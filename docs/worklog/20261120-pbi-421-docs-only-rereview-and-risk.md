# 文書だけを直した後の再レビューとリスク評価を軽くする

- 日付: 2026-11-20（UTC）
- タスク: PBI-421
- PR: #465
- ブランチ: sacty/task-887c7e69
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

- テスト：`apps/daemon/src/test-files-change-documents.test.ts`・`apps/daemon/src/rereview-docs-only.test.ts`・`apps/daemon/src/risk-inherit.test.ts`、`packages/core/src/risk-assessment.test.ts`、`apps/web/src/components/risk-assessment.test.ts`、`apps/daemon/src/repository.test.ts`（`mergeBaseOf`・`isAncestor`・`readFile` の `anyName` を実際の git で）。
- コマンド（最後の変更の後に実行）：`npm run lint`・`npm run typecheck` は通過。`npm test` は 281 ファイル・5683 件が通過（14 件は元からのスキップ）
- 確かめられないこと：規則 10 を実際のエージェントが起動表へ反映するか（実機のレビューでだけ確かめられる）。GitHub の再依頼の経路は、前回の判定を持たないので絞らないことをテストで確かめた（実際の GitHub では動かしていない）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 変わったパスを指示の文に埋め込んでいる | 指示とは分けた JSON のデータで渡し、制御文字を含むパスは確かめられないものとして絞らない・引き継がない |
| SKILL.md を消すだけの差分が文書だけになる | 名前が `SKILL.md` のパスも文書だけにしない |
| 3 回目以降の未対応の要修正・主対象が文書の PR・50 件超 | 前回が修正が必要なら、それより前の回の要修正も見る。読めないパスがあれば絞らない。50 件を超えれば絞らない。指示にも条件を足した |
| 再依頼の経路の `previousReview` に起点が入らない | `baseCommit`・`baseBranch` を足した |
| 規則 1・3 の文、spec・user・worklog の記述 | 括弧と句点を直し、spec・user に `.` で始まるディレクトリの扱いを足し、この節を直した |
| 絞り・引き継ぎを諦めた理由が残らない | `console.warn` に 1 行残す。理由は `renderMessage(redactText(…))` で読める文にし、秘密の値を伏せ、タスク ID を添える |
| SKILL.md の確認が、日本語・空白を含むディレクトリで失敗する | `readFile` に `anyName` を渡す。実際の git のテストと、日本語・空白のディレクトリの再レビューのテストを足した |
| 再依頼の経路では、前回の判定が無く、絞りが効かない | 新しい状態を足さず、絞らないと仕様書・ユーザードキュメント・ADR に書き、テストで確かめた |
| ADR の置き換え関係、判定の列挙、200 件の上限、intake.en.md、worklog の結果 | 古い ADR を `superseded` にして関係を揃え、ADR・spec・user を直した |

## 残したこと

なし
