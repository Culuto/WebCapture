import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser, freePort } from '../server/browser-capture.mjs';

test('隔離ブラウザで描画後DOMと素材を取得し、一時的な非送信クリック状態は元へ戻す', { timeout: 240000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  let fontBytes;
  for (const candidate of ['C:/Windows/Fonts/arial.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf']) {
    try { fontBytes = await fs.readFile(candidate); break; } catch {}
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/font.ttf' && fontBytes) { res.writeHead(200, { 'content-type': 'font/ttf' }); res.end(fontBytes); return; }
    if (req.url === '/font-state') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Dynamic font</title><style id="dynamic"></style><style id="deleted">.deleted{color:red}</style><p class="dynamic-font">Font state</p><script>deleted.sheet.deleteRule(0);dynamic.sheet.insertRule(".dynamic-font {color:rgb(1, 2, 3);font-family:ArchiveFixture}");fetch("/font.ttf").then(r=>r.arrayBuffer()).then(bytes=>{const face=new FontFace("ArchiveFixture",bytes);return face.load().then(()=>{document.fonts.add(face);document.documentElement.dataset.fontLoaded="true"})})</script>');
      return;
    }
    if (req.url === '/inner-scroll') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Inner scroll</title><style>html,body{margin:0;height:100%;overflow:hidden}.page{height:100%;overflow-y:auto}.content{height:1900px;background:linear-gradient(#fff,#036)}</style><div class="page"><div class="content">全体画像</div></div>');
      return;
    }
    if (req.url === '/hover-menu') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Hover</title><style>.item .panel{display:none}.item:hover .panel{display:block;width:40px;height:40px;background:url(/hover-bg.svg)}</style><nav><ul><li class="item"><a href="#m">メニュー</a><div class="panel"></div></li><li id="js-item"><span>JS</span></li></ul></nav><script>document.getElementById("js-item").addEventListener("mouseenter",()=>{const img=new Image();img.src="/hover-js.svg";document.body.append(img)},{once:true})</script><shadow-links></shadow-links><script>customElements.define("shadow-links",class extends HTMLElement{constructor(){super();this.attachShadow({mode:"closed"}).innerHTML="<a href=/from-shadow>内側のリンク</a>"}})</script><canvas id="gl" width="8" height="8"></canvas><script>const gl=document.getElementById("gl").getContext("webgl");if(gl){gl.clearColor(1,0,0,1);gl.clear(gl.COLOR_BUFFER_BIT)}</script>');
      return;
    }
    if (req.url === '/hover-bg.svg' || req.url === '/hover-js.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>');
      return;
    }
    if (req.url === '/report') {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('%PDF-1.4\n%fixture\n');
      return;
    }
    if (req.url === '/sjis') {
      res.writeHead(200, { 'content-type': 'text/html; charset=Shift_JIS' });
      res.end(Buffer.concat([Buffer.from('<!doctype html><meta charset="Shift_JIS"><title>'), Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), Buffer.from('</title><link rel="stylesheet" href="/sjis.css"><p class="jp">'), Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), Buffer.from('</p>')]));
      return;
    }
    if (req.url === '/sjis.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=Shift_JIS' });
      res.end(Buffer.concat([Buffer.from('.jp::after{content:"'), Buffer.from([0x93, 0xfa, 0x96, 0x7b, 0x8c, 0xea]), Buffer.from('"}')]));
      return;
    }
    if (req.url === '/shadow-nested') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Nested shadow</title><outer-card></outer-card><script>customElements.define("inner-chip",class extends HTMLElement{constructor(){super();this.attachShadow({mode:"open"}).innerHTML="<b>内側の部品</b>"}});customElements.define("outer-card",class extends HTMLElement{constructor(){super();const root=this.attachShadow({mode:"closed"});root.innerHTML="<p>閉じた部品</p><inner-chip></inner-chip>"}});const sheet=new CSSStyleSheet();sheet.replaceSync(".doc-adopted{color:rgb(4, 5, 6)}");document.adoptedStyleSheets=[sheet]</script>');
      return;
    }
    if (req.url === '/lazy-panel') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Lazy panel</title><button type="button" aria-expanded="false" aria-controls="panel" onclick="panel.hidden=false;this.setAttribute(\'aria-expanded\',\'true\');panel.innerHTML=\'<img src=/panel.svg>\'">開く</button><div id="panel" hidden></div><details><summary>詳細</summary><img src="/details.svg"></details><button type="button" onclick="location.href=\'/purchased\'">購入する</button>');
      return;
    }
    if (req.url === '/panel.svg' || req.url === '/details.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="green"/></svg>');
      return;
    }
    if (req.url === '/dialog') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>Dialog</title><p>確認ダイアログの後ろの内容</p><script>alert("保存中の確認");confirm("続けますか");window.addEventListener("beforeunload",event=>{event.preventDefault();event.returnValue=""})</script>');
      return;
    }
    if (req.url === '/endless') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><title>Endless</title><body style="height:3000px"><script>setInterval(()=>{document.body.style.height=(document.documentElement.scrollHeight+1000)+'px'},20)</script></body>`);
      return;
    }
    if (req.url === '/style.css') {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      res.end('@keyframes pulse{from{opacity:.4}to{opacity:1}} .animated{animation:pulse 1s infinite}');
      return;
    }
    if (req.url === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
      res.end("document.documentElement.dataset.scriptLoaded='true';customElements.define('shadow-fixture',class extends HTMLElement{constructor(){super();if(!this.shadowRoot)this.attachShadow({mode:'open'}).innerHTML='<span>Shadow content</span>'}})");
      return;
    }
    if (req.url === '/pixel.gif') {
      res.writeHead(200, { 'content-type': 'image/gif' });
      res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==', 'base64'));
      return;
    }
    if (req.url === '/image.svg' || req.url === '/image-2.svg' || req.url === '/image-hi.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="blue"/></svg>');
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/next' }); res.end(); return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Fixture</title><link rel="stylesheet" href="/style.css"><script src="/app.js"></script><shadow-fixture></shadow-fixture><button aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.querySelector('#hidden').hidden=false">詳細</button><p id="hidden" hidden>クリック後に表示</p><img src="/image.svg" data_max_resolution="/image-hi.svg" srcset="/image.svg 1x, /image-2.svg 2x"><img class="animated" src="/pixel.gif"><textarea id="note"></textarea><input id="secret" type="password"><canvas id="drawing" width="4" height="4"></canvas><script>note.value='保存メモ';secret.value='保存しない';drawing.getContext('2d').fillRect(0,0,4,4)</script><a href="/next">次へ</a>`);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const capture = await captureWithBrowser(url, { session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 15000, captureSrcsetCandidates: true, freezeResponsiveImages: false, maxSrcsetCandidates: null, maxLinksPerPage: null, maxResourcesPerPage: null });
  assert.equal(capture.title, 'Fixture');
  assert.match(capture.html, /クリック後に表示/);
  assert.match(capture.html, /aria-expanded="false"/);
  assert.match(capture.html, /id="hidden" hidden/);
  assert.match(capture.html, /data-script-loaded="true"/);
  assert.match(capture.html, /template shadowrootmode="open"/);
  assert.match(capture.html, /Shadow content/);
  assert.match(capture.html, /<textarea id="note">保存メモ<\/textarea>/);
  assert.doesNotMatch(capture.html, /id="secret"[^>]*value="保存しない"/);
  assert.match(capture.html, /data-webcapture-canvas="data:image\/png;base64,/);
  assert.match(capture.html, /srcset="\/image\.svg 1x, \/image-2\.svg 2x"/);
  for (const asset of ['/style.css', '/app.js', '/image.svg', '/image-2.svg', '/image-hi.svg', '/pixel.gif']) {
    assert.ok(capture.resources.some((item) => item.url.endsWith(asset)), `${asset}: ${capture.resources.map((item) => item.url).join(', ')}`);
  }
  assert.ok(capture.screenshot?.length > 1000, JSON.stringify(capture.blocked));
  assert.ok(capture.links.some((item) => item.url.endsWith('/next')));
  if (fontBytes) {
    const fonts = await captureWithBrowser(`${url}font-state`, { session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 15000, screenshotMode: 'none', initialWaitMs: 100, scrollEnabled: false });
    assert.match(fonts.html, /data-font-loaded="true"/);
    assert.match(fonts.html, /data-webcapture-fonts/);
    assert.ok(fonts.html.includes(`data:font/otf;base64,${fontBytes.toString('base64')}`));
    assert.match(fonts.html, /font-family:\s*ArchiveFixture/);
    assert.match(fonts.html, /color:\s*rgb\(1, 2, 3\)/);
    assert.match(fonts.html, /<style id="deleted"><\/style>/);
    assert.equal(fonts.preservation.capturedFontFaces, 1);
  } else t.diagnostic('動的バイナリフォントはOSのfixture字体がないため未検証');
  const innerScroll = await captureWithBrowser(`${url}inner-scroll`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 15000,
    screenshotMode: 'full-page', viewportWidth: 800, viewportHeight: 600, scrollEnabled: true
  });
  assert.ok(innerScroll.preservation.fullPageScreenshot.expandedScrollContainers >= 1);
  assert.ok(innerScroll.screenshot.readUInt32BE(20) >= 1800, `スクリーンショット高さ: ${innerScroll.screenshot.readUInt32BE(20)}`);
  const filtered = await captureWithBrowser(`${url}next`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 15000,
    screenshotMode: 'none', scrollEnabled: false, resourceTypes: { image: false }
  });
  assert.equal(filtered.screenshot, null);
  assert.ok(!filtered.resources.some((item) => item.type === 'Image'));
  assert.ok(filtered.blocked.some((item) => item.reason.includes('素材種別 Image')));
  const redirected = await captureWithBrowser(`${url}redirect`, { session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 15000, screenshotMode: 'none' });
  assert.ok(redirected.redirects.some((item) => item.url.endsWith('/redirect') && item.targetUrl.endsWith('/next')));
  const endless = await captureWithBrowser(`${url}endless`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 1500, finalizeGraceMs: 30000,
    screenshotMode: 'none', maxScrollContainers: null, maxScrollStepsPerContainer: null, scrollDelayMs: 10
  });
  assert.equal(endless.partial, true);
  assert.equal(endless.preservation.partialCapture, true);
  assert.match(endless.html, /Endless/);
  assert.ok(endless.blocked.some((item) => /その時点までの内容を保存しました/.test(item.reason)), JSON.stringify(endless.blocked));
  const dialog = await captureWithBrowser(`${url}dialog`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, loadWaitMs: 5000, screenshotMode: 'none'
  });
  assert.equal(dialog.partial, false);
  assert.match(dialog.html, /確認ダイアログの後ろの内容/);
  const frameServer = http.createServer((req, res) => {
    if (req.url === '/frame-image.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      res.end('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><rect width="3" height="3" fill="red"/></svg>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Embedded</title><p>埋め込みの中身</p><img src="/frame-image.svg">');
  });
  let frameHost = '127.0.0.2';
  try { await new Promise((resolve, reject) => { frameServer.once('error', reject); frameServer.listen(0, frameHost, resolve); }); }
  catch { frameHost = '127.0.0.1'; await new Promise((resolve) => frameServer.listen(0, frameHost, resolve)); }
  t.after(() => new Promise((resolve) => frameServer.close(resolve)));
  const frameUrl = `http://${frameHost}:${frameServer.address().port}/frame`;
  const embeddingServer = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Embedding</title><iframe src="${frameUrl}" width="200" height="100"></iframe>`);
  });
  await new Promise((resolve) => embeddingServer.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => embeddingServer.close(resolve)));
  const embedded = await captureWithBrowser(`http://127.0.0.1:${embeddingServer.address().port}/`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none', interactDuringCapture: false,
    networkIdleMs: 500, networkIdleMaxMs: 6000
  });
  assert.ok(embedded.resources.some((item) => item.url === frameUrl && item.body.toString('utf8').includes('埋め込みの中身')), embedded.resources.map((item) => item.url).join(', '));
  assert.ok(embedded.resources.some((item) => item.url.endsWith('/frame-image.svg') && item.body.length > 0));
  if (frameHost !== '127.0.0.1') assert.ok(embedded.preservation.attachedTargets?.frames >= 1, JSON.stringify(embedded.preservation.attachedTargets));
  else t.diagnostic('127.0.0.2を待ち受けできないため、別プロセスのiframe接続は未検証');
  const sjis = await captureWithBrowser(`${url}sjis`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none', interactDuringCapture: false
  });
  assert.equal(sjis.title, '日本語');
  assert.match(sjis.html, /<p class="jp">日本語<\/p>/);
  const sjisCss = sjis.resources.find((item) => item.url.endsWith('/sjis.css'));
  assert.ok(sjisCss, sjis.resources.map((item) => item.url).join(', '));
  assert.ok(['utf-8', 'shift_jis'].includes(sjisCss.bodyCharset), sjisCss.bodyCharset);
  assert.equal(new TextDecoder(sjisCss.bodyCharset).decode(sjisCss.body), '.jp::after{content:"日本語"}');
  const hover = await captureWithBrowser(`${url}hover-menu`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 30000, screenshotMode: 'none', interactDuringCapture: false,
    hoverDuringCapture: true, networkIdleMs: 400, networkIdleMaxMs: 5000
  });
  assert.ok(hover.resources.some((item) => item.url.endsWith('/hover-bg.svg')), `CSSのhover素材: ${hover.resources.map((item) => item.url).join(', ')}`);
  assert.ok(hover.resources.some((item) => item.url.endsWith('/hover-js.svg')), 'mouseenterで読み込まれる素材');
  assert.ok(hover.preservation.hovers.hovered >= 2, JSON.stringify(hover.preservation.hovers));
  assert.ok(hover.links.some((item) => item.url.endsWith('/from-shadow')), '閉じたShadow DOM内のリンクも巡回対象にする');
  assert.match(hover.html, /<canvas id="gl"[^>]*data-webcapture-canvas="data:image\/png;base64,/, 'WebGLの描画内容を画像として保存する');
  await assert.rejects(
    captureWithBrowser(`${url}report`, { session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 15000, screenshotMode: 'none' }),
    (error) => error.code === 'NON_HTML_DOCUMENT' && /pdf/.test(error.mimeType)
  );
  const nestedShadow = await captureWithBrowser(`${url}shadow-nested`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none', interactDuringCapture: false
  });
  assert.match(nestedShadow.html, /<template shadowrootmode="closed">[\s\S]*閉じた部品/);
  assert.match(nestedShadow.html, /<inner-chip><template shadowrootmode="open"><b>内側の部品<\/b>/);
  assert.match(nestedShadow.html, /data-webcapture-adopted-document[^>]*>[^<]*color:\s*rgb\(4, 5, 6\)/);
  const lazyPanel = await captureWithBrowser(`${url}lazy-panel`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 30000, screenshotMode: 'none',
    interactDuringCapture: true, interactionMaxMs: 10000, networkIdleMs: 400, networkIdleMaxMs: 6000
  });
  assert.ok(lazyPanel.resources.some((item) => item.url.endsWith('/panel.svg')), `操作後の素材: ${lazyPanel.resources.map((item) => item.url).join(', ')}`);
  assert.ok(lazyPanel.resources.some((item) => item.url.endsWith('/details.svg')));
  assert.match(lazyPanel.html, /id="panel" hidden/);
  assert.match(lazyPanel.html, /aria-expanded="false"/);
  assert.ok(lazyPanel.preservation.interactions.testedCount >= 2, JSON.stringify(lazyPanel.preservation.interactions));
  assert.equal(lazyPanel.preservation.interactions.errorCount, 0);
  assert.ok(!lazyPanel.resources.some((item) => item.url.endsWith('/purchased')), '購入ボタンは押さない');
  const withoutInteraction = await captureWithBrowser(`${url}lazy-panel`, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 20000, screenshotMode: 'none',
    interactDuringCapture: false, networkIdleMs: 400, networkIdleMaxMs: 4000
  });
  assert.ok(!withoutInteraction.resources.some((item) => item.url.endsWith('/panel.svg')));
  assert.equal(withoutInteraction.preservation.interactions, undefined);
  const closedPort = await freePort();
  await assert.rejects(
    captureWithBrowser(`http://127.0.0.1:${closedPort}/`, {
      session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 15000, screenshotMode: 'none'
    }),
    (error) => error.code === 'PAGE_NAVIGATION_FAILED' && /ページを開けませんでした: net::/.test(error.message)
  );
  const closing = Date.now();
  await session.close();
  assert.ok(Date.now() - closing < 20000, '保存用ブラウザを閉じるのを長く待たない');
  let profileLeft = true;
  for (let attempt = 0; attempt < 120 && profileLeft; attempt += 1) {
    try { await fs.stat(session.profile); await new Promise((resolve) => setTimeout(resolve, 1000)); } catch (error) { profileLeft = error.code !== 'ENOENT'; }
  }
  assert.equal(profileLeft, false, '作業用フォルダは閉じた後に裏で削除される');
});
