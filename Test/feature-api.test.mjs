import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { VaultStore } from '../server/store.mjs';

async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
}

async function waitReady(url, processHandle) {
  for (let index = 0; index < 80; index += 1) {
    if (processHandle.exitCode !== null) throw new Error('テストサーバーが終了しました。');
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('テストサーバーの起動がタイムアウトしました。');
}

test('追加機能のAPI：プリセット・整理・定期保存・お知らせ・容量・共有化・見比べ・画像の取得を画面と同じ手順で使える', { timeout: 60000 }, async (t) => {
  const appPort = await port();
  const replayPort = await port();
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-feature-api-'));
  const fixture = await new VaultStore(dataRoot).init();
  const id = 'archive_feature_api';
  const html = await fixture.writeBlob(id, Buffer.from('<title>Feature</title><p>Feature fixture</p>'));
  await fixture.writeScreenshot(id, '00001.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fixture.writeManifest(id, { id, startUrl: 'https://example.com/', pages: [{ url: 'https://example.com/', title: 'Feature', html: html.file, screenshot: 'screenshots/00001.png' }], resources: {}, blocked: [] });
  await fixture.addArchive({ id, startUrl: 'https://example.com/', title: 'Feature', status: 'complete', pages: 1, resources: 0, bytes: 10, errors: 0, savedAt: new Date().toISOString() });
  const root = path.resolve(import.meta.dirname, '..');
  const processHandle = childProcess.spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], {
    cwd: root, windowsHide: true, stdio: 'ignore',
    env: { ...process.env, WEBCAPTURE_PORT: String(appPort), WEBCAPTURE_REPLAY_PORT: String(replayPort), WEBCAPTURE_DATA_ROOT: dataRoot, WEBCAPTURE_METRICS_ROOT: path.join(dataRoot, 'metrics'), WEBCAPTURE_METRICS_INTERVAL_MS: '60000' }
  });
  t.after(async () => { if (processHandle.exitCode === null) processHandle.kill(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${appPort}`;
  await waitReady(`${base}/api/health`, processHandle);
  const { csrfToken } = await (await fetch(`${base}/api/session`)).json();
  const get = async (route) => { const response = await fetch(`${base}${route}`); return { status: response.status, body: await response.json() }; };
  const send = async (route, body = {}, method = 'POST', token = csrfToken) => {
    const response = await fetch(`${base}${route}`, { method, headers: { 'content-type': 'application/json', 'x-webcapture-csrf': token }, body: method === 'DELETE' ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await send('/api/presets', { name: 'x', fields: { concurrency: '1' } }, 'POST', 'wrong')).status, 403, '変更系のAPIは確認情報が必要');
  const presets = await get('/api/presets');
  assert.ok(presets.body.presets.some((item) => item.builtIn));
  const saved = await send('/api/presets', { name: '手元用', fields: { concurrency: '2', 'capture-mobile': true }, scope: 'site' });
  assert.equal(saved.status, 201);
  assert.equal((await send(`/api/presets/${saved.body.preset.id}`, {}, 'DELETE')).status, 200);
  assert.equal((await send('/api/presets/builtin_heavy', {}, 'DELETE')).status, 400);

  const meta = await send(`/api/archives/${id}/meta`, { tags: 'a, b', folder: '仕事', note: 'メモ' });
  assert.deepEqual(meta.body.archive.tags, ['a', 'b']);
  assert.equal(meta.body.facets.folders[0].name, '仕事');
  assert.equal((await get('/api/archives/facets')).body.facets.tags.length, 2);
  const filtered = await get('/api/archives?folder=%E4%BB%95%E4%BA%8B&tag=a');
  assert.deepEqual(filtered.body.archives.map((item) => item.id), [id]);
  assert.equal((await get('/api/archives?folder=__none__')).body.archives.length, 0);

  const schedule = await send(`/api/archives/${id}/schedule`, { frequency: 'weekly', weekday: 1, hour: 4, minute: 30 });
  assert.equal(schedule.body.schedule.frequency, 'weekly');
  assert.equal((await get(`/api/archives/${id}/schedule`)).body.schedule.id, schedule.body.schedule.id);
  assert.equal((await send(`/api/archives/${id}/schedule`, { frequency: 'yearly' })).status, 400);
  assert.equal((await get('/api/schedules')).body.schedules.length, 1);
  assert.equal((await send(`/api/schedules/${schedule.body.schedule.id}`, {}, 'DELETE')).status, 200);

  const notifications = await get('/api/notifications');
  assert.deepEqual([notifications.body.items.length, notifications.body.unread], [0, 0]);
  assert.equal((await send('/api/notifications/read', {})).body.unread, 0);

  const batch = await send('/api/batches', { text: 'not-a-url' });
  assert.equal(batch.status, 400);
  assert.equal(batch.body.error.code, 'NO_URLS');

  assert.equal((await send('/api/storage/cleanup/settings', { enabled: true, limitGb: 0 })).status, 400);
  const cleanup = await send('/api/storage/cleanup/settings', { enabled: true, limitGb: 50, includeWarc: true });
  assert.deepEqual(cleanup.body.settings, { enabled: true, limitGb: 50, includeWarc: true });
  const plan = await send('/api/storage/cleanup/plan', {});
  assert.deepEqual(plan.body.plan.items, []);
  assert.equal((await send('/api/storage/cleanup/execute', { planId: 'cleanup_missing' })).status, 409);
  assert.equal((await get('/api/storage/cleanup')).body.cleanup.settings.limitGb, 50);

  assert.equal((await send('/api/storage/dedupe', {})).status, 202);
  const storage = await get(`/api/archives/${id}/storage`);
  assert.ok(storage.body.storage.shared, '容量の内訳に共有の情報が入る');

  const history = await get(`/api/pages/history?url=${encodeURIComponent('https://example.com/')}`);
  assert.deepEqual(history.body.items.map((item) => item.archiveId), [id]);
  assert.equal((await get('/api/pages/history?url=javascript:alert(1)')).status, 400);

  const image = await fetch(`${base}/api/archives/${id}/image?path=screenshots/00001.png`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${base}/api/archives/${id}/image?path=..%2Fmanifest.json`)).status, 400, '保存先の外や別のファイルは読ませない');
  assert.equal((await fetch(`${base}/api/archives/${id}/image?path=manifest.json`)).status, 400);
  const visual = await get(`/api/archives/${id}/visual`);
  assert.equal(visual.body.visual.available, false);
  assert.equal((await get(`/api/archives/${id}/page-export?url=javascript:1`)).status, 400);

  const page = await (await fetch(`${base}/visual-diff.html`)).text();
  assert.match(page, /見た目の比較/);
  const script = await fetch(`${base}/features.js`);
  assert.equal(script.status, 200);
});
