import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logEvent } from './logger.mjs';

const DIGEST_NAME = /^[a-f0-9]{64}$/;

export async function fileDigest(file) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve);
  });
  return hash.digest('hex');
}

export async function* blobFiles(archiveRoot) {
  const root = path.join(archiveRoot, 'blobs');
  let buckets = [];
  try { buckets = await fs.readdir(root, { withFileTypes: true }); } catch { return; }
  for (const bucket of buckets) {
    if (!bucket.isDirectory() || !/^[a-f0-9]{2}$/.test(bucket.name)) continue;
    let names = [];
    try { names = await fs.readdir(path.join(root, bucket.name)); } catch { continue; }
    for (const name of names) if (DIGEST_NAME.test(name) && name.startsWith(bucket.name)) yield { digest: name, file: path.join(root, bucket.name, name) };
  }
}

export async function linkReplace(source, target) {
  const temporary = `${target}.dedupe-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.link(source, temporary);
    await fs.rename(temporary, target);
    return true;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function sharedBlobStats(archiveRoot) {
  let files = 0;
  let sharedFiles = 0;
  let sharedBytes = 0;
  for await (const { file } of blobFiles(archiveRoot)) {
    try {
      const stat = await fs.stat(file);
      files += 1;
      if (stat.nlink > 1) { sharedFiles += 1; sharedBytes += stat.size; }
    } catch {}
  }
  return { files, sharedFiles, sharedBytes };
}

export class BlobDedupeService {
  constructor({ store, isBusy = () => false }) {
    this.store = store;
    this.isBusy = isBusy;
    this.task = null;
  }

  status() { return this.task ? { ...this.task } : null; }

  start() {
    if (this.task?.status === 'running') return this.status();
    const task = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, archives: 0, scannedFiles: 0, linkedFiles: 0, savedBytes: 0, skippedArchives: 0, failedFiles: 0, message: '' };
    this.task = task;
    this.run(task).catch((error) => {
      task.status = 'failed';
      task.message = error.message;
      task.finishedAt = new Date().toISOString();
      logEvent('error', 'storage', 'dedupe.failed', { message: error.message });
    });
    return this.status();
  }

  async run(task) {
    const canonical = new Map();
    logEvent('info', 'storage', 'dedupe.started', { archives: this.store.listArchives().length });
    for (const archive of this.store.listArchives().reverse()) {
      if (this.isBusy(archive.id)) { task.skippedArchives += 1; continue; }
      task.archives += 1;
      for await (const { digest, file } of blobFiles(this.store.archiveRoot(archive.id))) {
        task.scannedFiles += 1;
        let stat;
        try { stat = await fs.stat(file); } catch { continue; }
        const known = canonical.get(digest);
        if (!known) {
          canonical.set(digest, { file, ino: stat.ino, dev: stat.dev, size: stat.size, verified: false });
          continue;
        }
        if (known.ino === stat.ino && known.dev === stat.dev) continue;
        if (known.dev !== stat.dev || known.size !== stat.size) continue;
        try {
          if (!known.verified) {
            if (await fileDigest(known.file) !== digest) { canonical.set(digest, { file, ino: stat.ino, dev: stat.dev, size: stat.size, verified: false }); continue; }
            known.verified = true;
          }
          const saved = stat.nlink === 1 ? stat.size : 0;
          await linkReplace(known.file, file);
          task.linkedFiles += 1;
          task.savedBytes += saved;
        } catch (error) {
          task.failedFiles += 1;
          if (task.failedFiles <= 5) logEvent('warn', 'storage', 'dedupe.file.failed', { archiveId: archive.id, code: error.code || 'LINK_FAILED' });
        }
      }
    }
    task.status = 'completed';
    task.finishedAt = new Date().toISOString();
    task.message = task.linkedFiles ? `${task.linkedFiles}件の素材をまとめました。` : 'まとめられる重複した素材はありませんでした。';
    logEvent('info', 'storage', 'dedupe.completed', { linkedFiles: task.linkedFiles, savedBytes: task.savedBytes, failedFiles: task.failedFiles, skippedArchives: task.skippedArchives });
  }
}

export function peerArchivesFor(store, archiveId, limit = 6) {
  const job = store.state.jobs.find((item) => item.archiveId === archiveId);
  const archive = store.getArchive(archiveId);
  const startUrl = archive?.startUrl || job?.startUrl;
  let host = '';
  try { host = new URL(startUrl).hostname; } catch { return []; }
  const previous = archive?.previousArchiveId || job?.previousArchiveId || null;
  const peers = store.listArchives()
    .filter((item) => item.id !== archiveId && (() => { try { return new URL(item.startUrl).hostname === host; } catch { return false; } })())
    .map((item) => item.id);
  const ordered = previous && previous !== archiveId ? [previous, ...peers.filter((id) => id !== previous)] : peers;
  return ordered.slice(0, limit);
}
