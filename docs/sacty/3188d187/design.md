<!-- sacty task 3188d187-dd80-4711-9797-b43b71083da8 の設計。sacty が作成しました。 -->

# 設計：セキュリティ対応の行数の上限を無くし、直しでは解消できない要修正で一時停止する

## スコープ

セキュリティ対応の変更行数の上限（300 行）を無くす。
PR のレビューが「直しでは解消できず、人の判断が要る」と印を付けた要修正が残った回は、直しに入らずに一時停止し、人の PR のコメントか画面・MCP の再開で進める。

- 対象
  - 行数の上限の削除（`security.ts`・指示・PR の本文の範囲の節・`review.scopeViolated` の文言）
  - レビューの判定のブロックの印と、レビューの指示・既定のスキル `pr-review.md` の付け方
  - 新しい一時停止の理由、PR への知らせ、画面の見出し（ja・en）、PR のコメントでの再開、同じ先頭での繰り返しの防止
  - 仕様書（tasks-and-steps・approval・event-log・mcp-server）とユーザー文書（tasks）の ja・en、ADR、作業履歴
- 対象外
  - 「セキュリティ対応」と判定する基準、C-17 の文（`viewpoints.md`・`C-17.md` の例の 300 行を含む）
  - PR の本文の組み立ての作り替え（範囲の節から行数の文を除くだけ）、`rework-notice.ts` の変更（PR の文面を作り替える PBI-450 が触る）
  - 人の指摘を含む回の印（印を読むのは、AI のレビューの指摘だけの回。人がすでに関わっているため）

## 確認したいこと

- must：なし
- should
  1. 人が「この指摘は直さずに受け入れる」と書いたときも、再開は直しの実行に入る、でよいか。推奨：はい。受け入れるだけならマージ（既存の承認）で済み、要求 4 も直しに渡すと決めている。
     懸念：利用者が了承のコメントだけで承認待ちに戻ると思うと、直しの実行の費用が 1 回かかり、実装が何も変えなければ `unchanged` で止まり直す。
  2. PR のコメントで再開するのは、一時停止の間に取り込んだ、本人と確かめられた人のコメント（`by: person`）が 1 件以上あるとき、でよいか。中身（了承か方針か、PBI-439 の「対応を求めていない」コメントか）は見分けない。推奨：はい。見分けは再開の後の戻し先の判断（既存）がする。
     懸念：「確認します」のような返事でも再開し、方針の無いまま直しが 1 回走る。
  3. 新しい一時停止の理由 `needs_decision` を足す（作業履歴に記録した後は、前の版の sacty に戻せない）でよいか。推奨：はい。受け入れ条件の「止まり方を理由で区別する」に要る。
     懸念：この版を入れた後に不具合で版を戻したい運用者は、このタスクの記録があると前の版を起動できない。
  4. 範囲の宣言が無いセキュリティ対応は、sacty の検査が何も無くなる（今は行数だけを見る）。指示と PR の本文に「宣言が無いので sacty は範囲を照らしていない」と書き、最小限かはレビューの SEC-MIN に任せる、でよいか。推奨：はい（利用者の決定は数で縛らない）。
     懸念：宣言の無いタスクで大きな差分が出ても、レビューが見逃せば、人は PR を開くまで気づかない。
- 確認しないと決めたこと
  - 対象のタスク：セキュリティ対応に限らず、PR のレビューの子タスクがあるすべてのタスクに当てる。要求 2・3・5 が種類を限っていないため。
  - 並行の PBI-450（PR の文面）・PBI-451（既定のスキル・観点）との重なり：PR への知らせは新しいファイルにし、`rework-notice.ts`・`review-stop-notice.ts` を触らない。prompts.ts・service.ts・`pr-review.md` の衝突は、後にマージする側が解く（既存の進め方で、人の判断が要らないため）。

## 既定で決めたこと

- 印：判定のブロックの `rework.findings[]` に `needs_decision`（直しでは解消できない根拠の文。2,000 文字で切る）を足す。判定が「修正が必要」の回だけ止める。
- 判定し直しの回（実装が指摘をすべて断った後に同じ先頭を判定し直す回）に印があれば、`implement.declinedAgain` より先に `needs_decision` で止める（人の判断が要る理由が伝わるため）。
- 繰り返しの防止：止めた回の PR の先頭を記録し、人の判断の後に同じ先頭のレビューに印があっても止めずに直しに入る。先頭が変わった回は、レビューの指示（PR に人の判断がある指摘には印を付けない）に任せる。
- PR のコメントでの再開の `TaskResumed` の actor は `sacty`（人が再開を押していないため。取り込みの記録は `person`）。
- 以前の版の違反の記録は読み込み、行数は表示しない。`outside` が空の違反は、違反なしとして扱う。

