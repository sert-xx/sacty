<!-- sacty task fc3a26e7-3135-442d-a54c-8587cc816e76 の設計。sacty が作成しました。 -->

# 設計：前の工程へ戻した後の実装の PR のマージ（PBI-494）

## スコープ

前の工程（要求要件・設計）へ戻している間に実装の PR（引き継いだ PR を含む）がマージされたら、作り直しの間のマージ（PBI-276）と同じ記録で実装の承認として進める。
すでにこの状態で止まったタスクも、修正の版で進むようにする。
前の工程へ戻している間も、実装の PR の閉じた・開き直した状態を記録に合わせ、取り消しのときは、マージ済み・閉じた実装の PR を閉じる対象に挙げない。

- 対象
  - 前の工程へ戻している間の実装の PR の見守り（PR の確認・工程の PR の作成の前後）と、マージ・閉じた・開き直した記録の投影
  - 工程の PR と実装の PR が同じ確認でどちらもマージ済みのときの一時停止（PR の確認と工程の PR の公開で同じ判定を使う）
  - マージの後に残った、やり直しの間の工程の PR の片付け（閉じるまで繰り返す。後で main へマージされたものは merged と記録する）
  - 取り消しの閉じる対象（画面の `cleanupPlan`・中止の片付け・MCP の `cancelTargets`）
  - 再現のテスト、仕様書（日英）、利用者の文書（日英）、ADR、作業履歴（原因）
- 対象外
  - マージのやり方・ブランチを消す設定
  - 承認の基準とマージされた実装の包含関係を一般に保証すること（同じ確認で両方がマージ済みなら一時停止して人に任せる。まれな競合として既知の制約に書く）

## 確認したいこと

must：なし

should
- Q-1：マージで進めたとき、やり直しの間に作った工程の PR（タスクブランチ向き）が開いていたら、sacty が閉じるか。
  - 推奨：閉じて、記録でも置き換え済みにする。GitHub は消えたブランチを向く PR を、マージした PR のベース（main）へ付け替えるため。
  - 懸念：閉じないと、終わったタスクの設計書だけの PR が main 向きで開いたまま残り、人が誤ってマージしうる。
- Q-2：引き継いだ PR が、sacty が実装の PR を一度も出す前に（前の工程にいる間に）マージされたら、どの承認に戻すか。
  - 推奨：実装へ進んだ時点の承認・成果に戻す。まだ実装へ進んでいなければ、そのときの承認を残し、承認の無い工程は承認なしで done にする。
  - 懸念：引き継いだ PR の中身は人が書いたもので、どの承認にも対応しない。推奨のままだと、記録の承認済みの設計とマージされた中身が食い違ったまま完了しうる。
- Q-3：マージされたコミットが、基準を残したときのタスクブランチの先頭と違う（記録の前に積んだ push・人が積んだコミット）とき、どうするか。
  - 推奨：一時停止せず、基準の承認に戻して進め、`PullRequestMerged` を `edited` にする。人のマージは承認とする PBI-63 と同じ扱いのため。
  - 懸念：記録の承認済みの設計と、マージされた実装が食い違ったまま完了しうる。止めて人に判断させる案は、受け入れ条件 2 の「状態にかかわらず進む」と逆になる。
- Q-4（削除：承認の代理が決めた。承認にせず、記録の状態を merged にする）
- Q-5：両方がマージ済みで一時停止したタスクを人が再開したら、どう進めるか。
  - 推奨：実装の PR のマージだけを承認として進め、工程の PR は承認にせず merged と記録する（実装の承認の基準は変えない）。止めたままにすると、再開しても同じ一時停止を繰り返すため。
  - 懸念：工程の PR が実は実装の PR に入っていたなら、記録の承認済みの設計がマージされた実装より古いまま完了する。正しく記録したい人は、再開でなく取り消しを選ぶ必要がある。

確認しないと決めたこと
- 原因の経路：PR #590 にマージの 32 秒前（21:53:27Z）の「指摘を設計に戻しました」があり、PR の指摘の戻し先が設計の差し戻し（`ChangesRequested`）と決めた。設計の変更の申し出（`ChangeApplied`）は工程を戻さないので、本文の「変更の申し出」とは食い違う。見守りの条件は「実行対象の工程が実装より前」で、戻した経路に依らないが、再現のテストは PR #590 と同じ経路と、要求要件の変更の申し出（`ChangeApplied` の `reopen`）で戻る経路の両方で作る。
- やり直しを捨ててマージを承認にする：受け入れ条件 2 が「マージを認めて次へ進む」と決めており、PBI-276・PBI-462 の作り直しの間のマージと同じ扱いになるため。
- ADR を足す：PBI-276 の「前の工程をやり直している間は実装の PR を見守らない」（approval.md）を変えるので、リポジトリの決まりで要る。PBI-276 に ADR は無く、PBI-462 の ADR はこの場合を決めていないので、置き換え（superseded）はしない。
- 記録が `closed` の実装の PR は、取り消しの閉じる対象から外す（受け入れ条件 4）。いまの仕様の「閉じ直すので出す」を変える。

