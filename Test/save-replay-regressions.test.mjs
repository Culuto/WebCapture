import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { VaultStore } from '../server/store.mjs';
import { CrawlManager } from '../server/crawler.mjs';
import { DEFAULT_CAPTURE_OPTIONS } from '../server/capture-options.mjs';
import { rewriteJavaScript, rewriteCss, rewriteHtml, createReplayHandler, findTypekitCompleteFontFallback, auxiliaryReplayResponse, serverBoundaryReplayResponse } from '../server/replay.mjs';
import { parseSrcset } from '../server/srcset.mjs';
import { htmlAssetReferences, referenceAudit } from '../server/asset-references.mjs';
import { classifyCapturedPage, completionStatus, summarizeArchiveQuality } from '../server/quality.mjs';
import { replayState, applyReplayMessage, replayStateLabel, isReplayMessageCurrent, appendReplayHistory } from '../public/replay-state.js';
import { createWarcAsync } from '../server/warc.mjs';
import { gunzipSync } from 'node:zlib';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runInNewContext } from 'node:vm';

const execute = promisify(execFile);

test('再生で戻った後に以前のリンクを開き直すと、履歴位置を進めて古い進む先を除く', () => {
  const home = 'https://example.com/', product = 'https://example.com/product', faq = 'https://example.com/faq';
  const initial = appendReplayHistory([], -1, home);
  assert.deepEqual(initial, { history: [home], index: 0 });
  const savedHistory = [home, product, faq];
  const reopened = appendReplayHistory(savedHistory, 0, faq);
  assert.deepEqual(reopened, { history: [home, faq], index: 1 });
  assert.deepEqual(savedHistory, [home, product, faq]);
  assert.deepEqual(appendReplayHistory([home, product], 0, product), { history: [home, product], index: 1 });
  assert.deepEqual(appendReplayHistory(savedHistory, 1, product), { history: savedHistory, index: 1 });
  assert.deepEqual(appendReplayHistory([home, product], 1, `${product}#details`), { history: [home, product, `${product}#details`], index: 2 });
});

test('埋め込み再生のリンク・フォーム通知は直接の親へ届き、元サイトのURLを保持する', () => {
  const messages = [], outerMessages = [], handlers = new Map(), workers = [];
  class Element { getAttribute() { return null; } setAttribute() {} }
  const window = { Worker: class { constructor(url) { workers.push(url); } } };
  const context = {
    window, Element, URL, location: { href: 'http://127.0.0.1:43194/archive/archive_test/page', origin: 'http://127.0.0.1:43194' },
    parent: { postMessage: message => messages.push(message) }, top: { postMessage: message => outerMessages.push(message) },
    history: { pushState() {}, replaceState() {} },
    document: { addEventListener: (name, handler) => handlers.set(name, handler) }, addEventListener() {},
    FormData: class { forEach(handler) { handler('archive', 'q'); } }
  };
  const html = rewriteHtml('<head></head><main>Page</main>', 'https://example.com/article', 'archive_test', {}, 'nav-7');
  runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], context);
  let prevented = 0;
  handlers.get('click')({ target: { closest: () => ({ getAttribute: () => '/next' }) }, preventDefault: () => prevented++ });
  handlers.get('submit')({ target: { method: 'get', action: 'http://127.0.0.1:43194/search', getAttribute: name => name === 'data-webcapture-action' ? '/search' : '#' }, preventDefault: () => prevented++ });
  handlers.get('submit')({ target: { method: 'post' }, preventDefault: () => prevented++ });
  assert.equal(messages[0].url, 'https://example.com/next');
  assert.equal(messages[1].url, 'https://example.com/search?q=archive');
  assert.equal(messages[2].type, 'webcapture-blocked');
  assert.ok(messages.every(message => message.archiveId === 'archive_test'));
  assert.ok(messages.every(message => message.navigationId === 'nav-7'));
  assert.equal(outerMessages.length, 0);
  assert.equal(prevented, 3);
  window.open('http://127.0.0.1:43194/local-path?version=1#details');
  assert.equal(messages.at(-1).url, 'https://example.com/local-path?version=1#details');
  new window.Worker('http://127.0.0.1:43194/workers/main.js');
  assert.equal(workers[0], '/archive/archive_test/web/https://example.com/workers/main.js');
});

