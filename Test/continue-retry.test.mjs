import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { buildRetryPlan, retryQueue, summarizeRetryPlan } from '../server/retry-plan.mjs';
import { summarizeArchiveQuality, completionStatus } from '../server/quality.mjs';
import { computeStorageSummary, resourceCategory } from '../server/storage-summary.mjs';

const baseOptions = { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 1, maxPages: 50, autoExcludeAccountPages: false };

async function fixture(t, handler) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-continue-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const hits = new Map();
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    hits.set(pathname, (hits.get(pathname) || 0) + 1);
    handler(pathname, req, res, hits.get(pathname));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  return { store, hits, base: `http://127.0.0.1:${server.address().port}` };
}

const html = (res, body, status = 200) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }); res.end(body); };

test('品質の点数：外部サイトのログイン画面や取れない素材は点数に含めず、別の件数として出す', () => {
  const manifest = {
    startUrl: 'https://store.example/',
    pages: [
      { url: 'https://store.example/', scope: 'origin', resources: ['https://store.example/app.css'], quality: { classification: 'normal' } },
      { url: 'https://accounts.other.example/login', requestedUrl: 'https://other.example/me', scope: 'external', quality: { classification: 'login-required', level: 'blocked' } }
    ],
    resources: { 'https://store.example/app.css': { url: 'https://store.example/app.css', status: 200, size: 10 } },
    blocked: [{ url: 'https://fonts.other.example/a.woff', reason: '参照素材を取得できません: HTTP 403' }],
    referenceAudit: { checkedCount: 3, missingCount: 1, missing: ['https://fonts.other.example/a.woff'], siteMissing: [] }
  };
  const quality = summarizeArchiveQuality(manifest, { errors: 0, status: 'complete' });
  assert.equal(quality.score, 100);
  assert.equal(quality.level, 'verified');
  assert.equal(quality.externalPageIssueCount, 1);
  assert.equal(quality.externalHardBlockedCount, 1);
  assert.equal(quality.externalReferenceMissingCount, 1);
  assert.equal(completionStatus({ pages: 2, errors: 0 }, manifest).status, 'complete', '外部の問題だけなら「一部エラー」にしない');
  const broken = structuredClone(manifest);
  broken.blocked.push({ url: 'https://store.example/hero.jpg', reason: '参照素材を取得できません: HTTP 500' });
  broken.referenceAudit.missing.push('https://store.example/hero.jpg');
  broken.referenceAudit.siteMissing.push('https://store.example/hero.jpg');
  const brokenQuality = summarizeArchiveQuality(broken, { errors: 0, status: 'complete' });
  assert.ok(brokenQuality.score < 100, '開始サイトの欠落は点数に入る');
  assert.equal(completionStatus({ pages: 2, errors: 0 }, broken).status, 'complete-with-errors');
});

test('容量の内訳：種類ごとに分け、CSSから読み込む画像は背景画像として数える', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-storage-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'blobs'), { recursive: true });
  await fs.mkdir(path.join(root, 'screenshots'), { recursive: true });
  const write = async (name, body) => { await fs.writeFile(path.join(root, 'blobs', name), body); return `blobs/${name}`; };
  const css = await write('css', '.hero{background:url("/bg.png")}');
  const page = await write('page', '<img src="/photo.jpg"><div style="background-image:url(&quot;/inline.png&quot;)"></div>');
  await fs.writeFile(path.join(root, 'screenshots', '1.png'), Buffer.alloc(7));
  await fs.writeFile(path.join(root, 'collection.warc.gz'), Buffer.alloc(11));
  const manifest = {
    pages: [{ url: 'https://s.example/', html: page, screenshot: 'screenshots/1.png' }],
    resources: {
      'https://s.example/app.css': { url: 'https://s.example/app.css', mimeType: 'text/css', file: css, size: 40 },
      'https://s.example/bg.png': { url: 'https://s.example/bg.png', mimeType: 'image/png', file: await write('bg', 'b'), size: 100 },
      'https://s.example/inline.png': { url: 'https://s.example/inline.png', mimeType: 'image/png', file: await write('inline', 'i'), size: 50 },
      'https://s.example/photo.jpg': { url: 'https://s.example/photo.jpg', mimeType: 'image/jpeg', file: await write('photo', 'p'), size: 200 },
      'https://s.example/movie.mp4': { url: 'https://s.example/movie.mp4', mimeType: 'video/mp4', file: await write('movie', 'm'), size: 5000 },
      'https://s.example/font.woff2': { url: 'https://s.example/font.woff2', mimeType: 'font/woff2', file: await write('font', 'f'), size: 30 },
      'https://s.example/api': { url: 'https://s.example/api', mimeType: 'application/json', file: await write('api', '{}'), size: 2 }
    }
  };
  const summary = await computeStorageSummary(manifest, root);
  const bytes = Object.fromEntries(summary.categories.map((item) => [item.key, item.bytes]));
  assert.equal(bytes.media, 5000);
  assert.equal(bytes.image, 200);
  assert.equal(bytes.background, 150);
  assert.equal(bytes.font, 30);
  assert.equal(bytes.system, 40);
  assert.equal(bytes.data, 2);
  assert.equal(bytes.screenshot, 7);
  assert.equal(bytes.warc, 11);
  assert.ok(bytes.page > 0);
  assert.equal(resourceCategory({ url: 'https://x.example/seg.m4s' }), 'media');
});

