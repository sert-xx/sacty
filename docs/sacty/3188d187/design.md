<!-- sacty task 3188d187-dd80-4711-9797-b43b71083da8 の設計。sacty が作成しました。 -->

# 設計：セキュリティ対応の行数の上限を無くし、直しでは解消できない要修正で一時停止する

## スコープ

セキュリティ対応の変更行数の上限（300 行）を無くす。
PR のレビューが「直しでは解消できず、人の判断が要る」と印を付けた要修正が残った回は、直しに入らずに一時停止し、人の PR のコメントか画面・MCP の再開で進める。

- 対象
  - 行数の上限の削除（`security.ts`・指示・PR の本文の範囲の節・`review.scopeViolated` の文言）
  - レビューの判定のブロックの印と、レビューの指示・既定のスキル `pr-review.md` の付け方
  - 新しい一時停止の理由、PR への知らせ、画面の見出し（ja・en）、PR のコメントでの再開、同じ指摘での繰り返しの防止
  - 仕様書（tasks-and-steps・approval・event-log・mcp-server）とユーザー文書（tasks）の ja・en、ADR、作業履歴
- 対象外
  - 「セキュリティ対応」と判定する基準、C-17 の文（`viewpoints.md`・`C-17.md` の例の 300 行を含む）
  - PR の本文の組み立ての作り替え（範囲の節から行数の文を除くだけ。新しい文は足さない）、`rework-notice.ts` の変更（PR の文面を作り替える PBI-450 が触る）
  - 人の指摘を含む回の印（印を読むのは、AI のレビューの指摘だけの回。人がすでに関わっているため）

## 確認したいこと

- must：なし
- should
  1. 一時停止を、セキュリティ対応に限らず、PR のレビューの子タスクがあるすべてのタスクに当ててよいか。推奨：はい。要求 2・3・5 が種類を限っておらず、往復の費用はどの種類でも起きる。
     懸念：依頼者がセキュリティ対応だけが止まると思って承認すると、ほかの種類のタスクも印が付けば人の判断待ちで止まり、気づくまで進まない。
  2. 人が「この指摘は直さずに受け入れる」と書いたときも、再開は直しの実行に入る、でよいか。推奨：はい。受け入れるだけならマージで済む（止まった PR は、人がドラフトを外せば戻さない）。要求 4 も直しに渡すと決めている。
     懸念：利用者が了承のコメントだけで承認待ちに戻ると思うと、直しの実行の費用が 1 回かかり、実装が何も変えなければ `unchanged` で止まり直す。
  3. PR のコメントで再開するのは、一時停止の間に取り込んだ `by: person` のコメント（PR の作者、または OWNER・MEMBER・COLLABORATOR の投稿。sacty の目印の付いた投稿を除く）が 1 件以上あるとき、でよいか。中身（了承か方針か、PBI-439 の「対応を求めていない」コメントか）は見分けない。推奨：はい。見分けは再開の後の戻し先の判断（既存）がする。
     懸念：書き込みの権限は確かめないので、COLLABORATOR などの「確認します」のような返事でも再開し、方針の無いまま直しが 1 回走る。
  4. 新しい一時停止の理由 `needs_decision` と、`max` を持たない範囲の違反の記録を足す（どちらかを記録した後は、前の版の sacty に戻せない）でよいか。推奨：はい。止まり方の区別に要り、`max` は上限を無くすと意味が無い。
     懸念：この版を入れた後に版を戻したい運用者は、`needs_decision` で止まったタスクか、範囲の外のファイルを変えたセキュリティ対応のタスクが 1 件でもあると、前の版を起動できない。
  5. 範囲の宣言が無いセキュリティ対応は、sacty の検査が何も無くなる（今は行数だけを見る）。実装とレビューの指示にだけ「宣言が無いので sacty は範囲を照らしていない」と書き、PR の本文は行数の文を除くだけにする、でよいか。最小限かはレビューの SEC-MIN に任せる。推奨：はい（利用者の決定は数で縛らない。本文に文を足すと PBI-450 の組み立てと重なる）。
     懸念：宣言の無いタスクで大きな差分が出ても、レビューが見逃せば、PR の本文にも出ないので、人は差分を見るまで気づかない。
