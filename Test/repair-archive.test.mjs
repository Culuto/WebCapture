import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { VaultStore } from '../server/store.mjs';
import { createWarc } from '../server/warc.mjs';

test('オフライン補完はdata画像を壊さず拡大画像を取得し、HTTP失敗を成功にしない', async t => {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-repair-test-'));
  t.after(() => fs.rm(dataRoot, { recursive: true, force: true }));
  const server = http.createServer((req, res) => { res.writeHead(req.url === '/bad.svg' ? 403 : 200, { 'content-type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const appPort = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const store = await new VaultStore(dataRoot).init();
  const id = 'archive_repair_fixture';
  const blob = await store.writeBlob(id, Buffer.from('<img srcset="data:image/svg+xml;base64,PHN2Zy8+ 1x, /candidate.svg 2x" data_max_resolution="/hi.svg"><img srcset="/bad.svg 1x">'));
  await store.writeManifest(id, { id, startUrl: base, pages: [{ url: base, html: blob.file }], resources: {}, resourceAliases: {}, blocked: [], options: { warcEnabled: true, policyOptions: { allowPrivateForTests: true } } });
  const before = createWarc([{ url: base, httpPayload: Buffer.from('HTTP/1.1 200 OK\r\n\r\noriginal') }]);
  await fs.writeFile(path.join(store.archiveRoot(id), 'collection.warc.gz'), before);
  await store.addArchive({ id, startUrl: base, pages: 1, resources: 0, bytes: blob.size + before.length, errors: 0, status: 'complete', savedAt: new Date().toISOString() });
  let report;
  try { await promisify(execFile)(process.execPath, ['scripts/repair-archive-srcset.mjs', id], { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, env: { ...process.env, WEBCAPTURE_DATA_ROOT: dataRoot, WEBCAPTURE_PORT: String(appPort) } }); assert.fail('HTTP失敗を成功扱いにしました'); }
  catch (error) { assert.equal(error.code, 1); report = JSON.parse(error.stdout); }
  assert.equal(report.candidates, 3);
  assert.equal(report.repaired, 2);
  assert.equal(report.failures.length, 1);
  const repaired = JSON.parse(await fs.readFile(path.join(store.archiveRoot(id), 'manifest.json'), 'utf8'));
  assert.equal(repaired.resources[`${base}hi.svg`].status, 200);
  assert.equal(repaired.resources[`${base}bad.svg`], undefined);
  assert.equal(repaired.referenceAudit.missingCount, 1);
  assert.deepEqual(await fs.readFile(path.join(store.archiveRoot(id), blob.file)), Buffer.from('<img srcset="data:image/svg+xml;base64,PHN2Zy8+ 1x, /candidate.svg 2x" data_max_resolution="/hi.svg"><img srcset="/bad.svg 1x">'));
  const warc = await fs.readFile(path.join(store.archiveRoot(id), 'collection.warc.gz'));
  assert.deepEqual(warc.subarray(0, before.length), before);
  assert.match(gunzipSync(warc).toString(), /original/);
});
