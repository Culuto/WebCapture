import { createLocalAuditBrowser, captureFullPage } from './replay-auditor.mjs';
import { navigateAndSettle } from './browser-page.mjs';
import { logEvent, safeUrl } from './logger.mjs';

export const MOBILE_VIEWPORT = Object.freeze({ width: 390, height: 844, deviceScaleFactor: 2 });
const SCROLL_THROUGH = `(async () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const root = document.scrollingElement || document.documentElement;
  const maximum = Math.min(Math.max(0, root.scrollHeight - innerHeight), 16000);
  for (let y = 0; y <= maximum; y += Math.max(300, Math.floor(innerHeight * 0.8))) { scrollTo(0, y); await wait(60); }
  scrollTo(0, 0);
  await Promise.race([Promise.allSettled([...document.images].filter((image) => !image.complete).map((image) => new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); }))), wait(4000)]);
  if (document.fonts) await Promise.race([document.fonts.ready.catch(() => {}), wait(3000)]);
  return true;
})()`;

let queue = Promise.resolve();

export function exportReplayPage({ archiveId, pageUrl, format = 'png', view = 'desktop', config, browserFactory = createLocalAuditBrowser }) {
  const run = queue.then(async () => {
    const mobile = view === 'mobile';
    const session = await browserFactory({ viewportWidth: mobile ? MOBILE_VIEWPORT.width : 1440, viewportHeight: mobile ? MOBILE_VIEWPORT.height : 1000 });
    try {
      const { client } = session;
      if (mobile) await client.send('Emulation.setDeviceMetricsOverride', { width: MOBILE_VIEWPORT.width, height: MOBILE_VIEWPORT.height, deviceScaleFactor: MOBILE_VIEWPORT.deviceScaleFactor, mobile: true });
      const target = `http://${config.host}:${config.replayPort}/archive/${encodeURIComponent(archiveId)}/page?url=${encodeURIComponent(pageUrl)}${mobile ? '&view=mobile' : ''}`;
      await navigateAndSettle(client, target, { timeoutMs: 30000, settleMs: 1500 });
      await client.send('Runtime.evaluate', { expression: SCROLL_THROUGH, awaitPromise: true, returnByValue: true }, 40000).catch(() => {});
      if (format === 'pdf') {
        const printed = await client.send('Page.printToPDF', { printBackground: true, preferCSSPageSize: false, marginTop: 0.3, marginBottom: 0.3, marginLeft: 0.3, marginRight: 0.3 }, 120000);
        return Buffer.from(printed.data || '', 'base64');
      }
      const image = await captureFullPage(client, { maxHeight: 16000, timeoutMs: 120000 });
      if (!image) throw new Error('ページの画像を作れませんでした。');
      return image;
    } catch (error) {
      logEvent('warn', 'archive', 'page.export.failed', { archiveId, pageUrl: safeUrl(pageUrl), format, message: error.message });
      throw Object.assign(new Error(`書き出しに失敗しました: ${error.message}`), { status: 500, code: 'PAGE_EXPORT_FAILED' });
    } finally {
      await session.close().catch(() => {});
    }
  });
  queue = run.catch(() => {});
  return run;
}
