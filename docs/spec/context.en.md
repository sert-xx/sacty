[日本語](context.md) | **English**

# Context composition

The rules, skills, MCP servers, external PFs, and agent settings (the context) given to a step's agent are composed by stacking layers, and on every run they are placed
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

Code: `apps/daemon/default-context/skills/review/review-dispatch/SKILL.md`, `apps/daemon/default-context/skills/review/review-dispatch/references/verification-run.md`, `apps/daemon/default-context/skills/review/review-execution/references/X-2.md`, `apps/daemon/default-context/agents/codex/config.toml`

## Default writing skill

The default context has `writing`, which sets how to write text that people read: PR descriptions, review comments, comments on Issues and PRs, requirements and designs, investigation results, and reports.
The order of precedence is the requester's instructions, then the target repository's writing rules (AGENTS.md, CONTRIBUTING, the docs policy, and so on), then this skill.
In Japanese, a line break follows each "。"; in English, no line break follows a period.
Where a line break would break the rendering, such as code blocks, table cells, and the first line of a commit message, no line break is added.
The default `git`, `review-dispatch`, and `review-execution` skills refer to this skill where they write text.

Code: `apps/daemon/default-context/skills/writing/SKILL.md`, `apps/daemon/default-context/skills/writing/references/layout.md`, `apps/daemon/default-context/skills/writing/references/sentences.md`

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
| Claude Code | `CLAUDE.md` (rules), `settings.json` (composed settings), `mcp.json` (`{ "mcpServers": … }`; the command type has `command`, `args`, `env`; the URL type has `type: "http"`, `url`, `headers`) |
| Codex | `AGENTS.md` (rules and the skill list `- <name>：<description>（<location>）`), `config.toml` (composed settings and `[mcp_servers."<name>"]`; the URL type has `url`, `http_headers`, `env_http_headers`) |

- MCP secrets are written in the files as environment variables `SACTY_MCP_SECRET_<number>`, and the values are passed as container environment variables (retrieved on the host).
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
comments and do not change the default context). If the same path or `rules` exists, it writes nothing and stops unless `--force` is given. If an intermediate directory
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
