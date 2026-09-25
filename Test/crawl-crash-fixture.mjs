import { VaultStore } from '../server/store.mjs';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';

const [root, id, phase] = process.argv.slice(2);
const store = await new VaultStore(root).init();
await store.updateJob(id, { status: 'queued' });
const suspend = async current => {
  if (current !== phase || store.getJob(id).pages < (phase === 'blob-stage' ? 2 : 3)) return;
  if (phase === 'blob-stage') await manager.pause(id);
  process.send({ phase: current });
  await new Promise(() => {});
};
const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS, captureCommitCheckpoint: suspend });
if (phase === 'blob-stage') {
  const original = store.writeBlob.bind(store);
  store.writeBlob = async (...args) => { const result = await original(...args); await suspend('blob-stage'); return result; };
}
await manager.run(id);
process.send({ unexpectedCompletion: true });
process.disconnect();
