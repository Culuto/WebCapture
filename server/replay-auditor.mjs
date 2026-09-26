import childProcess from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CdpClient, findBrowser, freePort, platformBrowserArgs, terminateBrowser, waitForDebugger } from './browser-capture.mjs';
import { logEvent, redactDiagnosticData, safeUrl } from './logger.mjs';
import { isAuxiliaryRuntimeUrl, isServerBoundaryUrl } from './quality.mjs';
import { safeInteractionExpression } from './safe-interactions.mjs';

const PAGE_AUDIT_EXPRESSION = String.raw`(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const layoutVisible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || 1) > 0 && rect.width > 0 && rect.height > 0;
  };
  const root = document.scrollingElement || document.documentElement;
  const maxScrollY = Math.max(0, root.scrollHeight - innerHeight);
  let reachedBottom = maxScrollY === 0;
  const step = Math.max(320, Math.floor(innerHeight * 0.8));
  for (let y = 0; y <= maxScrollY; y += step) {
    scrollTo(0, Math.min(y, maxScrollY));
    await wait(45);
  }
  if (maxScrollY > 0) {
    scrollTo(0, maxScrollY);
    await wait(80);
    reachedBottom = Math.abs(scrollY - maxScrollY) <= 3;
  }
  const scrollContainers = [...document.querySelectorAll('*')].filter(element => {
    const style = getComputedStyle(element);
    return layoutVisible(element) && element.scrollHeight > element.clientHeight + 20 && /(auto|scroll)/.test(style.overflowY);
  }).slice(0, 30);
  let unreachableScrollContainerCount = 0;
  for (const element of scrollContainers) {
    const previous = element.scrollTop;
    const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
    const oldBehavior = element.style.getPropertyValue('scroll-behavior');
    const oldBehaviorPriority = element.style.getPropertyPriority('scroll-behavior');
    element.style.setProperty('scroll-behavior', 'auto', 'important');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      element.scrollTo({ top: maximum, behavior: 'instant' });
      await wait(60);
    }
    const observed = element.scrollTop;
    if (maximum > 20 && observed <= previous + 3) unreachableScrollContainerCount += 1;
    element.scrollTo({ top: previous, behavior: 'instant' });
    if (oldBehavior) element.style.setProperty('scroll-behavior', oldBehavior, oldBehaviorPriority);
    else element.style.removeProperty('scroll-behavior');
  }
  scrollTo(0, 0);
  const visibleImages = [...document.images].filter(layoutVisible);
  await Promise.race([
    Promise.allSettled(visibleImages.filter(image => !image.complete).map(image => new Promise(resolve => {
      image.addEventListener('load', resolve, { once: true });
      image.addEventListener('error', resolve, { once: true });
    }))),
    wait(3500)
  ]);
  if (document.fonts) await Promise.race([document.fonts.ready.catch(() => {}), wait(3000)]);
  const images = [...document.images].map(image => {
    const source = image.currentSrc || image.src || '';
    return {
      source,
      visible: layoutVisible(image),
      complete: Boolean(image.complete),
      naturalWidth: Number(image.naturalWidth || 0),
      naturalHeight: Number(image.naturalHeight || 0),
      loading: image.loading || ''
    };
  });
  const broken = images.filter(image => image.source && image.complete && image.naturalWidth === 0);
  const pending = images.filter(image => image.source && !image.complete);
  const mediaErrors = [...document.querySelectorAll('video,audio')].filter(media => media.error).map(media => ({
    tag: media.tagName.toLowerCase(), code: Number(media.error?.code || 0), source: media.currentSrc || media.src || ''
  }));
  const sampledAnimations = document.getAnimations ? document.getAnimations() : [];
  const animationTimes = sampledAnimations.map(animation => Number(animation.currentTime || 0));
  await wait(180);
  const progressingAnimationCount = sampledAnimations.filter((animation, index) =>
    animation.playState === 'running' && Math.abs(Number(animation.currentTime || 0) - animationTimes[index]) >= 5
  ).length;
  return {
    title: document.title,
    bodyTextLength: (document.body?.innerText || '').trim().length,
    documentWidth: Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0),
    documentHeight: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0),
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    maxScrollY,
    reachedBottom,
    scrollContainerCount: scrollContainers.length,
    unreachableScrollContainerCount,
    imageCount: images.length,
    loadedImageCount: images.filter(image => image.complete && image.naturalWidth > 0).length,
    brokenImageCount: broken.length,
    visibleBrokenImageCount: broken.filter(image => image.visible).length,
    pendingImageCount: pending.length,
    visiblePendingImageCount: pending.filter(image => image.visible).length,
    brokenImages: broken.slice(0, 20),
    pendingImages: pending.filter(image => image.visible).slice(0, 20),
    fontStatus: document.fonts?.status || 'unsupported',
    fontFaceCount: Number(document.fonts?.size || 0),
    mediaErrorCount: mediaErrors.length,
    mediaErrors: mediaErrors.slice(0, 20),
    linkCount: document.querySelectorAll('a[href],area[href]').length,
    buttonCount: document.querySelectorAll('button,[role="button"]').length,
    formCount: document.forms.length,
    detailsCount: document.querySelectorAll('details').length,
    iframeCount: document.querySelectorAll('iframe').length,
    canvasCount: document.querySelectorAll('canvas').length,
    animationCount: sampledAnimations.length,
    progressingAnimationCount,
    animationSampleMs: 180
  };
})()`;

