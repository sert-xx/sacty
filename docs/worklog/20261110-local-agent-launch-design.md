# プロジェクトのコンテキストでホストの Claude Code・Codex を起動する CLI の方針を、ADR に決める

- 日付: 2026-11-10（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-805f354d-tec1x2
- 関係する ADR: [プロジェクトのコンテキストで、ホストの Claude Code・Codex を利用者のログインのまま対話で起動する CLI を足し、作業履歴には記録しない](../adr/20261110-0011-launch-local-agent-with-project-context.md)

## 目的

利用者が手元の端末で、プロジェクトのコンテキストを使って Claude Code・Codex と対話できる仕組みを足す前に、方針を決める。
人と決めたこと：CLI として足す・認証は利用者のログインのまま（sacty の API キーを使わない）・作業履歴には記録しない。
このタスクでは実装せず、ADR だけを足す（仕様書・ユーザードキュメントは、今の振る舞いを書くものなので実装の PR で直す）。

## したこと

- 工程の実行の組み立て（`apps/daemon/src/agents/invocation.ts` の `buildInvocation`）・MCP の置き換え（`apps/daemon/src/context.ts` の `routeMcp`）・ゲートウェイ（`apps/daemon/src/gateway.ts` の `listen`・`register`・`containerOrigin`）・プレビュー（`packages/cli/src/context-preview.ts`、`apps/daemon/src/server.ts` の `/api/projects/:id/context-preview`）を読み、ホストで使うときに合わない所（設定の場所・認証・MCP の宛先・権限のモード・作業履歴への記録）を洗い出した。
- ADR を足した。CLI（`sacty launch`）・デーモンの API・Claude Code と Codex への渡し方・安全のための扱いを決め、実装のときに確かめることを影響に書いた。

## 確かめたこと

- `claude --help`（Claude Code 2.1.321）で、`--settings`・`--mcp-config`・`--strict-mcp-config`・`--append-system-prompt-file`・`--agents`・`--add-dir`・`--plugin-dir` があることを確かめた。
- ゲートウェイが 127.0.0.1 で待ち受けること（`gateway.ts` の `listen`）をコードで確かめた。
- Codex はこの環境に入っておらず、公式の文書（developers.openai.com）もこの環境のネットワークの設定で開けなかったため、Codex の引数・認証の保存先（`cli_auth_credentials_store`）と `CODEX_HOME` の関係は確かめられていない（ADR の影響に、実装のときに確かめることとして書いた）。
- `npx vitest run tests/docs`：3 ファイル・93 件すべて成功。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- 実装（CLI・デーモンの API）と、仕様書（`docs/spec/context.md`）・ユーザードキュメント（`docs/user/cli.md`）の更新。
- ADR の影響に書いた、実際の CLI での確認。
