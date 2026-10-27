# 実装の PR を最終レビューの前にドラフトで作り、CI を待ってから判定し、合格したらドラフトを外してレビューへ進める

- 日付: 2026-10-27（UTC）
- タスク: なし
- PR: #239
- ブランチ: claude/zen-einstein-h97u1u
- 関係する ADR: [実装の PR を最終レビューの前にドラフトで作り、CI を待ってからゴールガーディアンが判定し、合格したらドラフトを外してレビューへ進める](../adr/20261027-2330-draft-pull-request-before-final-review.md)

## 目的

ゴールガーディアンの最終レビューに合格するまで実装の PR が無く、実装の状態を確かめにくい。
CI の上の振る舞いも PR を作らないと確かめられない。
最終レビューに続けて通らずに止まると、人がよいと判断しても PR のレビューへ進められない。

- 実装の工程の最後（最終レビューの前）に、実装の PR をドラフトで作る。
- ゴールガーディアンは、作業領域のテストと PR の CI の結果を合わせて判定する。
- 合格したらドラフトを外し、レビュー用のラベルを付ける。
- 不合格が続けて止まったタスクも、人の判断でドラフトを外してレビューへ進められる。

CI を待つか・CI の失敗をどう扱うかは、利用者に確かめた（CI の完了を待つ・ゴールガーディアンが判断する）。

## したこと

- core
  - `PullRequestPublished` に `verifying`・`draft` を足した。
    `PullRequestCiFinished`・`VerificationOverridden` を足した。
  - 投影に `pullRequestCi`・`verificationOverride`・`awaitingPullRequestCi`・`canOverrideVerification` を足した。
    実装をやり直すと、CI の待ちを消す。
    最終レビューの前のプッシュ（`BranchPushed`）も受け付ける。
  - 文言のコード `override.notAllowed`・`pr.readyFailed`、GitHub の操作 `draftPr` を足した。
- daemon
  - `github.ts`：PR をドラフトで作る（ドラフトを使えない 422 なら、ふつうの PR にする）。
    `setDraft` で、GraphQL の `convertPullRequestToDraft`・`markPullRequestReadyForReview` を呼ぶ。
  - `service.ts`
    - `verify` で、最終レビューの前に `publish`（`verifying`）でドラフトの PR を作り、CI を待つ。
    - マージの後の監視の CI の読み方を `readCi` に切り出し、`checkVerificationCi` と共用した。
    - 検証に通った後の `publish` で、ドラフトを外してから承認待ちにする。
    - `submitForReview` で、人の判断でレビューへ進める。
    - 依存の `draftPullRequests`（テストで切る）を足した。
  - `server.ts`：`POST /api/tasks/:id/submit-for-review` を足した。
  - `prompts.ts`：最終レビューの指示に `pullRequestCiLines` を足した。
    PR の本文に、検証中であることと、人が不合格のまま進めたことを書く（`PullRequestBodyStage`）。
- web
  - 一時停止の欄に「レビューへ進める」（`ToReviewForm`）を足した。
  - 状態「PR の CI を待っている」と、作業履歴の行を足した。
    辞書は日英。
- docs
  - 仕様書（タスクと工程・承認と差し戻し）とユーザードキュメント（タスク・取り込み）を、日英で直した。
  - 図 `verify.svg` を描き直した。
  - ADR を足し、置き換えた ADR の名前を `superseded` にした。

## 確かめたこと

- `npm run lint`・`npm run typecheck`・`npm run build`・`npx vitest run tests/docs` が通った。
- 回帰テスト
  - `github.test.ts`：ドラフトでの作成、ドラフトを使えないときの作り直し、ドラフトの切り替え（GraphQL）、すでにその状態なら何もしない、GraphQL のエラー。
  - `daemon.test.ts`（最終レビューの前のドラフトの PR と CI）
    - ドラフトの PR → CI を待つ → 最終レビューに CI を渡す → ドラフトを外してラベル → 承認待ち
    - CI の失敗をゴールガーディアンに渡し、不合格ならやり直した実装で同じ PR を更新
    - 承認待ちの後の差し戻しで、PR をドラフトに戻す
    - CI が無い・時間切れ・一時停止の間は読まない
    - ドラフトを使えないリポジトリ、ドラフトを外せないときの止め方と再開
    - 人がレビューへ進める操作と、進められないとき
  - `prompts.test.ts`：最終レビューに渡す CI の指示。
- `npx vitest run`：変更に関わるテストはすべて通った。
  - 失敗が 9 件ある。`host-mcp-processes`・`agent-sessions`・`context-mcp` の 8 件と、`question-form.browser` の 1 件。
  - 前の 8 件は、変更を外した状態でも同じく失敗し、この環境が原因（root で動かしている・プロセスの扱い）。
  - `question-form.browser` は、この環境に Chromium の用意が無いため。
- 実際の GitHub でドラフトの PR を作る・外すことは確かめていない（テストは fetch の偽物で確かめた）。
- 画面のスクリーンショット（`npm run docs:screenshots`）は撮り直していない。
  「レビューへ進める」が出る、検証で止まったタスクはスクリーンショットに無い。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- 既存の PR を引き継ぐタスクは、これまでどおり最終レビューに通ってから積む（最終レビューの前の CI は見ない）。
  人の PR に未完成の実装を積むことになるので、別に決める。
