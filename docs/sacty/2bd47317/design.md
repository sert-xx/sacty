<!-- sacty task 2bd47317-1b68-4023-91b2-f216e5d1e1e9 の設計。sacty が作成しました。 -->

# 設計：実装の PR のマージで作り直しを止めたときの表示を、実際の状態と合わせる

## スコープ

両方マージの一時停止の説明、作り直しを止めた行の状態、複数の工程の PR の番号の順を、実際の状態に合わせる。
承認にしなかったマージの知らせが失敗し続けるときは、やり直しの間を伸ばす。

- 対象
  - 再開の画面：両方マージの一時停止で、理由 error の決まった説明を出さない
  - `ReworkStoppedByMerge`：止めたときの工程と状態を、省略できる新しい欄 `state` に記録し、画面の行はそれを言う
  - 両方マージの一時停止：最初に一時停止した時点の工程と状態を、`TaskPaused` の省略できる新しい欄 `reworkState` に残し、同じ停止の追加の一時停止・デーモンの起動し直し・再開を通じて保ち、再開の後の `ReworkStoppedByMerge` の `state` に写す
  - 記録済みの行（`state` 無し）：`was: queued` のときは状態を言わない。`step` が無いときは、止めた対象を工程に依存しない語で言う
  - `pr.multipleMerged` の工程の PR の番号を昇順にする（投影で並べるので、記録済みのタスクにも効く）
  - `postMergeNotice`：失敗したら、同じ知らせのやり直しを 1 分から倍にして最大 1 時間まで待つ
  - 仕様書 `docs/spec/approval.md`・`approval.en.md`、作業履歴、テスト
- 対象外
  - 両方マージのときの止め方・進め方、`TaskPaused` の理由（依頼の範囲の外）
  - `was` の値の追加（前の版のデーモンが作業履歴を読めなくなるため、欄を足す）
  - 一時停止の見出し「エラーで一時停止」の文言

## 確認したいこと

- must：なし
- should
  - Q-2：受け入れ条件 4 の「記録に残す」を、デーモンのログ（次に試す時刻を添えた警告）と作業履歴への記述と読んでよいか。推奨：そう読む。タスクの作業履歴（台帳）にイベントを足すと、前の版のデーモンが起動できなくなるため。
    懸念：画面の作業履歴に失敗の行が欲しかった場合、利用者は知らせの失敗を画面で知れず、実装の作り直しが要る。
- 確認しないと決めたこと
  - 受け入れ条件 1 の直し方：画面で `mergedPullRequests` と理由 error がそろうときだけ `pauseHelp.error` を出さない。記録の形を変えず、範囲の外（止め方）に触れないため。
  - `state` を足すか：足す。zod の object は知らない欄を捨てるので、前の版のデーモンも読める。`was` の値を増やすと読めなくなる。
  - 記録済みの `was: queued` の表示：状態を言わない。実行待ちと承認待ち・PR の作成待ちを見分けられないため（依頼の「言えないときは状態を言わない」）。
  - 記録済みで `step` の無い行の主語：工程に依存しない「直し」にする。記録からは、実装の作り直しか、前の工程へ戻していた回かを見分けられないため。
  - やり直されていた知らせ：承認にしなかったマージの知らせ（`checkSentBackMerges` が確認のたびに呼ぶ）。承認にした知らせは記録のときに1回だけ呼ぶ。間を伸ばす方式は `noteRemarkReplyLimited` の前例に合わせる。
  - 両方マージから再開した後の行の状態：両方マージで最初に一時停止した時点（実行を止める前）の状態を言う。再開の後の状態（`idle` など）や、追加の一時停止の時点の `paused` は、止めたときの状態ではないため。最初の状態が無ければ、後の値で代えずに状態を言わない。

## 既定で決めたこと

- 間を置く状態はデーモンのメモリーに持ち、デーモンを起動し直すと消す（`remarkReplyRetryAt` と同じ）。
- 新しい状態の語：承認待ち（awaiting approval）・エスカレーション中（escalated）。そのほかは `reworkStage` の語を使う。
- 前の工程へ戻していた回の行の主語は「{工程}のやり直し」（英 "the redo of the {step}"）にする。工程の PR の直しは「{工程}の直し」のまま。
- 記録済みで `step` の無い行の主語は「直し」（英 "the rework"）にする。

## データ

`ReworkStoppedByMerge` に、省略できる欄を足す。新しいデーモンは毎回記録する。

| 欄 | 値 | 意味 |
| --- | --- | --- |
| `state.step` | `requirements`・`design`・`implement` など（`StepKey`） | 止めたときに動いていた工程（戻していた回は `activeStep`） |
| `state.status` | `queued`・`running`・`verifying`・`publishing`・`awaiting_approval`・`escalated`・`paused`（省略できる） | 止めたときの状態。復元できないときは省く |

