import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { assertPublicUrl, classifyScope, isPublicIp, nextExternalDepth, normalizeSameSiteKeywords, normalizeUrl, registrableDomain, validateSameSiteKeywords, warningForDepth } from '../server/policy.mjs';
import { createPolicyProxy } from '../server/policy-proxy.mjs';

test('URLを正規化しfragmentと既定portだけを除く', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM:443/a/../b?q=2#section'), 'https://example.com/b?q=2');
  assert.equal(normalizeUrl('../img/a.png', 'https://example.com/docs/start/'), 'https://example.com/docs/img/a.png');
  assert.throws(() => normalizeUrl('file:///C:/secret.txt'), /http/);
  assert.throws(() => normalizeUrl('https://user:pass@example.com/'), /認証情報/);
});

test('親domainは同じサイト、別registrable domainは外部として扱う', () => {
  assert.equal(registrableDomain('docs.example.co.jp'), 'example.co.jp');
  assert.equal(classifyScope('https://www.example.com/a', 'https://docs.example.com/b'), 'site');
  assert.equal(classifyScope('https://www.example.com/a', 'https://example.net/b'), 'external');
});

test('開始先と候補先のホスト名に登録語があれば関連サイト扱いにする', () => {
  const startUrl = 'https://store.kkvv.jp/';
  const options = { sameSiteKeywords: ['kkvv'] };
  assert.equal(classifyScope(startUrl, 'https://support-kkvv.example/', options), 'keyword-site');
  assert.equal(classifyScope(startUrl, 'https://google.example/', options), 'external');
  assert.equal(classifyScope('https://example.com/', 'https://support-kkvv.example/', options), 'external');
  assert.equal(classifyScope(startUrl, 'https://notkkvv.example/', options), 'external');
});

test('同一サイト扱いキーワードを正規化し、広すぎる語を拒否する', () => {
  assert.deepEqual(normalizeSameSiteKeywords('KKVV, kkvv, example-brand'), ['kkvv', 'example-brand']);
  assert.deepEqual(validateSameSiteKeywords('KKVV, kkvv'), ['kkvv']);
  assert.throws(() => validateSameSiteKeywords('shop'), /固有語/);
  assert.throws(() => validateSameSiteKeywords('1234'), /固有語/);
});

test('同じ親サイトは30、外部サイトは5で初めて警告する', () => {
  const startUrl = 'https://www.example.com/';
  assert.equal(warningForDepth({ startUrl, url: 'https://docs.example.com/a', depth: 29 }), null);
  assert.equal(warningForDepth({ startUrl, url: 'https://docs.example.com/a', depth: 30 }).threshold, 30);
  assert.equal(warningForDepth({ startUrl, url: 'https://outside.example.net/a', depth: 40, externalDepth: 4 }), null);
  assert.equal(warningForDepth({ startUrl, url: 'https://outside.example.net/a', depth: 2, externalDepth: 5 }).threshold, 5);
});

test('外部取得深度はメインから出ると1、外部内で増え、メインへ戻ると0になる', () => {
  const startUrl = 'https://store.example.com/';
  assert.equal(nextExternalDepth({ startUrl, currentUrl: startUrl, candidateUrl: 'https://google.example.net/', currentExternalDepth: 0 }), 1);
  assert.equal(nextExternalDepth({ startUrl, currentUrl: 'https://google.example.net/', candidateUrl: 'https://support.example.net/', currentExternalDepth: 1 }), 2);
  assert.equal(nextExternalDepth({ startUrl, currentUrl: 'https://google.example.net/', candidateUrl: 'https://docs.example.com/', currentExternalDepth: 2 }), 0);
});

test('登録語一致サイトは外部深度0で、そこから一般外部へ出ると1になる', () => {
  const startUrl = 'https://store.kkvv.jp/';
  const sameSiteKeywords = ['kkvv'];
  assert.equal(nextExternalDepth({ startUrl, currentUrl: startUrl, candidateUrl: 'https://support-kkvv.example/', sameSiteKeywords }), 0);
  assert.equal(nextExternalDepth({ startUrl, currentUrl: 'https://support-kkvv.example/', candidateUrl: 'https://google.example/', sameSiteKeywords }), 1);
  assert.equal(warningForDepth({ startUrl, url: 'https://support-kkvv.example/', depth: 29, externalDepth: 0, sameSiteKeywords }), null);
  assert.equal(warningForDepth({ startUrl, url: 'https://support-kkvv.example/', depth: 30, externalDepth: 0, sameSiteKeywords }).threshold, 30);
});

