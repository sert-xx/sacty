# sacty mcp に承認を足す

- 日付: 2026-11-19（UTC）
- タスク: PBI-396
- PR: なし
- ブランチ: sacty/task-<タスク ID の先頭8文字>
- 関係する ADR: [sacty mcp の承認は、画面の「承認する」と同じ API に限り、PR のマージは入れない](../adr/20261119-0300-mcp-approve-with-screen-api-not-merge.md)

## 目的

手元の AI が、利用者に頼まれたときに、画面の「承認する」と同じ承認を MCP からできるようにする。
`sacty mcp` に機能を1つずつ足す流れの3回目（1回目は作成、2回目は成果物と実行の読み取り）。PR のマージ・差し戻しなどは範囲外。

## したこと

- `apps/daemon/src/task-mcp.ts`：ツール `approve_step` を `TOOLS` の最後に足した（既存の8つの引数・結果・説明は変えていない）。`SactyApi` に `approve` を足し、`approvalOf`（承認待ちの工程・回・手段）を作って、タスクの要約に承認待ちのときだけ `approval` を足した。`INSTRUCTIONS` にも足した。
- `packages/cli/src/mcp.ts`：`approve`。先に `GET /api/tasks/:id`（消したプロジェクトのタスクを断る）、続けて `POST /api/tasks/:id/approve`。古い回の理由だけ、MCP 向けの文にした。結果を受け取れなかったときの案内（`APPROVE_UNCERTAIN`）を付けた。
- `packages/cli/src/index.ts`：`sacty mcp` の使い方の表示に承認を足した。
- デーモン（`service.approve`・`gateTask`・`server.ts`）・画面・`messages.ts` は変えていない。
- 仕様書（`docs/spec/mcp-server.md`）・ユーザードキュメント（`docs/user/mcp.md`・`cli.md`）の日英、ADR、この作業履歴、`CONTRIBUTING.md` のテストの表。

## 確かめたこと

- `npx vitest run --no-file-parallelism`（全件）・`npm run lint`・`npm run typecheck`・`npm run build`・`npx biome format .`。結果は PR の本文に書いた。
- `apps/daemon/src/task-mcp.test.ts`：本物のサービスと `createApp` で、承認できる（記録1件）・2回目は断る・古い回・違う工程・承認待ちでない・無いタスク・PR のマージで承認する工程（URL・何も変わらない）・引数の形の違い・結果を受け取れない・ツールの一覧。
- `packages/cli/src/mcp.test.ts`：呼ぶ API・消したプロジェクトのタスク・理由の文・時間切れ／切断／5xx の案内・401／接続拒否／前の版のデーモン。

## 既定で決めたこと

- ツールの名前は `approve_step`。
- 上限を超えた差し戻しの判断待ち（`escalated`）は、画面と同じく承認できる。
- 結果を受け取れなかったときは、5xx も「承認された可能性」にした（`create_task` と同じ）。

## 残したこと

- PR のマージ（GitHub への書き込み）。入れるかは人が決める。
- 差し戻し・変更の申し出への決定・質問への回答・一時停止／再開／中止・待つこと・ログの取得は、後続。
