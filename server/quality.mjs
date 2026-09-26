import { registrableDomain } from './policy.mjs';

const CHALLENGE_TITLE = /(?:just a moment|attention required|access denied|request blocked|robot check|verify (?:that )?you are human|checking your browser|security check|captcha)/i;
const CHALLENGE_BODY = /(?:cf-chl-|challenge-platform|captcha-container|verify (?:that )?you are human|checking (?:your )?browser|unusual traffic|アクセスが拒否されました|ロボットではないことを確認)/i;
const LOGIN_TITLE = /(?:^|\b)(?:sign[ -]?in|log[ -]?in|login|authentication|required account)(?:\b|$)|アカウント.{0,8}(?:ログイン|サインイン)|ログイン(?:が必要|してください)?/i;
const LOGIN_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|auth|authentication|customer-authentication|customer_authentication|authorize|oauth|sso)(?:\/|$)/i;
const ERROR_TITLE = /^\s*(?:(?:http\s*)?[45]\d\d\s*[-:|–—]?\s*)?(?:error(?: page)?|(?:page )?not found|service unavailable|temporarily unavailable|forbidden|bad gateway|gateway timeout|ページが見つかりません|エラーが発生(?:しました)?|利用できません)(?:\s*[-:|–—]\s*.+)?\s*$|^\s*(?:http\s*)?[45]\d\d\s*$/i;

export function documentStatus(resources = [], url = '') {
  const document = resources.find((item) => item?.type === 'Document' && item.url === url) || resources.find((item) => item?.type === 'Document');
  return Number(document?.status || 0) || null;
}

function safePath(value) {
  try { return new URL(value).pathname; } catch { return ''; }
}

function compactText(html = '') {
  return String(html).replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200000);
}

