# notFound() のページのタブの題と、文の括弧書きを直す

- 日付: 2026-11-22（UTC）
- タスク: PBI-477
- PR: #559
- ブランチ: なし
- 関係する ADR: [画面の文言の括弧は、文とラベルで基準を分ける](../adr/20261122-1200-ui-wording-paren-sentences-and-labels.md)

## 目的

無いタスク・プロジェクトなどを開いたとき、タブの題を「ページが見つかりません - Sacty」にする。デーモンに届かないときの知らせなど、規則に反する文の括弧書きを直し、検査で見つかるようにする。

## したこと

- `notFound()` を呼ぶ 8 ページに `generateMetadata` を足した。`<Suspense>` の中の `notFound()` は `not-found.tsx` の題に届かず、レイアウトの「Sacty」が残るため。ページの部品と `generateMetadata` は、`cache` で包んだ同じ読み込み（引数は ID の文字列だけ）を使い、デーモンへの問い合わせは 1 回のまま。設定のページは、無いときの戻り値を無いページの題にした。共通の関数は `lib/not-found-metadata.ts`。
- 応答コードと本文は変えていない。
- 検査を、文とラベルで分けた（`wording-policy.test.ts`）。判定は `parenViolations`、認める括弧の中身は、数字と単位の一覧の語（「3 件」「30 秒」。数字に続く任意の語は認めない）・ID・`FORMAT_NAMES`。
- `live.stale` を、括弧の無い 2 文にした。ユーザー文書（日英）も合わせた。

## 直した文の件数

- 辞書の文：8 件（`live.stale`・`common.action.invalidAdoptNote`・`forms.task.taskImageNote`・`forms.task.noRepository`・`projects.editor.githubReloadTimeout`・`projects.intake.stopped`・`labels.pauseHelp.verification`・`review.gate.notReproducedHelp`）。
- 引数を取る文言の文：23 件（`audit.bulk.invalidSelection`、作業履歴の 9 件、`settings.secretsResult`（レビューで見つかり、「（下の警告を見てください）」を文にした）、`runLog.shown`・`skipped`、設定の `*Current`・`intervalWhenOn` 4 件、`shell.update.newer`、`task.costs.unknownNote`・`deliverable.reviewDispatchRound`・`discardedReview.help`・`heldReview.help`、`parts.implementation.environmentPassNote`）。
- 合計 31 件（辞書の文 8 件、引数を取る文言の文 23 件）。値そのものを示す引数 1 つの括弧（`（${command}）`・`（${commit}）`・`（${url}）` など）は残した。

## 直さずに残した形

- ラベル・見出し・選択肢の短い語を添える括弧（今の長さの基準のまま）。
- 括弧の中にだけ「。」を持つ作業履歴の行（`parts.flakyFailure`・`labels.stepsServices`）。
- 補足（`hint`・`*Hint`）とデーモンの文（core の辞書）。
- React の #419 の例外と、`CardSection`・`DashboardCard` の「補足」の名前。

## `PAREN_EXCEPTIONS` に移したキー

10 件：`runLog.roles.*`（3 件）・`projects.editor.excluded`・`task.images.defaultDescription`・`projects.editor.githubForContext`・`githubForShared`・`sharedRepo`・`settings.notifyApi`・`runLog.clipped`。

## 確かめたこと

今回の直しの後に実行した結果。

- `npm run format`・`npm run lint`・`npm run typecheck`・`npm run build`・`npm test`（全件）：すべて通った（`npm test` は 341 ファイル、6989 件が通り、14 件はスキップ）
- ブラウザーのテスト（`*.browser.test.ts`）は、この環境に Chromium が無い場合は実行できない。実行できたかは上の結果に含む。
- 応答コードは、人が本番のビルドの実ブラウザーで確かめた値（`notFound()` を呼ぶ 8 ページは 200、無い URL は 404）を、仕様書に反映した（下の「残したこと」）。この作業領域では実機で確かめていない。

- `not-found-pages.test.ts`：8 ページの無いとする条件ごとに、部品が `notFound()` で止まり、題が日英で無いページのものになる。あるとき・デーモンに届かないときの題は今のまま。
- `wording-policy.test.ts`：辞書の全体と、判定の固定の入力（直す前の `live.stale`、「？」で終わる文、認める括弧、`Node.js`・`e.g.`、片方だけが文のキー、`PAREN_EXCEPTIONS`）。
- 文言が変わった既存のテストの期待を、新しい文言に直した。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| `settings.secretsResult` に、理由を添える括弧が残っている | 日英とも括弧を文に直し（「詳しくは下の警告を見てください。」・"See the warnings below."）、期待値と件数を直した。辞書の全関数を例示値で呼んで括弧を見る検査は足していない（検査は関数を読まない決まりのまま、差分のレビューで確かめる） |
| 括弧を外すために文が増え、1 文・2 文までの規則と日英の文数が崩れた | 注釈を語句・読点でつなぐ形にまとめ、文数を括弧を足す前（日英とも）に戻した。対象は、設定の `*Current`・`intervalWhenOn`（「既定の」を数の前に置く）、作業履歴の `ReworkStoppedByMerge`・`PullRequestMarkedReadyWithSuggestions`・`PullRequestReviewImported`・CI の失敗・セッションの引き継ぎ、`environmentPassNote`、`discardedReview.help`・`heldReview.help`・`task.costs.unknownNote`・`reviewDispatchRound`。文数を見る検査は足していない |
| 括弧に認める「数字」の判定が緩い | 単位・助数詞の一覧の語だけに絞り、注釈が落ちる入力と、長さの境界（日 13／14 字・英 29／30 字）、「！」「…」で終わる文、`etc.`・`i.e.` の固定入力のテストを足した |
| 作業履歴の件数・記録が合っていない | 件数を数え直し、確かめたこと・この節・PR 番号を足した |
| 3 回目のレビューの提案 5 件 | `ReviewRejudgeRequested` の選り分けの枝を、日英とも 2 文に戻した。作業履歴の英語の段階を "stopped while it was ${stage}" にして文法を直した。`discardedReview.help` を日英とも 2 文にした。略語が括弧の外にある入力と、入れ子の括弧（外側の中身も確かめる）の固定入力のテストを足した |
| 応答コードは 200（人の確かめ） | `architecture`（日英）の「404 になる」を、無いページを出して応答コードは 200 に直し、「応答コードは変えない」に値を添えた |


## 残したこと

- 無いタスク・プロジェクトを開いたときの応答コードが 200 であることは、人の確かめで得た値。`architecture`（日英）の 404 の記述を実際の値に直した。応答コードは変えていない。
