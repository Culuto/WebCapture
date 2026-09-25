import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SystemMonitor, cpuUsagePercent, normalizeWindowsCounters } from '../server/system-monitor.mjs';

function cpu(idle, user) {
  return [{ model: 'test', speed: 1, times: { idle, user, nice: 0, sys: 0, irq: 0 } }];
}

test('CPU差分とWindowsカウンターを有限な範囲へ正規化する', () => {
  assert.equal(cpuUsagePercent(cpu(50, 50), cpu(80, 120)), 70);
  assert.equal(cpuUsagePercent(cpu(50, 50), cpu(50, 50)), null);
  assert.deepEqual(normalizeWindowsCounters({
    disk: { available: true, busyPercent: -5, readBytesPerSecond: 1.4, writeBytesPerSecond: -2 },
    network: { available: true, bytesPerSecond: 99.7, utilizationPercent: 120 },
    gpu: { available: true, percent: 101 }
  }), {
    disk: { available: true, busyPercent: 0, readBytesPerSecond: 1, writeBytesPerSecond: 0 },
    network: { available: true, bytesPerSecond: 100, utilizationPercent: 100 },
    gpu: { available: true, percent: 100 }
  });
});

test('数値だけの負荷記録をJSONLへ保存し直近値を読める', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-metrics-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cpuSamples = [cpu(50, 50), cpu(80, 120)];
  const monitor = new SystemMonitor({
    metricsRoot: path.join(root, 'metrics'),
    dataRoot: root,
    intervalMs: 60000,
    cpuProvider: () => cpuSamples.shift() || cpu(80, 120),
    memoryProvider: () => ({ total: 1000, free: 250 }),
    statfs: async () => ({ bsize: 10, blocks: 1000, bavail: 400 }),
    counterSampler: async () => normalizeWindowsCounters({
      disk: { available: true, busyPercent: 22.25, readBytesPerSecond: 10, writeBytesPerSecond: 20 },
      network: { available: true, bytesPerSecond: 30, utilizationPercent: 4.25 },
      gpu: { available: true, percent: 5.25 }
    })
  });
  await monitor.start();
  const sample = await monitor.sample();
  await monitor.stop();
  assert.equal(sample.cpu.percent, 70);
  assert.equal(sample.memory.percent, 75);
  assert.equal(sample.disk.busyPercent, 22.3);
  assert.equal(sample.disk.freeBytes, 4000);
  assert.equal(sample.network.bytesPerSecond, 30);
  assert.equal(sample.gpu.percent, 5.3);
  assert.equal(Object.hasOwn(sample, 'hostname'), false);
  const recent = await monitor.recent(10);
  assert.equal(recent.length, 1);
  assert.deepEqual(recent[0], sample);
});
