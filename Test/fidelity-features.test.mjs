import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { VaultStore } from '../server/store.mjs';
import { createReplayHandler } from '../server/replay.mjs';
import { scriptReferencesIn, prefetchCandidates, prefetchScriptReferences } from '../server/script-prefetch.mjs';
import { siteReplayResponse, extractAssignedJson, canonicalGraphqlVariables } from '../server/site-adapters.mjs';
import { sanitizeCaptureOptions } from '../server/capture-options.mjs';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser, freePort, mobileBrowserIdentity } from '../server/browser-capture.mjs';
import { ReplayAuditManager, createLocalAuditBrowser } from '../server/replay-auditor.mjs';
import { visualPages, visualComparison } from '../server/visual-compare.mjs';
import { diffGrid } from '../public/visual-diff.js';
import { exportReplayPage } from '../server/page-export.mjs';
import { navigateAndSettle, evaluateValue } from '../server/browser-page.mjs';

async function tempStore(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `webcapture-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new VaultStore(root).init();
}

function response(body, { status = 200, type = 'text/javascript' } = {}) {
  const buffer = Buffer.from(body);
  return { ok: status >= 200 && status < 300, status, headers: new Headers({ 'content-type': type }), arrayBuffer: async () => buffer };
}

async function startReplay(t, store) {
  const replayPort = await freePort();
  const server = http.createServer(createReplayHandler(store, { host: '127.0.0.1', port: 1, replayPort }));
  await new Promise((resolve) => server.listen(replayPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { replayPort, base: `http://127.0.0.1:${replayPort}` };
}

test('保存設定：スマホ表示は既定OFF、部品の先取りは既定ON', () => {
  const defaults = sanitizeCaptureOptions({});
  assert.equal(defaults.captureMobile, false);
  assert.equal(defaults.prefetchScripts, true);
  const custom = sanitizeCaptureOptions({ captureMobile: true, prefetchScripts: false, resourceTypes: { media: false } });
  assert.deepEqual([custom.captureMobile, custom.prefetchScripts, custom.resourceTypes.media, custom.resourceTypes.image], [true, false, false, true]);
});

test('部品の先取り：スクリプトやページ内の参照から、同じサイトの未保存の部品だけを探す', () => {
  const found = scriptReferencesIn('import("./chunk-a.js");const x="\\/s\\/desktop\\/app.js";const y=\'https://cdn.other.example/lib.js\';const z="/styles/theme.css?v=2";const n="plain.js"', 'https://www.example.com/static/main.js');
  assert.ok(found.includes('https://www.example.com/static/chunk-a.js'));
  assert.ok(found.includes('https://www.example.com/s/desktop/app.js'), 'JSONのエスケープされた斜線も読む');
  assert.ok(found.includes('https://www.example.com/styles/theme.css?v=2'));
  assert.ok(!found.some((url) => url.endsWith('/plain.js')), '場所の分からない名前だけの参照は使わない');
  const capture = {
    url: 'https://www.example.com/',
    html: '<link rel="modulepreload" href="/m/entry.js"><link rel="preload" as="image" href="/hero.js"><script>var cfg={"jsUrl":"\\/s\\/player\\/base.js"}</script>',
    resources: [
      { url: 'https://www.example.com/static/main.js', mimeType: 'text/javascript', type: 'Script', status: 200, body: Buffer.from('import("./chunk-a.js");fetch("https://www.google-analytics.com/analytics.js");const k="https://cdn.other.example/lib.js"') },
      { url: 'https://static.example.com/known.js', mimeType: 'text/javascript', type: 'Script', status: 200, body: Buffer.from('"./next.js"') }
    ]
  };
  const candidates = prefetchCandidates(capture, { knownResourceUrls: new Set(['https://www.example.com/s/player/base.js']) });
  assert.deepEqual(candidates.sort(), ['https://static.example.com/next.js', 'https://www.example.com/m/entry.js', 'https://www.example.com/static/chunk-a.js'].sort());
});

