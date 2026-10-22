**日本語** | [English](agent-execution.en.md)

# エージェントの実行

工程・オーケストレーター・ゴールガーディアン・質問への答え・書き出しは、どれも AI のエージェント（Claude Code か Codex）を
docker のコンテナの中で1回実行して行う。テストは、sacty が別のコンテナで実行せず、ゴールガーディアン（最終レビュー）と再現の工程のエージェントが、
それぞれのコンテナの中で実行する。

関係する ADR: [ゴールガーディアンが最終レビューの中でテストを実行し、sacty はテストのコンテナを使わない](../adr/20261021-1431-guardian-runs-tests.md)

## コンテナ

- `docker run --rm --name sacty-run-<実行 ID> --security-opt no-new-privileges --cap-drop ALL -v <作業領域>:/workspace -w /workspace`
  で起動する。必要なら次を足す。
  - `--network <ネットワーク>`：docker compose のサービスを起動した実行（[サービス](services.md)）。
  - `--add-host host.docker.internal:<ホストのアドレス>`：ゲートウェイを使う実行。アドレスは `gateway.host_address`（既定 `host-gateway`）。
  - 追加のマウント（sacty が用意する場所だけ。設定の場所・レビューの差分 `/sacty-review` の読み取り専用・質問への答えの各実行のセッションログ
    `/sacty-logs` の読み取り専用・メモリー `/sacty-memory/project`・`/sacty-memory/repository` の読み取り専用（[メモリー](memory.md)）など）。
- 動かすユーザーは、イメージの `USER node`（`--user` は付けない）。
- 環境変数は、引数には名前だけ（`-e NAME`）を書き、値は docker コマンドのプロセスの環境から渡す（`ps` に値を出さない）。
  docker コマンドのプロセスに残すホストの環境変数は `PATH`・`HOME`・`DOCKER_HOST`・`DOCKER_CONTEXT`・`DOCKER_CONFIG`・`TMPDIR` だけで、
  コンテナには、sacty が決めた変数（認証・設定の場所・イメージの `env` など）だけが入る。同じ名前は、実行の側がイメージの `env` より優先。
- 実行全体の上限は、`config.yaml` の `run_timeout`（PBI-150）で決める。役割（工程・`guardian`・`orchestrator` など）の `roles` の上書きがあればそれ、
  無ければ `agent_minutes`（既定 30 分。`AGENT_RUN_TIMEOUT_MS`）。テストを実行する役割（`final-review`・`reproduce`）は、上書きが無ければ
  `agent_minutes` に `test_minutes`（既定 20 分）を足した分。設定を読めなければ、ふつうの役割は 30 分、最終レビュー・再現は 50 分（30 分に 20 分を足す）。実行ごとに読むので、次の実行から効く。
  過ぎたらコンテナを止め、時間切れ（`run.timeout`。その実行の上限の分を添える）にする。
- 止めるときは `docker kill` し、`docker ps -aq --filter name=^/<名前>$` が空になるまで、1秒おきに最大11回確かめる。止まったことを
  確かめられなければ、結果を `run.containerNotConfirmed` にし、認証ファイルの書き戻しとセッションのファイルの保存をしない。
- 標準エラー出力に `Unable to find image`・`No such image`・`pull access denied` があれば、イメージが無い（`run.imageMissing`）とする。
- 標準エラー出力は先頭 64KB と末尾 256KB だけを持つ。

コード: `apps/daemon/src/agents/docker.ts`（`dockerRunArgs`・`dockerClientEnv`・`DockerExecutor`・`RunningContainers`）、`apps/daemon/src/context.ts`（`AGENT_RUN_TIMEOUT_MS`）、`apps/daemon/src/run-timeouts.ts`（`agentTimeoutMs`・`RUN_TIMEOUT_ROLES`）、`apps/daemon/src/service.ts`（`executeLogged`）

## 実行のコマンド

