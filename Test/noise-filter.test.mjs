import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { isCaptureNoise } from '../server/noise-filter.mjs';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser, regularBrowserIdentity } from '../server/browser-capture.mjs';

test('計測・広告・ログ送信だけを保存しない通信として見分ける', () => {
  for (const url of [
    'https://www.google-analytics.com/g/collect?v=2', 'https://www.googletagmanager.com/gtag/js?id=G-1', 'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
    'https://www.youtube.com/api/stats/watchtime?ns=yt', 'https://www.youtube.com/youtubei/v1/log_event?alt=json', 'https://play.google.com/log?format=json',
    'https://x.com/i/api/1.1/jot/client_event.json', 'https://store.kkvv.jp/.well-known/shopify/monorail/unstable/produce_batch', 'https://www.facebook.com/tr/?id=1',
    'https://connect.facebook.net/en_US/fbevents.js', 'https://example.com/api/collect'
  ]) assert.equal(isCaptureNoise(url), true, url);
  assert.equal(isCaptureNoise('https://example.com/anything', 'Ping'), true, 'sendBeaconは常に止める');
  for (const url of [
    'https://www.youtube.com/watch?v=abc', 'https://i.ytimg.com/vi/abc/hqdefault.jpg', 'https://www.youtube.com/s/player/base.js',
    'https://cdn.shopify.com/s/files/1/image.png', 'https://store.kkvv.jp/products/item', 'https://fonts.gstatic.com/s/font.woff2',
    'https://pbs.twimg.com/media/a.jpg', 'https://example.com/collections/all', 'https://example.com/images/pixel.gif'
  ]) assert.equal(isCaptureNoise(url), false, url);
});

test('保存用ブラウザの名乗りは通常のChromeと同じにし、Headlessを含めない', () => {
  const identity = regularBrowserIdentity({ 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/140.0.7339.80 Safari/537.36' }, 'C:/Program Files/Google/Chrome/Application/chrome.exe');
  assert.equal(identity.userAgent.includes('Headless'), false);
  assert.match(identity.userAgent, /Chrome\/140\.0\.7339\.80/);
  assert.deepEqual(identity.userAgentMetadata.brands.map((item) => item.brand), ['Chromium', 'Google Chrome', 'Not.A/Brand']);
  assert.equal(identity.userAgentMetadata.brands[0].version, '140');
});

test('計測の通信が続くページでも通信の完了待ちを長引かせず、計測の通信は保存しない', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const agents = new Set();
  let collects = 0;
  const server = http.createServer((req, res) => {
    agents.add(String(req.headers['user-agent'] || ''));
    if (req.url.startsWith('/api/collect') || req.url.startsWith('/g/collect')) { collects += 1; res.writeHead(204); res.end(); return; }
    if (req.url === '/photo.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Noisy</title><img src="/photo.svg"><script>document.documentElement.dataset.webdriver=String(navigator.webdriver);setInterval(()=>{fetch("/api/collect?t="+Date.now(),{method:"POST",body:"x"});navigator.sendBeacon("/g/collect?b="+Date.now(),"y")},300)</script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const capture = await captureWithBrowser(`http://127.0.0.1:${server.address().port}/`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 60000, screenshotMode: 'none',
    interactDuringCapture: false, hoverDuringCapture: false, networkIdleMs: 1500, networkIdleMaxMs: 30000
  });
  assert.ok(capture.preservation.timings.networkIdleMs < 6000, `完了待ちが長い: ${capture.preservation.timings.networkIdleMs}`);
  assert.ok(capture.resources.some((item) => item.url.endsWith('/photo.svg')));
  assert.equal(capture.resources.some((item) => /\/(?:api|g)\/collect/.test(item.url)), false, '計測の通信は保存しない');
  assert.equal(collects, 0, '計測の通信はサーバーまで届かない');
  assert.ok(capture.preservation.blockedNoiseCount > 0);
  assert.equal([...agents].some((agent) => /Headless/i.test(agent)), false, [...agents].join(' | '));
  assert.match(capture.html, /data-webdriver="false"/);
});

test('ページそのものの読み込みはURLに analytics 等が含まれても止めない', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Analytics terms</title><p>規約</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const capture = await captureWithBrowser(`http://127.0.0.1:${server.address().port}/analytics/terms/jp.html`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 30000, screenshotMode: 'none', interactDuringCapture: false, hoverDuringCapture: false
  });
  assert.equal(capture.title, 'Analytics terms');
});
