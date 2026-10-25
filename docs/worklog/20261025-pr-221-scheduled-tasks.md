# スケジュールタスク（決めた内容のタスクを、決めた予定で作る）を足す

- 日付: 2026-10-25（UTC）
- タスク: なし
- PR: #221
- ブランチ: claude/scheduled-task-feature-2om9q6
- 関係する ADR: [スケジュールタスクは、逃した予定のうち直前の1回だけを、使えるようになったときに作る](../adr/20261025-1130-scheduled-task-catch-up.md)

## 目的

決めた内容のタスクを、決めた予定で作る機能を足す。新しい画面を作り、サイドメニューにアイコンを足す。
sacty はローカルで動くので、予定の時刻に PC が使えない・ネットにつながらないときは、復帰したときに直前の予定の分を作る。
逃した回が複数あっても、タスクを複数作らない。
作成の画面はタスクの作成のダイアログと同じ設定ができ、編集で内容・予定・設定を変えられ、詳細でそのスケジュールタスクが作ったタスクを一覧する。

## したこと

- `packages/core/src/schedules.ts`：予定の決め方（毎日・毎週・毎月）・作るタスクの内容・入力の検査と、直前・次・作るべき回の計算を足した。
  `messages.ts` に文言のコード `schedule.*` を足した。
- `packages/core/src/events.ts`・`projection.ts`：`TaskCreated` の `start` に `schedule` を、`schedule`（スケジュールタスクの ID と予定の時刻）を足した。
- `apps/daemon/src/schedules.ts`：保存先（`schedules` テーブル）・`ScheduledTasks`（作成・編集・削除・確認）・`ScheduleRunner`（起動のときと1分ごと）・ネットの確認を足した。
- `apps/daemon/src/service.ts`：タスクの作成の検査を `prepareTask`・`prepareTemplateTask` に分け、スケジュールタスクの検査と作成（`checkScheduledTask`・`createScheduledTask`）で使う。
- `apps/daemon/src/server.ts`・`main.ts`：API（`/api/projects/:id/schedules`・`/api/schedules/:id`）と、確認の開始・停止。プロジェクトの削除でスケジュールタスクも消す。
- `apps/web`：サイドメニューの「スケジュール」、一覧と詳細の画面、作成・編集・削除のダイアログ、サーバーアクション、文言（日英）。
  タスクの作成のダイアログの項目を `TaskFields` に分け、スケジュールタスクのダイアログでも使う。
- 仕様書（`docs/spec/scheduled-tasks.md` を足し、`tasks-and-steps.md`・`architecture.md` を直した）・ユーザードキュメント（`docs/user/scheduled-tasks.md`）を英語の版とともに足した。

## 確かめたこと

- `npx vitest run packages/core/src/schedules.test.ts apps/daemon/src/schedules.test.ts`：通過（予定の計算、逃した回は直前の1回だけ、二重に作らない、ネットにつながらない間は作らない、保存の前に止まったときに作り直さない、テンプレート、保存のときの検査、編集・停止・再開、作れない内容、API）。
- `npm run typecheck`・`npm run lint`：通過。
- `npx vitest run`：スケジュールタスクに関係するものは通過。次の失敗は、変更の前（main）でも同じく失敗する環境によるもの（コンテナを root で動かしている・プロセスの扱い）：
  `agent-sessions.test.ts`（読めないファイル）、`context-mcp.test.ts`（層の写しの失敗）、`host-mcp-processes.test.ts`（実際のプロセスの後始末 6 件）、`question-form.browser.test.ts`。
