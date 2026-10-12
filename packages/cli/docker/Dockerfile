# sacty のエージェント実行用イメージ。タスクごとにこのイメージからコンテナを作る。
# 元のイメージは、config.yaml の image_build.base_image で変えられる（プライベートのレジストリなど。PBI-33）。
# 元のイメージは Node.js 22 で、node ユーザーがあること（公式の node のイメージを写したものなど）。
ARG BASE_IMAGE=node:22-bookworm-slim
FROM ${BASE_IMAGE}

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
  && npm cache clean --force

# root では動かさない（node イメージの node ユーザー）
USER node
WORKDIR /workspace
