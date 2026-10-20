**日本語** | [English](configuration.en.md)

# 設定（config.yaml）

`SACTY_HOME/config.yaml` は、マシンごとの設定（AI の接続先と単価・エージェントの上書き・イメージ・ゲートウェイ）を持つ。デーモンは
使うたびに読み直す（止めずに変えられる）。ただし `web.auth` は、`sacty up` の起動のときだけ読む（画面の子プロセスの環境に固定する。
変えたら起動し直す）。読めない・形が違うときは、最初の誤りの場所（`path`）と理由を、画面の警告に出す文言にする。
`sacty config init` は雛形（`CONFIG_TEMPLATE`）を権限 0600 で書く（あれば `--force` が無いと止まる）。

エージェントの定義（モデル・リーズニングエフォート）の既定は、リポジトリの `config/agents.yaml` に持つ（`DEFAULT_AGENTS_PATH`）。
`loadConfig(home, defaultsPath)` は、既定に `config.yaml` の `agents` を重ねる。

利用者向けの書き方は [ユーザードキュメント](../user/README.md) にある。ここでは項目の意味と既定値、検査の規則を書く。

関係する ADR: [エージェントの既定をリポジトリに持ち、config.yaml は接続先と単価だけにする](../adr/20261018-1105-agent-defaults-in-repo.md)

