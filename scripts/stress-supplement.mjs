import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const origin = process.env.WEBCAPTURE_ORIGIN || 'http://127.0.0.1:43193';
const outputRoot = path.join(root, 'runtime', 'stress');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(outputRoot, `supplement-${stamp}.jsonl`);
const statePath = path.join(outputRoot, 'supplement-current.json');
const pollMs = 3000;
const observeMs = 15 * 60 * 1000;

// 認証入口は画面を読むだけ、リンク/埋め込み系もGETだけに限定する。フォーム送信・ログイン・購入・外部操作はしない。
const targets = [
  { category: 'login-required', url: 'https://github.com/login', pages: 1 },
  { category: 'login-required', url: 'https://accounts.google.com/', pages: 1 },
  { category: 'login-required', url: 'https://id.atlassian.com/login', pages: 1 },
  { category: 'login-required', url: 'https://login.microsoftonline.com/', pages: 1 },
  { category: 'login-required', url: 'https://login.yahoo.com/', pages: 1 },
  { category: 'login-required', url: 'https://www.dropbox.com/login', pages: 1 },
  { category: 'login-required', url: 'https://www.paypal.com/signin', pages: 1 },
  { category: 'login-required', url: 'https://www.netflix.com/login', pages: 1 },
  { category: 'login-required', url: 'https://www.amazon.com/ap/signin', pages: 1 },
  { category: 'login-required', url: 'https://www.notion.so/login', pages: 1 },
  { category: 'login-required', url: 'https://www.canva.com/login', pages: 1 },
  { category: 'login-required', url: 'https://www.figma.com/login', pages: 1 },
  { category: 'login-required', url: 'https://www.facebook.com/login/', pages: 1 },
  { category: 'login-required', url: 'https://www.tiktok.com/login', pages: 1 },
  { category: 'link-heavy', url: 'https://docs.python.org/3/', pages: 2 },
  { category: 'link-heavy', url: 'https://www.gnu.org/', pages: 2 },
  { category: 'link-heavy', url: 'https://stackoverflow.com/', pages: 2 },
  { category: 'link-heavy', url: 'https://www.gov.uk/', pages: 2 },
  { category: 'link-heavy', url: 'https://www.bbc.com/', pages: 2 },
  { category: 'link-heavy', url: 'https://www.imdb.com/', pages: 2 },
  { category: 'link-heavy', url: 'https://www.openstreetmap.org/', pages: 2 },
  { category: 'link-heavy', url: 'https://en.wikipedia.org/wiki/Main_Page', pages: 2 },
  { category: 'link-heavy', url: 'https://medium.com/', pages: 2 },
  { category: 'link-heavy', url: 'https://developer.chrome.com/', pages: 2 },
  { category: 'embedded', url: 'https://codepen.io/', pages: 1 },
  { category: 'embedded', url: 'https://jsfiddle.net/', pages: 1 },
  { category: 'embedded', url: 'https://stackblitz.com/', pages: 1 },
  { category: 'embedded', url: 'https://observablehq.com/', pages: 1 },
  { category: 'embedded', url: 'https://www.twitch.tv/', pages: 1 },
  { category: 'embedded', url: 'https://vimeo.com/', pages: 1 },
  { category: 'embedded', url: 'https://www.w3schools.com/html/html_youtube.asp', pages: 1 },
  { category: 'embedded', url: 'https://www.google.com/maps', pages: 1 },
  { category: 'embedded', url: 'https://glitch.com/', pages: 1 }
];
const terminal = new Set(['complete', 'complete-with-errors', 'cancelled', 'limit-reached']);
const state = { pid: process.pid, startedAt: new Date().toISOString(), reportPath, status: 'running', index: 0, cycle: 0, submitted: 0, completed: 0, statusCounts: {}, categoryCounts: {}, active: null, lastError: null };
let csrf = '';
let stopping = false;