## 既定で決めたこと

- 新しいイベントは足さず、`ReworkStoppedByMerge`（step なし）・`PullRequestMerged`・`StepApproved` を記録し、工程の PR の片付けは `PullRequestClosed` で記録する。記録した後は前の版のデーモンが投影で止まるので、版を戻せないことを ADR と仕様に書く。
- 捨てた指摘（`discardedRemarks`）は、やり直している工程の未反映の指摘にする。
- 前の工程へ戻している間に閉じられた実装の PR も見守り続け、GitHub で開き直されたら `PullRequestReopened` を記録する（開き直してマージされることがあるため）。
- 戻す承認の基準は、sacty がタスクブランチの先頭を変えたと記録した時点のもの（実装の PR の作成・更新と、タスクブランチ向きの工程の PR のマージ）。実装へ進み直しただけのときと、画面での承認（工程の PR をマージしない）では基準を変えない。
- 両方がマージ済みのときの一時停止は、既存の `TaskPaused`（reason `error`）に、新しい文言のコード（両 PR の番号・再開したときの進み方を出す）と、任意の欄 `mergedPullRequests`（両 PR の番号）を付けて記録する。新しい理由の値を足すと前の版のデーモンが作業履歴を読めなくなるため。

## 構成

| 場所 | 変更 |
| --- | --- |
| `packages/core/src/projection.ts` | `sentBackImplementPullRequest(task)` を足す。実行対象の工程が実装より前、状態が `queued`・`running`・`idle`・`paused`・`awaiting_approval`・`escalated` のとき、`pullRequest` があり記録が `open`・`closed` ならその PR を、`pullRequest` が無く `continuedPullRequest` があれば引き継いだ PR（コミットは `reworkingPullRequest` と同じ。記録の `pullRequestState` が無ければ `open` とみなす）を返す |
| 同上 `Task.implementBasis` | タスクブランチの先頭のコミットと、そのときの実装より前の全工程の承認・成果・テスト観点を残す。sacty がタスクブランチの先頭を記録するたびに置き換える：実装の `PullRequestPublished`（作成・更新。その `commit`）と、タスクブランチ向きの工程の PR の `PullRequestMerged`（承認を反映した後。その `mergeCommit`）。`pullRequest` がまだ無い（引き継いだ PR だけの）間に限り、実装へ進んだとき（前の工程の `StepApproved`）にも置き換える。それ以外（実装へ進み直し・`reopen`・画面での承認）では変えない |
| 同上 `ReworkStoppedByMerge`（step なし） | 上の PR も受け付ける。引き継いだ PR なら、いまと同じく `pullRequest` に記録する。戻している工程から実装の前までを done にし、実装より前の全工程の承認・成果・テスト観点を `implementBasis` で置き換える（やり直しの間に承認し直した工程も戻す。基準が無い工程は Q-2）。工程の PR の記録は変えない |
| 同上 `PullRequestMerged`・`PullRequestClosed`・`PullRequestReopened` | ゲートの PR に加えて、上の PR も受け付け、`pullRequestState` を `merged`・`closed`・`open` にする（`Closed`・`Reopened` では工程と状態は変えない。`pullRequest` の無い引き継いだ PR も、同じ `pullRequestState` に残す）。`PullRequestClosed` は、実装の PR がマージ済みのタスクの開いた工程の PR も受け付け、置き換え済みにする。任意の欄 `merged: true` があれば工程の PR の state を `merged`、無ければ `closed` にし、どちらも承認にしない |
| 同上 `TaskPaused` | 任意の欄 `mergedPullRequests` を `Task` に残し、`TaskResumed` の後もその番号の組に限って残す（Q-5 の再開の扱いに使う） |
| `packages/core/src/events.ts` | `PullRequestClosed` に任意の `merged`、`TaskPaused` に任意の `mergedPullRequests` を足す（前の版は欄を読み飛ばすので読める） |
| `apps/daemon/src/service.ts` `reworkTarget` | 1 件ではなく、見守る PR をすべて返す（工程の PR の直しの PR・要求要件へ戻している間の設計の PR と、上の PR）。両 PR の状態をまとめて読み、どれを記録するか・一時停止するかを決める共通の判定（新しい関数）を、`checkReworkMerges` と `publishStepPullRequest` の両方が使う。判定：実装の PR だけがマージ済みなら実装の承認、工程の PR だけならいまの PBI-462 の扱い、同じ確認で両方がマージ済みならどちらも記録せず一時停止（既定で決めたこと）。`mergedPullRequests` の組と同じ両 PR で再開された後は、実装の PR だけを承認として記録し、工程の PR は片付けで merged と記録する（Q-5）。実行中の工程はコンテナを止めて確かめる |
| 同上 `checkReworkMerges` | 工程の PR の公開中（`stepPublishing`）のタスクは、実装の PR も含めて見守る PR をすべて飛ばし、`publishStepPullRequest` に任せる（片方だけを記録しないため）。上の PR が GitHub で閉じていて記録が `open`（引き継いだ PR は記録が無いときも）なら `PullRequestClosed` を、開いていて記録が `closed` なら `PullRequestReopened` を記録する |
| 同上 マージの記録 | マージされたコミット（`PullRequestMerged` の `commit`）が `implementBasis` のコミットと違えば、基準のまま進め、`edited` にする（Q-3） |
| 同上 `publishStepPullRequest` | タスクブランチを取りに行く前に、前の工程の PR と上の PR の状態をまとめて読み、共通の判定で決める。どちらかのマージを記録したか一時停止したなら、PR を作らない。工程の PR の公開のどこで失敗しても（取得・push・PR の作成・更新）、共通の失敗の処理で両方を読み直して同じ判定を使う（どちらもマージ済みでなければいまの `pr.failed`） |
| 同上 `checkPullRequests` の片付け | 実装の PR がマージ済みで、開いた工程の PR が記録に残るタスク（完了したタスクを含む）を毎回見る。GitHub で閉じてから（すでに閉じていればそのまま）`PullRequestClosed` を記録する。GitHub で main へマージされていれば、閉じずに `merged: true` 付きで記録する。閉じるのに失敗したら記録せず、次の確認（再起動の後を含む）で閉じ直す（Q-1） |
| 同上 記録の後 | PR に、マージを承認にしたことを知らせる（既存の知らせ） |
| 同上 `cleanupPlan`・中止の片付け、`apps/daemon/src/task-mcp.ts` `cancelTargets` | 実装の PR は、記録が `open` のものだけを閉じる対象にする。片付けは、閉じる直前に GitHub で開いているかを確かめる |
| `packages/core/src/messages.ts` ほか文言の辞書 | 両方がマージ済みの一時停止の文言（日英） |
| テスト | 再現は `apps/daemon/src/daemon-implement.test.ts`。投影は `packages/core` の投影のテスト、MCP は `packages/cli/src/mcp-cancel.test.ts`。偽物の `fetchBranch` に、ブランチごとの `couldn't find remote ref` を足す |
| 文書 | `docs/spec/approval.md`（「PR の確認」「実装の作り直しの間のマージ」の対象・互換性・既知の制約）・`docs/spec/mcp-server.md` の閉じる PR・`docs/spec/tasks-and-steps.md` の中止の片付け（閉じる実装の PR）・`docs/user/tasks.md`（「直してからマージしたとき・作り直しの間にマージしたとき」の「要求要件・設計をやり直している間は…止めません」）、と各 `.en.md`。ADR（`docs/adr/`）、作業履歴 `docs/worklog/YYYYMMDD-pbi-494-<スラッグ>.md` |

