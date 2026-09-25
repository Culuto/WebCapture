import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { CONFIG } from '../server/config.mjs';
import { safeFetch } from '../server/crawler.mjs';
import { VaultStore } from '../server/store.mjs';
import { createWarcAsync } from '../server/warc.mjs';
import { reserveOfflinePort, reserveDataWriter } from '../server/offline-guard.mjs';
import { logEvent, safeUrl, waitForLogs } from '../server/logger.mjs';
import { parseSrcset } from '../server/srcset.mjs';
import { IMAGE_SOURCE_ATTRIBUTES, documentBaseUrl, htmlAssetReferences, cssAssetReferences, referenceAudit } from '../server/asset-references.mjs';
import { summarizeArchiveQuality } from '../server/quality.mjs';
import { commitArchiveRepair } from '../server/repair-transaction.mjs';

const archiveId = process.argv[2];
if (!archiveId || !/^archive_[a-z0-9_]+$/i.test(archiveId)) {
  console.error('Usage: npm run repair:srcset -- <archive-id>');
  process.exit(2);
}

const offlineGuard = await reserveOfflinePort(CONFIG.host, CONFIG.port);
let dataWriter;
try {
dataWriter = await reserveDataWriter(CONFIG.dataRoot);
const store = await new VaultStore(CONFIG.dataRoot).init();
store.assertArchiveWritable(archiveId);
const manifest = await store.readManifest(archiveId);
if (!manifest) throw new Error('アーカイブが見つかりません。');
logEvent('info', 'archive', 'repair.started', { archiveId });
manifest.resources ||= {};
manifest.resourceAliases ||= {};
const successful = new Set(Object.values(manifest.resources).filter(resource => resource.status >= 200 && resource.status < 400 && (resource.size > 0 || [204, 205].includes(resource.status))).map(resource => resource.url));
const known = new Set([...successful, ...Object.entries(manifest.resourceAliases).filter(([, target]) => successful.has(target)).map(([alias]) => alias)]);
const missing = new Set();
const references = [];
function candidate(value, baseUrl) {
  if (!value || /^(?:data:|blob:|#)/i.test(value)) return;
  try { const url = new URL(value.replace(/&amp;/gi, '&'), baseUrl); url.hash = ''; if (!known.has(url.href)) missing.add(url.href); } catch {}
}

for (const page of manifest.pages || []) {
  if (!page.html) continue;
  const html = await fs.readFile(path.join(store.archiveRoot(archiveId), page.html), 'utf8');
  const baseUrl = documentBaseUrl(html, page.url);
  references.push(...htmlAssetReferences(html, page.url));
  for (const match of html.matchAll(/\bsrcset\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    for (const { url } of parseSrcset(match[2])) candidate(url, baseUrl);
  }
  for (const tag of html.matchAll(/<(?:img|source)\b[^>]*>/gi)) for (const name of IMAGE_SOURCE_ATTRIBUTES) {
    const match = tag[0].match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
    if (match) candidate(match[1] ?? match[2] ?? match[3], baseUrl);
  }
}

const records = [];
let addedBytes = 0;
const failures = [];
for (const url of missing) {
  logEvent('info', 'archive', 'repair.resource.requested', { archiveId, resourceUrl: safeUrl(url) });
  try {
    const { response, finalUrl } = await safeFetch(url, { ...manifest.options, requestTimeoutMs: manifest.options?.requestTimeoutMs || 120000 });
    if (!response.ok) throw new Error(`画像の取得先がHTTP ${response.status}を返しました。`);
    const body = Buffer.from(await response.arrayBuffer());
    if (!body.length) throw new Error('取得した応答が空でした。');
    const blob = await store.writeBlob(archiveId, body);
    const headers = Object.fromEntries(response.headers.entries());
    manifest.resources[url] = {
      url, status: response.status, headers, mimeType: response.headers.get('content-type') || 'application/octet-stream',
      digest: blob.digest, file: blob.file, size: blob.size, capturedAt: new Date().toISOString()
    };
    if (finalUrl !== url) manifest.resourceAliases[finalUrl] = url;
    addedBytes += blob.size;
    records.push({
      url, capturedAt: new Date().toISOString(),
      httpPayload: Buffer.concat([
        Buffer.from(`HTTP/1.1 ${response.status} OK\r\n${Object.entries(headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`),
        body
      ])
    });
    logEvent('info', 'archive', 'repair.resource.saved', { archiveId, resourceUrl: safeUrl(url), bytes: blob.size });
  } catch (error) {
    failures.push({ host: (() => { try { return new URL(url).hostname; } catch { return 'invalid'; } })(), message: error.message });
    logEvent('warn', 'archive', 'repair.resource.failed', { archiveId, resourceUrl: safeUrl(url), code: error.code, message: error.message });
  }
}

let warcChunk = Buffer.alloc(0);
if (records.length && manifest.options?.warcEnabled !== false) {
  warcChunk = await createWarcAsync(records, { repair: 'missing-srcset' }, manifest.options?.warcCompressionLevel ?? 1);
}
const warcBytes = warcChunk.length;
for (const resource of Object.values(manifest.resources)) if (/text\/css/i.test(resource.mimeType || '')) references.push(...cssAssetReferences(await fs.readFile(path.join(store.archiveRoot(archiveId), resource.file), 'utf8'), resource.url));
manifest.referenceAudit = referenceAudit(references, new Set(Object.values(manifest.resources).filter(resource => resource.status >= 200 && resource.status < 400 && (resource.size > 0 || [204, 205].includes(resource.status))).map(resource => resource.url)), manifest.resourceAliases);
manifest.quality = summarizeArchiveQuality(manifest, store.getArchive(archiveId) || {});
const resourceCount = Object.keys(manifest.resources).length;
const archive = store.getArchive(archiveId);
await commitArchiveRepair(store, archiveId, {
  manifest, warcChunk,
  archive: archive ? { ...archive, quality: manifest.quality, resources: resourceCount, bytes: Number(archive.bytes || 0) + addedBytes + warcBytes, repairedAt: new Date().toISOString() } : null,
  jobs: store.state.jobs.filter(item => item.archiveId === archiveId).map(job => ({ id: job.id, resources: resourceCount, bytes: Number(job.bytes || 0) + addedBytes + warcBytes }))
});
console.log(JSON.stringify({ archiveId, candidates: missing.size, repaired: records.length, failures, addedBytes, warcBytes }, null, 2));
logEvent('info', 'archive', 'repair.completed', { archiveId, candidates: missing.size, repaired: records.length, failures: failures.length, addedBytes, warcBytes });
process.exitCode = failures.length ? 1 : 0;
} catch (error) {
  logEvent('error', 'archive', 'repair.failed', { archiveId, code: error.code, message: error.message });
  throw error;
} finally { await dataWriter?.close(); await offlineGuard.close(); await waitForLogs(); }
