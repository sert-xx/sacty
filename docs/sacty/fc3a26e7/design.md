<!-- sacty task fc3a26e7-3135-442d-a54c-8587cc816e76 の設計。sacty が作成しました。 -->

# 設計：前の工程へ戻した後の実装の PR のマージ（PBI-494）

## スコープ

前の工程（要求要件・設計）へ戻している間に実装の PR がマージされたら、作り直しの間のマージ（PBI-276）と同じ記録で実装の承認として進める。
すでにこの状態で止まったタスクも、修正の版で進むようにする。
前の工程へ戻している間も、実装の PR の閉じた・開き直した状態を記録に合わせ、取り消しのときは、マージ済み・閉じた実装の PR を閉じる対象に挙げない。

- 対象
  - 前の工程へ戻している間の実装の PR の見守り（PR の確認・工程の PR の作成の前後）と、マージ・閉じた・開き直した記録の投影
  - 取り消しの閉じる対象（画面の `cleanupPlan`・中止の片付け・MCP の `cancelTargets`）
  - 再現のテスト、仕様書（日英）、利用者の文書（日英）、ADR、作業履歴（原因）
- 対象外
  - マージのやり方・ブランチを消す設定

## 確認したいこと

must：なし

should
- Q-1：マージで進めたとき、やり直しの間に作った工程の PR（タスクブランチ向き）が開いていたら、sacty が閉じるか。
  - 推奨：閉じて、記録でも置き換え済みにする。GitHub は消えたブランチを向く PR を、マージした PR のベース（main）へ付け替えるため。
  - 懸念：閉じないと、終わったタスクの設計書だけの PR が main 向きで開いたまま残り、人が誤ってマージしうる。

確認しないと決めたこと
- 原因の経路：PR #590 にマージの 32 秒前（21:53:27Z）の「指摘を設計に戻しました」があり、PR の指摘の戻し先が設計の差し戻し（`ChangesRequested`）と決めた。設計の変更の申し出（`ChangeApplied`）は工程を戻さないので、本文の「変更の申し出」とは食い違う。見守りの条件は「実行対象の工程が実装より前」で、戻した経路（要求要件の申し出の `reopen` を含む）に依らないので、テストは PR #590 と同じ経路で作る。
- やり直しを捨ててマージを承認にする：受け入れ条件 2 が「マージを認めて次へ進む」と決めており、PBI-276・PBI-462 の作り直しの間のマージと同じ扱いになるため。
- ADR を足す：PBI-276 の「前の工程をやり直している間は実装の PR を見守らない」（approval.md）を変えるので、リポジトリの決まりで要る。PBI-276 に ADR は無く、PBI-462 の ADR はこの場合を決めていないので、置き換え（superseded）はしない。
- 記録が `closed` の実装の PR は、取り消しの閉じる対象から外す（受け入れ条件 4）。いまの仕様の「閉じ直すので出す」を変える。

## 既定で決めたこと

- 新しいイベントは足さず、`ReworkStoppedByMerge`（step なし）・`PullRequestMerged`・`StepApproved` を記録する。記録した後は前の版のデーモンが投影で止まるので、版を戻せないことを ADR と仕様に書く。
- 捨てた指摘（`discardedRemarks`）は、やり直している工程の未反映の指摘にする。
- 前の工程へ戻している間に閉じられた実装の PR も見守り続け、GitHub で開き直されたら `PullRequestReopened` を記録する（開き直してマージされることがあるため）。

## 構成

