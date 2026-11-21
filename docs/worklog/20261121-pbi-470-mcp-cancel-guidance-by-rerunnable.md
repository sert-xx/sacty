# MCP の中止の案内を、中止の後に再実行できるかで切り替える

- 日付: 2026-11-21（UTC）
- タスク: PBI-470
- PR: #542
- ブランチ: sacty が作るタスクのブランチ（作業領域では main のまま。ブランチ名は sacty が決める）
- 関係する ADR: [中止の案内を、中止の後に再実行できるかで切り替える](../adr/20261121-2300-mcp-cancel-guidance-by-rerunnable.md)

## 目的

`sacty mcp` の中止の案内が、どのタスクにも「やり直すなら再実行」と書いていた。PR のレビューのタスクなどは中止の後に再実行できないので、案内をタスクごとに切り替える（PBI-402 の PR のレビューの指摘）。

## したこと

- `rerunBlock` の状態以外の条件を `rerunKindBlock` に分け、`get_cancel_plan` の `irreversible`・`resume_task` の断りが同じ判定を使うようにした。
- 再実行できないタスクには、`rerun_task` を案内せず、「MCP からはやり直せません」と `rerunBlock` の理由・画面で決めることを案内する。中止できないタスクには、やり直しの案内を入れない。
- `cancel_task` の説明・`INSTRUCTIONS`・`gate.invalidTarget` の文を条件付きにした。
- 仕様書・ユーザー文書（日英）と ADR（既存の ADR は `superseded` に置き換え）を直した。

## 確かめたこと

- `packages/cli/src/mcp-rerun.test.ts` に、再実行できる・できない（PR のレビュー・リポジトリ未定・既定値が通らない・分割の子・再実行済み）・中止できないタスクの案内と、固定の文を確かめるテストを足した。
- 実行した検証（直しの後のコードで実行）：
  - `npm run lint`：通った。
  - `npm run typecheck`・`npm run build`：通った。
  - `npx vitest run`：338 ファイル中、336 通過・2 ファイルで 3 件が 5 秒の時間切れ（全件の負荷による。`tests/docs/docs.test.ts` の 2 件と `tests/desktop/migration.test.ts` の 1 件）。この 2 ファイルと `tests/docs` を単独で流し直すと、5 ファイル 120 件が通った。
- 案内を戻すと落ちること：`get_cancel_plan` の判定を無効にして daemon をビルドし直すと、`mcp-rerun.test.ts` の「再実行できないタスク」のテストが落ちた。戻した後は通る。

## レビューの指摘と対応

- 前置きの主語を呼び出し側が渡す形（中止の前は「中止すると」、中止の後は「中止したタスクは」）にし、片付けの文の後に案内を置いた。理由から消す句は、`rerunBlock` の理由と同じ定数にした。画面の案内の見出しは「画面で人が行うこと」にした。
- PR のレビューのケースの期待を、画面の案内が出ないことを確かめる形にした。
- テストの `describe` を入れ子から外し、トップレベルにした。
- ユーザー文書・仕様書（日英）の言い方、仕様書の `rerun_task` の節・関係する ADR を直した。

## 残したこと

- 題材ごとのテストのファイル（`mcp-cancel.test.ts`・`mcp-pause.test.ts`）への移動はしていない。判定を `rerun_task` の断りと並べて確かめるため、`mcp-rerun.test.ts` に置いた。
- `rerunKindBlock` の名前は、仕様書の記述と合わせて変えていない。
