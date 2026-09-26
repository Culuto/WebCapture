import { isServerBoundaryUrl, unresolvedCaptureFailures } from './quality.mjs';
import { isAccountLikeUrl } from './policy.mjs';

const CATEGORIES = [
  {
    key: 'login', label: 'ログインが必要', severity: 'info',
    explanation: 'ログインしないと中身が返らないページや部品。保存したページでも動きません。',
    advice: 'ログイン状態で保存する機能を使うと保存できる場合があります。',
    action: 'retry-login', actionLabel: 'ログイン情報を使って保存し直す'
  },
  {
    key: 'refused', label: '相手サイトが拒否', severity: 'warn',
    explanation: '相手サイトがアクセスを断った（403・429・Bot対策など）。',
    advice: '分散アクセスをONにする、同時保存数を減らす、時間をおいて保存し直すと取れる場合があります。',
    action: 'retry-spaced', actionLabel: '間隔をあけて取り直す'
  },
  {
    key: 'originMissing', label: '元サイトのリンク切れ', severity: 'info',
    explanation: '元のサイトにもう存在しない（404・410）。元サイト側の問題で、保存し直しても取れません。',
    advice: '対処は不要。'
  },
  {
    key: 'timeout', label: '時間切れ', severity: 'warn',
    explanation: '読み込みや操作が時間内に終わりませんでした。',
    advice: '同時保存数を減らすか、低負荷モードをONにすると取れる場合があります。',
    action: 'retry-gentle', actionLabel: '同時保存数を減らして取り直す'
  },
  {
    key: 'network', label: '通信エラー', severity: 'warn',
    explanation: '通信が途中で切れた、または相手サーバーに接続できませんでした。',
    advice: '回線を確認して保存し直すと取れる場合があります。',
    action: 'retry', actionLabel: '取り直す'
  },
  {
    key: 'unavailable', label: '素材が取れない', severity: 'warn',
    explanation: 'ページは表示できたが、一部の画像・スクリプトなどの中身を取得できませんでした。',
    advice: '保存し直すと取れる場合があります。',
    action: 'retry', actionLabel: '取り直す'
  },
  {
    key: 'outOfScope', label: '保存範囲外', severity: 'info',
    explanation: '設定した範囲（外部リンクの深さ・除外設定・自動除外）の外のため、意図的に保存していません。',
    advice: '必要なら外部リンクの深さや除外設定を変えます。'
  },
  {
    key: 'browser', label: 'ブラウザを起動できない', severity: 'warn',
    explanation: '保存に使うブラウザ（Chrome・Edge）が起動直後に終了したため、ページを開けませんでした。',
    advice: 'Chromeを更新して再起動するか、パソコンを再起動してから取り直すと保存できる場合があります。',
    action: 'retry', actionLabel: '取り直す'
  },
  {
    key: 'other', label: 'その他', severity: 'warn',
    explanation: '上のどれにも当てはまらない問題。',
    advice: '詳細の理由を確認します。'
  }
];

const OUT_OF_SCOPE = /取得深度上限|転送先が保存範囲外|保存対象外|自動で除外|除外パターン|robots\.txt|外部サイトのため保存しません|ログイン誘導先は保存済み|転送先は保存済み/;

const BROWSER_START = /ブラウザ（[^）]*）を起動できませんでした|ブラウザがキャプチャ開始前に終了|ブラウザのキャプチャ接続がタイムアウト/;

export const RETRY_ACTION_OPTIONS = Object.freeze({
  retry: {},
  'retry-gentle': { concurrency: 1, requestTimeoutMs: 900000, finalizeGraceMs: 180000, networkIdleMaxMs: 180000 },
  'retry-spaced': { concurrency: 1, distributedAccess: true, perHostConcurrency: 1, perHostIntervalMs: 5000 }
});

export function retryOptionOverrides(action) {
  return { ...(RETRY_ACTION_OPTIONS[action] || {}) };
}

function safePath(value) {
  try { return new URL(value).pathname; } catch { return ''; }
}

function categoryOf(item) {
  const reason = String(item.reason || '');
  if (OUT_OF_SCOPE.test(reason)) return 'outOfScope';
  if (BROWSER_START.test(reason)) return 'browser';
  if (isServerBoundaryUrl(item.url) || isAccountLikeUrl(item.url) || /\/(?:login|signin|authorize|oauth)(?:[_/-]|$)/i.test(safePath(item.url)) || /ログイン/.test(reason)) return 'login';
  if (/HTTP (?:404|410)\b/.test(reason)) return 'originMissing';
  if (/HTTP (?:401|403|429)\b|ERR_HTTP_RESPONSE_CODE_FAILURE|ERR_BLOCKED_BY_RESPONSE|アクセス確認|Bot/i.test(reason)) return 'refused';
  if (/タイムアウト|時間切れ|timed? ?out|超えたため/i.test(reason)) return 'timeout';
  if (/fetch failed|net::ERR_|ECONN|EAI_AGAIN|ENOTFOUND|socket|接続できません|応答しません/i.test(reason)) return 'network';
  if (/取得できません|空でした|読み込みに失敗/.test(reason)) return 'unavailable';
  return 'other';
}

export function buildIssueReport(manifest = {}) {
  const buckets = new Map(CATEGORIES.map((category) => [category.key, { ...category, count: 0, examples: [] }]));
  const seen = new Set();
  const add = (key, url, reason) => {
    const identity = `${key}|${url}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    const bucket = buckets.get(key);
    bucket.count += 1;
    if (bucket.examples.length < 20) bucket.examples.push({ url, reason: String(reason || '').slice(0, 300) });
  };
  const unresolved = new Set(unresolvedCaptureFailures(manifest).map((item) => `${item.url}|${item.reason}`));
  for (const item of manifest.blocked || []) {
    if (!item?.url) continue;
    const key = categoryOf(item);
    const isFailure = unresolved.has(`${item.url}|${item.reason}`) || /^ページを開けませんでした|ページの保存|保存を完了|HTTP \d{3}/.test(item.reason || '');
    if (key === 'outOfScope' || isFailure || key === 'login' || key === 'browser') add(key, item.url, item.reason);
  }
  for (const page of manifest.pages || []) {
    const quality = page.quality;
    if (!quality || quality.classification === 'normal') continue;
    const reason = (quality.reasons || []).join(' ');
    const key = quality.classification === 'login-required' ? 'login'
      : quality.classification === 'access-challenge' ? 'refused'
        : /HTTP (?:404|410)\b/.test(reason) ? 'originMissing' : categoryOf({ url: page.url, reason });
    add(key, page.url, reason || quality.classification);
  }
  const categories = [...buckets.values()].filter((bucket) => bucket.count > 0);
  return {
    categories,
    problemCount: categories.filter((bucket) => bucket.key !== 'outOfScope').reduce((sum, bucket) => sum + bucket.count, 0),
    outOfScopeCount: buckets.get('outOfScope').count
  };
}
