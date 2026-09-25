import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const config = JSON.parse(await readFile(path.join(root, 'app.config.json'), 'utf8'));
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
if (config.version !== packageJson.version) throw new Error('app.config.json と package.json のversionが一致していません。');
const appDetailSpecPath = path.resolve(root, config.appDetailSpecPath || 'AppDetail/Appdetail.md');
const detail = path.join(root, 'AppDetail');
await Promise.all([mkdir(path.join(detail, 'Detail'), { recursive: true }), mkdir(path.join(detail, 'Apptheme'), { recursive: true })]);
const updatedAt = new Date().toISOString();
async function writeJsonKeepingTimestamp(file, value) {
  const previous = await readFile(file, 'utf8').then(JSON.parse).catch(() => null);
  const withoutTime = (item) => JSON.stringify({ ...item, updatedAt: undefined });
  const next = previous && withoutTime(previous) === withoutTime(value) ? { ...value, updatedAt: previous.updatedAt } : value;
  await writeFile(file, `${JSON.stringify(next, null, 2)}\n`);
}
const info = {
  Appname: config.appName,
  Systemname: config.systemName,
  info: 'Webサイトを安全に保存・隔離再生',
  'info-detail': '権限のある公開WebサイトをURL階層に沿って巡回し、HTML、CSS、全srcset画像候補、フォント、GIF、動画、音声、JavaScript、API応答、ブラウザ描画後DOM、open Shadow DOM、Canvas静止画、フォーム表示状態、スクリーンショット、WARC通信記録をローカルへ保存するWebアーカイブアプリ。高精度プロファイルは保存しながら構造を把握し、ページ数・容量・同一サイト深度・素材数・リンク数・実行時間のユーザー上限を設けない。HTMLの軽量探索で全体または指定ページ数を先に把握する方式も選べる。Public Suffix Listに基づく登録可能ドメインと、開始・候補ホストのラベルに一致する固有キーワードで関連サイトを判定し、外部リンクは独立深度を指定する。構造把握を最大16並列、本保存を最大4並列にし、隔離ブラウザ再利用とバッチ確定で高速化する。複数ジョブは全体の公平な並列枠を共有し、CPU・メモリ・ディスク・通信・GPUの端末負荷を記録しながら、高負荷時だけ新しい取得開始数を抑える。保存後は全ページを隔離Chromeで自動表示検査し、画像、フォント、スクロール、通信失敗、JavaScriptエラーを原本とは別の副記録へ保持できる。保存済みサイトは別オリジンのsandbox iframeで隔離再生する。ログイン、投稿、購入、決済、DRM、WebSocket、WebRTCなど閉鎖後のサーバー処理は再現対象外。',
  Version: config.version,
  type: 'Desktop Web / localhost / Node.js 24 / Chrome DevTools Protocol / WARC 1.1',
  'Developer-name': 'MultiApp project',
  terminal: ['Windows 11 / Google Chrome', 'Windows 11 / Microsoft Edge', 'FishLauncher / Codex内ブラウザ'],
  functiontag: ['web-archive', 'site-crawler', 'rendered-dom', 'srcset-capture', 'high-resolution-images', 'dynamic-font-capture', 'cssom-snapshot', 'media-capture', 'warc', 'offline-replay', 'replay-audit', 'runtime-diagnostics', 'system-metrics', 'adaptive-concurrency', 'original-viewport', 'archive-delete', 'compressed-queue-resume', 'repair-recovery', 'capture-recovery', 'blob-integrity', 'single-data-writer', 'graceful-shutdown', 'session-recovery', 'browser-in-browser', 'same-site-keywords', 'public-suffix-list', 'external-depth-limit', 'parallel-capture', 'capture-profiles', 'browser-reuse', 'ssrf-protection', 'localhost'],
  updatedAt
};
const theme = {
  maincolor: config.mainColor,
  Accentcolor: config.accentColor,
  background: config.mainColor,
  fontcolor: config.fontColor,
  darklight: 'Light only',
  LiquidGlass: 'Notsupported',
  color: `Dangerous:#B42318 Safe:#219653 Warning:${config.warningColor}`,
  updatedAt
};
const launch = {
  bootURL: `http://${config.host}:${config.port}/`,
  localbootcmd: `wscript.exe ${path.join(detail, `Appboot_${config.systemName}.vbs`)}`,
  backgroundCommand: `wscript.exe ${path.join(detail, `Appboot-background_${config.systemName}.vbs`)}`,
  stopCommand: `wscript.exe ${path.join(detail, `Appstop_${config.systemName}.vbs`)}`,
  restartCommand: `wscript.exe ${path.join(detail, `AppReload_${config.systemName}.vbs`)}`,
  healthURL: `http://${config.host}:${config.port}/api/health`,
  apiBaseURL: `http://${config.host}:${config.port}/api`,
  replayOrigin: `http://${config.host}:${config.replayPort}`,
  healthContract: { app: config.systemName, ready: true, version: config.version, replayReady: true },
  iframe: { allowed: true, url: `http://${config.host}:${config.port}/`, parentOrigins: config.iframeParentOrigins },
  schemaVersion: 1,
  metadataSource: 'app.config.json + package.json + PLAN.md',
  updatedAt
};
const integration = `# ${config.systemName} 連携情報

- UI: \`http://${config.host}:${config.port}/\`
- API Health: \`GET http://${config.host}:${config.port}/api/health\`
- 再生Origin: \`http://${config.host}:${config.replayPort}\`。管理UIと分離し、保存済み本文だけをsandbox iframeへ表示する。
- 稼働確認: HTTP 200、\`app=${config.systemName}\`、\`ready=true\`、\`version=${config.version}\`、\`replayReady=true\`。
- AppDetail仕様: 同梱の \`AppDetail/Appdetail.md\`。\`npm run appdetail:sync\` でメタデータを同期する。
- 通常起動: Node.jsサーバーを非表示で起動し、専用Chrome / Edgeアプリウィンドウを開く。バックグラウンド起動はサーバーのみ。
- 通常終了: 起動制御は同一Origin/CSRF確認付きの終了APIを使用し、通信中断、未保存URL復元、ブラウザ終了、状態とログの書込みを待つ。所有確認済みプロセスの強制終了は通常終了できない場合の最終手段。
- 待受: 管理 ${config.host}:${config.port}、再生 ${config.host}:${config.replayPort} のloopbackのみ。
- 埋め込み: ${config.iframeParentOrigins.map((origin) => `\`${origin}\``).join(', ')} のFishLauncher親Originだけ許可する。
- 保存先: \`data/archives/<archive-id>/\`。URLをファイル名にせず、SHA-256 blob、manifest.json、collection.warc.gz、screenshotsへ保存する。HTTPでは管理外ファイルを直接配信しない。
- 整合性監査: \`npm run audit:archive -- <archive-id>\` で素材のSHA-256、サイズ、HTML/CSS/srcsetの素材参照、スクリーンショット、WARC gzip、異常な空応答を検査する。ファイル整合性と参照素材の欠落は別判定とし、実表示・ページ操作の検証とは区別する。
- 全ページ表示検査: アーカイブ画面から開始し、保存済みページだけを専用の隔離Chromeで順に開く。画像、フォント、スクロール、HTTP失敗、JavaScript例外をページ単位で確認し、\`replay-audit.json\`へ副記録する。重大な表示失敗だけ証拠画像を残し、manifestとWARC原本、通常の未保存素材回数は変更しない。
- 素材補完: \`npm run repair:srcset -- <archive-id>\` で未保存srcset・拡大画像候補を安全なGETで取得する。アプリ停止中のみ利用可能。準備記録を先に保存してWARC・manifest・件数を同期し、途中停止した更新は起動時に一度だけ復旧する。元ページの本文は変更しない。想定外のWARC変更・準備記録破損は上書きせず、対象アーカイブの変更を止めてログへ記録する。
- 二重書込み防止: アプリポートが違う場合も、同じ保存先の実体パスを使用するwriterを状態読込みより先に拒否する。Windowsではプロセス終了時に解放されるNode.js標準named pipeを使用する。仕様: https://nodejs.org/download/release/latest-v24.x/docs/api/net.html#ipc-support
- 動的表示: JavaScriptから生成された読み込み済みFontFaceの原本と、style要素のCSSOM変更をHTMLへ保持する。高解像度・遅延画像URL属性を取得・参照検査・再生書換えで共通使用する。保存時の表示幅・高さへ切替可能。埋め込み再生通知は直接親へ送り、navigationIdで古い文書の通知を除外する。未保存ページ、素材欠落、動作エラーは成功表示とは分ける。
- 品質診断: 表示に影響する欠落、認証/決済の外部サービス境界、計測系の未取得を分離する。再計算した品質は一覧へ保存する。点数が高くても任意の全操作を完全再現する証明にはならない。
- 外部通信: 利用者が入力した公開http/https URLへの保存時のみ。localhost、LAN、link-local、予約IP、クラウドmetadata、userinfo付きURLを拒否し、リダイレクトごとに再検査する。
- 深度: 文書リンクだけを1階層として数える。Public Suffix Listに基づく登録可能ドメインが同じURLと、開始・候補ホストのラベルで登録語が一致するURLを関連サイトとする。外部取得深度はメインまたは関連サイトから最初の外部ページを1とし、外部ページ内を辿るごとに増える。素材は文書階層へ加算しない。
- 高精度: ページ数、容量、同一サイト深度、素材数、リンク数、実行時間を制限せず、全素材種別、srcset候補、open Shadow DOM、Canvas静止画、フォーム表示状態、通常倍率1倍、全体スクリーンショット、WARC通信記録を自動保存する。password/file入力は保存しない。
- 停止回避: 各ページのブラウザ処理全体を120秒で打ち切って次へ進む。ログイン誘導先は同一origin/path単位で1回だけ保存し、循環転送・無限スクロール・終了しない描画処理を内部安全装置で停止する。
- 構造把握: 保存しながら把握、指定ページ数を軽量探索後に保存、全ページを軽量探索後に保存から選択する。高精度はJavaScript生成リンクを取りこぼしにくい保存しながら把握を既定にする。
- 高速化: 構造把握は2・4・8・16並列、本保存は1〜4並列。隔離ブラウザと検査proxyをページ間で再利用し、manifestとジョブ状態をバッチ確定する。WARCはgzipレベル1の可逆圧縮。
- 全体負荷: 複数ジョブはFIFOの全体枠（本保存4、構造把握8）を共有する。CPU・メモリ・ディスク・通信・GPUが高負荷のときは、新しく開始する取得数だけを段階的に抑える。実行中の書込みとジョブ内設定は変更しない。
- 負荷記録: 端末全体の数値を10秒ごとに\`runtime/metrics/\`へ日別JSONLで記録し、7日後に削除する。端末名、インターフェース名、IP、MACアドレスは記録しない。\`GET /api/diagnostics/metrics\`と管理画面で確認でき、取得不能値は0ではなく未取得とする。
- アーカイブ管理: 0ページ失敗を含む保存結果を一覧化し、60件単位の検索・追加表示で大量記録の負荷を減らす。削除APIは同一OriginとCSRF tokenを要求し、使用中または補完復旧できない保存先は拒否する。再起動後のCSRF失効はsession APIから自動更新し、拒否された変更操作だけ最大1回再試行する。
- ローカル再生: 保存済みCSS、画像、フォント、動画、JavaScript module、GET fetch/XHR、GETフォーム、History API、Workerを再生Originへ接続する。picture/sourceの複数行srcsetを含むPC・モバイル画像候補も再生URLへ書き換え、未保存通信と更新系操作は遮断する。
- 送信操作: POST、フォーム送信、購入、削除、ログインは実行しない。変更APIは同一OriginとCSRF tokenを要求する。
- 再現対象外: 閉鎖後の検索、投稿、認証、決済、WebSocket、WebRTC、Push、DRM、時刻・利用者依存APIはNotsupported。
- 外部依存: tldts 7.4.11（MIT License）をPublic Suffix Listに基づくドメイン判定、Lucide 1.46.0（ISC License）を管理画面の操作アイコンに使用する。
`;
await Promise.all([
  writeFile(path.join(detail, 'Appdetail.md'), await readFile(appDetailSpecPath)),
  writeJsonKeepingTimestamp(path.join(detail, `Appinfo_${config.systemName}.json`), info),
  writeJsonKeepingTimestamp(path.join(detail, `Apptheme_${config.systemName}.json`), theme),
  writeJsonKeepingTimestamp(path.join(detail, `AppLaunch_${config.systemName}.json`), launch),
  writeFile(path.join(detail, 'Detail', `Integration_${config.systemName}.md`), integration)
]);
console.log(`AppDetail synced: ${config.systemName} ${config.version}`);
