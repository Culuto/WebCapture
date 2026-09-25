import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { redirectChainExternalDepth, savedPageForMissingUrl } from '../server/policy.mjs';
import { createReplayHandler, rewriteHtml } from '../server/replay.mjs';
import { CdpClient, createBrowserCaptureSession, findBrowser, freePort } from '../server/browser-capture.mjs';

const token = (seed) => `eyJhbGciOiJIUzI1NiJ9.eyJzZWVkIjoi${seed}fQ.c2lnbmF0dXJlLXNlZWQt${seed}`;

test('転送の途中で元のサイトや別のサイトを経由しても、リンク1本の移動として外部の階層を数える', () => {
  const start = 'https://store.example/';
  assert.equal(redirectChainExternalDepth({ startUrl: start, requestedUrl: 'https://shopify.example/1/account/profile', requestedExternalDepth: 1, finalUrl: 'https://shopify.example/authentication/1/login' }), 1, '同じサイトに戻るなら階層は増えない');
  assert.equal(redirectChainExternalDepth({ startUrl: start, requestedUrl: 'https://store.example/account', requestedExternalDepth: 0, finalUrl: 'https://shopify.example/login' }), 1, '元のサイトから外部へ転送されたら1');
  assert.equal(redirectChainExternalDepth({ startUrl: start, requestedUrl: 'https://a.example/x', requestedExternalDepth: 1, finalUrl: 'https://b.example/y' }), 2, '外部から別の外部へ転送されたら1つ増える');
  assert.equal(redirectChainExternalDepth({ startUrl: start, requestedUrl: 'https://a.example/x', requestedExternalDepth: 1, finalUrl: 'https://store.example/back' }), 0);
});

