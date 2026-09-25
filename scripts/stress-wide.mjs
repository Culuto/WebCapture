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
const reportPath = path.join(outDir, `wide-${stamp}.jsonl`);
const statePath = path.join(outDir, 'wide-current.json');

// すべて公開URLのGETだけを対象にする。ログイン、送信、購入、コメント、外部操作は実行しない。
const targets = [
  { family: 'video', url: 'https://www.youtube.com/', pages: 1 },
  { family: 'video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', pages: 1 },
  { family: 'video-live', url: 'https://www.youtube.com/live', pages: 1 },
  { family: 'video-live', url: 'https://www.twitch.tv/', pages: 1 },
  { family: 'video', url: 'https://vimeo.com/', pages: 1 },
  { family: 'video', url: 'https://www.dailymotion.com/', pages: 1 },
  { family: 'video', url: 'https://www.bilibili.com/', pages: 1 },
  { family: 'video', url: 'https://rumble.com/', pages: 1 },
  { family: 'big-search', url: 'https://www.google.com/', pages: 1 },
  { family: 'big-search', url: 'https://www.google.com/search?q=webcapture', pages: 1 },
  { family: 'big-commerce', url: 'https://www.amazon.com/', pages: 1 },
  { family: 'big-commerce', url: 'https://www.amazon.co.jp/', pages: 1 },
  { family: 'big-commerce', url: 'https://www.ebay.com/', pages: 1 },
  { family: 'big-commerce', url: 'https://www.etsy.com/', pages: 1 },
  { family: 'big-commerce', url: 'https://www.rakuten.co.jp/', pages: 1 },
  { family: 'big-platform', url: 'https://drive.google.com/', pages: 1 },
  { family: 'big-platform', url: 'https://docs.google.com/', pages: 1 },
  { family: 'big-platform', url: 'https://www.microsoft.com/', pages: 2 },
  { family: 'big-platform', url: 'https://www.apple.com/', pages: 2 },
  { family: 'big-platform', url: 'https://www.adobe.com/', pages: 2 },
  { family: 'web-archive', url: 'https://web.archive.org/', pages: 2 },
  { family: 'web-archive', url: 'https://archive.org/', pages: 2 },
  { family: 'web-archive', url: 'https://www.loc.gov/', pages: 2 },
  { family: 'web-archive', url: 'https://www.gutenberg.org/', pages: 2 },
  { family: 'web-archive', url: 'https://www.cia.gov/readingroom/', pages: 2 },
  { family: 'link-heavy', url: 'https://www.britannica.com/', pages: 2 },
  { family: 'link-heavy', url: 'https://www.reddit.com/', pages: 2 },
  { family: 'link-heavy', url: 'https://news.ycombinator.com/', pages: 2 },
  { family: 'link-heavy', url: 'https://slashdot.org/', pages: 2 },
  { family: 'link-heavy', url: 'https://www.quora.com/', pages: 2 },
  { family: 'link-heavy', url: 'https://www.instructables.com/', pages: 2 },
  { family: 'developer', url: 'https://github.com/', pages: 2 },
  { family: 'developer', url: 'https://gitlab.com/', pages: 2 },
  { family: 'developer', url: 'https://www.npmjs.com/', pages: 2 },
  { family: 'developer', url: 'https://pypi.org/', pages: 2 },
  { family: 'developer', url: 'https://huggingface.co/', pages: 2 },
  { family: 'developer', url: 'https://stackoverflow.com/', pages: 2 },
  { family: 'interactive', url: 'https://www.figma.com/', pages: 1 },
  { family: 'interactive', url: 'https://www.canva.com/', pages: 1 },
  { family: 'interactive', url: 'https://www.kaggle.com/', pages: 1 },
  { family: 'interactive', url: 'https://colab.research.google.com/', pages: 1 },
  { family: 'personal-static', url: 'https://info.cern.ch/', pages: 2 },
  { family: 'personal-static', url: 'https://www.paulgraham.com/', pages: 2 },
  { family: 'personal-static', url: 'https://motherfuckingwebsite.com/', pages: 1 },
  { family: 'personal-static', url: 'https://bettermotherfuckingwebsite.com/', pages: 1 },
  { family: 'personal-static', url: 'https://www.berkshirehathaway.com/', pages: 2 },
  { family: 'personal-static', url: 'https://neocities.org/', pages: 1 },
  { family: 'personal-static', url: 'https://www.kottke.org/', pages: 2 },
  { family: 'data-stream', url: 'https://httpbin.org/stream/10', pages: 1 },
  { family: 'data-stream', url: 'https://httpbin.org/bytes/1048576', pages: 1 },
  { family: 'data-stream', url: 'https://jsonplaceholder.typicode.com/', pages: 1 },
  { family: 'data-stream', url: 'https://api.github.com/', pages: 1 },
  { family: 'docs', url: 'https://developer.apple.com/', pages: 2 },
  { family: 'docs', url: 'https://developer.chrome.com/', pages: 2 },
  { family: 'docs', url: 'https://docs.python.org/3/', pages: 2 },
  { family: 'docs', url: 'https://www.rfc-editor.org/', pages: 2 },
  { family: 'news', url: 'https://www.nytimes.com/', pages: 1 },
  { family: 'news', url: 'https://www.theguardian.com/', pages: 2 },
  { family: 'news', url: 'https://www.cnn.com/', pages: 1 },
  { family: 'news', url: 'https://www3.nhk.or.jp/', pages: 2 }
];

