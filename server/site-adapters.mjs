const YOUTUBE_HOSTS = /^(?:www\.|m\.|music\.)?youtube\.com$|^youtubei\.googleapis\.com$/i;
const X_HOSTS = /^(?:(?:www|mobile|api)\.)?(?:x|twitter)\.com$/i;
const JSON_TYPE = 'application/json; charset=utf-8';
const JS_TYPE = 'application/javascript; charset=utf-8';

export function extractAssignedJson(html, name) {
  const source = String(html || '');
  const pattern = new RegExp(`(?:var\\s+|window\\[["']|window\\.|\\b)${name}(?:["']\\])?\\s*=\\s*\\{`, 'g');
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length - 1;
    const text = balancedObject(source, start);
    if (!text) continue;
    try { return JSON.parse(text); } catch {}
  }
  return null;
}

export function balancedObject(source, start) {
  let depth = 0;
  let quote = null;
  for (let index = start; index < source.length && index - start < 20 * 1024 * 1024; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === '\\') { index += 1; continue; }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") { quote = character; continue; }
    if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

function parseJsonBody(body) {
  if (!body?.length) return null;
  try { return JSON.parse(Buffer.from(body).toString('utf8')); } catch { return null; }
}

function jsonResponse(value, adapter, contentType = JSON_TYPE) {
  return { status: 200, contentType, body: Buffer.from(JSON.stringify(value)), adapter };
}

function pageHost(page) {
  try { return new URL(page.url).hostname; } catch { return ''; }
}

async function youtubeResponse(target, { manifest, body, pageUrl, readPageHtml }) {
  const path = target.pathname.replace(/^\/youtubei\/v1\//, '');
  if (!['player', 'next', 'browse'].includes(path)) return null;
  const request = parseJsonBody(body) || {};
  const videoId = String(request.videoId || request.playbackContext?.contentPlaybackContext?.videoId || '').trim()
    || (() => { try { return new URL(pageUrl).searchParams.get('v') || ''; } catch { return ''; } })();
  const pages = (manifest.pages || []).filter((page) => page.html && YOUTUBE_HOSTS.test(pageHost(page)));
  if (path === 'player' || path === 'next') {
    if (!/^[A-Za-z0-9_-]{6,20}$/.test(videoId)) return null;
    const candidates = pages.filter((page) => { try { return new URL(page.url).searchParams.get('v') === videoId || new URL(page.url).pathname.endsWith(`/${videoId}`); } catch { return false; } });
    for (const page of candidates) {
      const html = await readPageHtml(page);
      if (path === 'player') {
        const data = extractAssignedJson(html, 'ytInitialPlayerResponse');
        if (data?.videoDetails?.videoId === videoId) return jsonResponse(data, 'youtube-player');
      } else {
        const data = extractAssignedJson(html, 'ytInitialData');
        const current = data?.currentVideoEndpoint?.watchEndpoint?.videoId;
        if (data && (!current || current === videoId)) return jsonResponse(data, 'youtube-next');
      }
    }
    return null;
  }
  const browseId = String(request.browseId || '').trim();
  if (!browseId || request.continuation) return null;
  for (const page of pages) {
    let pathname = '';
    try { pathname = new URL(page.url).pathname; } catch { continue; }
    if (browseId === 'FEwhat_to_watch' && pathname !== '/') continue;
    const html = await readPageHtml(page);
    const data = extractAssignedJson(html, 'ytInitialData');
    if (!data) continue;
    const externalId = data.metadata?.channelMetadataRenderer?.externalId;
    if (browseId === 'FEwhat_to_watch' || externalId === browseId) return jsonResponse(data, 'youtube-browse');
  }
  return null;
}

export function canonicalGraphqlVariables(value) {
  let parsed = value;
  if (typeof value === 'string') { try { parsed = JSON.parse(value); } catch { return null; } }
  if (!parsed || typeof parsed !== 'object') return null;
  const sort = (input) => Array.isArray(input) ? input.map(sort) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().map((key) => [key, sort(input[key])])) : input;
  return JSON.stringify(sort(parsed));
}

function graphqlOperation(url) {
  const match = url.pathname.match(/\/graphql\/[^/]+\/([A-Za-z0-9_]+)$/);
  return match ? match[1] : null;
}

async function xResponse(target, { manifest, method, body, readFile }) {
  const operation = graphqlOperation(target);
  if (!operation) return null;
  const wanted = method === 'POST'
    ? canonicalGraphqlVariables(parseJsonBody(body)?.variables)
    : canonicalGraphqlVariables(target.searchParams.get('variables'));
  if (!wanted) return null;
  const sources = method === 'POST'
    ? Object.values(manifest.postResponses || {}).map((entry) => ({ url: entry.url, entry, request: entry.requestFile }))
    : Object.values(manifest.resources || {}).map((entry) => ({ url: entry.url, entry }));
  for (const source of sources) {
    let candidate;
    try { candidate = new URL(source.url); } catch { continue; }
    if (!X_HOSTS.test(candidate.hostname) || graphqlOperation(candidate) !== operation) continue;
    if (Number(source.entry.status) >= 400 || !source.entry.file) continue;
    let variables = null;
    if (method === 'POST') {
      if (!source.request) continue;
      variables = canonicalGraphqlVariables(parseJsonBody(await readFile(source.request).catch(() => null))?.variables);
    } else variables = canonicalGraphqlVariables(candidate.searchParams.get('variables'));
    if (variables !== wanted) continue;
    const saved = await readFile(source.entry.file).catch(() => null);
    if (!saved) continue;
    return { status: 200, contentType: source.entry.mimeType || JSON_TYPE, body: saved, adapter: 'x-graphql' };
  }
  return null;
}

function productFromHtml(html, handle) {
  const scripts = String(html || '').matchAll(/<script\b[^>]*type\s*=\s*["']application\/(?:ld\+)?json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    let data;
    try { data = JSON.parse(match[1].trim()); } catch { continue; }
    for (const candidate of [data, data?.product]) {
      if (candidate && typeof candidate === 'object' && candidate.handle === handle && Array.isArray(candidate.variants)) return candidate;
    }
  }
  const meta = extractAssignedJson(html, 'meta');
  if (meta?.product && Array.isArray(meta.product.variants) && (!meta.product.handle || meta.product.handle === handle)) return { handle, ...meta.product };
  return null;
}

async function shopifyResponse(target, { manifest, method, readPageHtml }) {
  const pathname = target.pathname.replace(/\/+$/, '');
  if (method === 'GET' && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?cart\.(?:js|json)$/i.test(pathname)) {
    const pages = (manifest.pages || []).filter((page) => page.html && pageHost(page) === target.hostname);
    let currency = null;
    let shopify = false;
    for (const page of pages.slice(0, 5)) {
      const html = await readPageHtml(page);
      shopify ||= /cdn\.shopify\.com|\bShopify\./.test(html);
      currency ||= html.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Z]{3})"/)?.[1] || html.match(/"currency"\s*:\s*"([A-Z]{3})"/)?.[1] || null;
      if (shopify && currency) break;
    }
    if (!shopify) return null;
    return jsonResponse({
      token: '', note: null, attributes: {}, original_total_price: 0, total_price: 0, total_discount: 0, total_weight: 0,
      item_count: 0, items: [], requires_shipping: false, currency: currency || 'JPY', items_subtotal_price: 0, cart_level_discount_applications: []
    }, 'shopify-cart');
  }
  const product = pathname.match(/\/products\/([^/]+)\.(js|json)$/i);
  if (method !== 'GET' || !product) return null;
  const handle = decodeURIComponent(product[1]);
  const pages = (manifest.pages || []).filter((page) => page.html && pageHost(page) === target.hostname && (() => {
    try { return new URL(page.url).pathname.replace(/\/+$/, '').endsWith(`/products/${handle}`); } catch { return false; }
  })());
  for (const page of pages) {
    const data = productFromHtml(await readPageHtml(page), handle);
    if (!data) continue;
    return product[2].toLowerCase() === 'js' ? jsonResponse(data, 'shopify-product', JS_TYPE) : jsonResponse({ product: data }, 'shopify-product');
  }
  return null;
}

export function createPageHtmlReader(readFile, limit = 24) {
  const cache = new Map();
  return async (page) => {
    if (cache.has(page.html)) return cache.get(page.html);
    const html = await readFile(page.html).then((buffer) => buffer.toString('utf8')).catch(() => '');
    cache.set(page.html, html);
    while (cache.size > limit) cache.delete(cache.keys().next().value);
    return html;
  };
}

export async function siteReplayResponse({ manifest, target, method = 'GET', body = null, pageUrl = '', readFile, readPageHtml = null }) {
  let url;
  try { url = new URL(target); } catch { return null; }
  const context = { manifest, method, body, pageUrl, readFile, readPageHtml: readPageHtml || createPageHtmlReader(readFile) };
  if (YOUTUBE_HOSTS.test(url.hostname) && url.pathname.startsWith('/youtubei/v1/')) return youtubeResponse(url, context);
  if (X_HOSTS.test(url.hostname) && url.pathname.includes('/graphql/')) return xResponse(url, context);
  if (/\/(?:cart\.(?:js|json)|products\/[^/]+\.(?:js|json))$/i.test(url.pathname)) return shopifyResponse(url, context);
  return null;
}
