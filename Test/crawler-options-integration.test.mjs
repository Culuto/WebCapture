import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';

test('詳細設定を構造把握と本保存へ適用し、除外URLとWARC無効化を守る', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-options-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let activeRequests = 0;
  let requestCount = 0;
  let discoveryActiveMax = 0;
  const server = http.createServer((req, res) => {
    requestCount += 1;
    activeRequests += 1;
    if (requestCount <= 3) discoveryActiveMax = Math.max(discoveryActiveMax, activeRequests);
    res.once('finish', () => { activeRequests -= 1; });
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (req.url.startsWith('/a')) return res.end('<title>A</title><p>A page</p>');
      if (req.url.startsWith('/b')) return res.end('<title>B</title><p>B page</p>');
      if (req.url.startsWith('/excluded')) return res.end('<title>Excluded</title>');
      res.end('<title>Root</title><a href="/a?utm_source=test">A</a><a href="/b">B</a><a href="/excluded">除外</a>');
    }, 30);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const startUrl = `http://127.0.0.1:${server.address().port}/`;
  const store = await new VaultStore(root).init();
  const options = {
    ...DEFAULT_CAPTURE_OPTIONS,
    policyOptions: { allowPrivateForTests: true },
    captureRendered: false,
    respectRobots: false,
    discoveryMode: 'complete',
    discoveryConcurrency: 3,
    concurrency: 2,
    maxPages: 10,
    queryPolicy: 'drop-tracking',
    excludeUrlPatterns: ['*/excluded*'],
    warcEnabled: false
  };
  const job = await store.addJob({ startUrl, options });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(job.status, 'complete', JSON.stringify(manifest.blocked));
  assert.equal(job.pages, 3);
  assert.deepEqual(manifest.pages.map((page) => new URL(page.url).pathname).sort(), ['/', '/a', '/b']);
  assert.ok(discoveryActiveMax >= 2, `構造把握が並列化されていません: ${discoveryActiveMax}`);
  assert.ok(manifest.blocked.some((item) => item.url.includes('/excluded') && item.reason.includes('対象外')));
  assert.equal(manifest.options.discoveryConcurrency, 3);
  await assert.rejects(fs.stat(path.join(store.archiveRoot(job.archiveId), 'collection.warc.gz')), { code: 'ENOENT' });
});

