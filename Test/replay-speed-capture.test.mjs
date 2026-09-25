import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { VaultStore } from '../server/store.mjs';
import { createReplayHandler, replayCacheTag, warmupList } from '../server/replay.mjs';
import { findSimilarPostResponse, requestBodyLeaves, requestBodyDigests, scorePostCandidate } from '../server/post-archive.mjs';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser, freePort } from '../server/browser-capture.mjs';

const json = (value) => Buffer.from(JSON.stringify(value));

test('送信応答：毎回変わる値は無視し、動画IDや続きの目印が同じ保存済み応答を選ぶ', async () => {
  const bodies = {
    'a.json': zlib.gzipSync(json({ context: { client: { visitorData: 'v1', time: 1 } }, videoId: 'video-one', continuation: 'next-page-1' })),
    'b.json': zlib.gzipSync(json({ context: { client: { visitorData: 'v2', time: 2 } }, videoId: 'video-two', continuation: 'next-page-2' })),
    'c.json': json({ context: { client: { visitorData: 'v3', time: 3 } }, videoId: 'video-one' })
  };
  const entry = (file, extra = {}) => ({ url: 'https://video.example/api/next?pretty=false', method: 'POST', requestFile: file, requestSize: bodies[file].length, requestContentType: 'application/json', file: `answer-${file}`, ...extra });
  const manifest = { postResponses: { a: entry('a.json'), b: entry('b.json'), c: entry('c.json') } };
  const readRequestBody = async (file) => bodies[file];
  const leaves = requestBodyLeaves(zlib.gzipSync(json({ videoId: 'x', nested: { list: [1, 2] } })));
  assert.deepEqual([...leaves], [['videoId', 'x'], ['nested.list.0', '1'], ['nested.list.1', '2']], 'gzipの本文も中身で比べる');
  assert.equal(scorePostCandidate(requestBodyLeaves(json({ videoId: 'a' })), requestBodyLeaves(json({ videoId: 'b' }))), null, 'IDが違う応答は選ばない');

  const replayBody = zlib.gzipSync(json({ context: { client: { visitorData: 'fresh', time: 99 } }, videoId: 'video-two', continuation: 'next-page-2' }));
  const similar = await findSimilarPostResponse(manifest, { url: 'https://video.example/api/next?pretty=false', body: replayBody, readRequestBody });
  assert.equal(similar.entry, manifest.postResponses.b);
  assert.equal(similar.match, 'similar');

  const withoutContinuation = await findSimilarPostResponse(manifest, { url: 'https://video.example/api/next?pretty=false', body: json({ context: { client: { time: 5 } }, videoId: 'video-one' }), readRequestBody });
  assert.equal(withoutContinuation.entry, manifest.postResponses.c, '続きの目印がない最初の問い合わせには、同じく目印がない応答を選ぶ');

  const otherQuery = await findSimilarPostResponse(manifest, { url: 'https://video.example/api/next?key=abc&pretty=false', body: replayBody, readRequestBody });
  assert.equal(otherQuery.entry, manifest.postResponses.b);
  assert.equal(otherQuery.match, 'similar-path', '付け足された鍵などの違いは同じ場所への問い合わせとして扱う');

  const unknown = await findSimilarPostResponse(manifest, { url: 'https://video.example/api/next?pretty=false', body: json({ videoId: 'video-three' }), readRequestBody });
  assert.equal(unknown.entry, null, '保存していない動画の応答は他の動画で代用しない');

  const emptyBody = await findSimilarPostResponse(manifest, { url: 'https://video.example/api/next?pretty=false', body: Buffer.alloc(0), pageUrl: 'https://video.example/watch/video-two', readRequestBody });
  assert.equal(emptyBody.entry, manifest.postResponses.b, '本文が読めない問い合わせは、開いているページのURLにあるIDで選ぶ');
});

