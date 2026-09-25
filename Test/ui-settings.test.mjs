import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { sanitizeUiPrefs, readUiPrefs, writeUiPrefs, resolveTheme, urlPatternList, MAX_URL_PATTERNS, UI_PREFS_KEY } from '../public/ui-prefs.js';
import { EN, translate } from '../public/i18n.js';
import { documentUrlAllowed } from '../server/capture-options.mjs';

const publicFile = (name) => fs.readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
const JAPANESE = /[぀-ヿ㐀-鿿！-｠]/;

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
}

function staticJapaneseStrings(html) {
  const found = new Set();
  const decode = (value) => value.replace(/&#10;/g, '\n').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  for (const match of html.matchAll(/(?:placeholder|aria-label|data-help|data-tooltip|title|alt)="([^"]*)"/g)) if (JAPANESE.test(match[1])) found.add(decode(match[1]).trim());
  const body = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<[^>]+>/g, '\u0000');
  for (const part of body.split('\u0000')) { const text = decode(part).trim(); if (text && JAPANESE.test(text)) found.add(text); }
  return [...found];
}

test('画面設定は壊れた保存値を既定値に戻し、未知の値を受け付けない', () => {
  assert.deepEqual(sanitizeUiPrefs(null), { theme: 'light', language: 'ja', legacyKeywords: false, excludeUrlPatterns: '', includeUrlPatterns: '' });
  assert.deepEqual(sanitizeUiPrefs({ theme: 'neon', language: 'fr', legacyKeywords: 'yes', excludeUrlPatterns: 3 }), sanitizeUiPrefs({}));
  const storage = memoryStorage();
  assert.equal(writeUiPrefs(storage, { theme: 'dark', language: 'en', legacyKeywords: true, excludeUrlPatterns: '/login' }), true);
  assert.deepEqual(readUiPrefs(storage), { theme: 'dark', language: 'en', legacyKeywords: true, excludeUrlPatterns: '/login', includeUrlPatterns: '' });
  storage.setItem(UI_PREFS_KEY, '{broken');
  assert.equal(readUiPrefs(storage).theme, 'light', '壊れたJSONでも画面が開ける');
  assert.equal(readUiPrefs(null).language, 'ja');
  const throwing = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  assert.equal(readUiPrefs(throwing).theme, 'light');
  assert.equal(writeUiPrefs(throwing, {}), false);
});

test('テーマはライト・ダーク・システム連動を正しく解決する', () => {
  assert.equal(resolveTheme('light', true), 'light');
  assert.equal(resolveTheme('dark', false), 'dark');
  assert.equal(resolveTheme('system', true), 'dark');
  assert.equal(resolveTheme('system', false), 'light');
  assert.equal(resolveTheme('unknown', true), 'light');
});

test('除外・限定URLは1行1件で、部分一致とワイルドカードがサーバー判定と一致する', () => {
  const patterns = urlPatternList('/login\n\n# メモ\nexample.com/private/*\n/login\n  /cart  ');
  assert.deepEqual(patterns, ['*/login*', 'example.com/private/*', '*/cart*']);
  const options = { excludeUrlPatterns: patterns, includeUrlPatterns: [] };
  assert.equal(documentUrlAllowed('https://example.com/login?next=/', options), false);
  assert.equal(documentUrlAllowed('https://shop.example.com/cart', options), false);
  assert.equal(documentUrlAllowed('https://example.com/blog/1', options), true);
  const limited = { excludeUrlPatterns: [], includeUrlPatterns: urlPatternList('example.com/blog/') };
  assert.equal(documentUrlAllowed('https://example.com/blog/1', limited), true);
  assert.equal(documentUrlAllowed('https://example.com/about', limited), false);
  const many = Array.from({ length: 80 }, (_, index) => `/p${index}`).join('\n');
  assert.equal(urlPatternList(many).length, MAX_URL_PATTERNS, 'サーバーの上限（50件）を超えて送らない');
});

test('保存画面：サンプルURLは https://example.com だけ、保存範囲は1つの切替ボタン、？の説明は1種類', async () => {
  const html = await publicFile('index.html');
  assert.equal((html.match(/placeholder="https:\/\/example\.com"/g) || []).length, 2);
  assert.doesNotMatch(html, /（サンプル）|例: https:\/\/example\.com/);
  assert.match(html, /id="scope-toggle"[^>]*role="switch"/);
  assert.doesNotMatch(html, /class="segmented"/);
  assert.doesNotMatch(html, /id="help-popover"/, 'クリック用の別ポップアップを持たない（二重表示しない）');
  assert.match(html, /id="legacy-keyword-block" class="option-block" hidden/, '同一サイト扱いキーワードは初期状態で隠す');
});

test('保存画面の配置：ライブ表示は独立したカード、自動で保存する内容は設定タブ', async () => {
  const html = await publicFile('index.html');
  const saveView = html.slice(html.indexOf('<section id="save-view"'), html.indexOf('<section id="archives-view"'));
  const progress = saveView.slice(saveView.indexOf('<section id="progress-region"'), saveView.indexOf('<div class="save-side">'));
  const settings = html.slice(html.indexOf('<section id="settings-view"'));
  assert.doesNotMatch(progress, /id="live-view"/, '保存中カードの中にライブ表示を置かない');
  assert.match(saveView, /<section id="live-view" class="card live-view live-card"/);
  assert.ok(saveView.indexOf('id="live-view"') > saveView.indexOf('<div class="save-side">'), 'ライブ表示は保存済みサイトの下');
  assert.doesNotMatch(saveView, /automatic-preservation/);
  assert.match(settings, /class="automatic-preservation"/);
  for (const id of ['theme-select', 'language-select', 'exclude-url-patterns', 'include-url-patterns', 'legacy-keywords']) assert.match(settings, new RegExp(`id="${id}"`));
  assert.match(html, /<script src="\/prefs-boot\.js"><\/script>/);
  assert.match(html, /href="\/theme\.css"/);
});

