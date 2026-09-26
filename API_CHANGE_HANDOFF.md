# WebCapture API互換性メモ（旧名 SiteVault）

2026-09-14。既存の管理APIのURL、認証、既定の応答形式は維持する。

- `GET /api/archives/:id` は従来どおり `ok`、`archive`、`manifest`、`runtimeMisses` を返す。
- `GET /api/archives/:id?view=diagnostics` を追加。管理画面の欠落件数更新用に、巨大なmanifestと欠落URL一覧を除いた `ok`、`archive`、`runtimeMisses`（件数・更新時刻等）を返す。既存クライアントに変更は不要。
- 品質情報に `referenceChecked` を追加。既存項目は維持し、未検査の記録を素材欠落0だけで検査済みと扱わない。
- 隔離再生は保存された403・405等を200に変えず返し、単一bytes Rangeに206/416、HEADに本文なしで応答する。GET/HEAD限定と外部通信遮断は維持する。
- 保存素材・旧アーカイブ・圧縮キューの形式は変更しない。圧縮キューの再開時だけ既存形式を展開する。
- 新規ブラウザ保存のHTMLに読み込み済みFontFaceのCSS原本とCSSOM変更を保持し、preservationへ`capturedFontFaces`件数を追加する。旧記録は変更しない。既存クライアントは追加項目を無視できる。
- 埋め込み再生のリンク/フォーム通知も直接親へ統一し、既存の通知typeを維持する。

検証：`Test/save-replay-regressions.test.mjs` と `Test/server.test.mjs`。他アプリの起動・接続先は変更しない。

## 2026-09-15 追加互換情報

- `GET /api/session` は現在のCSRF tokenを返す。再起動後に`CSRF_REJECTED`となった管理UIだけがtokenを更新し、拒否された変更操作を最大1回再試行する。Origin/Host/CSRF検査は維持する。
- `POST /api/system/shutdown` は通常終了用の追加API。既存と同じOrigin/CSRF検査後に202を返し、保存・ブラウザ・状態・ログの終了を待つ。起動制御が使用する。
- 再生URLとiframe通知に`navigationId`を追加。同じURLの古い文書から届いた通知も識別する。通知typeと`archiveId`/`url`等の既存項目は維持する。
- 品質へ`serverBoundaryCount`、`auxiliaryRuntimeMissingCount`を追加し、表示欠落と認証/決済・計測通信を分離する。品質再計算後の一覧用記録も更新する。
- 管理UIのページング指定は60件。全件を返す旧`GET /api/archives`と通常bootstrapの応答は変更しない。`q`/`offset`/`limit`で明示的にページングを選ぶ経路の既定値を60件にする。
- 中断したオフライン補完は起動時に復旧する。破損や想定外WARC変更で復旧できないアーカイブの詳細には、任意の`archive.repairRecovery={status:'failed',message:...}`を追加する。ページの読込みAPIは利用可能だが、対象の再開・補完・削除は拒否する。他アーカイブには影響しない。
- 同じデータ保存先に対する別ポートの二重起動も、状態を読み込む前に拒否する。保存形式と既存ポートは変更しない。

検証：`Test/offline-guard.test.mjs`、`Test/repair-transaction.test.mjs`、`Test/repair-archive.test.mjs`、`Test/server.test.mjs`。他アプリの必須対応はない。

通常保存にも中断復旧を適用した。保存準備中のpause/cancelは制御状態を維持し、未確定の件数・訪問済みURLを先に永続化しない。復旧待ちは同じ任意項目`archive.repairRecovery`とログで扱い、管理API・保存manifestの形・既存URLは変更しない。内部の準備記録に保存ジョブ状態とそのSHA-256を追加したが、古い補完準備記録も読み込める。過去の欠落アーカイブを自動的に完全保存へ変えるものではない。検証：`Test/capture-transaction.test.mjs`。

## 2026-09-15 負荷記録と全体並列制御

- `GET /api/diagnostics/metrics?limit=N`を追加し、数値化した端末負荷の直近記録と最新値を返す。変更操作ではなく、既存のHost制限を受ける読取り専用API。
- `GET /api/bootstrap`と`GET /api/snapshot`へ任意の`metrics`と`load`を追加した。`metrics`はCPU・メモリ・ディスク・通信・GPU、`load`は構造把握/本保存の実行数・待機数・現在上限。既存項目は変更しない。
- 複数ジョブは全体で本保存4、構造把握8の公平な枠を共有する。高負荷時は新規開始枠だけを2分の1または4分の1へ下げ、実行中処理と利用者が選んだジョブ内並列設定は変更しない。
- 記録は10秒間隔、7日保持。端末名、インターフェース名、IP、MACアドレスは記録しない。取得不能値は`available=false`と`null`で返す。

