# 終わっていない実装を提出にせず、変更の無いやり直しで行き止まりにしない

- 日付: 2026-11-15（UTC）
- タスク: PBI-347
- PR: #378
- ブランチ: feat/issue-347-stop-incomplete-implementation
- 関係する ADR: [終わっていない実装を提出にせず、変更の無いやり直しで行き止まりにしない](../adr/20261115-1224-stop-incomplete-implementation-and-unchanged-rework.md)

## 目的

タスク分割の子タスクの実装が、範囲の一部だけを実装して「実装は未完了です」と書いて終わり、sacty がそのまま PR を作った。
PR のレビューの子タスクの指摘を受けたやり直しも何も変えずに終わり、PR の先頭が変わらないので再レビューが始まらず、タスクが動かなくなった。
人から、この2つの仕組みの欠陥を1つの PR で直すよう指示された（指示の文の見直しは、次の PR）。

受け入れ条件の要点は次のとおり。

- 実装の工程の指示が、完了の申告を必ず付けるよう求める。
- 未完了と申告した・申告が無い実行は提出しない（PR を作らない・更新しない）。残っていることを渡して実装をやり直し、続けて終わらなければ一時停止して、残っていることを出す。
- 完了と申告した実行と、申告させる前の作業履歴は、今までどおり提出に進む。
- AI のレビューが指摘を残した PR の先頭を、やり直しが変えなかったら、提出にせず一時停止する。行き止まりにならないやり直しは、今までどおり提出する。
- 一時停止の理由が、画面・一覧・お知らせから分かる（日本語と英語）。

## したこと

- `apps/daemon/src/completion.ts`（新規）：完了の申告の指示（`implementCompletionLines`）と、出力からの読み取り（`extractCompletion`）。
  最後の申告だけを使う。未完了の申告は、残っていることが読めなくても未完了にする。完了の申告でも、残っていることがあれば未完了にする。
- `apps/daemon/src/prompts.ts`：実装の指示（標準・要求要件を省いた実装・不具合の修正）に「完了の申告」の節を足した。
  実装の工程の出力からだけ、申告を読んで本文から取り除く（`extractBlocks` の `completion`）。
  やり直しの指示に、前回が未完了だった（申告が無かった）ことと残っていること、前回が PR を何も変えなかったことを渡す（`feedbackLines`）。
- `apps/daemon/src/service.ts`
  - 実装の完了の記録に、申告を残す（無い・読めなければ `null`）。
  - PR の作成へ進む前（`FinalReviewSkipped` の前）に、申告を確かめる（`implementationCompleted`）。
    未完了・申告なしなら `ImplementationIncomplete` を記録して実装をやり直し、3 回続くか、やり直しても作業領域の差分が変わらなければ、一時停止する（`pauseIfImplementationKeepsIncomplete`・`workspaceFingerprint`）。
  - PR を更新する前に、出すコミットが、子タスクが指摘を残した先頭のままかを確かめる（`reviewLeftFindingsOn`）。
    当たれば `ImplementationUnchanged` と一時停止を記録し、PR を更新しない。
- `packages/core`
  - イベント：`AgentRunCompleted` の `completion`、`ImplementationIncomplete`、`ImplementationUnchanged`。一時停止の理由に `incomplete`・`unchanged`。
  - 投影：`implementCompletion`・`incompleteRuns`、やり直しに渡す内容（`verifyFeedback`）の `incomplete`・`unchanged`。再開で回数を数え直す。
  - 文言：`implement.incomplete`・`implement.unchanged`（日本語と英語）。
  - エラーレポート：2つの記録を「確認の不合格」に数える。
- `apps/web`・`apps/daemon/src/notifier.ts`：2つの一時停止の理由と、作業履歴の2つの記録の文言（日本語と英語）。
- テストの偽の実行器（`FakeExecutor`）：実装の指示が申告を求めていて、テストの出力に申告が無ければ、完了の申告を足す（本物のエージェントが指示どおり申告する代わり）。
  申告の無い実行を確かめるテストは、`undeclaredCompletion` で足さないようにする。
- 仕様書（タスクと工程・承認・エラーレポート。日本語と英語）、ユーザードキュメント（タスク・困ったとき。日本語と英語）、ADR を直した。
  最終レビューをやめた ADR（2026-11-12 07:14）は、実装の工程の後に確かめずに PR を作る部分が置き換わったので、`superseded` にして、リンクを直した。

## 確かめたこと

- `npm run lint`：通った。
- `npm run typecheck`：通った。
- `npm run build`：通った。
- `npx vitest run --no-file-parallelism`：4325 件のうち 4323 件が通り、1 件が落ち、1 件を飛ばした（もともと飛ばしているテスト）。
  - 落ちたのは `apps/web/src/components/shell/menus.browser.test.ts` の 1 件で、30 秒の時間切れ。そのファイルだけを実行し直すと、3 件とも通った（この変更は、そのテストが見る部品に触れていない）。
- `npx vitest run tests/docs`：通った。
- 足したテスト
  - `apps/daemon/src/completion.test.ts`：申告の読み取り（完了・未完了・残っていることの欠け・食い違う申告・件数と長さの上限・読めない申告・複数の申告）、実装でない工程の出力を変えないこと。
  - `apps/daemon/src/daemon.test.ts`（PBI-347 の describe。13 件）
    - 未完了の実行は PR を作らず、残っていることを渡してやり直す。3 回続くと一時停止し、再開でやり直す。
    - やり直しても差分が変わらなければ、2 回目で止まる。差分を読めなければ、回数まで数える。
    - 申告が読めない・無い実行も、未完了と同じに扱う。
    - 子タスクが指摘を残した先頭（sacty が出したコミット・人が足したコミット）を、やり直しが変えなければ、PR を更新せずに一時停止し、再開でやり直す。
    - 子タスクが指摘なしにした先頭・まだレビューしていない先頭・子タスクを待たない PR は、何も変えなくても今までどおり提出する。
  - `packages/core/src/projection.test.ts`（PBI-347 の describe。8 件）：申告の項目の無い記録が今までどおり進むこと、未完了の回数と差分の目印、再開、変更の無いやり直しの記録。
  - `apps/daemon/src/agents/agents.test.ts`：スタブの実装の出力に、完了の申告が無ければ足すこと。
- 実装を一時的に無効にして、足したテストが落ちることを確かめた。
  - 申告の確認（`implementationCompleted`）を常に通すと、未完了・申告なしの 6 件が落ちる。
  - 指摘が残る先頭の判定（`reviewLeftFindingsOn`）を常に無しにすると、変更の無いやり直しの 2 件が落ちる。
  - 判定を「sacty が前に出したコミットと同じとき」に狭めると、人が足したコミットの先頭の 1 件が落ちる。
- 画面の文言の規則（`apps/web/src/i18n/wording-policy.test.ts`）に合わせて、一時停止の説明を短くした（日本語 60 文字・英語 130 文字以内）。

実際のエージェントで、未完了の申告と一時停止までを動かして確かめることは、まだしていない（この PR のマージの後に、止めてある子タスクを再開して確かめる）。

## レビューの指摘と対応

（レビューの後に書く）
