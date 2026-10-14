# エージェントの実行

工程・オーケストレーター・ゴールガーディアン・質問への答え・書き出しは、どれも AI のエージェント（Claude Code か Codex）を
docker のコンテナの中で1回実行して行う。テストの実行も、同じイメージのコンテナで行う。

関係する ADR: なし

## コンテナ

- `docker run --rm --name sacty-run-<実行 ID> --security-opt no-new-privileges --cap-drop ALL -v <作業領域>:/workspace -w /workspace`
  で起動する。必要なら次を足す。
  - `--network <ネットワーク>`：docker compose のサービスを起動した実行（[サービス](services.md)）。
  - `--add-host host.docker.internal:<ホストのアドレス>`：ゲートウェイを使う実行。アドレスは `gateway.host_address`（既定 `host-gateway`）。
  - 追加のマウント（sacty が用意する場所だけ。設定の場所・レビューの差分 `/sacty-review` の読み取り専用など）。
- 動かすユーザーは、イメージの `USER node`（`--user` は付けない）。
- 環境変数は、引数には名前だけ（`-e NAME`）を書き、値は docker コマンドのプロセスの環境から渡す（`ps` に値を出さない）。
  docker コマンドのプロセスに残すホストの環境変数は `PATH`・`HOME`・`DOCKER_HOST`・`DOCKER_CONTEXT`・`DOCKER_CONFIG`・`TMPDIR` だけで、
  コンテナには、sacty が決めた変数（認証・設定の場所・イメージの `env` など）だけが入る。同じ名前は、実行の側がイメージの `env` より優先。
- 実行全体の上限は30分（`AGENT_RUN_TIMEOUT_MS`）。過ぎたらコンテナを止め、時間切れ（`run.timeout`）にする。
- 止めるときは `docker kill` し、`docker ps -aq --filter name=^/<名前>$` が空になるまで、1秒おきに最大11回確かめる。止まったことを
  確かめられなければ、結果を `run.containerNotConfirmed` にし、認証ファイルの書き戻しとセッションのファイルの保存をしない。
- 標準エラー出力に `Unable to find image`・`No such image`・`pull access denied` があれば、イメージが無い（`run.imageMissing`）とする。
- 標準エラー出力は先頭 64KB と末尾 256KB だけを持つ。

コード: `apps/daemon/src/agents/docker.ts`（`dockerRunArgs`・`dockerClientEnv`・`DockerExecutor`・`RunningContainers`）、`apps/daemon/src/context.ts`（`AGENT_RUN_TIMEOUT_MS`）

## 実行のコマンド

| runtime | コマンド | 設定の場所 |
| --- | --- | --- |
| `claude-code` | `claude -p <指示> --output-format stream-json --verbose`（再開は `--resume <ID>`、複製は `--fork-session`。MCP があれば `--mcp-config …/mcp.json --strict-mcp-config --allowedTools mcp__<名前>,…`。`--model`（Bedrock では環境変数 `ANTHROPIC_MODEL`）・`--effort`） | `CLAUDE_CONFIG_DIR=/tmp/sacty-claude-config`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| `codex` | `codex exec --json --skip-git-repo-check --sandbox danger-full-access`（接続先は `-c model_provider=…` などで指定。`--model`・`-c model_reasoning_effort=…`。再開は `resume <ID>`。最後に指示） | `CODEX_HOME=/.codex` |
| `stub` | `sh -c 'printf "%s" "$SACTY_STUB_RESULT"'`（設定の `stub` の出力を返す。AI は呼ばない） | なし |

- 設定の場所には、実行ごとの一時ディレクトリを読み書きでマウントし、合成したコンテキスト（[コンテキストの合成](context.md)）・
  保存したセッション・認証ファイルを写してから起動する。
- コマンドは、コンテナの中で Node.js の小さなスクリプトで包む。外側が出力の中継（コマンドの出力を一時ファイルに書かせて読みながら流し、
  流した分を 8MB ごとに捨てる。終了コードは変えない）、内側が localhost の転送（compose のサービスを起動した実行だけ）。

コード: `apps/daemon/src/agents/invocation.ts`（`buildInvocation`・`CONTAINER_CLAUDE_CONFIG_DIR`・`CONTAINER_CODEX_HOME`）、`apps/daemon/src/agents/output-relay.ts`（`withOutputRelay`・`RELAY_DISCARD_BYTES`）、`apps/daemon/src/agents/forward.ts`（`withLocalForwards`）

## 認証

コンテナには、選んだ認証方式の変数だけを入れる（ホストの `ANTHROPIC_API_KEY` などは引き継がない）。秘密情報はホストで取り出す
（[秘密情報](secrets.md)）。

