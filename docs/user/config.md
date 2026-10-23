<!-- 対応するコード: apps/daemon/src/config.ts（ConfigFile・ProviderFile・ProviderAuth・AgentFile・loadConfig・CONFIG_TEMPLATE）、config/agents.yaml、packages/core/src/events.ts（StepKey・DEFAULT_BUDGET_USD） -->

**日本語** | [English](config.en.md)

# config.yaml の設定

`~/.sacty/config.yaml`（`SACTY_HOME` を変えたら `$SACTY_HOME/config.yaml`）に書く、sacty 全体の設定です。
雛形は `npx sacty config init` で作ります（[CLI](cli.md#sacty-config-init)）。

プロジェクトごとの設定（対象・GitHub のアカウント・コンテキストリポジトリなど）は、config.yaml には書かず、画面の [プロジェクトの設定](project-settings.md) に書きます。

## 項目の一覧

| 項目 | 意味 | 既定値 |
| --- | --- | --- |
| `providers` | runtime ごとの接続先（認証）と、使えるモデルの単価（[接続先と単価](#接続先と単価providers)）。`codex` と `claude` だけ | なし |
| `default_agent` | 工程を実行する AI（エージェントの名前） | `codex_standard`（使えなければ `claude_standard`） |
| `guardian_agent` | ゴールガーディアンに使う AI | `default_agent` |
| `audit_agent` | 完了したタスクの監査に使う AI（[監査](audit.md)） | `guardian_agent`（無ければ `default_agent`） |
| `agent_fallback.cooldown_minutes` | 失敗したエージェントを使わず、代わりのエージェントを使う時間（分。1〜1440 の整数。[失敗したときの切り替え](#失敗したときの切り替え)） | `60` |
| `step_agents` | 工程（マージの後の監視を含む）・オーケストレーター・情報収集ごとに使う AI（[工程ごとのモデル](#工程ごとのモデル)） | 書かなければ `default_agent`（統合レビューは `guardian_agent`、情報収集はオーケストレーターの AI） |
| `agents` | sacty の既定のエージェントの上書き・追加（[エージェントの上書き](#エージェントの上書き)）。任意 | なし（sacty の既定を使う） |
| `budget.default_per_task_usd` | 1タスクあたりの予算（米ドル。0 より大きい数） | `1` |
| `budget.per_plan_usd` | 工程の組み合わせごとの予算（米ドル。0 より大きい数。[予算](#予算)） | なし（`budget.default_per_task_usd`） |
| `budget.default_per_audit_usd` | 1回の監査の予算（米ドル。0 より大きい数。タスクの予算とは別。[監査](audit.md#予算)） | `1` |
| `image` | エージェントの実行に使うイメージ | `sacty-agent:1.9.0` |
| `image_build` | `sacty image build` の元のイメージと npm の設定（[コンテナイメージ](images.md)） | なし |
| `images` | 言語ごとのイメージ（[コンテナイメージ](images.md#言語ごとのイメージ)） | なし |
| `onepassword.account` | 使う 1Password のアカウント（[秘密情報](secrets.md#1password)） | なし |
| `gateway` | ホストのゲートウェイ（[ゲートウェイ](gateway.md)） | なし |
| `web.auth` | 画面の認証。`false` にすると、入り口の URL を開かなくても画面を使える（危険と切り替え方は [CLI](cli.md#sacty-up)）。`sacty up` の起動のときだけ読む | `true` |
| `run_timeout` | エージェントの1回の実行の上限（分。1〜720）。`agent_minutes`（エージェント）・`test_minutes`（テストを実行する最終レビュー `final-review` と再現 `reproduce` で、`agent_minutes` に足す分）と、役割ごとの上書きの `roles`（例：`implement: 90`・`guardian: 45`。上書きがあれば、その分だけになります）。過ぎるとコンテナを止め、タスクを一時停止します。次の実行から効きます | `agent_minutes: 30`・`test_minutes: 20` |
| `update_check` | sacty の新しいリリースを1日ごとに確かめ、あれば画面に出す（[sacty を更新する](getting-started.md#sacty-を更新する)）。インターネットに出られない環境では `false` にする（GitHub に問い合わせない） | `true` |

次の2つは、config.yaml には書かず、画面の「Sacty の設定」で決めます。

- 取り込みの間隔：取り込みの種類ごとに決めます（[取り込み](intake.md#取り込みの間隔)）。
- メモリーを残す日数（[監査を見る](audit.md#メモリー)）

以前の版の `github:`（`poll_interval_sec`）は、書いてあっても読みません。
消してかまいません。

設定に誤りがあると、sacty はどの項目（例 `providers.codex.auth.secret`）の何が誤りかを画面に出します。

## 接続先と単価（providers）

工程を動かす AI のモデルとリーズニングエフォートは、sacty が推奨する既定（[既定のエージェント](#既定のエージェント)）を使います。
config.yaml には、使うツールの接続先（認証）と、使えるモデルの単価（`available_models`）だけを書けば動きます。

```yaml
providers:
  codex:
    auth:
      mode: api-key
      secret: openai-api-key   # 値は npx sacty secret set openai-api-key で保存する
    available_models:          # 単価は例。契約の単価に合わせる
      gpt-6-luna: { input: 0.25, cached_input: 0.025, output: 2 }
      gpt-6.1-sol: { input: 1.25, cached_input: 0.125, output: 10 }
```

`providers` に書けるのは、Codex の `codex` と Claude Code の `claude` の2つだけです。
片方だけでも、両方でもかまいません。

| 項目 | 意味 | 既定値 |
| --- | --- | --- |
| `auth` | 認証方式（[認証方式](#認証方式)）。必須 | なし |
| `via_gateway` | AI の呼び出しを、ホストのゲートウェイ経由にする（`codex` の `bedrock`・`openai-compatible` だけ。[ゲートウェイ](gateway.md#ai-の呼び出しを中継する)） | `false` |
| `available_models` | 使えるモデルと、100万トークンあたりの単価（米ドル）。モデルの名前ごとに `input`・`cached_input`・`output` は必須、`cache_write` は任意 | なし（`cache_write` は `0`） |

- `available_models` に単価の無いモデルのエージェントは、使えない扱いになります。
  - 工程・タスクの詳細の選択肢に出しません。
  - 画面の警告に、どのモデルの単価が無いか（そのモデルを使うエージェントの名前）を出します。
  - 設定の誤りにはしません。
- sacty を更新して既定のモデルが変わったら、警告に出たモデルの単価を `available_models` に足してください。
- 単価は、利用するモデルの最新の単価に合わせてください。
  契約で単価が違う場合は、その単価を書きます。
  - sacty は、この単価とトークン数から費用を計算します。
  - サブスクリプションでは実際の請求は発生しません。
    sacty は同じ単価で換算した値を費用として扱い、予算の判定に使います。
- `default_agent`・`guardian_agent`・`audit_agent`・`step_agents` に、使えないエージェントを書くと誤りになります。
- `default_agent` を書かず、`codex_standard`・`claude_standard` のどちらも使えないときも、誤りになります（`providers` を書いていないときなど）。

## 認証方式

| AI | 認証方式（`auth.mode`） | 用意するもの |
| --- | --- | --- |
| Claude Code（`claude`） | `subscription` | `claude setup-token` で作ったトークン（`secret` は必須） |
| Claude Code（`claude`） | `api-key` | Anthropic の API キー |
| Claude Code（`claude`） | `bedrock` | Bedrock の API キーと `region`。モデルは推論プロファイル ID |
| Codex（`codex`） | `subscription` | ChatGPT でのログイン（`auth_file`。既定 `~/.codex/auth.json`） |
| Codex（`codex`） | `api-key` | OpenAI の API キー |
| Codex（`codex`） | `bedrock` | Bedrock の API キーと `region`。`endpoint` は `runtime`（既定。モデルは推論プロファイル ID、例 `global.openai.gpt-6-sol`）か `mantle`（モデルは例 `openai.gpt-6-sol`） |
| Codex（`codex`） | `openai-compatible` | OpenAI 互換の接続先の `base_url` と API キー（[ゲートウェイ](gateway.md#openai-互換の接続先)） |

- トークンや API キーは `secret` に名前（または 1Password の参照）だけを書き、値はキーチェーンか 1Password に置きます（[秘密情報](secrets.md)）。
- `endpoint` は Codex だけで使います。
  `claude` の `bedrock` に書くと誤りになります。
- sacty はコンテナに、選んだ認証方式の環境変数だけを渡します（ホストの `ANTHROPIC_API_KEY` などは引き継ぎません）。
- Bedrock ではモデルの名前が変わります。
  [エージェントの上書き](#エージェントの上書き)で `model` を書き換え、その名前の単価を `available_models` に書いてください。
  上書きしていない段階は単価が無いので、使えない扱いになり、画面に警告が出ます。

```yaml
providers:
  codex:
    auth:
      mode: bedrock
      secret: bedrock-api-key
      region: us-east-2
      endpoint: runtime
    via_gateway: true
    available_models:
      global.openai.gpt-6-sol: { input: 1.25, cached_input: 0.125, output: 10 }
agents:
  codex_standard:
    model: global.openai.gpt-6-sol
default_agent: codex_standard
```

## 既定のエージェント

sacty は、段階（[エージェントの段階](#エージェントの段階)）ごとのエージェントを既定で持っています。
モデルが新しくなったら、sacty の更新で既定も新しくなります。

| 名前 | ツール | モデル | リーズニングエフォート |
| --- | --- | --- | --- |
| `codex_lite` | Codex | `gpt-6-luna` | `low` |
| `codex_entry` | Codex | `gpt-6-luna` | `high` |
| `codex_standard` | Codex | `gpt-6.1-sol` | `low` |
| `codex_advanced` | Codex | `gpt-6.1-sol` | `medium` |
| `codex_ultimate` | Codex | `gpt-6.1-sol` | `high` |
| `claude_lite` | Claude Code | `claude-haiku-5-5` | （ツールの既定） |
| `claude_entry` | Claude Code | `claude-sonnet-5-5` | `low` |
| `claude_standard` | Claude Code | `claude-sonnet-5-5` | `medium` |
| `claude_advanced` | Claude Code | `claude-opus-5-5` | `medium` |
| `claude_ultimate` | Claude Code | `claude-opus-5-5` | `high` |

- `default_agent` を書かなければ、`codex_standard` を使います。
  `codex_standard` が使えない（`providers.codex` が無い・単価が無い）ときは `claude_standard` を使います。
- `providers` に無いツールの既定のエージェントは、使えない扱いになります。
  そのツールを使っていないだけなので、警告は出しません。

## エージェントの上書き

`agents` は書かなくてかまいません。
書いたときは、既定と同じ名前のエージェントを、書いた項目だけ上書きします（書いていない項目は既定のままです）。
新しい名前で足すこともできます。

```yaml
agents:
  codex_ultimate:
    reasoning_effort: xhigh   # モデルは既定のまま
  my-reviewer:                # 新しい名前（runtime・model が要る）
    runtime: claude-code
    model: claude-opus-5-5
    reasoning_effort: high
```

| 項目 | 意味 | 既定値 |
| --- | --- | --- |
| `runtime` | `claude-code`・`codex`・`stub`（動作確認用。実際の AI は呼ばない）。新しい名前では必須 | 既定のエージェントのもの |
| `model` | モデル。新しい名前では必須（単価を `available_models` から引くため） | 既定のエージェントのもの |
| `reasoning_effort` | リーズニングエフォート（Codex の `model_reasoning_effort`、Claude Code の `--effort`）。英小文字で始まる、英小文字・数字・`_`・`-` | 既定のエージェントのもの（無ければツールの既定） |
| `price_per_mtok_usd` | `runtime: stub` だけ。100万トークンあたりの単価（米ドル）。書き方は `available_models` と同じ | `0` |
| `stub` | `runtime: stub` の出力 | なし |
| `fallback` | 実行が失敗したとき（利用制限・認証エラーなど、理由は問いません）に代わりに使うエージェントの名前。1つか並び（上から順に試す。[失敗したときの切り替え](#失敗したときの切り替え)） | なし（切り替えない） |

- エージェントには、認証・接続先・単価（`auth`・`provider`・`via_gateway`・`price_per_mtok_usd`）を書けません。
  これらは `providers` に書きます（`runtime: stub` の `price_per_mtok_usd` を除く）。
- 新しい名前のエージェントも、そのツールの `providers` が無いか、モデルの単価が無ければ使えない扱いになり、画面に警告を出します。

## 工程ごとのモデル

`step_agents` で、工程とオーケストレーターごとにエージェントを選びます。

```yaml
default_agent: codex_standard
guardian_agent: codex_advanced
step_agents:          # 書かなければ default_agent（統合レビューは guardian_agent）
  orchestrator: codex_lite
  requirements: codex_advanced
  design: codex_advanced
```

`step_agents` に書けるキーは次のとおりです。

| キー | 対象 |
| --- | --- |
| `orchestrator` | オーケストレーター |
| `gather` | タスクの開始時の情報収集（書かなければ `orchestrator` の AI） |
| `investigate` | 調査 |
| `review` | レビュー |
| `requirements` | 要求要件 |
| `design` | 設計 |
| `split` | タスク分割 |
| `integrate` | 統合レビュー |
| `reproduce` | 再現 |
| `implement` | 実装 |
| `document` | 文書作成 |
| `operation` | 作業 |
| `deployment` | マージの後の監視の工程の確認（[マージの後の監視](deployment-watch.md)） |

- `default_agent`・`guardian_agent`・`audit_agent`・`step_agents` に、無い名前や使えないエージェントを書くと誤りになります。
- 以前の版の `pr`（PR作成）は、工程を無くしたので書けません。
  書くと誤りになるので、消してください。

## エージェントの段階

エージェントを「段階」で分けておくと、スキル（既定の `review` など）が観点ごとに段階の名前でサブエージェントを起動します。
Claude Code と Codex のどちらでも、同じ段階の担当が動きます。
モデルの世代が変わったら、sacty の更新で段階の既定のモデルも新しくなります。

段階のエージェントは、`claude_<段階>`・`codex_<段階>` の名前で sacty が既定で持っています（[既定のエージェント](#既定のエージェント)）。
段階は `lite`・`entry`・`standard`・`advanced`・`ultimate` の 5 つです。
sacty は、使える段階（`providers` に接続先とモデルの単価がある段階）だけを置きます。
段階のモデルを変えるときは、[エージェントの上書き](#エージェントの上書き)で同じ名前に `model` を書きます。

| 段階 | 意味 | 想定する使い方 |
| --- | --- | --- |
| `lite` | 最も速く安い | 表記・リンクなどの機械的な確認 |
| `entry` | 日常の作業に十分 | 文言・読み手の適合 |
| `standard` | 標準 | ほとんどの観点の既定 |
| `advanced` | 難しい推論 | 正しさ・堅牢性・セキュリティ・並行・設計の整合 |
| `ultimate` | 最上位 | 観点に縛られない欠陥探索 |

- 工程を動かすとき、sacty はそのツールの段階（Claude Code なら `claude_*`、Codex なら `codex_*`）を、接頭辞を外した名前のサブエージェントの定義として設定の場所に置きます。
  置く場所は、Claude Code は `agents/<段階>.md`、Codex は `agents/<段階>.toml` です。
- サブエージェントは工程のエージェントと同じプロセスで動きます。
  接続先はツールごとの `providers` なので、同じツールの段階は工程のエージェントと同じ接続先になります。
- 段階の名前の接頭辞と `runtime` が合わないと誤りになります（例 `claude_lite` に `runtime: codex`）。
- 置いた段階は、作業履歴の「コンテキストを用意」の詳細と、プロジェクトの設定のコンテキストのプレビューで確かめられます。
- 使える段階が無ければ、サブエージェントは工程のエージェントと同じモデルで動きます。
- 段階のエージェントも普通のエージェントなので、`step_agents` に書いて工程に使えます。
- 費用は、担当ごとのモデルの単価ではなく、工程のエージェントの結果の使用量と単価から計算します。
  - 段階を置いた実行の費用は概算として記録し、画面では「概算」の印を付けます。
  - 段階のモデルの `available_models` の単価は、その段階を `step_agents` で工程に使ったときに使います。
- コンテキストリポジトリに同じ名前の定義（`agents/claude/agents/<段階>.md`・`agents/codex/agents/<段階>.toml`、Codex の `config.toml` の `[agents.<段階>]`）があっても使いません（警告を残します）。

## 以前の版から移す

以前の版の書き方は、自動では読み替えず、誤りになります。
次のように書き直してください。

- エージェントの `auth`・`via_gateway` は、そのツールの `providers.codex`・`providers.claude` に移します。
- エージェントの `price_per_mtok_usd` は、モデルごとの単価として `providers.<ツール>.available_models` に移します。
- 名前を付けた `providers`（OpenAI 互換の接続先）と、エージェントの `provider` は、`providers.codex` の `auth`（`mode: openai-compatible`・`base_url`・`secret`）に書き直します。
- 既定と同じモデルで足りるエージェントは、`agents` から消してかまいません。
  `default_agent` などは既定のエージェントの名前に直します。

## 失敗したときの切り替え

エージェントに `fallback`（代わりのエージェントの名前）を書くと、実行が失敗したときに代わりのエージェントに切り替えます。
たとえば、Claude Code をメインに使い、利用制限に達したときや認証に失敗したときに Codex に切り替えられます。

```yaml
default_agent: claude_standard
agents:
  claude_standard:
    fallback: codex_standard
  claude_advanced:
    fallback: [codex_advanced, codex_standard]   # 並べると、上から順に試す
agent_fallback:
  cooldown_minutes: 60   # 失敗したエージェントを使わない時間（分。1〜1440）
```

エージェントの実行が失敗したときの動きは、実行の種類で違います。

| 実行 | 失敗したとき |
| --- | --- |
| 工程・統合レビュー・オーケストレーターの工程の選択・チケットの読み取り・最終レビュー・ゴールガーディアンの判定（変更の申し出・差し戻しの指摘） | 理由を問わず（利用制限・認証エラー・そのほかのエラー）、タスクを止めずに、代わりのエージェントで同じ工程をやり直す |
| 書き出し・マージの後の監視・監査・質問への答え | その回の失敗はこれまでどおり扱う（止まる・確かめられなかったことにするなど）。利用制限のときは、次の実行から代わりのエージェントを使う |

- 失敗かどうかは、エージェントの終了コードと出力で判断し、標準エラー出力に出たログでは判断しません。
- 実行が正常に終わった後に答えの形が正しくなかったときに切り替えるのは、オーケストレーターの工程の選択とチケットの読み取りだけです。
- sacty は作業履歴に「利用制限に達したので」「認証に失敗したので」「失敗したので」のように、理由とともに切り替えたことを記録します。
- `cooldown_minutes` の間は、失敗したエージェントを使わず、代わりのエージェントを使います。
  代わりを使う範囲は、失敗の理由で違います。
  - 利用制限：ほかのタスクでも代わりを使います。
  - それ以外の失敗：そのタスクでだけ代わりを使います（ほかのタスクは元のエージェントで動きます）。
- `cooldown_minutes` が過ぎたら、元のエージェントに戻ります。
  sacty を起動し直したときも、元のエージェントから試します。
- オーケストレーターを代わりのエージェント（別のツール）に切り替えたときは、前のエージェントのセッションのやり取りを読み取り専用で渡して引き継ぎます。
  セッションそのものは、別のツールでは再開できないためです。
  元のエージェントに戻ったときも同じように引き継ぎます。
- 代わりのエージェントも失敗したら（並べたものをすべて試し終えたら）、これまでどおり一時停止します。
  - `cooldown_minutes` が過ぎていても、試し終えたエージェントには戻りません。
  - 再開すると、もう一度、選んだエージェントから順に試します。
  - `fallback` を書いていないエージェントも、これまでどおり一時停止します。
- エージェントのコンテナが止まったことを確かめられなかったときは、切り替えずに一時停止します。
  元のコンテナが動いたままかもしれないためです。
- `fallback` に無い名前や、そのエージェント自身を書くと誤りになります。
- 代わりのエージェントが使えない（そのツールの `providers` が無いなど）ときは、画面に警告を出し、そのエージェントには切り替えません。
- 代わりのエージェントは、`default_agent`・`guardian_agent`・`audit_agent`・`step_agents` やタスクの詳細で選んだエージェントの、どれにも効きます。

## 予算

- 1タスクあたりの予算の既定値は `budget.default_per_task_usd`（既定 $1）です。
- 工程の組み合わせ（オーケストレーターが選ぶ `standard`・`split` など）ごとに予算を決めるときは、`budget.per_plan_usd` に組み合わせの名前と金額を書きます。
  - オーケストレーターがその組み合わせを選んだときに、タスクの予算の上限をその金額にします。
  - 書いていない組み合わせは `budget.default_per_task_usd` のままです。
  - 工程を選ぶ前に、再開で上限を上げていたときは、上げた上限のままにします。

  ```yaml
  budget:
    default_per_task_usd: 1
    per_plan_usd:
      standard: 3
      split: 10
  ```

  組み合わせの名前は `standard`・`skip-design`・`direct`・`bugfix`・`investigate`・`design-only`・`review`・`split`・`document`・`operation` です。
  ほかの名前を書くと、設定の誤りになります。
- 予算の 80% で作業履歴に通知を記録し、上限に達したら一時停止します（作業は残します）。
  再開するときは、累計の新しい上限を画面で入力します。
- サブスクリプションの利用上限や認証エラーでも一時停止し、再開すると止まった工程を実行し直します。
  代わりのエージェントを書けば、切り替えて続けます（[失敗したときの切り替え](#失敗したときの切り替え)）。
  ただし、開始済みの作業は再開できず、停止したままになります。

## 関係するページ

- [秘密情報](secrets.md)
- [ゲートウェイ](gateway.md)
- [コンテナイメージ](images.md)
