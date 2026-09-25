import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { CONFIG, MIME_TYPES } from './config.mjs';
import { assertPublicUrl, validateSameSiteKeywords } from './policy.mjs';
import { VaultStore, createId } from './store.mjs';
import { CrawlManager, safeFetch } from './crawler.mjs';
import { DeferredMediaService } from './deferred-media.mjs';
import { CdpClient, cleanupStaleBrowserProfiles, createBrowserCaptureSession, findBrowser } from './browser-capture.mjs';
import { LoginProfiles } from './login-profiles.mjs';
import { createReplayHandler } from './replay.mjs';
import { logEvent, readRecentLogs, safeUrl, waitForLogs } from './logger.mjs';
import { sanitizeCaptureOptions } from './capture-options.mjs';
import { completionStatus, summarizeArchiveQuality } from './quality.mjs';
import { reserveDataWriter } from './offline-guard.mjs';
import { SystemMonitor } from './system-monitor.mjs';
import { ReplayAuditManager } from './replay-auditor.mjs';
import { OPTIMIZE_START } from './concurrency-tuner.mjs';
import { buildIssueReport } from './issue-report.mjs';
import { notifyDesktop } from './notify.mjs';
import { SearchIndex } from './search-index.mjs';
import { SharedPages } from './shared-pages.mjs';
import { storageSummary } from './storage-summary.mjs';
import { archiveDiff, pageDiff } from './archive-diff.mjs';
import { exportFileName, exportWebCapture, exportWacz, importWebCapture } from './archive-export.mjs';
import { NotificationCenter } from './notifications.mjs';
import { ScheduleService } from './schedules.mjs';
import { WatchService, browserWatchReader, httpWatchReader } from './watches.mjs';
import { BlobDedupeService, sharedBlobStats } from './blob-dedupe.mjs';
import { StorageCleanupService } from './storage-cleanup.mjs';
import { BatchQueue } from './batch-queue.mjs';
import { PresetStore } from './presets.mjs';
import { pageHistory } from './page-history.mjs';
import { retryOptionOverrides } from './issue-report.mjs';
import { exportReplayPage } from './page-export.mjs';
import { visualComparison } from './visual-compare.mjs';

let store, crawler, browserInfoPromise, dataWriter, systemMonitor, replayAuditor, deferredMedia, searchIndex, loginProfiles, sharedPages;
let notifications, schedules, watches, blobDedupe, storageCleanup, batches, presets;
let appSettings = { lowImpactMode: true, optimizeMode: false, notifyOnComplete: true, optimized: null };

function settingsFile() {
  return path.join(CONFIG.dataRoot, 'settings.json');
}

async function readAppSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    const optimized = saved.optimized && Number.isSafeInteger(saved.optimized.capture) && Number.isSafeInteger(saved.optimized.discovery) ? saved.optimized : null;
    return { lowImpactMode: saved.lowImpactMode !== false, optimizeMode: saved.optimizeMode === true, notifyOnComplete: saved.notifyOnComplete !== false, optimized };
  } catch {
    return { lowImpactMode: true, optimizeMode: false, notifyOnComplete: true, optimized: null };
  }
}

let settingsWrite = Promise.resolve();
function writeAppSettings(settings) {
  const write = settingsWrite.then(async () => {
    const temporary = `${settingsFile()}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2));
    await fs.rename(temporary, settingsFile());
  });
  settingsWrite = write.catch(() => {});
  return write;
}
let initialized = false;
const csrfToken = crypto.randomBytes(24).toString('base64url');
const QUALITY_SUMMARY_FIELDS = ['level', 'score', 'pageIssueCount', 'blockedCount', 'hardBlockedCount', 'serverBoundaryCount', 'runtimeMissingCount', 'auxiliaryRuntimeMissingCount', 'referenceMissingCount', 'referenceChecked', 'partialCapture', 'scope', 'perfect'];

function qualitySummaryChanged(previous, next) {
  return QUALITY_SUMMARY_FIELDS.some((key) => previous?.[key] !== next?.[key]);
}

function archivePage(url) {
  return store.queryArchives({
    query: url.searchParams.get('q') || '',
    offset: url.searchParams.get('offset') || 0,
    limit: url.searchParams.get('limit') || 60,
    folder: url.searchParams.get('folder') || '',
    tag: url.searchParams.get('tag') || ''
  });
}

function compactReplayAudit(audit) {
  if (!audit) return null;
  const { pages = [], ...summary } = audit;
  return {
    ...summary,
    issuePages: pages.filter(page => page.status !== 'healthy').slice(0, 30).map(page => ({
      url: page.url,
      title: page.title || page.savedTitle || '',
      status: page.status,
      visibleBrokenImages: Number(page.metrics?.visibleBrokenImageCount || 0),
      visiblePendingImages: Number(page.metrics?.visiblePendingImageCount || 0),
      missingResources: Number(page.missingResources?.length || 0),
      boundaryResources: Number(page.boundaryResources?.length || 0),
      auxiliaryResources: Number(page.auxiliaryResources?.length || 0),
      failedRequests: Number(page.failedRequests?.length || 0),
      isolationEvents: Number(page.isolationEvents?.length || 0),
      runtimeAdvisories: Number(page.runtimeAdvisories?.length || 0),
      runtimeErrors: Number(page.runtimeErrors?.length || 0),
      interactionCandidates: Number(page.interactions?.candidateCount || 0),
      interactionsTested: Number(page.interactions?.testedCount || 0),
      interactionErrors: Number(page.interactions?.errorCount || 0),
      interactionSkipped: Number(page.interactions?.skippedCount || 0),
      interactionTransient: Number(page.interactions?.transientCount || 0),
      interactionLimitReached: Boolean(page.interactions?.limitReached),
      screenshot: page.screenshot || null
    }))
  };
}

function json(res, status, body, extra = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': payload.length, 'cache-control': 'no-store', ...extra });
  res.end(payload);
}

function errorJson(res, status, message, code = 'REQUEST_FAILED') {
  json(res, status, { ok: false, error: { code, message } });
}

function securityHeaders(req, res) {
  const frameAncestors = ["'self'", ...CONFIG.iframeParentOrigins].join(' ');
  res.setHeader('content-security-policy', `default-src 'self'; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-src http://${CONFIG.host}:${CONFIG.replayPort} http://localhost:${CONFIG.replayPort} http://*.localhost:${CONFIG.replayPort}; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors ${frameAncestors}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  res.setHeader('cross-origin-resource-policy', 'cross-origin');
}

function allowedHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  return host === `${CONFIG.host}:${CONFIG.port}` || host === `localhost:${CONFIG.port}`;
}

function allowedOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === `http://${CONFIG.host}:${CONFIG.port}` || origin === `http://localhost:${CONFIG.port}`;
}

