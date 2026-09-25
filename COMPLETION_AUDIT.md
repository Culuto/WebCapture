# WebCapture Completion Audit

## 追記：v2.1.0（2026-09-24 JST）

- マウスを乗せると出るメニュー、Shadow DOM内のリンク、PDFなどページ以外のリンク先、ページごとに違う応答、WebGLの描画を保存できるようにした。恒久テスト119件成功。
- apple.com/jp を高精度で保存し、ホバー300件・素材433件、参照欠落0（元サイトで既に404の152件は分離）。再生で壊れた画像0・欠落0・実行エラー0・外部通信0。KKVVの再生も欠落0を維持。
- 同じURLでも条件で変わる応答は「ページごとの版」まで保存できるようになった。時刻・Cookie・操作順ごとの版の選択までは対応していない。

## 現在の判定：v2.0.0 保存忠実度の改修後（2026-09-23 JST）

v2.0.0で保存・再生の欠落を段階的に解消した。以下はv2.0.0で実際に保存したアーカイブと恒久テストに基づく。旧版のアーカイブは再保存していないため、下の旧判定のままである。

### 実サイトでの確認（有名サイトを種類別に保存）

| サイト | 保存結果 | 再生確認 |
|---|---|---|
| store.kkvv.jp（EC・Shopify） | 43ページ、1,250素材、約155 MB、エラー0。別ドメインの埋め込み103件へ接続、安全な操作254件、読み込み時のPOST応答1,368件を保存 | 全ページ表示検査43/43正常。壊れた画像0、未保存素材0、実行エラー0、安全な操作378/378成功。保存時点で元サイト自身が404を返した送信1件は「保存時の応答」として分離 |
| developer.apple.com（配信の解説） | 1ページ、210素材。元サイトで既に404のフォント参照173件を欠落から分離 | — |
| react.dev（SPA） | 4ページ、220素材、埋め込み7件、操作41件 | 画像9/9、欠落は計測用のみ |
| developer.mozilla.org | 1ページ、187素材、埋め込み6件、操作19件 | — |
| w3schools.com（mp4/ogg動画） | 動画2本を全体保存（部分取得のまま残らない） | 2本とも再生・終盤へのシークが成功 |
| hlsjs.video-dev.org（HLS配信） | 配信リストを解析して分割ファイルを保存。上限150 MBを超えた2本を未保存として記録 | 再生時間634秒の配信を再生し、80%地点へのシークが成功。未保存だった1本を「後から保存」で追加（約20 MB） |
| www.aozora.gr.jp（Shift_JIS） | 題名・本文とも文字化けなし | 再生でも文字化けなし、画像36/36 |

### v2.0.0で解消したもの

- 1ページの保存が時間切れでも、その時点までの内容を保存する。load待ちを全体時間から分離し、最終書き出しの固定30秒を廃止。ダイアログで止まらない。開けなかった原因をChromeの理由文で記録
- 保存中にタブ・開閉・スライダーなど送信を伴わない操作を行い、操作後に読み込まれる素材を保存（保存HTMLは操作前の状態）
- 別ドメインのiframeの中身、閉じた・入れ子のShadow DOM、文書全体の構築済みスタイル
- 動画・音声の全体保存、HLS/DASHの全分割ファイル、上限超過の記録と後から保存
- 読み込み時のPOST応答の保存と再生時の照合（計測用は再生時に空応答）
- 文字コードの判定・記録と、再生時の正しい読み直し
- 親アプリへの埋め込み、SPAの履歴移動、スクリプトによる外部への移動の遮断、元のパスでの再読込、実行ごとに変わるURLの照合、乱数と時計の固定
- 長く続く通信（常時接続・ストリーミング）で保存が止まらない

### 現在も「完全」と言えない理由

- 同じURLでも時刻・Cookie・操作順で変わる応答は、ページごとの版までしか保存しない（v2.1.0で追加）
- 複数の操作を組み合わせた順序、時間経過で変わる全時点は網羅しない（ホバー表示はv2.1.0で対応）
- ログイン後の画面、決済、投稿、WebSocketの双方向通信、ライブ配信、DRM、WebGLの状態は原理的に再現できない
- 大量保存テスト（多数サイトの連続保存）はv2.0.0では未実施

### 検証

- 恒久テスト116件成功（`node --test --test-concurrency=1 Test/*.test.mjs`）、静的検査成功、AppDetail 14ファイル整合、依存関係の脆弱性0件

