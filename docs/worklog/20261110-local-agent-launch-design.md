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
- 公式の文書（developers.openai.com）は、この環境のネットワークの設定で開けなかった。
- Codex 0.167.0 を作業用のディレクトリに npm で入れ、`HOME` を作業用のディレクトリにして（利用者の設定を使わずに）、ログインせずに次を確かめた。
  - `codex debug prompt-input -c developer_instructions='"…"'`：渡した文が developer の入力に入る。
  - `-c features.multi_agent=true -c agents.lite.config_file="<パス>" -c agents.lite.description="…"`：`lite` がサブエージェントの「Available roles」に出る。
  - `codex mcp list -c 'mcp_servers.<名前>={url="http://127.0.0.1:9/…", http_headers={…}}' -c 'mcp_servers.mine.enabled=false'`：加えたサーバーが `enabled`、`config.toml` にあるサーバーが `disabled` で出る。
  - `--add-dir` に置いた `.agents/skills/` と、`-c skills.config=[…]` では、スキルは一覧に出なかった（スキルの置き場所を足す設定は見つからなかった）。そのため、スキルは工程の実行と同じく、規則の一覧から場所を示して読ませる。
  - 本体の文字列で、認証の環境変数（`OPENAI_API_KEY`・`CODEX_API_KEY`・`CODEX_ACCESS_TOKEN`）を見た。`CODEX_ACCESS_TOKEN` は Agent Identity の認証と `codex login --with-access-token` に使われていて、ChatGPT のアカウントのログインのトークンを渡せるかは分からなかった。
- 認証をキーチェーンに置く設定（`cli_auth_credentials_store`）で `CODEX_HOME` を変えるとログインできなくなることは、依頼者が実際に使って確かめていた。
- `npx vitest run tests/docs`：3 ファイル・93 件すべて成功。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 依頼者：キーチェーンのログインは、`CODEX_HOME` を変えると使えなくなることを実際に確かめている | ADR の決定・理由・影響を、確かめたこととして直した（キーチェーンのときは止めて、使える方法を表示する） |
| 依頼者：Codex のキーチェーンのログインも使えるようにしてほしい | `CODEX_HOME` を変えず、合成したものを `-c` で渡すことにした（上の「確かめたこと」の Codex の確認）。キーチェーンのときに止める決定は消した |
| 依頼者：sacty が取り出した認証の情報を、環境変数で Codex に渡すのはどうか | 採らなかった。ChatGPT のアカウントのログインは更新用トークンが使うたびに新しくなり、一時ディレクトリの Codex が更新すると利用者のログインが切れるため（ADR の理由に、比べた案として書いた） |

## 残したこと

- 実装（CLI・デーモンの API）と、仕様書（`docs/spec/context.md`）・ユーザードキュメント（`docs/user/cli.md`）の更新。
- ADR の影響に書いた、実際の CLI での確認。
