# 利用制限のときに、代わりのエージェントへ自動で切り替える

- 日付: 2026-10-20（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-8e541545-dgzcfs
- 関係する ADR: [利用制限に達したエージェントは、agents の fallback に書いた代わりのエージェントに切り替えて、止めずに続ける](../adr/20261020-1123-agent-fallback-on-usage-limit.md)

## 目的

Claude Code をメインに使い、利用制限に達したら別のエージェントへ自動で切り替えられるようにする。オーケストレーターは、切り替えても
それまでの経緯を引き継げるようにする。

## したこと

- 設定：`agents.<名前>.fallback`（名前1つか並び）と `agent_fallback.cooldown_minutes`（既定 60、1〜1440）を足した。無い名前・自分自身は誤り、
  使えない代わりは警告して外す（`apps/daemon/src/config.ts` の `AgentFile`・`buildAgents`・`fallbackAgentFor`）。設定のひな形にも例を足した。
- 実行：`usage_limit` で失敗したエージェントを期限まで制限中として覚え（`markLimited`）、エージェントを選ぶところで代わりを選ぶ
  （`usableAgent`）。工程・統合レビュー・工程の選択・チケットの読み取り・最終レビューは、一時停止の代わりに `AgentFellBack` を記録して
  止めずにやり直す（`pauseOrFallBack`）。変更の申し出・差し戻しの指摘の判定は、その場でやり直す（`runGuardianWithFallback`）。
- オーケストレーターの引き継ぎ：別のエージェントのセッションが保存してあれば、指示とエージェントの発言の文を書き出し、`/sacty-handoff` に
  読み取り専用でマウントして、指示に場所を足す（`apps/daemon/src/orchestrator-handoff.ts`、`OrchestratorSessionStore.plan` の `handoff`）。
  `OrchestratorSessionUsed` に `handoffFrom` を足した。
- イベント `AgentFellBack` を足し（状態は変えない）、画面の作業履歴の文言（日本語・英語）を足した。代わりのエージェントの秘密情報も、起動の
  ときにまとめて取り出す（`secretUses`）。
- 仕様書（設定ファイル・エージェントの実行・作業履歴）とユーザードキュメント（config.yaml の設定・トラブルシューティング）を、日本語・英語で直した。

## 確かめたこと

- `npm run typecheck`：通った。
- `npx biome check .`：誤りなし。
- `npx vitest run`：2375 件が通り、8 件が落ちた。落ちた 8 件（`agent-sessions.test.ts` の読めないファイル・`context-mcp.test.ts` の確保の巻き戻し・
  `host-mcp-processes.test.ts` の実際のプロセス）は、変更の前の main でも同じく落ちる（root で動かす作業環境で、ファイルの権限・プロセスの
  扱いが違うため）。
- 足したテスト：工程が利用制限で代わりに切り替わり、期限まで代わりを使い、過ぎたら戻る・代わりも制限なら止める・利用制限でない失敗では
  切り替えない・ゴールガーディアンの判定をその場でやり直す・オーケストレーターを別の種類のエージェントに切り替えたらやり取りを引き継ぐ
  （`daemon.test.ts`）、設定の読み方（`agent-defaults.test.ts`）、やり取りの書き出し（`orchestrator-handoff.test.ts`）、保存したセッションの
  引き継ぎの判断（`orchestrator-sessions.test.ts`）。
- 実際の Claude Code・Codex の利用制限での動作は確かめていない（制限を起こせないため）。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | — |

## 残したこと

- 書き出し・マージの後の監視・監査・質問への答えは、利用制限で失敗したときに止めずにやり直さない（次の実行から代わりを使う）。
- 制限が戻る時刻をエラーの文から読まず、決まった時間（`cooldown_minutes`）だけ使わない。