for (const discoveryMode of ['immediate', 'complete']) {
test(`${discoveryMode}: 複数ページが同じログイン画面へ転送されても1回だけ保存して巡回を終了する`, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-login-redirect-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith('/private')) {
      res.writeHead(302, { location: `/login?return=${encodeURIComponent(req.url)}` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url?.startsWith('/login')) return res.end('<title>Login</title><a href="/private/again">ログイン</a>');
    res.end('<title>Root</title><a href="/private/a">A</a><a href="/private/b">B</a>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const startUrl = `http://127.0.0.1:${server.address().port}/`;
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl,
    options: {
      ...DEFAULT_CAPTURE_OPTIONS,
      policyOptions: { allowPrivateForTests: true },
      captureRendered: false,
      respectRobots: false,
      discoveryMode,
      concurrency: 2,
      maxPages: null,
      sameSiteMaxDepth: null
    }
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(job.status, 'complete-with-errors');
  assert.equal(job.errors, 0);
  assert.equal(manifest.pages.length, 2);
  assert.equal(manifest.pages.filter((page) => new URL(page.url).pathname === '/login').length, 1);
  assert.ok(manifest.blocked.some((item) => /ログイン誘導先は(?:保存|把握)済み/.test(item.reason)));
});
}

test('同じURLでもページごとに内容が違う応答と、リンク先のPDFを保存する', { timeout: 120000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-variants-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    if (req.url === '/manual.pdf') { res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end('%PDF-1.4 manual'); }
    if (req.url.startsWith('/state.css')) {
      const from = new URL(req.headers.referer || 'http://x/').pathname;
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`/* ${from} */ body{--page:"${from}"}`);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/other') return res.end('<title>Other</title><link rel="stylesheet" href="/state.css"><p>other</p>');
    res.end('<title>Root</title><link rel="stylesheet" href="/state.css"><a href="/other">Other</a><a href="/manual.pdf">PDF</a>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const startUrl = `http://127.0.0.1:${server.address().port}/`;
  const store = await new VaultStore(root).init();
  const job = await store.addJob({ startUrl, options: {
    ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, respectRobots: false, captureRendered: true,
    discoveryMode: 'immediate', concurrency: 1, maxPages: 10, screenshotMode: 'none', interactDuringCapture: false, hoverDuringCapture: false,
    disableBrowserCache: true, networkIdleMs: 300, networkIdleMaxMs: 3000, requestTimeoutMs: 30000
  } });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  const browser = await manager.browserInfo();
  if (!browser.available) return t.skip('Chrome / Edgeが見つかりません。');
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  const pdfPage = manifest.pages.find((page) => page.url.endsWith('/manual.pdf'));
  assert.ok(pdfPage?.file, JSON.stringify(manifest.pages.map((page) => [page.url, page.file])));
  assert.match(pdfPage.mimeType, /pdf/);
  assert.equal((await fs.readFile(path.join(store.archiveRoot(job.archiveId), manifest.resources[pdfPage.url].file), 'utf8')), '%PDF-1.4 manual');
  const cssUrl = `${startUrl}state.css`;
  const base = await fs.readFile(path.join(store.archiveRoot(job.archiveId), manifest.resources[cssUrl].file), 'utf8');
  const variants = manifest.resourceVariants?.[cssUrl] || [];
  assert.equal(variants.length, 1, JSON.stringify(manifest.resourceVariants));
  const variantBody = await fs.readFile(path.join(store.archiveRoot(job.archiveId), variants[0].file), 'utf8');
  assert.notEqual(base, variantBody);
  assert.ok(variants[0].pages.some((url) => url.endsWith('/other')));
  assert.match(variantBody, /\/other/);
});

test('並列保存は1ページ終わるごとに次のページを始め、遅いページの完了を待たない', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-pool-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const started = new Map();
  let slowFinishedAt = 0;
  let active = 0;
  let activeMax = 0;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    started.set(pathname, Date.now());
    active += 1;
    activeMax = Math.max(activeMax, active);
    res.once('finish', () => { active -= 1; });
    const reply = (html, delayMs = 20) => setTimeout(() => {
      if (pathname === '/slow') slowFinishedAt = Date.now();
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(html);
    }, delayMs);
    if (pathname === '/') return reply('<title>Root</title><a href="/slow">slow</a><a href="/fast">fast</a>');
    if (pathname === '/slow') return reply('<title>Slow</title><p>slow</p>', 2500);
    if (pathname === '/fast') return reply('<title>Fast</title><a href="/next-1">1</a><a href="/next-2">2</a>');
    if (pathname === '/next-1') return reply('<title>Next 1</title><a href="/next-3">3</a>');
    return reply(`<title>${pathname}</title>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl: `http://127.0.0.1:${server.address().port}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 2, maxPages: 20 }
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(job.status, 'complete', JSON.stringify(manifest.blocked));
  assert.deepEqual(manifest.pages.map((page) => new URL(page.url).pathname).sort(), ['/', '/fast', '/next-1', '/next-2', '/next-3', '/slow']);
  for (const pathname of ['/next-1', '/next-2', '/next-3']) {
    assert.ok(started.get(pathname) < slowFinishedAt, `${pathname} が遅いページの完了を待ってから始まった`);
  }
  assert.ok(activeMax <= 2, `同時保存数を超えた: ${activeMax}`);
  assert.deepEqual(job.inFlight, []);
  assert.equal(job.pages, 6);
});

test('一時停止した保存はアーカイブ一覧に一時停止として出て、再開して完了すると完了に変わる', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-paused-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (pathname === '/') return res.end('<title>Root</title><a href="/p1">1</a><a href="/p2">2</a><a href="/p3">3</a>');
      res.end(`<title>${pathname}</title>`);
    }, pathname === '/' ? 10 : 400);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl: `http://127.0.0.1:${server.address().port}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 1, maxPages: 10 }
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  const running = manager.run(job.id);
  while (!store.getArchive(job.archiveId)) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(store.getArchive(job.archiveId).status, 'running', '保存中の保存もアーカイブ一覧に出る');
  assert.ok(store.getArchive(job.archiveId).pages >= 1);
  await manager.pause(job.id);
  await running;
  const paused = store.getArchive(job.archiveId);
  assert.equal(paused?.status, 'paused');
  assert.ok(paused.pages >= 1);
  assert.equal(paused.partial, true);
  await assert.rejects(store.deleteArchive(job.archiveId), /停止してから削除/);
  await store.addArchive({ ...store.getArchive(job.archiveId), status: 'running' });
  await manager.publishInterruptedArchives();
  assert.equal(store.getArchive(job.archiveId).status, 'paused', '起動時に取り残された「保存中」を一時停止へ直す');
  await manager.resume(job.id);
  assert.equal(store.getArchive(job.archiveId).status, 'running');
  await manager.running.get(job.id);
  assert.equal(job.status, 'complete');
  assert.equal(store.getArchive(job.archiveId).status, 'complete');
  assert.equal(store.getArchive(job.archiveId).pages, 4);
});

test('一時的なエラーのページは記録して自動で取り直し、直らないページは回数上限で失敗として残す', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-retry-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    const count = (hits.get(pathname) || 0) + 1;
    hits.set(pathname, count);
    if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<title>Root</title><a href="/flaky">flaky</a><a href="/down">down</a><a href="/gone">gone</a>'); }
    if (pathname === '/flaky' && count < 3) { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<title>Busy</title>'); }
    if (pathname === '/down') { res.writeHead(429, { 'content-type': 'text/html' }); return res.end('<title>Too many</title>'); }
    if (pathname === '/gone') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('<title>Not found</title>'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<title>${pathname}</title><p>ok</p>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const base = `http://127.0.0.1:${server.address().port}`;
  const job = await store.addJob({
    startUrl: `${base}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 2, maxPages: 20, pageRetries: 2 }
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, pageRetryDelayMs: 50 });
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(hits.get('/flaky'), 3, '503が2回続いたあと3回目で取れる');
  assert.equal(hits.get('/down'), 4, '429は取り直し3回と完了前の自動修正1回まで試す');
  assert.equal(hits.get('/gone'), 1, '404は取り直さない');
  const flaky = manifest.pages.find((page) => page.url === `${base}/flaky`);
  assert.equal(flaky?.quality?.level === 'failed', false, '取り直したページは正常な内容で保存する');
  assert.equal(manifest.pageRetries[`${base}/flaky`].status, 'recovered');
  assert.equal(manifest.pageRetries[`${base}/flaky`].attempts, 3);
  assert.equal(manifest.pageRetries[`${base}/down`].attempts, 4);
  assert.equal(manifest.pageRetries[`${base}/down`].status, 'failed');
  assert.ok(manifest.pageRetries[`${base}/down`].reasons.some((reason) => reason.includes('429')));
  assert.equal(manifest.pageRetries[`${base}/gone`], undefined);
  assert.equal(job.queue.length, 0);
  assert.deepEqual(job.inFlight, []);
});

test('最適化モードはエラーのたびに同時保存数を下げ、見つかった数を報告する', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-optimize-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let active = 0;
  let activeMax = 0;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    active += 1;
    activeMax = Math.max(activeMax, active);
    res.once('finish', () => { active -= 1; });
    setTimeout(() => {
      if (pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(`<title>Root</title>${Array.from({ length: 12 }, (_, index) => `<a href="/p${index}">${index}</a><a href="/bad${index}">bad</a>`).join('')}`);
      }
      if (pathname.startsWith('/bad')) { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('<title>Busy</title>'); }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<title>${pathname}</title>`);
    }, 60);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl: `http://127.0.0.1:${server.address().port}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 30, discoveryConcurrency: 64, optimize: true, pageRetries: 0, maxPages: 100 }
  });
  const results = [];
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, globalCaptureConcurrency: 30, tuningCooldownMs: 0, onTuningResult: (result) => results.push(result) });
  await manager.run(job.id);
  assert.equal(job.status, 'complete-with-errors');
  assert.ok(job.tuning.capture < 30, `エラーで下がっていない: ${job.tuning.capture}`);
  assert.equal(job.tuning.capture, 30 - job.tuning.reductionCount);
  assert.equal(job.tuning.reductionCount, 12);
  assert.ok(activeMax > 4, `最初は多い並列で始まる: ${activeMax}`);
  assert.equal(results.length, 1);
  assert.deepEqual([results[0].capture, results[0].discovery], [job.tuning.capture, 64]);
  assert.equal(manager.tuners.size, 0);
});

test('保存用のChromeが途中で止まっても自動で起動し直し、残りのページを保存する', { timeout: 120000 }, async (t) => {
  const { findBrowser } = await import('../server/browser-capture.mjs');
  if (!await findBrowser()) return t.skip('Chrome / Edgeが見つかりません。');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-browser-restart-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (pathname === '/') return res.end('<title>Root</title><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a><a href="/d">d</a>');
    setTimeout(() => res.end(`<title>${pathname}</title><p>${pathname}</p>`), 300);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl: `http://127.0.0.1:${server.address().port}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: true, browserReuse: true, respectRobots: false, discoveryMode: 'immediate', concurrency: 2, maxPages: 10, screenshotMode: 'none', interactDuringCapture: false, hoverDuringCapture: false, initialWaitMs: 0, requestTimeoutMs: 30000 }
  });
  const sessions = [];
  let killed = false;
  const manager = new CrawlManager(store, {
    defaultLimits: DEFAULT_CAPTURE_OPTIONS, pageRetryDelayMs: 50,
    onBrowserSession: (session) => sessions.push(session)
  });
  const running = manager.run(job.id);
  while (job.pages < 1) await new Promise((resolve) => setTimeout(resolve, 20));
  sessions[0].handle.kill('SIGKILL');
  killed = true;
  await running;
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(killed, true);
  assert.ok(sessions.length >= 2, `Chromeを起動し直していない: ${sessions.length}`);
  assert.equal(job.status, 'complete', JSON.stringify(manifest.blocked));
  assert.deepEqual(manifest.pages.map((page) => new URL(page.url).pathname).sort(), ['/', '/a', '/b', '/c', '/d']);
});

