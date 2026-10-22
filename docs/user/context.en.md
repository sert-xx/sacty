<!-- Code: apps/daemon/src/context-mcp.ts (ContextMcpServers), apps/daemon/src/context.ts (ContextManifest, McpServer, McpTimeouts, PlatformsFile, composeContext, RESERVED_SETTINGS, RESERVED_FILES), apps/daemon/src/context-template.ts, apps/daemon/src/platforms.ts, packages/cli/src/index.ts (contextInit, contextPreview), packages/cli/src/context-preview.ts -->

[日本語](context.md) | **English**

# Context repository

You can collect the rules, skills, MCP servers, external platforms, and agent settings that are passed to step agents and the Orchestrator in a context repository, and specify it in the project settings (optional). sacty layers the context repository on top of its default context.

Before starting the reviewers, the default review skills run the formatting, lint, type check, tests, and other checks defined by the target repository in check mode, and share the results with the reviewers. If verification or CI has results, they also start a reviewer that analyzes the failures and warnings. The verification logs are saved outside the review's workspace, and the PR quotes only the parts needed for the comments.

The default writing skill `writing` sets how agents write PR descriptions, review comments, reports, and other text. In Japanese text, it adds a line break after each "。" and puts structured information in lists and tables. If the target repository has writing rules (AGENTS.md, CONTRIBUTING, and so on), those take precedence.

The default requirements skill `ears-requirements` has the acceptance criteria of requirements written in the EARS (Easy Approach to Requirements Syntax) patterns. Each requirement is one sentence in a fixed pattern such as `When <trigger>, the <system> shall <response>.` with an ID such as `R-1`. The Requirements step writes its acceptance criteria with this skill. If the target repository has rules for requirements, those take precedence.

The default plan-selection skill `plan-steps` sets how the Orchestrator chooses the plan of steps for a task. Before output, the Orchestrator checks the answer JSON with a tool such as `jq` and fixes it until the check passes. This reduces stops caused by broken answer JSON (such as a missing closing brace) when the steps themselves were chosen.

The default diagram skill `drawio` is draw.io's official skill. Agents use it when making diagrams (`.drawio`, including export to PNG, SVG, and PDF). Converting diagrams written in Mermaid and exporting them uses the draw.io CLI in the image ([Container images](images.en.md#the-drawio-cli)).

## Creating the template

```sh
npx sacty context init sacty-context   # create the template in the given directory (the current directory if omitted)
```

