import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { VaultStore } from '../server/store.mjs';
import { findBrowser } from '../server/browser-capture.mjs';

async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
}

async function wait(url, processHandle) {
  for (let index = 0; index < 60; index += 1) {
    if (processHandle.exitCode !== null) throw new Error('テストサーバーが終了しました。');
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('テストサーバーの起動がタイムアウトしました。');
}

test('localhost UI/API/別origin replayが起動し、Host・CSRFを検査する', { timeout: 60000 }, async (t) => {
  const appPort = await port(); const replayPort = await port();
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-server-test-'));
  const root = path.resolve(import.meta.dirname, '..');
  const fixtureStore = await new VaultStore(dataRoot).init();
  const archiveId = 'archive_api_fixture';
  const fixtureHtml = await fixtureStore.writeBlob(archiveId, Buffer.from('<title>API fixture</title><main>Visible fixture</main><button type="button" aria-expanded="false" aria-controls="panel" onclick="const open=this.getAttribute(\'aria-expanded\')!==\'true\';this.setAttribute(\'aria-expanded\',String(open));document.getElementById(\'panel\').hidden=!open">Toggle panel</button><section id="panel" hidden>Panel</section><details><summary>More</summary><p>Details</p></details><img src="https://example.com/missing.png">'));
  await fixtureStore.writeManifest(archiveId, { id: archiveId, startUrl: 'https://example.com/', pages: [{ url: 'https://example.com/', html: fixtureHtml.file }], resources: {}, blocked: [], referenceAudit: { checkedCount: 0, missingCount: 0 } });
  await fixtureStore.addArchive({ id: archiveId, startUrl: 'https://example.com/', title: 'API fixture', status: 'complete', pages: 1, resources: 0, bytes: fixtureHtml.size, errors: 0, savedAt: new Date().toISOString() });
  const damagedArchiveId = 'archive_repair_blocked_fixture';
  const damagedFixtureHtml = await fixtureStore.writeBlob(damagedArchiveId, Buffer.from('<title>Repair recovery fixture</title><main>Saved content remains readable</main>'));
  await fixtureStore.writeManifest(damagedArchiveId, { id: damagedArchiveId, pages: [{ url: 'https://example.com/', html: damagedFixtureHtml.file }], resources: {}, blocked: [] });
  await fixtureStore.addArchive({ id: damagedArchiveId, startUrl: 'https://example.com/', title: 'Repair recovery fixture', status: 'complete', pages: 1, resources: 0, bytes: damagedFixtureHtml.size, savedAt: new Date().toISOString() });
  await fs.mkdir(path.join(dataRoot, '.archive-repairs', damagedArchiveId), { recursive: true });
  await fs.writeFile(path.join(dataRoot, '.archive-repairs', damagedArchiveId, 'plan.json'), '{}');
  await fs.mkdir(path.join(dataRoot, 'shared'), { recursive: true });
  await fs.writeFile(path.join(dataRoot, 'shared', 'references.json'), JSON.stringify({ [archiveId]: [damagedArchiveId] }));
  const processHandle = childProcess.spawn(process.execPath, [path.join(root, 'server', 'server.mjs')], {
    cwd: root, windowsHide: true, stdio: 'ignore', env: {
      ...process.env,
      WEBCAPTURE_PORT: String(appPort), WEBCAPTURE_REPLAY_PORT: String(replayPort), WEBCAPTURE_DATA_ROOT: dataRoot,
      WEBCAPTURE_METRICS_ROOT: path.join(dataRoot, 'metrics'), WEBCAPTURE_METRICS_INTERVAL_MS: '60000'
    }
  });
  t.after(async () => { if (processHandle.exitCode === null) processHandle.kill(); await fs.rm(dataRoot, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${appPort}`;
  const health = await (await wait(`${base}/api/health`, processHandle)).json();
  assert.deepEqual({ app: health.app, ready: health.ready, replayReady: health.replayReady }, { app: 'WebCapture', ready: true, replayReady: true });
  const session = await (await fetch(`${base}/api/session`)).json();
  assert.equal(session.ok, true);
  assert.match(session.csrfToken, /^[A-Za-z0-9_-]+$/);
  const initialSettings = await (await fetch(`${base}/api/settings`)).json();
  assert.deepEqual(initialSettings.settings, { lowImpactMode: true, optimizeMode: false, notifyOnComplete: true, optimized: null });
  const settingsHeaders = { origin: base, 'content-type': 'application/json', 'x-webcapture-csrf': session.csrfToken };
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ lowImpactMode: false }) })).status, 403);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: settingsHeaders, body: JSON.stringify({ lowImpactMode: 'no' }) })).status, 400);
  const turnedOff = await (await fetch(`${base}/api/settings`, { method: 'POST', headers: settingsHeaders, body: JSON.stringify({ lowImpactMode: false }) })).json();
  assert.equal(turnedOff.settings.lowImpactMode, false);
  assert.equal(turnedOff.load.lowImpact, false);
  assert.equal(turnedOff.load.pressure, 'off');
  assert.equal(JSON.parse(await fs.readFile(path.join(dataRoot, 'settings.json'), 'utf8')).lowImpactMode, false);
  assert.deepEqual((await (await fetch(`${base}/api/logins`)).json()).logins, []);
  assert.equal((await fetch(`${base}/api/logins`, { method: 'POST', headers: settingsHeaders, body: JSON.stringify({ method: 'unknown' }) })).status, 400);
  const missingUrl = await fetch(`${base}/api/logins`, { method: 'POST', headers: settingsHeaders, body: JSON.stringify({ method: 'paste', name: 'x', text: 'a=1' }) });
  assert.equal(missingUrl.status, 400);
  assert.match((await missingUrl.json()).error.message, /URLが必要/);
  assert.equal((await fetch(`${base}/api/logins`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify({ method: 'paste' }) })).status, 403);
  const sharedDelete = await fetch(`${base}/api/archives/${archiveId}`, { method: 'DELETE', headers: settingsHeaders });
  assert.equal(sharedDelete.status, 409, 'ほかのアーカイブから使われているアーカイブは削除できない');
  assert.match((await sharedDelete.json()).error.message, /使われているため削除できません/);
  const snapshotAfterSettings = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(snapshotAfterSettings.load.lowImpact, false);
  assert.equal(snapshotAfterSettings.load.capture.limit, 30);
  const optimizeOn = await (await fetch(`${base}/api/settings`, { method: 'POST', headers: settingsHeaders, body: JSON.stringify({ optimizeMode: true }) })).json();
  assert.equal(optimizeOn.settings.optimizeMode, true);
  assert.equal(optimizeOn.settings.lowImpactMode, false);
  assert.equal((await fetch(`${base}/api/settings`, { method: 'POST', headers: settingsHeaders, body: JSON.stringify({}) })).status, 400);
  const bootstrapResponse = await fetch(`${base}/api/bootstrap`);
  const bootstrap = await bootstrapResponse.json();
  assert.equal(bootstrap.ok, true);
  assert.equal(bootstrap.config.replayOrigin, `http://127.0.0.1:${replayPort}`);
  assert.equal(bootstrap.config.externalMaxDepth, 1);
  assert.equal(bootstrap.config.concurrency, 2);
  assert.deepEqual(bootstrap.config.sameSiteKeywords, []);
  assert.equal(bootstrap.load.capture.limit, 30);
  assert.equal(bootstrap.load.discovery.limit, 256);
  const metricsResponse = await (await fetch(`${base}/api/diagnostics/metrics?limit=10`)).json();
  assert.equal(metricsResponse.ok, true);
  assert.ok(Array.isArray(metricsResponse.metrics));
  const csrfRejected = await fetch(`${base}/api/jobs/fake/pause`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(csrfRejected.status, 403);
  assert.equal((await fetch(`${base}/api/jobs/fake/live`)).status, 404);
  assert.equal((await fetch(`${base}/api/jobs/fake/live/0/frame`)).status, 404);
  assert.equal((await fetch(`${base}/api/jobs/fake/live`, { method: 'POST', headers: { origin: base }, body: '{}' })).status, 405);
  const hostRejected = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: appPort, path: '/api/health', headers: { host: `evil.example:${appPort}` } }, resolve);
    request.once('error', reject); request.end();
  });
  assert.equal(hostRejected.statusCode, 400);
  hostRejected.resume();
  const index = await (await fetch(`${base}/`)).text();
  assert.match(index, /WebCapture/);
  assert.match(index, /外部リンクの深さ/);
  assert.match(index, /同一サイト扱いキーワード/);
  assert.match(index, /data-icon="archive"/);
  const iconModule = await fetch(`${base}/vendor/lucide/icons/archive.mjs`);
  assert.equal(iconModule.status, 200);
  assert.match(iconModule.headers.get('content-type'), /javascript/);
  assert.match(await iconModule.text(), /const Archive/);
  const vendorTraversal = await fetch(`${base}/vendor/lucide/..%2F..%2Fpackage.json`);
  assert.equal(vendorTraversal.status, 404);
  const normalArchive = await (await fetch(`${base}/api/archives/${archiveId}`)).json();
  assert.ok(normalArchive.manifest);
  assert.ok(normalArchive.runtimeMisses);
  const summary = await (await fetch(`${base}/api/archives/${archiveId}?view=summary`)).json();
  assert.equal(summary.manifest.startUrl, normalArchive.manifest.startUrl);
  assert.equal(summary.manifest.pages.length, normalArchive.manifest.pages.length);
  assert.equal(summary.manifest.pages[0].url, normalArchive.manifest.pages[0].url);
  assert.equal(summary.manifest.resources, undefined, '画面用の要約には素材一覧を含めない');
  assert.equal(summary.manifest.postResponses, undefined);
  assert.equal(summary.manifest.pages[0].resources, undefined);
  assert.equal(summary.runtimeMisses.items, undefined);
  const diagnostics = await (await fetch(`${base}/api/archives/${archiveId}?view=diagnostics`)).json();
  assert.equal(diagnostics.manifest, undefined);
  assert.equal(diagnostics.archive.id, archiveId);
  assert.equal(diagnostics.archive.quality.referenceChecked, true);
  const persistedArchive = (await (await fetch(`${base}/api/archives`)).json()).archives.find(item => item.id === archiveId);
  assert.equal(persistedArchive.quality.level, diagnostics.archive.quality.level);
  assert.equal(persistedArchive.quality.score, diagnostics.archive.quality.score);
  const auditCsrfRejected = await fetch(`${base}/api/archives/${archiveId}/replay-audit`, { method: 'POST', headers: { origin: base }, body: '{}' });
  assert.equal(auditCsrfRejected.status, 403);
  if (await findBrowser()) {
    const auditStarted = await fetch(`${base}/api/archives/${archiveId}/replay-audit`, {
      method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-webcapture-csrf': session.csrfToken }, body: '{}'
    });
    assert.equal(auditStarted.status, 202);
    let audit;
    for (let index = 0; index < 200; index += 1) {
      audit = (await (await fetch(`${base}/api/archives/${archiveId}/replay-audit`)).json()).audit;
      if (['completed', 'failed', 'cancelled'].includes(audit?.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(audit?.status, 'completed', audit?.message);
    assert.equal(audit.pagesAudited, 1);
    assert.equal(audit.pages, undefined);
    assert.equal(audit.summary.missingResources, 1);
    assert.equal(audit.summary.interactionCandidates, 2);
    assert.equal(audit.summary.interactionsTested, 2);
    assert.equal(audit.summary.interactionChanges, 2);
    assert.equal(audit.summary.interactionErrors, 0);
    assert.equal(audit.summary.interactionSkipped, 0);
    assert.equal(audit.summary.interactionTransient, 0);
    assert.equal(audit.coverage.interactions, true);
    assert.equal(audit.coverage.timepoints, 2);
    assert.equal((await fixtureStore.readRuntimeMisses(archiveId)).total, 0);
    const fullAudit = (await (await fetch(`${base}/api/archives/${archiveId}/replay-audit?view=full`)).json()).audit;
    assert.equal(fullAudit.pages.length, 1);
    assert.equal((await fixtureStore.readReplayAudit(archiveId)).status, 'completed');
  }
  const recoveryDetail = await (await fetch(`${base}/api/archives/${damagedArchiveId}`)).json();
  assert.equal(recoveryDetail.ok, true);
  assert.equal(recoveryDetail.archive.repairRecovery.status, 'failed');
  const readablePage = await fetch(`http://127.0.0.1:${replayPort}/archive/${damagedArchiveId}/page?url=https%3A%2F%2Fexample.com%2F`);
  assert.equal(readablePage.status, 200);
  assert.match(await readablePage.text(), /Saved content remains readable/);
  const recoveryDelete = await fetch(`${base}/api/archives/${damagedArchiveId}`, { method: 'DELETE', headers: { origin: base, 'x-webcapture-csrf': session.csrfToken } });
  assert.equal(recoveryDelete.status, 400);
  assert.match((await recoveryDelete.json()).error.message, /復旧/);
  await fs.access(fixtureStore.manifestFile(damagedArchiveId));
  const replayStateModule = await fetch(`${base}/replay-state.js`);
  assert.match(replayStateModule.headers.get('content-type'), /javascript/);
  assert.match(await replayStateModule.text(), /applyReplayMessage/);
  const replay = await fetch(`http://127.0.0.1:${replayPort}/archive/archive_missing/page?url=https%3A%2F%2Fexample.com%2F`);
  assert.equal(replay.status, 404);
  const replayHostRejected = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: replayPort, path: '/archive/archive_missing/page', headers: { host: `evil.example:${replayPort}` } }, resolve);
    request.once('error', reject); request.end();
  });
  assert.equal(replayHostRejected.statusCode, 400);
  replayHostRejected.resume();
  const malformed = await fetch(`http://127.0.0.1:${replayPort}/archive/%/page`);
  assert.equal(malformed.status, 400);
  const healthAfterMalformed = await (await fetch(`${base}/api/health`)).json();
  assert.equal(healthAfterMalformed.ok, true);
  // A second writer must fail before startup recovery can change active records.
  const job = await fixtureStore.addJob({ startUrl: 'https://example.com/', options: {} });
  const jobFile = path.join(dataRoot, 'state-v2', 'jobs', `${job.id}.json`);
  job.status = 'running';
  await fs.writeFile(jobFile, JSON.stringify(job));
  const originalJob = await fs.readFile(jobFile);
  const otherAppPort = await port(); const otherReplayPort = await port();
  for (const options of [{ appPort, replayPort }, { appPort: otherAppPort, replayPort: otherReplayPort }]) for (const command of [['server/server.mjs'], ['scripts/repair-archive-srcset.mjs', archiveId]]) {
    const rejected = childProcess.spawn(process.execPath, command, { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env, WEBCAPTURE_PORT: String(options.appPort), WEBCAPTURE_REPLAY_PORT: String(options.replayPort), WEBCAPTURE_DATA_ROOT: dataRoot } });
    t.after(() => { if (rejected.exitCode === null) rejected.kill(); });
    const exitCode = await new Promise((resolve, reject) => { rejected.once('exit', resolve); rejected.once('error', reject); });
    assert.notEqual(exitCode, 0);
    assert.deepEqual(await fs.readFile(jobFile), originalJob);
  }
  const shutdownResponse = await fetch(`${base}/api/system/shutdown`, {
    method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-webcapture-csrf': session.csrfToken }, body: '{}'
  });
  assert.equal(shutdownResponse.status, 202);
  const exitCode = processHandle.exitCode ?? await new Promise((resolve, reject) => { processHandle.once('exit', resolve); processHandle.once('error', reject); });
  assert.equal(exitCode, 0);
});
