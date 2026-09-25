import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { VaultStore } from '../server/store.mjs';
import { createReplayHandler, rewriteHtml } from '../server/replay.mjs';
import { CdpClient, createBrowserCaptureSession, findBrowser, freePort } from '../server/browser-capture.mjs';
import { replayState, applyReplayMessage, replayStateLabel } from '../public/replay-state.js';

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64');

test('再生：preloadのimagesrcsetも保存済みの画像へ向け、固定表示では元のスクリプトを外し動きは止めない', () => {
  const html = '<html><head><link rel="preload" as="image" imagesrcset="https://img.example/a.png 600w, https://img.example/b.png 1200w"><style>.x{animation:spin 1s}</style></head><body><video autoplay src="https://img.example/v.mp4"></video><script>document.body.innerHTML=""</script></body></html>';
  const normal = rewriteHtml(html, 'https://site.example/', 'archive_t', {}, 'n1', { guard: true });
  assert.match(normal, /imagesrcset="\/archive\/archive_t\/web\/https:\/\/img\.example\/a\.png 600w, \/archive\/archive_t\/web\/https:\/\/img\.example\/b\.png 1200w"/);
  assert.match(normal, /installCollapseGuard/);
  assert.match(normal, /mode=static/);
  assert.match(normal, /installStyleUrlRewrite/);
  const still = rewriteHtml(html, 'https://site.example/', 'archive_t', {}, 'n1', { guard: true, still: true });
  assert.doesNotMatch(still, /document\.body\.innerHTML=""/);
  assert.doesNotMatch(still, /installCollapseGuard/);
  assert.doesNotMatch(still, /data-webcapture-light/);
  assert.match(still, /<video autoplay/);
  const frame = rewriteHtml(html, 'https://site.example/frame', 'archive_t', {}, '', {});
  assert.doesNotMatch(frame, /installCollapseGuard/, '埋め込み枠の中の文書では固定表示へ切り替えない');
});

test('再生状態：固定表示への切り替えを表示し、読み込み完了で完了にする', () => {
  let current = replayState('archive_t', 'https://site.example/', true, 'n1');
  const message = (type) => ({ type, archiveId: 'archive_t', pageUrl: 'https://site.example/', navigationId: 'n1' });
  current = applyReplayMessage(current, message('webcapture-ready'));
  current = applyReplayMessage(current, message('webcapture-static-fallback'));
  assert.equal(current.phase, 'loading');
  current = applyReplayMessage(current, message('webcapture-ready'));
  assert.match(replayStateLabel(current), /^表示完了・ページのスクリプトが表示を消したため保存時の見た目で表示/);
});

