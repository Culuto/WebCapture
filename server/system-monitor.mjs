import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logEvent } from './logger.mjs';

const execFileAsync = promisify(execFile);
const MAX_FILE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOWS_COUNTER_SCRIPT = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
$disk = Get-CimInstance Win32_PerfFormattedData_PerfDisk_PhysicalDisk | Where-Object { $_.Name -eq '_Total' } | Select-Object -First 1
$network = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface)
$networkBytes = [double](($network | Measure-Object -Property BytesTotalPersec -Sum).Sum)
$networkPercent = 0.0
foreach ($item in $network) {
  $bandwidth = [double]$item.CurrentBandwidth
  if ($bandwidth -gt 0) { $networkPercent = [Math]::Max($networkPercent, ([double]$item.BytesTotalPersec * 8.0 * 100.0 / $bandwidth)) }
}
$gpuEngines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine)
$gpuGroups = @{}
foreach ($engine in $gpuEngines) {
  $key = [string]$engine.Name
  if ($key -match '^pid_\d+_(luid_.+?_phys_\d+_eng_\d+_engtype_.+)$') { $key = $Matches[1] }
  if (-not $gpuGroups.ContainsKey($key)) { $gpuGroups[$key] = 0.0 }
  $gpuGroups[$key] += [double]$engine.UtilizationPercentage
}
$gpuPercent = 0.0
foreach ($value in $gpuGroups.Values) { $gpuPercent = [Math]::Max($gpuPercent, [double]$value) }
[ordered]@{
  disk = [ordered]@{
    available = ($null -ne $disk)
    busyPercent = $(if ($null -ne $disk) { 100.0 - [double]$disk.PercentIdleTime } else { $null })
    readBytesPerSecond = $(if ($null -ne $disk) { [double]$disk.DiskReadBytesPersec } else { $null })
    writeBytesPerSecond = $(if ($null -ne $disk) { [double]$disk.DiskWriteBytesPersec } else { $null })
  }
  network = [ordered]@{
    available = ($network.Count -gt 0)
    bytesPerSecond = $(if ($network.Count -gt 0) { $networkBytes } else { $null })
    utilizationPercent = $(if ($network.Count -gt 0) { $networkPercent } else { $null })
  }
  gpu = [ordered]@{
    available = ($gpuEngines.Count -gt 0)
    percent = $(if ($gpuEngines.Count -gt 0) { $gpuPercent } else { $null })
  }
} | ConvertTo-Json -Compress -Depth 4
`;

function finite(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clampPercent(value) {
  const parsed = finite(value);
  return parsed === null ? null : Math.min(100, Math.max(0, Math.round(parsed * 10) / 10));
}

function cpuTotals(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus || []) {
    idle += finite(cpu?.times?.idle, 0);
    total += Object.values(cpu?.times || {}).reduce((sum, value) => sum + finite(value, 0), 0);
  }
  return { idle, total };
}

export function cpuUsagePercent(previous, current) {
  const before = cpuTotals(previous);
  const after = cpuTotals(current);
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (!(totalDelta > 0) || idleDelta < 0) return null;
  return clampPercent((1 - idleDelta / totalDelta) * 100);
}

export function normalizeWindowsCounters(value = {}) {
  return {
    disk: {
      available: Boolean(value.disk?.available),
      busyPercent: value.disk?.available ? clampPercent(value.disk.busyPercent) : null,
      readBytesPerSecond: value.disk?.available ? Math.max(0, Math.round(finite(value.disk.readBytesPerSecond, 0))) : null,
      writeBytesPerSecond: value.disk?.available ? Math.max(0, Math.round(finite(value.disk.writeBytesPerSecond, 0))) : null
    },
    network: {
      available: Boolean(value.network?.available),
      bytesPerSecond: value.network?.available ? Math.max(0, Math.round(finite(value.network.bytesPerSecond, 0))) : null,
      utilizationPercent: value.network?.available ? clampPercent(value.network.utilizationPercent) : null
    },
    gpu: {
      available: Boolean(value.gpu?.available),
      percent: value.gpu?.available ? clampPercent(value.gpu.percent) : null
    }
  };
}

export async function sampleWindowsCounters({ timeoutMs = 4000 } = {}) {
  if (process.platform !== 'win32') return normalizeWindowsCounters();
  const encoded = Buffer.from(WINDOWS_COUNTER_SCRIPT, 'utf16le').toString('base64');
  const { stdout } = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 5 * 1024 * 1024,
    encoding: 'utf8'
  });
  return normalizeWindowsCounters(JSON.parse(String(stdout).trim()));
}

async function readTailLines(file, wanted) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const chunks = [];
    let position = size;
    let newlines = 0;
    while (position > 0 && newlines <= wanted) {
      const length = Math.min(64 * 1024, position);
      position -= length;
      const buffer = Buffer.allocUnsafe(length);
      await handle.read(buffer, 0, length, position);
      chunks.unshift(buffer);
      for (const byte of buffer) if (byte === 10) newlines += 1;
    }
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter(Boolean).slice(-wanted);
  } finally {
    await handle.close();
  }
}

export class SystemMonitor {
  constructor({ metricsRoot, dataRoot, intervalMs = 10000, counterSampler = sampleWindowsCounters, cpuProvider = os.cpus, memoryProvider = () => ({ total: os.totalmem(), free: os.freemem() }), statfs = fs.statfs } = {}) {
    this.metricsRoot = path.resolve(metricsRoot);
    this.dataRoot = path.resolve(dataRoot);
    this.intervalMs = Math.max(1000, Number(intervalMs) || 10000);
    this.counterSampler = counterSampler;
    this.cpuProvider = cpuProvider;
    this.memoryProvider = memoryProvider;
    this.statfs = statfs;
    this.previousCpu = this.cpuProvider();
    this.latest = null;
    this.listeners = new Set();
    this.timer = null;
    this.inFlight = null;
    this.writeQueue = Promise.resolve();
    this.lastCounterError = '';
    this.lastCleanupDay = '';
  }

  async start() {
    await fs.mkdir(this.metricsRoot, { recursive: true });
    this.sample().catch(() => {});
    this.timer = setInterval(() => this.sample().catch(() => {}), this.intervalMs);
    this.timer.unref?.();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot() {
    return this.latest ? structuredClone(this.latest) : null;
  }

  async sample() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.sampleOnce().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async sampleOnce() {
    let counters = normalizeWindowsCounters();
    let counterError = null;
    let diskSpace = null;
    try { counters = await this.counterSampler(); }
    catch (error) { counterError = error; }
    try { diskSpace = await this.statfs(this.dataRoot); }
    catch (error) {
      logEvent('warn', 'metrics', 'disk-space.failed', { code: error.code || 'STATFS_FAILED', message: error.message });
    }
    const currentCpu = this.cpuProvider();
    const cpuPercent = cpuUsagePercent(this.previousCpu, currentCpu);
    this.previousCpu = currentCpu;
    const memory = this.memoryProvider();
    const memoryTotal = Math.max(0, finite(memory.total, 0));
    const memoryFree = Math.max(0, finite(memory.free, 0));
    const blockSize = Math.max(0, finite(diskSpace?.bsize, 0));
    const diskTotal = blockSize * Math.max(0, finite(diskSpace?.blocks, 0));
    const diskFree = blockSize * Math.max(0, finite(diskSpace?.bavail ?? diskSpace?.bfree, 0));
    const sample = {
      timestamp: new Date().toISOString(),
      cpu: { available: cpuPercent !== null, percent: cpuPercent, logicalProcessors: currentCpu.length },
      memory: {
        available: memoryTotal > 0,
        percent: memoryTotal > 0 ? clampPercent((memoryTotal - memoryFree) * 100 / memoryTotal) : null,
        usedBytes: memoryTotal > 0 ? Math.max(0, memoryTotal - memoryFree) : null,
        totalBytes: memoryTotal > 0 ? memoryTotal : null
      },
      disk: {
        ...counters.disk,
        spaceAvailable: diskTotal > 0,
        freeBytes: diskTotal > 0 ? diskFree : null,
        totalBytes: diskTotal > 0 ? diskTotal : null
      },
      network: counters.network,
      gpu: counters.gpu,
      process: { rssBytes: process.memoryUsage().rss }
    };
    this.latest = sample;
    if (counterError) {
      const errorKey = `${counterError.code || counterError.name || 'COUNTERS_FAILED'}:${counterError.message}`;
      if (errorKey !== this.lastCounterError) logEvent('warn', 'metrics', 'windows-counters.failed', { code: counterError.code || 'COUNTERS_FAILED', message: counterError.message });
      this.lastCounterError = errorKey;
    } else if (this.lastCounterError) {
      logEvent('info', 'metrics', 'windows-counters.recovered');
      this.lastCounterError = '';
    }
    logEvent('info', 'metrics', 'sampled', {
      cpuPercent: sample.cpu.percent,
      memoryPercent: sample.memory.percent,
      diskBusyPercent: sample.disk.busyPercent,
      networkBytesPerSecond: sample.network.bytesPerSecond,
      networkUtilizationPercent: sample.network.utilizationPercent,
      gpuPercent: sample.gpu.percent,
      processRssBytes: sample.process.rssBytes
    });
    await this.record(sample);
    for (const listener of this.listeners) {
      try { listener(sample); } catch (error) { logEvent('warn', 'metrics', 'listener.failed', { message: error.message }); }
    }
    return this.snapshot();
  }

  async cleanup(day) {
    if (this.lastCleanupDay === day) return;
    this.lastCleanupDay = day;
    const now = Date.now();
    for (const name of await fs.readdir(this.metricsRoot)) {
      if (!/^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)) continue;
      const file = path.join(this.metricsRoot, name);
      try { if (now - (await fs.stat(file)).mtimeMs > MAX_FILE_AGE_MS) await fs.rm(file, { force: true }); } catch {}
    }
  }

  async record(sample) {
    const day = sample.timestamp.slice(0, 10);
    this.writeQueue = this.writeQueue.then(async () => {
      await this.cleanup(day);
      await fs.appendFile(path.join(this.metricsRoot, `metrics-${day}.jsonl`), `${JSON.stringify(sample)}\n`, 'utf8');
    }).catch((error) => logEvent('warn', 'metrics', 'record.failed', { code: error.code || 'METRICS_WRITE_FAILED', message: error.message }));
    await this.writeQueue;
  }

  async recent(limit = 300) {
    await this.writeQueue;
    const wanted = Math.max(1, Math.min(2000, Number(limit) || 300));
    let names = [];
    try { names = (await fs.readdir(this.metricsRoot)).filter((name) => /^metrics-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort().reverse(); } catch {}
    const lines = [];
    for (const name of names) {
      const remaining = wanted - lines.length;
      if (remaining <= 0) break;
      lines.unshift(...await readTailLines(path.join(this.metricsRoot, name), remaining));
    }
    return lines.slice(-wanted).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    await this.inFlight?.catch(() => {});
    await this.writeQueue;
  }
}