## 旧判定（v1.9.0以前）

## 現在の判定：高忠実度だが完全保存ではない（2026-09-21 JST）

以下は現行コード、最新のKKVV全体保存、ファイル監査、実ブラウザ再生に基づく。下部の2026-08-31表・passed判定は旧版の履歴であり、現在の完全保存の証明には使用しない。

### 最新の実サイト証拠

- 保存記録: `archive_mu0usjkf_4a5927487e`。`https://store.kkvv.jp/`から43ページ、713素材、278,756,279 bytes（画面表示266 MB）。42ページは開始サイト、1ページは登録語で関連サイト扱いになった別ホスト。
- ファイル整合性: 594個の重複排除済み実体、97,850,039 bytesのサイズ・SHA-256が一致。WARC gzipは83,341,623 bytes、798 recordを読取可能。
- 参照監査: HTML/CSS/srcsetの364参照を検査し、表示素材の未保存候補は0種類。未取得のShop Pay preload 1種類は閉鎖後に再現できない決済境界として分離した。ファイル監査は成功（終了コード0）。
- 品質表示: 「おおむね良好（94点）」、表示に影響する欠落0種類、ログイン・決済等の外部サービス境界4種類、計測系の未取得3種類。外部サービスをローカルだけで再現できないため100点とは表示しない。
- トップ再生: 画像49要素中49件が読込済み、表示中の壊れた画像は0件。`scrollHeight=3306`、`clientHeight=629`、`document.fonts.status=loaded`。プレビュー内部を0→960pxへ実スクロールし、商品一覧の画像表示を確認。
- 商品ページ再生: 選択行、アドレス表示、iframe URLが同じ商品URLで一致。画像45要素中39件が読込済みで、残る6件は非表示の遅延候補、表示中の壊れた画像は0件。6候補の元URLは全てmanifestに保存済みであり、素材欠落ではなく非表示中の未読込。`document.fonts.status=loaded`。
- 操作確認: 商品ページを0→1439px→479pxへ実スクロールし、`details`を実クリックして開閉状態の変化を確認。保存ページ内のALL ITEMリンク、管理画面の戻る、時間経過する告知スライダーを確認。古いiframe文書から遅れて届く移動通知は無視する。以前の監査では商品画像ダイアログの主画像3840×3840も読込済み。
- 全ページ表示検査: 保存済み43ページを専用Chromeで順に実表示し、43/43ページが正常。表示中の壊れた画像0、待機中画像0、表示素材欠落0、通信失敗0、JavaScript実行エラー0、スクロール不能0。安全な操作候補252件を252件検査し、127件で状態変化、操作エラー0、未検査0、一時的なView Transition 42件を助言へ分離した。外部機能85回、計測系170回、安全な隔離258回、サイト側代替42回は表示不良と分離した。
- 再生中の安全遮断: KKVVトップの背景送信9回は外部へ送らず回数表示と詳細ログへ分離。Shopifyの計測コードとShop Payの外部決済応答はWARC原本を変更せず、再生時だけ無害なローカル応答に置換した。背景通信では警告ポップを出さず、利用者が直接送信フォームを操作した場合だけ独自UIで通知する。
- UI記録: 2026-09-21にCodex In-app Browserで、KKVV再生、内部スクロール、戻る・進む、設定、独自ヘルプ、診断ログ・負荷履歴の相互排他と開閉を実操作した。前回のファイル記録は`runtime/audits/2026-09-14-ui/03-product-selection-fixed.png`、`04-product-image-modal.png`、`05-final-product.png`。
- 最新ファイル監査: `runtime/audits/archive_mu0usjkf_4a5927487e-1789976786344.json`。全ページ表示検査: `data/archives/archive_mu0usjkf_4a5927487e/replay-audit.json`。

### 今回修正・検証した範囲

