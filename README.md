# sacty

AIソフトウェアファクトリー。タスクを取り込み、オーケストレーターとゴールガーディアンが工程を進め、
人間は承認ゲートでだけ判断する。

## 必要なもの

- macOS
- Node.js 22.13以上
- Docker（Docker Desktop、OrbStack、Colima など。工程はコンテナの中で実行する）

## セットアップ

```sh
npm install
npm run build
npx sacty config init   # ~/.sacty/config.yaml を作る
npx sacty image build   # エージェント実行用のコンテナイメージを作る
```

`~/.sacty/config.yaml` で、工程を実行するAI（`default_agent`）と認証方式、単価を設定する。
単価（`price_per_mtok_usd`）は100万トークンあたりの米ドルで、利用するモデルの最新の単価に合わせる。

プロジェクトの「対象」（GitHub の Org またはリポジトリ）と GitHub のアカウントは、画面のプロジェクトの
設定で登録する。対象は、ホストを含めた URL で書く（例 `https://github.com/acme/app`、
`https://ghe.example.co.jp/acme`。github.com も GitHub Enterprise Server も同じ形）。画面でタスクを作るときは、対象の中からリポジトリを選ぶ（Org の対象は、gh で読んだその Org の
リポジトリから選ぶ）。対象の、取り込むラベルの付いた開いている Issue と PR は、タスクとして取り込む。
取り込むラベルは、すべてのプロジェクトに共通の設定として、画面の「sacty の設定」（ユーザーメニュー）で決める。
設定していなければ取り込まない。
ベースブランチとテストのコマンドは、タスクの開始時にオーケストレーターがリポジトリを読んで決める。
工程の選択と、コードや仕組みを読んで説明する調査では、開発のセットアップ（依存のインストール・ビルドなど）を実行しない
（リポジトリの AGENTS.md などにセットアップの手順があっても、こちらを優先する）。不具合の調査・再現・実装では、リポジトリの手順どおりセットアップする。

注意：対象に登録すると、タスクの内容によっては、sacty が対象のリポジトリにブランチをプッシュし、PR を作る。

### コンテキストリポジトリ

工程エージェントに渡す規則・スキル・MCP・エージェントの設定は、コンテキストリポジトリにまとめて、
プロジェクトの設定で指定する（任意）。sacty の既定のコンテキストの上に重ねて渡す。雛形は次のコマンドで作る。

```sh
npx sacty context init sacty-context   # 指定したディレクトリ（省略すれば今のディレクトリ）に雛形を作る
```

`README.md`・`rules.md`・`skills/`・`mcp.yaml`・`sacty-context.yaml`・`agents/codex/config.toml` ができる。
各ファイルには何を書く場所かの説明が入っていて、そのままでは既定のコンテキストを何も変えない。
同じ名前のファイル（または `rules/`）がすでにあれば、上書きせずに止まる。上書きする場合は `--force` を付ける。
書いたら git で管理して push し、画面のプロジェクトの設定の「コンテキストリポジトリ」にそのリポジトリを指定する。

### Slack の通知

人間の出番（承認待ち・エスカレーション・一時停止）とタスクの完了を、プロジェクトごとに Slack に通知する。画面のプロジェクトの設定で、送り方と言語を選ぶ（設定しなければ通知しない）。

- Slack API の形：送り先の URL（`https://slack.com/api/chat.postMessage` や、認証の要らない Slack Proxy）とチャンネル。トークンが要るなら、秘密情報の名前か 1Password の参照を書く
- Incoming Webhook：Webhook の URL を、秘密情報の名前か 1Password の参照で書く（URL そのものが秘密のため）
- 通知には、タスクと承認の窓口（成果物チェックは PR も）へのリンクを入れる。人間が自分で一時停止したときは通知しない
- 送れなかったときは、タスクは止めずに、タスクの一覧の画面に理由を出す。プロジェクトの設定の画面から、テストの通知を送って確かめられる

### 認証方式