## 止まっているタスクの扱い

台帳は変えない。
修正の版の起動で投影を作り直すと、実装の `PullRequestPublished` と工程の PR の `PullRequestMerged` が `implementBasis` を残し直すので、次の PR の確認（一時停止のままでも）か再開の後の `publishStepPullRequest` が、マージを見つけて進める。







---

工程の PR を公開するときにも、PR の確認と同じ判定で両方の PR を確かめるように設計を直しました。公開は、タスクブランチを取りに行く前と、途中で失敗した後の両方で行います。テスト観点は、この2つの場合を足して 22 件です。

- **文書の検証：** `npx vitest run tests/docs` は、5 秒の既定の時間切れで、リンクの検査の1件が落ちました。この1件は、設計の下書きを置かないときも同じ時間切れで落ちています。時間切れを 60 秒にして流すと、下書きを置いて 99 件すべて通りました。時間切れの短さはこのコンテナの遅さによるもので、下書きの中身とは関係ないと見ています。CI の結果は、PR で確かめてください。
- **確かめてほしいこと（Q-5）：** 両方の PR がマージ済みで止まったタスクを再開したときの扱いです。推奨は、実装の PR だけを承認にし、工程の PR は承認にせず merged と記録することです。止めたままにすると、再開するたびに同じ一時停止を繰り返します。ただし、工程の PR が実際には実装に入っていた場合、記録の承認済みの設計が実装より古いまま完了します。

