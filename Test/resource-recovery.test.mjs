import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { recoverEmptyResourceBodies, recoverMissingSrcsetResources } from '../server/crawler.mjs';

test('200系なのに空で取得された素材を安全なHTTP再取得で回復する', async (t) => {
  const expected = Buffer.from('body{color:#123456}');
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/css', 'content-length': expected.length });
    res.end(expected);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/style.css`;
  const failedUrl = 'http://127.0.0.1:9/missing.js';
  const capture = { resources: [
    { url, status: 200, headers: { 'content-type': 'text/css' }, mimeType: 'text/css', type: 'Stylesheet', body: Buffer.alloc(0) },
    { url: failedUrl, status: 200, headers: { 'content-type': 'text/javascript' }, mimeType: 'text/javascript', type: 'Script', body: Buffer.alloc(0) }
  ], blocked: [] };
  await recoverEmptyResourceBodies(capture, { policyOptions: { allowPrivateForTests: true }, responseMaxBytes: null, requestTimeoutMs: 5000 });
  assert.deepEqual(capture.resources[0].body, expected);
  assert.equal(capture.resources.some((item) => item.url === failedUrl), false);
  assert.ok(capture.blocked.some((item) => item.url === failedUrl && item.reason.includes('再取得できません')));
});

test('ブラウザ通信に現れなかった複数行srcset画像候補をHTMLから補完する', async (t) => {
  const server = http.createServer((req, res) => {
    const body = Buffer.from(req.url === '/small.png' ? 'small-image' : 'large-image');
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': body.length });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const capture = {
    url: base,
    html: '<picture><source srcset="\n/small.png 1x,\n/large.png 2x\n"><img src="/large.png"></picture>',
    resources: [], blocked: []
  };
  await recoverMissingSrcsetResources(capture, {
    policyOptions: { allowPrivateForTests: true }, captureSrcsetCandidates: true,
    maxSrcsetCandidates: null, responseMaxBytes: null, requestTimeoutMs: 5000
  });
  assert.deepEqual(capture.resources.map((item) => new URL(item.url).pathname).sort(), ['/large.png', '/small.png']);
  assert.ok(capture.resources.every((item) => item.body.length > 0));
  assert.equal(capture.blocked.length, 0);
});

test('元のサーバーが本当に0バイトを返す素材は、空のファイルとして保存済みに扱い欠落に数えない', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/empty.css') { res.writeHead(200, { 'content-type': 'text/css', 'content-length': 0 }); res.end(); return; }
    res.writeHead(500, { 'content-type': 'text/plain' }); res.end('');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const capture = { resources: [
    { url: `${base}/empty.css`, status: 200, headers: { 'content-type': 'text/css' }, mimeType: 'text/css', type: 'Stylesheet', body: Buffer.alloc(0) },
    { url: `${base}/broken.js`, status: 200, headers: { 'content-type': 'text/javascript' }, mimeType: 'text/javascript', type: 'Script', body: Buffer.alloc(0) }
  ], blocked: [{ url: `${base}/empty.css`, reason: '素材本体を取得できません: No resource with given identifier found' }] };
  await recoverEmptyResourceBodies(capture, { policyOptions: { allowPrivateForTests: true }, responseMaxBytes: null, requestTimeoutMs: 5000 });
  const empty = capture.resources.find((item) => item.url.endsWith('/empty.css'));
  assert.equal(empty?.emptyConfirmed, true);
  assert.equal(empty.body.length, 0);
  assert.equal(capture.blocked.some((item) => item.url.endsWith('/empty.css')), false, '空で正しい素材は失敗として残さない');
  assert.ok(capture.blocked.some((item) => item.url.endsWith('/broken.js')), 'サーバーエラーで空のものは失敗のまま');
  const { unresolvedCaptureFailures, summarizeArchiveQuality } = await import('../server/quality.mjs');
  const manifest = {
    pages: [{ url: `${base}/`, quality: { classification: 'normal', level: 'verified' } }],
    resources: { [`${base}/empty.css`]: { url: `${base}/empty.css`, status: 200, size: 0, emptyConfirmed: true } },
    blocked: [{ url: `${base}/empty.css`, reason: '空の素材本文を再取得できません: 再取得した応答も空でした。' }, { url: 'https://accounts.google.com/gsi/button?x=1', reason: '参照素材を取得できません: HTTP 400' }, { url: 'https://api.x.com/1.1/flow/viewer.json', reason: '空の素材本文を再取得できません: 再取得した応答も空でした。' }],
    referenceAudit: { checkedCount: 1, missingCount: 0 }
  };
  const unresolved = unresolvedCaptureFailures(manifest).map((item) => item.url);
  assert.equal(unresolved.includes(`${base}/empty.css`), false);
  const quality = summarizeArchiveQuality(manifest, { errors: 0 });
  assert.equal(quality.hardBlockedCount, 0, 'ログインが必要な部品は欠落ではなく外部サービスの境界');
  assert.equal(quality.serverBoundaryCount, 2);
});
