[日本語](agent-execution.md) | **English**

# Agent execution

Steps, the Orchestrator, the Goal Guardian, answers to questions, and export are all carried out by running an AI agent (Claude Code or Codex)
once inside a docker container. sacty does not run tests in a separate container; the Goal Guardian (the final review) and the Reproduce step's agent
run them inside their own containers.

Related ADRs: [The Goal Guardian runs the tests in the final review, and sacty no longer uses a test container](../adr/20261021-1431-guardian-runs-tests.md)

## Container

- The container starts with `docker run --rm --name sacty-run-<run ID> --security-opt no-new-privileges --cap-drop ALL -v <workspace>:/workspace -w /workspace`.
  The following are added when needed.
  - `--network <network>`: runs that started docker compose services ([Services](services.en.md)).
  - `--add-host host.docker.internal:<host address>`: runs that use the gateway. The address is `gateway.host_address` (default `host-gateway`).
  - Extra mounts (only locations sacty prepares: the config location, the review diff `/sacty-review` read-only, the session logs of each run for answers to questions
    `/sacty-logs` read-only, memories `/sacty-memory/project` and `/sacty-memory/repository` read-only ([Memory](memory.en.md)), and so on).
- The user is the image's `USER node` (`--user` is not passed).
- For environment variables, the arguments contain only the name (`-e NAME`); the values are passed through the environment of the docker command's process (so they do not appear in `ps`).
  The only host environment variables kept in the docker command's process are `PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, and `TMPDIR`;
  the container receives only variables sacty decides (authentication, the config location, the image's `env`, and so on). For the same name, the run's value takes precedence over the image's `env`.
- The limit for the whole run is set by `run_timeout` in `config.yaml` (PBI-150): the role's override in `roles` (a step, `guardian`, `orchestrator`, and so on) if present,
  otherwise `agent_minutes` (default 30 minutes; `AGENT_RUN_TIMEOUT_MS`). For the roles that run tests (`final-review`, `reproduce`), without an override it is
  `agent_minutes` plus `test_minutes` (default 20 minutes). If the config cannot be read, 30 minutes. It is read for every run, so changes apply from the next run.
  When it passes, the container is stopped and the run times out (`run.timeout`, with that run's limit in minutes).
- To stop a container, sacty runs `docker kill` and checks up to 11 times, once per second, until `docker ps -aq --filter name=^/<name>$` is empty. If it cannot
  confirm the container stopped, the result is `run.containerNotConfirmed`, and the auth file is not written back and the session files are not saved.
- If standard error contains `Unable to find image`, `No such image`, or `pull access denied`, the image is treated as missing (`run.imageMissing`).
- Only the first 64KB and the last 256KB of standard error are kept.

Code: `apps/daemon/src/agents/docker.ts` (`dockerRunArgs`, `dockerClientEnv`, `DockerExecutor`, `RunningContainers`), `apps/daemon/src/context.ts` (`AGENT_RUN_TIMEOUT_MS`), `apps/daemon/src/run-timeouts.ts` (`agentTimeoutMs`, `RUN_TIMEOUT_ROLES`), `apps/daemon/src/service.ts` (`executeLogged`)

## Run commands

| runtime | Command | Config location |
| --- | --- | --- |
| `claude-code` | `claude -p --output-format stream-json --verbose` (the instructions go to stdin. `--add-dir <location>` if there is a location outside the workspace to read; only `/sacty-logs` for answers to questions. Resume is `--resume <ID>`, fork is `--fork-session`. With MCP, `--mcp-config …/mcp.json --strict-mcp-config --allowedTools mcp__<name>,…`. `--model` (on Bedrock, the environment variable `ANTHROPIC_MODEL`), `--effort`) | `CLAUDE_CONFIG_DIR=/tmp/sacty-claude-config`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| `codex` | `codex exec --json --skip-git-repo-check --sandbox danger-full-access` (the endpoint is specified with `-c model_provider=…` and the like. `--model`, `-c model_reasoning_effort=…`. Resume is `resume <ID>`. Last come `--` and `-` (the instructions go to stdin)) | `CODEX_HOME=/.codex` |
| `stub` | `sh -c 'printf "%s" "$SACTY_STUB_RESULT"'` (returns the output of the `stub` setting; no AI is called) | None |

- The instructions (prompt) for the agent are not put in the command arguments; they are written to the container's stdin with `docker run -i` and then closed (PBI-149). In an argument,
  a large prompt (such as the Goal Guardian's, which includes a diff) exceeds Linux's per-argument limit (128 KiB) and fails with `argument list too long`. The prompt itself is unchanged.
  The output relay and localhost forwarding pass stdin through to the command. Runs without instructions (`stub`) get no `-i`, and stdin is closed at once.
- A temporary directory per run is mounted read-write at the config location, and the composed context ([Context composition](context.en.md)),
  the saved session, and the auth files are copied into it before the run starts.
- The command is wrapped in small Node.js scripts inside the container. The outer one relays output (the command writes its output to a temporary file, which is read and streamed,
  and every 8MB streamed is discarded; the exit code is unchanged); the inner one forwards localhost (only for runs that started compose services).

Code: `apps/daemon/src/agents/invocation.ts` (`buildInvocation`, `Invocation`, `CONTAINER_CLAUDE_CONFIG_DIR`, `CONTAINER_CODEX_HOME`), `apps/daemon/src/agents/docker.ts` (`dockerRunArgs`, `DockerExecutor`), `apps/daemon/src/agents/output-relay.ts` (`withOutputRelay`, `RELAY_DISCARD_BYTES`), `apps/daemon/src/agents/forward.ts` (`withLocalForwards`)

## Authentication

The container receives only the variables for the chosen authentication method (the host's `ANTHROPIC_API_KEY` and the like are not inherited). Secrets are retrieved on the host
([Secrets](secrets.en.md)).

| runtime × `auth.mode` | What is passed to the container |
| --- | --- |
| claude-code × `subscription` | `CLAUDE_CODE_OAUTH_TOKEN` |
| claude-code × `api-key` | `ANTHROPIC_API_KEY` |
| claude-code × `bedrock` | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION` |
| codex × `subscription` | The host's `auth_file` (default `~/.codex/auth.json`) is copied to the config location as `auth.json`. If it changed after the run, it is written back to the host (not written back if the host's file changed during the run) |
| codex × `api-key` | `CODEX_API_KEY`, `OPENAI_API_KEY` (the same value) |
| codex × `bedrock` | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`. When `providers.codex` has `via_gateway: true`, a per-run gateway token instead of the API key |
| codex × `openai-compatible` (`auth.mode` at run time is `provider`) | `SACTY_PROVIDER_API_KEY` (when `auth.secret` is written; with `via_gateway: true`, the per-run token). The endpoint is `-c model_providers.sacty-provider={ … wire_api = "responses" }` |

- A run goes through the gateway (`via_gateway`) when `via_gateway` of `providers.codex` is `true` and `auth.mode` is `bedrock` or `openai-compatible`
  (authentication and the endpoint are built from the `providers` entry of the agent's runtime; `connectionOf`; [Configuration](configuration.en.md#providers)).
  In that case the API key is given to the gateway, and the container receives only the per-run token and the gateway URL (`http://host.docker.internal:<port>/openai/v1`)
  ([Gateway](gateway.en.md)).
- If a secret is not found, the run fails (reason `auth`) and the task is paused.
- The cost of subscription and stub runs is recorded as estimated (`estimated`). So is the cost of a run that placed tier subagent definitions (`estimateCost`),
  because a reviewer may run with a model other than the parent's while the cost can only be computed from the parent's usage and unit prices
  ([Context composition](context.en.md#files-placed-for-a-run)).

Code: `apps/daemon/src/agents/invocation.ts` (`buildInvocation`), `apps/daemon/src/agents/docker.ts` (`syncBackIfChanged`), `apps/daemon/src/service.ts` (`executeLogged`, `bedrockOrigin`)

## Output handling

- For Claude Code output (stream-json), the last `type: "result"` is the answer, and `input_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, and `output_tokens` of `usage` are the token counts. It fails if `is_error` is set or the exit code is not 0.
- For Codex output (JSONL), the `usage` of each `turn.completed` is summed (`cached_input_tokens` is subtracted from `input` and counted as cache reads),
  and the last `agent_message` is the answer. It fails if there is `turn.failed` or `error`, or the exit code is not 0.
- A line can be at most 16M characters (longer lines are skipped).
- Failure reasons are classified from the text (`classifyFailure`): usage limits (`usage limit`, `rate limit`, `429`, `quota`, and so on) are `usage_limit`, authentication
  (`401`, `403`, `unauthorized`, `expired`, `not logged in`, and so on) is `auth`, and anything else is `error`. When a task stopped on `usage_limit` or `auth`
  is resumed, the step it stopped at runs again (if there is a fallback agent, the task does not stop whatever the reason; see "Fallback agents on failure" below).
- Structured answers from an agent are JSON with a heading (`sacty-steps`, `sacty-verdict`, `sacty-final-review`, `sacty-split`,
  `sacty-export`, and so on); the JSON objects in the output are tried from the end, and the first one that parses is used.
- Secrets used in the run (retrieved values, gateway tokens, values in auth files, and so on) are replaced with
  `[REDACTED]` in the run's result text and output before they are recorded.

Code: `apps/daemon/src/agents/parse.ts` (`ClaudeOutcomeReader`, `CodexOutcomeReader`, `classifyFailure`, `MAX_LINE`), `apps/daemon/src/agent-json.ts` (`jsonCandidates`, `lastJsonAnswer`), `apps/daemon/src/agents/redact.ts` (`redact`, `redactText`)

## Fallback agents on failure

- When a run fails with `usage_limit`, the agent is remembered as limited for all tasks for `agent_fallback.cooldown_minutes` (60 minutes by default)
  (`markLimited`).
- When a run fails for another reason (`auth`, `error`) and reaches `fallBack`, the agent is remembered as not
  to be used for the same time, for that task only (other tasks run with the original agent). Both are kept only in the daemon's memory (after a restart,
  the original agent is tried first).
- Whether a run failed is decided from the exit code and the agent's output (`is_error` of Claude Code's `result`; Codex's `turn.failed` and `error`), not
  from the text on standard error (standard error is used only for the failure text and for classifying the reason). So a misclassified reason does not
  change whether the fallback is used (it changes only whether the agent is avoided for all tasks or for that task).
- When an agent is chosen (steps, the integration review, the Orchestrator, reading tickets, answering questions, the Goal Guardian, the final review,
  judging rework, exports, the post-merge watch, audits), if the chosen agent is limited or not to be used for that task, its `fallback` is looked at from the
  top (following each `fallback`'s own fallbacks too), and the first usable one is used (`fallbackAgentFor`). If none is usable, the chosen agent is kept.
- When the run of a step, the integration review, the Orchestrator's choice of steps, reading a ticket, or the final review fails (for any reason) and a usable fallback
  exists, `AgentFellBack` (the failed run, the role, the original and fallback agents, the failure reason, and the time limit) is recorded instead of a pause (`TaskPaused`). The failure
  record has put the task back to queued, so the fallback agent runs it again in the next pass. Switching when the run ended normally but its answer could not be read
  applies only to the choice of steps and reading a ticket (an unreadable answer from the final review or the Goal Guardian's judgements is handled as before).
- The agents tried while switching are remembered per task and per role of the process being retried (the step name, `orchestrator`, `final-review`, and so on;
  the role passed to `fallBack`), separately from the time limit (`fallbackTried`), and an agent already tried is not used again even after its time limit expires.
  When all have been tried, the task stops. When the run after a switch ends without coming back to `fallBack` (the run succeeded and its answer could be read),
  they are forgotten when the next run for that role is chosen (`usableAgent`). They are also forgotten when a person resumes the task. Success in another role
  (such as answering a question) does not forget them. For the Goal Guardian's judgements, they are forgotten when one judgement ends.
- A run whose container could not be confirmed as stopped (`run.containerNotConfirmed`) stops without switching (the original container may still be running, and
  a fallback starting in the same workspace could duplicate changes or outside operations).
- Judging change proposals and rework remarks is redone on the spot with the fallback agent; `AgentFellBack` is recorded, and the cost of the failed run is
  added to the judgement's cost (`runGuardianWithFallback`). Within one judgement, an agent already tried is not tried again even after its time limit expires, and when all have
  been tried the last failure is returned (retries are at most the number of fallbacks).
- When a person paused or cancelled the task, or there is no fallback or none is usable (including those already tried), the task stops as before. Exports, the post-merge watch, audits, and answers to
  questions handle the failure as before and use the fallback agent from the next run (only at a usage limit).
- The secrets of fallback agents are also retrieved together at startup (`secretUses`).

Code: `apps/daemon/src/service.ts` (`usableAgent`, `agentUnusable`, `markLimited`, `notConfirmed`, `fallBack`, `pauseOrFallBack`, `runGuardianWithFallback`), `apps/daemon/src/config.ts` (`fallbackAgentFor`), `apps/daemon/src/secret-uses.ts` (`secretUses`)

## Saving and reusing sessions

- After every run, the session files in the config location (for Claude Code, under `projects/` and `history.jsonl`; for Codex, under `sessions/` and
  `archived_sessions/` and `history.jsonl`) are copied, with secrets hidden, to `SACTY_HOME/runs/<task ID>/<run ID>/agent/`. Auth and config
  files (`.credentials.json`, `auth.json`, `.claude.json`, `config.toml`, and so on), symbolic links, and anything that is not a regular file are not copied.
  The total limit is 200MB (beyond it, the middle of large files is omitted). The size and SHA-256 of the copied files are recorded in `AgentSessionArchived`.
- The Orchestrator reuses one session per task. `session.json`
  (the AI ID, runtime, session ID, run ID, and the file list) and `generations/<run ID>/files/` are placed in `SACTY_HOME/sessions/<task ID>/orchestrator/`; only the current one and the one before are kept.
  - The next run uses a new session when there is no saved session (`first`), it is broken (`files_broken`), the AI changed (`agent_changed`), or files were omitted (`truncated`);
    otherwise it resumes the saved session.
  - When the AI changed (`agent_changed`) and the main file of the previous agent's saved session matches its record, its conversation is handed over.
    Only the text of the instructions and the agent's messages (no tool calls or results; up to 8000 characters per message and 200,000 in total, dropping the oldest
    messages beyond that; only the last 8MiB of the file is read (`HANDOFF_READ_LIMIT`); messages are not cut in the middle of a surrogate pair) is written to `previous-session.md`, mounted read-only at `/sacty-handoff`, and its location is added to the end of the instructions. The handover is
    recorded in `handoffFrom` of `OrchestratorSessionUsed`, and the written file is deleted after the run.
  - Orchestrator runs are one at a time per task (serial).
  - "Ask the Orchestrator" answers by forking the saved session (Claude Code uses `--fork-session`; Codex resumes in a throwaway location),
    and does not save it. Cancelled tasks are not saved either.
  - The session used is recorded in `OrchestratorSessionUsed` (`resumed`, `forked`, `new`).
- When a resume is refused (the AI failed without using anything and returned text saying the session was not found), the run is retried with a new run ID and a new session,
  and the cost of both attempts is recorded together (`resumeRejected`).

Code: `apps/daemon/src/agent-sessions.ts` (`SOURCES`, `selectAgentSessionFiles`, `AGENT_FILES_LIMIT`), `apps/daemon/src/orchestrator-sessions.ts` (`OrchestratorSessionStore`, `plan`, `save`), `apps/daemon/src/orchestrator-handoff.ts` (`sessionTranscript`, `stageHandoff`), `apps/daemon/src/service.ts` (`resumeRejected`, `RESUME_REJECTED`, `executeWithSession`)

## Images

- The default image is `image` (default `sacty-agent:1.7.1`). Per-language images are `images.<name>` (the tag defaults to `sacty-agent-<name>:1.7.1`).
  The image used is the default when there is no name or the name is `default`, the entry in `images` if it exists, and for an unknown name the run stops (`image.unknown`).
  A person can change a step's image on the task detail; it is used from the next run of the step ("Changing a step's image" in [Tasks and steps](tasks-and-steps.en.md)).
- `sacty image build [<name>...]` runs `docker build` on `packages/cli/docker/Dockerfile`. Without names it builds the default and everything in `images`.
  If there is no config file it builds with the defaults; if there is any other error it builds nothing.
  - The base image (`BASE_IMAGE`) defaults to `node:22-bookworm-slim`. Claude Code (`@anthropic-ai/claude-code@2.1.296`) and Codex
    (`@openai/codex@0.160.0`) are installed with `npm install -g`. It ends with `USER node` and `WORKDIR /workspace`.
  - A per-language image uses the base image's Node.js if it has Node.js 18 or later and npm; otherwise Node.js is copied from `node_image` (or
    `image_build.base_image` if that is unset, or `node:22-bookworm-slim` if that is unset too). If there is no `node` user it is created, with `HOME=/home/node` and
    `GOPATH=/home/node/go`. With `maven_mirror`, Maven's `settings.xml` and a Gradle init script are written.
  - `packages` are installed as root with whichever of dnf, microdnf, yum, or apt-get the base image has, and `enable_repos` becomes its `--enablerepo` (fails with apt-get).
    `run` is executed as root from top to bottom (with `-o pipefail` if bash is available).
  - The npm token (`image_build.npm_token`) is read only during the build through a BuildKit secret (`npmrc`) and does not remain in the image.
    The npm settings that remain in the image (`registry` and `npm_config`) are passed through a separate secret.
  - Because secret contents are not part of BuildKit's cache key, hashes of the contents (`NPM_CONFIG_HASH`, `SACTY_SETUP_HASH`) are passed as build-args
    so that the image is rebuilt when they change.
  - In place of `gh`, `packages/cli/docker/gh-shim.cjs` is placed at `/opt/sacty/bin/gh`, at the front of `PATH` (it is used before a `gh` in the base image).
    It accepts only `gh api` and sends REST `GET` and `HEAD` and GraphQL to `$SACTY_GITHUB_URL/<host>/…` (the host is `--hostname`, else
    `GH_HOST`). Fields (`-f`, `-F`) become the query for REST, and `query` and variables for GraphQL. It accepts `--paginate` (for REST it follows `link` and
    merges the arrays; for GraphQL, `$endCursor` and `pageInfo`), `--jq` (when `jq` exists), `-i`, `-H`, and `--input`.
    Write methods and other commands print the usage and exit with code 1 ([Gateway](gateway.en.md#relaying-github-reads)).
- The image's `env` is passed to the agent containers that run on that image (including the final review that runs the tests).

Code: `apps/daemon/src/config.ts` (`resolveImage`, `languageImageTag`, `DEFAULT_IMAGE`), `apps/daemon/src/image.ts` (`buildImage`, `imageBuildArgs`, `imageBuildSettings`, `imageBuildTargets`), `packages/cli/docker/Dockerfile`

## Running tests

- sacty does not run the test command in a container of its own. The Goal Guardian runs the tests for verifying the implementation inside the final review,
  and the Reproduce step's agent runs the reproduction test; both report the result (command, exit code, and an excerpt) ([Tasks and steps](tasks-and-steps.en.md#verifying-the-implementation)).
- The final review runs on the Implementation step's image (or the Reproduce step's if absent), with that image's `env`, on a disposable copy of the implemented working tree.
  If the implementation uses services, it is connected to them ([Services](services.en.md)).
- The test code runs inside an agent container, so, as in any other agent run, it can reach the agent's authentication values in the container and,
  in runs that use the gateway, the per-run gateway token.
- The time limit is that of the role running the tests ("Container" above; without a role override, `agent_minutes` + `test_minutes`).

Code: `apps/daemon/src/service.ts` (`verify`, `runGuardian`), `apps/daemon/src/run-timeouts.ts` (`agentTimeoutMs`)
