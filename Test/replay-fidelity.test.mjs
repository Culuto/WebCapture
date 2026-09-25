import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CdpClient, captureWithBrowser, createBrowserCaptureSession, findBrowser, freePort } from '../server/browser-capture.mjs';
import { archiveIdFromReplayHost, archiveReplayHost } from '../public/replay-origin.js';
import { VaultStore } from '../server/store.mjs';
import { archivedWebPath, createReplayHandler, findQueryVariantFallback, rewriteHtml } from '../server/replay.mjs';
import { installSeededRandom, pageSeed } from '../server/determinism.mjs';
import { runInNewContext } from 'node:vm';

test('実行のたびに変わるURLは変わる部分だけを無視し、意味のある条件は一致を求める', () => {
  const manifest = { resources: {
    'https://site.example/app.js?v=1712345678': { url: 'https://site.example/app.js?v=1712345678', status: 200, size: 10, file: 'app' },
    'https://site.example/api/items?page=1&_=1712345678901': { url: 'https://site.example/api/items?page=1&_=1712345678901', status: 200, size: 10, file: 'page1' },
    'https://site.example/pixel.gif?cb=0.123456789': { url: 'https://site.example/pixel.gif?cb=0.123456789', status: 200, size: 10, file: 'pixel' }
  } };
  assert.equal(findQueryVariantFallback(manifest, 'https://site.example/app.js?v=1799999999').resource.file, 'app');
  assert.equal(findQueryVariantFallback(manifest, 'https://site.example/api/items?page=1&_=1799999999999').resource.file, 'page1');
  assert.equal(findQueryVariantFallback(manifest, 'https://site.example/api/items?page=2&_=1799999999999'), null);
  assert.equal(findQueryVariantFallback(manifest, 'https://site.example/pixel.gif?cb=0.987654321').kind, 'query-variant');
  assert.equal(findQueryVariantFallback(manifest, 'https://site.example/other.js?v=1'), null);
});

test('再生ページへ差し込むスクリプトは常に構文として正しい', () => {
  for (const context of [{}, { seedUrl: 'https://a.example/', capturedAt: '2020-01-01T00:00:00.000Z' }]) {
    const html = rewriteHtml('<head></head><main>x</main>', 'https://a.example/p?q=1', 'archive_t', { freezeResponsiveImages: true }, 'nav-1', context);
    for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(script));
  }
  assert.equal(archivedWebPath('archive_t', 'https://cdn.example/x/master.m3u8?token=1#t=3'), '/archive/archive_t/web/https://cdn.example/x/master.m3u8?token=1#t=3');
  const bridge = rewriteHtml('<head></head>', 'https://a.example/jp/', 'archive_t').match(/<script>([\s\S]*?)<\/script>/)[1];
  const messages = [];
  const context = {
    window: {}, Element: class { getAttribute() { return null; } setAttribute() {} }, URL, URLSearchParams,
    location: { href: 'http://127.0.0.1:43194/jp/', origin: 'http://127.0.0.1:43194', pathname: '/jp/', search: '', hash: '' },
    parent: { postMessage: (message) => messages.push(message) }, history: { pushState() {}, replaceState() {}, state: null },
    document: { addEventListener() {} }, addEventListener() {}, FormData: class {}
  };
  runInNewContext(bridge, context);
  context.window.open('https://a.example/archive/archive_t/web/https://a.example/jp/shop/item?x=1');
  assert.equal(messages.at(-1).url, 'https://a.example/jp/shop/item?x=1', '保存データのパスを元サイトへ付け直したURLも元のURLへ戻す');
  assert.equal(messages.at(-1).source, 'script', 'スクリプトによる移動は親が連続移動を制限できるよう区別する');
  const before = messages.length;
  context.window.open('about:blank');
  context.window.open('javascript:void(0)');
  assert.equal(messages.length, before, 'about:blankなど実在しないページへの移動は親へ送らない');
  assert.equal(new URL('url_0/low.m3u8', `http://127.0.0.1:43194${archivedWebPath('archive_t', 'https://cdn.example/x/master.m3u8')}`).pathname, '/archive/archive_t/web/https://cdn.example/x/url_0/low.m3u8');
});

