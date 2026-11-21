<!-- sacty task da296049-4510-4bc2-9769-e336e4bf4592 の設計。sacty が作成しました。 -->

# 設計：再レビューの途中で PR の先頭が変わったときの打ち切りと回の数え方

## スコープ

レビュー（1回目を含む）の実行中に PR の先頭が変わったら、実行を止めて古い先頭宛てを投稿せず、先頭が落ち着いてから新しい先頭で1回だけ始め直す。打ち切った回と親に届かなかった回は数えず、間に合わずに投稿された回の指摘は、次の回に新しい先頭で確かめさせる。

- 対象
  - レビュー（1回目を含む）の、実行中と投稿の直前の先頭の変化の検知・打ち切り・始め直しの待ち（`apps/daemon/src/service.ts`）。子タスク（`reviewOf`）と、取り込み・人が作ったレビューのタスクの両方
  - マージ・クローズで止めたレビューの記録（`AgentRunFailed`・`TaskPaused` を出さない）
  - 打ち切りを記録する新しいイベント（`packages/core` の events・projection、作業履歴の画面の表示名）
  - 親に届かなかった回の扱い（`apps/daemon/src/prompts.ts` の `rereviewLines`、`suggestion-triage.ts` の `countSuggestionRounds`、スキル review-dispatch の `references/aggregation.md`）
  - 仕様書・ユーザー文書（日英）、ADR、作業履歴、テスト
- 対象外
  - フォークからの PR（PBI-461 で、自動では再レビューしないと決めた。今の振る舞いのまま）
  - 親が古い先頭宛ての指摘を直しに取り込むこと（`PullRequestReviewDiscarded` と画面の `DiscardedReviewNotice` は残す）

## 確認したいこと

### must

なし

### should

なし

### 確認しないと決めたこと

- 検知の経路：60秒ごとの `checkReviewPullRequests` で読む。`reconcileReviewTaskSoon` は実行中の子を動かさない（`canRereview` が偽）ので使えず、受け入れ条件は経路を問わないため。
- 待つ時間と印：見守りと同じ `FEEDBACK_QUIET_MS`（2分）、印はメモリーに持ち、起動の後は待ち直す。見守り（PBI-411）の決まりに揃うため。
- 開いている PR #523（レビューの本文から過程の情報を外し、回ごとの記録 `reviewRecords` を足す）・#524（直しの最中のマージを承認にする）との衝突：main を起点に作る。打ち切った回の記録の消し方は、どちらが先に入っても成り立つ形を「データ」に決めた。

## 既定で決めたこと

- 打ち切りは、先頭の変化を見つけたらすぐ行う。待つのは始め直しだけにする（実行の無駄を早く止めるため）。
- 実行の後・投稿の直前（`composeReviewPost`）に先頭の違いを見つけた再レビューも、投稿せずに打ち切る。
- 打ち切った回は回の番号を進めず、同じ番号で始め直す。

## データ

- イベント `ReviewRunStopped`：`reason`（`head_changed`・`merged`・`closed`）・`from`（レビューしていた先頭）・`to`（新しい先頭。`head_changed` だけ）・`runIds`・費用（`costUsd`・`estimated`・`usage`・費用不明の印）。
- 投影：`head_changed` は、`reviewTarget`・`reviewResolvedAt`・今の回の `outputs.review`・`reviewComments` を消し、`round` を持つ回ごとの記録（`reviewVerdicts`・`reviewDispatch` など）から今の回の要素を消して、`queued` に戻す。`reviewRound`・`previousReview`・`earlierReviews` は変えない。`merged`・`closed` は記録だけ（続く `TaskCancelled` で中止）。
- PR #523 の `reviewRecords` との合わせ方：仕様書（`event-log`）の決まりを「`head_changed` は、回ごとの記録のすべてから今の回の要素を消す」と書き、投影のテストは、タスクの `round` を持つ配列の欄をすべて見て、今の回の要素が残らないことを確かめる。
  - #523 が先に入る：この PR で `reviewRecords` の今の回の要素も消す。
  - この PR が先に入る：#523 が `reviewRecords` を足すと上のテストが落ちるので、#523 の側で消す処理を足す。
  - どちらでも、打ち切った回の記録は画面・`get_task` に出ず、始め直した回の `ReviewRestarted` で作る `previousReview.record` にも使われない。
