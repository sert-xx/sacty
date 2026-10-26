# 作業領域の写し・削除の間も、デーモンが画面や API に応答し続けるようにする

- 日付: 2026-10-26（UTC）
- タスク: PBI-156
- PR: #226
- ブランチ: claude/sweet-ride-tpbj7w
- 関係する ADR: [対象リポジトリの大きさに比例する作業領域の写し・削除は、デーモンのイベントループを止めない非同期のファイル操作で行う](../adr/20261025-2359-async-workspace-copy-and-removal.md)

## 目的

大きな作業ツリー（数 GB・数万ファイル）を `_guardian/<実行 ID>` に写す間・消す間、同期の `cpSync`・`rmSync` でデーモンのイベントループが
止まり、ダッシュボードなどが応答しなくなっていた。写し方と片付け方、止めるときの扱いを変えずに、写し・削除を非同期にする。

## したこと

- `apps/daemon/src/repository.ts`：`copyWorkingTree`（作業ツリーと退避したメタデータの写し）と `prepare`（前回の残りの削除・clone の後の
  `.git` の退避）を、`node:fs/promises` の `cp`・`rm` にした。フィルター（`.git` を除く）・`verbatimSymlinks` は同じ。
- `apps/daemon/src/service.ts`：実行ごとの作業領域（`_guardian`・`_snapshots`・`_review`・`_deployment`・`_export`・操作の作業領域）、
  共用の compose の書き出し先、中止したタスクの作業領域と退避したメタデータの削除を `await rm(...)` にした。
- `apps/daemon/src/shared-compose.ts`：キャッシュと書き出し先の削除を非同期にした。
- `apps/daemon/src/agents/docker.ts`：デーモンを止め始めた後（`abortAll` の後）に始めた実行は、コンテナを起動せずに `run.daemonStopped`
  で終える（写している間に止められた実行が、写し終わってから起動しないように）。一時停止・中止は、これまでどおり `executeLogged` の起動前の
  確認で止まる。
- 小さなファイル操作（一時インデックス・質問・監査のログの置き場所・引き継ぎの置き場所など）は同期のまま。
- 仕様書（日英）：`architecture`（データの置き場所）・`tasks-and-steps`（ゴールガーディアン）・`daemon-lifecycle`（デーモンの終了）を直した。

## 確かめたこと

- 回帰テストを足した。
  - `apps/daemon/src/repository.test.ts`：2,000 ファイルの作業ツリーを `copyWorkingTree` で写す間に、`setImmediate` のタイマーが進むこと。
  - `apps/daemon/src/daemon.test.ts`：ゴールガーディアンの作業領域（2,000 ファイル）を消す間に、タイマーが進み、消し終わってから工程を終えること。
  - `apps/daemon/src/agents/agents.test.ts`：`abortAll` の後に始めた実行は docker を起動しないこと。
- 修正を戻す（`repository.ts`・`service.ts`・`shared-compose.ts`・`docker.ts` を元に戻す）と、写し・削除の2つのテストが
  `expected 0 to be greater than 0` で失敗することを確かめた。
- `npm run lint`・`npm run typecheck`：通った。
- `npx vitest run`：下の環境による失敗のほかは通った。`agent-sessions.test.ts`（読めないファイル）・`context-mcp.test.ts`（層の写しの失敗）・
  `host-mcp-processes.test.ts`（実際のプロセスの後始末）の 8 件は、変更の前の main でも同じく失敗する（root で動かす環境で、読めないはずの
  ファイルが読めるなど）。`apps/web/src/components/question-form.browser.test.ts` は、この環境のブラウザーの版が合わず起動できないため
  読み込みで失敗する（変更とは関係しない）。
- `npx vitest run tests/docs`：通った。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 写しの途中で一時停止・中止を求めたときに、写し終わってもコンテナを起動しないことをテストするとよい（sacty のレビュー、提案） | `daemon.test.ts` に、最終レビューの `copyWorkingTree` を保留して一時停止・中止を求め、解放した後に最終レビューのコンテナを起動しないこと・一時停止／中止になること・`_guardian` の写しが消えることを確かめるテストを足した。`executeLogged` の起動前の確認を外すと、このテストが失敗することを確かめた |

## 残したこと

- 写す量を減らすこと（`node_modules` などを写さない）は範囲外。
- デーモンの終了で後片付けを待つのは最大20秒なので、大きな作業領域を消している途中で終わると残りうる。残った作業領域の片付けは PBI-157。
