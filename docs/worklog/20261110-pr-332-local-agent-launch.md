# プロジェクトのコンテキストでホストの Claude Code・Codex を起動する CLI（sacty launch）を、ADR を決めてから足す

- 日付: 2026-11-10（UTC）
- タスク: なし
- PR: #332
- ブランチ: ccr-805f354d-tec1x2
- 関係する ADR: [プロジェクトのコンテキストで、ホストの Claude Code・Codex を利用者のログインのまま対話で起動する CLI を足し、作業履歴には記録しない](../adr/20261110-0011-launch-local-agent-with-project-context.md)

## 目的

利用者が手元の端末で、プロジェクトのコンテキストを使って Claude Code・Codex と対話できるようにする。
人と決めたこと：CLI として足す・認証は利用者のログインのまま（sacty の API キーを使わない。Codex のキーチェーンのログインも使えるようにする）・作業履歴には記録しない。
先に ADR で方針を決め、人が確かめてから実装した。

## したこと

- 工程の実行の組み立て（`apps/daemon/src/agents/invocation.ts` の `buildInvocation`）・MCP の置き換え（`apps/daemon/src/context.ts` の `routeMcp`）・ゲートウェイ（`apps/daemon/src/gateway.ts` の `listen`・`register`・`containerOrigin`）・プレビュー（`packages/cli/src/context-preview.ts`、`apps/daemon/src/server.ts` の `/api/projects/:id/context-preview`）を読み、ホストで使うときに合わない所（設定の場所・認証・MCP の宛先・権限のモード・作業履歴への記録）を洗い出した。
- ADR を足した。CLI（`sacty launch`）・デーモンの API・Claude Code と Codex への渡し方・安全のための扱いを決め、実装のときに確かめることを影響に書いた。実装の後、実装で決めたこと（段階を渡さない場合・外部 PF の案内・渡さないファイルの知らせ）と、確かめたことを書き足した。
- デーモン
  - `apps/daemon/src/service.ts`：`createLocalSession`・`closeLocalSession`。`prepareContext` を、ゲートウェイの起点をホストから見たもの（`mcpRouting` に起点を渡せるようにした）にして呼び、コマンド型の MCP の確保・ゲートウェイの登録・秘密情報の取り出しをして、置くファイルと環境変数を返す。作業履歴には書かない。
  - `apps/daemon/src/server.ts`：`POST /api/projects/:id/local-sessions`・`DELETE /api/local-sessions/:id`。
  - `apps/daemon/src/gateway.ts`：`hostOrigin`。`platformsUrl` に起点を渡せるようにした。
  - `apps/daemon/src/context.ts`：`prepareContext` が、置いたファイルの一覧（パスと層）も返すようにした。
  - `apps/daemon/src/local-launch.ts`（`@sacty/daemon/local-launch` として公開）：受け取ったファイルから、Claude Code・Codex の引数と置くファイルを組み立てる（`claudeLaunch`・`codexLaunch`・`codexUserMcpServers`）。
  - `packages/core/src/messages.ts`：`local.tiersSkipped`。
- CLI
  - `packages/cli/src/launch.ts`：一時ディレクトリを作り、セッションを作ってファイルを置き、AI の CLI を起動し、終わったら後片付けする。`--` の後の引数を分ける（`splitLaunchArgs`）。
  - `packages/cli/src/index.ts`：`sacty launch` と、使い方の表示。
  - `packages/cli/src/context-preview.ts`：プロジェクトの探し方とデーモンの呼び方を、`resolveProjectId`・`daemonRequest` に切り出した（`launch` でも使う）。
- ドキュメント：仕様書（`docs/spec/context.md` の「ローカルのセッション」、`architecture.md` の API と `daemon.json`、`daemon-lifecycle.md`）とユーザードキュメント（`docs/user/cli.md`）を、日英で直した。

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
- 実装の後、既定のコンテキストを `prepareContext` で合成し、`codexLaunch`・`claudeLaunch` で組み立てた引数を、実際の CLI に渡した（作業用のディレクトリの `HOME` で、利用者の設定を使わずに）。
  - Codex 0.167.0：`codex debug prompt-input` で、既定の規則（「sacty の既定の規則」）と、一時ディレクトリの絶対パスのスキルの一覧が入力に入り、段階 `standard` が「Available roles」に出た。`codex mcp list` で、コンテキストの MCP サーバーが `enabled`、利用者の `config.toml` の MCP サーバーが `disabled` で出た。ログインした対話の起動は確かめていない。
  - Claude Code 2.1.321：この環境では `claude -p` が実際に答えたので、組み立てた引数で、使えるスキル・サブエージェント・規則の見出しを答えさせた。既定のコンテキストのスキル（`review-dispatch` など）が名前のまま、段階 `standard` がサブエージェントとして出て、規則の見出しも入っていた。
  - Claude Code：設定に `permissions.defaultMode: bypassPermissions` を書いて `touch` を頼むと、設定だけでは実行され、sacty の引数（`--permission-mode default`）を付けると承認を求めて実行されなかった。
  - 確かめる中で、既定のコンテキストのファイルの層の名前が `sacty-default@<コミット>` の形で、渡さないファイルの知らせから外す判定が合っていないことが分かり、直した（テストの例も同じ形にした）。
- `npm run lint`：成功。
- `npm run typecheck`：成功。
- `npm run build`：成功。
- 直したテスト（既定のコンテキストのファイルを注意から外す）は、判定を戻すと失敗することを確かめた。
- `npx vitest run apps/daemon/src/local-launch.test.ts packages/cli`：成功。`npx vitest run apps/daemon/src/daemon.test.ts -t "ローカルのセッション"`：4 件成功。
- `npx vitest run`（全体）：7 ファイル・19 件が失敗。うち 6 ファイル・17 件（`repository.test.ts` の `git merge-tree`、`agent-sessions.test.ts`・`context-mcp.test.ts` の読めないファイル、`host-mcp-processes.test.ts`、画面の 2 つの browser テストの Chromium が無いこと）は、変更を退避した元のコードでも同じく失敗した（この環境の git の版・root での実行・ブラウザが無いことによる）。残りの `daemon.test.ts` の「タスクの並行実行」の 2 件は、単独で 3 回流して 3 回とも成功し、全体を流した 1 回目でも失敗していなかったので、負荷による揺れとみた。
- `npx vitest run tests/docs`：3 ファイル・93 件すべて成功。

## レビューの指摘と対応

| 指摘 | 対応 |
| --- | --- |
| 依頼者：キーチェーンのログインは、`CODEX_HOME` を変えると使えなくなることを実際に確かめている | ADR の決定・理由・影響を、確かめたこととして直した（キーチェーンのときは止めて、使える方法を表示する） |
| 依頼者：Codex のキーチェーンのログインも使えるようにしてほしい | `CODEX_HOME` を変えず、合成したものを `-c` で渡すことにした（上の「確かめたこと」の Codex の確認）。キーチェーンのときに止める決定は消した |
| 依頼者：sacty が取り出した認証の情報を、環境変数で Codex に渡すのはどうか | 採らなかった。ChatGPT のアカウントのログインは更新用トークンが使うたびに新しくなり、一時ディレクトリの Codex が更新すると利用者のログインが切れるため（ADR の理由に、比べた案として書いた） |

## 残したこと

- Codex を、実際にログインした対話で起動しての確認（この環境では Codex にログインできない）。
- macOS（sacty の対象の OS）での起動の確認（この環境は Linux）。
- `--` の後の引数で、sacty が渡した引数と同じものを渡したときにどちらが効くかの確認（ユーザードキュメントには、AI の CLI の決まりによると書いた）。
