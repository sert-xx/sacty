[日本語](agent-execution.md) | **English**

# Agent execution

sacty carries out steps, information gathering, the Orchestrator, the Goal Guardian, answers to questions, and export by running an AI agent (Claude Code or Codex) once inside a docker container. sacty does not run tests in a separate container. The agents of the Goal Guardian (the final review), the Reproduce step, and the PR review step run them inside their own containers.

Related ADRs: [The Goal Guardian runs the tests in the final review, and sacty no longer uses a test container](../adr/20261021-1431-superseded-guardian-runs-tests.md)

## Container

- The container starts with `docker run --rm --name sacty-run-<run ID> --security-opt no-new-privileges --cap-drop ALL --init -v <workspace>:/workspace -w /workspace`. `--init` makes PID 1 an init that reaps finished child processes (zombies); when the agent's CLI is PID 1 they are not reaped, and tests that check process cleanup fail because of the environment (PBI-155). sacty adds the following when needed.
  - `--network <network>`: runs that started docker compose services ([Services](services.en.md)).
  - `--add-host host.docker.internal:<host address>`: runs that use the gateway. The address is `gateway.host_address` (default `host-gateway`).
  - Extra mounts: only locations sacty prepares. These include the config location, the review diff `/sacty-review` read-only, the session logs of each run for answers to questions `/sacty-logs` read-only, memories `/sacty-memory/project` and `/sacty-memory/repository` read-only ([Memory](memory.en.md)), and the dependency cache `/sacty-cache` ("Dependency cache" below).
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
  - sacty reads the usage from what the agent had written to standard output by the time it stopped, and attaches it to the timeout error (`AgentTimeoutError`). After stopping, sacty waits up to 5 seconds for the `docker run` child process to end and its remaining output to be read before fixing the usage (`TIMEOUT_DRAIN_MS`). How it reads is under "Output handling", runs that stopped before a result. The caller records what could be read as the cost (`executeLogged`). If, after stopping, the container could not be confirmed stopped, the error says so (`unconfirmedContainer`) and the caller makes the result `run.containerNotConfirmed` (the container may still be running, so sacty does not switch to a fallback agent).
- To stop a container, sacty runs `docker kill` and checks up to 11 times, once per second, until `docker ps -aq --filter name=^/<name>$` is empty. If it cannot confirm the container stopped, the result is `run.containerNotConfirmed`, and sacty neither writes back the auth file nor saves the session files.
- If standard error contains `Unable to find image`, `No such image`, or `pull access denied`, sacty treats the image as missing (`run.imageMissing`).
- sacty keeps only the first 64KB and the last 256KB of standard error.

Code: `apps/daemon/src/agents/docker.ts` (`dockerRunArgs`, `dockerClientEnv`, `DockerExecutor`, `RunningContainers`), `apps/daemon/src/context.ts` (`AGENT_RUN_TIMEOUT_MS`), `apps/daemon/src/run-timeouts.ts` (`agentTimeoutMs`, `RUN_TIMEOUT_ROLES`), `apps/daemon/src/service.ts` (`executeLogged`)

## Dependency cache

Within one task, the results of preparing dependencies (package downloads, build caches, and so on) are reused across steps and runs (PBI-319).

- Location: `_task-cache/<task-id>` under the workspace root (`0700`). It is separate per task and never mounted into another task's container.
- Runs that get it: only runs that work on the target repository with the task's image (steps, the final review, the integration review).
  The Goal Guardian's judgments, the Orchestrator, information gathering, answers to questions, export, external work, and the after-merge watch do not get it.
