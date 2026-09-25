import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser } from '../server/browser-capture.mjs';
import { sanitizeCaptureOptions } from '../server/capture-options.mjs';

test('操作の確認回数：無制限・数値・代表的なものだけを設定として受け付ける', () => {
  assert.equal(sanitizeCaptureOptions({ maxInteractionsPerPage: 'unlimited' }).maxInteractionsPerPage, null);
  assert.equal(sanitizeCaptureOptions({ maxInteractionsPerPage: null }).maxInteractionsPerPage, null);
  assert.equal(sanitizeCaptureOptions({ maxInteractionsPerPage: 500 }).maxInteractionsPerPage, 500);
  assert.equal(sanitizeCaptureOptions({ interactionMode: 'representative' }).interactionMode, 'representative');
  assert.equal(sanitizeCaptureOptions({ interactionMode: 'x' }).interactionMode, 'all');
});

test('操作の確認：回数の上限・無制限・代表的なものだけを実際のChromeで守る', { timeout: 120000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const buttons = Array.from({ length: 30 }, (_, index) => `<li><button type="button" class="menu-button" aria-expanded="false" onclick="this.setAttribute('aria-expanded', this.getAttribute('aria-expanded') === 'true' ? 'false' : 'true')">メニュー${index}</button></li>`).join('');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Many</title><ul class="video-list">${buttons}</ul><div role="tablist"><button role="tab" aria-selected="true">A</button><button role="tab" aria-selected="false" onclick="this.setAttribute('aria-selected','true')">B</button></div>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const base = { session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 60000, screenshotMode: 'none', hoverDuringCapture: false, interactionSettleMs: 10 };
  const limited = await captureWithBrowser(url, { ...base, maxInteractionsPerPage: 5 });
  assert.equal(limited.preservation.interactions.testedCount, 5);
  assert.equal(limited.preservation.interactions.limitReached, true);
  const unlimited = await captureWithBrowser(url, { ...base, maxInteractionsPerPage: null, interactionMaxMs: 1000 });
  assert.equal(unlimited.preservation.interactions.testedCount, 32, '無制限では全部試す（操作の時間の目安より長くてもページの上限まで続ける）');
  assert.equal(unlimited.preservation.interactions.limitReached, false);
  const representative = await captureWithBrowser(url, { ...base, maxInteractionsPerPage: null, interactionMode: 'representative' });
  assert.ok(representative.preservation.interactions.testedCount <= 4, `代表だけ試した数: ${representative.preservation.interactions.testedCount}`);
  assert.ok(representative.preservation.interactions.representativeSkipped >= 28);
  assert.equal(representative.preservation.interactions.representative, true);
});
