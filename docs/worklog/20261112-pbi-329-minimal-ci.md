# PR と main への push で、lint・型検査・テストを実行する最小の CI を足す

- 日付: 2026-11-12（UTC）
- タスク: PBI-329
- PR: #344
- ブランチ: feat/issue-329-minimal-ci
- 関係する ADR: [最小の CI を GitHub Actions で足し、main の承認数は 0 のままにする](../adr/20261112-0224-minimal-ci-without-required-approvals.md)

## 目的

セキュリティチェックの指摘（CI のワークフローが無い・main の承認数が 0）に、利用者の決定（2026-11-12：CI は最小構成で足す、承認数は 0 のまま）で対応する。

## したこと

- `.github/workflows/ci.yml` を足した。PR と main への push で、`npm ci`・`npm run lint`・`npm run typecheck`・`npx vitest run` を実行する。
- 権限は `contents: read`、checkout は `persist-credentials: false`、Action は SHA で固定（`actions/checkout` v7.0.1・`actions/setup-node` v7.1.0。SHA は `gh api` でタグから引いた）。
- Node.js の版は `.node-version` から読む。
- ADR に、承認数を 0 のままにする決定も書いた。

## 確かめたこと

- この PR で CI が動き、結果が付くこと（PR の画面）。

## 残したこと

- Dependabot（依存と Action の版の更新の PR）は足していない（利用者に確かめる）。
