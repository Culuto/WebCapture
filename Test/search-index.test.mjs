import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { VaultStore } from '../server/store.mjs';
import { SearchIndex, htmlToSearchText } from '../server/search-index.mjs';

test('HTMLから検索用の本文だけを取り出す', () => {
  const text = htmlToSearchText('<title>題</title><style>.a{}</style><script>var hidden=1</script><p>こんにちは&amp;世界&#x21;</p><!-- メモ -->');
  assert.equal(text, '題 こんにちは&世界!');
});

test('保存したページの本文を全アーカイブ横断で検索でき、索引がなくても保存データから作る', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-search-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/robots.txt') return res.end('');
    if (req.url === '/') return res.end('<title>トップ</title><p>アクリルスタンドの受注について</p><a href="/faq">faq</a>');
    res.end('<title>よくある質問</title><p>配送は約2週間です。アクリル製品は丁寧に梱包します。</p>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const store = await new VaultStore(root).init();
  const searchIndex = new SearchIndex(store);
  const job = await store.addJob({ startUrl: `http://127.0.0.1:${server.address().port}/`, options: { ...DEFAULT_CAPTURE_OPTIONS, policyOptions: { allowPrivateForTests: true }, captureRendered: false, respectRobots: false, discoveryMode: 'immediate', maxPages: 5 } });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, searchIndex });
  await manager.run(job.id);
  const both = await searchIndex.search('アクリル');
  assert.equal(both.total, 2);
  const narrowed = await searchIndex.search('アクリル 配送');
  assert.equal(narrowed.total, 1);
  assert.equal(narrowed.results[0].title, 'よくある質問');
  assert.match(narrowed.results[0].snippet, /配送/);
  assert.equal(narrowed.results[0].archiveId, job.archiveId);
  await fs.rm(path.join(store.archiveRoot(job.archiveId), 'search-index.jsonl'));
  const rebuilt = await new SearchIndex(store).search('梱包');
  assert.equal(rebuilt.total, 1, '索引ファイルがなくても保存データから作り直す');
  assert.equal((await searchIndex.search('存在しない言葉')).total, 0);
});
