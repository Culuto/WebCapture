import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';

test('実行中に再開要求が来ても、現在処理の終了後に再始動する', async () => {
  const job = { id: 'job_resume', status: 'running' };
  const store = { getJob: () => job };
  const manager = new CrawlManager(store, { defaultLimits: {} });
  let calls = 0;
  manager.run = async () => {
    calls += 1;
    if (calls === 1) job.status = 'queued';
    else job.status = 'paused';
  };
  manager.start(job.id);
  for (let attempt = 0; attempt < 20 && calls < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(calls, 2);
  assert.equal(manager.running.size, 0);
});

test('初期化中に停止されたジョブをrunningへ戻さない', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-cancel-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const job = {
    id: 'job_cancel', archiveId: 'archive_cancel', startUrl: 'https://example.com/', createdAt: new Date().toISOString(),
    status: 'queued', pages: 0, resources: 0, bytes: 0, errors: 0, queue: [], inFlight: [], visited: [],
    options: { externalMaxDepth: 1, concurrency: 1 }
  };
  const updates = [];
  let finalized = false;
  let archive;
  const store = {
    getJob: () => job,
    archiveRoot: () => path.join(root, 'archive_cancel'),
    readManifest: async () => {
      job.status = 'cancelled';
      return { pages: [], resources: {}, blocked: [], options: job.options };
    },
    updateJob: async (_id, patch) => { updates.push(patch); Object.assign(job, patch); return job; },
    writeManifest: async () => {},
    addArchive: async (value) => { archive = value; },
    finalizeJob: async () => { finalized = true; }
  };
  const manager = new CrawlManager(store, { defaultLimits: { externalMaxDepth: 1 } });
  await manager.run(job.id);
  assert.equal(job.status, 'cancelled');
  assert.equal(updates.some((patch) => patch.status === 'running'), false);
  assert.equal(archive.status, 'cancelled');
  assert.equal(finalized, true);
});

test('通常停止は通信・URL復元・ブラウザ終了を待ち、再始動しない', async () => {
  const job = { id: 'job_shutdown', status: 'running', queue: [], inFlight: ['https://example.com/pending'] };
  const events = [];
  const store = {
    getJob: id => id === job.id ? job : null,
    updateJob: async (_id, patch) => { Object.assign(job, patch); events.push('paused'); }
  };
  const manager = new CrawlManager(store, { defaultLimits: {} });
  const controller = new AbortController();
  manager.abortControllers.set(job.id, new Set([controller]));
  let release;
  const released = new Promise(resolve => { release = resolve; });
  controller.signal.addEventListener('abort', () => { assert.equal(job.status, 'paused'); events.push('aborted'); });
  let calls = 0;
  manager.run = async () => {
    calls += 1;
    await released;
    job.queue.push(...job.inFlight); job.inFlight = [];
    events.push('restored');
    events.push('browser-closed');
    job.status = 'queued';
  };
  manager.start(job.id);
  let finished = false;
  const stopping = manager.shutdown();
  assert.equal(manager.shutdown(), stopping);
  stopping.then(() => { finished = true; events.push('stopped'); });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(controller.signal.aborted, true);
  assert.equal(finished, false);
  manager.start('another');
  release();
  await stopping;
  assert.equal(calls, 1);
  assert.equal(manager.running.size, 0);
  assert.deepEqual(job.queue, ['https://example.com/pending']);
  assert.deepEqual(events, ['paused', 'aborted', 'restored', 'browser-closed', 'stopped']);
});

test('停止状態の書込みに失敗しても通信中断と実行終了を待つ', async () => {
  const job = { id: 'job_shutdown_failure', status: 'running' };
  const controller = new AbortController();
  const manager = new CrawlManager({ getJob: () => job, updateJob: async () => { job.status = 'paused'; throw new Error('disk-write-failed'); } }, { defaultLimits: {} });
  manager.abortControllers.set(job.id, new Set([controller]));
  let settled = false;
  manager.run = async () => { await new Promise(resolve => controller.signal.addEventListener('abort', resolve)); settled = true; };
  manager.start(job.id);
  await assert.rejects(manager.shutdown(), /disk-write-failed/);
  assert.equal(controller.signal.aborted, true);
  assert.equal(settled, true);
  assert.equal(manager.running.size, 0);
});
