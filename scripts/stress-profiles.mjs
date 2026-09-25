import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, '..');
const origin = process.env.WEBCAPTURE_ORIGIN || 'http://127.0.0.1:43193';
const outDir = path.join(root, 'runtime', 'stress');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(outDir, `profiles-${stamp}.jsonl`);
const statePath = path.join(outDir, 'profiles-current.json');
const targets = [
  { url: 'https://www.bbc.com/', family: 'heavy-news' },
  { url: 'https://www.nasa.gov/', family: 'heavy-media' },
  { url: 'https://en.wikipedia.org/wiki/Main_Page', family: 'link-heavy' },
  { url: 'https://codepen.io/', family: 'embedded' },
  { url: 'https://openlibrary.org/', family: 'link-heavy' }
];
const profiles = [
  { name: 'baseline', patch: {} },
  { name: 'warc-uncompressed', patch: { warcCompressionLevel: 0 } },
  { name: 'warc-max-compression', patch: { warcCompressionLevel: 9 } },
  { name: 'deep-same-site', patch: { maxPages: 3, discoveryPageLimit: 3, sameSiteMaxDepth: 4, discoveryConcurrency: 4 } },
  { name: 'external-one-level', patch: { followExternal: true, externalMaxDepth: 1, externalWarningDepth: 2, maxPages: 2, discoveryPageLimit: 2 } },
  { name: 'fresh-browser', patch: { browserReuse: false, concurrency: 1 } },
  { name: 'media-priority', patch: { maxPages: 1, discoveryPageLimit: 1, resourceTypes: { stylesheet: true, script: true, image: true, media: true, font: true, xhr: true, other: true }, screenshotMode: 'full-page', imageWaitMs: 8000, networkIdleMaxMs: 12000 } }
];
const terminal = new Set(['complete', 'complete-with-errors', 'cancelled', 'limit-reached']);
const state = { pid: process.pid, startedAt: new Date().toISOString(), reportPath, status: 'running', index: 0, cycle: 0, submitted: 0, completed: 0, active: null, lastError: null };
let csrf = '';
let stopping = false;