test('レイアウト：保存済みサイトは追尾せず、エラー数は0のとき赤くせず、ライブ画面は16:9', async () => {
  const css = await publicFile('layout.css');
  assert.doesNotMatch(css, /\.save-side\s*\{[^}]*sticky/);
  assert.doesNotMatch(css, /max-width:\s*1840px/);
  assert.doesNotMatch(css, /nth-child\(4\) dd \{ color: var\(--danger\)/);
  assert.match(css, /dd\.has-errors \{ color: var\(--danger\); \}/);
  assert.match(css, /aspect-ratio: 16 \/ 9;/);
  assert.match(css, /#save-view, #save-view \* \{ overflow-anchor: none; \}/, '画面の更新でスクロール位置が勝手に動かない');
  assert.match(css, /\.live-view\.expanded \{[^}]*background: var\(--page-bg\)/, '拡大表示はライトでは明るい背景');
  assert.doesNotMatch(css, /\.live-view\.expanded \{[^}]*#0e1320/);
  assert.match(css, /\.live-tabs \{[^}]*scrollbar-width: none/, 'タブ列にブラウザのスクロールバーを出さない');
  assert.match(css, /\.live-view\.expanded \.live-panes \{[^}]*align-content: safe center; justify-content: safe center;/, 'はみ出しても上端が欠けない中央寄せ');
  assert.match(await publicFile('theme.css'), /:root\[data-theme="dark"\] \.live-view\.expanded \{ background: #0e1320; \}/, 'ダークでは暗い拡大表示');
  const liveHtml = await publicFile('index.html');
  assert.match(liveHtml, /id="live-tabs-prev"[\s\S]*id="live-tabs"[\s\S]*id="live-tabs-next"/, 'タブ列は独自の送りボタンで動かす');
  assert.match(css, /\.archive-list-region \{[^}]*min-height: \d+px/);
  const live = await publicFile('live-view.js');
  assert.match(live, /const barHeight = Math\.max\(34, Math\.ceil\(measuredChrome\) \+ 2\);/, '画面の上部バーの実際の高さで並べる');
  assert.match(live, /const TILE_RATIO = 16 \/ 9;/);
  const app = await publicFile('app.js');
  assert.match(app, /classList\.toggle\('has-errors', Number\(job\.errors\) > 0\)/);
  assert.match(app, /const ADVANCED_IDLE_MS = 15000;/);
  assert.match(app, /sameSiteKeywords: uiPrefs\.legacyKeywords \? sameSiteKeywords : \[\]/, 'レガシー機能OFFのときはキーワードを送らない');
  const dark = await publicFile('theme.css');
  assert.match(dark, /:root\[data-theme="dark"\] \.help-tip/);
  assert.match(css, /\.help-tip \{ background: #ffffff;/, 'ライトでは？の説明を白地で出す');
});

test('英語表示：画面に固定で書かれた日本語はすべて英訳を持つ', async () => {
  const html = await publicFile('index.html');
  const missing = staticJapaneseStrings(html).filter((text) => translate(text, 'en') === text && EN[text] !== text);
  assert.deepEqual(missing, []);
  const source = await publicFile('i18n.js');
  const keys = [...source.matchAll(/^ {2}"([^"]+)": /gm)].map((match) => match[1]);
  assert.equal(new Set(keys).size, keys.length, '辞書に重複した見出しがない');
  assert.ok(Object.keys(EN).length >= 300);
});

test('バージョン表記はすべて一致する（不一致だとアプリが起動しない）', async () => {
  const read = (name) => fs.readFile(new URL(`../${name}`, import.meta.url), 'utf8');
  const version = JSON.parse(await read('package.json')).version;
  assert.equal(JSON.parse(await read('app.config.json')).version, version);
  assert.equal(JSON.parse(await read('package-lock.json')).version, version);
  assert.match(await read('server/config.mjs'), new RegExp(`version: '${version.replaceAll('.', '\\.')}'`));
  assert.match(await read('public/index.html'), new RegExp(`<span>v${version.replaceAll('.', '\\.')}</span></footer>`));
  assert.match(await read('public/app.js'), new RegExp(`application\\.ready', \\{ version: '${version.replaceAll('.', '\\.')}'`));
});

test('英語表示：動的な文言と前後の空白を保って訳し、未知の文は元のまま', () => {
  assert.equal(translate('  保存中  ', 'en'), '  Saving  ');
  assert.equal(translate('12ページ', 'en'), '12 pages');
  assert.equal(translate('3ページ把握 / 2ページ保存', 'en'), '3 discovered / 2 saved');
  assert.equal(translate('ページを開いています: https://example.com/a', 'en'), 'Opening page: https://example.com/a');
  assert.equal(translate('除外 2件・限定 0件を次の保存から使います。', 'en'), '2 exclude and 0 include filters apply to the next save.');
  assert.equal(translate('未知の文です', 'en'), '未知の文です');
  assert.equal(translate('保存中', 'ja'), '保存中');
  assert.equal(translate('https://example.com', 'en'), 'https://example.com');
});