検証：`Test/load-governor.test.mjs`、`Test/system-monitor.test.mjs`、`Test/server.test.mjs`。既存クライアントの必須対応はない。

## 2026-09-15 全ページ表示検査

- `POST /api/archives/:id/replay-audit`で保存済みページの表示検査をFIFOで開始する。管理画面の変更APIと同じOrigin/CSRF検査を使用する。
- `GET /api/archives/:id/replay-audit`は進捗、集計、最大30件の問題ページを返す。`?view=full`を明示した場合だけページ別の完全な結果を返す。
- `POST /api/archives/:id/replay-audit/cancel`で停止できる。アーカイブ削除時は検査ブラウザの終了を待ってから削除し、削除後に副記録を再作成しない。
- 検査は再生Originだけへ接続する専用Chromeで、画像、フォント、全体スクロール、HTTP失敗、JavaScript例外を確認する。外部サイトへ再接続しない。
- 結果は`replay-audit.json`へ保存し、manifest、WARC、保存素材を変更しない。検査による反復アクセスは通常の未保存素材回数へ加算しない。

検証：`Test/replay-auditor.test.mjs`、`Test/server.test.mjs`。既存APIの応答形は変更しない。

## 2026-09-22 v2.0.0 保存忠実度の改修

既存APIのURL・認証・既存項目の意味は変更しない。追加だけを行う。

- 保存オプションに任意項目を追加: `loadWaitMs`、`finalizeGraceMs`、`interactDuringCapture`、`interactionMaxMs`、`interactionSettleMs`、`maxInteractionsPerPage`、`mediaMaxBytes`（`null`は無制限）。`requestTimeoutMs`の上限を6時間、`networkIdleMaxMs`を10分、`imageWaitMs`を5分へ広げた。省略時は従来どおりの既定値が入る。
- 1ページの保存が`requestTimeoutMs`を超えても失敗にせず、その時点までの内容を保存する。ページ記録の`preservation`に任意の`partialCapture`、`serializeFallback`、`interactions`、`attachedTargets`が付く。完全な失敗は`finalizeGraceMs`を過ぎた場合だけ。
- manifestの素材に任意の`charset`（本文の文字コード）を追加。再生時の文字コード判定に使う。古い記録は中身から判定する。
- manifestに任意の`deferredMedia`（上限超過で未保存の動画・配信）と`postResponses`（ページが送ったPOSTの保存済み応答。キーは`POST <URL> <要求本文SHA-256>`）を追加。従来の`resources`はGET専用のまま変更しない。
- `GET /api/archives/:id/deferred-media`: 未保存の動画・音声の一覧と後追い保存の進捗。`POST`（Origin/CSRF検査あり）で`{ urls?: string[] }`を指定して開始する。保存処理中のアーカイブは409、対象なしは404。
- 再生サーバーに`GET /archive/:id/post?url=&digest=&canonical=`を追加。再生ページ内のfetch/XHRのPOSTはこのGET照会へ置き換わる。再生サーバーはGET/HEAD限定のまま。
- 再生ページのCSP `frame-ancestors`に`app.config.json`の`iframeParentOrigins`を加えた。管理UIの許可元も同じ設定から読む。
- 再生ページは元サイトのパスへ`history.replaceState`で切り替わり、同一originの未知パスへの再読込は`sitevault_replay` Cookieを使って保存ページへ302で戻す。
- WARCに`request`レコード（POST本文）を追加し、応答レコードの`content-length`を実際の本文長に揃えた。

検証：`Test/browser-capture.test.mjs`、`Test/charset.test.mjs`、`Test/media-capture.test.mjs`、`Test/deferred-media.test.mjs`、`Test/post-replay.test.mjs`、`Test/replay-fidelity.test.mjs`、`Test/policy.test.mjs`。他アプリの必須対応はない。
- 再生の素材URLを`/archive/:id/web/<元のURL>`形式に変えた。元のパス構造が残るため、HLSの子リストのように相対パスで次のファイルを組み立てるスクリプトも保存データへ届く。従来の`/archive/:id/resource?url=`は引き続き受け付ける。
- 再生ページでは`Math.random`をページURLから決まる系列に固定し、`Date`を保存時刻から進める。保存時も同じ乱数系列を使うため、乱数で選ばれる画像や時刻依存の表示が保存時と一致する（保存オプション`deterministicRandom: false`で無効化できる）。
- 計測・テレメトリ送信先（Google Analytics、Shopify monorail/otlp、Cloudflare RUMなど）への未保存POSTは、再生時に204の空応答を返し欠落として数えない。それ以外の未保存POSTは404と欠落記録のまま。
- 再生ページ内で`new FontFace()`に渡されたURLも保存データへ置き換える。
- 素材補完で元サイトが404/410を返した参照は「元サイト側で既に存在しない」として`referenceAudit.originMissingCount`に分けて数え、表示欠落には含めない。