| 確認対象 | 現在の証拠・残る範囲 |
|---|---|
| 停止・再開・アプリ終了 | 構造把握/本保存のpause・cancel、未保存URL復元、ブラウザ終了待ちを恒久テストで確認。通常終了APIは保存処理とログ書込みを待ってから終了する。実再起動で`shutdown.requested`、`stopped`、新しい`started`を確認 |
| 圧縮キューと削除失敗 | 終了キューの展開・再開、削除commit失敗時の復元を使い捨てデータで確認。既存アーカイブの実削除は実施していない |
| module/CSS/data画像/基準URL | 変換後URLの完全一致、冪等性、SVG fragment、data srcset、base hrefを恒久テストで確認。任意の実行時生成コードまでは保証しない |
| HTTPと動画部分取得 | 保存された403/405、HEAD、単一Rangeの206/416を恒久テストで確認。実動画のseek操作は未検証 |
| 素材の網羅性 | HTML/CSS/srcset参照、ファイル整合性、実表示を別検査にした。全操作・全時点で後から発生する通信までは静的検査で証明できない |
| WARC | gzipレベル0/1/9で原本bytesの可逆保持を確認し、圧縮を非同期化。最新実アーカイブ798 recordも読取可能 |
| Browser-in-Browser | ページ選択、保存ページ内リンク、戻る、再読込、画像拡大、内部スクロールを実操作。再生通知にナビゲーションIDを付け、古い文書の通知を遮断 |
| 再生診断UI | 表示欠落、外部サービス境界、計測系通信、動作エラーを分離。品質再計算を保存し、一覧の古い点数を更新 |
| 全ページ表示検査 | 全ページを専用Chromeで順に開き、画像、フォント、全体/内部スクロール、通信、実行エラーと表示中の安全な操作部品を監査。操作前後2時点を比較し、Shopify計測・決済、CSP隔離、一時的なView Transitionを表示欠落から分離する |
| 計測・外部決済の再生 | Shopify Web Pixels、Typekit計測pixel、Shop Payの決済境界を保存素材の欠落に数えず、外部接続しない種類別ローカル応答へ置換。元の保存blobとWARCは変更しない |
| 動的字体とShadow DOM再生 | Typekitの動的部分字体が未保存でも同じ書体の保存済み完全字体を使用。保存済み宣言的Shadow DOMへ元スクリプトが再装着して停止する問題を既存root再利用で回避 |
| 診断書込み負荷 | 同じ未保存素材の反復要求を250ms単位で一括確定し、1要求ごとのJSON全体書換えを廃止。読取時は未確定分も合算し、終了時に全件flushする |
| Chrome検査終了 | 無限スクロール等でページがタイムアウトした後も、DevToolsタブ終了と検査proxyの接続を上限付きで破棄し、テストや保存処理が無期限停止しない |
| セッション復旧 | サーバー再起動後に古くなったCSRF tokenを自動更新し、安全な変更APIを1回だけ再試行することを実ブラウザで確認 |
| 大量一覧 | 現在の1,462件を全件送らず、サーバー検索・ページングを使用。初期描画を120件から60件へ縮小し、残りは「さらに表示」で取得 |
| 資源監視と全体負荷管理 | CPU・メモリ・ディスク・通信・GPU・アプリRSSを10秒ごとに数値記録し、7日で回転。保存4・構造把握8をアプリ全体のFIFO枠で共有し、高負荷時は新規開始枠を1/2、重大負荷時は1/4まで自動縮小。既に走っている処理を途中で破棄しない |
| 再生中の外部送信 | fetch・XHR・フォームの非GET送信を遮断し、方式・method・理由をログへ記録。背景計測は件数表示、直接フォーム操作だけ独自通知として区別 |
| アイコンUI | 文字記号をLucideのSVGアイコンへ統一。ページ一覧、削除チップ、確認モーダルを含め、ブラウザ標準confirmに依存しない |
| AppDetail | PowerShell 5/7のPID時刻照合、所有確認、通常終了APIを経由するbackground reload、healthを確認 |
| 素材補完の中断復旧 | 準備記録を先に保存し、WARC・manifest・件数を再適用する。5段階の停止、17 bytesだけの部分追記、破損データ、2回の再起動を一時データで検証。原ページHTMLは変更しない |
| 通常保存の中断復旧 | 2並列保存の5段階で子プロセスを実際に強制終了し、2回の再起動・再開後に5ページ6素材・各URLのWARC原本1回・件数・未処理URLが一致。準備前pause時に未確定件数を保存しないこと、準備後cancel維持、部分追記、WARCなし、commit失敗・準備ジョブ改変も一時データで確認 |
| 素材実体の途中書込み | fsync済み一時ファイルからSHA名を反映し、同一素材8同時保存で実体1個・原本一致。既存の部分/同サイズ破損は上書きせず、成功扱いしない。スクリーンショットも一時ファイルから反映 |
| 保存先の単独所有 | Windowsで同じ実体パスの二重書込み、異なるポートからの起動・補完を拒否する。強制終了後の所有解除を子プロセスで確認。Linux・その他OSの実動作は未検証 |
| 戻った後の再訪 | 履歴末尾ではなく現在位置と比較し、未来の履歴を切って新しい訪問を記録する。実ブラウザで開始→商品→戻る→同じ商品→戻る→進むを確認し、選択行・アドレス・iframeが一致 |
| 実ブラウザ保存の起動 | 全回帰でShadow DOM保存部品の読込み宣言欠落を検出。宣言を復元し、描画後DOM・素材・一時クリック状態を扱う実Chromeテストで再確認 |
| 設定画面の補助表示 | 独自ヘルプ表示中は重複するhover説明を隠し、閉じると元ボタンへfocusを戻す。診断ログと負荷履歴は片方だけ開き、同じボタンで閉じることを実ブラウザで確認 |

