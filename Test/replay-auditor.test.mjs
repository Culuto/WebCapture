import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyReplayAuditPage, isRuntimeAdvisory, ReplayAuditManager } from '../server/replay-auditor.mjs';

test('表示検査は見える破損画像をerror、動作エラーだけをwarningとして分類する', () => {
  assert.equal(classifyReplayAuditPage({ metrics: { bodyTextLength: 10, visibleBrokenImageCount: 1 } }), 'error');
  assert.equal(classifyReplayAuditPage({ metrics: { bodyTextLength: 10 }, runtimeErrors: [{ message: 'error' }] }), 'warning');
  assert.equal(classifyReplayAuditPage({ metrics: { bodyTextLength: 10, maxScrollY: 500, reachedBottom: true } }), 'healthy');
  assert.equal(classifyReplayAuditPage({ metrics: { bodyTextLength: 10 }, boundaryResources: [{}], auxiliaryResources: [{}], isolationEvents: [{}], runtimeAdvisories: [{}] }), 'healthy');
  assert.equal(classifyReplayAuditPage({ metrics: { bodyTextLength: 10, unreachableScrollContainerCount: 1 } }), 'warning');
  assert.equal(classifyReplayAuditPage({ metrics: { bodyTextLength: 10 }, interactions: { errorCount: 1 } }), 'warning');
  assert.equal(classifyReplayAuditPage({ metrics: { bodyTextLength: 10 }, interactions: { skippedCount: 1 } }), 'warning');
  assert.equal(classifyReplayAuditPage({ metrics: { bodyTextLength: 10 }, interactions: { transientCount: 4 } }), 'healthy');
  assert.equal(classifyReplayAuditPage({ metrics: { bodyTextLength: 0, loadedImageCount: 0 } }), 'error');
});

test('自動操作で中断されたView Transitionだけを助言として扱う', () => {
  assert.equal(isRuntimeAdvisory('AbortError: Transition was skipped'), true);
  assert.equal(isRuntimeAdvisory('AbortError: The operation was aborted'), false);
  assert.equal(isRuntimeAdvisory('TypeError: transition failed'), false);
});

test('全ページ表示検査は進捗と結果を副記録へ保存し、原manifestを書き換えない', async () => {
  const writes = [];
  const manifest = { pages: [
    { url: 'https://example.test/', title: 'Top', html: 'blobs/a' },
    { url: 'https://example.test/about', title: 'About', html: 'blobs/b' }
  ] };
  const store = {
    getArchive: id => id === 'archive_audit_fixture' ? { id } : null,
    readManifest: async () => manifest,
    readReplayAudit: async () => writes.at(-1) || null,
    writeReplayAudit: async (_id, report) => { writes.push(structuredClone(report)); },
    archiveRoot: () => path.join(os.tmpdir(), 'webcapture-replay-audit-test')
  };
  let visited = 0;
  const manager = new ReplayAuditManager(store, { host: '127.0.0.1', replayPort: 43194 }, {
    browserFactory: async () => ({ client: {}, close: async () => {} }),
    auditPage: async (_client, { page }) => ({
      url: page.url, requestedUrl: page.url, savedTitle: page.title, title: page.title,
      documentStatus: 200, navigationError: '', status: ++visited === 1 ? 'healthy' : 'warning',
      metrics: { bodyTextLength: 20, imageCount: 1, loadedImageCount: 1, visibleBrokenImageCount: 0 },
      interactions: { discoveredCount: 3, candidateCount: 2, testedCount: 2, skippedCount: 0, transientCount: 1, changedCount: 1, errorCount: 0, limitReached: false, items: [] },
      missingResources: visited === 2 ? [{ url: 'redacted', status: 404, type: 'Image' }] : [],
      boundaryResources: [], auxiliaryResources: [], failedRequests: [], isolationEvents: [], runtimeAdvisories: [], runtimeErrors: []
    })
  });
  const started = await manager.start('archive_audit_fixture');
  assert.equal(started.status, 'queued');
  await manager.queue;
  const completed = await manager.status('archive_audit_fixture');
  assert.equal(completed.status, 'completed');
  assert.equal(completed.pagesAudited, 2);
  assert.deepEqual(completed.summary, {
    totalPages: 2, healthyPages: 1, warningPages: 1, errorPages: 0,
    visibleBrokenImages: 0, visiblePendingImages: 0, missingResources: 1,
    boundaryResources: 0, auxiliaryResources: 0, failedRequests: 0, archivedErrorResponses: 0,
    isolationEvents: 0, runtimeAdvisories: 0, runtimeErrors: 0,
    interactionCandidates: 4, interactionsTested: 4, interactionChanges: 2,
    interactionErrors: 0, interactionSkipped: 0, interactionTransient: 2, interactionLimitPages: 0,
    visualCompared: 0, visualMismatchPages: 0, visualAverage: null
  });
  assert.equal(completed.coverage.interactions, true);
  assert.equal(completed.coverage.interactionScope, 'visible-safe-controls');
  assert.equal(completed.coverage.interactionSequences, false);
  assert.equal(completed.coverage.timepoints, 2);
  assert.equal(writes.length, 1);
  assert.equal(manifest.pages.length, 2);
  await manager.shutdown();
});

test('削除前の停止待ちは検査ブラウザが閉じるまで完了を返さない', async () => {
  let stored = null;
  let browserClosed = false;
  let auditStarted;
  const started = new Promise(resolve => { auditStarted = resolve; });
  const store = {
    getArchive: () => ({ id: 'archive_cancel_fixture' }),
    readManifest: async () => ({ pages: [{ url: 'https://example.test/', title: 'Top', html: 'blobs/a' }] }),
    readReplayAudit: async () => stored,
    writeReplayAudit: async (_id, report) => { stored = structuredClone(report); },
    archiveRoot: () => path.join(os.tmpdir(), 'webcapture-replay-audit-cancel-test')
  };
  const manager = new ReplayAuditManager(store, { host: '127.0.0.1', replayPort: 43194 }, {
    browserFactory: async () => ({ client: {}, close: async () => { browserClosed = true; } }),
    auditPage: async (_client, { signal }) => {
      auditStarted();
      await new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => { const error = new Error('stopped'); error.name = 'AbortError'; reject(error); }, { once: true });
      });
    }
  });
  await manager.start('archive_cancel_fixture');
  await started;
  const stopped = await manager.cancelAndWait('archive_cancel_fixture');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(browserClosed, true);
  assert.equal(stored.status, 'cancelled');
  await manager.shutdown();
});