## 2026-09-24 v2.1.0 残りの保存漏れとUI整理

既存APIのURL・既存項目の意味は変更しない。追加だけを行う。

- 保存オプションに任意項目`hoverDuringCapture`、`hoverMaxMs`、`maxHoversPerPage`を追加。保存中にメニュー等へ実際にマウスを乗せ、表示された素材を保存する。ページ記録の`preservation`に任意の`hovers`（候補数・実施数）と`canvasBlank`を追加。
- manifestのページ記録に任意の`file: true`、`mimeType`、`size`を追加。PDF・ZIP・画像などページ以外のリンク先を素材として保存したもの。再生の`/archive/:id/page?url=`は、このページや、ページとして保存していない素材URLに対して案内ページを返す。案内ページは`sitevault-open-file`通知（`path`は再生サーバー上の素材パス）を親へ送り、管理UIが別タブで開く。
- manifestに任意の`resourceVariants`（URLごとの配列。各要素は素材と同じ項目＋`pages`）を追加。同じURLでもページごとに内容が違う応答を保存する。再生では`sitevault_replay` Cookieに現在のページURL全体を入れ（従来はoriginのみ）、該当ページの版を返して`x-sitevault-resource-variant: 1`を付ける。
- 再生の応答で、保存時点のエラー応答には`x-sitevault-archived-status`を付ける。全ページ表示検査の集計に`archivedErrorResponses`を追加（表示不良には数えない）。
- 管理UIの保存画面・アーカイブ画面の配置を変更した。要素IDは維持している。中断中の保存は`/api/jobs/:id/resume`・`cancel`を従来どおり使う。
- 起動時に30分以上前の使い捨てブラウザフォルダ（OSの一時フォルダ内`sitevault-browser-*`）を削除する。

検証：`Test/browser-capture.test.mjs`、`Test/crawler-options-integration.test.mjs`、`Test/media-capture.test.mjs`、`Test/replay-fidelity.test.mjs`、`Test/replay-auditor.test.mjs`、`Test/server.test.mjs`。他アプリの必須対応はない。

## 2026-09-24 v2.1.1 プレビューが重くなる・落ちる問題の修正

- 再生をアーカイブごとの別ホスト`a-<ID>.localhost:43194`（例: `archive_abc_123` → `a-abc-123.localhost`）で表示する。管理画面（127.0.0.1）と別サイトになるため、Chromeが別プロセスで動かし、重いページや停止したページが管理画面を巻き込まない。アーカイブ同士も別オリジンになる。従来の`127.0.0.1:43194`も引き続き受け付ける（全ページ表示検査・他アプリ向け）。別ホストで別アーカイブを要求すると403。
- `/api/bootstrap`の`config`に任意の`replayPort`を追加。管理UIのCSP `frame-src`に`http://*.localhost:43194`を追加。
- 別サイトの埋め込みではCookieが送られないため、再読込時の元パス復元とページごとの版選択は、そのアーカイブで直前に表示したページをサーバーが記憶して判断する（Cookieがある場合はCookieを優先）。
- 再生ページは1秒ごとに`sitevault-heartbeat`（`busy`・`memory`）を親へ送り、処理が重いと`sitevault-heavy`を1回送る。管理UIは通知を出し、応答が途絶えたら自動で軽量表示へ切り替える。
- `/archive/:id/page?url=&mode=light`で軽量表示（ページのスクリプト・イベント属性・自動再生・アニメーションを止める）。同じアーカイブの入れ子の埋め込みにも適用する。
- `sitevault-navigate`通知に`source`（`click`・`form`・`script`）を追加。http/https以外への移動は送らない。管理UIはスクリプトによる同じページへの移動を無視し、15秒間に3回を超える自動移動を止める。

検証：`Test/replay-fidelity.test.mjs`（別ホスト・軽量表示・応答確認・移動の抑制）。他アプリの必須対応はない。

## 2026-09-24 保存中のライブ表示（v2.2.0）

既存APIのURL・送る/返すデータ・認証・保存形式は変更しない。以下はすべて追加。

- `GET /api/jobs/:id/live`: 保存中の枠（並列数ぶん）の状態を返す。`{ ok, jobId, status, phase, slots: [{ index, url, title, phase, phaseLabel, frameSeq, hasFrame }] }`。呼ばれてから5秒間は「見ている人がいる」とみなし、保存中のブラウザから画面を配信する。呼ばれなければ配信しない。保存中でないジョブは`slots`が空。存在しないジョブは404。
- `GET /api/jobs/:id/live/:slot/frame`: その枠の最新画面（JPEG、最大960×720）。画面がなければ204。GET以外は405。
- どちらも読み取り専用で、既存のGET APIと同じくHost検査のみ（CSRFは不要）。応答は`cache-control: no-store`。画面はメモリにだけ置き、保存データには残さない。
- 共有ブラウザで開く保存用タブを別ウィンドウで開くように変更（裏タブは描画が止まり画面が取れないため）。保存結果の形式は変わらない。