## データ

| 場所 | 変更 |
| --- | --- |
| `security.ts` | `SECURITY_FIX_MAX_CHANGED_LINES`・`LOCKFILES` を削除。`ScopeViolation` は `{ outside }`。`diffStats` はパスの取得に残す |
| `FinalReviewSkipped.securityScope.violation` | `lines`・`max` を optional にして読み込みを保つ。新しい記録は `outside` だけ |
| `ReviewRework.findings[]` | `needsDecision?: string`（JSON の `needs_decision`）。前の版の parse は余分な欄を捨てるので互換 |
| `PauseReason` | `needs_decision` を足す |
| `TaskPaused.payload` | `commit?`（止めた回の PR の先頭）。投影は `task.decisionPause`（先頭と、人の判断が済んだか）に持つ |
| `messages.ts` | `review.needsDecision`（PR の番号と、指摘と根拠の一覧）を足し、`review.scopeViolated` から行数の文を削除（ja・en） |
| `labels.ts` | `pause.needs_decision`・`pauseHelp.needs_decision`（ja・en） |

## 処理の流れ

1. AI のレビューの指摘だけの回で、次の 3 つがそろえば、`settleReview` が `requestChanges` に pause を渡す。
   - `reviewTaskRework` が読む子の最後の回の判定が `changes_required`
   - `needsDecision` の付いた指摘がある
   - その PR の先頭が、`decisionPause` の判断済みの先頭と違う
2. `ChangesRequested` と同じ追記で `TaskPaused { reason: "needs_decision", message: review.needsDecision, commit }` を記録する。直しの実行は始めない。
3. PR に知らせを 1 通出す（新しい `decision-notice.ts`。目印 `<!-- sacty-decision-notice:<タスク>:<回> -->`、指摘と根拠を `askQuote` で伏せて引用）。
4. 再開
   - 画面・MCP：既存の `TaskResumed`（`note` は説明に足され、直しの指示に届く）。
   - PR：`holdFeedback` が、`needs_decision` で止まったタスクに `by: person` のコメントを取り込んだら、`TaskResumed { retry: true }` を記録する。その後は既存の `reworkHeldReview` がコメントを判断して直しに渡す。
   - どちらも `decisionPause` を判断済みにする。

## 影響範囲

- `prompts.ts`
  - `securityFixImplementLines`・`reviewSecurityLines`・`scopeDataLines`・`securityScopeBodyLines` から行数を除く。
  - `reviewReworkLines` に印の欄と付ける条件を足し、`reviewReworkOf` で読む。条件は、方式を変えても解消しない・依頼の受け入れ条件と制約がぶつかるなど、根拠で示せるときだけ付ける。迷ったら付けない。PR に人の判断がある指摘には付けない。
- 既定のスキル `pr-review.md` の「指摘と判定の書き方」に、同じ条件を汎用の文で足す（依頼した側が印の形を決めたときだけ付ける）。
- `settlePausedDrafts` は、ほかの一時停止と同じく PR をドラフトに戻す。
- docs
  - tasks-and-steps（セキュリティ対応・一時停止の理由）、approval（AI のレビューの指摘・一時停止の間に届いた指摘で再開すること）、event-log、mcp-server（`pausedReason`）、user/tasks の 300 行の文
  - ADR を足し、前の版に戻せないことを影響に書く

## テスト観点

- [TV-1] 範囲の中の大きな差分を違反にしない
  - 入力：範囲の宣言が src/fix.ts で、src/fix.ts とテストのファイルを合わせて 600 行変えた変更を scopeViolation に渡す
  - 期待結果：undefined を返し、FinalReviewSkipped の securityScope に violation が記録されない
- [TV-2] 範囲の外のファイルは今までどおり違反にする
  - 入力：範囲の宣言が src/fix.ts で、src/util.ts を 1 行変えた変更を scopeViolation に渡す
  - 期待結果：{ outside: ["src/util.ts"] } を返し、lines・max を持たない