## テスト観点

- [TV-1] 前の工程へ戻した後のマージで、タスクが一時停止せずに実装の承認へ進む（再現）
  - 入力：実装の PR が open のタスクで、PR の指摘の戻し先を設計にして差し戻し（ChangesRequested）、設計のやり直しが終わって工程の PR の作成を待つ（idle）。偽の GitHub は実装の PR を merged と返し、タスクブランチの fetchBranch は couldn't find remote ref で失敗する
  - 期待結果：PR の確認の後、作業履歴に ReworkStoppedByMerge（step なし）・PullRequestMerged・StepApproved（implement）がこの順に1回だけ記録され、TaskPaused（error）は無く、タスクはマージの後の監視か完了に進み、修正を戻すと TaskPaused（error・pr.failed）になってテストが落ちる
- [TV-2] 要求要件の変更の申し出で戻った後のマージでも、一時停止せずに進む（再現）
  - 入力：実装の PR が open のタスクで、実装の工程の要求要件への変更の申し出を認めて（ChangeApplied。reopen で要求要件が実行対象）、要求要件のやり直しが終わって工程の PR の作成を待つ（idle）。偽の GitHub は実装の PR を merged と返し、タスクブランチの fetchBranch は couldn't find remote ref で失敗する
  - 期待結果：PR の確認の後、上と同じ 3 つの記録が1回だけ記録されて TaskPaused（error）は無く、修正を戻すと TaskPaused（error・pr.failed）になってテストが落ちる
- [TV-3] PR の確認より先に工程の PR の作成が始まっても、タスクブランチを取りに行かずに進む
  - 入力：上と同じタスクで、PR の確認を呼ばずに実行（runNext）だけを進める
  - 期待結果：publishStepPullRequest がタスクブランチの fetchBranch を呼ばず、PR も作らず、上と同じ 3 つの記録でタスクが進む
- [TV-4] 状態を読んだ直後にマージされてブランチが消えても、一時停止せずに進む
  - 入力：上と同じタスクで、偽の GitHub が実装の PR を、publishStepPullRequest の最初の読み取りでは open、2 回目からは merged と返し、タスクブランチの fetchBranch は couldn't find remote ref で失敗する
  - 期待結果：状態が読み直され、TaskPaused（error）も pr.failed も記録されず、上と同じ 3 つの記録でタスクが進む
- [TV-5] ブランチの取得の後、工程の PR の作成の前にマージされても、一時停止せずに進む
  - 入力：上と同じタスクで、偽の GitHub が実装の PR を最初の読み取りでは open、2 回目からは merged と返し、fetchBranch は成功し、工程の PR の作成（pulls.create）は base が無いエラーで失敗する
  - 期待結果：共通の失敗の処理で状態が読み直され、TaskPaused（error）も pr.failed も記録されず、上と同じ 3 つの記録でタスクが進む
- [TV-6] やり直しの実行中にマージされたら、実行を止めてから記録する
  - 入力：設計へ戻した後の設計の実行が実行中（running）のときに、実装の PR が merged になる
  - 期待結果：コンテナが止められ、止めた実行が ReworkStoppedByMerge の stoppedRuns に入り、人の一時停止（TaskPaused）は記録されずに上と同じく進む
- [TV-7] 実装の PR が開いたままなら、やり直しは続く
  - 入力：設計へ戻した後、偽の GitHub が実装の PR を open と返す
  - 期待結果：ReworkStoppedByMerge は記録されず、設計の工程の PR が作られて設計の承認待ちになる
