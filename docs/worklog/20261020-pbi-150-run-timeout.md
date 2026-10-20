# エージェントの実行とテストの実行の上限を、config.yaml の run_timeout で設定できるようにする

- 日付: 2026-10-20（UTC）
- タスク: PBI-150
- PR: #169
- ブランチ: feat/pbi-150-run-timeout
- 関係する ADR: なし

## 目的

エージェントの1回の実行の上限（30 分）とテストのコマンドの上限（20 分）がコードの定数で固定され、時間のかかる工程が時間切れで止まっていた
（ステークホルダー）。`config.yaml` で、既定と役割ごとの上限を決められるようにする。

## したこと

- 設定（`apps/daemon/src/config.ts`・`apps/daemon/src/run-timeouts.ts`）：`run_timeout` に `agent_minutes`（既定 30）・`test_minutes`（既定 20）・`roles`
  （工程と `guardian`・`final-review`・`rework`・`orchestrator`・`chat`・`export`・`audit`・`audit-dive` ごとの上書き）を足した。1〜720 分の整数で、
  範囲外・知らない役割は設定の誤り。`agentTimeoutMs`・`testTimeoutMs` で、役割の上書き → 既定 → 固定の既定の順に決める。雛形にコメントで例を足した。
- 実行（`apps/daemon/src/agents/docker.ts`・`test-runner.ts`）：実行ごとの上限（`timeoutMs`）を受け取り、無ければこれまでの既定を使う。時間切れの文言は
  その実行の上限の分を出す。
- デーモン（`apps/daemon/src/service.ts`）：実行のたびに設定を読み、その役割の上限をエージェントの実行に、`test_minutes` をテストの実行に渡す（次の実行から効く）。
  MCP の時間切れの警告（`context.mcpTimeoutOverRun`）も、その実行の役割の上限で判断する（`runContext` に役割を渡し、`prepareContext` に上限を渡す）。
- `config.ts` から `context.ts` へは `host-mcp.ts` を通して読み込みがあるので、既定の値は新しいモジュール `run-timeouts.ts` に置き、循環を避けた。
- テスト：`run-timeouts.test.ts`（既定・読み取り・範囲の境界・誤り・雛形の例・役割の決め方）、`containers.test.ts`（エージェントとテストの実行ごとの上限）、
  `context.test.ts`（MCP の警告をその実行の上限で判断する）、`daemon.test.ts`（工程の実行に役割の上限を渡す・テストの上限の既定）。
- 仕様書（`agent-execution`・`configuration`・`context`・`deployment-watch`）とユーザードキュメント（`config`・`context`・`troubleshooting`）の日英を直した。

## 確かめたこと

- `npm run lint`：通過（358 ファイル）。`npm run typecheck`：通過。`npx vitest run`：121 ファイル・2364 件が通過。
- DA のセルフレビュー（受け入れ条件との照合）：既定（書かなければ 30 分・20 分）、役割ごとの上書き、テストの上限、範囲（1・720 の境界と外）、知らない役割、
  実行ごとに設定を読むこと、MCP の警告がその実行の上限で判断されること、時間切れの文言の分。ゴールガーディアン・オーケストレーター・セッションの再開・監査も、
  同じ実行の経路（`executeLogged`）を通るので上限が効く。
- 実際に長い工程を動かして、設定した上限で止まることは確かめていない（手元に AI の認証が無い）。運用の環境で、`run_timeout.roles` を書いて、
  その工程が設定した分まで続くことを確かめる。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （なし） | |
