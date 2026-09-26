import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { browserStartOrder, clearBrowserStartFailures, createBrowserCaptureSession, findBrowsers, noteBrowserStartFailure, pendingBrowserUpdate } from '../server/browser-capture.mjs';
import { buildIssueReport } from '../server/issue-report.mjs';
import { completionStatus } from '../server/quality.mjs';

test('ブラウザの起動順：まず同じブラウザで1回やり直し、続けて失敗中のものは後回しにする', () => {
  clearBrowserStartFailures();
  assert.deepEqual(browserStartOrder('chrome', ['chrome', 'edge']), ['chrome', 'chrome', 'edge']);
  noteBrowserStartFailure('chrome');
  assert.deepEqual(browserStartOrder('chrome', ['chrome', 'edge']), ['edge', 'chrome']);
  noteBrowserStartFailure('edge');
  assert.deepEqual(browserStartOrder('chrome', ['chrome', 'edge']), ['chrome', 'chrome', 'edge']);
  assert.deepEqual(browserStartOrder('chrome', ['chrome', 'edge'], Date.now() + 11 * 60 * 1000), ['chrome', 'chrome', 'edge']);
  clearBrowserStartFailures();
});

test('Chromeの更新待ち（new_chrome.exe）を見分ける', async (t) => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-chrome-update-'));
  t.after(() => fs.rm(folder, { recursive: true, force: true }));
  const chrome = path.join(folder, 'chrome.exe');
  await fs.writeFile(chrome, '');
  assert.equal(await pendingBrowserUpdate(chrome), false);
  await fs.writeFile(path.join(folder, 'new_chrome.exe'), '');
  assert.equal(await pendingBrowserUpdate(chrome), true);
  assert.equal(await pendingBrowserUpdate(path.join(folder, 'msedge.exe')), false);
});

test('起動直後に終了するブラウザは、やり直したあと別のブラウザへ切り替える', { timeout: 90000 }, async (t) => {
  clearBrowserStartFailures();
  t.after(() => clearBrowserStartFailures());
  const broken = process.execPath;
  const installed = (await findBrowsers()).filter((file) => file !== broken);
  if (!installed.length) {
    await assert.rejects(createBrowserCaptureSession({ executable: broken }), (error) => {
      assert.equal(error.code, 'BROWSER_START_FAILED');
      assert.match(error.message, /を起動できませんでした/);
      return true;
    });
    return;
  }
  const started = Date.now();
  const session = await createBrowserCaptureSession({ executable: broken });
  t.after(() => session.close());
  assert.equal(session.executable, installed[0]);
  assert.ok(session.alive);
  assert.ok(Date.now() - started < 60000);
});

test('ブラウザを起動できずに0ページで終わったとき、理由を問題の件数と完了メッセージに出す', () => {
  const reason = 'ブラウザ（chrome.exe）を起動できませんでした。ChromeまたはEdgeを一度開いて正常に動くか確認し、パソコンを再起動してから保存し直してください。';
  const manifest = { startUrl: 'https://store.example/', pages: [], blocked: [{ url: 'https://store.example/', reason }] };
  const report = buildIssueReport(manifest);
  assert.equal(report.problemCount, 1);
  assert.equal(report.categories[0].key, 'browser');
  const legacy = buildIssueReport({ ...manifest, blocked: [{ url: 'https://store.example/', reason: 'ブラウザがキャプチャ開始前に終了しました。' }] });
  assert.equal(legacy.categories[0].key, 'browser');
  const status = completionStatus({ pages: 0 }, manifest);
  assert.equal(status.status, 'failed');
  assert.match(status.message, /ブラウザ（chrome\.exe）を起動できませんでした/);
});