- [TV-8] 工程の PR と実装の PR が同じ確認でどちらもマージ済みなら一時停止し、再開で実装の PR だけを承認にする
  - 入力：設計へ戻して設計の PR（タスクブランチ向き）を直している間に、偽の GitHub が設計の PR と実装の PR をどちらも merged と返し（merged_at は同じ秒）、その後にタスクを再開する
  - 期待結果：1 回目の確認で ReworkStoppedByMerge・PullRequestMerged・StepApproved はどちらの PR にも記録されず、TaskPaused（error）が両 PR の番号を含む文言と mergedPullRequests で1回だけ記録され、再開の後の確認で実装の PR の 3 つの記録だけが記録されて設計の StepApproved は無く、設計の PR は PullRequestClosed（merged: true）で state が merged になる
- [TV-9] 工程の PR の公開の入口で両方がマージ済みなら、PR の確認と同じく一時停止する
  - 入力：設計へ戻して直した設計の PR（タスクブランチ向き）の更新を待つ（idle）タスクで、PR の確認を呼ばずに実行（runNext）だけを進め、偽の GitHub が設計の PR と実装の PR をどちらも merged と返す
  - 期待結果：publishStepPullRequest が fetchBranch も pulls.create も呼ばず、ReworkStoppedByMerge・PullRequestMerged・StepApproved はどちらの PR にも記録されず、PR の確認のときと同じ文言と mergedPullRequests の TaskPaused（error）が1回だけ記録される
- [TV-10] 工程の PR の公開の途中の失敗の後に両方がマージ済みと分かっても、一時停止する
  - 入力：上と同じタスクで、偽の GitHub が両 PR を最初の読み取りでは open、2 回目からは merged と返し、タスクブランチの fetchBranch は couldn't find remote ref で失敗する
  - 期待結果：pr.failed は記録されず、実装の承認も設計の承認も記録されず、上と同じ TaskPaused（error・mergedPullRequests）が1回だけ記録される
- [TV-11] 実装の PR のマージで main へ付け替わった工程の PR が後でマージされても、承認にせず merged と記録する
  - 入力：設計へ戻して設計の PR（D2）を直している間に、偽の GitHub が実装の PR（基準は D1）だけを merged と返して実装の承認が記録された後、片付けの前の確認で設計の PR を base.ref が main の merged と返す
  - 期待結果：設計の PR の StepApproved（design）は記録されず、approved.design と outputs.design が D1 のままで、pulls.close は呼ばれずに PullRequestClosed（merged: true）が1回記録され、設計の PR の state が merged・superseded になる
- [TV-12] マージの後の投影で、工程と承認が実装の PR を作った時点に戻る
  - 入力：承認済みの設計 A で実装の PR を作り、設計へ差し戻して設計の出力を B にやり直した後、上の 3 つの記録を投影する
  - 期待結果：要求要件・設計・実装の工程が done、approved.design.output と outputs.design が A、テスト観点が A のもので、設計へ戻した指摘は無効（voided）、記録の pullRequestState は merged になる
- [TV-13] マージされたコミットが基準のコミットと違っても、一時停止せずに基準の承認で進む
  - 入力：設計 D1 で実装の PR を作り（commit C1）、設計へ戻してやり直している間に、偽の GitHub が実装の PR を、先頭が C1 と違うコミット（人が積んだもの）で merged と返す
  - 期待結果：TaskPaused は記録されず、上と同じ 3 つの記録で進み、PullRequestMerged の edited が true で、approved.design と outputs.design が D1 になる
- [TV-14] 引き継いだ PR が、実装の PR を出す前の前の工程でマージされても進む
  - 入力：continuedPullRequest があり pullRequest が無いタスクで、設計の承認で実装へ進んだ後に要求要件へ戻し、要求要件をやり直している間に、偽の GitHub が引き継いだ PR を merged と返す
  - 期待結果：上と同じ 3 つの記録でタスクが進み、pullRequest が引き継いだ PR の番号で記録されて pullRequestState が merged、承認と成果は実装へ進んだ時点のものになる
- [TV-15] 引き継いだ PR が、実装の PR を出す前の前の工程で閉じられたら、記録の無い状態から closed に合わせる
  - 入力：continuedPullRequest があり pullRequest も pullRequestState も無いタスクで、要求要件へ戻してやり直している間に、偽の GitHub が引き継いだ PR を closed と返し、次の確認では open と返す
  - 期待結果：1 回目の確認で引き継いだ PR の番号の PullRequestClosed が記録されて pullRequestState が closed になり、cleanupPlan と get_cancel_plan の閉じる対象に引き継いだ PR が出ず、2 回目の確認で PullRequestReopened が記録されて open に戻る
