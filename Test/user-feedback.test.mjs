import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { balancedConcurrency, CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { LiveViewHub } from '../server/live-view.mjs';
import { retiredSlots, idlePlaceholder } from '../public/live-view.js';
import { createReplayHandler, findImageVariantFallback, imageVariantKey } from '../server/replay.mjs';
import { freePort, findBrowser } from '../server/browser-capture.mjs';
import { createLocalAuditBrowser } from '../server/replay-auditor.mjs';
import { safeInteractionExpression } from '../server/safe-interactions.mjs';
import { navigateAndSettle, evaluateValue } from '../server/browser-page.mjs';

async function tempStore(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `webcapture-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new VaultStore(root).init();
}

test('並列の配分：残りのページを均等に分け、最後に1件だけで保存する時間を作らない', () => {
  assert.equal(balancedConcurrency(61, 30), 21, '61件・同時30なら21件前後ずつ3回');
  assert.equal(balancedConcurrency(31, 30), 16);
  assert.equal(balancedConcurrency(60, 30), 30, 'ちょうど割り切れるときは減らさない');
  assert.equal(balancedConcurrency(20, 30), 30, '同時数以下なら全部を一度に始める');
  assert.equal(balancedConcurrency(91, 30), 23);
  for (let pending = 31; pending <= 200; pending += 1) {
    const limit = balancedConcurrency(pending, 30);
    assert.ok(limit <= 30 && limit >= 15, `${pending}件で${limit}`);
    const waves = Math.ceil(pending / limit);
    assert.ok(pending - limit * (waves - 1) >= limit / 2 || waves === 1, `${pending}件の最後の回が少なすぎない`);
  }
});

test('勝手な制限をなくす：分散アクセスOFFなら同じサイトの制限をかけず、制限がかかるときは理由を記録する', { timeout: 60000 }, async (t) => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(pathname === '/' ? `<title>Root</title>${Array.from({ length: 8 }, (_, index) => `<a href="/p${index}">${index}</a>`).join('')}` : `<title>${pathname}</title>`);
    }, 150);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const startUrl = `http://127.0.0.1:${server.address().port}/`;
  const run = async (distributedAccess) => {
    const store = await tempStore(t, `throttle-${distributedAccess}`);
    const job = await store.addJob({ startUrl, options: {
      ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false,
      discoveryMode: 'immediate', concurrency: 4, maxPages: 20, distributedAccess, perHostConcurrency: 1, perHostIntervalMs: 0, repairBeforeComplete: false
    } });
    const throttles = [];
    const original = store.updateJob.bind(store);
    store.updateJob = async (id, patch) => { if (patch.throttle) throttles.push(patch.throttle); return original(id, patch); };
    let peak = 0;
    const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
    const probe = setInterval(() => { peak = Math.max(peak, store.getJob(job.id)?.inFlight?.length || 0); }, 20);
    await manager.run(job.id);
    clearInterval(probe);
    assert.equal(store.getJob(job.id).status, 'complete');
    return { throttles, peak };
  };
  const on = await run(true);
  assert.ok(on.throttles.some((item) => item.reasons.includes('per-host')), '分散アクセスで待っている理由を記録する');
  assert.equal(on.peak, 1, '同じサイトは1件ずつ');
  const off = await run(false);
  assert.ok(off.peak > 1, '分散アクセスOFFなら同じサイトでも並列で保存する');
  assert.ok(!off.throttles.some((item) => item.reasons.includes('per-host')));
});

test('ライブ表示：残りが枠より少なくなったら、10秒以上動きのない枠だけを隠し、空いた枠は完了済みと表示する', () => {
  const slots = [
    { index: 0, busy: true, idleMs: 20000, url: 'https://example.com/a', phase: 'reading' },
    { index: 1, busy: false, idleMs: 12000, url: 'https://example.com/b', phase: 'done' },
    { index: 2, busy: false, idleMs: 3000, url: 'https://example.com/c', phase: 'done' },
    { index: 3, busy: false, idleMs: null, url: '', phase: 'idle' }
  ];
  assert.deepEqual([...retiredSlots(slots, 10)], [], '残りが多い間は隠さない');
  assert.deepEqual([...retiredSlots(slots, 1)].sort(), [1, 3], '動いている枠と、止まって10秒未満の枠は残す');
  const allIdle = slots.map((slot) => ({ ...slot, busy: false, idleMs: 60000 }));
  allIdle[2].idleMs = 11000;
  assert.deepEqual([...retiredSlots(allIdle, 0)].sort(), [0, 1, 3], '全部止まっても最後に動いた枠は1つ残す');
  assert.equal(idlePlaceholder(slots[1], 1, 1), '完了済み');
  assert.equal(idlePlaceholder(slots[1], 5, 1), '次のページを待っています');
  assert.equal(idlePlaceholder(slots[0], 1, 1), '画面を準備中');
  const hub = new LiveViewHub({ now: () => 50000 });
  hub.begin('job', 0, 'https://example.com/');
  hub.update('job', 0, { phase: 'done' });
  const [snapshot] = hub.snapshot('job', 2);
  assert.deepEqual([snapshot.busy, snapshot.idleMs], [false, 0]);
  assert.equal(hub.snapshot('job', 2)[1].busy, false);
});

