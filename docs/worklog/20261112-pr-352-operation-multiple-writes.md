# 単発作業（operation）の指示から書き込みの回数の上限をなくし、同じ書き込みの再送だけを禁じる

- 日付: 2026-11-12（UTC）
- タスク: なし
- PR: #352
- ブランチ: claude/elegant-einstein-yrsoa4
- 関係する ADR: [単発作業（operation）の書き込みに回数の上限を設けず、同じ書き込みの再送だけを禁じる](../adr/20261112-1524-operation-allows-multiple-writes.md)

## 目的

Slack の親の投稿とスレッドへの返信が要るスキルを operation で実行すると、固定の指示「書込要求は1回だけ」と食い違い、投稿せずに失敗していた。
依頼に要る複数の書き込みを許し、失敗・結果不明の後の同じ書き込みの再送だけを禁じる。

## したこと

- `apps/daemon/src/prompts.ts`（`buildPrompt` の `operation`）：「書込要求は1回だけです」を、依頼に要る書き込みはすべて行う（回数の上限は無い）、同じ書き込みは1回だけ、エラー・タイムアウト・結果不明の後は再送せず残りもせずに、済んだもの・済んでいないものを失敗として報告する、に変えた。
- `apps/daemon/src/prompts.test.ts`：指示の文言のテストを足した。
- 仕様書 `docs/spec/tasks-and-steps.md`・`docs/spec/tasks-and-steps.en.md` の operation の指示の説明を直した。
- ADR を足した。

## 確かめたこと

- `npx vitest run apps/daemon/src/prompts.test.ts tests/docs`：追加したテストと docs のテストは通った。
  既存の時間計測のテスト（「空白の無い長い URL の並びの出力も、長さに比例する時間で項目にする」）は、この環境では変更前のコードでも約1.1秒かかり、1秒の上限を超えて落ちた（今回の変更とは関係しない）。
- `npx biome check apps/daemon/src`・`npm run typecheck`：通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | |

## 残したこと

なし
