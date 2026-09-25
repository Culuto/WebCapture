import '../server/env-compat.mjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { htmlAssetReferences, cssAssetReferences, referenceAudit, documentBaseUrl } from '../server/asset-references.mjs';
import { parseSrcset } from '../server/srcset.mjs';

const gunzip = promisify(zlib.gunzip);
const projectRoot = path.resolve(import.meta.dirname, '..');
const archiveId = process.argv[2];

if (!archiveId || !/^archive_[a-z0-9_]+$/i.test(archiveId)) {
  console.error('Usage: npm run audit:archive -- <archive-id>');
  process.exit(2);
}

const archiveRoot = path.join(process.env.WEBCAPTURE_DATA_ROOT || path.join(projectRoot, 'data'), 'archives', archiveId);
const manifest = JSON.parse(await fs.readFile(path.join(archiveRoot, 'manifest.json'), 'utf8'));
const resources = Object.values(manifest.resources || {});
const uniqueFiles = new Map(resources.filter((item) => item?.file).map((item) => [item.file, item]));
const failures = [];
let verifiedBytes = 0;
let srcsetCandidates = 0;
const missingSrcsetCandidates = new Set();
const references = [];
const successfulResources = new Set(resources.filter(item => item && item.status >= 200 && item.status < 400 && (item.size > 0 || [204, 205].includes(item.status))).map(item => item.url));
let screenshotsNotRecorded = 0;

for (const [relativeFile, resource] of uniqueFiles) {
  try {
    const body = await fs.readFile(path.join(archiveRoot, relativeFile));
    const digest = `sha256:${crypto.createHash('sha256').update(body).digest('hex')}`;
    if (digest !== resource.digest) failures.push({ type: 'digest-mismatch', file: relativeFile });
    if (body.length !== resource.size) failures.push({ type: 'size-mismatch', file: relativeFile });
    verifiedBytes += body.length;
    if (/text\/css/i.test(resource.mimeType || resource.headers?.['content-type'] || '')) references.push(...cssAssetReferences(body.toString('utf8'), resource.url));
  } catch (error) {
    failures.push({ type: 'missing-resource-file', file: relativeFile, code: error.code || 'READ_FAILED' });
  }
}

for (const page of manifest.pages || []) {
  for (const [type, relativeFile] of [['html', page.html], ['screenshot', page.screenshot]]) {
    if (!relativeFile) {
      if (type === 'screenshot') { screenshotsNotRecorded += 1; continue; }
      failures.push({ type: `missing-${type}-reference` });
      continue;
    }
    try {
      await fs.access(path.join(archiveRoot, relativeFile));
      if (type === 'html') {
        const html = await fs.readFile(path.join(archiveRoot, relativeFile), 'utf8');
        references.push(...htmlAssetReferences(html, page.url));
        const baseUrl = documentBaseUrl(html, page.url);
        for (const match of html.matchAll(/\bsrcset\s*=\s*(["'])([\s\S]*?)\1/gi)) {
          for (const { url } of parseSrcset(match[2])) {
            const value = url.replace(/&amp;/gi, '&');
            if (!value || /^(?:data:|blob:)/i.test(value)) continue;
            try {
              const candidate = new URL(value, baseUrl); candidate.hash = '';
              srcsetCandidates += 1;
              if (!successfulResources.has(candidate.href) && !successfulResources.has(manifest.resourceAliases?.[candidate.href])) missingSrcsetCandidates.add(candidate.href);
            } catch {}
          }
        }
      }
    }
    catch (error) { failures.push({ type: `missing-${type}-file`, file: relativeFile, code: error.code || 'READ_FAILED' }); }
  }
}

const suspiciousEmpty = resources.filter((item) =>
  item && item.status >= 200 && item.status < 300 && ![204, 205].includes(item.status) && item.size === 0);
const brokenCandidateUrls = resources.filter((item) => {
  try { return new URL(item.url).pathname.endsWith('.'); } catch { return false; }
});

let warc = { exists: false, gzipValid: false, records: 0, bytes: 0 };
try {
  const compressed = await fs.readFile(path.join(archiveRoot, 'collection.warc.gz'));
  const plain = await gunzip(compressed);
  warc = {
    exists: true,
    gzipValid: true,
    records: (plain.toString('latin1').match(/WARC\/1\.1\r?\n/g) || []).length,
    bytes: compressed.length
  };
} catch (error) {
  if (manifest.options?.warcEnabled !== false || error.code !== 'ENOENT') failures.push({ type: 'warc-invalid', code: error.code || 'GZIP_FAILED' });
}

const staticReferences = referenceAudit(references, successfulResources, manifest.resourceAliases);

const blockedByReason = Object.entries((manifest.blocked || []).reduce((result, item) => {
  const reason = String(item.reason || '不明').replace(/[?&][^\s]*/g, '');
  result[reason] = (result[reason] || 0) + 1;
  return result;
}, {})).map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count);

const startHost = new URL(manifest.startUrl).hostname;
const externalHosts = [...new Set(resources.flatMap((item) => {
  try {
    const host = new URL(item.url).hostname;
    return host !== startHost && !host.endsWith(`.${startHost}`) ? [host] : [];
  } catch { return []; }
}))].sort();

const report = {
  archiveId,
  auditedAt: new Date().toISOString(),
  ok: failures.length === 0 && suspiciousEmpty.length === 0 && brokenCandidateUrls.length === 0 && staticReferences.missingCount === 0,
  perfect: false,
  scope: 'stored-files-and-static-reference-candidates',
  runtimeVerification: 'not-tested',
  fileIntegrity: { ok: failures.length === 0, failures: failures.length },
  staticReferences,
  screenshotsNotRecorded,
  pages: manifest.pages?.length || 0,
  resources: resources.length,
  uniqueFiles: uniqueFiles.size,
  verifiedBytes,
  suspiciousEmptyResponses: suspiciousEmpty.length,
  brokenCandidateUrls: brokenCandidateUrls.length,
  srcsetCandidates,
  missingSrcsetCandidates: missingSrcsetCandidates.size,
  externalHosts,
  blockedByReason,
  warc,
  failures
};

const auditRoot = process.env.WEBCAPTURE_AUDIT_ROOT || path.join(projectRoot, 'runtime', 'audits');
await fs.mkdir(auditRoot, { recursive: true });
const reportPath = path.join(auditRoot, `${archiveId}-${Date.now()}.json`);
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...report, reportPath: path.relative(projectRoot, reportPath).replaceAll('\\', '/') }, null, 2));
process.exitCode = report.ok ? 0 : 1;