async function replayFixture(t, html, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-replay-fidelity-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const id = 'archive_replay_fidelity';
  const page = await store.writeBlob(id, Buffer.from(html));
  const resources = {};
  for (const [url, body] of Object.entries(extra.resources || {})) {
    const blob = await store.writeBlob(id, Buffer.from(body.body));
    resources[url] = { url, status: 200, headers: { 'content-type': body.type }, mimeType: body.type, ...blob };
  }
  const pages = [{ url: 'https://shop.example/shop/item', requestedUrl: 'https://shop.example/shop/item', html: page.file, ...(extra.capturedAt ? { capturedAt: extra.capturedAt } : {}) }];
  for (const item of extra.pages || []) {
    const { htmlBody, ...record } = item;
    pages.push({ requestedUrl: item.url, ...record, html: htmlBody ? (await store.writeBlob(id, Buffer.from(htmlBody))).file : null });
  }
  const resourceVariants = {};
  for (const [url, list] of Object.entries(extra.variants || {})) {
    resourceVariants[url] = [];
    for (const variant of list) {
      const blob = await store.writeBlob(id, Buffer.from(variant.body));
      resourceVariants[url].push({ status: 200, headers: { 'content-type': variant.type }, mimeType: variant.type, pages: variant.pages, ...blob });
    }
  }
  await store.writeManifest(id, { id, startUrl: 'https://shop.example/shop/item', options: {}, resources, resourceAliases: {}, resourceVariants, pages });
  const replayPort = await freePort();
  const server = http.createServer(createReplayHandler(store, { host: '127.0.0.1', port: 43193, replayPort, iframeParentOrigins: ['http://127.0.0.1:8090'] }));
  await new Promise((resolve) => server.listen(replayPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { id, base: `http://127.0.0.1:${replayPort}` };
}

test('再生ページは親アプリからの埋め込みを許可し、元のパスへの再読込を保存ページへ戻す', async (t) => {
  const { id, base } = await replayFixture(t, '<title>Item</title><iframe src="https://shop.example/embed.html"></iframe>', {
    resources: { 'https://shop.example/embed.html': { type: 'text/html; charset=utf-8', body: '<p>embedded</p>' } }
  });
  const page = await fetch(`${base}/archive/${id}/page?url=${encodeURIComponent('https://shop.example/shop/item')}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors [^;]*http:\/\/127\.0\.0\.1:8090/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors [^;]*http:\/\/127\.0\.0\.1:43193/);
  const cookie = page.headers.get('set-cookie').split(';')[0];
  const nested = await fetch(`${base}/archive/${id}/resource?url=${encodeURIComponent('https://shop.example/embed.html')}`);
  assert.match(nested.headers.get('content-security-policy') || '', /connect-src 'self'/, '入れ子の埋め込みにも同じ隔離を適用する');
  const reloaded = await fetch(`${base}/products/2?color=red`, { headers: { cookie, 'sec-fetch-dest': 'iframe' }, redirect: 'manual' });
  assert.equal(reloaded.status, 302);
  assert.equal(reloaded.headers.get('location'), `/archive/${id}/page?url=${encodeURIComponent('https://shop.example/products/2?color=red')}`);
  const asset = await fetch(`${base}/img/logo.png`, { headers: { cookie, 'sec-fetch-dest': 'image' }, redirect: 'manual' });
  assert.equal(asset.headers.get('location'), `/archive/${id}/web/https://shop.example/img/logo.png`);
  assert.equal((await fetch(`${base}/favicon.ico`, { headers: { cookie }, redirect: 'manual' })).status, 404);
  assert.equal((await fetch(`${base}/products/2`, { redirect: 'manual' })).status, 404);
});

test('PDFなどページ以外の保存ファイルは案内ページで開け、同じURLでもページごとに保存した版を返す', async (t) => {
  const { id, base } = await replayFixture(t, '<title>Item</title>', {
    resources: {
      'https://shop.example/docs/manual.pdf': { type: 'application/pdf', body: '%PDF-1.4 fixture' },
      'https://shop.example/api/state.json': { type: 'application/json', body: '{"page":"item"}' }
    },
    pages: [
      { url: 'https://shop.example/docs/manual.pdf', title: 'manual.pdf', file: true, mimeType: 'application/pdf' },
      { url: 'https://shop.example/other', title: 'Other', htmlBody: '<title>Other</title>' }
    ],
    variants: { 'https://shop.example/api/state.json': [{ type: 'application/json', body: '{"page":"other"}', pages: ['https://shop.example/other'] }] }
  });
  const pageOf = (url) => fetch(`${base}/archive/${id}/page?url=${encodeURIComponent(url)}`);
  const file = await pageOf('https://shop.example/docs/manual.pdf');
  assert.equal(file.status, 200);
  const fileHtml = await file.text();
  assert.match(fileHtml, /manual\.pdf/);
  assert.match(fileHtml, /application\/pdf/);
  assert.match(fileHtml, /webcapture-open-file/);
  assert.ok(fileHtml.includes(`/archive/${id}/web/https://shop.example/docs/manual.pdf`));
  assert.match(await (await pageOf('https://shop.example/api/state.json')).text(), /state\.json/, 'ページとして保存していない素材URLも開ける');
  assert.equal((await pageOf('https://shop.example/missing.pdf')).status, 404);
  const resourceWith = async (pageUrl) => {
    const cookie = (await pageOf(pageUrl)).headers.get('set-cookie').split(';')[0];
    return fetch(`${base}/archive/${id}/web/https://shop.example/api/state.json`, { headers: { cookie } });
  };
  const itemState = await resourceWith('https://shop.example/shop/item');
  assert.equal(await itemState.text(), '{"page":"item"}');
  assert.equal(itemState.headers.get('x-webcapture-resource-variant'), null);
  const otherState = await resourceWith('https://shop.example/other');
  assert.equal(await otherState.text(), '{"page":"other"}');
  assert.equal(otherState.headers.get('x-webcapture-resource-variant'), '1');
});

test('再生ページの乱数は保存時と同じ系列になり、時計は保存時刻から進む', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const pageUrl = 'https://shop.example/shop/item';
  const sandboxMath = Object.create(Math);
  runInNewContext(`(${installSeededRandom.toString()})(${pageSeed(pageUrl)})`, { window: {}, Math: sandboxMath });
  const expected = [sandboxMath.random(), sandboxMath.random()].map(String);
  const { id, base } = await replayFixture(t, '<title>Clock</title><body><script>document.body.dataset.first=String(Math.random());document.body.dataset.second=String(Math.random());document.body.dataset.year=String(new Date().getFullYear());document.body.dataset.now=String(Date.now())</script></body>', { capturedAt: '2020-05-01T00:00:00.000Z' });
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const replayed = await captureWithBrowser(`${base}/archive/${id}/page?url=${encodeURIComponent(pageUrl)}`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none', interactDuringCapture: false, deterministicRandom: false
  });
  assert.equal(replayed.html.match(/data-first="([^"]+)"/)[1], expected[0]);
  assert.equal(replayed.html.match(/data-second="([^"]+)"/)[1], expected[1]);
  assert.match(replayed.html, /data-year="2020"/);
  const now = Number(replayed.html.match(/data-now="(\d+)"/)[1]);
  assert.ok(now >= Date.parse('2020-05-01T00:00:00.000Z') && now < Date.parse('2020-05-01T00:10:00.000Z'), String(now));
});

test('未保存の計測用POSTは静かに空応答を返し、スクリプトで作るフォントは保存データから読む', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const { id, base } = await replayFixture(t, '<title>Telemetry</title><body><script>fetch("https://monorail-edge.shopifysvc.com/v1/produce",{method:"POST",body:"{}"}).then(r=>{document.body.dataset.telemetry=String(r.status)});fetch("https://shop.example/api/cart",{method:"POST",body:"{}"}).then(r=>{document.body.dataset.cart=String(r.status)});new FontFace("Saved","url(https://fonts.example/saved.woff2)").load().then(()=>{document.body.dataset.font="loaded"},()=>{document.body.dataset.font="failed"})</script></body>', {
    resources: { 'https://fonts.example/saved.woff2': { type: 'font/woff2', body: 'not-a-real-font' } }
  });
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const requested = [];
  const replayed = await captureWithBrowser(`${base}/archive/${id}/page?url=${encodeURIComponent('https://shop.example/shop/item')}`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none', interactDuringCapture: false, networkIdleMs: 500
  });
  for (const item of replayed.resources) requested.push(item.url);
  assert.match(replayed.html, /data-telemetry="204"/);
  assert.match(replayed.html, /data-cart="404"/, '計測以外の未保存POSTは欠落として正直に404を返す');
  assert.match(replayed.html, /data-font="(?:loaded|failed)"/);
  assert.ok(requested.some((url) => url.includes('/web/https://fonts.example/saved.woff2')), requested.join(', '));
  assert.ok(!requested.some((url) => url.startsWith('https://fonts.example/')), '外部のフォント配信へ直接取りに行かない');
});

