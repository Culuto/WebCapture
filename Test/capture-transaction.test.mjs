import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { VaultStore } from '../server/store.mjs';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';

async function fixture(t, warcEnabled = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-capture-crash-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const requests = new Map();
  const routes = { '/': ['/a', '/b'], '/a': ['/c'], '/b': ['/d'], '/c': [], '/d': [] };
  const server = http.createServer((req, res) => {
    requests.set(req.url, (requests.get(req.url) || 0) + 1);
    if (req.url === '/image.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); return res.end('<svg xmlns="http://www.w3.org/2000/svg"/>'); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<title>Page ${req.url}</title><img src="/image.svg">${routes[req.url].map(url => `<a href="${url}">${url}</a>`).join('')}`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const startUrl = `http://127.0.0.1:${server.address().port}/`;
  const store = await new VaultStore(root).init();
  const job = await store.addJob({ startUrl, options: {
    ...DEFAULT_CAPTURE_OPTIONS, discoveryMode: 'immediate', captureRendered: false, respectRobots: false,
    concurrency: 2, maxPages: null, warcEnabled, screenshotMode: 'none', policyOptions: { allowPrivateForTests: true }
  } });
  return { root, store, jobId: job.id, id: job.archiveId, startUrl, requests };
}

async function crashAt(t, f, phase) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, 'crawl-crash-fixture.mjs'), f.root, f.jobId, phase], {
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, WEBCAPTURE_LOG_ROOT: path.join(f.root, 'logs') }
  });
  let stderr = '';
  child.stderr.on('data', value => { stderr += value.toString(); });
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGKILL'); await exit; } });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`checkpoint timed out: ${stderr}`)), 10000);
    child.once('message', message => { clearTimeout(timer); message.phase === phase ? resolve() : reject(new Error(JSON.stringify(message))); });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`child exited before checkpoint: ${stderr}`)); });
  });
  const exit = new Promise(resolve => child.once('exit', resolve));
  assert.equal(child.kill('SIGKILL'), true);
  await exit;
}

async function verifyCompletion(f, recovered, expectedRequests = 1) {
  const manager = new CrawlManager(recovered, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  await manager.resume(f.jobId);
  await manager.running.get(f.jobId);
  const job = recovered.getJob(f.jobId);
  const manifest = await recovered.readManifest(f.id);
  assert.equal(job.status, 'complete');
  assert.equal(job.pages, 5);
  assert.equal(job.resources, 6);
  assert.equal(manifest.pages.length, 5);
  assert.equal(recovered.getArchive(f.id).pages, 5);
  for (const route of ['/', '/a', '/b', '/c', '/d']) assert.equal(f.requests.get(route), route === '/a' || route === '/b' ? expectedRequests : 1);
  if (job.options.warcEnabled) {
    const plain = gunzipSync(await fs.readFile(path.join(recovered.archiveRoot(f.id), 'collection.warc.gz'))).toString();
    for (const route of ['', 'a', 'b', 'c', 'd', 'image.svg']) assert.equal(plain.split(`WARC-Target-URI: ${f.startUrl}${route}\r\n`).length - 1, 1);
  } else await assert.rejects(fs.access(path.join(recovered.archiveRoot(f.id), 'collection.warc.gz')), { code: 'ENOENT' });
  for (const resource of Object.values(manifest.resources)) {
    const body = await fs.readFile(path.join(recovered.archiveRoot(f.id), resource.file));
    assert.equal(body.length, resource.size);
    assert.equal(`sha256:${crypto.createHash('sha256').update(body).digest('hex')}`, resource.digest);
  }
}

for (const phase of ['prepared', 'warc', 'manifest', 'archive', 'jobs']) {
  test(`通常並列保存の${phase}でプロセスを強制終了しても、件数と未処理URLを復旧する`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    await crashAt(t, f, phase);
    const plan = JSON.parse(await fs.readFile(path.join(f.root, '.archive-repairs', f.id, 'plan.json'), 'utf8'));
    const recovered = await new VaultStore(f.root).init();
    const job = recovered.getJob(f.jobId);
    assert.equal(job.status, 'paused');
    assert.equal(job.pages, 3);
    assert.equal(job.bytes, plan.captureJob.state.bytes);
    assert.deepEqual(job.queue.map(item => new URL(item.url).pathname).sort(), ['/c', '/d']);
    const second = await new VaultStore(f.root).init();
    assert.equal(second.getJob(f.jobId).bytes, job.bytes);
    await verifyCompletion(f, second);
  });
}

test('通常保存の部分WARC追記から残りだけ反映し、原ページを二重保存しない', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await crashAt(t, f, 'prepared');
  const chunk = await fs.readFile(path.join(f.root, '.archive-repairs', f.id, 'warc-addition.gz'));
  await fs.appendFile(path.join(f.store.archiveRoot(f.id), 'collection.warc.gz'), chunk.subarray(0, 17));
  await verifyCompletion(f, await new VaultStore(f.root).init());
});

