import { WEBAUTHN_GUARD_SOURCE } from './webauthn-guard.mjs';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { assertPublicUrl, isRecordableRequestMethod } from './policy.mjs';
import { createPolicyProxy } from './policy-proxy.mjs';
import { logEvent, safeUrl } from './logger.mjs';
import { resourceTypeAllowed } from './capture-options.mjs';
import { parseSrcset } from './srcset.mjs';
import { installFontCapture, capturedFontCss } from './browser-fonts.mjs';
import { installShadowCapture, capturedShadowRoots, adoptedDocumentCss } from './browser-shadow.mjs';
import { safeInteractionExpression } from './safe-interactions.mjs';
import { detectCharset, isTextualType } from './charset.mjs';
import { IMAGE_SOURCE_ATTRIBUTES } from './asset-references.mjs';
import { installSeededRandom, pageSeed } from './determinism.mjs';
import { installCanvasPreservation } from './browser-canvas.mjs';
import { openCaptureTarget, startLiveScreencast } from './browser-live.mjs';
import { isCaptureNoise } from './noise-filter.mjs';

function headerValue(headers = {}, name) {
  const key = Object.keys(headers || {}).find((item) => item.toLowerCase() === name);
  return key ? String(headers[key]) : '';
}

const WINDOWS_BROWSER_PATHS = [
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
].filter(Boolean);

const MAC_BROWSER_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium'
];
const LINUX_BROWSER_NAMES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable'];

export function browserCandidates(platform = process.platform, env = process.env) {
  const configured = env.WEBCAPTURE_BROWSER ? [env.WEBCAPTURE_BROWSER] : [];
  if (platform === 'win32') return [...configured, ...WINDOWS_BROWSER_PATHS];
  if (platform === 'darwin') return [...configured, ...MAC_BROWSER_PATHS];
  const folders = String(env.PATH || '').split(':').filter(Boolean);
  return [...configured, ...LINUX_BROWSER_NAMES.flatMap((name) => folders.map((folder) => path.posix.join(folder, name)))];
}

export function platformBrowserArgs(platform = process.platform) {
  return platform === 'linux' && typeof process.getuid === 'function' && process.getuid() === 0 ? ['--no-sandbox'] : [];
}

const BROWSER_FAILURE_COOLDOWN_MS = 10 * 60 * 1000;
const browserStartFailures = new Map();

export function noteBrowserStartFailure(executable, at = Date.now()) {
  if (executable) browserStartFailures.set(executable, at);
}

export function clearBrowserStartFailures() { browserStartFailures.clear(); }

function recentlyFailed(executable, now = Date.now()) {
  const at = browserStartFailures.get(executable);
  if (!at) return false;
  if (now - at < BROWSER_FAILURE_COOLDOWN_MS) return true;
  browserStartFailures.delete(executable);
  return false;
}

export async function findBrowsers() {
  const found = [];
  for (const file of browserCandidates()) {
    if (found.includes(file)) continue;
    try { await fs.access(file); found.push(file); } catch {}
  }
  return found;
}

export async function findBrowser() {
  const found = await findBrowsers();
  return found.find((file) => !recentlyFailed(file)) || found[0] || null;
}

export async function pendingBrowserUpdate(executable) {
  if (!executable || !/chrome\.exe$/i.test(executable)) return false;
  try { await fs.access(path.join(path.dirname(executable), 'new_chrome.exe')); return true; } catch { return false; }
}

export function browserStartOrder(executable, installed = [], now = Date.now()) {
  const others = installed.filter((file) => file !== executable);
  const healthy = others.filter((file) => !recentlyFailed(file, now));
  const failing = others.filter((file) => recentlyFailed(file, now));
  if (recentlyFailed(executable, now) && healthy.length) return [...healthy, executable, ...failing];
  return [executable, executable, ...healthy, ...failing];
}

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function terminateBrowser(handle, { graceful = null } = {}) {
  if (!handle || handle.exitCode !== null || handle.signalCode !== null) return;
  const exited = new Promise((resolve) => handle.once('exit', resolve));
  if (graceful) {
    await graceful().catch(() => {});
    await Promise.race([exited, delay(1500)]);
    if (handle.exitCode !== null || handle.signalCode !== null) return;
  }
  if (process.platform === 'win32' && handle.pid) {
    await new Promise((resolve) => childProcess.execFile('taskkill', ['/PID', String(handle.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, () => resolve()));
    await Promise.race([exited, delay(1000)]);
    releaseBrowserHandle(handle);
    return;
  }
  handle.kill();
  await Promise.race([exited, delay(2000)]);
  if (handle.exitCode === null && handle.signalCode === null) {
    handle.kill('SIGKILL');
    await Promise.race([exited, delay(1000)]);
  }
  releaseBrowserHandle(handle);
}

function releaseBrowserHandle(handle) {
  if (handle.exitCode !== null || handle.signalCode !== null) return;
  try { handle.stderr?.destroy(); } catch {}
  try { handle.unref(); } catch {}
}

export function removeProfileLater(profile) {
  const attempt = (remaining) => fs.rm(profile, { recursive: true, force: true }).catch(() => {
    if (remaining > 0) setTimeout(() => attempt(remaining - 1), 2000).unref?.();
  });
  return attempt(120);
}

export async function waitForDebugger(port, processHandle, diagnostics = {}) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null || processHandle.signalCode !== null) throw new Error('ブラウザがキャプチャ開始前に終了しました。');
    if (diagnostics.spawnError) throw diagnostics.spawnError;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        const targets = await response.json();
        if (Array.isArray(targets) && targets.some((target) => target.type === 'page')) return targets;
      }
    } catch {}
    await delay(100);
  }
  throw new Error('ブラウザのキャプチャ接続がタイムアウトしました。');
}

