# 投稿の前に PR の先頭が変わったレビューを打ち切って始め直し、親に届かなかった回の指摘を次の回で確かめ直す

- 日付: 2026-11-21（UTC）
- タスク: PBI-465
- PR: なし
- ブランチ: main
- 関係する ADR: [投稿の前に PR の先頭が変わったレビューは打ち切って始め直し、親に届かなかった回の指摘は次の回で確かめ直す](../adr/20261121-1756-stop-unposted-review-on-head-change.md)

## 目的

再レビューの途中で PR の先頭が変わっても、その回の指摘を捨てず、同じ原因の回数に数え違えないようにする。

- フォークでない PR の、投稿していないレビュー（1 回目を含む）は、先頭が変わったら古い先頭宛てに投稿せずに打ち切り、先頭が落ち着いてから同じ回の番号で始め直す。
- PR のマージ・クローズで止めたレビューの実行を、失敗に見せずに記録する。
- 親に届かなかった回を、同じ原因の回数・提案だけの回の連続に数えず、その回の指摘を次の回で今の先頭に照らして確かめ直す。

## したこと

コード・テスト・文書・画面の表示名を変えた。

- コード：`apps/daemon/src/service.ts`（検知・打ち切り・始め直しの待ち・マージとクローズの記録・投稿の直前の打ち切り・届かなかった回の判定の結線）、`apps/daemon/src/undelivered-review.ts`、`apps/daemon/src/prompts.ts`、`apps/daemon/src/suggestion-triage.ts`、`packages/core` のイベント `ReviewRunStopped` と投影（`reviewStop`・回ごとの記録の消去）、費用の数え方。打ち切りで実行を止めている間、または止める前に人が一時停止を求めていたら、人の一時停止を優先し、`ReviewRunStopped` を記録しない（`abortReviewRun`）。始め直しの待ちの印が無い間は、初めて見た時刻から待つ（PR を読めない状態が続いても、待ちは過ぎる）。
- テスト：`apps/daemon/src/daemon-review-run-stopped.test.ts`、親の取り込みを通して届かなかった回の判定を確かめる `daemon-step-pull-requests.test.ts`・`daemon-suggestion-triage.test.ts` の各 1 件、`packages/core/src/projection.test.ts`、`apps/web/src/lib/labels.test.ts`、既存の `daemon-review-watch.test.ts`・`daemon-implement.test.ts`・`step-costs-totals.test.ts` の追従。
- 画面：作業履歴の表示名（日英）。
- 仕様書（日英）
  - `docs/spec/tasks-and-steps.md`：投稿の直前の確かめで、古い先頭宛てに `latestCommit` を付けて投稿するのをフォークからの PR に限った。節「投稿の前の先頭の変化での打ち切り」を足した（見張り・打ち切り・投影・始め直し・マージとクローズ・届かなかった回）。再レビューの範囲の絞り（PBI-432）に、届かなかった回の指摘は範囲に入れる例外を足した。
  - `docs/spec/approval.md`：PR のレビューの子タスクの打ち切りと、届かなかった回の確かめ直し、マージ・クローズで中止するときの `ReviewRunStopped` を足した。「古い head へのレビュー」に、捨てた回の指摘を子タスクの次の回が確かめ直すことを足した。
  - `docs/spec/event-log.md`：`ReviewRunStopped` の欄・記録できる状態・投影・前の版との互換を足した。イベントの種類の数を 137 に、費用を持つイベントを 20 種類に直し、表に行を足した。実行の内訳の「中断」に、打ち切った実行を足した。
