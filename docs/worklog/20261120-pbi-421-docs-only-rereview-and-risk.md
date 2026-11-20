# 文書だけを直した後の再レビューとリスク評価を軽くする

- 日付: 2026-11-20（UTC）
- タスク: PBI-421
- PR: なし
- ブランチ: sacty/task-（タスク ID の先頭 8 文字）
- 関係する ADR: [文書だけを直した後の再レビューは観点と検証を絞り、リスク評価は引き継ぐ](../adr/20261120-2200-narrow-rereview-and-risk-for-documents-only.md)

## 目的

直しが文書だけの再レビューが、毎回、全部の観点と全テストを実行し、リスク評価もやり直していたため、文書だけの直しの後は軽くする。

## したこと

- `apps/daemon/src/test-files.ts`：`isChangeDocumentsOnly`（文書だけの判定。エージェントへの指示を除く）。
- `apps/daemon/src/repository.ts`：`isAncestor` を公開し、`mergeBaseOf` を足した。テストの偽物（`FakeRepos`）にも足した。
- `apps/daemon/src/service.ts`：`documentsOnlySince`、`rereviewDocsOnlyOf`（再レビューの準備）、`assessRisk` の引き継ぎ、`resolveReviewTarget` の `baseBranch`。
- `apps/daemon/src/prompts.ts`：`rereviewDocsOnlyLines`。当たる回だけ、担当の起動・検証・再レビューの 3 つの行を規則 10 に従う文に差し替える。
- `packages/core`：`ReviewTargetResolved`・`previousReview` に向き先、`PullRequestRiskAssessed`・`riskAssessment` に `base`・`inheritedFrom`。
- `apps/web`：引き継いだ評価の作業履歴の 1 行。
- 既定のスキル `review-dispatch`：規則 10、`pr-review` の「前回以降が文書だけの再レビュー」、`verification-run`・`viewpoints` の例外。
- 仕様書（`tasks-and-steps`・`context`・`risk-assessment`・`event-log`。日英）、ユーザードキュメント（`tasks`・`intake`。日英）、ADR。

## 決めたこと

- 人の指摘 design-2-2：エージェントへの指示を「文書」に数えない。一覧にない指示・コードやテストが読む文書は、リスク評価では引き継ぐことがある。
- 人の指摘 design-2-3：向き先の同一は `base.sha` で見ず、向き先のブランチと merge-base で見る。

## 確かめたこと

- テスト：`test-files-change-documents.test.ts`・`rereview-docs-only.test.ts`・`risk-inherit.test.ts`・`review-dispatch-rule10.test.ts`。
