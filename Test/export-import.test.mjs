import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore, createId } from '../server/store.mjs';
import { exportFileName, exportWebCapture, exportWacz, importWebCapture, surtKey, tarHeader } from '../server/archive-export.mjs';

async function collect(write) {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  await write(stream);
  stream.end();
  return Buffer.concat(chunks);
}

function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, 'ZIPの終わりの記録がある');
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = new Map();
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localName = buffer.readUInt16LE(offset + 26);
    const localExtra = buffer.readUInt16LE(offset + 28);
    const data = buffer.subarray(offset + 30 + localName + localExtra, offset + 30 + localName + localExtra + size);
    assert.equal(method, 0);
    assert.equal(zlib.crc32(data) >>> 0, crc, `${name} のCRC`);
    entries.set(name, data);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function savedArchive(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-export-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    if (pathname === '/logo.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(Buffer.from('89504e470d0a1a0a', 'hex')); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pathname === '/' ? '<title>保存テスト</title><img src="/logo.png"><a href="/a">a</a>' : '<title>A</title><p>本文</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(path.join(root, 'source')).init();
  const job = await store.addJob({ startUrl: `http://127.0.0.1:${server.address().port}/`, options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 1, maxPages: 5 } });
  await new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS }).run(job.id);
  return { root, store, archiveId: job.archiveId };
}

test('WebCapture形式：1ファイルに書き出し、別の場所のWebCaptureで同じ内容を読み込める', { timeout: 60000 }, async (t) => {
  const { root, store, archiveId } = await savedArchive(t);
  await fs.writeFile(path.join(store.archiveRoot(archiveId), 'storage-summary.json'), '{}');
  const file = await collect((out) => exportWebCapture(store, archiveId, out, { appVersion: 'test' }));
  assert.equal(file.length % 512, 0);
  const target = await new VaultStore(path.join(root, 'target')).init();
  const imported = await importWebCapture(target, Readable.from([file.subarray(0, 700), file.subarray(700)]), { importsRoot: path.join(root, 'target', 'imports'), createArchiveId: () => createId('archive') });
  assert.equal(imported.archive.id, archiveId, '重複しなければ元のIDのまま');
  const original = await store.readManifest(archiveId);
  const copy = await target.readManifest(archiveId);
  assert.equal(copy.pages.length, original.pages.length);
  for (const page of copy.pages) assert.equal(await fs.readFile(path.join(target.archiveRoot(archiveId), page.html), 'utf8'), await fs.readFile(path.join(store.archiveRoot(archiveId), page.html), 'utf8'));
  await assert.rejects(fs.stat(path.join(target.archiveRoot(archiveId), 'storage-summary.json')), { code: 'ENOENT' }, '計算用の一時ファイルは含めない');
  assert.equal(target.getArchive(archiveId).pages, original.pages.length);
  const again = await importWebCapture(target, Readable.from([file]), { importsRoot: path.join(root, 'target', 'imports'), createArchiveId: () => createId('archive') });
  assert.notEqual(again.archive.id, archiveId, '同じものを2回読み込むと別のIDで追加する');
  assert.equal((await target.readManifest(again.archive.id)).id, again.archive.id);
  assert.match(exportFileName({ title: 'a/b:c', savedAt: '2026-09-25T00:00:00Z' }, 'wacz'), /^a_b_c-2026-09-25\.wacz$/);
});

test('旧名（SiteVault）で書き出した .sitevault ファイルも読み込める', { timeout: 60000 }, async (t) => {
  const { root, store, archiveId } = await savedArchive(t);
  const file = await collect((out) => exportWebCapture(store, archiveId, out, { appVersion: 'test' }));
  const metaSize = parseInt(file.toString('ascii', 124, 136).replace(/\0.*$/, '').trim(), 8);
  const metaBlocks = Math.ceil(metaSize / 512) * 512;
  const meta = JSON.parse(file.toString('utf8', 512, 512 + metaSize));
  const legacyMeta = Buffer.from(JSON.stringify({ ...meta, format: 'sitevault-archive' }));
  const legacyPadding = Buffer.alloc((512 - (legacyMeta.length % 512)) % 512);
  const legacy = Buffer.concat([tarHeader('sitevault-export.json', legacyMeta.length), legacyMeta, legacyPadding, file.subarray(512 + metaBlocks)]);
  const target = await new VaultStore(path.join(root, 'legacy-target')).init();
  const imported = await importWebCapture(target, Readable.from([legacy]), { importsRoot: path.join(root, 'legacy-target', 'imports'), createArchiveId: () => createId('archive') });
  assert.equal(imported.archive.id, archiveId);
  assert.ok(imported.fileCount > 0);
});

