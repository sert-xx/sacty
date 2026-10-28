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
| ドラフトを外すかを台帳の `draft` で決めると、ドラフトに戻した答えを受け取れなかったときに外さずに承認待ちになる | PR を更新したときの GitHub の答え（`pr.draft`）で決めるようにした。答えを受け取れなかったときのテストを足し、元の条件に戻すと失敗することを確かめた |
| 人が不合格のまま進めた記録と不合格の理由が、本文の長さの上限で消える | footer に置くようにした（`overrideBodyLines`。不合格の観点と、1行にした所見）。要求要件が長いときの通常の本文・テンプレートの本文のテストを足した |
| 既存の PR を引き継ぐタスクでも、不合格のままレビューへ進められ、人の PR に積まれる | `canOverrideVerification` で引き継ぐタスクを除いた。core のテストを足した |
| 図が、変更なしのときも必ず CI 待ちへ進む | 変更なしで CI 待ちを飛ばす分岐を足し、日英の SVG を作り直した |
| CI を確かめたコミットと最終の PR のコミットが同じことを、テストが確かめていない | 偽物のリポジトリに、内容が変わらなければ前のコミットを使う動き（`sameAsParent`）を足し、同じコミットのまま・新しくプッシュしないことを確かめた |
| 仕様書の工程の表と承認ゲートの説明に、検証に通ってから PR を作る説明が残っている | 日英とも、最終レビューの前にドラフトで作り、通ったらドラフトを外す説明に直した |
| （2回目）PR の答えを読めないと、ドラフトかが分からないのに外れているものとして、ドラフトのまま承認待ちになる。GraphQL の答えを読めないときも成功にしている | 今の PR の答えを読めない・`draft` が boolean でないときは失敗にした。GraphQL は、変えた後の `isDraft` が求めた状態のときだけ成功にした。検証に通った後は、更新の答えではなく、毎回 GitHub の今の PR を読んでから外すようにした。回帰テストを足し、元のコードで失敗することを確かめた |

## 残したこと

- 既存の PR を引き継ぐタスクは、これまでどおり最終レビューに通ってから積む（最終レビューの前の CI は見ない）。
  人の PR に未完成の実装を積むことになるので、別に決める。
