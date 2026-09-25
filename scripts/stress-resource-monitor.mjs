import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const outputRoot = path.join(root, 'runtime', 'stress');
const currentPath = path.join(outputRoot, 'resource-current.json');
const pids = [...new Set(String(process.env.WEBCAPTURE_MONITOR_PIDS || '34808,43760,33632').split(',').map((value) => Number(value.trim())).filter(Number.isInteger))];
const powershell = 'powershell.exe';
const maxReportBytes = 64 * 1024 * 1024;
let reportRotation = 0;
let reportPath = newReportPath();
let stopping = false;
let previousCpu = null;
let previousProcessCpu = new Map();
let previousProcessCpuAt = null;

function newReportPath() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = reportRotation ? `-${reportRotation}` : '';
  return path.join(outputRoot, `resource-usage-${stamp}${suffix}.jsonl`);
}

async function tasklist(pid) {
  try {
    const { stdout } = await execFileAsync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 10000 });
    const match = stdout.match(/"[^"]+","(\d+)","[^"]+","[^"]+","([\d,]+) K"/);
    return match ? { pid: Number(match[1]), workingSetBytes: Number(match[2].replaceAll(',', '')) * 1024 } : { pid, missing: true };
  } catch (error) { return { pid, error: String(error?.message || error).slice(0, 300) }; }
}

function cpuSnapshot() {
  const cpus = os.cpus();
  const totals = cpus.reduce((sum, cpu) => {
    const times = cpu.times || {};
    const total = Object.values(times).reduce((part, value) => part + Number(value || 0), 0);
    return { total: sum.total + total, idle: sum.idle + Number(times.idle || 0) };
  }, { total: 0, idle: 0 });
  let utilizationPercent = null;
  if (previousCpu && totals.total > previousCpu.total) {
    const totalDelta = totals.total - previousCpu.total;
    const idleDelta = Math.max(0, totals.idle - previousCpu.idle);
    utilizationPercent = Number(Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100)).toFixed(2));
  }
  previousCpu = totals;
  return { utilizationPercent, logicalCores: cpus.length, sample: 'os.cpus' };
}

function memorySnapshot() {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = Math.max(0, totalBytes - freeBytes);
  return {
    totalBytes,
    freeBytes,
    usedBytes,
    usedPercent: totalBytes ? Number((usedBytes / totalBytes * 100).toFixed(2)) : null,
    sample: 'os.totalmem/os.freemem',
  };
}

const powershellScript = [
  '$ErrorActionPreference = "Stop"',
  '$errors = [ordered]@{}',
  '$disks = @(); try { $disks = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object { $size=[double]$_.Size; $free=[double]$_.FreeSpace; [pscustomobject]@{device=$_.DeviceID; totalBytes=$size; freeBytes=$free; usedBytes=($size-$free); usedPercent=if($size -gt 0){[math]::Round((1-($free/$size))*100,2)}else{$null} } }) } catch { $errors["disks"] = $_.Exception.Message }',
  '$diskIo = @(); try { $diskIo = @(Get-CimInstance Win32_PerfFormattedData_PerfDisk_LogicalDisk | Where-Object {$_.Name -ne "_Total"} | ForEach-Object { [pscustomobject]@{device=$_.Name; percentDiskTime=[double]$_.PercentDiskTime; diskBytesPerSec=[double]$_.DiskBytesPerSec; readsPerSec=[double]$_.DiskReadsPerSec; writesPerSec=[double]$_.DiskWritesPerSec} }) } catch { $errors["diskIo"] = $_.Exception.Message }',
  '$interfaces = @(); try { $interfaces = @(Get-CimInstance Win32_PerfFormattedData_Tcpip_NetworkInterface | ForEach-Object { $bandwidth=[double]$_.CurrentBandwidth; $total=[double]$_.BytesTotalPersec; [pscustomobject]@{name=$_.Name; currentBandwidthBitsPerSec=$bandwidth; bytesReceivedPerSec=[double]$_.BytesReceivedPersec; bytesSentPerSec=[double]$_.BytesSentPersec; bytesTotalPerSec=$total; packetsPerSec=[double]$_.PacketsPersec; utilizationPercent=if($bandwidth -gt 0){[math]::Round(($total*8/$bandwidth)*100,2)}else{$null} } }) } catch { $errors["network"] = $_.Exception.Message }',
  '$gpuTop = @(); $gpuSummary = $null; try { $gpuRaw = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine | ForEach-Object { [pscustomobject]@{name=$_.Name; utilizationPercent=[double]$_.UtilizationPercentage} }); $gpuUsages = @($gpuRaw | ForEach-Object { [double]$_.utilizationPercent }); $gpuSummary = [pscustomobject]@{engineCount=$gpuRaw.Count; activeEngineCount=@($gpuUsages | Where-Object {$_ -gt 0}).Count; maxUtilizationPercent=if($gpuRaw.Count){[double](($gpuUsages | Measure-Object -Maximum).Maximum)}else{$null}; averageUtilizationPercent=if($gpuRaw.Count){[math]::Round((($gpuUsages | Measure-Object -Average).Average),2)}else{$null} }; $gpuTop = @($gpuRaw | Sort-Object utilizationPercent -Descending | Select-Object -First 20) } catch { $errors["gpuEngines"] = $_.Exception.Message }',
  '[pscustomobject]@{disks=$disks; diskIo=$diskIo; network=$interfaces; gpuEngines=$gpuTop; gpuSummary=$gpuSummary; errors=$errors} | ConvertTo-Json -Depth 8 -Compress',
].join('; ');