- 届かなかった回：`rereviewLines` に渡す前回・それより前の回のデータに `delivered: false` を付ける。根拠は親の `discardedReviews` の項目のキーが `sactyReviewKey(子, 回)` であること。作業履歴の欄は足さない（ADR PBI-424）。

## 処理の流れ

1. 検知：`checkReviewPullRequests` が、投稿前のレビュー（1回目を含む・`reviewTarget` あり・フォークでない）の PR の先頭を読み、`reviewTarget.headCommit` と違えば打ち切る。
2. 打ち切り：止める印（メモリー。`mergeStopping` と同じ形）を立てて実行を止め、止めたコンテナを確かめる。実行の失敗の経路は、印を見て `AgentRunFailed`・`TaskPaused` の代わりに `ReviewRunStopped(head_changed)` を記録する。対象の確認中・投稿待ちのときも同じ記録にする。
3. 始め直し：`ReviewRunStopped(head_changed)` の後のタスクは、同じ先頭を `FEEDBACK_QUIET_MS` 見続けるまで実行の列に入れない（`runNext`・`queuedTaskIds`）。落ち着いたら、その先頭で対象を確かめ直して1回走る。
4. マージ・クローズ：`cancel(pull_request_merged|pull_request_closed)` が実行を止める前に同じ印を立て、`ReviewRunStopped(merged|closed)` と `TaskCancelled` を残す。
5. 届かなかった回：`rereviewLines` は、`delivered: false` の回を同じ原因の回数に数えさせない。その回の指摘（提案を含む）は、再レビューの範囲の絞り（PBI-432）にかかわらず範囲の中として今回の先頭で確かめさせ、当てはまるものを今回の指摘として出させる（「未対応の指摘は繰り返さない」を当てない）。`countSuggestionRounds` もその回を飛ばす。`aggregation.md` の「回をまたいで同じ原因が続くとき」に、届かなかった回を数えない決まりを足す。

## エラー時の振る舞い

- PR の先頭を読めない：打ち切らず、次の確認で読み直す。
- 止めたコンテナを確かめられない：`ReviewRunStopped` を記録せず、`unstoppedRuns` を付けた一時停止にして人の確認を待つ（`stopReworkForMerge` と同じ）。
- 止めている間に人が一時停止・中止した：人の操作を優先し、今の記録（人の一時停止・中止）にする。

## 影響範囲

- 仕様書（日英）：`tasks-and-steps`（PR のレビューだけのタスク・投稿の後の見守り）、`approval`（PR のレビューの子タスク・古い head へのレビュー）、`event-log`（イベントの一覧、費用を持つイベント、実行の内訳の「中断」）。
- ユーザー文書（日英）：`docs/user/intake`（古い head のレビューを捨てる説明、見守り、`ReviewRunStopped` を記録した後は前の版のデーモンに戻せないこと）。
- 新しい ADR（記録した後は前の版に戻せないことを「影響」に書く）。PBI-291 の ADR（古い head への AI のレビューは捨て、新しい head でかけ直さない）は一部置き換えにし、ファイル名を superseded にして、置き換え先に「届かなかった回の指摘を次の回で確かめ直す部分」と書く。作業履歴。
- 作業履歴の画面の表示名（`apps/web/src/lib/labels.ts`・`apps/web/src/i18n/messages/labels.ts`。日英）。

## テスト観点

- [TV-1] 再レビューの実行中に先頭が変わったら、実行を止めて投稿しない
  - 入力：子タスクの2回目のレビューが HEAD_A を対象に実行中で、PR の先頭が HEAD_B に変わってから PR の確認が1回走る
  - 期待結果：実行が止められ、postReview は呼ばれず、作業履歴に ReviewRunStopped（reason head_changed・from HEAD_A・to HEAD_B）が残り、AgentRunFailed と TaskPaused は記録されない
