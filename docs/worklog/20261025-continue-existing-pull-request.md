# 既存の PR を直すタスクで PR を引き継ぎ、文書だけの観点に形だけのテストを書かせない

- 日付: 2026-10-25（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/sweet-volta-jlznx0
- 関係する ADR: [既存の PR を直すタスクは、PR を引き継いで同じブランチに積み、文書だけの観点はテストを書かずに差分で確かめる](../adr/20261025-1337-continue-existing-pull-request.md)

## 目的

人が作った PR のレビューの指摘への対応を sacty のタスクにしたときに報告された、次の2つを直す。

- 既存の PR とは別の PR が作られた。
- `docs/` のドキュメントを読めるかを確かめるだけの、意味の無いテストが足された。

## したこと

- 既存の PR の引き継ぎ
  - オーケストレーターの指示に `continuePullRequest` を足した（タスクに PR のリンクがあり、実装する組み合わせを選べるときだけ）。`extractStepPlan` で読む（`apps/daemon/src/prompts.ts`）。
  - sacty が PR を確かめ（開いている・フォークでない・ほかのタスクの PR でない）、PR の元のブランチで作業領域を用意し直して `StepsChosen` の `continuedPullRequest` に記録する。引き継げなければ工程を決めずに止める（`resolveContinuedPullRequest`・`runNextInner`）。
  - 工程の指示に、引き継ぐ PR と PR のレビュー・コメントを渡す（`continuedPullRequestLines`・`continuedFeedback`）。
  - 実装は PR の元のブランチに積み、PR を作らない（`publishContinued`）。ブランチが進んでいたら止める。
  - 要求要件・設計は PR にしない（`stepPullRequestsOn`）。実装の前からある指摘を取り込み直さない（`handedOverFeedback`・`Task.implementStartedAt`）。中止で PR を閉じず、ブランチを消さない。
  - GitHub の PR の読み取りに、状態・元のブランチとそのリポジトリ・向き先のブランチを足した（`PullRequestInfo`）。
  - タスクの詳細の工程の欄に、引き継いで直す PR を出す。
- 文書だけの観点
  - テストの対応に `untested`（テストを書かずに差分で確かめる理由）を足した（`TestMapping`）。申告した観点は、対応させたものにする（`mappedViewpointIds`）。
  - 実装の指示に、ファイルがある・読める・文字列を含むことだけを確かめるテストを書かないこと、sacty の要求要件・設計のファイルを対象にしないことを書いた（`UNTESTED_LINES`）。設計の指示にも、同じ観点を作らないよう書いた。
  - 最終レビューの指示で、申告した観点の変更が振る舞いを変えないことを差分で確かめさせ、変えるのにテストが無ければ不合格にさせる。
  - PR の本文の対応表と、実装の成果物に「テストなし・差分で確認（理由）」を出す。
- 仕様書（`tasks-and-steps`・`approval`）・ユーザードキュメント（`tasks`）を、日本語と英語の両方で直した。

## 確かめたこと

- `npm run typecheck`：通った。
- `npx biome check .`：指摘なし。
- `npx vitest run`：足したテスト（引き継ぎ 7 件・差分で確かめる観点 2 件・PR の読み取り 1 件・実装の成果物 1 件）を含めて通った。
  通らなかったのは、変更の前のブランチでも同じく通らない、この作業の環境によるものだけ（root で動かしているので読めないファイルが読めてしまう・プロセスの後始末のテスト 8 件と、Playwright のブラウザの版が環境と合わないブラウザのテスト 1 ファイル）。
- `npx vitest run tests/docs`：通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | — |

## 残したこと

- 引き継いだ PR に、sacty の実装の説明や検証の結果をコメントとして残すこと（いまは sacty の画面で見る）。
- タスクの作成の画面で、人が「この PR を直す」と指定する口（いまはオーケストレーターの判断だけ）。
