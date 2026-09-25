import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { VaultStore } from '../server/store.mjs';
import { DeferredMediaService } from '../server/deferred-media.mjs';

function streamingFetcher(files) {
  return async (url, options = {}) => {
    const body = files[url];
    if (!body) return { finalUrl: url, response: { status: 404, ok: false, headers: new Headers(), arrayBuffer: async () => Buffer.alloc(0) } };
    assert.equal(options.responseMaxBytes, null, '後から保存するときは上限を外す');
    for (let offset = 0; offset < body.length; offset += 1000) await options.bodySink(body.subarray(offset, offset + 1000));
    return { finalUrl: url, response: { status: 200, ok: true, headers: new Headers({ 'content-type': 'video/mp4', 'content-length': String(body.length) }), streamedBytes: body.length } };
  };
}

async function waitForTask(service, id) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { task } = await service.status(id);
    if (task && task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('task did not finish');
}

test('上限超過で未保存にした動画と配信の残りを、選んだものだけ後から保存する', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-deferred-media-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const job = await store.addJob({ startUrl: 'https://video.example/', options: { discoveryMode: 'immediate' } });
  const id = job.archiveId;
  const movie = crypto.randomBytes(4500);
  const segment = crypto.randomBytes(1200);
  const manifest = {
    id, pages: [], resources: {}, resourceAliases: {}, options: { warcEnabled: true, warcCompressionLevel: 1 },
    blocked: [
      { url: 'https://video.example/movie.mp4', reason: '動画・音声が1件の上限（2 GB）を超えるため未保存です。' },
      { url: 'https://video.example/other.mp4', reason: '動画・音声が1件の上限（2 GB）を超えるため未保存です。' }
    ],
    deferredMedia: [
      { url: 'https://video.example/movie.mp4', kind: 'file', expectedBytes: movie.length, limitBytes: 1000 },
      { url: 'https://video.example/live.m3u8', kind: 'stream', remainingUrls: ['https://video.example/seg9.ts'], savedBytes: 800, limitBytes: 1000 },
      { url: 'https://video.example/other.mp4', kind: 'file', expectedBytes: 9999, limitBytes: 1000 }
    ]
  };
  await store.writeManifest(id, manifest);
  await store.addArchive({ id, startUrl: 'https://video.example/', pages: 0, resources: 0, bytes: 0, errors: 0, status: 'complete', savedAt: new Date().toISOString() });
  await store.updateJob(job.id, { status: 'complete' });
  const service = new DeferredMediaService({ store, fetcher: streamingFetcher({ 'https://video.example/movie.mp4': movie, 'https://video.example/seg9.ts': segment }) });
  const before = await service.status(id);
  assert.equal(before.items.length, 3);
  assert.equal(before.items.find((item) => item.kind === 'stream').remainingCount, 1);
  await service.start(id, ['https://video.example/movie.mp4', 'https://video.example/live.m3u8']);
  const task = await waitForTask(service, id);
  assert.equal(task.status, 'completed', JSON.stringify(task));
  assert.equal(task.completed, 2);
  const saved = await store.readManifest(id);
  assert.deepEqual(saved.deferredMedia.map((item) => item.url), ['https://video.example/other.mp4']);
  const savedMovie = saved.resources['https://video.example/movie.mp4'];
  assert.equal(savedMovie.size, movie.length);
  assert.equal(savedMovie.completedLater, true);
  assert.deepEqual(await fs.readFile(path.join(store.archiveRoot(id), savedMovie.file)), movie);
  assert.equal(saved.resources['https://video.example/seg9.ts'].size, segment.length);
  assert.ok(!saved.blocked.some((item) => item.url === 'https://video.example/movie.mp4'));
  assert.ok(saved.blocked.some((item) => item.url === 'https://video.example/other.mp4'));
  assert.equal(store.getArchive(id).resources, 2);
  await assert.rejects(service.start(id, ['https://video.example/missing.mp4']), { code: 'NOTHING_TO_SAVE' });
  await store.updateJob(job.id, { status: 'running' });
  await assert.rejects(service.start(id), { code: 'ARCHIVE_BUSY' });
});
