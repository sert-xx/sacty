[日本語](configuration.md) | **English**

# Configuration (config.yaml)

`SACTY_HOME/config.yaml` holds the per-machine settings (AI endpoints and prices, agent overrides, images, and the gateway). The daemon
reads it again on every use (you can change it without stopping the daemon), except `web.auth`, which is read only when `sacty up` starts (it is fixed in the web UI
child process's environment; restart after changing it). When it cannot be read or has the wrong shape, the location of the first error (`path`) and the reason become the message shown as a warning in the web UI.
`sacty config init` writes the template (`CONFIG_TEMPLATE`) with permission 0600 (if the file exists, it stops unless `--force` is given).

The defaults of the agent definitions (model and reasoning effort) are kept in the repository's `config/agents.yaml` (`DEFAULT_AGENTS_PATH`).
`loadConfig(home, defaultsPath)` lays `agents` of `config.yaml` over the defaults.

How to write it, for users, is in the [user documentation](../user/README.en.md). This page describes the meaning and default of each item, and the validation rules.

Related ADRs: [Keep the agent defaults in the repository, and limit config.yaml to endpoints and prices](../adr/20261018-1105-agent-defaults-in-repo.md)

## Top-level items

| Item | Default | Meaning |
| --- | --- | --- |
| `image` | `sacty-agent:1.5.0` (`DEFAULT_IMAGE`) | The default image. Used to run agents and tests |
| `providers` | `{}` | The endpoint per runtime ("Providers" below). Only the names `codex` and `claude` |
| `default_agent` | The first usable one in `default_agent` of `config/agents.yaml` | The default AI. An agent name |
| `guardian_agent` | `default_agent` | The Goal Guardian's AI |
| `audit_agent` | `guardian_agent` (or `default_agent`) | The AI for audits of completed tasks ([Audit](audit.en.md)) |
| `agent_fallback.cooldown_minutes` | `60` (`DEFAULT_FALLBACK_COOLDOWN_MINUTES`) | How long an agent that failed at a usage limit (`usage_limit`) is not used (minutes; an integer from 1 to 1440). During that time, the `fallback` in `agents` is used ([Agent execution](agent-execution.en.md#fallback-agents-at-a-usage-limit)) |
| `step_agents` | `{}` | The AI per step (`StepKey`; `deployment` is the check in the after-merge watch step) and for `orchestrator`. If not written, `default_agent`; for Integration review (`integrate`), `guardian_agent` |
| `agents` | `{}` | Overrides of and additions to the agent defaults ("Agent defaults and overrides" below) |
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
| `web.auth` | `true` | Web UI sign-in. `false` turns it off (booleans only; [Daemon startup and shutdown](daemon-lifecycle.en.md#web-ui-sign-in)) |
| `run_timeout.agent_minutes` | `30` | Limit of one agent run (minutes; an integer from 1 to 720; PBI-150). When it passes, the container is stopped and the run times out (`run.timeout`) ([Agent execution](agent-execution.en.md#container)) |
| `run_timeout.test_minutes` | `20` | Limit of one test command run (minutes; an integer from 1 to 720) |
| `run_timeout.roles` | `{}` | Per-role overrides (minutes). Keys are steps (`investigate`, `requirements`, `design`, `implement`, and so on) and `guardian`, `final-review`, `rework`, `orchestrator`, `chat`, `export`, `audit`, `audit-dive`. Other keys are errors |
| `update_check` | `true` | Check for a newer sacty (the latest GitHub release) and tell the web UI. `false` does not contact GitHub (booleans only; [Daemon startup and shutdown](daemon-lifecycle.en.md#checking-for-a-newer-version)) |

Other checks: it is an error when a value of `default_agent`, `guardian_agent`, `audit_agent`, or `step_agents` is not an agent (`config.agentMissing`),
and also when it is an agent that cannot be used ("Usable agents" below; `config.agentUnavailable`, which carries the reason in `reason`, because the web UI shows no warnings while the config has an error).
It is also an error when an `agents` name is a tier (`claude_<tier>`, `codex_<tier>`; the tiers are `lite`, `entry`, `standard`, `advanced`, and `ultimate` in `AGENT_TIERS`)
but its `runtime` does not match the prefix (`config.tierRuntime`). Usable tier agents are also collected in `tierAgents` (per runtime and tier;
`parseTierId`, `tierAgentsFor`). How they are placed is in [Context composition](context.en.md#files-placed-for-a-run).

Unknown items are not treated as errors and are not read. The intake interval is not in `config.yaml` but in the sacty settings ([Intake](intake.en.md#interval)).
The former `github.poll_interval_sec` (`github:`) is not read either, even if written (no warning).

Code: `apps/daemon/src/config.ts` (`ConfigFile`, `loadConfig`, `DEFAULT_AGENTS_PATH`, `agentFor`, `CONFIG_TEMPLATE`)

## Providers

There is one entry in `providers` per runtime: `codex` (`runtime: codex`) and `claude` (`runtime: claude-code`). `stub` uses no endpoint.
Other names are errors (`config.providerLegacyName`; it says to rewrite a former named OpenAI-compatible endpoint as the `auth` of `providers.codex`).

| Item | Default | Meaning |
| --- | --- | --- |
| `auth` | (required) | Authentication (table below) |
| `via_gateway` | `false` | Route AI calls through the host gateway. It can be `true` only when `auth.mode` of `codex` is `bedrock` or `openai-compatible` (`config.gatewayUnsupported`) |
| `available_models` | `{}` | Prices per model name (US dollars per million tokens). `input`, `cached_input`, `output` (required), and `cache_write` (default 0) |

`auth.mode` and the allowed providers:

| `auth.mode` | Items | `claude` | `codex` |
| --- | --- | --- | --- |
| `subscription` | `secret` (required for `claude`; `config.subscriptionSecret`), `auth_file` (Codex; default `~/.codex/auth.json`) | Yes | Yes |
| `api-key` | `secret` | Yes | Yes |
| `bedrock` | `secret`, `region`, `endpoint` (`runtime`｜`mantle`; `codex` only (`config.bedrockEndpointCodexOnly`); `runtime` when omitted) | Yes | Yes |
| `openai-compatible` | `base_url` (http or https), `secret` (optional) | No | Yes |

Combinations that are not allowed are errors (`config.authUnsupported`). At run time, the authentication, gateway, and endpoint are built from the provider of the agent's runtime
(`providerKeyOf`, `connectionOf`). For `openai-compatible`, `auth.mode` at run time is `provider`, and `base_url` (without trailing `/`),
`secret`, and `via_gateway` are put in `endpoint` (named `codex`; [Agent execution](agent-execution.en.md#authentication)).

Code: `apps/daemon/src/config.ts` (`ProviderFile`, `ProviderAuth`, `PriceFile`, `refineProvider`, `providerKeyOf`, `connectionOf`)

## Agent defaults and overrides

The repository's `config/agents.yaml` (`DefaultsFile`) has `default_agent` (a list of candidates; at least one) and `agents` (definitions per name; `runtime` is required).
When it cannot be read or has the wrong shape, loading stops with the file's location and the reason (`config.defaultsUnreadable`).

| Name | `runtime` | `model` | `reasoning_effort` |
| --- | --- | --- | --- |
| `codex_lite` | `codex` | `gpt-6-luna` | `low` |
| `codex_entry` | `codex` | `gpt-6-luna` | `high` |
| `codex_standard` | `codex` | `gpt-6.1-sol` | `low` |
| `codex_advanced` | `codex` | `gpt-6.1-sol` | `medium` |
| `codex_ultimate` | `codex` | `gpt-6.1-sol` | `high` |
| `claude_lite` | `claude-code` | `claude-haiku-5-5` | none |
| `claude_entry` | `claude-code` | `claude-sonnet-5-5` | `low` |
| `claude_standard` | `claude-code` | `claude-sonnet-5-5` | `medium` |
| `claude_advanced` | `claude-code` | `claude-opus-5-5` | `medium` |
| `claude_ultimate` | `claude-code` | `claude-opus-5-5` | `high` |

The `default_agent` candidates are `codex_standard`, then `claude_standard`. When `config.yaml` has no `default_agent`, the first usable candidate is used.
If none is usable, it is an error (`config.noDefaultAgent`).

`agents` in `config.yaml` (`AgentFile`):

| Item | Meaning |
| --- | --- |
| `runtime` | `claude-code`, `codex`, or `stub`. Can be omitted for a name in the defaults. Required for a name not in the defaults (`config.agentRuntimeRequired`) |
| `model` | The model. For `claude-code` and `codex`, required in the result merged with the defaults (`config.agentModelRequired`; its price is looked up in `available_models`) |
| `reasoning_effort` | The reasoning effort (optional; `^[a-z][a-z0-9_-]{0,30}$`). Passed to Codex as `model_reasoning_effort` and to Claude Code as `--effort` |
| `fallback` | The names of the agents used instead at a usage limit (optional; one name or a list, tried from the top). A name not in `agents` is an error (`config.agentMissing`), and so is the agent itself (`config.agentFallbackSelf`). Agents that cannot be used are removed with a warning (`config.agentFallbackUnavailable`) |
| `price_per_mtok_usd` | `runtime: stub` only. The price (written the same way as `available_models`; 0 if not written) |
| `stub` | The output of `runtime: stub` (default outputs for steps, the Orchestrator, the Goal Guardian, and so on; token counts; and `fail: usage_limit｜auth` to reproduce failures) |

- For a name that is in the defaults, only the items written are laid over the default (items not written keep the default). A name not in the defaults adds that agent.
- Writing `auth`, `provider`, or `via_gateway` on an agent is an error. Writing `price_per_mtok_usd` on an agent other than `stub` is also an error (`config.agentLegacyKey`;
  it says to write them in `auth`, `via_gateway`, and `available_models` of `providers`). The former format is not converted automatically.
- Names in `agents` cannot be empty (`config.agentNameEmpty`; the name chosen in the task details is recorded in the Activity).

Code: `apps/daemon/src/config.ts` (`DefaultsFile`, `AgentFile`, `LEGACY_AGENT_KEYS`, `loadDefaults`, `buildAgents`, `StubBehavior`, `fallbackAgentFor`)

## Usable agents

Of the agents merged from the defaults and the overrides, the following cannot be used (unusable). This is not a settings error (so that settings can still be read
when a sacty update changes the default models). Unusable agents are not put in `agents` or `tierAgents`, and are not offered in the task details.

- The endpoint of the runtime (`providers.codex`, `providers.claude`) is not written. A warning is shown only for agents the user wrote in `agents` of `config.yaml`
  (`config.agentProviderMissing`). Default agents get no warning, because that runtime is just not in use.
- The model's price is not in `available_models` of the provider (names of inherited properties are not treated as prices). A warning is shown per model, listing the names of
  the unusable agents (`config.modelPriceMissing`).

The warnings are kept in `agentWarnings` and shown as warnings in the web UI (`warnings` of `GET /api/status`). Agents with `runtime: stub` are usable without
looking at endpoints or prices (the price is `price_per_mtok_usd`, or 0).

The AI used for each role is chosen by `agentFor`: the one in `step_agents` if present, otherwise `default_agent` (`guardian_agent` for `integrate`).
For steps (including the after-merge watch, operations, and exports), an agent a person chose in the task details takes precedence (`stepAgentFor`; [Changing a step's agent](tasks-and-steps.en.md#changing-a-steps-agent)).
The Activity keeps only the `authMode`, `model`, and `reasoningEffort` of the AI used (it does not keep secret values or endpoint URLs; `agentSetting`).

Code: `apps/daemon/src/config.ts` (`buildAgents`, `loadConfig`, `agentFor`, `stepAgentFor`, `agentSetting`), `apps/daemon/src/service.ts` (`TaskService.status`)

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
