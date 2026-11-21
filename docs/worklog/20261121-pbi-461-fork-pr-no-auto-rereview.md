# フォークからの PR の push では、自動で再レビューしない

- 日付: 2026-11-21（UTC）
- タスク: PBI-461
- PR: なし
- ブランチ: なし
- 関係する ADR: [フォークからの PR の push では、見守りのレビューが自動で再レビューしない](../adr/20261121-1505-fork-pr-push-is-not-re-reviewed-automatically.md)

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

- `npx vitest run`（全件）・`npx biome check --error-on-warnings .`・`npm run typecheck`：結果は、提出の前の検証の報告に書いた。
- フォークの保留の分岐を外すと、フォークの新しいテストが落ちる。

## レビューの指摘と対応

- フォークかどうかを読めないとき：自動の再レビューに倒れていたので、保留に倒す向きに直した（同じリポジトリと確かめられたときだけ従来の経路）。
- PR への知らせ：記録と投稿を分けた。目印のコメントを探して重複を防ぎ、失敗したら次の確認でやり直す。
- 先頭がレビューした先頭に戻ったとき：待ちの記録を消す。
- 画面・MCP の説明・ユーザー文書：保留中の文言と、フォークの例外を直した。知らせの本文は、取り込み方に関わらず成り立つ案内にした。
- ADR：日時を直し、PBI-411 の ADR を superseded にした。

## 残したこと

- 設定で見守りそのものを切る仕組み、見守りの読み取りのレート制限・間引きは、範囲の外。
- フォークの PR の GitHub の再依頼は、頼んだ人が PR の作者でなく書き込みの権限を持つときだけ、新しいタスクを作る（人の指摘で足した。`lastReviewRequester`・`canWrite`）。読めないときは作らず、保留と同じに扱う。