test('準備済みジョブ記録が改変された場合は原本へ反映せず、復旧待ちを維持する', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await crashAt(t, f, 'prepared');
  const file = path.join(f.root, '.archive-repairs', f.id, 'plan.json');
  const plan = JSON.parse(await fs.readFile(file, 'utf8'));
  plan.captureJob.state.queue = [];
  await fs.writeFile(file, JSON.stringify(plan));
  const original = await fs.readFile(path.join(f.store.archiveRoot(f.id), 'collection.warc.gz'));
  const recovered = await new VaultStore(f.root).init();
  assert.equal(recovered.repairRecoveryFailures.get(f.id).status, 'failed');
  assert.equal((await recovered.readManifest(f.id)).pages.length, 1);
  assert.deepEqual(await fs.readFile(path.join(f.store.archiveRoot(f.id), 'collection.warc.gz')), original);
  await assert.rejects(recovered.restoreJobQueue(f.jobId), /復旧/);
});

test('通常保存のcommit失敗を完了・失敗アーカイブで上書きせず、再起動後に再開する', async t => {
  const f = await fixture(t);
  const manager = new CrawlManager(f.store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, captureCommitCheckpoint: async phase => {
    if (phase === 'prepared' && f.store.getJob(f.jobId).pages === 3) throw new Error('simulated-commit-interruption');
  } });
  manager.start(f.jobId);
  await manager.running.get(f.jobId);
  assert.equal(f.store.getJob(f.jobId).status, 'paused');
  assert.equal(f.store.getJob(f.jobId).pages, 1);
  assert.ok([undefined, 'paused'].includes(f.store.getArchive(f.id)?.status), '完了・失敗のアーカイブで上書きせず、途中の記録は一時停止として残す');
  assert.equal((await f.store.readManifest(f.id)).pages.length, 1);
  await verifyCompletion(f, await new VaultStore(f.root).init());
});

test('WARCなしの通常保存も強制終了から件数・未処理URLを復旧する', { timeout: 15000 }, async t => {
  const f = await fixture(t, false);
  await crashAt(t, f, 'manifest');
  await verifyCompletion(f, await new VaultStore(f.root).init());
});

test('準備前に一時停止して強制終了しても未確定の訪問済みURLを永続化しない', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  await crashAt(t, f, 'blob-stage');
  const recovered = await new VaultStore(f.root).init();
  assert.equal(recovered.getJob(f.jobId).pages, 1);
  assert.equal((await recovered.readManifest(f.id)).pages.length, 1);
  assert.deepEqual(recovered.getJob(f.jobId).queue.map(item => new URL(item.url).pathname).sort(), ['/a', '/b']);
  await verifyCompletion(f, recovered, 2);
});

for (const action of ['pause', 'cancel']) {
  test(`準備済みバッチの${action}を維持し、保存件数と再開URLを確定する`, async t => {
    const f = await fixture(t);
    let changed = false;
    const manager = new CrawlManager(f.store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, captureCommitCheckpoint: async phase => {
      if (!changed && phase === 'prepared' && f.store.getJob(f.jobId).pages === 3) { changed = true; await manager[action](f.jobId); }
    } });
    await manager.run(f.jobId);
    const job = f.store.getJob(f.jobId);
    assert.equal(changed, true);
    assert.equal(job.status, action === 'pause' ? 'paused' : 'cancelled');
    assert.equal(job.pages, 3);
    await f.store.restoreJobQueue(f.jobId);
    assert.deepEqual(job.queue.map(item => new URL(item.url).pathname).sort(), ['/c', '/d']);
    await verifyCompletion(f, f.store);
  });
}

test('部分・同サイズ破損blobを成功扱いせず、既存bytesを上書きしない', async t => {
  const f = await fixture(t);
  const body = Buffer.from('original response bytes');
  const blob = await f.store.writeBlob(f.id, body);
  const file = path.join(f.store.archiveRoot(f.id), blob.file);
  await fs.writeFile(file, body.subarray(0, 5));
  await assert.rejects(f.store.writeBlob(f.id, body), { code: 'BLOB_INTEGRITY_ERROR' });
  assert.deepEqual(await fs.readFile(file), body.subarray(0, 5));
  await fs.writeFile(file, Buffer.alloc(body.length, 0x5a));
  await assert.rejects(f.store.writeBlob(f.id, body), { code: 'BLOB_INTEGRITY_ERROR' });
  assert.deepEqual(await fs.readFile(file), Buffer.alloc(body.length, 0x5a));
});

test('同じblobの同時保存とスクリーンショットを原子的に反映する', async t => {
  const f = await fixture(t);
  const body = crypto.randomBytes(128 * 1024);
  const blobs = await Promise.all(Array.from({ length: 8 }, () => f.store.writeBlob(f.id, body)));
  assert.equal(new Set(blobs.map(blob => blob.file)).size, 1);
  const file = path.join(f.store.archiveRoot(f.id), blobs[0].file);
  assert.deepEqual(await fs.readFile(file), body);
  assert.deepEqual(await fs.readdir(path.dirname(file)), [path.basename(file)]);
  const screenshot = await f.store.writeScreenshot(f.id, '00001.png', body);
  assert.deepEqual(await fs.readFile(path.join(f.store.archiveRoot(f.id), screenshot)), body);
  await assert.rejects(f.store.writeScreenshot(f.id, '../manifest.png', body));
});