検証：`Test/live-view.test.mjs`（枠の状態・間引き・配信の開始停止・実ブラウザ2並列での画面取得）、`Test/server.test.mjs`（404・405）。他アプリの必須対応はない。

## 2026-09-24 低負荷モード・中断中アーカイブ（v2.3.0）

- 追加: `GET /api/settings` → `{ ok, settings: { lowImpactMode } }`。`POST /api/settings` `{ lowImpactMode: boolean }`（Origin/CSRF必須、boolean以外は400）→ `{ ok, settings, load }`。設定は`data/settings.json`に保存し、既定はON。
- `load`（bootstrap/snapshot）に`lowImpact`（boolean）を追加。`pressure`に`'off'`（OFF時）を追加。既存の`normal`/`high`/`critical`は維持。critical時の構造把握枠は1に変更。
- 保存設定の上限: `concurrency`は1〜10（従来1〜4、v2.3.1で10へ）、`discoveryConcurrency`は1〜32（従来1〜16）。全体枠の既定は10・32（環境変数で従来値に戻せる）。
- アーカイブ一覧に、一時停止・確認待ちのジョブの保存途中のアーカイブが`status: 'paused'|'warning'`（再開後は`'running'`）で含まれるようになった。記録に任意項目`jobId`を追加。完了時は従来どおりの記録で上書きされる。一覧を読む他アプリは、完了済みだけを扱う場合`status`で絞り込むこと。

検証：`Test/server.test.mjs`（設定API）、`Test/load-governor.test.mjs`、`Test/capture-options.test.mjs`、`Test/crawler-options-integration.test.mjs`（中断中アーカイブ）。

## 2026-09-25 自動取り直し・保存中アーカイブ（v2.4.0）

- manifestに任意項目`pageRetries`（URLごとに`{ url, attempts, status: 'retrying'|'recovered'|'failed', reasons[], updatedAt, nextAttemptAt? }`）を追加。保存設定に`pageRetries`（0〜5、既定2）を追加。
- アーカイブ一覧に、保存中のジョブのアーカイブが`status: 'running'`で含まれる（v2.3.0の一時停止中に加えて）。完了時は通常の記録で上書き。完了済みだけを扱う他アプリは`status`で絞り込むこと。
- 待ち行列の項目に任意項目`attempt`・`notBefore`（取り直しの回数と開始可能時刻）を追加。

検証：`Test/crawler-options-integration.test.mjs`（取り直し・保存中アーカイブ）、`Test/capture-transaction.test.mjs`。

## 2026-09-25 並列上限の拡大と最適化モード（v2.5.0）

- 保存設定: `concurrency`は1〜30、`discoveryConcurrency`は1〜64。`optimize`（boolean、既定false）を追加。全体枠の既定は30・64。
- `GET/POST /api/settings`: `optimizeMode`（boolean）と、読み取り専用の`optimized`（`{ jobId, startUrl, status, capture, discovery, reductionCount, updatedAt }`またはnull）を追加。POSTは`lowImpactMode`・`optimizeMode`のどちらか1つ以上が必要（空は400）。
- `optimizeMode`がONのとき、`POST /api/jobs`は送られた同時保存数・構造把握数を無視して30・64で開始し、`options.optimize: true`を記録する。
- ジョブに任意項目`tuning`（`{ capture, discovery, start, reductionCount, lastReduction }`）を追加。

検証：`Test/concurrency-tuner.test.mjs`、`Test/crawler-options-integration.test.mjs`（最適化モードで実際に下がる）、`Test/server.test.mjs`、`Test/capture-options.test.mjs`。

## 2026-09-25 v2.7.0

- 保存設定に`blockTrackers`（boolean、既定true）を追加。`GET /api/jobs/:id/live`に`pollMs`（推奨の問い合わせ間隔）と`streamPaused`（負荷が非常に高く映像を止めている）を追加。既存項目は変更なし。

## 2026-09-25 v2.7.1

- manifestの素材に任意項目`emptyConfirmed`（元のサーバーが200・0バイトを返すことを取り直しで確認済み）を追加。品質判定では保存済みとして扱う。外部サービスの境界の判定に、accounts.google.com/gsi/、api.x.com・api.twitter.comの/1.1/(flow|graphql)/viewer…、shop.app/__manifest を追加。

## 2026-09-25 v2.8.0（段階A）

