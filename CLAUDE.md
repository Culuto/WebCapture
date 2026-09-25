# CLAUDE.md

このリポジトリでの作業ルールは `AGENTS.md` に従う。

@AGENTS.md

## このリポジトリ固有の追加ルール

- git のコミットメッセージやプルリクエストの本文に、Claude を共同開発者として記載しない（`Co-Authored-By` 行や「Generated with Claude Code」などの表記を付けない）。
- 保存データ（`data/`）、ログ（`runtime/`）、ログイン状態、Cookie は絶対にコミットしない。
- 画面の文言は「です・ます調」の説明文で書く。日本語の文言を追加・変更したら、`public/i18n.js` の英訳も同じキーで追加・更新する。