- 確認しないと決めたこと
  - 並行の PBI-450（PR の文面）・PBI-451（既定のスキル・観点）との重なり：PR への知らせは新しいファイルにし、`rework-notice.ts`・`review-stop-notice.ts` を触らない。prompts.ts・service.ts・`pr-review.md` の衝突は、後にマージする側が解く（既存の進め方で、人の判断が要らないため）。

## 既定で決めたこと

- 印：判定のブロックの `rework.findings[]` に `needs_decision`（直しでは解消できない根拠の文。2,000 文字で切る）を足す。判定が「修正が必要」の回だけ止める。
- 同じ回で重なったときの順：印での停止を、判定し直しの止まり方（PBI-357 の `implement.declinedAgain`）より先にする。戻し先（PBI-446）は今までどおり決めて記録し、設計に戻す回でも止める。
- 繰り返しの防止：人の判断を、止めた指摘と組みで記録し、以後のレビューの子の指示に渡す。人の判断の後は、同じ先頭のレビューの印では止めない。
- PR のコメントでの再開の `TaskResumed` の actor は `sacty`（人が再開を押していないため。取り込みの記録は `person`）。
- 以前の版の違反の記録は読み込み、行数は表示しない。`outside` が空の違反は、違反なしとして扱う。版を入れた時点で始まっていたレビューの子の回は印を書かず、従来どおり直しに入る。

## データ

| 場所 | 変更 |
| --- | --- |
| `security.ts` | `SECURITY_FIX_MAX_CHANGED_LINES`・`LOCKFILES` を削除。`ScopeViolation` は `{ outside }`。`diffStats` はパスの取得に残す |
| `FinalReviewSkipped.securityScope.violation` | `lines`・`max` を optional にして読み込みを保つ。新しい記録は `outside` だけ |
| `ReviewRework.findings[]` | `needsDecision?: string`（JSON の `needs_decision`）。前の版の parse は余分な欄を捨てるので互換 |
| `PauseReason` | `needs_decision` を足す |
| `TaskPaused.payload` | `commit?`（止めた回の PR の先頭）。投影は `task.decisionPause`（先頭・印の付いた指摘・人の判断の文〔再開の補足か取り込んだ人のコメント〕）に持つ |
| `messages.ts` | `review.needsDecision`（PR の番号と、指摘と根拠の一覧）を足し、`review.scopeViolated` から行数の文を削除（ja・en） |
| `labels.ts` | `pause.needs_decision`・`pauseHelp.needs_decision`（ja・en） |

## 処理の流れ

1. AI のレビューの指摘だけの回（`unverified` の取り込みが混ざっても、`person` が無ければこの回に数える）で、次の 3 つがそろえば、`settleReview` が `requestChanges` に pause を渡す。
   - `reviewTaskRework` が読む子の最後の回の判定が `changes_required`
   - `needsDecision` の付いた指摘がある
   - その PR の先頭が、`decisionPause` の人の判断が済んだ先頭と違う
2. `ChangesRequested` と同じ追記で `TaskPaused { reason: "needs_decision", message: review.needsDecision, commit }` を記録する。直しの実行は始めない。
3. PR に知らせを 1 通出す（新しい `decision-notice.ts`。目印 `<!-- sacty-decision-notice:<タスク>:<回> -->`、指摘と根拠を `askQuote` で伏せて引用）。`github.ts` の `feedback` は、この目印を既存の知らせの目印と同じく取り込みから外す。
4. 見張り：`needs_decision` で止まったタスクは、戻し先（`activeStep`）が設計でも、実装の PR を `checkHeldFeedback`・`holdFeedback` の対象にする。
5. 再開
   - 画面・MCP：既存の `TaskResumed`（`note` は説明に足され、直しの指示に届く）。
   - PR：`holdFeedback` が、`needs_decision` で止まったタスクに `by: person` のコメントを取り込んだら、`PullRequestReviewImported`（held）と同じ追記で `TaskResumed { retry: true }` を記録する。その後は既存の `reworkHeldReview` がコメントを判断して直しに渡す。
   - どちらも、その文を `decisionPause` の人の判断に記録し、止めた先頭を判断済みにする。