| runtime | コマンド | 設定の場所 |
| --- | --- | --- |
| `claude-code` | `claude -p --output-format stream-json --verbose`（指示は標準入力。作業領域の外で読ませる場所があれば `--add-dir <場所>`。質問への答えの `/sacty-logs` だけ。再開は `--resume <ID>`、複製は `--fork-session`。MCP があれば `--mcp-config …/mcp.json --strict-mcp-config --allowedTools mcp__<名前>,…`。`--model`（Bedrock では環境変数 `ANTHROPIC_MODEL`）・`--effort`） | `CLAUDE_CONFIG_DIR=/tmp/sacty-claude-config`、`CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| `codex` | `codex exec --json --skip-git-repo-check --sandbox danger-full-access`（接続先は `-c model_provider=…` などで指定。`--model`・`-c model_reasoning_effort=…`。再開は `resume <ID>`。最後に `--` と `-`（指示は標準入力）） | `CODEX_HOME=/.codex` |
| `stub` | `sh -c 'printf "%s" "$SACTY_STUB_RESULT"'`（設定の `stub` の出力を返す。AI は呼ばない） | なし |

- エージェントへの指示（プロンプト）は、コマンドの引数に入れず、`docker run -i` でコンテナの標準入力に書いて閉じる（PBI-149）。引数に入れると、
  Linux の1つの引数の上限（128 KiB）を超えた大きな指示（差分を含むゴールガーディアンなど）で `argument list too long` になるため。指示の中身は変えない。
  出力の中継と localhost の転送は、標準入力をそのままコマンドに渡す。指示の無い実行（`stub`）は `-i` を付けず、標準入力をすぐ閉じる。
- 設定の場所には、実行ごとの一時ディレクトリを読み書きでマウントし、合成したコンテキスト（[コンテキストの合成](context.md)）・
  保存したセッション・認証ファイルを写してから起動する。
- コマンドは、コンテナの中で Node.js の小さなスクリプトで包む。外側が出力の中継（コマンドの出力を一時ファイルに書かせて読みながら流し、
  流した分を 8MB ごとに捨てる。終了コードは変えない）、内側が localhost の転送（compose のサービスを起動した実行だけ）。

コード: `apps/daemon/src/agents/invocation.ts`（`buildInvocation`・`Invocation`・`CONTAINER_CLAUDE_CONFIG_DIR`・`CONTAINER_CODEX_HOME`）、`apps/daemon/src/agents/docker.ts`（`dockerRunArgs`・`DockerExecutor`）、`apps/daemon/src/agents/output-relay.ts`（`withOutputRelay`・`RELAY_DISCARD_BYTES`）、`apps/daemon/src/agents/forward.ts`（`withLocalForwards`）

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
| codex × `bedrock` | `AWS_BEARER_TOKEN_BEDROCK`・`AWS_REGION`。`providers.codex` が `via_gateway: true` なら、API キーの代わりに実行ごとのゲートウェイのトークン |
| codex × `openai-compatible`（実行のときの `auth.mode` は `provider`） | `SACTY_PROVIDER_API_KEY`（`auth.secret` があるとき。`via_gateway: true` なら実行ごとのトークン）。接続先は `-c model_providers.sacty-provider={ … wire_api = "responses" }` |

- ゲートウェイ経由（`via_gateway`）の判定は、`providers.codex` の `via_gateway` が `true` で、`auth.mode` が `bedrock` か `openai-compatible` のとき
  （認証・接続先は、エージェントの runtime の `providers` から作る。`connectionOf`。[設定](configuration.md#接続先providers)）。
  そのときは API キーをゲートウェイに渡し、コンテナには実行ごとのトークンとゲートウェイの URL（`http://host.docker.internal:<ポート>/openai/v1`）
  だけを渡す（[ゲートウェイ](gateway.md)）。
