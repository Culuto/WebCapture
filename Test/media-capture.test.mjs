import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { completeMediaResources, parseDashManifest, parseHlsPlaylist } from '../server/media-capture.mjs';
import { captureFile, looksLikeFileUrl } from '../server/crawler.mjs';

function fakeFetcher(files, requests = []) {
  return async (url, options = {}) => {
    requests.push(url);
    const file = files[url];
    if (!file) throw new Error('HTTP 404');
    const max = options.responseMaxBytes === null ? null : options.responseMaxBytes;
    if (max !== null && max !== undefined && file.body.length > max) throw new Error('1件の取得上限を超えています。');
    return {
      finalUrl: url,
      response: {
        status: 200, ok: true, headers: new Headers({ 'content-type': file.type, 'content-length': String(file.body.length) }),
        arrayBuffer: async () => file.body
      }
    };
  };
}

test('PDFや動画へのリンクをファイルとして保存し、上限を超えるものは後から保存できるよう記録する', async (t) => {
  assert.equal(looksLikeFileUrl('https://example.com/docs/manual.PDF'), true);
  assert.equal(looksLikeFileUrl('https://example.com/files/%E8%B3%87%E6%96%99.xlsx'), true);
  assert.equal(looksLikeFileUrl('https://example.com/products/item'), false);
  assert.equal(looksLikeFileUrl('https://example.com/blog/pdf-guide'), false);
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': req.url.endsWith('.pdf') ? 'application/pdf' : 'video/mp4' });
    res.end(req.url.endsWith('.pdf') ? '%PDF-1.4' : Buffer.alloc(4096));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const options = { policyOptions: { allowPrivateForTests: true }, requestTimeoutMs: 10000 };
  const pdf = await captureFile(`${base}/manual.pdf`, { ...options, mediaMaxBytes: null });
  assert.equal(pdf.fileDocument, true);
  assert.equal(pdf.title, 'manual.pdf');
  assert.equal(pdf.resources[0].body.toString(), '%PDF-1.4');
  const big = await captureFile(`${base}/movie.mp4`, { ...options, mediaMaxBytes: 1000 });
  assert.equal(big.resources.length, 0);
  assert.equal(big.deferredMedia[0].url, `${base}/movie.mp4`);
  assert.equal(big.deferredMedia[0].kind, 'file');
});

test('HLSの親リスト・子リスト・暗号鍵・初期化分割を読み取る', () => {
  const master = parseHlsPlaylist('#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio/index.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow/index.m3u8\n', 'https://cdn.example/video/master.m3u8');
  assert.deepEqual(master.playlists.sort(), ['https://cdn.example/video/audio/index.m3u8', 'https://cdn.example/video/low/index.m3u8']);
  const media = parseHlsPlaylist('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:4,\nseg1.ts\n#EXTINF:4,\nhttps://other.example/seg2.ts\n#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://drm"\n', 'https://cdn.example/video/low/index.m3u8');
  assert.deepEqual(media.segments, ['https://cdn.example/video/low/key.bin', 'https://cdn.example/video/low/init.mp4', 'https://cdn.example/video/low/seg1.ts', 'https://other.example/seg2.ts']);
});

test('DASHのSegmentTemplate・SegmentTimeline・SegmentListから分割ファイルを列挙する', () => {
  const template = parseDashManifest(`<MPD mediaPresentationDuration="PT10S"><Period><AdaptationSet><SegmentTemplate media="v/$RepresentationID$/$Number%03d$.m4s" initialization="v/$RepresentationID$/init.mp4" duration="4" timescale="1" startNumber="1"/><Representation id="720" bandwidth="1"/></AdaptationSet></Period></MPD>`, 'https://cdn.example/a/manifest.mpd');
  assert.deepEqual(template.segments, ['https://cdn.example/a/v/720/init.mp4', 'https://cdn.example/a/v/720/001.m4s', 'https://cdn.example/a/v/720/002.m4s', 'https://cdn.example/a/v/720/003.m4s']);
  const timeline = parseDashManifest(`<MPD><Period><AdaptationSet><Representation id="a"><SegmentTemplate media="$Time$.m4s" timescale="10"><SegmentTimeline><S t="0" d="20" r="1"/><S d="5"/></SegmentTimeline></SegmentTemplate></Representation></AdaptationSet></Period></MPD>`, 'https://cdn.example/b/m.mpd');
  assert.deepEqual(timeline.segments, ['https://cdn.example/b/0.m4s', 'https://cdn.example/b/20.m4s', 'https://cdn.example/b/40.m4s']);
  const list = parseDashManifest(`<MPD><BaseURL>https://media.example/x/</BaseURL><Period><AdaptationSet><Representation id="r"><SegmentList><Initialization sourceURL="i.mp4"/><SegmentURL media="1.m4s"/><SegmentURL media="2.m4s"/></SegmentList></Representation></AdaptationSet></Period></MPD>`, 'https://cdn.example/c/m.mpd');
  assert.deepEqual(list.segments, ['https://media.example/x/i.mp4', 'https://media.example/x/1.m4s', 'https://media.example/x/2.m4s']);
});

