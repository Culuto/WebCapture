import fs from 'node:fs/promises';
import path from 'node:path';
import { readJsonFile, createSerialWriter, randomId, serviceError } from './json-file.mjs';
import { resourceCategory } from './storage-summary.mjs';
import { logEvent } from './logger.mjs';

const GiB = 1024 ** 3;
const NOTIFY_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PLAN_REUSE_MS = 30 * 60 * 1000;
const SEGMENT = /\.(?:ts|m4s|mp2t)$/i;

export async function diskUsage(root) {
  const seen = new Set();
  let bytes = 0;
  const walk = async (directory) => {
    let entries = [];
    try { entries = await fs.readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) { await walk(target); continue; }
      try {
        const stat = await fs.stat(target);
        const key = `${stat.dev}:${stat.ino}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bytes += stat.size;
      } catch {}
    }
  };
  await walk(root);
  return bytes;
}

export function normalizeCleanupSettings(input = {}, current = {}) {
  const limitGb = input.limitGb === undefined ? current.limitGb ?? 100 : Number(input.limitGb);
  if (!Number.isFinite(limitGb) || limitGb < 1 || limitGb > 100000) throw serviceError('容量の上限は1GB以上で指定してください。', 'INVALID_LIMIT');
  return {
    enabled: input.enabled === undefined ? current.enabled === true : input.enabled === true,
    limitGb: Math.round(limitGb * 10) / 10,
    includeWarc: input.includeWarc === undefined ? current.includeWarc === true : input.includeWarc === true
  };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

function mediaResources(manifest) {
  return Object.values(manifest?.resources || {}).filter((resource) => resource?.file && resourceCategory(resource) === 'media');
}

function referencedFiles(manifest) {
  const files = new Set();
  for (const resource of Object.values(manifest.resources || {})) if (resource?.file) files.add(resource.file);
  for (const list of Object.values(manifest.resourceVariants || {})) for (const variant of list || []) if (variant?.file) files.add(variant.file);
  for (const item of Object.values(manifest.postResponses || {})) { if (item?.file) files.add(item.file); if (item?.requestFile) files.add(item.requestFile); }
  for (const page of manifest.pages || []) { if (page.html) files.add(page.html); if (page.mobile?.html) files.add(page.mobile.html); }
  return files;
}

export function deferredEntriesFor(resources, recordedAt) {
  const entries = [];
  const streams = new Map();
  for (const resource of resources) {
    if (SEGMENT.test(new URL(resource.url).pathname)) {
      const url = new URL(resource.url);
      const key = `${url.origin}${url.pathname.replace(/[^/]*$/, '')}`;
      const stream = streams.get(key) || { url: resource.url, kind: 'stream', remainingUrls: [], savedBytes: 0, limitBytes: null, recordedAt, reason: '容量の整理で削除しました。', pruned: true };
      stream.remainingUrls.push(resource.url);
      streams.set(key, stream);
    } else {
      entries.push({ url: resource.url, kind: 'file', expectedBytes: resource.size ?? null, recordedAt, reason: '容量の整理で削除しました。', pruned: true });
    }
  }
  return [...entries, ...streams.values()];
}

export class StorageCleanupService {
  constructor({ dataRoot, store, isBusy = () => false, notifications = null, now = () => new Date(), intervalMs = 60 * 60 * 1000 }) {
    this.dataRoot = dataRoot;
    this.file = path.join(dataRoot, 'cleanup.json');
    this.write = createSerialWriter(this.file);
    this.store = store;
    this.isBusy = isBusy;
    this.notifications = notifications;
    this.now = now;
    this.intervalMs = intervalMs;
    this.settings = { enabled: false, limitGb: 100, includeWarc: false };
    this.plan = null;
    this.lastNotifiedAt = null;
    this.running = false;
    this.timer = null;
  }

  async init() {
    const saved = await readJsonFile(this.file, {});
    try { this.settings = normalizeCleanupSettings(saved.settings || {}, {}); } catch {}
    this.lastNotifiedAt = saved.lastNotifiedAt || null;
    return this;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.check().catch((error) => logEvent('warn', 'cleanup', 'check.failed', { message: error.message })); }, this.intervalMs);
    this.timer.unref?.();
  }

  stop() { clearInterval(this.timer); this.timer = null; }
  save() { return this.write({ settings: this.settings, lastNotifiedAt: this.lastNotifiedAt }); }

  async updateSettings(input) {
    this.settings = normalizeCleanupSettings(input, this.settings);
    this.plan = null;
    await this.save();
    return this.settings;
  }

  async usage() {
    return diskUsage(path.join(this.dataRoot, 'archives'));
  }

  async status() {
    const usedBytes = await this.usage();
    return { settings: this.settings, usedBytes, limitBytes: this.settings.limitGb * GiB, overLimit: usedBytes > this.settings.limitGb * GiB, plan: this.plan, running: this.running };
  }

  async buildPlan() {
    const usedBytes = await this.usage();
    const limitBytes = this.settings.limitGb * GiB;
    const newestByHost = new Map();
    for (const archive of this.store.listArchives()) {
      const host = hostOf(archive.startUrl);
      if (host && !newestByHost.has(host)) newestByHost.set(host, archive.id);
    }
    const candidates = this.store.listArchives().slice().reverse()
      .filter((archive) => newestByHost.get(hostOf(archive.startUrl)) !== archive.id && !this.isBusy(archive.id));
    const items = [];
    let freeable = 0;
    for (const archive of candidates) {
      if (usedBytes - freeable <= limitBytes) break;
      const manifest = await this.store.readManifest(archive.id).catch(() => null);
      if (!manifest) continue;
      const root = this.store.archiveRoot(archive.id);
      let mediaBytes = 0;
      let mediaCount = 0;
      const seenFiles = new Set();
      for (const resource of mediaResources(manifest)) {
        if (seenFiles.has(resource.file)) continue;
        seenFiles.add(resource.file);
        try {
          const stat = await fs.stat(path.join(root, resource.file));
          mediaCount += 1;
          if (stat.nlink === 1) mediaBytes += stat.size;
        } catch {}
      }
      let warcBytes = 0;
      if (this.settings.includeWarc) { try { warcBytes = (await fs.stat(path.join(root, 'collection.warc.gz'))).size; } catch {} }
      if (!mediaCount && !warcBytes) continue;
      items.push({ archiveId: archive.id, title: archive.title || archive.startUrl, startUrl: archive.startUrl, savedAt: archive.savedAt, mediaCount, mediaBytes, warcBytes });
      freeable += mediaBytes + warcBytes;
    }
    this.plan = { id: randomId('cleanup'), createdAt: this.now().toISOString(), usedBytes, limitBytes, freeableBytes: freeable, includeWarc: this.settings.includeWarc, items };
    return this.plan;
  }

  async check() {
    if (!this.settings.enabled || this.running) return null;
    const usedBytes = await this.usage();
    if (usedBytes <= this.settings.limitGb * GiB) return null;
    const recent = this.plan && this.now().getTime() - new Date(this.plan.createdAt).getTime() < PLAN_REUSE_MS;
    const plan = recent ? this.plan : await this.buildPlan();
    const last = this.lastNotifiedAt ? new Date(this.lastNotifiedAt).getTime() : 0;
    if (plan.items.length && this.now().getTime() - last >= NOTIFY_INTERVAL_MS) {
      this.lastNotifiedAt = this.now().toISOString();
      await this.save();
      await this.notifications?.add({ kind: 'cleanup', title: '保存容量が上限を超えました', message: `${plan.items.length}件のアーカイブの整理案を作りました。設定タブの「容量の自動整理」で内容を確認して実行してください。`, action: 'cleanup' });
    }
    return plan;
  }

  async execute(planId, archiveIds = null) {
    if (!this.plan || this.plan.id !== planId) throw serviceError('整理案が古くなっています。もう一度整理案を作ってください。', 'PLAN_EXPIRED', 409);
    if (this.running) throw serviceError('整理を実行中です。', 'CLEANUP_RUNNING', 409);
    const wanted = Array.isArray(archiveIds) ? new Set(archiveIds) : null;
    const targets = this.plan.items.filter((item) => !wanted || wanted.has(item.archiveId));
    this.running = true;
    const results = [];
    try {
      for (const item of targets) {
        try { results.push({ archiveId: item.archiveId, ...await this.pruneArchive(item.archiveId, { includeWarc: this.plan.includeWarc }) }); }
        catch (error) { results.push({ archiveId: item.archiveId, error: error.message }); }
      }
    } finally {
      this.running = false;
      this.plan = null;
    }
    logEvent('info', 'cleanup', 'executed', { archives: results.length, freedBytes: results.reduce((sum, item) => sum + (item.freedBytes || 0), 0) });
    return { results, freedBytes: results.reduce((sum, item) => sum + (item.freedBytes || 0), 0) };
  }

  async pruneArchive(archiveId, { includeWarc = false } = {}) {
    if (this.isBusy(archiveId)) throw serviceError('保存中のアーカイブは整理できません。', 'ARCHIVE_BUSY', 409);
    this.store.assertArchiveWritable(archiveId);
    const manifest = structuredClone(await this.store.readManifest(archiveId));
    if (!manifest) throw serviceError('保存済みサイトが見つかりません。', 'NOT_FOUND', 404);
    const root = this.store.archiveRoot(archiveId);
    const media = mediaResources(manifest);
    const recordedAt = this.now().toISOString();
    for (const resource of media) delete manifest.resources[resource.url];
    const existing = new Set((manifest.deferredMedia || []).map((item) => item.url));
    manifest.deferredMedia = [...(manifest.deferredMedia || []), ...deferredEntriesFor(media, recordedAt).filter((item) => !existing.has(item.url))];
    manifest.prunedMedia = { at: recordedAt, count: media.length };
    const keep = referencedFiles(manifest);
    await this.store.writeManifest(archiveId, manifest);
    let freedBytes = 0;
    const removed = new Set();
    for (const resource of media) {
      if (keep.has(resource.file) || removed.has(resource.file)) continue;
      removed.add(resource.file);
      const file = path.join(root, resource.file);
      try {
        const stat = await fs.stat(file);
        await fs.rm(file, { force: true });
        if (stat.nlink === 1) freedBytes += stat.size;
      } catch {}
    }
    let warcRemoved = false;
    if (includeWarc) {
      const warc = path.join(root, 'collection.warc.gz');
      try { const stat = await fs.stat(warc); await fs.rm(warc, { force: true }); freedBytes += stat.size; warcRemoved = true; } catch {}
    }
    const archive = this.store.getArchive(archiveId);
    if (archive) {
      await this.store.addArchive({
        ...archive, bytes: Math.max(0, Number(archive.bytes || 0) - freedBytes), resources: Object.keys(manifest.resources).length,
        prunedAt: recordedAt, prunedMediaCount: media.length, ...(warcRemoved ? { warcRemoved: true } : {})
      });
    }
    logEvent('info', 'cleanup', 'archive.pruned', { archiveId, mediaCount: media.length, freedBytes, warcRemoved });
    return { mediaCount: media.length, freedBytes, warcRemoved };
  }
}