6. 以後のレビューの子の指示（`reviewReworkLines`）に、止めた指摘と人の判断の文を渡し、その指摘には印を付けないと書く（先頭が変わった回も同じ）。
7. 人の判断の後の同じ先頭の回は、印では止めない。実装が指摘をすべて断った後の判定し直しで指摘が残れば、PBI-357 のとおり `unchanged`・`implement.declinedAgain` で止まる（同じ先頭を判定し直すのは 1 回だけ）。

## 影響範囲

- `prompts.ts`
  - `securityFixImplementLines`・`reviewSecurityLines`・`scopeDataLines`・`securityScopeBodyLines` から行数を除く。
  - `reviewReworkLines` に印の欄と付ける条件を足し、`reviewReworkOf` で読む。条件は、方式を変えても解消しない・依頼の受け入れ条件と制約がぶつかるなど、根拠で示せるときだけ付ける。迷ったら付けない。PR に人の判断がある指摘には付けない。
- 既定のスキル `pr-review.md` の「指摘と判定の書き方」に、同じ条件を汎用の文で足す（依頼した側が印の形を決めたときだけ付ける）。
- `github.ts`：知らせの目印の判定（`isDecisionNotice`）を、取り込みの除外の一覧に足す。
- `settlePausedDrafts`：`needs_decision` を、人がドラフトを外したら戻さない理由に足す。
- docs
  - tasks-and-steps（セキュリティ対応・一時停止の理由）、approval（AI のレビューの指摘・一時停止の間に届いた指摘で再開すること）、event-log、mcp-server（`pausedReason`）、user/tasks の 300 行の文
  - ADR を足し、影響に、前の版に戻せない記録（`needs_decision` の `TaskPaused`・`max` の無い違反）と、切り戻しはそれらが作業履歴に無いときだけできることを書く

## テスト観点

- [TV-1] 範囲の中の大きな差分を違反にしない
  - 入力：範囲の宣言が src/fix.ts で、src/fix.ts とテストのファイルを合わせて 600 行変えた変更を scopeViolation に渡す
  - 期待結果：undefined を返し、FinalReviewSkipped の securityScope に violation が記録されない
- [TV-2] 範囲の外のファイルは今までどおり違反にする
  - 入力：範囲の宣言が src/fix.ts で、src/util.ts を 1 行変えた変更を scopeViolation に渡す
  - 期待結果：{ outside: ["src/util.ts"] } を返し、lines・max を持たない
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
- [TV-8] 印の付いた要修正の回は直しに入らずに止まる
  - 入力：実装の承認待ちのタスクに、レビューの子の最後の回（changes_required、rework.findings の 1 件に needs_decision あり）の AI のレビューの指摘を取り込む
  - 期待結果：ChangesRequested と TaskPaused（reason needs_decision、commit が PR の先頭）が同じ追記で記録され、実装の実行（AgentRunStarted）が始まらない
- [TV-9] unverified の取り込みが混ざった回でも印で止まる
  - 入力：前の観点の回に、by が unverified の PR のコメントを 1 件あわせて取り込む
  - 期待結果：TaskPaused（reason needs_decision）が記録され、直しの実行が始まらない
- [TV-10] 止まった理由が作業履歴・画面・get_task で読める
  - 入力：印で止まったタスクを、作業履歴・タスクの詳細・あなたの出番（ja・en）・MCP の get_task で読む
  - 期待結果：pausedReason が needs_decision、pausedMessage に PR の番号と印の付いた指摘の要約と根拠があり、画面の見出しは ja・en とも「直しでは解消できない指摘」の旨で、unchanged の見出しと違う
- [TV-11] PR に理由を 1 回だけ投稿する
  - 入力：印で止まったタスクについて、デーモンの確認を 2 回まわす
  - 期待結果：PR に目印 sacty-decision-notice:<タスク>:<回> のコメントが 1 通だけ投稿され、指摘の要約と根拠が引用され、秘密の値は伏せられる
- [TV-12] 止まった PR のドラフトを人が外したら戻さない
  - 入力：印で止まり、ドラフトに戻った PR を人がドラフトから外した後に、デーモンの確認をまわす
  - 期待結果：PR はドラフトに戻されず、タスクは needs_decision で一時停止のまま
