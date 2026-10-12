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
設定で登録する。画面でタスクを作るときは、対象の中からリポジトリを選ぶ（Org の対象は、gh で読んだその Org の
リポジトリから選ぶ）。対象の、取り込むラベルの付いた開いている Issue と PR は、タスクとして取り込む。
取り込むラベルは、すべてのプロジェクトに共通の設定として、画面の「sacty の設定」（ユーザーメニュー）で決める。
設定していなければ取り込まない。
ベースブランチとテストのコマンドは、タスクの開始時にオーケストレーターがリポジトリを読んで決める。

注意：対象に登録すると、タスクの内容によっては、sacty が対象のリポジトリにブランチをプッシュし、PR を作る。

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
  base_image: registry.example.com/library/node:22-bookworm-slim   # Node.js 22 で node ユーザーがあること
  npm_registry: https://npm.example.com/repository/npm/
  npm_token: npm-token   # 認証が要るとき。値は sacty secret set npm-token で保存する
```

- npm のトークンは、ビルドのときだけ読ませる（BuildKit の secret）。イメージの層・履歴・環境変数には残らない
- 元のイメージに git が入っていれば、Debian のミラーに届かなくても作れる
- 作ったイメージ（`image`）は、エージェントの実行とテストの実行の両方で使う

### ホストのゲートウェイ（Codex × Bedrock）

エージェントに `via_gateway: true` を書くと、AI の呼び出しを sacty がホストで動かすゲートウェイ経由にする。

- API キーはゲートウェイだけが持ち、エージェントのコンテナには実行ごとのトークンだけを渡す
- レート制限（429）と一時的な失敗（5xx・接続の失敗）は、`Retry-After`（無ければ1秒から倍にしていく間隔）で待ってリトライする
- リトライの上限は `gateway.retry`（`max_attempts`：1件のリクエストで送る回数、`max_wait_sec`：成功するまでに待つ合計）で変えられる。上限に達すると、エージェントは利用上限として一時停止し、再開でやり直せる
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

### 社内 PF の API（ゲートウェイ経由）

MCP サーバーが無い社内 PF は、`gateway.platforms` に書くと、エージェントが API で使える。認証情報はゲートウェイだけが持ち、エージェントには渡さない。

```yaml
gateway:
  platforms:
    ticket:                                   # エージェントは $SACTY_PF_URL/ticket/… で呼ぶ
      upstream: https://ticket.internal.example.com
      description: 社内のチケット管理
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
ログイン済みのアカウントで行う。使うアカウントは、プロジェクトの設定で必ず選ぶ（最初は `gh` のアクティブな
アカウントが選ばれている）。`gh` でアカウントを切り替えても、プロジェクトごとに選んだアカウントを使う。

```sh
gh auth login   # 使うアカウントごとにログインする
```

HTTPS の GitHub のリポジトリは、そのアカウントのトークンで clone・プッシュする（ホストの git の認証の設定は
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
