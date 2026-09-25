import path from 'node:path';
import { readJsonFile, createSerialWriter, randomId, serviceError } from './json-file.mjs';
import { logEvent, safeUrl } from './logger.mjs';

const TERMINAL = new Set(['complete', 'complete-with-errors', 'cancelled', 'limit-reached', 'failed', 'blocked', 'login-required']);
const STOPPED = new Set(['paused', 'warning', 'discovered']);
export const MAX_BATCH_URLS = 500;

export function parseUrlList(text) {
  const values = String(text || '').split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
  const urls = [];
  const invalid = [];
  const seen = new Set();
  for (const value of values) {
    let parsed;
    try { parsed = new URL(value); } catch { invalid.push(value.slice(0, 200)); continue; }
    if (!['http:', 'https:'].includes(parsed.protocol)) { invalid.push(value.slice(0, 200)); continue; }
    if (seen.has(parsed.href)) continue;
    seen.add(parsed.href);
    urls.push(parsed.href);
  }
  return { urls, invalid };
}

export class BatchQueue {
  constructor({ dataRoot, store, startJob, notifications = null, now = () => new Date(), intervalMs = 3000 }) {
    this.file = path.join(dataRoot, 'batches.json');
    this.write = createSerialWriter(this.file);
    this.store = store;
    this.startJob = startJob;
    this.notifications = notifications;
    this.now = now;
    this.intervalMs = intervalMs;
    this.items = [];
    this.timer = null;
    this.ticking = null;
  }

  async init() {
    const saved = await readJsonFile(this.file, { items: [] });
    this.items = Array.isArray(saved.items) ? saved.items.filter((item) => item?.id && Array.isArray(item.entries)) : [];
    return this;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((error) => logEvent('warn', 'batch', 'tick.failed', { message: error.message })); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }
  save() { return this.write({ items: this.items.slice(-50) }); }

  summary(batch) {
    const count = (status) => batch.entries.filter((entry) => entry.status === status).length;
    return { ...batch, total: batch.entries.length, done: count('done'), failed: count('failed'), pending: count('pending'), running: count('running'), skipped: count('skipped'), paused: count('paused') };
  }

  list() { return this.items.slice().reverse().map((batch) => this.summary(batch)); }

  async create({ text = '', urls = null, options = {} }) {
    const parsed = Array.isArray(urls) ? parseUrlList(urls.join('\n')) : parseUrlList(text);
    if (!parsed.urls.length) throw serviceError('保存できるURLが見つかりませんでした。http:// または https:// で始まるURLを1行に1つずつ入力してください。', 'NO_URLS');
    if (parsed.urls.length > MAX_BATCH_URLS) throw serviceError(`一度に予約できるのは${MAX_BATCH_URLS}件までです。`, 'TOO_MANY_URLS');
    const batch = {
      id: randomId('batch'), status: 'running', createdAt: this.now().toISOString(), finishedAt: null, options,
      entries: parsed.urls.map((url) => ({ url, status: 'pending', jobId: null, archiveId: null, message: '' }))
    };
    this.items.push(batch);
    await this.save();
    logEvent('info', 'batch', 'created', { batchId: batch.id, urls: batch.entries.length, invalid: parsed.invalid.length });
    this.tick().catch(() => {});
    return { batch: this.summary(batch), invalid: parsed.invalid };
  }

  async cancel(id) {
    const batch = this.items.find((item) => item.id === id);
    if (!batch) throw serviceError('まとめて保存の予約が見つかりません。', 'NOT_FOUND', 404);
    for (const entry of batch.entries) if (entry.status === 'pending') { entry.status = 'skipped'; entry.message = '予約を取り消しました。'; }
    if (!batch.entries.some((entry) => entry.status === 'running')) { batch.status = 'cancelled'; batch.finishedAt = this.now().toISOString(); }
    else batch.status = 'cancelling';
    await this.save();
    return this.summary(batch);
  }

  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this.advance().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  async advance() {
    let changed = false;
    for (const batch of this.items) {
      if (!['running', 'cancelling'].includes(batch.status)) continue;
      const running = batch.entries.find((entry) => entry.status === 'running');
      if (running) {
        const job = this.store.getJob(running.jobId);
        if (job && !TERMINAL.has(job.status) && !STOPPED.has(job.status)) continue;
        if (job && STOPPED.has(job.status)) {
          running.status = 'paused';
          running.message = '一時停止したため次へ進みました。保存タブから再開できます。';
        } else {
          running.status = job && ['complete', 'complete-with-errors', 'limit-reached'].includes(job.status) ? 'done' : 'failed';
          running.message = job ? job.message || job.status : '保存記録が見つかりません。';
        }
        changed = true;
      }
      let next = batch.status === 'running' ? batch.entries.find((entry) => entry.status === 'pending') : null;
      while (next) {
        try {
          const job = await this.startJob(next.url, batch.options);
          next.status = 'running';
          next.jobId = job.id;
          next.archiveId = job.archiveId;
          next.message = '';
          logEvent('info', 'batch', 'entry.started', { batchId: batch.id, url: safeUrl(next.url), jobId: job.id });
          break;
        } catch (error) {
          next.status = 'failed';
          next.message = String(error.message || error).slice(0, 300);
          next = batch.entries.find((entry) => entry.status === 'pending');
        }
      }
      changed = true;
      if (!next) {
        batch.status = batch.status === 'cancelling' ? 'cancelled' : 'done';
        batch.finishedAt = this.now().toISOString();
        changed = true;
        const summary = this.summary(batch);
        await this.notifications?.add({ kind: 'batch', title: 'まとめて保存が終わりました', message: `${summary.total}件中 ${summary.done}件を保存しました。失敗 ${summary.failed}件。` });
      }
    }
    if (changed) await this.save();
  }
}