| AI | 認証方式（`auth.mode`） | 用意するもの |
| --- | --- | --- |
| Claude Code | `subscription` | `claude setup-token` で作ったトークン |
| Claude Code | `api-key` | Anthropic APIキー |
| Claude Code | `bedrock` | BedrockのAPIキーと `region`。`model` は推論プロファイルID |
| Codex | `subscription` | ChatGPTでのログイン（`~/.codex/auth.json`） |
| Codex | `api-key` | OpenAI APIキー |
| Codex | `bedrock` | BedrockのAPIキーと `region`。`endpoint` は `runtime`（既定。`model` は推論プロファイルID、例 `global.openai.gpt-6-sol`）か `mantle`（`model` は例 `openai.gpt-6-sol`） |
| （動作確認用） | `stub` | なし。実際のAIは呼ばない |

トークンやAPIキーは、設定ファイルには名前（`secret`）だけを書き、値はキーチェーンに保存する。

```sh
npx sacty secret set claude-oauth-token
```

値は `security` コマンドがたずねる。sactyは値をコマンドライン・作業履歴・ログ・画面に出さない。

1Password に保存した秘密情報は、名前の代わりに参照（`op://保管庫/アイテム/フィールド`）を書く。エージェントの認証・MCP・npm のトークンなど、秘密情報を書くすべての所で使える。

```yaml
agents:
  codex-bedrock:
    auth: { mode: bedrock, secret: "op://Work/Bedrock/credential", region: us-east-2 }
# 複数の 1Password のアカウントにサインインしているときは、使うアカウントを書く
onepassword:
  account: my-company.1password.com
```

- 1Password CLI（`op`）で取り出す。先に `op signin`（または 1Password のアプリとの連携）でサインインしておく
- 取り出した値は、デーモンが動いている間だけメモリーに持ち、同じ参照で何度も問い合わせない（ディスクには書かない）
- サインインしていない・参照先が無いときは、どの参照かと理由を記録してタスクを止める。サインインしてから再開すると、取り出し直す

費用は、エージェントごとの単価（`price_per_mtok_usd`。100万トークンあたりの米ドル）とトークン数から計算する。契約で単価が違う場合は、その単価を書く。

### プライベートのレジストリからイメージを作る

Docker Hub や npm の公開レジストリを使えない環境では、`config.yaml` の `image_build` に元のイメージと npm のレジストリを書いてから `sacty image build` を実行する。

```yaml
image: registry.example.com/sacty-agent:0.1.0
image_build:
  base_image: registry.example.com/library/node:22-bookworm-slim   # Node.js 18 以上で node ユーザーがあること
  npm_registry: https://npm.example.com/repository/npm/
  npm_token: npm-token   # 認証が要るとき。値は sacty secret set npm-token で保存する
  npm_version: 11        # イメージに入れる npm の版（書かなければ元のイメージの npm）
  npm_config:            # コンテナの中の npm 全体の設定（global の npmrc）
    replace-registry-host: always   # package-lock.json の古い取得元の URL を、いまの registry に置き換える
    audit: false
    min-release-age: 7              # 公開から7日たっていない版は入れない（npm 11 から）
```

- npm のトークンは、ビルドのときだけ読ませる（BuildKit の secret）。イメージの層・履歴・環境変数には残らない
- 元のイメージに git が入っていれば、Debian のミラーに届かなくても作れる
- `npm_registry` は、コンテナの中の npm の registry にもなる（`npm_config` の `registry` があれば、そちらが優先）。`npm_token` はイメージを作るときだけ使い、コンテナの中では使わない
- `npm_config` はイメージに残り、コンテナの中のすべての npm（対象リポジトリの `npm ci` など）に効く。対象リポジトリの `.npmrc` に同じ項目があれば、そちらが優先する。認証の項目（`_authToken` など）はイメージに残るので書けない
- 作ったイメージ（`image`）は、エージェントの実行とテストの実行の両方で使う

### 言語ごとのイメージ

Python・Go・Java などのリポジトリは、言語のツールが入ったイメージ（CI のイメージなど）を元にして、言語ごとのイメージを作る。

```yaml
images:
  java17:
    description: Java 17・Maven・Gradle          # オーケストレーターが選ぶときに見る説明
    base_image: registry.example.com/ci/java:17   # Debian・Ubuntu 系か RHEL 系（Rocky Linux など）
    maven_mirror: https://maven.example.com/repository/maven-public/
  python:
    description: Python 3.12・pip・uv
    base_image: registry.example.com/ci/python:3.12
    env:                                          # エージェントとテストのコンテナに渡す
      PIP_INDEX_URL: https://pypi.example.com/simple
  go:
    description: Go 1.23
    base_image: registry.example.com/ci/go:1.23
    env:
      GOPROXY: https://goproxy.example.com
```

