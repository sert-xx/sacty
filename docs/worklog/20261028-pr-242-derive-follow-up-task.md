# 完了したタスクから、続きのタスクを作れるようにする（派生）

- 日付: 2026-10-28（UTC）
- タスク: なし
- PR: #242
- ブランチ: ccr-9499358d-6sfr1y
- 関係する ADR: [完了したタスクから、元のタスクを指す続きのタスクを何度でも作れるようにする（派生）](../adr/20261028-0054-derive-follow-up-task.md)

## 目的

完了したタスク（セキュリティチェック・調査・実装など）の成果をもとに、見つかったものの対応や追加の改善を、別のタスクとして
作れるようにする。元のタスクは変えず、1つのタスクから何度でも作れるようにする。

## したこと

- core：`TaskCreated` に `derivedFrom` を足し、入力 `DeriveTaskInput`・見出し `DERIVE_RECORD_HEADING` を足した。
  投影で、元のタスクに `derivedTasks` を記録し、完了していないタスクからの派生を受け付けない（`canDerive`）。
  文言のコード `derive.notCompleted`・`derive.securityPlanRequired`・`input.bodyRequired` を日英で足した。
- daemon：`TaskService.deriveTask`（リポジトリ・進め方の確かめ、セキュリティのタスクの進め方の制限）と、説明に元のタスクの記録を
  足す `buildDeriveBody` を足した。`POST /api/tasks/:id/derive` を足した。
- web：完了したタスクの詳細に「続きのタスク」のカード（作ったタスクの一覧と作るダイアログ。`derive-dialog.tsx`）を足し、
  続きのタスクの詳細の先頭に元のタスクへのリンクを出した。作業履歴の行に、続きのタスクであることを出した。
- docs：仕様書（タスクと工程）・ユーザードキュメント（タスクを進める）の日英、ADR を足した。

## 確かめたこと

- `npx biome check .`：指摘なし
- `npm run typecheck`：エラーなし
- `npm run build`：成功
- `npx vitest run apps/daemon/src/daemon.test.ts -t 派生`・`packages/core/src/projection.test.ts -t 派生`・`apps/web/src/components/derive-dialog.test.ts`：すべて合格
- `npx vitest run`（`tests/docs` を含む）：2862 件合格・8 件不合格。不合格は `host-mcp-processes.test.ts`・`agent-sessions.test.ts`・
  `context-mcp.test.ts`・`question-form.browser.test.ts` で、変更を退避した状態でも同じく不合格になる（作業した環境が root で
  動いていることなどによるもので、この変更とは関係しない）

レビューの対応の後に確かめ直したこと：

- `npm run lint`：指摘なし（491 ファイル）
- `npm run typecheck`・`npm run build`：エラーなし
- `npx vitest run`：2868 件合格・8 件不合格（不合格は上と同じ4ファイルで、変更を退避しても不合格）

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| [要修正] 元のタスクの記録を足して説明が 10000 文字を超えると、派生タスクを中止した後、再実行の画面の初期値のまま送れない | `rerunEditableBody` が元のタスクの記録（`derivedRecord`）を除くようにし、`rerunTask` が人の説明の後に記録を付け直すようにした。元のタスクが今も派生できるなら `derivedFrom` も引き継ぐ。長い記録のタスクで再実行できることをテストした |
| [提案] チケット・取り込み元・PR・最終レビュー・質問と答えを持つタスクからの記録と、取り込み元を引き継がないことを確かめていない | `buildDeriveBody` の単体テスト（チケット・取り込み元・実装と要求要件の PR・最終レビュー・成果の切り詰め・質問と答え）と、Issue から取り込んだタスクから派生しても `source`・`ticket` を持たないことのテストを足した |
| [提案] 派生タスクの題のために、1件ずつ詳細（作業履歴を含む）を取っている | タスクの一覧（`listTasks`）を1度だけ取って題を引くようにした（子タスクの題と同じ取り方。作業履歴は取らない） |
| [提案] 別のプロジェクトからの派生の拒否を独立して確かめていない | 完了した元のタスクに、別のプロジェクトの派生のイベントを適用して拒否するテストを足した（プロジェクトの比較を消すと失敗することを確かめた） |
| [提案] ダイアログの入力・選択肢・送信を確かめていない | jsdom でダイアログを開いて操作するテストを足した。送信の失敗で戻ると進め方の選択が消える不具合が見つかったので、選択欄を非制御にし、戻した値で付け直すようにした |
| [提案] `npm run lint` が import の並び順で失敗する | 並び順を直した。最初の PR の本文で lint を「指摘なし」と書いたのは誤りだった（`projection.test.ts` を直した後に lint を流し直していなかった） |

## 残したこと

- 画面のスクリーンショット（`npm run docs:screenshots`）は撮り直していない（今のスクリーンショットに、完了したタスクの詳細は写っていないため）。
