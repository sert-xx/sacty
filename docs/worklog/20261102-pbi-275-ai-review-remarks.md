# sacty 自身の AI のレビューの指摘を、人の指摘と区別して扱う

- 日付: 2026-11-02（UTC）
- タスク: PBI-275
- PR: #279
- ブランチ: feat/issue-275-ai-review-feedback
- 関係する ADR: [sacty 自身の AI のレビューの指摘を、人の指摘と区別して扱う](../adr/20261102-0843-distinguish-ai-review-remarks.md)

## 目的

sacty のレビューのタスクが、作ったタスクの PR にプロジェクトのアカウント（人と同じ）で投稿するレビューの指摘が、人の指摘と同じに扱われていた。
実験（S14・S18・S19）で、作業履歴の「指摘5件（人間）」の4件が AI のレビューだった・差し戻しの上限（3回）に早く達した・監査が「人の差し戻し」と数えた・
人の「さっきの指摘は無しで」を AI のレビューのことと読んだ・古い head へのレビューが遅れて届き実装が余分に1回走った、ことが起きた。
AI のレビューの指摘は今までどおり作ったタスクに届け、人の指摘と区別する。

## したこと

- 見分け：`GitHubPullRequests.feedback` が、sacty のレビューのタスクの投稿（目印と回で判定する、既存の取り込みの判定）に `source: "sacty_review"` と、
  対象にしたコミット（`commit_id`）を付ける。アカウントでは見分けない。
- 記録（`packages/core`）：`PullRequestReviewImported` の `items[].source`、差し戻しの指摘（`Remark`・`TaskRemark`）の `source`、`pendingReview.aiReview` を足した。
  古い head へのレビューを捨てる `PullRequestReviewDiscarded` を足した（取り込み済みにするだけ）。
- 回数と上限：`changeRounds` を、人の指摘が1件でもある回の数にした。`lastChangeRound` を足し、回の番号と指摘の ID は AI のレビューの回も含めて続ける。
  `requestChanges` は、AI のレビューの指摘だけなら上限でエスカレーションにせず、actor を `sacty` にする。
  取り込みの記録も、AI のレビューだけなら actor を `sacty` にした。費用の上限は変えていない。
- 古い head：`importFeedback` が、AI のレビューの対象のコミットが PR の今の head と違えば、取り込まずに捨てる（`withoutStaleReviews`）。
  コミットが分からなければ取り込み、head を読めなければ AI のレビューだけ次の確認に回す。
- エージェントへの渡し方（`prompts.ts`）：`remarkSections`・`reworkRemarkLines` で、人の指摘と AI のレビューの指摘の節を分けた。
  工程の指示・最終レビュー・統合レビュー・戻し先の判断・質問・監査・再実行の記録・`remarks.md` に適用し、人の指摘の節に
  「さっきの指摘」などは人の指摘を指すと添える。
- 表示・集計：作業履歴の差し戻し・取り込み・捨てた記録、承認の画面の指摘の印、ダッシュボードの品質の信号（`aiReviewRework`）、
  監査の根拠の件数（`aiReviewRemark`。`AuditSurveyed` の `counts` は、無い種類を 0 として読む）。
- docs：仕様書（approval・intake・audit・architecture・tasks-and-steps。日英）、ユーザードキュメント（intake・tasks・audit・dashboard。日英）、ADR。

## 確かめたこと

- `npx biome check .`：指摘なし。
- `npm run typecheck`：通った。
- `npx vitest run`：182 ファイル・3401 件が通った（終了コード 0）。`npx vitest run tests/docs` も通った。
- 足したテスト：
  - `packages/core`：投影（出どころ・位置の記録、人の回数と回の番号、捨てた記録）・ダッシュボード・監査の件数の読み込み（以前の記録）。
  - `apps/daemon`：`github.test.ts`（目印・コミットの添え方。人が目印を写したもの・別アカウントは AI にしない）、`prompts.test.ts`（節の分け方・空・AI だけ・戻し先の判断）、
    `audit-prompts.test.ts`（件数）、`daemon.test.ts`（AI のレビュー4回続けても上限にならず、人の3回で上限になる・混ざった取り込み・古い head を捨てる・
    コミットが分からない／head を読めない）。
  - `apps/web`：作業履歴の文・承認の画面の指摘・監査の欄。
- 修正を戻すと落ちることを確かめた：`changeRounds` が AI の回も数える形・古い head を捨てない形に戻すと、足したテスト 4 件が落ちる。
- 状態の境界：AI のレビューの 0 件・1 件・複数件、人と AI が混ざる回、短い commit・大文字小文字の違い、AI の回が人の回の間に入る順。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （DA のセルフレビュー）対象のコミットが分からない投稿・head を読めないときの扱い | 前者は取り込み、後者は AI のレビューだけ次の確認に回す形にして、テストで確かめた |
| （Sacty のレビュー）要求要件・設計を AI の指摘だけで差し戻しても、直し方の指示が「人間の指摘」と書いていた | 「今回の指摘」と、出どころを限定しない表現にした |
| （Sacty のレビュー）作業履歴の差し戻しを展開した詳細に、混ざった回の指摘の出どころが無い | AI のレビューの指摘に「（AI のレビュー）」の印を付けた（日英） |
| （Sacty のレビュー）行へのコメントの `commit_id` は後の push で今の head に付け替わり、古い head の判定に使えない | 親レビューの `commit_id`（無ければ `original_commit_id`）を使い、両者が異なるケースをテストした |
| （Sacty のレビュー）人3回→AI だけ→人 の順のテストが無い | 足した。AI では取り込んで人の回数は 3 のまま、続く人で上限が効く |
| （Sacty のレビュー）混ざる回でも AI の指摘に「数えない」と出る | 同じ工程・同じ回に人の指摘があるときは、通常の回の表示にした |
| （Sacty のレビュー・main 取り込み後）PBI-276 の `unreflectedImplementRemarks` が最新の回に `changeRounds` を使っており、最初の回が AI のレビューだけだと 0 になって未反映の指摘を取れない | `lastChangeRound` に切り替え、AI だけの回と、AI の回の後に人の回が続くケースをテストした。main に入った他の箇所に `changeRounds` の取り違えがないことを grep で確かめた（残りの使用は上限の判定と承認の画面の回数だけ） |
| （DA のセルフレビュー）監査の件数の記録に種類を足すと、以前の記録が読めなくなる（zod 4 の record は全キー必須） | `partialRecord` で読み、無い種類を 0 にして返す形にして、テストを足した |

## 残したこと

- このデーモンの台帳に無い（別の sacty が投稿した）AI のレビューは、目印があっても区別せず、これまでどおり扱う。
- AI のレビューの投稿が、レビューした後に取り込むまでの間に PR が更新されなかった場合の余分な実行（指摘が妥当で直す実行）は、方針どおり届ける。