```bash
npx sacty image build            # 既定のイメージと images のすべて
npx sacty image build java17     # 名前を指定して作る（default は既定のイメージ）
```

- sacty が、元のイメージに Node.js（`node_image`、無ければ `image_build.base_image` か `node:22-bookworm-slim` から写す）・git・Claude Code・Codex を足し、`node` ユーザーで動かす。npm の設定は `image_build` のものを使う
- イメージの名前は、書かなければ `sacty-agent-<名前>:0.1.0`（`image` で変えられる）
- `env` は、組織のレジストリなど（`PIP_INDEX_URL`・`UV_DEFAULT_INDEX`・`GOPROXY`・`GONOSUMDB` など）。コンテナの中のすべてのコマンドに見えるので、認証の値（`TOKEN`・`PASSWORD` などを含む名前、ユーザー名・パスワードを含む URL）は書けない
- `maven_mirror` は、Maven（`settings.xml` の mirror）と Gradle（init スクリプト）の取得先を、すべてその URL に向ける
- 工程ごとのイメージは、オーケストレーターが工程を選ぶときに、リポジトリ（`pom.xml`・`go.mod`・`pyproject.toml`・`package.json` など。モノレポなら工程で触るディレクトリ）を読んで選ぶ。テストは、実装（不具合の修正では再現）の工程のイメージで実行する。オーケストレーター自身は既定のイメージで動く
- プロジェクトの対象（リポジトリ・Org）ごとにイメージを指定すると、オーケストレーターに選ばせず、すべての工程でそれを使う（リポジトリの指定が Org の指定より優先）
- 選んだイメージと理由は作業履歴に残る。`images` に無い名前を選んだ・指定したときは、理由を示して止まる

### docker compose のサービス（DB・モック API など）

テストや動作確認に、docker compose で起動する DB やモック API が要るリポジトリでは、sacty がホストでサービスを起動し、エージェントとテストのコンテナをそのネットワークにつなぐ（エージェントには Docker の権限を渡さない）。設定は要らない。

- どの compose ファイルのどのサービスを、どの工程（実装・再現・不具合の調査）で使うかは、オーケストレーターが工程を選ぶときに、リポジトリ（compose ファイル・README・AGENTS.md・テストの設定）を読んで決める。内容の調査では起動しない
- 工程のエージェントの実行と、テストの実行の1回ごとに、別のプロジェクト名で起動し（`docker compose up --wait`）、終わったらコンテナ・ネットワーク・ボリュームを消す。同じリポジトリのタスクを並行で動かしてもぶつからない。データは実行ごとに消える
- エージェントとテストは、サービス名とコンテナのポートで接続する（例 `db:5432`）。`ports`（ホストのポート）と `container_name` は外して起動する
- compose ファイルは `docker compose config` で正規化してから確かめ、使うサービスとその依存に次の設定があれば、起動せずに理由を示して止まる
  - `privileged`・`cap_add`・`devices`・`volumes_from`・ホストのネットワーク・PID など（`network_mode: host`・`pid: host` など）・`security_opt` の unconfined
  - Docker の API のソケットを渡す `use_api_socket`・ホストでコマンドを動かす `provider`・ビルドの `ssh`・`network: host`・`privileged`・`entitlements`
  - 作業領域の外のパスのマウント（Docker のソケットを含む）・作業領域の外の `build`・`env_file`・`label_file`・`secrets`・`include`・`extends` のファイル（これらのパスに変数は使えない）
  - external のネットワーク・ボリューム、bridge 以外のネットワークのドライバー、ボリュームのドライバーの指定
- サービスのイメージは、compose ファイルに書かれた名前のまま、ホストの Docker で取得・ビルドする（組織のレジストリのイメージは、ホストで `docker login` しておく）
- デーモンが途中で終わって残ったサービスは、次の起動のときに消す

### 組織の AI gateway と、工程ごとのモデル

OpenAI 互換（Responses API）の接続先（組織の AI gateway など）は `providers` に書き、Codex のエージェントから `provider` で使う。エージェントは「接続先・モデル・リーズニングエフォート・単価」の組で書き、`step_agents` で工程とオーケストレーターごとに選ぶ。

