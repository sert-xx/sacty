<!-- sacty task c128e4da-4476-4a5a-b5e9-4be3543d4e9e の設計。sacty が作成しました。 -->

出典の分類が終わったので、設計を出します。

# 設計：要求要件・設計の PR で「提案あり」の直しと再レビューを打ち切る（PBI-481）

## スコープ

要求要件・設計の PR で、提案だけの判定が 2 回続いたら、2 回目は直しに入らずに承認待ちのまま保つ。
打ち切ったことは新しい記録 `StepSuggestionsHeld` に残し、承認の画面・タスクの概要・作業履歴で知らせる。
人が PR に直接コミットしたら、その先頭を同じレビューの子タスクの次の回として再レビューする。

- 対象
  - `apps/daemon/src/service.ts`：取り込んだ指摘を直しに回す前に、打ち切るかを判定する（`needsDecisionOf` の後、`triageSuggestions` の前）
  - `apps/daemon/src/service.ts`：`reconcileReviewTaskNow` で、要求要件・設計の PR の再レビューの対象を、人が足した先頭にする
  - `packages/core`：記録 `StepSuggestionsHeld` と、投影の `Task.heldSuggestions`
  - `apps/web`：`AiReviewNotice` の知らせ、作業履歴の行、文言（日英）
  - 文書：`approval`・`event-log`・`tasks`・`intake`（日英）、ADR、作業履歴
- 対象外
  - 打ち切った回に、AI のレビューの提案のコメントへ返信を投稿すること
  - 実装の PR の選り分け・判定し直し・ドラフトの扱い（`triageSuggestions` から先は変えない）

## 確認したいこと

### must

なし

### should

- Q-1：新しい記録 `StepSuggestionsHeld` を足してよいか。
  足すと、記録した後は前の版のデーモンに戻せません（前の版は作業履歴を読めず、起動しません）。
  推奨：はい。今の記録（`SuggestionsTriaged`・`PullRequestMarkedReady`）は実装の PR を前提に投影するので、広げると実装の PR の扱い（R-8）を崩しやすいため。
  懸念：版を戻せることが要るなら、戻した利用者のデーモンが起動しなくなり、記録の形を作り直す作業が要ります。
- Q-2：人が要求要件・設計の PR に直接コミットしたときの再レビューを、打ち切った後に限らず、承認待ちの間はいつも始めてよいか。
  推奨：はい。今は人のコミットでは再レビューが始まらず、提案の回を続けて数える前提（承認済みの要求要件の should）が成り立たないため。打ち切った後だけに絞る条件を足すより、規則が 1 つで済む。
  懸念：打ち切りの前は人のコミットを再レビューさせたくなかったなら、利用者が要求要件・設計の PR に直接直すたびに、AI のレビューが 1 回（数分と費用）余計に回ります。

## 既定で決めたこと

- 人の指摘による直しかどうかは、その工程への最後の差し戻し（`ChangesRequested`）に、AI のレビュー（`source: sacty_review`）でない指摘があるかで決める。
- 知らせは、打ち切った先頭が PR の今の先頭のときだけ出す（実装の PR の「提案が残っている」と同じ）。
  人のコミットの後は、次の判定に任せる。
- 直させる方法は、ヒントではなく知らせの本文に出す。

## 処理の流れ

取り込んだ指摘（`pendingReview`）を直しに回す前に、次の条件をすべて満たすなら打ち切る（`StepSuggestionsHeld` を記録して終える）。
1 つでも外れれば、今までどおり判断と直しに進む。

| # | 条件 | 外れる例 |
| --- | --- | --- |
| 1 | PR の工程が `requirements`・`design`（実装の工程が無い進め方の PR を含む） | 実装の PR |
| 2 | 指摘がすべて AI のレビューで、人（出どころを確かめられない人を含む）の指摘が無い | PR に人のコメントがある（R-4） |
| 3 | AI のレビューの指摘がすべて子タスクの最後の回のもので、その回の判定が `suggestions` | 要修正（R-3）、前の回の指摘が混ざる |
| 4 | `countSuggestionRounds`（届かなかった回を除く）が 2 以上 | 初回の提案、要修正の後の提案（R-2） |
| 5 | その工程への最後の `ChangesRequested` の指摘が、すべて `source: sacty_review` | 人の指摘・画面からの差し戻しの後の提案（R-2） |

- 人のコミットの後の再レビュー：今は、要求要件・設計の PR の再レビューの対象が、親が提出した `gate.commit` に固定され、人が足した先頭を見ない。
  - `reconcileReviewTaskNow` で、要求要件・設計の PR は、PR の確認で読んだ先頭（`latestHeads`。番号と提出したコミットが今の PR と同じとき）が `gate.commit` と違えば、それを対象にする。
  - 対象が子タスクのレビュー済みの先頭（`reviewTarget.headCommit`）とも、再レビューを始めた先頭（`reviewRestartCommit`）とも違えば、同じ子タスクに `ReviewRestarted`（`reason: updated`・`commit` は人が足した先頭）を記録する。
  - 子タスクの回が続くので、その判定は条件 4 で続けて数える。条件 5 も変わらない。
  - 実装の PR の対象の決め方（`awaiting`・`reviewed`・`draftedAhead`）は変えない（R-8）。
