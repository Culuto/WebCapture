import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VaultStore } from '../server/store.mjs';
import { NotificationCenter } from '../server/notifications.mjs';
import { ScheduleService, nextRunAt, normalizeSchedule, describeDiff } from '../server/schedules.mjs';
import { BatchQueue, parseUrlList } from '../server/batch-queue.mjs';
import { PresetStore, BUILT_IN_PRESETS, sanitizePresetFields } from '../server/presets.mjs';
import { WatchService, validateSelector, normalizeWatchText, httpWatchReader } from '../server/watches.mjs';
import { BlobDedupeService, sharedBlobStats } from '../server/blob-dedupe.mjs';
import { StorageCleanupService, deferredEntriesFor, normalizeCleanupSettings } from '../server/storage-cleanup.mjs';
import { SearchIndex } from '../server/search-index.mjs';
import { pageHistory } from '../server/page-history.mjs';
import { buildIssueReport, retryOptionOverrides } from '../server/issue-report.mjs';

async function tempRoot(t, name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `webcapture-${name}-`));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function archiveFixture(store, id, { startUrl = 'https://example.com/', savedAt, html = '<title>A</title><p>Hello</p>', resources = {}, blobs = [] } = {}) {
  const page = await store.writeBlob(id, Buffer.from(html));
  const written = {};
  for (const [url, body, mimeType] of blobs) {
    const blob = await store.writeBlob(id, Buffer.from(body));
    written[url] = { url, status: 200, mimeType, digest: blob.digest, file: blob.file, size: blob.size };
  }
  await store.writeManifest(id, { id, startUrl, pages: [{ url: startUrl, title: 'A', html: page.file }], resources: { ...resources, ...written }, blocked: [] });
  await store.addArchive({ id, startUrl, title: `Archive ${id}`, status: 'complete', pages: 1, resources: Object.keys(written).length, bytes: 1000, errors: 0, savedAt: savedAt || new Date().toISOString() });
  return written;
}

test('お知らせ：追加・既読・保存後の読み直しができ、デスクトップ通知は設定に従う', async (t) => {
  const root = await tempRoot(t, 'notify');
  const shown = [];
  let desktop = true;
  const center = await new NotificationCenter({ dataRoot: root, desktop: (title, message) => shown.push({ title, message }), desktopEnabled: () => desktop }).init();
  await center.add({ kind: 'watch', title: '変化がありました（example.com）', message: '前：1\n今：2', url: 'https://example.com/' });
  desktop = false;
  await center.add({ kind: 'nonsense', title: 'x'.repeat(500) });
  assert.equal(shown.length, 1, '通知OFFのときはデスクトップ通知を出さない');
  const listed = center.list();
  assert.equal(listed.unread, 2);
  assert.equal(listed.items[0].kind, 'info', '未知の種類は info にする');
  assert.equal(listed.items[0].title.length, 200);
  await center.markRead([listed.items[1].id]);
  const reloaded = await new NotificationCenter({ dataRoot: root }).init();
  assert.equal(reloaded.list().unread, 1, '既読の状態がファイルに残る');
  await reloaded.markRead();
  assert.equal(reloaded.list().unread, 0);
});

test('定期保存：次回時刻の計算（毎時・毎日・毎週）と入力の検査', () => {
  const from = new Date(2026, 8, 25, 10, 30, 0);
  assert.deepEqual(nextRunAt({ frequency: 'hourly', minute: 15 }, from), new Date(2026, 8, 25, 11, 15, 0));
  assert.deepEqual(nextRunAt({ frequency: 'hourly', minute: 45 }, from), new Date(2026, 8, 25, 10, 45, 0));
  assert.deepEqual(nextRunAt({ frequency: 'daily', hour: 3, minute: 0 }, from), new Date(2026, 8, 26, 3, 0, 0));
  assert.deepEqual(nextRunAt({ frequency: 'daily', hour: 23, minute: 5 }, from), new Date(2026, 8, 25, 23, 5, 0));
  const weekly = nextRunAt({ frequency: 'weekly', weekday: from.getDay(), hour: 9, minute: 0 }, from);
  assert.equal(Math.round((weekly - from) / 86400000), 7, '同じ曜日で時刻が過ぎていれば翌週');
  assert.throws(() => normalizeSchedule({ frequency: 'yearly' }), /毎時/);
  assert.deepEqual(normalizeSchedule({ frequency: 'daily', hour: 99, minute: -3 }), { frequency: 'daily', hour: 23, minute: 0, weekday: 0, enabled: true });
  assert.match(describeDiff({ added: [1], changed: [1, 2], removed: [] }), /追加1ページ・変更2ページ・削除0ページ/);
  assert.equal(describeDiff({ added: [], changed: [], removed: [] }), '前回から変わったページはありません。');
});

