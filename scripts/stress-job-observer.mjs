import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(import.meta.dirname, '..');
const origin = process.env.WEBCAPTURE_ORIGIN || 'http://127.0.0.1:43193';
const outDir = path.join(root, 'runtime', 'stress');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(outDir, `job-observer-${stamp}.jsonl`);
const statePath = path.join(outDir, 'job-observer-current.json');
const pollMs = 30000;
const staleMs = 180000;
const seen = new Map();
const warned = new Set();
const completed = new Set();
const state = { pid: process.pid, startedAt: new Date().toISOString(), reportPath, status: 'running', polls: 0, activeJobs: 0, staleJobs: 0, terminalJobs: 0, lastError: null };
let stopping = false;

const safeUrl = (value) => { try { const u = new URL(String(value)); return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname || '/'}`.slice(0, 320); } catch { return String(value || '').slice(0, 320); } };
const errorText = (error) => String(error?.message || error || '不明なエラー').replace(/[\r\n]+/g, ' ').slice(0, 500);
const terminal = new Set(['complete', 'complete-with-errors', 'cancelled', 'limit-reached', 'failed']);

async function write(record) {
  await fs.mkdir(outDir, { recursive: true });
  await fs.appendFile(reportPath, `${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`, 'utf8');
  await fs.writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

async function getJobs() {
  const response = await fetch(`${origin}/api/jobs`, { headers: { accept: 'application/json' } });
  const body = await response.json();
  if (!response.ok || body.ok === false) throw new Error(`${response.status} ${body?.error?.message || 'ジョブ一覧の取得に失敗しました。'}`);
  return Array.isArray(body.jobs) ? body.jobs : [];
}

async function snapshot() {
  const observedAt = Date.now();
  let jobs;
  try { jobs = await getJobs(); } catch (error) { state.lastError = errorText(error); await write({ type: 'poll-error', error: state.lastError }); return; }
  state.polls += 1;
  const active = jobs.filter((job) => job.status === 'running' || job.status === 'queued');
  state.activeJobs = active.length;
  let staleJobs = 0;
  for (const job of jobs) {
    if (!job?.id) continue;
    const id = String(job.id);
    if (!seen.has(id)) seen.set(id, observedAt);
    const updatedAt = Date.parse(job.updatedAt || '');
    const stagnantMs = Number.isFinite(updatedAt) ? Math.max(0, observedAt - updatedAt) : null;
    const summary = { id, startUrl: safeUrl(job.startUrl), status: job.status, phase: job.phase, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, currentUrl: safeUrl(job.currentUrl), updatedAt: job.updatedAt || null, stagnantMs };
    if ((job.status === 'running' || job.status === 'queued') && stagnantMs !== null && stagnantMs >= staleMs) {
      staleJobs += 1;
      if (!warned.has(id)) { warned.add(id); await write({ type: 'suspected-hang', thresholdMs: staleMs, job: summary }); }
    }
    if (terminal.has(job.status) && !completed.has(id)) { completed.add(id); await write({ type: 'terminal', job: summary }); }
  }
  state.staleJobs = staleJobs;
  state.terminalJobs = completed.size;
  state.lastError = null;
  await write({ type: 'snapshot', active: active.map((job) => { const updatedAt = Date.parse(job.updatedAt || ''); return { id: job.id, startUrl: safeUrl(job.startUrl), status: job.status, phase: job.phase, pages: job.pages, resources: job.resources, bytes: job.bytes, errors: job.errors, currentUrl: safeUrl(job.currentUrl), updatedAt: job.updatedAt || null, stagnantMs: Number.isFinite(updatedAt) ? Math.max(0, observedAt - updatedAt) : null }; }), activeCount: active.length, staleCount: staleJobs });
}

async function main() {
  await write({ type: 'observer-started', origin, pollMs, staleMs, readOnly: true, actions: 'GET /api/jobs only; no cancel/retry/mutation' });
  while (!stopping) { await snapshot(); if (stopping) break; await new Promise((resolve) => setTimeout(resolve, pollMs)); }
  state.status = 'stopped'; await write({ type: 'observer-stopped' });
}
process.once('SIGINT', () => { stopping = true; });
process.once('SIGTERM', () => { stopping = true; });
main().catch(async (error) => { state.status = 'failed'; state.lastError = errorText(error); await write({ type: 'observer-failed', error: state.lastError }).catch(() => {}); process.exitCode = 1; });