- [TV-13] 印の無い要修正だけの回は止まらずに直しに入る
  - 入力：rework.findings に needs_decision が無い changes_required の回の AI のレビューの指摘を取り込む
  - 期待結果：TaskPaused が記録されずに実装の直しの実行が始まり、印の判定を外すと「印の付いた要修正の回は直しに入らずに止まる」のテストが落ちる
- [TV-14] 提案だけの回は今までの流れのまま
  - 入力：判定が提案ありで、needs_decision の付いた項目を含む rework の回の AI のレビューの指摘を取り込む
  - 期待結果：needs_decision で止まらず、選り分け（セキュリティのタスクでは直し）の今までの流れに進む
- [TV-15] 人の PR のコメントで再開し、方針が直しに渡る
  - 入力：印で止まったタスクの PR に、by が person のコメント「テストを 2 件に絞って進めてください」が届く
  - 期待結果：PullRequestReviewImported（held）と TaskResumed が同じ追記で記録され、その後の実装の直しの指示にコメントの文が入る
- [TV-16] 戻し先が設計の回でも PR のコメントで再開する
  - 入力：印の付いた指摘の戻し先が design で止まったタスクの PR に、by が person のコメントが届く
  - 期待結果：コメントが PullRequestReviewImported（held）で取り込まれ、同じ追記で TaskResumed が記録される
- [TV-17] 人でないコメント・sacty の知らせでは再開しない
  - 入力：印で止まったタスクの PR に、sacty の AI のレビューのコメント、by が unverified のコメント、PR の作者のアカウントで投稿した目印 sacty-decision-notice の知らせだけが届く
  - 期待結果：知らせは取り込まれず、ほかは held で記録されるが、TaskResumed は記録されず一時停止のまま
- [TV-18] 画面・MCP の再開で補足が直しに渡る
  - 入力：印で止まったタスクを、note「上限は気にせず受け入れ条件を満たしてください」を付けて resume_task（または画面の再開）で再開する
  - 期待結果：TaskResumed の note が記録され、直しの実装の指示に note の文が入る
- [TV-19] 人の判断が次のレビューの指示に渡り、先頭が変わっても同じ指摘で止まらない
  - 入力：note を付けて再開し、直しで PR の先頭が変わった後に、レビューの子の指示を組み立てる
  - 期待結果：指示に止めた指摘と note の文があり、その指摘には印を付けないと書かれ、その回に印の無い要修正が残れば TaskPaused が記録されずに直しに入る
- [TV-20] 人の判断の後、同じ先頭では印で止まらない
  - 入力：人の再開の後、実装が指摘をすべて断り、同じ PR の先頭を判定し直したレビューの回に、needs_decision の付いた要修正が残る
  - 期待結果：needs_decision の TaskPaused は記録されず、PBI-357 のとおり reason unchanged・文言 implement.declinedAgain で止まる
- [TV-21] 判定し直しの回の印は needs_decision で止まり、ほかの止まり方と区別できる
  - 入力：人の判断の前に、実装が指摘をすべて断った後の判定し直しの回（PBI-357）に needs_decision の要修正が残る場合と、印の無い要修正が残る場合と、印の付いた指摘の戻し先が design の回（PBI-446）を比べる
  - 期待結果：1 つ目と 3 つ目は reason needs_decision・文言 review.needsDecision（3 つ目は ChangesRequested の target が design）、2 つ目は今までどおり reason unchanged・文言 implement.declinedAgain で記録される
- [TV-22] 仕様書・ユーザー文書・ADR が新しい振る舞いを書いている
  - 入力：docs/spec の tasks-and-steps・approval・event-log・mcp-server、docs/user/tasks（ja・en）、docs/adr の差分
  - 期待結果：セキュリティ対応の節に行数の上限が無く範囲の外のファイルの検査だけがあり、PauseReason に needs_decision、needs_decision で止まったタスクは人の PR のコメントで再開すること、ADR の影響に前の版に戻せない記録（needs_decision の TaskPaused・max の無い違反）と切り戻しの条件が ja・en で書かれている
- [TV-23] 検査が通る
  - 入力：変更後のリポジトリで npm run lint・型検査・vitest（CI の手順）を実行する
  - 期待結果：すべて成功する