- [TV-16] やり直しの間に作った工程の PR を、GitHub で閉じてから記録し、失敗したら閉じ直す
  - 入力：設計へ戻した後に作った設計の PR（タスクブランチ向き）が開いて設計の承認待ちのときに実装の PR が merged になり、偽の GitHub の pulls.close が 1 回目は失敗し、2 回目は成功する（2 回目の前にデーモンを起動し直す）
  - 期待結果：タスクは 1 回目の確認で実装の承認へ進み、1 回目は設計の PR が記録で open のまま残って PullRequestClosed は無く、起動し直した後の確認で pulls.close が呼ばれ、成功の後に PullRequestClosed が1回記録されて設計の PR が closed・superseded になる
- [TV-17] 前の工程へ戻している間に閉じた・開き直した実装の PR の状態を記録に合わせる
  - 入力：設計へ戻して設計をやり直している間に、偽の GitHub が実装の PR を closed と返し、次の PR の確認では open と返す
  - 期待結果：1 回目の確認で PullRequestClosed が記録されて pullRequestState が closed になり、cleanupPlan と get_cancel_plan の閉じる対象に実装の PR が出ず、2 回目の確認で PullRequestReopened が記録されて open に戻り、どちらでも設計の工程と状態は変わらない
- [TV-18] すでにこの状態で一時停止したタスクが、修正の版で進む
  - 入力：作業履歴に、設計へ戻した後の TaskPaused（error、文言は pr.failed の couldn't find remote ref）までがあるタスクを読み込んでデーモンを起動し、偽の GitHub は実装の PR を merged と返す
  - 期待結果：PR の確認、または resume の後の実行で、上と同じ 3 つの記録が記録され、タスクはマージの後の監視か完了に進み、記録の pullRequestState は merged になる
- [TV-19] 取り消しの確認は、記録が open でない実装の PR を閉じる対象に挙げない
  - 入力：pullRequestState が merged・merged_outdated・closed の実装の PR を持つタスクで、cleanupPlan と get_cancel_plan（cancelTargets）を読む
  - 期待結果：どちらも実装の PR を閉じる対象（pull_request の detail・willClose.pullRequests）に含めず、get_cancel_plan は untouched.pullRequests に理由つきで出す
- [TV-20] 中止の片付けは、GitHub で開いていない実装の PR を閉じない
  - 入力：記録の pullRequestState が open で、偽の GitHub が merged と返す実装の PR を持つタスクを中止する
  - 期待結果：pulls.close は実装の PR に対して呼ばれず、片付けの結果に失敗が出ない
- [TV-21] 作業履歴に原因が書いてある
  - 入力：docs/worklog/YYYYMMDD-pbi-494-<スラッグ>.md
  - 期待結果：PR #590 で設計へ戻した後（21:53:27Z）にマージ（21:53:59Z）され、実行対象が設計のため実装の PR を見守らず、工程の PR の作成がタスクブランチの取得で失敗して一時停止した経緯が書いてある
- [TV-22] 仕様書・利用者の文書と ADR に新しい扱いが書いてある
  - 入力：docs/spec/approval.md・approval.en.md・mcp-server.md・mcp-server.en.md・tasks-and-steps.md・tasks-and-steps.en.md・docs/user/tasks.md・tasks.en.md と追加の ADR
  - 期待結果：approval の日英に、前の工程へ戻している間も実装の PR（引き継いだ PR を含む）を見守りマージで実装の承認として進めること・工程の PR の作成の前と公開の失敗の後に工程の PR と実装の PR をまとめて確かめ、PR の確認と同じ判定を使うこと・承認を sacty がタスクブランチの先頭を最後に変えた時点に戻し、マージされたコミットが違えば edited にすること・同じ確認で工程の PR と実装の PR がどちらもマージ済みなら（PR の確認でも工程の PR の公開でも）一時停止し、再開すると実装の PR だけを承認にすることを既知の制約（まれな競合）として・やり直しの間の工程の PR を閉じられるまで閉じ直し、main へマージされていれば承認にせず merged と記録すること・閉じた・開き直した状態を（引き継いだ PR は記録の無い状態からも）記録すること・記録した後は版を戻せないことが、mcp-server と tasks-and-steps の中止の片付けの日英に、記録が open の実装の PR だけを閉じる対象にすることが、tasks の日英に、要求要件・設計をやり直している間に実装の PR がマージされたらやり直しを止めて承認として進めることが書いてあり、ADR が PBI-276 の決めを変える理由を述べている
