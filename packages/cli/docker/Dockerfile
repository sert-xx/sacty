# sacty のエージェント実行用イメージ。タスクごとにこのイメージからコンテナを作る。
FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# エージェントのCLI。版を固定し、上げるときはこのファイルを変える。
RUN npm install -g @anthropic-ai/claude-code@2.1.296 @openai/codex@0.160.0 \
  && npm cache clean --force

# root では動かさない（node イメージの node ユーザー）
USER node
WORKDIR /workspace
