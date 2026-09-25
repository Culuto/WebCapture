import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { VaultStore } from '../server/store.mjs';
import { classifyCapturedPage, completionStatus } from '../server/quality.mjs';

const gunzip = promisify(zlib.gunzip);

test('アクセス確認・ログイン転送・0ページを成功扱いにしない', () => {
  const challenge = classifyCapturedPage({ title: 'Just a moment...', html: '<div id="cf-chl-widget">Checking your browser</div>' });
  assert.equal(challenge.classification, 'access-challenge');
  const login = classifyCapturedPage({
    startUrl: 'https://example.com/private', requestedUrl: 'https://example.com/private', url: 'https://example.com/login',
    title: 'Sign in', html: '<form><input type="password"></form>'
  });
  assert.equal(login.classification, 'login-required');
  const normal = classifyCapturedPage({ title: 'Article', html: '<main>本文</main>', resources: [{ type: 'Document', status: 200 }] });
  assert.equal(normal.classification, 'normal');
  assert.equal(completionStatus({ pages: 0, errors: 0 }, { pages: [] }).status, 'failed');
});

test('旧stateを保持して個別保存へ移行し、完了済み待ち行列を可逆圧縮する', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-v2-migration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const archiveId = 'archive_zero_test';
  const jobId = 'job_zero_test';
  const legacy = {
    schemaVersion: 1,
    archives: [],
    jobs: [{
      id: jobId, archiveId, startUrl: 'https://example.com/', status: 'complete', pages: 0, resources: 0, bytes: 0, errors: 0,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:01.000Z',
      queue: Array.from({ length: 120 }, (_, index) => ({ url: `https://example.com/${index}`, depth: 1 })),
      inFlight: [], plannedQueue: [], discoveryVisited: [], visited: [], visitedDetails: [], options: { discoveryMode: 'immediate' }
    }]
  };
  const legacyText = JSON.stringify(legacy);
  await fs.mkdir(path.join(root, 'archives', archiveId), { recursive: true });
  await fs.writeFile(path.join(root, 'state.json'), legacyText);
  await fs.writeFile(path.join(root, 'archives', archiveId, 'manifest.json'), JSON.stringify({ id: archiveId, startUrl: 'https://example.com/', pages: [], resources: {}, blocked: [] }));

  const store = await new VaultStore(root).init();
  assert.equal(await fs.readFile(path.join(root, 'state.json'), 'utf8'), legacyText);
  assert.equal(store.getJob(jobId).status, 'failed');
  assert.equal(store.getJob(jobId).queue.length, 0);
  assert.equal(store.getJob(jobId).queueCount, 120);
  assert.equal(store.getArchive(archiveId).status, 'failed');
  await fs.access(path.join(root, 'state-v2', 'jobs', `${jobId}.json`));
  await fs.access(path.join(root, 'state-v2', 'archives', `${archiveId}.json`));
  const queuePayload = JSON.parse((await gunzip(await fs.readFile(path.join(root, 'state-v2', 'terminal-queues', `${jobId}.json.gz`)))).toString('utf8'));
  assert.equal(queuePayload.queue.length, 120);

  await store.recordReplayMiss(archiveId, 'https://example.com/missing.js');
  await store.recordReplayMiss(archiveId, 'https://example.com/missing.js');
  const misses = await store.readRuntimeMisses(archiveId);
  assert.equal(misses.total, 2);
  assert.equal(misses.unique, 1);
  await store.waitForWrites();
  const persistedMisses = JSON.parse(await fs.readFile(path.join(root, 'archives', archiveId, 'runtime-misses.json'), 'utf8'));
  assert.equal(persistedMisses.total, 2);
  assert.equal(persistedMisses.unique, 1);
});

test('アーカイブ検索とページングをサーバー側で行う', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-v2-query-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  for (let index = 0; index < 5; index += 1) {
    await store.addArchive({
      id: `archive_query_${index}`, startUrl: `https://example.com/${index}`, title: index === 3 ? 'KKVV sample' : `Sample ${index}`,
      status: 'complete', pages: 1, resources: 1, bytes: 10, errors: 0, savedAt: `2026-01-0${index + 1}T00:00:00.000Z`
    });
  }
  const first = store.queryArchives({ offset: 0, limit: 2 });
  assert.equal(first.items.length, 2);
  assert.equal(first.total, 5);
  assert.equal(first.hasMore, true);
  assert.equal(store.queryArchives().limit, 60);
  const filtered = store.queryArchives({ query: 'kkvv', offset: 0, limit: 2 });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, 'archive_query_3');
});