const processCpuScript = pids.length
  ? `$ids=@(${pids.join(',')}); Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{pid=$_.Id; cpuSeconds=[double]$_.CPU} } | ConvertTo-Json -Compress`
  : '[]';

async function windowsCounters() {
  const result = { disks: [], diskIo: [], network: { interfaces: [], totals: null }, gpu: { windowsEngines: [], windowsEngineSummary: null, nvidiaSmi: null }, windowsCounterErrors: {} };
  try {
    const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershellScript], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout.trim() || '{}');
    result.disks = Array.isArray(parsed.disks) ? parsed.disks : (parsed.disks ? [parsed.disks] : []);
    result.diskIo = Array.isArray(parsed.diskIo) ? parsed.diskIo : (parsed.diskIo ? [parsed.diskIo] : []);
    result.windowsCounterErrors = parsed.errors && typeof parsed.errors === 'object' ? parsed.errors : {};
    const interfaces = Array.isArray(parsed.network) ? parsed.network : (parsed.network ? [parsed.network] : []);
    const totals = interfaces.reduce((sum, item) => ({
      bytesReceivedPerSec: sum.bytesReceivedPerSec + Number(item.bytesReceivedPerSec || 0),
      bytesSentPerSec: sum.bytesSentPerSec + Number(item.bytesSentPerSec || 0),
      bytesTotalPerSec: sum.bytesTotalPerSec + Number(item.bytesTotalPerSec || 0),
      packetsPerSec: sum.packetsPerSec + Number(item.packetsPerSec || 0),
    }), { bytesReceivedPerSec: 0, bytesSentPerSec: 0, bytesTotalPerSec: 0, packetsPerSec: 0 });
    const bandwidth = interfaces.reduce((sum, item) => sum + Number(item.currentBandwidthBitsPerSec || 0), 0);
    result.network = { interfaces, totals: { ...totals, currentBandwidthBitsPerSec: bandwidth, utilizationPercent: bandwidth ? Number((totals.bytesTotalPerSec * 8 / bandwidth * 100).toFixed(2)) : null } };
    const gpuEngines = Array.isArray(parsed.gpuEngines) ? parsed.gpuEngines : (parsed.gpuEngines ? [parsed.gpuEngines] : []);
    result.gpu.windowsEngineSummary = parsed.gpuSummary || null;
    result.gpu.windowsEngines = gpuEngines;
  } catch (error) {
    result.windowsCountersError = String(error?.message || error).slice(0, 500);
  }
  try {
    const { stdout } = await execFileAsync('nvidia-smi.exe', ['--query-gpu=index,name,utilization.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 512 * 1024,
    });
    const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
    const invalidRows = [];
    const rows = lines.map((line) => {
      const [index, name, utilizationPercent, memoryUsedMiB, memoryTotalMiB] = line.split(',').map((value) => value.trim());
      const row = { index: Number(index), name, utilizationPercent: Number(utilizationPercent), memoryUsedMiB: Number(memoryUsedMiB), memoryTotalMiB: Number(memoryTotalMiB) };
      if (!Number.isInteger(row.index) || !Number.isFinite(row.utilizationPercent) || !Number.isFinite(row.memoryUsedMiB) || !Number.isFinite(row.memoryTotalMiB)) { invalidRows.push(line.slice(0, 300)); return null; }
      return row;
    }).filter(Boolean);
    result.gpu.nvidiaSmi = rows.length ? rows : { unavailable: true, reason: lines.length ? 'no-valid-device-rows' : 'no-devices-returned', invalidRows };
    if (invalidRows.length) result.gpu.nvidiaSmiParseWarnings = invalidRows;
  } catch (error) {
    result.gpu.nvidiaSmi = { unavailable: true, error: String(error?.message || error).slice(0, 300) };
  }
  return result;
}