| runtime × `auth.mode` | コンテナに渡すもの |
| --- | --- |
| claude-code × `subscription` | `CLAUDE_CODE_OAUTH_TOKEN` |
| claude-code × `api-key` | `ANTHROPIC_API_KEY` |
| claude-code × `bedrock` | `CLAUDE_CODE_USE_BEDROCK=1`・`AWS_BEARER_TOKEN_BEDROCK`・`AWS_REGION` |
| codex × `subscription` | ホストの `auth_file`（既定 `~/.codex/auth.json`）を設定の場所に `auth.json` として写す。実行の後に変わっていれば、ホストに書き戻す（実行中にホストのファイルが変わっていたら書き戻さない） |
| codex × `api-key` | `CODEX_API_KEY`・`OPENAI_API_KEY`（同じ値） |
| codex × `bedrock` | `AWS_BEARER_TOKEN_BEDROCK`・`AWS_REGION`。`via_gateway: true` なら、API キーの代わりに実行ごとのゲートウェイのトークン |
| codex × `provider` | `SACTY_PROVIDER_API_KEY`（接続先に `secret` があるとき。`via_gateway: true` なら実行ごとのトークン）。接続先は `-c model_providers.sacty-provider={ … wire_api = "responses" }` |

- ゲートウェイ経由（`via_gateway`）の判定は、エージェントの `via_gateway` かつ `bedrock`、または `provider` で接続先の `via_gateway`。
  そのときは API キーをゲートウェイに渡し、コンテナには実行ごとのトークンとゲートウェイの URL（`http://host.docker.internal:<ポート>/openai/v1`）
  だけを渡す（[ゲートウェイ](gateway.md)）。
- 秘密情報が見つからないときは、実行の失敗（理由 `auth`）にして、タスクを一時停止する。
- サブスクリプションとスタブの実行の費用は推定（`estimated`）として記録する。

コード: `apps/daemon/src/agents/invocation.ts`（`buildInvocation`）、`apps/daemon/src/agents/docker.ts`（`syncBackIfChanged`）、`apps/daemon/src/service.ts`（`executeLogged`・`bedrockOrigin`）

## 出力の扱い

- Claude Code の出力（stream-json）は、最後の `type: "result"` を答えにし、`usage` の `input_tokens`・`cache_read_input_tokens`・
  `cache_creation_input_tokens`・`output_tokens` をトークン数にする。`is_error` か終了コードが 0 でなければ失敗。
- Codex の出力（JSONL）は、`turn.completed` の `usage` を足し合わせ（`cached_input_tokens` は `input` から引いてキャッシュの読み出しにする）、
  最後の `agent_message` を答えにする。`turn.failed`・`error` があるか、終了コードが 0 でなければ失敗。
- 1行の上限は 16M 文字（超えた行は読み飛ばす）。
- 失敗の理由は文から分ける（`classifyFailure`）：利用上限（`usage limit`・`rate limit`・`429`・`quota` など）は `usage_limit`、認証
  （`401`・`403`・`unauthorized`・`expired`・`not logged in` など）は `auth`、それ以外は `error`。`usage_limit`・`auth` で止まったタスクは、
  再開すると止まった工程を実行し直す。
- エージェントが返す決まった答えは、見出しの付いた JSON（`sacty-steps`・`sacty-verdict`・`sacty-final-review`・`sacty-split`・
  `sacty-export` など）で、出力の中の JSON のオブジェクトを後ろから順に試し、読めた最初のものを使う。
- 実行の結果の文と出力からは、その実行で使った秘密情報（取り出した値・ゲートウェイのトークン・認証ファイルの中の値など）を
  `[REDACTED]` に置き換えてから記録する。

コード: `apps/daemon/src/agents/parse.ts`（`ClaudeOutcomeReader`・`CodexOutcomeReader`・`classifyFailure`・`MAX_LINE`）、`apps/daemon/src/agent-json.ts`（`jsonCandidates`・`lastJsonAnswer`）、`apps/daemon/src/agents/redact.ts`（`redact`・`redactText`）

## セッションの保存と使い回し

- 実行のたびに、設定の場所のセッションのファイル（Claude Code は `projects/` の下と `history.jsonl`、Codex は `sessions/`・
  `archived_sessions/` の下と `history.jsonl`）を、秘密情報を伏せて `SACTY_HOME/runs/<タスク ID>/<実行 ID>/agent/` に写す。認証・設定の
  ファイル（`.credentials.json`・`auth.json`・`.claude.json`・`config.toml` など）、シンボリックリンク、通常のファイルでないものは写さない。
  合計の上限は 200MB（超えたら大きいファイルの間を省く）。写したファイルの大きさと SHA-256 は `AgentSessionArchived` に記録する。