function requireMutationGuard(req, res) {
  if (!allowedOrigin(req)) { errorJson(res, 403, 'この画面以外からの操作は拒否しました。', 'ORIGIN_REJECTED'); return false; }
  if (req.headers['x-webcapture-csrf'] !== csrfToken) { errorJson(res, 403, '操作確認情報が一致しません。画面を再読み込みしてください。', 'CSRF_REJECTED'); return false; }
  return true;
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('入力が大きすぎます。');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('入力データの形式が正しくありません。'); }
}

function sanitizeOptions(input = {}) {
  return sanitizeCaptureOptions(input, CONFIG.defaultLimits, validateSameSiteKeywords);
}

async function api(req, res, url) {
  if (!(req.method === 'GET' && (['/api/bootstrap', '/api/snapshot'].includes(url.pathname) || /^\/api\/jobs\/[^/]+\/live(?:\/|$)/.test(url.pathname)))) {
    logEvent('info', 'api', 'request', { method: req.method, path: url.pathname });
  }
  const extra = await featureApi(req, res, url);
  if (extra !== false) return extra;
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true, app: CONFIG.appName, version: CONFIG.version, ready: true, replayReady: true, storage: 'segmented-v2',
      monitoring: { enabled: true, latestAt: systemMonitor?.snapshot()?.timestamp || null }
    });
  }
  if (url.pathname === '/api/settings') {
    if (req.method === 'GET') return json(res, 200, { ok: true, settings: appSettings });
    if (req.method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
    if (!requireMutationGuard(req, res)) return;
    const body = await readJson(req);
    const changes = {};
    for (const key of ['lowImpactMode', 'optimizeMode', 'notifyOnComplete']) {
      if (body[key] === undefined) continue;
      if (typeof body[key] !== 'boolean') return errorJson(res, 400, '設定の指定が正しくありません。');
      changes[key] = body[key];
    }
    if (!Object.keys(changes).length) return errorJson(res, 400, '設定の指定が正しくありません。');
    appSettings = { ...appSettings, ...changes };
    await writeAppSettings(appSettings);
    if ('lowImpactMode' in changes) crawler.loadGovernor.setLowImpact(appSettings.lowImpactMode);
    logEvent('info', 'settings', 'changed', changes);
    return json(res, 200, { ok: true, settings: appSettings, load: crawler.loadSnapshot() });
  }
  if (url.pathname === '/api/logins') {
    if (req.method === 'GET') return json(res, 200, { ok: true, logins: await loginProfiles.list() });
    if (req.method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
    if (!requireMutationGuard(req, res)) return;
    const body = await readJson(req);
    try {
      let login;
      if (body.method === 'paste') login = await loginProfiles.importPastedCookies({ name: body.name, text: body.text, siteUrl: body.siteUrl });
      else if (body.method === 'chrome' || body.method === 'edge') login = await loginProfiles.importFromBrowser({ name: body.name, browser: body.method });
      else if (body.method === 'manual') login = await loginProfiles.openLoginWindow({ name: body.name, url: body.url || undefined });
      else return errorJson(res, 400, 'ログイン方法の指定が正しくありません。');
      return json(res, 201, { ok: true, login });
    } catch (error) {
      logEvent('warn', 'login', 'profile.create.failed', { method: String(body.method || ''), message: error.message });
      return errorJson(res, 400, error.message, 'LOGIN_FAILED');
    }
  }
  const loginMatch = url.pathname.match(/^\/api\/logins\/(login_[a-z0-9_]+)(?:\/(open))?$/i);
  if (loginMatch) {
    if (!requireMutationGuard(req, res)) return;
    const id = loginMatch[1];
    try {
      if (req.method === 'POST' && loginMatch[2] === 'open') {
        const body = await readJson(req);
        return json(res, 200, { ok: true, login: await loginProfiles.openLoginWindow({ id, url: body.url || undefined }) });
      }
      if (req.method === 'DELETE' && !loginMatch[2]) {
        await loginProfiles.remove(id);
        return json(res, 200, { ok: true });
      }
      return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
    } catch (error) {
      return errorJson(res, 400, error.message, 'LOGIN_FAILED');
    }
  }
  if (req.method === 'GET' && url.pathname === '/api/search') {
    const query = String(url.searchParams.get('q') || '').slice(0, 200);
    const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 50));
    return json(res, 200, { ok: true, query, ...await searchIndex.search(query, { limit }) });
  }
  if (req.method === 'GET' && url.pathname === '/api/session') {
    return json(res, 200, { ok: true, csrfToken });
  }
  if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
    if (url.searchParams.get('view') !== 'dashboard') {
      return json(res, 200, {
        ok: true, csrfToken,
        config: { ...CONFIG.defaultLimits, replayOrigin: `http://${CONFIG.host}:${CONFIG.replayPort}`, replayPort: CONFIG.replayPort },
        browser: await browserInfoPromise, jobs: store.listJobs(), archives: store.listArchives(),
        metrics: systemMonitor?.snapshot() || null, load: crawler?.loadSnapshot() || null
      });
    }
    const archives = archivePage(url);
    return json(res, 200, {
      ok: true,
      csrfToken,
      config: { ...CONFIG.defaultLimits, replayOrigin: `http://${CONFIG.host}:${CONFIG.replayPort}`, replayPort: CONFIG.replayPort },
      browser: await browserInfoPromise,
      jobs: store.listJobSummaries({ activeOnly: true, includePreviews: true, limit: 200 }),
      archives: archives.items,
      archivePage: { total: archives.total, offset: archives.offset, limit: archives.limit, hasMore: archives.hasMore },
      counts: store.counts(),
      revisions: store.revisions(),
      metrics: systemMonitor?.snapshot() || null,
      load: crawler?.loadSnapshot() || null
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/snapshot') {
    return json(res, 200, {
      ok: true,
      jobs: store.listJobSummaries({ activeOnly: true, includePreviews: true, limit: 200 }),
      counts: store.counts(),
      revisions: store.revisions(),
      metrics: systemMonitor?.snapshot() || null,
      load: crawler?.loadSnapshot() || null
    });
  }
  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    const limit = Math.max(1, Math.min(5000, Number(url.searchParams.get('limit')) || 2000));
    return json(res, 200, { ok: true, jobs: url.searchParams.get('view') === 'summary' ? store.listJobSummaries({ limit, includePreviews: false }) : store.listJobs() });
  }
  if (req.method === 'GET' && url.pathname === '/api/archives') {
    if (!['q', 'offset', 'limit', 'folder', 'tag'].some((key) => url.searchParams.has(key))) return json(res, 200, { ok: true, archives: store.listArchives() });
    const archives = archivePage(url);
    return json(res, 200, { ok: true, archives: archives.items, page: { total: archives.total, offset: archives.offset, limit: archives.limit, hasMore: archives.hasMore }, revisions: store.revisions() });
  }
  if (req.method === 'GET' && url.pathname === '/api/diagnostics/logs') {
    return json(res, 200, { ok: true, logs: await readRecentLogs(url.searchParams.get('limit')) });
  }
  if (req.method === 'GET' && url.pathname === '/api/diagnostics/metrics') {
    return json(res, 200, { ok: true, metrics: await systemMonitor.recent(url.searchParams.get('limit')), latest: systemMonitor.snapshot() });
  }
  if (req.method === 'POST' && url.pathname === '/api/diagnostics/events') {
    if (!requireMutationGuard(req, res)) return;
    const body = await readJson(req);
    for (const item of (Array.isArray(body.events) ? body.events : []).slice(0, 200)) {
      logEvent(item.level === 'error' ? 'error' : item.level === 'warn' ? 'warn' : 'info', 'ui', String(item.event || 'event').slice(0, 100), item.data || {});
    }
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/system/shutdown') {
    if (!requireMutationGuard(req, res)) return;
    logEvent('info', 'server', 'shutdown.requested', { source: 'local-controller' });
    json(res, 202, { ok: true });
    setImmediate(shutdown);
    return;
  }
  const deferredMediaMatch = url.pathname.match(/^\/api\/archives\/([^/]+)\/deferred-media$/);
  if (deferredMediaMatch) {
    const id = decodeURIComponent(deferredMediaMatch[1]);
    if (!/^archive_[a-z0-9_]+$/i.test(id)) return errorJson(res, 400, 'アーカイブIDが正しくありません。');
    if (!store.getArchive(id)) return errorJson(res, 404, '保存済みサイトが見つかりません。', 'NOT_FOUND');
    if (req.method === 'GET') return json(res, 200, { ok: true, ...await deferredMedia.status(id) });
    if (req.method === 'POST') {
      if (!requireMutationGuard(req, res)) return;
      const body = await readJson(req);
      try {
        const task = await deferredMedia.start(id, Array.isArray(body.urls) ? body.urls.slice(0, 5000) : null);
        return json(res, 202, { ok: true, task });
      } catch (error) {
        if (error.status) return errorJson(res, error.status, error.message, error.code);
        throw error;
      }
    }
    return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
  }
  const replayAuditMatch = url.pathname.match(/^\/api\/archives\/([^/]+)\/replay-audit(?:\/(cancel))?$/);
  if (replayAuditMatch) {
    const id = decodeURIComponent(replayAuditMatch[1]);
    if (!/^archive_[a-z0-9_]+$/i.test(id)) return errorJson(res, 400, 'アーカイブIDが正しくありません。');
    if (!store.getArchive(id)) return errorJson(res, 404, '保存済みサイトが見つかりません。', 'NOT_FOUND');
    if (req.method === 'GET' && !replayAuditMatch[2]) {
      const audit = await replayAuditor.status(id);
      return json(res, 200, { ok: true, audit: url.searchParams.get('view') === 'full' ? audit : compactReplayAudit(audit) });
    }
    if (req.method === 'POST') {
      if (!requireMutationGuard(req, res)) return;
      const audit = replayAuditMatch[2] === 'cancel' ? replayAuditor.cancel(id) : await replayAuditor.start(id);
      return json(res, 202, { ok: true, audit });
    }
    return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
  }
  if (url.pathname === '/api/archives/import') {
    if (req.method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
    if (!requireMutationGuard(req, res)) return;
    try {
      const result = await importWebCapture(store, req, { importsRoot: path.join(CONFIG.dataRoot, 'imports'), createArchiveId: () => createId('archive') });
      logEvent('info', 'archive', 'imported', { archiveId: result.archive.id, pages: result.archive.pages, files: result.fileCount });
      return json(res, 201, { ok: true, ...result });
    } catch (error) {
      logEvent('warn', 'archive', 'import.failed', { message: error.message });
      return errorJson(res, 400, error.message, 'IMPORT_FAILED');
    }
  }
  const exportMatch = url.pathname.match(/^\/api\/archives\/([^/]+)\/export$/);
  if (exportMatch) {
    if (req.method !== 'GET') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
    const id = decodeURIComponent(exportMatch[1]);
    const archive = store.getArchive(id);
    if (!archive) return errorJson(res, 404, '保存済みサイトが見つかりません。', 'NOT_FOUND');
    if (crawler.archiveBusy(id)) return errorJson(res, 409, '保存中または一時停止中のアーカイブは書き出せません。', 'ARCHIVE_BUSY');
    const format = url.searchParams.get('format') === 'wacz' ? 'wacz' : 'webcapture';
    const name = exportFileName(archive, format);
    res.writeHead(200, {
      'content-type': format === 'wacz' ? 'application/wacz' : 'application/x-webcapture',
      'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'cache-control': 'no-store', 'x-content-type-options': 'nosniff'
    });
    logEvent('info', 'archive', 'export.started', { archiveId: id, format });
    try {
      if (format === 'wacz') await exportWacz(store, id, res, { workRoot: path.join(CONFIG.dataRoot, 'exports-tmp') });
      else await exportWebCapture(store, id, res, { appVersion: CONFIG.version });
      res.end();
      logEvent('info', 'archive', 'export.completed', { archiveId: id, format });
    } catch (error) {
      logEvent('warn', 'archive', 'export.failed', { archiveId: id, format, message: error.message });
      res.destroy(error);
    }
    return;
  }
  const archiveAction = url.pathname.match(/^\/api\/archives\/([^/]+)\/(storage|retry-plan|continue|retry|resave|diff|diff-page)$/);
  if (archiveAction) {
    const id = decodeURIComponent(archiveAction[1]);
    const action = archiveAction[2];
    if (!store.getArchive(id)) return errorJson(res, 404, '保存済みサイトが見つかりません。', 'NOT_FOUND');
    const readOnly = ['storage', 'retry-plan', 'diff', 'diff-page'].includes(action);
    if (readOnly ? req.method !== 'GET' : req.method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
    if (!readOnly && !requireMutationGuard(req, res)) return;
    try {
      if (action === 'storage') return json(res, 200, { ok: true, storage: { ...await storageSummary(store, id), shared: await sharedBlobStats(store.archiveRoot(id)) } });
      if (action === 'retry-plan') return json(res, 200, { ok: true, plan: await crawler.retryPlan(id) });
      if (action === 'continue') return json(res, 202, { ok: true, job: await crawler.continueArchive(id) });
      if (action === 'resave') return json(res, 202, { ok: true, job: await crawler.resaveArchive(id) });
      if (action === 'diff' || action === 'diff-page') {
        const previousArchiveId = store.getArchive(id)?.previousArchiveId;
        if (!previousArchiveId || !store.getArchive(previousArchiveId)) return errorJson(res, 404, '比べる前回のアーカイブがありません。', 'PREVIOUS_NOT_FOUND');
        if (action === 'diff') return json(res, 200, { ok: true, diff: await archiveDiff(store, id, previousArchiveId) });
        const pageUrl = url.searchParams.get('url') || '';
        if (!/^https?:\/\//i.test(pageUrl)) return errorJson(res, 400, 'ページのURLを指定してください。');
        return json(res, 200, { ok: true, diff: await pageDiff(store, id, previousArchiveId, pageUrl) });
      }
      const body = await readJson(req);
      const list = (value) => Array.isArray(value) ? value.map(String).filter((item) => item.length <= 253).slice(0, 500) : [];
      const loginProfileId = typeof body.loginProfileId === 'string' && body.loginProfileId ? body.loginProfileId : null;
      if (loginProfileId && !await loginProfiles.get(loginProfileId)) return errorJson(res, 400, '選んだログイン設定が見つかりません。');
      const retryAction = typeof body.action === 'string' ? body.action : '';
      const job = await crawler.retryArchive(id, { loginProfileId, loginHosts: list(body.loginHosts), skipHosts: list(body.skipHosts), includeFailed: body.includeFailed !== false, optionOverrides: sanitizeOverrides(retryOptionOverrides(retryAction)), reason: retryAction });
      return json(res, 202, { ok: true, job });
    } catch (error) {
      return errorJson(res, error.status || 500, error.message, error.code || 'ARCHIVE_ACTION_FAILED');
    }
  }
  const archiveMatch = url.pathname.match(/^\/api\/archives\/([^/]+)$/);
  if (req.method === 'GET' && archiveMatch) {
    let archive = store.getArchive(decodeURIComponent(archiveMatch[1]));
    if (!archive) return errorJson(res, 404, '保存済みサイトが見つかりません。', 'NOT_FOUND');
    const manifest = await store.readManifest(archive.id);
    const runtimeMisses = await store.readRuntimeMisses(archive.id);
    const quality = summarizeArchiveQuality(manifest, { errors: archive.errors }, runtimeMisses);
    const correctedCompletion = ['complete', 'complete-with-errors'].includes(archive.status)
      ? completionStatus({ pages: archive.pages, errors: archive.errors, status: archive.status }, manifest)
      : { status: archive.status };
    const correctedStatus = correctedCompletion.status;
    if (qualitySummaryChanged(archive.quality, quality) || correctedStatus !== archive.status) {
      archive = { ...archive, quality, status: correctedStatus, partial: correctedStatus !== 'complete' };
      await store.addArchive(archive);
    }
    const repairRecovery = store.repairRecoveryFailures.get(archive.id);
    const archiveResponse = { ...archive, quality, ...(repairRecovery ? { repairRecovery } : {}) };
    if (url.searchParams.get('view') === 'diagnostics') {
      const { items, ...runtimeSummary } = runtimeMisses;
      return json(res, 200, { ok: true, archive: archiveResponse, runtimeMisses: runtimeSummary });
    }
    if (url.searchParams.get('view') === 'summary') {
      const { items, ...runtimeSummary } = runtimeMisses;
      return json(res, 200, { ok: true, archive: archiveResponse, manifest: summaryManifest(manifest, quality), runtimeMisses: runtimeSummary, issueReport: buildIssueReport(manifest) });
    }
    return json(res, 200, { ok: true, archive: archiveResponse, manifest: { ...manifest, quality }, runtimeMisses, issueReport: buildIssueReport(manifest) });
  }
  if (req.method === 'DELETE' && archiveMatch) {
    if (!requireMutationGuard(req, res)) return;
    const id = decodeURIComponent(archiveMatch[1]);
    if (!/^archive_[a-z0-9_]+$/i.test(id)) return errorJson(res, 400, 'アーカイブIDが正しくありません。');
    logEvent('info', 'archive', 'delete.requested', { archiveId: id });
    const referencedBy = sharedPages.referencesTo(id);
    if (referencedBy.length) {
      const names = referencedBy.map((other) => store.getArchive(other)?.title || store.getArchive(other)?.startUrl || other).slice(0, 5).join('、');
      logEvent('info', 'archive', 'delete.blocked.shared', { archiveId: id, referencedBy: referencedBy.length });
      return errorJson(res, 409, `このアーカイブのページは、ほかの${referencedBy.length}件のアーカイブ（${names}）から使われているため削除できません。先にそちらを削除してください。`, 'ARCHIVE_SHARED');
    }
    await replayAuditor.cancelAndWait(id);
    if (!await store.deleteArchive(id)) return errorJson(res, 404, '保存済みサイトが見つかりません。', 'NOT_FOUND');
    await sharedPages.removeArchive(id);
    searchIndex.forget(id);
    logEvent('info', 'archive', 'delete.completed', { archiveId: id });
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && url.pathname === '/api/jobs') {
    if (!requireMutationGuard(req, res)) return;
    const body = await readJson(req);
    try {
      return json(res, 202, { ok: true, job: await startCaptureJob(body.url, body.options) });
    } catch (error) {
      if (error.code === 'LOGIN_NOT_FOUND') return errorJson(res, 400, error.message);
      throw error;
    }
  }

  const liveMatch = url.pathname.match(/^\/api\/jobs\/([^/]+)\/live(?:\/(\d{1,2})\/frame)?$/);
  if (liveMatch) {
    if (req.method !== 'GET') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
    const id = decodeURIComponent(liveMatch[1]);
    const job = store.getJob(id);
    if (!job) return errorJson(res, 404, '保存処理が見つかりません。', 'NOT_FOUND');
    if (liveMatch[2] === undefined) {
      crawler.liveView.touchViewer(id);
      return json(res, 200, {
        ok: true, jobId: id, status: job.status, phase: job.phase || '', pollMs: crawler.liveView.pollMs(), streamPaused: crawler.liveView.streamPaused(),
        slots: crawler.liveView.snapshot(id, ['running', 'queued'].includes(job.status) ? Math.max(1, crawler.tuningSnapshot(id)?.capture ?? (Number(job.options?.concurrency) || 1)) : 0)
      });
    }
    const frame = crawler.liveView.frameOf(id, Number(liveMatch[2]));
    if (!frame) { res.writeHead(204, { 'cache-control': 'no-store' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': frame.length, 'cache-control': 'no-store' });
    res.end(frame);
    return;
  }
  const jobAction = url.pathname.match(/^\/api\/jobs\/([^/]+)\/(pause|resume|cancel|warning|start-capture)$/);
  if (req.method === 'POST' && jobAction) {
    if (!requireMutationGuard(req, res)) return;
    const id = decodeURIComponent(jobAction[1]);
    if (!store.getJob(id)) return errorJson(res, 404, '保存処理が見つかりません。', 'NOT_FOUND');
    let job;
    if (jobAction[2] === 'pause') job = await crawler.pause(id);
    if (jobAction[2] === 'resume') job = await crawler.resume(id);
    if (jobAction[2] === 'cancel') job = await crawler.cancel(id);
    if (jobAction[2] === 'start-capture') {
      const body = await readJson(req);
      try {
        job = await crawler.startCaptureFromDiscovery(id, { excludeHosts: Array.isArray(body.excludeHosts) ? body.excludeHosts.map(String).slice(0, 1000) : [] });
      } catch (error) { return errorJson(res, error.status || 500, error.message, error.code || 'START_FAILED'); }
    }
    if (jobAction[2] === 'warning') {
      const body = await readJson(req);
      if (!['continue', 'stop'].includes(body.action)) return errorJson(res, 400, '警告への操作が正しくありません。');
      job = await crawler.resolveWarning(id, body.action, body.suppress);
    }
    logEvent('info', 'crawler', `job.${jobAction[2]}`, { jobId: id, status: job?.status });
    return json(res, 200, { ok: true, job });
  }
  return false;
}

async function startCaptureJob(rawUrl, rawOptions = {}) {
  const checked = await assertPublicUrl(rawUrl);
  const requested = { ...(rawOptions || {}), optimize: appSettings.optimizeMode };
  if (appSettings.optimizeMode) Object.assign(requested, { concurrency: OPTIMIZE_START.capture, discoveryConcurrency: OPTIMIZE_START.discovery });
  const options = sanitizeOptions(requested);
  if (options.loginProfileId && !await loginProfiles.get(options.loginProfileId)) throw Object.assign(new Error('選んだログイン設定が見つかりません。'), { code: 'LOGIN_NOT_FOUND' });
  const job = await store.addJob({ startUrl: checked.url, options });
  logEvent('info', 'crawler', 'job.created', { jobId: job.id, archiveId: job.archiveId, startUrl: safeUrl(job.startUrl), options: job.options });
  crawler.start(job.id);
  return job;
}

function sanitizeOverrides(overrides = {}) {
  if (!Object.keys(overrides).length) return {};
  const sanitized = sanitizeOptions(overrides);
  return Object.fromEntries(Object.keys(overrides).map((key) => [key, sanitized[key]]));
}

const ARCHIVE_ID = /^archive_[a-z0-9_]+$/i;
const IMAGE_PATH = /^(?:screenshots\/\d{5}(?:-mobile)?\.png|replay-audit\/[A-Za-z0-9-]+\/(?:screenshots|visual)\/[A-Za-z0-9-]+\.png)$/;

async function sendServiceError(res, error) {
  if (error.status) return errorJson(res, error.status, error.message, error.code || 'REQUEST_FAILED');
  throw error;
}

async function featureApi(req, res, url) {
  const route = url.pathname;
  const method = req.method;
  const mutate = async () => {
    if (!requireMutationGuard(req, res)) return null;
    return readJson(req);
  };
  try {
    if (route === '/api/notifications') {
      if (method !== 'GET') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
      return json(res, 200, { ok: true, ...notifications.list({ limit: url.searchParams.get('limit') }) });
    }
    if (route === '/api/notifications/read' && method === 'POST') {
      const body = await mutate(); if (!body) return;
      await notifications.markRead(Array.isArray(body.ids) ? body.ids.slice(0, 500) : null);
      return json(res, 200, { ok: true, ...notifications.list({}) });
    }
    if (route === '/api/notifications/clear' && method === 'POST') {
      const body = await mutate(); if (!body) return;
      await notifications.clear();
      return json(res, 200, { ok: true, ...notifications.list({}) });
    }
    if (route === '/api/schedules' && method === 'GET') return json(res, 200, { ok: true, schedules: schedules.list() });
    const scheduleDelete = route.match(/^\/api\/schedules\/(schedule_[a-z0-9_]+)$/i);
    if (scheduleDelete && method === 'DELETE') {
      if (!requireMutationGuard(req, res)) return;
      await schedules.remove(scheduleDelete[1]);
      return json(res, 200, { ok: true });
    }
    const archiveFeature = route.match(/^\/api\/archives\/([^/]+)\/(schedule|meta|page-export|visual|image)$/);
    if (archiveFeature) {
      const id = decodeURIComponent(archiveFeature[1]);
      if (!ARCHIVE_ID.test(id)) return errorJson(res, 400, 'アーカイブIDが正しくありません。');
      if (!store.getArchive(id)) return errorJson(res, 404, '保存済みサイトが見つかりません。', 'NOT_FOUND');
      const action = archiveFeature[2];
      if (action === 'schedule') {
        if (method === 'GET') return json(res, 200, { ok: true, schedule: schedules.forArchive(id) });
        if (method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
        const body = await mutate(); if (!body) return;
        return json(res, 200, { ok: true, schedule: await schedules.upsert(id, body) });
      }
      if (action === 'meta') {
        if (method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
        const body = await mutate(); if (!body) return;
        const archive = await store.updateArchiveMeta(id, { tags: body.tags, folder: body.folder, note: body.note });
        logEvent('info', 'archive', 'meta.updated', { archiveId: id, tags: archive.tags?.length || 0, folder: Boolean(archive.folder), note: Boolean(archive.note) });
        return json(res, 200, { ok: true, archive, facets: store.archiveFacets() });
      }
      if (method !== 'GET') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
      if (action === 'image') {
        const file = String(url.searchParams.get('path') || '');
        if (!IMAGE_PATH.test(file)) return errorJson(res, 400, '画像の指定が正しくありません。');
        let body;
        try { body = await fs.readFile(path.join(store.archiveRoot(id), file)); } catch { return errorJson(res, 404, '画像が見つかりません。', 'NOT_FOUND'); }
        res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length, 'cache-control': 'private, max-age=3600' });
        res.end(body);
        return;
      }
      if (action === 'visual') {
        const pageUrl = url.searchParams.get('url') || '';
        return json(res, 200, { ok: true, visual: await visualComparison(store, id, pageUrl) });
      }
      const pageUrl = url.searchParams.get('url') || '';
      if (!/^https?:\/\//i.test(pageUrl)) return errorJson(res, 400, 'ページのURLを指定してください。');
      const format = url.searchParams.get('format') === 'pdf' ? 'pdf' : 'png';
      const view = url.searchParams.get('view') === 'mobile' ? 'mobile' : 'desktop';
      const result = await exportReplayPage({ archiveId: id, pageUrl, format, view, config: CONFIG, store });
      const name = `${(store.getArchive(id).title || 'page').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80)}.${format}`;
      res.writeHead(200, {
        'content-type': format === 'pdf' ? 'application/pdf' : 'image/png', 'content-length': result.length, 'cache-control': 'no-store',
        'content-disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '')}"; filename*=UTF-8''${encodeURIComponent(name)}`
      });
      res.end(result);
      logEvent('info', 'archive', 'page.exported', { archiveId: id, format, view, bytes: result.length });
      return;
    }
    if (route === '/api/archives/facets' && method === 'GET') return json(res, 200, { ok: true, facets: store.archiveFacets() });
    if (route === '/api/pages/history' && method === 'GET') {
      const pageUrl = url.searchParams.get('url') || '';
      if (!/^https?:\/\//i.test(pageUrl)) return errorJson(res, 400, 'ページのURLを指定してください。');
      return json(res, 200, { ok: true, ...await pageHistory(store, searchIndex, pageUrl) });
    }
    if (route === '/api/watches') {
      if (method === 'GET') return json(res, 200, { ok: true, watches: watches.list() });
      if (method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
      const body = await mutate(); if (!body) return;
      const watch = await watches.add(body);
      watches.check(watch.id).catch(() => {});
      return json(res, 201, { ok: true, watch });
    }
    const watchMatch = route.match(/^\/api\/watches\/(watch_[a-z0-9_]+)(?:\/(check))?$/i);
    if (watchMatch) {
      if (method === 'DELETE' && !watchMatch[2]) {
        if (!requireMutationGuard(req, res)) return;
        await watches.remove(watchMatch[1]);
        return json(res, 200, { ok: true });
      }
      if (method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
      const body = await mutate(); if (!body) return;
      if (watchMatch[2] === 'check') return json(res, 200, { ok: true, watch: await watches.check(watchMatch[1]) });
      return json(res, 200, { ok: true, watch: await watches.update(watchMatch[1], body) });
    }
    if (route === '/api/storage/dedupe') {
      if (method === 'GET') return json(res, 200, { ok: true, task: blobDedupe.status() });
      if (method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
      const body = await mutate(); if (!body) return;
      return json(res, 202, { ok: true, task: blobDedupe.start() });
    }
    if (route === '/api/storage/cleanup' && method === 'GET') return json(res, 200, { ok: true, cleanup: await storageCleanup.status() });
    const cleanupMatch = route.match(/^\/api\/storage\/cleanup\/(settings|plan|execute)$/);
    if (cleanupMatch && method === 'POST') {
      const body = await mutate(); if (!body) return;
      if (cleanupMatch[1] === 'settings') return json(res, 200, { ok: true, settings: await storageCleanup.updateSettings(body) });
      if (cleanupMatch[1] === 'plan') return json(res, 200, { ok: true, plan: await storageCleanup.buildPlan() });
      const result = await storageCleanup.execute(String(body.planId || ''), Array.isArray(body.archiveIds) ? body.archiveIds.map(String).slice(0, 5000) : null);
      return json(res, 200, { ok: true, result });
    }
    if (route === '/api/batches') {
      if (method === 'GET') return json(res, 200, { ok: true, batches: batches.list() });
      if (method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
      const body = await mutate(); if (!body) return;
      const created = await batches.create({ text: typeof body.text === 'string' ? body.text.slice(0, 200000) : '', urls: Array.isArray(body.urls) ? body.urls.map(String).slice(0, 1000) : null, options: body.options || {} });
      return json(res, 201, { ok: true, ...created });
    }
    const batchCancel = route.match(/^\/api\/batches\/(batch_[a-z0-9_]+)\/cancel$/i);
    if (batchCancel && method === 'POST') {
      const body = await mutate(); if (!body) return;
      return json(res, 200, { ok: true, batch: await batches.cancel(batchCancel[1]) });
    }
    if (route === '/api/presets') {
      if (method === 'GET') return json(res, 200, { ok: true, presets: presets.list() });
      if (method !== 'POST') return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
      const body = await mutate(); if (!body) return;
      return json(res, 201, { ok: true, preset: await presets.save(body), presets: presets.list() });
    }
    const presetMatch = route.match(/^\/api\/presets\/([a-z0-9_]+)$/i);
    if (presetMatch && method === 'DELETE') {
      if (!requireMutationGuard(req, res)) return;
      await presets.remove(presetMatch[1]);
      return json(res, 200, { ok: true, presets: presets.list() });
    }
  } catch (error) {
    return sendServiceError(res, error);
  }
  return false;
}

async function staticFile(req, res, url) {
  if (url.pathname.startsWith('/vendor/lucide/')) {
    const relativeVendor = decodeURIComponent(url.pathname.slice('/vendor/lucide/'.length));
    if (!/^(?:createElement|defaultAttributes)\.mjs$|^icons\/[a-z0-9-]+\.mjs$/.test(relativeVendor)) return false;
    const vendorRoot = path.join(CONFIG.projectRoot, 'node_modules', 'lucide', 'dist', 'esm');
    const vendorFile = path.resolve(vendorRoot, relativeVendor);
    if (!vendorFile.startsWith(`${path.resolve(vendorRoot)}${path.sep}`)) return false;
    try {
      const body = await fs.readFile(vendorFile);
      res.writeHead(200, { 'content-type': MIME_TYPES['.mjs'], 'content-length': body.length, 'cache-control': 'public, max-age=86400' });
      res.end(body);
      return true;
    } catch { return false; }
  }
  const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  const file = path.resolve(CONFIG.publicRoot, relative);
  if (!file.startsWith(`${path.resolve(CONFIG.publicRoot)}${path.sep}`) && file !== path.join(CONFIG.publicRoot, 'index.html')) return false;
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return false;
    const body = await fs.readFile(file);
    res.writeHead(200, { 'content-type': MIME_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-cache' });
    res.end(body);
    return true;
  } catch { return false; }
}

const appServer = http.createServer(async (req, res) => {
  try {
    if (!initialized) return errorJson(res, 503, '保存データを読み込み中です。', 'INITIALIZING');
    if (!allowedHost(req)) return errorJson(res, 400, 'Hostを確認できません。', 'HOST_REJECTED');
    securityHeaders(req, res);
    const url = new URL(req.url, `http://${CONFIG.host}:${CONFIG.port}`);
    if (url.pathname.startsWith('/api/')) {
      const handled = await api(req, res, url);
      if (handled !== false) return;
      return errorJson(res, 404, 'APIが見つかりません。', 'NOT_FOUND');
    }
    if (!['GET', 'HEAD'].includes(req.method)) return errorJson(res, 405, 'この操作は許可されていません。', 'METHOD_NOT_ALLOWED');
    if (!await staticFile(req, res, url)) return errorJson(res, 404, 'ページが見つかりません。', 'NOT_FOUND');
  } catch (error) {
    logEvent('error', 'server', 'request.failed', { method: req.method, requestUrl: req.url, message: error.message, stack: error.stack });
    errorJson(res, 400, error.message || '処理に失敗しました。');
  }
});

appServer.requestTimeout = 0;

let replayHandler;
const replayServer = http.createServer((req, res) => {
  if (!initialized) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end('Initializing'); return; }
  Promise.resolve(replayHandler(req, res)).catch(() => {
    logEvent('error', 'replay', 'request.failed', { method: req.method, requestUrl: req.url });
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' });
    if (!res.writableEnded) res.end('Replay failed');
  });
});

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, CONFIG.host, resolve);
  });
}

// Never recover or persist another server's running jobs before port ownership.
try {
  await Promise.all([listen(appServer, CONFIG.port), listen(replayServer, CONFIG.replayPort)]);
  dataWriter = await reserveDataWriter(CONFIG.dataRoot);
  store = await new VaultStore(CONFIG.dataRoot).init();
  systemMonitor = new SystemMonitor({ metricsRoot: CONFIG.metricsRoot, dataRoot: CONFIG.dataRoot, intervalMs: CONFIG.metricsIntervalMs });
  await systemMonitor.start();
  appSettings = await readAppSettings();
  searchIndex = new SearchIndex(store);
  sharedPages = await new SharedPages({ dataRoot: CONFIG.dataRoot, store }).init();
  loginProfiles = await new LoginProfiles({ dataRoot: CONFIG.dataRoot, findBrowser, createSession: (options) => createBrowserCaptureSession(options), CdpClient }).init();
  crawler = new CrawlManager(store, {
    ...CONFIG, systemMonitor, searchIndex, loginProfiles, sharedPages, lowImpactMode: appSettings.lowImpactMode,
    onJobFinished: async (result) => {
      if (schedules && await schedules.handleJobFinished(result).catch(() => null)) return;
      if (appSettings.notifyOnComplete === false) return;
      let host = result.startUrl;
      try { host = new URL(result.startUrl).hostname; } catch {}
      const label = ({ complete: '保存が完了', 'complete-with-errors': '保存が完了（一部エラー）', 'limit-reached': '上限に達して停止', failed: '保存に失敗', blocked: 'アクセス確認で停止', 'login-required': 'ログインが必要' })[result.status] || '保存が終了';
      await notifyDesktop(`WebCapture: ${label}`, `${host} を ${result.pages}ページ保存しました。保存できなかったもの ${result.problemCount}件。`);
    },
    onTuningResult: async (result) => {
      appSettings = { ...appSettings, optimized: result };
      await writeAppSettings(appSettings);
      logEvent('info', 'tuning', 'result.saved', result);
    }
  });
  await crawler.publishInterruptedArchives();
  notifications = await new NotificationCenter({ dataRoot: CONFIG.dataRoot, desktop: notifyDesktop, desktopEnabled: () => appSettings.notifyOnComplete !== false }).init();
  schedules = await new ScheduleService({ dataRoot: CONFIG.dataRoot, store, crawler, notifications, diff: (current, previous) => archiveDiff(store, current, previous) }).init();
  watches = await new WatchService({
    dataRoot: CONFIG.dataRoot, notifications, assertUrl: (value) => assertPublicUrl(value),
    reader: async (target) => (await findBrowser()) ? browserWatchReader(target) : httpWatchReader(safeFetch)(target)
  }).init();
  blobDedupe = new BlobDedupeService({ store, isBusy: (id) => crawler.archiveBusy(id) });
  storageCleanup = await new StorageCleanupService({ dataRoot: CONFIG.dataRoot, store, notifications, isBusy: (id) => crawler.archiveBusy(id) || deferredMedia?.tasks?.get(id)?.status === 'running' }).init();
  batches = await new BatchQueue({ dataRoot: CONFIG.dataRoot, store, notifications, startJob: (value, options) => startCaptureJob(value, options) }).init();
  presets = await new PresetStore({ dataRoot: CONFIG.dataRoot }).init();
  schedules.start();
  watches.start();
  storageCleanup.start();
  batches.start();
  replayAuditor = new ReplayAuditManager(store, CONFIG);
  cleanupStaleBrowserProfiles().catch(() => {});
  deferredMedia = new DeferredMediaService({ store, fetcher: safeFetch });
  browserInfoPromise = crawler.browserInfo().catch(() => ({ available: false, name: null }));
  replayHandler = createReplayHandler(store, CONFIG);
  initialized = true;
} catch (error) {
  await Promise.all([appServer, replayServer].map(server => new Promise(resolve => server.close(resolve))));
  await systemMonitor?.stop();
  await dataWriter?.close();
  logEvent('error', 'server', 'initialization.failed', { code: error.code, message: error.message });
  await waitForLogs();
  throw error;
}
console.log(`WebCapture ready: http://${CONFIG.host}:${CONFIG.port}/`);
logEvent('info', 'server', 'started', { version: CONFIG.version, host: CONFIG.host, port: CONFIG.port, replayPort: CONFIG.replayPort });

let shutdownPromise;
function shutdown() {
  if (shutdownPromise) return shutdownPromise;
  initialized = false;
  shutdownPromise = (async () => {
    for (const service of [schedules, watches, storageCleanup, batches]) service?.stop();
    await replayAuditor.shutdown();
    const closingServers = Promise.all([new Promise((resolve) => appServer.close(resolve)), new Promise((resolve) => replayServer.close(resolve))]);
    await crawler.shutdown();
    await systemMonitor.stop();
    await Promise.all([closingServers, store.waitForWrites(), store.waitForTrashCleanup()]);
    await dataWriter.close();
    logEvent('info', 'server', 'stopped', { jobsSettled: true });
    await waitForLogs();
    process.exit(0);
  })().catch(error => {
    logEvent('error', 'server', 'shutdown.failed', { code: error.code, message: error.message });
    process.exitCode = 1;
  });
  return shutdownPromise;
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export function summaryManifest(manifest, quality = manifest.quality) {
  const { pages = [], resources, resourceAliases, postResponses, resourceVariants, blocked, ...rest } = manifest;
  return {
    ...rest, quality,
    pages: pages.map((page) => ({ url: page.url, requestedUrl: page.requestedUrl, title: page.title, depth: page.depth, scope: page.scope, externalDepth: page.externalDepth, html: page.html, file: page.file, capturedAt: page.capturedAt, screenshot: page.screenshot || null, mobile: page.mobile?.html ? { screenshot: page.mobile.screenshot || null } : undefined, quality: page.quality ? { classification: page.quality.classification, level: page.quality.level, score: page.quality.score } : undefined }))
  };
}
