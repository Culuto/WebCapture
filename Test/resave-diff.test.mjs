import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { archiveDiff, diffLines, htmlToLines, pageDiff } from '../server/archive-diff.mjs';

test('差分：本文を行に分け、スクリプトやタグの違いは無視して、追加・削除行を出す', () => {
  assert.deepEqual(htmlToLines('<h1>見出し</h1><p>A&amp;B</p><script>var x=1</script><p>  二行目 </p>'), ['見出し', 'A&B', '二行目']);
  const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
  assert.deepEqual(ops, [
    { type: 'same', text: 'a' }, { type: 'remove', text: 'b' }, { type: 'add', text: 'x' },
    { type: 'same', text: 'c' }, { type: 'same', text: 'd' }, { type: 'add', text: 'e' }
  ]);
  assert.deepEqual(diffLines(['same'], ['same']), [{ type: 'same', text: 'same' }]);
});

test('再保存：同じ設定で新しいアーカイブを作り、前回と比べて追加・削除・変更されたページを出す', { timeout: 60000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-resave-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let version = 1;
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname === '/robots.txt') { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (pathname === '/') return res.end(version === 1 ? '<title>Root</title><a href="/news">news</a><a href="/old">old</a><a href="/same">same</a>' : '<title>Root</title><a href="/news">news</a><a href="/new">new</a><a href="/same">same</a>');
    if (pathname === '/news') return res.end(version === 1 ? '<title>News</title><p>価格は100円</p><p>在庫あり</p>' : '<title>News</title><p>価格は120円</p><p>在庫あり</p>');
    if (pathname === '/same') return res.end(`<title>Same</title><p>変わらない</p><script>window.t=${Date.now() + version}</script>`);
    res.end(`<title>${pathname}</title>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const store = await new VaultStore(root).init();
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  const first = await store.addJob({ startUrl: `${base}/`, options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', concurrency: 1, maxPages: 20 } });
  await manager.run(first.id);
  version = 2;
  const second = await manager.resaveArchive(first.archiveId);
  assert.notEqual(second.archiveId, first.archiveId);
  await manager.running.get(second.id);
  const archive = store.getArchive(second.archiveId);
  assert.equal(archive.previousArchiveId, first.archiveId);
  assert.ok(store.getArchive(first.archiveId), '前回のアーカイブは残す');
  const diff = await archiveDiff(store, second.archiveId, first.archiveId);
  assert.deepEqual(diff.added.map((item) => new URL(item.url).pathname), ['/new']);
  assert.deepEqual(diff.removed.map((item) => new URL(item.url).pathname), ['/old']);
  assert.deepEqual(diff.changed.map((item) => new URL(item.url).pathname).sort(), ['/', '/news']);
  assert.ok(diff.unchangedCount >= 1, 'スクリプトだけ違うページは変更なし');
  const detail = await pageDiff(store, second.archiveId, first.archiveId, `${base}/news`);
  assert.deepEqual(detail.ops.filter((op) => op.type !== 'same'), [{ type: 'remove', text: '価格は100円' }, { type: 'add', text: '価格は120円' }]);
  assert.equal((await archiveDiff(store, second.archiveId, first.archiveId)).computedAt, diff.computedAt, '変わっていなければ前回の計算を使う');
});