- 保存設定に追加: `externalDetail`（'full'|'standard'|'light'、既定'full'）、`distributedAccess`（既定true）、`perHostConcurrency`（1〜30、既定2）、`perHostIntervalMs`（0〜60000、既定1000）、`autoExcludeAccountPages`（既定true）、`repairBeforeComplete`（既定true）。画面の保存プロファイル（高精度・標準・高速）は廃止し、画面は常に最大の詳しさの値を送る。
- `GET /api/archives/:id`（通常表示）に`issueReport`（原因別の`categories`・`problemCount`・`outOfScopeCount`）を追加。
- `/api/settings`に`notifyOnComplete`（既定true）を追加。
- manifestの`pageRetries`に`repaired: true`（完了前の自動修正で取れた）、素材に`repaired: true`（完了前に取り直した）を追加。
- 同じ登録ドメイン内の転送は外部の階層を増やさない（保存範囲の判定変更）。

## 2026-09-25 v3.0.0（段階B・C）

- 追加API: `GET /api/search?q=&limit=`（`{ results: [{ archiveId, archiveTitle, url, title, snippet }], total }`）。`GET /api/logins`、`POST /api/logins`（`method: 'paste'|'chrome'|'edge'|'manual'`、`name`、`text`、`siteUrl`、`url`）、`POST /api/logins/:id/open`（`url`）、`DELETE /api/logins/:id`。変更系はOrigin/CSRF必須。Cookieの中身は応答・ログに含めない。
- 保存設定に`loginProfileId`（存在しないIDは400）、`sharePages`（既定true）を追加。
- アーカイブ記録に任意項目`loggedIn: true`。manifestに任意項目`sharedPages`（`[{ url, archiveId, pageUrl, depth, externalDepth, from, sharedAt }]`）、ジョブに`sharedPages`（件数）。
- 再生: 共有ページを開くと、参照先アーカイブの再生URLへ302で転送（`navigationId`・軽量表示を引き継ぐ）。管理画面は参照先アーカイブのオリジンからの通知も受け付ける。
- `DELETE /api/archives/:id`: ほかのアーカイブから共有で使われている場合は409（`ARCHIVE_SHARED`）。
- 新しい保存データ: `data/logins/`（ログイン用プロファイル）、`data/shared/`（ページ索引と参照）、アーカイブ内`search-index.jsonl`。既存データはそのまま読める。
- v3.0.1: `POST /api/logins`（method: 'manual'）と`POST /api/logins/:id/open`は`url`省略可（省略時は検索ページを開く）。
- v3.0.2: `perHostConcurrency`は0（または'unlimited'）で無制限。

## 2026-09-25 v3.1.0

- APIのURL・送受信の形・認証は変更なし。
- 管理画面は既存の保存設定項目`includeUrlPatterns`・`excludeUrlPatterns`（最大50件、`*`は任意の文字）に、設定タブの入力を送るようになった。`*`を含まない行は前後に`*`を付けて部分一致にしてから送る。
- 設定の「レガシー機能（同一サイト扱いキーワード）」がOFFのとき、管理画面は`sameSiteKeywords: []`を送る。APIは従来どおりキーワードを受け付ける。
- 低負荷モードの負荷段階に`elevated`（少し減速）を追加。`/api/snapshot`等の`load.pressure`に`elevated`が入ることがある。未知の値を「計測中」等として扱うクライアントは変更不要。
- 負荷の計測間隔の既定を10秒から5秒に変更（`SITEVAULT_METRICS_INTERVAL_MS`で変更可）。

検証：`Test/ui-settings.test.mjs`、`Test/load-governor.test.mjs`、`Test/login-profiles.test.mjs`。他アプリ側の必須対応はない。

## 2026-09-25 v3.1.1

- 再生`GET /archive/:id/page?url=`：保存していないURLでも、保存時に「ログイン誘導先は保存済みです」「転送先は保存済みです」と記録された転送元（使い捨ての鍵だけ違うURLを含む）なら、404ではなく保存済みページへの302を返す。`navigationId`・軽量表示は引き継ぐ。本当に保存していないページは従来どおり404。
- manifestの`pageRetries[].status`に`skipped`（転送先が保存範囲外で打ち切り）が加わり、転送で片付いた場合は`resolution`（文字列）が付く。`recovered`/`failed`/`retrying`の意味は変えない。
- 再生ページに差し込むスクリプトで、パスキー（`navigator.credentials.get/create`の`publicKey`）を拒否する。

検証：`Test/account-redirects.test.mjs`。他アプリ側の必須対応はない。

## 2026-09-25 v3.2.0