- ユーザー文書（日英）：`docs/user/intake.md` に、レビューの途中の push での打ち切りと始め直し、フォークからの PR の扱い、前の版のデーモンが起動できなくなることを書いた。捨てた指摘を子タスクの次のレビューが確かめ直すことを書いた。
- ADR：`docs/adr/20261121-1756-stop-unposted-review-on-head-change.md` を足した。PBI-291 の ADR は、新しい head への AI のレビューのかけ直しをしない部分を置き換えたので、`git mv` で `20261103-0744-superseded-deliver-discarded-ai-review-to-person.md` に変え、ステータスと置き換え先を直した。旧ファイル名へのリンク（`docs/worklog/20261103-pbi-291-discarded-ai-review-delivery.md`）を直した。PBI-432・PBI-424 の ADR は変えていない。
- `docs/spec/context.md`（日英）：既定のレビュー用スキルの同じ原因の規則の説明に、`delivered` が `false` の回を数えないことを足した。
- スキル：`apps/daemon/default-context/skills/review/review-dispatch/references/aggregation.md` の「回をまたいで同じ原因が続くとき」に、`delivered` が `false` の回を数えない決まりを足した。
- イベントの種類の数は、直す前の文書が 134 で、HEAD のコードの `EventInput` は 136 種類だった。今のコードの数え（137）に合わせた。

## 確かめたこと

- 最後の変更の後に実行した（結果はそのときのもの）：
  - `npx vitest run`（全件）：335 ファイル・6666 件が通り、14 件はスキップだった。
  - `npm run lint`（`biome check --error-on-warnings .`）：801 ファイルを検査して通った。
  - `npm run typecheck`（`tsc -b packages/core apps/daemon packages/cli && npm run typecheck -w @sacty/web`）：通った。
- service・prompts・投影・届かなかった回の判定の変更を 1 つずつ外すと、新しいテストが落ちることも確かめた。
- `npx vitest run tests/docs apps/daemon/src/default-skills.test.ts`：5 ファイル・217 件が通った。
- `grep -rn "20261103-0744-deliver-discarded-ai-review-to-person"`（`node_modules`・`.git` を除く）：旧ファイル名への参照が残っていないことを確かめた。
- 書いた振る舞いを、次のコードと突き合わせた：`apps/daemon/src/service.ts` の `checkReviewPullRequests`・`checkReviewHead`・`abortReviewRun`・`recordReviewRunStopped`・`recordableReviewStop`・`reviewSettlingNow`・`composeReviewPost`・`cancel`、`packages/core/src/events.ts` の `ReviewRunStopped`、`packages/core/src/projection.ts` の `ReviewRunStopped`・`ReviewTargetResolved`・`ReviewRestarted`、`packages/core/src/cost.ts` の `CHARGED_EVENT_TYPES`、`apps/web/src/lib/step-costs.ts`、`apps/daemon/src/undelivered-review.ts`、`apps/daemon/src/prompts.ts` の `rereviewLines`、`apps/daemon/src/suggestion-triage.ts` の `countSuggestionRounds`。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 人の一時停止が打ち切りと重なると消える（implement-1-2、implement-3-1） | 打ち切りより先の一時停止の要求も人の要求として残すようにし、テスト `TV-14（人の操作を優先・人が先）` を足した |
| 待ちの印が無い間に始め直しが止まる（implement-1-3） | 印が無い間は、いま見た時刻から待つ。仕様書の記述も実装に合わせた |
| 届かなかった回の結線のテスト（implement-1-1） | 親の取り込みを通す 2 件を足した |
| 打ち切りより先・打ち切りの間の人の一時停止（implement-4-1） | 順序 A（人が先）・B（止めている間）・B'（止めた実行が失敗で返った後の確認の間）の 3 件のテストで、`ReviewRunStopped` を記録せず人の一時停止にすることを確かめた。B' は、`abortReviewRun` の人の一時停止の分岐で `running` も記録する直しを外すと落ちることを確かめた（A は `abortReviewRun` の人の要求の扱いを外すと落ちる。B は `kill` の中で `pause()` を呼ぶ形で、止める最中を確かめる） |
| テストのファイル名（implement-1-4） | `daemon-review-run-stopped.test.ts` に変え、CONTRIBUTING.md の表に行を足した |

## 残したこと

- 順序 B'（止めた実行が失敗で返った後に人が一時停止）：`running` のままなら、費用を `AgentRunFailed` に残してから人の一時停止にする。

- CI と、ブラウザのテスト、build は実行していない。マージの前に PR のチェックで確かめる。