### 現在も「完全」と言えない理由

- 認証、決済、投稿、検索結果生成、WebSocket/WebRTC、ライブ配信、DRMなど、閉鎖後も外部サーバーを必要とする機能は再現できない。画面本体の欠落とは分けて表示する。
- KKVVではShop Payの決済用preloadなど外部サービス境界が残るが、表示素材の欠落とは分離され、ローカル再生から外部へ接続しない。
- URLが同じでもCookie、時刻、request header、操作順で異なるGET応答を返すサイトは、現在のURL中心の索引では全版を選択再生できない。
- 計算で生成されるJavaScript import、closed Shadow DOM、別origin iframe内部、WebGL/GPU状態など、ブラウザから完全には抽出できない状態がある。
- 通常保存にも中断復旧を適用したが、新しいバッチに対するWindowsでの故障試験の証拠である。旧版で既に発生した欠落、電源断、ディスクそのものの故障、全OS・任意規模の実サイトでの保証ではない。破損素材は検出して原本を保全するが、自動補修はしない。
- CPU・メモリ・ディスク・通信・GPUに基づく全体並列枠は実装したが、OSの計測APIが値を返さない環境では該当指標を`unavailable`として扱う。保存速度や完全性を保証する仕組みではなく、過負荷時の新規処理開始を抑える仕組みである。
- 全43ページの表示と、表示中の安全な操作候補252件は操作前後2時点で検査済み。ただし複数操作の順序、全アニメーション時点、送信を伴う操作は網羅しない。検査結果は`coverage.interactions=true`、`interactionSequences=false`、`externalNetwork=false`、`timepoints=2`であり、完全保存とは表示しない。

### 最新の検証

- `npm test`: 100 passed / 0 failed。ローカルfixtureを使う実Chrome保存、通常保存の中断復旧、ログイン画面への重複転送停止、全体並列枠、資源計測、計測・決済境界のローカル再生、全ページ表示検査を含む。
- 補完復旧・保存先所有・サーバーの対象回帰テスト: 14 passed / 0 failed。
- `npm run check`、`npm run appdetail:check`: passed。AppDetail必須14 file。`npm audit --omit=dev`: 0 vulnerabilities。
- 実サーバー: `ready=true`、`replayReady=true`、segmented-v2。安全なbackground reloadを実行済み。
- 2026-09-21時点で1,462アーカイブ・77 pausedジョブを保持し、最新KKVVのmanifest SHA-256は`3581BE94...A31C2B7`、WARC SHA-256は`762D963B...C5F444D`で事前値と一致した。実サイト保存を再開・中止せず、既存アーカイブの故障注入・削除は行っていない。
- 9月21日のBrowser Use: Codex In-app Browser、`http://127.0.0.1:43193/`。KKVVの商品ページとトップ間の戻る・進む、内部スクロール、独自ヘルプ、診断ログ・負荷履歴の開閉を実操作。専用Chromeの副記録では保存済み43/43ページ、操作252/252件、表示欠落0、実行エラー0。ログイン、決済、送信、実アーカイブ削除は未実施。
- 今回は既存KKVV保存の再表示確認であり、外部サイトの新規保存を繰り返してはいない。表示証拠は一時フォルダに保存し、最終ブラウザタブを保持した。

### 優先する追加機能案

