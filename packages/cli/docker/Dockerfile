# sacty のエージェント実行用イメージ。タスクごとにこのイメージからコンテナを作る。
# 元のイメージは、config.yaml の image_build.base_image で変えられる（プライベートのレジストリなど。PBI-33）。
# 元のイメージは Node.js 18 以上で、node ユーザーがあること（公式の node のイメージを写したものなど）。
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}
# イメージに入れる npm の版（config.yaml の image_build.npm_version。空なら元のイメージの npm。PBI-40）
ARG NPM_VERSION=

USER root

# git が無ければ入れる（元のイメージに入っていれば、Debian のミラーに届かない環境でも作れる）
RUN if ! command -v git >/dev/null 2>&1; then \
    apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*; \
  fi

# エージェントのCLI。版を固定し、上げるときはこのファイルを変える。
# npm のレジストリと認証は、sacty が作った .npmrc をビルドのときだけ読ませる（イメージには残らない。PBI-33）
RUN --mount=type=secret,id=npmrc,target=/run/secrets/npmrc \
  NPM_CONFIG_USERCONFIG=/run/secrets/npmrc \
  npm install -g @anthropic-ai/claude-code@2.1.296 @openai/codex@0.160.0 \
    ${NPM_VERSION:+npm@${NPM_VERSION}} \
  && npm cache clean --force

# コンテナの中の npm 全体の設定（config.yaml の image_build.npm_config。認証の項目は含まない。PBI-40）。
# CLI を入れた後に置く（CLI の取得には効かせない）。ファイルの受け渡しは、認証の .npmrc と同じ secret の仕組みを
# 使う（--build-context は、Docker の構成によっては使えないため）。中身はこの RUN でイメージの設定に書き込む
RUN --mount=type=secret,id=npmconfig,target=/run/secrets/npmconfig \
  g="$(npm config get globalconfig)" && mkdir -p "$(dirname "$g")" \
  && cat /run/secrets/npmconfig >> "$g"

# root では動かさない（node イメージの node ユーザー）
USER node
WORKDIR /workspace