- 打ち切った後は、人がコミットしない限り先頭が変わらないので、再レビューは始まらない。
  人のコメントは条件 2 で外れ、画面からの差し戻しは `requestChanges` を直接通るので、どちらも直しに入る（R-4）。

## データ

- `StepSuggestionsHeld`（actor `sacty`）：`step`・`number`・`commit`（打ち切った先頭）・`round`・`suggestionRounds`
- 投影：承認待ちで、判断・選り分けの前の `pendingReview` があることを確かめてから、`pendingReview` を外す（取り込み済みのキーは残す）。
  `Task.heldSuggestions` に `step`・`number`・`commit` を持つ。
  その工程への `ChangesRequested` と、承認ゲートが閉じたときに外す。
- 再起動の後も、`pendingReview` が無く指摘は取り込み済みなので、直しに入らない（R-7）。

## 画面

- `AiReviewNotice`：`heldSuggestions` の `number` が承認待ちの PR で、`commit` が今の先頭のとき、次の 2 つの文言（各 1 文）を出す。
  - 提案が残っているが、提案だけの判定が続いたため、直しと再レビューをしていないこと
  - 直させたいときは、PR に要対応とコメントするか、画面から差し戻すこと
- 作業履歴の行（`labels.ts`）：「PR #N で提案だけの判定が続いたため直しに入らなかった。提案は残っている。直させたいときは、PR に要対応とコメントするか、画面から差し戻す」を 1 行で出す（日英）。

## 影響範囲

- `approval`（日英）：次の 3 か所を、この規則に合わせる。
  - 選り分けの節の対象外の行
  - 「PR のレビューの子タスク」の「提案だけの回は直しに入る」と、要求要件・設計の PR の再レビューが始まる条件（人が PR に足したコミットでも始まる）
  - 「変えないもの」の「要求要件・設計の PR のレビュー」
- `event-log`（日英）：`StepSuggestionsHeld` の項を足し、種類の数を 143 から 144 にする（`EventInput` の数と合わせる）。
- `tasks`・`intake`（日英）：選り分けの対象外の記述に、要求要件・設計の PR での打ち切りと、直させる方法を足す。
- ADR：新しく 1 件足し、次のことを書く。
  - 回数で打ち切る理由
  - PBI-436 の ADR が、実装の PR では回数で止める案と人の承認を待つ案を採らなかったことと、今回の理由の違い
  - 記録した後は版を戻せないこと
- `20261120-2109-superseded-triage-ai-review-suggestions-before-rework.md`：置き換え先に新しい ADR を足し、置き換えた部分を「要求要件・設計の PR は変えない」と書く。
- 作業履歴：`docs/worklog/` に PBI-481 の 1 件を足す。

## テスト観点

- [TV-1] 要求要件の PR の初回の提案だけの判定で直しに入る
  - 入力：実装の工程が残るタスクの要求要件の PR に、子タスクの 1 回目の判定が suggestions の AI のレビューだけが届く
  - 期待結果：StepSuggestionsHeld を記録せず、要求要件の工程への ChangesRequested が記録される
- [TV-2] 要求要件の PR で提案だけの判定が 2 回続くと打ち切る
  - 入力：1 回目の suggestions で AI のレビューだけの直しをした後、2 回目の判定も suggestions の AI のレビューだけが届く
  - 期待結果：StepSuggestionsHeld（suggestionRounds が 2）を記録し、新しい ChangesRequested は無く、タスクは承認待ちのまま pendingReview が無い
- [TV-3] 実装の工程が無い進め方の設計の PR でも 2 回目で打ち切る
  - 入力：design-only のタスクの設計の PR で、1 回目の suggestions の直しの後、2 回目も suggestions の AI のレビューだけが届く
  - 期待結果：StepSuggestionsHeld を記録し、新しい ChangesRequested は無い
- [TV-4] 要修正の後の提案だけの判定は 1 回目として直す
  - 入力：設計の PR で、1 回目が changes_required（needs_decision の印なし）で直した後、2 回目が suggestions の AI のレビューだけ
  - 期待結果：StepSuggestionsHeld を記録せず、ChangesRequested が記録される
- [TV-5] 人の指摘による直しの後の提案だけの判定は 1 回目として直す
  - 入力：設計の PR で打ち切った後、人のコメント（source の無い指摘）による直しをして、次の判定が suggestions の AI のレビューだけ
  - 期待結果：StepSuggestionsHeld を記録せず、ChangesRequested が記録される
