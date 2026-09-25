import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser } from './browser-capture.mjs';
import { LiveViewHub } from './live-view.mjs';
import { ConcurrencyTuner, OPTIMIZE_START } from './concurrency-tuner.mjs';
import { buildIssueReport } from './issue-report.mjs';
import { prefetchScriptReferences } from './script-prefetch.mjs';
import { assertPublicUrl, classifyScope, isAccountLikeUrl, nextExternalDepth, normalizeUrl, redirectChainExternalDepth, registrableDomain, stableDocumentKey, warningForDepth } from './policy.mjs';
import { createWarcAsync } from './warc.mjs';
import { commitArchiveCapture } from './repair-transaction.mjs';
import { logEvent, safeUrl } from './logger.mjs';
import { applyQueryPolicy, documentUrlAllowed, resourceTypeAllowed } from './capture-options.mjs';
import { classifyCapturedPage, completionStatus, documentStatus, isServerBoundaryUrl, isStartSitePage, summarizeArchiveQuality, unresolvedCaptureFailures } from './quality.mjs';

const RETRY_DELAY_MS = 5000;
const EXTERNAL_DETAIL_OVERRIDES = Object.freeze({
  standard: { interactionMaxMs: 60000, maxInteractionsPerPage: 250, hoverMaxMs: 30000, maxHoversPerPage: 80, networkIdleMs: 1000, networkIdleMaxMs: 30000, imageWaitMs: 15000, initialWaitMs: 500 },
  light: { interactDuringCapture: false, hoverDuringCapture: false, networkIdleMs: 500, networkIdleMaxMs: 10000, imageWaitMs: 5000, initialWaitMs: 0, maxScrollContainers: 50, maxScrollStepsPerContainer: 200, screenshotMode: 'viewport' }
});

export function captureOptionsForScope(options, scope) {
  if (scope !== 'external') return options;
  const overrides = EXTERNAL_DETAIL_OVERRIDES[options.externalDetail];
  return overrides ? { ...options, ...overrides } : options;
}
const RETRYABLE_ERROR_CODES = new Set(['BROWSER_UNAVAILABLE', 'PAGE_NAVIGATION_FAILED', 'PAGE_CAPTURE_TIMEOUT', 'PAGE_STALLED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

export function retryableDocumentStatus(status) {
  const value = Number(status) || 0;
  return value === 408 || value === 425 || value === 429 || value >= 500;
}

export function retryablePageError(error) {
  if (!error || error.code === 'NON_HTML_DOCUMENT') return false;
  if (RETRYABLE_ERROR_CODES.has(error.code)) return true;
  return /net::ERR_|timed? ?out|タイムアウト|時間切れ|fetch failed|socket hang up|DevTools接続|ECONNRESET|HTTP (?:408|425|429|5\d\d)\b/i.test(String(error.message || ''));
}
import { htmlAssetReferences, cssAssetReferences, referenceAudit } from './asset-references.mjs';
import { parseSrcset } from './srcset.mjs';
import { CaptureLoadGovernor } from './load-governor.mjs';
import { completeMediaResources } from './media-capture.mjs';
import { buildRetryPlan, retryQueue, summarizeRetryPlan } from './retry-plan.mjs';
import { discoverWithBrowser } from './browser-discovery.mjs';
import { postResponseKey, requestBodyDigests } from './post-archive.mjs';
import { charsetFromContentType, decodeStoredText, decodeText, detectCharset, isTextualType, withCharset } from './charset.mjs';

function contentType(headers) {
  if (headers instanceof Headers) return headers.get('content-type') || 'application/octet-stream';
  const key = Object.keys(headers || {}).find((item) => item.toLowerCase() === 'content-type');
  return key ? String(headers[key]) : 'application/octet-stream';
}

function headersObject(headers) {
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  return Object.fromEntries(Object.entries(headers || {}).map(([key, value]) => [key.toLowerCase(), String(value)]));
}

function resourceCharset(resource) {
  if (resource.bodyCharset !== undefined) return resource.bodyCharset;
  const declared = contentType(resource.headers || {});
  const type = declared && !/^application\/octet-stream/i.test(declared) ? declared : resource.mimeType || declared;
  return isTextualType(type) ? detectCharset({ contentType: type, body: resource.body }) : null;
}

function httpRequestPayload(method, url, requestContentType, body) {
  const target = new URL(url);
  const lines = [`${method} ${target.pathname}${target.search} HTTP/1.1`, `host: ${target.host}`];
  if (requestContentType) lines.push(`content-type: ${requestContentType}`);
  lines.push(`content-length: ${body.length}`);
  return Buffer.concat([Buffer.from(`${lines.join('\r\n')}\r\n\r\n`), body]);
}

function httpPayload(status, headers, body, bodyCharset = null) {
  const statusText = status === 200 ? 'OK' : '';
  const headerLines = Object.entries(headers)
    .filter(([key]) => !['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase()))
    .map(([key, value]) => key.toLowerCase() === 'content-type' && bodyCharset && charsetFromContentType(value) && charsetFromContentType(value) !== bodyCharset
      ? [key, withCharset(value, bodyCharset)]
      : [key, value]);
  if (body.length || Object.keys(headers).some((key) => key.toLowerCase() === 'content-length')) headerLines.push(['content-length', String(body.length)]);
  return Buffer.concat([
    Buffer.from(`HTTP/1.1 ${status} ${statusText}\r\n${headerLines.map(([key, value]) => `${key}: ${value}`).join('\r\n')}\r\n\r\n`),
    body
  ]);
}

function extractLinks(html, baseUrl) {
  const links = [];
  const pattern = /<(?:a|area)\b[^>]*?\bhref\s*=\s*["']([^"']+)["']/gi;
  for (const match of html.matchAll(pattern)) {
    try { links.push(normalizeUrl(match[1], baseUrl)); } catch {}
  }
  return [...new Set(links)];
}

function limited(items, limit) {
  return limit === null || limit === undefined ? items : items.slice(0, limit);
}

function reached(value, limit) {
  return limit !== null && limit !== undefined && value >= limit;
}

const INTERNAL_REDIRECT_LIMIT = 50;

function authenticationRedirectIdentity(input) {
  try {
    const url = new URL(input);
    const path = url.pathname.toLowerCase();
    if (!/(?:^|\/)(?:login|log-in|signin|sign-in|auth|authentication|customer-authentication|customer_authentication|authorize|oauth|sso)(?:\/|$)/.test(path)) return null;
    return `${url.origin}${path.replace(/\/+$/, '') || '/'}`;
  } catch { return null; }
}

export async function safeFetch(url, options = {}) {
  let current = url;
  const redirects = [];
  const seenRedirects = new Set();
  const seenAuthenticationTargets = new Set();
  const totalTimeoutMs = Math.max(1000, Number(options.timeoutMs ?? options.requestTimeoutMs ?? 30000));
  const deadline = Date.now() + totalTimeoutMs;
  const maxRedirects = options.maxRedirects === null ? INTERNAL_REDIRECT_LIMIT : Math.min(options.maxRedirects ?? 8, INTERNAL_REDIRECT_LIMIT);
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('リダイレクトを含む取得全体がタイムアウトしました。');
    const checked = await assertPublicUrl(current, options.policyOptions);
    const target = new URL(checked.url);
    const client = target.protocol === 'https:' ? https : http;
    const response = await new Promise((resolve, reject) => {
      const request = client.request({
        host: checked.addresses[0], port: target.port || (target.protocol === 'https:' ? 443 : 80),
        method: 'GET', path: `${target.pathname}${target.search}`,
        servername: target.hostname,
        headers: { host: target.host, 'user-agent': 'WebCapture/1.0 (+local archival)', accept: '*/*', 'accept-encoding': 'gzip, deflate, br' },
        lookup: (_hostname, _lookupOptions, callback) => callback(null, checked.addresses[0], net.isIP(checked.addresses[0]))
      }, async (incoming) => {
        try {
          const max = options.responseMaxBytes === null ? null : (options.responseMaxBytes || 256 * 1024 * 1024);
          const declared = Number(incoming.headers['content-length'] || 0);
          if (max !== null && declared > max) throw new Error('1件の取得上限を超えています。');
          const status = incoming.statusCode || 0;
          if (options.bodySink && status >= 200 && status < 300) {
            const encoding = String(incoming.headers['content-encoding'] || '').toLowerCase();
            const decoder = encoding === 'gzip' ? zlib.createGunzip() : encoding === 'deflate' ? zlib.createInflate() : encoding === 'br' ? zlib.createBrotliDecompress() : null;
            const source = decoder ? incoming.pipe(decoder) : incoming;
            let streamed = 0;
            for await (const chunk of source) {
              streamed += chunk.length;
              if (max !== null && streamed > max) { incoming.destroy(); throw new Error('1件の取得上限を超えています。'); }
              await options.bodySink(chunk);
            }
            const headers = new Headers();
            for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && name !== 'content-encoding' && name !== 'content-length') headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
            headers.set('content-length', String(streamed));
            resolve({ status, ok: true, headers, streamedBytes: streamed, arrayBuffer: async () => Buffer.alloc(0), text: async () => '' });
            return;
          }
          const chunks = []; let size = 0;
          for await (const chunk of incoming) {
            size += chunk.length;
            if (max !== null && size > max) { incoming.destroy(); throw new Error('1件の取得上限を超えています。'); }
            chunks.push(chunk);
          }
          let body = Buffer.concat(chunks);
          const encoding = String(incoming.headers['content-encoding'] || '').toLowerCase();
          const decompressionOptions = max === null ? {} : { maxOutputLength: max };
          if (encoding === 'gzip') body = zlib.gunzipSync(body, decompressionOptions);
          else if (encoding === 'deflate') body = zlib.inflateSync(body, decompressionOptions);
          else if (encoding === 'br') body = zlib.brotliDecompressSync(body, decompressionOptions);
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers)) if (value !== undefined && name !== 'content-encoding' && name !== 'content-length') headers.set(name, Array.isArray(value) ? value.join(', ') : String(value));
          headers.set('content-length', String(body.length));
          resolve({ status: incoming.statusCode || 0, ok: (incoming.statusCode || 0) >= 200 && (incoming.statusCode || 0) < 300, headers, arrayBuffer: async () => body, text: async () => body.toString('utf8') });
        } catch (error) { reject(error); }
      });
      const hardTimeout = setTimeout(() => request.destroy(new Error('リダイレクトを含む取得全体がタイムアウトしました。')), remainingMs);
      request.setTimeout(Math.min(totalTimeoutMs, remainingMs), () => request.destroy(new Error('取得がタイムアウトしました。')));
      const abort = () => request.destroy(new Error('保存を中止しました。'));
      if (options.signal?.aborted) abort();
      else options.signal?.addEventListener('abort', abort, { once: true });
      request.once('close', () => { clearTimeout(hardTimeout); options.signal?.removeEventListener('abort', abort); });
      request.once('error', reject); request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop >= maxRedirects) throw new Error('リダイレクト回数が設定上限を超えています。');
      const location = response.headers.get('location');
      if (!location) throw new Error('転送先のないリダイレクトです。');
      const targetUrl = normalizeUrl(location, current);
      if (seenRedirects.has(targetUrl)) throw new Error('リダイレクトが循環しています。');
      const authIdentity = authenticationRedirectIdentity(targetUrl);
      if (authIdentity && seenAuthenticationTargets.has(authIdentity)) throw new Error('ログインページへのリダイレクトが循環しています。');
      if (authIdentity) seenAuthenticationTargets.add(authIdentity);
      seenRedirects.add(current);
      redirects.push({ url: current, targetUrl, status: response.status, headers: headersObject(response.headers) });
      current = targetUrl;
      continue;
    }
    return { response, finalUrl: current, redirects };
  }
  throw new Error('リダイレクト回数が設定上限を超えています。');
}

const FILE_EXTENSION = /\.(?:pdf|zip|rar|7z|gz|tgz|tar|bz2|xz|dmg|exe|msi|apk|iso|docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv|tsv|epub|mobi|mp3|m4a|aac|wav|flac|ogg|oga|opus|mp4|m4v|mov|webm|mkv|avi|wmv|jpe?g|png|gif|webp|avif|bmp|tiff?|ico|psd|ai|eps|ttf|otf|woff2?)$/i;

export function looksLikeFileUrl(value) {
  try { return FILE_EXTENSION.test(decodeURIComponent(new URL(value).pathname)); } catch { return false; }
}

export async function captureFile(url, options = {}) {
  const limit = options.mediaMaxBytes === undefined ? options.responseMaxBytes : options.mediaMaxBytes;
  const name = decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || new URL(url).hostname);
  try {
    const capture = await captureStatic(url, { ...options, responseMaxBytes: limit ?? null });
    return { ...capture, html: '', links: [], title: name, fileDocument: true };
  } catch (error) {
    if (!/取得上限を超え/.test(error.message || '')) throw error;
    const reason = `ファイルが1件の上限を超えるため未保存です。アーカイブ画面からあとで保存できます。`;
    return {
      url, title: name, html: '', links: [], screenshot: null, resources: [], redirects: [], engine: 'HTTP', fileDocument: true,
      blocked: [{ url, reason }], deferredMedia: [{ url, kind: 'file', expectedBytes: null, limitBytes: limit, reason }]
    };
  }
}

async function captureStatic(url, options) {
  const { response, finalUrl, redirects } = await safeFetch(url, options);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (options.responseMaxBytes !== null && declaredLength > options.responseMaxBytes) throw new Error('1件の取得上限を超えています。');
  const body = Buffer.from(await response.arrayBuffer());
  if (options.responseMaxBytes !== null && body.length > options.responseMaxBytes) throw new Error('1件の取得上限を超えています。');
  const type = contentType(response.headers);
  const bodyCharset = isTextualType(type) ? detectCharset({ contentType: type, body }) : null;
  const html = type.includes('text/html') ? decodeText(body, bodyCharset) : '';
  return {
    url: finalUrl, title: html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim() || new URL(finalUrl).hostname,
    html, links: extractLinks(html, finalUrl).map((item) => ({ url: item, text: '' })), screenshot: null,
    resources: [{ url: finalUrl, status: response.status, headers: headersObject(response.headers), mimeType: type, body, bodyCharset, type: 'Document' }],
    blocked: [], redirects, engine: 'HTTP'
  };
}

