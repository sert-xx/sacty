# sacty mcp に、タスクの状態が変わるまで待つツールを足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-399
- PR: なし
- ブランチ: なし
- 関係する ADR: [sacty mcp の待つツールは、デーモンに待つ API を足さず MCP の層で取りに行き、人の出番だけで起こす](../adr/20261119-0700-mcp-wait-for-task-poll-in-mcp-layer.md)

## 目的

手元の AI が、MCP だけで「人の出番」（承認待ち・人の判断待ち・一時停止・完了・中止・PR のレビューの判定）まで待てるようにする。機能を1つずつ足す流れの6回目。
読むだけのツール `wait_for_task` を1つ足す（10個から11個）。デーモンは変えず、MCP の層で `GET /api/tasks/:id` を数秒おきに呼ぶ。

## したこと

- `apps/daemon/src/task-mcp.ts`：`wait_for_task`（`task_id`・`timeout_seconds`・`cursor`）を足した。要約（`summarizeTask`）の欄を前の値と比べ、人の出番の変化だけで起こす。子（`reviewTasks`、新しい方から 5 件）も引き、状態・回・投稿・判定の変化で起こす。
  既定 30 秒・最大 50 秒・間隔 5 秒・指定した時間＋5 秒で必ず返る。`cursor` は比べる欄の値だけを符号化する。取り消しの信号（`ctx.mcpReq.signal`）と、サーバーの終了の信号を、ツールの処理に渡した。時計は `startTaskMcp` の `clock` で差し替えられる。
  `INSTRUCTIONS` には足すだけ。既存の10個のツールは変えていない。
- `packages/cli/src/mcp.ts`・`packages/cli/src/context-preview.ts`：`getTask` に省ける期限・取り消しの引数、`daemonRequest` に省ける `signal`（`AbortSignal.any`）を足した。渡さなければ、これまでと同じ。
- デーモンのサービス・API の入口・`@sacty/core`・画面は変えていない（新しい API の呼び出しなし）。
- 仕様書・ユーザードキュメント（日英）、ADR、この作業履歴、`CONTRIBUTING.md` のテストの表、`sacty mcp` の使い方の文・CLI の文書。

## 確かめたこと

- `npx vitest run apps/daemon/src/task-mcp-wait.test.ts packages/cli/src/mcp.test.ts apps/daemon/src/task-mcp.test.ts`：時計と待ちを差し替えたテスト。本物のサービスと `createApp` を通した承認待ち・完了、一時停止・人の判断待ち・中止、子のレビュー、動いているだけで起きないこと、時間切れと上限、応答しないとき、`cursor`、取り消しと閉じたときの後片付け、ほかのツールが待ちの間に答えること、既存の10個のツールの一覧が変わらないことを確かめた。
- 全体の検査（format・lint・typecheck・テスト全件）の結果は、実装の説明に書いた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 既定で決めたこと

- `blocked`・`waiting_children` は、人の出番ではないので、動いている側（`active`）に入れる。
- 間隔は 5 秒（画面の 3 秒より長い。子も引くため）。1回の問い合わせは 10 秒まで、子は 5 件まで。
- 引けなかった子は、前の値と比べず、`cursor` には前に分かっていた値を残す。

## 残したこと

- デーモンの待つ API・押し出し、作業履歴の差分の取得、複数のタスク・プロジェクトを待つこと、分割の子の変化で起こすこと、費用のしきい値で起こすこと、進捗の通知。
