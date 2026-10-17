[日本語](configuration.md) | **English**

# Configuration (config.yaml)

`SACTY_HOME/config.yaml` holds the per-machine settings (AI agents, authentication, images, and the gateway). The daemon
reads it again on every use (you can change it without stopping the daemon). When it cannot be read or has the wrong shape, the location of the first error (`path`) and the reason become the message shown as a warning in the web UI.
`sacty config init` writes the template (`CONFIG_TEMPLATE`) with permission 0600 (if the file exists, it stops unless `--force` is given).

How to write it, for users, is in the [user documentation](../user/README.en.md). This page describes the meaning and default of each item, and the validation rules.

Related ADRs: none

## Top-level items

| Item | Default | Meaning |
| --- | --- | --- |
| `image` | `sacty-agent:0.1.0` (`DEFAULT_IMAGE`) | The default image. Used to run agents and tests |
| `default_agent` | (required) | The default AI. A name in `agents` |
| `guardian_agent` | `default_agent` | The Goal Guardian's AI |
| `step_agents` | `{}` | The AI per step (`StepKey`; `deployment` is the check in the after-merge watch step) and for `orchestrator`. If not written, `default_agent`; for Integration review (`integrate`), `guardian_agent` |
| `agents` | (required) | Agent definitions ("Agents" below) |
| `providers` | `{}` | OpenAI-compatible (Responses API) endpoints. Names match `^[A-Za-z0-9_-]+$`. `base_url` (http or https), `secret` (optional), `via_gateway` (default `false`) |
| `budget.default_per_task_usd` | `1` (`DEFAULT_BUDGET_USD`) | The budget per task (US dollars; a positive number) |
| `budget.default_per_audit_usd` | `1` (`DEFAULT_AUDIT_BUDGET_USD`) | The budget per audit (US dollars; a positive number; separate from the task budget; [Audit](audit.en.md)) |
| `image_build` | none | The source for `sacty image build` ("Images" in [Agent execution](agent-execution.en.md)) |
| `images` | `{}` | Images per language (same as above) |
| `onepassword.account` | none | The 1Password account ([Secrets](secrets.en.md)) |
| `gateway.host_address` | `host-gateway` (`DEFAULT_HOST_ADDRESS`) | The host's address as seen from containers. `^[A-Za-z0-9.:-]+$` |
| `gateway.retry.max_attempts` | `8` | How many times one AI call request is sent upstream (1 to 50, including the first attempt) |
| `gateway.retry.max_wait_sec` | `600` | The upper limit on total waiting during a run of failures (0 to 86400 seconds) |
| `gateway.platforms` | `{}` | Organization platforms (PF). Names match `^[a-z0-9][a-z0-9-]*$` ([Gateway](gateway.en.md)) |
| `gateway.mcp_servers` | `{}` | MCP servers run on the host. Names match `^[A-Za-z0-9_-]+$` (same as above) |

