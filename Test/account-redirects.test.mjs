import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { savedPageForMissingUrl, stableDocumentKey } from '../server/policy.mjs';
import { createReplayHandler } from '../server/replay.mjs';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser, freePort } from '../server/browser-capture.mjs';
import { WEBAUTHN_GUARD_SOURCE } from '../server/webauthn-guard.mjs';

const token = (seed) => `eyJhbGciOiJIUzI1NiJ9.eyJzZWVkIjoi${seed}fQ.c2lnbmF0dXJlLXNlZWQt${seed}`;

test('使い捨ての鍵（JWT・計測ID）だけが違うURLは同じページとして扱う', () => {
  const a = `https://shopify.com/1/account/profile?locale=ja&buyer_flags=${token('AAAAAAAA')}`;
  const b = `https://shopify.com/1/account/profile?locale=ja&buyer_flags=${token('BBBBBBBB')}`;
  assert.equal(stableDocumentKey(a), stableDocumentKey(b));
  assert.equal(stableDocumentKey(a), 'https://shopify.com/1/account/profile?locale=ja');
  assert.notEqual(stableDocumentKey('https://a.example/list?page=1'), stableDocumentKey('https://a.example/list?page=2'), '意味のある条件は区別する');
  assert.equal(stableDocumentKey('https://a.example/p?id=10'), 'https://a.example/p?id=10');
  assert.equal(stableDocumentKey('not a url'), 'not a url');
});

test('保存済みのログイン画面へ転送されたリンクは、鍵が違っても保存済みページへ案内する', () => {
  const login = 'https://shopify.com/authentication/1/login?locale=ja';
  const manifest = {
    pages: [{ url: login, requestedUrl: 'https://store.example/customer_authentication/redirect', html: 'x' }, { url: 'https://store.example/', requestedUrl: 'https://store.example/', html: 'y' }],
    blocked: [
      { url: `https://shopify.com/1/account/profile?buyer_flags=${token('AAAAAAAA')}`, reason: `ログイン誘導先は保存済みです: ${login}` },
      { url: 'https://store.example/old', reason: '転送先は保存済みです: https://store.example/' },
      { url: 'https://store.example/broken', reason: '転送先は保存済みです: https://store.example/not-saved' }
    ]
  };
  assert.equal(savedPageForMissingUrl(manifest, `https://shopify.com/1/account/profile?buyer_flags=${token('AAAAAAAA')}`)?.url, login);
  assert.equal(savedPageForMissingUrl(manifest, `https://shopify.com/1/account/profile?buyer_flags=${token('CCCCCCCC')}`)?.url, login, '別の鍵のリンクも同じ行き先へ');
  assert.equal(savedPageForMissingUrl(manifest, 'https://store.example/old')?.url, 'https://store.example/');
  assert.equal(savedPageForMissingUrl(manifest, 'https://store.example/broken'), null, '行き先が保存されていなければ案内しない');
  assert.equal(savedPageForMissingUrl(manifest, 'https://store.example/unknown'), null);
});

test('再生：保存済みページへ転送されたURLを開くと、そのページへ移動する', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-account-replay-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const id = 'archive_account_redirects';
  const login = 'https://shop.example/authentication/login';
  const blob = await store.writeBlob(id, Buffer.from('<title>Login</title><p>login</p>'));
  const profile = `https://shop.example/account/profile?buyer_flags=${token('AAAAAAAA')}`;
  await store.writeManifest(id, {
    id, startUrl: 'https://shop.example/', options: {}, resources: {}, resourceAliases: {},
    pages: [{ url: login, requestedUrl: login, html: blob.file }],
    blocked: [{ url: profile, reason: `ログイン誘導先は保存済みです: ${login}` }]
  });
  const replayPort = await freePort();
  const server = http.createServer(createReplayHandler(store, { host: '127.0.0.1', port: 43193, replayPort, iframeParentOrigins: [] }));
  await new Promise((resolve) => server.listen(replayPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${replayPort}`;
  const other = `https://shop.example/account/profile?buyer_flags=${token('ZZZZZZZZ')}`;
  const response = await fetch(`${base}/archive/${id}/page?url=${encodeURIComponent(other)}&navigationId=n1`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), `/archive/${id}/page?url=${encodeURIComponent(login)}&navigationId=n1`);
  const missing = await fetch(`${base}/archive/${id}/page?url=${encodeURIComponent('https://shop.example/nothing')}`, { redirect: 'manual' });
  assert.equal(missing.status, 404, '本当に保存していないページは従来どおり「保存されていません」');
  const page = await (await fetch(`${base}/archive/${id}/page?url=${encodeURIComponent(login)}`)).text();
  assert.ok(page.includes('Passkeys and security keys are disabled in WebCapture.'), '再生ページでもパスキーを呼ばない');
});

