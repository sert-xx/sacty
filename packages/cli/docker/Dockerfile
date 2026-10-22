# sacty のエージェント実行用イメージ。タスクごとにこのイメージからコンテナを作る。
# 既定のイメージ：元のイメージは config.yaml の image_build.base_image で変えられる（プライベートのレジストリなど。PBI-33）。
#   Node.js 18 以上で、node ユーザーがあること（公式の node のイメージを写したものなど）。
# 言語ごとのイメージ（config.yaml の images。PBI-41）：BASE_KIND=lang。元のイメージ（Debian・Ubuntu 系か、Rocky Linux
#   などの RHEL 系。glibc のもの）に Node.js 18 以上と npm があればそれを使い、無ければ NODE_IMAGE から写して作る。
ARG BASE_IMAGE=node:22-bookworm-slim
ARG NODE_IMAGE=node:22-bookworm-slim
# node：元のイメージをそのまま使う。lang：Node.js を写し、node ユーザーを作る
ARG BASE_KIND=node

# Node.js を写す元（元のイメージに使える Node.js が無いとき）。node と npm の実際の場所を探して /sacty-node に集める
# （npm が /usr/local/lib/node_modules に無いイメージもあるため）。無ければ空のまま（使うときに理由を示す）
FROM ${NODE_IMAGE} AS sacty-node
USER root
RUN mkdir -p /sacty-node/bin /sacty-node/lib/node_modules \
  && n="$(command -v node || true)" \
  && if [ -n "$n" ]; then cp "$(readlink -f "$n")" /sacty-node/bin/node; fi \
  && for d in "$(npm root -g 2>/dev/null || true)" /usr/local/lib/node_modules /usr/lib/node_modules; do \
    if [ -n "$d" ] && [ -f "$d/npm/bin/npm-cli.js" ]; then cp -R "$d/npm" /sacty-node/lib/node_modules/npm; break; fi; \
  done

FROM ${BASE_IMAGE} AS base-node

FROM ${BASE_IMAGE} AS base-lang
USER root
# 元のイメージに Node.js 18 以上と npm があれば、それを使う（Node.js のイメージなど）。無ければ、写す元から写した
# Node.js（と npm）を、ほかのツールとぶつからない場所に置く。グローバルに入れる CLI もそこに入る
COPY --from=sacty-node /sacty-node /opt/sacty-node
RUN if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1 \
    && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 18 ]; then \
    rm -rf /opt/sacty-node; \
  elif [ -x /opt/sacty-node/bin/node ] && [ -f /opt/sacty-node/lib/node_modules/npm/bin/npm-cli.js ]; then \
    ln -s ../lib/node_modules/npm/bin/npm-cli.js /opt/sacty-node/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /opt/sacty-node/bin/npx; \
  else \
    echo "sacty: 元のイメージに Node.js 18 以上と npm が無く、Node.js を写す元のイメージ（images の node_image か image_build.base_image）にも node と npm が見つかりません。node と npm の入ったイメージを node_image に書いてください。" >&2; \
    exit 1; \
  fi
# root では動かさない。元のイメージに node ユーザーが無ければ作る（UID 1000 が使われていれば、空いている番号）
RUN if ! id node >/dev/null 2>&1; then \
    if command -v useradd >/dev/null 2>&1; then \
      if getent passwd 1000 >/dev/null 2>&1; then useradd -m -s /bin/sh node; \
      else useradd -m -u 1000 -s /bin/sh node; fi; \
    else \
      adduser -D -s /bin/sh node; \
    fi; \
  fi \
  && mkdir -p /home/node/go \
  && chown -R "node:$(id -g node)" /home/node
# エージェントを動かす node ユーザーの場所を既定にする。CI のイメージは HOME・GOPATH を root 向けの場所（/root など）に
# していることがあり、node ユーザーでは書けないため（Go のキャッシュ・モジュール、Maven の設定など）。
# 元のイメージの PATH は残し（入っているツールはそのまま使える）、go install で入れたツールの場所を足す。
# GOPATH を別の場所にしたいときは、images の env で上書きする
ENV HOME=/home/node \
  GOPATH=/home/node/go \
  PATH=/opt/sacty-node/bin:$PATH:/home/node/go/bin

FROM base-${BASE_KIND}
# イメージに入れる npm の版（config.yaml の image_build.npm_version。空なら元のイメージの npm。PBI-40）
ARG NPM_VERSION=
# Maven・Gradle の取得先にする組織のミラー（言語ごとのイメージの maven_mirror。空なら設定しない。PBI-41）
ARG MAVEN_MIRROR=

USER root

