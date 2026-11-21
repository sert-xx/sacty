<!-- sacty task 3188d187-dd80-4711-9797-b43b71083da8 の設計。sacty が作成しました。 -->

# 設計：セキュリティ対応の行数の上限を無くし、直しでは解消できない要修正で一時停止する

## スコープ

セキュリティ対応の変更行数の上限（300 行）を無くす。
PR のレビューが「直しでは解消できず、人の判断が要る」と印を付けた要修正が残った回は、直しに入らずに一時停止し、人の PR のコメントか画面・MCP の再開で進める。
一時停止は、セキュリティ対応に限らず、PR のレビューの子があるすべてのタスクに当てる（止まるのは印の付いた回だけ）。

- 対象
  - 行数の上限の削除（`security.ts`・指示・PR の本文の範囲の節・`review.scopeViolated` の文言）
  - 既定のレビューの観点 C-17（`viewpoints.md`・`C-17.md`）から行数の上限を外す
  - レビューの判定のブロックの印と、レビューの指示・既定のスキル `pr-review.md` の付け方
  - 新しい一時停止の理由、PR への知らせ、画面の見出し（ja・en）、PR のコメントでの再開、同じ指摘での繰り返しの防止
  - 仕様書（tasks-and-steps・approval・event-log・mcp-server）とユーザー文書（tasks）の ja・en、ADR、作業履歴
- 対象外
  - 「セキュリティ対応」と判定する基準
  - PR の本文の組み立ての作り替え（範囲の節から行数の文を除くだけ。新しい文は足さない）、`rework-notice.ts` の変更（PR の文面を作り替える PBI-450 が触る）
  - 人の指摘を含む回の印（印を読むのは、`by: person` の指摘が無い回だけ。人がすでに関わっているため）

## 確認したいこと

- must：なし
- should：なし
- 確認しないと決めたこと
  - 並行の PBI-450（PR の文面）・PBI-451（既定のスキル・観点）との重なり：PR への知らせは新しいファイルにし、`rework-notice.ts`・`review-stop-notice.ts` を触らない。prompts.ts・service.ts・`pr-review.md` の衝突は、後にマージする側が解く（既存の進め方で、人の判断が要らないため）。

## 既定で決めたこと

- 印：判定のブロックの `rework.findings[]` に `needs_decision`（直しでは解消できない根拠の文。2,000 文字で切る）を足す。判定が「修正が必要」の回だけ止める。
- 同じ回で重なったときの順：印での停止を、判定し直しの止まり方（PBI-357 の `implement.declinedAgain`）より先にする。戻し先（PBI-446）は今までどおり決めて記録し、設計に戻す回でも止める。
- 繰り返しの防止：人の判断を、止めた指摘と組みで記録し、以後のレビューの子の指示に渡す。人の判断の後は、同じ先頭のレビューの印では止めない。
- PR のコメントでの再開の `TaskResumed` の actor は `sacty`（人が再開を押していないため。取り込みの記録は `person`）。
- 違反の記録：新しい記録は `lines` を持たず、`max` は前の版が読めるように旧値 300 を固定で書く（読まず、表示しない）。以前の版の記録は読み込み、行数は表示せず、`outside` が空の違反は違反なしとして扱う。版を入れた時点で始まっていたレビューの子の回は印を書かず、従来どおり直しに入る。

## データ

| 場所 | 変更 |
| --- | --- |
| `security.ts` | `SECURITY_FIX_MAX_CHANGED_LINES`・`LOCKFILES` を削除。`ScopeViolation` は `{ outside }`。`diffStats` はパスの取得に残す |
| `FinalReviewSkipped.securityScope.violation` | schema は変えない（`lines` は optional、`max` は必須のまま）。新しい記録は `outside` と `max: 300` |
| `ReviewRework.findings[]` | `needsDecision?: string`（JSON の `needs_decision`）。前の版の parse は余分な欄を捨てるので互換 |
| `PauseReason` | `needs_decision` を足す |
| `TaskPaused.payload` | `commit?`（止めた回の PR の先頭）。投影は `task.decisionPause`（先頭・印の付いた指摘・人の判断の文〔再開の補足か取り込んだ人のコメント〕）に持つ |
| `messages.ts` | `review.needsDecision`（PR の番号と、指摘と根拠の一覧）を足し、`review.scopeViolated` から行数の文を削除（ja・en） |
| `labels.ts` | `pause.needs_decision`・`pauseHelp.needs_decision`（ja・en） |

## 処理の流れ

