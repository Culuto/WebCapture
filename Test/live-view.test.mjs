import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { LiveViewHub, livePhaseLabel } from '../server/live-view.mjs';
import { startLiveScreencast } from '../server/browser-live.mjs';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser } from '../server/browser-capture.mjs';

function fakeClock(start = 1000) {
  const clock = { value: start, now: () => clock.value };
  return clock;
}

test('ライブ表示の枠は見ている人がいる間だけ配信対象になり、枠ごとに最新画面を持つ', () => {
  const clock = fakeClock();
  const hub = new LiveViewHub({ now: clock.now });
  assert.equal(hub.wanted('job_a'), false);
  hub.touchViewer('job_a');
  assert.equal(hub.wanted('job_a'), true);
  clock.value += 6000;
  assert.equal(hub.wanted('job_a'), false);

  const channel = hub.begin('job_a', 1, 'https://example.com/a');
  assert.deepEqual(hub.snapshot('job_a', 3).map((slot) => slot.phase), ['idle', 'waiting', 'idle']);
  channel.phase('loading');
  channel.update({ title: 'ページA', url: 'https://example.com/a2' });
  assert.equal(channel.frame(Buffer.from('one')), true);
  assert.equal(channel.frame(Buffer.from('two')), false, '短すぎる間隔の画面は間引く');
  clock.value += 250;
  assert.equal(channel.frame(Buffer.from('three')), true);
  const [, slot] = hub.snapshot('job_a', 2);
  assert.equal(slot.url, 'https://example.com/a2');
  assert.equal(slot.title, 'ページA');
  assert.equal(slot.phaseLabel, livePhaseLabel('loading'));
  assert.equal(slot.hasFrame, true);
  assert.equal(String(hub.frameOf('job_a', 1)), 'three');
  assert.equal(hub.frameOf('job_a', 0), null);

  const seqBefore = slot.frameSeq;
  hub.begin('job_a', 1, 'https://example.com/b');
  const [, reset] = hub.snapshot('job_a');
  assert.equal(reset.hasFrame, false, '次のページに移ったら前のページの画面は出さない');
  assert.ok(reset.frameSeq > seqBefore);

  hub.clearJob('job_a');
  assert.deepEqual(hub.snapshot('job_a'), []);
});

test('画面配信は見ている間だけ開始し、撮影中は止め、終了時に後片付けする', async () => {
  const sent = [];
  const listeners = new Map();
  const client = {
    send: async (method, params) => { sent.push({ method, params }); return method === 'Runtime.evaluate' ? { result: { value: 'タイトル' } } : {}; },
    on: (method, handler) => { listeners.set(method, handler); return () => listeners.delete(method); }
  };
  let wanted = false;
  const frames = [];
  const updates = [];
  const channel = { wanted: () => wanted, frame: (buffer) => frames.push(String(buffer)), update: (patch) => updates.push(patch), phase: () => {} };
  const live = startLiveScreencast(client, channel);
  await live.pause();
  live.resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.some((item) => item.method === 'Page.startScreencast'), false, '誰も見ていなければ配信しない');

  wanted = true;
  await live.pause();
  live.resume();
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.filter((item) => item.method === 'Page.startScreencast').length, 1);
  listeners.get('Page.screencastFrame')({ data: Buffer.from('frame-1').toString('base64'), sessionId: 7 });
  assert.deepEqual(frames, ['frame-1']);
  assert.equal(sent.some((item) => item.method === 'Page.screencastFrameAck'), false, '受信確認を遅らせて画面の送信を1秒5枚までに抑える');
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(sent.some((item) => item.method === 'Page.screencastFrameAck' && item.params.sessionId === 7));

  await live.pause();
  assert.equal(sent.at(-1).method, 'Page.stopScreencast');
  listeners.get('Page.screencastFrame')({ data: Buffer.from('frame-2').toString('base64'), sessionId: 8 });
  assert.deepEqual(frames, ['frame-1'], '撮影で止めている間の画面は使わない');

  listeners.get('Page.frameNavigated')({ frame: { url: 'https://example.com/next' } }, null);
  listeners.get('Page.frameNavigated')({ frame: { url: 'https://ads.example/frame', parentId: 'main' } }, null);
  listeners.get('Page.loadEventFired')({}, null);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(updates, [{ url: 'https://example.com/next' }, { title: 'タイトル' }]);

  live.stop();
  assert.equal(listeners.size, 0);
});

test('並列保存の全タブが実際の画面を配信し、工程とページ名が枠に反映される', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Live ${req.url.slice(1)}</title><style>@keyframes spin{to{transform:rotate(360deg)}}.box{width:120px;height:120px;background:#0b5fff;animation:spin 1s linear infinite}</style><h1>Live fixture ${req.url.slice(1)}</h1><div class="box"></div><div style="height:2400px;background:linear-gradient(#fff,#036)"></div>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const hub = new LiveViewHub();
  hub.touchViewer('job_live');
  const keepWatching = setInterval(() => hub.touchViewer('job_live'), 500);
  t.after(() => clearInterval(keepWatching));
  const phases = [[], []];
  const base = `http://127.0.0.1:${server.address().port}`;
  await Promise.all([0, 1].map((index) => {
    const channel = hub.begin('job_live', index, `${base}/p${index}`);
    const recording = { ...channel, phase: (phase) => { phases[index].push(phase); channel.phase(phase); } };
    return captureWithBrowser(`${base}/p${index}`, {
      session, liveView: recording, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000,
      initialWaitMs: 1500, screenshotMode: 'viewport', interactDuringCapture: false
    });
  }));
  const slots = hub.snapshot('job_live');
  for (const [index, slot] of slots.entries()) {
    assert.equal(slot.hasFrame, true, `${index + 1}番目のタブに画面が届いていない`);
    assert.equal(hub.frameOf('job_live', index).subarray(0, 2).toString('hex'), 'ffd8', 'JPEG画像として届く');
    assert.equal(slot.title, `Live p${index}`);
    assert.equal(slot.url, `${base}/p${index}`);
    assert.deepEqual(phases[index].slice(0, 2), ['loading', 'preparing']);
    assert.ok(phases[index].includes('reading'));
  }
});
