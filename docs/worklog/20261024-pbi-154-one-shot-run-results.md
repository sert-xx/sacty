# Claude Code の実行で後で起こす予約を使わせず、結果が何回も出ても本文と使用量を正しく取る

- 日付: 2026-10-24（UTC）
- タスク: PBI-154
- PR: #213
- ブランチ: feat/issue-154-one-shot-run-results
- 関係する ADR: [Claude Code の実行で後で起こす予約を使わせず、結果が何回も出ても本文と使用量を正しく取る](../adr/20261024-0700-one-shot-run-results.md)

## 目的

PR のレビューのタスクの4回目の再レビューで、レビューの工程が 42 分かかり、投稿の本文が途中の要約に置き換わった（ステークホルダーの指摘）。
エージェントが `ScheduleWakeup` で後で起こす予約をし、`claude -p` が最終の答えの後も 26 分終わらず、起こされた後の返答が最後の `result` として投稿された。
あわせて、費用を最後の `result` の `usage`（その番の分だけ）で数えていたので、通知が何回も来る実行では少なく記録されていた。

誤った本文で投稿されたレビューは、セッションのログから最終の答えを取り出し、sacty の本文の組み立て（`extractReviewComments`・`buildReviewBody`・`buildReviewComments`）で作り直して、投稿し直した（ステークホルダーの指示）。

## したこと

- `apps/daemon/src/agents/invocation.ts`：Claude Code の引数に `--disallowedTools ScheduleWakeup,CronCreate,CronDelete,CronList,RemoteTrigger` を足した（`CLAUDE_DISALLOWED_TOOLS`）。`Invocation` に `preferResult` と `resumed`（セッションを再開・複製する実行）を足した。
- `apps/daemon/src/agents/parse.ts`：`ClaudeOutcomeReader` が、`prefer` を含む最後の `result` を答えにし、使用量を最後の `result` の `modelUsage` の合計（無いか、再開した実行なら各 `result` の `usage` の合計）にするようにした。
- `apps/daemon/src/agents/docker.ts`：`preferResult`・`resumed` を読み取りに渡す。
- `apps/daemon/src/service.ts`：レビューの工程の実行では、`preferResult` に、引用符で囲んだ判定の塊の見出し（`REVIEW_VERDICT_HEADING`。`prompts.ts` から公開）を入れる。
- テスト：`agents.test.ts`（引数・再開の印・本文の選び方・使用量の合計）、`agent-sessions.test.ts`（`DockerExecutor` が目印と再開の印を読み取りに渡す）、`daemon.test.ts`（レビューの工程だけ目印を渡す）。
- 仕様書（`spec/agent-execution`・`spec/tasks-and-steps`）・ユーザードキュメント（`user/config`）の日英、ADR を足した。

## 確かめたこと

- `npx vitest run apps/daemon/src/agents`：通った。直した箇所（サービスの目印・引数・本文の選び方・`modelUsage` の合計・`usage` の合計）を1つずつ戻すと、それぞれのテストが失敗することを確かめた。
- 問題の実行（`00c3cb8a`）の出力を新しい読み取りで読み直し、答えが総評と判定の塊の `result` になり、使用量がサブエージェントを含む値（キャッシュの読み出し 13,491,140 など）になることを確かめた。`result` が1つの実行（情報収集）は、これまでと同じ値だった。

## DA のセルフレビューの指摘と対応

- 再開・複製した実行の `modelUsage` には、前の実行の分も入る：小さなモデルで `claude -p` を2回続けて（2回目は `--resume`）確かめた。2回目の `modelUsage` の出力のトークン数は 9 で、1回目の 4 と2回目の `usage` の 5 の和だった。
  このままではオーケストレーターの再開・質問への答えの費用を二重に数えるので、`resumed` の実行では各 `result` の `usage` の合計にした。
- 目印が、返答の文で名前に触れただけで当たる：目印を引用符で囲んだキー（`"sacty-review-verdict"`）にし、名前に触れるだけの返答で当たらないことをテストで確かめた。
- `DockerExecutor` の受け渡しにテストが無い：`agent-sessions.test.ts` に足し、受け渡しを戻すと失敗することを確かめた。
- `npm run lint`・`npm run typecheck`：通った。`npx vitest run`：PR の番号を書いてから 2605 件すべて通った（`tests/docs` を含む）。

## レビューの指摘と対応（PR #213、sacty のレビュー。判定：提案あり）

sacty のレビューの工程が、手元で `npm ci`・lint・typecheck・`npx vitest run` を実行してレビューした（プロセスの後始末のテスト 16 件が、コンテナに init が無いことで落ちたと報告。この PR とは関係しない）。

- [提案] `modelUsage` のトークン数が読めないと、使用量が 0 になる：読める項目を持つモデルが無ければ `modelUsage` を使わないようにした。項目ごとに、各 `result` の `usage` の合計と大きいほうを取るようにした。形の崩れた `modelUsage` のテストを足した。
- [提案] 目印を渡すのがレビューの工程だけ：答えに決まった見出しの塊を必ず含める役割（最終レビュー・再現・分割・統合レビュー・情報収集）にも渡すようにした（`answerMarker`）。ADR の決定・理由・影響と仕様書（日英）を直した。
- [提案] result が何回も出て最後が失敗する場合のテストが無い：最後が `is_error: true` のとき、失敗になり、使用量が実行の全体の値（`modelUsage`、無ければ各 `usage` の合計）になることを確かめるテストを足した。
- [提案] ADR の置き換え元が無い：`20261013-1533-claude-stream-json-output.md` の「最後の `result` から出力と使用量を読む部分」を置き換えたので、`git mv` で `superseded` を付け、ステータスと置き換え先を直した。新しい ADR に置き換え元を書いた。名前の変更で切れる作業履歴（PBI-62）のリンクを直した。
- [提案] 目印に当たらず最後の result に戻ったことが残らない：目印を渡したのに当たらず、`result` が2つ以上あったときは、`result` の数と使用量の出どころを、デーモンのログとセッションログ（標準エラー）に1行残すようにした。

確かめたこと：

- 直した箇所を1つずつ戻すと、それぞれのテストが失敗することを確かめた。対象は、項目ごとに大きいほうを取る処理・読める項目の判定・知らせの条件・知らせをセッションログに残す処理・サービスの目印・役割の対応・`Object.hasOwn`。
  読める項目の判定と知らせの条件は、最初は戻しても落ちなかったので、知らせの使用量の出どころと、`result` が1つのときのテストを足した。
