<!-- 対応するコード: apps/daemon/src/context-mcp.ts（ContextMcpServers）、apps/daemon/src/context.ts（ContextManifest・McpServer・McpTimeouts・PlatformsFile・composeContext・RESERVED_SETTINGS・RESERVED_FILES）、apps/daemon/src/context-template.ts、apps/daemon/src/platforms.ts、packages/cli/src/index.ts（contextInit・contextPreview）、packages/cli/src/context-preview.ts -->

# コンテキストリポジトリ

工程エージェントに渡す規則・スキル・MCP・外部 PF・エージェントの設定は、コンテキストリポジトリにまとめて、プロジェクトの設定で
指定する（任意）。sacty の既定のコンテキストの上に重ねて渡す。

## 雛形を作る

```sh
npx sacty context init sacty-context   # 指定したディレクトリ（省略すれば今のディレクトリ）に雛形を作る
```

- `README.md`・`rules.md`・`skills/README.md`・`mcp.yaml`・`platforms.yaml`・`sacty-context.yaml`・`agents/codex/config.toml` ができる。
- 各ファイルには何を書く場所かの説明が入っていて、そのままでは既定のコンテキストを何も変えない。
- 同じ名前のファイル（または `rules/`）がすでにあれば、上書きせずに止まる。上書きする場合は `--force` を付ける。
- 書いたら git で管理して push し、画面のプロジェクトの設定の「コンテキストリポジトリ」にそのリポジトリを指定する
  （[プロジェクトの設定](project-settings.md#コンテキストリポジトリ)）。

## 置くファイル

| ファイル | 内容 | 重ね方 |
| --- | --- | --- |
| `rules.md`（または `rules/*.md`） | 規則。Claude Code には CLAUDE.md、Codex には AGENTS.md として渡す。`rules.md` があれば `rules/` は読まない | 上位の層から順に連結する |
| `skills/<名前>/SKILL.md` | スキル。SKILL.md の無いディレクトリはグループ（`skills/<グループ>/<名前>/SKILL.md` も名前 `<名前>` のスキル） | 名前ごとに下位が上書きする |
| `mcp.yaml` | MCP サーバー（[mcp.yaml](#mcpyaml)） | 名前ごとに下位が上書きする |
| `platforms.yaml` | このプロジェクトだけで使える外部 PF（[platforms.yaml](#platformsyaml)） | 名前ごとに下位が上書きする |
| `agents/codex/`・`agents/claude/` | Codex の `CODEX_HOME`・Claude Code の `CLAUDE_CONFIG_DIR` に写すファイル | 同じパスは下位が上書きする。`config.toml`・`settings.json` はキーごとに重ねる |
| `sacty-context.yaml` | 継承と、上書き禁止・取り除き（[sacty-context.yaml](#sacty-contextyaml)） | |

- `README.md` はエージェントに渡さない。シンボリックリンクは使えない（理由を示して止まる）。
- `agents/claude/settings.json` の `permissions.allow`・`deny`・`ask` は、置き換えずに上位の層と合わせる。
- sacty が決める項目は、書いても使わない（警告を残す）。
  - `agents/codex/config.toml`：`mcp_servers`・`model_provider`・`model_providers`・`forced_login_method`・`forced_chatgpt_workspace_id`・
    `chatgpt_base_url`・`approval_policy`・`sandbox_mode`・`sandbox_workspace_write`・`profile`・`profiles`
  - `agents/claude/settings.json`：`apiKeyHelper`・`awsAuthRefresh`・`awsCredentialExport`・`forceLoginMethod`・`forceLoginOrgUUID`、
    `env` の認証・接続先の変数（`ANTHROPIC_API_KEY`・`ANTHROPIC_BASE_URL`・`CLAUDE_CODE_OAUTH_TOKEN`・`AWS_BEARER_TOKEN_BEDROCK` など）と
    `SACTY_` で始まる変数
  - ファイル：Codex の `auth.json`・`AGENTS.md`・`skills/`、Claude Code の `.credentials.json`・`.claude.json`・`CLAUDE.md`・`mcp.json`・`skills/`
- Codex のルール（`agents/codex/rules/*.rules`）は、既定のルールを消さないように `sacty.rules` 以外の名前にする。
- モデルは、`config.yaml` のエージェントに `model` があれば、設定より優先する。

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

- 継承は10層まで。同じリポジトリと ref が2度出てきたら（循環）、理由を示して止まる。
- 上書き禁止の項目を下位で上書き・取り除きしようとしたときは、警告を残して上位のものを使う。

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

- 名前は英数字・`_`・`-`。サーバーは、`url`（HTTP）か `command`（コマンド。stdio）のどちらかの形で書く。
  - HTTP：`url`（必須）・`headers`・`via_gateway`（既定 `true`）・`startup_timeout_sec`・`tool_timeout_sec`
  - コマンド：`command`（必須）・`args`・`env`・`via_gateway`（既定 `true`）・`startup_timeout_sec`・`tool_timeout_sec`
- 秘密情報は値を書かず、`{ secret: 名前 }`（キーチェーンの名前か 1Password の参照。`prefix` は値の前につける）で書く。
  文字列に `${` は書けない（Claude Code が環境変数として展開するため）。
- HTTP のものも `command` のものも、既定で sacty のゲートウェイ経由で使う。工程エージェントには、ゲートウェイの URL（`/ctx-mcp/<名前>`）と、
  実行ごとのトークンだけを渡す（Claude Code の `mcp.json`・Codex の `config.toml` のどちらでも、HTTP の MCP になる）。
- コンテナの中で動かす（HTTP はコンテナから直接つなぐ）ときは、そのサーバーに `via_gateway: false` と書く。書いたものはコンテナの中で
  起動・接続し、秘密情報の値は環境変数でコンテナに渡す。
- `config.yaml` の `gateway.mcp_servers` と同じ名前のサーバーは、`gateway.mcp_servers` のものを使い、作業履歴に警告を残す
  （`mcp.yaml` のものは起動しない）。

### HTTP の MCP サーバー

- 認証のヘッダーの秘密情報は、ホストで取り出してゲートウェイが上流に付ける（コンテナには渡さない）。
- エージェントが付けた認証などのヘッダーは上流に送らない（MCP の Streamable HTTP に要るヘッダーだけを送る）。応答（SSE）はそのまま
  返す。リダイレクトはたどらない。

### コマンドの MCP サーバー（ホストで動かす）

`command` のサーバーは、既定で、sacty を動かすホストでゲートウェイが起動する（`gateway.mcp_servers` と同じ仕組み）。`env` の秘密情報は
ホストで取り出して起動するときにだけ入れ、コンテナには渡さない。

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

- 作業ディレクトリ：そのサーバーを書いた層のリポジトリの写し（`SACTY_HOME/context-mcp/layers` の下。`.git` は写さない）。`args` などの
  相対パスは、そのリポジトリの直下から解決する（コンテナの作業領域ではない）。継承の親の層に書いたサーバーは、親のリポジトリの写しで動く。
- コマンド：ホストの `PATH` から探す（`./bin/server` のように `/` を含むものは作業ディレクトリから）。見つからない（`npx`・`uvx` などを
  ホストに入れていない）ときは、どの MCP サーバーのどのコマンドかと、ホストに入れるか `via_gateway: false` を書くよう、作業履歴
  （コンテキストの注意）に残して実行する（1分ごとに起動し直すので、ホストに入れれば使えるようになる）。
- 分離：プロジェクトごとに起動し、そのタスクのプロジェクトの実行のトークンでだけ使える（`platforms.yaml` の PF と同じ）。ほかの
  プロジェクトの実行からは、名前を知っていても使えない。同じ中身でも、プロジェクトが違えば別のプロセスになる。
- 使い回し：同じプロジェクトで中身（名前・`command`・`args`・`env`・時間切れ・層のリポジトリと commit）が同じなら、実行をまたいで
  同じプロセスを使う（並行する実行も同じ）。中身が変われば（コンテキストリポジトリに push して commit が変わったときも）、次の実行で
  新しく起動する。
- 止める：使っている実行が無くなったものは、同じプロジェクト・同じ名前の新しい中身が使われたらすぐに、そうでなければ最後に使って
  から30分で止める（層の写しも消す）。`sacty up` を止めるとすべて止め、デーモンが突然落ちて残ったものは、次の起動のときに片付ける
  （`gateway.mcp_servers` と同じ記録 `SACTY_HOME/host-mcp/processes` を使う）。
- 準備：実行の前に、その実行が使うサーバーの起動（MCP の初期化）を待つ。上限は120秒（`startup_timeout_sec` がそれより長ければ、
  その値）。準備ができなければ、どの MCP サーバーかを作業履歴（コンテキストの注意）に残して実行する。そのサーバーへの成果の書き出しは、
  理由を残して書き出さない。
- プロジェクトの設定の「コンテキストのプレビュー」には、エージェントから見える URL（`/ctx-mcp/<名前>`）と、ホストで起動するコマンド・
  `env`（秘密情報は参照の名前だけ）・作業ディレクトリの層が出る。
- ブラウザで認証するものなど、すべてのプロジェクトで使うものは、`config.yaml` の `gateway.mcp_servers` に書ける
  （[ゲートウェイ](gateway.md#ホストで動かす-mcp-サーバー)）。

### 信頼の前提

`command` のサーバーは、sacty を動かすホストで、デーモンと同じ利用者・同じ環境変数（`PATH`・`HOME` など）で動く。つまり、
コンテキストリポジトリ（継承する親のリポジトリも含む）を編集できる人は、sacty を動かすホストで任意のコマンドを動かせる。sacty は、
コンテキストリポジトリを `config.yaml` と同じくらい信頼する前提で動き、許可するコマンドの一覧や、人の承認は設けない。

- コンテキストリポジトリ（と `extends` の親）は、`config.yaml` を編集してよい人だけが変更できるようにする（ブランチの保護・レビューの
  必須など）。
- ホストで動かしたくないサーバーは、`via_gateway: false` でコンテナの中で動かす。
- MCP のツールの結果に秘密情報が含まれると、エージェントに渡る（sacty は伏せない）。

### MCP サーバーの時間切れ

各サーバーには、起動（初期化とツールの一覧）を待つ上限 `startup_timeout_sec`（1〜3600 秒）と、ツールの呼び出しを待つ上限
`tool_timeout_sec`（1〜86400 秒）を書ける（どちらも任意。整数）。書かなければ、エージェントの既定のまま。

```yaml
servers:
  build-tool:
    command: npx
    args: ["-y", "example-build-mcp"]
    startup_timeout_sec: 60     # 起動に時間がかかる
    tool_timeout_sec: 900       # 15分かかるツールがある
```

エージェントの実行全体には、開始から30分の上限がある（過ぎるとコンテナを止める）。MCP の時間切れをそれ以上にしても、実行全体が
先に止まるので意味が無い。起動・ツールの呼び出しのどちらかを30分以上にしたときは、コンテキストを用意するときに警告を作業履歴に残す
（設定の誤りにはしない）。

- Codex：`config.toml` の `mcp_servers.<名前>` に、同じ名前（`startup_timeout_sec`・`tool_timeout_sec`）で渡す。
- Claude Code：ツールの呼び出しは、`mcp.json` のサーバーごとの `timeout`（ミリ秒。環境変数 `MCP_TOOL_TIMEOUT` より優先される）で渡す。
  起動を待つ上限はサーバーごとに渡す設定が無いため、全体の環境変数 `MCP_TIMEOUT` にする。値は、書いたサーバーの値と、書いていない
  サーバーの Claude Code の既定（30秒）の大きい方（書いていないサーバーの待ち時間を既定より短くしない。そのため、書いていないサーバーが
  あるときは、既定より短い値は効かない）。どれにも書かなければ `MCP_TIMEOUT` は渡さない。
- ゲートウェイ経由の HTTP のサーバーは、中継が先に切れないよう、ゲートウェイが上流を待つ上限（既定は5分）を、書いた値の大きい方まで延ばす。
- ホストで動かす `command` のサーバーは、`gateway.mcp_servers` と同じく、ゲートウェイの中継（ツールの呼び出しは既定で10分、一覧は既定で60秒）を、
  書いた値より先に切らない。
- `gateway.mcp_servers` にも同じ2つを書ける（[ゲートウェイ](gateway.md#ホストで動かす-mcp-サーバー)）。

## platforms.yaml

プロジェクトごとに使いたい外部 PF が違うときは、`platforms.yaml` に書く。書ける項目は `config.yaml` の `gateway.platforms` と同じ
（`upstream`・`description`・`auth`・`allow`。[ゲートウェイ](gateway.md#組織内-pf-の-api)）。

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

- 層の合成は `mcp.yaml` と同じ。名前ごとに下位の層が上書きし、`sacty-context.yaml` の `locked.platforms`・`remove.platforms` で
  上書き禁止・取り除きができる（当たったときは警告を残す）。
- `config.yaml` の `gateway.platforms` は、すべてのプロジェクトで使える。同じ名前があれば `config.yaml` のものを使い、作業履歴の
  「コンテキストを用意」に警告を残す。
- 工程エージェントには、そのタスクのプロジェクトで使える PF（ホストの PF と、そのプロジェクトのコンテキストで合成した PF）だけを、
  `$SACTY_PF_URL` の一覧と説明で伝える。
- コンテキストの PF は、そのプロジェクトのタスクの実行のトークンでだけ使える。ほかのプロジェクトのタスクからは、名前を知っていても
  使えない（ゲートウェイが 404 で拒否する）。
- 認証の値は、ホストのゲートウェイだけが使うときに取り出して付ける。エージェント・コンテキストのファイル・作業履歴・ログ・画面には
  出さない。秘密情報が見つからないなど、認証を用意できなければ、どの層のどの PF かを添えてエージェントに返す（502）。
- 形の誤り（`allow` が無い・`auth` に `secret` と `token` の両方を書いたなど）は、どの層の `platforms.yaml` のどの項目
  （`platforms.<名前>.…`）かを示して工程を止める。
- チケットの取り込み・成果の書き出しの接続先にも、プロジェクトのコンテキストの PF を選べる（ホストの PF に無い名前のときだけ、
  コンテキストを取得して探す）。
- プロジェクトの設定の画面の「使える外部 PF」に、名前・どこで定義したか・説明・使える API を出す（秘密情報の名前・値は出さない）。
  作業履歴の「コンテキストを用意」にも出す。
- コンテキストリポジトリに書いた PF は、書いた秘密情報を、書いた転送先・トークンの窓口に、ホストが付けて送る。`mcp.yaml` と同じく、
  コンテキストリポジトリは信頼できる人だけが変えられるようにする（[信頼の前提](#信頼の前提)）。

## 合成の結果を確かめる

合成の結果（実行のときに Claude Code・Codex の設定のディレクトリに置くファイルと、層・警告・MCP の接続先など）は、プロジェクトの設定の
「コンテキストのプレビュー」で確かめられる（保存した設定でも、編集中の設定でも）。CLI からは、起動中の sacty（`sacty up`）に
問い合わせて同じものを出せる（[CLI](cli.md#sacty-context-preview)）。秘密情報は参照の名前だけを出す。

```sh
npx sacty context preview 決済 --runtime codex
```

保存するときも同じ検査をし、`mcp.yaml`・`platforms.yaml` などに誤りがあれば知らせる（保存はする）。

## 関係するページ

- [ゲートウェイ](gateway.md)
- [プロジェクトの設定](project-settings.md)
