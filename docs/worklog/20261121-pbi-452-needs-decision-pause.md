# セキュリティ対応の行数の上限をやめ、直しでは解消できない指摘で止める

- 日付: 2026-11-21（UTC）
- タスク: PBI-452
- PR: なし
- ブランチ: なし
- 関係する ADR: [セキュリティ対応の変更行数の上限をやめ、レビューが直しでは解消できないと印を付けた指摘で止めて、人の判断を待つ](../adr/20261121-2000-pause-on-findings-a-rework-cannot-resolve.md)

## 目的

行数の上限が原因で往復が止まらない状況をなくす。直しでは解消できないとレビューが示した指摘は、人の判断を待つ。

## したこと

- `security.ts`：行数の上限・ロックファイルの一覧を削除。違反は範囲の外のファイルだけ。記録の `max` は前の版が読める固定値。
- 指示・PR の本文・画面の文言から、行数の上限を除いた。宣言が無いときの文は、実装とレビューの指示だけに足した。
- 判定のブロックの `needs_decision`、止める処理（`needsDecisionOf`・`checkDecisionPauses`）、PR への知らせ（`decision-notice.ts`）、再開・マージ・人の判断の引き継ぎを足した。
- 既定のスキル `pr-review.md` と観点 C-17 を直した。

## 確かめたこと

- 結合のテスト：`needs-decision.test.ts`、`daemon-design-edit.test.ts`・`daemon-step-pull-requests.test.ts` の PBI-452 の節、`daemon-deployment-security.test.ts`、`security.test.ts`、`projection.test.ts`。
- 画面：`apps/web/src/components/needs-decision.test.ts`、`labels.test.ts`。
- `npm run lint`・型検査・`vitest` の全件。