# git が無ければ入れる（元のイメージに入っていれば、パッケージのミラーに届かない環境でも作れる）。
# Debian・Ubuntu 系は apt-get、RHEL 系は dnf・microdnf・yum
RUN if ! command -v git >/dev/null 2>&1; then \
    if command -v apt-get >/dev/null 2>&1; then \
      apt-get update \
      && apt-get install -y --no-install-recommends git ca-certificates \
      && rm -rf /var/lib/apt/lists/*; \
    elif command -v dnf >/dev/null 2>&1; then dnf install -y git-core && dnf clean all; \
    elif command -v microdnf >/dev/null 2>&1; then microdnf install -y git-core && microdnf clean all; \
    elif command -v yum >/dev/null 2>&1; then yum install -y git && yum clean all; \
    else echo "sacty: git が無く、パッケージの管理のコマンドも見つかりません。git の入った元のイメージを使ってください。" >&2; exit 1; \
    fi; \
  fi

# エージェントの作業で使う CLI（jq・rg・fd・python3 など）。元のイメージに無いものだけを、OS のパッケージで入れる。
# パッケージのミラーに届かないなどで入れられないものは、警告して続ける（中身は install-tools.sh）
COPY --chmod=755 install-tools.sh /opt/sacty/lib/install-tools.sh
RUN /opt/sacty/lib/install-tools.sh

# draw.io の CLI（既定のスキル drawio が使う）。公式のリリースのパッケージを、版とハッシュを固定して入れ、画面の無い
# コンテナで動かすための包むスクリプトを /opt/sacty/bin/drawio に置く（config.yaml の image_build.drawio が false なら
# 入れない。drawio_mirror があれば、そこから取る）。取得できないときは警告して続け、ハッシュが合わないときは止める（中身は install-drawio.sh）
ARG SACTY_DRAWIO=1
# draw.io のパッケージの取得先（config.yaml の image_build.drawio_mirror。空なら GitHub のリリース）
ARG SACTY_DRAWIO_MIRROR=
COPY --chmod=755 install-drawio.sh drawio-shim.cjs /opt/sacty/lib/
RUN /opt/sacty/lib/install-drawio.sh

# エージェントのCLI。版を固定し、上げるときはこのファイルを変える。
# npm のレジストリと認証は、sacty が作った .npmrc をビルドのときだけ読ませる（イメージには残らない。PBI-33）
# キャッシュは一時的な場所に置いて消す（HOME の下に root の持ち物を残すと、node ユーザーの npm が書けなくなるため）
RUN --mount=type=secret,id=npmrc,target=/run/secrets/npmrc \
  NPM_CONFIG_USERCONFIG=/run/secrets/npmrc \
  NPM_CONFIG_CACHE=/tmp/sacty-npm-cache \
  npm install -g @anthropic-ai/claude-code@2.1.296 @openai/codex@0.160.0 \
    ${NPM_VERSION:+npm@${NPM_VERSION}} \
  && rm -rf /tmp/sacty-npm-cache

# コンテナの中の npm 全体の設定（config.yaml の image_build.npm_config。認証の項目は含まない。PBI-40）。
# CLI を入れた後に置く（CLI の取得には効かせない）。ファイルの受け渡しは、認証の .npmrc と同じ secret の仕組みを
# 使う（--build-context は、Docker の構成によっては使えないため）。中身はこの RUN でイメージの設定に書き込む。
# secret の中身はビルドのキャッシュの判定に入らないので、中身のハッシュを引数で渡し、変わったら作り直す。
# 元のイメージにすでに設定があり、最後の行が改行で終わっていなければ、改行してから書き足す（行がつながらないように）
ARG NPM_CONFIG_HASH=
RUN --mount=type=secret,id=npmconfig,target=/run/secrets/npmconfig \
  if [ ! -f /run/secrets/npmconfig ]; then \
    echo "sacty: npm の設定のファイルが渡されていません。sacty を作り直して（npm run build）から、sacty image build を実行してください。" >&2; \
    exit 1; \
  fi \
  && g="$(npm config get globalconfig)" && mkdir -p "$(dirname "$g")" \
  && { [ ! -s "$g" ] || [ -z "$(tail -c 1 "$g")" ] || echo; cat /run/secrets/npmconfig; } >> "$g"

# イメージを作るときに入れる OS のパッケージと、実行するコマンド（言語ごとのイメージの packages・run。PBI-50）。
# パッケージは、元のイメージにあるパッケージの管理のコマンド（dnf・microdnf・yum・apt-get）で入れる。コマンドは
# 上から順に root で実行し、失敗したら止める（bash があれば pipefail で、パイプの途中の失敗でも止める）。
# SACTY_ENABLE_REPOS（images の enable_repos。PBI-59）は、元のイメージで無効にしてあるリポジトリを、dnf・microdnf・yum の
# --enablerepo で有効にして入れる（apt-get では使えないので止める）。ID は設定の読み込みで、シェルの特別な文字を含まない
# 形に限っている。コマンドのファイルは secret の仕組みで受け取る（中身のハッシュで作り直す）
ARG SACTY_PACKAGES=
ARG SACTY_ENABLE_REPOS=
ARG SACTY_SETUP_HASH=
RUN --mount=type=secret,id=setup,target=/run/secrets/setup \
  if [ -n "$SACTY_PACKAGES" ]; then \
    repos=""; for r in $SACTY_ENABLE_REPOS; do repos="$repos --enablerepo=$r"; done; \
    if command -v dnf >/dev/null 2>&1; then dnf $repos install -y $SACTY_PACKAGES && dnf $repos clean all; \
    elif command -v microdnf >/dev/null 2>&1; then microdnf $repos install -y $SACTY_PACKAGES && microdnf $repos clean all; \
    elif command -v yum >/dev/null 2>&1; then yum $repos install -y $SACTY_PACKAGES && yum $repos clean all; \
    elif command -v apt-get >/dev/null 2>&1; then \
      if [ -n "$SACTY_ENABLE_REPOS" ]; then \
        echo "sacty: enable_repos（$SACTY_ENABLE_REPOS）は dnf・microdnf・yum のリポジトリを有効にするものです。apt-get のイメージでは使えないので、images の enable_repos を消し、リポジトリの設定は run で行ってください。" >&2; \
        exit 1; \
      fi; \
      apt-get update && apt-get install -y --no-install-recommends $SACTY_PACKAGES && rm -rf /var/lib/apt/lists/*; \
    else echo "sacty: パッケージの管理のコマンド（dnf・microdnf・yum・apt-get）が見つからないので、packages を入れられません。" >&2; exit 1; \
    fi; \
  fi \
  && if [ -s /run/secrets/setup ]; then \
    if command -v bash >/dev/null 2>&1; then bash -ex -o pipefail /run/secrets/setup; \
    else sh -ex /run/secrets/setup; fi; \
  fi

# gh の代わり：gh api（REST の GET と GraphQL の query）だけを、sacty のゲートウェイの GitHub の読み取りの中継に送る。
# トークンはコンテナに入れない（ゲートウェイが、プロジェクトの gh のアカウントで認証する）。元のイメージに本物の gh が
# あっても、認証が無く使えないので、PATH の先頭に置いてこちらを使わせる
COPY --chmod=755 gh-shim.cjs /opt/sacty/bin/gh
ENV PATH=/opt/sacty/bin:$PATH

# root で実行した手順（npm など）が HOME の下に作ったものを、node ユーザーの持ち物に戻す
RUN if [ -d /home/node ]; then chown -R "node:$(id -g node)" /home/node; fi

# root では動かさない（node ユーザー）
USER node
WORKDIR /workspace

# Maven・Gradle の取得先を、組織のミラーに向ける（PBI-41）。Maven は settings.xml の mirror、Gradle は init スクリプトで、
# プロジェクトに書かれたすべての Maven のリポジトリ（プラグインの取得先も含む）の URL をミラーに置き換える
RUN if [ -n "$MAVEN_MIRROR" ]; then \
    mkdir -p "$HOME/.m2" "${GRADLE_USER_HOME:-$HOME/.gradle}/init.d" \
    && printf '%s\n' \
      '<settings>' \
      '  <mirrors>' \
      '    <mirror>' \
      '      <id>sacty-mirror</id>' \
      '      <mirrorOf>*</mirrorOf>' \
      "      <url>$MAVEN_MIRROR</url>" \
      '    </mirror>' \
      '  </mirrors>' \
      '</settings>' > "$HOME/.m2/settings.xml" \
    && printf '%s\n' \
      "def sactyMirror = '$MAVEN_MIRROR'" \
      'def sactyUseMirror = { repos -> repos.withType(MavenArtifactRepository).configureEach { it.url = sactyMirror } }' \
      'beforeSettings { settings ->' \
      '  sactyUseMirror(settings.pluginManagement.repositories)' \
      '  try { sactyUseMirror(settings.dependencyResolutionManagement.repositories) } catch (ignored) {}' \
      '}' \
      'allprojects {' \
      '  sactyUseMirror(buildscript.repositories)' \
      '  sactyUseMirror(repositories)' \
      '}' > "${GRADLE_USER_HOME:-$HOME/.gradle}/init.d/sacty-mirror.gradle"; \
  fi
