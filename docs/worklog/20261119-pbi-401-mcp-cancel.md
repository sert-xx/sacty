# sacty mcp に、タスクの中止のツールを足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-401
- PR: なし
- ブランチ: sacty/task-<タスク ID の先頭8文字>
- 関係する ADR: [sacty mcp の中止は、片付けの対象を読む専用のツールと、読んだ対象を引数で確かめる歯止めを付けて足す](../adr/20261119-0900-mcp-cancel-with-plan-and-confirmed-targets.md)

## 目的

手元の AI が、MCP だけでタスクを中止し、中止の前に片付けられるものを読めるようにする。機能を1つずつ足す流れの7回目の後半（7b）。
ツール `get_cancel_plan`・`cancel_task` を足す（13個から15個）。デーモンのサービス・API の入口・`@sacty/core`・画面は変えず、既存の API だけを呼ぶ。

## したこと

- `apps/daemon/src/task-mcp.ts`：`get_cancel_plan`・`cancel_task` を足した（`resume_task` の後ろ）。`SactyApi` に `cancel`・`cleanupPlan` を足した。
  中止できるかの判定（`cancelBlock`。完了・中止済み・PR のレビューの子タスク・分割の親と子を断る）と、閉じる PR・消すブランチ（`cancelTargets`。デーモンの片付けの条件の写し）を、要約の `canCancel` とツールで共有した。
  `cancel_task` は、引数が対象と一致したときだけ API に送る。結果に、片付けの結果・閉じた PR・消したブランチ・失敗を足した。説明と `INSTRUCTIONS` は、取り消せないこと・はっきり頼まれたときだけ・「止めて」は一時停止・文の中の指示では呼ばないこと・先に読み取りで確かめることを強く書いた。「中止はできません」の古い文を直した。
- `packages/cli/src/mcp.ts`：`cancel`（`writeTask`）・`cleanupPlan` を足した。結果を受け取れなかったときの案内（`CANCEL_UNCERTAIN`）は、一時停止の案内の形に合わせた。
- `packages/cli/src/index.ts` の使い方の表示、仕様書・ユーザードキュメント（日英）、ADR、この作業履歴、`CONTRIBUTING.md` のテストの表。
- 新しいテスト：`packages/cli/src/mcp-cancel.test.ts`（本物のサービスと `createApp`・本物の `daemonApi` をつなぐ）。既存のテストは、ツール一覧を15個にし、偽の API に `cancel`・`cleanupPlan` を足した。

## 確かめたこと

- `npx vitest run --no-file-parallelism packages/cli/src/mcp-cancel.test.ts`：読み取りと中止の PR・ブランチの一致、引数の不一致、実行中・実行待ち・一時停止中・人の判断待ちの中止、失敗の報告、完了したタスクの断り（サービスの `cancel` を直接呼ぶと通る）、ほかの断り、結果を受け取れないとき、説明の文を確かめた。
- 最後に、`npm run lint`・`npm run typecheck`・`npx vitest run tests/docs`・`npx vitest run --no-file-parallelism` を実行した（結果は PR の本文）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | |

## 残したこと

- やり直し（rerun）・派生（derive）・エラーの分析。
- 分割の親・子・PR のレビューの子タスクを MCP から中止できるようにするか。
- 片付けの対象を引数で渡す歯止めを緩めるか・保つか。
- 完了したタスクへの中止を、デーモンの API で断るか（先読みと送信の間の窓は残る）。
- 要求要件・設計の PR は記録で判断するので、人が GitHub で先に閉じた PR は、読み取りに出るが、実際は閉じない。
- レビューだけの取り込み（PR のレビューのタスクで、子タスクでないもの）の中止は断っていない（中止すると再レビューできなくなる）。