追加API（すべて既存と同じOrigin/CSRF検査。GETは読み取りのみ）：
- `GET /api/archives/:id/storage` → `{ storage: { categories: [{ key, label, bytes, count }], totalBytes } }`（key: media/image/background/font/system/page/data/screenshot/warc/other）。
- `GET /api/archives/:id/retry-plan` → `{ plan: { failedPages, failedPageCount, loginSites: [{ host, count, sample }], missingResourceCount, busy, remainingCount } }`。
- `POST /api/archives/:id/continue` → 中止・上限停止などで残ったページから同じアーカイブへ保存を続ける（202、`{ job }`）。残りがなければ409 `NOTHING_TO_CONTINUE`、保存中は409 `ARCHIVE_BUSY`。
- `POST /api/archives/:id/retry`（`{ includeFailed, loginHosts, skipHosts, loginProfileId }`）→ 同じアーカイブへ取り直す新しいジョブ（`kind: 'retry'`）を作る。`loginHosts`があるのに`loginProfileId`がなければ400 `LOGIN_PROFILE_REQUIRED`。
- `POST /api/archives/:id/resave` → 同じ設定で新しいアーカイブを作るジョブ。完了したアーカイブに`previousArchiveId`が付く。
- `GET /api/archives/:id/diff`、`GET /api/archives/:id/diff-page?url=` → 前回との追加・削除・変更ページと行単位の差分。
- `GET /api/archives/:id/export?format=sitevault|wacz` → 1ファイルでダウンロード（SiteVault形式はtar、WACZはZIP）。保存中は409。
- `POST /api/archives/import`（本文は.sitevaultファイルそのもの）→ 201 `{ archive, fileCount, sharedPagesExcluded }`。
- `POST /api/jobs/:id/start-capture`（`{ excludeHosts }`）→ 「把握だけ」で止まっているジョブ（status `discovered`）の保存を始める。`cancel`で把握結果を破棄（アーカイブは作らない）。

保存設定の追加：`discoveryMode: 'separate'`、`discoveryMethod: 'http'|'browser'`、`discoveryConcurrency`上限64→256、`mediaStrategy: 'inline'|'background'`、`mediaSpeed: 'slow'|'normal'|'fast'`、`maxInteractionsPerPage: null`（無制限）、`interactionMode: 'all'|'representative'`。
ジョブの状態に`discovered`（把握済み・確認待ち）を追加。品質（`quality`）に`externalIssueCount`等と`scoring: 'start-site'`を追加し、点数は保存を始めたサイトだけで付ける。

検証：`Test/continue-retry.test.mjs`、`Test/discovery.test.mjs`、`Test/media-lane.test.mjs`、`Test/resave-diff.test.mjs`、`Test/export-import.test.mjs`、`Test/interaction-mode.test.mjs`。他アプリ側の必須対応はない。

## 2026-09-25 v3.2.1

公開APIのURL・送受信データの形は変更なし。挙動の変更：
- 再生サーバー `GET /archive/:id/page?url=`：未保存でもログイン系のURL（同じ配信元・同じ先頭パスで login/auth/authentication 等を含む）は、保存済みのログイン画面へ302で案内する。本当に該当がなければ従来どおり404。
- 再生ページの`<template shadowrootmode="open">`は`data-sitevault-shadowrootmode`へ書き換えて返し、部品が自分で中身を作らなかった場合だけ後から戻す（保存ファイルは書き換えない）。
- 再生iframeの通知（`sitevault-ready`等）は、転送で表示ページが変わった場合、同じ`navigationId`なら新しい`pageUrl`で届く。管理画面側はそれを採用して表示する。
- 保存時の転送の外部深度の数え方を変更（リンク1回＝1段）。新しく保存したアーカイブにだけ影響する。

検証：`Test/redirect-chain.test.mjs`、`Test/save-replay-regressions.test.mjs`。他アプリ側の必須対応はない。

## 2026-09-25 v3.2.2

公開APIのURL・送受信データの形は変更なし。再生サーバーの追加：
- `GET /archive/:id/page?url=...&mode=static` を追加（元のページのスクリプトを外して保存時の見た目で返す。`mode=light`と違い動きは止めない）。転送（302）でも`mode`を引き継ぐ。
- 再生iframeから管理画面への通知に`sitevault-static-fallback`（`{ type, archiveId, pageUrl, navigationId, reason: 'collapsed' }`）を追加。直後に同じ`navigationId`の固定表示ページが読み込まれる。知らない通知として無視しても動作に問題はない。
- 再生HTMLの`<link imagesrcset>`を保存済みURLへ書き換える。

検証：`Test/replay-dynamic.test.mjs`。他アプリ側の必須対応はない。

## 2026-09-25 v3.3.0

