import dns from 'node:dns/promises';
import net from 'node:net';
import { getDomain } from 'tldts';

const HOSTNAME_BLOCKLIST = new Set(['localhost', 'localhost.localdomain', 'metadata.google.internal']);
const GENERIC_SITE_KEYWORDS = new Set(['www', 'com', 'net', 'org', 'info', 'biz', 'app', 'dev', 'shop', 'store', 'cdn']);

function ipv4ToNumber(ip) {
  return ip.split('.').reduce((value, octet) => (value << 8) + Number(octet), 0) >>> 0;
}

function inIpv4Range(ip, base, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(ip) & mask) === (ipv4ToNumber(base) & mask);
}

export function isPublicIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    const blocked = [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
      ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
    ];
    return !blocked.some(([base, bits]) => inIpv4Range(ip, base, bits));
  }
  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return false;
    if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') ||
        normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb') ||
        normalized.startsWith('ff')) return false;
    if (normalized.startsWith('::ffff:')) return isPublicIp(normalized.slice(7));
    return true;
  }
  return false;
}

export function normalizeUrl(input, base) {
  let url;
  try {
    url = new URL(String(input).trim(), base);
  } catch {
    throw new Error('URLの形式が正しくありません。');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('http または https のURLだけ保存できます。');
  if (url.username || url.password) throw new Error('認証情報を含むURLは保存できません。');
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  if ((url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')) url.port = '';
  return url.href;
}

export function registrableDomain(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIP(host)) return host;
  return getDomain(host, { allowPrivateDomains: true }) || host;
}

function keywordMatchesHost(hostname, keyword) {
  return hostname.toLowerCase().split('.').some((label) =>
    label === keyword || label.split('-').includes(keyword)
  );
}

export function normalizeSameSiteKeywords(input) {
  const values = Array.isArray(input) ? input : String(input || '').split(/[\s,]+/);
  return [...new Set(values.map((value) => String(value).trim().toLowerCase()).filter((value) =>
    value.length >= 4 && value.length <= 32 && /^[a-z0-9-]+$/.test(value) && !/^\d+$/.test(value) && !GENERIC_SITE_KEYWORDS.has(value)
  ))].slice(0, 10);
}

export function validateSameSiteKeywords(input) {
  const values = (Array.isArray(input) ? input : String(input || '').split(/[\s,]+/))
    .map((value) => String(value).trim()).filter(Boolean);
  if (values.length > 10) throw new Error('同一サイト扱いキーワードは10件までです。');
  const normalized = normalizeSameSiteKeywords(values);
  if (normalized.length !== new Set(values.map((value) => value.toLowerCase())).size) {
    throw new Error('キーワードは4〜32文字の半角英数字・ハイフンで、一般的すぎない固有語を指定してください。');
  }
  return normalized;
}

export function classifyScope(startUrl, candidateUrl, options = {}) {
  const start = new URL(startUrl);
  const candidate = new URL(candidateUrl);
  if (start.origin === candidate.origin) return 'origin';
  if (registrableDomain(start.hostname) === registrableDomain(candidate.hostname)) return 'site';
  const keywords = normalizeSameSiteKeywords(options.sameSiteKeywords);
  if (keywords.some((keyword) => keywordMatchesHost(start.hostname, keyword) && keywordMatchesHost(candidate.hostname, keyword))) return 'keyword-site';
  return 'external';
}

export function nextExternalDepth({ startUrl, currentUrl, currentExternalDepth = 0, candidateUrl, sameSiteKeywords = [] }) {
  const options = { sameSiteKeywords };
  if (classifyScope(startUrl, candidateUrl, options) !== 'external') return 0;
  return classifyScope(startUrl, currentUrl, options) === 'external'
    ? Math.max(1, Number(currentExternalDepth) || 1) + 1
    : 1;
}

const ACCOUNT_HOSTS = /^(?:accounts\.google\.com|myaccount\.google\.com|appleid\.apple\.com|account\.apple\.com|secure\d*\.store\.apple\.com|login\.microsoftonline\.com|login\.live\.com|auth0\.com|[a-z0-9-]+\.auth0\.com)$/i;
const ACCOUNT_SEGMENT = /(?:^|\/)(?:log-?in|log-?out|sign-?in|sign-?up|sign-?out|register|account|accounts|my-?page|mypage|member|members|cart|checkout|checkouts|basket|password|reset-password|auth|authentication|oauth2?|sso|wishlist|favorites?)(?:\/|$|\.)/i;

const VOLATILE_QUERY_NAMES = new Set(['buyer_flags', 'analytics_trace_id', 'code_challenge', 'nonce']);
const TOKEN_VALUE = /^eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/;

export function stableDocumentKey(value) {
  let url;
  try { url = new URL(value); } catch { return value; }
  const volatile = [...url.searchParams].filter(([name, item]) => VOLATILE_QUERY_NAMES.has(name.toLowerCase()) || TOKEN_VALUE.test(item)).map(([name]) => name);
  if (!volatile.length) return value;
  for (const name of volatile) url.searchParams.delete(name);
  return url.href;
}

const SAVED_REDIRECT_REASON = /^(?:ログイン誘導先は保存済みです|転送先は保存済みです): (\S+)$/;

export function savedPageForMissingUrl(manifest = {}, target = '') {
  const pages = (manifest.pages || []).filter((page) => page.html || page.file);
  const pageFor = (value) => pages.find((page) => page.url === value || page.requestedUrl === value) || null;
  const key = stableDocumentKey(target);
  const sameKey = (value) => value === target || (key !== target && stableDocumentKey(value || '') === key);
  if (key !== target) {
    const page = pages.find((item) => sameKey(item.requestedUrl) || sameKey(item.url));
    if (page) return page;
  }
  for (const item of manifest.blocked || []) {
    if (!sameKey(item.url)) continue;
    const saved = SAVED_REDIRECT_REASON.exec(item.reason || '')?.[1];
    const page = saved ? pageFor(saved) : null;
    if (page) return page;
  }
  return authenticationEntryPage(manifest, pages, pageFor, target);
}

const AUTH_ENTRY_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|auth|authentication|customer_authentication|customer-authentication|oauth|sso)(?:\/|$)/i;

function authenticationEntryPage(manifest, pages, pageFor, target) {
  let wanted;
  try { wanted = new URL(target); } catch { return null; }
  if (!AUTH_ENTRY_PATH.test(wanted.pathname)) return null;
  const firstSegment = wanted.pathname.split('/')[1] || '';
  const sameEntry = (value) => {
    try {
      const url = new URL(value);
      return url.origin === wanted.origin && (url.pathname.split('/')[1] || '') === firstSegment;
    } catch { return false; }
  };
  const loginPage = pages.find((page) => page.quality?.classification === 'login-required' && sameEntry(page.requestedUrl || page.url));
  if (loginPage) return loginPage;
  for (const item of manifest.blocked || []) {
    if (!sameEntry(item.url)) continue;
    const saved = SAVED_REDIRECT_REASON.exec(item.reason || '')?.[1];
    const page = saved ? pageFor(saved) : null;
    if (page) return page;
  }
  return null;
}

export function isAccountLikeUrl(value) {
  try {
    const url = new URL(value);
    return ACCOUNT_HOSTS.test(url.hostname) || ACCOUNT_SEGMENT.test(url.pathname);
  } catch { return false; }
}

export function redirectExternalDepth({ startUrl, fromUrl, currentExternalDepth = 0, toUrl, sameSiteKeywords = [] }) {
  try {
    const from = new URL(fromUrl);
    const to = new URL(toUrl);
    if (registrableDomain(from.hostname) === registrableDomain(to.hostname)) {
      return classifyScope(startUrl, toUrl, { sameSiteKeywords }) === 'external' ? Math.max(1, Number(currentExternalDepth) || 1) : 0;
    }
  } catch {}
  return nextExternalDepth({ startUrl, currentUrl: fromUrl, currentExternalDepth, candidateUrl: toUrl, sameSiteKeywords });
}

export function redirectChainExternalDepth({ startUrl, requestedUrl, requestedExternalDepth = 0, finalUrl, sameSiteKeywords = [] }) {
  const options = { sameSiteKeywords };
  if (classifyScope(startUrl, finalUrl, options) !== 'external') return 0;
  const requestedExternal = classifyScope(startUrl, requestedUrl, options) === 'external';
  const requestedDepth = requestedExternal ? Math.max(1, Number(requestedExternalDepth) || 1) : 0;
  try {
    if (registrableDomain(new URL(requestedUrl).hostname) === registrableDomain(new URL(finalUrl).hostname)) return Math.max(1, requestedDepth);
  } catch {}
  return requestedDepth ? requestedDepth + 1 : 1;
}

export function warningForDepth({ startUrl, url, depth, externalDepth, sameSiteKeywords = [], sameSiteWarningDepth = 30, externalWarningDepth = 5 }) {
  const scope = classifyScope(startUrl, url, { sameSiteKeywords });
  const threshold = scope === 'external' ? externalWarningDepth : sameSiteWarningDepth;
  if (threshold === null || threshold === undefined) return null;
  const measuredDepth = scope === 'external' ? Math.max(1, Number(externalDepth) || 1) : depth;
  if (measuredDepth < threshold) return null;
  return { scope, metric: scope === 'external' ? 'externalDepth' : 'depth', threshold, depth: measuredDepth, totalDepth: depth, url };
}

export async function assertPublicUrl(input, options = {}) {
  const normalized = normalizeUrl(input);
  const url = new URL(normalized);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (HOSTNAME_BLOCKLIST.has(host) || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('ローカルPCやLAN内のURLは保存できません。');
  }
  if (net.isIP(host)) {
    if (!isPublicIp(host) && !options.allowPrivateForTests) throw new Error('公開アドレス以外には接続できません。');
    return { url: normalized, addresses: [host] };
  }
  const lookup = options.lookup || dns.lookup;
  let records;
  try {
    records = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new Error('URLの接続先を確認できませんでした。');
  }
  if (!records.length) throw new Error('URLの接続先が見つかりません。');
  if (!options.allowPrivateForTests && records.some((record) => !isPublicIp(record.address))) {
    throw new Error('公開アドレス以外へ解決されるURLは保存できません。');
  }
  return { url: normalized, addresses: records.map((record) => record.address) };
}

export function isSafeNavigationMethod(method) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

export function isRecordableRequestMethod(method) {
  return isSafeNavigationMethod(method) || method === 'POST';
}
