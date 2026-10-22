<!-- 対応するコード: apps/daemon/src/context-mcp.ts（ContextMcpServers）、apps/daemon/src/context.ts（ContextManifest・McpServer・McpTimeouts・PlatformsFile・composeContext・RESERVED_SETTINGS・RESERVED_FILES）、apps/daemon/src/context-template.ts、apps/daemon/src/platforms.ts、packages/cli/src/index.ts（contextInit・contextPreview）、packages/cli/src/context-preview.ts -->

**日本語** | [English](context.en.md)

# コンテキストリポジトリ

工程エージェントとオーケストレーターに渡す規則・スキル・MCP・外部 PF・エージェントの設定は、コンテキストリポジトリにまとめて、プロジェクトの設定で指定します（任意）。
sacty は、既定のコンテキストの上にコンテキストリポジトリを重ねて渡します。

既定のレビュー用スキルは、レビューの担当を起動する前に、対象のリポジトリで定められたフォーマット・lint・型チェック・テストなどを確認モードで実行し、結果を担当に共有します。
検証や CI に結果があれば、その失敗や警告を分析する担当も起動します。
検証のログはレビューの作業領域の外に保存し、PR には指摘に必要な箇所だけを引用します。

既定の文章用スキル `writing` は、エージェントが PR の本文・レビューのコメント・報告などを書くときの書き方を決めます。
日本語の文章では「。」の後で改行し、構造のある情報は箇条書きと表にします。
対象のリポジトリに文章の決まり（AGENTS.md・CONTRIBUTING など）があれば、そちらを優先します。

既定の要求要件用スキル `ears-requirements` は、要求要件の受け入れ条件を EARS（Easy Approach to Requirements Syntax）の文型で書かせます。
`<きっかけ>とき、<システム>は、<応答>しなければならない。`のような決まった文型で、1文に1つの要求を書き、`R-1` などの ID を付けます。
要求要件の工程は、このスキルに従って受け入れ条件を書きます。
対象のリポジトリに要求要件の決まりがあれば、そちらを優先します。

既定の工程の選択用スキル `plan-steps` は、オーケストレーターがタスクの工程の組み合わせを選ぶ手順を決めます。
オーケストレーターは、答えの JSON を出す前に `jq` などの道具で検査し、通るまで直します。
答えの JSON の壊れ（閉じ括弧の欠けなど）が原因で、工程を選べているのにタスクが止まることを減らします。