- How it is passed:
  - It is mounted with `-v <location>:/sacty-cache`, and `XDG_CACHE_HOME=/sacty-cache` is passed (taking precedence over the image's `env`).
    The value before the override (one set in the image's `env` and so on) is passed to the check below in `SACTY_PREVIOUS_XDG_CACHE_HOME`, with `SACTY_PREVIOUS_XDG_CACHE_HOME_WAS_SET=1` showing that it was set.
  - `HOME` and `XDG_CONFIG_HOME` are not changed (auth config files disappear when the container is removed).
  - The agent CLI's own cache (Claude Code's `claude-cli-nodejs`) is made a container-only location with `--tmpfs /sacty-cache/claude-cli-nodejs`.
    Anything a previous run left at `claude-cli-nodejs` in the location (including a link) is removed before the run (a link is removed by itself).
  - Inside the container, sacty checks that the user can write to `/sacty-cache` before it `exec`s the command (`withTaskCacheProbe`, inside the output relay and the port forwarding).
    If it cannot write (for example, on Linux when the daemon's UID differs from the container user's), it writes a notice starting with `[sacty] 依存のキャッシュ：` to standard error and runs with `XDG_CACHE_HOME` restored to the value before the override (removed if there was none; the usual run, without the cache).
    `SACTY_PREVIOUS_XDG_CACHE_HOME` and `SACTY_PREVIOUS_XDG_CACHE_HOME_WAS_SET`, used for the check, are not passed to the command.
    The notice is copied to the daemon's log too, from the standard error received so far, however the run ends, including a timeout or a failure to confirm the stop (`taskCacheNotices`).
    The condition for writing is the same as for the workspace (`/workspace`): sacty changes the owner of neither and passes no `--user`, so with an ordinary Linux bind mount the container can write only when the daemon's UID equals the UID of the image's `node` (the workspace is `0755` and the cache is `0700`; in both, only the owner can write).
    In environments that share files into a virtual machine, such as Docker Desktop and Rancher Desktop, they appear as owned by the container's user, so it can write.
- sacty appends a short guide (`## 依存のキャッシュ`) at the end of the instructions of runs that get the cache, asking the agent to do the following (`taskCachePromptLines`).
  It is added in the common path of runs, so it also reaches the final review and the integration review, which do not get the default rules. Runs without the cache do not get it.
  - Put tool caches in `XDG_CACHE_HOME`. For tools that do not read it, point the tool's cache location setting under `XDG_CACHE_HOME` (without changing the repository's files).
  - Not put auth config files or secret values there.
  - Go on without the cache if a failure looks caused by it.
- It is prepared before the run (`prepareTaskCache`).
  - If missing, it is created.
  - If the task's location is not a directory (a link or a file) or cannot be read and written, it is removed and created again (a link is removed by itself).
  - If `_task-cache` is not a directory (a link or a file) or the location cannot be created again, the reason goes to the daemon's log and the run proceeds without the cache (the task is not stopped).
- When it is removed: the same as the task's workspace ([Tasks and steps](tasks-and-steps.en.md#cleaning-up-the-workspaces-of-finished-tasks)).

Related ADRs: [Reuse the results of preparing dependencies across steps and runs, in a per-task cache directory](../adr/20261108-0739-task-dependency-cache.md)

Code: `apps/daemon/src/task-cache.ts` (`prepareTaskCache`, `taskCachePromptLines`), `apps/daemon/src/workspace-cleanup.ts` (`TASK_CACHE_DIR`, `taskCachePath`, `taskWorkspacePaths`), `apps/daemon/src/agents/docker.ts` (`CONTAINER_TASK_CACHE`, `DockerExecutor`, `withTaskCacheProbe`, `taskCacheNotices`), `apps/daemon/src/agents/invocation.ts` (`CLAUDE_CACHE_DIR`), `apps/daemon/src/service.ts` (`ExecuteRun`)

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
  - Runs that placed tier subagent definitions (`estimateCost`). A reviewer may run with a model other than the parent's ([Context composition](context.en.md#files-placed-for-a-run)).
    How the cost is decided is in "Output handling" below.

Code: `apps/daemon/src/agents/invocation.ts` (`buildInvocation`, `CLAUDE_DISALLOWED_TOOLS`), `apps/daemon/src/agents/docker.ts` (`syncBackIfChanged`), `apps/daemon/src/service.ts` (`executeLogged`, `bedrockOrigin`)

## Output handling

