# エージェントの実行が失敗したら、理由を問わず代わりのエージェントでやり直す

- 日付: 2026-10-20（UTC）
- タスク: なし
- PR: なし
- ブランチ: claude/stoic-pascal-nc6b7z
- 関係する ADR: [エージェントの実行が失敗したら、理由を問わず、agents の fallback に書いた代わりのエージェントでやり直す](../adr/20261020-2317-agent-fallback-on-any-failure.md)

## 目的

`fallback` を書いたエージェントは、利用制限のときだけでなく、認証の失敗などどの失敗でも代わりのエージェントで自動的にやり直す。

## したこと

- `apps/daemon/src/service.ts`：`fallBack` の利用制限だけの条件を外した。利用制限でない失敗は、そのエージェントをタスクごとに
  （`failedAgents`）期限まで使わないものとして覚え、`usableAgent` がタスクの ID を受け取って、利用制限中かそのタスクで失敗したエージェントを
  避ける（`agentUnusable`）。`AgentFellBack` に失敗の理由を足した。
- `packages/core/src/events.ts`：`AgentFellBack` に任意の `reason` を足した（無い前の記録は利用制限として読む）。
- `apps/web`：作業履歴の文言を、理由ごと（利用制限・認証の失敗・失敗）に分け、利用制限でなければ「このタスクでは」使わないと書く。
- `apps/daemon/src/config.ts`：`config init` のひな形の説明とコメントを直した。
- docs：仕様書（エージェントの実行・設定ファイル）・ユーザードキュメント（設定・困ったとき）を日本語・英語で直し、ADR を足して前の ADR を
  置き換え済みにした。

## 確かめたこと

- `npm run typecheck`：成功。
- `npx biome check`：変えたファイルで誤り無し。
- `npx vitest run`：変えたところのテスト（`daemon.test.ts` の代わりのエージェント・`labels.test.ts`）は成功。
  `agent-sessions.test.ts`・`context-mcp.test.ts`・`host-mcp-processes.test.ts` の 8 件は、変える前の main でも同じく失敗する
  （root で動かした環境によるもの）。
- `npx vitest run tests/docs`：成功。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | — |

## 残したこと

- 失敗の理由の分類（`classifyFailure`）は、標準エラー出力のログに引きずられて誤ることがある。今回の変更で、切り替えるかどうかには
  影響しなくなったが、一時停止の理由や、すべてのタスクで避けるかどうかには影響する。
