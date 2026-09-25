import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { VaultStore } from '../server/store.mjs';
import { createWarc } from '../server/warc.mjs';
import { commitArchiveRepair, recoverArchiveRepairs } from '../server/repair-transaction.mjs';

async function fixture(t, withWarc = true) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-repair-transaction-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const job = await store.addJob({ startUrl: 'https://example.com/', options: { discoveryMode: 'immediate' } });
  const id = job.archiveId;
  const originalHtml = Buffer.from('<main>Original page</main>');
  const pageBlob = await store.writeBlob(id, originalHtml);
  const originalWarc = withWarc ? createWarc([{ url: 'https://example.com/', httpPayload: Buffer.from('HTTP/1.1 200 OK\r\n\r\nOriginal page') }]) : Buffer.alloc(0);
  const warcFile = path.join(store.archiveRoot(id), 'collection.warc.gz');
  if (withWarc) await fs.writeFile(warcFile, originalWarc);
  const manifest = { id, pages: [{ url: 'https://example.com/', html: pageBlob.file }], resources: {}, blocked: [], options: { warcEnabled: withWarc } };
  await store.writeManifest(id, manifest);
  const originalBytes = pageBlob.size + originalWarc.length;
  const archive = { id, startUrl: 'https://example.com/', pages: 1, resources: 0, bytes: originalBytes, errors: 0, status: 'complete', savedAt: new Date().toISOString() };
  await store.addArchive(archive);
  await store.updateJob(job.id, { pages: 1, bytes: originalBytes, status: 'complete' });
  const image = Buffer.from('<svg>Preserved image</svg>');
  const imageBlob = await store.writeBlob(id, image);
  const imageUrl = 'https://example.com/image.svg';
  const warcChunk = withWarc ? createWarc([{ url: imageUrl, httpPayload: Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n\r\n'), image]) }]) : Buffer.alloc(0);
  const nextManifest = { ...manifest, resources: { [imageUrl]: { url: imageUrl, status: 200, mimeType: 'image/svg+xml', ...imageBlob } } };
  const expectedBytes = originalBytes + imageBlob.size + warcChunk.length;
  return {
    root, store, id, jobId: job.id, originalHtml, pageBlob, originalWarc, warcFile, warcChunk, expectedBytes,
    next: { manifest: nextManifest, warcChunk, archive: { ...archive, resources: 1, bytes: expectedBytes }, jobs: [{ id: job.id, resources: 1, bytes: expectedBytes }] }
  };
}

async function interrupted(f, phase = 'prepared') {
  await assert.rejects(commitArchiveRepair(f.store, f.id, f.next, {
    checkpoint: async current => { if (current === phase) throw new Error(`interrupted:${phase}`); }
  }), new RegExp(`interrupted:${phase}`));
}

async function assertRecovered(f) {
  const recovered = await new VaultStore(f.root).init();
  assert.equal(recovered.repairRecoveryFailures.size, 0);
  assert.equal(recovered.getArchive(f.id).resources, 1);
  assert.equal(recovered.getArchive(f.id).bytes, f.expectedBytes);
  assert.equal(recovered.getJob(f.jobId).resources, 1);
  assert.equal(recovered.getJob(f.jobId).bytes, f.expectedBytes);
  assert.equal(Object.keys((await recovered.readManifest(f.id)).resources).length, 1);
  assert.deepEqual(await fs.readFile(path.join(recovered.archiveRoot(f.id), f.pageBlob.file)), f.originalHtml);
  if (f.warcChunk.length) {
    const warc = await fs.readFile(f.warcFile);
    assert.deepEqual(warc, Buffer.concat([f.originalWarc, f.warcChunk]));
    const text = gunzipSync(warc).toString();
    assert.equal(text.split('WARC-Target-URI: https://example.com/image.svg').length - 1, 1);
  } else await assert.rejects(fs.access(f.warcFile), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.root, '.archive-repairs', f.id)), { code: 'ENOENT' });
  const second = await new VaultStore(f.root).init();
  assert.equal(second.getArchive(f.id).bytes, f.expectedBytes);
  assert.equal(second.getJob(f.jobId).bytes, f.expectedBytes);
  return recovered;
}

for (const phase of ['prepared', 'warc', 'manifest', 'archive', 'jobs']) {
  test(`補完の${phase}段階で停止しても、再起動で原本を保ったまま1回だけ反映する`, async t => {
    const f = await fixture(t);
    await interrupted(f, phase);
    await assertRecovered(f);
  });
}

test('補完WARCが部分書込みされた状態から、残りのbytesだけを復旧する', async t => {
  const f = await fixture(t);
  await interrupted(f);
  await fs.appendFile(f.warcFile, f.warcChunk.subarray(0, 17));
  await assertRecovered(f);
});

test('WARCなしの設定でもmanifestと件数の中断復旧を行い、WARCを勝手に作らない', async t => {
  const f = await fixture(t, false);
  await interrupted(f, 'manifest');
  await assertRecovered(f);
});

test('補完中WARCが一致しない場合は原本と準備記録を残し、他アーカイブの表示・保存を止めない', async t => {
  const f = await fixture(t);
  await interrupted(f);
  await fs.appendFile(f.warcFile, Buffer.alloc(17, 0x5a));
  const damagedWarc = await fs.readFile(f.warcFile);
  const recovered = await new VaultStore(f.root).init();
  assert.equal(recovered.repairRecoveryFailures.get(f.id)?.status, 'failed');
  assert.equal(Object.keys((await recovered.readManifest(f.id)).resources).length, 0);
  assert.deepEqual(await fs.readFile(f.warcFile), damagedWarc);
  assert.deepEqual(damagedWarc.subarray(0, f.originalWarc.length), f.originalWarc);
  await assert.rejects(recovered.writeBlob(f.id, Buffer.from('wrong')), /復旧/);
  await assert.rejects(recovered.restoreJobQueue(f.jobId), /復旧/);
  await assert.rejects(recovered.deleteArchive(f.id), /復旧/);
  await recovered.writeManifest('archive_other_fixture', { id: 'archive_other_fixture', pages: [] });
  assert.deepEqual((await recovered.readManifest('archive_other_fixture')).pages, []);
  await fs.truncate(f.warcFile, f.originalWarc.length);
  await recoverArchiveRepairs(recovered);
  assert.equal(recovered.repairRecoveryFailures.size, 0);
  await assertRecovered(f);
});

for (const file of ['manifest.json', 'warc-addition.gz']) {
  test(`補完準備の${file}が破損した場合はWARCや元ページを更新しない`, async t => {
    const f = await fixture(t);
    await interrupted(f);
    await fs.writeFile(path.join(f.root, '.archive-repairs', f.id, file), file.endsWith('.json') ? '{}' : 'corrupted');
    const recovered = await new VaultStore(f.root).init();
    assert.equal(recovered.repairRecoveryFailures.get(f.id)?.status, 'failed');
    assert.deepEqual(await fs.readFile(f.warcFile), f.originalWarc);
    assert.equal(recovered.getArchive(f.id).bytes, f.expectedBytes - f.next.warcChunk.length - Buffer.byteLength('<svg>Preserved image</svg>'));
    assert.equal(Object.keys((await recovered.readManifest(f.id)).resources).length, 0);
  });
}