既定の図用スキル `drawio` は、draw.io の公式のスキルです。
エージェントが図（`.drawio`。PNG・SVG・PDF への書き出しを含む）を作るときに使います。
Mermaid で書いた図の変換と書き出しには、イメージの draw.io の CLI（[コンテナイメージ](images.md#drawio-の-cli)）を使います。

## 雛形を作る

```sh
npx sacty context init sacty-context   # 指定したディレクトリ（省略すれば今のディレクトリ）に雛形を作る
```

- `README.md`・`rules.md`・`skills/README.md`・`mcp.yaml`・`platforms.yaml`・`sacty-context.yaml`・`agents/codex/config.toml` ができます。
- 各ファイルには、何を書く場所かの説明が入っています。
  そのままでは既定のコンテキストを何も変えません。
- 同じ名前のファイル（または `rules/`）がすでにあれば、上書きせずに止まります。
  上書きする場合は `--force` を付けてください。
- 書いたら git で管理して push し、画面のプロジェクトの設定の「コンテキストリポジトリ」にそのリポジトリを指定します（[プロジェクトの設定](project-settings.md#コンテキストリポジトリ)）。

## 置くファイル

| ファイル | 内容 | 重ね方 |
| --- | --- | --- |
| `rules.md`（または `rules/*.md`） | 規則。Claude Code には CLAUDE.md、Codex には AGENTS.md として渡す。`rules.md` があれば `rules/` は読まない | 上位の層から順に連結する |
| `skills/<名前>/SKILL.md` | スキル。SKILL.md の無いディレクトリはグループ（`skills/<グループ>/<名前>/SKILL.md` も名前 `<名前>` のスキル） | 名前ごとに下位が上書きする |
| `mcp.yaml` | MCP サーバー（[mcp.yaml](#mcpyaml)） | 名前ごとに下位が上書きする |
| `platforms.yaml` | このプロジェクトだけで使える外部 PF（[platforms.yaml](#platformsyaml)） | 名前ごとに下位が上書きする |
| `agents/codex/`・`agents/claude/` | Codex の `CODEX_HOME`・Claude Code の `CLAUDE_CONFIG_DIR` に写すファイル | 同じパスは下位が上書きする。`config.toml`・`settings.json` はキーごとに重ねる |
| `sacty-context.yaml` | 継承と、上書き禁止・取り除き（[sacty-context.yaml](#sacty-contextyaml)） | |

- `README.md` はエージェントに渡しません。
- シンボリックリンクは使えません（理由を示して止まります）。
- `agents/claude/settings.json` の `permissions.allow`・`deny`・`ask` は、置き換えずに上位の層と合わせます。
- sacty が決める項目は、書いても使いません（警告を残します）。
  - `agents/codex/config.toml`：`mcp_servers`・`model_provider`・`model_providers`・`forced_login_method`・`forced_chatgpt_workspace_id`・`chatgpt_base_url`・`approval_policy`・`sandbox_mode`・`sandbox_workspace_write`・`profile`・`profiles`
  - `agents/claude/settings.json`
    - `apiKeyHelper`・`awsAuthRefresh`・`awsCredentialExport`・`forceLoginMethod`・`forceLoginOrgUUID`
    - `env` の認証・接続先の変数（`ANTHROPIC_API_KEY`・`ANTHROPIC_BASE_URL`・`CLAUDE_CODE_OAUTH_TOKEN`・`AWS_BEARER_TOKEN_BEDROCK` など）
    - `SACTY_` で始まる変数
  - ファイル：Codex の `auth.json`・`AGENTS.md`・`skills/`、Claude Code の `.credentials.json`・`.claude.json`・`CLAUDE.md`・`mcp.json`・`skills/`
- 段階のサブエージェントの定義は、[エージェントの段階](config.md#エージェントの段階)から sacty が作るので、置いても使いません（使える段階が無くても使いません。警告を残します）。
  - 対象は `agents/claude/agents/<段階>.md`・`agents/codex/agents/<段階>.toml` と、Codex の `config.toml` の `[agents.<段階>]` です。
    段階は `lite`・`entry`・`standard`・`advanced`・`ultimate` です。
  - Codex の `agents/*.toml` は、ファイル名が違っても、中の `name` が段階なら使いません。
- Codex のルール（`agents/codex/rules/*.rules`）は、既定のルールを消さないように `sacty.rules` 以外の名前にしてください。
- モデルは、エージェントの `model`（sacty の既定か、`config.yaml` の `agents` の上書き）が、ここの設定より優先します。

## sacty-context.yaml

```yaml
extends: git@github.com:acme/sacty-context.git#main   # 親（上位の層）のコンテキストリポジトリ。URL#ref で ref を指定できる
locked:            # 下位の層で上書き・取り除きできないスキル・MCP サーバー・外部 PF
  skills: [review]
  mcp: [docs]
  platforms: [ticket]
remove:            # 上位の層から引き継いだスキル・MCP サーバー・外部 PF を取り除く
  skills: []
  mcp: []
  platforms: []
```

- 継承は10層までです。
  同じリポジトリと ref が2度出てきたら（循環）、理由を示して止まります。
- 上書き禁止の項目を下位で上書き・取り除きしようとしたときは、警告を残して上位のものを使います。

## mcp.yaml

```yaml
servers:
  docs:
    url: https://mcp.example.com/mcp
    headers:
      Authorization: { secret: docs-token, prefix: "Bearer " }
  local-tool:
    command: npx
    args: ["-y", "example-mcp-server"]
    env:
      API_TOKEN: { secret: op://Work/Tool/token }
```

- 名前に使えるのは英数字・`_`・`-` です。
- サーバーは、`url`（HTTP）か `command`（コマンド。stdio）のどちらかの形で書きます。
  - HTTP：`url`（必須）・`headers`・`via_gateway`（既定 `true`）・`startup_timeout_sec`・`tool_timeout_sec`
  - コマンド：`command`（必須）・`args`・`env`・`via_gateway`（既定 `true`）・`startup_timeout_sec`・`tool_timeout_sec`
- 秘密情報は値を書かず、`{ secret: 名前 }`（キーチェーンの名前か 1Password の参照。`prefix` は値の前につける）で書きます。
  文字列に `${` は書けません（Claude Code が環境変数として展開するため）。
- `mcp.yaml`・`platforms.yaml` の秘密情報は、`sacty up` の起動のときとプロジェクトの設定を保存したときに、ほかの秘密情報とまとめて取り出します。
  後から足したものは、使うときに取り出します（[秘密情報](secrets.md#後からコンテキストに足した秘密情報)）。
- HTTP のものも `command` のものも、既定で sacty のゲートウェイ経由で使います。
  工程エージェントには、ゲートウェイの URL（`/ctx-mcp/<名前>`）と、実行ごとのトークンだけを渡します。
  Claude Code の `mcp.json`・Codex の `config.toml` のどちらでも、HTTP の MCP になります。
- コンテナの中で動かす（HTTP はコンテナから直接つなぐ）ときは、そのサーバーに `via_gateway: false` と書きます。
  書いたものはコンテナの中で起動・接続し、秘密情報の値は環境変数でコンテナに渡します。
- `config.yaml` の `gateway.mcp_servers` と同じ名前のサーバーは、`gateway.mcp_servers` のものを使い、作業履歴に警告を残します（`mcp.yaml` のものは起動しません）。

### HTTP の MCP サーバー

- 認証のヘッダーの秘密情報は、ホストで取り出してゲートウェイが上流に付けます（コンテナには渡しません）。
- エージェントが付けた認証などのヘッダーは上流に送りません（MCP の Streamable HTTP に要るヘッダーだけを送ります）。
- 応答（SSE）はそのまま返します。
- リダイレクトはたどりません。

### コマンドの MCP サーバー（ホストで動かす）

`command` のサーバーは、既定で、sacty を動かすホストでゲートウェイが起動します（`gateway.mcp_servers` と同じ仕組みです）。
`env` の秘密情報はホストで取り出して起動するときにだけ入れ、コンテナには渡しません。

```yaml
servers:
  issue-tracker:                 # ホストで起動する（既定）
    command: npx
    args: ["-y", "example-issue-mcp", "--config", "./mcp/issue.json"]
    env:
      API_TOKEN: { secret: op://Work/Issue/token }
  browser:                       # コンテナの中で起動する
    command: npx
    args: ["-y", "@playwright/mcp"]
    via_gateway: false
```

- 作業ディレクトリ：そのサーバーを書いた層のリポジトリの写し（`SACTY_HOME/context-mcp/layers` の下。`.git` は写しません）です。
  - `args` などの相対パスは、そのリポジトリの直下から解決します（コンテナの作業領域ではありません）。
  - 継承の親の層に書いたサーバーは、親のリポジトリの写しで動きます。
- コマンド：ホストの `PATH` から探します（`./bin/server` のように `/` を含むものは作業ディレクトリから探します）。
  - 見つからない（`npx`・`uvx` などをホストに入れていない）ときも、実行は続けます。
    どの MCP サーバーのどのコマンドかと、ホストに入れるか `via_gateway: false` を書くよう、作業履歴（コンテキストの注意）に残します。
  - 1分ごとに起動し直すので、ホストに入れれば使えるようになります。
- 分離：プロジェクトごとに起動し、そのタスクのプロジェクトの実行のトークンでだけ使えます（`platforms.yaml` の PF と同じです）。
  - ほかのプロジェクトの実行からは、名前を知っていても使えません。
  - 同じ中身でも、プロジェクトが違えば別のプロセスになります。
- 使い回し：同じプロジェクトで中身（名前・`command`・`args`・`env`・時間切れ・層のリポジトリと commit）が同じなら、実行をまたいで同じプロセスを使います（並行する実行も同じです）。
  中身が変われば（コンテキストリポジトリに push して commit が変わったときも）、次の実行で新しく起動します。
- 止める：使っている実行が無くなったものを止めます（層の写しも消します）。
  - 同じプロジェクト・同じ名前の新しい中身が使われたら、すぐに止めます。
    そうでなければ、最後に使ってから30分で止めます。
  - `sacty up` を止めると、すべて止めます。
  - デーモンが突然落ちて残ったものは、次の起動のときに片付けます（`gateway.mcp_servers` と同じ記録 `SACTY_HOME/host-mcp/processes` を使います）。
- 準備：実行の前に、その実行が使うサーバーの起動（MCP の初期化）を待ちます。
  - 上限は120秒（`startup_timeout_sec` がそれより長ければ、その値）です。
  - 準備ができなければ、どの MCP サーバーか（`mcp.yaml` の名前・層・プロジェクトの名前）を作業履歴（コンテキストの注意）に残して実行します。
  - そのサーバーへの成果の書き出しはせず、理由を残します。
- ログ：デーモンのログの `[gateway] context MCP "<mcp.yaml の名前>" (project "<プロジェクトの名前>" [<ID>], context "<層>", internal ctx-…)` の行が、そのサーバーの起動・準備できない理由・停止を表します。
  `internal` の名前はゲートウェイの中の名前で、設定には出てきません。
- プロジェクトの設定の「コンテキストのプレビュー」には、次のものが出ます。
  - エージェントから見える URL（`/ctx-mcp/<名前>`）
  - ホストで起動するコマンド・`env`（秘密情報は参照の名前だけ）・作業ディレクトリの層
- ブラウザで認証するものなど、すべてのプロジェクトで使うものは、`config.yaml` の `gateway.mcp_servers` に書けます（[ゲートウェイ](gateway.md#ホストで動かす-mcp-サーバー)）。

### 信頼の前提

`command` のサーバーは、sacty を動かすホストで、デーモンと同じ利用者・同じ環境変数（`PATH`・`HOME` など）で動きます。
つまり、コンテキストリポジトリ（継承する親のリポジトリも含む）を編集できる人は、sacty を動かすホストで任意のコマンドを動かせます。
sacty は、コンテキストリポジトリを `config.yaml` と同じくらい信頼する前提で動き、許可するコマンドの一覧や、人の承認は設けません。

- コンテキストリポジトリ（と `extends` の親）は、`config.yaml` を編集してよい人だけが変更できるようにしてください（ブランチの保護・レビューの必須など）。
- ホストで動かしたくないサーバーは、`via_gateway: false` でコンテナの中で動かします。
- MCP のツールの結果に秘密情報が含まれると、エージェントに渡ります（sacty は伏せません）。

### MCP サーバーの時間切れ

各サーバーには、次の2つの上限を書けます（どちらも任意。整数）。
書かなければ、エージェントの既定のままです。

- `startup_timeout_sec`：起動（初期化とツールの一覧）を待つ上限（1〜3600 秒）
- `tool_timeout_sec`：ツールの呼び出しを待つ上限（1〜86400 秒）

```yaml
servers:
  build-tool:
    command: npx
    args: ["-y", "example-build-mcp"]
    startup_timeout_sec: 60     # 起動に時間がかかる
    tool_timeout_sec: 900       # 15分かかるツールがある
```

エージェントの実行全体には、開始からの上限があります。
既定は開始から30分で、`config.yaml` の `run_timeout` で変えられます（[config.yaml の設定](config.md)）。
上限を過ぎると、sacty はコンテナを止めます。
MCP の時間切れをそれ以上にしても、実行全体が先に止まるので意味がありません。
起動・ツールの呼び出しのどちらかをその実行の上限以上（既定ではどちらかを30分以上）にしたときは、コンテキストを用意するときに警告を作業履歴に残します（設定の誤りにはしません）。

sacty は、書いた値をツールごとに次のように渡します。

- Codex：`config.toml` の `mcp_servers.<名前>` に、同じ名前（`startup_timeout_sec`・`tool_timeout_sec`）で渡します。
- Claude Code
  - ツールの呼び出しは、`mcp.json` のサーバーごとの `timeout`（ミリ秒。環境変数 `MCP_TOOL_TIMEOUT` より優先されます）で渡します。
  - 起動を待つ上限はサーバーごとに渡す設定が無いため、全体の環境変数 `MCP_TIMEOUT` にします。
    値は、書いたサーバーの値と、書いていないサーバーの Claude Code の既定（30秒）の大きい方です。
    書いていないサーバーの待ち時間を既定より短くしないためです。
    そのため、書いていないサーバーがあるときは、既定より短い値は効きません。
  - どれにも書かなければ `MCP_TIMEOUT` は渡しません。
- ゲートウェイ経由の HTTP のサーバー：中継が先に切れないよう、ゲートウェイが上流を待つ上限（既定は5分）を、書いた値の大きい方まで延ばします。
- ホストで動かす `command` のサーバー：`gateway.mcp_servers` と同じく、ゲートウェイの中継（ツールの呼び出しは既定で10分、一覧は既定で60秒）を、書いた値より先に切りません。

`gateway.mcp_servers` にも同じ2つを書けます（[ゲートウェイ](gateway.md#ホストで動かす-mcp-サーバー)）。

## platforms.yaml

プロジェクトごとに使いたい外部 PF が違うときは、`platforms.yaml` に書きます。
書ける項目は `config.yaml` の `gateway.platforms` と同じです（`upstream`・`description`・`auth`・`allow`。[ゲートウェイ](gateway.md#組織内-pf-の-api)）。

```yaml
platforms:
  ticket:                                     # エージェントは $SACTY_PF_URL/ticket/… で呼ぶ
    upstream: https://ticket.internal.example.com
    description: チケット管理
    auth:
      header: Authorization
      prefix: "Bearer "
      secret: op://Work/Ticket/token          # 秘密情報は名前か 1Password の参照で書く（値は書かない）
    allow:
      - GET /api/v1/tickets/**
```

- 層の合成は `mcp.yaml` と同じです。
  名前ごとに下位の層が上書きし、`sacty-context.yaml` の `locked.platforms`・`remove.platforms` で上書き禁止・取り除きができます（当たったときは警告を残します）。
- `config.yaml` の `gateway.platforms` は、すべてのプロジェクトで使えます。
  同じ名前があれば `config.yaml` のものを使い、作業履歴の「コンテキストを用意」に警告を残します。
- 工程エージェントには、そのタスクのプロジェクトで使える PF（ホストの PF と、そのプロジェクトのコンテキストで合成した PF）だけを、`$SACTY_PF_URL` の一覧と説明で伝えます。
- コンテキストの PF は、そのプロジェクトのタスクの実行のトークンでだけ使えます。
  ほかのプロジェクトのタスクからは、名前を知っていても使えません（ゲートウェイが 404 で拒否します）。
- 認証の値は、ホストのゲートウェイだけが、使うときに取り出して付けます。
  - エージェント・コンテキストのファイル・作業履歴・ログ・画面には出しません。
  - 秘密情報が見つからないなど、認証を用意できなければ、どの層のどの PF かを添えてエージェントに返します（502）。
- 形の誤り（`allow` が無い・`auth` に `secret` と `token` の両方を書いたなど）は、どの層の `platforms.yaml` のどの項目（`platforms.<名前>.…`）かを示して工程を止めます。
- チケットの取り込み・成果の書き出しの接続先にも、プロジェクトのコンテキストの PF を選べます。
  ホストの PF に無い名前のときだけ、コンテキストを取得して探します。
- プロジェクトの設定の画面の「使える外部 PF」に、名前・どこで定義したか・説明・使える API を出します（秘密情報の名前・値は出しません）。
  作業履歴の「コンテキストを用意」にも出します。
- コンテキストリポジトリに書いた PF では、書いた秘密情報を、書いた転送先・トークンの窓口に、ホストが付けて送ります。
  `mcp.yaml` と同じく、コンテキストリポジトリは信頼できる人だけが変えられるようにしてください（[信頼の前提](#信頼の前提)）。

## 合成の結果を確かめる

合成の結果は、プロジェクトの設定の「コンテキストのプレビュー」で確かめられます（保存した設定でも、編集中の設定でも）。
結果には、実行のときに Claude Code・Codex の設定のディレクトリに置くファイルと、層・警告・MCP の接続先などが出ます。
CLI からは、起動中の sacty（`sacty up`）に問い合わせて同じものを出せます（[CLI](cli.md#sacty-context-preview)）。
秘密情報は参照の名前だけを出します。

```sh
npx sacty context preview 決済 --runtime codex
```

保存するときも同じ検査をし、`mcp.yaml`・`platforms.yaml` などに誤りがあれば知らせます（保存はします）。

## 関係するページ

- [ゲートウェイ](gateway.md)
- [プロジェクトの設定](project-settings.md)