const SAFE_INTERACTION_AUDIT_EXPRESSION = safeInteractionExpression();
export const VISUAL_MATCH_THRESHOLD = 0.9;

function abortError() {
  const error = new Error('表示検査を停止しました。');
  error.name = 'AbortError';
  return error;
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { cleanup(); resolve(); }
    function aborted() { clearTimeout(timer); cleanup(); reject(abortError()); }
    function cleanup() { signal?.removeEventListener('abort', aborted); }
    signal?.addEventListener('abort', aborted, { once: true });
  });
}

function waitForEvent(client, method, timeoutMs, signal) {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(reject, new Error(`${method} がタイムアウトしました。`)), timeoutMs);
    const off = client.on(method, value => finish(resolve, value));
    const aborted = () => finish(reject, abortError());
    signal?.addEventListener('abort', aborted, { once: true });
    function finish(callback, value) {
      clearTimeout(timer);
      off();
      signal?.removeEventListener('abort', aborted);
      callback(value);
    }
  });
}

function lowerHeaders(headers = {}) {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}

function diagnosticText(value) {
  return String(redactDiagnosticData(String(value || '')) || '').slice(0, 500);
}

function uniqueBy(items, keyOf) {
  const seen = new Set();
  return items.filter(item => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function originalReplayTarget(value = '') {
  try {
    const url = new URL(value);
    if (/^\/archive\/[^/]+\/resource$/i.test(url.pathname)) {
      const target = url.searchParams.get('url');
      if (target) return new URL(target).href;
    }
    if (/^\/archive\/[^/]+\/post$/i.test(url.pathname)) {
      const target = url.searchParams.get('url');
      if (target) return new URL(target).href;
    }
    const web = url.pathname.match(/^\/archive\/[^/]+\/web\/(https?:\/+.+)$/i);
    if (web) return new URL(`${web[1].replace(/^(https?):\/+/i, '$1://')}${url.search}`).href;
    return url.href;
  } catch { return String(value || ''); }
}

function missingResourceBucket(value = '') {
  if (isServerBoundaryUrl(value)) return 'boundaryResources';
  if (isAuxiliaryRuntimeUrl(value)) return 'auxiliaryResources';
  return 'missingResources';
}

function isReplayIsolationResponse(response = {}, event = {}, replayOrigin = '') {
  if (!['Ping', 'WebSocket'].includes(event.type || '')) return false;
  try { return new URL(response.url).origin === new URL(replayOrigin).origin; } catch { return false; }
}

function isReplayIsolationFailure(event = {}) {
  return Boolean(event.blockedReason || event.corsErrorStatus)
    || ['Ping', 'WebSocket'].includes(event.type || '')
    || /(?:ERR_BLOCKED|BLOCKED_BY_RESPONSE|CSP)/i.test(event.errorText || '');
}

function isReplayIsolationMessage(value = '') {
  return /content security policy|violates the following .* directive|refused to (?:connect|frame|load|execute)|failed to load resource:.*(?:404|405)|mime type .*not executable|second declarative shadow root cannot be created/i.test(value);
}

export function isRuntimeAdvisory(value = '') {
  return /falling back to|deprecated|third-party cookie|\bAbortError:\s*Transition was skipped\b/i.test(value);
}

export function classifyReplayAuditPage(page = {}) {
  const metrics = page.metrics || {};
  const major = Boolean(page.navigationError)
    || Number(page.documentStatus || 0) >= 500
    || Number(metrics.visibleBrokenImageCount || 0) > 0
    || Number(metrics.mediaErrorCount || 0) > 0
    || Number(metrics.bodyTextLength || 0) === 0 && Number(metrics.loadedImageCount || 0) === 0;
  const warning = major
    || Number(page.missingResources?.length || 0) > 0
    || Number(page.failedRequests?.length || 0) > 0
    || Number(page.runtimeErrors?.length || 0) > 0
    || Number(page.interactions?.errorCount || 0) > 0
    || Number(page.interactions?.skippedCount || 0) > 0
    || page.interactions?.limitReached === true
    || Number(metrics.visiblePendingImageCount || 0) > 0
    || metrics.fontStatus === 'loading'
    || Number(metrics.maxScrollY || 0) > 0 && metrics.reachedBottom === false
    || Number(metrics.unreachableScrollContainerCount || 0) > 0;
  return major ? 'error' : warning ? 'warning' : 'healthy';
}

export async function createLocalAuditBrowser({ executable, viewportWidth = 1440, viewportHeight = 1000 } = {}) {
  const browserExecutable = executable || await findBrowser();
  if (!browserExecutable) throw new Error('ChromeまたはEdgeが見つかりません。');
  const port = await freePort();
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-replay-audit-'));
  const diagnostics = { stderr: '', spawnError: null };
  const handle = childProcess.spawn(browserExecutable, [
    ...platformBrowserArgs(), '--headless=new', '--disable-background-networking', '--disable-component-update', '--disable-default-apps',
    '--disable-extensions', '--disable-sync', '--metrics-recording-only', '--no-first-run',
    '--no-default-browser-check', '--password-store=basic', '--use-mock-keychain',
    '--disable-features=MediaRouter,OptimizationHints,Translate', '--no-proxy-server',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    `--window-size=${viewportWidth},${viewportHeight}`, 'about:blank'
  ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  handle.on('error', error => { diagnostics.spawnError = error; });
  handle.stderr?.on('data', chunk => { diagnostics.stderr = (diagnostics.stderr + String(chunk)).slice(-8000); });
  let client;
  try {
    const targets = await waitForDebugger(port, handle, diagnostics);
    const target = targets.find(item => item.type === 'page' && item.webSocketDebuggerUrl);
    if (!target) throw new Error('表示検査用のブラウザページを作成できません。');
    client = await new CdpClient(target.webSocketDebuggerUrl).connect();
    await Promise.all([
      client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable'), client.send('Log.enable')
    ]);
    await client.send('Network.setCacheDisabled', { cacheDisabled: true });
    await client.send('Network.setExtraHTTPHeaders', { headers: { 'X-WebCapture-Replay-Audit': '1' } });
    return {
      client,
      async close() {
        client?.close();
        await terminateBrowser(handle);
        await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
      }
    };
  } catch (error) {
    client?.close();
    await terminateBrowser(handle);
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    throw error;
  }
}

export async function captureFullPage(client, { maxHeight = 16000, timeoutMs = 60000 } = {}) {
  const metrics = await client.send('Page.getLayoutMetrics', {}, 15000);
  const content = metrics.cssContentSize || metrics.contentSize || {};
  const viewport = metrics.cssLayoutViewport || metrics.layoutViewport || {};
  const width = Math.max(1, Math.ceil(viewport.clientWidth || content.width || 1440));
  const height = Math.max(1, Math.min(maxHeight, Math.ceil(content.height || viewport.clientHeight || 1000)));
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x: 0, y: 0, width, height, scale: 1 } }, timeoutMs);
  return shot.data ? Buffer.from(shot.data, 'base64') : null;
}

export async function auditReplayPage(client, { archiveId, page, replayOrigin, signal, settleMs = 250, captureVisual = false } = {}) {
  if (signal?.aborted) throw abortError();
  const navigationId = `audit-${crypto.randomBytes(6).toString('hex')}`;
  const targetUrl = `${replayOrigin}/archive/${encodeURIComponent(archiveId)}/page?url=${encodeURIComponent(page.url)}&navigationId=${navigationId}`;
  const collected = {
    documentStatus: null,
    missingResources: [],
    boundaryResources: [],
    auxiliaryResources: [],
    failedRequests: [],
    archivedErrorResponses: [],
    isolationEvents: [],
    runtimeAdvisories: [],
    runtimeErrors: []
  };
  const collectRuntime = (item) => {
    if (isReplayIsolationMessage(item.message)) collected.isolationEvents.push(item);
    else if (isRuntimeAdvisory(item.message)) collected.runtimeAdvisories.push(item);
    else collected.runtimeErrors.push(item);
  };
  const auditBlockedRequests = new Set();
  await client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
  const removers = [
    client.on('Fetch.requestPaused', event => {
      let allowed = false;
      try {
        const requested = new URL(event.request?.url || '');
        allowed = ['data:', 'blob:', 'about:'].includes(requested.protocol) || requested.origin === new URL(replayOrigin).origin;
      } catch {}
      if (allowed) {
        client.send('Fetch.continueRequest', { requestId: event.requestId }).catch(() => {});
        return;
      }
      auditBlockedRequests.add(event.networkId || event.requestId);
      collected.isolationEvents.push({ kind: 'external-request-blocked', message: '表示検査中の外部接続を遮断', source: safeUrl(event.request?.url || '') });
      client.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
    }),
    client.on('Network.responseReceived', event => {
      const response = event.response || {};
      const headers = lowerHeaders(response.headers);
      if (event.type === 'Document') collected.documentStatus = Number(response.status || 0);
      const originalUrl = originalReplayTarget(response.url);
      const item = { url: safeUrl(originalUrl), status: Number(response.status || 0), type: event.type || 'Other' };
      if (headers['x-webcapture-server-boundary'] === '1') collected.boundaryResources.push(item);
      else if (headers['x-webcapture-auxiliary-disabled'] === '1') collected.auxiliaryResources.push(item);
      else if (headers['x-webcapture-missing-resource'] === '1') collected[missingResourceBucket(originalUrl)].push(item);
      else if (headers['x-webcapture-archived-status']) {
        if (isServerBoundaryUrl(originalUrl)) collected.boundaryResources.push(item);
        else if (isAuxiliaryRuntimeUrl(originalUrl)) collected.auxiliaryResources.push(item);
        else collected.archivedErrorResponses.push(item);
      }
      else if (Number(response.status || 0) >= 400) {
        if (isReplayIsolationResponse(response, event, replayOrigin)) collected.isolationEvents.push(item);
        else collected.failedRequests.push(item);
      }
    }),
    client.on('Network.loadingFailed', event => {
      if (auditBlockedRequests.delete(event.requestId)) return;
      if (event.canceled || event.errorText === 'net::ERR_ABORTED') return;
      const item = {
        url: '', status: 0, type: event.type || 'Other', error: diagnosticText(event.errorText),
        blockedReason: diagnosticText(event.blockedReason || event.corsErrorStatus?.corsError || '')
      };
      if (isReplayIsolationFailure(event)) collected.isolationEvents.push(item);
      else collected.failedRequests.push(item);
    }),
    client.on('Runtime.exceptionThrown', event => {
      const detail = event.exceptionDetails || {};
      collectRuntime({ kind: 'exception', message: diagnosticText(detail.exception?.description || detail.text), source: safeUrl(detail.url || '') });
    }),
    client.on('Runtime.consoleAPICalled', event => {
      if (!['error', 'assert'].includes(event.type)) return;
      const message = (event.args || []).map(arg => arg.value ?? arg.description ?? '').join(' ');
      collectRuntime({ kind: 'console', message: diagnosticText(message), source: '' });
    }),
    client.on('Log.entryAdded', event => {
      const entry = event.entry || {};
      if (entry.level !== 'error') return;
      collectRuntime({ kind: 'log', message: diagnosticText(entry.text), source: safeUrl(entry.url || '') });
    })
  ];
  let navigationError = '';
  try {
    const loaded = waitForEvent(client, 'Page.loadEventFired', 15000, signal);
    const navigation = await client.send('Page.navigate', { url: targetUrl }, 15000);
    if (navigation.errorText) navigationError = diagnosticText(navigation.errorText);
    try { await loaded; } catch (error) { if (error.name === 'AbortError') throw error; navigationError ||= diagnosticText(error.message); }
    await delay(settleMs, signal);
    let metrics = {}, interactions = {};
    try {
      const evaluated = await client.send('Runtime.evaluate', { expression: PAGE_AUDIT_EXPRESSION, awaitPromise: true, returnByValue: true }, 20000);
      if (evaluated.exceptionDetails) navigationError ||= diagnosticText(evaluated.exceptionDetails.text || 'ページ状態を取得できません。');
      metrics = evaluated.result?.value || {};
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      navigationError ||= diagnosticText(error.message);
    }
    let visualShot = null;
    if (captureVisual && !navigationError) {
      try { visualShot = await captureFullPage(client); } catch (error) { if (error.name === 'AbortError') throw error; }
    }
    try {
      const evaluated = await client.send('Runtime.evaluate', { expression: SAFE_INTERACTION_AUDIT_EXPRESSION, awaitPromise: true, returnByValue: true }, 30000);
      if (evaluated.exceptionDetails) interactions = { discoveredCount: 0, candidateCount: 0, testedCount: 0, skippedCount: 0, transientCount: 0, changedCount: 0, errorCount: 1, limitReached: false, items: [{ kind: 'audit', label: '', changed: false, error: diagnosticText(evaluated.exceptionDetails.text), status: 'error', reason: '' }] };
      else interactions = evaluated.result?.value || {};
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      interactions = { discoveredCount: 0, candidateCount: 0, testedCount: 0, skippedCount: 0, transientCount: 0, changedCount: 0, errorCount: 1, limitReached: false, items: [{ kind: 'audit', label: '', changed: false, error: diagnosticText(error.message), status: 'error', reason: '' }] };
    }
    const result = {
      url: page.url,
      requestedUrl: page.requestedUrl || page.url,
      savedTitle: page.title || '',
      title: metrics.title || '',
      documentStatus: collected.documentStatus,
      navigationError,
      metrics,
      interactions,
      missingResources: uniqueBy(collected.missingResources, item => `${item.url}|${item.status}|${item.type}`).slice(0, 100),
      boundaryResources: uniqueBy(collected.boundaryResources, item => `${item.url}|${item.status}|${item.type}`).slice(0, 100),
      auxiliaryResources: uniqueBy(collected.auxiliaryResources, item => `${item.url}|${item.status}|${item.type}`).slice(0, 100),
      failedRequests: uniqueBy(collected.failedRequests, item => `${item.url}|${item.status}|${item.type}|${item.error || ''}`).slice(0, 100),
      archivedErrorResponses: uniqueBy(collected.archivedErrorResponses, item => `${item.url}|${item.status}|${item.type}`).slice(0, 100),
      isolationEvents: uniqueBy(collected.isolationEvents, item => `${item.kind || ''}|${item.message || ''}|${item.source || ''}|${item.url || ''}|${item.status || 0}|${item.type || ''}|${item.error || ''}|${item.blockedReason || ''}`).slice(0, 100),
      runtimeAdvisories: uniqueBy(collected.runtimeAdvisories, item => `${item.kind}|${item.message}|${item.source}`).slice(0, 100),
      runtimeErrors: uniqueBy(collected.runtimeErrors, item => `${item.kind}|${item.message}|${item.source}`).slice(0, 100)
    };
    if (visualShot) result.visualShot = visualShot;
    result.status = classifyReplayAuditPage(result);
    if (result.status === 'error') {
      try {
        const screenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true }, 30000);
        if (screenshot.data) result.screenshot = Buffer.from(screenshot.data, 'base64');
      } catch {}
    }
    return result;
  } finally {
    for (const remove of removers) remove();
    await client.send('Fetch.disable').catch(() => {});
  }
}