Other checks: it is an error when a value of `default_agent`, `guardian_agent`, or `step_agents` is not in `agents`, or when a `provider` name is not in `providers`.
It is also an error when an `agents` name is a tier (`claude_<tier>`, `codex_<tier>`; the tiers are `lite`, `entry`, `standard`, `advanced`, and `ultimate` in `AGENT_TIERS`)
but its `runtime` does not match the prefix (`config.tierRuntime`). Tier agents are also collected in `tierAgents` (per runtime and tier;
`parseTierId`, `tierAgentsFor`). How they are placed is in [Context composition](context.en.md#files-placed-for-a-run). The template (`CONFIG_TEMPLATE`) has commented examples of all five tiers
for both runtimes.

Unknown items are not treated as errors and are not read. The intake interval is not in `config.yaml` but in the sacty settings ([Intake](intake.en.md#interval)).
The former `github.poll_interval_sec` (`github:`) is not read either, even if written (no warning).

Code: `apps/daemon/src/config.ts` (`ConfigFile`, `loadConfig`, `agentFor`, `CONFIG_TEMPLATE`)

## Agents (agents)

| Item | Meaning |
| --- | --- |
| `runtime` | `claude-code`, `codex`, or `stub` |
| `model` | The model (optional) |
| `reasoning_effort` | The reasoning effort (optional; `^[a-z][a-z0-9_-]{0,30}$`). Passed to Codex as `model_reasoning_effort` and to Claude Code as `--effort` |
| `auth` | Authentication (table below). Writing only `provider: <name>` instead of `auth` is read as `auth: { mode: provider, provider: <name> }` |
| `price_per_mtok_usd` | US dollars per million tokens. `input`, `cached_input`, `output` (required), and `cache_write` (default 0) |
| `via_gateway` | Default `false`. It can be `true` only with `runtime: codex` and `auth.mode: bedrock` |
| `stub` | The output of `runtime: stub` (default outputs for steps, the Orchestrator, the Goal Guardian, and so on; token counts; and `fail: usage_limit｜auth` to reproduce failures) |

`auth.mode` and the allowed `runtime`:

| `auth.mode` | Items | `claude-code` | `codex` | `stub` |
| --- | --- | --- | --- | --- |
| `subscription` | `secret` (required for Claude Code), `auth_file` (Codex; default `~/.codex/auth.json`) | Yes | Yes | No |
| `api-key` | `secret` | Yes | Yes | No |
| `bedrock` | `secret`, `region`, `endpoint` (`runtime`｜`mantle`; Codex only; `runtime` when omitted) | Yes | Yes | No |
| `provider` | `provider` (a name in `providers`) | No | Yes | No |
| `stub` | none | No | No | Yes |

Names in `agents` cannot be empty (`config.agentNameEmpty`; the name chosen in the task details is recorded in the Activity).
The AI used for each role is chosen by `agentFor`: the one in `step_agents` if present, otherwise `default_agent` (`guardian_agent` for `integrate`).
For steps (including the after-merge watch, operations, and exports), an agent a person chose in the task details takes precedence (`stepAgentFor`; [Changing a step's agent](tasks-and-steps.en.md#changing-a-steps-agent)).
The Activity keeps only the `authMode`, `model`, and `reasoningEffort` of the AI used (it does not keep secret values or endpoint URLs; `agentSetting`).

Code: `apps/daemon/src/config.ts` (`Agent`, `Auth`, `Provider`, `StubBehavior`, `agentFor`, `agentSetting`)

## Validation of image settings

- `image_build.npm_config`: authentication items (`_auth`, `_authToken`, `_password`, `username`, `email`, `certfile`, `keyfile`, `cert`, `key`,
  including ones bound to a registry such as `//host/:_authToken`) cannot be written. Values cannot contain line breaks.
- `image_build.npm_version`: `latest` or `digits(.digits){0,2}`.
- Names in `images`: `^(?!default$)[a-z0-9][a-z0-9_-]{0,39}$` (`default` cannot be used because it refers to the default image).
- `images.<name>.env`: names match `^[A-Z_][A-Z0-9_]*$`. Names that look like credentials (containing `TOKEN`, `PASSWORD`, `PASSWD`, `SECRET`, `CREDENTIAL`, `AUTH`,
  `API_KEY`, or `PRIVATE_KEY`) and URLs containing a user name or password cannot be written. `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`,
  `NODE_OPTIONS`, and names starting with `DOCKER_`, `SACTY_`, `CODEX_`, `CLAUDE_`, `ANTHROPIC_`, `OPENAI_`, or `NPM_CONFIG_` cannot be written.
- `images.<name>.packages`, `enable_repos`, `run`: only a fixed set of characters (no shell special characters). `run` is one command per line.
  `enable_repos` is written together with `packages`.
- `images.<name>.maven_mirror`: an http or https URL without a user name, password, or symbols such as quotes.

Code: `apps/daemon/src/config.ts` (`NPM_SECRET_KEY`, `IMAGE_ENV_SECRET_NAME`, `IMAGE_ENV_RESERVED`, `hasUserInfo`)