- [TV-3] 範囲の宣言が無いときは行数で違反にしない
  - 入力：範囲の宣言が無いセキュリティ対応のタスクで、600 行変えた変更を scopeViolation に渡し、実装の指示・レビューの指示・PR の本文を組み立てる
  - 期待結果：違反は undefined で、3 つの文に「宣言が無いので sacty は範囲を照らしていない」旨があり、「行の数」「上限」の語が無い
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
- [TV-9] 止まった理由が作業履歴・画面・get_task で読める
  - 入力：前の観点で止まったタスクを、作業履歴・タスクの詳細・あなたの出番（ja・en）・MCP の get_task で読む
  - 期待結果：pausedReason が needs_decision、pausedMessage に PR の番号と印の付いた指摘の要約と根拠があり、画面の見出しは ja・en とも「直しでは解消できない指摘」の旨で、unchanged の見出しと違う
- [TV-10] PR に理由を 1 回だけ投稿する
  - 入力：前の観点で止まったタスクについて、デーモンの確認を 2 回まわす
  - 期待結果：PR に目印 sacty-decision-notice:<タスク>:<回> のコメントが 1 通だけ投稿され、指摘の要約と根拠が引用され、秘密の値は伏せられる
- [TV-11] 印の無い要修正だけの回は止まらずに直しに入る
  - 入力：rework.findings に needs_decision が無い changes_required の回の AI のレビューの指摘を取り込む
  - 期待結果：TaskPaused が記録されずに実装の直しの実行が始まり、印の判定を外すと前の観点のテストが落ちる
- [TV-12] 提案だけの回は今までの流れのまま
  - 入力：判定が提案ありで、needs_decision の付いた項目を含む rework の回の AI のレビューの指摘を取り込む
  - 期待結果：needs_decision で止まらず、選り分け（セキュリティのタスクでは直し）の今までの流れに進む
- [TV-13] 人の PR のコメントで再開し、方針が直しに渡る
  - 入力：needs_decision で止まったタスクの PR に、by が person のコメント「テストを 2 件に絞って進めてください」が届く
  - 期待結果：PullRequestReviewImported（held）の後に TaskResumed が記録され、その後の実装の直しの指示にコメントの文が入る
- [TV-14] 人でないコメントでは再開しない
  - 入力：needs_decision で止まったタスクの PR に、sacty の AI のレビューのコメントと、by が unverified のコメントだけが届く
  - 期待結果：取り込みは held で記録されるが、TaskResumed は記録されず一時停止のまま
- [TV-15] 画面・MCP の再開で補足が直しに渡る
  - 入力：needs_decision で止まったタスクを、note「上限は気にせず受け入れ条件を満たしてください」を付けて resume_task（または画面の再開）で再開する
  - 期待結果：TaskResumed の note が記録され、直しの実装の指示に note の文が入る
- [TV-16] 人の判断の後、同じ先頭では同じ理由で止まらない
  - 入力：人の再開の後、同じ PR の先頭を判定し直したレビューの回に、needs_decision の付いた要修正が再び残る
  - 期待結果：needs_decision の TaskPaused が記録されず、直しに入る
- [TV-17] 判定し直しの回の印は needs_decision で止まり、ほかの止まり方と区別できる
  - 入力：実装が指摘をすべて断った後の判定し直しの回（PBI-357）に needs_decision の要修正が残る場合と、印の無い要修正が残る場合を比べる
  - 期待結果：前者は reason needs_decision・文言 review.needsDecision、後者は今までどおり reason unchanged・文言 implement.declinedAgain で記録される
- [TV-18] 仕様書・ユーザー文書・ADR が新しい振る舞いを書いている
  - 入力：docs/spec の tasks-and-steps・approval・event-log・mcp-server、docs/user/tasks（ja・en）、docs/adr の差分
  - 期待結果：セキュリティ対応の節に行数の上限が無く範囲の外のファイルの検査だけがあり、PauseReason に needs_decision、needs_decision で止まったタスクは人の PR のコメントで再開すること、ADR の影響に前の版に戻せないことが ja・en で書かれている
- [TV-19] 検査が通る
  - 入力：変更後のリポジトリで npm run lint・型検査・vitest（CI の手順）を実行する
  - 期待結果：すべて成功する
