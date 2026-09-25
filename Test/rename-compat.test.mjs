import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { applyLegacyEnvironment } from '../server/env-compat.mjs';
import { rewriteHtml, upgradeLegacyMarkers } from '../server/replay.mjs';
import { exportFileName } from '../server/archive-export.mjs';
import { browserCandidates, platformBrowserArgs } from '../server/browser-capture.mjs';
import { LEGACY_UI_PREFS_KEY, UI_PREFS_KEY, readUiPrefs } from '../public/ui-prefs.js';

const root = path.resolve(import.meta.dirname, '..');

test('旧名の環境変数（SITEVAULT_）は新しい名前（WEBCAPTURE_）へ引き継ぎ、新しい名前の指定を優先する', () => {
  const env = { SITEVAULT_PORT: '5000', SITEVAULT_DATA_ROOT: 'old', WEBCAPTURE_DATA_ROOT: 'new' };
  applyLegacyEnvironment(env);
  assert.equal(env.WEBCAPTURE_PORT, '5000');
  assert.equal(env.WEBCAPTURE_DATA_ROOT, 'new');
});

test('旧名で保存したHTMLの印（data-sitevault-）は再生時に新しい名前として扱う', () => {
  assert.equal(upgradeLegacyMarkers('<img data-sitevault-current-src="a.png"><canvas data-sitevault-canvas="x">'), '<img data-webcapture-current-src="a.png"><canvas data-webcapture-canvas="x">');
  const html = rewriteHtml('<html><head></head><body><img src="https://img.example/a.png" data-sitevault-current-src="https://img.example/a.png"></body></html>', 'https://site.example/', 'archive_t', { freezeResponsiveImages: true }, 'n1', {});
  assert.match(html, /data-webcapture-current-src="https:\/\/img\.example\/a\.png"/);
  assert.doesNotMatch(html, /data-sitevault-current-src/);
});

test('旧名で保存した画面設定も読み込み、新しい名前で書き出す', () => {
  const storage = new Map([[LEGACY_UI_PREFS_KEY, JSON.stringify({ theme: 'dark' })]]);
  const prefs = readUiPrefs({ getItem: (key) => storage.get(key) ?? null });
  assert.equal(prefs.theme, 'dark');
  assert.equal(UI_PREFS_KEY, 'webcapture.uiPrefs');
});

test('書き出しファイルは新しい拡張子（.webcapture）で、画面は旧拡張子（.sitevault）も読み込める', async () => {
  assert.match(exportFileName({ title: 'Example', savedAt: '2026-09-26T00:00:00Z' }, 'webcapture'), /\.webcapture$/);
  const html = await fs.readFile(path.join(root, 'public', 'index.html'), 'utf8');
  assert.match(html, /accept="\.webcapture,\.sitevault"/);
});

test('配布向け：画面・パッケージ・起動ファイルに旧名が残らず、Windows以外でもブラウザを探せる', async () => {
  const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'webcapture');
  assert.equal(pkg.license, 'Apache-2.0');
  for (const file of ['public/index.html', 'public/app.js', 'public/i18n.js', 'app.config.json', 'README.md']) {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    assert.doesNotMatch(text.replace(/SITEVAULT_|\.sitevault|sitevault\.(uiPrefs|captureSettings)|name SiteVault/g, ''), /sitevault/i, `${file} に旧名が残っている`);
  }
  assert.ok((await fs.readdir(path.join(root, 'AppDetail'))).every((name) => !/sitevault/i.test(name)));
  assert.equal(browserCandidates('linux', { PATH: '/usr/bin:/bin' })[0], '/usr/bin/google-chrome');
  assert.equal(browserCandidates('darwin', {})[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  assert.equal(browserCandidates('linux', { PATH: '/usr/bin', WEBCAPTURE_BROWSER: '/opt/chrome' })[0], '/opt/chrome');
  assert.deepEqual(platformBrowserArgs('win32'), []);
});

test('配布向け：保存データ・ログ・秘密情報・手元の起動パスはGitに入れない', async () => {
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  for (const pattern of ['node_modules/', 'data/', 'data-*/', 'runtime/', '.env', 'AppDetail/AppLaunch_*.json']) assert.ok(ignore.split(/\r?\n/).includes(pattern), `${pattern} が .gitignore にない`);
  for (const file of ['LICENSE', 'NOTICE', 'README.md', 'AGENTS.md', 'CLAUDE.md']) await fs.access(path.join(root, file));
});