```yaml
providers:
  corp-gw:
    base_url: https://ai-gateway.example.com/v1   # Codex の model_providers の base_url と同じ
    secret: op://Work/AI-Gateway/api-key           # env_key に入れていた API キー
    via_gateway: true                              # sacty のゲートウェイ経由（429 のリトライ・キーをコンテナに渡さない）
agents:
  sol-high:
    runtime: codex
    provider: corp-gw
    model: gpt-6-sol
    reasoning_effort: high
    price_per_mtok_usd: { input: 1.25, cached_input: 0.125, output: 10 }
  luna-low:
    runtime: codex
    provider: corp-gw
    model: gpt-6-luna
    reasoning_effort: low
    price_per_mtok_usd: { input: 0.3, cached_input: 0.03, output: 1.5 }
default_agent: luna-low
guardian_agent: sol-high
step_agents:          # 書かなければ default_agent（統合レビューは guardian_agent）
  orchestrator: luna-low
  requirements: sol-high
  design: sol-high
```

### ホストのゲートウェイ（Codex × Bedrock）

エージェントに `via_gateway: true` を書くと、AI の呼び出しを sacty がホストで動かすゲートウェイ経由にする。

- API キーはゲートウェイだけが持ち、エージェントのコンテナには実行ごとのトークンだけを渡す
- レート制限（429）と一時的な失敗（5xx・接続の失敗）は、`Retry-After`（無ければ1秒から倍にしていく間隔）で待ってリトライする
- リトライの上限は `gateway.retry`（`max_attempts`：1件のリクエストで送る回数、`max_wait_sec`：成功するまでに待つ合計）で変えられる。上限に達すると、エージェントは利用上限として一時停止し、再開でやり直せる
- コンテナは `host.docker.internal` でゲートウェイにつなぐ。Docker Desktop ではそのまま届く。Rancher Desktop など、仮想マシンの中の Docker では `host-gateway` が仮想マシンを指して届かない（`Reconnecting... error sending request` のまま進まない）ので、`gateway.host_address` にホストに届くアドレスを書く（Rancher Desktop は `192.168.5.2`）

```yaml
gateway:
  host_address: 192.168.5.2   # Rancher Desktop
```
- リトライした実行は、作業履歴に回数と待った時間を残す
- ゲートウェイは 127.0.0.1 だけで待ち受け、実行中のエージェントのトークンを持つリクエストだけを受け付ける

### ブラウザで認証する MCP サーバー（ホストで動かす）

起動時にブラウザで認証（Okta など）する手元のコマンドの MCP サーバーは、`gateway.mcp_servers` に書くと、ゲートウェイがホストで起動して持ち続け、工程エージェントには HTTP の MCP として渡す（コンテナの中ではブラウザを開けないため）。

```yaml
gateway:
  mcp_servers:
    private-cloud:
      command: npx
      args: ["-y", "@example/private-cloud-mcp"]
      env: { CLOUD_REGION: ap-northeast-1, TOKEN: { secret: op://Work/Cloud/token } }
      restart_every_min: 240     # 認証の期限の前に、起動し直して再認証する（期限より短くする）
      ready_timeout_sec: 300     # 起動してから認証が済むまで待つ上限
```

- 認証の期限の前に、`restart_every_min` ごとに起動し直す。新しいプロセスの準備（認証）ができてから切り替え、古いプロセスを止める（使っている途中のエージェントを止めない）
- プロセスが終わった・ツールが認証エラーを返したときも、起動し直す（ブラウザでの承認は自動化されている前提で、人の操作は待たない）
- 起動し直しても準備ができなければ、タスクの一覧の画面に出し、1分ごとに起動し直す
- コンテナには、実行ごとのトークンを付けた HTTP の MCP の URL だけを渡す（Claude Code・Codex のどちらにも渡せる）

### 組織内 PF の API（ゲートウェイ経由）

MCP サーバーが無い組織内 PF は、`gateway.platforms` に書くと、エージェントが API で使える。認証情報はゲートウェイだけが持ち、エージェントには渡さない。