export function defaultVisualComparer(config) {
  const appOrigin = `http://${config.host}:${config.port}`;
  let ready = false;
  return async (client, archiveId, savedPath, replayPath) => {
    if (!ready) {
      const loaded = waitForEvent(client, 'Page.loadEventFired', 15000);
      await client.send('Page.navigate', { url: `${appOrigin}/visual-diff.html` }, 15000);
      await loaded.catch(() => {});
      ready = true;
    }
    const image = (file) => `/api/archives/${encodeURIComponent(archiveId)}/image?path=${encodeURIComponent(file)}`;
    const evaluated = await client.send('Runtime.evaluate', {
      expression: `import('/visual-diff.js').then((module) => module.compareImageUrls(${JSON.stringify(image(savedPath))}, ${JSON.stringify(image(replayPath))}))`,
      awaitPromise: true, returnByValue: true
    }, 60000);
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text || '見た目を比べられませんでした。');
    return evaluated.result?.value || {};
  };
}

function publicState(state) {
  if (!state) return null;
  const { controller: _controller, task: _task, ...output } = state;
  return structuredClone(output);
}

function reportSummary(pages) {
  const count = status => pages.filter(page => page.status === status).length;
  return {
    totalPages: pages.length,
    healthyPages: count('healthy'),
    warningPages: count('warning'),
    errorPages: count('error'),
    visibleBrokenImages: pages.reduce((sum, page) => sum + Number(page.metrics?.visibleBrokenImageCount || 0), 0),
    visiblePendingImages: pages.reduce((sum, page) => sum + Number(page.metrics?.visiblePendingImageCount || 0), 0),
    missingResources: pages.reduce((sum, page) => sum + Number(page.missingResources?.length || 0), 0),
    boundaryResources: pages.reduce((sum, page) => sum + Number(page.boundaryResources?.length || 0), 0),
    auxiliaryResources: pages.reduce((sum, page) => sum + Number(page.auxiliaryResources?.length || 0), 0),
    failedRequests: pages.reduce((sum, page) => sum + Number(page.failedRequests?.length || 0), 0),
    archivedErrorResponses: pages.reduce((sum, page) => sum + Number(page.archivedErrorResponses?.length || 0), 0),
    isolationEvents: pages.reduce((sum, page) => sum + Number(page.isolationEvents?.length || 0), 0),
    runtimeAdvisories: pages.reduce((sum, page) => sum + Number(page.runtimeAdvisories?.length || 0), 0),
    runtimeErrors: pages.reduce((sum, page) => sum + Number(page.runtimeErrors?.length || 0), 0),
    interactionCandidates: pages.reduce((sum, page) => sum + Number(page.interactions?.candidateCount || 0), 0),
    interactionsTested: pages.reduce((sum, page) => sum + Number(page.interactions?.testedCount || 0), 0),
    interactionChanges: pages.reduce((sum, page) => sum + Number(page.interactions?.changedCount || 0), 0),
    interactionErrors: pages.reduce((sum, page) => sum + Number(page.interactions?.errorCount || 0), 0),
    interactionSkipped: pages.reduce((sum, page) => sum + Number(page.interactions?.skippedCount || 0), 0),
    interactionTransient: pages.reduce((sum, page) => sum + Number(page.interactions?.transientCount || 0), 0),
    interactionLimitPages: pages.filter(page => page.interactions?.limitReached).length,
    visualCompared: pages.filter(page => Number.isFinite(page.visual?.similarity)).length,
    visualMismatchPages: pages.filter(page => Number.isFinite(page.visual?.similarity) && page.visual.similarity < VISUAL_MATCH_THRESHOLD).length,
    visualAverage: (() => {
      const values = pages.map(page => page.visual?.similarity).filter(Number.isFinite);
      return values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length * 1000) / 1000 : null;
    })()
  };
}

