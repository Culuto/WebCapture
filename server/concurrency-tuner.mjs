export const OPTIMIZE_START = Object.freeze({ capture: 30, discovery: 64 });
const DEFAULT_COOLDOWN_MS = 5000;
const DEFAULT_CPU_THRESHOLD = 98;
const DEFAULT_MEMORY_THRESHOLD = 97;

export class ConcurrencyTuner {
  constructor({ capture = OPTIMIZE_START.capture, discovery = OPTIMIZE_START.discovery, cooldownMs = DEFAULT_COOLDOWN_MS, cpuThreshold = DEFAULT_CPU_THRESHOLD, memoryThreshold = DEFAULT_MEMORY_THRESHOLD, now = () => Date.now(), onChange = () => {} } = {}) {
    this.capture = Math.max(1, Math.trunc(capture));
    this.discovery = Math.max(1, Math.trunc(discovery));
    this.start = { capture: this.capture, discovery: this.discovery };
    this.cooldownMs = cooldownMs;
    this.cpuThreshold = cpuThreshold;
    this.memoryThreshold = memoryThreshold;
    this.now = now;
    this.onChange = onChange;
    this.lastReducedAt = { capture: -Infinity, discovery: -Infinity };
    this.reductions = [];
  }

  reduce(kind, reason) {
    if (!['capture', 'discovery'].includes(kind) || this[kind] <= 1) return false;
    const now = this.now();
    if (now - this.lastReducedAt[kind] < this.cooldownMs) return false;
    this.lastReducedAt[kind] = now;
    const from = this[kind];
    this[kind] = from - 1;
    const entry = { kind, from, to: this[kind], reason, at: new Date(now).toISOString() };
    this.reductions.push(entry);
    if (this.reductions.length > 200) this.reductions.shift();
    this.onChange(entry, this.snapshot());
    return true;
  }

  onError(kind, reason = 'error') {
    return this.reduce(kind, reason);
  }

  onMetrics(metrics, kind) {
    const cpu = Number(metrics?.cpu?.percent);
    const memory = Number(metrics?.memory?.percent);
    if (Number.isFinite(memory) && memory >= this.memoryThreshold) return this.reduce(kind, 'memory');
    if (Number.isFinite(cpu) && cpu >= this.cpuThreshold) return this.reduce(kind, 'cpu');
    return false;
  }

  snapshot() {
    return {
      capture: this.capture,
      discovery: this.discovery,
      start: { ...this.start },
      reductionCount: this.reductions.length,
      lastReduction: this.reductions.at(-1) || null
    };
  }
}