export function isServerBoundaryUrl(value = '') {
  try {
    const url = new URL(value);
    if (url.hostname === 'shop.app' && (
      /^\/accounts\/pre_auth(?:\/|$)/i.test(url.pathname)
      || /^\/checkouts(?:\/|$)/i.test(url.pathname)
      || /^\/pay(?:\/|$)/i.test(url.pathname)
      || /^\/__manifest(?:\/|$)/i.test(url.pathname)
    )) return true;
    if (url.hostname === 'accounts.google.com' && /^\/gsi\//i.test(url.pathname)) return true;
    if (/^\/services\/login_with_shop\//i.test(url.pathname)) return true;
    if (/^api\.(?:x|twitter)\.com$/i.test(url.hostname) && /^\/1\.1\/(?:flow|graphql)\/viewer/i.test(url.pathname)) return true;
    return false;
  } catch { return false; }
}

const TELEMETRY_HOST = /(?:^|\.)(?:google-analytics\.com|analytics\.google\.com|stats\.g\.doubleclick\.net|monorail-edge\.shopifysvc\.com|otlp-http-[a-z0-9-]+\.shopifysvc\.com|error-analytics-[a-z0-9-]+\.shopifysvc\.com|incoming\.telemetry\.mozilla\.org|cloudflareinsights\.com|bat\.bing\.com|clarity\.ms|hotjar\.com|segment\.io|mixpanel\.com|ingest\.sentry\.io|browser-intake-datadoghq\.com|nr-data\.net)$/i;

export function isAuxiliaryRuntimeUrl(value = '') {
  try {
    const url = new URL(value);
    if (url.hostname === 'p.typekit.net' && url.pathname === '/p.gif') return true;
    if (/\/cdn\/wpm\//i.test(url.pathname)) return true;
    if (/^\/web-pixels@/i.test(url.pathname)) return true;
    if (TELEMETRY_HOST.test(url.hostname)) return true;
    if (/(?:^|\/)(?:g\/collect|j\/collect|collect|b\/ss|v1\/produce|v1\/(?:logs|metrics|traces)|cdn-cgi\/rum|beacon|telemetry|analytics)(?:\/|$)/i.test(url.pathname) && !/\.(?:m?js|css|png|jpe?g|gif|webp|svg|woff2?)$/i.test(url.pathname)) return true;
    return /\/web-pixels@[^/]+\/.*\/sandbox\/worker(?:\.[^/]+)?\.js$/i.test(url.pathname);
  } catch { return false; }
}

function endpointKey(value = '') {
  try { const url = new URL(value); return `${url.origin}${url.pathname}`; } catch { return String(value); }
}

function effectiveReferenceMissingCount(manifest = {}, include = null) {
  const audit = manifest.referenceAudit;
  if (!audit) return 0;
  if (!Array.isArray(audit.missing)) return include ? 0 : Number(audit.missingCount || 0);
  const completeTypekitFonts = new Set();
  for (const value of Object.keys(manifest.resources || {})) {
    try {
      const url = new URL(value);
      if (url.hostname === 'use.typekit.net' && url.pathname.startsWith('/af/') && url.searchParams.get('chunks') === '0') {
        completeTypekitFonts.add(`${url.origin}${url.pathname}`);
      }
    } catch {}
  }
  return audit.missing.filter((value) => {
    if (include && !include(value)) return false;
    if (isServerBoundaryUrl(value) || isAuxiliaryRuntimeUrl(value)) return false;
    try {
      const url = new URL(value);
      if (url.hostname === 'use.typekit.net' && url.pathname.startsWith('/af/') && completeTypekitFonts.has(`${url.origin}${url.pathname}`)) return false;
    } catch {}
    return true;
  }).length;
}

export function classifyCapturedPage({ startUrl, requestedUrl, url, title, html, resources = [] } = {}) {
  const reasons = [];
  const status = documentStatus(resources, url);
  const body = compactText(html);
  const redirected = Boolean(requestedUrl && url && requestedUrl !== url);
  const startPath = safePath(startUrl || requestedUrl);
  const finalPath = safePath(url);

  if (CHALLENGE_TITLE.test(title || '') || CHALLENGE_BODY.test(body) && (body.length < 12000 || !/<main\b/i.test(html || ''))) {
    reasons.push('アクセス確認またはBot対策ページが表示されました。');
    return { classification: 'access-challenge', level: 'blocked', score: 0, reasons, documentStatus: status };
  }
  const loginRedirect = redirected && LOGIN_PATH.test(finalPath) && !LOGIN_PATH.test(startPath);
  const passwordForm = /<input\b[^>]*\btype\s*=\s*["']?password/i.test(html || '');
  if (loginRedirect || (LOGIN_TITLE.test(title || '') && passwordForm)) {
    reasons.push(loginRedirect ? '開いたURLからログインページへ転送されました。' : 'ログイン必須ページが表示されました。');
    return { classification: 'login-required', level: 'blocked', score: 0, reasons, documentStatus: status };
  }
  if ((status && status >= 400) || ERROR_TITLE.test(title || '')) {
    reasons.push(status && status >= 400 ? `HTTP ${status} のエラーページです。` : 'エラーページの可能性が高いタイトルです。');
    return { classification: 'error-page', level: 'failed', score: 0, reasons, documentStatus: status };
  }
  if (!html) {
    reasons.push('再生用HTMLを取得できませんでした。');
    return { classification: 'missing-html', level: 'failed', score: 0, reasons, documentStatus: status };
  }
  return { classification: 'normal', level: 'verified', score: 100, reasons, documentStatus: status };
}

export function qualityFromLegacyTitle(title = '', startUrl = '') {
  if (CHALLENGE_TITLE.test(title)) return { classification: 'access-challenge', level: 'blocked', score: 0, reasons: ['アクセス確認ページのタイトルです。'] };
  if (LOGIN_TITLE.test(title) && !LOGIN_PATH.test(safePath(startUrl))) return { classification: 'login-required', level: 'blocked', score: 0, reasons: ['ログインページのタイトルです。'] };
  if (ERROR_TITLE.test(title)) return { classification: 'error-page', level: 'failed', score: 0, reasons: ['エラーページのタイトルです。'] };
  return null;
}

function hostDomain(value) {
  try { return registrableDomain(new URL(value).hostname); } catch { return ''; }
}

export function isStartSitePage(page = {}) {
  return page.scope ? page.scope !== 'external' : true;
}

export function startSiteScope(manifest = {}) {
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  const startDomain = hostDomain(manifest.startUrl || pages[0]?.url || '');
  const siteUrls = new Set();
  for (const page of pages.filter(isStartSitePage)) {
    for (const value of [page.url, page.requestedUrl, ...(page.resources || []), ...(page.blocked || []).map((item) => item?.url)]) if (value) siteUrls.add(value);
  }
  const siteMissing = Array.isArray(manifest.referenceAudit?.siteMissing) ? new Set(manifest.referenceAudit.siteMissing) : null;
  return {
    isSitePage: isStartSitePage,
    isSiteUrl: (value) => !startDomain || siteUrls.has(value) || hostDomain(value) === startDomain,
    isSiteReference: (value) => siteMissing ? siteMissing.has(value) : !startDomain || siteUrls.has(value) || hostDomain(value) === startDomain
  };
}

export function summarizeArchiveQuality(manifest = {}, job = {}, runtimeMisses = null) {
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  const scope = startSiteScope(manifest);
  const qualityOf = (page) => page.quality || qualityFromLegacyTitle(page.title, manifest.startUrl);
  const pageIssues = pages.filter(scope.isSitePage).map(qualityOf).filter((quality) => quality && quality.classification !== 'normal');
  const externalPageIssues = pages.filter((page) => !scope.isSitePage(page)).map(qualityOf).filter((quality) => quality && quality.classification !== 'normal');
  const blocked = Array.isArray(manifest.blocked) ? manifest.blocked : [];
  const unresolvedRuntime = Array.isArray(runtimeMisses?.items) ? runtimeMisses.items.filter(item => !item.repairedAt) : null;
  const runtimeServerBoundaries = unresolvedRuntime?.filter(item => isServerBoundaryUrl(item.url)) || [];
  const auxiliaryRuntime = unresolvedRuntime?.filter(item => isAuxiliaryRuntimeUrl(item.url)) || [];
  const missingRuntime = Number(unresolvedRuntime
    ? unresolvedRuntime.filter(item => !isServerBoundaryUrl(item.url) && !isAuxiliaryRuntimeUrl(item.url)).length
    : runtimeMisses?.total || 0);
  const allUnresolvedCapture = unresolvedCaptureFailures(manifest);
  const unresolvedCapture = allUnresolvedCapture.filter((item) => scope.isSiteUrl(item.url));
  const externalHardBlocked = new Set(allUnresolvedCapture.filter((item) => !scope.isSiteUrl(item.url) && !isServerBoundaryUrl(item.url)).map(item => endpointKey(item.url))).size;
  const serverBoundaryUrls = new Set([
    ...allUnresolvedCapture.filter(item => isServerBoundaryUrl(item.url)).map(item => endpointKey(item.url)),
    ...runtimeServerBoundaries.map(item => endpointKey(item.url))
  ]);
  const hardBlocked = new Set(unresolvedCapture.filter(item => !isServerBoundaryUrl(item.url)).map(item => endpointKey(item.url))).size;
  const serverBoundaryCount = serverBoundaryUrls.size;
  let score = pages.length ? 100 : 0;
  if (pageIssues.length) score -= Math.min(80, pageIssues.length * 25);
  if (hardBlocked) score -= Math.min(45, hardBlocked * 3);
  if (Number(job.errors || 0)) score -= Math.min(40, Number(job.errors) * 8);
  if (missingRuntime) score -= Math.min(35, missingRuntime * 3);
  const referenceMissingCount = effectiveReferenceMissingCount(manifest, scope.isSiteReference);
  const externalReferenceMissingCount = Math.max(0, effectiveReferenceMissingCount(manifest) - referenceMissingCount);
  const referenceChecked = Boolean(manifest.referenceAudit && Number.isFinite(Number(manifest.referenceAudit.checkedCount)));
  if (!referenceChecked) score = Math.min(score, 94);
  if (referenceMissingCount) score -= Math.min(45, referenceMissingCount * 3);
  if (serverBoundaryCount || auxiliaryRuntime.length) score = Math.min(score, 94);
  const limited = ['limit-reached', 'cancelled'].includes(job.status || manifest.status);
  if (limited) score = Math.min(score, 69);
  score = Math.max(0, Math.round(score));
  let level = score >= 95 && !missingRuntime && !referenceMissingCount && !hardBlocked && !pageIssues.length ? 'verified' : score >= 70 ? 'good' : score > 0 ? 'partial' : 'failed';
  const sitePageCount = pages.filter(scope.isSitePage).length;
  if (pageIssues.length === sitePageCount && sitePageCount) {level = pageIssues.some((item) => item.level === 'blocked') ? 'blocked' : 'failed';score=0;}
  return {
    level,
    score,
    pageIssueCount: pageIssues.length,
    blockedCount: blocked.length,
    hardBlockedCount: hardBlocked,
    serverBoundaryCount,
    runtimeMissingCount: missingRuntime,
    auxiliaryRuntimeMissingCount: new Set(auxiliaryRuntime.map(item => endpointKey(item.url))).size,
    referenceMissingCount,
    externalIssueCount: externalPageIssues.length + externalHardBlocked + externalReferenceMissingCount,
    externalPageIssueCount: externalPageIssues.length,
    externalHardBlockedCount: externalHardBlocked,
    externalReferenceMissingCount,
    scoring: 'start-site',
    referenceChecked,
    partialCapture: limited,
    scope: 'stored-content',
    perfect: false,
    checkedAt: new Date().toISOString()
  };
}

export function unresolvedCaptureFailures(manifest = {}) {
  return (manifest.blocked || []).filter((item) => {
    if (!/(?:取得できません|読み込みに失敗|空でした|タイムアウト|ERR_|上限を超え)/i.test(item?.reason || '')) return false;
    const resource = manifest.resources?.[item.url] || manifest.resources?.[manifest.resourceAliases?.[item.url]];
    return !resource || Number(resource.status || 200) >= 400 || !(resource.size > 0 || resource.emptyConfirmed || [204, 205].includes(resource.status));
  });
}

export function completionStatus(job = {}, manifest = {}) {
  const pages = Array.isArray(manifest.pages) ? manifest.pages : [];
  if (!Number(job.pages || pages.length)) {
    const browserFailure = (manifest.blocked || []).find((item) => /ブラウザ（[^）]*）を起動できませんでした|ブラウザがキャプチャ開始前に終了/.test(String(item?.reason || '')));
    if (browserFailure) return { status: 'failed', message: `保存できたページがありません。${browserFailure.reason}` };
    return { status: 'failed', message: '保存できたページがありません。エラー内容を確認してください。' };
  }
  const scope = startSiteScope(manifest);
  const sitePages = pages.filter(scope.isSitePage);
  const pageQualities = pages.map((page) => page.quality || qualityFromLegacyTitle(page.title, manifest.startUrl)).filter(Boolean);
  const siteQualities = sitePages.map((page) => page.quality || qualityFromLegacyTitle(page.title, manifest.startUrl)).filter(Boolean);
  if (pageQualities.length === pages.length && pageQualities.every((item) => item.classification === 'access-challenge')) {
    return { status: 'blocked', message: 'アクセス確認ページのみ取得したため、対象サイトは保存できませんでした。' };
  }
  if (pageQualities.length === pages.length && pageQualities.every((item) => item.classification === 'login-required')) {
    return { status: 'login-required', message: 'ログインページのみ取得したため、対象コンテンツは保存できませんでした。' };
  }
  if (pageQualities.length === pages.length && pageQualities.every((item) => ['error-page', 'missing-html'].includes(item.classification))) {
    return { status: 'failed', message: 'エラーページのみ取得したため、対象サイトは保存できませんでした。' };
  }
  const hardCaptureFailures = unresolvedCaptureFailures(manifest).filter((item) => scope.isSiteUrl(item.url) && !isServerBoundaryUrl(item.url) && !isAuxiliaryRuntimeUrl(item.url));
  return Number(job.errors || 0) || siteQualities.some((item) => item.classification !== 'normal') || effectiveReferenceMissingCount(manifest, scope.isSiteReference) || hardCaptureFailures.length
    ? { status: 'complete-with-errors', message: '一部を除いて保存しました。' }
    : { status: 'complete', message: '保存が完了しました。' };
}