const safeUrl = (v) => { try { const u = new URL(String(v)); return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname || '/'}`.slice(0, 320); } catch { return String(v || '').slice(0, 320); } };
const errText = (e) => String(e?.message || e || '不明なエラー').replace(/[\r\n]+/g, ' ').slice(0, 1000);
async function write(record) { await fs.mkdir(outDir, { recursive: true }); const row = { timestamp: new Date().toISOString(), ...record }; await fs.appendFile(reportPath, `${JSON.stringify(row)}\n`, 'utf8'); await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8'); process.stdout.write(`${JSON.stringify(row)}\n`); }
async function api(endpoint, init = {}, retry = true) { const headers = { accept: 'application/json', ...(init.headers || {}) }; if (init.method && init.method !== 'GET') { headers['content-type'] ||= 'application/json'; headers['x-webcapture-csrf'] = csrf; } const response = await fetch(`${origin}${endpoint}`, { ...init, headers, redirect: 'error' }); const text = await response.text(); let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { ok: false, error: { message: text.slice(0, 500) } }; } if (response.status === 403 && retry) { const b = await api('/api/bootstrap', {}, false); csrf = b.csrfToken || csrf; return api(endpoint, init, false); } if (!response.ok || body.ok === false) throw new Error(`${response.status} ${body?.error?.code || 'API_ERROR'}: ${body?.error?.message || 'API操作に失敗しました。'}`); return body; }
function options(profile, target) { return { followExternal: false, respectRobots: true, captureRendered: true, discoveryMode: profile.patch.maxPages > 1 ? 'partial' : 'immediate', discoveryPageLimit: profile.patch.maxPages || 1, discoveryConcurrency: 2, maxPages: 1, maxBytes: 64 * 1024 * 1024, maxDurationMs: 180000, sameSiteWarningDepth: 30, sameSiteMaxDepth: 2, externalWarningDepth: 5, externalMaxDepth: 0, concurrency: 1, requestTimeoutMs: 30000, responseMaxBytes: 32 * 1024 * 1024, pageMaxBytes: 128 * 1024 * 1024, maxRedirects: 8, maxLinksPerPage: 2000, maxResourcesPerPage: 2000, queryPolicy: 'keep', resourceTypes: { stylesheet: true, script: true, image: true, media: true, font: true, xhr: true, other: true }, screenshotMode: 'viewport', warcEnabled: true, warcCompressionLevel: 1, browserReuse: true, viewportWidth: 1440, viewportHeight: 1000, deviceScaleFactor: 1, initialWaitMs: 250, networkIdleMs: 700, networkIdleMaxMs: 8000, scrollEnabled: true, scrollDelayMs: 100, scrollStepRatio: 0.75, maxScrollContainers: 10, maxScrollStepsPerContainer: 30, imageWaitMs: 4000, preserveShadowDom: true, preserveCanvas: true, preserveFormState: true, freezeResponsiveImages: true, captureSrcsetCandidates: true, maxSrcsetCandidates: 5000, ...profile.patch }; }
async function audit(archiveId) { try { const { stdout, stderr } = await execFileAsync(process.execPath, ['scripts/audit-archive.mjs', archiveId], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); const report = JSON.parse(stdout); return { attempted: true, ok: Boolean(report.ok), pages: report.pages, resources: report.resources, bytes: report.verifiedBytes, missingSrcsetCandidates: report.missingSrcsetCandidates, suspiciousEmptyResponses: report.suspiciousEmptyResponses, warc: report.warc, failureCount: report.failures?.length || 0, reportPath: report.reportPath, stderr: stderr.slice(0, 500) }; } catch (e) { return { attempted: true, ok: false, reason: errText(e) }; } }
async function runOne(target, profile) { const label = `${profile.name}:${target.family}`; state.active = { label, url: safeUrl(target.url), startedAt: new Date().toISOString() }; try { const created = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ url: target.url, options: options(profile, target) }) }); const id = created.job.id; const archiveId = created.job.archiveId; state.submitted += 1; await write({ type: 'submitted', label, target, profile: profile.name, job: { id, archiveId, status: created.job.status } }); let job; let last = ''; const started = Date.now(); while (!stopping) { job = ((await api('/api/jobs')).jobs || []).find((j) => j.id === id); if (!job) { await write({ type: 'job-missing', label, jobId: id }); break; } if (job.status !== last) { last = job.status; await write({ type: 'status-change', label, job: { id, archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, currentUrl: safeUrl(job.currentUrl) } }); } if (terminal.has(job.status) || Date.now() - started > 210000) break; await new Promise((r) => setTimeout(r, 3000)); } if (!job) return; state.completed += 1; state.active = null; await write({ type: 'completed', label, target, profile: profile.name, job: { id: job.id, archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, durationMs: Date.now() - started }, audit: await audit(archiveId) }); } catch (e) { state.active = null; state.lastError = errText(e); await write({ type: 'target-error', label, target, profile: profile.name, error: errText(e) }); } }
async function main() { await fs.mkdir(outDir, { recursive: true }); csrf = (await api('/api/bootstrap')).csrfToken || ''; await write({ type: 'runner-started', targetCount: targets.length, profileCount: profiles.length, safety: { getOnly: true, maxPages: 3, maxBytes: 64 * 1024 * 1024, maxDurationMs: 180000 } }); while (!stopping) { for (; state.index < profiles.length * targets.length && !stopping; state.index += 1) { const p = profiles[Math.floor(state.index / targets.length)]; const t = targets[state.index % targets.length]; await runOne(t, p); } if (stopping) break; state.index = 0; state.cycle += 1; await write({ type: 'cycle-complete', cycle: state.cycle, submitted: state.submitted, completed: state.completed }); } state.status = 'stopped'; await write({ type: 'runner-stopped', cycle: state.cycle, submitted: state.submitted, completed: state.completed }); }
process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
main().catch(async (e) => { state.status = 'failed'; state.lastError = errText(e); await write({ type: 'runner-failed', error: errText(e) }).catch(() => {}); process.exitCode = 1; });
