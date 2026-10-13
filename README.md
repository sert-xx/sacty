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

PR のレビューだけを任せることもできる（画面の「sacty の設定」の「PR のレビューの取り込み」）。
- 自分にレビューが依頼された PR（プロジェクトでそのホストに選んだ GitHub のアカウントへの、個人としての依頼。チームへの依頼は除く）と、PR のレビュー用のラベル（取り込むラベルとは別）の付いた PR を取り込む
- 取り込んだ PR は、オーケストレーターを使わずにレビューだけを行い、PR にレビュー（コメント）として投稿する。実装や PR の作成はしない
- PR がマージ・クローズされたら、終わっていないレビューのタスクは中止する
- 新しいコミットが積まれたら、タスクの詳細の「再レビュー」で、最新のコミットをもう一度レビューして投稿する
ベースブランチとテストのコマンドは、タスクの開始時にオーケストレーターがリポジトリを読んで決める。
工程の選択と、コードや仕組みを読んで説明する調査では、開発のセットアップ（依存のインストール・ビルドなど）を実行しない
（リポジトリの AGENTS.md などにセットアップの手順があっても、こちらを優先する）。不具合の調査・再現・実装では、リポジトリの手順どおりセットアップする。

タスクの詳細の「オーケストレーターに質問」で、タスクの状況を質問できる。オーケストレーター（`step_agents.orchestrator` か `default_agent`）が、
タスクの台帳（作業履歴・承認済みの成果物・工程の出力・判定・費用）と、用意済みなら対象リポジトリの起点のコード（使い捨ての写し）を読んで答える。
質問しても工程や承認済みの内容は変わらず、作業中のタスクでも作業を止めない。答えの費用はタスクの費用に入り、予算の上限に達したタスクでは質問できない。

注意：対象に登録すると、タスクの内容によっては、sacty が対象のリポジトリにブランチをプッシュし、PR を作る。

### PR での承認（要求要件・設計・成果物チェック）

人間の承認が要る工程（要求要件・設計・実装の成果物チェック）は、対象のリポジトリへの PR で判断する。承認＝マージで、
PR を作った工程は sacty の画面からは承認しない（画面は PR への案内と状況の表示）。

1. sacty が、ベースブランチの起点のコミットからタスクブランチ（`sacty/task-<タスクの短い ID>`）を作る
2. 要求要件を、ファイル（既定 `docs/sacty/<タスクの短い ID>/requirements.md`）にして、タスクブランチへの PR にする。
   マージされたら要求要件の承認として記録し、次の工程に進む
3. 設計（テスト観点を含む。`design.md`）も同じく、タスクブランチへの PR にする
4. 設計の PR がマージされたら、タスクブランチに実装を積み、タスクブランチからベースブランチへの PR（成果物チェック）にする
   （CI が動く）。実装の PR には、要求要件・設計のファイルも含まれる

- ファイルの置き場所は、リポジトリやプロジェクトのコンテキストの規約に決まっていれば、オーケストレーターがそれに従う
- PR のレビュー・行へのコメント・通常のコメント（bot と sacty の投稿は除く）を指摘として取り込み（1分ごとに確かめ、最後の
  コメントから2分後）、ゴールガーディアンが、その工程のやり直し（同じ PR を更新）か前の工程への差し戻しかを判断する
  （人の確認は挟まない。判断と理由は作業履歴と PR の欄に残る）。同じ工程への差し戻しが上限を超えたら、エスカレーションになる
- 前の工程に戻したときは、マージ済みの PR は戻さず、タスクブランチに直しの PR を新しく作る。直しがマージされたら、後ろの工程の
  PR を作り直す（開いていた前の PR は閉じる。実装の PR は、同じ PR を更新する）
- マージされずに閉じられた・sacty の提出と違う内容でマージされたときは、承認にせずに判断を待つ（画面から差し戻すと、作り直した
  内容を新しい PR で出す）
- 承認が要らない工程（前段の調査など）と、調査だけ・レビューだけ・不具合の修正（要求要件・設計の無いタスク）では、要求要件・
  設計の PR を作らない（調査だけのタスクは、これまでどおり画面で承認する）。この版より前に、画面で要求要件・設計を提出した
  タスクは、そのまま画面で承認する
- タスク分割の子タスクは、それぞれ自分のタスクブランチを持つ（親の要求要件・設計も親のタスクブランチへの PR で承認するが、
  親のタスクブランチはベースブランチにはマージしない）
