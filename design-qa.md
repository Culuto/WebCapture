# WebCapture Design QA

## 比較条件

- 元デザイン: `docs/ui-concept-save.png`、`docs/ui-concept-replay-warning.png`（1505 x 1045）
- 実装: `docs/implementation-save.png`、`docs/implementation-replay-warning.png`（1440 x 1000）
- 同一画像比較: `docs/qa-comparison-save.png`、`docs/qa-comparison-replay-warning.png`
- モバイル確認: 390 x 844指定（取得画像 375 x 812）

## 確認結果

- 情報構造: 左の保存条件、中央の進捗・巡回、下部の保存済み一覧を維持。
- 再生構造: ページ一覧、再生ツールバー、隔離フレーム、保存情報、クロール経路を維持。
- 視覚: 白基調、青い選択状態、細い境界線、角丸を抑えた操作部品、Yu Gothic UIを一致させた。
- 警告: 元デザインと同じ中央配置、暗転、警告画像、2択操作、再表示抑止を実装。
- レスポンシブ: 375px実表示で横はみ出し0。保存画面と再生画面の先頭位置、操作部品、iframe幅を確認。
- 操作: 警告停止、保存済みページの選択、保存時クリック状態、ページ間リンク、戻るを実ブラウザで確認。
- コンソール: desktop/mobileとも warning・error 0。

## Fidelity ledger

| 比較点 | 元デザイン | 実装確認 | 対応 |
|---|---|---|---|
| 画面構造 | 保存条件 / 進捗 / 巡回 / 一覧の3領域 | 同じ情報順と左右比率を維持 | 主要導線を一致 |
| 文字 | 保存・アーカイブ・設定、保存を開始、階層警告 | 主操作名と警告文を一致 | above-the-foldの製品コピー差分なし |
| タイポグラフィ | 日本語ゴシック、太い見出し、控えめな補助文 | `Yu Gothic UI`、Meiryo、system-uiで実測 | 再生iframeを含め統一 |
| 色・面 | 真白背景、#0B5FFF系の青、細い灰色罫線 | 同じ白・青・灰色構成 | 色温度や不要なgradientなし |
| 操作部品 | 角丸を抑えたボタン・入力・表 | 4〜5px radius、focus ring、表形式 | カード化せずopen layoutを維持 |
| 資産 | 青い保管庫logo、黄色い警告mark | Image Gen由来PNGを実寸配置 | 透明余白をcropし、CSS記号を除去 |
| 再生操作 | 戻る・進む・再読み込み・保存時ページ | 4操作と履歴状態を実ブラウザで確認 | disabled/active状態も反映 |
| responsive | desktop主体、狭幅への継続が必要 | 390 x 844指定で横overflow 0 | 1列化、toolbar 2列化、iframe 349px |

## Above-the-fold copy diff

主navigation、URL入力、主CTA、巡回範囲、警告深度、上限値の製品コピーに追加・欠落・改名はない。元デザイン内のページ数・日時・URLなどのdemo値は製品コピーではなく、ローカルfixtureの実値へ置き換えた。

## 修正履歴

1. 再生HTMLの `base` による保存CSS不達を除去し、CSS URL書換えテストを追加。
2. モバイルの画面切替時にスクロール位置を先頭へ戻すよう修正。
3. 保存ページfixtureにviewportとモバイルCSSを追加。
4. 生成アイコンの透明余白を除去し、警告記号を生成画像へ置換。

## 残差

- 元デザインの大量ページ・素材は概念用データで、実装QAは2ページ・3素材の安全なローカルfixtureを使用した。
- 元デザインのOSウィンドウ操作部はWeb UIの責務外なので含めていない。
- 元デザインの装飾的なtoolbar iconは、視認性と外部icon依存0を優先して文字labelにした。主要logoと警告assetは忠実に画像化している。
- どちらも機能・可読性・操作導線を損なう差ではなく、P0/P1/P2の未解決項目はない。

実装は元デザインの情報構造、色、文字階層、操作導線、警告状態に対して忠実に検証済み。上記の意図的差分以外に修正可能なmaterial mismatchは残っていない。

final result: passed
