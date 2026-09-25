import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = path.resolve(import.meta.dirname, '..');
const managementOrigin = process.env.WEBCAPTURE_ORIGIN || 'http://127.0.0.1:43193';
const maxConcurrentJobs = Math.max(1, Number(process.env.WEBCAPTURE_STRESS_CONCURRENCY || 2));
const pollMs = Math.max(1000, Number(process.env.WEBCAPTURE_STRESS_POLL_MS || 3000));
const maxObservationMs = Math.max(60000, Number(process.env.WEBCAPTURE_STRESS_OBSERVE_MS || 15 * 60 * 1000));
const stressRoot = path.join(projectRoot, 'runtime', 'stress');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(stressRoot, `stress-${runStamp}.jsonl`);
const statePath = path.join(stressRoot, 'stress-current.json');
const pidPath = path.join(stressRoot, 'runner.pid.json');

// 公開・認証不要の読み取り専用入口だけを対象にする。フォーム送信、ログイン、購入、外部操作は行わない。
// ページ数とバイト数は外部サイトへの負荷とローカルディスクの暴走を防ぐテスト用安全弁であり、本体の保存上限設定を変更しない。
const targets = [
  { category: 'static', url: 'https://example.com/', pages: 2, mode: 'immediate' },
  { category: 'static', url: 'https://httpbin.org/html', pages: 2, mode: 'immediate' },
  { category: 'redirect', url: 'https://httpbin.org/redirect/3', pages: 2, mode: 'immediate' },
  { category: 'redirect', url: 'https://httpbin.org/absolute-redirect/2', pages: 2, mode: 'immediate' },
  { category: 'document', url: 'https://www.w3.org/', pages: 3, mode: 'partial' },
  { category: 'document', url: 'https://www.rfc-editor.org/', pages: 3, mode: 'partial' },
  { category: 'document', url: 'https://developer.mozilla.org/en-US/', pages: 3, mode: 'partial' },
  { category: 'spa', url: 'https://react.dev/', pages: 2, mode: 'partial' },
  { category: 'spa', url: 'https://vite.dev/', pages: 2, mode: 'partial' },
  { category: 'spa', url: 'https://www.typescriptlang.org/', pages: 2, mode: 'partial' },
  { category: 'media', url: 'https://threejs.org/', pages: 2, mode: 'immediate' },
  { category: 'media', url: 'https://www.nasa.gov/', pages: 2, mode: 'partial' },
  { category: 'image', url: 'https://unsplash.com/', pages: 1, mode: 'immediate' },
  { category: 'commerce', url: 'https://www.shopify.com/', pages: 2, mode: 'partial' },
  { category: 'content', url: 'https://www.wikipedia.org/', pages: 2, mode: 'partial' },
  { category: 'content', url: 'https://openlibrary.org/', pages: 2, mode: 'partial' },
  { category: 'content', url: 'https://news.ycombinator.com/', pages: 2, mode: 'immediate' },
  { category: 'code-hosting', url: 'https://github.com/', pages: 2, mode: 'partial' },
  { category: 'auth-redirect', url: 'https://github.com/login', pages: 1, mode: 'immediate' },
  { category: 'auth-redirect', url: 'https://x.com/', pages: 1, mode: 'immediate' },
  { category: 'auth-redirect', url: 'https://www.reddit.com/login/', pages: 1, mode: 'immediate' },
  { category: 'auth-redirect', url: 'https://www.linkedin.com/', pages: 1, mode: 'immediate' },
  { category: 'auth-redirect', url: 'https://accounts.google.com/', pages: 1, mode: 'immediate' },
  { category: 'platform', url: 'https://www.mozilla.org/', pages: 2, mode: 'partial' },
  { category: 'platform', url: 'https://www.cloudflare.com/', pages: 2, mode: 'partial' },
  { category: 'platform', url: 'https://www.npmjs.com/', pages: 1, mode: 'immediate' }
];