- 中止すると、sacty が作った開いている PR をすべて閉じ、タスクブランチ・工程のブランチを消す

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
- `sacty up` の起動のときに、使う秘密情報（エージェントの認証・providers・組織内 PF・ホストの MCP サーバー・プロジェクトの通知先）をまとめて取り出す。1Password の参照は1回の `op run` で取り出すので、認証は起動のときの1回だけ。キーチェーンの秘密情報は、取り出せるかを確かめる（使うたびに取り出す）
- 起動のときに取り出せなかったものは、画面の警告と端末に、どの設定かと理由を出す（起動は止めない）。用意してから「sacty の設定」の「秘密情報を取り出し直す」を押す
- イメージの作成だけで使う npm のトークンと、コンテキストリポジトリの mcp.yaml の秘密情報は、起動のときには取り出さない（使うときに取り出す）

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

- sacty が、元のイメージに git・Claude Code・Codex を足し、`node` ユーザーで動かす。元のイメージに Node.js 18 以上と npm があればそれを使い、無ければ `node_image`（無ければ `image_build.base_image` か `node:22-bookworm-slim`）から写す（npm は `npm root -g`・`/usr/local/lib/node_modules`・`/usr/lib/node_modules` から探す）。npm の設定は `image_build` のものを使う。エージェントは `node` ユーザーで動くので、`HOME` は `/home/node`、`GOPATH` は `/home/node/go`（`/home/node/go/bin` を PATH に足す）にする（CI のイメージが root 向けの場所にしていても書けるように。`GOPATH` は `env` で上書きできる）
- イメージの名前は、書かなければ `sacty-agent-<名前>:0.1.0`（`image` で変えられる）
- `env` は、組織のレジストリなど（`PIP_INDEX_URL`・`UV_DEFAULT_INDEX`・`GOPROXY`・`GONOSUMDB` など）。コンテナの中のすべてのコマンドに見えるので、認証の値（`TOKEN`・`PASSWORD` などを含む名前、ユーザー名・パスワードを含む URL）は書けない
- `maven_mirror` は、Maven（`settings.xml` の mirror）と Gradle（init スクリプト）の取得先を、すべてその URL に向ける
- `packages` に書いた OS のパッケージを、イメージを作るときに root で入れる（dnf・microdnf・yum・apt-get のうち、元のイメージにあるもの。下の `enable_repos` も参照）。`run` に書いたコマンドは、イメージを作るときに root で上から順に実行する（組織のパッケージのリポジトリの設定、CLI の導入など。失敗したら止める）。`packages`・`run` を変えると、`sacty image build` で作り直される。イメージに残るので、`run` に秘密情報は書かない
  ```yaml
  images:
    node-pw:
      description: Node.js 22・Playwright
      base_image: registry.example.com/ci/node:22
      packages: [nss, nspr, atk, at-spi2-atk, cups-libs, libdrm, libxkbcommon, mesa-libgbm, pango, alsa-lib]   # RHEL 系
      run:
        # 取得とインストールを分ける（取得に失敗したら、そこで止まる）
        - curl -fsSL https://artifacts.example.com/pf-cli/install.sh -o /tmp/pf-install.sh
        - sh /tmp/pf-install.sh
  ```
  `run` のコマンドは、終了コードが 0 でなければ止まる。元のイメージに bash があれば `pipefail` で実行するのでパイプの途中の失敗でも止まるが、bash が無いイメージ（`sh` で実行）では、パイプの最後のコマンドの終了コードしか見ない。取得して実行するような処理は、パイプでつながずに項目を分ける
  エージェントは root ではないので、タスクの中では OS のパッケージを入れられない。Playwright のブラウザ本体は、リポジトリの版に合わせてタスクの中で `npx playwright install chromium` で取る（OS のライブラリだけをイメージに入れる。Debian 系なら `run: [npx -y playwright@<版> install-deps chromium]` でもよい）
- 元のイメージに設定があるが無効にしてあるパッケージのリポジトリ（組織の rpm リポジトリなど）は、`enable_repos` に repo の ID を書くと、`packages` を入れるときに有効にする（dnf・microdnf・yum の `--enablerepo`）。apt-get のイメージでは使えない（理由を示して止まる。リポジトリの設定は `run` で行う）。ID は英数字で始まり、英数字と `. _ : -` だけ。`packages` と一緒に書く。`enable_repos` を変えると、`sacty image build` で作り直される
  ```yaml
  images:
    rocky-pw:
      description: Rocky Linux 9・Playwright
      base_image: registry.example.com/ci/rocky:9
      enable_repos: [corp-baseos, corp-appstream]
      packages: [nss, nspr, atk, at-spi2-atk, cups-libs, libdrm, libxkbcommon, mesa-libgbm, pango, alsa-lib]
  ```
  元のイメージにある repo の ID は `docker run --rm --user root --entrypoint dnf <元のイメージ> repolist --all` で確かめられる