test('YouTubeの画像：保存時と違う大きさを求められたら、同じ画像の保存済みの大きさを返す', async (t) => {
  assert.equal(imageVariantKey('https://yt3.googleusercontent.com/abcdefghijkl=w1060-fcrop64=1,00'), 'sized:yt3.googleusercontent.com/abcdefghijkl');
  assert.equal(imageVariantKey('https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg'), 'ytimg:abcdefghijk');
  assert.equal(imageVariantKey('https://example.com/a=b.png'), null);
  const store = await tempStore(t, 'image-variant');
  const id = 'archive_image_variant';
  const banner = await store.writeBlob(id, Buffer.from('banner-2560'));
  const small = await store.writeBlob(id, Buffer.from('b'));
  const thumb = await store.writeBlob(id, Buffer.from('thumb-hq'));
  const html = await store.writeBlob(id, Buffer.from('<title>Channel</title>'));
  const bannerUrl = 'https://yt3.googleusercontent.com/BannerIdentifier123=w2560-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj';
  await store.writeManifest(id, {
    id, startUrl: 'https://www.youtube.com/@channel', options: {}, resourceAliases: {},
    pages: [{ url: 'https://www.youtube.com/@channel', html: html.file }],
    resources: {
      [bannerUrl]: { url: bannerUrl, status: 200, mimeType: 'image/jpeg', ...banner },
      'https://yt3.googleusercontent.com/BannerIdentifier123=w320': { url: 'https://yt3.googleusercontent.com/BannerIdentifier123=w320', status: 200, mimeType: 'image/jpeg', ...small },
      'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg': { url: 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg', status: 200, mimeType: 'image/jpeg', ...thumb }
    }
  });
  const manifest = await store.readManifest(id);
  assert.equal(findImageVariantFallback(manifest, 'https://yt3.googleusercontent.com/BannerIdentifier123=w1060-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj').resource.url, bannerUrl, '一番大きい保存済みの画像を使う');
  const replayPort = await freePort();
  const replay = http.createServer(createReplayHandler(store, { host: '127.0.0.1', port: 1, replayPort }));
  await new Promise((resolve) => replay.listen(replayPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { replay.closeAllConnections(); replay.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${replayPort}/archive/${id}/web/https://yt3.googleusercontent.com/BannerIdentifier123=w1707-fcrop64=1,00005a57ffffa5a8-k-c0xffffffff-no-nd-rj`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-webcapture-resource-fallback'), 'image-size-variant');
  assert.equal(await response.text(), 'banner-2560');
  const thumbResponse = await fetch(`http://127.0.0.1:${replayPort}/archive/${id}/web/https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg`);
  assert.equal(await thumbResponse.text(), 'thumb-hq');
  const other = await fetch(`http://127.0.0.1:${replayPort}/archive/${id}/web/https://i.ytimg.com/vi/zzzzzzzzzzz/maxresdefault.jpg`);
  assert.equal(other.status, 404, '別の動画のサムネイルは代用しない');
});

test('実際のChrome：押すたびに作り直されるボタンや同じ名前のボタンを延々と押し続けない', { timeout: 120000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const page = `<!doctype html><title>Buttons</title><body>
    <div id="menu-host"></div><div id="carousel"></div><div id="many"></div>
    <script>
      window.clicks = { rerender: 0, next: 0, many: 0 };
      const renderMenu = () => { const host = document.getElementById('menu-host'); host.innerHTML = ''; const button = document.createElement('button'); button.type = 'button'; button.setAttribute('aria-expanded', 'false'); button.textContent = 'その他の操作'; button.onclick = () => { window.clicks.rerender += 1; renderMenu(); }; host.append(button); };
      const renderNext = () => { const host = document.getElementById('carousel'); host.innerHTML = ''; const button = document.createElement('button'); button.type = 'button'; button.className = 'carousel-next'; button.textContent = '次へ'; button.onclick = () => { window.clicks.next += 1; setTimeout(renderNext, 0); }; host.append(button); };
      renderMenu(); renderNext();
      const many = document.getElementById('many');
      for (let index = 0; index < 120; index += 1) { const wrap = document.createElement('section'); const button = document.createElement('button'); button.type = 'button'; button.textContent = 'もっと見る'; button.onclick = () => { window.clicks.many += 1; }; wrap.append(button); many.append(wrap); }
    </script></body>`;
  const server = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const session = await createLocalAuditBrowser({ executable: browser });
  t.after(() => session.close());
  await navigateAndSettle(session.client, `http://127.0.0.1:${server.address().port}/`, { settleMs: 200 });
  const started = Date.now();
  const result = evaluateValue(await session.client.send('Runtime.evaluate', { expression: safeInteractionExpression({ limit: 1000, settleMs: 5, deadlineMs: 60000 }), awaitPromise: true, returnByValue: true }, 70000));
  const clicks = evaluateValue(await session.client.send('Runtime.evaluate', { expression: 'window.clicks', returnByValue: true }));
  assert.ok(clicks.rerender <= 2, `作り直されるボタンを${clicks.rerender}回押した`);
  assert.ok(clicks.next <= 2, `作り直される「次へ」を${clicks.next}回押した`);
  assert.ok(clicks.many <= 40, `同じ名前のボタンを${clicks.many}回押した`);
  assert.ok(result.repeatSkipped > 0);
  assert.ok(result.testedCount < 60);
  assert.ok(Date.now() - started < 30000, '時間切れまで粘らずに終わる');
});