- This creates `README.md`, `rules.md`, `skills/README.md`, `mcp.yaml`, `platforms.yaml`, `sacty-context.yaml`, and `agents/codex/config.toml`.
- Each file contains an explanation of what to write there. As created, the files change nothing in the default context.
- If a file with the same name (or `rules/`) already exists, the command stops without overwriting it. To overwrite, add `--force`.
- When you have written the files, specify them in "Context repository" in the project settings in the web UI ([Project settings](project-settings.en.md#context-repository), [Where to put it](#where-to-put-it)).
  - To use them as a local directory, specify that directory as is (no commit is needed).
  - To use them with a git URL, manage them with git, commit, and push, then specify that repository. Changes that are not pushed are not used.

## Where to put it

You can put the context in a git repository, in a local directory, or in a directory inside a monorepo.

| Location | "Repository" | "Branch or tag" | "Directory" | Contents used |
| --- | --- | --- | --- | --- |
| A git repository | A git URL (e.g. `git@github.com:acme/sacty-context.git`) | Optional (the default branch if empty) | Empty | The commit of that branch or tag |
| A local directory | An absolute path or a path starting with `~/` (e.g. `/Users/acme/sacty-context`) | Empty | Empty | The current contents of the directory |
| A commit of a local git repository | An absolute path or a path starting with `~/` | A branch or tag | Empty | The commit of that branch or tag |
| A directory inside a monorepo | Any of the above | As above | A path relative to the repository root (e.g. `contexts/team`) | The contents of that directory |

- A local directory can be used even if it isn't managed with git or has uncommitted changes. sacty reads its contents at that moment on every run (`.git` is not read). The activity log records a hash of the contents instead of a commit.
- A relative path (such as `./sacty-context`) points to a different place depending on the directory where the daemon was started, so it is not treated as a local directory. Write an absolute path.
- In a monorepo, the directory written in "Directory" takes the place of the root of the context repository. Put `rules.md`, `skills/`, `mcp.yaml`, and so on in that directory. Paths that point outside the repository (those containing `..`) and paths with a symbolic link along the way can't be used.

## Files to put in it

| File | Contents | How layers combine |
| --- | --- | --- |
| `rules.md` (or `rules/*.md`) | Rules. Passed to Claude Code as CLAUDE.md and to Codex as AGENTS.md. If `rules.md` exists, `rules/` is not read | Concatenated in order from the upper layer |
| `skills/<name>/SKILL.md` | Skills. A directory without SKILL.md is a group (`skills/<group>/<name>/SKILL.md` is also the skill named `<name>`) | A lower layer overrides by name |
| `mcp.yaml` | MCP servers ([mcp.yaml](#mcpyaml)) | A lower layer overrides by name |
| `platforms.yaml` | External platforms available only to this project ([platforms.yaml](#platformsyaml)) | A lower layer overrides by name |
| `agents/codex/`, `agents/claude/` | Files copied into Codex's `CODEX_HOME` and Claude Code's `CLAUDE_CONFIG_DIR` | A lower layer overrides the same path. `config.toml` and `settings.json` are merged key by key |
| `sacty-context.yaml` | Inheritance, locking, and removal ([sacty-context.yaml](#sacty-contextyaml)) | |

- `README.md` is not passed to agents.
- Symbolic links cannot be used (sacty stops and shows the reason).
- `permissions.allow`, `deny`, and `ask` in `agents/claude/settings.json` are combined with the upper layers rather than replaced.
- Items that sacty decides are not used even if you write them (a warning is recorded).
  - `agents/codex/config.toml`: `mcp_servers`, `model_provider`, `model_providers`, `forced_login_method`, `forced_chatgpt_workspace_id`, `chatgpt_base_url`, `approval_policy`, `sandbox_mode`, `sandbox_workspace_write`, `profile`, `profiles`
  - `agents/claude/settings.json`
    - `apiKeyHelper`, `awsAuthRefresh`, `awsCredentialExport`, `forceLoginMethod`, `forceLoginOrgUUID`
    - The authentication and endpoint variables in `env` (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_OAUTH_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, and so on)
    - Variables starting with `SACTY_`
  - Files: Codex's `auth.json`, `AGENTS.md`, and `skills/`; Claude Code's `.credentials.json`, `.claude.json`, `CLAUDE.md`, `mcp.json`, and `skills/`
- Tier subagent definitions are generated by sacty from the [agent tiers](config.en.md#agent-tiers), so they are not used even if placed (not even when no tier can be used; a warning is left).
  - This covers `agents/claude/agents/<tier>.md`, `agents/codex/agents/<tier>.toml`, and `[agents.<tier>]` in Codex's `config.toml`. The tiers are `lite`, `entry`, `standard`, `advanced`, and `ultimate`.
  - A Codex `agents/*.toml` whose `name` inside is a tier is not used either, whatever its file name.
- Give Codex rules (`agents/codex/rules/*.rules`) a name other than `sacty.rules` so that they do not remove the default rules.
- The agent's `model` (sacty's default, or the override in `agents` of `config.yaml`) takes precedence over the model in these settings.

## sacty-context.yaml

```yaml
extends: git@github.com:acme/sacty-context.git#main   # parent (upper layer) context repository. Specify a ref with URL#ref (forms below)
locked:            # skills, MCP servers, and external platforms that lower layers cannot override or remove
  skills: [review]
  mcp: [docs]
  platforms: [ticket]
remove:            # remove skills, MCP servers, and external platforms inherited from upper layers
  skills: []
  mcp: []
  platforms: []
```

- Write one of the following in `extends`.

  ```yaml
  extends: git@github.com:acme/sacty-context.git#main   # another repository (#ref is optional)
  ```

  ```yaml
  extends: ../base   # a directory in the same repository (a path relative to this layer's directory)
  ```

  ```yaml
  extends:           # a directory inside another repository (ref and path are optional)
    repo: git@github.com:acme/monorepo.git
    ref: main
    path: contexts/base
  ```

- A relative path starting with `./` or `../` points inside the same branch or tag of the same repository (for a local directory, inside the same directory). Use it in a monorepo when a team's directory inherits a shared directory. It can't point outside the repository.
- Only a local path context without a branch or tag can write a local path (an absolute path or one starting with `~/`) in `extends`. If a context fetched with git (including a local git repository with a branch or tag) tries to inherit a local path, sacty stops and shows the reason.
- Inheritance goes up to 10 layers. If the same repository, directory, and ref appear twice (a cycle), sacty stops and shows the reason.
- If a lower layer tries to override or remove a locked item, a warning is recorded and the upper layer's item is used.

## mcp.yaml

```yaml
servers:
  docs:
    url: https://mcp.example.com/mcp
    headers:
      Authorization: { secret: docs-token, prefix: "Bearer " }
  local-tool:
    command: npx
    args: ["-y", "example-mcp-server"]
    env:
      API_TOKEN: { secret: op://Work/Tool/token }
```

- Names can contain alphanumerics, `_`, and `-`.
- Write each server in one of two forms: `url` (HTTP) or `command` (a command, over stdio).
  - HTTP: `url` (required), `headers`, `via_gateway` (default `true`), `startup_timeout_sec`, `tool_timeout_sec`
  - Command: `command` (required), `args`, `env`, `via_gateway` (default `true`), `startup_timeout_sec`, `tool_timeout_sec`
- Do not write secret values. Write `{ secret: name }` instead (a Keychain name or a 1Password reference; `prefix` is put before the value). You cannot write `${` in strings (Claude Code expands it as an environment variable).
- Secrets in `mcp.yaml` and `platforms.yaml` are fetched together with the other secrets when `sacty up` starts and when you save project settings. Ones added later are fetched when used ([Secrets](secrets.en.md#secrets-added-to-a-context-later)).
- Both HTTP servers and `command` servers are used through sacty's gateway by default. Step agents receive only the gateway URL (`/ctx-mcp/<name>`) and a per-run token. It becomes an HTTP MCP server in both Claude Code's `mcp.json` and Codex's `config.toml`.
- To run a server inside the container (for HTTP, connect directly from the container), write `via_gateway: false` for that server. Such servers are started and connected inside the container, and secret values are passed to the container as environment variables.
- If a server has the same name as one in `gateway.mcp_servers` in `config.yaml`, the one in `gateway.mcp_servers` is used and a warning is recorded in the Activity (the one in `mcp.yaml` is not started).

### HTTP MCP servers

- Secrets in authentication headers are fetched on the host, and the gateway adds them to upstream requests (they are not passed to the container).
- Authentication and other headers added by the agent are not sent upstream (only the headers needed for MCP Streamable HTTP are sent).
- Responses (SSE) are returned as they are.
- Redirects are not followed.

### Command MCP servers (run on the host)

By default, the gateway starts `command` servers on the host that runs sacty (the same mechanism as `gateway.mcp_servers`). Secrets in `env` are fetched on the host and set only when the server is started; they are not passed to the container.

```yaml
servers:
  issue-tracker:                 # started on the host (default)
    command: npx
    args: ["-y", "example-issue-mcp", "--config", "./mcp/issue.json"]
    env:
      API_TOKEN: { secret: op://Work/Issue/token }
  browser:                       # started inside the container
    command: npx
    args: ["-y", "@playwright/mcp"]
    via_gateway: false
```

- Working directory: a copy of the repository of the layer that defines the server (under `SACTY_HOME/context-mcp/layers`; `.git` is not copied).
  - Relative paths in `args` and elsewhere are resolved from the root of that repository (not the container's workspace).
  - A server defined in a parent layer of the inheritance runs in a copy of the parent repository.
- Command: looked up in the host's `PATH` (a command containing `/`, such as `./bin/server`, is looked up from the working directory).
  - If it is not found (`npx`, `uvx`, and so on are not installed on the host), the run still proceeds. The Activity (the notes of "Context prepared") records which command of which MCP server it is, and that you should install it on the host or write `via_gateway: false`.
  - The server is restarted every minute, so it becomes usable once you install it on the host.
- Isolation: servers are started per project and can be used only with the run tokens of that task's project (the same as platforms in `platforms.yaml`).
  - Runs of other projects cannot use them, even if they know the name.
  - Even with the same contents, different projects get separate processes.
- Reuse: within the same project, if the contents (name, `command`, `args`, `env`, timeouts, and the layer's repository and commit) are the same, the same process is used across runs (including concurrent runs). If the contents change (including when you push to the context repository and the commit changes), a new process is started for the next run.
- Stopping: sacty stops a server that no run uses any more (the layer copy is also deleted).
  - It stops the server immediately once new contents for the same project and the same name are used. Otherwise, it stops the server 30 minutes after it was last used.
  - Stopping `sacty up` stops all of them.
  - Servers left behind when the daemon crashed are cleaned up on the next start (using the same record as `gateway.mcp_servers`, `SACTY_HOME/host-mcp/processes`).
- Preparation: before a run, sacty waits for the servers that run uses to start (MCP initialization).
  - The limit is 120 seconds (or `startup_timeout_sec` if it is longer than that).
  - If a server is not ready, the run proceeds, and the Activity (the notes of "Context prepared") records which MCP server it is (its name in `mcp.yaml`, the layer, and the project name).
  - Exports of results to that server are not performed, and the reason is recorded.
- Logs: lines like `[gateway] context MCP "<mcp.yaml name>" (project "<project name>" [<ID>], context "<layer>", internal ctx-…)` in the daemon log show the server's start, the reason it is not ready, and its stop. The `internal` name is the name inside the gateway and does not appear in the settings.
- "Context preview" in the project settings shows the following.
  - The URL visible to agents (`/ctx-mcp/<name>`)
  - The command started on the host, `env` (only reference names for secrets), and the layer of the working directory
- Servers used by every project, such as those that authenticate in a browser, can be written in `gateway.mcp_servers` in `config.yaml` ([Gateway](gateway.en.md#host-mcp-servers)).

### Trust assumptions

`command` servers run on the host that runs sacty, as the same user and with the same environment variables (`PATH`, `HOME`, and so on) as the daemon. In other words, anyone who can edit the context repository (including the parent repositories it inherits from) can run arbitrary commands on the host that runs sacty. sacty assumes that you trust the context repository as much as `config.yaml`, and it has no allowlist of commands and no human approval.

- Make sure only people who may edit `config.yaml` can change the context repository (and the parents in `extends`) (branch protection, required reviews, and so on).
- Run servers you do not want on the host inside the container with `via_gateway: false`.
- If the result of an MCP tool contains secrets, they are passed to the agent (sacty does not mask them).

### MCP server timeouts

For each server, you can write the following two limits (both optional, integers). If you omit them, the agent's defaults apply.

- `startup_timeout_sec`: the limit for waiting for startup (initialization and the tool list) (1 to 3600 seconds)
- `tool_timeout_sec`: the limit for waiting for a tool call (1 to 86400 seconds)

```yaml
servers:
  build-tool:
    command: npx
    args: ["-y", "example-build-mcp"]
    startup_timeout_sec: 60     # takes a while to start
    tool_timeout_sec: 900       # has tools that take 15 minutes
```

A whole agent run has a limit from its start. The default is 30 minutes from the start, and you can change it with `run_timeout` in `config.yaml` ([config.yaml settings](config.en.md)). After that, sacty stops the container.

Setting MCP timeouts longer than that has no effect, because the whole run stops first. If you set either startup or tool calls to that run's limit or more (by default, 30 minutes or more), a warning is recorded in the Activity when the context is prepared (it is not treated as a configuration error).

sacty passes the values you write to each tool as follows.

- Codex: passed to `mcp_servers.<name>` in `config.toml` under the same names (`startup_timeout_sec`, `tool_timeout_sec`).
- Claude Code
  - Tool calls are passed as the per-server `timeout` in `mcp.json` (milliseconds; it takes precedence over the environment variable `MCP_TOOL_TIMEOUT`).
  - There is no per-server setting for the startup limit, so it becomes the global environment variable `MCP_TIMEOUT`. Its value is the larger of the values you wrote and, for servers where you wrote none, Claude Code's default (30 seconds). This is so that the wait for servers without a value is never made shorter than the default. So if there are servers without a value, values shorter than the default have no effect.
  - If no server has a value, `MCP_TIMEOUT` is not passed.
- HTTP servers through the gateway: the gateway extends its limit for waiting on upstream (5 minutes by default) up to the larger of the values you wrote, so the relay does not cut off first.
- `command` servers run on the host: as with `gateway.mcp_servers`, the gateway's relay (10 minutes by default for tool calls and 60 seconds for the list) does not cut off before the values you wrote.

You can write the same two settings in `gateway.mcp_servers` too ([Gateway](gateway.en.md#host-mcp-servers)).

## platforms.yaml

When each project needs different external platforms, write them in `platforms.yaml`. The items you can write are the same as `gateway.platforms` in `config.yaml` (`upstream`, `description`, `auth`, `allow`; see [Gateway](gateway.en.md#organization-platform-pf-apis)).

```yaml
platforms:
  ticket:                                     # agents call it at $SACTY_PF_URL/ticket/…
    upstream: https://ticket.internal.example.com
    description: Ticket management
    auth:
      header: Authorization
      prefix: "Bearer "
      secret: op://Work/Ticket/token          # write secrets as a name or a 1Password reference (not the value)
    allow:
      - GET /api/v1/tickets/**
```

- Layers combine the same way as `mcp.yaml`. A lower layer overrides by name, and `locked.platforms` and `remove.platforms` in `sacty-context.yaml` can lock and remove items (a warning is recorded when they apply).
- `gateway.platforms` in `config.yaml` is available to every project. If the same name exists, the one in `config.yaml` is used and a warning is recorded in the "Context prepared" entry of the Activity.
- Step agents are told only about the platforms available to that task's project (the host's platforms and the platforms composed from that project's context), through the list and descriptions of `$SACTY_PF_URL`.
- Platforms in a context can be used only with the run tokens of that project's tasks. Tasks of other projects cannot use them, even if they know the name (the gateway rejects them with 404).
- Only the host's gateway fetches and adds authentication values, at the time it uses them.
  - They are not shown to agents or in context files, the Activity, logs, or the web UI.
  - If authentication cannot be prepared, for example because a secret is not found, sacty returns an error to the agent that names the layer and the platform (502).
- Format errors (no `allow`, both `secret` and `token` in `auth`, and so on) stop the step, showing which item (`platforms.<name>.…`) in which layer's `platforms.yaml` is wrong.
- You can also choose a platform from the project's context as the connection for ticket intake and result export. sacty fetches the context to look for it only when the name is not among the host's platforms.
- "Available external platforms" in the project settings in the web UI shows the name, where each platform is defined, its description, and the APIs it allows (secret names and values are not shown). They are also shown in the "Context prepared" entry of the Activity.
- For platforms written in a context repository, the host adds the secrets written there and sends them to the upstream and token endpoint written there. As with `mcp.yaml`, make sure only trusted people can change the context repository ([Trust assumptions](#trust-assumptions)).

## Checking the composed result

You can check the composed result in "Context preview" in the project settings (for both saved settings and settings being edited). The result shows the files placed in Claude Code's and Codex's configuration directories at run time, along with the layers, warnings, MCP endpoints, and so on.

From the CLI, you can get the same output by querying the running sacty (`sacty up`) ([CLI](cli.en.md#sacty-context-preview)). Only reference names are shown for secrets.

```sh
npx sacty context preview payments --runtime codex
```

The same checks run when you save, and you are told about errors in `mcp.yaml`, `platforms.yaml`, and so on (the settings are still saved).

## Related pages

- [Gateway](gateway.en.md)
- [Project settings](project-settings.en.md)
