# sacty launch の Codex で、手元の設定と同じ名前の MCP サーバーがあっても起動できるようにする

- 日付: 2026-11-11（UTC）
- タスク: なし
- PR: なし
- ブランチ: ccr-805f354d-tec1x2
- 関係する ADR: [プロジェクトのコンテキストで、ホストの Claude Code・Codex を利用者のログインのまま対話で起動する CLI を足し、作業履歴には記録しない](../adr/20261110-0011-launch-local-agent-with-project-context.md)

## 目的

依頼者から、`sacty launch` を Codex で使うと「Error: url is not supported for stdio in mcp_servers.xxx」で起動しないと報告があった。
原因を突き止めて直す。

## したこと

- 原因：Codex の `-c` は、表を置き換えずに利用者の設定に重ねる。利用者の `config.toml` にコマンド型（stdio）の `mcp_servers.xxx` があり、コンテキストに同じ名前の URL 型の MCP サーバーがあると、`-c mcp_servers.xxx={ url = … }` が利用者の表と混ざり、`command` と `url` を両方持つ設定になって起動しない。
  これまでは、コンテキストと同じ名前の利用者の MCP サーバーを止めず、そのまま重ねていた（同じ型でも、`env` などのキーが混ざっていた）。
- `apps/daemon/src/local-launch.ts`（`codexLaunch`）：利用者の MCP サーバーは、すべて `enabled=false` にした。利用者のものと同じ名前のコンテキストの MCP サーバーは、`<名前>-sacty`（使われていれば `-sacty-2`・`-3`…）で渡し、計画の `renamed` に入れた。
- `packages/cli/src/launch.ts`：名前を変えた MCP サーバーを、起動の前に注意として表示する。
- テスト：名前がぶつかる場合のテストを足した。元のテストの、コンテキストと同じ名前の利用者の MCP サーバーをそのまま重ねることを期待していた部分（今回の不具合そのもの）は、利用者の MCP サーバーを別の名前だけにして、元の狙いに絞った。
- ドキュメント：仕様書（`docs/spec/context.md` の Codex への渡し方）とユーザードキュメント（`docs/user/cli.md`）を日英で直した。

## 確かめたこと

- Codex 0.167.0（作業用の `HOME`）で再現した。利用者の `config.toml` に `[mcp_servers.xxx] command = "echo"` を書き、`codex mcp list -c 'mcp_servers.xxx={ url = "http://127.0.0.1:9/ctx-mcp/xxx", … }'` を実行すると「failed to load bootstrap configuration … url is not supported for stdio」。利用者の設定に無ければ動く。
- `-c 'mcp_servers={ xxx = { url = … } }'`（表を丸ごと）でも、`command = ""` を足しても、同じ誤りになった（`-c` では置き換えも、キーを消すこともできない）。
- 直した `codexLaunch` の引数（`mcp_servers.xxx-sacty={ url = … }` と `mcp_servers.xxx.enabled=false`）で `codex mcp list` を実行すると、利用者の `xxx` が `disabled`、`xxx-sacty` が `enabled` で出た。
- 足したテストは、直す前の `codexLaunch` では失敗することを確かめた。
- `npx vitest run apps/daemon/src/local-launch.test.ts packages/cli`（29 件）・`npx vitest run tests/docs`（93 件）：成功。`npm run lint`・`npm run typecheck`：成功。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| なし | なし |

## 残したこと

- ログインした Codex での対話の起動での確認（この環境ではログインできない）。