- `state.status` の決め方：paused → `paused`、実行中か実行を止めた → `running`、awaiting_approval → `awaiting_approval`、escalated → `escalated`、`publishPending` か工程の PR の作成待ち → `publishing`、実装で `verification` あり → `verifying`、ほかは `queued`。
- 両方マージの一時停止の `TaskPaused` に、省略できる欄 `reworkState`（`state` と同じ形）を足す。
  - 同じ停止：タスクの `mergedPullRequests` に、その実装の PR がすでにある（再開しても消えない）。
  - デーモンは、同じ停止の最初の `TaskPaused` だけに、一時停止の前（実行を止める前）の状態を上の決め方で記録する。同じ確認で複数の工程の PR を記録するときの2件目以降、一時停止中の時間差の追加、再開の後の追加には記録しない。
  - 投影：同じ停止の最初でない `TaskPaused` は、`reworkState` があっても今の値を変えない（最初に無ければ無いまま）。再開でも消さず、`ReworkStoppedByMerge` で消す。台帳から投影し直すので、デーモンを起動し直しても保たれる。
- 再開の後の `ReworkStoppedByMerge`（タスクの `mergedPullRequests` に実装の PR がある）は、残した `reworkState` を `state` に写す。`reworkState` が無い（前の版が最初の一時停止を記録した）なら、`state.step` だけを記録し、`state.status` を省く。
- `was` は今の `reworkStage` のまま記録する（前の版の投影のため）。
- 前の版のデーモンは `state`・`reworkState` を読まずに捨てる。前の版が追加の一時停止を記録しても、欄が無いので最初の値は変わらない。仕様書と events.ts の注釈に書く。

## 処理の流れ

- 画面の行（`apps/web/src/lib/labels.ts`）：`state` があれば、主語と状態を `state` から作る（`state.status` が無ければ状態を言わない）。`state` が無ければ次のとおり。
  - 主語：`step` があれば「{工程}の直し」、無ければ「直し」（英 "the rework"）。「実装の作り直し」とは言わない
  - 状態：`was` が `queued` のときは言わず（「…を止めた」）、ほかは今の語を使う
- 投影（`projection.ts` の `TaskPaused`）：`pr.multipleMerged` の `steps` を番号の昇順にする。
- `postMergeNotice`：種類・タスク・PR ごとに次に試す時刻を持つ。失敗したら 1 分・2 分・4 分…最大 1 時間を置き、警告に次に試す時刻を書く。投稿できた・目印の投稿が見つかったら消す。

## 検証の計画

- マージの前に、`scripts/docs-screenshots` の偽の GitHub で sacty up の画面を日英で開き、両方マージの一時停止と、作り直しを止めた行を確かめ、動画を PR に残す（実装の担当）。

## テスト観点

- [TV-1] 両方マージの一時停止で、再開の説明が1つだけ出る（日英）
  - 入力：status paused・pausedReason error・mergedPullRequests [12, 9]・pausedMessage pr.bothMerged のタスクを、TaskDetailView（live-screens.test.ts の jsdom）で日英それぞれ描く
  - 期待結果：再開の画面に pr.bothMerged の文（日「再開すると実装の PR だけを承認します」、英 "Resuming approves only the implementation PR"）が1回だけ出て、pauseHelp.error の文（日「止まった工程を実行し直します」、英 "resume to rerun the stopped step"）が出ない。
- [TV-2] 両方マージでないエラーの一時停止では、決まった説明が残る
  - 入力：status paused・pausedReason error・mergedPullRequests 無しのタスクを、同じ TaskDetailView で描く
  - 期待結果：再開の画面に pauseHelp.error の文が出る。
- [TV-3] 設計へ戻して承認待ちの間に実装の PR がマージされると、工程と状態を記録する
  - 入力：設計へ戻し、設計の PR が承認待ち（status awaiting_approval）のタスクで、偽の GitHub が実装の PR をマージ済みと返し、PR の確認を1回流す（daemon-step-pull-requests.test.ts）
  - 期待結果：ReworkStoppedByMerge が step 無し・was queued・state { step: design, status: awaiting_approval } で記録される。
- [TV-4] 設計へ戻して実行中・一時停止中に実装の PR がマージされると、その状態を記録する
  - 入力：設計へ戻し、設計の実行中（status running）のタスクと、一時停止中（status paused）のタスクのそれぞれで、実装の PR をマージ済みにして PR の確認を流す
  - 期待結果：state が、実行中のタスクでは { step: design, status: running }、一時停止中のタスクでは { step: design, status: paused } で記録される。
- [TV-5] 両方マージで一時停止して再開した後の記録が、一時停止した時点の状態を言う
  - 入力：設計へ戻して設計の実行中（status running）のタスクと、手動で一時停止中（status paused）のタスクのそれぞれで、偽の GitHub が設計の PR と実装の PR をどちらもマージ済みと返し、PR の確認で両方マージの一時停止にしてから再開し、PR の確認をもう1回流す（daemon-step-pull-requests.test.ts）
  - 期待結果：両方マージの TaskPaused の reworkState と、再開の後の ReworkStoppedByMerge の state が、実行中のタスクでは { step: design, status: running }、一時停止中のタスクでは { step: design, status: paused } になる。