export class ReplayAuditManager {
  constructor(store, config, options = {}) {
    this.store = store;
    this.config = config;
    this.executable = options.executable;
    this.browserFactory = options.browserFactory || createLocalAuditBrowser;
    this.auditPage = options.auditPage || auditReplayPage;
    this.compareVisual = options.compareVisual || null;
    this.states = new Map();
    this.queue = Promise.resolve();
    this.closed = false;
  }

  async status(archiveId) {
    const active = this.states.get(archiveId);
    return publicState(active || await this.store.readReplayAudit(archiveId));
  }

  async start(archiveId) {
    if (this.closed) throw new Error('アプリを終了中です。');
    const existing = this.states.get(archiveId);
    if (existing && ['queued', 'running', 'cancelling'].includes(existing.status)) return publicState(existing);
    const archive = this.store.getArchive(archiveId);
    const manifest = await this.store.readManifest(archiveId);
    if (!archive || !manifest) throw new Error('保存済みサイトが見つかりません。');
    const pages = (manifest.pages || []).filter(page => page?.html && page?.url);
    if (!pages.length) throw new Error('表示検査できる保存ページがありません。');
    const controller = new AbortController();
    const state = {
      schemaVersion: 3,
      archiveId,
      runId: `${new Date().toISOString().replace(/[-:.Z]/g, '')}-${crypto.randomBytes(4).toString('hex')}`,
      status: 'queued',
      startedAt: null,
      completedAt: null,
      pagesTotal: pages.length,
      pagesAudited: 0,
      currentPageTitle: '',
      summary: null,
      pages: [],
      coverage: {
        rendering: true, images: true, fonts: true, scrolling: true, runtimeErrors: true,
        externalNetwork: false, interactions: true, interactionScope: 'visible-safe-controls', interactionSequences: false, timepoints: 2
      },
      controller,
      task: null
    };
    this.states.set(archiveId, state);
    const task = this.queue.catch(() => {}).then(() => this.run(state, pages));
    state.task = task;
    this.queue = task.catch(() => {});
    return publicState(state);
  }