test('private、loopback、link-local、予約IPを拒否する', () => {
  for (const ip of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.1.1','169.254.169.254','192.0.2.1','::1','fd00::1']) assert.equal(isPublicIp(ip), false, ip);
  for (const ip of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) assert.equal(isPublicIp(ip), true, ip);
});

test('DNSがpublicとprivateを混在させた場合も拒否する', async () => {
  const lookup = async () => [{ address: '93.184.216.34', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(assertPublicUrl('https://example.com/', { lookup }), /公開アドレス以外/);
  await assert.rejects(assertPublicUrl('http://localhost/'), /ローカルPC/);
});

test('検査proxyは読み取り用POSTを記録のため通し、PUT・PATCH・DELETEは上流へ送らず拒否する', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => { received.push(req.method); res.writeHead(200); res.end('ok'); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = await createPolicyProxy({ policyOptions: { allowPrivateForTests: true } });
  const call = (method) => new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: proxy.port, method,
      path: `http://127.0.0.1:${upstream.address().port}/api`
    }, (response) => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end('{"query":"items"}');
  });
  try {
    assert.equal(await call('POST'), 200);
    for (const method of ['PUT', 'PATCH', 'DELETE']) assert.equal(await call(method), 403);
    assert.deepEqual(received, ['POST']);
  } finally {
    await proxy.close();
    await new Promise((resolve) => upstream.close(resolve));
  }
});

test('同じサイト内の転送は外部の階層を増やさず、別サイトへの転送だけ1つ増やす', async () => {
  const { redirectExternalDepth } = await import('../server/policy.mjs');
  const startUrl = 'https://store.kkvv.jp/';
  assert.equal(redirectExternalDepth({ startUrl, fromUrl: 'https://withlive.zendesk.com/hc/ja/articles/1', currentExternalDepth: 1, toUrl: 'https://withlive.zendesk.com/hc/ja/articles/1-title' }), 1);
  assert.equal(redirectExternalDepth({ startUrl, fromUrl: 'https://support.apple.com/a', currentExternalDepth: 1, toUrl: 'https://www.apple.com/jp/' }), 1, '同じ登録ドメイン（apple.com）内は増やさない');
  assert.equal(redirectExternalDepth({ startUrl, fromUrl: 'https://www.apple.com/a', currentExternalDepth: 1, toUrl: 'https://www.google.com/' }), 2);
  assert.equal(redirectExternalDepth({ startUrl, fromUrl: 'https://store.kkvv.jp/a', currentExternalDepth: 0, toUrl: 'https://store.kkvv.jp/b' }), 0);
  assert.equal(redirectExternalDepth({ startUrl, fromUrl: 'https://store.kkvv.jp/a', currentExternalDepth: 0, toUrl: 'https://shopify.com/login' }), 1);
});

test('ログイン・カート・アカウント等のURLだけを自動除外の対象として見分ける', async () => {
  const { isAccountLikeUrl } = await import('../server/policy.mjs');
  for (const url of ['https://store.kkvv.jp/account', 'https://store.kkvv.jp/account/login', 'https://store.kkvv.jp/cart', 'https://shopify.com/authentication/1/login', 'https://accounts.google.com/ServiceLogin', 'https://secure11.store.apple.com/jp/shop/signIn/orders', 'https://example.com/mypage/', 'https://example.com/checkout']) assert.equal(isAccountLikeUrl(url), true, url);
  for (const url of ['https://store.kkvv.jp/', 'https://store.kkvv.jp/products/account-book', 'https://store.kkvv.jp/pages/faq', 'https://support.apple.com/ja-jp/apple-pay', 'https://example.com/blog/login-tips-2026']) assert.equal(isAccountLikeUrl(url), false, url);
});