```yaml
gateway:
  platforms:
    ticket:                                   # エージェントは $SACTY_PF_URL/ticket/… で呼ぶ
      upstream: https://ticket.internal.example.com
      description: チケット管理
      auth:                                   # 固定のキーを、ヘッダーに付ける（独自のヘッダーも書ける）
        header: X-Internal-Token
        secret: op://Work/Ticket/token
      allow:                                  # 使える API（* は1階層、** はそれ以下すべて）
        - GET /api/v1/tickets/**
        - POST /api/v1/tickets/*/comments
    deploy:
      upstream: https://deploy.internal.example.com
      auth:                                   # API キーでトークン（JWT など）を取得して付ける
        header: Authorization
        prefix: "Bearer "
        token:
          url: https://auth.internal.example.com/api/token
          json: { apiKey: "{{secret}}" }      # form（フォーム）や headers にも {{secret}} を書ける
          secret: op://Work/Deploy/api-key
          token_path: data.accessToken        # 応答の JSON の、トークンの場所
          expires_in_path: data.expiresIn     # 期限（秒）の場所。無ければ ttl_sec（既定 300）
      allow:
        - GET /api/v1/deployments/**
```

- 工程エージェントの指示に、使える PF と API の一覧を入れる。エージェントは認証を意識せずに呼べる
- ホワイトリストに無いリクエストは拒否する（403。何が使えるかを返す）
- トークンは期限の前に取り直し、拒否（401・403）されたら取り直して1回だけ送り直す
- 認証情報はデーモンの起動時に用意する。用意できない PF は、タスクの一覧の画面に出す（ほかの PF は使える）
コンテナには、選んだ認証方式の環境変数だけを渡す（ホストの `ANTHROPIC_API_KEY` などは引き継がない）。

サブスクリプションでは実際の請求は発生しないが、同じ単価で換算した値を費用として扱い、予算の判定に使う。

### GitHub

GitHub へのアクセス（Issue の取り込み、clone、プッシュ、PR の作成、調査の結果の Issue へのコメント、
レビューの PR への投稿）は、ホストの GitHub CLI（`gh`）に
ログイン済みのアカウントで行う。github.com と GitHub Enterprise Server（いくつでも）を同時に使える。
使うアカウントは、プロジェクトの設定で、対象のホストごとに必ず選ぶ（最初は、そのホストの `gh` のアクティブな
アカウントが選ばれている）。`gh` でアカウントを切り替えても、プロジェクトごとに選んだアカウントを使う。

```sh
gh auth login                                 # github.com。使うアカウントごとにログインする
gh auth login --hostname ghe.example.co.jp    # GitHub Enterprise Server も、ホストごとにログインする
```

API は、github.com なら `https://api.github.com`、GitHub Enterprise Server なら `https://<ホスト>/api/v3` を使う。
HTTPS のリポジトリは、そのホストのアカウントのトークンで clone・プッシュする（ホストの git の認証の設定は
要らない）。SSH の URL やローカルのパスは、ホストの認証（ssh-agent など）を使う。
トークンは使うたびに `gh` から取り出し、作業履歴・ログ・画面・コンテナには出さない。

## 起動

```sh
npx sacty up
```

`sacty up` はデーモンと画面（Next.js）を起動し、`http://127.0.0.1:4700` を表示する。Ctrl+Cで両方が終了する。

| オプション | 既定値 | 内容 |
| --- | --- | --- |
| `--port` | 4700 | 画面のポート |
| `--daemon-port` | 4710 | デーモンのポート（127.0.0.1でのみ待ち受け） |

データ（作業履歴・設定・作業領域）は `~/.sacty/` に保存される。環境変数 `SACTY_HOME` で変更できる。

## 予算

1タスクあたりの予算の既定値は $1（`budget.default_per_task_usd`）。予算の80%で作業履歴に通知を記録し、
上限に達したら一時停止する（作業は残す）。再開するときは、累計の新しい上限を画面で入力する。

サブスクリプションの利用上限や認証エラーでも一時停止し、再開すると止まった工程を実行し直す。

## 構成

| パス | 役割 |
| --- | --- |
| `packages/core` | 作業履歴のイベント、イベントからタスクの状態を復元する処理、費用の計算 |
| `apps/daemon` | 常駐プロセス。作業履歴（SQLite、追記専用）への書き込みと、工程の実行（コンテナ）を行う |
| `apps/web` | 画面（Next.js、shadcn/ui）。操作はデーモンのAPIに依頼する |
| `packages/cli` | `sacty` コマンドと、エージェント実行用イメージのDockerfile |

## 開発

```sh
npm test          # ユニットテスト
npm run lint      # Biome（整形とリンター）
npm run typecheck # 型チェック
```
