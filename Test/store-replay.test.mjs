import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultStore } from '../server/store.mjs';
import { rewriteCss, rewriteHtml } from '../server/replay.mjs';
import { createWarc } from '../server/warc.mjs';

test('blobはSHA-256で重複排除しmanifestを原子的に保存する', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-store-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const first = await store.writeBlob('archive_test', Buffer.from('same body'));
  const second = await store.writeBlob('archive_test', Buffer.from('same body'));
  assert.deepEqual(first, second);
  await store.writeManifest('archive_test', { id: 'archive_test', pages: [] });
  assert.deepEqual(await store.readManifest('archive_test'), { id: 'archive_test', pages: [] });
});

test('中断時の処理中URLを待ち行列へ戻し重複を除く', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-recovery-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    archives: [],
    jobs: [{
      id: 'job_test', status: 'running', message: '保存中',
      inFlight: [{ url: 'https://example.com/a', depth: 1, externalDepth: 0 }],
      queue: [{ url: 'https://example.com/a', depth: 1 }, { url: 'https://example.com/b', depth: 1 }]
    }]
  }));
  const store = await new VaultStore(root).init();
  const job = store.getJob('job_test');
  assert.equal(job.status, 'paused');
  assert.deepEqual(job.queue.map((item) => item.url), ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(job.inFlight, []);
});

test('大きなアーカイブは先に一覧から外してtrashを非同期削除する', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-delete-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const id = 'archive_large_test';
  await fs.mkdir(path.join(store.archiveRoot(id), 'blobs'), { recursive: true });
  await Promise.all(Array.from({ length: 100 }, (_, index) => fs.writeFile(path.join(store.archiveRoot(id), 'blobs', `${index}.bin`), Buffer.alloc(1024))));
  await store.addArchive({ id, startUrl: 'https://example.com/', title: 'Fixture', status: 'complete', pages: 100, savedAt: new Date().toISOString() });
  assert.equal(await store.deleteArchive(id), true);
  assert.equal(store.getArchive(id), undefined);
  await assert.rejects(fs.access(store.archiveRoot(id)), { code: 'ENOENT' });
  await store.waitForTrashCleanup();
});

test('保存済みHTMLは素材だけをarchive resourceへ書換え、リンクは再生UIへ渡す', () => {
  const html = '<!doctype html><html><head><link rel="stylesheet" href="/main.css"></head><body><a href="/next">Next</a><picture><source media="(max-width: 600px)" srcset="\n img/a-small.png 320w,\n img/a-medium.png 640w\n"><img src="img/a.png"></picture><form action="/send"><button>送信</button></form></body></html>';
  const output = rewriteHtml(html, 'https://example.com/docs/', 'archive_1');
  assert.match(output, /web\/https:\/\/example\.com\/main\.css/);
  assert.match(output, /<a href="\/next">Next<\/a>/);
  assert.match(output, /web\/https:\/\/example\.com\/docs\/img\/a\.png/);
  assert.match(output, /web\/https:\/\/example\.com\/docs\/img\/a-small\.png 320w/);
  assert.match(output, /web\/https:\/\/example\.com\/docs\/img\/a-medium\.png 640w/);
  assert.match(output, /action="#"/);
  assert.match(output, /webcapture-navigate/);
  assert.match(output, /status:204/);
});

test('CSS内URLも保存済みresourceへ書き換える', () => {
  const output = rewriteCss('body{background:url(../img/bg.png)}@import "theme.css";', 'https://example.com/css/main.css', 'archive_1');
  assert.ok(output.includes('web/https://example.com/img/bg.png'));
  assert.ok(output.includes('web/https://example.com/css/theme.css'));
});

test('import mapのモジュールURLをarchive resourceへ書き換える', () => {
  const html = '<script type="importmap">{"imports":{"@theme/component":"//example.com/assets/component.js"}}</script><script type="module">import "@theme/component"</script>';
  const output = rewriteHtml(html, 'https://example.com/', 'archive_1');
  assert.match(output, /web\/https:\/\/example\.com\/assets\/component\.js/);
  assert.match(output, /import "@theme\/component"/);
});

test('空白のないbare importは対応表名を保ち、相対importだけを書き換える', () => {
  const html = '<script type="module">import"@theme/component";import"./chunk.js";import{x as y}from"./dep.js";export{y}from"./other.js"</script>';
  const output = rewriteHtml(html, 'https://example.com/assets/main.js', 'archive_1');
  assert.match(output, /import"@theme\/component"/);
  assert.match(output, /web\/https:\/\/example\.com\/assets\/chunk\.js/);
  assert.match(output, /web\/https:\/\/example\.com\/assets\/dep\.js/);
  assert.match(output, /web\/https:\/\/example\.com\/assets\/other\.js/);
});

test('WARC 1.1 responseをgzipで出力する', async () => {
  const payload = Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\n\r\nhello');
  const warc = createWarc([{ url: 'https://example.com/', httpPayload: payload }], { test: true });
  assert.equal(warc[0], 0x1f);
  assert.equal(warc[1], 0x8b);
  const { gunzipSync } = await import('node:zlib');
  const text = gunzipSync(warc).toString('utf8');
  assert.match(text, /WARC\/1\.1/);
  assert.match(text, /WARC-Target-URI: https:\/\/example\.com\//);
  assert.match(text, /hello/);
});
