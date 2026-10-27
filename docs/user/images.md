<!-- 対応するコード: apps/daemon/src/config.ts（image_build・images・languageImageTag）、apps/daemon/src/image.ts、packages/cli/docker/Dockerfile、packages/cli/docker/install-tools.sh、packages/cli/docker/install-drawio.sh、packages/cli/docker/install-security-tools.sh、packages/cli/docker/drawio-shim.cjs、packages/cli/src/index.ts（imageBuild）、apps/daemon/src/service.ts（changeStepImage）、apps/web/src/components/step-image-form.tsx -->

**日本語** | [English](images.en.md)

# コンテナイメージ

エージェントの実行に使うコンテナイメージは、`npx sacty image build` で作ります（[CLI](cli.md#sacty-image-build)）。
作ったイメージ（`image`。既定 `sacty-agent:1.11.1`）で、エージェントが動きます。
テストも、エージェントのコンテナの中で実行します。

イメージには、`gh api` だけを使える `gh` が入ります。
この `gh` は GitHub をゲートウェイ経由で読むためのもので、元のイメージの `gh` より先に使われます（[ゲートウェイ](gateway.md#github-の読み取り)）。
sacty を更新したら、イメージを作り直してください。

## イメージに入るツール

エージェントが作業で使う、次のコマンドが入ります。
元のイメージにすでにあるコマンドは入れ直さず、そのまま使います。

| コマンド | 用途 |
| --- | --- |
| `jq` | JSON を読む・書き換える（`gh api --jq` もこれを使います） |
| `rg`（ripgrep）・`fd` | ファイルの中身・ファイル名を速く探す |
| `tree`・`file`・`less` | ディレクトリの構成・ファイルの種類・長いファイルを見る |
| `curl` | HTTP で取得する |
| `zip`・`unzip`・`xz`・`bzip2` | 圧縮したファイルを作る・展開する |
| `patch`・`diff`・`find`・`make`・`ps` | パッチの適用・差分・ファイルの検索・ビルドの手順・プロセスの確認 |
| `sqlite3`・`python3` | SQLite のデータベースを見る・スクリプトを書いて確かめる |
| `shellcheck` | シェルスクリプトを検査する |
| `drawio` | draw.io の図を変換・書き出す（下の [draw.io の CLI](#drawio-の-cli)） |
| `osv-scanner`・`gitleaks` | 依存の脆弱性・秘密情報の混入を検査する（セキュリティチェック・セキュリティ対応で使います。[タスクを進める](tasks.md#セキュリティチェックと対応)） |

- どれもオープンソースのソフトウェアで、OS の配布元のパッケージ（元のイメージに設定してあるミラー）から入れます。
  入るのは、イメージを作った時点の版です。
- `npx sacty image build` は Docker のビルドのキャッシュを使います。
  そのため、作り直しただけでは、パッケージを取り直さないことがあります。
  OS のセキュリティの更新を入れるときは、次のどちらかをしてから作り直してください。
  - 元のイメージを新しいものにする（`docker pull <元のイメージ>` で取り直す、更新した版のタグに変える）
  - `docker builder prune` でビルドのキャッシュを消す

  元のイメージにすでにあるコマンドは入れ直さないので、その更新は元のイメージの側で入れます。
- `osv-scanner`・`gitleaks` は、OS のパッケージではなく、GitHub の公式のリリースから版を固定して取り、同じリリースのハッシュのファイルで確かめてから入れます。
  GitHub のリリースに届かないときは、ビルドのログに警告を出して、入れずに作ります（工程は、その区分を確かめていない範囲として報告します）。
  ハッシュが合わないときは、作るのを止めます。
- パッケージのミラーに届かないなどで入れられなかったコマンドがあっても、sacty はビルドのログに警告を出して、そのまま作ります（エージェントは別の方法で代えます）。
- RHEL 系の元のイメージでは、`rg`・`fd`・`shellcheck` は EPEL にしか無いので、EPEL を使えなければ入りません。
  `packages` は `run` より先に入れるので、EPEL のパッケージは `packages` に書かないでください。
  EPEL を有効にするコマンドの後に、同じ `run` の中で入れます。
  組織の EPEL のミラーがあれば、`epel-release` の代わりに、そのリポジトリの設定を置くコマンドにします。

  ```yaml
  images:
    rocky:
      description: Rocky Linux 9
      base_image: registry.example.com/ci/rocky:9
      run:
        - dnf install -y epel-release
        - dnf install -y ripgrep fd-find ShellCheck
  ```

### draw.io の CLI

既定のスキル `drawio`（[コンテキストリポジトリ](context.md)）は、draw.io の CLI で次のことをします。

- 図の変換（Mermaid から draw.io の形式へ）
- 自動のレイアウト
- PNG・SVG・PDF への書き出し

sacty は、draw.io Desktop（Apache-2.0）の公式のリリースを GitHub から取り、版とハッシュを固定して確かめてから入れます。
日本語のラベルを書き出せるように、CJK のフォント（Noto CJK）も入れます。

- イメージが大きくなります（展開した大きさで 800MB ほど）。
  GitHub のリリース（`github.com` と `release-assets.githubusercontent.com`）に届かない環境や、イメージを小さくしたいときは、`image_build.drawio` を `false` にしてください。
  入れないときも、スキルは XML で図（`.drawio`）を作れます。
- GitHub に届かないときは、ビルドのログに警告を出して、draw.io の CLI を入れずに作ります。
  取得したファイルのハッシュが合わないときは、作るのを止めます。

```yaml
image_build:
  drawio: false   # draw.io の CLI を入れない
```

## プライベートのレジストリからイメージを作る

Docker Hub や npm の公開レジストリを使えない環境では、`config.yaml` の `image_build` に元のイメージと npm のレジストリを書いてから、`sacty image build` を実行してください。
書かなければ、Docker Hub の `node:22-bookworm-slim` と npm の公開レジストリから作ります。

```yaml
image: registry.example.com/sacty-agent:1.11.1
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

| 項目 | 意味 | 既定値 |
| --- | --- | --- |
| `base_image` | 元のイメージ（Node.js 18 以上で、`node` ユーザーがあること） | `node:22-bookworm-slim` |
| `npm_registry` | npm のレジストリ（`http`・`https` の URL） | npm の公開レジストリ |
| `npm_token` | npm のレジストリの認証トークン（秘密情報の名前か 1Password の参照） | なし |
| `npm_version` | イメージに入れる npm の版（`latest` か、`11`・`11.4`・`11.4.2` の形） | 元のイメージの npm |
| `npm_config` | コンテナの中の npm 全体の設定 | なし |
| `drawio` | draw.io の CLI を入れるか（[draw.io の CLI](#drawio-の-cli)。言語ごとのイメージにも効きます） | `true` |

- npm のトークンは、ビルドのときだけ読ませます（BuildKit の secret）。
  イメージの層・履歴・環境変数には残りません。
- 元のイメージに git が入っていれば、Debian のミラーに届かなくても作れます。
- `npm_registry` は、コンテナの中の npm の registry にもなります（`npm_config` の `registry` があれば、そちらが優先します）。
  `npm_token` はイメージを作るときだけ使い、コンテナの中では使いません。
- `npm_config` はイメージに残り、コンテナの中のすべての npm（対象リポジトリの `npm ci` など）に効きます。
  対象リポジトリの `.npmrc` に同じ項目があれば、そちらが優先します。
  認証の項目（`_authToken`・`_auth`・`_password`・`username`・`email`・`certfile`・`keyfile`・`cert`・`key`）はイメージに残るので、書けません。

## 言語ごとのイメージ

Python・Go・Java などのリポジトリには、言語のツールが入ったイメージ（CI のイメージなど）を元にして、言語ごとのイメージを作ります。

```yaml
images:
  java17:
    description: Java 17・Maven・Gradle          # オーケストレーターが選ぶときに見る説明
    base_image: registry.example.com/ci/java:17   # Debian・Ubuntu 系か RHEL 系（Rocky Linux など）
    maven_mirror: https://maven.example.com/repository/maven-public/
  python:
    description: Python 3.12・pip・uv
    base_image: registry.example.com/ci/python:3.12
    env:                                          # エージェントのコンテナ（テストを実行する最終レビューを含む）に渡す
      PIP_INDEX_URL: https://pypi.example.com/simple
  go:
    description: Go 1.23
    base_image: registry.example.com/ci/go:1.23
    env:
      GOPROXY: https://goproxy.example.com
```

```sh
npx sacty image build            # 既定のイメージと images のすべて
npx sacty image build java17     # 名前を指定して作る（default は既定のイメージ）
```

| 項目 | 意味 | 既定値 |
| --- | --- | --- |
| （名前） | 英小文字・数字で始まる、英小文字・数字・`_`・`-` の40文字まで。`default` は使えない | なし |
| `description` | オーケストレーターが選ぶときに見る説明（200文字まで）。必須 | なし |
| `base_image` | 元のイメージ。必須 | なし |
| `image` | 作るイメージの名前 | `sacty-agent-<名前>:1.11.1` |
| `node_image` | Node.js を写す元のイメージ（元のイメージに Node.js 18 以上と npm が無いとき） | `image_build.base_image`、無ければ `node:22-bookworm-slim` |
| `env` | エージェントのコンテナ（テストを実行する最終レビューを含む）の環境変数 | なし |
| `maven_mirror` | Maven・Gradle の取得先 | なし |
| `packages` | イメージを作るときに入れる OS のパッケージ | なし |
| `enable_repos` | `packages` を入れるときに有効にするパッケージのリポジトリの ID | なし |
| `run` | イメージを作るときに root で実行するコマンド | なし |

- sacty は、元のイメージに git・Claude Code・Codex を足し、`node` ユーザーで動かします。
  - 元のイメージに Node.js 18 以上と npm があればそれを使い、無ければ `node_image` から写します。
    npm は `npm root -g`・`/usr/local/lib/node_modules`・`/usr/lib/node_modules` から探します。
  - npm の設定は `image_build` のものを使います。
  - エージェントは `node` ユーザーで動くので、`HOME` を `/home/node`、`GOPATH` を `/home/node/go` にし、`/home/node/go/bin` を PATH に足します。
    CI のイメージが root 向けの場所にしていても書けるようにするためです。
    `GOPATH` は `env` で上書きできます。
- `env` には、組織のレジストリなど（`PIP_INDEX_URL`・`UV_DEFAULT_INDEX`・`GOPROXY`・`GONOSUMDB` など）を書きます。
  - 名前は、英大文字か `_` で始まる、英大文字・数字・`_` です。
  - コンテナの中のすべてのコマンドに見えるので、認証の値（`TOKEN`・`PASSWORD`・`SECRET`・`AUTH`・`API_KEY` などを含む名前、ユーザー名・パスワードを含む URL）は書けません。
  - `PATH`・`HOME`・`USER`・`SHELL`・`TMPDIR`・`NODE_OPTIONS` や、`SACTY_`・`DOCKER_`・`CODEX_`・`CLAUDE_`・`ANTHROPIC_`・`OPENAI_`・`NPM_CONFIG_` で始まる名前も書けません。
- `maven_mirror` は、Maven（`settings.xml` の mirror）と Gradle（init スクリプト）の取得先を、すべてその URL に向けます。
  ユーザー名・パスワードを含む URL と、引用符などの記号を含む URL は書けません。
- `packages` に書いた OS のパッケージは、イメージを作るときに root で入れます。
  使うのは、dnf・microdnf・yum・apt-get のうち、元のイメージにあるものです。
  `run` に書いたコマンドは、イメージを作るときに root で上から順に実行します（組織のパッケージのリポジトリの設定、CLI の導入など）。
  失敗したら止めます。
  `packages`・`run` を変えると、`sacty image build` で作り直されます。
  イメージに残るので、`run` に秘密情報は書かないでください。

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

  `run` のコマンドは、終了コードが 0 でなければ止まります。
  元のイメージに bash があれば `pipefail` で実行するので、パイプの途中の失敗でも止まります。
  bash が無いイメージ（`sh` で実行）では、パイプの最後のコマンドの終了コードしか見ません。
  取得して実行するような処理は、パイプでつながずに項目を分けてください。

  エージェントは root ではないので、タスクの中では OS のパッケージを入れられません。
  Playwright のブラウザ本体は、リポジトリの版に合わせて、タスクの中で `npx playwright install chromium` で取ります。
  イメージには OS のライブラリだけを入れます。
  Debian 系なら `run: [npx -y playwright@<版> install-deps chromium]` でもかまいません。
- 元のイメージに設定があるが無効にしてあるパッケージのリポジトリ（組織の rpm リポジトリなど）は、`enable_repos` に repo の ID を書くと、`packages` を入れるときに有効にします（dnf・microdnf・yum の `--enablerepo`）。
  - apt-get のイメージでは使えません。
    理由を示して止まるので、リポジトリの設定は `run` で行ってください。
  - ID は英数字で始まり、英数字と `. _ : -` だけです。
  - `packages` と一緒に書きます（`packages` が無いと誤りになります）。
  - `enable_repos` を変えると、`sacty image build` で作り直されます。

  ```yaml
  images:
    rocky-pw:
      description: Rocky Linux 9・Playwright
      base_image: registry.example.com/ci/rocky:9
      enable_repos: [acme-baseos, acme-appstream]
      packages: [nss, nspr, atk, at-spi2-atk, cups-libs, libdrm, libxkbcommon, mesa-libgbm, pango, alsa-lib]
  ```

  元のイメージにある repo の ID は `docker run --rm --user root --entrypoint dnf <元のイメージ> repolist --all` で確かめられます。

## どのイメージで動くか

- オーケストレーターは、工程を選ぶときに、工程それぞれのイメージを `images` から選びます。
  選ぶときは、リポジトリ（`pom.xml`・`go.mod`・`pyproject.toml`・`package.json` など。モノレポなら工程で触るディレクトリ）を読みます。
  オーケストレーター自身は既定のイメージで動きます。
- テストは、次の工程のイメージで動きます。
  そのため、テストを実行するイメージは、テストのコマンドとリポジトリの依存（Playwright などのブラウザのテスト、DB のクライアントなど）から選ばせます。
  - 実装の工程のイメージ（ゴールガーディアンが最終レビューの中で実行します）
  - 不具合の修正では、再現の工程のイメージ（再現のエージェントが実行します）
- 既定のイメージ（`image`）は、`images` のどれも合わないときの最後の手段です。
  Claude Code・Codex を動かす Node.js と git だけの最低限のもので、テストのブラウザ・DB のクライアント・ほかの言語のツールは入っていません。
  リポジトリが Node.js でも、`images` に合うものがあれば、そちらが使われます。
- 既定のイメージで動く工程には、`images` のどれも合わなかった理由が作業履歴（タスクの画面）に残ります。
  オーケストレーターが理由を書かなかった工程は、止めずに既定のイメージで進め、「理由が無いまま既定のイメージで動かす」と作業履歴に出します。
  テストが失敗したときは、ここを見て、`images` の `description` に、そのイメージに入っているツール（Playwright など）を書き足してください。
- テスト（検証）のコマンドに書いたツールが、テストを実行するイメージに無いとゴールガーディアンが報告したときは、sacty はタスクを一時停止して、イメージにツールを足す案内を出します（[検証のツールがイメージに無いとき](tasks.md#検証のツールがイメージに無いとき)）。
- プロジェクトの対象（リポジトリ・Org）ごとにイメージを指定すると、オーケストレーターに選ばせず、すべての工程でそれを使います。
  リポジトリの指定が Org の指定より優先します（[プロジェクトの設定](project-settings.md#対象)）。
- PR のレビューだけのタスク（[取り込み](intake.md)）でも、イメージを指定していなければ、オーケストレーターがレビューの工程のイメージを `images` から選びます。
  レビューは対象のプロジェクトのテスト・lint などの検証を実行するので、そのツールが入ったイメージを選ばせます。
  `images` を設定していなければ、オーケストレーターを使わずに既定のイメージでレビューします。
- 選んだイメージと理由は作業履歴に残ります。
  `images` に無い名前を選んだ・指定したときは、理由を示して止まります。

### 工程のイメージを変える

オーケストレーターが工程に合わないイメージを選んだとき（Playwright の要るリポジトリで既定のイメージを選んだなど）は、工程ごとに選び直せます。
選び直す所は、タスクの詳細の「工程」の欄の「工程のイメージ」です。

- 選べるのは、`images` の名前と `default`（既定のイメージ）です。
  それぞれの説明も出ます。
- 選び直せないときは、次のように出ます。
  - `images` に無い名前（config.yaml から消した名前など）は、理由を示して断ります。
  - config.yaml を読めないときは、設定の問題として理由を示して断ります。
  - sacty の状態を取得できないときは、候補を確かめられないことを出し、変える操作は出しません（少し待ってから開き直してください）。
- どの状態の工程も変えられます（これから実行する・実行中・失敗や一時停止・承認待ち・終わった工程）。
  - 変えたイメージは、その工程を次に実行するときから使います。
  - 実行中の工程は、今の実行はそのままで、次の実行から使います。
  - 画面の各工程に、いつから使うかが出ます。
- 実装の検証のテストは、ゴールガーディアンが実装の工程のイメージで実行します。
  実装の工程のイメージを変えると、次の最終レビューから使います。
- 失敗や一時停止で止まった工程は、イメージを変えてから「再開する」でやり直すと、変えたイメージで実行します。
- プロジェクトの対象でイメージを指定しているタスクも変えられます。
  人が変えた工程だけ、その指定より優先します。
- 変えたことは、作業履歴に「誰が・どの工程を・何から何に変えたか」で残ります。
  - 工程のイメージの欄には、人が変えた時刻と変える前の名前が出ます。
  - オーケストレーターが既定のイメージにした理由（または理由が無いこと）は、人が変えるまで工程のイメージの欄に出ます。
  - 作業履歴の「工程を決定」の行は、決めたときの記録のまま残ります。

## 関係するページ

- [config.yaml の設定](config.md)
- [docker compose のサービス](compose.md)
