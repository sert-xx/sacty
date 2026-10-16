# 要求要件・設計・実装の工程で、提出の前にセルフレビューを繰り返させ、結果を記録・表示する

- 日付: 2026-10-16（UTC）
- タスク: PBI-120
- PR: #130
- ブランチ: feat/issue-120-self-review
- 関係する ADR: [要求要件・設計・実装の工程で、提出の前に review-dispatch のセルフレビューをパスするまで繰り返させ、結果を記録して画面に出す](../adr/20261016-2354-self-review-before-submitting.md)

## 目的

成果物の品質を担保するため、要求要件・設計・実装の工程で、既定のスキル `review-dispatch` の `self-review` でセルフレビューし、パスするまで
修正とレビューを繰り返させる。結果を報告させて記録し、人が承認の前に見られるようにする。

## したこと

- daemon（`apps/daemon/src/prompts.ts`）：`selfReviewLines` を要求要件・設計・実装（標準・不具合の修正・テストの仕組みが無い）の指示に付けた。
  見出し `sacty-self-review` の報告を `extractBlocks` で読み、本文から取り除く（形が違っても取り除く）。
- core：`SelfReview`・`SELF_REVIEW_STEPS`、`AgentRunCompleted.selfReview`（null は記録なし）、投影の `selfReviews`（工程ごとの最新の提出）。
- daemon（`service.ts`）：工程の完了の記録に、セルフレビューをさせた工程だけ `selfReview` を入れる。
- web：`SelfReviewNote`（成果物のカード・実装のカード・承認の画面）、作業履歴の「実行が完了」の行、辞書（日英）。
- docs：仕様書（タスクと工程の「提出の前のセルフレビュー」）、ユーザードキュメント（タスクを進める）、ADR。英語の版も直した。

## 確かめたこと

- `npx biome check`・`npm run typecheck`・`npx vitest run`・`npm run build` が通った。
- 回帰テスト：指示（各工程のセルフレビューの行・主対象の種類・繰り返し・上限・報告の形。差し戻しのやり直しも。文書作成・調査には付けない）、
  報告の読み取り（正常・既定値・形が違う・無い）と本文からの除去（`prompts.test.ts`）、作業履歴とタスクへの記録・記録なしで止めない・やり直しで
  最新にする（`daemon.test.ts`）、表示（パス・パスしていない・記録なし・より前の記録で出さない。`self-review.test.ts`）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | |

## 残したこと

- 実機の AI がスキルに従ってセルフレビューを繰り返す様子は、この環境では確かめていない（AI の設定が無い）。スタブの AI で表示を確かめた。
