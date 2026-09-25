import crypto from 'node:crypto';
import zlib from 'node:zlib';

export function sortJsonKeys(value) {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJsonKeys(value[key])]));
  return value;
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function requestBodyDigests(body = Buffer.alloc(0)) {
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  let canonicalDigest = null;
  try { canonicalDigest = sha256(Buffer.from(JSON.stringify(sortJsonKeys(JSON.parse(buffer.toString('utf8')))))); } catch {}
  return { requestDigest: sha256(buffer), canonicalDigest };
}

export function postResponseKey(method, url, requestDigest) {
  return `${method} ${url} ${requestDigest}`;
}

export function findPostResponse(manifest, { method = 'POST', url, digest = '', canonical = '' }) {
  const candidates = Object.values(manifest?.postResponses || {}).filter((entry) => entry.method === method && entry.url === url);
  const exact = digest && candidates.find((entry) => entry.requestDigest === digest);
  if (exact) return { entry: exact, match: 'exact' };
  const canonicalMatch = canonical && candidates.find((entry) => entry.canonicalDigest && entry.canonicalDigest === canonical);
  if (canonicalMatch) return { entry: canonicalMatch, match: 'canonical' };
  if (candidates.length === 1) return { entry: candidates[0], match: 'only-response' };
  return { entry: null, match: candidates.length ? 'ambiguous' : 'none', candidates: candidates.length };
}

const IDENTITY_LEAF = /(?:^|\.)(?:id|ids|videoId|playlistId|browseId|channelId|continuation|cursor|query|q|handle|slug|operationName|screen_name|screenName|userId|user_id|productId|handleId)(?:\.\d+)?$/i;
const VARIABLES_BRANCH = /(?:^|\.)variables\./i;

function decodedRequestText(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || '');
  if (buffer[0] === 0x1f && buffer[1] === 0x8b) { try { return zlib.gunzipSync(buffer, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8'); } catch {} }
  return buffer.toString('utf8');
}

export function requestBodyLeaves(buffer, contentType = '') {
  const text = decodedRequestText(buffer);
  if (!text.trim()) return new Map();
  let value = null;
  try { value = JSON.parse(text); } catch {}
  if (value === null && /x-www-form-urlencoded/i.test(contentType) || value === null && /^[^{[\s][^\s]*=/.test(text)) {
    const leaves = new Map();
    for (const [key, item] of new URLSearchParams(text)) {
      let nested = null;
      try { nested = JSON.parse(item); } catch {}
      if (nested && typeof nested === 'object') for (const [path, leaf] of requestBodyLeaves(JSON.stringify(nested))) leaves.set(`${key}.${path}`, leaf);
      else leaves.set(key, item);
    }
    return leaves;
  }
  if (value === null || typeof value !== 'object') return null;
  const leaves = new Map();
  const walk = (node, prefix) => {
    if (leaves.size > 5000) return;
    if (node && typeof node === 'object') {
      const entries = Array.isArray(node) ? node.map((item, index) => [String(index), item]) : Object.entries(node);
      if (!entries.length) leaves.set(prefix, JSON.stringify(node));
      for (const [key, item] of entries) walk(item, prefix ? `${prefix}.${key}` : key);
      return;
    }
    leaves.set(prefix, String(node));
  };
  walk(value, '');
  return leaves;
}

function identityLeaf(path) {
  return IDENTITY_LEAF.test(path) || VARIABLES_BRANCH.test(`${path}`);
}

export function scorePostCandidate(requestLeaves, savedLeaves) {
  if (!requestLeaves || !savedLeaves) return null;
  let score = 0;
  for (const [path, value] of requestLeaves) {
    const saved = savedLeaves.get(path);
    if (identityLeaf(path) && saved !== value) return null;
    if (saved === value) score += 1;
    else if (saved === undefined) score -= 0.25;
  }
  for (const path of savedLeaves.keys()) if (identityLeaf(path) && !requestLeaves.has(path)) return null;
  return score;
}

function pathKey(value) {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return value; }
}

export async function findSimilarPostResponse(manifest, { method = 'POST', url, body, contentType = '', pageUrl = '', readRequestBody }) {
  const entries = Object.values(manifest?.postResponses || {}).filter((entry) => entry.method === method);
  let candidates = entries.filter((entry) => entry.url === url);
  let scope = 'url';
  if (!candidates.length) { const key = pathKey(url); candidates = entries.filter((entry) => pathKey(entry.url) === key); scope = 'path'; }
  if (!candidates.length) return { entry: null, match: 'none', candidates: 0 };
  const requestLeaves = requestBodyLeaves(body || Buffer.alloc(0), contentType);
  if (!requestLeaves) {
    if (scope === 'path' && candidates.length === 1) return { entry: candidates[0], match: 'same-path' };
    return { entry: null, match: 'ambiguous', candidates: candidates.length };
  }
  if (!requestLeaves.size) return pickByPageIdentity(candidates, pageUrl, readRequestBody, scope);
  let best = null;
  for (const entry of candidates.slice(-400)) {
    if (!entry.requestFile || Number(entry.requestSize || 0) > 262144) continue;
    let savedLeaves;
    try { savedLeaves = requestBodyLeaves(await readRequestBody(entry.requestFile), entry.requestContentType || ''); } catch { continue; }
    const score = scorePostCandidate(requestLeaves, savedLeaves);
    if (score === null) continue;
    const samePage = Boolean(pageUrl && entry.pageUrl === pageUrl);
    if (!best || score > best.score || (score === best.score && samePage && !best.samePage)) best = { entry, score, samePage };
  }
  if (!best) return { entry: null, match: 'ambiguous', candidates: candidates.length };
  return { entry: best.entry, match: scope === 'path' ? 'similar-path' : 'similar' };
}

async function pickByPageIdentity(candidates, pageUrl, readRequestBody, scope) {
  if (!pageUrl) return { entry: null, match: 'ambiguous', candidates: candidates.length };
  let decodedPage = pageUrl;
  try { decodedPage = decodeURIComponent(pageUrl); } catch {}
  let best = null;
  for (const entry of candidates.slice(-400)) {
    if (!entry.requestFile || Number(entry.requestSize || 0) > 262144) continue;
    let leaves;
    try { leaves = requestBodyLeaves(await readRequestBody(entry.requestFile), entry.requestContentType || ''); } catch { continue; }
    if (!leaves) continue;
    let score = 0;
    let extra = 0;
    for (const [path, value] of leaves) {
      if (!identityLeaf(path) || value.length < 6) continue;
      if (decodedPage.includes(value)) score += 1; else extra += 1;
    }
    if (!score) continue;
    if (!best || score > best.score || (score === best.score && extra < best.extra)) best = { entry, score, extra };
  }
  if (!best) return { entry: null, match: 'ambiguous', candidates: candidates.length };
  return { entry: best.entry, match: scope === 'path' ? 'page-identity-path' : 'page-identity' };
}
