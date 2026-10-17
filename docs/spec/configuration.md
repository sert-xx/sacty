**日本語** | [English](configuration.en.md)

# 設定（config.yaml）

`SACTY_HOME/config.yaml` は、マシンごとの設定（AI のエージェント・認証・イメージ・ゲートウェイ）を持つ。デーモンは
使うたびに読み直す（止めずに変えられる）。読めない・形が違うときは、最初の誤りの場所（`path`）と理由を、画面の警告に出す文言にする。
`sacty config init` は雛形（`CONFIG_TEMPLATE`）を権限 0600 で書く（あれば `--force` が無いと止まる）。

利用者向けの書き方は [ユーザードキュメント](../user/README.md) にある。ここでは項目の意味と既定値、検査の規則を書く。

関係する ADR: なし

## トップレベルの項目

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `image` | `sacty-agent:0.1.0`（`DEFAULT_IMAGE`） | 既定のイメージ。エージェントとテストの実行に使う |
| `default_agent` | （必須） | 既定の AI。`agents` にある名前 |
| `guardian_agent` | `default_agent` | ゴールガーディアンの AI |
| `step_agents` | `{}` | 工程（`StepKey`。`deployment` はマージの後の監視の工程の確認）と `orchestrator` ごとの AI。書かなければ `default_agent`、統合レビュー（`integrate`）は `guardian_agent` |
| `agents` | （必須） | エージェントの定義（下の「エージェント」） |
| `providers` | `{}` | OpenAI 互換（Responses API）の接続先。名前は `^[A-Za-z0-9_-]+$`。`base_url`（http・https）・`secret`（任意）・`via_gateway`（既定 `false`） |
| `budget.default_per_task_usd` | `1`（`DEFAULT_BUDGET_USD`） | 1タスクあたりの予算（米ドル。正の数） |
| `image_build` | なし | `sacty image build` の元（[エージェントの実行](agent-execution.md)の「イメージ」） |
| `images` | `{}` | 言語ごとのイメージ（同上） |
| `onepassword.account` | なし | 1Password のアカウント（[秘密情報](secrets.md)） |
| `gateway.host_address` | `host-gateway`（`DEFAULT_HOST_ADDRESS`） | コンテナから見たホストのアドレス。`^[A-Za-z0-9.:-]+$` |
| `gateway.retry.max_attempts` | `8` | AI の呼び出しの1件のリクエストで上流に送る回数（1〜50。最初の1回を含む） |
| `gateway.retry.max_wait_sec` | `600` | 一続きの失敗で待つ合計の上限（0〜86400 秒） |
| `gateway.platforms` | `{}` | 組織内 PF。名前は `^[a-z0-9][a-z0-9-]*$`（[ゲートウェイ](gateway.md)） |
| `gateway.mcp_servers` | `{}` | ホストで動かす MCP サーバー。名前は `^[A-Za-z0-9_-]+$`（同上） |

