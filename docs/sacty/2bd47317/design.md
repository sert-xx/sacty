<!-- sacty task 2bd47317-1b68-4023-91b2-f216e5d1e1e9 の設計。sacty が作成しました。 -->

# 設計：実装の PR のマージで作り直しを止めたときの表示を、実際の状態と合わせる

## スコープ

両方マージの一時停止の説明、作り直しを止めた行の状態、複数の工程の PR の番号の順を、実際の状態に合わせる。
承認にしなかったマージの知らせが失敗し続けるときは、やり直しの間を伸ばす。

- 対象
  - 再開の画面：両方マージの一時停止で、理由 error の決まった説明を出さない
  - `ReworkStoppedByMerge`：止めたときの工程と状態を、省略できる新しい欄 `state` に記録し、画面の行はそれを言う
  - 記録済みの行（`state` 無し）：`was: queued` のときは状態を言わない
  - `pr.multipleMerged` の工程の PR の番号を昇順にする（投影で並べるので、記録済みのタスクにも効く）
  - `postMergeNotice`：失敗したら、同じ知らせのやり直しを 1 分から倍にして最大 1 時間まで待つ
  - 仕様書 `docs/spec/approval.md`・`approval.en.md`、作業履歴、テスト
- 対象外
  - 両方マージのときの止め方・進め方、`TaskPaused` の理由・形（依頼の範囲の外）
  - `was` の値の追加（前の版のデーモンが作業履歴を読めなくなるため、欄を足す）
  - 一時停止の見出し「エラーで一時停止」の文言

## 確認したいこと

- must：なし
- should
  - Q-1：記録済みで step の無い行の主語は、前の工程へ戻していた回でも「実装の作り直し」のままでよいか。推奨：そのままにする。記録からは戻していた回かを見分けられず、状態の語だけを外せば「言えないことは言わない」を満たすため。
    懸念：PBI-494 のマージの後に記録された、戻していた回の古い行を見た人は、設計のやり直しを止めたことを、行から読み取れない。
  - Q-2：受け入れ条件 4 の「記録に残す」を、デーモンのログ（次に試す時刻を添えた警告）と作業履歴への記述と読んでよいか。推奨：そう読む。タスクの作業履歴（台帳）にイベントを足すと、前の版のデーモンが起動できなくなるため。
    懸念：画面の作業履歴に失敗の行が欲しかった場合、利用者は知らせの失敗を画面で知れず、実装の作り直しが要る。
- 確認しないと決めたこと
  - 受け入れ条件 1 の直し方：画面で `mergedPullRequests` と理由 error がそろうときだけ `pauseHelp.error` を出さない。記録の形を変えず、範囲の外（止め方）に触れないため。
  - `state` を足すか：足す。zod の object は知らない欄を捨てるので、前の版のデーモンも読める。`was` の値を増やすと読めなくなる。
  - 記録済みの `was: queued` の表示：状態を言わない。実行待ちと承認待ち・PR の作成待ちを見分けられないため（依頼の「言えないときは状態を言わない」）。
  - やり直されていた知らせ：承認にしなかったマージの知らせ（`checkSentBackMerges` が確認のたびに呼ぶ）。承認にした知らせは記録のときに1回だけ呼ぶ。間を伸ばす方式は `noteRemarkReplyLimited` の前例に合わせる。

## 既定で決めたこと

- 間を置く状態はデーモンのメモリーに持ち、デーモンを起動し直すと消す（`remarkReplyRetryAt` と同じ）。
- 新しい状態の語：承認待ち（awaiting approval）・エスカレーション中（escalated）。そのほかは `reworkStage` の語を使う。
- 前の工程へ戻していた回の行の主語は「{工程}のやり直し」（英 "the redo of the {step}"）にする。工程の PR の直しは「{工程}の直し」のまま。

## データ

`ReworkStoppedByMerge` に、省略できる欄を足す。新しいデーモンは毎回記録する。

| 欄 | 値 | 意味 |
| --- | --- | --- |
| `state.step` | `requirements`・`design`・`implement` など（`StepKey`） | 止めたときに動いていた工程（戻していた回は `activeStep`） |
| `state.status` | `queued`・`running`・`verifying`・`publishing`・`awaiting_approval`・`escalated`・`paused` | 止めたときの状態 |

- `state.status` の決め方：paused → `paused`、実行中か実行を止めた → `running`、awaiting_approval → `awaiting_approval`、escalated → `escalated`、`publishPending` か工程の PR の作成待ち → `publishing`、実装で `verification` あり → `verifying`、ほかは `queued`。
- `was` は今の `reworkStage` のまま記録する（前の版の投影のため）。
- 前の版のデーモンは `state` を読まずに捨てる。仕様書と events.ts の注釈に書く。

## 処理の流れ

- 画面の行（`apps/web/src/lib/labels.ts`）：`state` があれば、主語と状態を `state` から作る。無ければ、`was` が `queued` のときは状態を言わず（「…を止めた」）、ほかは今の語を使う。
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
- [TV-5] state のある行は、工程と状態を言う（日英）
  - 入力：payload が number 9・was queued・state { step: design, status: awaiting_approval }・stoppedRuns 空の ReworkStoppedByMerge を、作業履歴の行の部品 EventText（task-detail.tsx）で日英それぞれ描く
  - 期待結果：日は「設計のやり直しを承認待ちで止めた」、英は "the redo of the design was stopped while it was awaiting approval" を含み、「実行待ち」「queued」を含まない。
- [TV-6] 記録済みの state の無い行は、was が queued のときだけ状態を言わない
  - 入力：state 無し・step 無しで、was が queued の ReworkStoppedByMerge と、was が running のものを、EventText で日英それぞれ描く
  - 期待結果：queued の行は「実装の作り直しを止めた」（英 "the rework of the implementation was stopped"）で「実行待ち」「queued」を含まず、running の行は「実行中で止め」（英 "while it was running"）を含む。
- [TV-7] 複数の工程の PR の番号が昇順で出る（日英）
  - 入力：paused のタスクに、mergedPullRequests [335, 9] の TaskPaused、続けて [334, 9] の TaskPaused を投影し、その Task を TaskDetailView で日英それぞれ描く
  - 期待結果：再開の画面の説明が「#334, #335」の順で、「#335, #334」を含まない。
- [TV-8] 承認にしなかったマージの知らせが失敗し続けると、やり直しの間が伸びる
  - 入力：要求要件へ戻している間に設計の PR がマージ済みで、偽の GitHub の commentIssue が毎回失敗するタスクで、時計を1分ずつ進めて PR の確認を 8 回流す
  - 期待結果：commentIssue は 0・1・3・7 分目の 4 回だけ呼ばれ、失敗ごとの警告に次に試す時刻が出る。
- [TV-9] 仕様書（日英）が新しい振る舞いを書いている
  - 入力：docs/spec/approval.md と approval.en.md の「実装の作り直しの間のマージ」と知らせの節の差分
  - 期待結果：state の欄と値・前の版が欄を捨てること・state の無い記録の was queued は状態を言わないこと・両方マージで決まった説明を出さないこと・工程の PR の番号を昇順に出すこと・知らせのやり直しを 1 分から倍にして最大 1 時間置くことが、日英で同じ意味で書かれている。
