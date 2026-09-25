import { isServerBoundaryUrl, unresolvedCaptureFailures } from './quality.mjs';

const NOT_A_FAILURE = /保存済みです|対象外|除外|robots\.txt|深度上限|範囲外|ログイン・カート|外部サイトのため|把握済み|自動で除外/;
const LOGIN_REDIRECT = /^ログイン誘導先は保存済みです: /;
const BROKEN_PAGE = new Set(['error-page', 'missing-html']);

function hostOf(value) {
  try { return new URL(value).hostname; } catch { return ''; }
}

function pageItem(source, extra = {}) {
  return {
    url: source.requestedUrl || source.url,
    depth: Number(source.depth) || 0,
    externalDepth: Number(source.externalDepth) || 0,
    from: source.from || null,
    ...extra
  };
}

export function buildRetryPlan(manifest = {}) {
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  const savedOk = new Set();
  for (const page of pages) {
    const classification = page.quality?.classification || 'normal';
    if (classification === 'normal' && !page.preservation?.partialCapture) for (const value of [page.url, page.requestedUrl]) if (value) savedOk.add(value);
  }
  const failed = new Map();
  const addFailed = (item, reason) => {
    if (!item.url || savedOk.has(item.url) || failed.has(item.url)) return;
    failed.set(item.url, { ...item, reason: String(reason || '').slice(0, 200) });
  };
  for (const page of pages) {
    const classification = page.quality?.classification || 'normal';
    if (BROKEN_PAGE.has(classification)) addFailed(pageItem(page), page.quality?.reasons?.[0] || 'エラーページでした。');
    else if (page.preservation?.partialCapture) addFailed(pageItem(page), '時間切れで途中までしか保存できませんでした。');
  }
  for (const entry of Object.values(manifest.pageRetries || {})) {
    if (entry?.status === 'failed') addFailed({ url: entry.url, depth: 0, externalDepth: 0, from: null }, entry.reasons?.at(-1));
  }
  for (const item of manifest.blocked || []) {
    if (!Number.isFinite(Number(item?.depth)) || !item.url || NOT_A_FAILURE.test(item.reason || '')) continue;
    if (/素材|参照|本文/.test(item.reason || '')) continue;
    addFailed(pageItem(item), item.reason);
  }

  const loginHosts = new Map();
  const addLogin = (host, item) => {
    if (!host) return;
    const group = loginHosts.get(host) || { host, items: new Map() };
    if (!group.items.has(item.url)) group.items.set(item.url, item);
    loginHosts.set(host, group);
  };
  for (const page of pages) {
    if (page.quality?.classification !== 'login-required') continue;
    const requested = page.requestedUrl || page.url;
    addLogin(hostOf(requested), pageItem(page, { url: requested }));
  }
  for (const item of manifest.blocked || []) {
    if (!LOGIN_REDIRECT.test(item?.reason || '')) continue;
    addLogin(hostOf(item.url), pageItem(item));
  }
  for (const group of loginHosts.values()) for (const url of group.items.keys()) failed.delete(url);

  const resources = [...new Set(unresolvedCaptureFailures(manifest)
    .filter((item) => /^https?:/i.test(item.url) && !isServerBoundaryUrl(item.url) && !/HTTP (?:404|410)\b/.test(item.reason || ''))
    .map((item) => item.url))];

  return {
    failedPages: [...failed.values()],
    loginSites: [...loginHosts.values()].map((group) => ({ host: group.host, count: group.items.size, items: [...group.items.values()] }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
    missingResourceCount: resources.length
  };
}

export function retryQueue(plan, { loginHosts = [], skipHosts = [], includeFailed = true } = {}) {
  const useLogin = new Set(loginHosts);
  const skip = new Set(skipHosts);
  const queue = [];
  const seen = new Set();
  const push = (item, login) => {
    if (seen.has(item.url)) return;
    seen.add(item.url);
    queue.push({ url: item.url, depth: item.depth, externalDepth: item.externalDepth, from: item.from, repair: true, attempt: 0, notBefore: 0, ...(login ? { login: true } : {}) });
  };
  if (includeFailed) for (const item of plan.failedPages) push(item, false);
  for (const site of plan.loginSites) {
    if (skip.has(site.host) || !useLogin.has(site.host)) continue;
    for (const item of site.items) push(item, true);
  }
  return queue;
}

export function summarizeRetryPlan(plan) {
  return {
    failedPages: plan.failedPages.map(({ url, reason }) => ({ url, reason })),
    failedPageCount: plan.failedPages.length,
    loginSites: plan.loginSites.map(({ host, count, items }) => ({ host, count, sample: items.slice(0, 3).map((item) => item.url) })),
    missingResourceCount: plan.missingResourceCount
  };
}