test('開いたページが保存範囲外へ転送されたら、読み込み直後にやめて失敗ではなく保存対象外として記録する', { timeout: 120000 }, async (t) => {
  const { findBrowser } = await import('../server/browser-capture.mjs');
  if (!await findBrowser()) return t.skip('Chrome / Edgeが見つかりません。');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-early-scope-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const other = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<title>Other site</title><button type="button" aria-expanded="false">開く</button>'); });
  await new Promise((resolve) => other.listen(0, '127.0.0.2', resolve));
  t.after(() => new Promise((resolve) => other.close(resolve)));
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    if (pathname === '/go') { res.writeHead(302, { location: `http://127.0.0.2:${other.address().port}/landing` }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pathname === '/' ? '<title>Root</title><a href="/go">外へ</a><a href="/stay">中</a>' : `<title>${pathname}</title>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl: `http://127.0.0.1:${server.address().port}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: true, browserReuse: true, respectRobots: false, followExternal: false, discoveryMode: 'immediate', concurrency: 2, maxPages: 10, screenshotMode: 'none', hoverDuringCapture: false, requestTimeoutMs: 30000 }
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(job.status, 'complete', JSON.stringify(manifest.blocked));
  assert.equal(job.errors, 0, '範囲外への転送はエラーに数えない');
  assert.deepEqual(manifest.pages.map((page) => new URL(page.url).pathname).sort(), ['/', '/stay']);
  assert.ok(manifest.blocked.some((item) => item.reason.startsWith('転送先が保存範囲外のため保存しません') && item.url.includes('127.0.0.2')), JSON.stringify(manifest.blocked));
});

test('分散アクセスでは同じサイトへの同時アクセス数と間隔を守る', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-distributed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const starts = [];
  let active = 0;
  let activeMax = 0;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    starts.push(Date.now());
    active += 1;
    activeMax = Math.max(activeMax, active);
    res.once('finish', () => { active -= 1; });
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pathname === '/' ? `<title>Root</title>${[1, 2, 3, 4, 5].map((n) => `<a href="/p${n}">${n}</a>`).join('')}` : `<title>${pathname}</title>`);
    }, 150);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl: `http://127.0.0.1:${server.address().port}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 6, maxPages: 20, distributedAccess: true, perHostConcurrency: 1, perHostIntervalMs: 250 }
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  assert.equal(job.status, 'complete');
  assert.equal(job.pages, 6);
  assert.equal(activeMax, 1, '同じサイトへは1つずつ');
  const gaps = starts.slice(1).map((value, index) => value - starts[index]);
  assert.ok(gaps.every((gap) => gap >= 230), `間隔が短い: ${gaps.join(',')}`);
});

test('完了とする前に、失敗したページと取れなかった素材を同じ保存の中で取り直す', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-repair-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    const count = (hits.get(pathname) || 0) + 1;
    hits.set(pathname, count);
    if (pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<title>Root</title><img src="/late.png"><a href="/unstable">unstable</a>'); }
    if (pathname === '/unstable' && count <= 3) { res.socket.destroy(); return; }
    if (pathname === '/late.png' && count <= 1) { res.writeHead(500); res.end(); return; }
    if (pathname === '/late.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('png-bytes')); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<title>${pathname}</title><p>ok</p>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const base = `http://127.0.0.1:${server.address().port}`;
  const job = await store.addJob({
    startUrl: `${base}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 2, maxPages: 10, pageRetries: 2 }
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, pageRetryDelayMs: 30 });
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  assert.deepEqual(manifest.pages.map((page) => new URL(page.url).pathname).sort(), ['/', '/unstable'], JSON.stringify(manifest.blocked));
  assert.equal(hits.get('/unstable'), 4, '取り直し2回で失敗したあと、完了前の自動修正で取れた');
  assert.equal(manifest.pageRetries[`${base}/unstable`].status, 'recovered');
  assert.equal(job.errors, 0, '自動修正で取れたページはエラーに数えない');
  assert.equal(job.status, 'complete', JSON.stringify(manifest.blocked));
  assert.ok(manifest.resources[`${base}/late.png`]?.size > 0, '取れなかった素材も完了前に取り直す');
  assert.equal(manifest.blocked.some((item) => item.url === `${base}/late.png`), false);
});

test('分散アクセスで同じサイトへの同時アクセスを無制限にすると、同時保存数まで並行して開く', { timeout: 60000 }, async (t) => {
  const { sanitizeCaptureOptions } = await import('../server/capture-options.mjs');
  assert.equal(sanitizeCaptureOptions({ perHostConcurrency: 0 }).perHostConcurrency, 0);
  assert.equal(sanitizeCaptureOptions({ perHostConcurrency: 'unlimited' }).perHostConcurrency, 0);
  assert.equal(sanitizeCaptureOptions({}).perHostConcurrency, 2);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-crawler-unlimited-host-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let active = 0;
  let activeMax = 0;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    active += 1;
    activeMax = Math.max(activeMax, active);
    res.once('finish', () => { active -= 1; });
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pathname === '/' ? `<title>Root</title>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<a href="/p${n}">${n}</a>`).join('')}` : `<title>${pathname}</title>`);
    }, 300);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const job = await store.addJob({
    startUrl: `http://127.0.0.1:${server.address().port}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 4, maxPages: 20, distributedAccess: true, perHostConcurrency: 0, perHostIntervalMs: 0 }
  });
  await new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS }).run(job.id);
  assert.equal(job.status, 'complete');
  assert.equal(job.pages, 9);
  assert.equal(activeMax, 4, `同時保存数まで並行して開く: ${activeMax}`);
});
