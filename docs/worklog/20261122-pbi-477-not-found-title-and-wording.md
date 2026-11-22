# notFound() のページのタブの題と、文の括弧書きを直す

- 日付: 2026-11-22（UTC）
- タスク: PBI-477
- PR: なし
- ブランチ: なし
- 関係する ADR: [画面の文言の括弧は、文とラベルで基準を分ける](../adr/20261122-1200-ui-wording-paren-sentences-and-labels.md)

## 目的

無いタスク・プロジェクトなどを開いたとき、タブの題を「ページが見つかりません - Sacty」にする。デーモンに届かないときの知らせなど、規則に反する文の括弧書きを直し、検査で見つかるようにする。

## したこと

- `notFound()` を呼ぶ 8 ページに `generateMetadata` を足した。`<Suspense>` の中の `notFound()` は `not-found.tsx` の題に届かず、レイアウトの「Sacty」が残るため。ページの部品と `generateMetadata` は、`cache` で包んだ同じ読み込み（引数は ID の文字列だけ）を使い、デーモンへの問い合わせは 1 回のまま。設定のページは、無いときの戻り値を無いページの題にした。共通の関数は `lib/not-found-metadata.ts`。
- 応答コードと本文は変えていない。
- 検査を、文とラベルで分けた（`wording-policy.test.ts`）。判定は `parenViolations`、認める括弧の中身は数字と単位・ID・`FORMAT_NAMES`。
- `live.stale` を、括弧の無い 2 文にした。ユーザー文書（日英）も合わせた。

## 直した文の件数

- 辞書の文：8 件（`live.stale`・`common.action.invalidAdoptNote`・`forms.task.taskImageNote`・`forms.task.noRepository`・`projects.editor.githubReloadTimeout`・`projects.intake.stopped`・`labels.pauseHelp.verification`・`review.gate.notReproducedHelp`）。
- 引数を取る文言の文：22 件（`audit.bulk.invalidSelection`、作業履歴の 10 件、`runLog.shown`・`skipped`、設定の `*Current`・`intervalWhenOn` 4 件、`shell.update.newer`、`task.costs.unknownNote`・`deliverable.reviewDispatchRound`・`discardedReview.help`・`heldReview.help`、`parts.implementation.environmentPassNote`）。
- 合計 30 件。値そのものを示す引数 1 つの括弧（`（${command}）`・`（${commit}）`・`（${url}）` など）は残した。

## 直さずに残した形

- ラベル・見出し・選択肢の短い語を添える括弧（今の長さの基準のまま）。
- 括弧の中にだけ「。」を持つ作業履歴の行（`parts.flakyFailure`・`labels.stepsServices`）。
- 補足（`hint`・`*Hint`）とデーモンの文（core の辞書）。
- React の #419 の例外と、`CardSection`・`DashboardCard` の「補足」の名前。

## `PAREN_EXCEPTIONS` に移したキー

10 件：`runLog.roles.*`（3 件）・`projects.editor.excluded`・`task.images.defaultDescription`・`projects.editor.githubForContext`・`githubForShared`・`sharedRepo`・`settings.notifyApi`・`runLog.clipped`。

## 確かめたこと

- `not-found-pages.test.ts`：8 ページの無いとする条件ごとに、部品が `notFound()` で止まり、題が日英で無いページのものになる。あるとき・デーモンに届かないときの題は今のまま。
- `wording-policy.test.ts`：辞書の全体と、判定の固定の入力（直す前の `live.stale`、「？」で終わる文、認める括弧、`Node.js`・`e.g.`、片方だけが文のキー、`PAREN_EXCEPTIONS`）。
- 文言が変わった既存のテストの期待を、新しい文言に直した。

## 残したこと

- 応答コード（404 か 200 か）は、実機（`sacty up`）で無いタスクの `/tasks/<ID>` を開いて確かめ、記録する。`architecture` の「URL を直接開いても 404 になる」は、確かめるまで直さない。200 なら同じ PR で、この記述と無いページの記述を直す。
