import test from 'node:test';
import assert from 'node:assert/strict';
import { safeUrl, orderRecentLogFiles } from '../server/logger.mjs';

test('診断URLは個人情報を隠し、再処理しても表示形式を壊さない', () => {
  const once = safeUrl('https://user:pass@example.com/private/profile/avatar.png?email=person%40example.com&width=640');
  const twice = safeUrl(once);
  assert.equal(twice, once);
  assert.match(once, /^https:\/\/example\.com\/\[segments:3;ext:\.png\]\?keys=\[redacted-key\],width#id=[a-f0-9]{16}$/);
  assert.doesNotMatch(once, /user|pass|private|profile|person/i);
});

test('回転ログはファイル名ではなく更新日時の新しい順で読む', () => {
  const files = orderRecentLogFiles([
    { name: 'webcapture-2026-09-14.jsonl', modified: 100 },
    { name: 'webcapture-2026-09-14-2.jsonl', modified: 300 },
    { name: 'webcapture-2026-09-14-10.jsonl', modified: 200 }
  ]);
  assert.deepEqual(files, ['webcapture-2026-09-14-2.jsonl', 'webcapture-2026-09-14-10.jsonl', 'webcapture-2026-09-14.jsonl']);
});
