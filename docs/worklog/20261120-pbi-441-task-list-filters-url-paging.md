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
- `npm run lint`（警告 0 件）・`npm run typecheck`（エラー 0 件）・`npm test`（302 ファイル、6088 件が通り、14 件はスキップ）を、最後の変更の後に実行して通した。
- 起動したアプリでは確かめていない（言語の切り替え・サイドメニューの「タスク」・3 画面以上辿って戻る、の実機の確認は人が行う）。

## レビューの指摘と対応

- `replaceState` に履歴の state を渡すと、ルーターが URL の変更を知らず、あとでクエリが消える指摘：第 1 引数を `null` にした。
- 絞り込みの最初の値がサーバーの値だけで、URL と食い違う指摘：最初の値を今の URL から作り、ルーターの検索条件が変わったときに、画面の絞り込みが今の URL と違えば URL に合わせる（行数は 50 に戻す）ようにした。サーバーの props を合図にしていた同期は消した。クエリ無しで開いて絞り込み、クエリ無しの同じ一覧へ移る場合も戻る。
