import test from 'node:test';
import assert from 'node:assert/strict';
import { applyQueryPolicy, documentUrlAllowed, resourceTypeAllowed, sanitizeCaptureOptions } from '../server/capture-options.mjs';

test('保存設定は範囲内へ正規化し、未指定値は後方互換の既定値を使う', () => {
  const options = sanitizeCaptureOptions({
    concurrency: 99, discoveryConcurrency: 0, screenshotMode: 'invalid', requestTimeoutMs: 1,
    includeUrlPatterns: ['https://example.com/docs/*', 'https://example.com/docs/*'],
    resourceTypes: { media: false }, externalMaxDepth: 0
  });
  assert.equal(options.concurrency, 30);
  assert.equal(options.optimize, false);
  assert.equal(sanitizeCaptureOptions({ optimize: true }).optimize, true);
  assert.equal(options.discoveryConcurrency, 1);
  assert.equal(sanitizeCaptureOptions({ concurrency: 30, discoveryConcurrency: 64 }).concurrency, 30);
  assert.equal(sanitizeCaptureOptions({ discoveryConcurrency: 99 }).discoveryConcurrency, 99);
  assert.equal(sanitizeCaptureOptions({ discoveryConcurrency: 999 }).discoveryConcurrency, 256, '把握だけなら同時256まで');
  assert.equal(options.screenshotMode, 'viewport');
  assert.equal(options.requestTimeoutMs, 3000);
  assert.equal(options.externalMaxDepth, 0);
  assert.deepEqual(options.includeUrlPatterns, ['https://example.com/docs/*']);
  assert.equal(options.resourceTypes.media, false);
  assert.equal(options.resourceTypes.image, true);
});

test('query方針とURLパターンを文書巡回へ適用する', () => {
  assert.equal(applyQueryPolicy('https://example.com/a?utm_source=x&page=2', 'drop-tracking'), 'https://example.com/a?page=2');
  assert.equal(applyQueryPolicy('https://example.com/a?page=2', 'drop-all'), 'https://example.com/a');
  const options = { includeUrlPatterns: ['https://example.com/docs/*'], excludeUrlPatterns: ['*/private/*'] };
  assert.equal(documentUrlAllowed('https://example.com/docs/start', options), true);
  assert.equal(documentUrlAllowed('https://example.com/docs/private/a', options), false);
  assert.equal(documentUrlAllowed('https://example.com/blog/a', options), false);
  assert.equal(documentUrlAllowed('https://example.com/docs/item?view=full', { includeUrlPatterns: ['https://example.com/docs/*?view=*'], excludeUrlPatterns: [] }), true);
  assert.equal(documentUrlAllowed('https://example.com/docs/itemXview=full', { includeUrlPatterns: ['https://example.com/docs/*?view=*'], excludeUrlPatterns: [] }), false);
});

test('素材種別フィルターは文書を常に許可する', () => {
  const types = { stylesheet: true, script: false, image: true, media: false, font: true, xhr: false, other: false };
  assert.equal(resourceTypeAllowed('Document', types), true);
  assert.equal(resourceTypeAllowed('Script', types), false);
  assert.equal(resourceTypeAllowed('Image', types), true);
  assert.equal(resourceTypeAllowed('Fetch', types), false);
});

test('高精度設定の制限なしはnullのまま保持する', () => {
  const options = sanitizeCaptureOptions({
    maxPages: null, maxBytes: null, maxDurationMs: null, sameSiteWarningDepth: null,
    sameSiteMaxDepth: null, externalWarningDepth: null, externalMaxDepth: null,
    responseMaxBytes: null, pageMaxBytes: null, maxRedirects: null,
    maxLinksPerPage: null, maxResourcesPerPage: null, maxSrcsetCandidates: null
  });
  for (const key of ['maxPages','maxBytes','maxDurationMs','sameSiteWarningDepth','sameSiteMaxDepth','externalWarningDepth','externalMaxDepth','responseMaxBytes','pageMaxBytes','maxRedirects','maxLinksPerPage','maxResourcesPerPage','maxSrcsetCandidates']) {
    assert.equal(options[key], null, key);
  }
});