1. `by: person` の指摘が無い回（AI のレビューの指摘に `unverified` の取り込みが混ざっても、この回に数える）で、次の 3 つがそろえば、`settleReview` が `requestChanges` に pause を渡す。
   - `reviewTaskRework` が読む子の最後の回の判定が `changes_required`
   - `needsDecision` の付いた指摘がある
   - その PR の先頭が、`decisionPause` の人の判断が済んだ先頭と違う
2. `ChangesRequested` と同じ追記で `TaskPaused { reason: "needs_decision", message: review.needsDecision, commit }` を記録する。直しの実行は始めない。
3. PR に知らせを 1 通出す（新しい `decision-notice.ts`。目印 `<!-- sacty-decision-notice:<タスク>:<回> -->`、指摘と根拠を `askQuote` で伏せて引用）。`github.ts` の `feedback` は、この目印を既存の知らせの目印と同じく取り込みから外す。
4. 見張り：`needs_decision` で止まったタスクは、戻し先（`activeStep`）が設計でも、実装の PR を `checkHeldFeedback`・`holdFeedback` の対象にする。
5. 再開
   - 画面・MCP：既存の `TaskResumed`（`note` は説明に足され、直しの指示に届く）。
   - PR：`holdFeedback` が、`needs_decision` で止まったタスクに `by: person` のコメント（sacty の目印の付いた投稿を除く）を取り込んだら、`PullRequestReviewImported`（held）と同じ追記で `TaskResumed { retry: true }` を記録する。`unverified` のコメントは held で残すだけで再開しない。その後は既存の `reworkHeldReview` がコメントを判断して直しに渡す。
   - どちらも、その文を `decisionPause` の人の判断に記録し、止めた先頭を判断済みにする。
6. 以後のレビューの子の指示（`reviewReworkLines`）に、止めた指摘と人の判断の文を渡し、その指摘には印を付けないと書く（先頭が変わった回も同じ）。
7. 人の判断の後の同じ先頭の回は、印では止めない。実装が指摘をすべて断った後の判定し直しで指摘が残れば、PBI-357 のとおり `unchanged`・`implement.declinedAgain` で止まる（同じ先頭を判定し直すのは 1 回だけ）。

## 影響範囲

- `prompts.ts`
  - `securityFixImplementLines`・`reviewSecurityLines`・`scopeDataLines`・`securityScopeBodyLines` から行数を除く。範囲の宣言が無いときの「宣言が無いので範囲を照らしていない」の文は、実装とレビューの指示にだけ足す（PR の本文には足さない）。
  - `reviewReworkLines` に印の欄と付ける条件を足し、`reviewReworkOf` で読む。条件は、方式を変えても解消しない・依頼の受け入れ条件と制約がぶつかるなど、根拠で示せるときだけ付ける。迷ったら付けない。PR に人の判断がある指摘には付けない。
- 既定のスキル `pr-review.md` の「指摘と判定の書き方」に、同じ条件を汎用の文で足す（依頼した側が印の形を決めたときだけ付ける）。
- 既定の観点 C-17：`viewpoints.md`・`C-17.md` の「タスクの制約（最小限の変更・範囲・行数の上限）」などから行数の上限を外す。指摘の書き方の例の「行数の上限（300 行）」は、数を使わない制約（変えてよい範囲の外の共通の処理まで変えている）に差し替える。
- `github.ts`：知らせの目印の判定（`isDecisionNotice`）を、取り込みの除外の一覧に足す。
- `settlePausedDrafts`：`needs_decision` を、人がドラフトを外したら戻さない理由に足す（`unchanged` と同じ。受け入れるだけならマージで済む）。
- docs
  - tasks-and-steps（セキュリティ対応・一時停止の理由）、approval（AI のレビューの指摘・一時停止の間に届いた指摘で再開すること）、event-log、mcp-server（`pausedReason`）、user/tasks の 300 行の文
  - ADR を足し、影響に、前の版に戻せない記録は `needs_decision` の `TaskPaused` だけであること（違反の記録は前の版が読める形を保つ）と、切り戻しはそれが作業履歴に無いときだけできることを書く

## テスト観点

- [TV-1] 範囲の中の大きな差分を違反にしない
  - 入力：範囲の宣言が src/fix.ts で、src/fix.ts とテストのファイルを合わせて 600 行変えた変更を scopeViolation に渡す
  - 期待結果：undefined を返し、FinalReviewSkipped の securityScope に violation が記録されない
