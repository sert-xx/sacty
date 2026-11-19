# レビューのタスクを、指摘なしになるまで完了にせず、PR の変化を見守って再レビューする

- 日付: 2026-11-19（UTC）
- タスク: PBI-411
- PR: #452
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

## セルフレビューで見つけて直したこと

- 取り込みを通さずに人が作ったレビューのタスク（`source` が無い）は、投稿で見守りに入るのに、PR の確認の対象（`source.review` のあるタスク）に入っておらず、PR がマージされても「PR の対応待ち」のまま残った。見守りの対象を、確かめた対象の PR（`reviewTarget`）で決めるように直した。
- sacty が作った PR を、子タスクでないレビューのタスク（人が作ったもの・以前の版で取り込んだもの）が見守っているとき、PR を作ったタスクの更新のたびに、子タスクと二重に再レビューを始めうるので、見守りの終わりだけを扱うようにした。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npm run build`：通った。
- `npx vitest run --no-file-parallelism`：通った。
- `npx vitest run tests/docs`：通った。
- 足したテスト：`apps/daemon/src/daemon-review-watch.test.ts`（見守り・以前の版で完了したタスク・再依頼）、`packages/core/src/projection.test.ts`・`apps/daemon/src/daemon-step-pull-requests.test.ts`（子タスクと親の流れ）・`apps/daemon/src/task-mcp.test.ts`・`apps/daemon/src/task-mcp-wait.test.ts`・`apps/daemon/src/notifier.test.ts`・`apps/daemon/src/github.test.ts`・`packages/core/src/dashboard.test.ts`・`apps/web/src/lib/labels.test.ts`・`apps/web/src/components/review-watch-notice.test.ts`。
- 直しを戻すと、テストが落ちること（19 通り。1 つずつ戻して、関係するテストを実行し、戻した）：
  - 先頭の変化で再レビューを始めない／同じ先頭の歯止めを外す
  - 返信で判定し直さない／同じ先頭の返信の歯止めを外す／sacty の目印の投稿を除かない／作者でない人の投稿も数える／対象を確かめる前の投稿も数える
  - push・返信を静かになるまで待たない／先頭がまた変わっても待ち直さない
  - 指摘なしで完了した後は先頭を追わない／完了の後も返信で始める／指摘なしでも完了にしない
  - 見守り中のマージ・クローズを記録しない／見守りを終えても完了にしない
  - 見守りの印の無い投稿も見守る／見守りの印の無い完了タスクも PR の確認の対象にする
  - 人が作ったレビューのタスクを見守りの対象から外す／sacty が作った PR でも再レビューを始める
- 以前の版の作業履歴：見守りの印の無い投稿（判定が「修正が必要」「提案あり」「判定なし」）の作業履歴を読み込ませ、PR の先頭の変化・作者の返信・マージがあっても、完了のまま・何も記録しない・PR を読みに行かないことを、テストで確かめた（投影のテストは、再レビューを重ねた作業履歴も）。
- 実機：この版をビルドし、一時の `SACTY_HOME` と別のポートで `sacty up` を起動して、画面で確かめた。GitHub の API は代わりの答え、エージェントの実行（docker）は決まった答えを返す代わりのスクリプト、対象リポジトリはローカルの git リポジトリ。
  - レビュー用のラベルで取り込んだ PR のタスクが、「修正が必要」のレビューを投稿して、状態が「PR の対応待ち（修正が必要）」になった。一覧・ダッシュボード（「終わっていないタスク」に出て、「あなたの出番」に出ない）・詳細の知らせで確かめた。
  - PR に push すると、次の PR の確認から 2 分たって、sacty が再レビューを始めた（push から 162 秒）。再レビューが「指摘なし」を投稿して、「完了」になった。
  - 「提案あり」で見守っている別の PR をマージすると、次の PR の確認で、状態が「完了（PR がマージされた）」になり、作業履歴と詳細に理由が出た。
  - 見守っている間に `sacty up` を止めて起動し直しても、「PR の対応待ち」のまま出て、その後のマージで完了になった。

## レビューの指摘と対応

1 回目（sacty のレビュー。判定：提案あり。提案 13 件）。

| 指摘 | 対応 |
| --- | --- |
| 1. 取り込んだ後の push が、人の判断なしに検証で動く | 文書に書いた（ADR の影響、ユーザードキュメントの「信頼できない PR を取り込まない」、仕様書）。フォークの PR は人の操作を待つ・設定で見守りを切る、は足していない（残したこと） |
| 2. 返信を読む間に再依頼の新しいタスクができると、二重に始める | 読んだ後に確かめ直すようにした（`watchReview`）。割り込みのテストを足した |
| 3. 見守りの読み取りの失敗・遅延 | 読んだ時刻は読めたときだけ記録する。PR の状態とコメントの読み取りに期限（30 秒）を付けた。警告にタスクの ID を入れた。レート制限の見分けは足していない（残したこと） |
| 4. 指摘なしで完了した後のマージでも、詳細に「マージされたので完了」と出る | 判定が指摘なしでないときだけ出すようにした。テストを足した |
| 5. `isFinished` の意味の変化に追従していない箇所 | 詳細の監査の読み取りを、監査の対象の条件（`isAuditTarget`）にそろえた。流量の数え方は意図した変化なので、ユーザードキュメントに書いた |
| 6. ユーザードキュメントの、sacty が作った PR の記述が実装と合わない | ラベルで取り込んだ PR と sacty が作った PR を分けて書いた（日英） |
| 7. 古い `reviewRestartCommit` で、レビューしていない先頭が再レビューされない | 別の先頭をレビューした後は歯止めにしないようにした。テストを足した（読み違えの歯止めのテストは、そのまま通る） |
| 8. 人が作ったレビューのタスクは、実行中のマージ・クローズで中止されない | 直していない。今までも、人が作ったタスクは PR のマージ・クローズで中止していない（取り込んだタスクだけ）。仕様書に例外として書いた |
| 9. 返信で判定し直す回に、返信が作者の返答として渡らない | 前の回の対象を確かめた時刻より後の返信を渡すようにし、判定し直す回の指示を足した。テストを足した |
| 10. 予算の上限で止まり、再開して見守りに戻ることのテストが無い | テストを足した |
| 11. 作業履歴に、ひな形の節が無い | この節と「残したこと」を足した |
| 12. 以前の版に戻すと起動できなくなることが、文書に無い | ADR の影響に書いた |
| 13. 細かい指摘 | 使っていない `reviewFollowing` と `reviewWatchEnded.at` を消した。子タスクを毎回読むのは、そのままにした（親のマージ・クローズに遅れずに完了にするため。親が承認待ちの間だけ、同じ PR を親と子で読む）。`watchReview` の分割は、していない（残したこと） |

## 残したこと

- フォークの PR の push は人の操作を待つ・プロジェクトの設定で見守りを切る（新しい設定と判定が要る）。
- 見守りの読み取りで、GitHub のレート制限を見分けて待つ（ほかの PR の確認と共通の仕組みが要る）。
- 再レビューの実行中のマージ・クローズを、中止ではなく完了にする（実行を止めた後に完了へ進める仕組みが要る）。人が作ったレビューのタスクの、実行中のマージ・クローズでの打ち切りも同じ。
- GitHub の再依頼で引き継がれた元のタスクと、sacty が作った PR を見守る人のタスクは、画面の補足が「自動で再レビューします」のままで、実際には始めない（デーモンから、始めない理由を画面に返す仕組みが要る）。
- `watchReview` を、打ち切りの判定・push の待ち・返信の待ちに分ける整理。
