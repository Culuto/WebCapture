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
const reportPath = path.join(outDir, `exploratory-${stamp}.jsonl`);
const statePath = path.join(outDir, 'exploratory-current.json');
const pidPath = path.join(outDir, 'exploratory.pid.json');

// 公開URLのGETだけを対象にする。ログイン、フォーム送信、購入、決済、投稿、外部操作は実行しない。
const targets = [
  { family: 'social', url: 'https://x.com/', pages: 1 },
  { family: 'social', url: 'https://bsky.app/', pages: 1 },
  { family: 'social', url: 'https://mastodon.social/', pages: 1 },
  { family: 'social', url: 'https://lemmy.world/', pages: 2 },
  { family: 'social', url: 'https://telegram.org/', pages: 2 },
  { family: 'commerce', url: 'https://www.walmart.com/', pages: 1 },
  { family: 'commerce', url: 'https://www.target.com/', pages: 1 },
  { family: 'commerce', url: 'https://www.costco.com/', pages: 1 },
  { family: 'commerce', url: 'https://www.mercari.com/jp/', pages: 2 },
  { family: 'commerce', url: 'https://shop.app/', pages: 1 },
  { family: 'finance', url: 'https://finance.yahoo.com/', pages: 2 },
  { family: 'finance', url: 'https://www.tradingview.com/', pages: 1 },
  { family: 'finance', url: 'https://coinmarketcap.com/', pages: 1 },
  { family: 'finance', url: 'https://www.coingecko.com/', pages: 1 },
  { family: 'travel', url: 'https://www.booking.com/', pages: 1 },
  { family: 'travel', url: 'https://www.tripadvisor.com/', pages: 1 },
  { family: 'travel', url: 'https://www.weather.gov/', pages: 2 },
  { family: 'travel', url: 'https://www.metoffice.gov.uk/', pages: 2 },
  { family: 'education', url: 'https://www.khanacademy.org/', pages: 2 },
  { family: 'education', url: 'https://www.coursera.org/', pages: 1 },
  { family: 'education', url: 'https://www.edx.org/', pages: 1 },
  { family: 'education', url: 'https://ocw.mit.edu/', pages: 2 },
  { family: 'pwa-webapp', url: 'https://app.diagrams.net/', pages: 1 },
  { family: 'pwa-webapp', url: 'https://web.whatsapp.com/', pages: 1 },
  { family: 'pwa-webapp', url: 'https://slack.com/', pages: 1 },
  { family: 'pwa-webapp', url: 'https://app.element.io/', pages: 1 },
  { family: 'webgl', url: 'https://threejs.org/', pages: 2 },
  { family: 'webgl', url: 'https://playground.babylonjs.com/', pages: 1 },
  { family: 'webgl', url: 'https://webglsamples.org/', pages: 1 },
  { family: 'webgl', url: 'https://sketchfab.com/', pages: 1 },
  { family: 'media-protocol', url: 'https://test-streams.mux.dev/', pages: 1 },
  { family: 'media-protocol', url: 'https://dash.akamaized.net/', pages: 1 },
  { family: 'media-protocol', url: 'https://www.bitmovin.com/', pages: 1 },
  { family: 'international', url: 'https://www3.nhk.or.jp/news/', pages: 2 },
  { family: 'international', url: 'https://www.lemonde.fr/', pages: 1 },
  { family: 'international', url: 'https://www.spiegel.de/', pages: 1 },
  { family: 'international', url: 'https://www.bbc.co.uk/', pages: 2 },
  { family: 'http-edge', url: 'https://httpbin.org/gzip', pages: 1 },
  { family: 'http-edge', url: 'https://httpbin.org/image/png', pages: 1 },
  { family: 'http-edge', url: 'https://httpbin.org/redirect/2', pages: 1 },
  { family: 'http-edge', url: 'https://httpstat.us/302', pages: 1 },
  { family: 'static-international', url: 'https://www.example.org/', pages: 1 },
  { family: 'static-international', url: 'https://www.gnu.org/licenses/gpl-3.0.html', pages: 2 },
  { family: 'static-international', url: 'https://www.w3.org/', pages: 2 },
  { family: 'static-international', url: 'https://www.iana.org/domains/example', pages: 2 },
];

