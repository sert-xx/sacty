# セキュリティ対応の行数の上限をやめ、直しでは解消できない指摘で止める

- 日付: 2026-11-21（UTC）
- タスク: PBI-452
- PR: なし
- ブランチ: sacty が作るタスクのブランチ（PR の作成時に決まる）
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
- `npm run lint`：成功（790 ファイル）。
- `npm run typecheck`（core・daemon・cli・web）：成功。
- `npx vitest run`（全件）：330 ファイル、6444 件が成功、14 件はスキップ。
- 実行していない検証：`build`、CI と同じ直列の実行（`--no-file-parallelism`）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 仕様書 `architecture` の `PAUSE_REASON_ORDER` の列挙に `needs_decision` が無い | ja・en の列挙に足した |
| 範囲の宣言が無いのに、本文とレビューの指示が「照らし、見つかりませんでした」と書く | 宣言が無ければ照合も差分の読み出しもせず、「照らした」の文を出さない（本文には新しい文を足さない） |
| マージの記録の件数が、取り込んだ投稿の数になる | 止めた回の印の付いた指摘の数にした |
| `await` の後の状態の読み直しが抜けている | `holdFeedback` は出どころの確認を読み直しの前に移し、`checkDecisionPauses` は中止・マージの停止中を読み直す |
| `diffStats` の行数と、上限があった頃の理由の記述 | 返す形を保つため残し、仕様書の理由を「照合には行の数を使わない」に直した |
| 知らせがセキュリティのタスクの確認を通っていない | セキュリティのタスクには知らせを投稿しない |
| 秘密の伏せのテストが知らせの本文・人のコメント由来の判断の文を確かめていない | 両方を確かめるテストと、`decision-notice.test.ts` を足した |
| 作業履歴の節が足りない | この節と「残したこと」を足した |
| 止まった画面の案内・取り込みの記録の複製・取り込みの上限 | この PR では直さない（案内の見せ方・整理・推測の害のため） |

## 残したこと

- 止まった画面から PR へのリンクと、判断を書く欄の案内の改善。
- `PullRequestReviewImported` の組み立ての関数化。
- 取り込みの上限に人のコメントが入りきらないときの扱い。
