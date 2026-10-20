# 中止したタスクを、詳細の「再実行」から最初からやり直せるようにする

- 日付: 2026-10-20（UTC）
- タスク: なし
- PR: #173
- ブランチ: ccr-b026098c-jny1qi
- 関係する ADR: [中止したタスクは、元のタスクを引き継いだ新しいタスクを作って最初からやり直す](../adr/20261020-1111-rerun-cancelled-task.md)

## 目的

中止したタスクを、情報を補ってやり直したい。チケットから取り込んだタスクは、中止したタスクが残っていると再トリアージされないので、
中止したタスクの詳細から、リポジトリ（無しも）・補足・イメージを直して最初からやり直せるようにする（ステークホルダー）。

## したこと

- core（`packages/core/src/events.ts`・`projection.ts`・`messages.ts`）：`TaskCreated` に `rerun`（元のタスク・イメージ）、入力 `RerunTaskInput`、
  `rerunEditableBody`、`imageSource` の `rerun` を足した。投影で元のタスクに `rerunBy` を記録し、中止していない・再実行済みのタスクの再実行を
  受け付けない。`canRerun` を足し、`awaitingTicketTriage`・`isRepoless`・`awaitingRepository` で再実行のチケットのタスクを扱う。文言のコードを足した。
- デーモン（`apps/daemon/src/service.ts`・`prompts.ts`・`server.ts`）：`rerunTask`（リポジトリとイメージを確かめ、チケットを引き継いだ新しいタスクを作る）、
  `buildRerunBody`（補足と前の試行の記録）、`POST /api/tasks/:id/rerun`。`pinnedImage` が再実行のイメージを優先し、`chooseRepository` は再実行の
  チケットのタスクをリポジトリ無しのタスクの選び方にする。
- 画面（`apps/web`）：中止したタスクの詳細に「再実行」のボタンとダイアログ（`rerun-dialog.tsx`）、再実行の元・再実行したタスクへのリンク、
  作業履歴とイメージの選んだ元の表示、日英の文言。
- テスト：`daemon.test.ts`（再実行・記録・1度だけ・イメージ・断る入力・API・チケットのタスク）、`projection.test.ts`、`rerun-dialog.test.ts`。
- 仕様書（`tasks-and-steps`）とユーザードキュメント（`tasks`）の日英、ADR を足した。

## 確かめたこと

- `npm run lint`・`npm run typecheck`：通過。
- `npx vitest run`：追加したテストを含めて通過。ただし、この環境（root で動くコンテナ）では、`host-mcp-processes.test.ts`・
  `agent-sessions.test.ts`・`context-mcp.test.ts` の 8 件が、変更の前のコミットでも同じく失敗する（プロセスと読めないファイルの扱い）。
- 実際のデーモンと画面を動かしての確認はしていない（手元に AI の認証と JIRA が無い）。

## レビューの指摘と対応（PR #173、Codex の DA レビュー）

| 指摘 | 対応 |
| --- | --- |
| [提案] 再実行のダイアログに最大の高さと縦のスクロールが無く、狭い画面・文字の拡大で見出しと操作が画面の外に出る | `rerun-dialog.tsx` の `DialogContent` に `max-h-[calc(100dvh-2rem)] overflow-y-auto` を付けた |
| [提案] 予算の設定のキーは `budget_per_task_usd` ではなく `budget.default_per_task_usd` | 仕様書（日英）を正しいキーに直し、再実行のタスクを作った時点の設定値で、元のタスクの上限は引き継がないと書いた |
| [提案] `clip` が UTF-16 のコード単位で切るので、境界でサロゲートペアが壊れる | `clip`（`apps/daemon/src/prompts.ts`）で、切る位置がペアの途中なら1つ前で切るようにし、`prompts.test.ts` にテストを足した |

対応の後、`npm run lint`・`npm run typecheck`・`prompts.test.ts`・`rerun-dialog.test.ts`・`tests/docs`（174 件）・`daemon.test.ts`（632 件）が通過。
