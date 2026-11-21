# フォークからの PR の push では、自動で再レビューしない

- 日付: 2026-11-21（UTC）
- タスク: PBI-461
- PR: なし
- ブランチ: なし
- 関係する ADR: [フォークからの PR の push では、見守りのレビューが自動で再レビューしない](../adr/20261121-2200-fork-pr-push-is-not-re-reviewed-automatically.md)

## 目的

見守り中のレビューのタスクが、フォークからの PR の push・作者の返信で、人の判断なしに再レビュー（PR のコードの実行）を始めないようにする。

## したこと

- `apps/daemon/src/github.ts`：PR の状態の答えに `fork` を足した。
- `apps/daemon/src/service.ts`：`watchReview` で、フォークの PR は `holdForkRestart` に回し、再レビューを始めない。
- `packages/core`：イベント `ReviewRestartHeld` と、タスクの `reviewHold` を足した。
- `apps/daemon/src/review-fork-hold-notice.ts`：PR への知らせの本文。
- 画面（`ReviewWatchNotice`・作業履歴の行）と MCP の `review.heldCommit`。
- 仕様書・ユーザー文書（日英）、ADR、テスト。

## 確かめたこと

- `npx vitest run tests/docs` と、変えたコードのテスト。
