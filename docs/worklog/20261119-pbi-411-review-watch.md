# レビューのタスクを、指摘なしになるまで完了にせず、PR の変化を見守って再レビューする

- 日付: 2026-11-19（UTC）
- タスク: PBI-411
- PR: なし
- ブランチ: feat/issue-411-review-watch
- 関係する ADR: [レビューのタスクは、判定が指摘なしになるまで完了にせず、PR の変化を見守って自動で再レビューする](../adr/20261119-1925-review-task-watches-pr-until-no-findings.md)

## 目的

PR のレビューのタスクは、判定に関係なく、レビューを投稿すると完了していた。指摘の後の PR の作者の修正・反論を見ていなかった。
判定が指摘なしになるまで完了にせず、PR の変化（push・作者の返信・マージ・クローズ）を見守って、自動で再レビューする。
この仕組みより前に完了したタスクは、完了のままにする（一斉に再レビューを始めない）。sacty が作った PR の子タスクと親の流れは変えない。

## したこと

- `packages/core/src/events.ts`
  - `PullRequestReviewPosted` に見守りの印 `watch` を足した。`ReviewRestarted` の `reason` に `pushed`・`replied` を足した。`ReviewWatchEnded`（`merged`・`closed`）を足した。
- `packages/core/src/projection.ts`
  - タスクに `reviewWatch`・`reviewWatchEnded`・`reviewResolvedAt`・`reviewReplyCommit` を足した。
  - `reviewWatching`・`reviewFollowing`・`currentReviewVerdict`・`isDone` を足し、`isFinished` を「中止か `isDone`」にした。`isCompleted`（工程がすべて終わった）は変えていない。
- `apps/daemon/src/service.ts`
  - レビューの投稿に `watch: true` を付ける（`composeReviewPost`）。
  - `checkReviewPullRequests` を、投稿の前のタスク（今までどおり、マージ・クローズで中止）と、見守っているタスク（`watchReview`）に分けた。
  - `watchReview`：マージ・クローズで `ReviewWatchEnded`、先頭の変化で `ReviewRestarted`（`pushed`）、作者の返信で `ReviewRestarted`（`replied`）。静かになるまで `FEEDBACK_QUIET_MS` 待つ。
  - `reviewWatchDue`・`REVIEW_WATCH_INTERVALS`：投稿から時間がたった PR は、間を空けて読む。
  - `supersededByRerequest`：GitHub の再依頼で作った、より新しいタスクがある元のタスクは、PR の変化で再レビューを始めない。
  - `reconcileReviewTasks`：親が中止されたら、見守り中の子タスクも中止する。
- `apps/daemon/src/github.ts`：PR の状態の答えに `updatedAt` を足した（変わっていない PR のコメントを読み直さない）。
- `apps/daemon/src/notifier.ts`：見守りの間は、完了の通知を出さない。
- `apps/daemon/src/task-mcp.ts`：要約の `review` に `watching`・`watchEnded` を足した。`pause_task` を見守り中にも使えるようにした。`wait_for_task` が、レビューの投稿（見守りに入ったとき）でも起きるようにした（cursor に、PR のレビューのタスクだけの欄 `w`）。説明文を直した。
- `apps/web`：状態の表示（「PR の対応待ち（判定）」「完了（PR がマージされた）」など）、タスクの詳細の知らせ（`ReviewWatchNotice`）、見守り中の一時停止・中止の操作、作業履歴の行。
- `packages/core/src/messages.ts`：再レビューできないときの文（`review.notRereviewable`）を直した。
- 文書：仕様書（`tasks-and-steps`・`intake`・`approval`・`mcp-server`・`notifications`・`audit`）とユーザードキュメント（`intake`・`mcp`・`tasks`・`dashboard`）の日本語と英語、ADR。

既定で決めたこと（ADR に書いたものを除く）：

- 続きのタスクの作成（派生）は、見守り中のタスクからも今までどおり作れる（指摘を直すタスクなど。`canDerive` は工程が終わったことで決める）。
- 一時停止している見守りのタスクは、PR がマージ・クローズされても完了にしない（再開の後の確認で完了にする）。
- `sacty mcp` の要約の `state` に新しい値は足さず、見守り中は `idle` のまま、`review.watching` で見分ける。

## 確かめたこと

- `npm run typecheck`：通った。
- `npm run lint`：通った。
- `npx vitest run tests/docs`：通った。
- 足したテスト：`apps/daemon/src/daemon-review-watch.test.ts`（見守り・過去のタスク・再依頼）、`packages/core/src/projection.test.ts`・`apps/daemon/src/daemon-step-pull-requests.test.ts`（子タスクと親の流れ）・`apps/daemon/src/task-mcp.test.ts`・`apps/daemon/src/task-mcp-wait.test.ts`・`apps/daemon/src/notifier.test.ts`・`apps/daemon/src/github.test.ts`・`packages/core/src/dashboard.test.ts`・`apps/web/src/lib/labels.test.ts`・`apps/web/src/components/review-watch-notice.test.ts`。