1. 操作シナリオ監査の拡張：現在の個別操作に加え、メニュー→タブ→モーダルなど複数操作の安全な順序を定義し、途中状態と復元結果を記録する。
2. 不足素材の安全な補完候補：原本を残し、補完元・時刻・理由・hash差分を確認してから適用する。再生時には勝手に外部取得しない。
3. 同じURLの応答版保存：時刻・header・Cookie・操作順で異なるGET応答をページ状態と関連付け、再生する版を選べるようにする。
4. 視覚差分監査：保存権限のある稼働サイトとアーカイブを同じviewportで撮影し、画像差分をページ別に表示する。
5. 復旧ダッシュボード：中断復旧待ち・保全した破損素材・補完可能項目を一覧化し、対象を明示して再取得する。
6. 検査付き持ち運び：検査付きエクスポート、別PCでの復元検証、復元可能なごみ箱、hash署名付き監査報告を一式にする。

## 過去の検証履歴（2026-08-31）

当時のworkspaceと実行結果に基づく。現在の仕様・品質判定とは異なる。

| 要件 | 判定 | 根拠 |
|---|---|---|
| URLを渡して保存 | proven | `POST /api/jobs`、公開URL検査、URL入力UI、job永続化 |
| HTML/CSS/JS/画像/GIF/SVG/font/video/audio/描画後DOMを保存 | proven | Chrome/Edge CDP capture、Network body収集、SHA-256 blob、実ブラウザfixture test |
| クリック時のclient-side状態を残す | proven within stated boundary | 非送信のdetails、aria-expanded、tabを安全に操作後DOMへ反映する実ブラウザtest。保存JSも隔離再生 |
| 閉鎖後の擬似再生 | proven | 別origin replay、保存resource書換え、未保存resource 404、リンク履歴・戻る・進むをIABで操作確認 |
| リンクを階層巡回 | proven | BFS queue、visited重複排除、manifestのdepth/from/links、巡回tree UI |
| 外部siteは5階層で警告 | proven | `warningForDepth`の境界test（4ではなし、5で警告）とIAB警告操作 |
| 同一親domainは30階層で警告 | proven | registrable domain判定、subdomainをsite扱い、29ではなし・30で警告するtest |
| 無限巡回対策 | proven | 5/30警告に加え、最大100,000 page、500GB、7日、1 response 256MBのhard cap。UI既定は10,000 page・50GB・12時間 |
| 送信操作を行わない | proven | CDP Fetchと検査proxyの二重GET/HEAD/OPTIONS制限。POST拒否test |
| SSRF/DNS rebinding対策 | proven | loopback/LAN/link-local/reserved/metadata/認証URL拒否、全DNS address検査、検査済みIPへ固定、redirect再検査test |
| 安全なoffline replay | proven | loopbackのみ、管理/replay別port、Host/Origin/CSRF、sandbox、CSP、form/connect/worker/object禁止、Host拒否test |
| 保存形式 | proven | 原子的JSON state/manifest、SHA-256重複排除blob、screenshot、WARC 1.1 gzipとtest |
| MultiApp配置 | proven | プロジェクトフォルダ直下の既存形式、独立port、他app非変更 |
| AppDetail | proven | 仕様原本を同梱、必須14 file、同期script、JSON/PNG/PowerShell/VBS契約check、実際のboot/health/stop成功 |
| localhost Web UI | proven | `127.0.0.1:43193`で稼働、`43194` replay、health ready/replayReady true |
| Browser/IAB表示 | proven | IABでdesktop 1440x1000、mobile 390x844、警告・再生・link・戻るを操作。最終tabをdeliverableとして保持 |
| UI完成度 | proven | Image Gen concept、実装screenshot、side-by-side comparison、`design-qa.md` final result passed、console error/warning 0 |

## 実行済みgate

- `npm test`: 12/12 passed
- `npm run check`: passed
- `npm run appdetail:check`: 14 files passed
- `npm audit --omit=dev`: 0 vulnerabilities
- AppDetail background boot / health / stop: passed
- 最終production health: WebCapture 1.0.0、ready=true、replayReady=true

## 技術的境界

任意のWebサイトを「完全」に保存することは、閉鎖後も必要なserver処理まで含めると原理的に不可能。検索、投稿、認証、決済、comment、WebSocket、WebRTC、Push、DRM、時刻・利用者依存APIは再現対象外。WebCaptureは保存済みGET response、media、描画後DOM、client-side JavaScriptで動く範囲を高忠実度で再生し、この境界をUIとREADMEに明示している。

final result: passed
