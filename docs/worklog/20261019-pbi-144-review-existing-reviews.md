# PR のレビューの前に、PR にすでにあるレビューを確かめ、同じ指摘を繰り返さない

- 日付: 2026-10-19（UTC）
- タスク: PBI-144
- PR: なし
- ブランチ: feat/pbi-144-review-existing
- 関係する ADR: [PR のレビューは、PR にすでにあるレビューを入力に揃え、他のレビュアーと同じ指摘を繰り返さない](../adr/20261019-1250-review-checks-existing-reviews.md)

## 目的

sacty のレビューが、他のレビュアーが PR ですでに指摘した問題をもう一度指摘し、PR の作者の手間が増えていた。
レビューの前に PR のレビューの状況を確かめ、既存の指摘と同じ問題は繰り返さないようにする。

## したこと

- デーモン（`apps/daemon/src/service.ts`）：再レビューの作者の返答だけを読んでいた `reviewReplies` を `reviewFeedback` にし、review の工程の実行の前に
  PR のレビュー・コメントを 1 回読んで、既存のレビュー（全部）と作者の返答（再レビューのときだけ）を同じ読み出しから作るようにした。
  読めなければ両方を読めなかったものとして、理由をログに残す（秘密の値は伏せる）。作者を読めなければ、返答だけ読めなかったものにする。
- 指示（`apps/daemon/src/prompts.ts`）：`existingReviewLines` で「--- PR の既存のレビュー ---」の節を足し、既存の指摘の状況を確かめること、
  同じ問題を繰り返さないこと、省いた件数を総評に書くことを書き、既存のレビューを 1 行の JSON のデータ（新しい 30 件、1 件 2000 文字）で渡す。
  無いとき・読めないときはそう書く。
- 既定のスキル（`apps/daemon/default-context/skills/review/review-dispatch/`）：SKILL.md の入力に既存のレビューを足し、pr-review.md に
  「既存のレビューの確認」と「既存の指摘との重なり」の節を足し、aggregation.md の不採用の理由・判定・記録（`existing_reviews`）を足した。
  スキルは汎用のまま（sacty 固有の書き方をしない）。
- テスト：`prompts.test.ts`（節の文言・JSON・無い・読めない・渡さない・上限）、`daemon.test.ts`（初回から読んで渡す、再レビューでは返答と
  既存のレビューの両方、読めないとき、作者が分からないとき）、`default-skills.test.ts`（スキルの文言）。
- 仕様書（`docs/spec/tasks-and-steps.md`・`context.md` と英語の版）を直し、ADR を足した。

## 確かめたこと

- `npm run lint`：通過（354 ファイル）。`npm run typecheck`：通過。
- `npx vitest run tests/docs apps/daemon/src/prompts.test.ts apps/daemon/src/default-skills.test.ts`：181 件が通過。
- `npx vitest run apps/daemon packages/core`：60 ファイル・1787 件が通過（初回から既存のレビューを読んで渡す、再レビューでは作者の返答と
  既存のレビューの両方、読めないとき、作者が分からないとき、の daemon のテストを含む）。
- DA のセルフレビュー（受け入れ条件との照合）：初回・再レビューの両方で渡す、件数と長さの上限、読めないときに止めない、スキルの入力・確認・
  不採用・総評・判定、スキルが汎用のまま、仕様書の日英、ADR。実際の PR での動作確認はしていない（手元の台帳が空）。
- 知っている限界：既存のレビューの読み出しは、このタスクのアカウントの目印付きの投稿を除くので、同じアカウントの別の sacty のタスクが
  同じ PR に投稿したレビューは、既存のレビューとして渡らない（レビューの依頼で取り込んだ sacty の PR のタスクなど）。

## 作業の記録

- PBI の番号は、最初 PBI-126 で起票したが、main のコード・ADR では他のセッションが PBI-143 まで使っていたので、PBI-144 に付け直した。
- 編集の一部が別の worktree（PBI-145 のブランチ）に書き込まれていたので、差分を取ってこの worktree に移した。