| 場所 | 変更 |
| --- | --- |
| `packages/core/src/projection.ts` | `sentBackImplementPullRequest(task)` を足す。`pullRequest` があり記録が `open`・`closed`、実行対象の工程が実装より前、状態が `queued`・`running`・`idle`・`paused`・`awaiting_approval`・`escalated` のとき、その PR を返す |
| 同上 `reopen` | 実装の PR があるとき、最初の `reopen` で、実装より前の全工程の承認・成果・テスト観点を `Task.implementBasis` に残す。後の `reopen` では上書きしない |
| 同上 `ReworkStoppedByMerge`（step なし） | 上の PR も受け付ける。戻している工程から実装の前までを done にし、実装より前の全工程の承認・成果・テスト観点を `implementBasis` で置き換える（やり直しの間に承認し直した工程も戻す）。やり直しの間に作った開いた工程の PR（置き換え済みにする）を片付ける |
| 同上 `PullRequestClosed`・`PullRequestReopened` | ゲートの PR に加えて、上の PR も受け付け、`pullRequestState` を `closed`・`open` にする（工程と状態は変えない） |
| `apps/daemon/src/service.ts` `reworkTarget` | 実装の作り直しの PR が無ければ、上の PR を返す。`checkReworkMerges`・`stopReworkForMerge`・`endReworkByMerge` がそのまま扱う（実行中の工程はコンテナを止めて確かめる） |
| 同上 `checkReworkMerges` | 上の PR が GitHub で閉じていて記録が `open` なら `PullRequestClosed` を、開いていて記録が `closed` なら `PullRequestReopened` を記録する |
| 同上 `publishStepPullRequest` | タスクブランチを取りに行く前に、上の PR の状態を読む。マージ済みなら、PR を作らず同じ記録で進める。取得が `couldn't find remote ref`（`remoteRefMissing`）で失敗したら、状態を読み直し、マージ済みなら同じく進める（そうでなければいまの `pr.failed`） |
| 同上 記録の後 | やり直しの間の開いた工程の PR を閉じる（Q-1）。PR に、マージを承認にしたことを知らせる（既存の知らせ） |
| 同上 `cleanupPlan`・中止の片付け、`apps/daemon/src/task-mcp.ts` `cancelTargets` | 実装の PR は、記録が `open` のものだけを閉じる対象にする。片付けは、閉じる直前に GitHub で開いているかを確かめる |
| テスト | 再現は `apps/daemon/src/daemon-implement.test.ts`。投影は `packages/core` の投影のテスト、MCP は `packages/cli/src/mcp-cancel.test.ts`。偽物の `fetchBranch` に、ブランチごとの `couldn't find remote ref` を足す |
| 文書 | `docs/spec/approval.md`（「PR の確認」「実装の作り直しの間のマージ」の対象・互換性）・`docs/spec/mcp-server.md` の閉じる PR・`docs/user/tasks.md`（「直してからマージしたとき・作り直しの間にマージしたとき」の「要求要件・設計をやり直している間は…止めません」）、と各 `.en.md`。ADR（`docs/adr/`）、作業履歴 `docs/worklog/YYYYMMDD-pbi-494-<スラッグ>.md` |

## 止まっているタスクの扱い

台帳は変えない。
修正の版の起動で投影を作り直すと、`reopen` が `implementBasis` を残し直すので、次の PR の確認（一時停止のままでも）か再開の後の `publishStepPullRequest` が、マージを見つけて進める。

## テスト観点

- [TV-1] 前の工程へ戻した後のマージで、タスクが一時停止せずに実装の承認へ進む（再現）
  - 入力：実装の PR が open のタスクで、PR の指摘の戻し先を設計にして差し戻し（ChangesRequested）、設計のやり直しが終わって工程の PR の作成を待つ（idle）。偽の GitHub は実装の PR を merged と返し、タスクブランチの fetchBranch は couldn't find remote ref で失敗する
  - 期待結果：PR の確認の後、作業履歴に ReworkStoppedByMerge（step なし）・PullRequestMerged・StepApproved（implement）がこの順に1回だけ記録され、TaskPaused（error）は無く、タスクはマージの後の監視か完了に進み、修正を戻すと TaskPaused（error・pr.failed）になってテストが落ちる
- [TV-2] PR の確認より先に工程の PR の作成が始まっても、タスクブランチを取りに行かずに進む
  - 入力：上と同じタスクで、PR の確認を呼ばずに実行（runNext）だけを進める
  - 期待結果：publishStepPullRequest がタスクブランチの fetchBranch を呼ばず、PR も作らず、上と同じ 3 つの記録でタスクが進む
- [TV-3] 状態を読んだ直後にマージされてブランチが消えても、一時停止せずに進む
  - 入力：上と同じタスクで、偽の GitHub が実装の PR を、publishStepPullRequest の最初の読み取りでは open、2 回目からは merged と返し、タスクブランチの fetchBranch は couldn't find remote ref で失敗する
  - 期待結果：状態が読み直され、TaskPaused（error）も pr.failed も記録されず、上と同じ 3 つの記録でタスクが進む
- [TV-4] やり直しの実行中にマージされたら、実行を止めてから記録する
  - 入力：設計へ戻した後の設計の実行が実行中（running）のときに、実装の PR が merged になる
  - 期待結果：コンテナが止められ、止めた実行が ReworkStoppedByMerge の stoppedRuns に入り、人の一時停止（TaskPaused）は記録されずに上と同じく進む
- [TV-5] 実装の PR が開いたままなら、やり直しは続く
  - 入力：設計へ戻した後、偽の GitHub が実装の PR を open と返す
  - 期待結果：ReworkStoppedByMerge は記録されず、設計の工程の PR が作られて設計の承認待ちになる