function safeUrl(value) {
  try { const u = new URL(String(value)); return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname || '/'}`.slice(0, 320); }
  catch { return String(value || '').slice(0, 320); }
}
function errText(error) { return String(error?.message || error || '不明なエラー').replace(/[\r\n]+/g, ' ').slice(0, 1000); }
async function write(record) {
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.appendFile(reportPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, 'utf8');
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`);
}
async function api(endpoint, init = {}, retry = true) {
  const headers = { accept: 'application/json', ...(init.headers || {}) };
  if (init.method && init.method !== 'GET') { headers['content-type'] ||= 'application/json'; headers['x-webcapture-csrf'] = csrf; }
  const response = await fetch(`${origin}${endpoint}`, { ...init, headers, redirect: 'error' });
  const text = await response.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { ok: false, error: { message: text.slice(0, 500) } }; }
  if (response.status === 403 && retry) { const b = await api('/api/bootstrap', {}, false); csrf = b.csrfToken || csrf; return api(endpoint, init, false); }
  if (!response.ok || body.ok === false) throw new Error(`${response.status} ${body?.error?.code || 'API_ERROR'}: ${body?.error?.message || 'API操作に失敗しました。'}`);
  return body;
}
function options(target) {
  return {
    followExternal: false, respectRobots: true, captureRendered: true, discoveryMode: target.pages > 1 ? 'partial' : 'immediate',
    discoveryPageLimit: target.pages, discoveryConcurrency: 2, maxPages: target.pages, maxBytes: 64 * 1024 * 1024, maxDurationMs: 180000,
    sameSiteWarningDepth: 30, sameSiteMaxDepth: 2, externalWarningDepth: 5, externalMaxDepth: 0, concurrency: 1, requestTimeoutMs: 30000,
    responseMaxBytes: 32 * 1024 * 1024, pageMaxBytes: 128 * 1024 * 1024, maxRedirects: 8, maxLinksPerPage: 2000, maxResourcesPerPage: 2000,
    queryPolicy: 'keep', resourceTypes: { stylesheet: true, script: true, image: true, media: true, font: true, xhr: true, other: true },
    screenshotMode: 'viewport', warcEnabled: true, warcCompressionLevel: 1, browserReuse: true, viewportWidth: 1440, viewportHeight: 1000,
    deviceScaleFactor: 1, initialWaitMs: 250, networkIdleMs: 700, networkIdleMaxMs: 8000, scrollEnabled: true, scrollDelayMs: 100,
    scrollStepRatio: 0.75, maxScrollContainers: 10, maxScrollStepsPerContainer: 30, imageWaitMs: 4000, preserveShadowDom: true,
    preserveCanvas: true, preserveFormState: true, freezeResponsiveImages: true, captureSrcsetCandidates: true, maxSrcsetCandidates: 5000
  };
}
async function audit(archiveId) {
  if (!archiveId) return { attempted: false, reason: 'archiveIdなし' };
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/audit-archive.mjs', archiveId], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    let report; try { report = JSON.parse(stdout); } catch { report = null; }
    if (!report) return { attempted: true, ok: false, reason: '監査JSONを解析できません。', stderr: stderr.slice(0, 1000) };
    return { attempted: true, ok: Boolean(report.ok), pages: report.pages, resources: report.resources, uniqueFiles: report.uniqueFiles, verifiedBytes: report.verifiedBytes, suspiciousEmptyResponses: report.suspiciousEmptyResponses, missingSrcsetCandidates: report.missingSrcsetCandidates, externalHostCount: report.externalHosts?.length || 0, blockedByReason: (report.blockedByReason || []).slice(0, 12), warc: report.warc, failureCount: report.failures?.length || 0, failures: (report.failures || []).slice(0, 20), reportPath: report.reportPath };
  } catch (error) { return { attempted: true, ok: false, reason: errText(error), stdout: String(error.stdout || '').slice(-2000), stderr: String(error.stderr || '').slice(-2000) }; }
}
async function logsFor(jobId) {
  try {
    const items = (await api('/api/diagnostics/logs?limit=1000')).logs || [];
    const related = items.filter((item) => item?.data?.jobId === jobId);
    const counts = {}; for (const item of related) { const key = `${item.level || 'info'}:${item.component || '?'}.${item.event || '?'}`; counts[key] = (counts[key] || 0) + 1; }
    const errors = related.filter((item) => item.level === 'warn' || item.level === 'error').slice(-40).map((item) => ({ timestamp: item.timestamp, level: item.level, component: item.component, event: item.event, code: item.data?.code, message: String(item.data?.message || '').slice(0, 500), url: safeUrl(item.data?.url || item.data?.pageUrl || item.data?.resourceUrl) }));
    return { count: related.length, counts, errors };
  } catch (error) { return { count: 0, counts: {}, errors: [], readError: errText(error) }; }
}
async function runOne(target) {
  state.active = { category: target.category, url: safeUrl(target.url), startedAt: new Date().toISOString() };
  try {
    const created = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ url: target.url, options: options(target) }) });
    const submittedAt = Date.now();
    const jobId = created.job.id; const archiveId = created.job.archiveId;
    state.submitted += 1;
    await write({ type: 'submitted', target: { category: target.category, url: safeUrl(target.url), pages: target.pages }, job: { id: jobId, archiveId, status: created.job.status } });
    let lastStatus = created.job.status; let job; let hangReported = false;
    while (!stopping) {
      const jobs = (await api('/api/jobs')).jobs || []; job = jobs.find((item) => item.id === jobId);
      if (!job) { await write({ type: 'job-missing', target: { category: target.category, url: safeUrl(target.url) }, jobId }); break; }
      if (job.status !== lastStatus) { lastStatus = job.status; await write({ type: 'status-change', target: { category: target.category, url: safeUrl(target.url) }, job: { id: job.id, archiveId: job.archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, currentUrl: safeUrl(job.currentUrl), message: String(job.message || '').slice(0, 300) } }); }
      if (terminal.has(job.status)) break;
      if (!hangReported && Date.now() - submittedAt > observeMs) { hangReported = true; await write({ type: 'suspected-hang', target: { category: target.category, url: safeUrl(target.url) }, job: { id: job.id, archiveId: job.archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, currentUrl: safeUrl(job.currentUrl) }, observedMs: Date.now() - submittedAt }); }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
    if (!job) return;
    const archive = await api(`/api/archives/${encodeURIComponent(job.archiveId)}`).then((result) => result.archive).catch(() => null);
    const result = { type: 'completed', target: { category: target.category, url: safeUrl(target.url), pages: target.pages }, job: { id: job.id, archiveId: job.archiveId, status: job.status, message: String(job.message || '').slice(0, 500), pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, phase: job.phase, currentUrl: safeUrl(job.currentUrl), durationMs: Date.now() - submittedAt }, archive: archive ? { id: archive.id, status: archive.status, pages: archive.pages, resources: archive.resources, bytes: archive.bytes, errors: archive.errors } : null, audit: await audit(job.archiveId), logs: await logsFor(job.id) };
    state.completed += 1; state.statusCounts[job.status] = (state.statusCounts[job.status] || 0) + 1; state.categoryCounts[target.category] = (state.categoryCounts[target.category] || 0) + 1; state.active = null; await write(result);
  } catch (error) { state.lastError = errText(error); state.active = null; await write({ type: 'target-error', target: { category: target.category, url: safeUrl(target.url) }, error: errText(error) }); }
}
async function main() {
  await fs.mkdir(outputRoot, { recursive: true });
  await fs.writeFile(path.join(outputRoot, 'supplement.pid.json'), `${JSON.stringify({ pid: process.pid, reportPath, startedAt: state.startedAt, root }, null, 2)}\n`, 'utf8');
  csrf = (await api('/api/bootstrap')).csrfToken || '';
  await write({ type: 'runner-started', origin, targetCount: targets.length, sequential: true, safety: { maxPagesPerTarget: 2, maxBytesPerJob: 64 * 1024 * 1024, maxDurationMs: 180000, followExternal: false, respectRobots: true, actions: 'GET only; no login/forms/purchases' } });
  while (!stopping) {
    for (; state.index < targets.length && !stopping; state.index += 1) await runOne(targets[state.index]);
    if (stopping) break;
    state.index = 0; state.cycle += 1;
    await write({ type: 'cycle-complete', cycle: state.cycle, submitted: state.submitted, completed: state.completed });
  }
  state.status = 'stopped'; await write({ type: 'runner-stopped', cycle: state.cycle, submitted: state.submitted, completed: state.completed });
}
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
main().catch(async (error) => { state.status = 'failed'; state.lastError = errText(error); await write({ type: 'runner-failed', error: errText(error) }).catch(() => {}); process.exitCode = 1; });