test('保存：鍵違いのアカウントURLは1回だけ開き、取り直し後に保存済みログイン画面へ転送されたら「取り直し中」を残さない', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-account-crawl-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    const count = (hits.get(pathname) || 0) + 1;
    hits.set(pathname, count);
    if (pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<title>Root</title><a href="/login">login</a><a href="/account/profile?buyer_flags=${token('AAAAAAAA')}">p1</a><a href="/account/profile?buyer_flags=${token('BBBBBBBB')}">p2</a><a href="/account/orders?buyer_flags=${token('AAAAAAAA')}">orders</a>`);
    }
    if (pathname === '/login') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<title>Login</title><form><input type="password"></form>'); }
    if (pathname === '/account/orders' && count === 1) { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<title>Busy</title>'); }
    if (pathname.startsWith('/account/')) { res.writeHead(302, { location: '/login?return_to=account' }); return res.end(); }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl: `${base}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 1, maxPages: 20, pageRetries: 2, autoExcludeAccountPages: false }
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, pageRetryDelayMs: 30 });
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(hits.get('/account/profile'), 1, '鍵だけ違うプロフィールは1回だけ開く');
  assert.ok(manifest.blocked.some((item) => item.url.includes('/account/profile') && item.reason.startsWith('ログイン誘導先は保存済みです')), JSON.stringify(manifest.blocked));
  const orders = Object.values(manifest.pageRetries || {}).find((item) => item.url.includes('/account/orders'));
  assert.equal(orders?.status, 'recovered', JSON.stringify(manifest.pageRetries));
  assert.ok(!Object.values(manifest.pageRetries || {}).some((item) => item.status === 'retrying'), '完了後に「取り直し中」が残らない');
  assert.equal(savedPageForMissingUrl(manifest, `${base}/account/profile?buyer_flags=${token('BBBBBBBB')}`)?.url, `${base}/login`);
});

test('パスキー呼び出しは拒否し、ほかの認証情報の呼び出しは元の処理へ渡す', async () => {
  const calls = [];
  class DOMException extends Error { constructor(message, name) { super(message); this.name = name; } }
  const credentials = { get: (options) => { calls.push(['get', options]); return Promise.resolve('password-credential'); }, create: () => Promise.resolve('created') };
  const PublicKeyCredential = { isConditionalMediationAvailable: () => Promise.resolve(true), isUserVerifyingPlatformAuthenticatorAvailable: () => Promise.resolve(true) };
  const context = { navigator: { credentials }, window: { PublicKeyCredential }, DOMException, Promise, Object };
  runInNewContext(WEBAUTHN_GUARD_SOURCE, context);
  await assert.rejects(credentials.get({ publicKey: { challenge: new Uint8Array(1) } }), { name: 'NotAllowedError' });
  await assert.rejects(credentials.get({ publicKey: {}, mediation: 'conditional' }), { name: 'NotAllowedError' });
  await assert.rejects(credentials.create({ publicKey: {} }), { name: 'NotAllowedError' });
  assert.equal(await credentials.get({ password: true }), 'password-credential');
  assert.equal(calls.length, 1, 'パスキー以外はそのまま');
  assert.equal(await PublicKeyCredential.isConditionalMediationAvailable(), false);
  assert.equal(await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(), false);
});

test('保存用Chromeでは、ページがパスキーを求めてもWindowsの画面を出さずに拒否される', { timeout: 60000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Passkey</title><iframe src="/frame"></iframe><script>
      navigator.credentials.get({ publicKey: { challenge: new Uint8Array(16), timeout: 60000, userVerification: 'required' } }).then(() => { document.body.dataset.passkey = 'resolved'; }, (error) => { document.body.dataset.passkey = error.name; });
      PublicKeyCredential.isConditionalMediationAvailable().then((value) => { document.body.dataset.conditional = String(value); });
    </script>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const started = Date.now();
  const capture = await captureWithBrowser(`http://127.0.0.1:${server.address().port}/`, { session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none', interactionsEnabled: false });
  assert.match(capture.html, /data-passkey="NotAllowedError"/);
  assert.match(capture.html, /data-conditional="false"/);
  assert.ok(Date.now() - started < 20000, 'パスキーの確認待ちで止まらない');
});
