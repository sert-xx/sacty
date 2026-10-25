# sacty のレビューのタスクの指摘を、提案だけの回も元のタスクに届けて対応させる

- 日付: 2026-10-19（UTC）
- タスク: PBI-145
- PR: #160
- ブランチ: feat/pbi-145-sacty-review-import
- 関係する ADR: [sacty のレビューのタスクの投稿は、提案だけの回も元のタスクの PR の指摘として取り込む](../adr/20261019-1239-superseded-import-sacty-review-suggestions.md)

## 目的

sacty が作った PR にレビュー用のラベルを付けて別のタスクにレビューさせても、そのレビューの指摘が「提案あり」の判定だと元のタスクに届かず、
人が指摘をさばいていた。sacty のレビューの内容を元のタスクが確かめて対応・修正まで自動で進むように、指摘のある回をすべて取り込む。
繰り返しの費用は予算で止める（ステークホルダー）。

## 調べたこと

実機の台帳は手元に無い（`~/.sacty/sacty.db` は空）ので、コードで取り込みの経路を追った。

- `GitHubPullRequests.feedback`（`apps/daemon/src/github.ts`）は、PR をレビューした sacty のタスクの回（`sactyReviews`）を受け取り、目印とアカウントが
  一致する投稿は `allowed` で含めるかを決める。目印はレビューの本文と行へのコメントの両方の先頭にある（`buildReviewComments`）。
- `sactyReviewsOf`（`apps/daemon/src/service.ts`）が `allowed` を決めていた。`source.review: sacty` で、その回の判定があり、判定が `changes_required` か
  読めない回だけを `allowed` にしていた。`suggestions` の回はここで除かれる。
- ほかに届かない原因になりうるもの：レビューのタスクのプロジェクトにそのホストのアカウント（`githubAccounts`）が無いと回を作らない（その場合は
  目印の投稿は人の投稿として取り込まれる）。元のタスクが承認待ち（`awaiting_approval`）でないか、前の取り込みの判断が残っている（`pendingReview`）
  と取り込まない。これらはコードの上では今までどおりで、今回は変えていない。

## したこと

- `sactyReviewsOf` の `allowed` を「判定が `no_findings` でない回」に変えた（`changes_required`・`suggestions`・読めない回を取り込む）。
- `daemon.test.ts` の、提案だけの回を取り込まない前提のテストを、取り込む前提に直した（判定ごとの期待を `verdict` で持たせた）。
- 仕様書（`docs/spec/approval.md`・`tasks-and-steps.md`・`intake.md` と英語の版）と、ユーザードキュメント（`docs/user/intake.md` と英語の版）の、
  元のタスクに届ける回の規則を直した（ユーザードキュメントは DA のセルフレビューで見つけた）。
- ADR を足した。

## 確かめたこと

- `npm run lint`：通過（354 ファイル）。
- `npm run typecheck`：通過。
- `npx vitest run apps/daemon packages/core`：60 ファイル・1787 件が通過（提案だけの回を取り込むテスト、指摘なしの回を取り込まないテスト、
  別アカウントのレビューのタスクの判定のテストを含む）。
- `npx vitest run tests/docs`：89 件が通過（ADR・作業履歴のファイル名、日英の突き合わせ）。
- DA のセルフレビュー：古い規則（「提案だけの回は取り込まない」）が残っていないかを docs・apps・packages で探し、ユーザードキュメントに残っていたので直した。
  実機の台帳が無いので、実際の PR での動作確認はしていない（実際の運用の環境で、sacty のレビューに `[提案]` だけが付いた PR の元のタスクが
  差し戻されることを確かめる）。