既存APIの形は変更なし。追加のみ：
- `GET /api/archives/:id?view=summary`：画面用の要約。`manifest`から`resources`・`resourceAliases`・`postResponses`・`resourceVariants`・`blocked`を除き、`pages[]`は`url/requestedUrl/title/depth/scope/externalDepth/html/file/capturedAt/quality(分類・段階・点数)`だけ。`runtimeMisses`は`items`なし。`view`なしの従来の応答はそのまま。
- 再生サーバー `POST /archive/:id/post?url=&digest=&canonical=`：本文に元の送信本文、`x-sitevault-request-type`に元のContent-Type、`x-sitevault-page`に開いているページURL。応答ヘッダー`x-sitevault-post-match`に`similar`・`similar-path`・`page-identity`等が加わる。従来の`GET`もそのまま。他のパスへのPOSTは従来どおり405。
- 再生サーバー `GET /archive/:id/warm?url=`（事前準備ページ）と `GET /archive/:id/warm-list?url=`（`{ urls, bytes, truncated }`）。
- 再生サーバーの素材応答に`ETag`（`"sv-<版>-<内容の指紋>-<n|l>"`）と`Cache-Control`（画像等`private, max-age=86400`、書き換える素材`private, no-cache`）が付き、`If-None-Match`で304を返す。未保存・エラーは従来どおり`no-store`。

検証：`Test/replay-speed-capture.test.mjs`、`Test/server.test.mjs`。他アプリ側の必須対応はない。

## 2026-09-26 v4.0.0（SiteVault → WebCapture 改名）

何を変更したか：アプリ名を SiteVault から WebCapture へ全面変更した。

| 項目 | 旧 | 新 | 互換性 |
| --- | --- | --- | --- |
| 環境変数 | `SITEVAULT_*` | `WEBCAPTURE_*` | 旧名も読む（新名の指定を優先） |
| 書き出し形式 | `.sitevault`（`sitevault-archive`、`sitevault-export.json`） | `.webcapture`（`webcapture-archive`、`webcapture-export.json`） | 旧形式も読み込める。`/api/archives/:id/export?format=sitevault` も従来どおりWebCapture形式で返す |
| 管理APIのCSRFヘッダー | `x-sitevault-csrf` | `x-webcapture-csrf` | 画面と同時に更新（外部アプリからの利用なし） |
| 再生サーバーの独自ヘッダー | `x-sitevault-*` | `x-webcapture-*` | 再生ページと同時に更新 |
| 再生iframeの通知 | `sitevault-ready` など | `webcapture-ready` など | 管理画面と同時に更新 |
| 保存HTMLの印 | `data-sitevault-*` | `data-webcapture-*` | 旧印は再生時に新しい名前へ読み替える（保存データは書き換えない） |
| 画面設定（ブラウザ保存） | `sitevault.uiPrefs` など | `webcapture.uiPrefs` など | 旧設定も読む |
| ログファイル | `sitevault-YYYY-MM-DD.jsonl` | `webcapture-YYYY-MM-DD.jsonl` | 古いログも7日で自動削除 |
| 起動ファイル | `AppDetail/*_SiteVault.*`、`SiteVaultController.ps1` | `*_WebCapture.*`、`WebCaptureController.ps1` | ランチャー側の登録の確認が必要 |

影響を受ける可能性があるアプリ：MultiAppのランチャー（起動ファイル名・フォルダ名の変更）。それ以外に外部から使うアプリはない。

テスト方法：`Test/rename-compat.test.mjs`、`Test/export-import.test.mjs`（旧 `.sitevault` の読み込み）。

## 2026-09-25 v4.1.0（再現度・保存の継続管理・使い勝手の15機能）

何を変更したか：既存APIのURL・送受信データの形・認証（Origin/Host/CSRF）は変更なし。APIと保存データの項目を追加しただけ。

なぜ：保存したページの再現度を上げ、保存を続けて管理しやすくし、使い勝手を良くするため（`PLAN.md` の v4.1.0 計画）。

### 管理APIの追加（すべて `127.0.0.1` のみ。変更系は従来どおり `x-webcapture-csrf` が必要）

