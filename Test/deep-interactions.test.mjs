import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { captureWithBrowser, createBrowserCaptureSession, findBrowser } from '../server/browser-capture.mjs';

const PAGE = `<!doctype html><title>Deep</title>
<store-account></store-account>
<form id="product" action="/cart/add" method="post">
  <input type="radio" name="color" id="red" value="red" checked style="position:absolute;opacity:0;width:1px;height:1px"><label for="red">赤</label>
  <input type="radio" name="color" id="blue" value="blue" style="position:absolute;opacity:0;width:1px;height:1px"><label for="blue">青</label>
  <button type="button" id="plus">数量を増やす</button>
  <button type="submit">カートに追加</button>
</form>
<img id="variant" src="/red.svg">
<button type="button" id="leave" onclick="location.href='/elsewhere'">他を見る</button>
<script>
customElements.define('store-account', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'closed' });
    root.innerHTML = '<button aria-label="アカウント" aria-haspopup="dialog" id="open">A</button>'
      + '<dialog id="panel"><button type="button" id="more" aria-expanded="false">詳しい案内</button><div id="extra" hidden></div>'
      + '<button type="button" id="login">ログイン</button><button type="button" aria-label="閉じる" id="close">x</button></dialog>';
    const panel = root.getElementById('panel');
    root.getElementById('open').addEventListener('click', () => { panel.show(); fetch('/panel-data.json'); });
    root.getElementById('more').addEventListener('click', (event) => {
      event.currentTarget.setAttribute('aria-expanded', 'true');
      const extra = root.getElementById('extra');
      extra.hidden = false;
      extra.innerHTML = '<img src="/nested.svg"><button type="button" id="deeper" aria-expanded="false">さらに開く</button>';
      extra.querySelector('#deeper').addEventListener('click', () => { const img = new Image(); img.src = '/deepest.svg'; extra.append(img); });
    });
    root.getElementById('login').addEventListener('click', () => fetch('/login-hit'));
    root.getElementById('close').addEventListener('click', () => panel.close());
  }
});
document.getElementById('blue').addEventListener('change', () => { document.getElementById('variant').src = '/blue.svg'; });
</script>`;

test('ポップアップの中のボタンや見えない領域のボタンまで試し、ログインや別ページへの移動はしない', { timeout: 90000 }, async (t) => {
  const browser = await findBrowser();
  if (!browser) return t.skip('Chrome / Edgeが見つかりません。');
  const hits = new Set();
  const server = http.createServer((req, res) => {
    hits.add(req.url);
    if (req.url.endsWith('.svg')) { res.writeHead(200, { 'content-type': 'image/svg+xml' }); res.end('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>'); return; }
    if (req.url.endsWith('.json')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/' ? PAGE : '<title>Other</title>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const session = await createBrowserCaptureSession({ executable: browser, policyOptions: { allowPrivateForTests: true } });
  t.after(() => session.close());
  const capture = await captureWithBrowser(url, {
    session, policyOptions: { allowPrivateForTests: true }, timeoutMs: 30000, screenshotMode: 'none',
    hoverDuringCapture: false, interactionSettleMs: 120
  });
  const saved = (asset) => capture.resources.some((item) => item.url.endsWith(asset));
  assert.ok(saved('/panel-data.json'), 'アカウントのポップアップを開いたときの通信を保存する');
  assert.ok(saved('/nested.svg'), 'ポップアップ内のボタンを押して出た画像を保存する');
  assert.ok(saved('/deepest.svg'), '3段目のボタンまで試す');
  assert.ok(saved('/blue.svg'), '商品の種類の切り替えで出る画像を保存する');
  assert.equal(hits.has('/login-hit'), false, 'ログインボタンは押さない');
  assert.equal(hits.has('/elsewhere'), false, '別ページへは移動しない');
  assert.equal([...hits].some((item) => item.startsWith('/cart/add')), false, 'フォームは送信しない');
  assert.equal(capture.title, 'Deep');
  const interactions = capture.preservation.interactions;
  assert.ok(interactions.testedCount >= 5, JSON.stringify(interactions));
});
