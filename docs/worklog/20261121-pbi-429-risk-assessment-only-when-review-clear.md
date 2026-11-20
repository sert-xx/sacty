# PR のリスク評価を、レビューが指摘なしになった回だけにする

- 日付: 2026-11-21（UTC）
- タスク: PBI-429
- PR: なし
- ブランチ: なし
- 関係する ADR: [PR のリスク評価は、レビューが指摘なしになった回だけにする](../adr/20261121-0300-risk-assessment-only-when-review-has-no-findings.md)

## 目的

PR を作る・更新するたびのリスク評価（オーケストレーターの実行。中央値 74 秒）が、登録からマージまでの時間の長い部分を占めていた。
評価は人が最終判断をするときだけ読むので、PR を作る・更新する時点ではやめ、レビューの工程で指摘なしになった回だけにする。

## したこと

- `apps/daemon/src/service.ts`：`publish` から評価（`assessRisk`。引き継ぎ・一時停止を含む）をなくした。`assessesReviewRisk` を足し、レビューの指示・読み取り・記録・投稿の本文で同じ判定を使う。記録は、判定が指摘なしの回だけ。
- `apps/daemon/src/risk-assessment.ts`：`assessesRiskInReview` の対象に、実装の PR の子タスクを足した（要求要件・設計の子タスクと、引き継いだ PR の子タスクは対象外）。`reviewRiskLines` は、判定を指摘なしにするときだけ評価を出すよう求める。使われなくなった `assessPullRequestRisk`・`buildRiskAssessmentPrompt` を消した。
- `apps/daemon/src/prompts.ts`：PR の本文（sacty の形・テンプレートの形）から評価の節をなくした。`extractReviewComments` は、指摘なしの回だけ評価を返し、ほかの回は JSON を本文から取り除く。`buildReviewBody` は、指摘なしの回の、今回の先頭の評価だけを載せる。
- `apps/web`：`riskAssessmentToShow` を足し、PR を作ったタスクの詳細に、子タスクの評価を、評価した先頭を添えて出す（PR の先頭が進んでいれば、今の先頭の評価ではないと書く）。文言は日英。
- 型・記録・投影・費用の集計・作業履歴の 1 行は変えない（版を上げる前の記録を、そのまま読む）。既定のコンテキストも変えない。
- 仕様書（`risk-assessment`・`approval`・`tasks-and-steps`・`event-log`・`README`。日英）、ユーザードキュメント（`tasks`・`intake`。日英）、ADR。PBI-421 の ADR は、引き継ぎの部分を置き換えたので `superseded` にした。

## 決めたこと

- 子タスクの評価は、リスク評価を有効にしたデーモン（`riskAssessment`）だけが行う（取り込んだ PR のレビューは、今までどおりこの設定によらない）。
- 親の画面は、子タスクの評価の先頭を、PR の提出した先頭と指摘なしにした先頭の両方と比べる（人がコミットを足すと、2 つが違うため）。
- 版を上げる前の `publish` の評価は、親の詳細に残し、評価した先頭を添える。子タスクの評価があれば、それを先に出す。

## 確かめたこと

- `apps/daemon/src/daemon-risk-assessment.test.ts`：評価を有効にしたデーモンで、PR の作成・更新に評価の実行・記録・本文の節が無いこと（過去の `publish` の記録つき）。対象 × 判定 × 評価の答えの表（45 通り）で、記録・コメントへの掲載・JSON の取り除き・指示を確かめた。
- `apps/daemon/src/risk-assessment.test.ts`：対象の判定、指示、読み取り、本文の組み立て（先頭が違う回・指摘なしでない回に載せない）。
- `apps/web/src/components/risk-assessment.test.ts`：親の詳細に子タスクの評価が出ること、先頭が進んだときの表示、過去の記録（`base`・`inheritedFrom` つき）の表示。