| API | 内容 |
| --- | --- |
| `GET /api/notifications?limit=`、`POST /api/notifications/read`（`{ ids? }`）、`POST /api/notifications/clear` | お知らせ（定期保存・見張り・容量整理・まとめて保存）。`{ items, unread }` |
| `GET /api/schedules`、`GET/POST /api/archives/:id/schedule`、`DELETE /api/schedules/:scheduleId` | 定期保存。`{ frequency: 'hourly'|'daily'|'weekly', hour, minute, weekday, enabled }` |
| `POST /api/archives/:id/meta`（`{ tags, folder, note }`）、`GET /api/archives/facets` | 整理。`GET /api/archives` に `folder`（`__none__`でフォルダなし）と `tag` の絞り込みを追加 |
| `GET /api/pages/history?url=` | 同じページを含むアーカイブの一覧（新しい順） |
| `GET/POST /api/watches`、`POST /api/watches/:id`（`{ enabled, intervalMinutes, label }`）、`POST /api/watches/:id/check`、`DELETE /api/watches/:id` | 変化の見張り。URLは保存と同じ公開アドレス検査を通す |
| `GET/POST /api/storage/dedupe` | 既存の保存データの共有化（バックグラウンド実行と進み具合） |
| `GET /api/storage/cleanup`、`POST /api/storage/cleanup/settings|plan|execute` | 容量の自動整理（設定・整理案・実行）。実行は整理案のIDが必要 |
| `GET/POST /api/batches`（`{ text | urls, options }`）、`POST /api/batches/:id/cancel` | まとめて保存（最大500件、1件ずつ順番） |
| `GET/POST /api/presets`、`DELETE /api/presets/:id` | 保存設定のプリセット（組み込みは削除不可） |
| `GET /api/archives/:id/page-export?url=&format=png|pdf&view=desktop|mobile` | 表示中のページを画像・PDFで書き出し（ファイルを返す） |
| `GET /api/archives/:id/visual?url=` | 見た目の比較の結果 |
| `GET /api/archives/:id/image?path=` | スクリーンショットと比較画像だけを返す（`screenshots/NNNNN(-mobile).png`、`replay-audit/<run>/(screenshots|visual)/*.png` 以外は400） |
| `POST /api/archives/:id/retry` に任意の `action`（`retry`/`retry-gentle`/`retry-spaced`） | 失敗理由に合わせた取り直し設定。省略時は従来どおり |
| `GET /api/archives/:id/storage` の応答に `storage.shared`（`files`・`sharedFiles`・`sharedBytes`） | 共有されている素材の量 |

### 保存オプションの追加（`POST /api/jobs` の `options`）
- `captureMobile`（既定 false）：スマホ表示も保存する。
- `prefetchScripts`（既定 true）：読み込まれなかった同じサイトの部品を先取り保存する。
- 動画なしの保存は既存の `resourceTypes.media: false` を使う。

### 保存データの項目追加（既存データはそのまま読める）
- manifest の `pages[].mobile = { html, screenshot, title, userAgent, viewport, capturedAt }`、`prunedMedia`、`deferredMedia[].pruned`。
- アーカイブ記録の `tags`・`folder`・`note`・`prunedAt`・`prunedMediaCount`・`warcRemoved`。
- 表示検査の記録 `replay-audit.json` の `pages[].visual` と `summary.visualCompared`・`visualMismatchPages`・`visualAverage`（既存項目は維持）。
- `data/` 直下の新しいファイル：`notifications.json`、`schedules.json`、`watches.json`、`batches.json`、`presets.json`、`cleanup.json`。
- 素材の共有化はハードリンクで行うため、`blobs/` のファイルの場所・名前・内容、manifest の形は変わらない。

### 再生サーバーの追加
- `GET /archive/:id/page?...&view=mobile|desktop`：スマホ表示を保存したページはスマホ用HTMLを返す。指定は `webcapture_view` Cookieに残り、ページ内のリンク移動でも保たれる。応答ヘッダー `x-webcapture-view`。
- 保存漏れの素材・送信応答のうち、YouTube（`/youtubei/v1/player|next|browse`）・X（GraphQL）・Shopify（`/products/*.js|json`、`/cart.js|json`）を保存済みデータから組み立てて返す。応答ヘッダー `x-webcapture-site-adapter`。IDが違う応答は代用しない。
- 再生iframeへの通知 `{ type: 'webcapture-find', query, direction }` と、iframeからの返事 `webcapture-find-result`（`count`・`index`）を追加（ページ内検索）。

影響を受ける可能性があるアプリ：なし（外部から使うアプリはない。MultiAppランチャーの起動方法は変わらない）。

他アプリ側で必要な対応：なし。

互換性維持の方法：追加のみ。未知の項目は無視できる。旧バージョンで保存したアーカイブ・書き出しファイルもそのまま開ける。

テスト方法：`Test/management-features.test.mjs`、`Test/fidelity-features.test.mjs`、`Test/feature-api.test.mjs`、`Test/replay-auditor.test.mjs`。

変更しないと起きる問題：なし（機能追加）。

補足（レビュー対応）：`GET /api/archives/:id/page-export` はほかのサイトから呼ばれた場合（`Origin`不一致、`Sec-Fetch-Site: cross-site`）に403を返す。容量の整理は、ほかのアーカイブから共有されているアーカイブを対象にせず、整理中のアーカイブへの取り直し・続き・後から保存・削除を409で断る。Windows通知の文面は、PowerShellが引用符とみなす全角の記号も無害にする。