test('部分取得の動画は全体を取り直し、上限を超えるものは未保存として記録する', async () => {
  const small = Buffer.alloc(3000, 1);
  const large = Buffer.alloc(9000, 2);
  const capture = {
    url: 'https://site.example/',
    resources: [
      { url: 'https://site.example/small.mp4', status: 206, headers: { 'content-range': 'bytes 0-999/3000', 'content-type': 'video/mp4' }, mimeType: 'video/mp4', type: 'Media', body: small.subarray(0, 1000) },
      { url: 'https://site.example/large.mp4', status: 206, headers: { 'content-range': 'bytes 0-999/9000', 'content-type': 'video/mp4' }, mimeType: 'video/mp4', type: 'Media', body: large.subarray(0, 1000) },
      { url: 'https://site.example/unknown.webm', status: 206, headers: { 'content-type': 'video/webm' }, mimeType: 'video/webm', type: 'Media', body: Buffer.alloc(10) }
    ],
    blocked: []
  };
  const requests = [];
  await completeMediaResources(capture, { mediaMaxBytes: 5000 }, fakeFetcher({
    'https://site.example/small.mp4': { type: 'video/mp4', body: small },
    'https://site.example/large.mp4': { type: 'video/mp4', body: large },
    'https://site.example/unknown.webm': { type: 'video/webm', body: Buffer.alloc(8000) }
  }, requests));
  const smallResource = capture.resources.find((item) => item.url.endsWith('/small.mp4'));
  assert.equal(smallResource.status, 200);
  assert.equal(smallResource.body.length, 3000);
  assert.ok(!requests.includes('https://site.example/large.mp4'), '全体サイズが分かっている超過動画は取得しない');
  assert.deepEqual(capture.deferredMedia.map((item) => item.url).sort(), ['https://site.example/large.mp4', 'https://site.example/unknown.webm']);
  assert.equal(capture.deferredMedia.find((item) => item.url.endsWith('large.mp4')).expectedBytes, 9000);
  assert.ok(capture.blocked.some((item) => item.url.endsWith('large.mp4') && /上限（/.test(item.reason)));
});

test('配信形式は全分割ファイルを保存し、上限に達した残りを後から保存できる形で残す', async () => {
  const files = {
    'https://cdn.example/v/low.m3u8': { type: 'application/vnd.apple.mpegurl', body: Buffer.from('#EXTM3U\n#EXTINF:4,\n1.ts\n#EXTINF:4,\n2.ts\n#EXTINF:4,\n3.ts\n') },
    'https://cdn.example/v/1.ts': { type: 'video/mp2t', body: Buffer.alloc(400) },
    'https://cdn.example/v/2.ts': { type: 'video/mp2t', body: Buffer.alloc(400) },
    'https://cdn.example/v/3.ts': { type: 'video/mp2t', body: Buffer.alloc(400) }
  };
  const capture = {
    resources: [{ url: 'https://cdn.example/v/master.m3u8', status: 200, headers: {}, mimeType: 'application/vnd.apple.mpegurl', type: 'Media', body: Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nlow.m3u8\n') }],
    blocked: []
  };
  await completeMediaResources(capture, { mediaMaxBytes: 900 }, fakeFetcher(files));
  const saved = capture.resources.map((item) => item.url);
  assert.ok(saved.includes('https://cdn.example/v/low.m3u8'));
  assert.ok(saved.includes('https://cdn.example/v/1.ts') && saved.includes('https://cdn.example/v/2.ts'));
  assert.ok(!saved.includes('https://cdn.example/v/3.ts'));
  assert.equal(capture.deferredMedia.length, 1);
  assert.equal(capture.deferredMedia[0].kind, 'stream');
  assert.deepEqual(capture.deferredMedia[0].remainingUrls, ['https://cdn.example/v/3.ts']);
  const unlimited = { resources: [{ ...capture.resources[0] }], blocked: [] };
  await completeMediaResources(unlimited, { mediaMaxBytes: null }, fakeFetcher(files));
  assert.ok(unlimited.resources.some((item) => item.url.endsWith('/3.ts')));
  assert.deepEqual(unlimited.deferredMedia, []);
});