- [TV-2] 実行の後・投稿の直前に先頭の違いを見つけた再レビューも投稿しない
  - 入力：2回目のレビューの実行が判定 changes_required で終わり、投稿の直前に読んだ PR の先頭が HEAD_B（レビューしたのは HEAD_A）
  - 期待結果：PR に投稿されず、ReviewRunStopped（head_changed）が記録され、タスクの reviewVerdicts に2回目の判定が残らない
- [TV-3] 始め直しは先頭が落ち着いてから1回だけ
  - 入力：打ち切りの後、FEEDBACK_QUIET_MS が過ぎる前に先頭が HEAD_B から HEAD_C に変わり、その後 HEAD_C のまま FEEDBACK_QUIET_MS が過ぎる
  - 期待結果：HEAD_C のまま FEEDBACK_QUIET_MS が過ぎるまで実行の列（queuedTaskIds）に入らず、その後 HEAD_C を対象にした ReviewTargetResolved と実行がちょうど1回だけ起きる
- [TV-4] デーモンを起動し直しても始め直しの待ちをやり直す
  - 入力：ReviewRunStopped（head_changed）の後、待ちの途中でデーモンを起動し直す
  - 期待結果：起動の直後には実行の列に入らず、起動の後に同じ先頭を FEEDBACK_QUIET_MS 見続けてから実行が始まる
- [TV-5] 打ち切った回は回の番号と前回の記録を変えない
  - 入力：2回目を打ち切って始め直し、新しい先頭で2回目の実行が完了して投稿する
  - 期待結果：reviewRound は 2 のままで、previousReview は1回目、earlierReviews は打ち切りの前と同じで、レビューの指示に「これは 2 回目のレビューです」と書かれる
- [TV-6] 打ち切った回の回ごとの記録は、round を持つ配列の欄のすべてから消える
  - 入力：2回目の実行が完了して AgentRunCompleted（判定と回ごとの記録を含む）が記録された後に、ReviewRunStopped（head_changed）を投影する
  - 期待結果：投影したタスクの round を持つ配列の欄（reviewVerdicts など。PR #523 が入った後は reviewRecords も）に round 2 の要素が無く、1回目の要素は残る
- [TV-7] 打ち切った実行の費用はタスクの費用に数える
  - 入力：costUsd 1.5 の実行を head_changed で打ち切る
  - 期待結果：ReviewRunStopped に costUsd 1.5 が入り、タスクの費用の合計と予算の判定にその 1.5 が加わる
- [TV-8] 再レビューの実行中のマージ・クローズは失敗に見えない形で中止する
  - 入力：2回目のレビューの実行中に PR がマージされる（別の場合としてクローズされる）
  - 期待結果：ReviewRunStopped（reason merged、クローズなら closed）と TaskCancelled（pull_request_merged、クローズなら pull_request_closed）が残り、AgentRunFailed と TaskPaused は記録されない
- [TV-9] 止めたコンテナを確かめられなければ一時停止にする
  - 入力：head_changed の打ち切りで ensureStopped が false を返す
  - 期待結果：ReviewRunStopped は記録されず、unstoppedRuns を付けた TaskPaused が記録され、始め直しは起きない
- [TV-10] 先頭を読めないときは打ち切らない
  - 入力：再レビューの実行中に、PR の状態の応答の headSha が空になる
  - 期待結果：実行は止められず、ReviewRunStopped は記録されない
- [TV-11] 1回目のレビューも、取り込みで作ったレビューのタスクも打ち切って始め直し、回の番号は1のまま
  - 入力：取り込みで作ったレビューのタスク（reviewOf なし・フォークでない）の1回目が HEAD_A を対象に実行中に先頭が HEAD_B に変わり、HEAD_B のまま FEEDBACK_QUIET_MS が過ぎる
  - 期待結果：HEAD_A 宛ては投稿されず、ReviewRunStopped（head_changed・from HEAD_A・to HEAD_B）が残り、HEAD_B で1回だけ始め直し、reviewRound は 1（または無い）のままで previousReview は無い
