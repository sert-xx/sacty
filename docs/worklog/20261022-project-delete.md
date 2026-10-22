# プロジェクトの設定の「危険な操作」から、プロジェクトを削除できるようにする

- 日付: 2026-10-22（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/youthful-brown-b4hr9a
- 関係する ADR: [プロジェクトの削除は定義だけを消し、終わっていないタスクがあれば拒否する](../adr/20261022-2338-project-delete-keeps-tasks.md)

## 目的

プロジェクトを削除できなかったので、プロジェクトの設定の画面に「危険な操作」として削除を置く。

## したこと

- `apps/daemon/src/projects.ts`：`ProjectStore` に `delete` を足した（SQLite とメモリーの両方）。
- `apps/daemon/src/service.ts`：`deleteProject` を足した。終わっていないタスク、または実行中・実行待ちの処理（`inflight`・
  `queuedTaskIds`）があるタスクがあれば `project.hasActiveTasks`（件数）で拒否する。消したら、そのプロジェクトの秘密情報の警告を消し、
  実行待ちの数え直し（`trackQueue`）をする。
- `apps/daemon/src/server.ts`：`DELETE /api/projects/:id` を足した（無ければ 404、拒否は 409）。
- `packages/core/src/messages.ts`：`project.hasActiveTasks` の文言を日本語と英語で足した。
- `apps/web/src/lib/daemon.ts`（`deleteProject`）・`apps/web/src/app/actions.ts`（`deleteProjectAction`）：名前の一致を確かめてから
  削除し、プロジェクトの一覧へ移る。
- `apps/web/src/components/delete-project.tsx`：「危険な操作」の欄と確認のダイアログ（名前を入力したときだけ削除のボタンを押せる）。
  プロジェクトの設定の画面（`apps/web/src/app/projects/[id]/settings/page.tsx`）の最後に置いた。
- 文言（`apps/web/src/i18n/messages/projects.ts`）を日本語と英語で足した。
- 仕様書（`docs/spec/architecture.md`）とユーザードキュメント（`docs/user/project-settings.md`・目次）を、英語の版も直した。

## 確かめたこと

- `npx vitest run apps/daemon/src/daemon.test.ts -t "プロジェクトの削除"`：2件とも通った（拒否・中止の後の削除・タスクが残ること・SQLite の削除）。
- `npm run typecheck`・`npx biome check .`：誤りなし。
- `npx vitest run`：2552件が通り、9件が失敗した。失敗は `agent-sessions`・`context-mcp`・`context`・`host-mcp-processes` のテストで、
  変更を戻した状態でも同じ9件が失敗する（この作業の環境で root として実行しているため、読めないファイルやプロセスの扱いが違う）。
- `scripts/docs-screenshots/capture.mjs` の写し（撮る画面だけを変えたもの）で、架空のデータの `sacty up` を起動し、プロジェクトの設定の
  画面の最後に「危険な操作」が出ること、確認のダイアログで名前を入力すると削除のボタンを押せること、終わっていないタスクのある
  プロジェクトでは削除せずに件数を添えた理由が出ることを確かめた。削除した後に一覧へ移ることは、画面では確かめていない。

## 残したこと

- 消したプロジェクトのタスクと作業履歴を消す操作は作っていない（ADR のとおり残す）。