test('再生：スクリプトが後から付けた背景画像も保存済み画像で表示し、ページが中身を消したら保存時の見た目へ切り替える（実際のChrome）', { timeout: 120000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-replay-dynamic-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const id = 'archive_replay_dynamic';
  const paragraphs = Array.from({ length: 80 }, (_, index) => `<p>保存したときの本文 ${index} です。ここに記事の文章が並んでいます。</p>`).join('');
  const pages = {
    'https://site.example/wipe': `<!doctype html><title>Wipe</title><main id="saved">${paragraphs}</main><script>setTimeout(() => { document.body.innerHTML = '<div id="app"></div>'; }, 300);</script>`,
    'https://site.example/grow': `<!doctype html><title>Grow</title><main>${paragraphs}</main><script>setTimeout(() => { document.querySelector('main').insertAdjacentHTML('beforeend', '<p id="grown">あとから増えた本文</p>'); }, 300);</script>`,
    'https://site.example/style': `<!doctype html><title>Style</title><div id="a" style="width:10px;height:10px"></div><div id="b"></div><div id="c"></div><div id="d" class="sheet"></div><div id="e"></div>
      <script>
        document.getElementById('a').style.backgroundImage = 'url("https://img.example/pixel.png")';
        document.getElementById('b').style.setProperty('background-image', 'url(https://img.example/pixel.png)');
        document.getElementById('c').setAttribute('style', 'background: url(//img.example/pixel.png) no-repeat');
        const sheet = new CSSStyleSheet(); sheet.replaceSync('.sheet{background-image:url("https://img.example/pixel.png")}'); document.adoptedStyleSheets = [sheet];
        const style = document.createElement('style'); style.textContent = '#e{background-image:url("https://img.example/pixel.png")}'; document.head.append(style);
        const link = document.createElement('link'); link.rel = 'preload'; link.as = 'image'; link.imageSrcset = 'https://img.example/pixel.png 1x'; document.head.append(link);
      </script>`
  };
  const manifestPages = [];
  for (const [url, html] of Object.entries(pages)) {
    const blob = await store.writeBlob(id, Buffer.from(html));
    manifestPages.push({ url, requestedUrl: url, html: blob.file });
  }
  const image = await store.writeBlob(id, PIXEL);
  await store.writeManifest(id, {
    id, startUrl: 'https://site.example/wipe', options: {}, resourceAliases: {}, pages: manifestPages,
    resources: { 'https://img.example/pixel.png': { url: 'https://img.example/pixel.png', status: 200, mimeType: 'image/png', headers: { 'content-type': 'image/png' }, ...image } }
  });
  const replayPort = await freePort();
  const server = http.createServer(createReplayHandler(store, { host: '127.0.0.1', port: 43193, replayPort, iframeParentOrigins: [] }));
  await new Promise((resolve) => server.listen(replayPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const tab = await (await fetch(`http://127.0.0.1:${session.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await new CdpClient(tab.webSocketDebuggerUrl).connect();
  t.after(() => client.close());
  await client.send('Page.enable');
  await client.send('Network.enable');
  const outside = [];
  client.on('Network.requestWillBeSent', (event) => { if (/^https?:\/\/img\.example\//.test(event.request.url)) outside.push(event.request.url); });
  const open = (url) => client.send('Page.navigate', { url: `http://127.0.0.1:${replayPort}/archive/${id}/page?url=${encodeURIComponent(url)}&navigationId=n1` });
  const evaluate = async (expression) => (await client.send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression })).result.value;
  const waitFor = async (expression, attempts = 40) => {
    let value = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      value = await evaluate(expression);
      if (value?.done) break;
    }
    return value;
  };

  await open('https://site.example/style');
  const styled = await waitFor(`(() => { const bg = (id) => getComputedStyle(document.getElementById(id)).backgroundImage; const values = ['a','b','c','d','e'].map(bg); return { done: values.every((value) => value.includes('/archive/')), values, preload: document.querySelector('link[rel=preload]')?.getAttribute('imagesrcset') || '' }; })()`);
  assert.equal(styled.done, true, `スクリプトが付けた背景画像が保存済みに向いていない: ${JSON.stringify(styled.values)}`);
  assert.match(styled.preload, /^\/archive\/archive_replay_dynamic\/web\/https:\/\/img\.example\/pixel\.png 1x$/);
  assert.deepEqual(outside, [], '元のサイトの画像へは通信しない');

  await open('https://site.example/wipe');
  const wiped = await waitFor(`({ done: performance.getEntriesByType('navigation')[0].name.includes('mode=static') && document.querySelectorAll('#saved p').length === 80, search: performance.getEntriesByType('navigation')[0].name, count: document.querySelectorAll('#saved p').length, scripts: document.querySelectorAll('script:not([src])').length })`);
  assert.equal(wiped.done, true, `中身を消されたページが保存時の見た目に戻らない: ${JSON.stringify(wiped)}`);

  await open('https://site.example/grow');
  await new Promise((resolve) => setTimeout(resolve, 3500));
  const grown = await evaluate(`({ search: performance.getEntriesByType('navigation')[0].name, grown: Boolean(document.getElementById('grown')) })`);
  assert.equal(grown.grown, true);
  assert.doesNotMatch(grown.search, /mode=static/, '中身が増えるだけのページは切り替えない');
});