test('拡大画像用URLを取得対象と再生対象にし、GETフォームの原移動先を残す', () => {
  const input = '<form method="get" action="/search?type=product&amp;sort=title"><img src="/small.jpg" data_max_resolution="/large.jpg"></form>';
  assert.deepEqual(htmlAssetReferences(input, 'https://example.com/').sort(), ['https://example.com/large.jpg', 'https://example.com/small.jpg']);
  const html = rewriteHtml(input, 'https://example.com/', 'archive_test');
  assert.match(html, /data_max_resolution="\/archive\/archive_test\/web\/https:\/\/example.com\/large.jpg"/);
  assert.ok(html.includes('data-webcapture-action="/search?type=product&amp;sort=title" action="#"'));
});

async function temporaryStore(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'webcapture-save-regressions-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return new VaultStore(root).init();
}

test('module/CSSの変換は正確で冪等、SVGのfragmentを残す', () => {
  const mapped = '/archive/archive_test/web/https://example.com/assets/dep.js';
  for (const [source, expected] of [
    ['import {x} from "./dep.js";', `import {x} from "${mapped}";`],
    ['import"./dep.js";', `import"${mapped}";`],
    ['export{x}from"./dep.js";', `export{x}from"${mapped}";`],
    ['import("./dep.js")', `import("${mapped}")`]
  ]) {
    const result = rewriteJavaScript(source, 'https://example.com/assets/main.js', 'archive_test');
    assert.equal(result, expected);
    assert.equal(rewriteJavaScript(result, 'https://example.com/assets/main.js', 'archive_test'), result);
  }
  assert.equal(rewriteJavaScript('import "@theme/component";', 'https://example.com/', 'archive_test'), 'import "@theme/component";');
  const css = rewriteCss('.icon{background:url(../sprite.svg#arrow)}@import "theme.css";', 'https://example.com/assets/main.css', 'archive_test');
  assert.ok(css.includes('web/https://example.com/sprite.svg#arrow'));
  assert.equal(rewriteCss(css, 'https://example.com/assets/main.css', 'archive_test'), css);
});

test('data画像のカンマと混在するsrcset候補を壊さない', () => {
  const data = 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=';
  const candidates = `${data} 1x, /large.png 2x`;
  assert.deepEqual(parseSrcset(candidates), [{ url: data, descriptor: '1x' }, { url: '/large.png', descriptor: '2x' }]);
  const html = `<img srcset="${candidates}" data-srcset="/a.png 320w, /b.png 640w">`;
  const rewritten = rewriteHtml(html, 'https://example.com/', 'archive_test');
  assert.ok(rewritten.includes(`srcset="${data} 1x, /archive/archive_test/web/https://example.com/large.png 2x"`));
  assert.ok(rewritten.includes('data-srcset="/archive/archive_test/web/https://example.com/a.png 320w'));
  assert.deepEqual(htmlAssetReferences(html, 'https://example.com/').sort(), ['https://example.com/a.png', 'https://example.com/b.png', 'https://example.com/large.png']);
});

test('base要素の相対URLを削除前の基準で解決する', () => {
  const html = '<head><base href="https://example.com/assets/"><link rel="stylesheet" href="theme.css"></head><img src="image.png"><script type="module">import "./chunk.js"</script>';
  const output = rewriteHtml(html, 'https://example.com/pages/article', 'archive_test');
  assert.ok(output.includes('web/https://example.com/assets/theme.css'));
  assert.ok(output.includes('web/https://example.com/assets/image.png'));
  assert.ok(output.includes('web/https://example.com/assets/chunk.js'));
  assert.deepEqual(htmlAssetReferences(html, 'https://example.com/pages/article').sort(), ['https://example.com/assets/image.png', 'https://example.com/assets/theme.css']);
});

test('画像固定は保存時オプションを尊重し、動的src/srcsetの更新にも適用する', () => {
  const html = '<img data-webcapture-current-src="https://example.com/captured.png" src="https://example.com/captured.png">';
  const fixed = rewriteHtml(html, 'https://example.com/', 'archive_test', { freezeResponsiveImages: true });
  const responsive = rewriteHtml(html, 'https://example.com/', 'archive_test', { freezeResponsiveImages: false });
  assert.match(fixed, /const freezeImages=true/);
  assert.match(responsive, /const freezeImages=false/);
  assert.match(fixed, /if\(key.endsWith\('srcset'\)\)return ''/);
  assert.match(fixed, /saved\(element.getAttribute\('data-webcapture-current-src'\)\)/);
  assert.match(fixed, /__webcaptureRealShadowRoot\(this\):this\.shadowRoot\)\|\|nativeAttachShadow\.call\(this,init\)/);
});

