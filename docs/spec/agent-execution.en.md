[日本語](agent-execution.md) | **English**

# Agent execution

sacty carries out steps, information gathering, the Orchestrator, the Goal Guardian, answers to questions, and export by running an AI agent (Claude Code or Codex) once inside a docker container. sacty does not run tests in a separate container. The agents of the Goal Guardian (the final review), the Reproduce step, and the PR review step run them inside their own containers.

Related ADRs: [The Goal Guardian runs the tests in the final review, and sacty no longer uses a test container](../adr/20261021-1431-superseded-guardian-runs-tests.md)

## Container

- The container starts with `docker run --rm --name sacty-run-<run ID> --security-opt no-new-privileges --cap-drop ALL --init -v <workspace>:/workspace -w /workspace`. `--init` makes PID 1 an init that reaps finished child processes (zombies); when the agent's CLI is PID 1 they are not reaped, and tests that check process cleanup fail because of the environment (PBI-155). sacty adds the following when needed.
  - `--network <network>`: runs that started docker compose services ([Services](services.en.md)).
  - `--add-host host.docker.internal:<host address>`: runs that use the gateway. The address is `gateway.host_address` (default `host-gateway`).
  - Extra mounts: only locations sacty prepares. These include the config location, the review diff `/sacty-review` read-only, the session logs of each run for answers to questions `/sacty-logs` read-only, and memories `/sacty-memory/project` and `/sacty-memory/repository` read-only ([Memory](memory.en.md)).