- [TV-6] 同じ確認で複数の工程の PR がマージ済みでも、最初の停止の前の状態を言う
  - 入力：設計へ戻して設計の実行中（status running）のタスクで、偽の GitHub が要求要件の PR・設計の PR・実装の PR をすべてマージ済みと返し、PR の確認で一時停止させてから再開し、PR の確認をもう1回流す（daemon-step-pull-requests.test.ts）
  - 期待結果：同じ確認で記録された TaskPaused のうち最初の1件だけが reworkState { step: design, status: running } を持ち、2件目は reworkState を持たず、再開の後の ReworkStoppedByMerge の state が { step: design, status: running } になる。
- [TV-7] 一時停止中の時間差の追加とデーモンの起動し直しの後も、最初の停止の前の状態を言う
  - 入力：設計へ戻して設計の実行中のタスクで、設計の PR と実装の PR のマージで両方マージの一時停止にした後、一時停止中に要求要件の PR もマージ済みにして PR の確認を流し、デーモンを同じ台帳で起動し直してから再開し、PR の確認を流す（daemon-step-pull-requests.test.ts）
  - 期待結果：時間差の追加の TaskPaused は reworkState を持たず、起動し直した後の Task の reworkState が { step: design, status: running } のままで、再開の後の ReworkStoppedByMerge の state が { step: design, status: running } になり status paused にならない。
- [TV-8] 同じ停止の最初でない TaskPaused は、投影の reworkState を変えない
  - 入力：projection.test.ts で、mergedPullRequests [12, 9]・reworkState { step: design, status: running } の TaskPaused、[13, 9]・reworkState { step: design, status: paused } の TaskPaused、TaskResumed の順に投影するものと、最初の TaskPaused が reworkState 無しで、2件目が reworkState { step: design, status: paused } のものを投影する
  - 期待結果：前者の Task の reworkState は { step: design, status: running } のままで、後者の Task は reworkState を持たない。
- [TV-9] reworkState の無い両方マージの一時停止から再開すると、状態を記録しない
  - 入力：reworkState 無しの両方マージの TaskPaused（mergedPullRequests [12, 9]）で一時停止した、設計へ戻していたタスクを再開し、実装の PR をマージ済みにして PR の確認を流す
  - 期待結果：ReworkStoppedByMerge が state { step: design } で記録され、state.status を持たない。
- [TV-10] state のある行は、工程と状態を言う（日英）
  - 入力：payload が number 9・was queued・state { step: design, status: awaiting_approval }・stoppedRuns 空の ReworkStoppedByMerge と、state { step: design }（status 無し）のものを、作業履歴の行の部品 EventText（task-detail.tsx）で日英それぞれ描く
  - 期待結果：前者は日「設計のやり直しを承認待ちで止めた」、英 "the redo of the design was stopped while it was awaiting approval" を含み、後者は日「設計のやり直しを止めた」、英 "the redo of the design was stopped" で状態の語を含まず、どちらも「実行待ち」「queued」を含まない。
- [TV-11] 記録済みの state・step の無い行は、工程に依存しない主語で言い、was が queued のときだけ状態を言わない
  - 入力：state 無し・step 無しで、was が queued の ReworkStoppedByMerge と、was が running のものを、EventText で日英それぞれ描く
  - 期待結果：queued の行は「PR #9 がマージされたため、直しを止めた」（英 "the rework was stopped"）で、running の行は「直しを実行中で止め」（英 "the rework was stopped while it was running"）を含み、どちらも「実装の作り直し」「the rework of the implementation」「実行待ち」「queued」を含まない。
- [TV-12] 複数の工程の PR の番号が昇順で出る（日英）
  - 入力：paused のタスクに、mergedPullRequests [335, 9] の TaskPaused、続けて [334, 9] の TaskPaused を投影し、その Task を TaskDetailView で日英それぞれ描く
  - 期待結果：再開の画面の説明が「#334, #335」の順で、「#335, #334」を含まない。
- [TV-13] 承認にしなかったマージの知らせが失敗し続けると、やり直しの間が伸びる
  - 入力：要求要件へ戻している間に設計の PR がマージ済みで、偽の GitHub の commentIssue が毎回失敗するタスクで、時計を1分ずつ進めて PR の確認を 8 回流す
  - 期待結果：commentIssue は 0・1・3・7 分目の 4 回だけ呼ばれ、失敗ごとの警告に次に試す時刻が出る。
- [TV-14] 仕様書（日英）が新しい振る舞いを書いている
  - 入力：docs/spec/approval.md と approval.en.md の「実装の作り直しの間のマージ」と知らせの節の差分
  - 期待結果：state の欄と値・両方マージの TaskPaused の reworkState を同じ停止の最初の TaskPaused だけに記録し追加の一時停止・起動し直し・再開を通じて最初の値を保つこと・再開の後の state への写し方（無ければ state.status を省く）・前の版が欄を捨てること・state の無い記録は was queued のとき状態を言わず step が無いとき主語を「直し」にすること・両方マージで決まった説明を出さないこと・工程の PR の番号を昇順に出すこと・知らせのやり直しを 1 分から倍にして最大 1 時間置くことが、日英で同じ意味で書かれている。
