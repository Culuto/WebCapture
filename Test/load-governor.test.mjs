import test from 'node:test';
import assert from 'node:assert/strict';
import { AdaptivePermitPool, adaptiveConcurrency } from '../server/load-governor.mjs';

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('全体並列枠はFIFOで上限を守り、解放後に次を開始する', async () => {
  const pool = new AdaptivePermitPool({ name: 'test', limit: 2 });
  const started = [];
  let releaseA;
  let releaseB;
  const first = pool.run(async () => { started.push('a'); await new Promise((resolve) => { releaseA = resolve; }); });
  const second = pool.run(async () => { started.push('b'); await new Promise((resolve) => { releaseB = resolve; }); });
  const third = pool.run(async () => { started.push('c'); });
  await tick();
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(pool.snapshot(), { active: 2, waiting: 1, limit: 2 });
  releaseA();
  await tick();
  assert.deepEqual(started, ['a', 'b', 'c']);
  releaseB();
  await Promise.all([first, second, third]);
  assert.deepEqual(pool.snapshot(), { active: 0, waiting: 0, limit: 2 });
});

test('待機中の取得はAbortSignalで取り除かれる', async () => {
  const pool = new AdaptivePermitPool({ name: 'test', limit: 1 });
  const permit = await pool.acquire();
  const controller = new AbortController();
  const waiting = pool.acquire({ signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
  assert.equal(pool.snapshot().waiting, 0);
  permit.release();
});

test('CPU・メモリ・ディスク等の高負荷時だけ新規並列数を段階的に抑える', () => {
  assert.deepEqual(adaptiveConcurrency(null, { capture: 4, discovery: 8 }), { pressure: 'normal', capture: 4, discovery: 8 });
  assert.deepEqual(adaptiveConcurrency({ cpu: { percent: 80 } }, { capture: 4, discovery: 8 }), { pressure: 'high', capture: 2, discovery: 3 });
  assert.deepEqual(adaptiveConcurrency({ cpu: { percent: 70 } }, { capture: 6, discovery: 12 }), { pressure: 'elevated', capture: 4, discovery: 8 }, 'やや高い段階で早めに少し減らす');
  assert.deepEqual(adaptiveConcurrency({ memory: { percent: 81 } }, { capture: 30, discovery: 64 }), { pressure: 'elevated', capture: 20, discovery: 43 });
  assert.deepEqual(adaptiveConcurrency({ cpu: { percent: 60 }, memory: { percent: 70 } }, { capture: 6, discovery: 12 }), { pressure: 'normal', capture: 6, discovery: 12 });
  assert.deepEqual(adaptiveConcurrency({ memory: { percent: 92 } }, { capture: 4, discovery: 8 }), { pressure: 'critical', capture: 1, discovery: 1 });
  assert.deepEqual(adaptiveConcurrency({ disk: { busyPercent: 98 } }, { capture: 3, discovery: 5 }), { pressure: 'critical', capture: 1, discovery: 1 });
  assert.deepEqual(adaptiveConcurrency({ network: { utilizationPercent: 96 } }, { capture: 3, discovery: 5 }), { pressure: 'high', capture: 1, discovery: 2 });
});

test('低負荷モードOFFでは負荷が高くても並列数を減らさない', () => {
  assert.deepEqual(adaptiveConcurrency({ memory: { percent: 100 }, cpu: { percent: 100 } }, { capture: 6, discovery: 32 }, { lowImpact: false }), { pressure: 'off', capture: 6, discovery: 32 });
  assert.deepEqual(adaptiveConcurrency({ memory: { percent: 100 } }, { capture: 6, discovery: 32 }, { lowImpact: true }), { pressure: 'critical', capture: 1, discovery: 1 });
});

test('低負荷モードの切り替えは直近の負荷で全体枠をすぐ更新する', async () => {
  const { CaptureLoadGovernor } = await import('../server/load-governor.mjs');
  const listeners = [];
  const monitor = { subscribe: (handler) => { listeners.push(handler); return () => {}; }, snapshot: () => ({ memory: { percent: 99 } }) };
  const governor = new CaptureLoadGovernor({ captureLimit: 6, discoveryLimit: 32, systemMonitor: monitor });
  assert.equal(governor.snapshot().capture.limit, 1);
  governor.setLowImpact(false);
  assert.equal(governor.snapshot().capture.limit, 6);
  assert.equal(governor.snapshot().discovery.limit, 32);
  assert.equal(governor.snapshot().lowImpact, false);
  governor.setLowImpact(true);
  assert.equal(governor.snapshot().capture.limit, 1);
  governor.close();
});