test('WebCapture形式の読み込みは、危ないファイル名や別形式のファイルを受け付けない', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-import-bad-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(path.join(root, 'data')).init();
  const pad = (buffer) => Buffer.concat([buffer, Buffer.alloc((512 - (buffer.length % 512)) % 512)]);
  const meta = Buffer.from(JSON.stringify({ format: 'webcapture-archive', version: 1, archive: {} }));
  const evil = Buffer.from('x');
  const tar = Buffer.concat([tarHeader('webcapture-export.json', meta.length), pad(meta), tarHeader('archive/../../evil.txt', evil.length), pad(evil), Buffer.alloc(1024)]);
  await assert.rejects(importWebCapture(store, Readable.from([tar]), { importsRoot: path.join(root, 'imports'), createArchiveId: () => createId('archive') }), /安全でない/);
  await assert.rejects(fs.stat(path.join(root, 'evil.txt')), { code: 'ENOENT' });
  const other = Buffer.concat([tarHeader('readme.txt', 1), pad(Buffer.from('x')), Buffer.alloc(1024)]);
  await assert.rejects(importWebCapture(store, Readable.from([other]), { importsRoot: path.join(root, 'imports'), createArchiveId: () => createId('archive') }), /書き出しファイルではありません/);
  assert.deepEqual(await fs.readdir(path.join(root, 'imports')), [], '失敗した読み込みの途中ファイルは残さない');
});

test('WACZ形式：一般の閲覧ツールが読むZIP（通信記録・ページ一覧・索引・目録）を作る', { timeout: 60000 }, async (t) => {
  const { root, store, archiveId } = await savedArchive(t);
  const zip = await collect((out) => exportWacz(store, archiveId, out, { workRoot: path.join(root, 'work') }));
  const entries = readZip(zip);
  assert.deepEqual([...entries.keys()].sort(), ['archive/data.warc.gz', 'datapackage.json', 'indexes/index.cdxj', 'pages/pages.jsonl']);
  const datapackage = JSON.parse(entries.get('datapackage.json'));
  for (const resource of datapackage.resources) {
    const data = entries.get(resource.path);
    assert.equal(resource.bytes, data.length);
    assert.equal(resource.hash, `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`);
  }
  const pages = entries.get('pages/pages.jsonl').toString().trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(pages[0].format, 'json-pages-1.0');
  const manifest = await store.readManifest(archiveId);
  assert.deepEqual(pages.slice(1).map((page) => page.url).sort(), manifest.pages.map((page) => page.url).sort());
  const warc = entries.get('archive/data.warc.gz');
  const lines = entries.get('indexes/index.cdxj').toString().trim().split('\n');
  assert.deepEqual([...lines].sort(), lines, '索引は並び替え済み');
  const logo = lines.find((line) => line.includes('/logo.png'));
  const info = JSON.parse(logo.slice(logo.indexOf('{')));
  const record = zlib.gunzipSync(warc.subarray(Number(info.offset), Number(info.offset) + Number(info.length))).toString('latin1');
  assert.match(record, /^WARC\/1\.1\r\n/);
  assert.match(record, /WARC-Target-URI: http:\/\/127\.0\.0\.1:\d+\/logo\.png/);
  assert.match(record, /HTTP\/1\.1 200 OK/);
  assert.ok(record.includes(Buffer.from('89504e470d0a1a0a', 'hex').toString('latin1')));
  assert.equal(surtKey('https://www.Example.com/Path?b=2&a=1'), 'com,example)/path?a=1&b=2');
  assert.deepEqual(await fs.readdir(path.join(root, 'work')), [], '作業用ファイルを残さない');
});