test('定期保存：期限が来たら再保存し、終わったら新しいアーカイブへ追従して差分を知らせる', async (t) => {
  const root = await tempRoot(t, 'schedule');
  const store = await new VaultStore(root).init();
  await archiveFixture(store, 'archive_schedule_a');
  let now = new Date(2026, 8, 25, 10, 0, 0);
  const started = [];
  let busy = false;
  const crawler = {
    archiveBusy: () => busy,
    resaveArchive: async (archiveId) => { const job = await store.addJob({ startUrl: 'https://example.com/', options: {} }); started.push({ archiveId, job }); return job; }
  };
  const notes = [];
  const notifications = { add: async (item) => notes.push(item) };
  const service = await new ScheduleService({ dataRoot: root, store, crawler, notifications, now: () => now, diff: async () => ({ added: [{}], changed: [], removed: [{}, {}] }) }).init();
  const saved = await service.upsert('archive_schedule_a', { frequency: 'daily', hour: 11, minute: 0 });
  assert.equal(new Date(saved.nextRunAt).getHours(), 11);
  await service.tick();
  assert.equal(started.length, 0, '時刻前は実行しない');
  now = new Date(2026, 8, 25, 11, 0, 30);
  busy = true;
  await service.tick();
  assert.equal(started.length, 0, '保存中なら後に回す');
  assert.equal(service.list()[0].lastResult.status, 'waiting');
  now = new Date(2026, 8, 25, 11, 20, 0);
  busy = false;
  await service.tick();
  assert.equal(started.length, 1);
  const job = started[0].job;
  assert.equal(store.getJob(job.id).scheduleId, saved.id);
  assert.equal(new Date(service.list()[0].nextRunAt).getDate(), 26, '次回は翌日');
  const handled = await service.handleJobFinished({ jobId: job.id, archiveId: job.archiveId, startUrl: 'https://example.com/', status: 'complete', pages: 3, title: 'New' });
  assert.equal(handled.archiveId, job.archiveId, '次回からは新しいアーカイブを元に再保存する');
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /追加1ページ・変更0ページ・削除2ページ/);
  assert.equal(await service.handleJobFinished({ jobId: 'job_other', archiveId: 'x', pages: 1 }), null, '定期保存以外の完了は扱わない');
  const reloaded = await new ScheduleService({ dataRoot: root, store, crawler, now: () => now }).init();
  assert.equal(reloaded.list()[0].archiveId, job.archiveId, '予定はファイルに残る');
});

test('定期保存：元のアーカイブが消えていたら止め、予定の削除もできる', async (t) => {
  const root = await tempRoot(t, 'schedule-gone');
  const store = await new VaultStore(root).init();
  await archiveFixture(store, 'archive_schedule_gone');
  let now = new Date(2026, 8, 25, 10, 0, 0);
  const service = await new ScheduleService({ dataRoot: root, store, crawler: { archiveBusy: () => false, resaveArchive: async () => { throw new Error('呼ばれない'); } }, now: () => now }).init();
  const item = await service.upsert('archive_schedule_gone', { frequency: 'hourly', minute: 5 });
  await store.deleteArchive('archive_schedule_gone');
  now = new Date(2026, 8, 25, 12, 0, 0);
  await service.tick();
  assert.equal(service.list()[0].enabled, false);
  assert.match(service.list()[0].lastResult.message, /削除/);
  await service.remove(item.id);
  assert.equal(service.list().length, 0);
  await assert.rejects(() => service.remove(item.id), /見つかりません/);
});

