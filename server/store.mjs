import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { logEvent } from './logger.mjs';
import { qualityFromLegacyTitle } from './quality.mjs';
import { recoverArchiveRepairs, captureJobState } from './repair-transaction.mjs';
import { fileDigest, peerArchivesFor } from './blob-dedupe.mjs';

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const TERMINAL_STATUSES = new Set(['complete', 'complete-with-errors', 'cancelled', 'limit-reached', 'failed', 'blocked', 'login-required']);
const PRESERVED_ARCHIVE_FIELDS = Object.freeze(['tags', 'folder', 'note', 'prunedAt', 'prunedMediaCount', 'warcRemoved']);
const ACTIVE_STATUSES = new Set(['queued', 'running', 'discovering', 'pausing', 'paused', 'warning', 'discovered']);

export function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`;
}

async function atomicBuffer(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(3).toString('hex')}.tmp`;
  const handle = await fs.open(temp, 'wx');
  try {
    await handle.writeFile(value);
    await handle.sync();
    await handle.close();
    await fs.rename(temp, file);
  } finally {
    await handle.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

async function atomicJson(file, value) {
  await atomicBuffer(file, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function recordName(id) {
  const value = String(id || '');
  if (!/^[a-z0-9_.-]+$/i.test(value)) throw new Error('保存IDが正しくありません。');
  return `${value}.json`;
}

function mergeReplayMissReport(report, batch) {
  const output = {
    schemaVersion: Number(report?.schemaVersion || 1),
    ...report,
    items: (Array.isArray(report?.items) ? report.items : []).map((item) => ({ ...item }))
  };
  const byUrl = new Map(output.items.map((item) => [item.url, item]));
  for (const [url, pending] of batch || []) {
    output.total = Number(output.total || 0) + Number(pending.count || 0);
    output.updatedAt = !output.updatedAt || pending.lastSeenAt > output.updatedAt ? pending.lastSeenAt : output.updatedAt;
    const existing = byUrl.get(url);
    if (existing) {
      existing.count = Number(existing.count || 0) + Number(pending.count || 0);
      existing.firstSeenAt = !existing.firstSeenAt || pending.firstSeenAt < existing.firstSeenAt ? pending.firstSeenAt : existing.firstSeenAt;
      existing.lastSeenAt = !existing.lastSeenAt || pending.lastSeenAt > existing.lastSeenAt ? pending.lastSeenAt : existing.lastSeenAt;
    } else if (output.items.length < 2000) {
      const item = { url, count: pending.count, firstSeenAt: pending.firstSeenAt, lastSeenAt: pending.lastSeenAt };
      output.items.push(item);
      byUrl.set(url, item);
    }
  }
  output.unique = output.items.length;
  return output;
}

async function mapLimit(items, concurrency, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function loadRecords(root) {
  let names = [];
  try { names = (await fs.readdir(root)).filter((name) => name.endsWith('.json')).sort(); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const records = new Array(names.length);
  await mapLimit(names, 32, async (name, index) => { records[index] = await readJson(path.join(root, name), null); });
  return records.filter(Boolean);
}

function terminalQueuePayload(job) {
  const queue = Array.isArray(job.queue) ? job.queue : [];
  const inFlight = Array.isArray(job.inFlight) ? job.inFlight : [];
  const plannedQueue = Array.isArray(job.plannedQueue) ? job.plannedQueue : [];
  const discoveryVisited = Array.isArray(job.discoveryVisited) ? job.discoveryVisited : [];
  if (!queue.length && !inFlight.length && !plannedQueue.length && !discoveryVisited.length) return null;
  return { schemaVersion: 1, jobId: job.id, archivedAt: new Date().toISOString(), queue, inFlight, plannedQueue, discoveryVisited };
}

function compactTerminalJob(job, queueFile = null) {
  const payload = terminalQueuePayload(job);
  if (!payload) {
    if (!job.terminalQueue) { job.queueCount = 0; job.inFlightCount = 0; job.plannedQueueCount = 0; delete job.queueSample; }
    return null;
  }
  job.queueCount = payload.queue.length;
  job.inFlightCount = payload.inFlight.length;
  job.plannedQueueCount = payload.plannedQueue.length;
  job.discoveryVisitedCount = payload.discoveryVisited.length;
  job.queueSample = payload.queue.slice(0, 40);
  job.terminalQueue = { file: queueFile || `${job.id}.json.gz`, format: 'json+gzip', lossless: true };
  job.queue = [];
  job.inFlight = [];
  job.plannedQueue = [];
  job.discoveryVisited = [];
  return payload;
}

function normalizeArchiveStatus(archive) {
  if (archive?.quality) return false;
  const quality = qualityFromLegacyTitle(archive?.title || '', archive?.startUrl || '');
  if (!quality) return false;
  archive.quality = { ...quality, checkedAt: new Date().toISOString(), source: 'legacy-title' };
  if (archive.status === 'complete') {
    archive.status = quality.classification === 'login-required' ? 'login-required'
      : quality.classification === 'access-challenge' ? 'blocked' : 'failed';
  }
  archive.partial = true;
  return true;
}

export class VaultStore {
  constructor(dataRoot) {
    this.dataRoot = dataRoot;
    this.stateFile = path.join(dataRoot, 'state.json');
    this.recordRoot = path.join(dataRoot, 'state-v2');
    this.jobsRoot = path.join(this.recordRoot, 'jobs');
    this.archivesRoot = path.join(this.recordRoot, 'archives');
    this.terminalQueuesRoot = path.join(this.recordRoot, 'terminal-queues');
    this.metaFile = path.join(this.recordRoot, 'meta.json');
    this.state = { schemaVersion: 2, jobs: [], archives: [] };
    this.meta = { schemaVersion: 2, stateRevision: 0, archiveRevision: 0, createdAt: new Date().toISOString() };
    this.writeQueue = Promise.resolve();
    this.mutationQueue = Promise.resolve();
    this.trashCleanupQueue = Promise.resolve();
    this.manifestCache = new Map();
    this.repairRecoveryFailures = new Map();
    this.captureBatches = new Map();
    this.verifiedBlobs = new Map();
    this.replayMissSuppressed = new Set();
    this.pendingReplayMisses = new Map();
    this.replayMissFlushTimers = new Map();
    this.blobSharing = true;
    this.maintenanceLocks = new Set();
    this.blobPeerCache = new Map();
  }

  blobPeers(id) {
    if (!this.blobSharing) return [];
    const cached = this.blobPeerCache.get(id);
    if (cached && Date.now() - cached.at < 60000) return cached.peers;
    const peers = peerArchivesFor(this, id);
    this.blobPeerCache.set(id, { at: Date.now(), peers });
    while (this.blobPeerCache.size > 64) this.blobPeerCache.delete(this.blobPeerCache.keys().next().value);
    return peers;
  }

  async linkPeerBlob(id, digest, size, file) {
    for (const peer of this.blobPeers(id)) {
      const peerFile = path.join(this.archiveRoot(peer), 'blobs', digest.slice(0, 2), digest);
      try {
        const stat = await fs.stat(peerFile);
        if (stat.size !== size || await fileDigest(peerFile) !== digest) continue;
        await fs.link(peerFile, file);
        return true;
      } catch (error) {
        if (error.code === 'EEXIST') return true;
      }
    }
    return false;
  }

  async init() {
    await fs.mkdir(path.join(this.dataRoot, 'archives'), { recursive: true });
    const trashRoot = path.join(this.dataRoot, '.trash');
    await fs.mkdir(trashRoot, { recursive: true });
    this.trashCleanupQueue = fs.readdir(trashRoot).then((names) => Promise.allSettled(names.map((name) => fs.rm(path.join(trashRoot, name), { recursive: true, force: true })))).catch((error) => {
      logEvent('warn', 'archive', 'trash.cleanup.failed', { code: error.code });
    });

    const segmentedMeta = await readJson(this.metaFile, null);
    if (segmentedMeta?.schemaVersion === 2) {
      this.meta = { ...this.meta, ...segmentedMeta };
      this.state = { schemaVersion: 2, jobs: await loadRecords(this.jobsRoot), archives: await loadRecords(this.archivesRoot) };
    } else {
      const legacy = await readJson(this.stateFile, { schemaVersion: 1, jobs: [], archives: [] });
      this.state = {
        schemaVersion: 2,
        jobs: Array.isArray(legacy.jobs) ? legacy.jobs : [],
        archives: Array.isArray(legacy.archives) ? legacy.archives : []
      };
      await this.normalizeRecoveredState();
      await this.migrateLegacyState();
      logEvent('info', 'store', 'state.migrated', { jobs: this.state.jobs.length, archives: this.state.archives.length, legacyPreserved: true });
      await recoverArchiveRepairs(this);
      return this;
    }

    await recoverArchiveRepairs(this);
    const changed = await this.normalizeRecoveredState();
    for (const id of changed.jobs) await this.compactTerminalJob(this.getJob(id));
    if (changed.jobs.size || changed.archives.size) await this.writeChangedRecords(changed.jobs, changed.archives);
    return this;
  }

  async normalizeRecoveredState() {
    const changedJobs = new Set();
    const changedArchives = new Set();
    for (const job of this.state.jobs) {
      const recovered = [...(Array.isArray(job.inFlight) ? job.inFlight : []), ...(Array.isArray(job.queue) ? job.queue : [])];
      const seen = new Set();
      job.queue = recovered.filter((item) => {
        const key = String(item?.url || '');
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      job.inFlight = [];
      if (['running', 'pausing', 'queued', 'discovering'].includes(job.status)) {
        job.status = 'paused';
        job.message = 'アプリ終了後の処理です。内容を確認してから再開してください。';
        job.updatedAt = new Date().toISOString();
        changedJobs.add(job.id);
      }
      if (['complete', 'complete-with-errors'].includes(job.status) && Number(job.pages || 0) === 0) {
        job.status = 'failed';
        job.phase = 'complete';
        job.message = '保存できたページがありません。エラー内容を確認してください。';
        job.updatedAt = new Date().toISOString();
        changedJobs.add(job.id);
      }
      if (TERMINAL_STATUSES.has(job.status) && !job.terminalQueue && terminalQueuePayload(job)) changedJobs.add(job.id);
      if (TERMINAL_STATUSES.has(job.status) && !this.getArchive(job.archiveId)) {
        const manifest = await this.readManifest(job.archiveId);
        if (manifest) {
          const archive = {
            id: job.archiveId,
            startUrl: job.startUrl,
            title: manifest.pages?.[0]?.title || new URL(job.startUrl).hostname,
            status: job.status,
            pages: job.pages,
            resources: job.resources,
            bytes: job.bytes,
            errors: job.errors,
            savedAt: job.updatedAt || job.createdAt,
            engine: manifest.engine || 'HTTP',
            partial: ['cancelled', 'limit-reached', 'failed', 'blocked', 'login-required'].includes(job.status),
            quality: manifest.quality || null
          };
          this.state.archives.push(archive);
          changedArchives.add(archive.id);
        }
      }
    }
    for (const archive of this.state.archives) if (normalizeArchiveStatus(archive)) changedArchives.add(archive.id);
    return { jobs: changedJobs, archives: changedArchives };
  }

  async migrateLegacyState() {
    const staging = `${this.recordRoot}.migrating-${process.pid}-${Date.now()}`;
    const stagingJobs = path.join(staging, 'jobs');
    const stagingArchives = path.join(staging, 'archives');
    const stagingQueues = path.join(staging, 'terminal-queues');
    await fs.mkdir(stagingJobs, { recursive: true });
    await fs.mkdir(stagingArchives, { recursive: true });
    await fs.mkdir(stagingQueues, { recursive: true });
    await mapLimit(this.state.jobs, 16, async (job) => {
      if (TERMINAL_STATUSES.has(job.status) && !job.terminalQueue) {
        const compacted = { ...job };
        const payload = compactTerminalJob(compacted);
        if (payload) {
          await atomicBuffer(path.join(stagingQueues, `${job.id}.json.gz`), await gzip(Buffer.from(JSON.stringify(payload)), { level: 6 }));
          Object.assign(job, compacted);
        }
      }
      await atomicJson(path.join(stagingJobs, recordName(job.id)), job);
    });
    await mapLimit(this.state.archives, 32, (archive) => atomicJson(path.join(stagingArchives, recordName(archive.id)), archive));
    this.meta = {
      schemaVersion: 2,
      stateRevision: 1,
      archiveRevision: 1,
      createdAt: new Date().toISOString(),
      migratedFrom: 'state.json',
      legacyStatePreserved: true
    };
    await atomicJson(path.join(staging, 'meta.json'), this.meta);
    await fs.rename(staging, this.recordRoot);
  }

  queueWrite(operation) {
    const queued = this.writeQueue.then(operation);
    this.writeQueue = queued.catch(() => {});
    return queued;
  }

  async compactTerminalJob(job) {
    if (!TERMINAL_STATUSES.has(job.status) || job.terminalQueue) return;
    const compacted = { ...job };
    const payload = compactTerminalJob(compacted);
    if (!payload) return;
    await atomicBuffer(path.join(this.terminalQueuesRoot, `${job.id}.json.gz`), await gzip(Buffer.from(JSON.stringify(payload)), { level: 6 }));
    Object.assign(job, compacted);
  }

  async writeChangedRecords(jobIds, archiveIds) {
    return this.queueWrite(async () => {
      for (const id of jobIds) {
        const job = this.getJob(id);
        if (!job) continue;
        const batch = this.captureBatches.get(id);
        await atomicJson(path.join(this.jobsRoot, recordName(id)), batch ? { ...job, ...batch.committed } : job);
      }
      for (const id of archiveIds) {
        const archive = this.getArchive(id);
        if (archive) await atomicJson(path.join(this.archivesRoot, recordName(id)), archive);
      }
      this.meta.stateRevision += 1;
      if (archiveIds.size) this.meta.archiveRevision += 1;
      await atomicJson(this.metaFile, this.meta);
    });
  }

  persistJob(idOrJob) {
    const id = typeof idOrJob === 'string' ? idOrJob : idOrJob?.id;
    if (!id) return Promise.resolve();
    return this.writeChangedRecords(new Set([id]), new Set());
  }

  beginCaptureBatch(id) {
    const job = this.getJob(id);
    if (!job || this.captureBatches.has(id)) throw new Error('保存バッチを開始できません。');
    const initial = captureJobState(job);
    this.captureBatches.set(id, { initial, committed: initial });
  }

  acceptCaptureBatch(id, state) {
    const job = this.getJob(id);
    if (!job) throw new Error('保存ジョブが見つかりません。');
    const batch = this.captureBatches.get(id);
    const next = structuredClone(state);
    if (batch) batch.committed = next;
    Object.assign(job, next);
  }

  endCaptureBatch(id, rollback = false) {
    const batch = this.captureBatches.get(id);
    if (rollback && batch) Object.assign(this.getJob(id), batch.initial);
    this.captureBatches.delete(id);
  }

  async finalizeJob(id) {
    const job = this.getJob(id);
    if (!job) return;
    await this.queueWrite(() => this.compactTerminalJob(job));
    await this.persistJob(id);
  }

  async restoreJobQueue(id) {
    const job = this.getJob(id);
    if (job) this.assertArchiveWritable(job.archiveId);
    if (!job?.terminalQueue) return job;
    await this.queueWrite(async () => {
      const payload = JSON.parse((await gunzip(await fs.readFile(path.join(this.terminalQueuesRoot, `${job.id}.json.gz`)))).toString('utf8'));
      if (payload.jobId !== job.id || payload.schemaVersion !== 1 || !['queue', 'inFlight', 'plannedQueue', 'discoveryVisited'].every(key => Array.isArray(payload[key]))) throw new Error('保存済みの待ち行列を復元できませんでした。');
      const restoredQueue = new Map([...payload.inFlight, ...payload.queue, ...job.inFlight, ...job.queue].map(item => [item.url, item]));
      job.queue = [...restoredQueue.values()];
      job.inFlight = [];
      job.plannedQueue = payload.plannedQueue;
      job.discoveryVisited = payload.discoveryVisited;
      job.queueCount = job.queue.length;
      job.inFlightCount = 0;
      job.plannedQueueCount = job.plannedQueue.length;
      job.discoveryVisitedCount = job.discoveryVisited.length;
      delete job.terminalQueue;
      delete job.queueSample;
    });
    await this.persistJob(id);
    return job;
  }

  persistArchive(idOrArchive) {
    const id = typeof idOrArchive === 'string' ? idOrArchive : idOrArchive?.id;
    if (!id) return Promise.resolve();
    return this.writeChangedRecords(new Set(), new Set([id]));
  }

  persist() {
    return this.writeChangedRecords(new Set(this.state.jobs.map((job) => job.id)), new Set(this.state.archives.map((archive) => archive.id)));
  }

  listJobs() { return [...this.state.jobs].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))); }
  listArchives() { return [...this.state.archives].sort((a, b) => String(b.savedAt || '').localeCompare(String(a.savedAt || ''))); }
  getJob(id) { return this.state.jobs.find((item) => item.id === id); }
  getArchive(id) { return this.state.archives.find((item) => item.id === id); }

  listJobSummaries({ limit = 2000, activeOnly = false, includePreviews = false } = {}) {
    const source = activeOnly ? this.listJobs().filter((job) => ACTIVE_STATUSES.has(job.status)) : this.listJobs();
    return source.slice(0, Math.max(1, Math.min(5000, limit))).map((job) => {
      const { queue = [], inFlight = [], visited = [], visitedDetails = [], plannedQueue = [], discoveryVisited = [], ...summary } = job;
      return {
        ...summary,
        queueCount: Number(job.queueCount ?? queue.length),
        inFlightCount: Number(job.inFlightCount ?? inFlight.length),
        visitedCount: visited.length,
        plannedQueueCount: Number(job.plannedQueueCount ?? plannedQueue.length),
        queue: includePreviews ? queue.slice(0, 80) : [],
        inFlight: includePreviews ? inFlight.slice(0, 20) : [],
        visited: includePreviews ? visited.slice(-80) : [],
        visitedDetails: includePreviews ? visitedDetails.slice(-80) : [],
        plannedQueue: includePreviews ? plannedQueue.slice(-80) : [],
        discoveryVisitedCount: Number(job.discoveryVisitedCount ?? discoveryVisited.length)
      };
    });
  }

  queryArchives({ query = '', offset = 0, limit = 60, folder = '', tag = '' } = {}) {
    const needle = String(query || '').trim().toLowerCase();
    const folderFilter = String(folder || '');
    const tagFilter = String(tag || '');
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(1, Math.min(500, Number(limit) || 60));
    const statusText = {
      complete: '完了', 'complete-with-errors': '一部エラー', cancelled: '中止', 'limit-reached': '上限停止',
      failed: '保存失敗', blocked: 'アクセス確認で停止', 'login-required': 'ログインが必要'
    };
    const filtered = this.listArchives()
      .filter((archive) => !folderFilter || (folderFilter === '__none__' ? !archive.folder : archive.folder === folderFilter))
      .filter((archive) => !tagFilter || (archive.tags || []).includes(tagFilter))
      .filter((archive) => !needle || `${archive.title || ''} ${archive.startUrl || ''} ${archive.status || ''} ${statusText[archive.status] || ''} ${archive.quality?.level || ''} ${(archive.tags || []).join(' ')} ${archive.folder || ''} ${archive.note || ''}`.toLowerCase().includes(needle));
    return { items: filtered.slice(start, start + size), total: filtered.length, offset: start, limit: size, hasMore: start + size < filtered.length };
  }

  archiveFacets() {
    const folders = new Map();
    const tags = new Map();
    for (const archive of this.state.archives) {
      if (archive.folder) folders.set(archive.folder, (folders.get(archive.folder) || 0) + 1);
      for (const tag of archive.tags || []) tags.set(tag, (tags.get(tag) || 0) + 1);
    }
    const sorted = (map) => [...map.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    return { folders: sorted(folders), tags: sorted(tags), unfiled: this.state.archives.filter((archive) => !archive.folder).length };
  }

  async updateArchiveMeta(id, input = {}) {
    const archive = this.getArchive(id);
    if (!archive) return null;
    const clean = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const next = { ...archive };
    if (input.tags !== undefined) {
      const list = Array.isArray(input.tags) ? input.tags : String(input.tags || '').split(/[,、]/);
      next.tags = [...new Set(list.map((tag) => clean(tag, 40)).filter(Boolean))].slice(0, 20);
      if (!next.tags.length) delete next.tags;
    }
    if (input.folder !== undefined) {
      next.folder = clean(input.folder, 80);
      if (!next.folder) delete next.folder;
    }
    if (input.note !== undefined) {
      next.note = String(input.note ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2000);
      if (!next.note) delete next.note;
    }
    return this.addArchive(next, { replaceMeta: true });
  }

  revisions() { return { stateRevision: this.meta.stateRevision, archiveRevision: this.meta.archiveRevision }; }
  counts() { return { jobs: this.state.jobs.length, archives: this.state.archives.length, activeJobs: this.state.jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length }; }

  async addJob(input) {
    const job = {
      id: createId('job'), archiveId: createId('archive'), startUrl: input.startUrl,
      status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      pages: 0, resources: 0, bytes: 0, errors: 0, depth: 0, currentUrl: '',
      message: '開始待ち', warning: null, warningGrants: [], queue: [{ url: input.startUrl, depth: 0, scope: 'origin', externalDepth: 0, from: null }],
      inFlight: [], phase: input.options.discoveryMode === 'immediate' ? 'capturing' : 'discovering',
      plannedQueue: [], discoveryVisited: [], discoveredPages: 0,
      visited: [], visitedDetails: [], options: input.options
    };
    this.state.jobs.push(job);
    await this.persistJob(job);
    return job;
  }

  async addRetryJob({ archiveId, startUrl, options, queue, sourceJobId = null, bytes = 0, kind = 'retry' }) {
    const job = {
      id: createId('job'), archiveId, startUrl, kind, retryOf: sourceJobId,
      status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      pages: 0, resources: 0, bytes: Number(bytes) || 0, errors: 0, depth: 0, currentUrl: '',
      message: '開始待ち', warning: null, warningGrants: [], queue,
      inFlight: [], phase: 'capturing', plannedQueue: [], discoveryVisited: [], discoveredPages: 0,
      visited: [], visitedDetails: [], options
    };
    this.state.jobs.push(job);
    await this.persistJob(job);
    return job;
  }

  async updateJob(id, patch) {
    const job = this.getJob(id);
    if (!job) return null;
    Object.assign(job, patch, { updatedAt: new Date().toISOString() });
    await this.persistJob(job);
    return job;
  }

  async addArchive(archive, { replaceMeta = false } = {}) {
    const index = this.state.archives.findIndex((item) => item.id === archive.id);
    if (index >= 0 && !replaceMeta) {
      const previous = this.state.archives[index];
      for (const key of PRESERVED_ARCHIVE_FIELDS) if (archive[key] === undefined && previous[key] !== undefined) archive = { ...archive, [key]: previous[key] };
    }
    if (index >= 0) this.state.archives[index] = archive;
    else this.state.archives.push(archive);
    await this.persistArchive(archive);
    return archive;
  }

  deleteArchive(id) {
    const operation = this.mutationQueue.then(() => this.performDeleteArchive(id));
    this.mutationQueue = operation.catch(() => {});
    return operation;
  }

  async performDeleteArchive(id) {
    this.assertArchiveWritable(id);
    const archive = this.getArchive(id);
    if (!archive) return false;
    const active = this.state.jobs.some((job) => job.archiveId === id && ACTIVE_STATUSES.has(job.status));
    if (active) throw new Error('保存処理が使用中のため、完了または停止してから削除してください。');
    this.discardPendingReplayMisses(id);
    await this.writeQueue;
    const archiveRoot = this.archiveRoot(id);
    const trashRoot = path.join(this.dataRoot, '.trash');
    const trashPath = path.join(trashRoot, `${id}-${Date.now()}`);
    let moved = false;
    try {
      await fs.mkdir(trashRoot, { recursive: true });
      await fs.rename(archiveRoot, trashPath);
      moved = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const previousArchives = this.state.archives;
    const previousJobs = this.state.jobs;
    const removedJobs = previousJobs.filter((job) => job.archiveId === id);
    this.state.archives = previousArchives.filter((item) => item.id !== id);
    this.state.jobs = previousJobs.filter((job) => job.archiveId !== id);
    try {
      await this.queueWrite(async () => {
        await fs.rm(path.join(this.archivesRoot, recordName(id)), { force: true });
        for (const job of removedJobs) {
          await fs.rm(path.join(this.jobsRoot, recordName(job.id)), { force: true });
        }
        this.meta.stateRevision += 1;
        this.meta.archiveRevision += 1;
        await atomicJson(this.metaFile, this.meta);
      });
    } catch (error) {
      this.state.archives = previousArchives;
      this.state.jobs = previousJobs;
      if (moved) await fs.rename(trashPath, archiveRoot).catch(() => {});
      await this.persist().catch(() => {});
      throw error;
    }
    await this.queueWrite(async () => {
      for (const job of removedJobs) await fs.rm(path.join(this.terminalQueuesRoot, `${job.id}.json.gz`), { force: true });
    }).catch(error => logEvent('warn', 'archive', 'queue.cleanup.failed', { archiveId: id, code: error.code }));
    if (moved) {
      this.trashCleanupQueue = this.trashCleanupQueue.then(() => fs.rm(trashPath, { recursive: true, force: true }))
        .then(() => logEvent('info', 'archive', 'trash.cleanup.completed', { archiveId: id }))
        .catch((error) => logEvent('warn', 'archive', 'trash.cleanup.failed', { archiveId: id, code: error.code }));
    }
    return true;
  }

  waitForTrashCleanup() { return this.trashCleanupQueue; }
  async waitForWrites() {
    await this.flushAllReplayMisses();
    await this.writeQueue;
  }

  setReplayMissSuppressed(id, suppressed) {
    if (suppressed) this.replayMissSuppressed.add(id);
    else this.replayMissSuppressed.delete(id);
  }

  scheduleReplayMissFlush(id, delayMs = 250) {
    if (this.replayMissFlushTimers.has(id)) return;
    const timer = setTimeout(() => {
      this.replayMissFlushTimers.delete(id);
      this.flushReplayMisses(id).catch((error) => logEvent('warn', 'replay', 'runtime-miss.flush.failed', { archiveId: id, code: error.code || 'WRITE_FAILED' }));
    }, delayMs);
    timer.unref?.();
    this.replayMissFlushTimers.set(id, timer);
  }

  discardPendingReplayMisses(id) {
    const timer = this.replayMissFlushTimers.get(id);
    if (timer) clearTimeout(timer);
    this.replayMissFlushTimers.delete(id);
    this.pendingReplayMisses.delete(id);
  }

  async flushReplayMisses(id) {
    const timer = this.replayMissFlushTimers.get(id);
    if (timer) clearTimeout(timer);
    this.replayMissFlushTimers.delete(id);
    const batch = this.pendingReplayMisses.get(id);
    if (!batch?.size) return;
    this.pendingReplayMisses.delete(id);
    try {
      await this.queueWrite(async () => {
        const report = await readJson(this.runtimeMissFile(id), { schemaVersion: 1, total: 0, items: [] });
        await atomicJson(this.runtimeMissFile(id), mergeReplayMissReport(report, batch));
      });
    } catch (error) {
      const next = this.pendingReplayMisses.get(id) || new Map();
      for (const [url, item] of batch) {
        const existing = next.get(url);
        if (existing) {
          existing.count += item.count;
          existing.firstSeenAt = item.firstSeenAt < existing.firstSeenAt ? item.firstSeenAt : existing.firstSeenAt;
          existing.lastSeenAt = item.lastSeenAt > existing.lastSeenAt ? item.lastSeenAt : existing.lastSeenAt;
        } else next.set(url, { ...item });
      }
      this.pendingReplayMisses.set(id, next);
      this.scheduleReplayMissFlush(id, 1000);
      throw error;
    }
  }

  async flushAllReplayMisses() {
    for (const id of [...this.pendingReplayMisses.keys()]) await this.flushReplayMisses(id);
  }

  archiveRoot(id) { return path.join(this.dataRoot, 'archives', id); }
  manifestFile(id) { return path.join(this.archiveRoot(id), 'manifest.json'); }
  runtimeMissFile(id) { return path.join(this.archiveRoot(id), 'runtime-misses.json'); }
  replayAuditFile(id) { return path.join(this.archiveRoot(id), 'replay-audit.json'); }
  assertArchiveWritable(id) {
    const failure = this.repairRecoveryFailures.get(id);
    if (failure) throw new Error(failure.message);
  }
  async readManifest(id) {
    const file = this.manifestFile(id);
    let stat;
    try { stat = await fs.stat(file); } catch (error) {if (error.code === 'ENOENT') return null;throw error;}
    const signature = `${stat.mtimeMs}:${stat.size}`;
    const cached = this.manifestCache.get(id);
    if (cached?.signature === signature) {this.manifestCache.delete(id);this.manifestCache.set(id,cached);return cached.manifest;}
    const manifest = await readJson(file, null);
    this.manifestCache.set(id, { signature, manifest });
    while (this.manifestCache.size > 12) this.manifestCache.delete(this.manifestCache.keys().next().value);
    return manifest;
  }
  async writeManifest(id, manifest) {this.assertArchiveWritable(id);await atomicJson(this.manifestFile(id), manifest);this.manifestCache.delete(id);}

  async readRuntimeMisses(id) {
    const report = await readJson(this.runtimeMissFile(id), { schemaVersion: 1, total: 0, items: [] });
    return mergeReplayMissReport(report, this.pendingReplayMisses.get(id));
  }

  async recordReplayMiss(id, resourceUrl) {
    if (this.replayMissSuppressed.has(id)) return;
    const now = new Date().toISOString();
    const batch = this.pendingReplayMisses.get(id) || new Map();
    const existing = batch.get(resourceUrl);
    if (existing) { existing.count += 1; existing.lastSeenAt = now; }
    else batch.set(resourceUrl, { count: 1, firstSeenAt: now, lastSeenAt: now });
    this.pendingReplayMisses.set(id, batch);
    this.scheduleReplayMissFlush(id);
  }

  async clearRuntimeMisses(id) {
    this.discardPendingReplayMisses(id);
    await this.queueWrite(() => fs.rm(this.runtimeMissFile(id), { force: true }));
  }

  async readReplayAudit(id) {
    return readJson(this.replayAuditFile(id), null);
  }

  async writeReplayAudit(id, report) {
    return this.queueWrite(async () => {
      if (!this.getArchive(id)) throw new Error('保存済みサイトが見つかりません。');
      this.assertArchiveWritable(id);
      await atomicJson(this.replayAuditFile(id), report);
    });
  }

  async writeBlob(id, body) {
    this.assertArchiveWritable(id);
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const file = path.join(this.archiveRoot(id), 'blobs', digest.slice(0, 2), digest);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const signatureOf = stat => `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
    const remember = stat => {
      this.verifiedBlobs.set(file, signatureOf(stat));
      while (this.verifiedBlobs.size > 2048) this.verifiedBlobs.delete(this.verifiedBlobs.keys().next().value);
    };
    const verify = async () => {
      const handle = await fs.open(file, 'r');
      try {
        const stat = await handle.stat();
        const signature = signatureOf(stat);
        if (stat.size === buffer.length && this.verifiedBlobs.get(file) === signature) return;
        const hash = crypto.createHash('sha256');
        const block = Buffer.alloc(64 * 1024);
        let offset = 0;
        while (stat.size === buffer.length && offset < stat.size) {
          const { bytesRead } = await handle.read(block, 0, Math.min(block.length, stat.size - offset), offset);
          if (!bytesRead) break;
          hash.update(block.subarray(0, bytesRead));
          offset += bytesRead;
        }
        if (stat.size !== buffer.length || offset !== stat.size || hash.digest('hex') !== digest) {
          const error = new Error('保存済み素材の内容がSHA-256と一致しません。原本は上書きしません。');
          error.code = 'BLOB_INTEGRITY_ERROR';
          logEvent('error', 'archive', 'blob.integrity.failed', { archiveId: id, digest, expectedBytes: buffer.length, actualBytes: stat.size });
          throw error;
        }
        remember(stat);
      } finally { await handle.close(); }
    };
    try { await verify(); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (await this.linkPeerBlob(id, digest, buffer.length, file)) {
        await verify();
        return { digest: `sha256:${digest}`, file: path.relative(this.archiveRoot(id), file).replaceAll('\\', '/'), size: buffer.length, shared: true };
      }
      const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      const handle = await fs.open(temp, 'wx');
      try {
        await handle.writeFile(buffer);
        await handle.sync();
        await handle.close();
        try { await fs.link(temp, file); remember(await fs.stat(file)); }
        catch (linkError) { if (linkError.code !== 'EEXIST') throw linkError; }
        await verify();
      } finally {
        await handle.close().catch(() => {});
        await fs.rm(temp, { force: true }).catch(() => {});
      }
    }
    return { digest: `sha256:${digest}`, file: path.relative(this.archiveRoot(id), file).replaceAll('\\', '/'), size: buffer.length };
  }

  async writeBlobFromStream(id, write) {
    this.assertArchiveWritable(id);
    const staging = path.join(this.archiveRoot(id), 'blobs', `incoming-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
    await fs.mkdir(path.dirname(staging), { recursive: true });
    const hash = crypto.createHash('sha256');
    let size = 0;
    const handle = await fs.open(staging, 'wx');
    try {
      await write(async (chunk) => {
        hash.update(chunk);
        size += chunk.length;
        await handle.write(chunk);
      });
      await handle.sync();
      await handle.close();
      const digest = hash.digest('hex');
      const file = path.join(this.archiveRoot(id), 'blobs', digest.slice(0, 2), digest);
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        const existing = await fs.stat(file);
        if (existing.size !== size) {
          const error = new Error('保存済み素材の内容がSHA-256と一致しません。原本は上書きしません。');
          error.code = 'BLOB_INTEGRITY_ERROR';
          throw error;
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        if (!await this.linkPeerBlob(id, digest, size, file)) {
          try { await fs.link(staging, file); }
          catch (linkError) { if (linkError.code !== 'EEXIST') throw linkError; }
        }
      }
      return { digest: `sha256:${digest}`, file: path.relative(this.archiveRoot(id), file).replaceAll('\\', '/'), size };
    } finally {
      await handle.close().catch(() => {});
      await fs.rm(staging, { force: true }).catch(() => {});
    }
  }

  async writeScreenshot(id, name, body) {
    this.assertArchiveWritable(id);
    if (!/^\d+(?:-mobile)?\.png$/.test(name)) throw new Error('スクリーンショット名が正しくありません。');
    await atomicBuffer(path.join(this.archiveRoot(id), 'screenshots', name), body);
    return `screenshots/${name}`;
  }
}