test('SPAは元のパスで起動し、履歴移動を保持し、スクリプトによる外部への移動は止める', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const { id, base } = await replayFixture(t, '<title>SPA</title><body><script>document.body.dataset.route=location.pathname;history.pushState({},"","/products/2?tab=spec");document.body.dataset.pushed=location.pathname+location.search;history.pushState({},"","https://shop.example/cart");document.body.dataset.absolute=location.pathname;setTimeout(()=>{location.href="https://outside.example/escape";document.body.dataset.after="1"},50)</script></body>');
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const replayed = await captureWithBrowser(`${base}/archive/${id}/page?url=${encodeURIComponent('https://shop.example/shop/item')}`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none', interactDuringCapture: false,
    initialWaitMs: 400, networkIdleMs: 400
  });
  assert.match(replayed.html, /data-route="\/shop\/item"/);
  assert.match(replayed.html, /data-pushed="\/products\/2\?tab=spec"/);
  assert.match(replayed.html, /data-absolute="\/cart"/);
  assert.match(replayed.html, /data-after="1"/);
  assert.equal(new URL(replayed.url).origin, base, '外部サイトへ移動していない');
  assert.ok(!replayed.blocked.some((item) => /outside\.example/.test(item.url || '')), JSON.stringify(replayed.blocked));
});

