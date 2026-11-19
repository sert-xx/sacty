# 最初の工程が始まる前の処理中を「実行待ち」と見せない

- 日付: 2026-11-19（UTC）
- タスク: PBI-410
- PR: #PRNUM
- ブランチ: feat/issue-410-preparing-status
- 関係する ADR: [最初の工程が始まる前の処理の段階を、デーモンのメモリーから画面に返す](../adr/20261119-1612-show-preparing-phase-from-daemon-memory.md)

## 目的

タスクを作ってから最初の工程が始まるまで、状態は `queued` のままで、画面は「実行待ち」と出していた。
この間に sacty が対象リポジトリの用意・情報収集・進め方の判定などを実際に進めていても、動いていないように見えた。
実際に処理している間だけ、進行中と分かる文と色で出す。枠を待っているだけのタスクは「実行待ち」のままにする。
ダッシュボードの待ち行列の「実行中」と、一覧の表示の食い違いも、この区間について無くす。

## したこと

- デーモン（`apps/daemon/src/service.ts`）
  - 処理の段階（`repository`・`gathering`・`triage`・`planning`・`review_target`）を、メモリーの表（`preparingPhases`）に持つ。
    `runNext`・`runNextInner` が、それぞれの処理を始める直前に付け、進め方の判定の後と、`runNext` の終わりに消す。
  - `preparingOf` は、状態が `queued` で、ワーカーが処理していて（`inflight`）、段階が付いているときだけ段階を返す。
  - `GET /api/tasks`（`listView`）と `GET /api/tasks/:id`（`view`）のタスクに、`preparing` を足す。作業履歴には記録しない。
- core（`packages/core/src/projection.ts`）：`PREPARING_PHASES`・`PreparingPhase`・`Task.preparing`（画面に返すときだけ足す欄）。
- 画面（`apps/web`）
  - `statusText`・`statusTone` が、`queued` で `preparing` があるタスクを、段階の文と `working` にする。
    一覧・ダッシュボード・詳細・関係するタスクの行・一覧の状態の絞り込みは、この2つの関数を通るので、同じ表示になる。
  - 文言（日本語・英語）を `labels.state.preparing` に足した。
  - 工程が決まる前の文「オーケストレーターが工程を選びます」を「工程は未定」にした（処理中の表示と矛盾しない、状態だけの文）。
- `sacty mcp`（`apps/daemon/src/task-mcp.ts`）：要約に `preparing` を足した（`state` は `queued` のまま。ほかの欄は変えない）。
- docs：仕様書（タスクと工程・アーキテクチャ・MCP サーバー）、ユーザードキュメント（タスク・ダッシュボード・MCP）を、日本語と英語で直した。ADR を足した。

決めたことの理由（作業履歴に記録しない・状態を増やさない・作業履歴から推し量らない）は ADR に書いた。

## 確かめたこと

- `npm run format`・`npm run lint`・`npm run typecheck`：問題なし。
- `npx vitest run --no-file-parallelism`：272 ファイル・5443 件が通った（1 件は元からの skip）。
- `npx vitest run tests/docs`：93 件が通った。
- 足したテスト
  - `apps/daemon/src/daemon-task-lifecycle.test.ts`：段階ごとに API（一覧・終わっていないタスクの一覧・詳細）が返す値、最初の工程が始まった後・一時停止・例外・起動し直しの後に返さないこと、作業履歴に記録が増えないこと、同時に実行する数の上限と件数の境界（処理中が 0 件・1 件・複数件）。
  - `apps/daemon/src/task-mcp.test.ts`：`list_tasks`・`get_task` の要約。
  - `apps/web/src/lib/labels.test.ts`・`apps/web/src/lib/dashboard-data.test.ts`・`apps/web/src/components/task-list-preparing.test.ts`：文と色、絞り込み、工程が決まる前の文。
- 直しを戻すと落ちること（戻した後、元に戻した）
  - 画面の判定を消す：5 件が落ちた。
  - 処理しているか（`inflight`）を見ずに `queued` を進行中と返す：8 件が落ちた（枠を待つタスクの境界のテストを含む）。
  - 処理の終わりに段階を消さず、状態も見ない：5 件が落ちた。
  - 段階を付けない：8 件が落ちた。
  - 進め方の判定の後に段階を消さない：1 件が落ちた。
- 実機（ビルドした版を、一時的な `SACTY_HOME` とポート 4800/4810 で起動。docker・gh は代わりのスクリプトで、エージェントの実行は 25 秒かかってから失敗する。同時に実行する数は 1）
  - 画面でタスクを2つ作ると、先のタスクは「情報を収集中」（進行中の色）、後のタスクは「実行待ち」と出た。待ち行列は実行中 1・実行待ち 1。
  - 状態の絞り込みの「進行中」には先のタスクだけ、「待ち」には後のタスクだけが出た。
  - 詳細は、先のタスクが「情報を収集中」と「工程は未定」、後のタスクが「実行待ち」。
  - 先のタスクの実行が失敗して一時停止すると、画面を読み込み直さずに、先のタスクが「エラーで一時停止」、後のタスクが「情報を収集中」に変わった。
  - 先のタスクの作業履歴は `TaskCreated`・`ContextResolved`・`RunCostRecorded`・`OrchestratorFailed`・`TaskPaused` だけで、表示のための記録は無い。
- 確かめられなかったこと：実際の AI・GitHub・Docker を使った実行での表示（代わりのスクリプトで確かめた）。対象リポジトリの用意・チケットの確認・進め方の判定・レビューする PR の確認の段階は、実機では見ておらず、テストで確かめた。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無い） | — |

## 残したこと

- 1つの処理が終わってからワーカーが次の処理を始めるまで（最長 2 秒）は「実行待ち」と出る。実際に処理していない間なので、そのままにした。
- 最初の工程が始まった後の、工程と工程の間の処理（工程の見直しなど）の表示は、範囲の外。
- 進行中の情報収集・判定の実行を、実行の一覧に出してログを読めるようにすることは、範囲の外。