async function processCpuSnapshot() {
  const now = Date.now();
  const intervalSeconds = previousProcessCpuAt ? Math.max(0.001, (now - previousProcessCpuAt) / 1000) : null;
  const result = { samples: [], error: null };
  try {
    const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', processCpuScript], { windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024 });
    const parsed = JSON.parse(stdout.trim() || '[]');
    const rows = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
    const next = new Map();
    result.samples = rows.map((row) => {
      const pid = Number(row.pid);
      const cpuSeconds = Number(row.cpuSeconds);
      const before = previousProcessCpu.get(pid);
      const cpuPercent = before !== undefined && intervalSeconds ? Number(Math.max(0, Math.min(100, (cpuSeconds - before) / intervalSeconds / Math.max(1, os.cpus().length) * 100)).toFixed(2)) : null;
      next.set(pid, cpuSeconds);
      return { pid, cpuSeconds, cpuPercent, sample: 'Get-Process.CPU' };
    }).filter((row) => Number.isInteger(row.pid) && Number.isFinite(row.cpuSeconds));
    previousProcessCpu = next;
  } catch (error) { result.error = String(error?.message || error).slice(0, 500); }
  previousProcessCpuAt = now;
  return result;
}

async function rotateReportIfNeeded() {
  try {
    const stat = await fs.stat(reportPath);
    if (stat.size >= maxReportBytes) { reportRotation += 1; reportPath = newReportPath(); }
  } catch {}
}

async function snapshot() {
  await fs.mkdir(outputRoot, { recursive: true });
  const [processes, counters, processCpu] = await Promise.all([Promise.all(pids.map(tasklist)), windowsCounters(), processCpuSnapshot()]);
  const processCpuByPid = new Map(processCpu.samples.map((item) => [item.pid, item]));
  const processRecords = processes.map((item) => ({ ...item, ...(processCpuByPid.get(item.pid) || {}) }));
  const files = [];
  for (const name of ['stress-current.json', 'supplement-current.json', 'profiles-current.json', 'wide-current.json']) {
    try { const stat = await fs.stat(path.join(outputRoot, name)); files.push({ name, bytes: stat.size, mtime: stat.mtime.toISOString() }); } catch {}
  }
  const record = {
    timestamp: new Date().toISOString(),
    monitorPid: process.pid,
    reportFile: path.relative(root, reportPath),
    currentFile: path.relative(root, currentPath),
    metrics: {
      cpu: cpuSnapshot(),
      memory: memorySnapshot(),
      disks: counters.disks,
      diskIo: counters.diskIo,
      network: counters.network,
      gpu: counters.gpu,
      ...(Object.keys(counters.windowsCounterErrors || {}).length ? { windowsCounterErrors: counters.windowsCounterErrors } : {}),
      ...(counters.windowsCountersError ? { windowsCountersError: counters.windowsCountersError } : {}),
      ...(processCpu.error ? { processCpuError: processCpu.error } : {}),
    },
    processes: processRecords,
    files,
  };
  await rotateReportIfNeeded();
  record.reportFile = path.relative(root, reportPath);
  await fs.appendFile(reportPath, `${JSON.stringify(record)}\n`, 'utf8');
  await fs.writeFile(currentPath, `${JSON.stringify(record)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({
    timestamp: record.timestamp,
    monitorPid: record.monitorPid,
    reportFile: record.reportFile,
    metrics: { cpu: record.metrics.cpu, memory: record.metrics.memory, disks: record.metrics.disks, diskIo: record.metrics.diskIo, network: { totals: record.metrics.network.totals }, gpu: { windowsEngineSummary: record.metrics.gpu.windowsEngineSummary, nvidiaSmi: record.metrics.gpu.nvidiaSmi } },
    processes: record.processes,
  })}\n`);
}
async function main() {
  await snapshot();
  while (!stopping) { await new Promise((resolve) => setTimeout(resolve, 30000)); if (!stopping) await snapshot(); }
}
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
main().catch((error) => { process.stderr.write(`${error.stack || error}\n`); process.exitCode = 1; });
