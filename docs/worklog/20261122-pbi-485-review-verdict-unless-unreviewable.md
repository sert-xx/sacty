# PR のレビューの判定なしをレビューできない場合に限る

- 日付: 2026-11-22（UTC）
- タスク: PBI-485
- PR: なし
- ブランチ: main
- 関係する ADR: [PR のレビューの判定を付ける条件](../adr/20261122-1340-review-verdict-unless-unreviewable.md)

## 目的

未確認の所があっても、読めた範囲に応じた判定を伝える。

## したこと

レビューの指示と既定のスキル、日英の仕様とユーザー文書をそろえた。
判定なしの回の取り込みと直しは変えていない。

## 確かめたこと

| コマンド | 結果 |
| --- | --- |
| `npm run lint` | 成功（819 ファイル） |
| `npm run typecheck` | 成功 |
| `npx vitest run apps/daemon/src/default-skills.test.ts apps/daemon/src/prompts.test.ts apps/daemon/src/review-verdict-missing.test.ts apps/daemon/src/daemon-step-pull-requests.test.ts --no-file-parallelism` | 成功（696 件） |
| `npm test` | 成功（346 ファイル、7,086 件成功、14 件スキップ） |
| `npm run build` | 成功 |

Git の機能・実行権限・明示的に有効化する評価テストの条件により、14 件がスキップされた。

## レビューの指摘と対応

### 設計のレビュー

判定なしの回に停止の仕組みを設けない方針により、指摘を停止で失う懸念は当たらなくなった。
差分・作業領域・主対象の文書の条件を入力確認から判定までそろえた。

### この PR の最初の提出

まだ無い（最初の提出）。

## 残したこと

なし。
