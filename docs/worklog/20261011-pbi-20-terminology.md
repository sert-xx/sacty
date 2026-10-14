# 用語を統一する（チケット→タスク、台帳→作業履歴）

- 日付: 2026-10-11（UTC）
- タスク: PBI-20
- PR: #26
- ブランチ: feat/issue-20-terminology
- 関係する ADR: [「チケット」を「タスク」に、「台帳」を「作業履歴」（英語は Activity）に統一し、コードの名前・API・テーブルも合わせる](../adr/20261011-0913-terminology-task-and-activity.md)

## 目的

動作確認でのフィードバックを受け、「チケット」を「タスク」に、「台帳」を「作業履歴」（英語は Activity）に統一する。画面・文書だけでなくコードの名前も変える。既存のデータは引き続き読めるようにする。

## したこと

- 画面・文言：作成ボタンを「タスクを作成」、作業履歴の1行目を「タスクを作成（人間）」、タスクの詳細の欄を「内容」、記録の欄を「作業履歴」にした（`apps/web/src/i18n/messages/` ほか）。エージェントへの指示も「--- タスク ---」などにした（`apps/daemon/src/prompts.ts`）。`README.md` の「台帳」も直した。
- コードの名前：`createTicket`・`CreateTicketInput`・`TICKET_*_MAX` を `createTask`・`CreateTaskInput`・`TASK_*_MAX` に、`LedgerEvent`・`LedgerStore`・`SqliteLedgerStore`・`LedgerIntegrityError` を `Activity*` に、`apps/daemon/src/ledger.ts` を `apps/daemon/src/activity.ts` に、`new-ticket-dialog.tsx` を `new-task-dialog.tsx` に、`POST /api/tickets` を `POST /api/tasks` に、タスクの API の応答の `ledger` を `activity` にした。
- 既存のデータとの互換：作業履歴のテーブルを `ledger` から `activity` に変え、起動時に以前のテーブルの名前を変える（行と seq の続きを引き継ぎ、索引とトリガーを作り直す）。画面で作ったタスクの開始地点は `sacty` と記録し、以前の `ticket` は `sacty` として読む。記録済みの文の「チケット」は、追記専用なので残した。

## 確かめたこと

- テスト：280件が通った。以前の `ledger` のテーブルを引き継ぐテストを足した（行と seq の続き、`ticket` の読み替え、古いトリガーが残らないこと、追記専用のままであること）。移行・`ticket` の読み替え・古いトリガーの削除を外すと、このテストが失敗することを確かめた。
- リント・型チェック・ビルドが通った。
- 利用者の環境（`~/.sacty`）の作業履歴の写しで確かめた。元のファイルは読み取り専用で開き、写しの側だけを移行した。26件をそのまま引き継ぎ、2つのタスクの状態を復元できた。写しで画面を起動し、「タスクを作成」「内容」「作業履歴」と出ることを確かめた。
- `ticket`・`ledger`・チケット・台帳で検索し、残っているのは互換のために意図して残した箇所だけであることを確かめた。
- レビューで、`npm test`（280件）・`npm run lint`・`npm run typecheck` が通った。レビューでは、実データでの移行とブラウザでの表示は確かめていない。

## レビューの指摘と対応

指摘は無かった（承認のみ）。

## 残したこと

なし
