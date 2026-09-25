import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIssueReport } from '../server/issue-report.mjs';

test('保存できなかったものを原因別に分け、説明と対処を付ける', () => {
  const manifest = {
    pages: [
      { url: 'https://store.example.jp/', quality: { classification: 'normal' } },
      { url: 'https://store.example.jp/members', quality: { classification: 'login-required', reasons: ['ログイン必須ページが表示されました。'] } }
    ],
    resources: {},
    blocked: [
      { url: 'https://x.com/example', reason: 'ページを開けませんでした: net::ERR_HTTP_RESPONSE_CODE_FAILURE' },
      { url: 'https://shop.app/checkouts/internal/preloads.js', reason: '参照素材を取得できません: HTTP 400' },
      { url: 'https://store.example.jp/services/login_with_shop/authorize?x=1', reason: '参照素材を取得できません: HTTP 406' },
      { url: 'https://km.support.apple.com/a.svg', reason: '参照素材を取得できません: HTTP 404' },
      { url: 'https://www.apple.com/jp/', reason: '外部リンクの取得深度上限（1）を超えるため保存しません。' },
      { url: 'https://store.example.jp/cart', reason: 'ログイン・カート・アカウント等のページのため自動で除外しました。' },
      { url: 'https://cdn.example.com/app.js', reason: '素材本体を取得できません: Network.getResponseBody がタイムアウトしました。' },
      { url: 'https://api.example.com/data', reason: '参照素材を取得できません: fetch failed' },
      { url: 'https://shop.app/pay/session', reason: '参照素材を取得できません: HTTP 429' }
    ]
  };
  const report = buildIssueReport(manifest);
  const count = (key) => report.categories.find((item) => item.key === key)?.count || 0;
  assert.equal(count('refused'), 1, 'x.comの拒否');
  assert.equal(count('login'), 4, 'shop.appの2件・ログイン用窓口・ログイン必須ページ');
  assert.equal(count('originMissing'), 1);
  assert.equal(count('outOfScope'), 2);
  assert.equal(count('timeout'), 1);
  assert.equal(count('network'), 1);
  assert.equal(report.outOfScopeCount, 2);
  assert.equal(report.problemCount, 8);
  for (const category of report.categories) {
    assert.ok(category.label && category.explanation && category.advice, category.key);
    assert.ok(category.examples.length > 0);
  }
});
