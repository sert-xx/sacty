# 文書が主対象のレビューでは、コードの検証を実行しない

- 日付: 2026-11-03（UTC）
- タスク: PBI-285
- PR: #287
- ブランチ: feat/issue-285-pbi-285
- 関係する ADR: [文書が主対象のレビューでは、文書に効く検証だけを実行し、コードの検証を実行しない](../adr/20261103-0300-docs-main-target-skips-code-checks-in-review.md)

## 目的

実験（findings F31）で、要求要件の工程の 37 回の実行のうち 20 回で、要求要件の PR への sacty のレビューでも、検証のコマンド（依存の取得・テスト・リポジトリ全体の検査・ビルド）が実行されていた。文書の判断には使われないので、文書が主対象のレビューでは文書に効く検証だけにする。

## したこと

- 既定のスキル `review-dispatch`
  - `references/verification-run.md`：節「0. 実行する範囲を決める」を足した。主対象が `design-doc`・`user-doc` なら文書に効く検証だけ（引数で絞れないものは実行しない）、無ければ何も実行しない。`code` は全部。主対象が文書でも差分にコードの変更があれば全部。`summary.json` に `scope` を足した。X-2 の起動を `scope` で分けた（`docs` は文書に効く検証を実行したときだけ。CI の結果だけでは起動せず、失敗したチェックは範囲に 1 行）。
  - `SKILL.md`・`references/viewpoints.md`：X-2 の起動の規則と、検証の結果の入力を同じ内容に直した。`references/self-review.md`：出力の例の検証の行に、文書が主対象のときの書き方を足した（再レビューの節は触っていない）。
  - `review-execution/references/X-2.md`：`scope` が `docs` のとき、実行していない検証を指摘しない。
- sacty の PR レビューの指示（`prompts.ts` の `reviewVerificationLines`）：文書が主対象のときは、スキルの規則に従い、`testCommand` を含めてコードの検証を実行しないことを足した（スキルと食い違わせない）。
- 仕様書（日英）・ユーザードキュメント（日英）・ADR を直した。

## 確かめたこと

作業は、リポジトリの外の worktree（`sacty-wt-pbi-285`）で行った。

- `npx biome check .`：通った。
- `npx vitest run apps/daemon/src/default-skills.test.ts apps/daemon/src/prompts.test.ts apps/daemon/src/review-eval.test.ts`：通った。
- 足したテストの文言を戻す（スキル・指示の変更を戻す）と、5 件が落ちることを確かめた。
