import { normalizeUrl, registrableDomain } from './policy.mjs';
import { isCaptureNoise } from './noise-filter.mjs';
import { decodeText, detectCharset } from './charset.mjs';
import { logEvent } from './logger.mjs';

const LITERAL = /["'`]((?:https?:\/\/|\.{1,2}\/|\/)[^"'`\s<>()]{1,300}?\.(?:m?js|css)(?:\?[^"'`\s<>()]{0,200})?)["'`]/gi;
const IMPORT_CALL = /\bimport\s*\(\s*["'`]([^"'`\s]{1,300}\.m?js(?:\?[^"'`\s]{0,200})?)["'`]\s*\)/gi;
const PRELOAD_LINK = /<link\b[^>]*\brel\s*=\s*["']?(?:modulepreload|preload|prefetch)["']?[^>]*>/gi;
const HREF = /\bhref\s*=\s*(["'])(.*?)\1/i;
const SCRIPT_TYPE = /javascript|ecmascript/i;
const MAX_SCAN_BYTES = 6 * 1024 * 1024;

function unescapeLiteral(value) {
  return String(value).replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/&amp;/gi, '&');
}

function isScriptResource(resource) {
  return SCRIPT_TYPE.test(resource?.mimeType || '') || resource?.type === 'Script' || /\.m?js(?:[?#]|$)/i.test(resource?.url || '');
}

function siteOf(url) {
  try { return registrableDomain(new URL(url).hostname); } catch { return ''; }
}

export function scriptReferencesIn(text, baseUrl) {
  const found = new Set();
  const source = unescapeLiteral(String(text || '').slice(0, MAX_SCAN_BYTES));
  for (const pattern of [LITERAL, IMPORT_CALL]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      try { found.add(normalizeUrl(match[1], baseUrl)); } catch {}
    }
  }
  return [...found];
}

export function prefetchCandidates(capture, { knownResourceUrls = new Set(), limit = 120 } = {}) {
  const pageUrl = capture.url;
  if (!pageUrl || !capture.html) return [];
  const allowedSites = new Set([siteOf(pageUrl)]);
  const known = new Set([...knownResourceUrls, ...(capture.resources || []).map((resource) => resource.url)]);
  const candidates = [];
  const push = (url, from) => {
    if (candidates.length >= limit || known.has(url) || !/^https?:/i.test(url)) return;
    const site = siteOf(url);
    if (!allowedSites.has(site) && site !== siteOf(from)) return;
    if (isCaptureNoise(url, 'Script')) return;
    known.add(url);
    candidates.push(url);
  };
  for (const tag of capture.html.matchAll(PRELOAD_LINK)) {
    const href = tag[0].match(HREF)?.[2];
    if (!href || /\bas\s*=\s*["']?(?:image|font|fetch|video|audio)/i.test(tag[0])) continue;
    try { push(normalizeUrl(unescapeLiteral(href), pageUrl), pageUrl); } catch {}
  }
  for (const block of capture.html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    for (const url of scriptReferencesIn(block[1], pageUrl)) push(url, pageUrl);
  }
  for (const resource of capture.resources || []) {
    if (!isScriptResource(resource) || !resource.body?.length || resource.status >= 400) continue;
    for (const url of scriptReferencesIn(decodeText(resource.body, 'utf-8'), resource.url)) push(url, resource.url);
  }
  return candidates;
}

export async function prefetchScriptReferences(capture, options = {}, diagnostic = {}, { fetcher, limit = 120, maxBytes = 8 * 1024 * 1024, budgetMs = 30000 } = {}) {
  if (!capture?.html || options.prefetchScripts === false || typeof fetcher !== 'function') return capture;
  const queue = prefetchCandidates(capture, { knownResourceUrls: options.knownResourceUrls, limit });
  if (!queue.length) return capture;
  const seen = new Set([...(options.knownResourceUrls || []), ...(capture.resources || []).map((resource) => resource.url), ...queue]);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), budgetMs);
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  let attempted = 0;
  let saved = 0;
  let failed = 0;
  try {
    while (queue.length && !signal.aborted && attempted < limit) {
      const batch = queue.splice(0, 6);
      await Promise.all(batch.map(async (url) => {
        attempted += 1;
        try {
          const { response, finalUrl } = await fetcher(url, { ...options, signal, responseMaxBytes: maxBytes });
          if (!response.ok) { failed += 1; response.body?.cancel?.().catch?.(() => {}); return; }
          const body = Buffer.from(await response.arrayBuffer());
          const mimeType = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          if (!body.length || body.length > maxBytes || /text\/html/i.test(mimeType)) { failed += 1; return; }
          const isCss = /css/i.test(mimeType) || /\.css(?:[?#]|$)/i.test(url);
          capture.resources.push({
            url, aliases: finalUrl && finalUrl !== url ? [finalUrl] : [], status: response.status,
            headers: Object.fromEntries(response.headers.entries()), mimeType: mimeType || (isCss ? 'text/css' : 'text/javascript'),
            type: isCss ? 'Stylesheet' : 'Script', body, prefetched: true
          });
          saved += 1;
          if (!isCss) {
            const text = decodeText(body, detectCharset({ contentType: mimeType, body }) || 'utf-8');
            for (const next of scriptReferencesIn(text, url)) {
              if (seen.has(next) || siteOf(next) !== siteOf(capture.url) && siteOf(next) !== siteOf(url) || isCaptureNoise(next, 'Script')) continue;
              seen.add(next);
              queue.push(next);
            }
          }
        } catch {
          failed += 1;
        }
      }));
    }
  } finally {
    clearTimeout(timer);
  }
  capture.preservation = { ...(capture.preservation || {}), prefetchedScripts: saved };
  logEvent('info', 'capture', 'resource.prefetch', { ...diagnostic, attempted, saved, failed });
  return capture;
}
