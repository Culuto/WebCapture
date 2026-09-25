import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser, freePort } from '../server/browser-capture.mjs';
import { VaultStore } from '../server/store.mjs';
import { createReplayHandler } from '../server/replay.mjs';
import { findPostResponse, postResponseKey, requestBodyDigests } from '../server/post-archive.mjs';

test('送信応答は本文のハッシュで照合し、キー順だけ違うJSONも同じ応答として扱う', () => {
  const saved = requestBodyDigests(Buffer.from('{"query":"items","variables":{"a":1,"b":2}}'));
  const reordered = requestBodyDigests(Buffer.from('{"variables":{"b":2,"a":1},"query":"items"}'));
  assert.notEqual(saved.requestDigest, reordered.requestDigest);
  assert.equal(saved.canonicalDigest, reordered.canonicalDigest);
  const manifest = { postResponses: {
    [postResponseKey('POST', 'https://api.example/graphql', saved.requestDigest)]: { method: 'POST', url: 'https://api.example/graphql', ...saved, file: 'a' },
    [postResponseKey('POST', 'https://api.example/graphql', 'f'.repeat(64))]: { method: 'POST', url: 'https://api.example/graphql', requestDigest: 'f'.repeat(64), canonicalDigest: null, file: 'b' },
    [postResponseKey('POST', 'https://api.example/single', 'e'.repeat(64))]: { method: 'POST', url: 'https://api.example/single', requestDigest: 'e'.repeat(64), canonicalDigest: null, file: 'c' }
  } };
  assert.equal(findPostResponse(manifest, { url: 'https://api.example/graphql', digest: saved.requestDigest }).match, 'exact');
  assert.equal(findPostResponse(manifest, { url: 'https://api.example/graphql', digest: reordered.requestDigest, canonical: reordered.canonicalDigest }).entry.file, 'a');
  assert.equal(findPostResponse(manifest, { url: 'https://api.example/graphql', digest: '0'.repeat(64) }).match, 'ambiguous');
  assert.equal(findPostResponse(manifest, { url: 'https://api.example/single', digest: '0'.repeat(64) }).match, 'only-response');
  assert.equal(findPostResponse(manifest, { url: 'https://api.example/none' }).entry, null);
});

test('ページが読み込み時に送るPOSTを保存し、再生では保存した応答をページへ返す', { timeout: 120000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const live = http.createServer((req, res) => {
    if (req.url === '/graphql' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const query = JSON.parse(body).query;
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ items: query === 'fruits' ? ['りんご', 'みかん'] : [] }));
      });
      return;
    }
    if (req.url === '/order' && req.method === 'POST') { res.writeHead(500); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Post page</title><body><ul id="out"></ul><form method="post" action="/order"><button>注文</button></form><script>fetch("/graphql",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({query:"fruits",variables:{b:2,a:1}})}).then(r=>r.json()).then(d=>{out.textContent=d.items.join(",");document.body.dataset.postOk=String(Number(document.body.dataset.postOk||0)+1)})</script></body>');
  });
  await new Promise((resolve) => live.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => live.close(resolve)));
  const pageUrl = `http://127.0.0.1:${live.address().port}/`;
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const capture = await captureWithBrowser(pageUrl, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none', interactDuringCapture: false, networkIdleMs: 500
  });
  assert.match(capture.html, /<ul id="out">りんご,みかん<\/ul>/);
  assert.match(capture.html, /data-post-ok="1"/);
  const post = capture.resources.find((item) => item.method === 'POST');
  assert.ok(post, capture.resources.map((item) => `${item.method || 'GET'} ${item.url}`).join(', '));
  assert.equal(post.url, `${pageUrl}graphql`);
  assert.equal(JSON.parse(post.requestBody.toString('utf8')).query, 'fruits');
  assert.equal(JSON.parse(post.body.toString('utf8')).items[0], 'りんご');

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-post-replay-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const id = 'archive_post_replay_test';
  const html = await store.writeBlob(id, Buffer.from(capture.html));
  const body = await store.writeBlob(id, post.body);
  const digests = requestBodyDigests(post.requestBody);
  await store.writeManifest(id, {
    id, startUrl: pageUrl, options: {}, resources: {}, resourceAliases: {},
    pages: [{ url: pageUrl, requestedUrl: pageUrl, html: html.file }],
    postResponses: { [postResponseKey('POST', post.url, digests.requestDigest)]: { url: post.url, method: 'POST', ...digests, status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, mimeType: 'application/json; charset=utf-8', ...body } }
  });
  const replayPort = await freePort();
  const replay = http.createServer(createReplayHandler(store, { host: '127.0.0.1', port: 1, replayPort }));
  await new Promise((resolve) => replay.listen(replayPort, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => replay.close(resolve)));
  live.close();
  const replayed = await captureWithBrowser(`http://127.0.0.1:${replayPort}/archive/${id}/page?url=${encodeURIComponent(pageUrl)}`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none', interactDuringCapture: false, networkIdleMs: 500
  });
  assert.match(replayed.html, /data-post-ok="2"/, '再生時のPOSTにも保存済み応答が返る');
  assert.match(replayed.html, /<ul id="out">りんご,みかん<\/ul>/);
  assert.ok(replayed.resources.some((item) => item.url.includes('/post?url=') && item.status === 200));
});
