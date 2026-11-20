<!-- 対応するコード: apps/daemon/src/config.ts（image_build・images・languageImageTag）、apps/daemon/src/image.ts、packages/cli/docker/Dockerfile、packages/cli/docker/install-tools.sh、packages/cli/docker/install-drawio.sh、packages/cli/docker/install-security-tools.sh、packages/cli/docker/drawio-shim.cjs、packages/cli/src/index.ts（imageBuild）、apps/daemon/src/service.ts（changeTaskImage・withImages・pinnedImage・stepSettingChanges）、apps/web/src/components/task-image-form.tsx、apps/daemon/src/context-images.ts、apps/daemon/src/main.ts、apps/web/src/components/shell/context-images-notice-view.tsx -->

**日本語** | [English](images.en.md)

# コンテナイメージ

エージェントは、コンテナイメージから作ったコンテナの中で動きます。
テストも、エージェントのコンテナの中で実行します。

まず、`npx sacty image build` でイメージを作ってください（[CLI](cli.md#sacty-image-build)）。
作ったイメージ（`config.yaml` の `image`。既定 `sacty-agent:1.29.0`）で、エージェントが動きます。
sacty を更新したら、イメージを作り直してください。

次のときは、追加の設定が要ります。
どれにも当てはまらなければ、追加の設定は要りません。

| こんなとき | 読む節 |
| --- | --- |
| Docker Hub や npm の公開レジストリを使えない | [プライベートのレジストリからイメージを作る](#プライベートのレジストリからイメージを作る) |
| Python・Go・Java などのリポジトリや、テストのブラウザを使うリポジトリなど、既定のイメージに無いツールが要る | [言語ごとのイメージ](#言語ごとのイメージ) |
| プロジェクトのコンテキストリポジトリに、そのプロジェクトだけで使うイメージを書きたい | [コンテキストのイメージ](#コンテキストのイメージ) |

イメージに入っているツールは、[イメージに入るツール](#イメージに入るツール) にあります。
タスクがどのイメージで動くかと、選び直し方は、[どのイメージで動くか](#どのイメージで動くか) にあります。

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
| `drawio` | draw.io の図を変換・書き出す（[draw.io の CLI](#drawio-の-cli)） |
| `osv-scanner`・`gitleaks` | 依存の脆弱性・秘密情報の混入を検査する（セキュリティチェック・セキュリティ対応で使います。[タスクを進める](tasks.md#セキュリティチェックと対応)） |

このほかに、`gh api` だけを使える `gh` が入ります。
この `gh` は GitHub をゲートウェイ経由で読むためのもので、元のイメージの `gh` より先に使われます（[ゲートウェイ](gateway.md#github-の読み取り)）。

表のコマンドは、次のように入れます。

- どれもオープンソースのソフトウェアで、OS の配布元のパッケージ（元のイメージに設定してあるミラー）から入れます。
  入るのは、イメージを作った時点の版です。
- `osv-scanner`・`gitleaks` は、OS のパッケージではなく、GitHub の公式のリリースから版を固定して取り、sacty に固定したハッシュで確かめてから入れます。
  GitHub のリリースに届かないときは、ビルドのログに警告を出して、入れずに作ります（工程は、その区分を確かめていない範囲として報告します）。
  ハッシュが合わないときは、作るのを止めます。
- パッケージのミラーに届かないなどで入れられなかったコマンドがあっても、sacty はビルドのログに警告を出して、そのまま作ります（エージェントは別の方法で代えます）。

### OS のセキュリティの更新を入れる

OS のセキュリティの更新は、イメージを作り直して入れます。
入れたいものによって、することが違います。

- sacty が OS のパッケージで入れるコマンドの更新は、`npx sacty image build` で作り直すと入ります。
  `npx sacty image build` は、作るたびにビルドキャッシュを片付けます。そのため、次に実行したときは、すべての手順を最初から実行し、パッケージをその時点の版で取り直します（[CLI](cli.md#sacty-image-build)）。
  ビルドのログに `CACHED` と出た手順は、実行し直していません。前の作成が途中で失敗したとき（片付けるのは、すべてのイメージを作れた後だけです）や、片付けに失敗したときなどに、出ることがあります。そのときは、`docker builder prune` でビルドキャッシュを消してから、もう一度作り直してください。
- 元のイメージにすでにあるコマンドの更新は、元のイメージを新しいものにしてから作り直すと入ります（sacty は、元のイメージにあるコマンドを入れ直しません）。
  元のイメージのダイジェストを更新した sacty に更新するか、`image_build.base_image` に更新した元のイメージ（`node:26-bookworm-slim` などのタグや、`<タグ>@sha256:<ダイジェスト>`）を書きます。
  `image_build.base_image` に書いたイメージがタグだけなら、`docker pull <元のイメージ>` で取り直します。
  既定の元のイメージは sacty の中でダイジェストで固定しているので、`docker pull` で取り直しても変わりません。

### RHEL 系の元のイメージ

RHEL 系の元のイメージでは、`rg`・`fd`・`shellcheck` は EPEL にしか無いので、EPEL を使えなければ入りません。
入れるには、[言語ごとのイメージ](#言語ごとのイメージ)の `run` に、次のように書きます。

- EPEL を有効にするコマンドの後に、同じ `run` の中で入れます。
- 組織の EPEL のミラーがあれば、`epel-release` の代わりに、そのリポジトリの設定を置くコマンドにします。
- `packages` は `run` より先に入れるので、EPEL のパッケージは `packages` に書かないでください。

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

既定のスキル `drawio`（[コンテキストリポジトリ](context.md#図用スキル)）は、draw.io の CLI で次のことをします。

- 図の変換（Mermaid から draw.io の形式へ）
- 自動のレイアウト
- PNG・SVG・PDF への書き出し

sacty は、draw.io Desktop（Apache-2.0）の公式のリリースを GitHub から取り、版とハッシュを固定して確かめてから入れます。
日本語のラベルを書き出せるように、CJK のフォント（Noto CJK）も入れます。

draw.io の CLI を入れると、イメージが大きくなります（展開した大きさで 800MB ほど）。
GitHub のリリース（`github.com` と `release-assets.githubusercontent.com`）に届かない環境や、イメージを小さくしたいときは、`image_build.drawio` を `false` にしてください。
入れないときも、スキルは XML で図（`.drawio`）を作れます。

```yaml
image_build:
  drawio: false   # draw.io の CLI を入れない
```

入れるときに問題があると、次のようになります。

- GitHub に届かないときは、ビルドのログに警告を出して、draw.io の CLI を入れずに作ります。
- 取得したファイルのハッシュが合わないときは、作るのを止めます。
- 入れた draw.io の CLI が読めないライブラリが残ったときも、ビルドのログに、そのライブラリの名前を示す警告を出します（そのときは `drawio` が起動しません）。

## プライベートのレジストリからイメージを作る

Docker Hub や npm の公開レジストリを使えない環境では、次の順に作ってください。

1. `config.yaml` の `image_build` に、元のイメージと npm のレジストリを書きます。
2. `sacty image build` を実行します。

`image_build` を書かなければ、Docker Hub の `node:26-bookworm-slim` と npm の公開レジストリから作ります。

```yaml
image: registry.example.com/sacty-agent:1.29.0
image_build:
  base_image: registry.example.com/library/node:26-bookworm-slim   # Node.js 18 以上で node ユーザーがあること
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
| `base_image` | 元のイメージ（Node.js 18 以上で、`node` ユーザーがあること） | `node:26-bookworm-slim` |
| `npm_registry` | npm のレジストリ（`http`・`https` の URL） | npm の公開レジストリ |
| `npm_token` | npm のレジストリの認証トークン（秘密情報の名前か 1Password の参照） | なし |
| `npm_version` | イメージに入れる npm の版（`latest` か、`11`・`11.4`・`11.4.2` の形） | 元のイメージの npm |
| `npm_config` | コンテナの中の npm 全体の設定 | なし |
| `drawio` | draw.io の CLI を入れるか（[draw.io の CLI](#drawio-の-cli)。言語ごとのイメージにも効きます） | `true` |

イメージを作るとき、sacty は次のように動きます。

- Claude Code・Codex とその依存は、sacty が lockfile で固定した版を、`npm_registry` のレジストリから取ります。
  レジストリにその版が無いときや、中身が公開レジストリのものと違う（`integrity` が合わない）ときは、作れません。
- 既定の元のイメージは、タグに加えてダイジェストで固定しています（同じ sacty の版なら、同じ元のイメージから作ります）。
- npm のトークンは、ビルドのときだけ読ませます（BuildKit の secret）。
  イメージの層・履歴・環境変数には残りません。
- 元のイメージに git が入っていれば、Debian のミラーに届かなくても作れます。

作ったイメージのコンテナの中の npm には、次の設定が効きます。

- `npm_registry` は、コンテナの中の npm の registry にもなります（`npm_config` の `registry` があれば、そちらが優先します）。
  `npm_token` はイメージを作るときだけ使い、コンテナの中では使いません。
- `npm_config` はイメージに残り、コンテナの中のすべての npm（対象リポジトリの `npm ci` など）に効きます。
  対象リポジトリの `.npmrc` に同じ項目があれば、そちらが優先します。
  認証の項目（`_authToken`・`_auth`・`_password`・`username`・`email`・`certfile`・`keyfile`・`cert`・`key`）はイメージに残るので、書けません。

## 言語ごとのイメージ

Python・Go・Java などのリポジトリには、言語のツールが入ったイメージ（CI のイメージなど）を元にして、言語ごとのイメージを作ります。
作ったイメージのどれでタスクが動くかは、[どのイメージで動くか](#どのイメージで動くか) にあります。

`config.yaml` の `images` に、名前ごとに、元のイメージ（`base_image`）と、オーケストレーターが選ぶときに見る説明（`description`）を書きます。

```yaml
images:
  java17:
    description: Java 17・Maven・Gradle          # オーケストレーターが選ぶときに見る説明
    base_image: registry.example.com/ci/java:17   # Debian・Ubuntu 系か RHEL 系（Rocky Linux など）
    maven_mirror: https://maven.example.com/repository/maven-public/
  python:
    description: Python 3.12・pip・uv
    base_image: registry.example.com/ci/python:3.12
    env:                                          # エージェントのコンテナに渡す
      PIP_INDEX_URL: https://pypi.example.com/simple
  go:
    description: Go 1.23
    base_image: registry.example.com/ci/go:1.23
    env:
      GOPROXY: https://goproxy.example.com
```

書いたら、次のコマンドで作ります。

```sh
npx sacty image build            # 既定のイメージと images のすべて
npx sacty image build java17     # 名前を指定して作る（default は既定のイメージ）
```

| 項目 | 意味 | 既定値 |
| --- | --- | --- |
| （名前） | 英小文字・数字で始まる、英小文字・数字・`_`・`-` の40文字まで。`default` は使えない | なし |
| `description` | オーケストレーターが選ぶときに見る説明（200文字まで）。必須 | なし |
| `base_image` | 元のイメージ。必須 | なし |
| `image` | 作るイメージの名前 | `sacty-agent-<名前>:1.29.0` |
| `node_image` | Node.js を写す元のイメージ（元のイメージに Node.js 18 以上と npm が無いとき） | `image_build.base_image`、無ければ `node:26-bookworm-slim` |
| `env` | エージェントのコンテナの環境変数 | なし |
| `maven_mirror` | Maven・Gradle の取得先 | なし |
| `packages` | イメージを作るときに入れる OS のパッケージ | なし |
| `enable_repos` | `packages` を入れるときに有効にするパッケージのリポジトリの ID | なし |
| `run` | イメージを作るときに root で実行するコマンド | なし |

### 元のイメージに sacty が足すもの

sacty は、元のイメージに git・Claude Code・Codex を足し、`node` ユーザーで動かします。

- 元のイメージに Node.js 18 以上と npm があればそれを使い、無ければ `node_image` から写します。
  npm は `npm root -g`・`/usr/local/lib/node_modules`・`/usr/lib/node_modules` から探します。
- npm の設定は `image_build` のものを使います。
- エージェントは `node` ユーザーで動くので、`HOME` を `/home/node`、`GOPATH` を `/home/node/go` にし、`/home/node/go/bin` を PATH に足します。
  CI のイメージが root 向けの場所にしていても書けるようにするためです。
  `GOPATH` は `env` で上書きできます。

写した Node.js が動かないとき（`ubuntu:24.04` のような素のイメージで、共有ライブラリが足りないなど）は、次のようになります。

- sacty は、元のイメージにある apt-get・dnf・microdnf・yum で `libatomic`・`libstdc++` を入れます。
- それでも動かなければ、「写した Node.js … が、元のイメージで動きません」と理由を示して止まります。
  そのときは、元のイメージで動く Node.js のイメージ（同じ C ライブラリのもの）を `node_image` に書くか、Node.js 18 以上と npm の入った元のイメージを使ってください。
- Alpine など musl のイメージには、既定の `node_image`（glibc）の Node.js は写せません。
- この確かめは `packages`・`run` より前に行うので、足りないものを `packages`・`run` で入れても間に合いません。

### 環境変数と Maven・Gradle の取得先（`env`・`maven_mirror`）

`env` には、組織のレジストリなど（`PIP_INDEX_URL`・`UV_DEFAULT_INDEX`・`GOPROXY`・`GONOSUMDB` など）を書きます。

- 名前は、英大文字か `_` で始まる、英大文字・数字・`_` です。
- コンテナの中のすべてのコマンドに見えるので、認証の値（`TOKEN`・`PASSWORD`・`SECRET`・`AUTH`・`API_KEY` などを含む名前、ユーザー名・パスワードを含む URL）は書けません。
- `PATH`・`HOME`・`USER`・`SHELL`・`TMPDIR`・`NODE_OPTIONS` や、`SACTY_`・`DOCKER_`・`CODEX_`・`CLAUDE_`・`ANTHROPIC_`・`OPENAI_`・`NPM_CONFIG_` で始まる名前も書けません。

`maven_mirror` は、Maven（`settings.xml` の mirror）と Gradle（init スクリプト）の取得先を、すべてその URL に向けます。
ユーザー名・パスワードを含む URL と、引用符などの記号を含む URL は書けません。

### OS のパッケージを入れる・コマンドを実行する（`packages`・`run`）

イメージを作るときに、OS のパッケージを入れ、コマンドを実行できます。

- `packages` に書いた OS のパッケージは、イメージを作るときに root で入れます。
  使うのは、dnf・microdnf・yum・apt-get のうち、元のイメージにあるものです。
- `run` に書いたコマンドは、イメージを作るときに root で上から順に実行します（組織のパッケージのリポジトリの設定、CLI の導入など）。
  失敗したら止めます。
- `packages`・`run` を変えると、`sacty image build` で作り直されます。
- イメージに残るので、`run` に秘密情報は書かないでください。

```yaml
images:
  node-pw:
    description: Node.js 26・Playwright
    base_image: registry.example.com/ci/node:26
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

### 無効にしてあるリポジトリを有効にする（`enable_repos`）

元のイメージに設定があるが無効にしてあるパッケージのリポジトリ（組織の rpm リポジトリなど）は、`enable_repos` に repo の ID を書くと、sacty が `packages` を入れるときに有効にします（dnf・microdnf・yum の `--enablerepo`）。

```yaml
images:
  rocky-pw:
    description: Rocky Linux 9・Playwright
    base_image: registry.example.com/ci/rocky:9
    enable_repos: [acme-baseos, acme-appstream]
    packages: [nss, nspr, atk, at-spi2-atk, cups-libs, libdrm, libxkbcommon, mesa-libgbm, pango, alsa-lib]
```

- `packages` と一緒に書きます（`packages` が無いと誤りになります）。
- ID は英数字で始まり、英数字と `. _ : -` だけです。
  元のイメージにある repo の ID は `docker run --rm --user root --entrypoint dnf <元のイメージ> repolist --all` で確かめられます。
- apt-get のイメージでは使えません。
  理由を示して止まるので、リポジトリの設定は `run` で行ってください。
- `enable_repos` を変えると、`sacty image build` で作り直されます。

## コンテキストのイメージ

プロジェクトのコンテキストリポジトリの `images.yaml` に書いたイメージ（[images.yaml](context.md#imagesyaml)）は、そのプロジェクトのタスクだけで使えます。
コンテキストのイメージは、`sacty up` で起動した後に sacty が裏で作ります。
`sacty image build` が作るのは、`config.yaml` のイメージだけです。

sacty は、次のときに作り始めます。

- `sacty up` の起動のとき（秘密情報をまとめて取り出した後）
- プロジェクトの設定を保存したとき
- 5分ごと（コンテキストリポジトリに push した定義は、遅くともこの間隔で作り始めます）

作るとき、sacty は次のように動きます。

- 手元にあるイメージは作りません。
  作ったイメージが消えていれば（`docker image prune` など）、読み直すときに作り直します。
  定義・`config.yaml` の `image_build`・sacty の版のどれかが変わると、新しい名前で作り直します。
- Docker の負荷を抑えるため、1つずつ順に作ります。
- 使わなくなったコンテキストのイメージ（古い定義のもの、消したプロジェクトのもの）は、作り終えた後に消します。
  コンテナが使っているものと、同じ Docker を使う別の `SACTY_HOME` の sacty が作ったものは残ります。
- このとき、使っていないビルドキャッシュも消します（Docker 全体のビルドキャッシュが対象です。使っていない期間では絞りません）。
  消した後に作るイメージは、ビルドキャッシュを使わず、すべての手順を最初から実行すると見ています。パッケージなどのダウンロードもやり直すので、時間がかかります。
  いまあるイメージと共有している層は、ディスクには残りますが、消した後のビルドでは使いません。
  これは、`npx sacty image build` の片付けの後のビルドで確かめた動きです（[CLI](cli.md#sacty-image-build)）。sacty を動かしている間の片付けも同じコマンドですが、その後のビルドでは確かめていません。
  同じ Docker を使う、sacty 以外のビルドのキャッシュも消えます。
  ビルドキャッシュを消すのは、sacty を起動した後の最初の片付けと、その後は6時間に1回です（消せなかったときは、次の読み直しで試し直します）。
  結果（docker の出力の最後の行）と、消せなかったことは、sacty を起動した端末のログに出ます。
- どれかのプロジェクトのコンテキストリポジトリを読めない間は、使わなくなったコンテキストのイメージを消しません（残すイメージを決められないためです）。
  ビルドキャッシュは、その間も同じ間隔で消します。そのとき、イメージの片付けを飛ばしたことが、sacty を起動した端末のログに出ます。
  読めるようになると、次の読み直しから、使わなくなったイメージも消します。
- `config.yaml` を読めない間は、使わなくなったイメージもビルドキャッシュも消しません（ログにも出ません）。
  読めるようになると、次の読み直しから消します。それまでは、`npx sacty image build` か `docker builder prune` で片付けてください。
- 1つのプロジェクトのコンテキストリポジトリの取得が5分で終わらなければ、止めて、読めなかったことにします（ほかのプロジェクトを先に進めます）。

### 作っている間

画面には、どの画面でも中身の上に「イメージの作成」として、作成中・順番待ちのイメージと、作成中のログの末尾が出ます。
作り終えると、リロードせずに消えます。

作っている間は、そのイメージを使うかもしれないタスクは始まりません（実行待ちのままです）。

- イメージをまだ選んでいないタスク（工程を選ぶ前）は待ちます。
  作り終えてからオーケストレーターが選ぶので、作成中のために合わないイメージが選ばれることはありません。
- 既定のイメージや `config.yaml` のイメージを使うと決まっているタスクは待ちません。

待っているタスクについては、次のとおりです。

- 同時に実行する数に数えません（ほかのタスクは先に進みます）。
- 待っている間も、一時停止・中止はできます。
- 60分たっても作り終えなければ、sacty は理由を示してタスクを一時停止します。
  作り終えてから再開してください。

### 作れなかったとき

「イメージの作成」に、作れなかったイメージ・理由・ログの末尾と「作り直す」が出ます。
1つのイメージの作成が60分で終わらないときも、止めて失敗にします（後のイメージを作れるようにするためです）。

作れなかったイメージは、自動では作り直しません（同じ失敗を繰り返さないためです）。
原因に合わせて、次のようにしてください。

- 一時的な失敗（ネットワークなど）なら、「作り直す」を押します。
- 定義の誤りなら、`images.yaml` を直して push します。
  新しい定義で作り直します。

次のときは、sacty がもう一度作るか、確かめ直します。

- `sacty up` を起動し直したときは、もう一度作ります（失敗したことは記録しません）。
- Docker に接続できなかったときだけは、次に読み直すとき（5分ごと）に確かめ直します。

作れなかったイメージと、読めなかった `images.yaml` については、次のとおりです。

- 作れなかったイメージも、タスクのイメージとして選べます。
  そのイメージで動く工程は、実行せずに理由を示して一時停止します。
  作り直してから再開してください。
- `images.yaml` を読めなかった（コンテキストリポジトリを取得できないなど）ときは、警告に出ます。
  前に読めた定義があれば、それを使い続けます。

## どのイメージで動くか

タスクのイメージは1つです。タスクのすべての工程とテストが、同じイメージで動きます。

オーケストレーター・人が選べるのは、`config.yaml` の `images` と、タスクのプロジェクトの[コンテキストのイメージ](#コンテキストのイメージ)です。

イメージは、次の順で決まります（先にあるものが優先します）。

1. 中止したタスクを再実行するときに選んだイメージ
2. タスクを作るときに人が指定したイメージ（[タスクのイメージと工程ごとのエージェントを指定する](tasks.md#タスクのイメージと工程ごとのエージェントを指定する)）
3. プロジェクトの対象（リポジトリ・Org）ごとのイメージ。リポジトリの指定が Org の指定より優先します（[プロジェクトの設定](project-settings.md#対象)）
4. オーケストレーターの選択（`images` を設定していなければ、既定のイメージ）

選んだイメージと理由は作業履歴に残ります。
`images` に無い名前を選んだ・指定したときは、理由を示して止まります。
決まったイメージがタスクに合わないときは、選び直せます（[タスクのイメージを変える](#タスクのイメージを変える)）。

### オーケストレーターの選び方

オーケストレーターは、工程を選ぶときに、タスクのイメージを `images` から1つ選びます。
オーケストレーター自身は既定のイメージで動きます。

- 選ぶときは、リポジトリ（`pom.xml`・`go.mod`・`pyproject.toml`・`package.json` など。モノレポなら作業で触るディレクトリ）を読みます。
- テストもタスクのイメージで動きます（実装の工程のエージェントが実行します。不具合の修正では、再現のエージェントも実行します）。
  そのため、イメージは、テストのコマンドとリポジトリの依存（Playwright などのブラウザのテスト、DB のクライアントなど）から選ばせます。
  テストのコマンドのツールを持つイメージがあれば、それが優先されます。
  どのイメージにも無いときだけ、オーケストレーターはテストのコマンドを書いたうえで、イメージを選んだ理由にそのことを残します。
- 取り込んだ PR のレビューだけのタスク（[取り込み](intake.md)）でも、イメージを指定していなければ、オーケストレーターがタスクのイメージを `images` から選びます。
  レビューは対象のプロジェクトのテスト・lint などの検証を実行するので、そのツールが入ったイメージを選ばせます。
  `images` を設定していなければ、オーケストレーターを使わずに既定のイメージでレビューします。
- sacty が作った PR のレビューの子タスクは、オーケストレーターを使わず、PR を作ったタスクのイメージでレビューします（そのイメージが `images` にあるときだけ。無いときは、上の決め方です）。

### 既定のイメージ

既定のイメージ（`image`）は、`images` のどれも合わないときの最後の手段です。
リポジトリが Node.js でも、`images` に合うものがあれば、そちらが使われます。

既定のイメージは、次のものが入った最低限のものです。

- Node.js・npm・git・Claude Code・Codex
- 作業用の CLI（`jq`・`rg`・`fd`・`tree`・`curl`・`zip`・`make`・`python3`・`sqlite3`・`shellcheck` ほか。[イメージに入るツール](#イメージに入るツール)）
- `drawio`・`osv-scanner`・`gitleaks`

次のものは入っていません。

- Go・Java・pnpm・yarn・C のコンパイラ・`golangci-lint` などの、ほかの言語のツール
- テストのブラウザ
- DB のクライアント（`sqlite3` を除く）
- `kustomize`・`helm` などの検証のツール

既定のイメージで動くタスクには、`images` のどれも合わなかった理由が作業履歴とタスクの詳細に残ります。
オーケストレーターが理由を書かなかったときは、止めずに既定のイメージで進めます。
このときは、作業履歴の「工程を決定」の行に「理由なく既定のイメージ」、タスクのイメージの欄に「オーケストレーターが既定を選択（理由なし）」と出ます。
テストが失敗したときは、この理由を見て、`images` の `description` に、そのイメージに入っているツール（Playwright など）を書き足してください。

### タスクのイメージを変える

オーケストレーターがタスクに合わないイメージを選んだとき（Playwright の要るリポジトリで既定のイメージを選んだなど）は、選び直せます。
選び直す所は、タスクの詳細の「工程の設定」タブの「タスクのイメージ」です。
一時停止したタスクを再開するときと、承認の画面で差し戻すときも、「タスクのイメージ・工程のエージェントを変える」（開いて使います）で一緒に選び直せます（[一時停止・再開・中止](tasks.md#一時停止再開中止)・[工程のエージェントを変える](tasks.md#工程のエージェントを変える)）。
再開・差し戻しのときに変えたイメージの扱いは、タスクの詳細で変えたときと同じです。

選べるイメージと、変えられるタスクは、次のとおりです。

- 選べるのは、`images` の名前と `default`（既定のイメージ）です。
  選択肢には名前だけが出て、選んだイメージの説明（`images` の `description`）は下に出ます。
- 工程が決まった後なら、いつでも変えられます（実行中・失敗や一時停止・承認待ち）。
- プロジェクトの対象の指定・作成時の人の指定・再実行での人の指定でイメージが決まったタスクも変えられます。

変えたイメージは、すべての工程の次の実行から使います。

- 実行中の工程は、今の実行はそのままで、次の実行から使います。
- 実装の検証のテストも、実装の工程のエージェントがタスクのイメージで実行します。
  変えると、次の実装の実行から使います。
- 失敗や一時停止で止まった工程は、イメージを変えてから「再開する」でやり直すと、変えたイメージで実行します。

選び直せないときは、次のように出ます。

- `images` に無い名前（config.yaml から消した名前など）は、理由を示して断ります。
- config.yaml を読めないときは、設定の問題として理由を示して断ります。
- sacty の状態を取得できないときは、候補を確かめられないことを出し、変える操作は出しません（少し待ってから開き直してください）。

変えたことは、次のように残ります。

- 作業履歴に「誰が・何から何に変えたか」で残ります。
- タスクのイメージの欄には、人が変えた時刻と変える前の名前が出ます。
- オーケストレーターが既定のイメージにした理由（または理由が無いこと）は、人が変えるまでタスクのイメージの欄に出ます。
- 作業履歴の「工程を決定」の行は、決めたときの記録のまま残ります。

### 以前の版で作ったタスク

以前の版の sacty で作ったタスクは、工程ごとにイメージを決めていることがあります。

- そのタスクは、それぞれの工程のイメージのまま動きます。
- タスクの詳細には「工程ごと（古い版）」と、工程ごとに最後に設定したイメージと、実行で使ったイメージが出ます。
- 最後に設定したイメージが `images` に無い工程は、そのまま実行すると止まるので、警告が出ます。
  タスクのイメージを選び直してください（[タスクのイメージを変える](#タスクのイメージを変える)）。
- タスクのイメージを選ぶと、それからはすべての工程がそのイメージで動きます。

## 関係するページ

- [config.yaml の設定](config.md)
- [docker compose のサービス](compose.md)