- [TV-2] 範囲の外のファイルは今までどおり違反にし、前の版が読める形で記録する
  - 入力：範囲の宣言が src/fix.ts で、src/util.ts を 1 行変えた変更で checkSecurityScope を通し、FinalReviewSkipped を記録する
  - 期待結果：violation が { outside: ["src/util.ts"], max: 300 } で lines を持たず、変更前の版の FinalReviewSkipped の schema でも parse が成功する
- [TV-3] 範囲の宣言が無いときは行数で違反にしない
  - 入力：範囲の宣言が無いセキュリティ対応のタスクで、600 行変えた変更を scopeViolation に渡し、実装の指示・レビューの指示・PR の本文の範囲の節を組み立てる
  - 期待結果：違反は undefined で、実装とレビューの指示に「宣言が無いので sacty は範囲を照らしていない」旨があり、PR の本文の範囲の節には新しい文が足されず、3 つのどれにも「行の数」「上限」の語が無い
- [TV-4] 指示・PR の本文・文言に行数の上限が出ない
  - 入力：範囲の宣言があるセキュリティ対応のタスクで、実装の指示・PR のレビューの指示（違反あり・なし）・PR の本文の範囲の節と、review.scopeViolated の ja・en を作る
  - 期待結果：どれにも「300」「行の数」「lines」の上限の文が無く、実装とレビューの指示に「最小限の変更」と「範囲の外を変えない（範囲の外は要修正）」の文が残る
- [TV-5] 以前の版の行数の違反の記録を読み込める
  - 入力：violation が { outside: [], lines: 571, max: 300 } と { outside: ["a.ts"], lines: 400, max: 300 } の FinalReviewSkipped を含む作業履歴を投影し、PR の本文を組み立てる
  - 期待結果：EventInput.parse が失敗せず、前者は違反なし・後者は a.ts だけの違反として本文に出て、行数は出ない
- [TV-6] レビューの指示に印と付ける条件がある
  - 入力：実装の PR のレビューの子タスクの指示を buildPrompt で組み立てる
  - 期待結果：判定のブロックの例に needs_decision の欄があり、要修正だけに付けること・方式を変えても解消しない／依頼の受け入れ条件と制約がぶつかるなど根拠で示せるときだけ付けること・迷ったら付けないこと・PR に人の判断がある指摘には付けないことが書かれている
- [TV-7] 既定のスキルに印の付け方が汎用の文で書かれている
  - 入力：apps/daemon/default-context/skills/review/review-dispatch/references/pr-review.md の「指摘と判定の書き方」の差分
  - 期待結果：依頼した側が印の形を決めたときに、直しでは解消できないと根拠で示せる must にだけ付け、迷ったら付けない決まりがあり、sacty の名前・内部の部品名・特定の言語の例が無い
- [TV-8] 既定の観点 C-17 に行数の上限が書かれていない
  - 入力：apps/daemon/default-context/skills/review/review-dispatch/references/viewpoints.md と review-execution/references/C-17.md の差分
  - 期待結果：タスクの制約の列挙は「最小限の変更・範囲など」で行数の上限を含まず、指摘の書き方の例は特定の行数を使わない別の汎用の制約（変えてよい範囲の外まで変えているなど）で、特定の製品・言語の名前が無い
- [TV-9] 印の付いた要修正の回は直しに入らずに止まる
  - 入力：実装の承認待ちのタスクに、レビューの子の最後の回（changes_required、rework.findings の 1 件に needs_decision あり）の AI のレビューの指摘を取り込む
  - 期待結果：ChangesRequested と TaskPaused（reason needs_decision、commit が PR の先頭）が同じ追記で記録され、実装の実行（AgentRunStarted）が始まらない
- [TV-10] unverified の取り込みが混ざった回でも印で止まる
  - 入力：前の観点の回に、by が unverified の PR のコメントを 1 件あわせて取り込む
  - 期待結果：TaskPaused（reason needs_decision）が記録され、直しの実行が始まらない
- [TV-11] 止まった理由が作業履歴・画面・get_task で読める
  - 入力：印で止まったタスクを、作業履歴・タスクの詳細・あなたの出番（ja・en）・MCP の get_task で読む
  - 期待結果：pausedReason が needs_decision、pausedMessage に PR の番号と印の付いた指摘の要約と根拠があり、画面の見出しは ja・en とも「直しでは解消できない指摘」の旨で、unchanged の見出しと違う
- [TV-12] PR に理由を 1 回だけ投稿する
  - 入力：印で止まったタスクについて、デーモンの確認を 2 回まわす
  - 期待結果：PR に目印 sacty-decision-notice:<タスク>:<回> のコメントが 1 通だけ投稿され、指摘の要約と根拠が引用され、秘密の値は伏せられる