test('部品の先取り：取得できた部品を保存に加え、その中の参照もたどり、HTMLや失敗は加えない', async () => {
  const bodies = {
    'https://www.example.com/static/chunk-a.js': 'import("./chunk-b.js")',
    'https://www.example.com/static/chunk-b.js': 'export const b = 1;',
    'https://www.example.com/static/missing.js': null,
    'https://www.example.com/static/login.js': '<html>login</html>'
  };
  const capture = {
    url: 'https://www.example.com/', html: '<script>import("/static/chunk-a.js");import("/static/missing.js");import("/static/login.js")</script>',
    resources: [], blocked: []
  };
  const fetched = [];
  await prefetchScriptReferences(capture, { signal: new AbortController().signal }, {}, {
    fetcher: async (url) => {
      fetched.push(url);
      const body = bodies[url];
      if (body === null || body === undefined) return { response: response('', { status: 404 }), finalUrl: url };
      return { response: response(body, { type: body.startsWith('<html') ? 'text/html' : 'text/javascript' }), finalUrl: url };
    }
  });
  assert.deepEqual(capture.resources.map((item) => item.url).sort(), ['https://www.example.com/static/chunk-a.js', 'https://www.example.com/static/chunk-b.js']);
  assert.ok(capture.resources.every((item) => item.prefetched && item.type === 'Script'));
  assert.equal(capture.preservation.prefetchedScripts, 2);
  assert.equal(capture.blocked.length, 0, '先取りの失敗は保存の失敗に数えない');
  assert.ok(fetched.includes('https://www.example.com/static/chunk-b.js'));
  const untouched = { url: 'https://www.example.com/', html: '<script>import("/a.js")</script>', resources: [] };
  await prefetchScriptReferences(untouched, { prefetchScripts: false }, {}, { fetcher: async () => { throw new Error('呼ばれない'); } });
  assert.equal(untouched.resources.length, 0);
});