export class CdpClient {
  constructor(url) {
    this.url = url;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  async connect() {
    this.socket = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DevTools接続がタイムアウトしました。')), 10000);
      this.socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('DevToolsへ接続できません。')); }, { once: true });
    });
    this.socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result || {});
        return;
      }
      const handlers = this.listeners.get(message.method) || [];
      for (const handler of handlers) handler(message.params || {}, message.sessionId || null);
    });
    return this;
  }

  send(method, params = {}, timeoutMs = 30000, sessionId = null) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs === null ? null : setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} がタイムアウトしました。`)); }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => { if (timer) clearTimeout(timer); resolve(value); },
        reject: (error) => { if (timer) clearTimeout(timer); reject(error); }
      });
      if (this.socket?.readyState !== WebSocket.OPEN) {
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        reject(new Error('DevTools接続が閉じています。'));
        return;
      }
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
    return () => this.listeners.set(method, handlers.filter((item) => item !== handler));
  }

  close(error = new Error('DevTools接続を閉じました。')) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close();
  }
}

function extractResult(evaluation) {
  if (evaluation.exceptionDetails) {
    const detail = evaluation.exceptionDetails.exception?.description || evaluation.exceptionDetails.text || 'unknown';
    throw new Error(`ページ内の状態を読み取れませんでした: ${detail}`);
  }
  return evaluation.result?.value;
}

async function prepareFullPageScreenshot(client) {
  return extractResult(await client.send('Runtime.evaluate', {
    expression: `(() => {
      const changed=[];
      const remember=element=>{if(!changed.some(item=>item.element===element))changed.push({element,style:element.getAttribute('style'),scrollTop:element.scrollTop,scrollLeft:element.scrollLeft})};
      const depth=e=>{let value=0;for(let n=e;n;n=n.parentElement)value++;return value};
      const candidates=[...document.querySelectorAll('*')].filter(e=>{
        if(e===document.scrollingElement)return false;
        const style=getComputedStyle(e),rect=e.getBoundingClientRect();
        return rect.width>0&&rect.height>=80&&e.scrollHeight>e.clientHeight+20&&/(auto|scroll)/.test(style.overflowY);
      }).sort((a,b)=>depth(b)-depth(a));
      for(const root of [document.documentElement,document.body].filter(Boolean)){
        remember(root);
        root.style.setProperty('height','auto','important');
        root.style.setProperty('max-height','none','important');
        root.style.setProperty('overflow','visible','important');
      }
      for(const element of candidates){
        remember(element);
        const height=Math.ceil(element.scrollHeight);
        element.style.setProperty('height',height+'px','important');
        element.style.setProperty('max-height','none','important');
        element.style.setProperty('overflow-y','visible','important');
        element.style.setProperty('overscroll-behavior','auto','important');
        if(getComputedStyle(element).position==='fixed')element.style.setProperty('position','relative','important');
        element.scrollTo(0,0);
      }
      window.scrollTo(0,0);
      window.__webcaptureScreenshotRestore=()=>{
        for(const item of changed){
          if(item.style===null)item.element.removeAttribute('style');else item.element.setAttribute('style',item.style);
          item.element.scrollTo(item.scrollLeft,item.scrollTop);
        }
        delete window.__webcaptureScreenshotRestore;
      };
      return {expandedScrollContainers:candidates.length,documentHeight:Math.max(document.documentElement.scrollHeight,document.body?.scrollHeight||0)};
    })()`,
    returnByValue: true
  }));
}

async function restoreFullPageScreenshot(client) {
  await client.send('Runtime.evaluate', { expression: `(()=>{try{window.__webcaptureScreenshotRestore?.()}catch{}return true})()`, returnByValue: true }).catch(() => {});
}

const HOVER_TARGETS = 'nav li, nav a, [role="menubar"] > *, [role="menu"] > *, [aria-haspopup], [class*="dropdown" i], [class*="mega" i], [class*="submenu" i], [class*="has-child" i], [class*="menu-item" i], [data-hover], [class*="hover" i]';

async function hoverMenus(client, { limit = 80, settleMs = 120, deadline = Infinity } = {}) {
  const prepared = extractResult(await client.send('Runtime.evaluate', {
    expression: `(() => {
      const visible = (element) => { const style = getComputedStyle(element), rect = element.getBoundingClientRect(); return style.display !== 'none' && style.visibility !== 'hidden' && rect.width >= 4 && rect.height >= 4; };
      const targets = [...new Set([...document.querySelectorAll(${JSON.stringify(HOVER_TARGETS)})].filter(visible))].slice(0, ${Math.max(1, Number(limit) || 80)});
      window.__webcaptureHoverTargets = targets;
      return targets.length;
    })()`,
    returnByValue: true
  }));
  let hovered = 0;
  for (let index = 0; index < prepared && Date.now() < deadline; index += 1) {
    const point = extractResult(await client.send('Runtime.evaluate', {
      expression: `(() => { const element = window.__webcaptureHoverTargets?.[${index}]; if (!element || !element.isConnected) return null; element.scrollIntoView({ block: 'center', inline: 'nearest' }); const rect = element.getBoundingClientRect(); if (rect.width < 1 || rect.height < 1) return null; return { x: Math.max(1, rect.left + Math.min(rect.width / 2, 24)), y: Math.max(1, rect.top + rect.height / 2) }; })()`,
      returnByValue: true
    }));
    if (!point) continue;
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    hovered += 1;
    await delay(settleMs);
  }
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 0, y: 0 }).catch(() => {});
  await client.send('Runtime.evaluate', { expression: '(()=>{scrollTo(0,0);delete window.__webcaptureHoverTargets;return true})()', returnByValue: true }).catch(() => {});
  return { candidates: prepared, hovered };
}

async function captureFallbackState(client, url, timeoutMs) {
  await client.send('DOM.enable', {}, timeoutMs).catch(() => {});
  const { root } = await client.send('DOM.getDocument', { depth: 0 }, timeoutMs);
  const { outerHTML } = await client.send('DOM.getOuterHTML', { nodeId: root.nodeId }, timeoutMs);
  const documentUrl = root.documentURL || url;
  const html = /^\s*<!doctype/i.test(outerHTML) ? outerHTML : `<!doctype html>\n${outerHTML}`;
  const links = new Map();
  for (const match of html.matchAll(/<(?:a|area)\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s">]+))/gi)) {
    const value = (match[1] ?? match[2] ?? match[3] ?? '').replaceAll('&amp;', '&');
    try {
      const resolved = new URL(value, documentUrl).href;
      if (!links.has(resolved)) links.set(resolved, { url: resolved, text: '' });
    } catch {}
  }
  return {
    html, url: documentUrl, links: [...links.values()], capturedFontFaces: 0, serializeFallback: true,
    title: (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '').trim()
  };
}

export async function captureWithBrowser(url, options = {}) {
  const diagnostic = options.diagnosticContext || {};
  logEvent('info', 'capture', 'page.started', { ...diagnostic, pageUrl: safeUrl(url) });
  const ownedSession = !options.session;
  const session = options.session || await createBrowserCaptureSession(options);
  const { executable, port, handle } = session;
  let client;
  let target;
  let live = null;
  let hardTimeout;
  let finalizeTimeout;
  const captureTimeoutMs = Math.max(1000, Number(options.timeoutMs ?? 120000));
  const finalizeGraceMs = Math.max(5000, Number(options.finalizeGraceMs ?? 45000));
  const captureDeadline = Date.now() + captureTimeoutMs;
  const remainingMs = () => Math.max(0, captureDeadline - Date.now());
  const finalizeBudgetMs = () => Math.max(20000, remainingMs() + finalizeGraceMs);
  const timeoutError = new Error(`ページ全体の保存が${Math.ceil((captureTimeoutMs + finalizeGraceMs) / 1000)}秒を超えたため、次のページへ進みます。`);
  timeoutError.code = 'PAGE_CAPTURE_TIMEOUT';
  let timedOut = false;
  const abort = () => { if (ownedSession) session.close().catch(() => {}); else client?.close(new Error('保存を中止しました。')); };
  if (options.signal?.aborted) {
    if (ownedSession) await session.close();
    throw new Error('保存を中止しました。');
  }
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    hardTimeout = setTimeout(() => {
      timedOut = true;
      logEvent('warn', 'capture', 'page.timeout', { ...diagnostic, pageUrl: safeUrl(url), timeoutMs: captureTimeoutMs, finalizeGraceMs });
      finalizeTimeout = setTimeout(() => {
        if (client) client.close(timeoutError);
        else if (ownedSession) session.close().catch(() => {});
      }, finalizeGraceMs);
    }, captureTimeoutMs);
    const targets = ownedSession
      ? await waitForDebugger(port, handle)
      : [await openCaptureTarget(session)];
    target = targets.find((item) => item.type === 'page');
    if (!target) throw new Error('キャプチャ用ページを作成できません。');
    client = await new CdpClient(target.webSocketDebuggerUrl).connect();
    const responses = new Map();
    const requestUrls = new Map();
    const redirects = [];
    const resourceBodies = new Map();
    const transcodedBodies = new Set();
    const requestDetails = new Map();
    const bodyReadAttempts = new Set();
    const pendingBodyReads = new Set();
    const finishedRequests = new Set();
    let unfinishedBodies = 0;
    const blocked = [];
    const pendingRequests = new Map();
    const noiseRequests = new Set();
    let noiseBlockedCount = 0;
    const blockNoise = options.blockTrackers !== false;
    const longRequestMs = Math.max(1000, Number(options.longRequestMs ?? 15000));
    const networkBusy = () => {
      const now = Date.now();
      for (const startedAt of pendingRequests.values()) if (now - startedAt < longRequestMs) return true;
      return now - lastNetworkActivity < (options.networkIdleMs ?? 1000);
    };
    let lastNetworkActivity = Date.now();
    const networkParams = {
      maxTotalBufferSize: 2 * 1024 * 1024 * 1024 - 1,
      maxResourceBufferSize: Math.min(options.responseMaxBytes ?? (1024 * 1024 * 1024), 1024 * 1024 * 1024)
    };
    const attachedTargets = { frames: 0, workers: 0, failed: 0 };
    const childFrames = new Map();
    const deferredDocuments = new Map();
    const checkedHosts = new Map();
    const check = async (requestUrl) => {
      const parsed = new URL(requestUrl);
      const key = parsed.hostname;
      if (!checkedHosts.has(key)) checkedHosts.set(key, assertPublicUrl(requestUrl, options.policyOptions));
      return checkedHosts.get(key);
    };
    await Promise.all([
      client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable', networkParams),
      client.send('Network.setCacheDisabled', { cacheDisabled: options.disableBrowserCache !== false }),
      client.send('Emulation.setDeviceMetricsOverride', options.mobile ? {
        width: MOBILE_CAPTURE_VIEWPORT.width, height: MOBILE_CAPTURE_VIEWPORT.height,
        deviceScaleFactor: MOBILE_CAPTURE_VIEWPORT.deviceScaleFactor, mobile: true
      } : {
        width: options.viewportWidth || 1440, height: options.viewportHeight || 1000,
        deviceScaleFactor: options.deviceScaleFactor || 1, mobile: false
      }),
      options.mobile ? client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }).catch(() => {}) : null,
      client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }),
      session.userAgent || options.mobile ? client.send('Network.setUserAgentOverride', userAgentOverride(session, options.mobile)) : null,
      client.send('WebAuthn.enable', { enableUI: false }).catch(() => {})
    ]);
    live = startLiveScreencast(client, options.liveView);
    const requestKey = (sessionId, requestId) => sessionId ? `${sessionId}:${requestId}` : requestId;
    client.on('Fetch.requestPaused', async ({ requestId, request, resourceType }, sessionId) => {
      if (blockNoise && resourceType !== 'Document' && isCaptureNoise(request.url, resourceType)) {
        noiseBlockedCount += 1;
        try { await client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, 30000, sessionId); } catch {}
        return;
      }
      try {
        if (!isRecordableRequestMethod(request.method)) throw new Error('送信操作は保存しません。');
        if (request.method === 'POST' && resourceType === 'Document') throw new Error('フォーム送信によるページ移動は行いません。');
        if (!resourceTypeAllowed(resourceType, options.resourceTypes)) throw new Error(`素材種別 ${resourceType || 'Other'} は設定により保存しません。`);
        if (!/^(?:data:|blob:)/i.test(request.url)) await check(request.url);
      } catch (error) {
        blocked.push({ url: request.url, reason: error.message });
        try { await client.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }, 30000, sessionId); } catch {}
        return;
      }
      try { await client.send('Fetch.continueRequest', { requestId }, 30000, sessionId); } catch {}
    });
    client.on('Network.responseReceived', ({ requestId, response, type }, sessionId) => {
      const key = requestKey(sessionId, requestId);
      responses.set(key, {
        requestId: key, cdpRequestId: requestId, sessionId, url: response.url, status: response.status,
        headers: response.headers, mimeType: response.mimeType, type
      });
    });
    client.on('Network.requestWillBeSent', ({ requestId: cdpRequestId, request, redirectResponse, type }, sessionId) => {
      const requestId = requestKey(sessionId, cdpRequestId);
      if (blockNoise && type !== 'Document' && isCaptureNoise(request?.url, type)) { noiseRequests.add(requestId); return; }
      if (!pendingRequests.has(requestId)) pendingRequests.set(requestId, Date.now()); lastNetworkActivity = Date.now();
      const urls = requestUrls.get(requestId) || new Set();
      if (request?.url) urls.add(request.url);
      requestUrls.set(requestId, urls);
      if (request?.method && request.method !== 'GET') {
        requestDetails.set(requestId, {
          method: request.method, cdpRequestId, sessionId, hasPostData: Boolean(request.hasPostData),
          postData: Array.isArray(request.postDataEntries) && request.postDataEntries.length
            ? Buffer.concat(request.postDataEntries.map((entry) => Buffer.from(entry.bytes || '', 'base64')))
            : typeof request.postData === 'string' ? Buffer.from(request.postData, 'utf8') : null,
          contentType: headerValue(request.headers, 'content-type')
        });
      }
      if (redirectResponse?.url && request?.url) redirects.push({
        url: redirectResponse.url, targetUrl: request.url, status: redirectResponse.status,
        headers: redirectResponse.headers || {}
      });
    });
    const readBody = (requestId, timeoutMs = 30000) => {
      const responseMeta = responses.get(requestId);
      if (!responseMeta || bodyReadAttempts.has(requestId)) return;
      bodyReadAttempts.add(requestId);
      if (responseMeta.status === 204 || responseMeta.status === 205 || responseMeta.status === 304 || responseMeta.type === 'Preflight' || responseMeta.type === 'Ping') {
        resourceBodies.set(requestId, Buffer.alloc(0));
        return;
      }
      const task = (async () => {
        try {
          const body = await client.send('Network.getResponseBody', { requestId: responseMeta.cdpRequestId || requestId }, timeoutMs, responseMeta.sessionId || null);
          const buffer = Buffer.from(body.body || '', body.base64Encoded ? 'base64' : 'utf8');
          if (!body.base64Encoded) transcodedBodies.add(requestId);
          if (!buffer.length) resourceBodies.set(requestId, buffer);
          else if (options.responseMaxBytes === null || buffer.length <= (options.responseMaxBytes || 256 * 1024 * 1024)) resourceBodies.set(requestId, buffer);
          else blocked.push({ url: responses.get(requestId)?.url, reason: '素材が1件の取得上限を超えています。' });
        } catch (error) {
          const response = responses.get(requestId);
          if (response?.type === 'Document' && !response.sessionId) {
            deferredDocuments.set(requestId, error);
            return;
          }
          if (response?.url && !/^(?:data:|blob:)/i.test(response.url)) {
            const unfinished = !finishedRequests.has(requestId);
            blocked.push({ url: response.url, reason: unfinished ? '素材本体を取得できません: 読み込みが終わる前にページの保存を終えました' : `素材本体を取得できません: ${error.message}` });
            if (unfinished) { unfinishedBodies += 1; return; }
            logEvent('warn', 'capture', 'resource.body.failed', {
              ...diagnostic, resourceUrl: safeUrl(response.url), code: 'BODY_READ_FAILED', resourceType: response.type, message: error.message
            });
          }
        }
      })();
      pendingBodyReads.add(task);
      task.finally(() => pendingBodyReads.delete(task));
    };
    client.on('Network.loadingFinished', ({ requestId: cdpRequestId }, sessionId) => {
      const requestId = requestKey(sessionId, cdpRequestId);
      if (noiseRequests.delete(requestId)) return;
      finishedRequests.add(requestId); pendingRequests.delete(requestId); lastNetworkActivity = Date.now(); readBody(requestId);
    });
    client.on('Network.loadingFailed', ({ requestId: cdpRequestId, errorText, canceled }, sessionId) => {
      const requestId = requestKey(sessionId, cdpRequestId);
      if (noiseRequests.delete(requestId)) return;
      pendingRequests.delete(requestId); lastNetworkActivity = Date.now();
      const response = responses.get(requestId);
      if (response?.url && !canceled) blocked.push({ url: response.url, reason: `素材の読み込みに失敗しました: ${errorText}` });
    });
    client.on('Target.attachedToTarget', ({ sessionId, targetInfo }) => {
      const kind = targetInfo?.type;
      const resume = () => client.send('Runtime.runIfWaitingForDebugger', {}, 10000, sessionId).catch(() => {});
      if (!['iframe', 'worker', 'shared_worker', 'service_worker'].includes(kind)) { resume(); return; }
      (async () => {
        try {
          await Promise.all([
            client.send('Network.enable', networkParams, 30000, sessionId),
            client.send('Network.setCacheDisabled', { cacheDisabled: options.disableBrowserCache !== false }, 30000, sessionId),
            kind === 'iframe' ? client.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, 30000, sessionId) : null,
            session.userAgent || options.mobile ? client.send('Network.setUserAgentOverride', userAgentOverride(session, options.mobile), 30000, sessionId).catch(() => {}) : null,
            kind === 'iframe' ? client.send('Page.enable', {}, 30000, sessionId) : null,
            kind === 'iframe' ? client.send('Page.addScriptToEvaluateOnNewDocument', { source: WEBAUTHN_GUARD_SOURCE }, 30000, sessionId).catch(() => {}) : null,
            kind === 'iframe' ? client.send('WebAuthn.enable', { enableUI: false }, 30000, sessionId).catch(() => {}) : null,
            kind === 'iframe' ? client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, 30000, sessionId) : null
          ]);
          if (kind === 'iframe') childFrames.set(sessionId, targetInfo.targetId);
          if (kind === 'iframe') attachedTargets.frames += 1; else attachedTargets.workers += 1;
        } catch (error) {
          if (kind !== 'iframe' && /Session with given id not found|No target with given id/i.test(error.message || '')) { logEvent('info', 'capture', 'target.ended.early', { ...diagnostic, pageUrl: safeUrl(url), targetType: kind }); return; }
          attachedTargets.failed += 1;
          logEvent('warn', 'capture', 'target.attach.failed', { ...diagnostic, pageUrl: safeUrl(url), targetType: kind, message: error.message });
        } finally { resume(); }
      })();
    });
    await client.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
    client.on('Page.javascriptDialogOpening', ({ type }) => {
      client.send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }).catch(() => {});
    });
    const loadWaitMs = Math.max(1000, Math.min(captureTimeoutMs, Number(options.loadWaitMs ?? 30000)));
    const loaded = new Promise((resolve) => {
      const timer = setTimeout(resolve, loadWaitMs);
      const off = client.on('Page.loadEventFired', () => { clearTimeout(timer); off(); resolve(); });
    });
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `${WEBAUTHN_GUARD_SOURCE}(${installFontCapture.toString()})();(${installShadowCapture.toString()})();${options.preserveCanvas === false ? '' : `(${installCanvasPreservation.toString()})();`}${options.deterministicRandom === false ? '' : `(${installSeededRandom.toString()})(${pageSeed(url)});`}`
    });
    live.phase('loading');
    const navigation = await client.send('Page.navigate', { url });
    const mainDocument = [...responses.values()].find((item) => item.type === 'Document' && !item.sessionId);
    if (mainDocument && mainDocument.status < 400 && mainDocument.mimeType && !/html|xml|svg|^text\//i.test(mainDocument.mimeType)) {
      const fileError = new Error('ページではなくファイルのため、ファイルとして保存します。');
      fileError.code = 'NON_HTML_DOCUMENT';
      fileError.mimeType = mainDocument.mimeType || '';
      throw fileError;
    }
    if (navigation?.errorText && navigation.errorText !== 'net::ERR_ABORTED') {
      const failure = new Error(`ページを開けませんでした: ${navigation.errorText}`);
      failure.code = 'PAGE_NAVIGATION_FAILED';
      throw failure;
    }
    if (navigation?.errorText) blocked.push({ url, reason: `ページの読み込みが中断されました: ${navigation.errorText}` });
    const timings = {};
    let stageStartedAt = Date.now();
    const nextLivePhase = { loadMs: 'preparing', preparationMs: 'settling', networkIdleMs: 'serializing', serializeMs: 'screenshot', screenshotMs: 'interacting', interactionMs: 'reading' };
    const stage = (name) => { const now = Date.now(); timings[name] = now - stageStartedAt; stageStartedAt = now; if (nextLivePhase[name]) live.phase(nextLivePhase[name]); };
    await loaded;
    stage('loadMs');
    if (typeof options.acceptDocumentUrl === 'function') {
      let documentUrl = '';
      try { documentUrl = String((await client.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, 5000))?.result?.value || ''); } catch {}
      if (/^https?:/i.test(documentUrl) && !options.acceptDocumentUrl(documentUrl)) {
        const outOfScope = new Error(`転送先が保存範囲外のため保存しません: ${documentUrl}`);
        outOfScope.code = 'OUT_OF_SCOPE_REDIRECT';
        outOfScope.finalUrl = documentUrl;
        throw outOfScope;
      }
    }
    if (options.initialWaitMs > 0) await delay(options.initialWaitMs);
    const scrollContainerLimit = options.maxScrollContainers ?? Number.MAX_SAFE_INTEGER;
    const scrollStepLimit = options.maxScrollStepsPerContainer ?? Number.MAX_SAFE_INTEGER;
    const srcsetLimit = options.maxSrcsetCandidates ?? Number.MAX_SAFE_INTEGER;
    const linkLimit = options.maxLinksPerPage ?? Number.MAX_SAFE_INTEGER;
    const preparationDeadlineMs = Math.max(1000, remainingMs());
    let preservation;
    try {
      preservation = extractResult(await client.send('Runtime.evaluate', {
      expression: `(async () => {
        const __svDeadline=Date.now()+${preparationDeadlineMs};
        const report={canvasCaptured:0,canvasFailed:0,canvasBlank:0,skippedSensitiveForms:0};
        document.querySelectorAll('img[loading="lazy"],iframe[loading="lazy"]').forEach(e => e.setAttribute('loading', 'eager'));
        if(${options.scrollEnabled !== false}){
          const scrolling=[document.scrollingElement,...[...document.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return r.width>0&&r.height>=80&&e.scrollHeight>e.clientHeight+20&&/(auto|scroll)/.test(s.overflowY)})]
            .filter((e,index,list)=>e&&list.indexOf(e)===index).sort((a,b)=>b.scrollHeight-a.scrollHeight).slice(0,${scrollContainerLimit});
          for(const area of scrolling){if(Date.now()>=__svDeadline)break;let steps=0,stableEnd=0,noProgress=0;while(steps<${scrollStepLimit}&&Date.now()<__svDeadline){const before=area.scrollHeight,beforeTop=area.scrollTop,maxY=Math.max(0,before-area.clientHeight),step=Math.max(200,Math.floor(area.clientHeight*${options.scrollStepRatio || 0.75}));area.scrollTo(0,Math.min(maxY,beforeTop+step));await new Promise(r=>setTimeout(r,${options.scrollDelayMs ?? 120}));steps++;if(Math.abs(area.scrollTop-beforeTop)<1&&area.scrollHeight<=before+2)noProgress++;else noProgress=0;if(noProgress>=2)break;if(area.scrollTop>=maxY-2){if(area.scrollHeight<=before+2)stableEnd++;else stableEnd=0;if(stableEnd>=2)break}}area.scrollTo(0,0)}
        }
        if(${options.captureSrcsetCandidates === true}){
          const parseSrcset=${parseSrcset.toString()};
          const candidates=[];
          for(const e of document.querySelectorAll('img,source'))for(const name of ${JSON.stringify(IMAGE_SOURCE_ATTRIBUTES)}){const value=e.getAttribute(name);if(!value)continue;try{const candidate=new URL(value,document.baseURI).href;if(/^https?:/i.test(candidate)&&!candidates.includes(candidate))candidates.push(candidate)}catch{}}
          for(const e of document.querySelectorAll('img[srcset],img[data-srcset],source[srcset],source[data-srcset]')){
            for(const {url} of parseSrcset(e.getAttribute('srcset')||e.getAttribute('data-srcset')||'')){
              try{const candidate=new URL(url,location.href).href;if(/^https?:/i.test(candidate)&&!candidates.includes(candidate))candidates.push(candidate)}catch{}
              if(candidates.length>=${srcsetLimit})break;
            }
            if(candidates.length>=${srcsetLimit})break;
          }
          await Promise.allSettled(candidates.map(src=>new Promise(resolve=>{const img=new Image();img.hidden=true;img.dataset.webcapturePreload='';document.documentElement.append(img);const done=()=>{img.remove();resolve()};img.onload=done;img.onerror=done;img.src=src;setTimeout(done,Math.min(${options.imageWaitMs ?? 5000},10000))})));
        }
        await Promise.race([Promise.all([...document.images].map(img => img.decode ? img.decode().catch(()=>{}) : Promise.resolve())),new Promise(r=>setTimeout(r,${options.imageWaitMs ?? 5000}))]);
        document.querySelectorAll('img').forEach(e=>{
          const current=e.currentSrc||e.src;
          if(current&&/^(?:https?:)?\\/\\//i.test(current)){e.dataset.webcaptureCurrentSrc=current;if(${options.freezeResponsiveImages === true})e.setAttribute('src',current)}
          if(${options.freezeResponsiveImages === true}){e.removeAttribute('srcset');e.removeAttribute('sizes');e.removeAttribute('data-srcset');e.removeAttribute('data-sizes');e.closest('picture')?.querySelectorAll('source').forEach(source=>{source.removeAttribute('srcset');source.removeAttribute('sizes');source.removeAttribute('data-srcset')})}
        });
        document.querySelectorAll('video,audio').forEach(e=>{const current=e.currentSrc||e.src;if(current&&/^(?:https?:)?\\/\\//i.test(current))e.setAttribute('src',current)});
        if(${options.preserveFormState !== false})document.querySelectorAll('input,textarea,select').forEach(e=>{
          if(e instanceof HTMLInputElement&&['password','file'].includes(e.type)){report.skippedSensitiveForms++;return}
          if(e instanceof HTMLTextAreaElement)e.textContent=e.value;
          else if('value' in e)e.setAttribute('value',e.value);
          if('checked' in e)e.toggleAttribute('checked',e.checked);
          if(e.tagName==='SELECT')[...e.options].forEach(o=>o.toggleAttribute('selected',o.selected));
        });
        if(${options.preserveCanvas !== false})document.querySelectorAll('canvas').forEach(e=>{try{const image=e.toDataURL('image/png');const blank=document.createElement('canvas');blank.width=e.width;blank.height=e.height;if(e.width&&e.height&&image===blank.toDataURL('image/png')){report.canvasBlank++;return}e.dataset.webcaptureCanvas=image;report.canvasCaptured++}catch{report.canvasFailed++}});
        return report;
      })()`,
      awaitPromise: true, returnByValue: true
      }, null));
    } catch (error) {
      preservation = { canvasCaptured: 0, canvasFailed: 0, skippedSensitiveForms: 0, preparationError: error.message };
      blocked.push({ url, reason: `保存前のページ準備を完了できません: ${error.message}` });
      logEvent('warn', 'capture', 'page.preparation.failed', {
        ...diagnostic, pageUrl: safeUrl(url), code: error.code || 'PAGE_PREPARATION_FAILED', message: error.message
      });
    }
    stage('preparationMs');
    const idleDeadline = Date.now() + Math.min(remainingMs(), options.networkIdleMaxMs ?? 15000);
    while (!timedOut && Date.now() < idleDeadline && networkBusy()) await delay(100);
    await Promise.allSettled([...pendingBodyReads]);
    if (preservation?.canvasFailed) blocked.push({ url, reason: `${preservation.canvasFailed}件のCanvasを画像化できませんでした（WebGLまたは保護された素材の可能性）。` });
    stage('networkIdleMs');
    let state;
    try {
      state = extractResult(await client.send('Runtime.evaluate', {
      expression: `(() => {
        const injected=[];
        const fontSnapshot=(${capturedFontCss.toString()})();
        if(fontSnapshot.css){const style=document.createElement('style');style.dataset.webcaptureFonts='';style.textContent=fontSnapshot.css;document.head.append(style);injected.push(style)}
        const adoptedDocument=(${adoptedDocumentCss.toString()})();
        if(adoptedDocument){const style=document.createElement('style');style.dataset.webcaptureAdoptedDocument='';style.textContent=adoptedDocument;document.head.append(style);injected.push(style)}
        if(${options.preserveShadowDom !== false})for(const root of (${capturedShadowRoots.toString()})()){
          const host=root.host;
          if(!host||host.querySelector(':scope > template[shadowrootmode]'))continue;
          const template=document.createElement('template');
          template.setAttribute('shadowrootmode',root.mode==='closed'?'closed':'open');
          if(root.delegatesFocus)template.setAttribute('shadowrootdelegatesfocus','');
          if(root.clonable)template.setAttribute('shadowrootclonable','');
          if(root.serializable)template.setAttribute('shadowrootserializable','');
          template.innerHTML=root.innerHTML;
          for(const sheet of root.adoptedStyleSheets||[]){try{const style=document.createElement('style');style.dataset.webcaptureAdopted='';style.textContent=[...sheet.cssRules].map(rule=>rule.cssText).join('\\n');template.content.prepend(style)}catch{}}
          host.prepend(template);injected.push(template);
        }
        const clone=document.documentElement.cloneNode(true),clonedStyles=[...clone.querySelectorAll('style:not([data-webcapture-fonts])')];
        document.querySelectorAll('style:not([data-webcapture-fonts])').forEach((style,index)=>{try{const css=[...style.sheet.cssRules].map(rule=>rule.cssText).join('\\n');if(clonedStyles[index])clonedStyles[index].textContent=css}catch{}});
        const html='<!doctype html>\\n'+clone.outerHTML;
        injected.forEach(template=>template.remove());
        const linkRoots=[document,...(${capturedShadowRoots.toString()})()];
        for(const frame of document.querySelectorAll('iframe,frame')){try{const inner=frame.contentDocument;if(inner&&inner.location.origin===location.origin)linkRoots.push(inner)}catch{}}
        const anchors=[...new Set(linkRoots.flatMap(root=>[...root.querySelectorAll('a[href],area[href]')]))];
        const links=anchors.map(a => ({ url: a.href, text: (a.textContent || '').trim().slice(0, 120) })).concat(linkRoots.flatMap(root=>[...root.querySelectorAll('form[method="get" i],form:not([method])')]).map(f=>({url:f.action||location.href,text:''})));
        return { html, title: document.title, url: location.href, links: links.slice(0,${linkLimit}), capturedFontFaces:fontSnapshot.count };
      })()`,
      returnByValue: true
      }, finalizeBudgetMs()));
    } catch (error) {
      state = await captureFallbackState(client, url, finalizeBudgetMs()).catch(() => null);
      if (!state) throw error;
      blocked.push({ url: state.url || url, reason: `描画後の書き出しに失敗したため、その時点のページ内容だけを保存しました: ${error.message}` });
      logEvent('warn', 'capture', 'page.serialize.fallback', {
        ...diagnostic, pageUrl: safeUrl(state.url || url), code: error.code || 'PAGE_SERIALIZE_FAILED', message: error.message
      });
    }
    stage('serializeMs');
    let screenshot = null;
    let screenshotPreservation = null;
    if (options.screenshotMode !== 'none' && timedOut) {
      blocked.push({ url: state.url || url, reason: 'ページ全体の保存が時間切れのため、スクリーンショットは保存していません。' });
    }
    if (options.screenshotMode !== 'none' && !timedOut) {
      try {
        const fullPage = options.screenshotMode === 'full-page';
        await live.pause();
        if (fullPage) screenshotPreservation = await prepareFullPageScreenshot(client);
        const metrics = fullPage ? await client.send('Page.getLayoutMetrics') : null;
        const content = metrics?.cssContentSize || metrics?.contentSize;
        screenshot = await client.send('Page.captureScreenshot', {
          format: 'png', captureBeyondViewport: fullPage, fromSurface: true,
          ...(fullPage && content ? { clip: { x: 0, y: 0, width: Math.max(1, Math.ceil(content.width)), height: Math.max(1, Math.ceil(content.height)), scale: 1 } } : {})
        }, Math.max(120000, finalizeBudgetMs()));
      } catch (error) {
        blocked.push({ url: state.url || url, reason: `スクリーンショットを保存できません: ${error.message}` });
        logEvent('warn', 'capture', 'screenshot.failed', { ...diagnostic, code: error.code || 'SCREENSHOT_FAILED', message: error.message });
      } finally {
        if (options.screenshotMode === 'full-page') await restoreFullPageScreenshot(client);
        live.resume();
      }
    }
    stage('screenshotMs');
    let interactions = null;
    if (options.interactDuringCapture !== false && !timedOut) {
      const unlimitedInteractions = options.maxInteractionsPerPage === null;
      const interactionDeadlineMs = Math.max(1000, unlimitedInteractions ? remainingMs() : Math.min(remainingMs(), options.interactionMaxMs ?? 60000));
      try {
        interactions = extractResult(await client.send('Runtime.evaluate', {
          expression: safeInteractionExpression({
            limit: unlimitedInteractions ? null : (options.maxInteractionsPerPage ?? 250),
            representative: options.interactionMode === 'representative',
            settleMs: options.interactionSettleMs ?? 120,
            deadlineMs: interactionDeadlineMs
          }),
          awaitPromise: true, returnByValue: true
        }, interactionDeadlineMs + finalizeGraceMs));
        const interactionIdleDeadline = Date.now() + Math.min(Math.max(remainingMs(), 5000), options.networkIdleMaxMs ?? 15000);
        while (Date.now() < interactionIdleDeadline && networkBusy()) await delay(100);
        logEvent('info', 'capture', 'page.interactions.completed', {
          ...diagnostic, pageUrl: safeUrl(state.url || url), tested: interactions?.testedCount || 0,
          changed: interactions?.changedCount || 0, skipped: interactions?.skippedCount || 0,
          errors: interactions?.errorCount || 0, limitReached: Boolean(interactions?.limitReached)
        });
      } catch (error) {
        blocked.push({ url: state.url || url, reason: `保存中の安全な操作を完了できません: ${error.message}` });
        logEvent('warn', 'capture', 'page.interactions.failed', {
          ...diagnostic, pageUrl: safeUrl(state.url || url), code: error.code || 'PAGE_INTERACTION_FAILED', message: error.message
        });
      }
    }
    let hovers = null;
    if (options.hoverDuringCapture !== false && !timedOut) {
      try { hovers = await hoverMenus(client, { limit: options.maxHoversPerPage ?? 80, settleMs: options.interactionSettleMs ?? 120, deadline: Date.now() + Math.max(1000, Math.min(remainingMs(), options.hoverMaxMs ?? 30000)) }); }
      catch (error) { logEvent('warn', 'capture', 'page.hover.failed', { ...diagnostic, pageUrl: safeUrl(state.url || url), message: error.message }); }
      if (hovers?.hovered) {
        const hoverIdleDeadline = Date.now() + Math.min(Math.max(remainingMs(), 3000), options.networkIdleMaxMs ?? 15000);
        while (Date.now() < hoverIdleDeadline && networkBusy()) await delay(100);
      }
    }
    stage('interactionMs');
    if (options.freezeAfterCapture !== false) {
      await live.pause();
      await client.send('Page.setWebLifecycleState', { state: 'frozen' }, 5000).catch(() => {});
    }
    const resources = [];
    for (const response of responses.values()) readBody(response.requestId, finishedRequests.has(response.requestId) ? 30000 : 2000);
    await Promise.allSettled([...pendingBodyReads]);
    if (unfinishedBodies) logEvent('info', 'capture', 'resource.body.unfinished', { ...diagnostic, pageUrl: safeUrl(url), count: unfinishedBodies });
    for (const [requestId, firstError] of deferredDocuments) {
      const response = responses.get(requestId);
      let recovered = null;
      for (const [sessionId, frameId] of childFrames) {
        try {
          const body = await client.send('Network.getResponseBody', { requestId: response.cdpRequestId }, 10000, sessionId);
          recovered = { buffer: Buffer.from(body.body || '', body.base64Encoded ? 'base64' : 'utf8'), transcoded: !body.base64Encoded };
        } catch {
          try {
            const content = await client.send('Page.getResourceContent', { frameId, url: response.url }, 10000, sessionId);
            recovered = { buffer: Buffer.from(content.content || '', content.base64Encoded ? 'base64' : 'utf8'), transcoded: !content.base64Encoded };
          } catch {}
        }
        if (recovered?.buffer.length) break;
        recovered = null;
      }
      if (recovered) {
        resourceBodies.set(requestId, recovered.buffer);
        if (recovered.transcoded) transcodedBodies.add(requestId);
        logEvent('info', 'capture', 'resource.body.recovered', { ...diagnostic, resourceUrl: safeUrl(response.url), resourceType: response.type, source: 'child-frame' });
      } else if (response?.url && !/^(?:data:|blob:)/i.test(response.url)) {
        blocked.push({ url: response.url, reason: `素材本体を取得できません: ${firstError.message}` });
        logEvent('warn', 'capture', 'resource.body.failed', {
          ...diagnostic, resourceUrl: safeUrl(response.url), code: 'BODY_READ_FAILED', resourceType: response.type, message: firstError.message
        });
      }
    }
    const responseList = [...responses.values()];
    const selectedResponses = options.maxResourcesPerPage === null ? responseList : responseList.slice(0, options.maxResourcesPerPage || 5000);
    for (const response of selectedResponses) {
      const buffer = resourceBodies.get(response.requestId);
      const body = buffer || Buffer.alloc(0);
      const declaredType = headerValue(response.headers, 'content-type') || response.mimeType || '';
      const bodyCharset = transcodedBodies.has(response.requestId)
        ? 'utf-8'
        : isTextualType(declaredType) || isTextualType(response.mimeType) ? detectCharset({ contentType: declaredType, body }) : null;
      const detail = requestDetails.get(response.requestId);
      let request = {};
      if (detail?.method === 'POST') {
        let requestBody = detail.postData;
        if (!requestBody && detail.hasPostData) {
          try {
            const data = await client.send('Network.getRequestPostData', { requestId: detail.cdpRequestId }, 10000, detail.sessionId);
            requestBody = Buffer.from(data.postData || '', data.base64Encoded ? 'base64' : 'utf8');
          } catch { requestBody = null; }
        }
        request = { method: 'POST', requestBody: requestBody || Buffer.alloc(0), requestBodyUnavailable: !requestBody && detail.hasPostData, requestContentType: detail.contentType };
      }
      resources.push({
        ...response, bodyCharset, body, ...request,
        aliases: [...(requestUrls.get(response.requestId) || [])].filter((url) => url !== response.url)
      });
    }
    stage('bodyReadMs');
    if (options.signal?.aborted) throw Object.assign(new Error('保存を中止しました。'), { code: 'CAPTURE_ABORTED' });
    timings.totalMs = Date.now() - captureDeadline + captureTimeoutMs;
    logEvent('info', 'capture', 'page.completed', {
      ...diagnostic, pageUrl: safeUrl(state.url || url), resourceCount: resources.length,
      responseCount: responses.size, blockedCount: blocked.length, htmlBytes: Buffer.byteLength(state.html || ''), capturedFontFaces: state.capturedFontFaces || 0,
      partial: timedOut, ...timings
    });
    preservation.capturedFontFaces = state.capturedFontFaces || 0;
    if (screenshotPreservation) preservation.fullPageScreenshot = screenshotPreservation;
    if (interactions) preservation.interactions = {
      testedCount: interactions.testedCount || 0, changedCount: interactions.changedCount || 0,
      skippedCount: interactions.skippedCount || 0, transientCount: interactions.transientCount || 0,
      errorCount: interactions.errorCount || 0, limitReached: Boolean(interactions.limitReached),
      ...(interactions.representative ? { representative: true, representativeSkipped: interactions.representativeSkipped || 0 } : {})
    };
    if (state.serializeFallback) preservation.serializeFallback = true;
    if (hovers) preservation.hovers = hovers;
    if (preservation.canvasBlank) blocked.push({ url: state.url || url, reason: `${preservation.canvasBlank}件のCanvasは保存時点で何も描かれていませんでした。` });
    preservation.timings = timings;
    if (attachedTargets.frames || attachedTargets.workers || attachedTargets.failed) preservation.attachedTargets = { ...attachedTargets };
    if (noiseBlockedCount) preservation.blockedNoiseCount = noiseBlockedCount;
    if (timedOut) {
      preservation.partialCapture = true;
      blocked.push({ url: state.url || url, reason: `ページ全体の保存が${Math.ceil(captureTimeoutMs / 1000)}秒を超えたため、その時点までの内容を保存しました。` });
    }
    return {
      ...state, resources, redirects, preservation, blocked, partial: timedOut,
      screenshot: screenshot ? Buffer.from(screenshot.data, 'base64') : null, engine: path.basename(executable),
      ...(options.mobile ? { userAgent: mobileBrowserIdentity(session).userAgent, viewport: { ...MOBILE_CAPTURE_VIEWPORT } } : {})
    };
  } finally {
    clearTimeout(hardTimeout);
    clearTimeout(finalizeTimeout);
    options.signal?.removeEventListener('abort', abort);
    live?.stop();
    client?.close();
    if (!ownedSession && target?.id) await fetch(`http://127.0.0.1:${port}/json/close/${encodeURIComponent(target.id)}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
    if (ownedSession) await session.close();
  }
}

export function regularBrowserIdentity(version, executable = '') {
  const reported = String(version?.['User-Agent'] || '');
  if (!reported) return {};
  const userAgent = reported.replace(/HeadlessChrome\//g, 'Chrome/');
  const fullVersion = (/Chrome\/([\d.]+)/.exec(userAgent) || [])[1] || '';
  const major = fullVersion.split('.')[0] || '';
  const edge = /msedge/i.test(path.basename(executable || ''));
  const productBrand = edge ? 'Microsoft Edge' : 'Google Chrome';
  const brands = [{ brand: 'Chromium', version: major }, { brand: productBrand, version: major }, { brand: 'Not.A/Brand', version: '99' }];
  return {
    userAgent: edge && !/Edg\//.test(userAgent) ? `${userAgent} Edg/${fullVersion}` : userAgent,
    userAgentMetadata: {
      brands, fullVersionList: brands.map((item) => ({ brand: item.brand, version: item.brand === 'Not.A/Brand' ? '99.0.0.0' : fullVersion })),
      fullVersion, platform: 'Windows', platformVersion: '15.0.0', architecture: 'x86', model: '', mobile: false, bitness: '64', wow64: false
    }
  };
}

export const MOBILE_CAPTURE_VIEWPORT = Object.freeze({ width: 390, height: 844, deviceScaleFactor: 2 });

export function mobileBrowserIdentity(session = {}) {
  const base = String(session.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36');
  const userAgent = base.replace(/\([^)]*\)/, '(Linux; Android 10; K)').replace(/ Edg\/[\d.]+/, '').replace(/(Chrome\/[\d.]+) (?:Mobile )?Safari/, '$1 Mobile Safari');
  const metadata = session.userAgentMetadata || {};
  return {
    userAgent,
    userAgentMetadata: { ...metadata, platform: 'Android', platformVersion: '10.0.0', architecture: '', model: 'K', mobile: true, bitness: '', wow64: false }
  };
}

function userAgentOverride(session, mobile = false) {
  if (mobile) {
    const identity = mobileBrowserIdentity(session);
    return { userAgent: identity.userAgent, acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7', platform: 'Linux armv8l', userAgentMetadata: identity.userAgentMetadata };
  }
  return { userAgent: session.userAgent, acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7', platform: 'Win32', userAgentMetadata: session.userAgentMetadata };
}

async function launchBrowserProcess(executable, options, proxy) {
  const port = await freePort();
  const profile = options.userDataDir || await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-browser-'));
  const keepProfile = Boolean(options.userDataDir);
  const diagnostics = { stderr: '', spawnError: null };
  const startedAt = Date.now();
  let handle = null;
  try {
    if (!keepProfile && typeof options.prepareProfile === 'function') await options.prepareProfile(profile);
    handle = childProcess.spawn(executable, [
      ...platformBrowserArgs(), '--headless=new', '--disable-gpu', '--disable-background-networking', '--disable-component-update',
      '--disable-default-apps', '--disable-extensions', '--disable-sync', '--metrics-recording-only',
      '--no-first-run', '--no-default-browser-check', '--password-store=basic', '--use-mock-keychain',
      '--disable-features=MediaRouter,OptimizationHints,Translate', '--disable-blink-features=AutomationControlled', `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`, `--proxy-server=http://127.0.0.1:${proxy.port}`, '--proxy-bypass-list=<-loopback>',
      `--window-size=${options.viewportWidth || 1440},${options.viewportHeight || 1000}`, 'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    handle.on('error', (error) => { diagnostics.spawnError = error; });
    handle.stderr?.on('data', (chunk) => { diagnostics.stderr = (diagnostics.stderr + String(chunk)).slice(-8000); });
    await waitForDebugger(port, handle, diagnostics);
    return { handle, port, profile, keepProfile };
  } catch (error) {
    const exitedEarly = Boolean(handle) && (handle.exitCode !== null || handle.signalCode !== null);
    const pendingUpdate = exitedEarly ? await pendingBrowserUpdate(executable) : false;
    logEvent('error', 'capture', 'browser.start.failed', {
      code: error.code || 'BROWSER_START_FAILED', message: error.message, stderr: diagnostics.stderr,
      browser: path.basename(executable), exitCode: handle?.exitCode ?? null, signal: handle?.signalCode ?? null,
      elapsedMs: Date.now() - startedAt, pendingUpdate
    });
    if (handle) await terminateBrowser(handle);
    if (!keepProfile) await fs.rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    throw Object.assign(error, { code: error.code || 'BROWSER_START_FAILED', browser: path.basename(executable), exitedEarly, pendingUpdate });
  }
}

function browserStartError(failures) {
  const updating = failures.find((item) => item.pendingUpdate);
  const names = [...new Set(failures.map((item) => item.browser).filter(Boolean))].join('・');
  const hint = updating
    ? 'Chromeの更新が途中で止まっている可能性があります。Chromeを開いて「設定」→「Chromeについて」で更新を完了し、Chromeを再起動してから保存し直してください。'
    : 'ChromeまたはEdgeを一度開いて正常に動くか確認し、パソコンを再起動してから保存し直してください。';
  const error = new Error(`ブラウザ（${names || 'Chrome・Edge'}）を起動できませんでした。${hint}`);
  error.code = 'BROWSER_START_FAILED';
  error.cause = failures[failures.length - 1];
  return error;
}

export async function createBrowserCaptureSession(options = {}) {
  const preferred = options.executable || await findBrowser();
  if (!preferred) throw new Error('ChromeまたはEdgeが見つかりません。');
  const proxy = await createPolicyProxy({ policyOptions: options.policyOptions });
  const order = options.userDataDir ? [preferred] : browserStartOrder(preferred, await findBrowsers());
  const failures = [];
  let launched = null;
  let executable = preferred;
  for (const [index, candidate] of order.entries()) {
    if (index > 0 && candidate === order[index - 1] && !failures[failures.length - 1]?.exitedEarly) continue;
    if (index > 0) await delay(candidate === order[index - 1] ? 2000 : 200);
    try {
      launched = await launchBrowserProcess(candidate, options, proxy);
      executable = candidate;
      if (failures.length) logEvent('warn', 'capture', 'browser.start.recovered', { browser: path.basename(candidate), attempts: failures.length + 1 });
      break;
    } catch (error) {
      failures.push(error);
      noteBrowserStartFailure(candidate);
    }
  }
  if (!launched) {
    await proxy.close().catch(() => {});
    throw browserStartError(failures);
  }
  browserStartFailures.delete(executable);
  const { handle, port, profile, keepProfile } = launched;
  const identity = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) }).then((response) => response.json()).catch(() => null);
  const browserIdentity = regularBrowserIdentity(identity, executable);
  let closed = false;
  let unhealthy = false;
  let browserClient = null;
  const connectBrowser = () => {
    browserClient ||= fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(5000) })
      .then((response) => response.json())
      .then((version) => new CdpClient(version.webSocketDebuggerUrl).connect())
      .catch((error) => { browserClient = null; throw error; });
    return browserClient;
  };
  return {
    executable, proxy, port, profile, handle, ...browserIdentity,
    get alive() {
      return !closed && !unhealthy && handle.exitCode === null && handle.signalCode === null;
    },
    markUnhealthy() {
      unhealthy = true;
    },
    async openPage() {
      const client = await connectBrowser();
      try {
        const { targetId } = await client.send('Target.createTarget', { url: 'about:blank', newWindow: true }, 10000);
        return { id: targetId, type: 'page', webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/${targetId}` };
      } catch (error) {
        client.close();
        browserClient = null;
        throw error;
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      const client = await Promise.resolve(browserClient).catch(() => null);
      await terminateBrowser(handle, { graceful: client ? () => client.send('Browser.close', {}, 3000) : null });
      client?.close();
      await proxy.close().catch(() => {});
      if (!keepProfile) await removeProfileLater(profile);
    }
  };
}

export async function cleanupStaleBrowserProfiles({ olderThanMs = 30 * 60 * 1000, root = os.tmpdir() } = {}) {
  let removed = 0;
  let entries = [];
  try { entries = await fs.readdir(root, { withFileTypes: true }); } catch { return removed; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^(?:webcapture|sitevault)-browser-[A-Za-z0-9]+$/.test(entry.name)) continue;
    const folder = path.join(root, entry.name);
    try {
      const stat = await fs.stat(folder);
      if (Date.now() - stat.mtimeMs < olderThanMs) continue;
      await fs.rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      removed += 1;
    } catch {}
  }
  if (removed) logEvent('info', 'capture', 'browser.profiles.cleaned', { removed });
  return removed;
}