- オーケストレーターは、タスクごとに1つのセッションを使い回す。`SACTY_HOME/sessions/<タスク ID>/orchestrator/` に `session.json`
  （AI の ID・runtime・セッション ID・実行 ID・ファイルの一覧）と `generations/<実行 ID>/files/` を置き、いまのものと1つ前だけを残す。
  - 次の実行は、保存が無い（`first`）・壊れている（`files_broken`）・AI が変わった（`agent_changed`）・省いたファイルがある（`truncated`）
    ときは新しいセッションで、それ以外は保存したセッションを再開する。
  - オーケストレーターの実行は、タスクごとに1つずつ（直列）にする。
  - 「オーケストレーターに質問」は、保存したセッションを複製して（Claude Code は `--fork-session`、Codex は使い捨ての場所で再開）答え、
    保存はしない。中止したタスクも保存しない。
  - 使ったセッションは `OrchestratorSessionUsed`（`resumed`・`forked`・`new`）に記録する。
- 再開を断られた（AI が何も使わずに失敗し、セッションが見つからない旨の文を返した）ときは、新しい実行 ID で新しいセッションでやり直し、
  2回分の費用を合わせて記録する（`resumeRejected`）。

コード: `apps/daemon/src/agent-sessions.ts`（`SOURCES`・`selectAgentSessionFiles`・`AGENT_FILES_LIMIT`）、`apps/daemon/src/orchestrator-sessions.ts`（`OrchestratorSessionStore`・`plan`・`save`）、`apps/daemon/src/service.ts`（`resumeRejected`・`RESUME_REJECTED`・`executeWithSession`）

## イメージ

- 既定のイメージは `image`（既定 `sacty-agent:0.1.0`）。言語ごとのイメージは `images.<名前>`（タグの既定は `sacty-agent-<名前>:0.1.0`）。
  使うイメージは、名前が無いか `default` なら既定、`images` にあればそれ、無い名前なら止める（`image.unknown`）。
- `sacty image build [<名前>...]` は `packages/cli/docker/Dockerfile` を `docker build` する。名前を省くと既定と `images` のすべてを作る。
  設定ファイルが無ければ既定で作り、ほかの誤りがあれば作らない。
  - 元のイメージ（`BASE_IMAGE`）の既定は `node:22-bookworm-slim`。Claude Code（`@anthropic-ai/claude-code@2.1.296`）と Codex
    （`@openai/codex@0.160.0`）を `npm install -g` で入れる。最後に `USER node`・`WORKDIR /workspace`。
  - 言語ごとのイメージは、元のイメージに Node.js 18 以上と npm があればそれを使い、無ければ `node_image`（無ければ
    `image_build.base_image`、それも無ければ `node:22-bookworm-slim`）から写す。`node` ユーザーが無ければ作り、`HOME=/home/node`・
    `GOPATH=/home/node/go` にする。`maven_mirror` があれば Maven の `settings.xml` と Gradle の init スクリプトを書く。
  - `packages` は元のイメージにある dnf・microdnf・yum・apt-get で root で入れ、`enable_repos` はその `--enablerepo` にする（apt-get では失敗）。
    `run` は root で上から実行する（bash があれば `-o pipefail`）。
  - npm のトークン（`image_build.npm_token`）は、ビルドのときだけ BuildKit の secret（`npmrc`）で読ませ、イメージには残さない。
    イメージに残す npm の設定（`registry` と `npm_config`）は別の secret で渡す。
  - secret の中身は BuildKit のキャッシュの判定に入らないので、中身のハッシュ（`NPM_CONFIG_HASH`・`SACTY_SETUP_HASH`）を build-arg で渡し、
    変えたときに作り直されるようにする。
- イメージの `env` は、エージェントとテストの両方のコンテナに渡す。

コード: `apps/daemon/src/config.ts`（`resolveImage`・`languageImageTag`・`DEFAULT_IMAGE`）、`apps/daemon/src/image.ts`（`buildImage`・`imageBuildArgs`・`imageBuildSettings`・`imageBuildTargets`）、`packages/cli/docker/Dockerfile`

## テストの実行

- エージェントと同じ `docker run` の形（秘密情報・認証ファイル・ゲートウェイは渡さない）で、`sh -c <テストのコマンド>` を実行する。
  イメージの `env` は渡す。
- 上限は20分。過ぎたら止め、基盤の失敗（`infrastructure`）にする。
- 出力は標準出力と標準エラー出力を合わせた末尾の 20,000 文字（`TEST_OUTPUT_TAIL`）だけを残す。合否は終了コードで決める
  （docker の失敗の `125` は基盤の失敗）。

コード: `apps/daemon/src/agents/test-runner.ts`（`DockerTestRunner`・`TEST_OUTPUT_TAIL`・`DOCKER_RUN_FAILED`）
