# 情報収集を、エージェントの実行・コンテキスト・タスク分割の仕様書と README にも書く

- 日付: 2026-10-23（UTC）
- タスク: なし
- PR: #207
- ブランチ: claude/nice-faraday-e1n1ip
- 関係する ADR: [オーケストレーターの前に情報収集のエージェントを置き、集めた情報をすべての工程とゴールガーディアンに引き継ぐ](../adr/20261022-2350-superseded-gather-information-before-orchestrator.md)

## 目的

PR #206 で入れた情報収集を、工程のページと流れの図には書いたが、各役割を並べて説明しているページへの反映が漏れていた（ユーザーとの確認で見つけた）。
仕様書を実装と一致させる。

## したこと

- `docs/spec/agent-execution.md`：冒頭の役割の一覧、代わりのエージェントの対象、失敗のときに切り替える実行、読めない答えで切り替える実行、役割の名前（`gather`）に、情報収集を足した。
- `docs/spec/context.md`・`docs/user/context.md`：コンテキストを渡す相手と、`ContextResolved` を記録する実行に、情報収集を足した。
- `docs/spec/split-and-integrate.md`：子タスクの本文に親が集めた情報を添えること、子タスクは集め直さないことを書いた。
- `README.md`：冒頭の概要に、情報を集めてから進めることを書いた。
- それぞれの英語の版も同じく直した。

## 確かめたこと

- `npx vitest run tests/docs`：93 件が合格した。
- 書いた内容を、コード（`apps/daemon/src/service.ts` の `gatherInformation`・`runOrchestrator`・`fallBack`、`apps/daemon/src/prompts.ts` の `buildChildBody`）と照らした。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| （まだ無し） | — |

## 残したこと

なし
