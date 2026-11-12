# PR と main への push で、lint・型検査・テストを実行する最小の CI を足す

- 日付: 2026-11-12（UTC）
- タスク: PBI-329
- PR: #344
- ブランチ: feat/issue-329-minimal-ci
- 関係する ADR: [最小の CI を GitHub Actions で足し、main の承認数は 0 のままにする](../adr/20261112-0224-minimal-ci-without-required-approvals.md)

## 目的

セキュリティチェックの指摘（CI のワークフローが無い・main の承認数が 0）に、利用者の決定（2026-11-12：CI は最小構成で足す、承認数は 0 のまま）で対応する。

## したこと

- `.github/workflows/ci.yml` を足した。PR と main への push で、`npm ci`・`npm run lint`・`npm run typecheck`・Chromium の導入・`npx vitest run --no-file-parallelism` を実行する。
- 権限は `contents: read`、checkout は `persist-credentials: false`、Action は SHA で固定（`actions/checkout` v7.0.1・`actions/setup-node` v7.1.0。SHA は `gh api` でタグから引いた）。
- Node.js の版は `.node-version` から読む。
- ADR に、承認数を 0 のままにする決定も書いた。

## 確かめたこと

- この PR で CI が動き、結果が付くこと。
- 最初の実行は落ちた。画面のテスト（`*.browser.test.ts`）の Chromium が無いことと、時間が入力の長さに比例するかを測るテスト2件が上限を超えたこと（手元で2つの全件の実行を同時に動かしたときと同じ）。
  `npx playwright install --with-deps --only-shell chromium` を足し、`npx vitest run --maxWorkers=2` にして、通った（約3分）。
  その後の実行で、時間を測るテスト1件が `--maxWorkers=2` でも上限を超えた（1044ms／1000ms）ので、`--no-file-parallelism` にした。

## 残したこと

- Dependabot（依存と Action の版の更新の PR）は足していない（利用者が 2026-11-12 に、今は足さないと決めた）。
