import { logEvent } from './logger.mjs';

function integer(value, fallback = 1) {
  const parsed = Math.trunc(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function abortError() {
  const error = new Error('処理が中断されました。');
  error.name = 'AbortError';
  error.code = 'ABORT_ERR';
  return error;
}

export class AdaptivePermitPool {
  constructor({ name, limit = 1 } = {}) {
    this.name = String(name || 'work');
    this.limit = integer(limit);
    this.active = 0;
    this.queue = [];
    this.closed = false;
  }

  setLimit(value) {
    const next = integer(value, this.limit);
    if (next === this.limit) return false;
    this.limit = next;
    this.drain();
    return true;
  }

  acquire({ signal } = {}) {
    if (this.closed || signal?.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, signal, queuedAt: Date.now(), onAbort: null };
      entry.onAbort = () => {
        const index = this.queue.indexOf(entry);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError());
      };
      signal?.addEventListener('abort', entry.onAbort, { once: true });
      this.queue.push(entry);
      this.drain();
    });
  }

  drain() {
    while (!this.closed && this.active < this.limit && this.queue.length) {
      const entry = this.queue.shift();
      if (entry.signal?.aborted) {
        entry.signal?.removeEventListener('abort', entry.onAbort);
        entry.reject(abortError());
        continue;
      }
      entry.signal?.removeEventListener('abort', entry.onAbort);
      this.active += 1;
      let released = false;
      entry.resolve({
        waitedMs: Math.max(0, Date.now() - entry.queuedAt),
        release: () => {
          if (released) return;
          released = true;
          this.active = Math.max(0, this.active - 1);
          this.drain();
        }
      });
    }
  }

  async run(task, options = {}) {
    const permit = await this.acquire(options);
    try {
      options.onAcquired?.(permit.waitedMs);
      return await task();
    } finally {
      permit.release();
    }
  }

  snapshot() {
    return { active: this.active, waiting: this.queue.length, limit: this.limit };
  }

  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      entry.signal?.removeEventListener('abort', entry.onAbort);
      entry.reject(abortError());
    }
  }
}

function percentage(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function adaptiveConcurrency(metrics, defaults = {}, { lowImpact = true } = {}) {
  const baseCapture = integer(defaults.capture, 4);
  const baseDiscovery = integer(defaults.discovery, 8);
  if (!lowImpact) return { pressure: 'off', capture: baseCapture, discovery: baseDiscovery };
  const cpu = percentage(metrics?.cpu?.percent);
  const memory = percentage(metrics?.memory?.percent);
  const disk = percentage(metrics?.disk?.busyPercent);
  const network = percentage(metrics?.network?.utilizationPercent);
  const gpu = percentage(metrics?.gpu?.percent);
  let pressure = 'normal';
  if ((cpu !== null && cpu >= 90) || (memory !== null && memory >= 92) || (disk !== null && disk >= 97)) pressure = 'critical';
  else if ((cpu !== null && cpu >= 78) || (memory !== null && memory >= 86) || (disk !== null && disk >= 90) || (network !== null && network >= 95) || (gpu !== null && gpu >= 95)) pressure = 'high';
  else if ((cpu !== null && cpu >= 65) || (memory !== null && memory >= 80) || (disk !== null && disk >= 75) || (network !== null && network >= 85) || (gpu !== null && gpu >= 85)) pressure = 'elevated';
  if (pressure === 'critical') return { pressure, capture: 1, discovery: 1 };
  const divisor = pressure === 'high' ? 3 : pressure === 'elevated' ? 1.5 : 1;
  return {
    pressure,
    capture: Math.max(1, Math.ceil(baseCapture / divisor)),
    discovery: Math.max(1, Math.ceil(baseDiscovery / divisor))
  };
}

export class CaptureLoadGovernor {
  constructor({ captureLimit = 4, discoveryLimit = 8, systemMonitor = null, lowImpact = true, onPressure = null } = {}) {
    this.onPressure = onPressure;
    this.base = { capture: integer(captureLimit, 4), discovery: integer(discoveryLimit, 8) };
    this.lowImpact = lowImpact !== false;
    this.lastMetrics = null;
    this.capture = new AdaptivePermitPool({ name: 'capture', limit: this.base.capture });
    this.discovery = new AdaptivePermitPool({ name: 'discovery', limit: this.base.discovery });
    this.pressure = 'normal';
    this.unsubscribe = systemMonitor?.subscribe?.((metrics) => this.update(metrics)) || null;
    if (systemMonitor?.snapshot?.()) this.update(systemMonitor.snapshot());
  }

  setLowImpact(enabled) {
    this.lowImpact = Boolean(enabled);
    logEvent('info', 'governor', 'low-impact.changed', { enabled: this.lowImpact });
    this.update(this.lastMetrics);
  }

  update(metrics) {
    this.lastMetrics = metrics || null;
    const next = adaptiveConcurrency(metrics, this.base, { lowImpact: this.lowImpact });
    const previous = this.snapshot();
    const changed = this.capture.setLimit(next.capture) | this.discovery.setLimit(next.discovery);
    const pressureChanged = this.pressure !== next.pressure;
    this.pressure = next.pressure;
    if (pressureChanged) this.onPressure?.(next.pressure);
    if (changed || pressureChanged) {
      logEvent('info', 'governor', 'limits.changed', {
        pressure: next.pressure,
        captureLimit: next.capture,
        discoveryLimit: next.discovery,
        previousCaptureLimit: previous.capture.limit,
        previousDiscoveryLimit: previous.discovery.limit
      });
    }
  }

  snapshot() {
    return { pressure: this.pressure, lowImpact: this.lowImpact, capture: this.capture.snapshot(), discovery: this.discovery.snapshot() };
  }

  close() {
    this.unsubscribe?.();
    this.capture.close();
    this.discovery.close();
  }
}
