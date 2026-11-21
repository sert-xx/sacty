# タスクの一覧の最初の表示・URL の絞り込み・50 行ずつの表示

- 日付: 2026-11-20（UTC）
- タスク: PBI-441
- PR: なし
- ブランチ: sacty/task-pbi-441
- 関係する ADR: [20261120-2355-task-list-filters-in-url](../adr/20261120-2355-task-list-filters-in-url.md)

## 目的

一覧を開いたときにいま動いているタスクを出し、絞り込みを URL に残し、件数が増えても画面が長くなりすぎないようにする。

## したこと

- `task-filter.ts` に、URL の読み書き（`parseTaskFilter`・`filterQuery`）・最初の状態（`defaultStatusFor`）・クリアを出す判断を足した。
- `task-list.tsx` を、`bfcacheId` を `key` にした部品に分け、絞り込み・足した行数・最初の状態を持たせた。「さらに表示」と、区切ったときの件数の文を足した。
- ページが `searchParams` を読み、`LiveTaskList` に渡す。
- 辞書に、件数の文とボタンの文を日英で足した。利用者向けの文書・仕様書・ADR を直した。

## 確かめたこと

- `task-list-pagination.test.ts`・`page-hydration.test.ts`・`task-list.browser.test.ts`（幅 375px）・`task-list-filter.test.ts` の更新。
- 実行の結果は、PR の本文に書いた。

## レビューの指摘と対応

なし（初回の提出）。