- 秘密情報が見つからないときは、実行の失敗（理由 `auth`）にして、タスクを一時停止する。
- サブスクリプションとスタブの実行の費用は推定（`estimated`）として記録する。段階のサブエージェントの定義を置いた実行（`estimateCost`）も推定にする
  （担当が親と違うモデルで動きうるが、費用は親の結果の使用量 × 親の単価でしか出せない。[コンテキストの合成](context.md#実行のときに置くファイル)）。

コード: `apps/daemon/src/agents/invocation.ts`（`buildInvocation`）、`apps/daemon/src/agents/docker.ts`（`syncBackIfChanged`）、`apps/daemon/src/service.ts`（`executeLogged`・`bedrockOrigin`）

## 出力の扱い

- Claude Code の出力（stream-json）は、最後の `type: "result"` を答えにし、`usage` の `input_tokens`・`cache_read_input_tokens`・
  `cache_creation_input_tokens`・`output_tokens` をトークン数にする。`is_error` か終了コードが 0 でなければ失敗。
- Codex の出力（JSONL）は、`turn.completed` の `usage` を足し合わせ（`cached_input_tokens` は `input` から引いてキャッシュの読み出しにする）、
  最後の `agent_message` を答えにする。`turn.failed`・`error` があるか、終了コードが 0 でなければ失敗。
- 1行の上限は 16M 文字（超えた行は読み飛ばす）。
- 失敗の理由は文から分ける（`classifyFailure`）：利用上限（`usage limit`・`rate limit`・`429`・`quota` など）は `usage_limit`、認証
  （`401`・`403`・`unauthorized`・`expired`・`not logged in` など）は `auth`、それ以外は `error`。`usage_limit`・`auth` で止まったタスクは、
  再開すると止まった工程を実行し直す（代わりのエージェントがあれば、理由を問わず止めない。下の「失敗したときの代わりのエージェント」）。
- エージェントが返す決まった答えは、見出しの付いた JSON（`sacty-steps`・`sacty-verdict`・`sacty-final-review`・`sacty-split`・
  `sacty-export` など）で、出力の中の JSON のオブジェクトを後ろから順に試し、読めた最初のものを使う。
- 実行の結果の文と出力からは、その実行で使った秘密情報（取り出した値・ゲートウェイのトークン・認証ファイルの中の値など）を
  `[REDACTED]` に置き換えてから記録する。

コード: `apps/daemon/src/agents/parse.ts`（`ClaudeOutcomeReader`・`CodexOutcomeReader`・`classifyFailure`・`MAX_LINE`）、`apps/daemon/src/agent-json.ts`（`jsonCandidates`・`lastJsonAnswer`）、`apps/daemon/src/agents/redact.ts`（`redact`・`redactText`）

## 失敗したときの代わりのエージェント

- 実行が `usage_limit` で失敗したら、そのエージェントを `agent_fallback.cooldown_minutes`（既定 60 分）の間、すべてのタスクで利用制限中と
  して覚える（`markLimited`）。
- 実行がそれ以外の理由（`auth`・`error`）で失敗し、`fallBack` に渡ったら、そのエージェントを同じ時間、
  そのタスクでだけ使わないものとして覚える（ほかのタスクは、元のエージェントで実行する）。どちらもデーモンのメモリーだけに持つ（起動し直すと、
  元のエージェントから試す）。
- 失敗かどうかは、終了コードとエージェントの出力（Claude Code の `result` の `is_error`・Codex の `turn.failed`・`error`）で決め、標準エラー
  出力の文では決めない（標準エラー出力は、失敗の文と理由の分類に使うだけ）。そのため、理由の分類を誤っても、代わりに切り替えるかどうかは
  変わらない（変わるのは、使わないのが全タスクか、そのタスクだけか）。
- エージェントを選ぶとき（工程・統合レビュー・オーケストレーター・チケットの読み取り・質問への答え・ゴールガーディアン・最終レビュー・
  差し戻しの判定・書き出し・マージの後の監視・監査）、選んだエージェントが利用制限中か、そのタスクで使わないものなら、その `fallback` を上から
  順に（その `fallback` もたどって）見て、使える最初のものを使う（`fallbackAgentFor`）。すべて使えなければ、選んだエージェントのまま。
- 工程・統合レビュー・オーケストレーターの工程の選択・チケットの読み取り・最終レビューの実行が失敗し（理由は問わない）、使える代わりがあれば、
  一時停止（`TaskPaused`）の代わりに `AgentFellBack`（失敗した実行・役割・元と代わりのエージェント・失敗の理由・期限）を記録する。失敗の記録が
  実行待ちに戻しているので、次の処理で代わりのエージェントがやり直す。実行が正常に終わった後に答えを読み取れなかったときに切り替えるのは、
  工程の選択とチケットの読み取りだけ（最終レビュー・ゴールガーディアンの判定の答えが読めないときは、これまでどおり扱う）。
- 切り替えの間に試したエージェントは、タスクと、やり直している処理の役割（工程の名前・`orchestrator`・`final-review` など。`fallBack` に
  渡す役割）ごとに、期限とは別に覚え（`fallbackTried`）、期限が過ぎても試し終えたものには戻らない。すべて試し終えたら止める。切り替えた後の
  実行が `fallBack` に戻らずに終わった（実行が成功し、答えも読み取れた）なら、その役割の次の実行を選ぶとき（`usableAgent`）に忘れる。
  人が再開したときも忘れる。ほかの役割（質問への答えなど）の成功では忘れない。ゴールガーディアンの判定は、1回の判定が終わったら忘れる。
- コンテナが止まったことを確かめられなかった実行（`run.containerNotConfirmed`）は、代わりに切り替えずに止める（元のコンテナが動いたままかも
  しれず、同じ作業領域で代わりが始めると、変更や外への操作が重なりうるため）。
- 変更の申し出と差し戻しの指摘の判定は、その場で代わりのエージェントで判定し直し、`AgentFellBack` を記録して、失敗した実行の費用を
  判定の費用に足す（`runGuardianWithFallback`）。1回の判定の中では、試したエージェントは期限が過ぎていても試さず、試し終えたら最後の
  失敗を返す（やり直しは代わりの数まで）。
- 人が止めた・中止した、代わりが無い・すべて使えない（試し終えたものを含む）なら、これまでどおり止める。書き出し・マージの後の監視・監査・質問への答えは、
  失敗をこれまでどおり扱い、次の実行から代わりのエージェントを使う（利用制限のときだけ）。
- 代わりのエージェントの秘密情報も、起動のときにまとめて取り出す（`secretUses`）。

コード: `apps/daemon/src/service.ts`（`usableAgent`・`agentUnusable`・`markLimited`・`notConfirmed`・`fallBack`・`pauseOrFallBack`・`runGuardianWithFallback`）、`apps/daemon/src/config.ts`（`fallbackAgentFor`）、`apps/daemon/src/secret-uses.ts`（`secretUses`）

## セッションの保存と使い回し

- 実行のたびに、設定の場所のセッションのファイル（Claude Code は `projects/` の下と `history.jsonl`、Codex は `sessions/`・
  `archived_sessions/` の下と `history.jsonl`）を、秘密情報を伏せて `SACTY_HOME/runs/<タスク ID>/<実行 ID>/agent/` に写す。認証・設定の
  ファイル（`.credentials.json`・`auth.json`・`.claude.json`・`config.toml` など）、シンボリックリンク、通常のファイルでないものは写さない。
  合計の上限は 200MB（超えたら大きいファイルの間を省く）。写したファイルの大きさと SHA-256 は `AgentSessionArchived` に記録する。
- オーケストレーターは、タスクごとに1つのセッションを使い回す。`SACTY_HOME/sessions/<タスク ID>/orchestrator/` に `session.json`
  （AI の ID・runtime・セッション ID・実行 ID・ファイルの一覧）と `generations/<実行 ID>/files/` を置き、いまのものと1つ前だけを残す。
  - 次の実行は、保存が無い（`first`）・壊れている（`files_broken`）・AI が変わった（`agent_changed`）・省いたファイルがある（`truncated`）
    ときは新しいセッションで、それ以外は保存したセッションを再開する。
  - AI が変わった（`agent_changed`）ときは、保存してある前のエージェントのセッションの本体のファイルが記録どおりなら、そのやり取りを引き継ぐ。
    指示とエージェントの発言の文だけ（ツールの呼び出し・結果は入れない。1つの発言は 8000 文字、全体は 20 万文字までで、超えたら古い発言から
    省く。ファイルは末尾の 8MiB だけを読む（`HANDOFF_READ_LIMIT`）。発言はサロゲートペアの途中では切らない）を `previous-session.md` に書き、`/sacty-handoff` に読み取り専用でマウントし、指示の末尾にその場所を足す。引き継いだことは
    `OrchestratorSessionUsed` の `handoffFrom` に記録し、書いたファイルは実行の後に消す。
  - オーケストレーターの実行は、タスクごとに1つずつ（直列）にする。
  - 「オーケストレーターに質問」は、保存したセッションを複製して（Claude Code は `--fork-session`、Codex は使い捨ての場所で再開）答え、
    保存はしない。中止したタスクも保存しない。
  - 使ったセッションは `OrchestratorSessionUsed`（`resumed`・`forked`・`new`）に記録する。
- 再開を断られた（AI が何も使わずに失敗し、セッションが見つからない旨の文を返した）ときは、新しい実行 ID で新しいセッションでやり直し、
  2回分の費用を合わせて記録する（`resumeRejected`）。

コード: `apps/daemon/src/agent-sessions.ts`（`SOURCES`・`selectAgentSessionFiles`・`AGENT_FILES_LIMIT`）、`apps/daemon/src/orchestrator-sessions.ts`（`OrchestratorSessionStore`・`plan`・`save`）、`apps/daemon/src/orchestrator-handoff.ts`（`sessionTranscript`・`stageHandoff`）、`apps/daemon/src/service.ts`（`resumeRejected`・`RESUME_REJECTED`・`executeWithSession`）

## イメージ

- 既定のイメージは `image`（既定 `sacty-agent:1.8.0`）。言語ごとのイメージは `images.<名前>`（タグの既定は `sacty-agent-<名前>:1.8.0`）。
  使うイメージは、名前が無いか `default` なら既定、`images` にあればそれ、無い名前なら止める（`image.unknown`）。
  工程のイメージは人がタスクの詳細で変えられ、その工程を次に実行するときから使う（[工程とタスク](tasks-and-steps.md)の「工程のイメージを人が変える」）。
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
  - `gh` の代わりに `packages/cli/docker/gh-shim.cjs` を `/opt/sacty/bin/gh` に置き、`PATH` の先頭にする（元のイメージの `gh` より先に
    使われる）。`gh api` だけを受け、REST の `GET`・`HEAD` と GraphQL を `$SACTY_GITHUB_URL/<ホスト>/…` に送る（ホストは `--hostname`、
    無ければ `GH_HOST`）。フィールド（`-f`・`-F`）は、REST ではクエリ、GraphQL では `query` と変数にする。`--paginate`（REST は `link` を
    たどって配列をまとめる。GraphQL は `$endCursor` と `pageInfo`）・`--jq`（`jq` があるとき）・`-i`・`-H`・`--input` を受ける。
    書き込みのメソッドと、ほかのコマンドは、使い方を示して終了コード 1 で終わる（[ゲートウェイ](gateway.md#github-の読み取りの中継)）。
  - 作業用の CLI（`packages/cli/docker/install-tools.sh`）：`jq`・`rg`・`fd`・`tree`・`file`・`less`・`curl`・`zip`・`unzip`・`xz`・`bzip2`・
    `patch`・`diff`・`find`・`make`・`ps`・`sqlite3`・`python3`・`shellcheck` のうち、元のイメージに無いコマンドだけを、元のイメージにある
    apt-get・dnf・microdnf・yum で入れる（RHEL 系のパッケージ名は `xz`・`procps-ng`・`sqlite`・`ShellCheck` など）。まとめて入れられなければ
    1つずつ入れ、入れられなかったコマンドを警告して続ける（ミラーに届かない、RHEL 系で EPEL にしか無い `rg`・`fd`・`shellcheck` など）。
    Debian・Ubuntu 系の `fdfind` は `/usr/local/bin/fd` からも使える。
  - draw.io の CLI（`packages/cli/docker/install-drawio.sh`）：build-arg `SACTY_DRAWIO`（既定 `1`。`image_build.drawio` が `false` なら `0`）が `1` のとき、
    draw.io Desktop の公式のリリース（`jgraph/drawio-desktop` の `v32.4.1`）の deb（apt-get。`amd64`・`arm64`）か rpm（dnf・yum。`x86_64`・`aarch64`）を
    `curl`（接続 30 秒・60 秒のあいだ 1KB/s を下回れば打ち切り・1 回 900 秒・再試行は 3 回までで、最初から 1200 秒を過ぎたら始めない。全体は 1200 秒を超えることがある）で取り、版ごとに固定した SHA-256 で確かめてから、`Xvfb`（`xvfb`・`xorg-x11-server-Xvfb`）と `libasound2`（Ubuntu 24.04 からは `libasound2t64`）・
    `alsa-lib` と一緒に入れる。CJK のフォント（`fonts-noto-cjk`・`google-noto-sans-cjk-ttc-fonts`）は、入れられなければ警告して続ける。
    ハッシュが合わなければ止め、ほかの理由（取得できない・パッケージの管理のコマンドや `curl` が無い・アーキテクチャが違う・入れられない）では警告して続ける。
    入れたら `/opt/drawio/chrome-sandbox` の setuid を外し（`0755`）、`/tmp/.X11-unix` を `1777` で作り、`/opt/sacty/bin/drawio` を
    `packages/cli/docker/drawio-shim.cjs` へのリンクにする。
  - `drawio`（`drawio-shim.cjs`）は、`/opt/drawio/drawio` を `--no-sandbox --disable-gpu` と受けた引数で起動する。`DISPLAY` が無ければ `Xvfb -displayfd`
    で空いている番号の仮想の画面を起動し、終わったら止めて、終わるまで待つ（3 秒で終わらなければ `SIGKILL`）。標準エラー出力から `ERROR:dbus/`・`ERROR:bus.cc` の行を除き、
    終了コードはそのまま返す。標準エラー出力は UTF-8 として復号してから行に分ける。仮想の画面を起動できなければ、理由を示して終了コード 1 で終わる。
    SIGINT・SIGTERM を受けたら、draw.io の実行中は同じシグナルを draw.io に送り、まだ起動していなければ（Xvfb の起動を待っている間など）Xvfb を止めて
    終わるのを待ってから、128 にシグナルの番号を足した終了コードで終わる。
- イメージの `env` は、そのイメージで動くエージェントのコンテナ（テストを実行する最終レビューを含む）に渡す。

コード: `apps/daemon/src/config.ts`（`resolveImage`・`languageImageTag`・`DEFAULT_IMAGE`）、`apps/daemon/src/image.ts`（`buildImage`・`imageBuildArgs`・`imageBuildSettings`・`imageBuildTargets`）、`packages/cli/docker/Dockerfile`、`packages/cli/docker/install-tools.sh`、`packages/cli/docker/install-drawio.sh`、`packages/cli/docker/drawio-shim.cjs`

## テストの実行

- sacty は、テストのコマンドを自分のコンテナで実行しない。実装の検証のテストは、ゴールガーディアンが最終レビューの中で実行し、再現のテストは
  再現の工程のエージェントが実行して、どちらも結果（コマンド・終了コード・結果の抜粋）を申告する（[タスクと工程](tasks-and-steps.md#実装の検証)）。
- 最終レビューは、実装の工程のイメージ（無ければ再現の工程のイメージ）で、そのイメージの `env` を渡して、実装後の作業領域の使い捨ての写しで動かす（写しの .git は、退避したメタデータの写し）。
  サービスを使う実装なら、そのサービスにつなぐ（[サービス](services.md)）。
- テストのコードは、エージェントのコンテナの中で動くので、ほかのエージェントの実行と同じく、コンテナにあるエージェントの認証の値と、
  ゲートウェイを使う実行では実行ごとのゲートウェイのトークンに触れられる。
- 時間の上限は、テストを実行する役割の上限（上の「コンテナ」。役割の上書きが無ければ `agent_minutes` + `test_minutes`）。

コード: `apps/daemon/src/service.ts`（`verify`・`runGuardian`）、`apps/daemon/src/run-timeouts.ts`（`agentTimeoutMs`）
