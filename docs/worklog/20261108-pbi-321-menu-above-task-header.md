# ヘッダーのメニューが、タスク詳細の見出しの下に隠れないようにする

- 日付: 2026-11-08（UTC）
- タスク: PBI-321
- PR: #328
- ブランチ: feat/issue-321-menu-above-task-header
- 関係する ADR: なし

## 目的

タスク詳細の画面でヘッダーのプロジェクトの切り替えのメニューを開くと、タスクの題・工程のバッジ・タブがある見出しの領域が
メニューの上に重なり、メニューの一部が隠れていた。メニューがほかの要素の上に出るようにする。ほかの画面のメニューの表示は崩さない。

## したこと

- 原因：Base UI の `Menu.Positioner` は位置を `transform` で決めるので、それ自体が重なりの文脈（stacking context）を作る。
  z-index（`z-50`）を中の `Menu.Popup` に付けていたため、その順はその文脈の中でしか効かず、Positioner 自体は `z-index: auto`
  のままだった。タスク詳細の見出しは `sticky top-16 z-20` なので、メニュー全体がその下に置かれていた。
- `apps/web/src/components/shell/menus.tsx` の3つのメニュー（プロジェクト・通知・アカウント）で、`z-50` を Popup から
  Positioner に移した。補足の吹き出し（`components/ui/hint.tsx`）は、もとから Positioner に `z-50` を付けている。
- 画面の構成と文言は変わらないので、仕様書・ユーザードキュメント・スクリーンショット（メニューを開いた画面は撮っていない）は直さない。

## 確かめたこと

- 架空のデータ（`scripts/docs-screenshots/seed.mjs`）を入れた一時の SACTY_HOME で、このブランチのビルドの `sacty up` を
  別のポート（4800/4801）で起動し、ブラウザーで確かめた。
  - 直す前：タスク詳細でプロジェクトのメニューを開くと、下半分（プロジェクトの一覧）が見出しの下に隠れた。Positioner の
    計算済みのスタイルは `position: absolute`・`transform: matrix(...)`・`z-index: auto` だった。
  - 直した後：タスク詳細でプロジェクト・通知・アカウントのメニューが、見出し・「一時停止」「中止」のボタンの上に出た。
    ダッシュボードとタスク一覧のプロジェクトのメニューも、カードの上に出た。
- `npm run lint`（602 ファイル、指摘なし）・`npm run typecheck`（エラーなし）・`npm test`（212 ファイル・4480 件が合格、3 件は既存のスキップ）。
- 回帰テストを足した後：`npm run lint`・`npm run typecheck` は合格。`npm test` は 4482 件が合格し、`apps/daemon/src/install-security-tools.test.ts` の1件だけが 5 秒のタイムアウトで失敗した（同時にまっさらな複製で `npm ci` を回していた）。そのファイルだけを3回実行し、3回とも 6 件すべて合格した。
- 依存を足したので、ブランチをまっさらに複製して `npm ci` から `menus.browser.test.ts` を実行し、3 件とも合格した。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （セルフレビュー）`z-50` を外した `POPUP` が、Positioner の外で使われていないか | 3つのメニューの Popup だけで使い、どれも `z-50` を付けた Positioner の中。ほかの Positioner は `hint.tsx` だけで、もとから `z-50` を付けている |
| （Sacty のレビュー・提案）この変更を戻しても検出できるよう、Chromium で、メニューと見出しが重なる座標でメニューが最前面にあることを確かめる回帰テストを足す | `apps/web/src/components/shell/menus.browser.test.ts` を足した。実際の3つのメニューと、タスク詳細の見出しと同じ `sticky top-16 z-20` の見出しを Vite で Chromium に載せ、各メニューを開いて、見出しと重なる範囲の6点で `elementFromPoint` がメニューを指すことを確かめる。CSS は `@tailwindcss/node` で、部品とテストの画面のクラスから実際の Tailwind で作る（間接の依存だったので `apps/web` の devDependencies に明示した）。直した後は3件とも合格、`menus.tsx` を main の版に戻すと3件とも失敗することを確かめた |
| （Sacty の再レビュー・提案）追加したテストで Vite が `envFile` の非推奨の警告を出すので、`envDir: false` に置き換える | `envDir: false` に置き換えた。個別に実行して警告が出なくなり、3件とも合格することを確かめた。同じ書き方の `question-form.browser.test.ts` はこの PR の範囲外なので直していない |

## 残したこと

なし