test('アーカイブごとに別サイトの再生ホストを使い、別アーカイブの読み出しを拒否する', async (t) => {
  assert.equal(archiveReplayHost('archive_muemxx8n_45fe91ea5f'), 'a-muemxx8n-45fe91ea5f.localhost');
  assert.equal(archiveIdFromReplayHost('a-muemxx8n-45fe91ea5f.localhost'), 'archive_muemxx8n_45fe91ea5f');
  assert.equal(archiveIdFromReplayHost('evil.localhost'), null);
  const { id, base } = await replayFixture(t, '<title>Item</title>');
  const port = new URL(base).port;
  const request = (path, host, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers: { host, ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
    req.on('error', reject); req.end();
  });
  const ownHost = `${archiveReplayHost(id)}:${port}`;
  const page = await request(`/archive/${id}/page?url=${encodeURIComponent('https://shop.example/shop/item')}`, ownHost);
  assert.equal(page.statusCode, 200);
  assert.equal((await request(`/archive/archive_other_000/page?url=x`, ownHost)).statusCode, 403);
  assert.equal((await request(`/archive/${id}/page?url=x`, `a-zzz-111.localhost:${port}`)).statusCode, 403);
  const reload = await request('/products/9', ownHost, { 'sec-fetch-dest': 'iframe' });
  assert.equal(reload.statusCode, 302, 'Cookieが送られない別サイトの埋め込みでも、直前に表示したページから元のサイトを特定する');
  assert.equal(reload.headers.location, `/archive/${id}/page?url=${encodeURIComponent('https://shop.example/products/9')}`);
});

test('軽量表示はページのスクリプト・イベント属性・自動再生を止め、入れ子の埋め込みにも適用する', async (t) => {
  const { id, base } = await replayFixture(t, '<head><script>window.heavy=1</script></head><body onload="x()"><video autoplay src="/v.mp4"></video><iframe src="https://shop.example/embed.html"></iframe></body>', {
    resources: { 'https://shop.example/embed.html': { type: 'text/html; charset=utf-8', body: '<script>while(true){}</script><p>embedded</p>' } }
  });
  const light = await (await fetch(`${base}/archive/${id}/page?url=${encodeURIComponent('https://shop.example/shop/item')}&mode=light`)).text();
  const markup = light.replace(/<script>[\s\S]*?<\/script>/g, '');
  assert.doesNotMatch(markup, /window\.heavy|onload=|autoplay/);
  assert.match(markup, /data-webcapture-light/);
  const nested = await (await fetch(`${base}/archive/${id}/web/https://shop.example/embed.html`)).text();
  assert.doesNotMatch(nested.replace(/<script>[\s\S]*?<\/script>/g, ''), /while\(true\)/);
  await fetch(`${base}/archive/${id}/page?url=${encodeURIComponent('https://shop.example/shop/item')}`);
  const normalNested = await (await fetch(`${base}/archive/${id}/web/https://shop.example/embed.html`)).text();
  assert.match(normalNested, /while\(true\)/, '通常表示に戻すと入れ子も元どおり動く');
});

test('再生ページは応答確認を送り続け、処理が重いと親へ知らせる', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const { id, base } = await replayFixture(t, '<title>Busy</title><body><script>setInterval(()=>{const start=performance.now();while(performance.now()-start<850){}},900)</script></body>');
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const tab = await (await fetch(`http://127.0.0.1:${session.port}/json/new?about:blank`, { method: 'PUT' })).json();
  const client = await new CdpClient(tab.webSocketDebuggerUrl).connect();
  t.after(() => client.close());
  await client.send('Page.enable');
  await client.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__messages=[];addEventListener("message",e=>window.__messages.push(e.data&&e.data.type))' });
  await client.send('Page.navigate', { url: `${base}/archive/${id}/page?url=${encodeURIComponent('https://shop.example/shop/item')}` });
  let types = [];
  for (let attempt = 0; attempt < 30 && !types.includes('webcapture-heavy'); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    types = (await client.send('Runtime.evaluate', { expression: 'window.__messages||[]', returnByValue: true })).result.value || [];
  }
  assert.ok(types.includes('webcapture-heartbeat'), JSON.stringify(types));
  assert.ok(types.includes('webcapture-heavy'), JSON.stringify([...new Set(types)]));
});