- [TV-6] 人が要求要件・設計の PR に足した先頭で再レビューが始まる
  - 入力：承認待ちの設計の PR で、PR の確認で読んだ先頭が、提出したコミット（gate.commit）と違う人のコミットになり、その確認を 2 回続けて行う
  - 期待結果：1 回目の確認で、同じレビューの子タスクに ReviewRestarted（reason が updated・commit が人の先頭）が 1 件記録され、2 回目の確認では重ねて記録されない
- [TV-7] 人のコミットの後の提案だけの判定は続けて数える
  - 入力：設計の PR で 2 回目に打ち切った後、人が PR にコミットを足して再レビューが始まり、3 回目の判定も人の先頭への suggestions の AI のレビューだけ
  - 期待結果：StepSuggestionsHeld（suggestionRounds が 3・commit が人の先頭）を記録し、ChangesRequested は無い
- [TV-8] 届かなかった回は提案だけの回に数えない
  - 入力：1 回目が suggestions で直した後、2 回目の suggestions が古い先頭宛てで捨てられ（stale_head）、3 回目が suggestions の AI のレビューだけ
  - 期待結果：3 回目は 2 回目として数え、StepSuggestionsHeld（suggestionRounds が 2）を記録する
- [TV-9] 打ち切った後の要修正では直しに入る
  - 入力：設計の PR で打ち切った後、人のコミットで始まった再レビューの判定が changes_required（印なし）
  - 期待結果：ChangesRequested が記録され、heldSuggestions が外れる
- [TV-10] 打ち切った後の人のコメント・画面からの差し戻しで直しに入る
  - 入力：要求要件の PR で打ち切った後、人が PR に要対応とコメントする場合と、画面から差し戻す場合
  - 期待結果：どちらの場合も ChangesRequested が記録され、要求要件の工程の直しが始まる
- [TV-11] 打ち切った後に再起動しても直しに入らない
  - 入力：StepSuggestionsHeld を記録した作業履歴で、PR の先頭が変わらないままデーモンを起動し直す
  - 期待結果：タスクは承認待ちのままで、ChangesRequested も子タスクの再レビューも始まらない
- [TV-12] 実装の PR の選り分けは変わらない
  - 入力：変更の後のコードで、既存の daemon-suggestion-triage.test.ts・suggestion-triage.test.ts・triage-reply.test.ts を変えずに流す
  - 期待結果：すべて通り、実装の PR では StepSuggestionsHeld が記録されない
- [TV-13] 承認の画面とタスクの概要に打ち切りの知らせが出る
  - 入力：heldSuggestions の commit が今の先頭の承認待ちのタスクを、日本語と英語で表示する
  - 期待結果：承認の画面とタスクの概要の両方に、提案が残っていること・直しと再レビューをしていないこと・PR に要対応とコメントするか画面から差し戻す方法が、日英それぞれで出る
- [TV-14] 先頭が進んだ後は打ち切りの知らせを出さない
  - 入力：heldSuggestions の commit と、PR の今の先頭が違う承認待ちのタスクを表示する
  - 期待結果：打ち切りの知らせは出ない
- [TV-15] 作業履歴に打ち切りの行が出る
  - 入力：StepSuggestionsHeld（number が 12）の記録を、日本語と英語で作業履歴の行にする
  - 期待結果：PR #12・提案だけの判定が続いたため直しに入らなかったこと・提案が残っていること・PR に要対応とコメントする方法・画面から差し戻す方法を含む 1 行が、日英それぞれで出る
- [TV-16] 仕様書に打ち切りの規則と記録がある
  - 入力：docs/spec/approval.md・approval.en.md・event-log.md・event-log.en.md の差分
  - 期待結果：approval の選り分けの節・PR のレビューの子タスクの節・変えないものが、提案だけの 2 回目で打ち切る規則・数え直しの条件・人が足したコミットで再レビューが始まること・直させる方法と一致し、event-log に StepSuggestionsHeld の項目があり種類の数が 144 になっている
- [TV-17] ユーザー文書に打ち切りと直させる方法がある
  - 入力：docs/user/tasks.md・tasks.en.md・intake.md・intake.en.md の差分
  - 期待結果：選り分けの対象外の記述に、要求要件・設計の PR は提案だけの判定が 2 回続くと直しに入らず承認を待つことと、PR に要対応とコメントする・画面から差し戻す方法が書かれている
- [TV-18] ADR と作業履歴が足されている
  - 入力：docs/adr/ と docs/worklog/ の差分と、npx vitest run tests/docs の結果
  - 期待結果：新しい ADR に回数で打ち切る理由・PBI-436 の ADR との違い・版を戻せないことが書かれ、PBI-436 の ADR の置き換え先に新しい ADR と置き換えた部分があり、PBI-481 の作業履歴が 1 件あり、tests/docs が通る