export async function recoverEmptyResourceBodies(capture, options = {}, diagnostic = {}) {
  const candidates = (capture.resources || []).filter((resource) =>
    resource?.body?.length === 0 && resource.status >= 200 && resource.status < 300 && ![204, 205].includes(resource.status) &&
    /^https?:/i.test(resource.url) && !options.knownResourceUrls?.has(resource.url)
  );
  if (!candidates.length) return capture;
  let cursor = 0;
  let recovered = 0;
  const recoveredUrls = new Set();
  const failedUrls = new Set();
  const failures = [];
  const workers = Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const resource = candidates[cursor++];
      try {
        const { response, finalUrl } = await safeFetch(resource.url, options);
        const body = Buffer.from(await response.arrayBuffer());
        if (!body.length && response.status === 200) {
          resource.status = response.status;
          resource.headers = headersObject(response.headers);
          resource.mimeType = contentType(response.headers) || resource.mimeType;
          resource.body = body;
          resource.emptyConfirmed = true;
          recoveredUrls.add(resource.url);
          continue;
        }
        if (!body.length) throw new Error('再取得した応答も空でした。');
        resource.aliases = [...new Set([...(resource.aliases || []), ...(finalUrl !== resource.url ? [finalUrl] : [])])];
        resource.status = response.status;
        resource.headers = headersObject(response.headers);
        resource.mimeType = contentType(response.headers) || resource.mimeType;
        resource.body = body;
        delete resource.bodyCharset;
        recovered += 1;
        recoveredUrls.add(resource.url);
      } catch (error) {
        failedUrls.add(resource.url);
        failures.push({ url: resource.url, reason: `空の素材本文を再取得できません: ${error.message}` });
      }
    }
  });
  await Promise.all(workers);
  capture.blocked = (capture.blocked || []).filter((item) =>
    !recoveredUrls.has(item.url) || !/^素材本体を取得できません:/.test(item.reason || '')
  );
  capture.resources = (capture.resources || []).filter((resource) =>
    !failedUrls.has(resource.url) || resource.body.length > 0
  );
  capture.blocked.push(...failures);
  logEvent(failures.length ? 'warn' : 'info', 'capture', 'resource.empty.recovery', {
    ...diagnostic, attempted: candidates.length, recovered, failed: failures.length
  });
  return capture;
}

