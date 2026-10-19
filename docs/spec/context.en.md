[日本語](context.md) | **English**

# Context composition

The rules, skills, MCP servers, external PFs, and agent settings (the context) given to a step's agent and the Orchestrator are composed by stacking layers, and on every run they are placed
in the Claude Code or Codex config location. The layers are sacty's default context and the context repository specified for the project (along with its
inheritance chain).

Related ADRs: [Start command-type MCP servers in the context's mcp.yaml on the host by default and route them through the gateway](../adr/20261014-0927-context-command-mcp-on-host.md), [Bundle a skill for writing text in the default context, and add a line break after "。" only in Japanese](../adr/20261015-0844-default-writing-skill.md)

## Layers

- From the top: sacty's default context (`apps/daemon/default-context/`; the bundled copy is read without fetching. Its name is `sacty-default`, and the SHA-256 of its contents
  is recorded instead of a commit) → the topmost ancestor in the context repository's inheritance chain → … → the repository the project specified (the bottom).
- Inheritance: write `<URL>[#<ref>]` in `extends` of `sacty-context.yaml` (split at the last `#`). If the same `repo#ref` appears twice, composition stops with `context.cycle`;
  if the depth reaches `MAX_CONTEXT_DEPTH` (10), it stops with `context.tooDeep`.
- The project's specification (`ContextSource`) is `repo` (a git URL or a local path, up to 500 characters) and `ref` (a branch or tag; the default branch if omitted).
- Fetches are not cached. Each composition runs `git clone --depth 1 [--branch <ref>]` into a temporary directory (`sacty-context-*`), which is deleted after use.
  The environment passed to git is only `GIT_TERMINAL_PROMPT=0`, the host's `PATH`, `HOME`, `SSH_AUTH_SOCK`, `TMPDIR`, and `LANG`, and authentication.
- Authentication: for an HTTPS URL, if the project has selected a GitHub account for that host, or the project's targets include the same host, the gh
  token is passed through the `http.https://<host>/.extraheader` setting (environment variables `GIT_CONFIG_*`). If an account is required but none is selected, composition stops
  (`github.accountRequired`). SSH, local paths, and other servers use the host's git authentication. The token is hidden in error text.

Code: `apps/daemon/src/context.ts` (`loadLayers`, `loadDefaultContext`, `resolveContext`, `parseExtends`, `GitContextFetcher`, `MAX_CONTEXT_DEPTH`, `DEFAULT_CONTEXT_REPO`), `apps/daemon/src/service.ts` (`gitAuth`, `githubToken`), `apps/daemon/src/gh.ts` (`gitAuthEnv`), `packages/core/src/projects.ts` (`ContextSource`)

## Default review skills

The default context has `review-dispatch` and `review-execution`, which split a review by viewpoint. Before starting the reviewers, the parent runs, once and without changing the target, the verification defined by the target project: formatter, linter, type check, tests, and build. It saves the results outside the workspace as a summary and logs, and passes the same summary to each reviewer. The cross-cutting viewpoint X-1 is always started, and if there are verification or CI results, X-2 analyzes the failed, warned, and unrun checks. A re-review verifies the new target again.

In the default Codex settings, the limit on reviewers open at the same time is `max_threads = 16`, and the depth that keeps reviewers from starting more agents is `max_depth = 1`.

The tier of the subagent that runs a reviewer (`lite`, `entry`, `standard`, `advanced`, `ultimate`) is decided per viewpoint in "Tier per viewpoint" of the viewpoint catalog. The parent starts the reviewer by naming the subagent of that tier (the definition sacty places under `agents/` in the config location; see "Files placed for a run" below); for a tier without a definition, it starts with the parent's model and writes "same as the parent" in the "tier" column of the launch table.

