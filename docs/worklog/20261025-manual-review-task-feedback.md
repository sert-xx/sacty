# 手動で作った PR のレビュータスクの指摘も、元のタスクに PR の指摘として取り込む

- 日付: 2026-10-25（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-333af1c0-je6e2h
- 関係する ADR: [PR を参照する sacty のタスクの投稿は、取り込みの経路に関わらず、指摘のある回を元のタスクの PR の指摘として取り込む](../adr/20261025-2245-import-sacty-reviews-from-any-intake.md)

## 目的

sacty が作った PR を、人が手動で作ったレビューのタスク（本文に PR の URL）でレビューさせても、そのタスクに `source` が無いため
投稿が元のタスクの PR の指摘として取り込まれず、差し戻しが動かなかった。取り込みの経路に関わらず、PR を参照する sacty のタスクの、
判定に指摘のある回を取り込むようにする。

## したこと

- `sactyReviewsOf`（`apps/daemon/src/service.ts`）の `allowed` から、`source.review === "sacty"`（と、引き継いだ PR での `continued` の例外）の条件を外した。
  判定が `changes_required`・`suggestions`・読めない回を取り込み、`no_findings` の回と判定の記録が無い回は取り込まない。
  `continued` の引数は要らなくなったので消した。
- `GitHubPullRequests.feedback`（`apps/daemon/src/github.ts`）のコメントを、新しい規則に合わせた（判定の処理は変えていない）。
- テスト（`apps/daemon/src/daemon.test.ts`）：`start` に工程の選び方（`planner`）を渡せるようにし、手動のレビューのタスクについて次を足した。
  - 修正が必要・提案あり・評価なしの回は取り込み、ゴールガーディアンの判断と差し戻しまで進む。指摘なしの回は取り込まない。
  - PR を参照するだけで、レビューの工程を持たないタスクの回は取り込まない。
  - 再レビューは回ごとに判定する。
  - 投稿したアカウントがそのタスクのアカウントと違えば、目印があっても取り込まない。
- ADR を足し、PBI-145 の ADR を置き換え済みにした（PBI-88 の ADR の置き換え先にも足した）。仕様書（`approval`・`intake`・`tasks-and-steps`。日本語と英語）を直した。

## 確かめたこと

- `npx biome check .`：指摘なし。
- `npm run typecheck`：通った。
- 足したテストは、直す前のコードでは 4 件のうち 3 件が通らない（判定の記録が無い回のテストは、もとから取り込まない）ことを確かめた。
- `npx vitest run`：足したテストを含めて通った。通らなかったのは、この作業の環境によるものだけ（root で動かしているので読めないファイルが読めてしまう・プロセスの後始末のテスト 8 件と、Playwright のブラウザの版が環境と合わないブラウザのテスト 1 ファイル。[前の作業履歴](20261025-pr-223-continue-existing-pull-request.md)と同じ）。
- `npx vitest run tests/docs`：通った。

## 残したこと

- 手動のタスクに `source` を付けて、ラベル経由のタスクと同じに扱うこと（範囲外）。
