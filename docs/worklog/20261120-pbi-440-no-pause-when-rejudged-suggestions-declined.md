# 判定し直しの回に残った提案もすべて対応しないとき、一時停止せずに、ドラフトを外して人の承認待ちにする

- 日付: 2026-11-20（UTC）
- タスク: PBI-440
- PR: なし
- ブランチ: sacty/task-（タスク ID の先頭 8 文字）
- 関係する ADR: [判定し直した回に残った提案もすべて対応しないときは、一時停止せずに、ドラフトを外して人の承認を待つ](../adr/20261120-2342-no-pause-when-rejudged-suggestions-all-declined.md)

## 目的

選り分けで始めた同じ先頭の判定し直しの回が、また提案だけを残し、それもすべて対応しないとしたとき、一時停止して人を待たずに、判定は「提案あり」のまま、ドラフトを外して人の承認を待つ（利用者の決定）。
その先頭にはリスク評価が出ないことを受け入れる。あわせて、選り分けの指示に載せる今回の提案・要修正の文の上限を 600 から 2,000 文字に上げる。

## したこと

- `PullRequestMarkedReady` に `reason`（`suggestions_declined`）を足した。無い記録は指摘なし（以前の記録は、そのまま読める）。
- PR の確認で、`triageStopDue` が真のとき、`TaskPaused`（`triage.left`）の代わりに `markReady(…, "suggestions_declined")` を呼ぶ。`markReady` の最後の検査は、この場合、子タスクが同じ先頭・同じ回・同じ判定数で、最後の判定が「提案あり」であり、`triageStopDue` が今も真であることを見る。
- 投影：`Task.triageStop` を `TaskPaused` で消さずに、`PullRequestMarkedReady` で消す（以前の版が一時停止させたタスクも、再開でドラフトが外れる）。`pullRequest.suggestionsLeft` を足し、`wantsDraft` と PR の確認の `redraftAwaiting` が、提案が残ったまま外した先頭をドラフトに戻さないようにした。
- 画面：作業履歴の行（`PullRequestMarkedReady` の理由が `suggestions_declined` のとき、別の文言）と、承認の画面・タスクの概要の `AiReviewNotice` に、提案が残っていること・リスク評価が無いこと・直させたいときは PR に要対応とコメントすることを足した。
- 選り分けの指示：今回の提案と要修正の文を 1 件 2,000 文字まで（前の回の指摘・対応しないとした提案・返信・再レビューに渡す分は 600 文字のまま）。件数が多いときの合計の上限は、1 つのレビューの本文の長さで抑えられるので、置かない。
- 仕様書（`approval`・`event-log`）・利用者向けの文書（`tasks`）を日英とも直し、ADR を足して PBI-436 の ADR を `superseded` にした。

## 確かめたこと

- `daemon-suggestion-triage.test.ts`：一時停止せずにドラフトが外れる（判定し直し・選り分けが増えない）、人の要対応のコメントで直しに入る、先頭が進むと再レビューが始まる、以前の版の一時停止（stop と `triage.left`）を再開するとドラフトが外れる、起動し直し。
- `suggestion-triage.test.ts`：今回の提案・要修正は 2,000 文字まで、前の回の指摘・対応しないとした提案は 600 文字まで。