For a PR review (the `pr-review` flow) and posting to a PR with the default `git` skill, if the requester (the calling tool or prompt) decides the output format and how to post, the agent follows it and does not post by itself. Only when it does not (a person asked in a conversation to post) does the agent post one `COMMENT` review following the `git` procedure. Findings start with `[要修正]` or `[提案]`, and there are three verdicts: changes required, suggestions only (OK to merge), and no findings. For a finding with no line in the diff to attach to, the agent asks how to handle it before posting if there is someone to ask (a person who asked in a conversation), and otherwise writes it in the summary without stopping. Before reviewing, the parent checks the reviews already on the PR (findings by other reviewers and the author's replies; what the requester passed, or fetched from the PR only when readable), does not repeat a problem already raised at the same place even for `must` (dismissed with the reason "already raised in an existing review" and not counted in the verdict), and writes briefly in the summary how many were left out. Existing findings are not given to the viewpoint agents; their count is kept in `existing_reviews` of the aggregation record. sacty's PR review tasks decide the output format in the instructions, and sacty does the posting ([Tasks and steps](tasks-and-steps.en.md#pr-review-only-tasks)). For documents shown in the PR description or the request (such as a design written outside Git), the parent sorts each into a review target or evidence from the title, description, and diff. The parent fetches both in full and keeps copies outside the workspace; target documents count when deciding the main target type and are given to the viewpoint agents as targets (not left out as outside the diff). Documents that cannot be fetched are listed in the review's scope, and if the document chosen as the main target cannot be read, the review is treated as not completed. The sorting is kept in `linked_docs` in the aggregation record. The default skills apply to repositories of any language or field and to use outside sacty, so they are not written for sacty only.

Code: `apps/daemon/default-context/skills/review/review-dispatch/SKILL.md`, `apps/daemon/default-context/skills/review/review-dispatch/references/pr-review.md`, `apps/daemon/default-context/skills/review/review-dispatch/references/linked-docs.md`, `apps/daemon/default-context/skills/git/references/pr-review-posting.md`, `apps/daemon/default-context/skills/review/review-dispatch/references/verification-run.md`, `apps/daemon/default-context/skills/review/review-execution/references/X-2.md`, `apps/daemon/default-context/agents/codex/config.toml`

## Default writing skill

The default context has `writing`, which sets how to write text that people read: PR descriptions, review comments, comments on Issues and PRs, requirements and designs, investigation results, and reports.
The order of precedence is the requester's instructions, then the target repository's writing rules (AGENTS.md, CONTRIBUTING, the docs policy, and so on), then this skill.
In Japanese, a line break follows each "。"; in English, no line break follows a period.
Where a line break would break the rendering, such as code blocks, table cells, and the first line of a commit message, no line break is added.
The default `git`, `review-dispatch`, and `review-execution` skills refer to this skill where they write text.

Code: `apps/daemon/default-context/skills/writing/SKILL.md`, `apps/daemon/default-context/skills/writing/references/layout.md`, `apps/daemon/default-context/skills/writing/references/sentences.md`

## Default requirements skill

The default context has `ears-requirements`, which writes the acceptance criteria of requirements in the EARS (Easy Approach to Requirements Syntax) patterns (PBI-122).
The patterns are ubiquitous, event-driven, state-driven, unwanted behavior, and optional, plus their combination, in Japanese and English.
Each sentence states one requirement with an ID (such as `R-1`), and its response is written so that a third party can decide pass or fail.
The order of precedence is the requester's instructions, then the target repository's rules for requirements, then this skill.
The instructions of the Requirements step ask for acceptance criteria in EARS and to follow this skill when it is present ([Tasks and steps](tasks-and-steps.en.md)).
The instructions also state the patterns, IDs, and how to write unwanted behavior, so the format is clear even when a project's context removes the skill.
The default skills apply to repositories of any language or field and to use outside sacty, so they are not written for sacty only.

Related ADR: [Have the requirements acceptance criteria written in EARS and ship the default skill ears-requirements](../adr/20261017-0130-ears-requirements.md)

Code: `apps/daemon/default-context/skills/ears-requirements/SKILL.md`, `apps/daemon/default-context/skills/ears-requirements/references/patterns.md`, `apps/daemon/src/prompts.ts` (`earsLines`)

## Default memory skill

The default context has `memory`, a skill for reading the memories the audit registered (PBI-126).
It describes the locations (`/sacty-memory/project`, `/sacty-memory/repository`), how to read (open only the relevant ones from the index), and the order to follow
(the person's instructions → the context's and repository's rules → the actual repository → memories). The prompt of a run with memories mounted states the same way of reading ([Memory](memory.en.md)).
The default skills apply to repositories of any language or field, so they are not written for sacty only.

Code: `apps/daemon/default-context/skills/memory/SKILL.md`, `apps/daemon/src/memory.ts` (`memoryPromptLines`)

## Default plan-selection skill

The default context has `plan-steps`, a skill for the Orchestrator to choose the plan of steps and answer in the requested JSON form (PBI-146).
It describes how to compare the candidates (in the order purpose, deliverable, scope of change, size; no unconditional default or catch-all), how to write the reason,
and the rules for the answer JSON (keep the heading and item names as given, do not copy the annotations of the format example, omit unneeded items by key).
Before output, the answer is written to a file and checked with `jq` (or `python3` or `node` when absent) for syntax and shape (the heading and required items),
fixed until the check passes, and then output exactly once at the end of the text (`references/json-check.md`).
The Orchestrator prompt asks to follow this skill and, so that the minimum is known even when a project context removes the skill, also states checking until it passes and
outputting once ([Tasks and steps](tasks-and-steps.en.md#orchestrator)).
Since the skill covers how sacty chooses steps, it may name sacty, but it is not tied to a particular language toolchain.

Related ADR: [オーケストレーターにもコンテキストを渡し、工程の選択を既定のスキル plan-steps にして答えの JSON を検査させる](../adr/20261019-1512-orchestrator-plan-steps-skill.md)

Code: `apps/daemon/default-context/skills/plan-steps/SKILL.md`, `apps/daemon/default-context/skills/plan-steps/references/json-check.md`, `apps/daemon/src/prompts.ts` (`planAnswerLines`, `PLAN_SKILL`)

## Context repository files

Only `sacty-context.yaml`, `mcp.yaml`, `platforms.yaml`, `rules.md`, `rules/`, `skills/`, and `agents/` are read (`README.md` is not).
If any of these contains something that is not a regular file or directory (a symbolic link, for example), composition stops (`context.notPlainFile`). A missing YAML file means
the defaults; an unreadable one stops with `context.fileUnreadable`, and a malformed one stops with `context.fileInvalid` (naming the layer, file, and field).

| File | Contents |
| --- | --- |
| `rules.md` or `rules/*.md` | Rules. If `rules.md` exists, only it is used; otherwise the `*.md` files directly under `rules/` are concatenated in name order. Each layer is prefixed with `<!-- sacty context: <layer> -->` and the layers are concatenated from the top |
| `skills/` | A directory with `SKILL.md` is one skill (its name is the directory name). A directory without one is treated as a group and searched. If names collide within the same layer, the first one is used with a warning |
| `mcp.yaml` | `servers.<name>` (`^[A-Za-z0-9_-]+$`). Either the command type (`command`, `args`, `env`, `via_gateway` (default `true`)) or the URL type (`url`, `headers`, `via_gateway` (default `true`)). Common to both: `startup_timeout_sec` (1 to 3600) and `tool_timeout_sec` (1 to 86400). Values are a string or `{ secret, prefix }`. Strings cannot contain `${` |
| `platforms.yaml` | `platforms.<name>`. The fields are the same as `gateway.platforms` ([Gateway](gateway.en.md)) |
| `sacty-context.yaml` | `extends`, `locked`, and `remove` (each a list of names for `skills`, `mcp`, and `platforms`) |
| `agents/codex/config.toml`, `agents/claude/settings.json` | Agent settings. Other files under `agents/codex/` and `agents/claude/` are copied by path |

Code: `apps/daemon/src/context.ts` (`CONTEXT_ENTRIES`, `assertPlainEntries`, `readYaml`, `layerRules`, `layerSkills`, `McpFile`, `McpServer`, `McpValue`, `PlatformsFile`, `ContextManifest`, `AGENT_SETTINGS_FILES`)

## Composition rules

- Skills, MCP, and PFs are processed by name, layer by layer from the top. Within one layer: (1) the layer's `remove` is applied (if a higher layer has it `locked`, it is kept with
  the warning `context.lockedRemove`); (2) the layer's entries are added (the same name is overwritten by the lower layer; for a `locked` name, the higher one is kept with the warning
  `context.lockedOverride`); (3) the layer's `locked` is registered.
- For agent settings, tables are merged key by key, and anything else (including arrays) is replaced by the lower layer's value. Only Claude's `permissions.allow`, `deny`, and `ask`
  are combined with duplicates removed.
- Fields sacty decides (Codex's `mcp_servers`, `model_provider`, `model_providers`, `approval_policy`, `sandbox_mode`, `profile`, and so on;
  Claude's `apiKeyHelper` and so on; variables in Claude's `env` for authentication, endpoints, and the config location, and names starting with `SACTY_`) are not used, with a warning
  (`context.reservedSetting`). `auth.json`, `AGENTS.md`, `CLAUDE.md`, `.credentials.json`, `.claude.json`, `mcp.json`, and
  `skills` under `agents/` are also not copied, with a warning.
- Tier subagent definitions (`agents/claude/agents/<tier>.md`, `agents/codex/agents/<tier>.toml`; `claude_<tier>` and `codex_<tier>` in
  [Configuration](configuration.en.md#agent-defaults-and-overrides)) are generated by sacty, so a layer file at such a path is not copied, with a warning (`context.reservedTierFile`), whether or not
  that tier is placed (if it stayed, a skill starting a subagent by tier name would use the layer's definition). Codex uses the `name` inside the file as the role name,
  so an `agents/codex/agents/*.toml` whose `name` is a tier is not copied either, whatever its file name (`codexRoleName`; `name` is compared with surrounding whitespace removed, and an empty one is not a name. Only regular, non-link files (up to 256 KB) inside the layer's
  agent settings directory are read; when `config_file` points outside it, to an absolute path, or to a non-regular file, it is not read and the declaration is kept. An unreadable file is copied as is).
  `agents.<tier>` in Codex's `config.toml` (a custom agent declaration, which is registered before the auto-discovered `agents/<tier>.toml`) and an `agents.<name>`
  whose `config_file` points to a definition whose `name` is a tier are also fields sacty decides and are not used, with a warning (`context.reservedSetting`;
  the other `agents` fields are kept).
- The host's MCP servers (`gateway.mcp_servers`) are added. If one has the same name as a layer's MCP, the host's is used with a warning (`context.hostMcpOverride`).
- PFs are combined with the host's `gateway.platforms`. For the same name, the host's is used with a warning (`context.hostPlatform`).
- Warnings do not stop the step. The composition result (layers, warnings, and a PF summary) is recorded in `ContextResolved` for every step run. Fetch failures and malformed files
  fail the run and pause the task.

Code: `apps/daemon/src/context.ts` (`composeContext`, `mergeNamed`, `mergeSettings`, `RESERVED_SETTINGS`, `RESERVED_FILES`, `routeMcp`), `apps/daemon/src/platforms.ts` (`mergePlatforms`), `apps/daemon/src/service.ts` (`runContext`)

## Files placed for a run

In the config location (`/tmp/sacty-claude-config` for Claude Code, `/.codex` for Codex), files are placed in this order: the layers' agent files → skills (`skills/<name>/…`) →
files sacty generates (for the same path, the later one overwrites).

| runtime | Files sacty generates |
| --- | --- |
| Claude Code | `CLAUDE.md` (rules), `settings.json` (composed settings), `mcp.json` (`{ "mcpServers": … }`; the command type has `command`, `args`, `env`; the URL type has `type: "http"`, `url`, `headers`), `agents/<tier>.md` (tier subagent definitions; `name`, `description`, `model`, and `effort` in the frontmatter) |
| Codex | `AGENTS.md` (rules and the skill list `- <name>：<description>（<location>）`), `config.toml` (composed settings and `[mcp_servers."<name>"]`; the URL type has `url`, `http_headers`, `env_http_headers`), `agents/<tier>.toml` (tier subagent definitions; `name`, `description`, `developer_instructions`, `model`, `model_reasoning_effort`) |

- Tier subagent definitions (PBI-119): of `claude_<tier>` and `codex_<tier>` among the usable agents (the defaults in `config/agents.yaml` with `agents` of `config.yaml`
  laid over them, that have an endpoint and a price; [Configuration](configuration.en.md#agent-defaults-and-overrides)), the ones with the same runtime as the step agent and the same
  authentication and endpoint (`auth`, `endpoint`, `via_gateway`) are placed under the name without the prefix (`selectTiers`, `tierFiles`). Ones that differ are not placed,
  and `agents.tierConnectionDiffers` is left as a note (the endpoint is built from the per-runtime `providers`, so tiers of the same runtime always match).
  Nothing is placed for a stub step. A tier without `reasoning_effort` (such as the default `claude_lite`) becomes a definition without it (the tool's default). The placed tiers (tier, agent name, model, reasoning effort) are recorded in `tiers` of `ContextResolved`, and the preview shows the same
  files (the parent for the preview is the `default_agent` of that runtime, otherwise the first of `step_agents` and `guardian_agent` with that runtime). `ContextResolved`
  is recorded with the `runId` of every run that receives a context: not only step runs but also the Orchestrator (PBI-146), the after-merge watch, operations, and exports (`contextResolved`).
  The cost of a run that placed tiers is recorded as estimated (`estimated`), because a reviewer may run with a model other than the parent's while the cost can only be
  computed from the parent's usage and unit prices ([Agent execution](agent-execution.en.md#authentication)).

- MCP secrets are written in the files as environment variables `SACTY_MCP_SECRET_<number>`, and the values are passed as container environment variables (retrieved on the host).
- Secrets in the layers' `mcp.yaml` and `platforms.yaml` have already been retrieved together with the other secrets at daemon startup, when secrets are retrieved again, and when the project is saved
  ([Secrets](secrets.en.md#retrieving-everything-at-startup)). Ones not retrieved yet (such as ones added to a layer later) are retrieved when used.
- A layer's MCP server with `via_gateway` set to `true` (the default) is replaced with a route through the gateway: the agent receives only
  `http://host.docker.internal:<port>/ctx-mcp/<name>` and an `Authorization` with the per-run token (`routeMcp`).
  - URL type: the gateway holds the original URL and headers (secrets in headers are retrieved on the host).
  - Command type: the gateway starts it on the host (see "Command-type MCP servers started on the host" below). Secrets in `env` are retrieved when it starts on the host
    and are not passed to the container.
  - With `via_gateway: false`, it starts inside the container (the URL type connects directly from the container). Secret values are passed to the container as environment variables.
  - Without a gateway, both start inside the container or connect directly.
- The host's MCP servers (`gateway.mcp_servers`) are passed as `/mcp/<name>` ([Gateway](gateway.en.md)).
- MCP timeouts: for Codex, they are written in `config.toml` under the same names. For Claude Code, `tool_timeout_sec` becomes each server's `timeout` (milliseconds), and
  only when `startup_timeout_sec` is set on any server, the global environment variable `MCP_TIMEOUT` is set to the maximum of the servers' values (30 seconds for servers that do not set it).
  If any is at or above the limit for the whole run (30 minutes), a warning is issued (`context.mcpTimeoutOverRun`).

Code: `apps/daemon/src/context.ts` (`planContext`, `codexServer`, `timeoutWarnings`, `routeMcp`, `McpServer`, `CLAUDE_MCP_CONFIG`, `CLAUDE_MCP_STARTUP_DEFAULT_SEC`, `GATEWAY_TOKEN_SECRET`), `apps/daemon/src/service.ts` (`contextContainerDir`, `mcpRouting`)

## Command-type MCP servers started on the host

Command-type MCP servers with `via_gateway` (default `true`) are started on the host by the gateway. Starting, readiness, restarting, relaying, and process records use
the same mechanism as the host's MCP servers ([Gateway](gateway.en.md)). Anyone who can edit the context repository can run commands on the host.

- Name isolation: the name inside the gateway (`ctx-<first 24 hex digits of SHA-256>`) is derived from the project and the contents (the name in `mcp.yaml`, `command`, `args`, `env`,
  timeouts, and the layer's repository, ref, and commit). Each run token is bound only to the names of that run's project, so runs of other
  projects cannot use it even if they know the name (404). Different contents under the same name never mix.
- Reuse: for the same project and the same contents, the same process is used across runs. If the contents change (including the layer's commit), it starts under a new name.
- Working directory: a copy of the repository of the layer that defined the server (`SACTY_HOME/context-mcp/layers/<project and commit identifier>-<random>`;
  `.git` is not copied). Fetched layers are deleted after the run, so the copy is made at lease time and deleted when nothing uses it anymore. A command with a relative path is looked up
  from the working directory, others from `PATH`; if not found, it becomes a reason (`context.mcpHostCommandMissing`) before starting.
- Lease and release: before a run, the servers that run uses are leased together (committed only once all are ready; if anything fails midway, the layers copied by that lease are
  deleted and the held state is unchanged. The prepared context is deleted too). Readiness is awaited for up to `max(120 seconds, startup_timeout_sec)`
  (`CONTEXT_MCP_READY_SEC`). If a server is not ready, which server (its name in `mcp.yaml` and its layer) is left in the context warnings and the run proceeds
  (for export, export to that destination stops). They are released when the run ends.
- Stopping: a server that no run is using anymore is stopped immediately if new contents are used for the same project and the same name (it has become stale), or otherwise
  30 minutes after its last use (checked every 60 seconds). Failures while stopping or deleting copies do not fail the lease or release; they are logged and
  retried later. When the daemon exits, all are stopped and the copies deleted, and at daemon startup the previous copies (`context-mcp/layers`) are deleted (leftover processes are stopped
  by the same cleanup as the host's MCP servers).
- Reasons (in the web UI, the activity log, and the 503 to the agent) show the name in `mcp.yaml`, the layer, and the project name, not the name inside the gateway
  (`name`, `from`, and `project` of `context.mcpHostUnavailable`, `context.mcpHostReadyTimeout`, and `context.mcpHostCommandMissing`; older records without `project`
  are shown without the project). Even if servers with the same layer and the same name exist in several projects, you can tell which one it is.
- Logs (start, not ready, stop, cleanup) also show the name in `mcp.yaml`, the project name and ID, and the layer, with the name inside the gateway alongside
  ("Host MCP servers" in [Gateway](gateway.en.md)).
- The layer shown in reasons and logs has credentials in the repository URL (`https://<user>:<token>@…`) hidden as `***` (`shownLayer`).
- The project name shown is the one at lease time. The name inside the gateway is derived from the project ID, so renaming the project does not restart the server.

Code: `apps/daemon/src/context-mcp.ts` (`ContextMcpServers`, `lease`, `prepare`, `sweep`, `copyLayer`, `forceRemove`, `shownLayer`, `CONTEXT_MCP_READY_SEC`), `apps/daemon/src/context.ts` (`routeMcp`, `HostedContextMcp`), `apps/daemon/src/host-mcp.ts` (`assertCommand`, `CommandNotFoundError`, `HostMcpContext`, `mcpLogName`), `apps/daemon/src/service.ts` (`runContext`, `mcpRouting`), `apps/daemon/src/main.ts`

## Template (sacty context init)

Creates `README.md`, `rules.md`, `skills/README.md`, `mcp.yaml`, `platforms.yaml`, `sacty-context.yaml`, and `agents/codex/config.toml` (their contents are only explanatory
comments and do not change the default context). `README.md` says that tier subagent definitions are generated by sacty, so placing them has no effect. If the same path or `rules` exists, it writes nothing and stops unless `--force` is given. If an intermediate directory
is not a directory, it stops even with `--force`.

Code: `apps/daemon/src/context-template.ts` (`CONTEXT_TEMPLATE_FILES`, `initContextRepo`)

## Preview

- `GET /api/projects/:id/context-preview?runtime=` (saved settings) and `POST /api/projects/:id/context-preview` (`{ runtime, definition? }`;
  settings being edited). `runtime` defaults to `claude-code`. It performs the same composition as a run but writes no files and leaves nothing in the activity log. Fetch and settings errors
  return 200 with `{ error }`.
- The result contains the layers, the files to place (up to 256KB per file and 8MB in total; binary contents are not shown), MCP (where each connects: `direct`, `gateway`, `host`, or `hostCommand` (the command type started on the host: command, arguments, `env` references, and which layer's copy it runs in)),
  skills, rules, effects (`locked`, `remove`), secret references, environment variables, a summary of usable PFs, and warnings. For secrets, only the reference names are shown.
- `sacty context preview <project>`: queries the endpoint in `SACTY_HOME/daemon.json`. The project is an ID or a name. `--runtime`
  (`claude-code` | `codex`), `--json` (the API result as is), `--no-content` (omits file contents). Exit code 1 on error.
- When a project is saved with a context specified, the same composition is also tried and errors are returned (the project is still saved).

Code: `apps/daemon/src/server.ts` (`PreviewRequest`), `apps/daemon/src/service.ts` (`projectContextPreview`, `checkProjectContext`, `ContextPreviewView`), `apps/daemon/src/context.ts` (`previewContext`, `ContextPreview`, `PREVIEW_FILE_MAX_BYTES`, `PREVIEW_TOTAL_MAX_BYTES`), `packages/cli/src/context-preview.ts` (`fetchContextPreview`, `previewOutput`)
