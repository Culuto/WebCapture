import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS, sanitizeCaptureOptions } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { findBrowser } from '../server/browser-capture.mjs';

async function site(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-discovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stats = { hits: new Map(), active: 0, maxActive: 0 };
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    stats.hits.set(pathname, (stats.hits.get(pathname) || 0) + 1);
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    res.once('close', () => { stats.active -= 1; });
    handler(pathname, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  return { store, stats, base: `http://127.0.0.1:${server.address().port}` };
}

const page = (res, body, delay = 0) => setTimeout(() => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); }, delay);

test('設定：把握だけのモードと把握の方式を受け付け、軽い方式は同時256まで', () => {
  const options = sanitizeCaptureOptions({ discoveryMode: 'separate', discoveryMethod: 'browser', discoveryConcurrency: 999 });
  assert.equal(options.discoveryMode, 'separate');
  assert.equal(options.discoveryMethod, 'browser');
  assert.equal(options.discoveryConcurrency, 256);
  assert.equal(sanitizeCaptureOptions({ discoveryMethod: 'x' }).discoveryMethod, 'http');
});

test('把握だけ：保存は一切せずに多数を同時に調べ、サイトごとの件数を出し、あとで選んで保存を始められる', { timeout: 90000 }, async (t) => {
  const { store, stats, base } = await site(t, (pathname, res) => {
    if (pathname === '/') return page(res, `<title>Root</title>${Array.from({ length: 120 }, (_, index) => `<a href="/p${index}">${index}</a>`).join('')}<img src="/big.png">`);
    if (pathname === '/p0') return page(res, '<title>slow</title><a href="/deep">deep</a>', 1500);
    page(res, `<title>${pathname}</title><img src="/big.png">`, 150);
  });
  const job = await store.addJob({
    startUrl: `${base}/`,
    options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'separate', discoveryMethod: 'http', discoveryConcurrency: 200, concurrency: 8, maxPages: null, sameSiteWarningDepth: null }
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, globalDiscoveryConcurrency: 256 });
  await manager.run(job.id);
  assert.equal(job.status, 'discovered', job.message);
  assert.equal(job.discoveredPages, 122);
  assert.ok(stats.maxActive > 64, `同時に調べた数: ${stats.maxActive}`);
  assert.equal(stats.hits.get('/big.png'), undefined, '把握では画像などを取得しない');
  const host = new URL(base).hostname;
  assert.deepEqual(job.discoveryHosts, [{ host, count: 122 }]);
  assert.equal((await store.readManifest(job.archiveId))?.pages?.length || 0, 0, '把握だけでは保存しない');
  assert.equal(store.getArchive(job.archiveId), undefined);
  assert.equal(store.listJobSummaries({ activeOnly: true }).some((item) => item.id === job.id), true, '確認待ちとして画面に出る');
  await assert.rejects(manager.startCaptureFromDiscovery(job.id, { excludeHosts: [host] }), { code: 'NOTHING_TO_CAPTURE' });
  await manager.startCaptureFromDiscovery(job.id);
  await manager.running.get(job.id);
  assert.equal(job.status, 'complete', job.message);
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(manifest.pages.length, 122);
  assert.equal(stats.hits.get('/p5'), 2, '把握で1回・保存で1回');
});

test('把握だけ：把握結果を破棄するとアーカイブを作らない', { timeout: 60000 }, async (t) => {
  const { store, base } = await site(t, (pathname, res) => page(res, pathname === '/' ? '<a href="/a">a</a>' : '<title>a</title>'));
  const job = await store.addJob({ startUrl: `${base}/`, options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'separate' } });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  assert.equal(job.status, 'discovered');
  await manager.cancel(job.id);
  assert.equal(job.status, 'cancelled');
  assert.equal(store.getArchive(job.archiveId), undefined);
});

test('正確な把握：ブラウザで表示してJavaScriptで作られるリンクも拾う（画像や動画は読み込まない）', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const { store, stats, base } = await site(t, (pathname, res) => {
    if (pathname === '/') return page(res, '<title>Root</title><a href="/static">static</a><img src="/photo.png"><script>const a=document.createElement("a");a.href="/js-only";a.textContent="js";document.body.append(a)</script>');
    page(res, `<title>${pathname}</title>`);
  });
  const options = { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'separate' };
  const httpJob = await store.addJob({ startUrl: `${base}/`, options: { ...options, discoveryMethod: 'http' } });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(httpJob.id);
  assert.equal(httpJob.discoveredPages, 2, '軽い方式はJavaScriptのリンクを見落とす');
  const browserJob = await store.addJob({ startUrl: `${base}/`, options: { ...options, discoveryMethod: 'browser' } });
  await manager.run(browserJob.id);
  assert.equal(browserJob.status, 'discovered', browserJob.message);
  assert.equal(browserJob.discoveredPages, 3, JSON.stringify(browserJob.discoveryHosts));
  assert.equal(stats.hits.get('/js-only'), 1);
  assert.equal(stats.hits.get('/photo.png'), undefined, '正確な方式でも画像は読み込まない');
});