const profiles = [
  { name: 'baseline', patch: {} },
  { name: 'deep-structure', patch: { maxPages: 2, discoveryPageLimit: 2, sameSiteMaxDepth: 4, discoveryConcurrency: 4 } },
  { name: 'media-rendered', patch: { screenshotMode: 'full-page', imageWaitMs: 8000, networkIdleMaxMs: 12000, browserReuse: false } },
];
const terminal = new Set(['complete', 'complete-with-errors', 'cancelled', 'limit-reached']);
const state = { pid: process.pid, startedAt: new Date().toISOString(), reportPath, status: 'running', index: 0, cycle: 0, submitted: 0, completed: 0, active: null, statusCounts: {}, familyCounts: {}, lastError: null };
let csrf = '';
let stopping = false;

const safeUrl = (value) => { try { const u = new URL(String(value)); return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname || '/'}`.slice(0, 320); } catch { return String(value || '').slice(0, 320); } };
const errText = (error) => String(error?.message || error || '不明なエラー').replace(/[\r\n]+/g, ' ').slice(0, 1000);
async function write(record) { await fs.mkdir(outDir, { recursive: true }); const row = { timestamp: new Date().toISOString(), ...record }; await fs.appendFile(reportPath, `${JSON.stringify(row)}\n`, 'utf8'); await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8'); process.stdout.write(`${JSON.stringify(row)}\n`); }
async function api(endpoint, init = {}, retry = true) { const headers = { accept: 'application/json', ...(init.headers || {}) }; if (init.method && init.method !== 'GET') { headers['content-type'] ||= 'application/json'; headers['x-webcapture-csrf'] = csrf; } const response = await fetch(`${origin}${endpoint}`, { ...init, headers, redirect: 'error' }); const text = await response.text(); let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { ok: false, error: { message: text.slice(0, 500) } }; } if (response.status === 403 && retry) { const b = await api('/api/bootstrap', {}, false); csrf = b.csrfToken || csrf; return api(endpoint, init, false); } if (!response.ok || body.ok === false) throw new Error(`${response.status} ${body?.error?.code || 'API_ERROR'}: ${body?.error?.message || 'API操作に失敗しました。'}`); return body; }
function options(target, profile) { return { followExternal: false, respectRobots: true, captureRendered: true, discoveryMode: (profile.patch.maxPages || target.pages) > 1 ? 'partial' : 'immediate', discoveryPageLimit: profile.patch.maxPages || target.pages, discoveryConcurrency: 2, maxPages: target.pages, maxBytes: 64 * 1024 * 1024, maxDurationMs: 180000, sameSiteWarningDepth: 30, sameSiteMaxDepth: 2, externalWarningDepth: 5, externalMaxDepth: 0, concurrency: 1, requestTimeoutMs: 30000, responseMaxBytes: 32 * 1024 * 1024, pageMaxBytes: 128 * 1024 * 1024, maxRedirects: 8, maxLinksPerPage: 2000, maxResourcesPerPage: 2000, queryPolicy: 'keep', resourceTypes: { stylesheet: true, script: true, image: true, media: true, font: true, xhr: true, other: true }, screenshotMode: 'viewport', warcEnabled: true, warcCompressionLevel: 1, browserReuse: true, viewportWidth: 1440, viewportHeight: 1000, deviceScaleFactor: 1, initialWaitMs: 250, networkIdleMs: 700, networkIdleMaxMs: 8000, scrollEnabled: true, scrollDelayMs: 100, scrollStepRatio: 0.75, maxScrollContainers: 10, maxScrollStepsPerContainer: 30, imageWaitMs: 4000, preserveShadowDom: true, preserveCanvas: true, preserveFormState: true, freezeResponsiveImages: true, captureSrcsetCandidates: true, maxSrcsetCandidates: 5000, ...profile.patch }; }
async function audit(archiveId) { try { const { stdout } = await execFileAsync(process.execPath, ['scripts/audit-archive.mjs', archiveId], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); const r = JSON.parse(stdout); return { attempted: true, ok: Boolean(r.ok), pages: r.pages, resources: r.resources, uniqueFiles: r.uniqueFiles, verifiedBytes: r.verifiedBytes, missingSrcsetCandidates: r.missingSrcsetCandidates, suspiciousEmptyResponses: r.suspiciousEmptyResponses, warc: r.warc, failureCount: r.failures?.length || 0, failures: (r.failures || []).slice(0, 12), reportPath: r.reportPath }; } catch (error) { return { attempted: true, ok: false, reason: errText(error) }; } }
async function runOne(target, profile) { const label = `${profile.name}:${target.family}`; state.active = { label, url: safeUrl(target.url), startedAt: new Date().toISOString() }; const started = Date.now(); let job; try { const created = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ url: target.url, options: options(target, profile) }) }); const jobId = created.job.id; const archiveId = created.job.archiveId; state.submitted += 1; await write({ type: 'submitted', label, target: { family: target.family, url: safeUrl(target.url), pages: target.pages }, profile: profile.name, job: { id: jobId, archiveId, status: created.job.status } }); let last = ''; while (!stopping) { job = ((await api('/api/jobs')).jobs || []).find((item) => item.id === jobId); if (!job) { await write({ type: 'job-missing', label, jobId }); break; } if (job.status !== last) { last = job.status; await write({ type: 'status-change', label, job: { id: job.id, archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, currentUrl: safeUrl(job.currentUrl), message: String(job.message || '').slice(0, 300) } }); } if (terminal.has(job.status)) break; if (Date.now() - started > 210000) { await write({ type: 'suspected-hang', label, job: { id: job.id, archiveId, status: job.status, pages: job.pages, resources: job.resources, errors: job.errors, currentUrl: safeUrl(job.currentUrl) }, observedMs: Date.now() - started }); break; } await new Promise((resolve) => setTimeout(resolve, 3000)); } if (!job) return; state.completed += 1; state.statusCounts[job.status] = (state.statusCounts[job.status] || 0) + 1; state.familyCounts[target.family] = (state.familyCounts[target.family] || 0) + 1; state.active = null; await write({ type: 'completed', label, target: { family: target.family, url: safeUrl(target.url), pages: target.pages }, profile: profile.name, job: { id: job.id, archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, durationMs: Date.now() - started }, audit: await audit(archiveId) }); } catch (error) { state.lastError = errText(error); state.active = null; await write({ type: 'target-error', label, target: { family: target.family, url: safeUrl(target.url) }, profile: profile.name, error: errText(error) }); } }
async function main() { await fs.mkdir(outDir, { recursive: true }); await fs.writeFile(pidPath, `${JSON.stringify({ pid: process.pid, reportPath, startedAt: state.startedAt, root }, null, 2)}\n`, 'utf8'); csrf = (await api('/api/bootstrap')).csrfToken || ''; await write({ type: 'runner-started', targetCount: targets.length, profileCount: profiles.length, safety: { getOnly: true, followExternal: false, maxPagesPerTarget: 2, maxBytes: 64 * 1024 * 1024, maxDurationMs: 180000 } }); while (!stopping) { for (; state.index < targets.length * profiles.length && !stopping; state.index += 1) { const profile = profiles[Math.floor(state.index / targets.length)]; const target = targets[state.index % targets.length]; await runOne(target, profile); } if (stopping) break; state.index = 0; state.cycle += 1; await write({ type: 'cycle-complete', cycle: state.cycle, submitted: state.submitted, completed: state.completed }); } state.status = 'stopped'; await write({ type: 'runner-stopped', cycle: state.cycle, submitted: state.submitted, completed: state.completed }); }
process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
main().catch(async (error) => { state.status = 'failed'; state.lastError = errText(error); await write({ type: 'runner-failed', error: errText(error) }).catch(() => {}); process.exitCode = 1; });