test('終わった保存の続き：中止した保存を、残ったページから同じアーカイブへ保存し続ける', { timeout: 60000 }, async (t) => {
  let manager;
  let job;
  const { store, hits, base } = await fixture(t, (pathname, req, res, count) => {
    if (pathname === '/') return html(res, '<title>Root</title><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>');
    if (pathname === '/a' && count === 1) { manager.cancel(job.id); return html(res, '<title>A</title>'); }
    html(res, `<title>${pathname}</title>`);
  });
  job = await store.addJob({ startUrl: `${base}/`, options: baseOptions });
  manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  assert.equal(job.status, 'cancelled');
  assert.equal(store.getArchive(job.archiveId).status, 'cancelled');
  const plan = await manager.retryPlan(job.archiveId);
  assert.ok(plan.remainingCount >= 2, JSON.stringify(plan));
  await manager.continueArchive(job.archiveId);
  assert.equal(store.getArchive(job.archiveId).status, 'running');
  await manager.running.get(job.id);
  assert.equal(job.status, 'complete');
  const manifest = await store.readManifest(job.archiveId);
  assert.deepEqual(manifest.pages.map((page) => new URL(page.url).pathname).sort(), ['/', '/a', '/b', '/c']);
  assert.equal(hits.get('/b'), 1);
  await assert.rejects(manager.continueArchive(job.archiveId), { code: 'NOTHING_TO_CONTINUE' });
});

test('問題を直して再保存：失敗したページを取り直し、ログインが必要なサイトはサイトごとに選んだものだけ取り直す', { timeout: 60000 }, async (t) => {
  let broken = true;
  const { store, hits, base } = await fixture(t, (pathname, req, res) => {
    if (pathname === '/') return html(res, '<title>Root</title><a href="/login">login</a><a href="/member">member</a><a href="/broken">broken</a>');
    if (pathname === '/login') return html(res, '<title>Login</title><form><input type="password"></form>');
    if (pathname === '/member') { res.writeHead(302, { location: '/login?next=/member' }); return res.end(); }
    if (pathname === '/broken') return broken ? html(res, '<title>Busy</title>', 503) : html(res, '<title>Fixed</title><p>ok</p>');
    html(res, `<title>${pathname}</title>`);
  });
  const job = await store.addJob({ startUrl: `${base}/`, options: { ...baseOptions, pageRetries: 0, repairBeforeComplete: false } });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  const before = await store.readManifest(job.archiveId);
  const plan = summarizeRetryPlan(buildRetryPlan(before));
  assert.deepEqual(plan.failedPages.map((item) => new URL(item.url).pathname), ['/broken'], JSON.stringify(plan));
  assert.deepEqual(plan.loginSites.map((item) => item.host), [new URL(base).host.replace(/:\d+$/, '')]);
  assert.ok(retryQueue(buildRetryPlan(before), { skipHosts: ['127.0.0.1'] }).every((item) => !item.login), 'スキップしたサイトは取り直さない');
  await assert.rejects(manager.retryArchive(job.archiveId, { loginHosts: ['127.0.0.1'] }), { code: 'LOGIN_PROFILE_REQUIRED' });
  broken = false;
  const retry = await manager.retryArchive(job.archiveId, { skipHosts: ['127.0.0.1'] });
  assert.notEqual(retry.id, job.id);
  assert.equal(retry.archiveId, job.archiveId);
  await manager.running.get(retry.id);
  const after = await store.readManifest(job.archiveId);
  const fixed = after.pages.find((page) => new URL(page.url).pathname === '/broken');
  assert.equal(fixed?.title, 'Fixed');
  assert.equal(after.pages.filter((page) => new URL(page.url).pathname === '/broken').length, 1, '同じページを二重に持たない');
  assert.equal(hits.get('/member'), 1, 'スキップを選んだログインサイトは開き直さない');
  assert.equal(store.getArchive(job.archiveId).pages, after.pages.length);
  assert.ok(store.getArchive(job.archiveId).bytes >= store.getArchive(job.archiveId).bytes, '容量は前の分を引き継ぐ');
});

test('止まったページは打ち切って取り直しに回し、件数を記録する', { timeout: 60000 }, async (t) => {
  const { store, hits, base } = await fixture(t, (pathname, req, res, count) => {
    if (pathname === '/') return html(res, '<title>Root</title><a href="/slow">slow</a>');
    if (pathname === '/slow' && count === 1) return;
    html(res, `<title>${pathname}</title>`);
  });
  const job = await store.addJob({ startUrl: `${base}/`, options: { ...baseOptions, requestTimeoutMs: 20000, pageRetries: 2 } });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, stallLimitMs: 400, pageRetryDelayMs: 20 });
  await manager.run(job.id);
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(job.stalledPages, 1);
  assert.ok(manifest.pages.some((page) => new URL(page.url).pathname === '/slow'), '取り直しで保存できる');
  assert.equal(hits.get('/slow'), 2);
  assert.equal(Object.values(manifest.pageRetries)[0].status, 'recovered');
});