ほかの検査：`default_agent`・`guardian_agent`・`step_agents` の値が `agents` に無い、`provider` の名前が `providers` に無いときは誤り。
`agents` の名前が段階（`claude_<段階>`・`codex_<段階>`。段階は `AGENT_TIERS` の `lite`・`entry`・`standard`・`advanced`・`ultimate`）なのに
`runtime` が接頭辞と合わないときも誤り（`config.tierRuntime`）。段階のエージェントは `tierAgents`（runtime ごと・段階ごと）にも集める
（`parseTierId`・`tierAgentsFor`）。置き方は [コンテキストの合成](context.md#実行のときに置くファイル)。雛形（`CONFIG_TEMPLATE`）には、両 runtime の 5 段階すべての例を
コメントで入れる。

知らない項目は、誤りにせずに読まない。取り込みの間隔は `config.yaml` には無く、sacty の設定に持つ（[取り込み](intake.md#間隔)）。
以前の `github.poll_interval_sec`（`github:`）も、書いてあれば読まない（警告もしない）。

コード: `apps/daemon/src/config.ts`（`ConfigFile`・`loadConfig`・`agentFor`・`CONFIG_TEMPLATE`）

## エージェント（agents）

| 項目 | 意味 |
| --- | --- |
| `runtime` | `claude-code`・`codex`・`stub` |
| `model` | モデル（任意） |
| `reasoning_effort` | リーズニングエフォート（任意。`^[a-z][a-z0-9_-]{0,30}$`）。Codex は `model_reasoning_effort`、Claude Code は `--effort` で渡す |
| `auth` | 認証（下の表）。`auth` の代わりに `provider: <名前>` だけを書くと、`auth: { mode: provider, provider: <名前> }` として読む |
| `price_per_mtok_usd` | 100万トークンあたりの米ドル。`input`・`cached_input`・`output`（必須）・`cache_write`（既定 0） |
| `via_gateway` | 既定 `false`。`true` にできるのは `runtime: codex` かつ `auth.mode: bedrock` のときだけ |
| `stub` | `runtime: stub` の出力（工程・オーケストレーター・ゴールガーディアンなどの既定の出力、トークン数、`fail: usage_limit｜auth` で失敗の再現） |

`auth.mode` と使える `runtime`：

| `auth.mode` | 項目 | `claude-code` | `codex` | `stub` |
| --- | --- | --- | --- | --- |
| `subscription` | `secret`（Claude Code では必須）・`auth_file`（Codex。既定 `~/.codex/auth.json`） | 可 | 可 | 不可 |
| `api-key` | `secret` | 可 | 可 | 不可 |
| `bedrock` | `secret`・`region`・`endpoint`（`runtime`｜`mantle`。Codex だけ。省略は `runtime`） | 可 | 可 | 不可 |
| `provider` | `provider`（`providers` の名前） | 不可 | 可 | 不可 |
| `stub` | なし | 不可 | 不可 | 可 |

`agents` の名前は空にできない（`config.agentNameEmpty`。タスクの詳細で選んだ名前を作業履歴に残すため）。
使う AI と役割の対応は `agentFor`：`step_agents` にあればそれ、無ければ `default_agent`（`integrate` は `guardian_agent`）。
工程（マージの後の監視・外部作業・書き出しを含む）は、人がタスクの詳細で選んだエージェントがあれば、それを優先する（`stepAgentFor`。[工程のエージェントを人が変える](tasks-and-steps.md#工程のエージェントを人が変える)）。
作業履歴には、使った AI の `authMode`・`model`・`reasoningEffort` だけを残す（秘密の値・接続先の URL は残さない。`agentSetting`）。

コード: `apps/daemon/src/config.ts`（`Agent`・`Auth`・`Provider`・`StubBehavior`・`agentFor`・`agentSetting`）

## イメージの設定の検査

- `image_build.npm_config`：認証の項目（`_auth`・`_authToken`・`_password`・`username`・`email`・`certfile`・`keyfile`・`cert`・`key`。
  `//host/:_authToken` のようにレジストリに結びつけたものも）は書けない。値に改行は書けない。
- `image_build.npm_version`：`latest` か `数字(.数字){0,2}`。
- `images` の名前：`^(?!default$)[a-z0-9][a-z0-9_-]{0,39}$`（`default` は既定のイメージを指すので使えない）。
- `images.<名前>.env`：名前は `^[A-Z_][A-Z0-9_]*$`。認証の値らしい名前（`TOKEN`・`PASSWORD`・`PASSWD`・`SECRET`・`CREDENTIAL`・`AUTH`・
  `API_KEY`・`PRIVATE_KEY` を含む）とユーザー名・パスワードを含む URL は書けない。`PATH`・`HOME`・`USER`・`SHELL`・`TMPDIR`・
  `NODE_OPTIONS` と、`DOCKER_`・`SACTY_`・`CODEX_`・`CLAUDE_`・`ANTHROPIC_`・`OPENAI_`・`NPM_CONFIG_` で始まる名前は書けない。
- `images.<名前>.packages`・`enable_repos`・`run`：決まった文字だけ（シェルの特別な文字を含まない）。`run` は1行ずつ。
  `enable_repos` は `packages` と一緒に書く。
- `images.<名前>.maven_mirror`：http・https の URL で、ユーザー名・パスワードや引用符などの記号を含まない。

コード: `apps/daemon/src/config.ts`（`NPM_SECRET_KEY`・`IMAGE_ENV_SECRET_NAME`・`IMAGE_ENV_RESERVED`・`hasUserInfo`）
