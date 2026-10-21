# 実行する検証が複数あれば、オーケストレーターに && でつないで1つのテストのコマンドにさせる

- 日付: 2026-10-21（UTC）
- タスク: なし
- PR: #190
- ブランチ: ccr-a1525adf-qf0jrs
- 関係する ADR: [実行する検証が複数あれば、オーケストレーターに && でつないで1つのテストのコマンドにさせる](../adr/20261021-2237-join-verification-commands.md)

## 目的

オーケストレーターがテスト（検証）のコマンドを決めるとき、テストの種類が複数ある・lint やマニフェストの検証もあるリポジトリで、
代表の1つだけを選んで、ほかの検証を確かめないまま合格にならないようにする。

## したこと

- オーケストレーターへの指示（`apps/daemon/src/prompts.ts` の `buildOrchestratorPrompt`）に、実行する検証が複数あるなら、CI・Makefile などが
  実行しているものをすべて `&&` でつないで1つの `testCommand` にし、`;` ではつながず、代表の1つだけを選ばない、という行を足した。
- テスト（`apps/daemon/src/prompts.test.ts`）に、その指示を確かめるケースを足した。
- 仕様書（`docs/spec/tasks-and-steps.md`・`.en.md` の `testCommand` の行）と ADR を足した・直した。
- `testCommand` を配列にする案は、変える範囲が広いので採らなかった（ADR の理由）。

## 確かめたこと

- `npx vitest run apps/daemon/src/prompts.test.ts tests/docs`：3 ファイル・182 件のテストが通った。
- `npx biome check apps/daemon/src/prompts.ts apps/daemon/src/prompts.test.ts`：指摘なし。
- `npx tsc -b packages/core apps/daemon packages/cli`：エラーなし。
- 実際の AI のオーケストレーターが複数の検証をつなぐかは試していない。