  async run(state, pages) {
    let session;
    try {
      if (state.controller.signal.aborted) throw abortError();
      state.status = 'running';
      state.startedAt = new Date().toISOString();
      this.store.setReplayMissSuppressed?.(state.archiveId, true);
      logEvent('info', 'replay-audit', 'started', { archiveId: state.archiveId, pages: pages.length });
      session = await this.browserFactory({ executable: this.executable });
      for (const [index, page] of pages.entries()) {
        if (state.controller.signal.aborted) throw abortError();
        state.currentPageTitle = String(page.title || new URL(page.url).hostname).slice(0, 160);
        const result = await this.auditPage(session.client, {
          archiveId: state.archiveId,
          page,
          replayOrigin: `http://${this.config.host}:${this.config.replayPort}`,
          signal: state.controller.signal,
          captureVisual: Boolean(page.screenshot)
        });
        if (result.visualShot) {
          const directory = path.join(this.store.archiveRoot(state.archiveId), 'replay-audit', state.runId, 'visual');
          await fs.mkdir(directory, { recursive: true });
          const name = `${String(index + 1).padStart(5, '0')}-${crypto.createHash('sha256').update(page.url).digest('hex').slice(0, 12)}.png`;
          const file = path.join(directory, name);
          const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
          await fs.writeFile(temporary, result.visualShot);
          await fs.rename(temporary, file);
          result.visual = { saved: page.screenshot, replay: path.relative(this.store.archiveRoot(state.archiveId), file).replaceAll('\\', '/') };
        }
        delete result.visualShot;
        if (!result.interactions || result.interactions.limitReached || Number(result.interactions.skippedCount || 0) > 0) state.coverage.interactions = false;
        for (const interaction of result.interactions?.items || []) {
          logEvent(interaction.error ? 'warn' : 'info', 'replay-audit', 'interaction.completed', {
            archiveId: state.archiveId, pageUrl: safeUrl(page.url), kind: interaction.kind,
            label: diagnosticText(interaction.label), changed: Boolean(interaction.changed), error: diagnosticText(interaction.error),
            status: interaction.status || (interaction.error ? 'error' : 'tested'), reason: interaction.reason || ''
          });
        }
        if (result.screenshot) {
          const directory = path.join(this.store.archiveRoot(state.archiveId), 'replay-audit', state.runId, 'screenshots');
          await fs.mkdir(directory, { recursive: true });
          const name = `${String(index + 1).padStart(5, '0')}-${crypto.createHash('sha256').update(page.url).digest('hex').slice(0, 12)}.png`;
          const file = path.join(directory, name);
          const temporary = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
          await fs.writeFile(temporary, result.screenshot);
          await fs.rename(temporary, file);
          result.screenshot = path.relative(this.store.archiveRoot(state.archiveId), file).replaceAll('\\', '/');
        }
        state.pages.push(result);
        state.pagesAudited = index + 1;
        state.summary = reportSummary(state.pages);
        logEvent(result.status === 'error' ? 'error' : result.status === 'warning' ? 'warn' : 'info', 'replay-audit', 'page.completed', {
          archiveId: state.archiveId, pageUrl: safeUrl(page.url), index: index + 1, total: pages.length, status: result.status,
          visibleBrokenImages: result.metrics?.visibleBrokenImageCount || 0,
          missingResources: result.missingResources.length,
          boundaryResources: result.boundaryResources.length,
          auxiliaryResources: result.auxiliaryResources.length,
          runtimeErrors: result.runtimeErrors.length
        });
      }
      await this.compareVisuals(state, session).catch((error) => logEvent('warn', 'replay-audit', 'visual.failed', { archiveId: state.archiveId, message: diagnosticText(error.message) }));
      state.status = 'completed';
      state.completedAt = new Date().toISOString();
      state.currentPageTitle = '';
      state.summary = reportSummary(state.pages);
      await this.store.writeReplayAudit(state.archiveId, publicState(state));
      logEvent('info', 'replay-audit', 'completed', { archiveId: state.archiveId, ...state.summary });
    } catch (error) {
      state.status = error.name === 'AbortError' ? 'cancelled' : 'failed';
      state.completedAt = new Date().toISOString();
      state.currentPageTitle = '';
      state.message = diagnosticText(error.message || '表示検査に失敗しました。');
      state.summary = reportSummary(state.pages);
      await this.store.writeReplayAudit(state.archiveId, publicState(state)).catch(() => {});
      logEvent(state.status === 'cancelled' ? 'warn' : 'error', 'replay-audit', state.status, { archiveId: state.archiveId, message: state.message, pagesAudited: state.pagesAudited });
    } finally {
      await session?.close().catch(() => {});
      this.store.setReplayMissSuppressed?.(state.archiveId, false);
      state.controller = null;
      state.task = null;
    }
  }