const profiles = [
  { name: 'baseline', patch: {} },
  { name: 'deep-links', patch: { maxPages: 2, discoveryPageLimit: 2, sameSiteMaxDepth: 4, discoveryConcurrency: 4 } },
  { name: 'media-heavy', patch: { screenshotMode: 'full-page', imageWaitMs: 8000, networkIdleMaxMs: 12000, browserReuse: false } },
  { name: 'warc-uncompressed', patch: { warcCompressionLevel: 0 } }
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
async function audit(archiveId) { try { const { stdout } = await execFileAsync(process.execPath, ['scripts/audit-archive.mjs', archiveId], { cwd: root, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); const r = JSON.parse(stdout); return { attempted: true, ok: Boolean(r.ok), pages: r.pages, resources: r.resources, uniqueFiles: r.uniqueFiles, verifiedBytes: r.verifiedBytes, missingSrcsetCandidates: r.missingSrcsetCandidates, suspiciousEmptyResponses: r.suspiciousEmptyResponses, warc: r.warc, failureCount: r.failures?.length || 0, failures: (r.failures || []).slice(0, 12), reportPath: r.reportPath }; } catch (e) { return { attempted: true, ok: false, reason: errText(e) }; } }
async function runOne(target, profile) { const label = `${profile.name}:${target.family}`; state.active = { label, url: safeUrl(target.url), startedAt: new Date().toISOString() }; let job; const started = Date.now(); try { const created = await api('/api/jobs', { method: 'POST', body: JSON.stringify({ url: target.url, options: options(target, profile) }) }); const id = created.job.id; const archiveId = created.job.archiveId; state.submitted += 1; await write({ type: 'submitted', label, family: target.family, profile: profile.name, target: { url: safeUrl(target.url), pages: target.pages }, job: { id, archiveId, status: created.job.status } }); let last = ''; while (!stopping) { job = ((await api('/api/jobs')).jobs || []).find((item) => item.id === id); if (!job) { await write({ type: 'job-missing', label, jobId: id }); break; } if (job.status !== last) { last = job.status; await write({ type: 'status-change', label, job: { id, archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, currentUrl: safeUrl(job.currentUrl), message: String(job.message || '').slice(0, 250) } }); } if (terminal.has(job.status)) break; if (Date.now() - started > 210000) { await write({ type: 'suspected-hang', label, job: { id, archiveId, status: job.status }, observedMs: Date.now() - started }); break; } await new Promise((resolve) => setTimeout(resolve, 3000)); } if (!job) return; state.completed += 1; state.statusCounts[job.status] = (state.statusCounts[job.status] || 0) + 1; state.familyCounts[target.family] = (state.familyCounts[target.family] || 0) + 1; state.active = null; await write({ type: 'completed', label, family: target.family, profile: profile.name, target: { url: safeUrl(target.url), pages: target.pages }, job: { id: job.id, archiveId: job.archiveId, status: job.status, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, durationMs: Date.now() - started }, audit: await audit(job.archiveId) }); } catch (e) { state.active = null; state.lastError = errText(e); await write({ type: 'target-error', label, family: target.family, profile: profile.name, target: { url: safeUrl(target.url) }, error: errText(e) }); } }
async function main() { await fs.mkdir(outDir, { recursive: true }); await fs.writeFile(path.join(outDir, 'wide.pid.json'), `${JSON.stringify({ pid: process.pid, reportPath, startedAt: state.startedAt }, null, 2)}\n`, 'utf8'); csrf = (await api('/api/bootstrap')).csrfToken || ''; await write({ type: 'runner-started', targetCount: targets.length, profileCount: profiles.length, safety: { getOnly: true, followExternal: false, respectRobots: true, maxBytes: 64 * 1024 * 1024, maxDurationMs: 180000 } }); while (!stopping) { for (; state.index < targets.length * profiles.length && !stopping; state.index += 1) { const profile = profiles[Math.floor(state.index / targets.length)]; const target = targets[state.index % targets.length]; await runOne(target, profile); } if (stopping) break; state.index = 0; state.cycle += 1; await write({ type: 'cycle-complete', cycle: state.cycle, submitted: state.submitted, completed: state.completed }); } state.status = 'stopped'; await write({ type: 'runner-stopped', cycle: state.cycle, submitted: state.submitted, completed: state.completed }); }
process.once('SIGINT', () => { stopping = true; }); process.once('SIGTERM', () => { stopping = true; });
main().catch(async (e) => { state.status = 'failed'; state.lastError = errText(e); await write({ type: 'runner-failed', error: errText(e) }).catch(() => {}); process.exitCode = 1; });