- [TV-6] マージの後の投影で、工程と承認が実装の PR を作った時点に戻る
  - 入力：承認済みの設計 A で実装の PR を作り、設計へ差し戻して設計の出力を B にやり直した後、上の 3 つの記録を投影する
  - 期待結果：要求要件・設計・実装の工程が done、approved.design.output と outputs.design が A、テスト観点が A のもので、設計へ戻した指摘は無効（voided）、記録の pullRequestState は merged になる
- [TV-7] やり直しの間に承認し直した工程も、実装の PR を作った時点の承認に戻る
  - 入力：要求要件 R1・設計 D1 の承認で実装の PR を作り、要求要件へ戻して要求要件を R2 で承認し直し、設計をやり直している間に、上の 3 つの記録を投影する
  - 期待結果：approved.requirements と outputs.requirements が R1、approved.design と outputs.design が D1、テスト観点が D1 のものになり、R2 の承認は残らない
- [TV-8] やり直しの間に作った工程の PR を閉じる
  - 入力：設計へ戻した後に作った設計の PR（タスクブランチ向き）が開いて設計の承認待ちのときに、実装の PR が merged になる
  - 期待結果：その設計の PR が記録で closed・superseded になり、GitHub の閉じる呼び出しが1回行われ、タスクは実装の承認へ進む
- [TV-9] 前の工程へ戻している間に閉じた・開き直した実装の PR の状態を記録に合わせる
  - 入力：設計へ戻して設計をやり直している間に、偽の GitHub が実装の PR を closed と返し、次の PR の確認では open と返す
  - 期待結果：1 回目の確認で PullRequestClosed が記録されて pullRequestState が closed になり、cleanupPlan と get_cancel_plan の閉じる対象に実装の PR が出ず、2 回目の確認で PullRequestReopened が記録されて open に戻り、どちらでも設計の工程と状態は変わらない
- [TV-10] すでにこの状態で一時停止したタスクが、修正の版で進む
  - 入力：作業履歴に、設計へ戻した後の TaskPaused（error、文言は pr.failed の couldn't find remote ref）までがあるタスクを読み込んでデーモンを起動し、偽の GitHub は実装の PR を merged と返す
  - 期待結果：PR の確認、または resume の後の実行で、上と同じ 3 つの記録が記録され、タスクはマージの後の監視か完了に進み、記録の pullRequestState は merged になる
- [TV-11] 取り消しの確認は、記録が open でない実装の PR を閉じる対象に挙げない
  - 入力：pullRequestState が merged・merged_outdated・closed の実装の PR を持つタスクで、cleanupPlan と get_cancel_plan（cancelTargets）を読む
  - 期待結果：どちらも実装の PR を閉じる対象（pull_request の detail・willClose.pullRequests）に含めず、get_cancel_plan は untouched.pullRequests に理由つきで出す
- [TV-12] 中止の片付けは、GitHub で開いていない実装の PR を閉じない
  - 入力：記録の pullRequestState が open で、偽の GitHub が merged と返す実装の PR を持つタスクを中止する
  - 期待結果：pulls.close は実装の PR に対して呼ばれず、片付けの結果に失敗が出ない
- [TV-13] 作業履歴に原因が書いてある
  - 入力：docs/worklog/YYYYMMDD-pbi-494-<スラッグ>.md
  - 期待結果：PR #590 で設計へ戻した後（21:53:27Z）にマージ（21:53:59Z）され、実行対象が設計のため実装の PR を見守らず、工程の PR の作成がタスクブランチの取得で失敗して一時停止した経緯が書いてある
- [TV-14] 仕様書・利用者の文書と ADR に新しい扱いが書いてある
  - 入力：docs/spec/approval.md・approval.en.md・mcp-server.md・mcp-server.en.md・docs/user/tasks.md・tasks.en.md と追加の ADR
  - 期待結果：approval の日英に、前の工程へ戻している間も実装の PR を見守りマージで実装の承認として進めること・工程の PR の作成の前とブランチの取得の失敗の後に確かめること・承認を実装の PR を作った時点に戻すこと・閉じた・開き直した状態を記録すること・記録した後は版を戻せないことが、mcp-server の日英に、記録が open の実装の PR だけを閉じる対象にすることが、tasks の日英に、要求要件・設計をやり直している間に実装の PR がマージされたらやり直しを止めて承認として進めることが書いてあり、ADR が PBI-276 の決めを変える理由を述べている
