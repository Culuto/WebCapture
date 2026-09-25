import { CdpClient } from './browser-capture.mjs';
import { openCaptureTarget } from './browser-live.mjs';
import { installShadowCapture, capturedShadowRoots } from './browser-shadow.mjs';
import { WEBAUTHN_GUARD_SOURCE } from './webauthn-guard.mjs';

const HEAVY_RESOURCES = Object.freeze(['*.png', '*.jpg', '*.jpeg', '*.gif', '*.webp', '*.avif', '*.svg', '*.ico', '*.bmp', '*.mp4', '*.webm', '*.m4s', '*.m3u8', '*.mpd', '*.ts', '*.mp3', '*.m4a', '*.woff', '*.woff2', '*.ttf', '*.otf']);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function linkExpression(limit) {
  return `(() => {
    const roots = [document, ...(${capturedShadowRoots.toString()})()];
    for (const frame of document.querySelectorAll('iframe,frame')) { try { const inner = frame.contentDocument; if (inner && inner.location.origin === location.origin) roots.push(inner); } catch {} }
    const links = [];
    const seen = new Set();
    for (const root of roots) {
      for (const anchor of root.querySelectorAll('a[href],area[href]')) {
        const href = anchor.href;
        if (!href || seen.has(href)) continue;
        seen.add(href);
        links.push(href);
        if (links.length >= ${Math.max(1, Number(limit) || 5000)}) break;
      }
    }
    return { url: location.href, title: document.title, links, html: document.documentElement.outerHTML.slice(0, 200000) };
  })()`;
}

export async function discoverWithBrowser(url, { session, timeoutMs = 30000, settleMs = 800, maxLinks = 5000, signal = null } = {}) {
  if (!session) throw new Error('把握用のブラウザがありません。');
  if (signal?.aborted) throw new Error('保存を中止しました。');
  const target = await openCaptureTarget(session);
  let client;
  const abort = () => client?.close(new Error('保存を中止しました。'));
  signal?.addEventListener('abort', abort, { once: true });
  try {
    client = await new CdpClient(target.webSocketDebuggerUrl).connect();
    let documentStatus = null;
    client.on('Network.responseReceived', ({ type, response, frameId }) => {
      if (type === 'Document' && documentStatus === null) documentStatus = Number(response?.status) || null;
    });
    await Promise.all([
      client.send('Page.enable'), client.send('Runtime.enable'), client.send('Network.enable'),
      client.send('Network.setBlockedURLs', { urls: [...HEAVY_RESOURCES] }).catch(() => {}),
      client.send('WebAuthn.enable', { enableUI: false }).catch(() => {}),
      session.userAgent ? client.send('Network.setUserAgentOverride', { userAgent: session.userAgent, acceptLanguage: 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7', platform: 'Win32', userAgentMetadata: session.userAgentMetadata }).catch(() => {}) : null,
      client.send('Page.addScriptToEvaluateOnNewDocument', { source: `${WEBAUTHN_GUARD_SOURCE}(${installShadowCapture.toString()})();` })
    ]);
    client.on('Page.javascriptDialogOpening', ({ type }) => { client.send('Page.handleJavaScriptDialog', { accept: type === 'beforeunload' }).catch(() => {}); });
    const loaded = new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(1000, timeoutMs));
      const off = client.on('Page.loadEventFired', () => { clearTimeout(timer); off(); resolve(); });
    });
    const navigation = await client.send('Page.navigate', { url }, Math.max(5000, timeoutMs));
    if (navigation?.errorText && navigation.errorText !== 'net::ERR_ABORTED') {
      const failure = new Error(`ページを開けませんでした: ${navigation.errorText}`);
      failure.code = 'PAGE_NAVIGATION_FAILED';
      throw failure;
    }
    await loaded;
    await delay(Math.max(0, settleMs));
    const evaluated = await client.send('Runtime.evaluate', { expression: linkExpression(maxLinks), returnByValue: true }, Math.max(5000, timeoutMs));
    const value = evaluated?.result?.value || {};
    return { finalUrl: value.url || url, title: value.title || '', links: Array.isArray(value.links) ? value.links : [], html: value.html || '', status: documentStatus || 200 };
  } finally {
    signal?.removeEventListener('abort', abort);
    client?.close();
    if (target?.id) await fetch(`http://127.0.0.1:${session.port}/json/close/${encodeURIComponent(target.id)}`, { signal: AbortSignal.timeout(2000) }).catch(() => {});
  }
}