- For Claude Code output (stream-json), the last `type: "result"` is the answer. Each notification from background work (subagents, background commands) starts another turn, so `result` appears many times. A role whose answer must contain a block with a fixed heading uses the last `result` that contains the key of that block (the heading in quotes) as the answer (the last `result` if none does), so that a reply to a notification after the final answer does not become the answer or the posted body (`preferResult`). The roles are review (`"sacty-review-verdict"`), final review (`"sacty-final-review"`), reproduce (`"sacty-reproduction"`), split (`"sacty-split"`), integration review (`"sacty-integration-review"`), and gathering (`"sacty-gathered"`) (`answerMarker`). When no `result` contains the marker and there are two or more of them, one line with the number of `result`s and the source of the usage is left in the daemon log and the session log (stderr). The token counts are the sum of `inputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`, and `outputTokens` for each model in `modelUsage` of the last `result` (the whole run, including subagents). Each count takes the larger of that and the sum of `usage` of every `result`. A `modelUsage` with no model that has a readable field is not used. Without `modelUsage`, or for a run that resumes or forks a saved session (its `modelUsage` also includes the earlier runs; `resumed`), they are the sum of `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, and `output_tokens` of `usage` (that turn only) of every `result`. The run fails if `is_error` is set or the exit code is not 0.
- Run cost (`runCost`): when the CLI reports a cost, that is the run's cost. Otherwise sacty converts the usage with unit prices (PBI-301).
  - For Claude Code, the reported cost is `total_cost_usd` of the last `result` (the whole run, including subagents).
    An unreadable value (not a number, negative, or not finite) is not a report, and a report of 0 although there is usage is not a report either (the CLI could not price it, for example because it does not know the price), so sacty converts instead.
    A run that resumes or forks a saved session (`resumed`) uses neither the report nor the per-model usage, because they include the earlier runs.
    Usage the report does not cover (`unreportedUsage`), such as a turn that started after the last `result`, is converted with the step agent's price and added.
  - With no report (Codex and so on), sacty converts the usage. If there is `modelUsage`, it converts each model's usage with that model's price and adds them.
    A model's price is looked up in `available_models` of the same provider as the step agent (`AgentConfig.modelPrices`; an exact match, otherwise the name without a suffix such as `[1m]`; inherited property names are not used).
    A model with no price in the config, and any usage the per-model usage does not cover, is converted with the step agent's price. Without `modelUsage`, the whole usage is converted with the step agent's price.
  - For every run that has usage, sacty records where the cost came from in `RunCostRecorded` (the run, the agent, `reported` or `converted`, the run's cost, the amount converted with the configured prices, and any models with no configured price). It only records; the cost itself is carried by the run's result event.
    A run of an agent whose CLI does not report a cost (Codex and so on) is also recorded, as `converted` (the CLI reported no cost, and the usage was converted with the price) (PBI-302 D2; before, a run whose usage was simply converted with the step agent's price was not recorded, so the activity log could not tell reported from converted). The activity log on screen shows "the agent CLI did not report a cost, so the usage was converted with the price".
- For a run that stopped before a result (a timeout or a forced stop), the usage of the whole run is not known (PBI-281).
  - Claude Code: if no `result` came but at least one event did, the part that could be read is kept as the usage, and it is marked unknown (`costUnknown`). The part is the sum of `message.usage` of `assistant` events, counted once per `message.id` (events for each content block repeat the same id and usage; within one id, each field takes the larger value). Usage inside subagents and the output tokens partway through a message cannot be read, so the sum is smaller than the real usage (a lower bound). With no readable message, no usage is kept. If no event came at all (it never started), nothing was used, so it is not marked unknown. Message ids are kept up to 256 characters and 4096 entries (the values come from the container, so memory is protected). Messages beyond the limit are not read; what was read is kept as a lower bound and marked unknown.
  - Messages of a turn that started after the last `result` (and then stopped by a forced stop or a timeout) are not in that `result`'s `usage`, so their `message.usage` is added and the run is marked unknown. Messages already in a `result` are not counted again.
  - A run that timed out is marked unknown whenever at least one event came, even if a `result` exists, because what happened after the last `result` is not known.
- When the final answer is empty (PBI-290). If the last `result` (for Codex, the last `agent_message`) is empty (whitespace only) and an earlier `result` has content, the last one with content is the answer (`ClaudeOutcomeReader`, `CodexOutcomeReader`). A turn started by the completion notice of background work can end without a body, so an empty `result` comes last. For Claude Code, when this happens, one line is left in the daemon log and the session log (stderr) (not for Codex).
  If no `result` has any content, the run is a failure (`error`, `run.emptyResult`) instead of an empty deliverable. The usage already spent is kept. The failure is handled like other failures (switch to a fallback agent, or pause if none; resuming runs the same step again).
  This applies to every role (the reading is done in one place, the run in `docker.ts`). A `result` with `is_error` is not replaced by an earlier `result`; it fails as before. A short but non-empty reply (such as "waiting") counts as content and is not told apart.

- For Codex output (JSONL), sacty sums the `usage` of each `turn.completed`, and the last `agent_message` is the answer. `cached_input_tokens` is subtracted from `input` and counted as cache reads. The run fails if there is `turn.failed` or `error`, or the exit code is not 0. A run stopped by the daemon stopping (`abortAll`) keeps its reason (`run.daemonStopped`) and also keeps the usage that could be read and the unknown mark. So does a run whose container could not be confirmed stopped (`run.containerNotConfirmed`). Codex gives usage only when a turn ends. If a turn that started (`turn.started`) stopped or failed without ending, that turn's usage cannot be read, so the run is marked unknown. The usage of turns that ended is kept; if none ended, no usage is kept (it is not set to 0).
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

Code: `apps/daemon/src/agents/parse.ts` (`ClaudeOutcomeReader`, `CodexOutcomeReader`, `classifyFailure`, `MAX_LINE`), `apps/daemon/src/agents/cost.ts` (`runCost`, `priceOfModel`), `apps/daemon/src/agent-json.ts` (`jsonCandidates`, `lastJsonAnswer`), `apps/daemon/src/prompts.ts` (`answerMarker`), `apps/daemon/src/agents/redact.ts` (`redact`, `redactText`)

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
- Even for a temporary failure of an agent run (such as a busy model), sacty has no process that waits and retries with the same agent.
  With no fallback, the task stops and waits until a person resumes it.
  When a Sacty review task stops, sacty also tells the PR that asked for the review ([Telling the PR when a review stops](intake.en.md#telling-the-pr-when-a-review-stops)).
  However, for a temporary failure of a review task's GitHub requests (checking the PR to review and posting the review), sacty waits and retries automatically before it stops (same section).
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
- A run stopped by the timeout continues the same agent session the next time the same role runs (PBI-280; the Orchestrator and answers to questions use the mechanism above).
  - For a run stopped by the timeout (`run.timeout`), sacty records `AgentRunTimedOut` (run ID, role, agent, runtime, the limit in minutes; it does not change state).
  - Before the next run, sacty looks through the activity from the newest and decides from the first run record it meets whether the previous run timed out (`timedOutRunBefore`).
    - `AgentRunTimedOut` means that run. `AgentRunContinued` (the record of continuing) means it was already continued, so there is nothing to do.
    - Any other run's file record (`AgentSessionArchived`, except answers to questions, `chat`) means another run came after the timeout, so there is nothing to do.
    - The start and failure of a step run (`AgentRunStarted`, `AgentRunFailed`) also count as another run, except those of the run stopped by the timeout itself and of the run about to start. If a continued run is interrupted by the daemon stopping, neither a file record nor a continued record remains, so sacty tells by this start and failure (it does not continue an old conversation without that run's progress).
  - If the run found and the role about to run are the same, sacty decides whether it can continue (`planTimeoutResume`). If the roles differ, it does nothing.
    - Continue: the agent (AI type and ID) is the same, the stopped run's `AgentSessionArchived` has the session ID and the main file, no file was omitted, and the copied files match the recorded hashes.
      sacty puts the copied files (`runs/<task ID>/<stopped run ID>/agent/`) back in the config location and resumes with `--resume <ID>` for Claude Code or `resume <ID>` for Codex. The run ID is new (the step records use that run ID).
      It adds to the start of the instructions that the run was stopped by the timeout and resumed, and how files are treated: those in the workspace (kept only for implementation and reproduction) and those inside the container (not kept) (`timeoutResumeLines`).
    - Do not continue (run again from the start): the reason is `no_session` (no session record, or the original files could not be copied), `agent_changed`, `truncated`, or `files_broken` (files missing or hashes differ).
  - sacty records whether it continued or ran again from the start in `AgentRunContinued` (run ID, stopped run ID, `resumed` or `restarted`, the session ID or the reason; it does not change state) **before the run**. If the daemon stops during the run, this record remains, so even for roles that leave no start record (the final review, the Goal Guardian, and so on) the next run does not continue the same old session again.
    If the run was meant to resume but started another session, or the AI refused the resume, sacty records `restarted` (`resume_failed`) again after the run (the newer record takes precedence). In that case sacty does not retry with a new run ID and returns the failure as it is (the next resume runs from the start).
  - The workspace for implementation and reproduction (the task's clone) is not deleted by the stop (only completed tasks are cleaned up). The resumed run works in the same workspace, with the changes made before the stop.
    Requirements, design, and the like use a copy prepared for each run, so files written before the stop are not kept.

Code: `apps/daemon/src/agent-sessions.ts` (`SOURCES`, `selectAgentSessionFiles`, `AGENT_FILES_LIMIT`), `apps/daemon/src/orchestrator-sessions.ts` (`OrchestratorSessionStore`, `plan`, `save`), `apps/daemon/src/orchestrator-handoff.ts` (`sessionTranscript`, `stageHandoff`), `apps/daemon/src/timeout-resume.ts` (`timedOutRunBefore`, `planTimeoutResume`, `timeoutResumeLines`), `apps/daemon/src/service.ts` (`resumeRejected`, `RESUME_REJECTED`, `executeWithSession`, `executeResumable`)

## Images

- The default image is `image` (default `sacty-agent:1.18.1`). Per-language images are `images.<name>` (the tag defaults to `sacty-agent-<name>:1.18.1`).
- The name decides which image is used.
  - No name, or the name `default`: the default image.
  - A name in `images`: that entry.
  - An unknown name: the run stops (`image.unknown`).
- Steps run on the task image (one image, the same for every step). A person can change it on the task detail, and the new image is used from the next run of every step ("Changing the task image" in [Tasks and steps](tasks-and-steps.en.md)). A task whose activity from an older version has per-step images runs each step on that step's image when it has no task image.
- `sacty image build [<name>...]` runs `docker build` on `packages/cli/docker/Dockerfile`. Without names it builds the default and everything in `images`. If there is no config file it builds with the defaults; if there is any other error it builds nothing.
  - Once everything is built, it cleans up old versions (`pruneOldImages`).
    For `sacty-agent` and `sacty-agent-<name>` images with `X.Y.Z` tags, it keeps the two newest versions of each name and removes the rest without forcing.
    It does not remove images that `image` or `images.*.image` point to, or images with other tags or names.
    Image layers also stay in the build cache, so it also removes build cache unused for more than 7 days.
    A cleanup failure does not fail `sacty image build`.
  - The base image (`BASE_IMAGE`) defaults to `node:26-bookworm-slim`. The default is pinned by the digest of the multi-arch index in addition to the tag (`node:26-bookworm-slim@sha256:…`; the default of `NODE_IMAGE` is the same). For Claude Code (`@anthropic-ai/claude-code@2.1.318`) and Codex (`@openai/codex@0.167.0`), the build copies `package.json` and `package-lock.json` of `packages/cli/docker/agent-cli` to `/opt/sacty/agent-cli` and installs them with `npm ci --omit=dev`, so the transitive dependencies follow the lockfile. `claude` and `codex` are links from `/opt/sacty/bin`, and the build puts `/opt/sacty/bin` at the front of `PATH` at this point (so the later `run` can call them). The lockfile has no source URLs (`resolved`): packages come from the configured registry and are checked with `integrity` (the same lockfile works with a private registry). With `NPM_VERSION` (`image_build.npm_version`), the build then installs `npm install -g npm@<version>`. It ends with `USER node` and `WORKDIR /workspace`.
  - A per-language image uses the base image's Node.js if it has Node.js 18 or later and npm. Otherwise the build copies Node.js from `node_image` (or `image_build.base_image` if that is unset, or `node:26-bookworm-slim` if that is unset too). If there is no `node` user, the build creates it, with `HOME=/home/node` and `GOPATH=/home/node/go`. With `maven_mirror`, the build writes Maven's `settings.xml` and a Gradle init script.
  - The build installs `packages` as root with whichever of dnf, microdnf, yum, or apt-get the base image has, and `enable_repos` becomes its `--enablerepo` (fails with apt-get). It executes `run` as root from top to bottom (with `-o pipefail` if bash is available).
  - The build reads the npm token (`image_build.npm_token`) only during the build through a BuildKit secret (`npmrc`), and the token does not remain in the image. The npm settings that remain in the image (`registry` and `npm_config`) are passed through a separate secret.
  - Secret contents are not part of BuildKit's cache key. So sacty passes hashes of the contents (`NPM_CONFIG_HASH`, `SACTY_SETUP_HASH`) as build-args, and the image is rebuilt when they change.
  - In place of `gh`, the build places `packages/cli/docker/gh-shim.cjs` at `/opt/sacty/bin/gh` after `run`, at the front of `PATH` (it is used before a `gh` in the base image; `gh` inside `run` is the base image's).
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
    - It checks them against the SHA-256 pinned in the script per version and architecture (it does not fetch the hash file of the release), and a mismatch stops the build. For other reasons (cannot fetch, no `curl`, an unsupported architecture, cannot extract, cannot place it in `/usr/local/bin`), it warns and continues (without reporting it as installed).
  - `drawio` (`drawio-shim.cjs`) starts `/opt/drawio/drawio` with `--no-sandbox --disable-gpu` and the arguments it received.
    - Without `DISPLAY`, it starts a virtual display on a free number with `Xvfb -displayfd`, and stops it and waits for it to end when done (`SIGKILL` if it has not ended in 3 seconds). If the virtual display cannot be started, it prints the reason and exits with code 1.
    - It decodes standard error as UTF-8, splits it into lines, and removes the `ERROR:dbus/` and `ERROR:bus.cc` lines. It returns the exit code unchanged.
    - On SIGINT or SIGTERM, it sends the same signal to draw.io while draw.io is running. If draw.io has not started yet (such as while waiting for Xvfb to start), it stops Xvfb and waits for it to end. It then exits with 128 plus the signal number.
- The image's `env` is passed to the agent containers that run on that image (including the final review that runs the tests).

Code: `apps/daemon/src/config.ts` (`resolveImage`, `languageImageTag`, `DEFAULT_IMAGE`), `apps/daemon/src/image.ts` (`buildImage`, `imageBuildArgs`, `imageBuildSettings`, `imageBuildTargets`), `packages/cli/docker/Dockerfile`, `packages/cli/docker/agent-cli/package.json`, `packages/cli/docker/agent-cli/package-lock.json`, `packages/cli/docker/install-tools.sh`, `packages/cli/docker/install-drawio.sh`, `packages/cli/docker/install-security-tools.sh`, `packages/cli/docker/drawio-shim.cjs`

## Running tests

- sacty does not run the test command in a container of its own.
  - The Goal Guardian runs the tests for verifying the implementation inside the final review.
  - The Reproduce step's agent runs the reproduction test.
  - The Goal Guardian and the Reproduce step's agent report the result (command, exit code, and an excerpt) ([Tasks and steps](tasks-and-steps.en.md#verifying-the-implementation)).
  - The PR review step's agent fetches dependencies in the copy of the PR's code and runs verification such as formatters, linters, type checks, tests, and builds. For verification that could not run, it writes the command and why it stopped in the review body ([Tasks and steps](tasks-and-steps.en.md#pr-review-only-tasks)).
- The final review runs on the task image (for per-step images in activity from an older version, the Implementation step's image, or the Reproduce step's if absent), with that image's `env`. It runs on a disposable copy of the implemented working tree (the copy's .git is a copy of the saved metadata). If the implementation uses services, it is connected to them ([Services](services.en.md)).
- The test code (in a PR review, including the PR's dependency install scripts and tests) runs inside the container of the agent that runs the tests. So, as in any other agent run, it can reach the agent's authentication values in the container. In runs that use the gateway, it can also reach the per-run gateway token.
- The time limit is that of the role running the tests ("Container" above; without a role override, `agent_minutes` + `test_minutes`).

Code: `apps/daemon/src/service.ts` (`verify`, `runGuardian`), `apps/daemon/src/prompts.ts` (`reviewVerificationLines`), `apps/daemon/src/run-timeouts.ts` (`agentTimeoutMs`, `TEST_RUNNING_ROLES`)