test('まとめて保存：URLの読み取り、1件ずつ順番に開始、取り消し、完了のお知らせ', async (t) => {
  const parsed = parseUrlList('https://example.com/a\nnot-a-url, https://example.com/b\nftp://example.com/x\nhttps://example.com/a');
  assert.deepEqual(parsed.urls, ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(parsed.invalid, ['not-a-url', 'ftp://example.com/x']);
  const root = await tempRoot(t, 'batch');
  const jobs = new Map();
  const store = { getJob: (id) => jobs.get(id) };
  const started = [];
  const notes = [];
  const queue = await new BatchQueue({
    dataRoot: root, store, notifications: { add: async (item) => notes.push(item) },
    startJob: async (url, options) => {
      if (url.endsWith('/fail')) throw new Error('公開されていないアドレスです。');
      const job = { id: `job_${started.length}`, archiveId: `archive_${started.length}`, status: 'running' };
      jobs.set(job.id, job);
      started.push({ url, options });
      return job;
    }
  }).init();
  await assert.rejects(() => queue.create({ text: 'nothing here' }), /URLが見つかりません/);
  const { batch } = await queue.create({ text: 'https://example.com/1\nhttps://example.com/fail\nhttps://example.com/2\nhttps://example.com/3', options: { concurrency: 2 } });
  await queue.tick();
  assert.equal(started.length, 1, '同時には1件だけ始める');
  assert.deepEqual(started[0].options, { concurrency: 2 });
  await queue.tick();
  assert.equal(started.length, 1, '前の保存が終わるまで次へ進まない');
  jobs.get('job_0').status = 'complete';
  await queue.tick();
  assert.equal(started.length, 2, '失敗したURLは記録して次へ進む');
  const afterFail = queue.list().find((item) => item.id === batch.id);
  assert.equal(afterFail.failed, 1);
  assert.match(afterFail.entries[1].message, /公開されていない/);
  await queue.cancel(batch.id);
  jobs.get('job_1').status = 'failed';
  await queue.tick();
  const finished = queue.list().find((item) => item.id === batch.id);
  assert.equal(finished.status, 'cancelled');
  assert.deepEqual([finished.done, finished.failed, finished.skipped], [1, 2, 1]);
  assert.equal(notes.length, 1);
  assert.equal(started.length, 2, '取り消した後は新しく始めない');
});

test('プリセット：組み込みは消せず、同じ名前は上書き、設定値は検査して保存する', async (t) => {
  const root = await tempRoot(t, 'preset');
  const presets = await new PresetStore({ dataRoot: root }).init();
  assert.ok(BUILT_IN_PRESETS.some((item) => item.name === '重いサイト用'));
  assert.ok(BUILT_IN_PRESETS.some((item) => item.fields['save-media'] === false), '動画なしは動画の保存を切る');
  assert.deepEqual(sanitizePresetFields({ concurrency: 3, 'capture-mobile': true, 'Bad Key': 'x', note: 'x'.repeat(600) }), { concurrency: '3', 'capture-mobile': true });
  assert.throws(() => sanitizePresetFields({}), /設定がありません/);
  const first = await presets.save({ name: ' 仕事用 ', fields: { concurrency: '2' }, scope: 'external' });
  assert.equal(first.name, '仕事用');
  const second = await presets.save({ name: '仕事用', fields: { concurrency: '4' } });
  assert.equal(second.id, first.id, '同じ名前は上書き');
  await assert.rejects(() => presets.save({ name: '重いサイト用', fields: { concurrency: '1' } }), /組み込み/);
  await assert.rejects(() => presets.remove('builtin_heavy'), /組み込み/);
  const reloaded = await new PresetStore({ dataRoot: root }).init();
  assert.equal(reloaded.list().find((item) => item.id === first.id).fields.concurrency, '4');
  await reloaded.remove(first.id);
  assert.equal(reloaded.list().filter((item) => !item.builtIn).length, 0);
});

test('整理：タグ・フォルダ・メモを付け、絞り込み・一覧・再保存後も残る', async (t) => {
  const root = await tempRoot(t, 'meta');
  const store = await new VaultStore(root).init();
  await archiveFixture(store, 'archive_meta_a', { startUrl: 'https://a.example/' });
  await archiveFixture(store, 'archive_meta_b', { startUrl: 'https://b.example/' });
  const updated = await store.updateArchiveMeta('archive_meta_a', { tags: '仕事、参考, 仕事', folder: ' 調査\u0007資料 ', note: 'メモ\nです' });
  assert.deepEqual(updated.tags, ['仕事', '参考']);
  assert.equal(updated.folder, '調査 資料');
  assert.equal(updated.note, 'メモ\nです');
  assert.deepEqual(store.queryArchives({ tag: '参考' }).items.map((item) => item.id), ['archive_meta_a']);
  assert.deepEqual(store.queryArchives({ folder: '__none__' }).items.map((item) => item.id), ['archive_meta_b']);
  assert.deepEqual(store.queryArchives({ query: 'メモ' }).items.map((item) => item.id), ['archive_meta_a'], 'メモの文字でも探せる');
  const facets = store.archiveFacets();
  assert.deepEqual(facets.tags.map((item) => item.name).sort(), ['仕事', '参考']);
  assert.equal(facets.unfiled, 1);
  await store.addArchive({ ...store.getArchive('archive_meta_a'), tags: undefined, folder: undefined, note: undefined, status: 'complete-with-errors' });
  assert.deepEqual(store.getArchive('archive_meta_a').tags, ['仕事', '参考'], '保存処理が記録を書き直しても整理情報は消えない');
  const cleared = await store.updateArchiveMeta('archive_meta_a', { tags: [], folder: '', note: '' });
  assert.equal(cleared.tags, undefined);
  assert.equal(cleared.folder, undefined);
  const reloaded = await new VaultStore(root).init();
  assert.equal(reloaded.getArchive('archive_meta_a').note, undefined);
});

test('日付で見比べる：同じページを含む過去のアーカイブを新しい順に返す', async (t) => {
  const root = await tempRoot(t, 'history');
  const store = await new VaultStore(root).init();
  await archiveFixture(store, 'archive_hist_old', { savedAt: '2026-01-01T00:00:00.000Z', html: '<title>Old</title>' });
  await archiveFixture(store, 'archive_hist_new', { savedAt: '2026-06-01T00:00:00.000Z', html: '<title>New</title>' });
  await archiveFixture(store, 'archive_hist_other', { startUrl: 'https://other.example/', savedAt: '2026-07-01T00:00:00.000Z' });
  const history = await pageHistory(store, new SearchIndex(store), 'https://example.com/');
  assert.deepEqual(history.items.map((item) => item.archiveId), ['archive_hist_new', 'archive_hist_old']);
});

test('変化の見張り：最初は基準を記録し、変わったら知らせ、失敗は理由を残す', async (t) => {
  const root = await tempRoot(t, 'watch');
  let text = '価格 1,000円';
  let fail = false;
  const notes = [];
  let now = new Date(2026, 8, 25, 10, 0, 0);
  const service = await new WatchService({
    dataRoot: root, now: () => now, notifications: { add: async (item) => notes.push(item) },
    assertUrl: async (url) => { if (!/^https:\/\/example\.com/.test(url)) throw new Error('公開されていないアドレスです。'); return { url }; },
    reader: async () => { if (fail) throw new Error('ページを開けませんでした。'); return { text }; }
  }).init();
  await assert.rejects(() => service.add({ url: 'http://127.0.0.1/' }), /公開されていない/);
  assert.throws(() => validateSelector('a'.repeat(301)), /長すぎる/);
  const watch = await service.add({ url: 'https://example.com/item', selector: '.price', label: '価格', intervalMinutes: 60 });
  await service.check(watch.id);
  assert.equal(notes.length, 0, '最初の確認は基準として記録するだけ');
  text = '価格   1,000円';
  await service.check(watch.id);
  assert.equal(notes.length, 0, '空白の違いだけでは知らせない');
  text = '価格 900円';
  now = new Date(2026, 8, 25, 12, 0, 0);
  await service.check(watch.id);
  assert.equal(notes.length, 1);
  assert.match(notes[0].message, /1,000円[\s\S]*900円/);
  assert.equal(service.list()[0].history.length, 2);
  fail = true;
  await service.check(watch.id);
  assert.match(service.list()[0].lastError, /開けません/);
  assert.equal(new Date(service.list()[0].nextCheckAt).getTime(), now.getTime() + 60 * 60000, '失敗しても次の確認時刻を決める');
  await service.update(watch.id, { enabled: false });
  now = new Date(2026, 8, 26, 12, 0, 0);
  fail = false;
  text = '価格 800円';
  await service.tick();
  assert.equal(notes.length, 1, '止めた見張りは確認しない');
  assert.equal(normalizeWatchText('  a \n b '), 'a b');
  await assert.rejects(() => httpWatchReader(async () => { throw new Error('no'); })({ url: 'https://example.com', selector: '.x' }), /Chrome/);
});

test('共有化：同じ内容の素材をアーカイブ間でハードリンクにまとめ、前回の保存とは自動で共有する', async (t) => {
  const root = await tempRoot(t, 'dedupe');
  const store = await new VaultStore(root).init();
  store.blobSharing = false;
  const body = 'same-image-bytes'.repeat(1000);
  const a = await archiveFixture(store, 'archive_dedupe_a', { blobs: [['https://example.com/a.png', body, 'image/png']] });
  const b = await archiveFixture(store, 'archive_dedupe_b', { blobs: [['https://example.com/a.png', body, 'image/png']] });
  const fileA = path.join(store.archiveRoot('archive_dedupe_a'), a['https://example.com/a.png'].file);
  const fileB = path.join(store.archiveRoot('archive_dedupe_b'), b['https://example.com/a.png'].file);
  assert.notEqual((await fs.stat(fileA)).ino, (await fs.stat(fileB)).ino);
  const service = new BlobDedupeService({ store, isBusy: () => false });
  service.start();
  while (service.status().status === 'running') await new Promise((resolve) => setTimeout(resolve, 20));
  const task = service.status();
  assert.equal(task.status, 'completed');
  assert.ok(task.linkedFiles >= 1);
  assert.ok(task.savedBytes >= body.length);
  assert.equal((await fs.stat(fileA)).ino, (await fs.stat(fileB)).ino, '同じ実体を指す');
  assert.equal(await fs.readFile(fileB, 'utf8'), body, '内容は変わらない');
  assert.ok((await sharedBlobStats(store.archiveRoot('archive_dedupe_b'))).sharedBytes >= body.length);
  await store.deleteArchive('archive_dedupe_a');
  await store.waitForTrashCleanup();
  assert.equal(await fs.readFile(fileB, 'utf8'), body, '片方を消してももう片方は読める');

  store.blobSharing = true;
  const job = await store.addJob({ startUrl: 'https://example.com/', options: {} });
  store.getJob(job.id).previousArchiveId = 'archive_dedupe_b';
  const written = await store.writeBlob(job.archiveId, Buffer.from(body));
  assert.equal(written.shared, true, '前回の保存にある同じ素材は複製せず共有する');
  assert.equal((await fs.stat(path.join(store.archiveRoot(job.archiveId), written.file))).ino, (await fs.stat(fileB)).ino);
  const corruptBody = 'another-body';
  const corrupt = await store.writeBlob('archive_dedupe_b', Buffer.from(corruptBody));
  const corruptFile = path.join(store.archiveRoot('archive_dedupe_b'), corrupt.file);
  await fs.chmod(corruptFile, 0o644);
  await fs.writeFile(corruptFile, 'another-bodX');
  const fresh = await store.writeBlob(job.archiveId, Buffer.from(corruptBody));
  assert.notEqual(fresh.shared, true, '内容が壊れた素材とは共有しない');
  assert.equal(await fs.readFile(path.join(store.archiveRoot(job.archiveId), fresh.file), 'utf8'), corruptBody);
});

test('容量の自動整理：上限を超えたら古いアーカイブの動画だけの整理案を作り、確認後に消して後から取り直せる一覧に戻す', async (t) => {
  const root = await tempRoot(t, 'cleanup');
  const store = await new VaultStore(root).init();
  store.blobSharing = false;
  const video = 'v'.repeat(5000);
  await archiveFixture(store, 'archive_cleanup_old', { savedAt: '2026-01-01T00:00:00.000Z', blobs: [['https://example.com/movie.mp4', video, 'video/mp4'], ['https://example.com/seg/1.ts', 'segment-1', 'video/mp2t'], ['https://example.com/seg/2.ts', 'segment-2', 'video/mp2t'], ['https://example.com/logo.png', 'png', 'image/png']] });
  await archiveFixture(store, 'archive_cleanup_new', { savedAt: '2026-06-01T00:00:00.000Z', blobs: [['https://example.com/movie.mp4', video + 'new', 'video/mp4']] });
  await store.updateArchiveMeta('archive_cleanup_old', { tags: ['残す情報'] });
  const notes = [];
  const service = await new StorageCleanupService({ dataRoot: root, store, notifications: { add: async (item) => notes.push(item) } }).init();
  assert.throws(() => normalizeCleanupSettings({ limitGb: 0 }), /1GB以上/);
  await service.updateSettings({ enabled: true, limitGb: 1 });
  assert.equal(await service.check(), null, '上限以下なら何もしない');
  service.settings.limitGb = 1e-9;
  const plan = await service.check();
  assert.deepEqual(plan.items.map((item) => item.archiveId), ['archive_cleanup_old'], '各サイトの最新アーカイブは対象外');
  assert.equal(plan.items[0].mediaCount, 3);
  assert.equal(notes.length, 1);
  await service.check();
  assert.equal(notes.length, 1, '同じ日には何度も知らせない');
  await assert.rejects(() => service.execute('cleanup_old_plan'), /古く/);
  const result = await service.execute(plan.id);
  assert.equal(result.results[0].mediaCount, 3);
  assert.ok(result.freedBytes >= video.length);
  const manifest = await store.readManifest('archive_cleanup_old');
  assert.equal(manifest.resources['https://example.com/movie.mp4'], undefined);
  assert.ok(manifest.resources['https://example.com/logo.png'], '画像は残す');
  const deferred = manifest.deferredMedia;
  assert.ok(deferred.some((item) => item.url === 'https://example.com/movie.mp4' && item.kind === 'file' && item.pruned));
  const stream = deferred.find((item) => item.kind === 'stream');
  assert.deepEqual(stream.remainingUrls.sort(), ['https://example.com/seg/1.ts', 'https://example.com/seg/2.ts'], '分割ファイルはまとめて1件にする');
  const archive = store.getArchive('archive_cleanup_old');
  assert.ok(archive.prunedAt);
  assert.deepEqual(archive.tags, ['残す情報']);
  assert.ok((await store.readManifest('archive_cleanup_new')).resources['https://example.com/movie.mp4'], '新しいアーカイブは消さない');
  assert.equal(deferredEntriesFor([], new Date().toISOString()).length, 0);
});

test('失敗理由への対処：原因ごとに対処ボタンと取り直しの設定を持つ', () => {
  const report = buildIssueReport({
    blocked: [
      { url: 'https://example.com/slow', reason: 'ページを開けませんでした（読み込みがタイムアウトしました）。' },
      { url: 'https://example.com/deny', reason: 'HTTP 429' },
      { url: 'https://example.com/net', reason: 'ページを開けませんでした: net::ERR_CONNECTION_RESET' }
    ],
    pages: []
  });
  const byKey = Object.fromEntries(report.categories.map((item) => [item.key, item]));
  assert.equal(byKey.timeout.action, 'retry-gentle');
  assert.equal(byKey.refused.action, 'retry-spaced');
  assert.equal(byKey.network.action, 'retry');
  assert.ok(byKey.timeout.actionLabel);
  assert.equal(retryOptionOverrides('retry-gentle').concurrency, 1);
  assert.equal(retryOptionOverrides('retry-spaced').perHostIntervalMs, 5000);
  assert.deepEqual(retryOptionOverrides('unknown'), {});
});

test('容量の自動整理：共有されているアーカイブと、整理中のアーカイブへの保存・削除・後から保存を避ける', async (t) => {
  const root = await tempRoot(t, 'cleanup-safety');
  const store = await new VaultStore(root).init();
  store.blobSharing = false;
  await archiveFixture(store, 'archive_safe_shared', { savedAt: '2026-01-01T00:00:00.000Z', blobs: [['https://example.com/a.mp4', 'video-a', 'video/mp4']] });
  await archiveFixture(store, 'archive_safe_old', { savedAt: '2026-02-01T00:00:00.000Z', blobs: [['https://example.com/b.mp4', 'video-b', 'video/mp4']] });
  await archiveFixture(store, 'archive_safe_new', { savedAt: '2026-06-01T00:00:00.000Z' });
  const service = await new StorageCleanupService({ dataRoot: root, store, isShared: (id) => id === 'archive_safe_shared' }).init();
  service.settings.limitGb = 1e-9;
  const plan = await service.buildPlan();
  assert.deepEqual(plan.items.map((item) => item.archiveId), ['archive_safe_old'], 'ほかのアーカイブが共有しているものは整理案に入れない');
  await assert.rejects(() => service.pruneArchive('archive_safe_shared'), /共有/);
  const { CrawlManager } = await import('../server/crawler.mjs');
  const { DeferredMediaService } = await import('../server/deferred-media.mjs');
  const crawler = new CrawlManager(store, { defaultLimits: {} });
  const media = new DeferredMediaService({ store, fetcher: async () => { throw new Error('no'); } });
  let seenDuring = null;
  const originalWrite = store.writeManifest.bind(store);
  store.writeManifest = async (id, manifest) => {
    seenDuring = { busy: crawler.archiveBusy(id), media: await media.start(id).then(() => 'started', (error) => error.code) };
    return originalWrite(id, manifest);
  };
  await service.pruneArchive('archive_safe_old');
  assert.deepEqual(seenDuring, { busy: true, media: 'ARCHIVE_BUSY' }, '整理中は取り直しや後から保存を始めない');
  assert.equal(crawler.archiveBusy('archive_safe_old'), false, '終わったら解除する');
});

test('定期保存・まとめて保存：一時停止や中止で止まったままにならない', async (t) => {
  const root = await tempRoot(t, 'stall');
  const store = await new VaultStore(root).init();
  await archiveFixture(store, 'archive_stall');
  let now = new Date(2026, 8, 25, 10, 0, 0);
  const started = [];
  const crawler = { archiveBusy: () => false, resaveArchive: async () => { const job = await store.addJob({ startUrl: 'https://example.com/', options: {} }); started.push(job); return job; } };
  const service = await new ScheduleService({ dataRoot: root, store, crawler, now: () => now }).init();
  await service.upsert('archive_stall', { frequency: 'hourly', minute: 30 });
  now = new Date(2026, 8, 25, 10, 31, 0);
  await service.tick();
  assert.equal(started.length, 1);
  await store.updateJob(started[0].id, { status: 'paused' });
  now = new Date(2026, 8, 25, 11, 31, 0);
  await service.tick();
  assert.equal(started.length, 2, '前回が一時停止のままでも次の予定は実行する');
  await store.updateJob(started[1].id, { status: 'cancelled' });
  now = new Date(2026, 8, 25, 11, 40, 0);
  await service.tick();
  assert.match(service.list()[0].lastResult.message, /中止/, '中止された結果も記録する');

  const jobs = new Map();
  const queue = await new BatchQueue({
    dataRoot: root, store: { getJob: (id) => jobs.get(id) },
    startJob: async () => { const job = { id: `job_${jobs.size}`, archiveId: 'x', status: 'running' }; jobs.set(job.id, job); return job; }
  }).init();
  const { batch } = await queue.create({ text: 'https://example.com/1\nhttps://example.com/2' });
  await queue.tick();
  jobs.get('job_0').status = 'paused';
  await queue.tick();
  const summary = queue.list().find((item) => item.id === batch.id);
  assert.equal(summary.paused, 1);
  assert.equal(summary.running, 1, '一時停止したら次のURLへ進む');
});

test('容量の自動整理：消した動画を後から保存で取り直したら、整理済みの印を外す', async (t) => {
  const root = await tempRoot(t, 'cleanup-restore');
  const store = await new VaultStore(root).init();
  store.blobSharing = false;
  await archiveFixture(store, 'archive_restore_old', { savedAt: '2026-01-01T00:00:00.000Z', blobs: [['https://example.com/clip.mp4', 'clip-bytes', 'video/mp4']] });
  await archiveFixture(store, 'archive_restore_new', { savedAt: '2026-06-01T00:00:00.000Z' });
  const service = await new StorageCleanupService({ dataRoot: root, store }).init();
  await service.pruneArchive('archive_restore_old');
  assert.ok(store.getArchive('archive_restore_old').prunedAt);
  const { DeferredMediaService } = await import('../server/deferred-media.mjs');
  const media = new DeferredMediaService({
    store,
    fetcher: async (url, options) => {
      await options.bodySink(Buffer.from('clip-bytes'));
      return { finalUrl: url, response: { ok: true, status: 200, headers: new Headers({ 'content-type': 'video/mp4' }) } };
    }
  });
  const task = await media.start('archive_restore_old');
  while (task.status === 'running') await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(task.status, 'completed');
  const manifest = await store.readManifest('archive_restore_old');
  assert.ok(manifest.resources['https://example.com/clip.mp4']);
  assert.equal(manifest.prunedMedia, undefined);
  assert.equal(store.getArchive('archive_restore_old').prunedAt, null);
});
