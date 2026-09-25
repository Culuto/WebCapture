import path from 'node:path';
import { readJsonFile, createSerialWriter, randomId, serviceError } from './json-file.mjs';
import { logEvent } from './logger.mjs';

export const SCHEDULE_FREQUENCIES = Object.freeze(['hourly', 'daily', 'weekly']);
const ACTIVE = new Set(['queued', 'running', 'discovering', 'pausing', 'paused', 'warning', 'discovered']);
const RETRY_BUSY_MS = 10 * 60 * 1000;

function clampInteger(value, min, max, fallback) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

export function normalizeSchedule(input = {}) {
  const frequency = SCHEDULE_FREQUENCIES.includes(input.frequency) ? input.frequency : null;
  if (!frequency) throw serviceError('繰り返しの間隔は「毎時」「毎日」「毎週」から選んでください。', 'INVALID_SCHEDULE');
  return {
    frequency,
    hour: clampInteger(input.hour, 0, 23, 3),
    minute: clampInteger(input.minute, 0, 59, 0),
    weekday: clampInteger(input.weekday, 0, 6, 0),
    enabled: input.enabled !== false
  };
}

export function nextRunAt(schedule, from = new Date()) {
  const base = new Date(from.getTime());
  base.setSeconds(0, 0);
  const candidate = new Date(base.getTime());
  if (schedule.frequency === 'hourly') {
    candidate.setMinutes(schedule.minute);
    if (candidate <= from) candidate.setHours(candidate.getHours() + 1);
    return candidate;
  }
  candidate.setHours(schedule.hour, schedule.minute, 0, 0);
  if (schedule.frequency === 'daily') {
    if (candidate <= from) candidate.setDate(candidate.getDate() + 1);
    return candidate;
  }
  let days = (schedule.weekday - candidate.getDay() + 7) % 7;
  if (days === 0 && candidate <= from) days = 7;
  candidate.setDate(candidate.getDate() + days);
  return candidate;
}

export function describeDiff(diff) {
  if (!diff) return '前回との比較はできませんでした。';
  const added = diff.added?.length || 0;
  const changed = diff.changed?.length || 0;
  const removed = diff.removed?.length || 0;
  if (!added && !changed && !removed) return '前回から変わったページはありません。';
  return `前回から 追加${added}ページ・変更${changed}ページ・削除${removed}ページ。`;
}

export class ScheduleService {
  constructor({ dataRoot, store, crawler, notifications = null, diff = null, now = () => new Date(), intervalMs = 30000 }) {
    this.file = path.join(dataRoot, 'schedules.json');
    this.write = createSerialWriter(this.file);
    this.store = store;
    this.crawler = crawler;
    this.notifications = notifications;
    this.diff = diff;
    this.now = now;
    this.intervalMs = intervalMs;
    this.items = [];
    this.timer = null;
    this.ticking = null;
  }

  async init() {
    const saved = await readJsonFile(this.file, { items: [] });
    this.items = Array.isArray(saved.items) ? saved.items.filter((item) => item?.id && SCHEDULE_FREQUENCIES.includes(item.frequency)) : [];
    return this;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.tick().catch((error) => logEvent('warn', 'schedule', 'tick.failed', { message: error.message })); }, this.intervalMs);
    this.timer.unref?.();
    setTimeout(() => { this.tick().catch(() => {}); }, 3000).unref?.();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }

  save() { return this.write({ items: this.items }); }
  list() { return this.items.map((item) => ({ ...item })); }
  forArchive(archiveId) { return this.items.find((item) => item.archiveId === archiveId) || null; }

  async upsert(archiveId, input) {
    const archive = this.store.getArchive(archiveId);
    if (!archive) throw serviceError('保存済みサイトが見つかりません。', 'NOT_FOUND', 404);
    const settings = normalizeSchedule(input);
    let item = this.forArchive(archiveId);
    if (!item) {
      item = { id: randomId('schedule'), archiveId, startUrl: archive.startUrl, title: archive.title || '', createdAt: this.now().toISOString(), lastRunAt: null, lastJobId: null, lastResult: null };
      this.items.push(item);
    }
    Object.assign(item, settings, { nextRunAt: settings.enabled ? nextRunAt(settings, this.now()).toISOString() : null, updatedAt: this.now().toISOString() });
    await this.save();
    logEvent('info', 'schedule', 'saved', { scheduleId: item.id, archiveId, frequency: item.frequency, enabled: item.enabled });
    return { ...item };
  }

  async remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.id !== id);
    if (before === this.items.length) throw serviceError('定期保存の予定が見つかりません。', 'NOT_FOUND', 404);
    await this.save();
    return true;
  }

  jobActive(jobId) {
    const job = jobId ? this.store.getJob(jobId) : null;
    return Boolean(job && ACTIVE.has(job.status));
  }

  tick() {
    if (this.ticking) return this.ticking;
    this.ticking = this.runDue().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  async runDue() {
    const now = this.now();
    let changed = false;
    for (const item of this.items) {
      if (!item.enabled || !item.nextRunAt || new Date(item.nextRunAt) > now) continue;
      changed = true;
      if (!this.store.getArchive(item.archiveId)) {
        item.enabled = false;
        item.nextRunAt = null;
        item.lastResult = { status: 'failed', message: '元のアーカイブが削除されたため、定期保存を止めました。', at: now.toISOString() };
        continue;
      }
      if (this.jobActive(item.lastJobId) || this.crawler.archiveBusy(item.archiveId)) {
        item.nextRunAt = new Date(now.getTime() + RETRY_BUSY_MS).toISOString();
        item.lastResult = { status: 'waiting', message: '前回の保存がまだ終わっていないため、少し後に実行します。', at: now.toISOString() };
        continue;
      }
      try {
        const job = await this.crawler.resaveArchive(item.archiveId);
        item.lastJobId = job.id;
        item.lastRunAt = now.toISOString();
        item.lastResult = { status: 'running', message: '定期保存を開始しました。', at: now.toISOString() };
        await this.store.updateJob(job.id, { scheduleId: item.id, message: '定期保存を開始待ち' });
        logEvent('info', 'schedule', 'run.started', { scheduleId: item.id, archiveId: item.archiveId, jobId: job.id });
      } catch (error) {
        item.lastResult = { status: 'failed', message: error.message, at: now.toISOString() };
        logEvent('warn', 'schedule', 'run.failed', { scheduleId: item.id, archiveId: item.archiveId, message: error.message });
      }
      item.nextRunAt = nextRunAt(item, now).toISOString();
    }
    if (changed) await this.save();
  }

  async handleJobFinished(result) {
    const item = this.items.find((entry) => entry.lastJobId === result.jobId);
    if (!item) return null;
    const previousArchiveId = item.archiveId;
    let diff = null;
    if (result.pages > 0 && result.archiveId !== previousArchiveId) {
      item.archiveId = result.archiveId;
      item.title = result.title || item.title;
      try { diff = this.diff ? await this.diff(result.archiveId, previousArchiveId) : null; } catch {}
    }
    const summary = describeDiff(diff);
    item.lastResult = { status: result.status, message: summary, at: this.now().toISOString(), archiveId: result.archiveId, previousArchiveId };
    await this.save();
    let host = result.startUrl;
    try { host = new URL(result.startUrl).hostname; } catch {}
    await this.notifications?.add({ kind: 'schedule', title: `定期保存が終わりました（${host}）`, message: summary, archiveId: result.archiveId, action: 'diff' });
    return item;
  }
}