- The user is the image's `USER node` (`--user` is not passed).
- For environment variables, the arguments contain only the name (`-e NAME`), and sacty passes the values through the environment of the docker command's process (so they do not appear in `ps`).
  - The only host environment variables kept in the docker command's process are `PATH`, `HOME`, `DOCKER_HOST`, `DOCKER_CONTEXT`, `DOCKER_CONFIG`, and `TMPDIR`.
  - The container receives only variables sacty decides (authentication, the config location, the image's `env`, and so on).
  - For the same name, the run's value takes precedence over the image's `env`.
- `run_timeout` in `config.yaml` (PBI-150) sets the limit for the whole run.
  - If `roles` has an override for the role (a step, `guardian`, `orchestrator`, and so on), sacty uses it.
  - Without an override, the limit is `agent_minutes` (default 30 minutes; `AGENT_RUN_TIMEOUT_MS`).
  - For the roles that run tests (`final-review`, `reproduce`, `review`), without an override the limit is `agent_minutes` plus `test_minutes` (default 20 minutes).
  - If sacty cannot read the config, the limit is 30 minutes for ordinary roles and 50 minutes (30 plus 20) for the final review, reproduction, and PR review.
  - sacty reads the setting for every run, so changes apply from the next run.
  - When the limit passes, sacty stops the container and the run times out (`run.timeout`, with that run's limit in minutes).
- To stop a container, sacty runs `docker kill` and checks up to 11 times, once per second, until `docker ps -aq --filter name=^/<name>$` is empty. If it cannot confirm the container stopped, the result is `run.containerNotConfirmed`, and sacty neither writes back the auth file nor saves the session files.
- If standard error contains `Unable to find image`, `No such image`, or `pull access denied`, sacty treats the image as missing (`run.imageMissing`).
- sacty keeps only the first 64KB and the last 256KB of standard error.

Code: `apps/daemon/src/agents/docker.ts` (`dockerRunArgs`, `dockerClientEnv`, `DockerExecutor`, `RunningContainers`), `apps/daemon/src/context.ts` (`AGENT_RUN_TIMEOUT_MS`), `apps/daemon/src/run-timeouts.ts` (`agentTimeoutMs`, `RUN_TIMEOUT_ROLES`), `apps/daemon/src/service.ts` (`executeLogged`)

## Run commands

| runtime | Command | Config location |
| --- | --- | --- |
| `claude-code` | `claude -p --output-format stream-json --verbose --disallowedTools ScheduleWakeup,CronCreate,CronDelete,CronList,RemoteTrigger` (the instructions go to stdin. A run is one-shot, so the tools that schedule a later wake-up or a recurring run are not allowed (a pending schedule keeps the run waiting after the final answer). `--add-dir <location>` if there is a location outside the workspace to read; only `/sacty-logs` for answers to questions. Resume is `--resume <ID>`, fork is `--fork-session`. With MCP, `--mcp-config …/mcp.json --strict-mcp-config --allowedTools mcp__<name>,…`. `--model` (on Bedrock, the environment variable `ANTHROPIC_MODEL`), `--effort`) | `CLAUDE_CONFIG_DIR=/tmp/sacty-claude-config`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` |
| `codex` | `codex exec --json --skip-git-repo-check --sandbox danger-full-access` (the endpoint is specified with `-c model_provider=…` and the like. `--model`, `-c model_reasoning_effort=…`. Resume is `resume <ID>`. Last come `--` and `-` (the instructions go to stdin)) | `CODEX_HOME=/.codex` |
| `stub` | `sh -c 'printf "%s" "$SACTY_STUB_RESULT"'` (returns the output of the `stub` setting; no AI is called) | None |

- sacty does not put the instructions (prompt) for the agent in the command arguments. It writes them to the container's stdin with `docker run -i` and then closes it (PBI-149). In an argument, a large prompt (such as the Goal Guardian's, which includes a diff) exceeds Linux's per-argument limit (128 KiB) and fails with `argument list too long`. The prompt itself is unchanged.
  - The output relay and localhost forwarding pass stdin through to the command.
  - Runs without instructions (`stub`) get no `-i`, and stdin is closed at once.
- sacty mounts a temporary directory per run read-write at the config location. Before the run starts, it copies the composed context ([Context composition](context.en.md)), the saved session, and the auth files into it. It is removed after the run; if it cannot be removed, only a warning is shown and the run's result (output and usage) is kept.
- sacty wraps the command in small Node.js scripts inside the container.
  - Outer: relays output. The command writes its output to a temporary file, which the script reads and streams, discarding every 8MB streamed. The exit code is unchanged.
  - Inner: forwards localhost (only for runs that started compose services).

Code: `apps/daemon/src/agents/invocation.ts` (`buildInvocation`, `Invocation`, `CONTAINER_CLAUDE_CONFIG_DIR`, `CONTAINER_CODEX_HOME`), `apps/daemon/src/agents/docker.ts` (`dockerRunArgs`, `DockerExecutor`), `apps/daemon/src/agents/output-relay.ts` (`withOutputRelay`, `RELAY_DISCARD_BYTES`), `apps/daemon/src/agents/forward.ts` (`withLocalForwards`)

## Authentication

The container receives only the variables for the chosen authentication method (the host's `ANTHROPIC_API_KEY` and the like are not inherited). sacty retrieves secrets on the host ([Secrets](secrets.en.md)).

| runtime × `auth.mode` | What is passed to the container |
| --- | --- |
| claude-code × `subscription` | `CLAUDE_CODE_OAUTH_TOKEN` |
| claude-code × `api-key` | `ANTHROPIC_API_KEY` |
| claude-code × `bedrock` | `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION` |
| codex × `subscription` | The host's `auth_file` (default `~/.codex/auth.json`) is copied to the config location as `auth.json`. If it changed after the run, it is written back to the host (not written back if the host's file changed during the run) |
| codex × `api-key` | `CODEX_API_KEY`, `OPENAI_API_KEY` (the same value) |
| codex × `bedrock` | `AWS_BEARER_TOKEN_BEDROCK`, `AWS_REGION`. When `providers.codex` has `via_gateway: true`, a per-run gateway token instead of the API key |
| codex × `openai-compatible` (`auth.mode` at run time is `provider`) | `SACTY_PROVIDER_API_KEY` (when `auth.secret` is written; with `via_gateway: true`, the per-run token). The endpoint is `-c model_providers.sacty-provider={ … wire_api = "responses" }` |

- A run goes through the gateway (`via_gateway`) when `via_gateway` of `providers.codex` is `true` and `auth.mode` is `bedrock` or `openai-compatible`. sacty builds authentication and the endpoint from the `providers` entry of the agent's runtime (`connectionOf`; [Configuration](configuration.en.md#providers)). In that case sacty gives the API key to the gateway, and the container receives only the per-run token and the gateway URL (`http://host.docker.internal:<port>/openai/v1`) ([Gateway](gateway.en.md)).
- If a secret is not found, the run fails (reason `auth`) and sacty pauses the task.
- sacty records the cost of the following runs as estimated (`estimated`).
  - Subscription and stub runs.
  - Runs that placed tier subagent definitions (`estimateCost`). A reviewer may run with a model other than the parent's, while the cost can only be computed from the parent's usage and unit prices ([Context composition](context.en.md#files-placed-for-a-run)).

Code: `apps/daemon/src/agents/invocation.ts` (`buildInvocation`, `CLAUDE_DISALLOWED_TOOLS`), `apps/daemon/src/agents/docker.ts` (`syncBackIfChanged`), `apps/daemon/src/service.ts` (`executeLogged`, `bedrockOrigin`)

## Output handling

- For Claude Code output (stream-json), the last `type: "result"` is the answer. Each notification from background work (subagents, background commands) starts another turn, so `result` appears many times. A role whose answer must contain a block with a fixed heading uses the last `result` that contains the key of that block (the heading in quotes) as the answer (the last `result` if none does), so that a reply to a notification after the final answer does not become the answer or the posted body (`preferResult`). The roles are review (`"sacty-review-verdict"`), final review (`"sacty-final-review"`), reproduce (`"sacty-reproduction"`), split (`"sacty-split"`), integration review (`"sacty-integration-review"`), and gathering (`"sacty-gathered"`) (`answerMarker`). When no `result` contains the marker and there are two or more of them, one line with the number of `result`s and the source of the usage is left in the daemon log and the session log (stderr). The token counts are the sum of `inputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, and `outputTokens` for each model in `modelUsage` of the last `result` (the whole run, including subagents). Each count takes the larger of that and the sum of `usage` of every `result`. A `modelUsage` with no model that has a readable field is not used. Without `modelUsage`, or for a run that resumes or forks a saved session (its `modelUsage` also includes the earlier runs; `resumed`), they are the sum of `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `output_tokens` of `usage` (that turn only) of every `result`. The run fails if `is_error` is set or the exit code is not 0.
- For Codex output (JSONL), sacty sums the `usage` of each `turn.completed`, and the last `agent_message` is the answer. `cached_input_tokens` is subtracted from `input` and counted as cache reads. The run fails if there is `turn.failed` or `error`, or the exit code is not 0.
- A line can be at most 16M characters (longer lines are skipped).
- sacty classifies failure reasons from the text (`classifyFailure`).

  | Reason | Example text |
  | --- | --- |
  | `usage_limit` (usage limit) | `usage limit`, `rate limit`, `429`, `quota`, and so on |
  | `auth` (authentication) | `401`, `403`, `unauthorized`, `expired`, `not logged in`, and so on |
  | `error` | Anything else |

  When a task stopped on `usage_limit` or `auth` is resumed, the step it stopped at runs again. If there is a fallback agent, the task does not stop whatever the reason (see "Fallback agents on failure" below).
- Structured answers from an agent are JSON with a heading (`sacty-steps`, `sacty-verdict`, `sacty-final-review`, `sacty-split`, `sacty-export`, and so on). sacty tries the JSON objects in the output from the end and uses the first one that parses.
- Before recording the run's result text and output, sacty replaces the secrets used in the run (retrieved values, gateway tokens, values in auth files, and so on) with `[REDACTED]`.

Code: `apps/daemon/src/agents/parse.ts` (`ClaudeOutcomeReader`, `CodexOutcomeReader`, `classifyFailure`, `MAX_LINE`), `apps/daemon/src/agent-json.ts` (`jsonCandidates`, `lastJsonAnswer`), `apps/daemon/src/prompts.ts` (`answerMarker`), `apps/daemon/src/agents/redact.ts` (`redact`, `redactText`)

## Fallback agents on failure

- When a run fails with `usage_limit`, sacty remembers the agent as limited for all tasks for `agent_fallback.cooldown_minutes` (60 minutes by default) (`markLimited`).
- When a run fails for another reason (`auth`, `error`) and reaches `fallBack`, sacty remembers the agent as not to be used for the same time, for that task only. Other tasks run with the original agent.
- sacty keeps both only in the daemon's memory. After a restart, it tries the original agent first.
- sacty decides whether a run failed from the exit code and the agent's output (`is_error` of Claude Code's `result`; Codex's `turn.failed` and `error`). It does not decide from the text on standard error, which it uses only for the failure text and for classifying the reason. So a misclassified reason does not change whether the fallback is used. It changes only whether the agent is avoided for all tasks or for that task.
- When sacty chooses an agent and the chosen agent is limited or not to be used for that task, sacty looks at its `fallback` from the top (following each `fallback`'s own fallbacks too) and uses the first usable one (`fallbackAgentFor`). If none is usable, the chosen agent is kept. This applies to steps, the integration review, information gathering, the Orchestrator, reading tickets, answering questions, the Goal Guardian, the final review, judging rework, exports, the post-merge watch, and audits.
- When the run of a step, the integration review, information gathering, the Orchestrator's choice of steps, reading a ticket, or the final review fails (for any reason) and a usable fallback exists, sacty records `AgentFellBack` instead of a pause (`TaskPaused`).
  - The record holds the failed run, the role, the original and fallback agents, the failure reason, and the time limit.
  - The failure record has put the task back to queued, so the fallback agent runs it again in the next pass.
  - sacty switches when the run ended normally but its answer could not be read only for information gathering, the choice of steps, and reading a ticket. An unreadable answer from the final review or the Goal Guardian's judgements is handled as before.
- sacty remembers the agents tried while switching per task and per role of the process being retried, separately from the time limit (`fallbackTried`). The role is the step name, `gather`, `orchestrator`, `final-review`, and so on: the role passed to `fallBack`.
  - sacty does not go back to an agent already tried, even after its time limit expires. When all have been tried, the task stops.
  - When the run after a switch ends without coming back to `fallBack` (the run succeeded and its answer could be read), sacty forgets them when it chooses the next run for that role (`usableAgent`).
  - sacty also forgets them when a person resumes the task. Success in another role (such as answering a question) does not forget them.
  - For the Goal Guardian's judgements, sacty forgets them when one judgement ends.
- A run whose container could not be confirmed as stopped (`run.containerNotConfirmed`) stops without switching. The original container may still be running, and a fallback starting in the same workspace could duplicate changes or outside operations.
- sacty redoes judging change proposals and rework remarks on the spot with the fallback agent (`runGuardianWithFallback`). It records `AgentFellBack` and adds the cost of the failed run to the judgement's cost. Within one judgement, it does not try an agent already tried even after its time limit expires, and when all have been tried it returns the last failure (retries are at most the number of fallbacks).
- In the following cases, the task stops as before.
  - A person paused or cancelled the task.
  - There is no fallback, or none is usable (including those already tried).
- Exports, the post-merge watch, audits, and answers to questions handle the failure as before and use the fallback agent from the next run (only at a usage limit).
- sacty also retrieves the secrets of fallback agents together at startup (`secretUses`).

Code: `apps/daemon/src/service.ts` (`usableAgent`, `agentUnusable`, `markLimited`, `notConfirmed`, `fallBack`, `pauseOrFallBack`, `runGuardianWithFallback`), `apps/daemon/src/config.ts` (`fallbackAgentFor`), `apps/daemon/src/secret-uses.ts` (`secretUses`)

## Saving and reusing sessions

- After every run, sacty copies the session files in the config location, with secrets hidden, to `SACTY_HOME/runs/<task ID>/<run ID>/agent/`.
  - Files copied: for Claude Code, under `projects/` and `history.jsonl`; for Codex, under `sessions/` and `archived_sessions/` and `history.jsonl`.
  - sacty does not copy auth and config files (`.credentials.json`, `auth.json`, `.claude.json`, `config.toml`, and so on), symbolic links, or anything that is not a regular file.
  - The total limit is 200MB (beyond it, the middle of large files is omitted).
  - sacty records the size and SHA-256 of the copied files in `AgentSessionArchived`.
- The Orchestrator reuses one session per task. sacty places `session.json` (the AI ID, runtime, session ID, run ID, and the file list) and `generations/<run ID>/files/` in `SACTY_HOME/sessions/<task ID>/orchestrator/` and keeps only the current one and the one before.
  - The next run uses a new session when there is no saved session (`first`), it is broken (`files_broken`), the AI changed (`agent_changed`), or files were omitted (`truncated`). Otherwise it resumes the saved session.
  - When the AI changed (`agent_changed`) and the main file of the previous agent's saved session matches its record, sacty hands over its conversation.
    - The handover contains only the text of the instructions and the agent's messages (no tool calls or results).
    - Each message is limited to 8000 characters and the whole to 200,000, dropping the oldest messages beyond that. sacty reads only the last 8MiB of the file (`HANDOFF_READ_LIMIT`). Messages are not cut in the middle of a surrogate pair.
    - sacty writes this to `previous-session.md`, mounts it read-only at `/sacty-handoff`, and adds its location to the end of the instructions.
    - sacty records the handover in `handoffFrom` of `OrchestratorSessionUsed` and deletes the written file after the run.
  - Orchestrator runs are one at a time per task (serial).
  - "Ask the Orchestrator" answers by forking the saved session (Claude Code uses `--fork-session`; Codex resumes in a throwaway location), and does not save it. Cancelled tasks are not saved either.
  - sacty records the session used in `OrchestratorSessionUsed` (`resumed`, `forked`, `new`).
- When a resume is refused (the AI failed without using anything and returned text saying the session was not found), sacty retries the run with a new run ID and a new session. It records the cost of both attempts together (`resumeRejected`).

Code: `apps/daemon/src/agent-sessions.ts` (`SOURCES`, `selectAgentSessionFiles`, `AGENT_FILES_LIMIT`), `apps/daemon/src/orchestrator-sessions.ts` (`OrchestratorSessionStore`, `plan`, `save`), `apps/daemon/src/orchestrator-handoff.ts` (`sessionTranscript`, `stageHandoff`), `apps/daemon/src/service.ts` (`resumeRejected`, `RESUME_REJECTED`, `executeWithSession`)

## Images

- The default image is `image` (default `sacty-agent:1.14.0`). Per-language images are `images.<name>` (the tag defaults to `sacty-agent-<name>:1.14.0`).
- The name decides which image is used.
  - No name, or the name `default`: the default image.
  - A name in `images`: that entry.
  - An unknown name: the run stops (`image.unknown`).
- A person can change a step's image on the task detail, and the new image is used from the next run of the step ("Changing a step's image" in [Tasks and steps](tasks-and-steps.en.md)).
- `sacty image build [<name>...]` runs `docker build` on `packages/cli/docker/Dockerfile`. Without names it builds the default and everything in `images`. If there is no config file it builds with the defaults; if there is any other error it builds nothing.
  - The base image (`BASE_IMAGE`) defaults to `node:26-bookworm-slim`. The build installs Claude Code (`@anthropic-ai/claude-code@2.1.296`) and Codex (`@openai/codex@0.160.0`) with `npm install -g`. It ends with `USER node` and `WORKDIR /workspace`.
  - A per-language image uses the base image's Node.js if it has Node.js 18 or later and npm. Otherwise the build copies Node.js from `node_image` (or `image_build.base_image` if that is unset, or `node:26-bookworm-slim` if that is unset too). If there is no `node` user, the build creates it, with `HOME=/home/node` and `GOPATH=/home/node/go`. With `maven_mirror`, the build writes Maven's `settings.xml` and a Gradle init script.
  - The build installs `packages` as root with whichever of dnf, microdnf, yum, or apt-get the base image has, and `enable_repos` becomes its `--enablerepo` (fails with apt-get). It executes `run` as root from top to bottom (with `-o pipefail` if bash is available).
  - The build reads the npm token (`image_build.npm_token`) only during the build through a BuildKit secret (`npmrc`), and the token does not remain in the image. The npm settings that remain in the image (`registry` and `npm_config`) are passed through a separate secret.
  - Secret contents are not part of BuildKit's cache key. So sacty passes hashes of the contents (`NPM_CONFIG_HASH`, `SACTY_SETUP_HASH`) as build-args, and the image is rebuilt when they change.
  - In place of `gh`, the build places `packages/cli/docker/gh-shim.cjs` at `/opt/sacty/bin/gh`, at the front of `PATH` (it is used before a `gh` in the base image).
    - It accepts only `gh api` and sends REST `GET` and `HEAD` and GraphQL to `$SACTY_GITHUB_URL/<host>/…` (the host is `--hostname`, else `GH_HOST`).
    - Fields (`-f`, `-F`) become the query for REST, and `query` and variables for GraphQL.
    - It accepts `--paginate` (for REST it follows `link` and merges the arrays; for GraphQL, `$endCursor` and `pageInfo`), `--jq` (when `jq` exists), `-i`, `-H`, and `--input`.
    - Write methods and other commands print the usage and exit with code 1 ([Gateway](gateway.en.md#relaying-github-reads)).
  - Work CLIs (`packages/cli/docker/install-tools.sh`)
    - The candidates are `jq`, `rg`, `fd`, `tree`, `file`, `less`, `curl`, `zip`, `unzip`, `xz`, `bzip2`, `patch`, `diff`, `find`, `make`, `ps`, `sqlite3`, `python3`, and `shellcheck`. The build installs only the commands the base image lacks, with whichever of apt-get, dnf, microdnf, or yum the base image has (on RHEL-family images the package names are `xz`, `procps-ng`, `sqlite`, `ShellCheck`, and so on).
    - If they cannot be installed together, the build installs them one by one, warns about the commands that could not be installed, and continues (the mirror is unreachable, or `rg`, `fd`, `shellcheck` and others exist only in EPEL on RHEL-family images).
    - Debian/Ubuntu's `fdfind` is also available as `/usr/local/bin/fd`.
  - The build installs the draw.io CLI (`packages/cli/docker/install-drawio.sh`) when the build-arg `SACTY_DRAWIO` (default `1`; `0` when `image_build.drawio` is `false`) is `1`.
    - It fetches the deb (apt-get; `amd64`, `arm64`) or rpm (dnf, yum; `x86_64`, `aarch64`) of the official draw.io Desktop release (`v32.4.1` of `jgraph/drawio-desktop`) with `curl`. The fetch allows 30 seconds to connect, aborts when below 1KB/s for 60 seconds, allows 900 seconds per attempt, and retries at most 3 times, starting none after 1200 seconds from the first attempt. The total can exceed 1200 seconds.
    - It checks the package against a SHA-256 pinned per version and installs it together with `Xvfb` (`xvfb`, `xorg-x11-server-Xvfb`) and `libasound2` (`libasound2t64` from Ubuntu 24.04) or `alsa-lib`. If CJK fonts (`fonts-noto-cjk`, `google-noto-sans-cjk-ttc-fonts`) cannot be installed, it warns and continues.
    - A hash mismatch stops the build. For other reasons (cannot fetch, no package manager or `curl`, an unsupported architecture, cannot install), it warns and continues.
    - After installing, it removes the setuid bit of `/opt/drawio/chrome-sandbox` (`0755`), creates `/tmp/.X11-unix` with `1777`, and makes `/opt/sacty/bin/drawio` a link to `packages/cli/docker/drawio-shim.cjs`.
  - The security check tools (`packages/cli/docker/install-security-tools.sh`) are `osv-scanner` (`v2.7.0` of `google/osv-scanner`) and `gitleaks` (`v8.30.1` of `gitleaks/gitleaks`).
    - Only the ones the base image lacks are installed: the build fetches the official release assets (`osv-scanner_linux_<amd64|arm64>`, `gitleaks_<version>_linux_<x64|arm64>.tar.gz`) with `curl` and puts them in `/usr/local/bin` (the fetch limits are the same as for draw.io).
    - It checks them against the SHA-256 in the hash file of the same release (`osv-scanner_SHA256SUMS`, `gitleaks_<version>_checksums.txt`), and a mismatch stops the build. For other reasons (cannot fetch, no `curl`, an unsupported architecture, no line in the hash file, cannot extract, cannot place it in `/usr/local/bin`), it warns and continues (without reporting it as installed).
  - `drawio` (`drawio-shim.cjs`) starts `/opt/drawio/drawio` with `--no-sandbox --disable-gpu` and the arguments it received.
    - Without `DISPLAY`, it starts a virtual display on a free number with `Xvfb -displayfd`, and stops it and waits for it to end when done (`SIGKILL` if it has not ended in 3 seconds). If the virtual display cannot be started, it prints the reason and exits with code 1.
    - It decodes standard error as UTF-8, splits it into lines, and removes the `ERROR:dbus/` and `ERROR:bus.cc` lines. It returns the exit code unchanged.
    - On SIGINT or SIGTERM, it sends the same signal to draw.io while draw.io is running. If draw.io has not started yet (such as while waiting for Xvfb to start), it stops Xvfb and waits for it to end. It then exits with 128 plus the signal number.
- The image's `env` is passed to the agent containers that run on that image (including the final review that runs the tests).

Code: `apps/daemon/src/config.ts` (`resolveImage`, `languageImageTag`, `DEFAULT_IMAGE`), `apps/daemon/src/image.ts` (`buildImage`, `imageBuildArgs`, `imageBuildSettings`, `imageBuildTargets`), `packages/cli/docker/Dockerfile`, `packages/cli/docker/install-tools.sh`, `packages/cli/docker/install-drawio.sh`, `packages/cli/docker/install-security-tools.sh`, `packages/cli/docker/drawio-shim.cjs`

## Running tests

- sacty does not run the test command in a container of its own.
  - The Goal Guardian runs the tests for verifying the implementation inside the final review.
  - The Reproduce step's agent runs the reproduction test.
  - The Goal Guardian and the Reproduce step's agent report the result (command, exit code, and an excerpt) ([Tasks and steps](tasks-and-steps.en.md#verifying-the-implementation)).
  - The PR review step's agent fetches dependencies in the copy of the PR's code and runs verification such as formatters, linters, type checks, tests, and builds. For verification that could not run, it writes the command and why it stopped in the review body ([Tasks and steps](tasks-and-steps.en.md#pr-review-only-tasks)).
- The final review runs on the Implementation step's image (or the Reproduce step's if absent), with that image's `env`. It runs on a disposable copy of the implemented working tree (the copy's .git is a copy of the saved metadata). If the implementation uses services, it is connected to them ([Services](services.en.md)).
- The test code (in a PR review, including the PR's dependency install scripts and tests) runs inside the container of the agent that runs the tests. So, as in any other agent run, it can reach the agent's authentication values in the container. In runs that use the gateway, it can also reach the per-run gateway token.
- The time limit is that of the role running the tests ("Container" above; without a role override, `agent_minutes` + `test_minutes`).

Code: `apps/daemon/src/service.ts` (`verify`, `runGuardian`), `apps/daemon/src/prompts.ts` (`reviewVerificationLines`), `apps/daemon/src/run-timeouts.ts` (`agentTimeoutMs`, `TEST_RUNNING_ROLES`)
