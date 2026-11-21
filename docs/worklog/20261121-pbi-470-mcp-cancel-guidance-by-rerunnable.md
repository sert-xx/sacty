# MCP の中止の案内を、中止の後に再実行できるかで切り替える

- 日付: 2026-11-21（UTC）
- タスク: PBI-470
- PR: なし
- ブランチ: main
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
