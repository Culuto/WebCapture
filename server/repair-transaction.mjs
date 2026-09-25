import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { logEvent } from './logger.mjs';

const validArchiveId = id => /^archive_[a-z0-9_]+$/i.test(String(id));
const digest = body => crypto.createHash('sha256').update(body).digest('hex');
const repairRoot = store => path.join(store.dataRoot, '.archive-repairs');
const recoveryWarning = { status: 'failed', message: '保存処理の復旧が完了していないため、このアーカイブの変更を停止しています。保存済みのページは表示できます。' };
const captureFields = ['pages', 'resources', 'bytes', 'errors', 'queue', 'inFlight', 'visited', 'visitedDetails'];

export function captureJobState(job) {
  return structuredClone(Object.fromEntries(captureFields.map(key => [key, job[key]])));
}

function validateCaptureJob(store, id, item, manifest) {
  if (!item || store.getJob(item.id)?.archiveId !== id || !item.state ||
      Object.keys(item.state).some(key => !captureFields.includes(key)) ||
      !['pages', 'resources', 'bytes', 'errors'].every(key => Number.isSafeInteger(item.state[key]) && item.state[key] >= 0) ||
      !['queue', 'inFlight', 'visited', 'visitedDetails'].every(key => Array.isArray(item.state[key])) ||
      !['queue', 'inFlight', 'visitedDetails'].every(key => item.state[key].every(value => value && typeof value.url === 'string')) ||
      !item.state.visited.every(value => typeof value === 'string') ||
      item.state.pages !== manifest.pages?.length || item.state.resources !== Object.keys(manifest.resources || {}).length) {
    throw new Error('保存のジョブ準備記録を照合できません。');
  }
}

function transactionRoot(store, id) {
  if (!validArchiveId(id)) throw new Error('補完対象のIDが正しくありません。');
  return path.join(repairRoot(store), id);
}

async function durableFile(file, body) {
  const handle = await fs.open(file, 'wx');
  try { await handle.writeFile(body); await handle.sync(); }
  finally { await handle.close(); }
}