- 工程ごとのイメージは、オーケストレーターが工程を選ぶときに、リポジトリ（`pom.xml`・`go.mod`・`pyproject.toml`・`package.json` など。モノレポなら工程で触るディレクトリ）を読んで選ぶ。テストは、実装（不具合の修正では再現）の工程のイメージで実行する。オーケストレーター自身は既定のイメージで動く
- プロジェクトの対象（リポジトリ・Org）ごとにイメージを指定すると、オーケストレーターに選ばせず、すべての工程でそれを使う（リポジトリの指定が Org の指定より優先）
- 選んだイメージと理由は作業履歴に残る。`images` に無い名前を選んだ・指定したときは、理由を示して止まる

### docker compose のサービス（DB・モック API など）

テストや動作確認に、docker compose で起動する DB やモック API が要るリポジトリでは、sacty がホストでサービスを起動し、エージェントとテストのコンテナをそのネットワークにつなぐ（エージェントには Docker の権限を渡さない）。設定は要らない。

- どの compose ファイルのどのサービスを、どの工程（実装・再現・不具合の調査）で使うかは、オーケストレーターが工程を選ぶときに、リポジトリ（compose ファイル・README・AGENTS.md・テストの設定）を読んで決める。内容の調査では起動しない
- 工程のエージェントの実行と、テストの実行の1回ごとに、別のプロジェクト名で起動し（`docker compose up --wait`）、終わったらコンテナ・ネットワーク・ボリュームを消す。同じリポジトリのタスクを並行で動かしてもぶつからない。データは実行ごとに消える
- エージェントとテストは、サービス名とコンテナのポートで接続する（例 `db:5432`）。`ports`（ホストのポート）と `container_name` は外して起動する
- リポジトリの設定の接続先が localhost のままでも届くよう、サービスを起動した実行では、エージェントとテストのコンテナの中で `127.0.0.1:<ポート>`（と、使えれば `[::1]:<ポート>`）をサービスの同じポート（`<サービス名>:<ポート>`）に転送する。転送は、コマンドの前に sacty がコンテナの中で起動する小さな TCP の転送（イメージにある Node.js で動く。追加のパッケージは要らない）で、コマンドが終わると止まる。コマンドの終了コードと出力は変わらない。サービスを起動しない実行では、何も変わらない（コマンドも同じ）
  - 転送するのは、サービスのコンテナのポート（`ports` の右側・`expose`）。`ports: ["15432:5432"]` のように、ホストで別のポートに出す前提の設定（`localhost:15432`）には届かない
  - 複数のサービスが同じポートを使うときは、そのポートは転送しない（どれにつなぐか決められないため。サービス名で接続する）。作業履歴のサービスの起動の記録と、エージェントへの指示に、そのポートを出す
  - そのポートをコンテナの中のほかのものがすでに使っているときは、そのポートは転送せずに続ける（失敗にしない）。理由を、テストの出力（標準エラー出力）か、デーモンのログ（エージェントの実行）に出す
  - 制限：転送は TCP だけ。MySQL のクライアントなど、ホストに `localhost` と書くと TCP ではなく UNIX ソケットで接続するものは届かない（`127.0.0.1` と書けば届く）。また、テストするアプリ自身がサービスと同じポートで待ち受けると、転送とぶつかって待ち受けられない（アプリのポートを変えるか、サービス名で接続する）
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

### コンテキストリポジトリの MCP サーバー

コンテキストリポジトリの `mcp.yaml` に書いた HTTP の MCP サーバーは、sacty のゲートウェイ経由で使う。

- 工程エージェントには、ゲートウェイの URL（`/ctx-mcp/<名前>`）と、実行ごとのトークンだけを渡す。認証のヘッダーの秘密情報は、ホストで取り出してゲートウェイが上流に付ける（コンテナには渡さない）
- エージェントが付けた認証などのヘッダーは上流に送らない（MCP の Streamable HTTP に要るヘッダーだけを送る）。応答（SSE）はそのまま返す。リダイレクトはたどらない
- コンテナから直接つなぐときは、サーバーに `via_gateway: false` と書く（秘密情報の値は、これまでどおり環境変数でコンテナに渡す）
- `command` のサーバーは、これまでどおりコンテナの中で起動する。ホストで動かしたいものは、次の `gateway.mcp_servers` に書く

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

