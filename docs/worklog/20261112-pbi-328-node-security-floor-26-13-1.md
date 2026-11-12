# Node.js の下限を、2026-11 のセキュリティリリースの修正版 26.13.1 に上げる

- 日付: 2026-11-12（UTC）
- タスク: PBI-328
- PR: #343
- ブランチ: feat/issue-328-node-26-13-1
- 関係する ADR: [Node.js の下限を、2026-11 のセキュリティリリースの修正版 26.13.1 に上げる](../adr/20261112-0154-node-security-floor-26-13-1.md)

## 目的

Node.js の 2026-11 のセキュリティリリース（26.x の修正版は v26.13.1）に合わせ、sacty が求める Node.js の下限を上げる。

## したこと

- `package.json`・`package-lock.json` の `engines.node`、`.node-version`、`mise.toml` を 26.13.1 にした。
- デスクトップアプリのパッケージを作るスクリプトの版の確かめを 26.13.1 にした。
- README（日英）・はじめに（日英）・CONTRIBUTING の「必要なもの」、テストのコメントの版を直した。
- ADR を足し、前の ADR を置き換え済みにした。

## 確かめたこと

- Node.js の配布の一覧（`https://nodejs.org/dist/index.json`）で、v26.13.1 が 2026-11-10 公開のセキュリティの修正版であること。
- エージェント実行用のイメージの元のイメージに固定したダイジェストが、`node:26.13.1-bookworm-slim` と同じこと（`docker buildx imagetools inspect`）。
- Node.js 26.13.1（`mise exec`）で `npm ci`・`npm run lint`・`npm run typecheck`・`npx vitest run`。

## 残したこと

- なし
