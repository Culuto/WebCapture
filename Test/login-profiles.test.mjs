import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { CdpClient, createBrowserCaptureSession, findBrowser } from '../server/browser-capture.mjs';
import { LoginProfiles, parseCookieText } from '../server/login-profiles.mjs';

test('貼り付けたCookieを3つの形式で読み取り、期限のないものには期限を付ける', () => {
  const json = parseCookieText(JSON.stringify([{ name: 'sid', value: 'a', domain: '.example.com', path: '/', secure: true, httpOnly: true, expirationDate: 2000000000, sameSite: 'lax' }]));
  assert.deepEqual(json[0], { name: 'sid', value: 'a', domain: '.example.com', path: '/', secure: true, httpOnly: true, expires: 2000000000, sameSite: 'Lax' });
  const netscape = parseCookieText('# Netscape HTTP Cookie File\n#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\ttoken\tb');
  assert.equal(netscape[0].httpOnly, true);
  assert.equal(netscape[0].name, 'token');
  assert.ok(netscape[0].expires > Date.now() / 1000, '期限のないCookieは30日の期限を付ける');
  const header = parseCookieText('a=1; b=two=2', 'https://example.com/path');
  assert.deepEqual(header.map((item) => [item.name, item.value, item.domain, item.secure]), [['a', '1', 'example.com', true], ['b', 'two=2', 'example.com', true]]);
  assert.throws(() => parseCookieText('a=1'), /URLが必要/);
  assert.throws(() => parseCookieText(''), /入力されていません/);
});

test('貼り付けたCookieでログイン状態のページを保存し、アーカイブに印を付ける', { timeout: 120000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-login-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/robots.txt') return res.end('');
    const loggedIn = /(?:^|;\s*)session=secret-value(?:;|$)/.test(req.headers.cookie || '');
    res.end(`<title>Members</title><p>${loggedIn ? 'ログイン済みの会員ページ' : '未ログイン'}</p>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const logins = new LoginProfiles({ dataRoot: root, findBrowser, createSession: (options) => createBrowserCaptureSession({ ...options, policyOptions: { allowPrivateForTests: true } }), CdpClient });
  const profile = await logins.importPastedCookies({ name: 'テスト会員', text: 'session=secret-value', siteUrl: `${base}/` });
  assert.equal(profile.method, 'paste');
  const listed = await logins.list();
  assert.equal(listed.length, 1);
  assert.equal(JSON.stringify(listed).includes('secret-value'), false, '一覧にはCookieの中身を残さない');
  const store = await new VaultStore(path.join(root, 'data')).init();
  const run = async (loginProfileId) => {
    const job = await store.addJob({ startUrl: `${base}/`, options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: true, respectRobots: false, discoveryMode: 'immediate', maxPages: 1, screenshotMode: 'none', interactDuringCapture: false, hoverDuringCapture: false, loginProfileId } });
    await new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, loginProfiles: logins }).run(job.id);
    const manifest = await store.readManifest(job.archiveId);
    const html = await fs.readFile(path.join(store.archiveRoot(job.archiveId), manifest.pages[0].html), 'utf8');
    return { html, archive: store.getArchive(job.archiveId) };
  };
  const loggedIn = await run(profile.id);
  assert.match(loggedIn.html, /ログイン済みの会員ページ/);
  assert.equal(loggedIn.archive.loggedIn, true);
  const anonymous = await run(null);
  assert.match(anonymous.html, /未ログイン/);
  assert.equal(anonymous.archive.loggedIn, undefined);
  await logins.remove(profile.id);
  assert.deepEqual(await logins.list(), []);
});

test('専用ブラウザでのログインはサイト指定なしで検索ページを開き、閉じると登録が完了する', async (t) => {
  const { EventEmitter } = await import('node:events');
  const { LOGIN_START_URL } = await import('../server/login-profiles.mjs');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-login-window-'));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const launches = [];
  let child;
  const logins = new LoginProfiles({
    dataRoot: root, findBrowser: async () => 'chrome.exe', createSession: null, CdpClient: null,
    spawn: (executable, args) => { launches.push({ executable, args }); child = new EventEmitter(); return child; }
  });
  const opened = await logins.openLoginWindow({ name: 'サンプル' });
  assert.equal(opened.status, 'waiting');
  assert.equal(launches[0].args.at(-1), LOGIN_START_URL, 'URLを指定しなければ検索ページを開く');
  assert.ok(launches[0].args.some((arg) => arg.startsWith('--user-data-dir=') && arg.includes(opened.id)), '専用のプロファイルを使う');
  await assert.rejects(logins.openLoginWindow({ id: opened.id }), /すでに開いています/);
  child.emit('exit', 0);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal((await logins.get(opened.id)).status, 'ready', 'ウィンドウを閉じると登録完了');
  await logins.openLoginWindow({ id: opened.id });
  assert.equal(launches.length, 2, '登録済みのものも開き直せる');
  const restarted = await new LoginProfiles({ dataRoot: root, findBrowser: async () => 'chrome.exe', createSession: null, CdpClient: null, spawn: () => new EventEmitter() }).init();
  assert.equal((await restarted.get(opened.id)).status, 'ready', 'サーバー再起動後は「開いている」のまま残さない');
  child.emit('exit', 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
});
