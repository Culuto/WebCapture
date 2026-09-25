import fs from 'node:fs/promises';
import path from 'node:path';
import { commitArchiveRepair } from './repair-transaction.mjs';
import { createWarcAsync } from './warc.mjs';
import { logEvent, safeUrl } from './logger.mjs';
import { summarizeArchiveQuality } from './quality.mjs';

const WARC_INLINE_LIMIT = 256 * 1024 ** 2;
const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'discovering', 'pausing', 'capturing']);

function serviceError(message, code, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}

function payload(status, headers, body) {
  const lines = Object.entries(headers)
    .filter(([key]) => !['content-encoding', 'transfer-encoding', 'content-length'].includes(key.toLowerCase()))
    .map(([key, value]) => `${key}: ${value}`);
  lines.push(`content-length: ${body.length}`);
  return Buffer.concat([Buffer.from(`HTTP/1.1 ${status} ${status === 200 ? 'OK' : ''}\r\n${lines.join('\r\n')}\r\n\r\n`), body]);
}

export function summarizeDeferredMedia(manifest) {
  return (manifest?.deferredMedia || []).map((item) => ({
    url: item.url, kind: item.kind, pageUrl: item.pageUrl || null, recordedAt: item.recordedAt || null,
    expectedBytes: item.expectedBytes ?? null, savedBytes: item.savedBytes ?? null, limitBytes: item.limitBytes ?? null,
    remainingCount: Array.isArray(item.remainingUrls) ? item.remainingUrls.length : item.kind === 'file' ? 1 : 0
  }));
}

export class DeferredMediaService {
  constructor({ store, fetcher }) {
    this.store = store;
    this.fetcher = fetcher;
    this.tasks = new Map();
  }

  async status(archiveId) {
    const manifest = await this.store.readManifest(archiveId);
    return { items: summarizeDeferredMedia(manifest), task: this.tasks.get(archiveId) || null };
  }

  async start(archiveId, urls = null) {
    const current = this.tasks.get(archiveId);
    if (current?.status === 'running') return current;
    if (this.store.state.jobs.some((job) => job.archiveId === archiveId && ACTIVE_JOB_STATUSES.has(job.status))) {
      throw serviceError('このアーカイブは保存処理中のため、完了してから実行してください。', 'ARCHIVE_BUSY', 409);
    }
    const manifest = await this.store.readManifest(archiveId);
    if (!manifest) throw serviceError('保存済みサイトが見つかりません。', 'NOT_FOUND', 404);
    const wanted = Array.isArray(urls) && urls.length ? new Set(urls.map(String)) : null;
    const selected = (manifest.deferredMedia || []).filter((item) => !wanted || wanted.has(item.url)).map((item) => item.url);
    if (!selected.length) throw serviceError('保存できる未保存の動画・音声がありません。', 'NOTHING_TO_SAVE', 404);
    const task = { archiveId, status: 'running', total: selected.length, completed: 0, failed: 0, bytes: 0, startedAt: new Date().toISOString(), finishedAt: null, errors: [] };
    this.tasks.set(archiveId, task);
    logEvent('info', 'archive', 'deferred-media.started', { archiveId, items: selected.length });
    this.run(archiveId, selected, task).catch((error) => {
      task.status = 'failed';
      task.finishedAt = new Date().toISOString();
      task.errors.push({ url: '', message: error.message });
      logEvent('error', 'archive', 'deferred-media.failed', { archiveId, code: error.code || 'DEFERRED_MEDIA_FAILED', message: error.message });
    });
    return task;
  }

  async run(archiveId, urls, task) {
    const store = this.store;
    const manifest = await store.readManifest(archiveId);
    manifest.resources ||= {};
    manifest.resourceAliases ||= {};
    const options = { ...(manifest.options || {}), requestTimeoutMs: 6 * 60 * 60 * 1000, responseMaxBytes: null };
    const records = [];
    const savedUrls = new Set();
    let addedBytes = 0;
    const saveUrl = async (url) => {
      let fetched;
      const blob = await store.writeBlobFromStream(archiveId, async (sink) => {
        fetched = await this.fetcher(url, { ...options, bodySink: sink });
      });
      const { response, finalUrl } = fetched;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!blob.size) throw new Error('取得した応答が空でした。');
      const headers = Object.fromEntries(response.headers.entries());
      const capturedAt = new Date().toISOString();
      manifest.resources[url] = {
        url, status: response.status, headers, mimeType: headers['content-type'] || 'application/octet-stream',
        digest: blob.digest, file: blob.file, size: blob.size, capturedAt, completedLater: true
      };
      if (finalUrl && finalUrl !== url) manifest.resourceAliases[finalUrl] = url;
      if (manifest.options?.warcEnabled !== false && blob.size <= WARC_INLINE_LIMIT) {
        const body = await fs.readFile(path.join(store.archiveRoot(archiveId), blob.file));
        records.push({ url, capturedAt, httpPayload: payload(response.status, headers, body) });
      } else if (manifest.options?.warcEnabled !== false) manifest.resources[url].warcOmitted = true;
      addedBytes += blob.size;
      savedUrls.add(url);
      task.bytes = addedBytes;
      logEvent('info', 'archive', 'deferred-media.saved', { archiveId, resourceUrl: safeUrl(url), bytes: blob.size });
    };
    for (const url of urls) {
      const entry = (manifest.deferredMedia || []).find((item) => item.url === url);
      if (!entry) { task.completed += 1; continue; }
      try {
        if (entry.kind === 'stream') {
          for (const segment of [...(entry.remainingUrls || [])]) {
            if (!manifest.resources[segment]) await saveUrl(segment);
            entry.remainingUrls = entry.remainingUrls.filter((item) => item !== segment);
          }
        } else await saveUrl(url);
        manifest.deferredMedia = manifest.deferredMedia.filter((item) => item !== entry);
        savedUrls.add(url);
        task.completed += 1;
      } catch (error) {
        task.failed += 1;
        task.errors.push({ url: safeUrl(url), message: error.message });
        logEvent('warn', 'archive', 'deferred-media.item.failed', { archiveId, resourceUrl: safeUrl(url), code: error.code || 'FETCH_FAILED', message: error.message });
      }
    }
    manifest.blocked = (manifest.blocked || []).filter((item) => !(savedUrls.has(item.url) && /上限（/.test(item.reason || '')));
    const warcChunk = records.length ? await createWarcAsync(records, { repair: 'deferred-media' }, manifest.options?.warcCompressionLevel ?? 1) : Buffer.alloc(0);
    const archive = store.getArchive(archiveId);
    manifest.quality = summarizeArchiveQuality(manifest, archive || {});
    const resourceCount = Object.keys(manifest.resources).length;
    await commitArchiveRepair(store, archiveId, {
      manifest, warcChunk,
      archive: archive ? { ...archive, quality: manifest.quality, resources: resourceCount, bytes: Number(archive.bytes || 0) + addedBytes + warcChunk.length, repairedAt: new Date().toISOString() } : null,
      jobs: store.state.jobs.filter((job) => job.archiveId === archiveId).map((job) => ({ id: job.id, resources: resourceCount, bytes: Number(job.bytes || 0) + addedBytes + warcChunk.length }))
    });
    task.status = task.failed ? (task.completed ? 'completed-with-errors' : 'failed') : 'completed';
    task.finishedAt = new Date().toISOString();
    logEvent(task.failed ? 'warn' : 'info', 'archive', 'deferred-media.completed', { archiveId, completed: task.completed, failed: task.failed, addedBytes, warcBytes: warcChunk.length });
  }
}