const terminalStatuses = new Set(['complete', 'complete-with-errors', 'cancelled', 'limit-reached']);
const state = {
  runId: runStamp,
  pid: process.pid,
  startedAt: new Date().toISOString(),
  reportPath,
  status: 'running',
  cycle: 0,
  nextTarget: 0,
  submitted: 0,
  completed: 0,
  active: {},
  categoryCounts: {},
  statusCounts: {},
  lastEventAt: null,
  lastError: null
};
let csrfToken = '';
let stopping = false;

function safeUrl(value) {
  try {
    const url = new URL(String(value));
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}${url.pathname || '/'}`.slice(0, 320);
  } catch { return String(value || '').slice(0, 320); }
}

function safeTarget(target) {
  return { category: target.category, url: safeUrl(target.url), pages: target.pages, mode: target.mode };
}

function errorText(error) {
  return String(error?.message || error || '不明なエラー').replace(/[\r\n]+/g, ' ').slice(0, 1000);
}

function summarizeLog(item) {
  const data = item?.data && typeof item.data === 'object' ? item.data : {};
  const keys = ['jobId', 'archiveId', 'code', 'message', 'reason', 'status', 'scope', 'depth', 'externalDepth', 'attempted', 'recovered', 'failed', 'method', 'path'];
  const summary = {};
  for (const key of keys) if (data[key] !== undefined) summary[key] = /url/i.test(key) ? safeUrl(data[key]) : String(data[key]).slice(0, 500);
  for (const key of ['url', 'startUrl', 'targetUrl', 'resourceUrl', 'requestUrl', 'from']) {
    if (data[key] !== undefined) summary[key] = safeUrl(data[key]);
  }
  return { timestamp: item.timestamp, level: item.level, component: item.component, event: item.event, data: summary };
}

async function append(record) {
  await fs.mkdir(stressRoot, { recursive: true });
  const line = `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`;
  await fs.appendFile(reportPath, line, 'utf8');
  state.lastEventAt = new Date().toISOString();
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  process.stdout.write(line);
}

async function api(endpoint, init = {}, retry = true) {
  const headers = { accept: 'application/json', ...(init.headers || {}) };
  if (init.method && init.method !== 'GET') {
    headers['content-type'] ||= 'application/json';
    headers['x-webcapture-csrf'] = csrfToken;
  }
  const response = await fetch(`${managementOrigin}${endpoint}`, { ...init, headers, redirect: 'error' });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { ok: false, error: { message: text.slice(0, 500) } }; }
  if (response.status === 403 && retry) {
    const bootstrap = await api('/api/bootstrap', {}, false);
    csrfToken = bootstrap.csrfToken || csrfToken;
    return api(endpoint, init, false);
  }
  if (!response.ok || body.ok === false) throw new Error(`${response.status} ${body?.error?.code || 'API_ERROR'}: ${body?.error?.message || 'API操作に失敗しました。'}`);
  return body;
}

function captureOptions(target) {
  return {
    followExternal: false,
    respectRobots: true,
    captureRendered: true,
    discoveryMode: target.mode,
    discoveryPageLimit: target.pages,
    discoveryConcurrency: 2,
    maxPages: target.pages,
    maxBytes: 64 * 1024 * 1024,
    maxDurationMs: 180000,
    sameSiteWarningDepth: 30,
    sameSiteMaxDepth: 2,
    externalWarningDepth: 5,
    externalMaxDepth: 0,
    concurrency: 1,
    requestTimeoutMs: 30000,
    responseMaxBytes: 32 * 1024 * 1024,
    pageMaxBytes: 128 * 1024 * 1024,
    maxRedirects: 8,
    maxLinksPerPage: 2000,
    maxResourcesPerPage: 2000,
    queryPolicy: 'keep',
    resourceTypes: { stylesheet: true, script: true, image: true, media: true, font: true, xhr: true, other: true },
    screenshotMode: 'viewport',
    warcEnabled: true,
    warcCompressionLevel: 1,
    browserReuse: true,
    disableBrowserCache: false,
    viewportWidth: 1440,
    viewportHeight: 1000,
    deviceScaleFactor: 1,
    initialWaitMs: 250,
    networkIdleMs: 700,
    networkIdleMaxMs: 8000,
    scrollEnabled: true,
    scrollDelayMs: 100,
    scrollStepRatio: 0.75,
    maxScrollContainers: 10,
    maxScrollStepsPerContainer: 30,
    imageWaitMs: 4000,
    preserveShadowDom: true,
    preserveCanvas: true,
    preserveFormState: true,
    freezeResponsiveImages: true,
    captureSrcsetCandidates: true,
    maxSrcsetCandidates: 5000
  };
}

async function auditArchive(archiveId) {
  if (!archiveId) return { attempted: false, reason: 'archiveIdなし' };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/audit-archive.mjs', archiveId], {
      cwd: projectRoot, windowsHide: true, maxBuffer: 4 * 1024 * 1024
    });
    let report;
    try { report = JSON.parse(stdout); } catch { report = null; }
    if (!report) return { attempted: true, ok: false, reason: '監査JSONを解析できません。', stderr: stderr.slice(0, 1000) };
    return {
      attempted: true, ok: Boolean(report.ok), pages: report.pages, resources: report.resources,
      uniqueFiles: report.uniqueFiles, verifiedBytes: report.verifiedBytes,
      suspiciousEmptyResponses: report.suspiciousEmptyResponses,
      brokenCandidateUrls: report.brokenCandidateUrls,
      srcsetCandidates: report.srcsetCandidates,
      missingSrcsetCandidates: report.missingSrcsetCandidates,
      externalHostCount: Array.isArray(report.externalHosts) ? report.externalHosts.length : 0,
      blockedByReason: (report.blockedByReason || []).slice(0, 12),
      warc: report.warc,
      failureCount: Array.isArray(report.failures) ? report.failures.length : 0,
      failures: (report.failures || []).slice(0, 20),
      reportPath: report.reportPath
    };
  } catch (error) {
    return {
      attempted: true, ok: false, exitCode: error.code, reason: errorText(error),
      stdout: String(error.stdout || '').slice(-2000), stderr: String(error.stderr || '').slice(-2000)
    };
  }
}

async function relatedLogs(jobId) {
  try {
    const result = await api('/api/diagnostics/logs?limit=1000');
    const logs = Array.isArray(result.logs) ? result.logs.filter((item) => item?.data?.jobId === jobId) : [];
    const counts = {};
    for (const item of logs) {
      const key = `${item.level || 'info'}:${item.component || 'unknown'}.${item.event || 'event'}`;
      counts[key] = (counts[key] || 0) + 1;
    }
    return { count: logs.length, counts, errors: logs.filter((item) => item.level === 'error' || item.level === 'warn').slice(-40).map(summarizeLog) };
  } catch (error) { return { count: 0, counts: {}, errors: [], readError: errorText(error) }; }
}

async function submit(target) {
  const result = await api('/api/jobs', {
    method: 'POST',
    body: JSON.stringify({ url: target.url, options: captureOptions(target) })
  });
  return result.job;
}

async function finish(activeItem, job) {
  const archive = job.archiveId ? (await api(`/api/archives/${encodeURIComponent(job.archiveId)}`).catch(() => null))?.archive : null;
  const audit = await auditArchive(job.archiveId);
  const logs = await relatedLogs(job.id);
  const record = {
    type: 'completed',
    target: safeTarget(activeItem.target),
    job: {
      id: job.id, archiveId: job.archiveId, status: job.status, message: String(job.message || '').slice(0, 500),
      pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors,
      phase: job.phase, depth: job.depth, currentUrl: safeUrl(job.currentUrl), startedAt: activeItem.startedAt,
      durationMs: Date.now() - activeItem.startedEpoch
    },
    archive: archive ? { id: archive.id, status: archive.status, pages: archive.pages, resources: archive.resources, bytes: archive.bytes, errors: archive.errors } : null,
    audit,
    logs
  };
  state.completed += 1;
  state.statusCounts[job.status] = (state.statusCounts[job.status] || 0) + 1;
  state.categoryCounts[activeItem.target.category] = (state.categoryCounts[activeItem.target.category] || 0) + 1;
  delete state.active[job.id];
  await append(record);
}

async function submitNext() {
  const target = targets[state.nextTarget];
  state.nextTarget += 1;
  if (state.nextTarget >= targets.length) { state.nextTarget = 0; state.cycle += 1; }
  try {
    const job = await submit(target);
    const item = { target, startedAt: new Date().toISOString(), startedEpoch: Date.now(), lastStatus: job.status };
    state.active[job.id] = { target: safeTarget(target), startedAt: item.startedAt, lastStatus: job.status };
    state.submitted += 1;
    await append({ type: 'submitted', target: safeTarget(target), job: { id: job.id, archiveId: job.archiveId, status: job.status }, cycle: state.cycle });
    return [job.id, item];
  } catch (error) {
    await append({ type: 'submission-error', target: safeTarget(target), error: errorText(error), cycle: state.cycle });
    state.lastError = errorText(error);
    return null;
  }
}

async function poll(active) {
  let jobs;
  try { jobs = (await api('/api/jobs')).jobs || []; }
  catch (error) {
    await append({ type: 'poll-error', error: errorText(error), activeJobIds: [...active.keys()] });
    state.lastError = errorText(error);
    return;
  }
  for (const [jobId, item] of [...active.entries()]) {
    const job = jobs.find((candidate) => candidate.id === jobId);
    if (!job) {
      await append({ type: 'job-missing', target: safeTarget(item.target), jobId, observedMs: Date.now() - item.startedEpoch });
      active.delete(jobId); delete state.active[jobId];
      continue;
    }
    if (job.status !== item.lastStatus) {
      await append({ type: 'status-change', target: safeTarget(item.target), job: { id: job.id, archiveId: job.archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, currentUrl: safeUrl(job.currentUrl), message: String(job.message || '').slice(0, 300) } });
      item.lastStatus = job.status;
      state.active[jobId].lastStatus = job.status;
    }
    if (terminalStatuses.has(job.status)) {
      active.delete(jobId);
      await finish(item, job);
      continue;
    }
    if (Date.now() - item.startedEpoch > maxObservationMs && !item.hangReported) {
      item.hangReported = true;
      await append({ type: 'suspected-hang', target: safeTarget(item.target), job: { id: job.id, archiveId: job.archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, currentUrl: safeUrl(job.currentUrl), message: String(job.message || '').slice(0, 500) }, observedMs: Date.now() - item.startedEpoch });
    }
  }
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function main() {
  await fs.mkdir(stressRoot, { recursive: true });
  await fs.writeFile(pidPath, `${JSON.stringify({ pid: process.pid, reportPath, startedAt: state.startedAt, root: projectRoot }, null, 2)}\n`, 'utf8');
  const bootstrap = await api('/api/bootstrap');
  csrfToken = bootstrap.csrfToken || '';
  await append({ type: 'runner-started', managementOrigin, maxConcurrentJobs, pollMs, maxObservationMs, targetCount: targets.length, browser: bootstrap.browser, safety: { pagesPerTarget: '1-3', maxBytesPerJob: 64 * 1024 * 1024, maxDurationMs: 180000, followExternal: false, respectRobots: true } });
  const active = new Map();
  while (!stopping) {
    await poll(active);
    while (!stopping && active.size < maxConcurrentJobs) {
      const result = await submitNext();
      if (result) active.set(result[0], result[1]);
      else if (active.size >= maxConcurrentJobs) break;
      if (!result && active.size === 0) await new Promise((resolve) => setTimeout(resolve, 5000));
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  state.status = 'stopped';
  for (const [jobId, item] of active) state.active[jobId] = { target: safeTarget(item.target), startedAt: item.startedAt, lastStatus: item.lastStatus, leftRunning: true };
  await append({ type: 'runner-stopped', activeJobIds: [...active.keys()], reason: 'SIGINT/SIGTERM' });
}

process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });

main().catch(async (error) => {
  state.status = 'failed';
  state.lastError = errorText(error);
  await append({ type: 'runner-failed', error: errorText(error) }).catch(() => {});
  process.exitCode = 1;
});

