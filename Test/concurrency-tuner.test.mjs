import test from 'node:test';
import assert from 'node:assert/strict';
import { ConcurrencyTuner, OPTIMIZE_START } from '../server/concurrency-tuner.mjs';

test('最適化モードは30・64から始め、エラーやCPU100%のたびに1ずつ下げる', () => {
  let clock = 0;
  const changes = [];
  const tuner = new ConcurrencyTuner({ now: () => clock, cooldownMs: 5000, onChange: (entry) => changes.push(entry) });
  assert.deepEqual([tuner.capture, tuner.discovery], [OPTIMIZE_START.capture, OPTIMIZE_START.discovery]);
  assert.equal(tuner.onError('capture'), true);
  assert.equal(tuner.capture, 29);
  assert.equal(tuner.onError('capture'), false, '5秒以内の連続エラーでは下げすぎない');
  clock += 5000;
  assert.equal(tuner.onMetrics({ cpu: { percent: 99.5 } }, 'capture'), true);
  assert.equal(tuner.capture, 28);
  clock += 5000;
  assert.equal(tuner.onMetrics({ cpu: { percent: 80 }, memory: { percent: 60 } }, 'capture'), false, 'CPUとメモリに余裕があれば下げない');
  assert.equal(tuner.onError('discovery'), true, '構造把握は別に数える');
  assert.equal(tuner.discovery, 63);
  assert.deepEqual(changes.map((entry) => [entry.kind, entry.from, entry.to, entry.reason]), [['capture', 30, 29, 'error'], ['capture', 29, 28, 'cpu'], ['discovery', 64, 63, 'error']]);
  assert.equal(tuner.snapshot().reductionCount, 3);
  assert.equal(tuner.snapshot().lastReduction.kind, 'discovery');
});

test('最適化モードは1より下げない', () => {
  const tuner = new ConcurrencyTuner({ capture: 2, discovery: 1, cooldownMs: 0 });
  tuner.onError('capture');
  tuner.onError('capture');
  tuner.onError('discovery');
  assert.deepEqual([tuner.capture, tuner.discovery], [1, 1]);
});

test('最適化モードはメモリ使用率97%以上でも1つ下げる', () => {
  const tuner = new ConcurrencyTuner({ cooldownMs: 0 });
  assert.equal(tuner.onMetrics({ cpu: { percent: 40 }, memory: { percent: 98.1 } }, 'capture'), true);
  assert.equal(tuner.capture, 29);
  assert.equal(tuner.snapshot().lastReduction.reason, 'memory');
});