  async compareVisuals(state, session) {
    const targets = state.pages.filter((page) => page.visual?.saved && page.visual?.replay);
    if (!targets.length) return;
    const compare = this.compareVisual || defaultVisualComparer(this.config);
    state.currentPageTitle = '見た目の比較';
    for (const page of targets) {
      if (state.controller.signal.aborted) throw abortError();
      try {
        const result = await compare(session.client, state.archiveId, page.visual.saved, page.visual.replay);
        page.visual = { ...page.visual, ...result, changed: (result.changed || []).slice(0, 4000) };
      } catch (error) {
        page.visual = { ...page.visual, error: diagnosticText(error.message) };
      }
    }
    logEvent('info', 'replay-audit', 'visual.completed', { archiveId: state.archiveId, pages: targets.length });
  }

  cancel(archiveId) {
    const state = this.states.get(archiveId);
    if (!state || !['queued', 'running'].includes(state.status)) return publicState(state);
    state.status = 'cancelling';
    state.controller.abort();
    return publicState(state);
  }

  async cancelAndWait(archiveId) {
    const state = this.states.get(archiveId);
    this.cancel(archiveId);
    if (state?.task) await state.task;
    return publicState(this.states.get(archiveId));
  }

  async shutdown() {
    this.closed = true;
    const tasks = [];
    for (const state of this.states.values()) {
      if (['queued', 'running', 'cancelling'].includes(state.status)) state.controller?.abort();
      if (state.task) tasks.push(state.task);
    }
    await Promise.allSettled(tasks);
  }
}
