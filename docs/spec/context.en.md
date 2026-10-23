[日本語](context.md) | **English**

# Context composition

The context is the rules, skills, MCP servers, external PFs, and agent settings given to a step's agent, information gathering, and the Orchestrator. sacty composes the context by stacking layers, and on every run places it in the Claude Code or Codex config location. The layers are sacty's default context and the context repository specified for the project (along with its inheritance chain).

Related ADRs: [Start command-type MCP servers in the context's mcp.yaml on the host by default and route them through the gateway](../adr/20261014-0927-context-command-mcp-on-host.md), [Bundle a skill for writing text in the default context, and add a line break after "。" only in Japanese](../adr/20261015-0844-default-writing-skill.md), [Allow the current contents of a local directory and a directory inside a monorepo as the context, and add relative paths to extends](../adr/20261022-0626-context-local-path-and-monorepo.md), [Fetch the submodules of a context repository so that skills and other items managed separately by an organization can be used without copying them](../adr/20261022-1503-context-submodules.md)

## Layers

Layers are stacked from the top, and a lower layer points to an upper one with `extends`.

![Context layers and inheritance](images/context-layers.en.svg)

- The layers, from the top, are as follows.
  1. sacty's default context (`apps/daemon/default-context/`). The bundled copy is read without fetching. Its name is `sacty-default`, and the SHA-256 of its contents is recorded instead of a commit.
  2. The topmost ancestor in the context repository's inheritance chain → …
  3. The repository the project specified (the bottom)
- The project's specification (`ContextSource`)
  - `repo`: a git URL or a local path (up to 500 characters). A local path is an absolute path or one starting with `~/` (`~` is the home directory).
  - `ref`: a branch or tag. If omitted, a git URL uses the default branch, and a local path uses the current contents of the directory.
  - `path`: a directory inside the repository (to make part of a monorepo a layer). A path relative to the repository root; `.` and `..` parts can't be written (`input.invalidContextPath`). If omitted, the repository root.
- A layer is shown as `<repo>//<path>#<ref>` (`path` and `ref` only when present). The activity log (`layers` of `ContextResolved`) records `repo`, `ref`, `path`, and `commit`.
- Inheritance: write one of the following in `extends` of `sacty-context.yaml`.
  - `<URL>[#<ref>]`: another repository (split at the last `#`).
  - `{ repo, ref, path }`: a directory inside another repository (`ref` and `path` are optional).
  - A relative path starting with `./` or `../`: a directory in the same repository and the same `ref`, seen from that layer's directory. If it points outside the repository, composition stops with `context.extendsOutside`.
  - A layer fetched with git (including a local path with a `ref`) can't extend a local path (`context.localExtendsFromRemote`). Local paths can be written only in the project's specification and in `extends` of a local path layer without a `ref` (a layer that reads the current contents).
  - If the same layer (`repo`, `path`, `ref`) appears twice, composition stops with `context.cycle`.
  - If the depth reaches `MAX_CONTEXT_DEPTH` (10), it stops with `context.tooDeep`.
- Fetches are not cached. Each composition places the layers in a temporary directory (`sacty-context-*`), which is deleted after use.
  - A git URL, and a local path with a `ref`: runs `git clone --depth 1 [--branch <ref>]`. Within one composition, the same `repo#ref` is fetched only once, and layers in different directories inside it use the same fetch (the same commit).
  - A local path without a `ref`: not fetched; the layer's directory (`<repo>/<path>`) is copied without `.git`. Copying and hashing run asynchronously, and files are read in chunks. If aborted (the time limit), they stop partway and composition stops with `context.copyAborted`. It doesn't have to be managed with git, and it may have uncommitted changes. Links are copied as links without following them. The SHA-256 of all the copied contents is recorded instead of a commit.
  - Submodules
    - A layer fetched with git: the submodules related to the layer are fetched with `git submodule update --init [--recursive] --depth 1 -- <paths>`.
      - Those inside the layer's directory: fetched including nested ones (`--recursive`).
      - Those containing the layer's directory (the layer is inside a submodule): only that submodule is fetched, and the submodules inside it are selected again by the relative path to the layer (nested ones inside it unrelated to the layer are not fetched).
    - They are fetched at the commits the fetched commit points to, so only the fetched repository's commit is recorded. Submodules unrelated to the layer (such as an app's in a monorepo) are not fetched. They are fetched only once per layer directory in the same fetch.
    - Submodules on a local path (the file protocol) are not fetched (`protocol.file.allow=never`), so that the contents of a fetched commit can't make sacty read host directories (the same as local paths in `extends`).
    - Authentication uses the same environment variables as for the repository. The gh token (`http.https://<host>/.extraheader`) is passed only when the repository has an HTTPS URL, and it works only for submodules with an HTTPS URL on the same host. Submodules with an SSH URL or on another host use the host's git authentication (`SSH_AUTH_SOCK` for SSH). If they can't be fetched, composition stops with `context.fetchFailed` (git's error text is passed as is).
    - A local path without a `ref`: if a submodule under the layer's directory (nested ones too) isn't checked out (the submodule has no `.git`), composition stops with `context.submoduleNotCheckedOut`. sacty doesn't change the host directory, so it doesn't check them out itself. A directory not managed with git (`git ls-files` fails) is treated as having no submodules.
    - The contents of submodules stop on symbolic links, like other files.
  - If the layer's directory doesn't exist or has a symbolic link along the way, composition stops with `context.pathMissing`.
  - The environment passed to git is only `GIT_TERMINAL_PROMPT=0`, the host's `PATH`, `HOME`, `SSH_AUTH_SOCK`, `TMPDIR`, and `LANG`, and authentication.
- Authentication
  - For an HTTPS URL, sacty passes the gh token through the `http.https://<host>/.extraheader` setting (environment variables `GIT_CONFIG_*`) if either of the following holds.
    - The project has selected a GitHub account for that host.
    - The project's targets include the same host.
  - If an account is required but none is selected, composition stops (`github.accountRequired`).
  - SSH, local paths, and other servers use the host's git authentication.
  - The token is hidden in error text.

Code: `apps/daemon/src/context.ts` (`loadLayers`, `loadDefaultContext`, `resolveContext`, `parseExtends`, `extendsRef`, `localContextDir`, `layerDir`, `copyLocalLayer`, `hashTree`, `assertSubmodulesCheckedOut`, `gitlinks`, `submoduleInLayer`, `GitContextFetcher`, `MAX_CONTEXT_DEPTH`, `DEFAULT_CONTEXT_REPO`), `apps/daemon/src/service.ts` (`gitAuth`, `githubToken`), `apps/daemon/src/gh.ts` (`gitAuthEnv`), `packages/core/src/projects.ts` (`ContextSource`, `ContextPath`, `contextLabel`)

## Default review skills

The default context has `review-dispatch` and `review-execution`, which split a review by viewpoint. The default skills apply to repositories of any language or field and to use outside sacty, so they are not written for sacty only.

Before starting the reviewers, the parent runs, once and without changing the target, the verification defined by the target project: formatter, linter, type check, tests, and build. It saves the results outside the workspace as a summary and logs, and passes the same summary to each reviewer. The cross-cutting viewpoint X-1 is always started, and if there are verification or CI results, X-2 analyzes the failed, warned, and unrun checks. A re-review verifies the new target again.

In the default Codex settings, the limit on reviewers open at the same time is `max_threads = 16`, and the depth that keeps reviewers from starting more agents is `max_depth = 1`.

The tier of the subagent that runs a reviewer (`lite`, `entry`, `standard`, `advanced`, `ultimate`) is decided per viewpoint in "Tier per viewpoint" of the viewpoint catalog. The parent starts the reviewer by naming the subagent of that tier (the definition sacty places under `agents/` in the config location; see "Files placed for a run" below). For a tier without a definition, the parent starts the reviewer with its own model and writes "same as the parent" in the "tier" column of the launch table.

### PR review and posting

A PR review (the `pr-review` flow) and posting to a PR with the default `git` skill work as follows.

- If the requester (the calling tool or prompt) decides the output format and how to post, the agent follows it and does not post by itself. sacty's PR review tasks decide the output format in the instructions, and sacty does the posting ([Tasks and steps](tasks-and-steps.en.md#pr-review-only-tasks)).
- Only when the requester does not (a person asked in a conversation to post) does the agent post one `COMMENT` review following the `git` procedure.
  - Findings start with `[要修正]` or `[提案]`.
  - There are three verdicts: changes required, suggestions only (OK to merge), and no findings.
  - For a finding with no line in the diff to attach to, the agent asks how to handle it before posting if there is someone to ask (a person who asked in a conversation). Otherwise it writes the finding in the summary without stopping.
- Existing reviews
  - Before reviewing, the parent checks the reviews already on the PR (findings by other reviewers and the author's replies). It uses what the requester passed, or fetches them from the PR only when readable.
  - The parent does not repeat a problem already raised at the same place, even for `must`. It dismisses the finding with the reason "already raised in an existing review" and does not count it in the verdict.
  - It writes briefly in the summary how many were left out.
  - Existing findings are not given to the viewpoint agents; their count is kept in `existing_reviews` of the aggregation record.
- Documents shown in the PR description or the request (such as a design written outside Git)
  - The parent sorts each into a review target or evidence from the title, description, and diff.
  - The parent fetches both in full and keeps copies outside the workspace.
  - Target documents count when deciding the main target type and are given to the viewpoint agents as targets (not left out as outside the diff).
  - Documents that cannot be fetched are listed in the review's scope. If the document chosen as the main target cannot be read, the review is treated as not completed.
  - The sorting is kept in `linked_docs` in the aggregation record.

Code: `apps/daemon/default-context/skills/review/review-dispatch/SKILL.md`, `apps/daemon/default-context/skills/review/review-dispatch/references/pr-review.md`, `apps/daemon/default-context/skills/review/review-dispatch/references/linked-docs.md`, `apps/daemon/default-context/skills/git/references/pr-review-posting.md`, `apps/daemon/default-context/skills/review/review-dispatch/references/verification-run.md`, `apps/daemon/default-context/skills/review/review-execution/references/X-2.md`, `apps/daemon/default-context/agents/codex/config.toml`

## Default writing skill

The default context has `writing`, which sets how to write text that people read: PR descriptions, review comments, comments on Issues and PRs, requirements and designs, investigation results, and reports. The order of precedence is the requester's instructions, then the target repository's writing rules (AGENTS.md, CONTRIBUTING, the docs policy, and so on), then this skill.

In Japanese, a line break follows each "。"; in English, no line break follows a period. Where a line break would break the rendering, such as code blocks, table cells, and the first line of a commit message, no line break is added. The default `git`, `review-dispatch`, and `review-execution` skills refer to this skill where they write text.

Code: `apps/daemon/default-context/skills/writing/SKILL.md`, `apps/daemon/default-context/skills/writing/references/layout.md`, `apps/daemon/default-context/skills/writing/references/sentences.md`

## Default requirements skill

The default context has `ears-requirements`, which writes the acceptance criteria of requirements in the EARS (Easy Approach to Requirements Syntax) patterns (PBI-122). The patterns are ubiquitous, event-driven, state-driven, unwanted behavior, and optional, plus their combination, in Japanese and English. Each sentence states one requirement with an ID (such as `R-1`), and its response is written so that a third party can decide pass or fail. The order of precedence is the requester's instructions, then the target repository's rules for requirements, then this skill.

The instructions of the Requirements step ask for acceptance criteria in EARS and to follow this skill when it is present ([Tasks and steps](tasks-and-steps.en.md)). The instructions also state the patterns, IDs, and how to write unwanted behavior, so the format is clear even when a project's context removes the skill. The default skills apply to repositories of any language or field and to use outside sacty, so they are not written for sacty only.

Related ADR: [Have the requirements acceptance criteria written in EARS and ship the default skill ears-requirements](../adr/20261017-0130-ears-requirements.md)

Code: `apps/daemon/default-context/skills/ears-requirements/SKILL.md`, `apps/daemon/default-context/skills/ears-requirements/references/patterns.md`, `apps/daemon/src/prompts.ts` (`earsLines`)

## Default memory skill

The default context has `memory`, a skill for reading the memories the audit registered (PBI-126). The skill describes the following.

- The locations (`/sacty-memory/project`, `/sacty-memory/repository`)
- How to read: open only the relevant ones from the index.
- The order to follow: the person's instructions → the context's and repository's rules → the actual repository → memories

The prompt of a run with memories mounted states the same way of reading ([Memory](memory.en.md)). The default skills apply to repositories of any language or field, so they are not written for sacty only.

Code: `apps/daemon/default-context/skills/memory/SKILL.md`, `apps/daemon/src/memory.ts` (`memoryPromptLines`)

## Default plan-selection skill

The default context has `plan-steps`, a skill for the Orchestrator to choose the plan of steps and answer in the requested JSON form (PBI-146). The skill describes the following.

- How to compare the candidates: in the order purpose, deliverable, scope of change, size. No unconditional default or catch-all.
- How to write the reason
- The rules for the answer JSON: keep the heading and item names as given, do not copy the annotations of the format example, omit unneeded items by key.
- Checking the answer (`references/json-check.md`): before output, the answer is written to a file and checked with `jq` (or `python3` or `node` when absent) for syntax and shape (the heading and required items). It is fixed until the check passes, and then output exactly once at the end of the text.

The Orchestrator prompt asks to follow this skill. So that the minimum is known even when a project context removes the skill, the prompt also states checking until it passes and outputting once ([Tasks and steps](tasks-and-steps.en.md#orchestrator)). Since the skill covers how sacty chooses steps, it may name sacty, but it is not tied to a particular language toolchain.

Related ADR: [オーケストレーターにもコンテキストを渡し、工程の選択を既定のスキル plan-steps にして答えの JSON を検査させる](../adr/20261019-1512-orchestrator-plan-steps-skill.md)

Code: `apps/daemon/default-context/skills/plan-steps/SKILL.md`, `apps/daemon/default-context/skills/plan-steps/references/json-check.md`, `apps/daemon/src/prompts.ts` (`planAnswerLines`, `PLAN_SKILL`)

## Default diagram skill

The default context has `drawio`, a skill for making draw.io diagrams (`.drawio`, including export to PNG, SVG, and PDF).

- Its contents are draw.io's official skill (`plugins/claude-code/skills/drawio/SKILL.md` of `jgraph/drawio-mcp`; the one for Codex has the same content; Apache-2.0). It is placed unmodified, together with its license (`LICENSE`).
- The imported version is `307725c331847c15bf5ddeef64a9c8434a30fadf` of `jgraph/drawio-mcp`, and a test checks the SHA-256 of SKILL.md.
- The skill writes diagrams as Mermaid or draw.io XML, and uses the image's `drawio` ([Agent execution](agent-execution.en.md#images)) for converting Mermaid, ELK layouts, and export. Without `drawio`, it writes a `.drawio` in XML.
- The skill fetches the detailed Mermaid and XML references from `raw.githubusercontent.com` at run time (if unreachable, it writes with the content of SKILL.md only).

Related ADR: [エージェントのイメージに作業用の CLI と draw.io の CLI を入れ、draw.io の公式のスキルを既定のスキルにする](../adr/20261022-0115-agent-image-tools-and-drawio.md)

Code: `apps/daemon/default-context/skills/drawio/SKILL.md`, `apps/daemon/default-context/skills/drawio/LICENSE`, `apps/daemon/src/default-skills.test.ts`

## Context repository files

Only `sacty-context.yaml`, `mcp.yaml`, `platforms.yaml`, `rules.md`, `rules/`, `skills/`, and `agents/` are read (`README.md` is not).

- If any of these contains something that is not a regular file or directory (a symbolic link, for example), composition stops (`context.notPlainFile`).
- A missing YAML file means the defaults.
- An unreadable one stops with `context.fileUnreadable`, and a malformed one stops with `context.fileInvalid` (naming the layer, file, and field).

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

The composition flows as follows (the detailed rules are in the list below).

![How a context is composed](images/context-merge.en.svg)

- Skills, MCP, and PFs are processed by name, layer by layer from the top. Within one layer, the steps are as follows.
  1. The layer's `remove` is applied. If a higher layer has it `locked`, it is kept with the warning `context.lockedRemove`.
  2. The layer's entries are added. The same name is overwritten by the lower layer. For a `locked` name, the higher one is kept with the warning `context.lockedOverride`.
  3. The layer's `locked` is registered.
- For agent settings, tables are merged key by key, and anything else (including arrays) is replaced by the lower layer's value. Only Claude's `permissions.allow`, `deny`, and `ask` are combined with duplicates removed.
- Fields sacty decides are not used, with a warning (`context.reservedSetting`).
  - Codex's `mcp_servers`, `model_provider`, `model_providers`, `approval_policy`, `sandbox_mode`, `profile`, and so on
  - Claude's `apiKeyHelper` and so on
  - Variables in Claude's `env` for authentication, endpoints, and the config location, and names starting with `SACTY_`
- `auth.json`, `AGENTS.md`, `CLAUDE.md`, `.credentials.json`, `.claude.json`, `mcp.json`, and `skills` under `agents/` are also not copied, with a warning.
- sacty generates tier subagent definitions (`agents/claude/agents/<tier>.md`, `agents/codex/agents/<tier>.toml`; `claude_<tier>` and `codex_<tier>` in [Configuration](configuration.en.md#agent-defaults-and-overrides)).
  - A layer file at such a path is not copied, with a warning (`context.reservedTierFile`), whether or not that tier is placed. If it stayed, a skill starting a subagent by tier name would use the layer's definition.
  - Codex uses the `name` inside the file as the role name. So an `agents/codex/agents/*.toml` whose `name` is a tier is not copied either, whatever its file name (`codexRoleName`).
    - `name` is compared with surrounding whitespace removed, and an empty one is not a name.
    - Only regular, non-link files (up to 256 KB) inside the layer's agent settings directory are read. When `config_file` points outside it, to an absolute path, or to a non-regular file, it is not read and the declaration is kept. An unreadable file is copied as is.
  - The following are also fields sacty decides and are not used, with a warning (`context.reservedSetting`; the other `agents` fields are kept).
    - `agents.<tier>` in Codex's `config.toml` (a custom agent declaration, which is registered before the auto-discovered `agents/<tier>.toml`)
    - An `agents.<name>` whose `config_file` points to a definition whose `name` is a tier
- The host's MCP servers (`gateway.mcp_servers`) are added. If one has the same name as a layer's MCP, the host's is used with a warning (`context.hostMcpOverride`).
- PFs are combined with the host's `gateway.platforms`. For the same name, the host's is used with a warning (`context.hostPlatform`).
- Warnings do not stop the step. The composition result (layers, warnings, and a PF summary) is recorded in `ContextResolved` for every step run.
- Fetch failures and malformed files fail the run and pause the task.

Code: `apps/daemon/src/context.ts` (`composeContext`, `mergeNamed`, `mergeSettings`, `RESERVED_SETTINGS`, `RESERVED_FILES`, `routeMcp`), `apps/daemon/src/platforms.ts` (`mergePlatforms`), `apps/daemon/src/service.ts` (`runContext`)

## Files placed for a run

In the config location (`/tmp/sacty-claude-config` for Claude Code, `/.codex` for Codex), files are placed in this order: the layers' agent files → skills (`skills/<name>/…`) → files sacty generates (for the same path, the later one overwrites).
The `.git` in the layers' agent files and skill directories (a submodule's file pointing to git's management data) is not placed (`filesUnder` and `layerAgentFiles` in `apps/daemon/src/context.ts`).

| runtime | Files sacty generates |
| --- | --- |
| Claude Code | `CLAUDE.md` (rules), `settings.json` (composed settings), `mcp.json` (`{ "mcpServers": … }`; the command type has `command`, `args`, `env`; the URL type has `type: "http"`, `url`, `headers`), `agents/<tier>.md` (tier subagent definitions; `name`, `description`, `model`, and `effort` in the frontmatter) |
| Codex | `AGENTS.md` (rules and the skill list `- <name>：<description>（<location>）`), `config.toml` (composed settings and `[mcp_servers."<name>"]`; the URL type has `url`, `http_headers`, `env_http_headers`), `agents/<tier>.toml` (tier subagent definitions; `name`, `description`, `developer_instructions`, `model`, `model_reasoning_effort`) |

### Tier subagent definitions

For tier subagent definitions (PBI-119), sacty places the tiers that meet the following conditions under the name without the prefix (`selectTiers`, `tierFiles`).

- It is a `claude_<tier>` or `codex_<tier>` among the usable agents. The usable agents are the defaults in `config/agents.yaml` with `agents` of `config.yaml` laid over them, that have an endpoint and a price ([Configuration](configuration.en.md#agent-defaults-and-overrides)).
- It has the same runtime as the step agent.
- It has the same authentication and endpoint (`auth`, `endpoint`, `via_gateway`).

Ones that differ are not placed, and `agents.tierConnectionDiffers` is left as a note (the endpoint is built from the per-runtime `providers`, so tiers of the same runtime always match).

- Nothing is placed for a stub step.
- A tier without `reasoning_effort` (such as the default `claude_lite`) becomes a definition without it (the tool's default).
- The placed tiers (tier, agent name, model, reasoning effort) are recorded in `tiers` of `ContextResolved`.
- The preview shows the same files. The parent for the preview is the `default_agent` of that runtime, otherwise the first of `step_agents` and `guardian_agent` with that runtime.
- `ContextResolved` is recorded with the `runId` of every run that receives a context (`contextResolved`). This covers not only step runs but also information gathering, the Orchestrator (PBI-146), the after-merge watch, operations, and exports.
- The cost of a run that placed tiers is recorded as estimated (`estimated`). This is because a reviewer may run with a model other than the parent's, while the cost can only be computed from the parent's usage and unit prices ([Agent execution](agent-execution.en.md#authentication)).

### Passing MCP servers

Where an MCP server runs and what the agent receives are decided as follows.

![Where an MCP server runs](images/context-mcp.en.svg)

- MCP secrets are written in the files as environment variables `SACTY_MCP_SECRET_<number>`, and the values are passed as container environment variables (retrieved on the host).
- Secrets in the layers' `mcp.yaml` and `platforms.yaml` have already been retrieved together with the other secrets ([Secrets](secrets.en.md#retrieving-everything-at-startup)). They are retrieved at daemon startup, when secrets are retrieved again, and when the project is saved. Ones not retrieved yet (such as ones added to a layer later) are retrieved when used.
- A layer's MCP server with `via_gateway` set to `true` (the default) is replaced with a route through the gateway. The agent receives only `http://host.docker.internal:<port>/ctx-mcp/<name>` and an `Authorization` with the per-run token (`routeMcp`).
  - URL type: the gateway holds the original URL and headers (secrets in headers are retrieved on the host).
  - Command type: the gateway starts it on the host (see "Command-type MCP servers started on the host" below). Secrets in `env` are retrieved when it starts on the host and are not passed to the container.
  - With `via_gateway: false`, it starts inside the container (the URL type connects directly from the container). Secret values are passed to the container as environment variables.
  - Without a gateway, both start inside the container or connect directly.
- The host's MCP servers (`gateway.mcp_servers`) are passed as `/mcp/<name>` ([Gateway](gateway.en.md)).
- MCP timeouts
  - Codex: they are written in `config.toml` under the same names.
  - Claude Code: `tool_timeout_sec` becomes each server's `timeout` (milliseconds). Only when `startup_timeout_sec` is set on any server, the global environment variable `MCP_TIMEOUT` is set to the maximum of the servers' values (30 seconds for servers that do not set it).
  - If any is at or above that run's limit (the role's limit from `run_timeout` in `config.yaml`; default 30 minutes; PBI-150), a warning is issued (`context.mcpTimeoutOverRun`).

Code: `apps/daemon/src/context.ts` (`planContext`, `codexServer`, `timeoutWarnings`, `routeMcp`, `McpServer`, `CLAUDE_MCP_CONFIG`, `CLAUDE_MCP_STARTUP_DEFAULT_SEC`, `GATEWAY_TOKEN_SECRET`), `apps/daemon/src/service.ts` (`contextContainerDir`, `mcpRouting`)

## Command-type MCP servers started on the host

The gateway starts command-type MCP servers with `via_gateway` (default `true`) on the host. Starting, readiness, restarting, relaying, and process records use the same mechanism as the host's MCP servers ([Gateway](gateway.en.md)). Anyone who can edit the context repository can run commands on the host.

- Name isolation
  - The name inside the gateway (`ctx-<first 24 hex digits of SHA-256>`) is derived from the project and the contents (the name in `mcp.yaml`, `command`, `args`, `env`, timeouts, and the layer's repository, ref, and commit).
  - Each run token is bound only to the names of that run's project. Runs of other projects cannot use it even if they know the name (404).
  - Different contents under the same name never mix.
- Reuse: for the same project and the same contents, the same process is used across runs. If the contents change (including the layer's commit), it starts under a new name.
- Working directory
  - A copy of the directory of the layer that defined the server (with `path`, that directory inside the repository) (`SACTY_HOME/context-mcp/layers/<project and layer identifier>-<random>`; `.git` is not copied). The layer identifier is made from `repo`, `ref`, `path`, and `commit`.
  - Fetched layers are deleted after the run, so the copy is made at lease time and deleted when nothing uses it anymore.
  - A command with a relative path is looked up from the working directory, others from `PATH`. If not found, it becomes a reason (`context.mcpHostCommandMissing`) before starting.
- Lease and release
  - Before a run, the servers that run uses are leased together. The lease is committed only once all are ready. If anything fails midway, the layers copied by that lease are deleted and the held state is unchanged. The prepared context is deleted too.
  - Readiness is awaited for up to `max(120 seconds, startup_timeout_sec)` (`CONTEXT_MCP_READY_SEC`). If a server is not ready, which server (its name in `mcp.yaml` and its layer) is left in the context warnings and the run proceeds (for export, export to that destination stops).
  - They are released when the run ends.
- Stopping
  - A server that no run is using anymore is stopped immediately if new contents are used for the same project and the same name (it has become stale). Otherwise it is stopped 30 minutes after its last use (checked every 60 seconds).
  - Failures while stopping or deleting copies do not fail the lease or release; they are logged and retried later.
  - When the daemon exits, all are stopped and the copies deleted. At daemon startup, the previous copies (`context-mcp/layers`) are deleted (leftover processes are stopped by the same cleanup as the host's MCP servers).
- Reasons (in the web UI, the activity log, and the 503 to the agent) show the name in `mcp.yaml`, the layer, and the project name, not the name inside the gateway.
  - The fields are `name`, `from`, and `project` of `context.mcpHostUnavailable`, `context.mcpHostReadyTimeout`, and `context.mcpHostCommandMissing`.
  - Older records without `project` are shown without the project.
  - Even if servers with the same layer and the same name exist in several projects, you can tell which one it is.
- Logs (start, not ready, stop, cleanup) also show the name in `mcp.yaml`, the project name and ID, and the layer, with the name inside the gateway alongside ("Host MCP servers" in [Gateway](gateway.en.md)).
- The layer shown in reasons and logs has credentials in the repository URL (`https://<user>:<token>@…`) hidden as `***` (`shownLayer`).
- The project name shown is the one at lease time. The name inside the gateway is derived from the project ID, so renaming the project does not restart the server.

Code: `apps/daemon/src/context-mcp.ts` (`ContextMcpServers`, `lease`, `prepare`, `sweep`, `copyLayer`, `forceRemove`, `shownLayer`, `CONTEXT_MCP_READY_SEC`), `apps/daemon/src/context.ts` (`routeMcp`, `HostedContextMcp`), `apps/daemon/src/host-mcp.ts` (`assertCommand`, `CommandNotFoundError`, `HostMcpContext`, `mcpLogName`), `apps/daemon/src/service.ts` (`runContext`, `mcpRouting`), `apps/daemon/src/main.ts`

## Template (sacty context init)

Creates `README.md`, `rules.md`, `skills/README.md`, `mcp.yaml`, `platforms.yaml`, `sacty-context.yaml`, and `agents/codex/config.toml`. Their contents are only explanatory comments and do not change the default context. `README.md` says that tier subagent definitions are generated by sacty, so placing them has no effect.

- If the same path or `rules` exists, it writes nothing and stops unless `--force` is given.
- If an intermediate directory is not a directory, it stops even with `--force`.

Code: `apps/daemon/src/context-template.ts` (`CONTEXT_TEMPLATE_FILES`, `initContextRepo`)

## Preview

- Endpoints
  - `GET /api/projects/:id/context-preview?runtime=`: saved settings
  - `POST /api/projects/:id/context-preview` (`{ runtime, definition? }`): settings being edited
  - `runtime` defaults to `claude-code`.
  - It performs the same composition as a run but writes no files and leaves nothing in the activity log.
  - Fetch and settings errors return 200 with `{ error }`.
- What the result contains
  - The layers
  - The files to place (up to 256KB per file and 8MB in total; binary contents are not shown)
  - MCP (where each connects: `direct`, `gateway`, `host`, or `hostCommand`). `hostCommand` is the command type started on the host, shown with the command, arguments, `env` references, and which layer's copy it runs in.
  - Skills, rules, and effects (`locked`, `remove`)
  - Secret references (only the reference names are shown)
  - Environment variables, a summary of usable PFs, and warnings
- `sacty context preview <project>`: queries the endpoint in `SACTY_HOME/daemon.json`.
  - The project is an ID or a name.
  - The options are `--runtime` (`claude-code` | `codex`), `--json` (the API result as is), and `--no-content` (omits file contents).
  - Exit code 1 on error.
- When a project is saved with a context specified, the same composition is also tried and errors are returned (the project is still saved).

Code: `apps/daemon/src/server.ts` (`PreviewRequest`), `apps/daemon/src/service.ts` (`projectContextPreview`, `checkProjectContext`, `ContextPreviewView`), `apps/daemon/src/context.ts` (`previewContext`, `ContextPreview`, `PREVIEW_FILE_MAX_BYTES`, `PREVIEW_TOTAL_MAX_BYTES`), `packages/cli/src/context-preview.ts` (`fetchContextPreview`, `previewOutput`)