test('サイト別の再生補助：YouTubeの動画情報・X・Shopifyの応答を保存済みページから組み立て、IDが違えば代用しない', async () => {
  const watchHtml = `<script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc123XYZ_0","title":"a } b"},"note":"'quote'"};var meta = 1;</script><script>var ytInitialData = {"currentVideoEndpoint":{"watchEndpoint":{"videoId":"abc123XYZ_0"}},"contents":{}};</script>`;
  const productHtml = '<script>var Shopify = Shopify || {}; Shopify.currency = {"active":"JPY","rate":"1.0"};</script><script src="https://cdn.shopify.com/s/files/x.js"></script><script type="application/json" data-product-json>{"id":1,"handle":"tee","title":"Tシャツ","variants":[{"id":11,"price":1000}]}</script>';
  const files = {
    'blobs/watch': watchHtml, 'blobs/product': productHtml,
    'blobs/x-response': '{"data":{"user":{"rest_id":"42"}}}',
    'blobs/x-request': JSON.stringify({ variables: { userId: '42', count: 20 }, features: { a: true } })
  };
  const readFile = async (file) => { if (!(file in files)) throw new Error('missing'); return Buffer.from(files[file]); };
  const manifest = {
    pages: [
      { url: 'https://www.youtube.com/watch?v=abc123XYZ_0', html: 'blobs/watch' },
      { url: 'https://shop.example.com/collections/all/products/tee', html: 'blobs/product' }
    ],
    resources: {
      'https://x.com/i/api/graphql/OLD/UserByRestId?variables=%7B%22userId%22%3A%2242%22%2C%22withSafety%22%3Atrue%7D&features=%7B%22old%22%3Atrue%7D': { url: 'https://x.com/i/api/graphql/OLD/UserByRestId?variables=%7B%22userId%22%3A%2242%22%2C%22withSafety%22%3Atrue%7D&features=%7B%22old%22%3Atrue%7D', status: 200, mimeType: 'application/json', file: 'blobs/x-response' }
    },
    postResponses: { key: { url: 'https://x.com/i/api/graphql/Q1/UserTweets', status: 200, mimeType: 'application/json', file: 'blobs/x-response', requestFile: 'blobs/x-request' } }
  };
  const player = await siteReplayResponse({ manifest, target: 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false', method: 'POST', body: Buffer.from(JSON.stringify({ videoId: 'abc123XYZ_0' })), readFile });
  assert.equal(player.adapter, 'youtube-player');
  assert.equal(JSON.parse(player.body).videoDetails.title, 'a } b', '文字列中の括弧で途切れない');
  const next = await siteReplayResponse({ manifest, target: 'https://www.youtube.com/youtubei/v1/next', method: 'POST', body: Buffer.from('{"videoId":"abc123XYZ_0"}'), readFile });
  assert.equal(next.adapter, 'youtube-next');
  assert.equal(await siteReplayResponse({ manifest, target: 'https://www.youtube.com/youtubei/v1/player', method: 'POST', body: Buffer.from('{"videoId":"other000000"}'), readFile }), null, '別の動画IDの情報は返さない');
  const xGet = await siteReplayResponse({ manifest, target: 'https://x.com/i/api/graphql/NEW/UserByRestId?variables=%7B%22withSafety%22%3Atrue%2C%22userId%22%3A%2242%22%7D&features=%7B%22new%22%3Atrue%7D', readFile });
  assert.equal(xGet.adapter, 'x-graphql', '毎回変わるfeaturesや操作IDの違いは無視する');
  assert.equal(await siteReplayResponse({ manifest, target: 'https://x.com/i/api/graphql/NEW/UserByRestId?variables=%7B%22userId%22%3A%2243%22%2C%22withSafety%22%3Atrue%7D', readFile }), null, 'ユーザーIDが違えば返さない');
  const xPost = await siteReplayResponse({ manifest, target: 'https://x.com/i/api/graphql/Q2/UserTweets', method: 'POST', body: Buffer.from(JSON.stringify({ variables: { count: 20, userId: '42' }, features: { b: false } })), readFile });
  assert.equal(xPost.adapter, 'x-graphql');
  const productJs = await siteReplayResponse({ manifest, target: 'https://shop.example.com/products/tee.js', readFile });
  assert.equal(JSON.parse(productJs.body).variants[0].price, 1000);
  const productJson = await siteReplayResponse({ manifest, target: 'https://shop.example.com/products/tee.json', readFile });
  assert.equal(JSON.parse(productJson.body).product.handle, 'tee');
  assert.equal(await siteReplayResponse({ manifest, target: 'https://shop.example.com/products/other.js', readFile }), null);
  const cart = await siteReplayResponse({ manifest, target: 'https://shop.example.com/cart.js', readFile });
  assert.deepEqual([JSON.parse(cart.body).item_count, JSON.parse(cart.body).currency], [0, 'JPY']);
  assert.equal(await siteReplayResponse({ manifest: { pages: [{ url: 'https://blog.example.com/', html: 'blobs/watch' }] }, target: 'https://blog.example.com/cart.js', readFile }), null, 'Shopifyではないサイトには空のカートを返さない');
  assert.equal(extractAssignedJson('window["ytInitialData"] = {"a":1};', 'ytInitialData').a, 1);
  assert.equal(canonicalGraphqlVariables('{"b":1,"a":{"d":2,"c":3}}'), '{"a":{"c":3,"d":2},"b":1}');
});

test('再生：スマホ表示の切り替えは保存したスマホ用HTMLを返し、ページ移動でも保たれる。ページ内検索の仕組みも入る', async (t) => {
  const store = await tempStore(t, 'mobile-replay');
  const id = 'archive_mobile_replay';
  const desktop = await store.writeBlob(id, Buffer.from('<html><head><title>PC</title></head><body><p>desktop layout</p></body></html>'));
  const mobile = await store.writeBlob(id, Buffer.from('<html><head><title>SP</title></head><body><p>mobile layout</p></body></html>'));
  await store.writeManifest(id, {
    id, startUrl: 'https://example.com/', options: {}, resources: {}, resourceAliases: {},
    pages: [{ url: 'https://example.com/', html: desktop.file, mobile: { html: mobile.file, userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Mobile' } }, { url: 'https://example.com/b', html: desktop.file }]
  });
  const { base } = await startReplay(t, store);
  const page = (query, headers = {}) => fetch(`${base}/archive/${id}/page?url=${encodeURIComponent('https://example.com/')}${query}`, { headers });
  const pc = await page('');
  assert.match(await pc.text(), /desktop layout/);
  const sp = await page('&view=mobile');
  const spHtml = await sp.text();
  assert.equal(sp.headers.get('x-webcapture-view'), 'mobile');
  assert.match(spHtml, /mobile layout/);
  assert.match(spHtml, /Linux armv8l/, 'スマホの名乗りをページ内でも使う');
  assert.match(spHtml, /webcapture-find/, 'ページ内検索の受け口が入る');
  const cookies = sp.headers.getSetCookie();
  assert.ok(cookies.some((cookie) => cookie.startsWith('webcapture_view=mobile')));
  const viewCookie = cookies.find((cookie) => cookie.startsWith('webcapture_view=')).split(';')[0];
  const followed = await page('', { cookie: viewCookie });
  assert.match(await followed.text(), /mobile layout/, 'リンク移動（view指定なし）でもスマホ表示を保つ');
  const noMobile = await fetch(`${base}/archive/${id}/page?url=${encodeURIComponent('https://example.com/b')}`, { headers: { cookie: viewCookie } });
  assert.equal(noMobile.headers.get('x-webcapture-view'), 'desktop', 'スマホ表示がないページはPC表示で出す');
  const back = await page('&view=desktop', { cookie: viewCookie });
  assert.match(await back.text(), /desktop layout/);
  assert.ok(back.headers.getSetCookie().some((cookie) => cookie.startsWith('webcapture_view=desktop')));
});

test('再生：保存漏れの通信はサイト別の再生補助で返し、補助できないものは従来どおり未保存として扱う', async (t) => {
  const store = await tempStore(t, 'adapter-replay');
  const id = 'archive_adapter_replay';
  const html = await store.writeBlob(id, Buffer.from('<html><head><title>Watch</title></head><body><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"vid00000001"},"streamingData":{}};</script></body></html>'));
  await store.writeManifest(id, { id, startUrl: 'https://www.youtube.com/watch?v=vid00000001', options: {}, resources: {}, resourceAliases: {}, pages: [{ url: 'https://www.youtube.com/watch?v=vid00000001', html: html.file }] });
  await store.addArchive({ id, startUrl: 'https://www.youtube.com/watch?v=vid00000001', title: 'Watch', status: 'complete', pages: 1, resources: 0, bytes: 1, errors: 0, savedAt: new Date().toISOString() });
  const { base } = await startReplay(t, store);
  const served = await fetch(`${base}/archive/${id}/post?url=${encodeURIComponent('https://www.youtube.com/youtubei/v1/player')}`, { method: 'POST', body: JSON.stringify({ videoId: 'vid00000001' }) });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('x-webcapture-site-adapter'), 'youtube-player');
  assert.equal((await served.json()).videoDetails.videoId, 'vid00000001');
  const missing = await fetch(`${base}/archive/${id}/web/https://www.youtube.com/s/desktop/abc/unknown.js`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-webcapture-missing-resource'), '1');
});

test('見た目の比較：区画ごとの差を数え、表示検査の結果から一致率の低い順に並べる', async (t) => {
  const width = 8;
  const height = 8;
  const saved = new Uint8ClampedArray(width * height * 4).fill(255);
  const replay = new Uint8ClampedArray(saved);
  for (let y = 4; y < 8; y += 1) for (let x = 0; x < 4; x += 1) replay.set([0, 0, 0, 255], (y * width + x) * 4);
  const grid = diffGrid(saved, replay, width, height, { sample: 4, cell: 32 });
  assert.deepEqual(grid.changed, [[0, 1]]);
  assert.equal(grid.similarity, 0.75);
  assert.deepEqual(diffGrid(saved, saved, width, height, { sample: 4 }).changed, []);
  const audit = { pages: [
    { url: 'https://example.com/a', title: 'A', visual: { saved: 'screenshots/00001.png', replay: 'replay-audit/r/visual/00001-a.png', similarity: 0.97 } },
    { url: 'https://example.com/b', title: 'B', visual: { saved: 'screenshots/00002.png', replay: 'replay-audit/r/visual/00002-b.png', similarity: 0.5 } },
    { url: 'https://example.com/c', title: 'C' }
  ] };
  assert.deepEqual(visualPages(audit).map((page) => [page.url, page.mismatch]), [['https://example.com/b', true], ['https://example.com/a', false]]);

  const store = await tempStore(t, 'visual-audit');
  const id = 'archive_visual_audit';
  const htmlBlob = await store.writeBlob(id, Buffer.from('<title>V</title>'));
  await store.writeScreenshot(id, '00001.png', Buffer.from('saved-png'));
  await store.writeManifest(id, { id, startUrl: 'https://example.com/', pages: [{ url: 'https://example.com/', title: 'V', html: htmlBlob.file, screenshot: 'screenshots/00001.png' }, { url: 'https://example.com/n', title: 'N', html: htmlBlob.file }], resources: {} });
  await store.addArchive({ id, startUrl: 'https://example.com/', title: 'V', status: 'complete', pages: 2, resources: 0, bytes: 1, errors: 0, savedAt: new Date().toISOString() });
  const compared = [];
  const manager = new ReplayAuditManager(store, { host: '127.0.0.1', port: 1, replayPort: 2 }, {
    browserFactory: async () => ({ client: {}, close: async () => {} }),
    auditPage: async (_client, { page, captureVisual }) => ({ url: page.url, status: 'healthy', metrics: {}, interactions: { items: [] }, missingResources: [], boundaryResources: [], auxiliaryResources: [], failedRequests: [], runtimeErrors: [], ...(captureVisual ? { visualShot: Buffer.from('replay-png') } : {}) }),
    compareVisual: async (_client, archiveId, savedPath, replayPath) => { compared.push([archiveId, savedPath, replayPath]); return { similarity: 0.62, changed: [[1, 2]], cellSize: 32, cols: 45, rows: 30, width: 1440, height: 960 }; }
  });
  await manager.start(id);
  await manager.states.get(id).task;
  const report = await store.readReplayAudit(id);
  assert.equal(report.status, 'completed');
  assert.equal(compared.length, 1, 'スクリーンショットのあるページだけ比べる');
  assert.equal(compared[0][1], 'screenshots/00001.png');
  const replayFile = report.pages[0].visual.replay;
  assert.match(replayFile, /^replay-audit\/[A-Za-z0-9-]+\/visual\/00001-[a-f0-9]{12}\.png$/);
  assert.equal(await fs.readFile(path.join(store.archiveRoot(id), replayFile), 'utf8'), 'replay-png');
  assert.equal(report.summary.visualMismatchPages, 1);
  assert.equal(report.summary.visualAverage, 0.62);
  assert.equal(report.pages[1].visual, undefined);
  const visual = await visualComparison(store, id, 'https://example.com/');
  assert.equal(visual.page.similarity, 0.62);
  assert.equal(visual.pages[0].mismatch, true);
});

test('スマホの名乗り：PC用の名乗りからAndroidのChromeの名乗りを作る', () => {
  const identity = mobileBrowserIdentity({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.1.2 Safari/537.36', userAgentMetadata: { platform: 'Windows', mobile: false } });
  assert.equal(identity.userAgent, 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.1.2 Mobile Safari/537.36');
  assert.equal(identity.userAgentMetadata.mobile, true);
  assert.equal(identity.userAgentMetadata.platform, 'Android');
});

test('スクリーンショット名：スマホ表示用の名前を受け付け、ほかの名前は拒否する', async (t) => {
  const store = await tempStore(t, 'mobile-shot');
  assert.equal(await store.writeScreenshot('archive_shot', '00001-mobile.png', Buffer.from('x')), 'screenshots/00001-mobile.png');
  await assert.rejects(() => store.writeScreenshot('archive_shot', '../00001.png', Buffer.from('x')), /スクリーンショット名/);
});

test('実際のChrome：スマホ表示で保存するとスマホの幅と名乗りでページが描かれる', { timeout: 120000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const live = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Responsive</title><body><p id="out"></p><script>out.textContent=innerWidth+"|"+(/Mobile/.test(navigator.userAgent)?"mobile":"desktop")+"|"+(matchMedia("(max-width: 600px)").matches?"narrow":"wide")</script></body>');
  });
  await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => live.close(resolve)));
  const pageUrl = `http://127.0.0.1:${live.address().port}/`;
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const options = { session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'viewport', interactDuringCapture: false, hoverDuringCapture: false, networkIdleMs: 300 };
  const desktop = await captureWithBrowser(pageUrl, options);
  assert.match(desktop.html, /1440\|desktop\|wide/);
  const mobile = await captureWithBrowser(pageUrl, { ...options, mobile: true });
  assert.match(mobile.html, /390\|mobile\|narrow/);
  assert.match(mobile.userAgent, /Android/);
  assert.equal(mobile.viewport.width, 390);
  assert.ok(mobile.screenshot?.length > 0);
});

test('実際のChrome：ページ内検索で一致を数えて強調し、PNGとPDFで書き出せる', { timeout: 180000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const store = await tempStore(t, 'export-find');
  const id = 'archive_export_find';
  const html = await store.writeBlob(id, Buffer.from('<!doctype html><html><head><title>Export</title></head><body><h1>Apple and apple</h1><p style="height:1500px">APPLE pie</p><footer>end</footer></body></html>'));
  await store.writeManifest(id, { id, startUrl: 'https://example.com/', options: {}, resources: {}, resourceAliases: {}, pages: [{ url: 'https://example.com/', html: html.file, title: 'Export' }] });
  await store.addArchive({ id, startUrl: 'https://example.com/', title: 'Export', status: 'complete', pages: 1, resources: 0, bytes: 1, errors: 0, savedAt: new Date().toISOString() });
  const { replayPort, base } = await startReplay(t, store);
  const config = { host: '127.0.0.1', replayPort };
  const png = await exportReplayPage({ archiveId: id, pageUrl: 'https://example.com/', format: 'png', config });
  assert.deepEqual([...png.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.ok(png.readUInt32BE(20) > 1000, 'ページ全体の高さで撮る');
  const pdf = await exportReplayPage({ archiveId: id, pageUrl: 'https://example.com/', format: 'pdf', config });
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  const session = await createLocalAuditBrowser({ executable: browser });
  t.after(() => session.close());
  await navigateAndSettle(session.client, `${base}/archive/${id}/page?url=${encodeURIComponent('https://example.com/')}`, { settleMs: 300 });
  const result = evaluateValue(await session.client.send('Runtime.evaluate', {
    expression: `new Promise((resolve) => { addEventListener('message', (event) => { if (event.data && event.data.type === 'webcapture-find-result') resolve({ count: event.data.count, index: event.data.index, highlighted: CSS.highlights.has('webcapture-find') }); }); postMessage({ type: 'webcapture-find', query: 'apple' }, '*'); })`,
    awaitPromise: true, returnByValue: true
  }, 10000));
  assert.deepEqual(result, { count: 3, index: 0, highlighted: true });
});

test('実際のChrome：保存処理でスマホ表示と読み込まれなかった部品を一緒に保存し、再生で切り替えられる', { timeout: 180000 }, async (t) => {
  const { CrawlManager } = await import('../server/crawler.mjs');
  const { DEFAULT_CAPTURE_OPTIONS } = await import('../server/capture-options.mjs');
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const requested = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    requested.push(pathname);
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    if (pathname === '/app.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('window.openMenu = () => import("./lazy-menu.js");'); return; }
    if (pathname === '/lazy-menu.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end('export const menu = "top bar";'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><meta name="viewport" content="width=device-width"><title>Fixture</title><body><p id="layout"></p><script src="/app.js"></script><script>layout.textContent=innerWidth<600?"phone layout":"pc layout"</script></body>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await tempStore(t, 'crawler-mobile');
  const startUrl = `http://127.0.0.1:${server.address().port}/`;
  const job = await store.addJob({ startUrl, options: {
    ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, respectRobots: false, captureRendered: true, captureMobile: true, prefetchScripts: true,
    discoveryMode: 'immediate', concurrency: 1, maxPages: 1, screenshotMode: 'viewport', interactDuringCapture: false, hoverDuringCapture: false,
    networkIdleMs: 300, networkIdleMaxMs: 3000, requestTimeoutMs: 30000
  } });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  const page = manifest.pages[0];
  assert.ok(page.mobile?.html, JSON.stringify(manifest.blocked));
  const root = store.archiveRoot(job.archiveId);
  assert.match(await fs.readFile(path.join(root, page.html), 'utf8'), /pc layout/);
  assert.match(await fs.readFile(path.join(root, page.mobile.html), 'utf8'), /phone layout/);
  assert.equal(page.mobile.screenshot, 'screenshots/00001-mobile.png');
  assert.ok((await fs.stat(path.join(root, page.mobile.screenshot))).size > 0);
  assert.match(page.mobile.userAgent, /Android/);
  assert.ok(manifest.resources[`${startUrl}lazy-menu.js`], '実行されなかった import() の部品も保存する');
  const { base } = await startReplay(t, store);
  const replayed = await fetch(`${base}/archive/${job.archiveId}/page?url=${encodeURIComponent(page.url)}&view=mobile`);
  assert.match(await replayed.text(), /phone layout/);
  const lazy = await fetch(`${base}/archive/${job.archiveId}/web/${startUrl}lazy-menu.js`);
  assert.equal(lazy.status, 200);
});