- [TV-13] 止まった PR のドラフトを人が外したら戻さない
  - 入力：印で止まり、ドラフトに戻った PR を人がドラフトから外した後に、デーモンの確認をまわす
  - 期待結果：PR はドラフトに戻されず、タスクは needs_decision で一時停止のまま
- [TV-14] 印の無い要修正だけの回は止まらずに直しに入る
  - 入力：rework.findings に needs_decision が無い changes_required の回の AI のレビューの指摘を取り込む
  - 期待結果：TaskPaused が記録されずに実装の直しの実行が始まり、印の判定を外すと「印の付いた要修正の回は直しに入らずに止まる」のテストが落ちる
- [TV-15] 提案だけの回は今までの流れのまま
  - 入力：判定が提案ありで、needs_decision の付いた項目を含む rework の回の AI のレビューの指摘を取り込む
  - 期待結果：needs_decision で止まらず、選り分け（セキュリティのタスクでは直し）の今までの流れに進む
- [TV-16] 人の PR のコメントで再開し、方針が直しに渡る
  - 入力：印で止まったタスクの PR に、by が person のコメント「テストを 2 件に絞って進めてください」が届く
  - 期待結果：PullRequestReviewImported（held）と TaskResumed が同じ追記で記録され、その後の実装の直しの指示にコメントの文が入る
- [TV-17] 戻し先が設計の回でも PR のコメントで再開する
  - 入力：印の付いた指摘の戻し先が design で止まったタスクの PR に、by が person のコメントが届く
  - 期待結果：コメントが PullRequestReviewImported（held）で取り込まれ、同じ追記で TaskResumed が記録される
- [TV-18] 人でないコメント・sacty の知らせでは再開しない
  - 入力：印で止まったタスクの PR に、sacty の AI のレビューのコメント、by が unverified のコメント、PR の作者のアカウントで投稿した目印 sacty-decision-notice の知らせだけが届く
  - 期待結果：知らせは取り込まれず、ほかは held で記録されるが、TaskResumed は記録されず一時停止のまま
- [TV-19] 画面・MCP の再開で補足が直しに渡る
  - 入力：印で止まったタスクを、note「上限は気にせず受け入れ条件を満たしてください」を付けて resume_task（または画面の再開）で再開する
  - 期待結果：TaskResumed の note が記録され、直しの実装の指示に note の文が入る
- [TV-20] 人の判断が次のレビューの指示に渡り、先頭が変わっても同じ指摘で止まらない
  - 入力：note を付けて再開し、直しで PR の先頭が変わった後に、レビューの子の指示を組み立てる
  - 期待結果：指示に止めた指摘と note の文があり、その指摘には印を付けないと書かれ、その回に印の無い要修正が残れば TaskPaused が記録されずに直しに入る
- [TV-21] 人の判断の後、同じ先頭では印で止まらない
  - 入力：人の再開の後、実装が指摘をすべて断り、同じ PR の先頭を判定し直したレビューの回に、needs_decision の付いた要修正が残る
  - 期待結果：needs_decision の TaskPaused は記録されず、PBI-357 のとおり reason unchanged・文言 implement.declinedAgain で止まる
- [TV-22] 判定し直しの回の印は needs_decision で止まり、ほかの止まり方と区別できる
  - 入力：人の判断の前に、実装が指摘をすべて断った後の判定し直しの回（PBI-357）に needs_decision の要修正が残る場合と、印の無い要修正が残る場合と、印の付いた指摘の戻し先が design の回（PBI-446）を比べる
  - 期待結果：1 つ目と 3 つ目は reason needs_decision・文言 review.needsDecision（3 つ目は ChangesRequested の target が design）、2 つ目は今までどおり reason unchanged・文言 implement.declinedAgain で記録される
- [TV-23] 仕様書・ユーザー文書・ADR が新しい振る舞いを書いている
  - 入力：docs/spec の tasks-and-steps・approval・event-log・mcp-server、docs/user/tasks（ja・en）、docs/adr の差分
  - 期待結果：セキュリティ対応の節に行数の上限が無く範囲の外のファイルの検査だけがあり、PauseReason に needs_decision、needs_decision で止まったタスクは by が person の PR のコメントで再開すること、ADR の影響に前の版に戻せない記録は needs_decision の TaskPaused だけで違反の記録は前の版が読める形を保つことと切り戻しの条件が ja・en で書かれている
- [TV-24] 検査が通る
  - 入力：変更後のリポジトリで npm run lint・型検査・vitest（CI の手順）を実行する
  - 期待結果：すべて成功する
