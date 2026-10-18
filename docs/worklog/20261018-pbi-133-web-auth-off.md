# 画面の認証を、設定ファイルで OFF にできるようにする

- 日付: 2026-10-18（UTC）
- タスク: PBI-133
- PR: #145
- ブランチ: feat/issue-133-web-auth-off
- 関係する ADR: [画面の認証を設定で OFF にできるようにする](../adr/20261018-0929-web-auth-off-setting.md)

## 目的

起動のたびに端末の URL を開く手間を、危険を理解したうえで省けるようにする（ステークホルダーの要望）。

## したこと

- 設定：`web.auth`（既定 `true`）。雛形に、OFF の例と危険をコメントで書いた。
- CLI：設定ファイルで OFF なら秘密を作らず、画面に `SACTY_WEB_AUTH=off` を渡す。シェルの `SACTY_WEB_AUTH` は取り除く。端末には画面の URL と警告を出す。
- 画面：OFF なら、Proxy と `daemonFetch` で cookie を確かめない（Host の確かめは残す）。
- docs：仕様書（設定・デーモンの起動と終了）、ユーザードキュメント（CLI）、ADR。

## 確かめたこと

- `npx biome check`・`npm run typecheck`・`npx vitest run`・`npm run build` が通った。
- 次の修正を戻すと、テストが落ちることを確かめた：設定ファイルが読めないときに ON にすること、シェルの指定を取り除くこと、`off` だけを
  受け付けること、OFF でも Host を確かめること、`daemonFetch` が OFF に従うこと、設定の既定。
- デモ用のポートで、OFF にして起動し、画面の URL を開くだけで使えること、警告が出ることを確かめた。