- [TV-12] フォークの PR は打ち切らない
  - 入力：フォークからの PR のレビューの実行中に先頭が変わる
  - 期待結果：実行は止められず、ReviewRunStopped は記録されず、古い先頭宛てに latestCommit を付けて投稿される
- [TV-13] 親が捨てた古い先頭宛ての回は、次の回で届かなかった回として渡す
  - 入力：子の2回目が HEAD_A 宛てに投稿され、親が PullRequestReviewDiscarded（stale_head）で捨て、子の3回目が HEAD_B で始まる
  - 期待結果：3回目のレビューの指示のデータで2回目に delivered false が付き、指示に、その回を同じ原因の回数に数えないことと、その回の指摘（提案を含む）を範囲の中として HEAD_B で確かめ、当てはまるものを今回の指摘として出すことが書かれる
- [TV-14] 届かなかった回は提案だけの回の連続に数えない
  - 入力：1回目と3回目が suggestions で親に届き、2回目が suggestions で親に stale_head で捨てられている
  - 期待結果：3回目の時点の countSuggestionRounds は 2 を返す（2回目を数えない）
- [TV-15] 先頭が変わらない再レビューは変わらない
  - 入力：2回目のレビューの実行中から投稿まで、PR の先頭が HEAD_A のまま変わらず、前回までの回はすべて親に取り込まれている
  - 期待結果：今までと同じに HEAD_A 宛てに投稿され、ReviewRunStopped は記録されず、レビューの指示に delivered と届かなかった回の行が現れない
- [TV-16] 修正を戻すとテストが落ちる
  - 入力：service.ts・prompts.ts・suggestion-triage.ts・projection.ts の今回の変更を戻して、上の観点のテストを走らせる
  - 期待結果：打ち切り・始め直しの待ち・回ごとの記録の消去・マージの記録・届かなかった回の扱いを確かめるテストが落ちる
- [TV-17] 仕様書（日英）に打ち切りと回の数え方が書かれている
  - 入力：docs/spec の tasks-and-steps・approval・event-log の日英の差分
  - 期待結果：レビュー（1回目を含む、フォークを除く）の実行中・投稿の直前の先頭の変化での打ち切り、FEEDBACK_QUIET_MS 待ってからの1回の始め直し、ReviewRunStopped の欄と費用、head_changed で回ごとの記録のすべてから今の回の要素を消すこと、マージ・クローズの記録、打ち切った回と親が捨てた回を数えないこと、捨てた回の指摘を次の回が確かめることが、日英で同じ内容で書かれている
- [TV-18] ユーザー文書（日英）が今の振る舞いを書いている
  - 入力：docs/user/intake.md と docs/user/intake.en.md の差分
  - 期待結果：古い先頭宛てのレビューの説明が「捨てる」だけでなく、次の回のレビューが新しい先頭で確かめ直すことと、レビューの途中で PR が更新されると打ち切って落ち着いてから始め直すことと、打ち切りを記録した後は前の版のデーモンに戻せないことを、経緯の言い回しなしに書いている
- [TV-19] ADR に決定と置き換えの関係が書かれている
  - 入力：docs/adr の新しい ADR と、PBI-291 の ADR のファイル名
  - 期待結果：新しい ADR に打ち切り（1回目を含む）・数え方・届かなかった回の扱いと、記録した後は前の版に戻せないことが書かれ、PBI-291 の ADR が superseded のファイル名で置き換え先に置き換わった部分が1行で書かれている
- [TV-20] スキルの集約の規則に届かなかった回の扱いが書かれている
  - 入力：apps/daemon/default-context/skills/review/review-dispatch/references/aggregation.md の「回をまたいで同じ原因が続くとき」の差分
  - 期待結果：親に届かなかった回を同じ原因の回数に数えないことが書かれている