export async function recoverMissingSrcsetResources(capture, options = {}, diagnostic = {}) {
  if (!capture.html || options.captureSrcsetCandidates !== true) return capture;
  const existing = new Set([
    ...(capture.resources || []).map((resource) => resource.url),
    ...(options.knownResourceUrls || [])
  ]);
  const candidates = [];
  const limit = options.maxSrcsetCandidates ?? Number.MAX_SAFE_INTEGER;
  for (const match of capture.html.matchAll(/\bsrcset\s*=\s*(["'])([\s\S]*?)\1/gi)) {
    for (const { url } of parseSrcset(match[2])) {
      const value = url.replace(/&amp;/gi, '&');
      if (!value || /^(?:data:|blob:)/i.test(value)) continue;
      try {
        const candidate = normalizeUrl(value, capture.url);
        if (!existing.has(candidate)) { existing.add(candidate); candidates.push(candidate); }
      } catch {}
      if (candidates.length >= limit) break;
    }
    if (candidates.length >= limit) break;
  }
  if (!candidates.length) return capture;
  let cursor = 0;
  const recovered = [];
  const failures = [];
  const workers = Array.from({ length: Math.min(8, candidates.length) }, async () => {
    while (cursor < candidates.length) {
      const url = candidates[cursor++];
      try {
        const { response, finalUrl } = await safeFetch(url, options);
        const body = Buffer.from(await response.arrayBuffer());
        if (!body.length) throw new Error('取得した応答が空でした。');
        recovered.push({
          url, aliases: finalUrl !== url ? [finalUrl] : [], status: response.status,
          headers: headersObject(response.headers), mimeType: contentType(response.headers),
          type: 'Image', body
        });
      } catch (error) {
        failures.push({ url, reason: `srcset画像候補を取得できません: ${error.message}` });
      }
    }
  });
  await Promise.all(workers);
  capture.resources.push(...recovered);
  capture.blocked ||= [];
  capture.blocked.push(...failures);
  logEvent(failures.length ? 'warn' : 'info', 'capture', 'resource.srcset.recovery', {
    ...diagnostic, attempted: candidates.length, recovered: recovered.length, failed: failures.length
  });
  return capture;
}

export async function recoverReferencedResources(capture, options = {}, diagnostic = {}) {
  const known = new Set([...(options.knownResourceUrls || []), ...(capture.resources || []).filter(item => item.status < 400 && item.body?.length).map(item => item.url)]);
  const queue = htmlAssetReferences(capture.html || '', capture.url);
  for (const resource of capture.resources || []) if (/text\/css/i.test(resource.mimeType || '') && resource.body?.length) queue.push(...cssAssetReferences(decodeText(resource.body, resourceCharset(resource) || 'utf-8'), resource.url));
  const seen = new Set(known);
  let attempted = 0;
  let recovered = 0;
  let originMissing = 0;
  const failures = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.requestTimeoutMs || 120000);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  try {
    while (queue.length && !signal.aborted) {
      const batch = [];
      while (queue.length && batch.length < Math.min(8, options.concurrency || 4)) {
        const url = queue.shift();
        if (!seen.has(url)) {seen.add(url);batch.push(url);}
      }
      if (!batch.length) continue;
      await Promise.all(batch.map(async url => {
        attempted += 1;
        try {
          const { response, finalUrl } = await safeFetch(url, { ...options, signal });
          if ([404, 410].includes(response.status)) {
            capture.resources.push({
              url, aliases: finalUrl !== url ? [finalUrl] : [], status: response.status, headers: headersObject(response.headers),
              mimeType: contentType(response.headers), body: Buffer.from(await response.arrayBuffer()), type: 'Other', originMissing: true
            });
            originMissing += 1;
            return;
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const body = Buffer.from(await response.arrayBuffer());
          if (!body.length && ![204, 205].includes(response.status)) throw new Error('素材の本文が空でした。');
          const mimeType = contentType(response.headers);
          if (/\.(?:m?js|css|png|jpe?g|gif|webp|woff2?)(?:[?#]|$)/i.test(url) && /text\/html/i.test(mimeType)) throw new Error('素材の代わりにHTMLページが返されました。');
          capture.resources.push({ url, aliases: finalUrl !== url ? [finalUrl] : [], status: response.status, headers: headersObject(response.headers), mimeType, body, type: /css/i.test(mimeType) ? 'Stylesheet' : /javascript/i.test(mimeType) ? 'Script' : /^image/i.test(mimeType) ? 'Image' : 'Other' });
          recovered += 1;
          if (/text\/css/i.test(mimeType)) queue.push(...cssAssetReferences(decodeText(body, detectCharset({ contentType: mimeType, body })), finalUrl));
        } catch (error) {failures.push({ url, reason: `参照素材を取得できません: ${error.message}` });}
      }));
    }
    if (queue.length) for (const url of new Set(queue.filter(url => !seen.has(url)))) failures.push({ url, reason: '参照素材の補完待機がタイムアウトしました。' });
  } finally {clearTimeout(timer);}
  capture.blocked ||= [];
  capture.blocked.push(...failures);
  capture.referenceRecovery = { attempted, recovered, originMissing, failed: failures.length };
  logEvent(failures.length ? 'warn' : 'info', 'capture', 'resource.reference.recovery', { ...diagnostic, ...capture.referenceRecovery });
  return capture;
}

async function robotsAllows(url, options, cache) {
  if (!options.respectRobots) return true;
  const parsed = new URL(url);
  const key = parsed.origin;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      try {
        const { response } = await safeFetch(`${key}/robots.txt`, options);
        if (!response.ok) return [];
        const lines = (await response.text()).split(/\r?\n/);
        let active = false;
        const rules = [];
        for (const raw of lines) {
          const line = raw.replace(/#.*/, '').trim();
          const [name, ...rest] = line.split(':');
          const value = rest.join(':').trim();
          if (name?.toLowerCase() === 'user-agent') active = value === '*' || value.toLowerCase() === 'webcapture';
          else if (active && name?.toLowerCase() === 'disallow' && value) rules.push(value);
        }
        return rules;
      } catch { return []; }
    })());
  }
  const rules = await cache.get(key);
  return !rules.some((rule) => parsed.pathname.startsWith(rule));
}

export class CrawlManager {
  constructor(store, config) {
    this.store = store;
    this.config = config;
    this.running = new Map();
    this.abortControllers = new Map();
    this.closing = false;
    this.shutdownPromise = null;
    this.liveView = new LiveViewHub();
    this.tuners = new Map();
    this.loadGovernor = new CaptureLoadGovernor({
      captureLimit: config.globalCaptureConcurrency || 4,
      discoveryLimit: config.globalDiscoveryConcurrency || 8,
      systemMonitor: config.systemMonitor || null,
      lowImpact: config.lowImpactMode !== false,
      onPressure: (pressure) => this.liveView.setPressure(pressure)
    });
    this.liveView.setPressure(this.loadGovernor.pressure);
  }

  loadSnapshot() { return this.loadGovernor.snapshot(); }

  async browserInfo() {
    const executable = await findBrowser();
    return { available: Boolean(executable), name: executable ? path.basename(executable) : null };
  }

  start(jobId) {
    if (this.closing || this.running.has(jobId)) return;
    const promise = this.run(jobId).catch(async (error) => {
      const job = this.store.getJob(jobId);
      if (!job) return;
      logEvent('error', 'crawler', 'job.failed', { jobId, code: error.code || 'JOB_FAILED', message: error.message });
      if (this.store.repairRecoveryFailures?.has(job.archiveId)) {
        await this.store.updateJob(jobId, { status: 'paused', message: '保存処理の復旧待ちです。アプリを再起動してから再開してください。' });
        const archive = this.store.getArchive?.(job.archiveId);
        if (archive && archive.status === 'running') await this.store.addArchive({ ...archive, status: 'paused' });
        return;
      }
      if (!['paused', 'cancelled'].includes(job.status)) await this.store.updateJob(jobId, { status: 'failed', phase: 'complete', message: `保存を完了できませんでした: ${error.message}`, errors: Number(job.errors || 0) + 1 });
      if (job.status === 'paused') {
        const archive = this.store.getArchive?.(job.archiveId);
        if (archive && archive.status === 'running') await this.store.addArchive({ ...archive, status: 'paused' });
        return;
      }
      const manifest = await this.store.readManifest(job.archiveId) || { id: job.archiveId, startUrl: job.startUrl, pages: [], resources: {}, blocked: [] };
      manifest.status = job.status;
      manifest.completedAt = new Date().toISOString();
      manifest.blocked ||= [];
      manifest.blocked.push({ url: job.currentUrl || job.startUrl, reason: error.message });
      manifest.quality = summarizeArchiveQuality(manifest, job);
      await this.store.writeManifest(job.archiveId, manifest);
      await this.store.addArchive({ id: job.archiveId, startUrl: job.startUrl, title: manifest.pages[0]?.title || new URL(job.startUrl).hostname, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, savedAt: manifest.completedAt, quality: manifest.quality, partial: true });
      await this.store.finalizeJob?.(jobId);
    }).catch(error => logEvent('error', 'crawler', 'job.failure.record.failed', { jobId, message: error.message })).finally(() => {
      this.running.delete(jobId);
      if (this.store.getJob(jobId)?.status === 'queued') this.start(jobId);
    });
    this.running.set(jobId, promise);
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.closing = true;
    this.shutdownPromise = (async () => {
      const tasks = [...this.running.entries()];
      const pauses = await Promise.allSettled(tasks.map(async ([id]) => {
        const job = this.store.getJob(id);
        if (job && ['queued', 'running', 'discovering', 'pausing'].includes(job.status)) {
          try { await this.store.updateJob(id, { status: 'paused', message: 'アプリの停止により一時停止しました。' }); }
          finally { for (const controller of this.abortControllers.get(id) || []) controller.abort(); }
        }
      }));
      await Promise.allSettled(tasks.map(([, promise]) => promise));
      this.loadGovernor.close();
      for (const result of pauses) if (result.status === 'rejected') throw result.reason;
    })();
    return this.shutdownPromise;
  }

  async pause(id) {
    for (const controller of this.abortControllers.get(id) || []) controller.abort();
    return this.store.updateJob(id, { status: 'paused', message: '一時停止しました。' });
  }
  async cancel(id) {
    for (const controller of this.abortControllers.get(id) || []) controller.abort();
    if (this.store.getJob(id)?.status === 'discovered') {
      const job = await this.store.updateJob(id, { status: 'cancelled', phase: 'complete', message: '把握結果を破棄しました。' });
      await this.store.finalizeJob(id);
      return job;
    }
    return this.store.updateJob(id, { status: 'cancelled', message: '保存を中止しました。' });
  }

  async startCaptureFromDiscovery(id, { excludeHosts = [] } = {}) {
    const job = this.store.getJob(id);
    if (!job) return null;
    if (job.status !== 'discovered') throw Object.assign(new Error('この保存は把握結果の確認待ちではありません。'), { code: 'NOT_DISCOVERED', status: 409 });
    const excluded = new Set(excludeHosts);
    const hostOf = (value) => { try { return new URL(value).hostname; } catch { return ''; } };
    const queue = job.plannedQueue.filter((item) => !excluded.has(hostOf(item.url)));
    if (!queue.length) throw Object.assign(new Error('保存するページがありません。除外したサイトを見直してください。'), { code: 'NOTHING_TO_CAPTURE', status: 409 });
    const updated = await this.store.updateJob(id, {
      status: 'queued', phase: 'capturing', queue, plannedQueue: [], excludedHosts: [...excluded],
      options: { ...job.options, discoveryMode: 'complete' },
      message: `${queue.length}ページの保存を開始待ち`
    });
    logEvent('info', 'crawler', 'discovery.capture.started', { jobId: id, pages: queue.length, excludedHosts: excluded.size });
    this.start(id);
    return updated;
  }
  async resume(id) {
    const existing = await this.store.restoreJobQueue?.(id) || this.store.getJob(id);
    if (!existing) return null;
    if (existing.phase === 'complete') existing.phase = existing.plannedQueue?.length ? 'discovering' : 'capturing';
    const job = await this.store.updateJob(id, { status: 'queued', warning: null, message: '再開待ち' });
    const archive = job && this.store.getArchive?.(job.archiveId);
    if (archive && ['paused', 'warning'].includes(archive.status)) await this.store.addArchive({ ...archive, status: 'running' });
    if (job) this.start(id);
    return job;
  }

  jobsForArchive(archiveId) {
    return this.store.listJobs().filter((job) => job.archiveId === archiveId);
  }

  archiveBusy(archiveId) {
    if (this.store.maintenanceLocks?.has(archiveId)) return true;
    return this.jobsForArchive(archiveId).some((job) => ['queued', 'running', 'discovering', 'pausing', 'paused', 'warning'].includes(job.status));
  }

  remainingQueueCount(job) {
    if (!job) return 0;
    if (!job.terminalQueue) return (job.queue?.length || 0) + (job.inFlight?.length || 0) + (job.plannedQueue?.length || 0);
    return Number(job.queueCount || 0) + Number(job.inFlightCount || 0) + Number(job.plannedQueueCount || 0);
  }

  async retryPlan(archiveId) {
    const manifest = await this.store.readManifest(archiveId);
    if (!manifest) return null;
    const latest = this.jobsForArchive(archiveId)[0] || null;
    return {
      ...summarizeRetryPlan(buildRetryPlan(manifest)),
      busy: this.archiveBusy(archiveId),
      remainingCount: latest && !['paused', 'warning'].includes(latest.status) ? this.remainingQueueCount(latest) : 0,
      continueJobId: latest?.id || null
    };
  }

  async continueArchive(archiveId) {
    const latest = this.jobsForArchive(archiveId)[0];
    if (!latest) throw Object.assign(new Error('このアーカイブの保存記録が見つかりません。'), { code: 'NOT_FOUND', status: 404 });
    if (this.archiveBusy(archiveId)) throw Object.assign(new Error('このアーカイブは保存中または一時停止中です。'), { code: 'ARCHIVE_BUSY', status: 409 });
    if (!this.remainingQueueCount(latest)) throw Object.assign(new Error('続きから保存できるページが残っていません。'), { code: 'NOTHING_TO_CONTINUE', status: 409 });
    const job = await this.resume(latest.id);
    const archive = this.store.getArchive(archiveId);
    if (archive) await this.store.addArchive({ ...archive, status: 'running' });
    logEvent('info', 'crawler', 'archive.continued', { archiveId, jobId: latest.id, remaining: this.remainingQueueCount(job) });
    return job;
  }

  async retryArchive(archiveId, { loginProfileId = null, loginHosts = [], skipHosts = [], includeFailed = true, optionOverrides = {}, reason = '' } = {}) {
    if (this.archiveBusy(archiveId)) throw Object.assign(new Error('このアーカイブは保存中または一時停止中です。'), { code: 'ARCHIVE_BUSY', status: 409 });
    const manifest = await this.store.readManifest(archiveId);
    const archive = this.store.getArchive(archiveId);
    if (!manifest || !archive) throw Object.assign(new Error('保存済みサイトが見つかりません。'), { code: 'NOT_FOUND', status: 404 });
    const plan = buildRetryPlan(manifest);
    const wantsLogin = loginHosts.length > 0;
    if (wantsLogin && !loginProfileId) throw Object.assign(new Error('ログイン状態で保存し直すには、使うログイン情報を選んでください。'), { code: 'LOGIN_PROFILE_REQUIRED', status: 400 });
    const queue = retryQueue(plan, { loginHosts, skipHosts, includeFailed });
    if (!queue.length && !plan.missingResourceCount) throw Object.assign(new Error('取り直す対象がありません。'), { code: 'NOTHING_TO_RETRY', status: 409 });
    const source = this.jobsForArchive(archiveId)[0] || null;
    const options = { ...(source?.options || manifest.options || {}), ...optionOverrides, retryLoginProfileId: wantsLogin ? loginProfileId : null, discoveryMode: 'immediate' };
    const job = await this.store.addRetryJob({ archiveId, startUrl: manifest.startUrl, options, queue, sourceJobId: source?.id || null, bytes: archive.bytes });
    await this.store.addArchive({ ...archive, status: 'running' });
    logEvent('info', 'crawler', 'archive.retry.started', { archiveId, jobId: job.id, reason: reason || 'manual', overrides: Object.keys(optionOverrides), pages: queue.length, loginPages: queue.filter((item) => item.login).length, missingResources: plan.missingResourceCount });
    this.start(job.id);
    return job;
  }

  async resaveArchive(archiveId) {
    const archive = this.store.getArchive(archiveId);
    const manifest = await this.store.readManifest(archiveId);
    if (!archive || !manifest) throw Object.assign(new Error('保存済みサイトが見つかりません。'), { code: 'NOT_FOUND', status: 404 });
    const source = this.jobsForArchive(archiveId).find((job) => !job.kind) || this.jobsForArchive(archiveId)[0] || null;
    const { retryLoginProfileId, ...previousOptions } = source?.options || manifest.options || {};
    const options = { ...previousOptions, sharePages: false, optimize: false };
    const job = await this.store.addJob({ startUrl: archive.startUrl || manifest.startUrl, options });
    await this.store.updateJob(job.id, { previousArchiveId: archiveId, message: '前回との比較のため再保存を開始待ち' });
    logEvent('info', 'crawler', 'archive.resave.started', { archiveId, jobId: job.id, newArchiveId: job.archiveId });
    this.start(job.id);
    return job;
  }

  async resolveWarning(id, action, suppress) {
    const job = this.store.getJob(id);
    if (!job?.warning) return null;
    if (action === 'stop') return this.store.updateJob(id, { status: 'paused', warning: null, message: '警告地点で停止しました。' });
    const grant = {
      scope: job.warning.scope, metric: job.warning.metric || 'depth', threshold: job.warning.threshold,
      host: suppress ? '*' : new URL(job.warning.url).hostname, suppress: Boolean(suppress)
    };
    await this.store.updateJob(id, { status: 'queued', warning: null, warningGrants: [...job.warningGrants, grant], message: '警告を確認して再開します。' });
    this.start(id);
    return this.store.getJob(id);
  }

  hasGrant(job, warning) {
    return job.warningGrants.some((grant) => grant.scope === warning.scope &&
      (grant.metric || 'depth') === warning.metric && grant.threshold === warning.threshold &&
      (grant.host === '*' || grant.host === new URL(warning.url).hostname));
  }

  tuningSnapshot(id) {
    return this.tuners.get(id)?.snapshot() || null;
  }

  createTuner(id, job) {
    const saved = job.tuning || {};
    const tuner = new ConcurrencyTuner({
      capture: saved.capture ?? Math.min(Number(job.options?.concurrency) || OPTIMIZE_START.capture, OPTIMIZE_START.capture),
      discovery: saved.discovery ?? Math.min(Number(job.options?.discoveryConcurrency) || OPTIMIZE_START.discovery, OPTIMIZE_START.discovery),
      cooldownMs: this.config.tuningCooldownMs,
      onChange: (entry, snapshot) => {
        logEvent('info', 'tuning', 'reduced', { jobId: id, ...entry });
        this.store.updateJob(id, { tuning: snapshot }).catch(() => {});
      }
    });
    tuner.unsubscribe = this.config.systemMonitor?.subscribe?.((metrics) => {
      const phase = this.store.getJob(id)?.phase;
      tuner.onMetrics(metrics, phase === 'discovering' ? 'discovery' : 'capture');
    }) || null;
    this.tuners.set(id, tuner);
    return tuner;
  }

  async run(id) {
    const job = this.store.getJob(id);
    const tuner = job?.options?.optimize ? this.createTuner(id, job) : null;
    if (tuner) await this.store.updateJob(id, { tuning: tuner.snapshot() });
    try {
      return await this.runJob(id);
    } finally {
      if (tuner) {
        tuner.unsubscribe?.();
        this.tuners.delete(id);
        const current = this.store.getJob(id);
        if (current) await this.store.updateJob(id, { tuning: tuner.snapshot() }).catch(() => {});
        await Promise.resolve(this.config.onTuningResult?.({ jobId: id, startUrl: job.startUrl, status: current?.status || '', capture: tuner.capture, discovery: tuner.discovery, reductionCount: tuner.reductions.length, updatedAt: new Date().toISOString() })).catch(() => {});
      }
    }
  }

  async runJob(id) {
    const job = this.store.getJob(id);
    if (!job || ['complete', 'complete-with-errors', 'cancelled', 'limit-reached', 'failed', 'blocked', 'login-required', 'discovered'].includes(job.status)) return;
    const tuner = this.tuners.get(id) || null;
    this.store.assertArchiveWritable?.(job.archiveId);
    const previousOptions = job.options || {};
    job.options = {
      ...this.config.defaultLimits,
      ...previousOptions,
      resourceTypes: {
        ...(this.config.defaultLimits.resourceTypes || {}),
        ...(previousOptions.resourceTypes || {})
      }
    };
    job.inFlight ||= [];
    job.phase ||= job.options.discoveryMode === 'immediate' ? 'capturing' : 'discovering';
    job.plannedQueue ||= [];
    job.discoveryVisited ||= [];
    job.discoveredPages ||= 0;
    const started = Date.now();
    const archiveRoot = this.store.archiveRoot(job.archiveId);
    await fs.mkdir(path.join(archiveRoot, 'screenshots'), { recursive: true });
    let manifest = structuredClone(await this.store.readManifest(job.archiveId) || {
      schemaVersion: 2, id: job.archiveId, startUrl: job.startUrl, createdAt: job.createdAt,
      engine: null, pages: [], resources: {}, resourceAliases: {}, blocked: [], options: job.options
    });
    manifest.resourceAliases ||= {};
    manifest.options = { ...job.options };
    // Older/resumed captures may have counted the same network response once per page.
    // The manifest is canonical, so keep the visible counter aligned with unique files.
    job.resources = Object.keys(manifest.resources || {}).length;
    job.pages = manifest.pages.length;
    job.visitedDetails = (manifest.pages || []).map((page) => ({
      url: page.url, depth: page.depth, scope: page.scope, externalDepth: page.externalDepth
    }));
    const canonicalDocumentUrl = (value, baseUrl) => applyQueryPolicy(normalizeUrl(value, baseUrl), job.options.queryPolicy);
    const robotsCache = new Map();
    const blockedKeys = new Set((manifest.blocked || []).map((item) => `${item.url}\n${item.reason}`));
    const addBlocked = (item) => {
      const key = `${item.url}\n${item.reason}`;
      if (blockedKeys.has(key)) return;
      blockedKeys.add(key);
      manifest.blocked.push(item);
    };
    const visited = new Set(job.visited.map((item) => { try { return canonicalDocumentUrl(item); } catch { return item; } }));
    for (const page of manifest.pages) {
      for (const value of [page.requestedUrl, page.url]) {
        try { if (value) visited.add(canonicalDocumentUrl(value)); } catch {}
      }
    }
    const queuedByUrl = new Map();
    const stableKeys = new Set();
    const rememberStableKey = (value) => { const key = stableDocumentKey(value); if (key !== value) stableKeys.add(key); };
    for (const value of visited) rememberStableKey(value);
    const indexQueue = () => {
      queuedByUrl.clear();
      for (const item of job.queue) {
        try { const key = canonicalDocumentUrl(item.url); queuedByUrl.set(key, item); rememberStableKey(key); } catch {}
      }
    };
    indexQueue();
    const restoreInFlight = () => {
      for (const item of [...job.inFlight].reverse()) {
        if (queuedByUrl.has(item.url)) continue;
        job.queue.unshift(item);
        queuedByUrl.set(item.url, item);
      }
      job.inFlight = [];
    };
    const enqueue = (item) => {
      let candidate;
      try { candidate = canonicalDocumentUrl(item.url); } catch { return; }
      if (candidate !== canonicalDocumentUrl(job.startUrl) && !documentUrlAllowed(candidate, job.options)) {
        addBlocked({ url: candidate, reason: 'URLの対象・除外パターンにより保存対象外です。', depth: item.depth, externalDepth: item.externalDepth, from: item.from });
        return;
      }
      if (job.options.autoExcludeAccountPages === true && candidate !== canonicalDocumentUrl(job.startUrl) && isAccountLikeUrl(candidate)) {
        addBlocked({ url: candidate, reason: 'ログイン・カート・アカウント等のページのため自動で除外しました。', depth: item.depth, externalDepth: item.externalDepth, from: item.from });
        return;
      }
      if (visited.has(candidate)) return;
      if (job.inFlight.some((active) => {
        try { return canonicalDocumentUrl(active.url) === candidate; } catch { return active.url === candidate; }
      })) return;
      const existing = queuedByUrl.get(candidate);
      const stableKey = stableDocumentKey(candidate);
      if (!existing && stableKey !== candidate && stableKeys.has(stableKey)) return;
      const prepared = { ...item, url: candidate };
      if (!existing) { job.queue.push(prepared); queuedByUrl.set(candidate, prepared); if (stableKey !== candidate) stableKeys.add(stableKey); }
      else if ((existing.externalDepth ?? Number.MAX_SAFE_INTEGER) > item.externalDepth) Object.assign(existing, prepared);
    };
    const blockForExternalLimit = (url, depth, externalDepth, from) => {
      addBlocked({
        url, reason: `外部リンクの取得深度上限（${job.options.externalMaxDepth}）を超えるため保存しません。`,
        depth, externalDepth, from
      });
    };
    const blockForSameSiteLimit = (url, depth, from) => addBlocked({
      url, reason: `同一サイト内の取得深度上限（${job.options.sameSiteMaxDepth}）を超えるため保存しません。`,
      depth, externalDepth: 0, from
    });
    if (!['queued', 'running'].includes(job.status)) {
      if (job.status === 'cancelled') await this.finish(id, manifest);
      return;
    }

    if (job.phase === 'discovering') {
      const discoveryVisited = new Set(job.discoveryVisited.map((item) => { try { return canonicalDocumentUrl(item); } catch { return item; } }));
      const plannedUrls = new Set(job.plannedQueue.map((item) => { try { return canonicalDocumentUrl(item.url); } catch { return item.url; } }));
      const authenticationTargets = new Set(job.plannedQueue.map(item => authenticationRedirectIdentity(item.url)).filter(Boolean));
      const pageTarget = job.options.maxPages ?? Number.MAX_SAFE_INTEGER;
      const discoveryTarget = job.options.discoveryMode === 'partial'
        ? Math.min(pageTarget, job.options.discoveryPageLimit)
        : pageTarget;
      const useBrowserDiscovery = job.options.discoveryMethod === 'browser' && Boolean(await findBrowser());
      const discoveryLimit = () => {
        const configured = Math.max(1, Number(tuner ? tuner.discovery : job.options.discoveryConcurrency) || 8);
        return Math.min(configured, useBrowserDiscovery ? 120 : 256);
      };
      const hostCounts = new Map((job.discoveryHosts || []).map((item) => [item.host, item.count]));
      const countHost = (url) => { try { const host = new URL(url).hostname; hostCounts.set(host, (hostCounts.get(host) || 0) + 1); } catch {} };
      if (!job.discoveryHosts) for (const item of job.plannedQueue) countHost(item.url);
      const hostSummary = () => [...hostCounts.entries()].map(([host, count]) => ({ host, count })).sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)).slice(0, 300);
      const enqueueDiscovery = (item) => {
        let candidate;
        try { candidate = canonicalDocumentUrl(item.url); } catch { return; }
        if (candidate !== canonicalDocumentUrl(job.startUrl) && !documentUrlAllowed(candidate, job.options)) {
          addBlocked({ url: candidate, reason: 'URLの対象・除外パターンにより構造把握の対象外です。', depth: item.depth, externalDepth: item.externalDepth, from: item.from });
          return;
        }
        if (job.options.autoExcludeAccountPages === true && candidate !== canonicalDocumentUrl(job.startUrl) && isAccountLikeUrl(candidate)) {
          addBlocked({ url: candidate, reason: 'ログイン・カート・アカウント等のページのため自動で除外しました。', depth: item.depth, externalDepth: item.externalDepth, from: item.from });
          return;
        }
        if (discoveryVisited.has(candidate) || plannedUrls.has(candidate) || discoveryActiveUrls.has(candidate)) return;
        const stableKey = stableDocumentKey(candidate);
        if (stableKey !== candidate && stableKeys.has(stableKey)) return;
        if (!queuedByUrl.has(candidate)) {
          const prepared = { ...item, url: candidate };
          job.queue.push(prepared); queuedByUrl.set(candidate, prepared);
          if (stableKey !== candidate) stableKeys.add(stableKey);
        }
      };
      await this.store.updateJob(id, { status: 'running', phase: 'discovering', message: useBrowserDiscovery ? 'ブラウザでページ構造を把握中' : 'ページ構造を把握中' });
      const discoveryActive = new Set();
      const discoveryActiveUrls = new Set();
      const discoveryControllers = new Set();
      this.abortControllers.set(id, discoveryControllers);
      let discoveryWarning = null;
      let discoverySession = null;
      const discoveryLoginPreparer = job.options.loginProfileId && this.config.loginProfiles ? (dir) => this.config.loginProfiles.copyInto(job.options.loginProfileId, dir) : undefined;
      const getDiscoverySession = async () => {
        if (discoverySession) {
          const current = await discoverySession.catch(() => null);
          if (current?.alive !== false) return current;
          current?.close().catch(() => {});
          discoverySession = null;
        }
        const browserPath = await findBrowser();
        discoverySession = createBrowserCaptureSession({ ...job.options, executable: browserPath, prepareProfile: discoveryLoginPreparer });
        discoverySession.catch(() => { discoverySession = null; });
        return discoverySession;
      };
      let lastProgressAt = 0;
      const saveProgress = async (force = false, current = null) => {
        if (!force && Date.now() - lastProgressAt < 1500) return;
        lastProgressAt = Date.now();
        job.discoveredPages = job.plannedQueue.length;
        job.discoveryHosts = hostSummary();
        await this.store.updateJob(id, {
          phase: 'discovering', discoveredPages: job.discoveredPages, discoveryHosts: job.discoveryHosts,
          ...(current ? { currentUrl: current.url, depth: current.depth } : {}),
          message: `${job.discoveredPages}ページの構造を把握済み`
        });
        await this.store.writeManifest(job.archiveId, manifest);
        await this.store.persistJob(id);
      };
      const pickDiscovery = () => {
        while (job.queue.length) {
          const current = job.queue.shift();
          let normalized;
          try { normalized = canonicalDocumentUrl(current.url); } catch { continue; }
          queuedByUrl.delete(normalized);
          if (discoveryVisited.has(normalized) || plannedUrls.has(normalized) || discoveryActiveUrls.has(normalized)) continue;
          const scope = classifyScope(job.startUrl, normalized, job.options);
          const externalDepth = scope === 'external' ? Math.max(1, Number(current.externalDepth) || 1) : 0;
          if (scope === 'external' && !job.options.followExternal) continue;
          if (scope === 'external' && job.options.externalMaxDepth !== null && externalDepth > job.options.externalMaxDepth) {
            blockForExternalLimit(normalized, current.depth, externalDepth, current.from); continue;
          }
          if (scope !== 'external' && job.options.sameSiteMaxDepth !== null && current.depth > job.options.sameSiteMaxDepth) {
            blockForSameSiteLimit(normalized, current.depth, current.from); continue;
          }
          const prepared = { ...current, url: normalized, scope, externalDepth };
          const warning = warningForDepth({ startUrl: job.startUrl, url: normalized, depth: current.depth, externalDepth, ...job.options });
          if (warning && !this.hasGrant(job, warning)) {
            job.queue.unshift(current); indexQueue(); discoveryWarning = { warning, current: prepared };
            return null;
          }
          return prepared;
        }
        return null;
      };
      const discoverOne = async (current) => {
        const controller = new AbortController();
        discoveryControllers.add(controller);
        try {
          if (job.status !== 'running') controller.abort();
          const options = { ...job.options, signal: controller.signal };
          return await this.loadGovernor.discovery.run(async () => {
            if (!await robotsAllows(current.url, options, robotsCache)) return { current, blockedByRobots: true };
            if (useBrowserDiscovery) {
              const session = await getDiscoverySession();
              const found = await discoverWithBrowser(current.url, { session, timeoutMs: Math.min(60000, Number(job.options.loadWaitMs) || 30000), maxLinks: job.options.maxLinksPerPage ?? 5000, signal: controller.signal });
              return { current, finalUrl: found.finalUrl, status: found.status, html: found.html, title: found.title, links: found.links, isHtml: true };
            }
            const capture = await safeFetch(current.url, options);
            const isHtml = contentType(capture.response.headers).includes('text/html');
            const html = isHtml ? await capture.response.text() : '';
            if (!isHtml) capture.response.body?.cancel?.().catch?.(() => {});
            return { current, finalUrl: capture.finalUrl, status: capture.response.status, html, isHtml };
          }, {
            signal: controller.signal,
            onAcquired: (waitedMs) => {
              if (waitedMs >= 250) logEvent('info', 'governor', 'permit.waited', { jobId: id, kind: 'discovery', waitedMs });
            }
          });
        } catch (error) { return { current, error }; }
        finally { discoveryControllers.delete(controller); }
      };
      const processDiscovery = (result) => {
        const { current } = result;
        discoveryVisited.add(current.url); job.discoveryVisited.push(current.url);
        if (result.blockedByRobots) {
          addBlocked({ url: current.url, reason: 'robots.txt', depth: current.depth, externalDepth: current.externalDepth });
          return;
        }
        if (result.error) {
          addBlocked({ url: current.url, reason: `構造把握: ${result.error.message}`, depth: current.depth, externalDepth: current.externalDepth });
          tuner?.onError('discovery', 'error');
          return;
        }
        const { finalUrl } = result;
        const finalDiscoveryScope = classifyScope(job.startUrl, finalUrl, job.options);
        if (finalDiscoveryScope === 'external' && !job.options.followExternal) {
          addBlocked({ url: finalUrl, reason: '構造把握中の転送先が外部サイトのため保存しません。', depth: current.depth, externalDepth: 1, from: current.url });
          return;
        }
        let canonicalFinal;
        try { canonicalFinal = canonicalDocumentUrl(finalUrl); } catch { return; }
        const authenticationTarget = authenticationRedirectIdentity(canonicalFinal);
        if (authenticationTarget && authenticationTargets.has(authenticationTarget)) {
          addBlocked({ url: current.url, reason: '構造把握のログイン誘導先は把握済みです。', from: finalUrl });
          return;
        }
        if (plannedUrls.has(canonicalFinal)) return;
        if (authenticationTarget) authenticationTargets.add(authenticationTarget);
        job.plannedQueue.push(current); plannedUrls.add(current.url); plannedUrls.add(canonicalFinal);
        countHost(current.url);
        if (!result.isHtml) return;
        const html = result.html || '';
        const quality = classifyCapturedPage({ startUrl: job.startUrl, requestedUrl: current.url, url: finalUrl, title: result.title || html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1] || '', html, resources: [{ type: 'Document', url: finalUrl, status: result.status }] });
        if (authenticationTarget && canonicalFinal !== current.url || quality.classification !== 'normal') return;
        const links = result.links || extractLinks(html, finalUrl);
        for (const link of limited(links, job.options.maxLinksPerPage)) {
          const linkDepth = current.depth + 1;
          let linkScope;
          try { linkScope = classifyScope(job.startUrl, link, job.options); } catch { continue; }
          const nextDepth = nextExternalDepth({
            startUrl: job.startUrl, currentUrl: finalUrl, currentExternalDepth: current.externalDepth,
            candidateUrl: link, sameSiteKeywords: job.options.sameSiteKeywords
          });
          if (nextDepth > 0 && !job.options.followExternal) continue;
          if (job.options.externalMaxDepth !== null && nextDepth > job.options.externalMaxDepth) { blockForExternalLimit(link, linkDepth, nextDepth, finalUrl); continue; }
          if (job.options.sameSiteMaxDepth !== null && nextDepth === 0 && linkDepth > job.options.sameSiteMaxDepth) { blockForSameSiteLimit(link, linkDepth, finalUrl); continue; }
          enqueueDiscovery({ url: link, depth: linkDepth, scope: linkScope, externalDepth: nextDepth, from: finalUrl });
        }
      };
      try {
        while (true) {
          if (job.status === 'running' && reached(Date.now() - started, job.options.maxDurationMs)) {
            await this.store.updateJob(id, { status: 'limit-reached', message: '構造把握中に時間上限へ達しました。' });
          }
          while (!discoveryWarning && job.status === 'running' && discoveryActive.size < discoveryLimit() && job.plannedQueue.length + discoveryActive.size < discoveryTarget) {
            const prepared = pickDiscovery();
            if (!prepared) break;
            job.inFlight.push(prepared);
            discoveryActiveUrls.add(prepared.url);
            const task = discoverOne(prepared).then(async (result) => {
              if (job.status !== 'running') return;
              job.inFlight = job.inFlight.filter((item) => item.url !== prepared.url);
              processDiscovery(result);
              await saveProgress(false, prepared);
            }).finally(() => {
              discoveryActive.delete(task);
              discoveryActiveUrls.delete(prepared.url);
            });
            discoveryActive.add(task);
          }
          if (!discoveryActive.size) break;
          await Promise.race(discoveryActive);
        }
      } finally {
        if (job.status !== 'running') for (const controller of discoveryControllers) controller.abort();
        await Promise.allSettled([...discoveryActive]);
        this.abortControllers.delete(id);
        const session = discoverySession ? await discoverySession.catch(() => null) : null;
        await session?.close().catch(() => {});
      }
      job.discoveredPages = job.plannedQueue.length;
      job.discoveryHosts = hostSummary();
      if (discoveryWarning && job.status === 'running') {
        await this.store.writeManifest(job.archiveId, manifest);
        await this.store.updateJob(id, { status: 'warning', warning: discoveryWarning.warning, message: '構造把握の範囲確認が必要です。', currentUrl: discoveryWarning.current.url, depth: discoveryWarning.current.depth, discoveredPages: job.discoveredPages, discoveryHosts: job.discoveryHosts });
        return;
      }
      if (job.status !== 'running') {
        restoreInFlight();
        await this.store.persistJob(id);
        await this.store.writeManifest(job.archiveId, manifest);
        if (['cancelled', 'limit-reached'].includes(job.status)) await this.finish(id, manifest);
        return;
      }
      if (job.options.discoveryMode === 'separate') {
        job.phase = 'discovered';
        manifest.discovery = { mode: 'separate', method: useBrowserDiscovery ? 'browser' : 'http', discoveredPages: job.discoveredPages, hosts: job.discoveryHosts, discoveredAt: new Date().toISOString() };
        await this.store.writeManifest(job.archiveId, manifest);
        await this.store.updateJob(id, {
          status: 'discovered', phase: 'discovered', discoveredPages: job.discoveredPages, discoveryHosts: job.discoveryHosts, currentUrl: '',
          message: `${job.discoveredPages}ページを把握しました。内容を確認して保存を開始できます。`
        });
        logEvent('info', 'crawler', 'discovery.completed', { jobId: id, archiveId: job.archiveId, pages: job.discoveredPages, hosts: job.discoveryHosts.length, method: useBrowserDiscovery ? 'browser' : 'http' });
        return;
      }
      job.queue = job.plannedQueue;
      job.plannedQueue = [];
      job.phase = 'capturing';
      indexQueue();
      await this.store.updateJob(id, {
        status: 'running', phase: 'capturing', queue: job.queue, plannedQueue: [], discoveredPages: job.discoveredPages, discoveryHosts: job.discoveryHosts,
        message: `${job.discoveredPages}ページの構造把握が完了。内容を保存中`, currentUrl: ''
      });
    }

    await this.store.updateJob(id, { status: 'running', message: '保存中' });
    logEvent('info', 'crawler', 'job.running', { jobId: id, archiveId: job.archiveId, phase: job.phase, startUrl: safeUrl(job.startUrl) });
    const browser = job.options.captureRendered ? await findBrowser() : null;
    let browserSessionRestarts = 0;
    const loginPreparer = job.options.loginProfileId && this.config.loginProfiles ? (dir) => this.config.loginProfiles.copyInto(job.options.loginProfileId, dir) : undefined;
    const retryLoginPreparer = job.options.retryLoginProfileId && this.config.loginProfiles ? (dir) => this.config.loginProfiles.copyInto(job.options.retryLoginProfileId, dir) : undefined;
    const sessionKindOf = (item) => item?.current?.login && retryLoginPreparer ? 'login' : 'main';
    const preparerFor = (item) => sessionKindOf(item) === 'login' ? retryLoginPreparer : loginPreparer;
    const sessionPromises = { main: null, login: null };
    const resetBrowserSession = async (session, reason) => {
      if (!session) return;
      for (const kind of Object.keys(sessionPromises)) {
        const current = sessionPromises[kind] ? await sessionPromises[kind].catch(() => null) : null;
        if (current !== session) continue;
        sessionPromises[kind] = null;
        browserSessionRestarts += 1;
        logEvent('warn', 'capture', 'browser.session.restarted', { jobId: id, archiveId: job.archiveId, reason, restarts: browserSessionRestarts, kind });
        session.close().catch(() => {});
      }
    };
    const getBrowserSession = async (kind = 'main') => {
      if (!browser || !job.options.browserReuse) return null;
      if (sessionPromises[kind]) {
        const current = await sessionPromises[kind].catch(() => null);
        if (current && !current.alive) await resetBrowserSession(current, current.handle?.exitCode !== null ? 'browser-exited' : 'browser-unresponsive');
      }
      if (!sessionPromises[kind]) {
        const prepareProfile = kind === 'login' ? retryLoginPreparer : loginPreparer;
        const created = createBrowserCaptureSession({ ...job.options, executable: browser, prepareProfile })
          .then((session) => { this.config.onBrowserSession?.(session); return session; })
          .catch((error) => { if (sessionPromises[kind] === created) sessionPromises[kind] = null; throw error; });
        sessionPromises[kind] = created;
      }
      return sessionPromises[kind];
    };
    try {
    const concurrencyLimit = Math.max(1, Number(job.options.concurrency) || 1);
    const controllers = new Set();
    this.abortControllers.set(id, controllers);
    const freeSlots = Array.from({ length: concurrencyLimit }, (_, index) => index);
    const active = new Set();
    const activeUrls = new Set();
    const pendingResults = [];
    let exclusiveTail = Promise.resolve();
    let warningHit = null;
    let limitHit = false;
    let fatalError = null;
    let lastArchivePublishAt = 0;
    const repairCandidates = new Map();
    let repairPhase = false;
    const exclusive = (task) => {
      const run = exclusiveTail.then(task);
      exclusiveTail = run.catch(() => {});
      return run;
    };
    const MEDIA_LANE = { slow: { workers: 1, bytesPerSecond: 3 * 1024 * 1024 }, normal: { workers: 2, bytesPerSecond: 0 }, fast: { workers: 4, bytesPerSecond: 0 } };
    const mediaLane = (() => {
      if (job.options.mediaStrategy !== 'background') return null;
      const setting = MEDIA_LANE[job.options.mediaSpeed] || MEDIA_LANE.normal;
      const pending = [];
      const queued = new Set();
      const laneController = new AbortController();
      controllers.add(laneController);
      let running = 0;
      let idleWaiters = [];
      const wake = () => { if (!running && (!pending.length || job.status !== 'running')) { for (const resolve of idleWaiters.splice(0)) resolve(); } };
      const throttle = (sink) => {
        if (!setting.bytesPerSecond) return sink;
        const startedAt = Date.now();
        let sent = 0;
        return async (chunk) => {
          await sink(chunk);
          sent += chunk.length;
          const due = (sent / setting.bytesPerSecond) * 1000 - (Date.now() - startedAt);
          if (due > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(due, 5000)));
        };
      };
      const saveUrl = async (url) => {
        let fetched;
        const blob = await this.store.writeBlobFromStream(job.archiveId, async (sink) => {
          fetched = await safeFetch(url, { ...job.options, requestTimeoutMs: 6 * 60 * 60 * 1000, responseMaxBytes: null, signal: laneController.signal, bodySink: throttle(sink) });
        });
        const { response, finalUrl } = fetched;
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!blob.size) throw new Error('取得した応答が空でした。');
        const headers = headersObject(response.headers);
        const capturedAt = new Date().toISOString();
        const record = { url, status: response.status, headers, mimeType: contentType(response.headers) || 'application/octet-stream', digest: blob.digest, file: blob.file, size: blob.size, capturedAt, completedLater: true, background: true };
        let warcChunk = Buffer.alloc(0);
        if (job.options.warcEnabled && blob.size <= 256 * 1024 ** 2) {
          const body = await fs.readFile(path.join(this.store.archiveRoot(job.archiveId), blob.file));
          warcChunk = await createWarcAsync([{ url, capturedAt, httpPayload: httpPayload(response.status, headers, body) }], { media: url }, job.options.warcCompressionLevel);
        } else if (job.options.warcEnabled) record.warcOmitted = true;
        return { record, finalUrl, warcChunk };
      };
      const commitSaved = (entry, saved, done) => exclusive(async () => {
        if (job.status !== 'running') return;
        for (const { record, finalUrl } of saved) {
          manifest.resources[record.url] = record;
          if (finalUrl && finalUrl !== record.url) manifest.resourceAliases[finalUrl] = record.url;
        }
        if (done) manifest.deferredMedia = (manifest.deferredMedia || []).filter((item) => item !== entry && item.url !== entry.url);
        const savedUrls = new Set(saved.map(({ record }) => record.url));
        manifest.blocked = manifest.blocked.filter((item) => !savedUrls.has(item.url));
        const warcChunk = Buffer.concat(saved.map((item) => item.warcChunk));
        job.resources = Object.keys(manifest.resources).length;
        job.bytes += saved.reduce((sum, item) => sum + item.record.size, 0) + warcChunk.length;
        this.store.beginCaptureBatch(id);
        let committed = false;
        try {
          await commitArchiveCapture(this.store, job.archiveId, { manifest, job, warcChunk }, { checkpoint: this.config.captureCommitCheckpoint });
          committed = true;
        } finally {
          this.store.endCaptureBatch(id, !committed);
        }
      });
      const processEntry = async (entry) => {
        if (entry.kind === 'stream') {
          const batch = [];
          for (const segment of [...(entry.remainingUrls || [])]) {
            if (job.status !== 'running') return;
            if (!manifest.resources[segment]) batch.push(await saveUrl(segment));
            entry.remainingUrls = entry.remainingUrls.filter((item) => item !== segment);
            if (batch.length >= 20) await commitSaved(entry, batch.splice(0), false);
          }
          await commitSaved(entry, batch, true);
        } else {
          await commitSaved(entry, [await saveUrl(entry.url)], true);
        }
        logEvent('info', 'crawler', 'media.lane.saved', { jobId: id, archiveId: job.archiveId, resourceUrl: safeUrl(entry.url), kind: entry.kind });
      };
      const pump = () => {
        while (running < setting.workers && pending.length && job.status === 'running') {
          const entry = pending.shift();
          running += 1;
          processEntry(entry).catch((error) => {
            if (job.status !== 'running') return;
            logEvent('warn', 'crawler', 'media.lane.failed', { jobId: id, archiveId: job.archiveId, resourceUrl: safeUrl(entry.url), message: String(error.message || error).slice(0, 200) });
            entry.failedAt = new Date().toISOString();
            entry.reason = `後から保存できませんでした: ${String(error.message || error).slice(0, 120)}`;
          }).finally(() => { running -= 1; queued.delete(entry.url); pump(); wake(); });
        }
      };
      return {
        enqueue(entry) {
          if (!entry?.background || queued.has(entry.url) || entry.failedAt) return;
          queued.add(entry.url);
          pending.push(entry);
          pump();
        },
        remaining: () => pending.length + running,
        async finish() {
          pump();
          if (!running && !pending.length) return;
          await new Promise((resolve) => { idleWaiters.push(resolve); wake(); });
        },
        stop() { laneController.abort(); pending.length = 0; wake(); }
      };
    })();
    for (const entry of manifest.deferredMedia || []) mediaLane?.enqueue(entry);
    const captureItem = async (item, slotIndex) => {
        const live = this.liveView.begin(id, slotIndex, item.normalized);
        if (item.current.scope === 'external' && !item.current.repair && job.options.sharePages !== false && this.config.sharedPages) {
          const shared = this.config.sharedPages.lookup(item.normalized, job.archiveId);
          if (shared) {
            live.phase('shared');
            return { ...item, shared };
          }
        }
        const controller = new AbortController();
        controllers.add(controller);
        const stallLimitMs = Number(this.config.stallLimitMs) || Math.round((item.current.repair ? 1.5 : 1) * Number(job.options.requestTimeoutMs || 30000))
          + Number(job.options.finalizeGraceMs ?? 45000) + Number(this.config.stallMarginMs ?? 60000);
        const guardStall = (work) => new Promise((resolve, reject) => {
          let settled = false;
          const finish = (callback, value) => { if (settled) return; settled = true; clearTimeout(timer); callback(value); };
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            controller.abort();
            job.stalledPages = Number(job.stalledPages || 0) + 1;
            logEvent('warn', 'crawler', 'page.stalled', { jobId: id, archiveId: job.archiveId, pageUrl: safeUrl(item.normalized), stallLimitMs });
            this.store.updateJob(id, { stalledPages: job.stalledPages }).catch(() => {});
            const error = new Error(`ページの保存が${Math.round(stallLimitMs / 1000)}秒を超えても終わらなかったため打ち切り、取り直しに回しました。`);
            error.code = 'PAGE_STALLED';
            reject(error);
          }, stallLimitMs);
          work(() => clearTimeout(timer)).then((value) => finish(resolve, value), (error) => finish(reject, error));
        });
        try {
          if (job.status !== 'running') controller.abort();
          const captured = await this.loadGovernor.capture.run(() => guardStall(async (captureFinished) => {
            live.phase('opening');
            await assertPublicUrl(item.normalized, job.options.policyOptions);
            if (!await robotsAllows(item.normalized, { ...job.options, signal: controller.signal }, robotsCache)) return { ...item, blockedByRobots: true };
            const knownResourceUrls = new Set(Object.values(manifest.resources).filter(resource => resource.status < 400 && (resource.size > 0 || resource.emptyConfirmed || [204, 205].includes(resource.status))).map(resource => resource.url));
            const session = await getBrowserSession(sessionKindOf(item));
            const acceptDocumentUrl = (documentUrl) => {
              let finalUrl;
              try { finalUrl = canonicalDocumentUrl(documentUrl); } catch { return true; }
              if (finalUrl === item.normalized || classifyScope(job.startUrl, finalUrl, job.options) !== 'external') return true;
              if (!job.options.followExternal) return false;
              if (job.options.externalMaxDepth === null) return true;
              return redirectChainExternalDepth({ startUrl: job.startUrl, requestedUrl: item.normalized, requestedExternalDepth: item.current.externalDepth, finalUrl, sameSiteKeywords: job.options.sameSiteKeywords }) <= job.options.externalMaxDepth;
            };
            let capture;
            if (looksLikeFileUrl(item.normalized)) {
              live.phase('file');
              capture = await captureFile(item.normalized, { ...job.options, signal: controller.signal });
            } else {
              try {
                if (!(job.options.captureRendered && browser)) live.phase('http');
                capture = job.options.captureRendered && browser
                  ? await captureWithBrowser(item.normalized, {
                    ...captureOptionsForScope(job.options, item.current.scope), executable: browser, session: session || undefined, liveView: live, prepareProfile: preparerFor(item),
                    acceptDocumentUrl,
                    timeoutMs: item.current.repair ? Math.round(job.options.requestTimeoutMs * 1.5) : job.options.requestTimeoutMs, responseMaxBytes: job.options.responseMaxBytes, signal: controller.signal,
                    diagnosticContext: { jobId: id, archiveId: job.archiveId, depth: item.current.depth }
                  })
                  : await captureStatic(item.normalized, { ...job.options, signal: controller.signal });
              } catch (error) {
                if (session && (error.code === 'BROWSER_UNAVAILABLE' || !session.alive)) await resetBrowserSession(session, error.code || 'browser-exited');
                if (error.code !== 'NON_HTML_DOCUMENT') throw error;
                live.phase('file');
                capture = await captureFile(item.normalized, { ...job.options, signal: controller.signal });
              }
              if (!capture.fileDocument && capture.engine === 'HTTP' && !/html|xml/i.test(capture.resources?.[0]?.mimeType || 'text/html')) capture.fileDocument = true;
            }
            captureFinished();
            if (job.options.captureMobile && job.options.captureRendered && browser && !capture.fileDocument && capture.html && capture.engine !== 'HTTP') {
              live.phase('mobile');
              try {
                const mobile = await captureWithBrowser(capture.url || item.normalized, {
                  ...captureOptionsForScope(job.options, item.current.scope), executable: browser, session: session || undefined, prepareProfile: preparerFor(item),
                  mobile: true, interactDuringCapture: false, hoverDuringCapture: false, acceptDocumentUrl,
                  timeoutMs: Math.min(Number(job.options.requestTimeoutMs) || 30000, 120000), finalizeGraceMs: Math.min(Number(job.options.finalizeGraceMs) || 45000, 60000),
                  responseMaxBytes: job.options.responseMaxBytes, signal: controller.signal,
                  diagnosticContext: { jobId: id, archiveId: job.archiveId, depth: item.current.depth, view: 'mobile' }
                });
                capture.mobile = { url: mobile.url || capture.url || item.normalized, html: mobile.html, title: mobile.title, screenshot: mobile.screenshot, resources: mobile.resources || [], userAgent: mobile.userAgent, viewport: mobile.viewport, partial: Boolean(mobile.partial) };
              } catch (error) {
                if (controller.signal.aborted) throw error;
                capture.blocked ||= [];
                capture.blocked.push({ url: capture.url || item.normalized, reason: `スマホ表示を保存できません: ${error.message}` });
                logEvent('warn', 'capture', 'page.mobile.failed', { jobId: id, archiveId: job.archiveId, pageUrl: safeUrl(item.normalized), message: error.message });
              }
            }
            live.phase('recovering');
            const recoveryOptions = { ...job.options, signal: controller.signal, knownResourceUrls };
            await recoverMissingSrcsetResources(capture, recoveryOptions, { jobId: id, archiveId: job.archiveId, depth: item.current.depth });
            await recoverEmptyResourceBodies(capture, recoveryOptions, { jobId: id, archiveId: job.archiveId, depth: item.current.depth });
            await recoverReferencedResources(capture, recoveryOptions, { jobId: id, archiveId: job.archiveId, depth: item.current.depth });
            if (job.options.prefetchScripts !== false && !capture.fileDocument) {
              live.phase('prefetching');
              await prefetchScriptReferences(capture, recoveryOptions, { jobId: id, archiveId: job.archiveId, depth: item.current.depth }, { fetcher: safeFetch });
            }
            await completeMediaResources(capture, recoveryOptions, safeFetch, { jobId: id, archiveId: job.archiveId, depth: item.current.depth });
            return { ...item, capture };
          }), {
            signal: controller.signal,
            onAcquired: (waitedMs) => {
              if (waitedMs >= 250) logEvent('info', 'governor', 'permit.waited', { jobId: id, kind: 'capture', waitedMs });
            }
          });
          live.phase(captured.blockedByRobots ? 'skipped' : 'done');
          return captured;
        } catch (error) {
          live.phase(error.code === 'OUT_OF_SCOPE_REDIRECT' ? 'skipped' : 'failed');
          return { ...item, error };
        } finally {
          controllers.delete(controller);
        }
    };
    const commitResults = async (results) => {
      if (job.status !== 'running') return;
      const batchWarcChunks = [];
      const indexedPages = [];
      const sharedIndexPages = [];
      const sharedReferences = new Set();
      this.store.beginCaptureBatch(id);
      let batchCommitted = false;
      try {
      for (const result of results) {
        if (job.status === 'cancelled' || job.status === 'limit-reached') break;
        const { current, normalized, capture } = result;
        job.inFlight = job.inFlight.filter((item) => item.url !== current.url);
        try {
          if (result.blockedByRobots) {
            if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
            addBlocked({ url: normalized, reason: 'robots.txt', depth: current.depth, externalDepth: current.externalDepth });
            continue;
          }
          if (result.shared) {
            if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
            manifest.sharedPages ||= [];
            if (!manifest.sharedPages.some((item) => item.url === normalized)) {
              manifest.sharedPages.push({ url: normalized, archiveId: result.shared.archiveId, pageUrl: result.shared.pageUrl, depth: current.depth, externalDepth: current.externalDepth, from: current.from, sharedAt: new Date().toISOString() });
            }
            sharedReferences.add(result.shared.archiveId);
            job.sharedPages = manifest.sharedPages.length;
            const { links } = await this.config.sharedPages.linksOf(result.shared.archiveId, result.shared.pageUrl);
            for (const link of limited(links, job.options.maxLinksPerPage)) {
              let target;
              try { target = canonicalDocumentUrl(String(link).replaceAll('&amp;', '&'), result.shared.pageUrl); } catch { continue; }
              const linkDepth = current.depth + 1;
              const externalDepth = nextExternalDepth({ startUrl: job.startUrl, currentUrl: normalized, currentExternalDepth: current.externalDepth, candidateUrl: target, sameSiteKeywords: job.options.sameSiteKeywords });
              if (externalDepth > 0 && !job.options.followExternal) continue;
              if (job.options.externalMaxDepth !== null && externalDepth > job.options.externalMaxDepth) { blockForExternalLimit(target, linkDepth, externalDepth, normalized); continue; }
              if (job.options.sameSiteMaxDepth !== null && externalDepth === 0 && linkDepth > job.options.sameSiteMaxDepth) { blockForSameSiteLimit(target, linkDepth, normalized); continue; }
              enqueue({ url: target, depth: linkDepth, scope: classifyScope(job.startUrl, target, job.options), externalDepth, from: normalized });
            }
            logEvent('info', 'crawler', 'page.shared', { jobId: id, archiveId: job.archiveId, pageUrl: safeUrl(normalized), sharedArchiveId: result.shared.archiveId });
            continue;
          }
          if (result.error) throw result.error;
          let finalUrl;
          try {
            finalUrl = canonicalDocumentUrl(capture.url || normalized);
          } catch (error) {
            const documentUrl = String(capture.url || '');
            const browserError = /^chrome-error:/i.test(documentUrl)
              ? capture.blocked?.find((item) => /^ページ(?:を開けませんでした|の読み込みが中断されました)|読み込みに失敗しました/.test(item?.reason || ''))?.reason
              : null;
            const unsupportedScheme = /^[a-z][a-z0-9+.-]*:/i.test(documentUrl) && !/^(?:https?|chrome-error|about|data|blob):/i.test(documentUrl);
            addBlocked({
              url: normalized,
              reason: browserError
                || (/^chrome-error:/i.test(documentUrl) ? 'ページを開けませんでした（ブラウザがエラーページを表示しました）。' : null)
                || (unsupportedScheme ? `転送先を保存できません: ${error.message}` : `ページの保存先URLを確定できません: ${error.message}`),
              depth: current.depth,
              externalDepth: current.externalDepth
            });
            if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
            logEvent('warn', 'crawler', 'page.document.unresolved', {
              jobId: id, archiveId: job.archiveId, pageUrl: safeUrl(normalized),
              code: unsupportedScheme ? 'UNSUPPORTED_REDIRECT' : 'DOCUMENT_URL_UNRESOLVED',
              documentScheme: documentUrl.split(':')[0] || 'unknown', message: error.message
            });
            continue;
          }
          const redirectedToAuthentication = finalUrl !== normalized && Boolean(authenticationRedirectIdentity(finalUrl));
          if (redirectedToAuthentication) {
            const identity = authenticationRedirectIdentity(finalUrl);
            const existingLoginPage = manifest.pages.find((page) => authenticationRedirectIdentity(page.url) === identity);
            if (existingLoginPage) {
              addBlocked({
                url: normalized,
                reason: `ログイン誘導先は保存済みです: ${existingLoginPage.url}`,
                depth: current.depth,
                externalDepth: current.externalDepth
              });
              settleRetry(current, normalized, 'recovered', 'ログイン誘導先（保存済み）へ転送');
              if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
              continue;
            }
          }
          if (finalUrl !== canonicalDocumentUrl(job.startUrl) && !documentUrlAllowed(finalUrl, job.options)) {
            addBlocked({ url: finalUrl, reason: '転送先がURLの対象・除外パターンにより保存対象外です。', depth: current.depth, externalDepth: current.externalDepth, from: normalized });
            settleRetry(current, normalized, 'skipped', '転送先が保存対象外');
            if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
            continue;
          }
          if (visited.has(finalUrl) && !current.repair) {
            if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
            addBlocked({ url: normalized, reason: `転送先は保存済みです: ${finalUrl}`, depth: current.depth, externalDepth: current.externalDepth });
            settleRetry(current, normalized, 'recovered', '転送先（保存済み）へ転送');
            continue;
          }
          const finalScope = classifyScope(job.startUrl, finalUrl, job.options);
          const effectiveExternalDepth = redirectChainExternalDepth({
            startUrl: job.startUrl, requestedUrl: normalized, requestedExternalDepth: current.externalDepth,
            finalUrl, sameSiteKeywords: job.options.sameSiteKeywords
          });
          if (finalScope === 'external' && !job.options.followExternal) {
            addBlocked({ url: finalUrl, reason: '転送先が外部サイトのため保存しません。', depth: current.depth, externalDepth: effectiveExternalDepth, from: normalized });
            settleRetry(current, normalized, 'skipped', '転送先が外部サイト');
            if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
            continue;
          }
          if (finalScope === 'external' && job.options.externalMaxDepth !== null && effectiveExternalDepth > job.options.externalMaxDepth) {
            blockForExternalLimit(finalUrl, current.depth, effectiveExternalDepth, current.from);
            settleRetry(current, normalized, 'skipped', '転送先が外部リンクの深さの上限を超える');
            if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
            continue;
          }
          const capturedStatus = capture.fileDocument ? 0 : documentStatus(capture.resources, finalUrl);
          if (retryableDocumentStatus(capturedStatus) && !repairPhase) tuner?.onError('capture', `HTTP ${capturedStatus}`);
          if (retryableDocumentStatus(capturedStatus) && scheduleRetry(current, normalized, `HTTP ${capturedStatus}`)) continue;
          manifest.engine ||= capture.engine;
          if (capture.mobile?.resources?.length) {
            const desktopKeys = new Set(capture.resources.map((resource) => { try { return normalizeUrl(resource.url); } catch { return resource.url; } }));
            for (const resource of capture.mobile.resources) {
              if (resource.type === 'Document' || resource.method === 'POST' || /^(?:data|blob|about):/i.test(String(resource.url || ''))) continue;
              let key;
              try { key = normalizeUrl(resource.url); } catch { continue; }
              if (desktopKeys.has(key) || manifest.resources[key]) continue;
              desktopKeys.add(key);
              capture.resources.push({ ...resource, mobileOnly: true });
            }
          }
          const pageResources = [];
          const validResourceMap = new Map();
          const postEntries = new Map();
          for (const resource of capture.resources) {
            if (/^(?:data|blob|about):/i.test(String(resource.url || ''))) continue;
            if (resource.method === 'POST') {
              try {
                if (resource.status >= 400 && !resource.body?.length) continue;
                const url = normalizeUrl(resource.url);
                const digests = requestBodyDigests(resource.requestBody);
                const key = postResponseKey('POST', url, digests.requestDigest);
                if (!manifest.postResponses?.[key] && !postEntries.has(key)) postEntries.set(key, { key, url, resource, ...digests, capturedAt: new Date().toISOString() });
              } catch (error) { addBlocked({ url: resource.url, reason: error.message, from: finalUrl }); }
              continue;
            }
            try {
              if (!resourceTypeAllowed(resource.type, job.options.resourceTypes)) continue;
              const key = normalizeUrl(resource.url);
              const previous = validResourceMap.get(key);
              if (!previous || resource.status < 400 && previous.resource.status >= 400 || (resource.status < 400) === (previous.resource.status < 400) && resource.body.length > previous.resource.body.length) validResourceMap.set(key, { resource, key, capturedAt: new Date().toISOString() });
            }
            catch (error) { addBlocked({ url: resource.url, reason: error.message, from: finalUrl }); }
          }
          const validResources = [...validResourceMap.values()];
          const needsWrite = ({ key, resource }) => !manifest.resources[key] || resource.status < 400 && (manifest.resources[key].status >= 400 || !manifest.resources[key].size && resource.body.length);
          const newResources = validResources.filter(needsWrite);
          const variantResources = [];
          for (const entry of validResources) {
            if (needsWrite(entry)) continue;
            const existing = manifest.resources[entry.key];
            if (!existing?.digest || existing.status >= 400 || entry.resource.status >= 400 || !entry.resource.body?.length) continue;
            const digest = `sha256:${crypto.createHash('sha256').update(entry.resource.body).digest('hex')}`;
            if (digest === existing.digest) continue;
            const known = (manifest.resourceVariants?.[entry.key] || []).some((item) => item.digest === digest);
            variantResources.push({ ...entry, digest, known });
          }
          const redirectRecords = (capture.redirects || []).map((redirect) => ({
            url: redirect.url, capturedAt: new Date().toISOString(),
            httpPayload: httpPayload(redirect.status, headersObject(redirect.headers), Buffer.alloc(0))
          }));
          const warcRecords = [...redirectRecords, ...newResources.map(({ resource, key, capturedAt }) => ({
            url: key, capturedAt, httpPayload: httpPayload(resource.status, headersObject(resource.headers), resource.body, resourceCharset(resource))
          })), ...variantResources.filter((item) => !item.known).map(({ resource, key, capturedAt }) => ({
            url: key, capturedAt, httpPayload: httpPayload(resource.status, headersObject(resource.headers), resource.body, resourceCharset(resource))
          })), ...[...postEntries.values()].map(({ url, resource, capturedAt }) => ({
            url, capturedAt,
            httpPayload: httpPayload(resource.status, headersObject(resource.headers), resource.body, resourceCharset(resource)),
            requestPayload: httpRequestPayload('POST', url, resource.requestContentType, resource.requestBody || Buffer.alloc(0))
          }))];
          const warcChunk = job.options.warcEnabled && warcRecords.length
            ? await createWarcAsync(warcRecords, { page: normalized }, job.options.warcCompressionLevel)
            : Buffer.alloc(0);
          const htmlBuffer = capture.html ? Buffer.from(capture.html) : null;
          const incomingBytes = newResources.reduce((sum, item) => sum + item.resource.body.length, 0) +
            (htmlBuffer?.length || 0) + (capture.screenshot?.length || 0) + warcChunk.length;
          if (job.options.pageMaxBytes !== null && incomingBytes > job.options.pageMaxBytes) throw new Error('1ページの保存容量上限を超えています。');
          if (job.options.maxBytes !== null && job.bytes + incomingBytes > job.options.maxBytes) {
            await this.store.updateJob(id, { status: 'limit-reached', message: '保存容量の上限に達したため停止しました。' });
            throw new Error('保存容量の上限に達しました。');
          }
          const stagedResources = {};
          const stagedAliases = {};
          let stagedResourceBytes = 0;
          for (const { resource, key, capturedAt } of validResources) {
            for (const alias of resource.aliases || []) {
              try {
                const normalizedAlias = normalizeUrl(alias);
                if (normalizedAlias !== key) stagedAliases[normalizedAlias] = key;
              } catch {}
            }
            pageResources.push(key);
            if (!needsWrite({ key, resource })) continue;
            const blob = await this.store.writeBlob(job.archiveId, resource.body);
            const headerMime = contentType(resource.headers);
            const servedMime = headerMime && !/^application\/octet-stream/i.test(headerMime) ? headerMime : (resource.mimeType || headerMime);
            const charset = resourceCharset(resource);
            stagedResources[key] = {
              url: key, status: resource.status, headers: headersObject(resource.headers), mimeType: servedMime,
              digest: blob.digest, file: blob.file, size: blob.size, capturedAt, ...(charset ? { charset } : {}),
              ...(resource.emptyConfirmed ? { emptyConfirmed: true } : {})
            };
            stagedResourceBytes += blob.size;
          }
          const stagedVariantList = [];
          for (const { key, resource, digest, known, capturedAt } of variantResources) {
            if (known) { stagedVariantList.push({ key, digest, entry: null }); continue; }
            const blob = await this.store.writeBlob(job.archiveId, resource.body);
            const headerMime = contentType(resource.headers);
            const charset = resourceCharset(resource);
            stagedVariantList.push({ key, digest, entry: {
              digest: blob.digest, file: blob.file, size: blob.size, status: resource.status, headers: headersObject(resource.headers),
              mimeType: headerMime && !/^application\/octet-stream/i.test(headerMime) ? headerMime : (resource.mimeType || headerMime),
              capturedAt, pages: [], ...(charset ? { charset } : {})
            } });
            stagedResourceBytes += blob.size;
          }
          const stagedPostResponses = {};
          for (const { key, url, resource, requestDigest, canonicalDigest, capturedAt } of postEntries.values()) {
            const blob = await this.store.writeBlob(job.archiveId, resource.body || Buffer.alloc(0));
            const requestBlob = resource.requestBody?.length ? await this.store.writeBlob(job.archiveId, resource.requestBody) : null;
            const headerMime = contentType(resource.headers);
            const charset = resourceCharset(resource);
            stagedPostResponses[key] = {
              url, method: 'POST', requestDigest, canonicalDigest, requestContentType: resource.requestContentType || '',
              requestSize: resource.requestBody?.length || 0, requestFile: requestBlob?.file || null,
              ...(resource.requestBodyUnavailable ? { requestBodyUnavailable: true } : {}),
              status: resource.status, headers: headersObject(resource.headers),
              mimeType: headerMime && !/^application\/octet-stream/i.test(headerMime) ? headerMime : (resource.mimeType || headerMime),
              digest: blob.digest, file: blob.file, size: blob.size, capturedAt, ...(charset ? { charset } : {})
            };
            stagedResourceBytes += blob.size + (requestBlob?.size || 0);
          }
          let htmlBlob = null;
          if (htmlBuffer) {
            htmlBlob = await this.store.writeBlob(job.archiveId, htmlBuffer);
          }
          let screenshotFile = null;
          if (capture.screenshot) {
            screenshotFile = await this.store.writeScreenshot(job.archiveId, `${String(job.pages + 1).padStart(5, '0')}.png`, capture.screenshot);
          }
          let mobileEntry = null;
          if (capture.mobile?.html) {
            const mobileHtml = Buffer.from(capture.mobile.html);
            const mobileBlob = await this.store.writeBlob(job.archiveId, mobileHtml);
            const mobileScreenshot = capture.mobile.screenshot
              ? await this.store.writeScreenshot(job.archiveId, `${String(job.pages + 1).padStart(5, '0')}-mobile.png`, capture.mobile.screenshot)
              : null;
            mobileEntry = {
              ...(capture.mobile.url && capture.mobile.url !== finalUrl ? { url: capture.mobile.url } : {}),
              html: mobileBlob.file, screenshot: mobileScreenshot, title: capture.mobile.title || '', userAgent: capture.mobile.userAgent || '',
              viewport: capture.mobile.viewport || null, capturedAt: new Date().toISOString(), ...(capture.mobile.partial ? { partial: true } : {})
            };
            job.bytes += mobileHtml.length + (capture.mobile.screenshot?.length || 0);
          }
          if (warcChunk.length) {
            batchWarcChunks.push(warcChunk);
          }
          Object.assign(manifest.resourceAliases, stagedAliases);
          Object.assign(manifest.resources, stagedResources);
          if (Object.keys(stagedPostResponses).length) manifest.postResponses = { ...(manifest.postResponses || {}), ...stagedPostResponses };
          for (const { key, digest, entry } of stagedVariantList) {
            manifest.resourceVariants ||= {};
            const list = manifest.resourceVariants[key] ||= [];
            let variant = list.find((item) => item.digest === digest);
            if (!variant && entry) { variant = entry; list.push(variant); }
            if (variant && !variant.pages.includes(finalUrl)) variant.pages.push(finalUrl);
          }
          job.resources = Object.keys(manifest.resources).length;
          job.bytes += stagedResourceBytes + (htmlBuffer?.length || 0) + (capture.screenshot?.length || 0) + warcChunk.length;
          const links = [...new Set(limited(capture.links, job.options.maxLinksPerPage).map((item) => {
            try { return canonicalDocumentUrl(String(item.url).replaceAll('&amp;', '&'), finalUrl); } catch { return null; }
          }).filter(Boolean))];
          const pageQuality = capture.fileDocument
            ? { classification: 'normal', level: 'verified', score: 100, reasons: [], documentStatus: capture.resources?.[0]?.status || 200 }
            : classifyCapturedPage({
              startUrl: job.startUrl,
              requestedUrl: normalized,
              url: finalUrl,
              title: capture.title,
              html: capture.html,
              resources: capture.resources
            });
          const captureNeedsRepair = Boolean(capture.partial) || retryableDocumentStatus(capturedStatus);
          const replaceIndex = current.repair ? manifest.pages.findIndex((page) => page.url === finalUrl || page.requestedUrl === normalized) : -1;
          if (replaceIndex >= 0 && captureNeedsRepair) {
            recordPageRetry(normalized, { status: 'failed', attempts: Number(manifest.pageRetries?.[normalized]?.attempts || 1) + 1, reason: capture.partial ? '時間切れ' : `HTTP ${capturedStatus}` });
            logEvent('info', 'crawler', 'repair.page.kept', { jobId: id, archiveId: job.archiveId, pageUrl: safeUrl(finalUrl) });
            continue;
          }
          if (!current.repair && captureNeedsRepair && job.options.repairBeforeComplete !== false) repairCandidates.set(normalized, { ...current, url: normalized });
          if (current.repair) {
            manifest.blocked = manifest.blocked.filter((item) => ![normalized, finalUrl].includes(item.url));
            recordPageRetry(normalized, { status: 'recovered', attempts: Number(manifest.pageRetries?.[normalized]?.attempts || 0) + 1, repaired: true });
            if (current.repairFailed) job.errors = Math.max(0, Number(job.errors || 0) - 1);
            logEvent('info', 'crawler', 'repair.page.recovered', { jobId: id, archiveId: job.archiveId, pageUrl: safeUrl(finalUrl), replaced: replaceIndex >= 0 });
          }
          const pageEntry = {
            url: finalUrl, requestedUrl: normalized, title: capture.title || new URL(finalUrl).hostname,
            depth: current.depth, scope: finalScope, externalDepth: effectiveExternalDepth, from: current.from, capturedAt: new Date().toISOString(),
            html: htmlBlob?.file || null, screenshot: screenshotFile, resources: pageResources, links,
            redirects: capture.redirects || [], preservation: capture.preservation || null, blocked: capture.blocked || [], quality: pageQuality,
            ...(capture.fileDocument ? { file: true, mimeType: capture.resources?.[0]?.mimeType || 'application/octet-stream', size: capture.resources?.[0]?.body?.length || 0 } : {}),
            ...(mobileEntry ? { mobile: mobileEntry } : {})
          };
          if (capture.html && !capture.fileDocument) indexedPages.push({ url: finalUrl, title: pageEntry.title, html: capture.html });
          sharedIndexPages.push({ url: finalUrl, requestedUrl: normalized, capturedAt: pageEntry.capturedAt });
          if (replaceIndex >= 0) manifest.pages[replaceIndex] = pageEntry;
          else manifest.pages.push(pageEntry);
          job.visitedDetails.push({ url: finalUrl, depth: current.depth, scope: finalScope, externalDepth: effectiveExternalDepth });
          for (const item of capture.blocked || []) addBlocked(item);
          for (const item of capture.deferredMedia || []) {
            manifest.deferredMedia ||= [];
            if (manifest.deferredMedia.some((entry) => entry.url === item.url)) continue;
            const entry = { ...item, pageUrl: finalUrl, recordedAt: new Date().toISOString() };
            manifest.deferredMedia.push(entry);
            mediaLane?.enqueue(entry);
          }
          if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
          visited.add(finalUrl);
          for (const link of redirectedToAuthentication || pageQuality.classification !== 'normal' ? [] : links) {
            const linkDepth = current.depth + 1;
            const linkScope = classifyScope(job.startUrl, link, job.options);
            const externalDepth = nextExternalDepth({
              startUrl: job.startUrl, currentUrl: finalUrl, currentExternalDepth: effectiveExternalDepth,
              candidateUrl: link, sameSiteKeywords: job.options.sameSiteKeywords
            });
            if (externalDepth > 0 && !job.options.followExternal) continue;
            if (job.options.externalMaxDepth !== null && externalDepth > job.options.externalMaxDepth) {
              blockForExternalLimit(link, linkDepth, externalDepth, finalUrl);
              continue;
            }
            if (job.options.sameSiteMaxDepth !== null && externalDepth === 0 && linkDepth > job.options.sameSiteMaxDepth) {
              blockForSameSiteLimit(link, linkDepth, finalUrl);
              continue;
            }
            enqueue({ url: link, depth: linkDepth, scope: linkScope, externalDepth, from: finalUrl });
          }
          if (replaceIndex < 0) job.pages += 1;
          if (Number(current.attempt) > 0 && !current.repair) recordPageRetry(normalized, retryableDocumentStatus(capturedStatus) ? { status: 'failed', attempts: Number(current.attempt) + 1, reason: `HTTP ${capturedStatus}` } : { status: 'recovered', attempts: Number(current.attempt) + 1 });
          logEvent('info', 'crawler', 'page.staged', {
            jobId: id, archiveId: job.archiveId, pageUrl: safeUrl(finalUrl), depth: current.depth,
            resources: validResources.length, totalPages: job.pages, totalBytes: job.bytes
          });
        } catch (error) {
          if (error.code === 'OUT_OF_SCOPE_REDIRECT') {
            if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
            addBlocked({ url: error.finalUrl || normalized, reason: error.message, depth: current.depth, externalDepth: current.externalDepth, from: normalized });
            settleRetry(current, normalized, 'skipped', '転送先が保存範囲外');
            continue;
          }
          if (job.status === 'running' && !repairPhase) tuner?.onError('capture', 'error');
          if (job.status === 'running' && retryablePageError(error) && scheduleRetry(current, normalized, error.message)) continue;
          if (job.status !== 'limit-reached' && !current.repair) job.errors += 1;
          if (Number(current.attempt) > 0 || current.repair) recordPageRetry(normalized, { status: 'failed', attempts: Number(manifest.pageRetries?.[normalized]?.attempts || Number(current.attempt) + 1) + (current.repair ? 1 : 0), reason: error.message });
          if (!current.repair && job.status === 'running' && job.options.repairBeforeComplete !== false && (retryablePageError(error) || error.code === 'PAGE_CAPTURE_TIMEOUT')) repairCandidates.set(normalized, { ...current, url: normalized, repairFailed: true });
          if (!visited.has(normalized)) { visited.add(normalized); job.visited.push(normalized); }
          addBlocked({ url: normalized, reason: error.message, depth: current.depth, externalDepth: current.externalDepth });
          logEvent('error', 'crawler', 'page.failed', { jobId: id, archiveId: job.archiveId, pageUrl: safeUrl(normalized), code: error.code || 'PAGE_FAILED', message: error.message });
        }
      }
      await commitArchiveCapture(this.store, job.archiveId, {
        manifest, job, warcChunk: Buffer.concat(batchWarcChunks)
      }, { checkpoint: this.config.captureCommitCheckpoint });
      batchCommitted = true;
      if (sharedIndexPages.length) await this.config.sharedPages?.addPages(job.archiveId, sharedIndexPages).catch(() => {});
      for (const target of sharedReferences) await this.config.sharedPages?.addReference(job.archiveId, target).catch(() => {});
      if (indexedPages.length) await this.config.searchIndex?.append(job.archiveId, indexedPages).catch((error) => logEvent('warn', 'search', 'index.append.failed', { archiveId: job.archiveId, message: error.message }));
      logEvent('info', 'crawler', 'batch.committed', { jobId: id, archiveId: job.archiveId, pages: job.pages, resources: job.resources, bytes: job.bytes });
      if (job.status === 'running' && Date.now() - lastArchivePublishAt >= (this.config.archivePublishIntervalMs ?? 3000)) {
        lastArchivePublishAt = Date.now();
        await this.publishInterruptedArchive(id, manifest).catch((error) => logEvent('warn', 'archive', 'running.publish.failed', { jobId: id, message: error.message }));
      }
      } finally {
        this.store.endCaptureBatch(id, !batchCommitted);
        indexQueue();
      }
    };
    const submitResult = (result) => new Promise((resolve, reject) => {
      pendingResults.push({ result, resolve, reject });
      exclusive(async () => {
        if (!pendingResults.length) return;
        const entries = pendingResults.splice(0);
        try {
          await commitResults(entries.map((entry) => entry.result));
          for (const entry of entries) entry.resolve();
        } catch (error) {
          for (const entry of entries) entry.reject(error);
        }
      });
    });
    const recordPageRetry = (url, patch) => {
      manifest.pageRetries ||= {};
      const previous = manifest.pageRetries[url] || { url, attempts: 0, reasons: [] };
      const reasons = patch.reason ? [...previous.reasons, String(patch.reason).slice(0, 300)].slice(-5) : previous.reasons;
      manifest.pageRetries[url] = { ...previous, ...patch, reasons, updatedAt: new Date().toISOString() };
      delete manifest.pageRetries[url].reason;
    };
    const settleRetry = (current, normalized, status, resolution) => {
      if (!(Number(current.attempt) > 0) || manifest.pageRetries?.[normalized]?.status !== 'retrying') return;
      recordPageRetry(normalized, { status, attempts: Number(current.attempt) + 1, resolution });
    };
    const scheduleRetry = (current, normalized, reason) => {
      const attempt = (Number(current.attempt) || 0) + 1;
      const limit = Number(job.options.pageRetries ?? 2);
      if (attempt > limit) return false;
      const notBefore = Date.now() + (this.config.pageRetryDelayMs ?? RETRY_DELAY_MS) * attempt;
      const item = { ...current, url: normalized, attempt, notBefore };
      job.queue.push(item);
      queuedByUrl.set(normalized, item);
      recordPageRetry(normalized, { status: 'retrying', attempts: attempt, reason, nextAttemptAt: new Date(notBefore).toISOString() });
      logEvent('warn', 'crawler', 'page.retry.scheduled', { jobId: id, archiveId: job.archiveId, pageUrl: safeUrl(normalized), attempt, limit, reason: String(reason).slice(0, 200) });
      return true;
    };
    const distributed = job.options.distributedAccess === true;
    const perHostSetting = Number(job.options.perHostConcurrency ?? 2);
    const perHostLimit = perHostSetting === 0 ? Infinity : Math.max(1, perHostSetting || 2);
    const perHostIntervalMs = Math.max(0, Number(job.options.perHostIntervalMs ?? 1000));
    const hostActive = new Map();
    const hostLastStart = new Map();
    const hostKeyOf = (value) => { try { return registrableDomain(new URL(value).hostname); } catch { return ''; } };
    const hostReadyAt = (key) => {
      if ((!distributed && !repairPhase) || !key) return 0;
      if ((hostActive.get(key) || 0) >= (repairPhase ? 1 : perHostLimit)) return Infinity;
      return (hostLastStart.get(key) || 0) + (repairPhase ? Math.max(2000, perHostIntervalMs) : perHostIntervalMs);
    };
    const nextRetryAt = () => {
      const now = Date.now();
      let earliest = null;
      for (const item of job.queue) {
        const at = Math.max(Number(item.notBefore) || 0, hostReadyAt(hostKeyOf(item.url)));
        if (at > now && Number.isFinite(at) && (earliest === null || at < earliest)) earliest = at;
      }
      return earliest;
    };
    const pickNext = () => {
      const now = Date.now();
      let index = 0;
      while (index < job.queue.length) {
        if (Number(job.queue[index].notBefore) > now || hostReadyAt(hostKeyOf(job.queue[index].url)) > now) { index += 1; continue; }
        const [current] = job.queue.splice(index, 1);
        let normalized;
        try { normalized = canonicalDocumentUrl(current.url); } catch { continue; }
        queuedByUrl.delete(normalized);
        if ((visited.has(normalized) && !current.repair) || activeUrls.has(normalized)) continue;
        const scope = classifyScope(job.startUrl, normalized, job.options);
        const externalDepth = scope === 'external' ? Math.max(1, Number(current.externalDepth) || 1) : 0;
        if (scope === 'external' && !job.options.followExternal) continue;
        if (scope === 'external' && job.options.externalMaxDepth !== null && externalDepth > job.options.externalMaxDepth) {
          blockForExternalLimit(normalized, current.depth, externalDepth, current.from);
          continue;
        }
        if (scope !== 'external' && job.options.sameSiteMaxDepth !== null && current.depth > job.options.sameSiteMaxDepth) {
          blockForSameSiteLimit(normalized, current.depth, current.from);
          continue;
        }
        const prepared = { ...current, url: normalized, scope, externalDepth };
        const warning = warningForDepth({ startUrl: job.startUrl, url: normalized, depth: current.depth, externalDepth, ...job.options });
        if (warning && !this.hasGrant(job, warning)) {
          job.queue.splice(index, 0, current);
          indexQueue();
          warningHit = { warning, current: prepared };
          return null;
        }
        return { current: prepared, normalized };
      }
      return null;
    };
    const launch = () => exclusive(async () => {
      let latest = null;
      const poolLimit = repairPhase ? Math.min(3, concurrencyLimit) : concurrencyLimit;
      while (!warningHit && !limitHit && !fatalError && job.status === 'running' && active.size < (tuner ? Math.min(poolLimit, tuner.capture) : poolLimit)) {
        if (reached(job.pages, job.options.maxPages) || reached(job.bytes, job.options.maxBytes) || reached(Date.now() - started, job.options.maxDurationMs)) {
          limitHit = true;
          break;
        }
        if (job.options.maxPages !== null && job.pages + active.size >= job.options.maxPages) break;
        const item = pickNext();
        if (!item) break;
        const slotIndex = freeSlots.shift();
        const hostKey = hostKeyOf(item.normalized);
        hostActive.set(hostKey, (hostActive.get(hostKey) || 0) + 1);
        hostLastStart.set(hostKey, Date.now());
        job.inFlight.push(item.current);
        activeUrls.add(item.normalized);
        const task = captureItem(item, slotIndex)
          .then((result) => submitResult(result))
          .catch((error) => { fatalError ||= error; })
          .finally(() => {
            active.delete(task);
            activeUrls.delete(item.normalized);
            hostActive.set(hostKey, Math.max(0, (hostActive.get(hostKey) || 1) - 1));
            freeSlots.push(slotIndex);
            freeSlots.sort((a, b) => a - b);
          });
        active.add(task);
        latest = item;
      }
      if (latest) {
        await this.store.updateJob(id, {
          inFlight: job.inFlight, currentUrl: latest.normalized,
          depth: Math.max(...job.inFlight.map((item) => item.depth || 0)),
          message: active.size > 1 ? `${active.size}ページを並列保存中` : 'ページを保存中'
        });
      }
    });
    const runPool = async () => {
      while (true) {
        await launch();
        if (fatalError) break;
        const retryAt = warningHit || limitHit || job.status !== 'running' ? null : nextRetryAt();
        if (!active.size && retryAt === null) break;
        const wait = retryAt === null ? null : new Promise((resolve) => setTimeout(resolve, Math.min(1000, Math.max(0, retryAt - Date.now()))));
        await Promise.race(wait ? [...active, wait] : [...active]);
      }
      if (fatalError) for (const controller of controllers) controller.abort();
      await Promise.all(active);
    };
    const canRepair = () => !fatalError && !warningHit && !limitHit && job.status === 'running' && job.options.repairBeforeComplete !== false;
    const repairResources = async () => {
      const targets = [...new Set(unresolvedCaptureFailures(manifest)
        .filter((item) => /^https?:/i.test(item.url) && !isServerBoundaryUrl(item.url) && !/HTTP (?:404|410)\b/.test(item.reason || ''))
        .map((item) => item.url))].slice(0, 500);
      if (!targets.length) return;
      logEvent('info', 'crawler', 'repair.resources.started', { jobId: id, archiveId: job.archiveId, resources: targets.length });
      await this.store.updateJob(id, { message: `取れなかった素材${targets.length}件を取り直し中` });
      const resolved = new Set();
      const records = [];
      let addedBytes = 0;
      let cursor = 0;
      const signal = new AbortController();
      controllers.add(signal);
      const workers = Array.from({ length: Math.min(4, targets.length) }, async () => {
        while (cursor < targets.length && job.status === 'running') {
          const url = targets[cursor++];
          try {
            const { response } = await safeFetch(url, { ...job.options, signal: signal.signal });
            const body = Buffer.from(await response.arrayBuffer());
            if (response.status >= 400 || (!body.length && response.status !== 200)) continue;
            const blob = await this.store.writeBlob(job.archiveId, body);
            const headers = headersObject(response.headers);
            const capturedAt = new Date().toISOString();
            manifest.resources[url] = {
              url, status: response.status, headers, mimeType: contentType(response.headers), digest: blob.digest, file: blob.file, size: blob.size, capturedAt,
              ...(body.length ? {} : { emptyConfirmed: true }), repaired: true
            };
            records.push({ url, capturedAt, httpPayload: httpPayload(response.status, headers, body) });
            addedBytes += blob.size;
            resolved.add(url);
          } catch (error) { logEvent("warn", "crawler", "repair.resource.failed", { jobId: id, resourceUrl: safeUrl(url), message: String(error.message || error).slice(0, 200) }); }
        }
      });
      await Promise.all(workers);
      controllers.delete(signal);
      if (!resolved.size) return;
      manifest.blocked = manifest.blocked.filter((item) => !resolved.has(item.url));
      job.resources = Object.keys(manifest.resources).length;
      const warcChunk = job.options.warcEnabled && records.length ? await createWarcAsync(records, { page: job.startUrl }, job.options.warcCompressionLevel) : Buffer.alloc(0);
      job.bytes += addedBytes + warcChunk.length;
      this.store.beginCaptureBatch(id);
      let committed = false;
      try {
        await commitArchiveCapture(this.store, job.archiveId, { manifest, job, warcChunk }, { checkpoint: this.config.captureCommitCheckpoint });
        committed = true;
      } finally {
        this.store.endCaptureBatch(id, !committed);
      }
      logEvent('info', 'crawler', 'repair.resources.completed', { jobId: id, archiveId: job.archiveId, repaired: resolved.size, attempted: targets.length });
    };
    try {
      await runPool();
      if (canRepair() && !job.queue.length && repairCandidates.size) {
        repairPhase = true;
        const items = [...repairCandidates.values()];
        repairCandidates.clear();
        logEvent('info', 'crawler', 'repair.started', { jobId: id, archiveId: job.archiveId, pages: items.length });
        await this.store.updateJob(id, { message: `保存できなかった${items.length}ページを取り直し中` });
        for (const item of items) {
          const entry = { ...item, repair: true, attempt: Number(job.options.pageRetries ?? 2), notBefore: 0 };
          job.queue.push(entry);
          queuedByUrl.set(entry.url, entry);
        }
        await runPool();
      }
      if (canRepair()) await repairResources();
      if (mediaLane && job.status === 'running' && !fatalError && mediaLane.remaining()) {
        await this.store.updateJob(id, { message: `ページの保存が完了。動画・音声を保存中（残り${mediaLane.remaining()}件）` });
        await mediaLane.finish();
      }
    } finally {
      mediaLane?.stop();
      this.abortControllers.delete(id);
    }
    if (fatalError) throw fatalError;
    if (limitHit && job.status === 'running') {
      await this.store.updateJob(id, { status: 'limit-reached', message: '安全上限に達したため停止しました。' });
    } else if (warningHit && job.status === 'running') {
      await this.store.writeManifest(job.archiveId, manifest);
      await this.store.updateJob(id, {
        status: 'warning', warning: warningHit.warning, message: '階層の確認が必要です。',
        currentUrl: warningHit.current.url, depth: warningHit.current.depth
      });
    }
    } finally {
      for (const pending of Object.values(sessionPromises)) {
        const browserSession = pending ? await pending.catch(() => null) : null;
        await browserSession?.close();
      }
      this.liveView.clearJob(id);
    }
    restoreInFlight();
    await this.store.persistJob(id);
    await this.finish(id, manifest);
  }

  async finish(id, manifest) {
    const job = this.store.getJob(id);
    if (!job) return;
    const archiveRoot = this.store.archiveRoot(job.archiveId);
    const references = [];
    const siteReferences = new Set();
    const siteResourceUrls = new Set();
    for (const page of manifest.pages) {
      const pageReferences = page.html ? htmlAssetReferences(await fs.readFile(path.join(archiveRoot, page.html), 'utf8'), page.url) : [];
      references.push(...pageReferences);
      if (isStartSitePage(page)) {
        for (const value of pageReferences) siteReferences.add(value);
        for (const value of page.resources || []) siteResourceUrls.add(value);
      }
    }
    for (const resource of Object.values(manifest.resources)) {
      if (!/text\/css/i.test(resource.mimeType || '')) continue;
      const cssReferences = cssAssetReferences(decodeStoredText(await fs.readFile(path.join(archiveRoot, resource.file)), resource), resource.url);
      references.push(...cssReferences);
      if (siteResourceUrls.has(resource.url)) for (const value of cssReferences) siteReferences.add(value);
    }
    const successfulResources = new Set(Object.values(manifest.resources).filter(resource => resource.status < 400 && (resource.size > 0 || resource.emptyConfirmed || [204, 205].includes(resource.status))).map(resource => resource.url));
    const originMissingResources = new Set(Object.values(manifest.resources).filter(resource => [404, 410].includes(Number(resource.status))).map(resource => resource.url));
    manifest.referenceAudit = referenceAudit(references, new Set([...successfulResources, ...originMissingResources]), manifest.resourceAliases);
    manifest.referenceAudit.siteMissing = (manifest.referenceAudit.missing || []).filter((value) => siteReferences.has(value));
    manifest.referenceAudit.originMissingCount = [...new Set(references)].filter(value => originMissingResources.has(value) || originMissingResources.has(manifest.resourceAliases?.[value])).length;
    let finalStatus = job.status;
    if (job.status === 'running' && !job.queue.length) {
      const completion = completionStatus(job, manifest);
      finalStatus = completion.status;
      await this.store.updateJob(id, {
        status: finalStatus, phase: 'complete',
        message: completion.message, currentUrl: ''
      });
    }
    if (['complete', 'complete-with-errors', 'cancelled', 'limit-reached', 'failed', 'blocked', 'login-required'].includes(finalStatus)) {
      manifest.completedAt = new Date().toISOString();
      manifest.status = finalStatus;
      manifest.discovery = { mode: job.options.discoveryMode, discoveredPages: job.discoveredPages || 0 };
      manifest.quality = summarizeArchiveQuality(manifest, job);
      await this.store.writeManifest(job.archiveId, manifest);
      const archive = {
        id: job.archiveId, startUrl: job.startUrl, title: manifest.pages[0]?.title || new URL(job.startUrl).hostname,
        status: finalStatus, pages: job.pages, resources: job.resources,
        bytes: job.bytes, errors: job.errors, savedAt: manifest.completedAt, engine: manifest.engine || 'HTTP',
        partial: finalStatus !== 'complete' || manifest.quality.level !== 'verified', quality: manifest.quality,
        ...(job.options.loginProfileId || job.options.retryLoginProfileId || this.store.getArchive?.(job.archiveId)?.loggedIn ? { loggedIn: true } : {}),
        ...(job.previousArchiveId || this.store.getArchive?.(job.archiveId)?.previousArchiveId ? { previousArchiveId: job.previousArchiveId || this.store.getArchive?.(job.archiveId).previousArchiveId } : {})
      };
      await this.store.addArchive(archive);
      await this.store.finalizeJob(id);
      logEvent('info', 'archive', 'created', { archiveId: archive.id, jobId: id, status: archive.status, pages: archive.pages, resources: archive.resources, bytes: archive.bytes });
      if (finalStatus !== 'cancelled') {
        const report = buildIssueReport(manifest);
        Promise.resolve(this.config.onJobFinished?.({ jobId: id, archiveId: archive.id, startUrl: job.startUrl, title: archive.title, status: finalStatus, pages: archive.pages, problemCount: report.problemCount })).catch(() => {});
      }
    } else if (['paused', 'warning'].includes(finalStatus)) {
      await this.publishInterruptedArchive(id, manifest);
    }
  }

  async publishInterruptedArchive(id, manifest = null) {
    const job = this.store.getJob(id);
    if (!job || !['paused', 'warning', 'running', 'queued'].includes(job.status)) return null;
    const current = manifest || await this.store.readManifest(job.archiveId).catch(() => null);
    if (!current?.pages?.length) return null;
    const archive = {
      id: job.archiveId, jobId: job.id, startUrl: job.startUrl, title: current.pages[0]?.title || new URL(job.startUrl).hostname,
      status: job.status, pages: current.pages.length, resources: Object.keys(current.resources || {}).length,
      bytes: job.bytes, errors: job.errors, savedAt: new Date().toISOString(), engine: current.engine || 'HTTP',
      partial: true, quality: summarizeArchiveQuality(current, job),
      ...(job.previousArchiveId ? { previousArchiveId: job.previousArchiveId } : {})
    };
    await this.store.addArchive(archive);
    logEvent('info', 'archive', 'interrupted.published', { archiveId: archive.id, jobId: id, status: archive.status, pages: archive.pages });
    return archive;
  }

  async publishInterruptedArchives() {
    for (const job of this.store.listJobs()) {
      if (!['paused', 'warning'].includes(job.status) || !job.pages) continue;
      const existing = this.store.getArchive?.(job.archiveId);
      if (existing) {
        if (['running', 'queued'].includes(existing.status)) await this.store.addArchive({ ...existing, status: job.status });
        continue;
      }
      await this.publishInterruptedArchive(job.id).catch((error) => logEvent('warn', 'archive', 'interrupted.publish.failed', { jobId: job.id, message: error.message }));
    }
  }
}
