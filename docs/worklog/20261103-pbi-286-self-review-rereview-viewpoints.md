# セルフレビューの再レビューは、前回 must を出した観点と X-1 だけを起動する

- 日付: 2026-11-03（UTC）
- タスク: PBI-286
- PR: なし
- ブランチ: feat/issue-286-pbi-286
- 関係する ADR: [セルフレビューの再レビューは、前回 must を出した観点と X-1 だけを起動する](../adr/20261103-0302-self-review-rereview-launches-must-viewpoints-only.md)

## 目的

実験（F31）で、要求要件・設計のセルフレビューが 1 回 $21〜32 かかり、観点の担当を 13〜17 個起動していた。再レビュー（2回目以降）も必須の観点を全部起動し直すためだった。
再レビューは、前回 `must` を出した観点と X-1 だけを起動する。初回と `pr-review` は変えない。観点をまとめることはしない。

## したこと

- 既定のスキル `review-dispatch`
  - `references/self-review.md` の「再レビュー（2回目以降）」：起動する観点を、前回の回で `must` を出した観点と X-1 だけにした。`must` が無く `should`・`nit` を直して進むときは X-1 だけ。前回の回の結果だけで決め、初回の規則（必須は全部・条件付きの判定し直し）は使わない。担当には前回の指摘と修正の内容を渡し、X-1 には採用した指摘のすべてを渡す。起動しなかった観点は起動表に理由を残し、「出力」の例の「起動した観点」でも分かるようにした。
  - X-2 は他の観点と同じ扱いにし、実行し直した検証が失敗・警告を出したときは起動する、と書いた（修正が検証を壊したのに分析されない穴を作らないため）。
  - `SKILL.md` の「観点の起動の規則」：規則 1 に再レビューの例外、規則 5 に `self-review` と `pr-review` の再レビューの違い、再レビューの起動表の例を足した。`references/viewpoints.md` の冒頭にも 1 文足した。
  - `verification-run.md` と X-2 の起動条件（規則 3）には触れていない（PBI-285 が直す）。
- Sacty の指示（`apps/daemon/src/prompts.ts`）は変えていない。`selfReviewLines` は回数の上限をスキルの規則に任せ、`partialReworkReviewLines` は範囲と回数だけを決めていて、起動する観点を決めていない。食い違わないことをテストで確かめた。
- 仕様書（`context.md`・`tasks-and-steps.md`、英語の版）、ユーザードキュメント（`tasks.md`、英語の版）、ADR を直した。

## 確かめたこと

作業は、リポジトリの外の worktree（`sacty-wt-pbi-286`）で行った。

- `npx vitest run apps/daemon/src/default-skills.test.ts`：通った。追加した 6 件のうち、スキルの変更を戻す（`git stash` で `apps/daemon/default-context` だけ戻す）と 5 件が落ちることを確かめた（残る 1 件は prompts.ts を読んで食い違う指示が無いことの確認で、スキルでなく指示の側の確認）。