test('保存：外部→元のサイト→別の外部→元の外部と転送されるリンクも、外部リンクの深さ1で保存する', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-chain-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const servers = [];
  const listen = async (host, handler) => {
    const server = http.createServer(handler);
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); }); }
    catch { return null; }
    servers.push(server);
    return `http://${host}:${server.address().port}`;
  };
  t.after(() => Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))));
  const hosts = {};
  const html = (res, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };
  const redirect = (res, location) => { res.writeHead(302, { location }); res.end(); };
  const pathOf = (req) => new URL(req.url, 'http://x').pathname;
  hosts.store = await listen('127.0.0.1', (req, res) => {
    const pathname = pathOf(req);
    if (pathname === '/') return html(res, `<title>Store</title><a href="${hosts.shopify}/account/profile?buyer_flags=${token('AAAAAAAA')}">profile</a>`);
    if (pathname === '/login_with_shop/start') return redirect(res, `${hosts.shop}/bounce`);
    if (pathname === '/login_with_shop/complete') return redirect(res, `${hosts.shopify}/authentication/login`);
    res.writeHead(404); res.end();
  });
  hosts.shopify = await listen('127.0.0.2', (req, res) => {
    const pathname = pathOf(req);
    if (pathname === '/account/profile') return redirect(res, `${hosts.store}/login_with_shop/start`);
    if (pathname === '/authentication/login') return html(res, '<title>Log in</title><form><input type="password"></form>');
    res.writeHead(404); res.end();
  });
  hosts.shop = await listen('127.0.0.3', (req, res) => {
    if (pathOf(req) === '/bounce') return redirect(res, `${hosts.store}/login_with_shop/complete`);
    res.writeHead(404); res.end();
  });
  if (!hosts.shopify || !hosts.shop) return t.skip('127.0.0.2 / 127.0.0.3 を待ち受けできない環境');
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl: `${hosts.store}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 1, maxPages: 10, followExternal: true, externalMaxDepth: 1, autoExcludeAccountPages: false, distributedAccess: false }
  });
  await new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS }).run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  const login = manifest.pages.find((page) => page.url === `${hosts.shopify}/authentication/login`);
  assert.ok(login, JSON.stringify(manifest.blocked));
  assert.equal(login.externalDepth, 1);
  assert.equal(savedPageForMissingUrl(manifest, `${hosts.shopify}/account/profile?buyer_flags=${token('BBBBBBBB')}`)?.url, login.url, '鍵違いのプロフィールリンクもログイン画面へ案内する');
  assert.ok(!Object.values(manifest.pageRetries || {}).some((item) => item.status === 'retrying'));
});

test('再生：保存時の部品の中身（Shadow DOM）はそのまま復元せず予備として持つ', () => {
  const output = rewriteHtml('<head></head><x-a><template shadowrootmode="open" shadowrootdelegatesfocus><p>snap</p></template></x-a><template id="t"><p>plain</p></template>', 'https://a.example/', 'archive_t', {}, '', {});
  assert.match(output, /<x-a><template data-webcapture-shadowrootmode="open" data-webcapture-shadowrootdelegatesfocus><p>snap<\/p><\/template><\/x-a>/);
  assert.match(output, /<template id="t"><p>plain<\/p><\/template>/, '普通のtemplateは変えない');
  for (const [, script] of output.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new Function(script));
});

test('再生：部品が自分で描けるときは任せ、描けないときだけ保存時の中身を戻す（実際のChrome）', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-shadow-fallback-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const id = 'archive_shadow_fallback';
  const pageHtml = `<!doctype html><title>Shadow</title>
    <x-live><template shadowrootmode="open"><p id="state">保存時の古い中身</p></template></x-live>
    <script>window.__peek = document.querySelector('x-live').shadowRoot === null ? 'empty' : 'snapshot';</script>
    <x-dead><template shadowrootmode="open"><p id="state">保存時の中身</p><x-inner><template shadowrootmode="open"><b id="inner">入れ子の中身</b></template></x-inner></template></x-dead>
    <div id="plain-host"><template shadowrootmode="open"><i id="plain">普通の要素の中身</i></template></div>
    <x-hydrate><template shadowrootmode="open"><p id="state">宣言的な中身</p></template></x-hydrate>
    <script>customElements.define('x-hydrate', class extends HTMLElement { connectedCallback() { const root = this.shadowRoot; this.dataset.found = root ? root.querySelector('#state').textContent : 'missing'; } });</script>
    <script>customElements.define('x-live', class extends HTMLElement { constructor() { super(); const root = this.attachShadow({ mode: 'open' }); if (root.querySelector('#state')) { this.dataset.skipped = 'true'; return; } root.innerHTML = '<p id="state">部品が描いた新しい中身</p>'; } });</script>`;
  const blob = await store.writeBlob(id, Buffer.from(pageHtml));
  await store.writeManifest(id, { id, startUrl: 'https://shadow.example/', options: {}, resources: {}, resourceAliases: {}, pages: [{ url: 'https://shadow.example/', requestedUrl: 'https://shadow.example/', html: blob.file }] });
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
  await client.send('Page.navigate', { url: `http://127.0.0.1:${replayPort}/archive/${id}/page?url=${encodeURIComponent('https://shadow.example/')}` });
  let state = null;
  for (let attempt = 0; attempt < 48; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    state = (await client.send('Runtime.evaluate', { returnByValue: true, expression: `({
      live: document.querySelector('x-live')?.shadowRoot?.querySelector('#state')?.textContent || null,
      skipped: document.querySelector('x-live')?.dataset.skipped || null,
      dead: document.querySelector('x-dead')?.shadowRoot?.querySelector('#state')?.textContent || null,
      inner: document.querySelector('x-dead')?.shadowRoot?.querySelector('x-inner')?.shadowRoot?.querySelector('#inner')?.textContent || null,
      plain: document.querySelector('#plain-host')?.shadowRoot?.querySelector('#plain')?.textContent || null,
      leftovers: document.querySelectorAll('template[data-webcapture-shadowrootmode]').length,
      hydrate: document.querySelector('x-hydrate')?.dataset.found || null,
      peek: window.__peek || null
    })` })).result.value;
    if (state.dead && state.inner && state.plain) break;
  }
  assert.equal(state.live, '部品が描いた新しい中身', '動く部品は保存時の中身に邪魔されず自分で描く');
  assert.equal(state.skipped, null);
  assert.equal(state.dead, '保存時の中身', '動かない部品は保存時の中身を戻す');
  assert.equal(state.inner, '入れ子の中身');
  assert.equal(state.plain, '普通の要素の中身');
  assert.equal(state.leftovers, 0);
  assert.equal(state.hydrate, '宣言的な中身', '保存した中身を前提にする部品には、読みに来た時点で中身を渡す');
  assert.equal(state.peek, 'empty', 'まだ定義されていない部品を先に覗かれても、保存時の中身を渡さない');
});

test('Shopでログインの本人確認の枠（login_with_shop）は、欠落ではなく外部サービスの境界として数える', async () => {
  const { isServerBoundaryUrl } = await import('../server/quality.mjs');
  assert.equal(isServerBoundaryUrl('https://store.example/services/login_with_shop/authorize?analytics_context=loginWithShopEmbed'), true);
  assert.equal(isServerBoundaryUrl('https://store.example/products/item'), false);
});

test('再生：閉じた部品の中身はそのまま、ログインの入口URLは同じ入口から転送された保存済みログイン画面へ案内する', async () => {
  const { deferSnapshotShadowRoots } = await import('../server/shadow-fallback.mjs');
  assert.equal(deferSnapshotShadowRoots(' shadowrootmode="closed"'), ' shadowrootmode="closed"');
  assert.equal(deferSnapshotShadowRoots(' shadowrootmode="open"'), ' data-webcapture-shadowrootmode="open"');
  const login = { url: 'https://auth.example/1/login', requestedUrl: 'https://store.example/customer_authentication/redirect', html: 'x', quality: { classification: 'login-required' } };
  const manifest = { pages: [login, { url: 'https://store.example/', html: 'y', quality: { classification: 'normal' } }], blocked: [] };
  assert.equal(savedPageForMissingUrl(manifest, 'https://store.example/customer_authentication/login?acr_values=provider%3Ashop')?.url, login.url);
  assert.equal(savedPageForMissingUrl(manifest, 'https://store.example/products/a'), null);
  assert.equal(savedPageForMissingUrl(manifest, 'https://other.example/customer_authentication/login'), null, '別のサイトの入口には案内しない');
});
