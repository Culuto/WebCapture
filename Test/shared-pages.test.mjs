import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { SharedPages } from '../server/shared-pages.mjs';
import { createReplayHandler } from '../server/replay.mjs';

async function listen(server, host) {
  return new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve); });
}

test('別のアーカイブで保存済みの外部ページは取り直さず共有し、参照先は削除から守る', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-shared-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const externalHits = new Map();
  const external = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://x').pathname;
    externalHits.set(pathname, (externalHits.get(pathname) || 0) + 1);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (pathname === '/robots.txt') return res.end('');
    res.end(pathname === '/guide' ? '<title>Guide</title><a href="/guide/next">next</a>' : `<title>${pathname}</title>`);
  });
  try { await listen(external, '127.0.0.2'); } catch { return t.skip('127.0.0.2を待ち受けできない環境'); }
  t.after(() => new Promise((resolve) => external.close(resolve)));
  const externalGuide = `http://127.0.0.2:${external.address().port}/guide`;
  const site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/robots.txt') return res.end('');
    res.end(`<title>${req.url}</title><a href="${externalGuide}">guide</a>`);
  });
  await listen(site, '127.0.0.1');
  t.after(() => new Promise((resolve) => site.close(resolve)));
  const base = `http://127.0.0.1:${site.address().port}`;
  const store = await new VaultStore(root).init();
  const sharedPages = await new SharedPages({ dataRoot: root, store }).init();
  const options = { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, followExternal: true, externalMaxDepth: 2, discoveryMode: 'immediate', maxPages: 10 };
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, sharedPages });
  const first = await store.addJob({ startUrl: `${base}/site-a`, options });
  await manager.run(first.id);
  assert.equal(externalHits.get('/guide'), 1);
  const second = await store.addJob({ startUrl: `${base}/site-b`, options });
  await manager.run(second.id);
  assert.equal(externalHits.get('/guide'), 1, '保存済みの外部ページは取り直さない');
  const manifest = await store.readManifest(second.archiveId);
  assert.deepEqual(manifest.sharedPages.map((item) => [item.url, item.archiveId]).sort(), [[externalGuide, first.archiveId], [`${externalGuide}/next`, first.archiveId]], '共有したページのリンク先も、保存済みなら共有する');
  assert.equal(externalHits.get('/guide/next'), 1);
  assert.equal(manifest.pages.some((page) => page.url === externalGuide), false);
  assert.equal(second.sharedPages, 2);
  assert.deepEqual(sharedPages.referencesTo(first.archiveId), [second.archiveId], '共有されている側は参照元を記録する');
  const reloaded = await new SharedPages({ dataRoot: root, store }).init();
  assert.deepEqual(reloaded.referencesTo(first.archiveId), [second.archiveId], '再起動後も参照を覚えている');
  assert.equal(reloaded.lookup(externalGuide, second.archiveId)?.archiveId, first.archiveId);

  const replayServer = http.createServer(createReplayHandler(store, { host: '127.0.0.1', port: 1, replayPort: 0, iframeParentOrigins: [] }));
  await listen(replayServer, '127.0.0.1');
  t.after(() => new Promise((resolve) => replayServer.close(resolve)));
  const replayPort = replayServer.address().port;
  const handlerServer = http.createServer(createReplayHandler(store, { host: '127.0.0.1', port: 1, replayPort, iframeParentOrigins: [] }));
  await listen(handlerServer, '127.0.0.1');
  t.after(() => new Promise((resolve) => handlerServer.close(resolve)));
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: handlerServer.address().port, path: `/archive/${second.archiveId}/page?url=${encodeURIComponent(externalGuide)}&navigationId=n1`, headers: { host: `127.0.0.1:${replayPort}` } }, resolve);
    request.once('error', reject);
    request.end();
  });
  response.resume();
  assert.equal(response.statusCode, 302);
  assert.ok(response.headers.location.includes(`/archive/${first.archiveId}/page?url=`), response.headers.location);
  assert.match(response.headers.location, /navigationId=n1/);
});
