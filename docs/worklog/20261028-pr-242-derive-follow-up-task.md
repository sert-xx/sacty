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

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- 画面のスクリーンショット（`npm run docs:screenshots`）は撮り直していない（今のスクリーンショットに、完了したタスクの詳細は写っていないため）。
