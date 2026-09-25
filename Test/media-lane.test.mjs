import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS, sanitizeCaptureOptions } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { completeMediaResources, BACKGROUND_MEDIA_REASON } from '../server/media-capture.mjs';

test('後回し方式では、部分取得の動画や配信の分割ファイルをその場で取らず、後から保存する印を付ける', async () => {
  let fetched = 0;
  const playlist = Buffer.from('#EXTM3U\n#EXTINF:1,\nseg1.ts\n#EXTINF:1,\nseg2.ts\n');
  const capture = { resources: [
    { url: 'https://site.example/movie.mp4', status: 206, headers: { 'content-range': 'bytes 0-9/5000', 'content-type': 'video/mp4' }, mimeType: 'video/mp4', type: 'Media', body: Buffer.alloc(10) },
    { url: 'https://site.example/live.m3u8', status: 200, headers: { 'content-type': 'application/vnd.apple.mpegurl' }, mimeType: 'application/vnd.apple.mpegurl', type: 'Media', body: playlist }
  ], blocked: [] };
  await completeMediaResources(capture, { mediaStrategy: 'background', mediaMaxBytes: null }, async () => { fetched += 1; throw new Error('呼ばれてはいけない'); });
  assert.equal(fetched, 0);
  assert.deepEqual(capture.deferredMedia.map((item) => [item.kind, item.background, item.reason]), [['file', true, BACKGROUND_MEDIA_REASON], ['stream', true, BACKGROUND_MEDIA_REASON]]);
  assert.deepEqual(capture.deferredMedia[1].remainingUrls, ['https://site.example/seg1.ts', 'https://site.example/seg2.ts']);
  assert.equal(capture.blocked.length, 0, '後回しは失敗として扱わない');
  assert.equal(sanitizeCaptureOptions({ mediaStrategy: 'background', mediaSpeed: 'slow' }).mediaSpeed, 'slow');
  assert.equal(sanitizeCaptureOptions({ mediaSpeed: 'warp' }).mediaSpeed, 'normal');
});

test('保存中に動画を別の流れで保存し、ページの保存を待たせず、終わるまでに全部そろえる', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-media-lane-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const video = Buffer.alloc(300000, 7);
  const events = [];
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    if (pathname === '/movie.mp4') {
      events.push('video-start');
      setTimeout(() => { res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': video.length }); res.end(video); events.push('video-end'); }, 600);
      return;
    }
    if (/^\/seg\d\.ts$/.test(pathname)) { res.writeHead(200, { 'content-type': 'video/mp2t' }); res.end(Buffer.alloc(1000, 1)); return; }
    events.push(`page:${pathname}`);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pathname === '/' ? '<title>Root</title><a href="/a">a</a><a href="/b">b</a>' : `<title>${pathname}</title>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = await new VaultStore(root).init();
  const options = { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 1, maxPages: 10, mediaStrategy: 'background', mediaSpeed: 'normal' };
  const job = await store.addJob({ startUrl: `${base}/`, options });
  await store.writeManifest(job.archiveId, {
    schemaVersion: 2, id: job.archiveId, startUrl: `${base}/`, createdAt: job.createdAt, engine: null, pages: [], resources: {}, resourceAliases: {}, blocked: [], options,
    deferredMedia: [
      { url: `${base}/movie.mp4`, kind: 'file', background: true, reason: BACKGROUND_MEDIA_REASON },
      { url: `${base}/live.m3u8`, kind: 'stream', background: true, remainingUrls: [`${base}/seg1.ts`, `${base}/seg2.ts`], reason: BACKGROUND_MEDIA_REASON }
    ]
  });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.run(job.id);
  assert.equal(job.status, 'complete', job.message);
  const manifest = await store.readManifest(job.archiveId);
  assert.equal(manifest.resources[`${base}/movie.mp4`]?.size, video.length);
  assert.ok(manifest.resources[`${base}/seg1.ts`] && manifest.resources[`${base}/seg2.ts`]);
  assert.deepEqual(manifest.deferredMedia, [], '全部保存できたら未保存の一覧から消える');
  assert.ok(events.indexOf('page:/b') < events.indexOf('video-end'), `ページは動画を待たずに進む: ${events.join(',')}`);
  assert.equal(manifest.pages.length, 3);
});