test('通信のエラー状態、HEAD、部分取得、欠落ページ通知を再現する', async (t) => {
  const store = await temporaryStore(t);
  const id = 'archive_http_test';
  const manifest = { id, startUrl: 'https://example.com/', pages: [], resources: {}, resourceAliases: {} };
  for (const [name, status, content] of [['image', 200, '0123456789abcdef'], ['forbidden', 403, ''], ['method', 405, 'not allowed'], ['empty', 204, '']]) {
    const blob = await store.writeBlob(id, Buffer.from(content));
    const url = `https://example.com/${name}`;
    manifest.resources[url] = { ...blob, url, status, mimeType: 'application/octet-stream' };
  }
  const fullFontUrl = 'https://use.typekit.net/af/font-id/family/31/m?features=ALL&v=4&chunks=0&order=0';
  const fullFont = await store.writeBlob(id, Buffer.from('complete-font-body'));
  manifest.resources[fullFontUrl] = { ...fullFont, url: fullFontUrl, status: 200, mimeType: 'font/opentype' };
  assert.equal(findTypekitCompleteFontFallback(manifest, 'https://use.typekit.net/af/font-id/family/31/m?features=ALL&v=4&chunks=7.22&order=0')?.url, fullFontUrl);
  await store.writeManifest(id, manifest);
  const config = { host: '127.0.0.1', replayPort: 0, port: 12345 };
  const handler = createReplayHandler(store, config);
  const server = http.createServer((req, res) => handler(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, config.host, resolve));
  config.replayPort = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://${config.host}:${config.replayPort}/archive/${id}`;
  const url = name => `${base}/resource?url=${encodeURIComponent(`https://example.com/${name}`)}`;
  const forbidden = await fetch(url('forbidden'));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.headers.get('x-webcapture-archived-status'), '403', '保存時点のエラー応答であることを検査側が区別できる');
  assert.equal(forbidden.headers.get('x-webcapture-missing-resource'), null);
  assert.equal((await fetch(url('method'))).status, 405);
  assert.equal((await fetch(url('image'))).headers.get('x-webcapture-archived-status'), null);
  assert.equal((await fetch(url('empty'))).status, 204);
  const range = await fetch(url('image'), { headers: { range: 'bytes=0-9' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 0-9/16');
  assert.equal(await range.text(), '0123456789');
  const suffix = await fetch(url('image'), { headers: { range: 'bytes=-3' } });
  assert.equal(await suffix.text(), 'def');
  const unsatisfiable = await fetch(url('image'), { headers: { range: 'bytes=100-' } });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */16');
  const changed = await fetch(url('image'), { headers: { range: 'bytes=0-1', 'if-range': '"different"' } });
  assert.equal(changed.status, 200);
  const head = await fetch(url('image'), { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), '16');
  assert.equal(await head.text(), '');
  const fontFallback = await fetch(`${base}/resource?url=${encodeURIComponent('https://use.typekit.net/af/font-id/family/31/m?features=ALL&v=4&chunks=7.22&order=0')}`);
  assert.equal(fontFallback.status, 200);
  assert.equal(fontFallback.headers.get('x-webcapture-resource-fallback'), 'complete-font');
  assert.equal(await fontFallback.text(), 'complete-font-body');
  const missing = await fetch(`${base}/page?url=https%3A%2F%2Fexample.com%2Fmissing`);
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get('x-webcapture-missing-page'), '1');
  assert.match(await missing.text(), /webcapture-page-error/);
  const file = manifest.resources['https://example.com/image'].file;
  await fs.rm(path.join(store.archiveRoot(id), file));
  assert.equal((await fetch(url('image'))).status, 404);
  assert.equal((await store.readRuntimeMisses(id)).unique, 1);
  store.setReplayMissSuppressed(id, true);
  await store.recordReplayMiss(id, 'https://example.com/audit-only.js');
  store.setReplayMissSuppressed(id, false);
  assert.equal((await store.readRuntimeMisses(id)).unique, 1);
});

test('保存再生では外部計測コードだけを無害化し、欠落記録を増やさない', async (t) => {
  assert.equal(auxiliaryReplayResponse('https://example.com/theme.js'), null);
  assert.match(auxiliaryReplayResponse('https://example.com/cdn/wpm/build.js')?.body.toString(), /webPixelsManager/);
  assert.match(auxiliaryReplayResponse('https://example.com/web-pixels@abc/custom/pixel/sandbox/modern/page')?.contentType, /^text\/html/);
  assert.equal(auxiliaryReplayResponse('https://p.typekit.net/p.gif?x=1')?.contentType, 'image/gif');

  const store = await temporaryStore(t);
  const id = 'archive_auxiliary_test';
  await store.writeManifest(id, { id, startUrl: 'https://example.com/', pages: [], resources: {}, resourceAliases: {} });
  const config = { host: '127.0.0.1', replayPort: 0, port: 12345 };
  const handler = createReplayHandler(store, config);
  const server = http.createServer((req, res) => handler(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, config.host, resolve));
  config.replayPort = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const target = 'https://example.com/web-pixels@abc/custom/pixel/sandbox/modern/page';
  const response = await fetch(`http://${config.host}:${config.replayPort}/archive/${id}/resource?url=${encodeURIComponent(target)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-webcapture-auxiliary-disabled'), '1');
  assert.match(response.headers.get('content-type'), /^text\/html/);
  assert.equal((await store.readRuntimeMisses(id)).unique, 0);
});

test('保存再生では決済と認証の外部境界をローカル応答へ分離する', async (t) => {
  assert.equal(serverBoundaryReplayResponse('https://example.com/theme.js'), null);
  assert.match(serverBoundaryReplayResponse('https://shop.app/checkouts/internal/preloads.js')?.contentType, /^text\/javascript/);
  assert.match(serverBoundaryReplayResponse('https://shop.app/pay/session?v=1')?.contentType, /^application\/json/);
  assert.match(serverBoundaryReplayResponse('https://shop.app/pay/hop')?.contentType, /^text\/html/);

  const store = await temporaryStore(t);
  const id = 'archive_boundary_test';
  await store.writeManifest(id, { id, startUrl: 'https://example.com/', pages: [], resources: {}, resourceAliases: {} });
  const config = { host: '127.0.0.1', replayPort: 0, port: 12345 };
  const handler = createReplayHandler(store, config);
  const server = http.createServer((req, res) => handler(req, res).catch(error => { res.writeHead(500); res.end(error.message); }));
  await new Promise(resolve => server.listen(0, config.host, resolve));
  config.replayPort = server.address().port;
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const target = 'https://shop.app/checkouts/internal/preloads.js?locale=ja-JP';
  const response = await fetch(`http://${config.host}:${config.replayPort}/archive/${id}/resource?url=${encodeURIComponent(target)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-webcapture-server-boundary'), '1');
  assert.match(response.headers.get('content-type'), /^text\/javascript/);
  assert.equal((await store.readRuntimeMisses(id)).unique, 0);
});

test('解説記事をErrorだけで失敗にせず、回復済み素材と未検査を区別する', () => {
  const page = { url: 'https://example.com/', title: 'Error handling guide', html: '<main>Error handling documentation</main>', resources: [{ url: 'https://example.com/', type: 'Document', status: 200 }] };
  assert.equal(classifyCapturedPage(page).classification, 'normal');
  assert.equal(classifyCapturedPage({ ...page, title: '404 Not Found' }).classification, 'error-page');
  const manifest = { pages: [{ title: 'Article' }], blocked: [{ url: 'https://example.com/font.woff2', reason: '読み込みに失敗 ERR_ABORTED' }], resources: { 'https://example.com/font.woff2': { status: 200, size: 50 } } };
  const unchecked = summarizeArchiveQuality(manifest);
  assert.equal(unchecked.hardBlockedCount, 0);
  assert.equal(unchecked.referenceChecked, false);
  assert.notEqual(unchecked.level, 'verified');
  assert.equal(summarizeArchiveQuality({ ...manifest, referenceAudit: { checkedCount: 1, missingCount: 0 } }).level, 'verified');
});

test('決済・認証境界と計測用通信を表示欠落から分離する', () => {
  const manifest = {
    pages: [{ title: 'Store', quality: { classification: 'normal' } }],
    blocked: [
      { url: 'https://shop.app/accounts/pre_auth', reason: '素材本体を取得できません' },
      { url: 'https://shop.app/accounts/pre_auth', reason: '再取得した応答も空でした' },
      { url: 'https://example.com/missing.css', reason: '素材の読み込みに失敗 ERR_FAILED' }
    ],
    resources: {}, referenceAudit: { checkedCount: 2, missingCount: 0 }
  };
  const quality = summarizeArchiveQuality(manifest, {}, { items: [
    { url: 'https://shop.app/pay/session' },
    { url: 'https://shop.app/checkouts/internal/preloads.js' },
    { url: 'https://example.com/cdn/wpm/pixel.js' },
    { url: 'https://example.com/web-pixels@abc/custom/pixel/sandbox/modern/page' },
    { url: 'https://example.com/missing.js' }
  ] });
  assert.equal(quality.hardBlockedCount, 1);
  assert.equal(quality.serverBoundaryCount, 3);
  assert.equal(quality.auxiliaryRuntimeMissingCount, 2);
  assert.equal(quality.runtimeMissingCount, 1);
  assert.equal(quality.level, 'good');
  assert.ok(quality.score >= 90);
});

test('Typekitの動的部分字体は同じ書体の保存済み完全字体で参照を満たす', () => {
  const requested = 'https://use.typekit.net/af/font-id/family/31/m?features=ALL&v=4&chunks=7.22&order=0';
  const complete = 'https://use.typekit.net/af/font-id/family/31/m?features=ALL&v=4&chunks=0&order=0';
  const result = referenceAudit([requested], new Set([complete]));
  assert.equal(result.missingCount, 0);
  assert.equal(result.fallbackResolvedCount, 1);
  assert.deepEqual(result.fallbackResolved, [requested]);
});

test('決済・計測の静的参照を表示素材の欠落に数えない', () => {
  const result = referenceAudit([
    'https://shop.app/checkouts/internal/preloads.js?locale=ja-JP',
    'https://example.com/cdn/wpm/pixel.js',
    'https://example.com/theme.css'
  ], new Set());
  assert.equal(result.missingCount, 1);
  assert.deepEqual(result.missing, ['https://example.com/theme.css']);
  assert.equal(result.serverBoundaryCount, 1);
  assert.equal(result.auxiliaryCount, 1);
});

test('旧監査の決済境界だけを保存失敗として残さない', () => {
  const boundary = 'https://shop.app/checkouts/internal/preloads.js?locale=ja-JP';
  const manifest = {
    pages: [{ url: 'https://example.com/', quality: { classification: 'normal' } }],
    resources: {},
    blocked: [{ url: boundary, reason: '素材本体を取得できません' }],
    referenceAudit: { checkedCount: 1, missingCount: 1, missing: [boundary] }
  };
  assert.equal(summarizeArchiveQuality(manifest).referenceMissingCount, 0);
  assert.equal(completionStatus({ pages: 1, errors: 0, status: 'complete-with-errors' }, manifest).status, 'complete');
});

test('再生エラーを成功表示で上書きせず、古いページの通知を無視する', () => {
  let current = replayState('archive_test', 'https://example.com/');
  const message = type => ({ type, archiveId: 'archive_test', pageUrl: 'https://example.com/' });
  current = applyReplayMessage(current, message('webcapture-ready'));
  assert.equal(current.phase, 'ready');
  current = applyReplayMessage(current, message('webcapture-missing'));
  current = applyReplayMessage(current, message('webcapture-runtime-error'));
  current = applyReplayMessage(current, message('webcapture-blocked'));
  assert.match(replayStateLabel(current), /保存対象外へのアクセス 1回.*動作エラー 1件/);
  assert.match(replayStateLabel(current), /送信を安全遮断 1回/);
  const previous = current;
  assert.equal(applyReplayMessage(current, { ...message('webcapture-page-error'), pageUrl: 'https://example.com/previous' }), previous);
  current = applyReplayMessage(current, { ...message('webcapture-page-error'), message: '未保存ページ' });
  current = applyReplayMessage(current, message('webcapture-ready'));
  assert.equal(replayStateLabel(current), '未保存ページ');
});

test('同じページURLでも前のiframe文書から届いた移動通知を無視する', () => {
  const current = replayState('archive_test', 'https://example.com/', true, 'nav-2');
  assert.equal(isReplayMessageCurrent(current, { archiveId: 'archive_test', pageUrl: 'https://example.com/', navigationId: 'nav-1' }), false);
  assert.equal(isReplayMessageCurrent(current, { archiveId: 'archive_test', pageUrl: 'https://example.com/', navigationId: 'nav-2' }), true);
});

test('一覧に無いURLは未保存と決めつけず、保存済みページへ転送されたらその表示を採用する', () => {
  let current = replayState('archive_test', 'https://shop.example/account/profile', false, 'nav-3');
  assert.equal(current.phase, 'loading');
  assert.notEqual(replayStateLabel(current), 'このページは保存されていません');
  const fromSaved = { archiveId: 'archive_test', pageUrl: 'https://shop.example/authentication/1/login', navigationId: 'nav-3' };
  assert.equal(isReplayMessageCurrent(current, { ...fromSaved, navigationId: 'nav-2' }), false);
  current = applyReplayMessage(current, { ...fromSaved, type: 'webcapture-ready' });
  assert.equal(current.phase, 'ready');
  assert.equal(current.pageUrl, fromSaved.pageUrl);
  assert.equal(current.requestedUrl, 'https://shop.example/account/profile');
  assert.equal(isReplayMessageCurrent(current, { ...fromSaved, pageUrl: 'https://shop.example/other' }), false);
  let missing = replayState('archive_test', 'https://shop.example/nothing', false, 'nav-4');
  missing = applyReplayMessage(missing, { type: 'webcapture-page-error', archiveId: 'archive_test', pageUrl: 'https://shop.example/nothing', navigationId: 'nav-4', message: 'このページは保存されていません' });
  assert.equal(replayStateLabel(missing), 'このページは保存されていません');
  const saved = replayState('archive_test', 'https://shop.example/', true, 'nav-5');
  assert.equal(isReplayMessageCurrent(saved, { archiveId: 'archive_test', pageUrl: 'https://shop.example/other', navigationId: 'nav-5' }), false);
});

for (const discoveryMode of ['complete', 'immediate']) {
  for (const action of ['pause', 'cancel']) {
    test(`${discoveryMode}中の${action}は通信を中断して未保存URLを保持し、再開できる`, { timeout: 10000 }, async (t) => {
      const store = await temporaryStore(t);
      let requested;
      const started = new Promise(resolve => { requested = resolve; });
      const timers = new Set();
      const server = http.createServer((_req, res) => {
        requested();
        const timer = setTimeout(() => { timers.delete(timer); res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Article</title><main>Page</main>'); }, 80);
        timers.add(timer);
      });
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      t.after(() => new Promise(resolve => { for (const timer of timers) clearTimeout(timer); server.closeAllConnections(); server.close(resolve); }));
      const startUrl = `http://127.0.0.1:${server.address().port}/`;
      const job = await store.addJob({ startUrl, options: { ...DEFAULT_CAPTURE_OPTIONS, discoveryMode, discoveryConcurrency: 1, captureRendered: false, respectRobots: false, screenshotMode: 'none', warcEnabled: false, maxPages: null, policyOptions: { allowPrivateForTests: true } } });
      const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
      const running = manager.run(job.id);
      await started;
      await manager[action](job.id);
      await running;
      assert.equal(job.status, action === 'pause' ? 'paused' : 'cancelled');
      assert.equal(job.pages, 0);
      assert.equal(job.errors, 0);
      assert.equal(job.inFlight.length, 0);
      assert.equal(job.queue.length || job.queueCount, 1);
      await manager.resume(job.id);
      await manager.running.get(job.id);
      assert.equal(job.status, 'complete');
      assert.equal(job.pages, 1);
      assert.equal(job.errors, 0);
      assert.equal(manager.running.size, 0);
    });
  }
}

test('構造把握のバッチ間で中止してもアーカイブを登録し、未保存URLを保持する', async (t) => {
  const store = await temporaryStore(t);
  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<title>Article</title><a href="/next">Next</a>'); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const startUrl = `http://127.0.0.1:${server.address().port}/`;
  const job = await store.addJob({ startUrl, options: { ...DEFAULT_CAPTURE_OPTIONS, discoveryMode: 'complete', discoveryConcurrency: 1, captureRendered: false, respectRobots: false, maxPages: null, policyOptions: { allowPrivateForTests: true } } });
  const manager = new CrawlManager(store, { defaultLimits: DEFAULT_CAPTURE_OPTIONS });
  const writeManifest = store.writeManifest.bind(store);
  let stopped = false;
  store.writeManifest = async (...args) => {
    if (!stopped && job.discoveredPages === 1 && job.status === 'running') { stopped = true; await manager.cancel(job.id); }
    return writeManifest(...args);
  };
  await manager.run(job.id);
  assert.equal(stopped, true);
  assert.equal(job.status, 'cancelled');
  assert.equal(job.pages, 0);
  assert.equal(store.getArchive(job.archiveId).status, 'cancelled');
  await store.restoreJobQueue(job.id);
  assert.equal(job.queue[0].url, `${startUrl}next`);
  assert.equal(job.plannedQueue[0].url, startUrl);
});

test('削除の保存失敗で圧縮済み待ち行列を失わない', async (t) => {
  const store = await temporaryStore(t);
  const job = await store.addJob({ startUrl: 'https://example.com/', options: {} });
  await fs.mkdir(store.archiveRoot(job.archiveId), { recursive: true });
  await store.updateJob(job.id, { status: 'cancelled' });
  await store.finalizeJob(job.id);
  await store.addArchive({ id: job.archiveId, startUrl: job.startUrl, title: 'Temporary fixture', status: 'cancelled', pages: 0, savedAt: new Date().toISOString() });
  const metadataFile = store.metaFile;
  const invalidParent = path.join(store.dataRoot, 'not-a-directory');
  await fs.writeFile(invalidParent, 'fixture');
  store.metaFile = path.join(invalidParent, 'meta.json');
  await assert.rejects(store.deleteArchive(job.archiveId));
  store.metaFile = metadataFile;
  assert.ok(store.getArchive(job.archiveId));
  await fs.access(store.archiveRoot(job.archiveId));
  await store.restoreJobQueue(job.id);
  assert.equal(job.queue[0].url, job.startUrl);
  assert.equal(job.terminalQueue, undefined);
});

test('非同期WARC圧縮は原本の全bytesを可逆保持する', async () => {
  const payload = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\n\r\n'), Buffer.from(Array.from({ length: 256 }, (_, index) => index))]);
  for (const level of [0, 1, 9]) {
    const plain = gunzipSync(await createWarcAsync([{ url: 'https://example.com/binary', httpPayload: payload }], {}, level));
    assert.ok(plain.includes(payload));
    assert.ok(plain.includes(Buffer.from('WARC/1.1')));
  }
});

test('監査は任意の撮影/WARC省略を許容し、HTML/CSSの欠落候補を検出する', async (t) => {
  const store = await temporaryStore(t);
  const id = 'archive_audit_test';
  const html = await store.writeBlob(id, Buffer.from('<title>Article</title><main>Page</main>'));
  const manifest = { id, startUrl: 'https://example.com/', pages: [{ url: 'https://example.com/', html: html.file, screenshot: null }], resources: {}, blocked: [], options: { warcEnabled: false, screenshotMode: 'none' } };
  await store.writeManifest(id, manifest);
  const options = { cwd: path.resolve(import.meta.dirname, '..'), windowsHide: true, env: { ...process.env, WEBCAPTURE_DATA_ROOT: store.dataRoot, WEBCAPTURE_AUDIT_ROOT: path.join(store.dataRoot, 'audits') } };
  const first = JSON.parse((await execute(process.execPath, ['scripts/audit-archive.mjs', id], options)).stdout);
  assert.equal(first.ok, true);
  assert.equal(first.perfect, false);
  assert.equal(first.runtimeVerification, 'not-tested');
  assert.equal(first.screenshotsNotRecorded, 1);
  const css = await store.writeBlob(id, Buffer.from('body{background:url(/missing.png)}'));
  manifest.resources['https://example.com/theme.css'] = { ...css, url: 'https://example.com/theme.css', status: 200, mimeType: 'text/css' };
  manifest.pages[0].html = (await store.writeBlob(id, Buffer.from('<link rel="stylesheet" href="/theme.css"><img src="/also-missing.png">'))).file;
  await store.writeManifest(id, manifest);
  let second;
  try { await execute(process.execPath, ['scripts/audit-archive.mjs', id], options); assert.fail('静的参照の欠落を成功扱いにしました'); }
  catch (error) { assert.equal(error.code, 1); second = JSON.parse(error.stdout); }
  assert.equal(second.fileIntegrity.ok, true);
  assert.equal(second.staticReferences.missingCount, 2);
  assert.equal(second.ok, false);
});
