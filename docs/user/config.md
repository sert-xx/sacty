<!-- 対応するコード: apps/daemon/src/config.ts（ConfigFile・Agent・Auth・Provider・CONFIG_TEMPLATE）、packages/core/src/events.ts（StepKey・DEFAULT_BUDGET_USD）、apps/daemon/src/intake.ts -->

**日本語** | [English](config.en.md)

# config.yaml の設定

`~/.sacty/config.yaml`（`SACTY_HOME` を変えたら `$SACTY_HOME/config.yaml`）に書く、sacty 全体の設定です。
雛形は `npx sacty config init` で作ります（[CLI](cli.md#sacty-config-init)）。

プロジェクトごとの設定（対象・GitHub のアカウント・コンテキストリポジトリ・通知など）は、config.yaml ではなく画面の
[プロジェクトの設定](project-settings.md) に書きます。

## 項目の一覧

| 項目 | 意味 | 既定値 |
| --- | --- | --- |
| `default_agent` | 工程を実行する AI（`agents` の名前）。必須 | なし |
| `guardian_agent` | ゴールガーディアンに使う AI | `default_agent` |
| `step_agents` | 工程とオーケストレーター・デプロイの確認ごとに使う AI（[工程ごとのモデル](#工程ごとのモデル)） | 書かなければ `default_agent`（統合レビューは `guardian_agent`） |
| `agents` | AI の定義（名前ごと。[エージェント](#エージェント)）。必須 | なし |
| `providers` | OpenAI 互換の接続先（[ゲートウェイ](gateway.md#openai-互換の接続先providers)） | なし |
| `budget.default_per_task_usd` | 1タスクあたりの予算（米ドル。0 より大きい数） | `1` |
| `image` | エージェントとテストの実行に使うイメージ | `sacty-agent:0.1.0` |
| `image_build` | `sacty image build` の元のイメージと npm の設定（[コンテナイメージ](images.md)） | なし |
| `images` | 言語ごとのイメージ（[コンテナイメージ](images.md#言語ごとのイメージ)） | なし |
| `onepassword.account` | 使う 1Password のアカウント（[秘密情報](secrets.md#1password)） | なし |
| `gateway` | ホストのゲートウェイ（[ゲートウェイ](gateway.md)） | なし |
| `github.poll_interval_sec` | Issue・PR・チケットを取り込む間隔（秒。60 以上の整数）。`github:` を書かなければ取り込まない（[取り込み](intake.md)） | `300` |

設定に誤りがあると、どの項目（例 `agents.claude-subscription.auth.secret`）の何が誤りかを画面に出します。

## エージェント

`agents` に、名前ごとに AI を書きます。

```yaml
agents:
  claude-subscription:
    runtime: claude-code
    auth:
      mode: subscription
      secret: claude-oauth-token
    price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }
```

| 項目 | 意味 | 既定値 |
| --- | --- | --- |
| `runtime` | `claude-code`・`codex`・`stub`（動作確認用。実際の AI は呼ばない） | 必須 |
| `model` | モデル | エージェントの既定 |
| `reasoning_effort` | リーズニングエフォート（Codex の `model_reasoning_effort`、Claude Code の `--effort`）。英小文字で始まる、英小文字・数字・`_`・`-` | エージェントの既定 |
| `auth` | 認証方式（[認証方式](#認証方式)）。`provider` を書くときは書かない | 必須 |
| `provider` | `auth` の代わりに書く、`providers` の接続先の名前（Codex だけ） | なし |
| `price_per_mtok_usd` | 100万トークンあたりの単価（米ドル）。`input`・`cached_input`・`output` は必須、`cache_write` は任意 | `cache_write` は `0` |
| `via_gateway` | AI の呼び出しを、ホストのゲートウェイ経由にする（Codex × Bedrock だけ。[ゲートウェイ](gateway.md#ai-の呼び出しを中継する)） | `false` |

単価は、利用するモデルの最新の単価に合わせてください。契約で単価が違う場合は、その単価を書きます。費用は、この単価とトークン数から計算します。
サブスクリプションでは実際の請求は発生しませんが、同じ単価で換算した値を費用として扱い、予算の判定に使います。

## 認証方式

| AI | 認証方式（`auth.mode`） | 用意するもの |
| --- | --- | --- |
| Claude Code | `subscription` | `claude setup-token` で作ったトークン（`secret` は必須） |
| Claude Code | `api-key` | Anthropic の API キー |
| Claude Code | `bedrock` | Bedrock の API キーと `region`。`model` は推論プロファイル ID |
| Codex | `subscription` | ChatGPT でのログイン（`auth_file`。既定 `~/.codex/auth.json`） |
| Codex | `api-key` | OpenAI の API キー |
| Codex | `bedrock` | Bedrock の API キーと `region`。`endpoint` は `runtime`（既定。`model` は推論プロファイル ID、例 `global.openai.gpt-6-sol`）か `mantle`（`model` は例 `openai.gpt-6-sol`） |
| （動作確認用） | `stub` | なし。`runtime: stub` のときだけ使える |

- トークンや API キーは `secret` に名前（または 1Password の参照）だけを書き、値はキーチェーンか 1Password に置きます（[秘密情報](secrets.md)）。
- `endpoint` は Codex だけで使います。Claude Code の `bedrock` に書くと誤りになります。
- コンテナには、選んだ認証方式の環境変数だけを渡します（ホストの `ANTHROPIC_API_KEY` などは引き継ぎません）。

```yaml
agents:
  codex-bedrock:
    runtime: codex
    model: global.openai.gpt-6-sol
    auth:
      mode: bedrock
      secret: bedrock-api-key
      region: us-east-2
      endpoint: runtime
    via_gateway: true
    price_per_mtok_usd: { input: 1.25, cached_input: 0.125, output: 10 }
```

## 工程ごとのモデル

エージェントを「接続先・モデル・リーズニングエフォート・単価」の組で書き、`step_agents` で工程とオーケストレーターごとに選びます。

```yaml
default_agent: luna-low
guardian_agent: sol-high
step_agents:          # 書かなければ default_agent（統合レビューは guardian_agent）
  orchestrator: luna-low
  requirements: sol-high
  design: sol-high
```

`step_agents` に書けるキーは、`orchestrator` と工程の `investigate`（調査）・`review`（レビュー）・`requirements`（要求要件）・
`design`（設計）・`split`（タスク分割）・`integrate`（統合レビュー）・`reproduce`（再現）・`implement`（実装）・`pr`（PR）と、
`deployment`（マージの後のデプロイの確認。[マージの後の監視](deployment-watch.md)）です。
`default_agent`・`guardian_agent`・`step_agents` に、`agents` に無い名前を書くと誤りになります。

## 予算

- 1タスクあたりの予算の既定値は `budget.default_per_task_usd`（既定 $1）です。
- 予算の 80% で作業履歴に通知を記録し、上限に達したら一時停止します（作業は残します）。再開するときは、累計の新しい上限を画面で入力します。
- サブスクリプションの利用上限や認証エラーでも一時停止し、再開すると止まった工程を実行し直します。

## 関係するページ

- [秘密情報](secrets.md)
- [ゲートウェイ](gateway.md)
- [コンテナイメージ](images.md)