### JIRA のチケットの取り込み

JIRA（Jira Cloud・Jira Server / Data Center）の接続先は、組織内 PF（`gateway.platforms`）として書く。JIRA 専用の設定は無い。

```yaml
gateway:
  platforms:
    jira:                                     # Jira Server / Data Center（個人用アクセストークン）
      upstream: https://jira.example.com
      description: JIRA
      auth:
        header: Authorization
        prefix: "Bearer "
        secret: op://Work/Jira/token
      allow:
        - GET /rest/api/2/search              # 取り込み（デーモンがチケットを探す）
        - GET /rest/api/2/issue/**            # オーケストレーターがチケット・親・サブタスクを読む
        - POST /rest/api/2/issue/*/comment    # 調査の結果と PR の URL をコメントする
    jira-cloud:                               # Jira Cloud（メールアドレス:API トークン を base64 にした値）
      upstream: https://example.atlassian.net
      description: JIRA Cloud
      auth:
        header: Authorization
        prefix: "Basic "
        secret: op://Work/JiraCloud/basic     # echo -n 'me@example.com:<API トークン>' | base64
      allow:
        - GET /rest/api/3/search/jql
        - GET /rest/api/2/issue/**
        - GET /rest/api/3/issue/**
        - POST /rest/api/2/issue/*/comment
```

- プロジェクトの設定の「チケットの取り込み」に、接続先（上の名前）・種類（Jira Cloud / Jira Server・Data Center）・JIRA のプロジェクトのキー（PAY など）を書く。1つのプロジェクトに複数書ける。同じ接続先の同じキーは、1つのプロジェクトにだけ書ける
- 「sacty の設定」の取り込むラベル（全取り込み先で共通）が付いた、終わっていないチケットをタスクにする。On/Off も「sacty の設定」で切り替える
- デーモンはチケットのキーと要約だけを探す。オーケストレーターがゲートウェイ経由でチケット（サブタスクなら親とほかのサブタスク）を読み、プロジェクトの対象から作業するリポジトリを選び、タスクの題と概要を書く。選べなければタスクは止まり、タスクの画面でリポジトリを選んで再開できる
- 調査の結果と PR の URL は、チケットにコメントする（チケットの状態は変えない）
- `allow` に無い API は、デーモンも呼ばない。JIRA ではない接続先を選んだときの動きは保証しない

### 成果の書き出し（Confluence・Notion など）

人間が承認した調査の結果（調査だけのタスク）・要求要件・設計（テスト観点を含む）を、Confluence・Notion などに書き出せる。
sacty は書き出し先の種類ごとの設定を持たない。接続先は、組織内 PF（`gateway.platforms`）か MCP サーバー（コンテキストリポジトリの `mcp.yaml`・`gateway.mcp_servers`）として書く（どちらにするかは自由）。

```yaml
gateway:
  platforms:
    confluence:
      upstream: https://wiki.example.com
      description: Confluence（設計書は DEV スペースの「設計」の下に置く）
      auth: { header: Authorization, prefix: "Bearer ", secret: op://Work/Confluence/token }
      allow:
        - GET /rest/api/content/**            # 置き場所と、前に書き出したページを探す
        - POST /rest/api/content              # ページを作る
        - PUT /rest/api/content/*             # 承認し直した版で、同じページを更新する
```

- 書き出すかどうか・どこに書き出すかは、工程を選ぶときにオーケストレーターが工程ごとに決める（使える接続先と説明・タスクの内容・取り込み元・プロジェクトのコンテキストの規約から判断する。書き出さない判断もある）。決めた書き出し先と理由は、作業履歴とタスクの画面の工程の欄に出る。使える接続先が無ければ決めない
- 工程の承認の後、その工程のエージェントが、決めた接続先だけを使って書き出す。認証はゲートウェイが付け、コンテナには実行ごとのトークンだけを渡す。書き出した先の URL は、作業履歴とタスクの画面に出し、取り込み元（Issue・JIRA）へのコメントにも添える
- 差し戻しの後に承認し直すと、前に書き出したページを更新する（新しく作らない）。書き出しの後・記録の前に止まっても、本文の目印で同じページを探して更新する
- 接続できない・書き出せないときは、理由を残して、これまでどおり（sacty の中に残す・取り込み元へのコメント）進める。タスクは止まらず、タスクの画面から書き出し直せる
- 書き出しの費用はタスクの費用に入り、工程ごとの費用の表に「書き出し」として出る

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