test('再生：送信の本文を受け取って近い保存済み応答を返し、素材は内容の指紋付きでキャッシュさせる', { timeout: 30000 }, async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-replay-speed-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = await new VaultStore(root).init();
  const id = 'archive_replay_speed';
  const savedRequest = json({ context: { t: 1 }, videoId: 'abc123' });
  const requestBlob = await store.writeBlob(id, savedRequest);
  const answerBlob = await store.writeBlob(id, json({ ok: 'saved answer' }));
  const otherRequestBlob = await store.writeBlob(id, json({ context: { t: 2 }, videoId: 'zzz999' }));
  const otherAnswerBlob = await store.writeBlob(id, json({ ok: 'other answer' }));
  const scriptA = await store.writeBlob(id, Buffer.from('import "./dep.js"; console.log(1);'));
  const image = await store.writeBlob(id, Buffer.from('fake-image-bytes'));
  const page = await store.writeBlob(id, Buffer.from('<!doctype html><title>t</title>'));
  const post = (requestBlob, answer, digests) => ({ url: 'https://site.example/api', method: 'POST', requestFile: requestBlob.file, requestSize: 30, requestContentType: 'application/json', ...digests, status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' }, file: answer.file, digest: answer.digest, size: answer.size });
  const resource = (url, blob, mimeType) => ({ url, status: 200, mimeType, headers: { 'content-type': mimeType }, ...blob });
  await store.writeManifest(id, {
    id, startUrl: 'https://site.example/', options: {}, resourceAliases: {},
    pages: [{ url: 'https://site.example/', requestedUrl: 'https://site.example/', html: page.file, resources: ['https://site.example/a/app.js', 'https://site.example/b/app.js', 'https://site.example/photo.png'] }],
    resources: {
      'https://site.example/a/app.js': resource('https://site.example/a/app.js', scriptA, 'text/javascript'),
      'https://site.example/b/app.js': resource('https://site.example/b/app.js', scriptA, 'text/javascript'),
      'https://site.example/photo.png': resource('https://site.example/photo.png', image, 'image/png'),
      'https://site.example/movie.mp4': resource('https://site.example/movie.mp4', image, 'video/mp4')
    },
    postResponses: {
      one: post(requestBlob, answerBlob, requestBodyDigests(savedRequest)),
      two: post(otherRequestBlob, otherAnswerBlob, requestBodyDigests(json({ context: { t: 2 }, videoId: 'zzz999' })))
    }
  });
  const replayPort = await freePort();
  const server = http.createServer(createReplayHandler(store, { host: '127.0.0.1', port: 43193, replayPort, iframeParentOrigins: [], version: '9.9.9' }));
  await new Promise((resolve) => server.listen(replayPort, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const base = `http://127.0.0.1:${replayPort}/archive/${id}`;

  const changed = json({ context: { t: 777 }, videoId: 'abc123' });
  const lookup = await fetch(`${base}/post?url=${encodeURIComponent('https://site.example/api')}&digest=${requestBodyDigests(changed).requestDigest}`, { method: 'POST', body: changed, headers: { 'x-webcapture-request-type': 'application/json' } });
  assert.equal(lookup.status, 200);
  assert.equal(lookup.headers.get('x-webcapture-post-match'), 'similar');
  assert.deepEqual(await lookup.json(), { ok: 'saved answer' });
  const oldStyle = await fetch(`${base}/post?url=${encodeURIComponent('https://site.example/api')}&digest=${requestBodyDigests(savedRequest).requestDigest}`);
  assert.equal(oldStyle.headers.get('x-webcapture-post-match'), 'exact', '本文を送らない以前の問い合わせ方も使える');
  assert.equal((await fetch(`${base}/page?url=${encodeURIComponent('https://site.example/')}`, { method: 'POST', body: 'x' })).status, 405, '送信での問い合わせは応答探しだけに限る');

  const imageResponse = await fetch(`${base}/web/https://site.example/photo.png`);
  const imageTag = imageResponse.headers.get('etag');
  assert.equal(imageTag, replayCacheTag({ version: '9.9.9' }, { digest: image.digest, status: 200 }));
  assert.match(imageResponse.headers.get('cache-control'), /max-age=86400/);
  const revalidated = await fetch(`${base}/web/https://site.example/photo.png`, { headers: { 'if-none-match': imageTag } });
  assert.equal(revalidated.status, 304, '同じ内容なら中身を送り直さない');
  const scriptResponse = await fetch(`${base}/web/https://site.example/a/app.js`);
  assert.match(scriptResponse.headers.get('cache-control'), /no-cache/, '書き換えるスクリプトは毎回確認してから使う');
  const scriptText = await scriptResponse.text();
  const otherScriptText = await (await fetch(`${base}/web/https://site.example/b/app.js`)).text();
  assert.match(scriptText, /\/web\/https:\/\/site\.example\/a\/dep\.js/);
  assert.match(otherScriptText, /\/web\/https:\/\/site\.example\/b\/dep\.js/, '同じ中身でも置き場所が違えば別々に書き換える');

  const list = await (await fetch(`${base}/warm-list?url=${encodeURIComponent('https://site.example/')}`)).json();
  assert.deepEqual(list.urls, [`/archive/${id}/web/https://site.example/a/app.js`, `/archive/${id}/web/https://site.example/b/app.js`, `/archive/${id}/web/https://site.example/photo.png`]);
  const warmPage = await (await fetch(`${base}/warm?url=${encodeURIComponent('https://site.example/')}`)).text();
  assert.match(warmPage, /runWarmup/);
  assert.equal(warmupList({ pages: [{ url: 'https://site.example/', resources: ['https://site.example/movie.mp4'] }], resources: { 'https://site.example/movie.mp4': { file: 'x', digest: 'd', status: 200, mimeType: 'video/mp4', size: 10 } } }, id).urls.length, 0, '動画は事前準備で読み込まない');
});

test('保存：ページの保存を終える時点で読み込み途中の素材は待たず、取り直しへ回す（実際のChrome）', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const hanging = new Set();
  const server = http.createServer((req, res) => {
    if (req.url === '/slow.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.write(Buffer.alloc(64)); hanging.add(res); return; }
    if (req.url === '/fast.svg') { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Slow</title><img src="/fast.svg"><p>本文</p><script>setTimeout(()=>{const i=new Image();i.src="/slow.png";document.body.append(i)},200)</script>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const res of hanging) res.destroy(); server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(async () => { const closing = Date.now(); await session.close(); assert.ok(Date.now() - closing < 20000, '保存用ブラウザを閉じるのに時間がかかりすぎる'); });
  const started = Date.now();
  const capture = await captureWithBrowser(`http://127.0.0.1:${server.address().port}/`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 60000, screenshotMode: 'none',
    interactDuringCapture: false, hoverDuringCapture: false, networkIdleMs: 500, networkIdleMaxMs: 1500
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 20000, `読み込み途中の素材で30秒待たされた: ${elapsed}ms`);
  assert.ok(capture.resources.some((item) => item.url.endsWith('/fast.svg') && item.body.length > 0));
  const slow = capture.resources.find((item) => item.url.endsWith('/slow.png'));
  assert.ok(slow, '途中の素材も取り直し対象として残す');
  assert.equal(slow.body.length, 0);
});