async function warcStat(file) {
  try { return await fs.stat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function applyRepair(store, id, checkpoint = async () => {}) {
  const root = transactionRoot(store, id);
  const plan = JSON.parse(await fs.readFile(path.join(root, 'plan.json'), 'utf8'));
  const manifestBody = await fs.readFile(path.join(root, 'manifest.json'));
  const manifest = JSON.parse(manifestBody.toString('utf8'));
  const chunk = await fs.readFile(path.join(root, 'warc-addition.gz'));
  if (plan.schemaVersion !== 1 || plan.archiveId !== id || manifest.id !== id ||
      !Number.isSafeInteger(plan.previousWarcSize) || plan.previousWarcSize < 0 ||
      plan.warcSize !== chunk.length || plan.warcDigest !== digest(chunk) ||
      plan.manifestDigest !== digest(manifestBody) || !Array.isArray(plan.jobs) ||
      plan.archive && plan.archive.id !== id) throw new Error('補完の準備記録が破損しています。');
  for (const item of plan.jobs) {
    if (!/^job_[a-z0-9_]+$/i.test(item.id) || store.getJob(item.id)?.archiveId !== id ||
        !Number.isSafeInteger(item.resources) || item.resources < 0 ||
        !Number.isSafeInteger(item.bytes) || item.bytes < 0) throw new Error('補完のジョブ記録を照合できません。');
  }
  if (plan.captureJob || plan.captureDigest) {
    if (!plan.captureJob || plan.jobs.length || plan.captureDigest !== digest(Buffer.from(JSON.stringify(plan.captureJob)))) throw new Error('保存のジョブ準備記録が破損しています。');
    validateCaptureJob(store, id, plan.captureJob, manifest);
  }

  if (chunk.length) {
    const file = path.join(store.archiveRoot(id), 'collection.warc.gz');
    const stat = await warcStat(file);
    const currentSize = stat?.size || 0;
    const alreadyWritten = currentSize - plan.previousWarcSize;
    if (alreadyWritten < 0 || alreadyWritten > chunk.length) throw new Error('補完中にWARCのサイズが変更されました。原本は上書きしません。');
    const handle = await fs.open(file, stat ? 'r+' : 'wx');
    try {
      if (alreadyWritten) {
        const previousAddition = Buffer.alloc(alreadyWritten);
        let offset = 0;
        while (offset < alreadyWritten) {
          const result = await handle.read(previousAddition, offset, alreadyWritten - offset, plan.previousWarcSize + offset);
          if (!result.bytesRead) throw new Error('補完済みWARCを読み取れません。');
          offset += result.bytesRead;
        }
        if (!previousAddition.equals(chunk.subarray(0, alreadyWritten))) throw new Error('補完中のWARCデータが一致しません。原本は上書きしません。');
      }
      let offset = alreadyWritten;
      while (offset < chunk.length) {
        const result = await handle.write(chunk, offset, chunk.length - offset, plan.previousWarcSize + offset);
        if (!result.bytesWritten) throw new Error('補完WARCを書き込めません。');
        offset += result.bytesWritten;
      }
      await handle.sync();
    } finally { await handle.close(); }
  }
  await checkpoint('warc');
  await store.writeManifest(id, manifest);
  await checkpoint('manifest');
  if (plan.archive) await store.addArchive(plan.archive);
  await checkpoint('archive');
  for (const item of plan.jobs) await store.updateJob(item.id, { resources: item.resources, bytes: item.bytes });
  if (plan.captureJob) {
    store.acceptCaptureBatch(plan.captureJob.id, plan.captureJob.state);
    await store.persistJob(plan.captureJob.id);
  }
  await checkpoint('jobs');
  await store.waitForWrites();
  const committed = path.join(repairRoot(store), `committed-${id}-${crypto.randomBytes(8).toString('hex')}`);
  await fs.rename(root, committed);
  await fs.rm(committed, { recursive: true, force: true }).catch(error => logEvent('warn', 'archive', 'repair.cleanup.failed', { archiveId: id, code: error.code }));
  logEvent('info', 'archive', 'repair.committed', { archiveId: id, resources: Object.keys(manifest.resources || {}).length, addedWarcBytes: chunk.length });
}

export async function commitArchiveRepair(store, id, { manifest, warcChunk = Buffer.alloc(0), archive = null, jobs = [], captureJob = null }, { checkpoint = async () => {} } = {}) {
  store.assertArchiveWritable(id);
  if (manifest?.id !== id) throw new Error('補完のmanifestを照合できません。');
  if (captureJob) validateCaptureJob(store, id, captureJob, manifest);
  const root = transactionRoot(store, id);
  if (await warcStat(root)) {
    store.repairRecoveryFailures.set(id, { ...recoveryWarning });
    throw new Error('未完了の保存記録が残っています。再起動して復旧してください。');
  }
  await fs.mkdir(repairRoot(store), { recursive: true });
  const staging = path.join(repairRoot(store), `staging-${id}-${crypto.randomBytes(8).toString('hex')}`);
  await fs.mkdir(staging);
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const plan = {
    schemaVersion: 1, archiveId: id, preparedAt: new Date().toISOString(),
    previousWarcSize: (await warcStat(path.join(store.archiveRoot(id), 'collection.warc.gz')))?.size || 0,
    warcSize: warcChunk.length, warcDigest: digest(warcChunk), manifestDigest: digest(manifestBody), archive, jobs,
    ...(captureJob ? { captureJob, captureDigest: digest(Buffer.from(JSON.stringify(captureJob))) } : {})
  };
  try {
    await durableFile(path.join(staging, 'manifest.json'), manifestBody);
    await durableFile(path.join(staging, 'warc-addition.gz'), warcChunk);
    await durableFile(path.join(staging, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
    await fs.rename(staging, root);
  } catch (error) {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  logEvent('info', 'archive', 'repair.prepared', { archiveId: id, addedWarcBytes: warcChunk.length });
  try {
    await checkpoint('prepared');
    await applyRepair(store, id, checkpoint);
  } catch (error) {
    store.repairRecoveryFailures.set(id, { ...recoveryWarning });
    logEvent('error', 'archive', 'repair.commit.interrupted', { archiveId: id, code: error.code, message: error.message });
    throw error;
  }
}

export function commitArchiveCapture(store, id, { manifest, warcChunk, job }, options) {
  return commitArchiveRepair(store, id, {
    manifest, warcChunk, captureJob: { id: job.id, state: captureJobState(job) }
  }, options);
}

export async function recoverArchiveRepairs(store) {
  let names;
  try { names = await fs.readdir(repairRoot(store)); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const id of names.filter(validArchiveId)) {
    try {
      store.repairRecoveryFailures.delete(id);
      await applyRepair(store, id);
      store.repairRecoveryFailures.delete(id);
      logEvent('info', 'archive', 'repair.recovered', { archiveId: id });
    } catch (error) {
      store.repairRecoveryFailures.set(id, { ...recoveryWarning });
      logEvent('error', 'archive', 'repair.recovery.failed', { archiveId: id, code: error.code, message: error.message });
    }
  }
}