## トップレベルの項目

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `image` | `sacty-agent:1.4.0`（`DEFAULT_IMAGE`） | 既定のイメージ。エージェントとテストの実行に使う |
| `providers` | `{}` | runtime ごとの接続先（下の「接続先」）。名前は `codex`・`claude` だけ |
| `default_agent` | `config/agents.yaml` の `default_agent` のうち、使える最初のもの | 既定の AI。エージェントの名前 |
| `guardian_agent` | `default_agent` | ゴールガーディアンの AI |
| `audit_agent` | `guardian_agent`（無ければ `default_agent`） | 完了したタスクの監査の AI（[監査](audit.md)） |
| `agent_fallback.cooldown_minutes` | `60`（`DEFAULT_FALLBACK_COOLDOWN_MINUTES`） | 利用制限（`usage_limit`）で失敗したエージェントを使わない時間（分。1〜1440 の整数）。その間は `agents` の `fallback` を使う（[エージェントの実行](agent-execution.md#利用制限のときの代わりのエージェント)） |
| `step_agents` | `{}` | 工程（`StepKey`。`deployment` はマージの後の監視の工程の確認）と `orchestrator` ごとの AI。書かなければ `default_agent`、統合レビュー（`integrate`）は `guardian_agent` |
| `agents` | `{}` | エージェントの既定の上書きと追加（下の「エージェントの既定と上書き」） |
| `budget.default_per_task_usd` | `1`（`DEFAULT_BUDGET_USD`） | 1タスクあたりの予算（米ドル。正の数） |
| `budget.default_per_audit_usd` | `1`（`DEFAULT_AUDIT_BUDGET_USD`） | 1回の監査の予算（米ドル。正の数。タスクの予算とは別。[監査](audit.md)） |
| `image_build` | なし | `sacty image build` の元（[エージェントの実行](agent-execution.md)の「イメージ」） |
| `images` | `{}` | 言語ごとのイメージ（同上） |
| `onepassword.account` | なし | 1Password のアカウント（[秘密情報](secrets.md)） |
| `gateway.host_address` | `host-gateway`（`DEFAULT_HOST_ADDRESS`） | コンテナから見たホストのアドレス。`^[A-Za-z0-9.:-]+$` |
| `gateway.retry.max_attempts` | `8` | AI の呼び出しの1件のリクエストで上流に送る回数（1〜50。最初の1回を含む） |
| `gateway.retry.max_wait_sec` | `600` | 一続きの失敗で待つ合計の上限（0〜86400 秒） |
| `gateway.platforms` | `{}` | 組織内 PF。名前は `^[a-z0-9][a-z0-9-]*$`（[ゲートウェイ](gateway.md)） |
| `gateway.mcp_servers` | `{}` | ホストで動かす MCP サーバー。名前は `^[A-Za-z0-9_-]+$`（同上） |
| `web.auth` | `true` | 画面の認証。`false` で OFF（真偽だけ。[デーモンの起動と終了](daemon-lifecycle.md#画面の認証)） |
| `run_timeout.agent_minutes` | `30` | エージェントの1回の実行の上限（分。1〜720 の整数。PBI-150）。過ぎたらコンテナを止め、時間切れ（`run.timeout`）にする（[エージェントの実行](agent-execution.md#コンテナ)） |
| `run_timeout.test_minutes` | `20` | テストのコマンドの1回の実行の上限（分。1〜720 の整数） |
| `run_timeout.roles` | `{}` | 役割ごとの上書き（分）。キーは工程（`investigate`・`requirements`・`design`・`implement` など）と `guardian`・`final-review`・`rework`・`orchestrator`・`chat`・`export`・`audit`・`audit-dive`。ほかのキーは誤り |
| `update_check` | `true` | sacty の最新版（GitHub Releases の最新のリリース）を確かめて画面に知らせる。`false` なら GitHub に問い合わせない（真偽だけ。[デーモンの起動と終了](daemon-lifecycle.md#最新版の確かめ)） |

ほかの検査：`default_agent`・`guardian_agent`・`audit_agent`・`step_agents` の値が、エージェントに無いときは誤り（`config.agentMissing`）、
使えないエージェント（下の「使えるエージェント」）のときも誤り（`config.agentUnavailable`。使えない理由の文言を `reason` に載せる。設定が誤りのときは画面の警告を出さないため）。
`agents` の名前が段階（`claude_<段階>`・`codex_<段階>`。段階は `AGENT_TIERS` の `lite`・`entry`・`standard`・`advanced`・`ultimate`）なのに
`runtime` が接頭辞と合わないときも誤り（`config.tierRuntime`）。使える段階のエージェントは `tierAgents`（runtime ごと・段階ごと）にも集める
（`parseTierId`・`tierAgentsFor`）。置き方は [コンテキストの合成](context.md#実行のときに置くファイル)。

知らない項目は、誤りにせずに読まない。取り込みの間隔は `config.yaml` には無く、sacty の設定に持つ（[取り込み](intake.md#間隔)）。
以前の `github.poll_interval_sec`（`github:`）も、書いてあれば読まない（警告もしない）。

コード: `apps/daemon/src/config.ts`（`ConfigFile`・`loadConfig`・`DEFAULT_AGENTS_PATH`・`agentFor`・`CONFIG_TEMPLATE`）

## 接続先（providers）

`providers` は runtime ごとに1つ：`codex`（`runtime: codex`）と `claude`（`runtime: claude-code`）。`stub` は接続先を使わない。
ほかの名前は誤り（`config.providerLegacyName`。以前の、名前を付けた OpenAI 互換の接続先は、`providers.codex` の `auth` に書き直すよう示す）。

| 項目 | 既定値 | 意味 |
| --- | --- | --- |
| `auth` | （必須） | 認証（下の表） |
| `via_gateway` | `false` | AI の呼び出しをホストのゲートウェイ経由にする。`true` にできるのは `codex` の `auth.mode` が `bedrock`・`openai-compatible` のときだけ（`config.gatewayUnsupported`） |
| `available_models` | `{}` | モデルの名前ごとの単価（100万トークンあたりの米ドル）。`input`・`cached_input`・`output`（必須）・`cache_write`（既定 0） |

`auth.mode` と使える接続先：

| `auth.mode` | 項目 | `claude` | `codex` |
| --- | --- | --- | --- |
| `subscription` | `secret`（`claude` では必須。`config.subscriptionSecret`）・`auth_file`（Codex。既定 `~/.codex/auth.json`） | 可 | 可 |
| `api-key` | `secret` | 可 | 可 |
| `bedrock` | `secret`・`region`・`endpoint`（`runtime`｜`mantle`。`codex` だけ（`config.bedrockEndpointCodexOnly`）。省略は `runtime`） | 可 | 可 |
| `openai-compatible` | `base_url`（http・https）・`secret`（任意） | 不可 | 可 |

使えない組み合わせは誤り（`config.authUnsupported`）。実行のときは、エージェントの runtime の接続先から認証・ゲートウェイ・接続先を作る
（`providerKeyOf`・`connectionOf`）。`openai-compatible` は、実行のときの `auth.mode` を `provider` にし、`base_url`（末尾の `/` を除く）・
`secret`・`via_gateway` を `endpoint` に置く（名前は `codex`。[エージェントの実行](agent-execution.md#認証)）。

コード: `apps/daemon/src/config.ts`（`ProviderFile`・`ProviderAuth`・`PriceFile`・`refineProvider`・`providerKeyOf`・`connectionOf`）

## エージェントの既定と上書き

リポジトリの `config/agents.yaml`（`DefaultsFile`）は、`default_agent`（候補の並び。1つ以上）と `agents`（名前ごとの定義。`runtime` は必須）を持つ。
読めない・形が違うときは、ファイルの場所と理由を示して止める（`config.defaultsUnreadable`）。

| 名前 | `runtime` | `model` | `reasoning_effort` |
| --- | --- | --- | --- |
| `codex_lite` | `codex` | `gpt-6-luna` | `low` |
| `codex_entry` | `codex` | `gpt-6-luna` | `high` |
| `codex_standard` | `codex` | `gpt-6.1-sol` | `low` |
| `codex_advanced` | `codex` | `gpt-6.1-sol` | `medium` |
| `codex_ultimate` | `codex` | `gpt-6.1-sol` | `high` |
| `claude_lite` | `claude-code` | `claude-haiku-5-5` | なし |
| `claude_entry` | `claude-code` | `claude-sonnet-5-5` | `low` |
| `claude_standard` | `claude-code` | `claude-sonnet-5-5` | `medium` |
| `claude_advanced` | `claude-code` | `claude-opus-5-5` | `medium` |
| `claude_ultimate` | `claude-code` | `claude-opus-5-5` | `high` |

`default_agent` の候補は `codex_standard`、`claude_standard` の順。`config.yaml` に `default_agent` が無ければ、候補のうち使える最初のものにする。
使えるものが無ければ誤り（`config.noDefaultAgent`）。

`config.yaml` の `agents`（`AgentFile`）：

| 項目 | 意味 |
| --- | --- |
| `runtime` | `claude-code`・`codex`・`stub`。既定にある名前では省ける。既定に無い名前では必須（`config.agentRuntimeRequired`） |
| `model` | モデル。`claude-code`・`codex` では、既定と重ねた結果に必須（`config.agentModelRequired`。単価を `available_models` から引くため） |
| `reasoning_effort` | リーズニングエフォート（任意。`^[a-z][a-z0-9_-]{0,30}$`）。Codex は `model_reasoning_effort`、Claude Code は `--effort` で渡す |
| `fallback` | 利用制限のときに代わりに使うエージェントの名前（任意。1つか並びで、上から順に試す）。`agents` に無い名前は誤り（`config.agentMissing`）、自分自身も誤り（`config.agentFallbackSelf`）。使えないエージェントは警告して外す（`config.agentFallbackUnavailable`） |
| `price_per_mtok_usd` | `runtime: stub` だけ。単価（書き方は `available_models` と同じ。書かなければ 0） |
| `stub` | `runtime: stub` の出力（工程・オーケストレーター・ゴールガーディアンなどの既定の出力、トークン数、`fail: usage_limit｜auth` で失敗の再現） |

- 既定と同じ名前は、書いた項目だけを既定に重ねる（書いていない項目は既定のまま）。既定に無い名前は、そのエージェントを足す。
- エージェントに `auth`・`provider`・`via_gateway` を書くと誤り。`stub` 以外に `price_per_mtok_usd` を書いても誤り（`config.agentLegacyKey`。
  `providers` の `auth`・`via_gateway`・`available_models` に書くよう示す）。以前の書き方は自動では読み替えない。
- `agents` の名前は空にできない（`config.agentNameEmpty`。タスクの詳細で選んだ名前を作業履歴に残すため）。

コード: `apps/daemon/src/config.ts`（`DefaultsFile`・`AgentFile`・`LEGACY_AGENT_KEYS`・`loadDefaults`・`buildAgents`・`StubBehavior`・`fallbackAgentFor`）

## 使えるエージェント

既定と上書きを重ねたエージェントのうち、次のものは使えない扱い（unusable）にする。設定の誤りにはしない（sacty の更新で既定のモデルが
変わっても、設定が読めなくならないように）。使えないエージェントは `agents`・`tierAgents` に入れず、タスクの詳細の選択肢にも出さない。

- runtime の接続先（`providers.codex`・`providers.claude`）が無い。利用者が `config.yaml` の `agents` に書いたエージェントだけ警告する
  （`config.agentProviderMissing`）。既定のエージェントは、その runtime を使っていないだけなので警告しない。
- モデルの単価が、接続先の `available_models` に無い（継承したプロパティの名前は単価としない）。モデルごとにまとめて、使えないエージェントの
  名前を並べて警告する（`config.modelPriceMissing`）。

警告は `agentWarnings` に持ち、画面の警告（`GET /api/status` の `warnings`）に出す。`runtime: stub` のエージェントは、接続先・単価を
見ずに使える（単価は `price_per_mtok_usd`、無ければ 0）。

使う AI と役割の対応は `agentFor`：`step_agents` にあればそれ、無ければ `default_agent`（`integrate` は `guardian_agent`）。
工程（マージの後の監視・外部作業・書き出しを含む）は、人がタスクの詳細で選んだエージェントがあれば、それを優先する（`stepAgentFor`。[工程のエージェントを人が変える](tasks-and-steps.md#工程のエージェントを人が変える)）。
作業履歴には、使った AI の `authMode`・`model`・`reasoningEffort` だけを残す（秘密の値・接続先の URL は残さない。`agentSetting`）。

コード: `apps/daemon/src/config.ts`（`buildAgents`・`loadConfig`・`agentFor`・`stepAgentFor`・`agentSetting`）、`apps/daemon/src/service.ts`（`TaskService.status`）

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
