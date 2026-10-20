<!-- Code: apps/daemon/src/config.ts (ConfigFile, ProviderFile, ProviderAuth, AgentFile, loadConfig, CONFIG_TEMPLATE), config/agents.yaml, packages/core/src/events.ts (StepKey, DEFAULT_BUDGET_USD) -->

[日本語](config.md) | **English**

# config.yaml settings

These are the settings for all of sacty, written in `~/.sacty/config.yaml` (`$SACTY_HOME/config.yaml` if you change `SACTY_HOME`).
Create the template with `npx sacty config init` ([CLI](cli.en.md#sacty-config-init)).

Per-project settings (targets, GitHub accounts, the context repository, and so on) go in
[Project settings](project-settings.en.md) in the web UI, not in config.yaml.

## Settings

| Setting | Meaning | Default |
| --- | --- | --- |
| `providers` | The connection (authentication) per runtime and the prices of the models you can use ([Connections and prices](#connections-and-prices-providers)). Only `codex` and `claude` | None |
| `default_agent` | The AI that runs the steps (an agent name) | `codex_standard` (`claude_standard` if it cannot be used) |
| `guardian_agent` | The AI used for the Goal Guardian | `default_agent` |
| `audit_agent` | The AI used for audits of completed tasks ([Audits](audit.en.md)) | `guardian_agent` (or `default_agent`) |
| `agent_fallback.cooldown_minutes` | How long an agent that failed is not used and the fallback agent is used instead (minutes; an integer from 1 to 1440; [Switching agents on failure](#switching-agents-on-failure)) | `60` |
| `step_agents` | The AI to use for each step (including the after-merge watch) and the Orchestrator ([Models per step](#models-per-step)) | `default_agent` if omitted (`guardian_agent` for Integration review) |
| `agents` | Overrides of and additions to sacty's default agents ([Overriding agents](#overriding-agents)). Optional | None (sacty's defaults are used) |
| `budget.default_per_task_usd` | Budget per task (US dollars. A number greater than 0) | `1` |
| `budget.default_per_audit_usd` | Budget per audit (US dollars. A number greater than 0. Separate from the task budget. [Audits](audit.en.md#budget)) | `1` |
| `image` | The image used to run agents and tests | `sacty-agent:1.5.0` |
| `image_build` | The base image and npm settings for `sacty image build` ([Container images](images.en.md)) | None |
| `images` | Images per language ([Container images](images.en.md#per-language-images)) | None |
| `onepassword.account` | The 1Password account to use ([Secrets](secrets.en.md#1password)) | None |
| `gateway` | The gateway on the host ([Gateway](gateway.en.md)) | None |
| `web.auth` | Web UI sign-in. With `false`, you can use the web UI without opening the sign-in URL (for the risk and how to switch, see [CLI](cli.en.md#sacty-up)). Read only when `sacty up` starts | `true` |
| `run_timeout` | Limits of one agent run and one test command run (minutes; 1 to 720). `agent_minutes` (agents), `test_minutes` (tests), and per-role overrides in `roles` (for example `implement: 90`, `guardian: 45`). When a limit passes, the container is stopped and the task is paused. Changes apply from the next run | `agent_minutes: 30`, `test_minutes: 20` |
| `update_check` | Checks daily for a newer sacty release and shows it in the web UI ([Updating sacty](getting-started.en.md#updating-sacty)). Set `false` where the internet is not reachable (GitHub is not contacted) | `true` |

You set the intake interval for each kind of intake in "Sacty settings" in the web UI, not in config.yaml ([Intake](intake.en.md#intake-intervals)).
The days to keep memories are also set in "Sacty settings" ([Viewing audits](audit.en.md#memories)).
`github:` (`poll_interval_sec`) from earlier versions is not read even if written. You can delete it.

If a setting is wrong, the web UI shows which setting (for example `providers.codex.auth.secret`) is wrong and why.

## Connections and prices (providers)

The models and reasoning efforts of the AIs that run steps come from the defaults sacty recommends ([Default agents](#default-agents)).
In config.yaml, you only need to write the connection (authentication) of the tool you use and the prices of the models you can use (`available_models`).

```yaml
providers:
  codex:
    auth:
      mode: api-key
      secret: openai-api-key   # Save the value with npx sacty secret set openai-api-key
    available_models:          # The prices are examples. Match your contract
      gpt-6-luna: { input: 0.25, cached_input: 0.025, output: 2 }
      gpt-6.1-sol: { input: 1.25, cached_input: 0.125, output: 10 }
```

Only two names can be written in `providers`: `codex` for Codex and `claude` for Claude Code. You can write one of them or both.

| Setting | Meaning | Default |
| --- | --- | --- |
| `auth` | The authentication method ([Authentication](#authentication)). Required | None |
| `via_gateway` | Route AI calls through the gateway on the host (`bedrock` and `openai-compatible` of `codex` only. [Gateway](gateway.en.md#relaying-ai-calls)) | `false` |
| `available_models` | The models you can use and their unit prices per million tokens (US dollars). For each model name, `input`, `cached_input`, and `output` are required; `cache_write` is optional | None (`cache_write` is `0`) |

- An agent whose model has no price in `available_models` cannot be used. It is not offered for steps or in the task details, and the web UI
  shows a warning saying which model has no price (with the names of the agents that use that model). It is not a settings error.
- When a sacty update changes the default models, add the prices of the models shown in the warning to `available_models`.
- Keep the unit prices in line with the latest prices of the models you use. If your contract has different prices, write those. Costs are calculated from these unit prices and the token counts.
  With a subscription you are not actually billed, but sacty treats the value converted at the same unit prices as the cost and uses it to check the budget.
- Writing an agent that cannot be used in `default_agent`, `guardian_agent`, `audit_agent`, or `step_agents` is an error.
- It is also an error when `default_agent` is not written and neither `codex_standard` nor `claude_standard` can be used (for example, when `providers` is not written).

## Authentication

| AI | Authentication method (`auth.mode`) | What you need |
| --- | --- | --- |
| Claude Code (`claude`) | `subscription` | A token created with `claude setup-token` (`secret` is required) |
| Claude Code (`claude`) | `api-key` | An Anthropic API key |
| Claude Code (`claude`) | `bedrock` | A Bedrock API key and `region`. The model is an inference profile ID |
| Codex (`codex`) | `subscription` | Sign-in with ChatGPT (`auth_file`. Default `~/.codex/auth.json`) |
| Codex (`codex`) | `api-key` | An OpenAI API key |
| Codex (`codex`) | `bedrock` | A Bedrock API key and `region`. `endpoint` is `runtime` (the default. The model is an inference profile ID, for example `global.openai.gpt-6-sol`) or `mantle` (the model is, for example, `openai.gpt-6-sol`) |
| Codex (`codex`) | `openai-compatible` | The `base_url` and API key of an OpenAI-compatible endpoint ([Gateway](gateway.en.md#openai-compatible-endpoints)) |

- For tokens and API keys, write only a name (or a 1Password reference) in `secret`, and keep the value in the Keychain or 1Password ([Secrets](secrets.en.md)).
- `endpoint` is used only by Codex. Writing it for `bedrock` of `claude` is an error.
- Only the environment variables of the chosen authentication method are passed to the container (host variables such as `ANTHROPIC_API_KEY` are not inherited).
- With Bedrock the model names differ, so change `model` with [Overriding agents](#overriding-agents) and write the price for that name in
  `available_models`. Tiers you do not override have no price, so they cannot be used and the web UI shows a warning.

```yaml
providers:
  codex:
    auth:
      mode: bedrock
      secret: bedrock-api-key
      region: us-east-2
      endpoint: runtime
    via_gateway: true
    available_models:
      global.openai.gpt-6-sol: { input: 1.25, cached_input: 0.125, output: 10 }
agents:
  codex_standard:
    model: global.openai.gpt-6-sol
default_agent: codex_standard
```

## Default agents

sacty has default agents for each tier ([Agent tiers](#agent-tiers)). When models are renewed,
the defaults are renewed with a sacty update.

| Name | Tool | Model | Reasoning effort |
| --- | --- | --- | --- |
| `codex_lite` | Codex | `gpt-6-luna` | `low` |
| `codex_entry` | Codex | `gpt-6-luna` | `high` |
| `codex_standard` | Codex | `gpt-6.1-sol` | `low` |
| `codex_advanced` | Codex | `gpt-6.1-sol` | `medium` |
| `codex_ultimate` | Codex | `gpt-6.1-sol` | `high` |
| `claude_lite` | Claude Code | `claude-haiku-5-5` | (the tool's default) |
| `claude_entry` | Claude Code | `claude-sonnet-5-5` | `low` |
| `claude_standard` | Claude Code | `claude-sonnet-5-5` | `medium` |
| `claude_advanced` | Claude Code | `claude-opus-5-5` | `medium` |
| `claude_ultimate` | Claude Code | `claude-opus-5-5` | `high` |

- If you do not write `default_agent`, `codex_standard` is used. When `codex_standard` cannot be used (no `providers.codex`, or no price),
  `claude_standard` is used.
- The default agents of a tool that is not in `providers` cannot be used (you are just not using that tool, so no warning is shown).

## Overriding agents

You do not have to write `agents`. When you write it, an agent with the same name as a default is overridden only in the settings you write
(the settings you do not write keep their defaults). You can also add agents under new names.

```yaml
agents:
  codex_ultimate:
    reasoning_effort: xhigh   # The model stays the default
  my-reviewer:                # A new name (needs runtime and model)
    runtime: claude-code
    model: claude-opus-5-5
    reasoning_effort: high
```

| Setting | Meaning | Default |
| --- | --- | --- |
| `runtime` | `claude-code`, `codex`, or `stub` (for trying things out. It does not call a real AI). Required for a new name | The default agent's |
| `model` | The model. Required for a new name (its price is looked up in `available_models`) | The default agent's |
| `reasoning_effort` | The reasoning effort (`model_reasoning_effort` for Codex, `--effort` for Claude Code). Lowercase letters, digits, `_`, and `-`, starting with a lowercase letter | The default agent's (or the tool's default) |
| `price_per_mtok_usd` | `runtime: stub` only. The unit price per million tokens (US dollars), written the same way as in `available_models` | `0` |
| `stub` | The output of `runtime: stub` | None |
| `fallback` | The names of the agents used instead when a run fails (for any reason, such as a usage limit or an authentication error). One name or a list (tried from the top; [Switching agents on failure](#switching-agents-on-failure)) | None (no switching) |

- Agents cannot contain authentication, connections, or prices (`auth`, `provider`, `via_gateway`, `price_per_mtok_usd`). Write them in `providers`
  (except `price_per_mtok_usd` of `runtime: stub`).
- An agent under a new name also cannot be used, with a warning in the web UI, when its tool has no `providers` entry or its model has no price.

## Models per step

In `step_agents`, choose an agent for each step and the Orchestrator.

```yaml
default_agent: codex_standard
guardian_agent: codex_advanced
step_agents:          # default_agent if omitted (guardian_agent for Integration review)
  orchestrator: codex_lite
  requirements: codex_advanced
  design: codex_advanced
```

The keys you can write in `step_agents` are `orchestrator`, the steps `investigate` (Investigation), `review` (Review), `requirements` (Requirements),
`design` (Design), `split` (Task split), `integrate` (Integration review), `reproduce` (Reproduce), `implement` (Implementation),
`document` (Document), `operation` (Operation), and
`deployment` (the check in the after-merge watch step. [After-merge watch](deployment-watch.en.md)).
Writing a name that does not exist or an agent that cannot be used in `default_agent`, `guardian_agent`, `audit_agent`, or `step_agents` is an error.
The `pr` key (PR作成) of earlier versions can no longer be written because the step was removed (it is an error; delete it).

## Agent tiers

If you sort your agents into tiers, skills (such as the default `review`) start a subagent by tier name for each viewpoint, and the same
tier runs in both Claude Code and Codex. When a new model generation comes out, a sacty update renews the tiers' default models too.

sacty has the tier agents by default under the names `claude_<tier>` and `codex_<tier>` ([Default agents](#default-agents)).
The tiers are `lite`, `entry`, `standard`, `advanced`, and `ultimate`, and only the tiers that can be used (with a connection and a model price in `providers`) are placed.
To change a tier's model, write `model` under the same name with [Overriding agents](#overriding-agents).

| Tier | Meaning | Intended use |
| --- | --- | --- |
| `lite` | Fastest and cheapest | Mechanical checks such as wording and links |
| `entry` | Enough for everyday work | Wording and fit for the reader |
| `standard` | Standard | The default for most viewpoints |
| `advanced` | Hard reasoning | Correctness, robustness, security, concurrency, and design consistency |
| `ultimate` | The top tier | Defect hunting not bound to a viewpoint |

- When a step runs, sacty places the tiers of that tool (`claude_*` for Claude Code, `codex_*` for Codex) in the config location as subagent
  definitions named without the prefix (`agents/<tier>.md` for Claude Code, `agents/<tier>.toml` for Codex).
- Subagents run in the same process as the step agent. The connection is per tool in `providers`, so the tiers of the same tool
  have the same connection as the step agent.
- It is an error when the prefix of a tier name does not match its `runtime` (for example `claude_lite` with `runtime: codex`).
- You can see the placed tiers in the details of "Context prepared" in the Activity and in the context preview of the project settings.
- If no tier can be used, subagents run with the same model as the step agent.
- A tier agent is an ordinary agent too, so you can write it in `step_agents` to use it for a step.
- Costs are calculated from the step agent's usage and unit prices, not from each reviewer's model. The cost of a run that placed tiers is recorded as an estimate
  and marked "Estimate" on the screen. The price of a tier's model in `available_models` is used when that tier runs a step through `step_agents`.
- Definitions of the same name in the context repository (`agents/claude/agents/<tier>.md`, `agents/codex/agents/<tier>.toml`, and `[agents.<tier>]` in Codex's
  `config.toml`) are not used (a warning is left).

## Moving from earlier versions

The format of earlier versions is not converted automatically. It is an error, so rewrite it as follows.

- Move `auth` and `via_gateway` of agents to `providers.codex` or `providers.claude` of that tool.
- Move `price_per_mtok_usd` of agents to `providers.<tool>.available_models` as per-model prices.
- Rewrite named `providers` (OpenAI-compatible endpoints) and `provider` of agents as the `auth` of `providers.codex`
  (`mode: openai-compatible`, `base_url`, `secret`).
- You can delete agents from `agents` when the default models are enough. Change `default_agent` and the others to the names of default agents.

## Switching agents on failure

You can, for example, use Claude Code as the main agent and switch to Codex when it reaches its usage limit, fails to authenticate, and so on.
Write `fallback` (the name of the agent to use instead) on an agent.

```yaml
default_agent: claude_standard
agents:
  claude_standard:
    fallback: codex_standard
  claude_advanced:
    fallback: [codex_advanced, codex_standard]   # with a list, tried from the top
agent_fallback:
  cooldown_minutes: 60   # how long an agent that failed is not used (minutes; 1-1440)
```

- When an agent's run fails, whatever the reason (usage limits, authentication errors, other errors), the task is not paused;
  the same step runs again with the fallback agent. Switching when the run ended normally but its answer was not in the right form applies only to the
  Orchestrator's choice of steps and reading tickets. Whether a run failed is judged from the agent's exit code and output, not from logs on standard error.
  The activity log records the switch with the reason, such as "reached its usage limit", "failed to authenticate", or "failed". This retry without pausing applies to steps, the integration review,
  the Orchestrator's choice of steps, reading tickets, the final review, and the Goal Guardian's judgements (change proposals and rework remarks).
- For exports, the post-merge watch, audits, and answers to questions, the failure of that run is handled as before (the task pauses, the check is recorded as not confirmed, and so on),
  and at a usage limit the fallback agent is used from the next run.
- For `cooldown_minutes`, the failed agent is not used and the fallback agent is used instead: for other tasks too at a usage limit,
  and only for that task on other failures (other tasks run with the original agent). After that, the original agent is used again.
  When Sacty restarts, the original agent is tried first as well.
- When the Orchestrator switches to a fallback agent (a different tool), the conversation of the previous agent's session is passed read-only so the new agent
  can take over (the session itself cannot be resumed by a different tool). The same handover happens when it switches back to the original agent.
- If the fallback agent also fails (all agents in the list have been tried), the task is paused as before. An agent already tried is not used again
  even after `cooldown_minutes`. Resuming tries again from the chosen agent in order. An agent without `fallback` is also paused as before.
- When the agent's container could not be confirmed as stopped, the task is paused without switching (the original container may still be running).
- Writing a name that does not exist, or the agent itself, in `fallback` is an error. When a fallback agent cannot be used (for example, there is no `providers` for its tool),
  a warning is shown in the web UI and Sacty does not switch to that agent.
- Fallback agents apply to every agent in `default_agent`, `guardian_agent`, `audit_agent`, `step_agents`, and the agents chosen in task details.

## Budget

- The default budget per task is `budget.default_per_task_usd` (default $1).
- At 80% of the budget, a notice is recorded in the activity log, and when the limit is reached the task is paused (the work is kept). To resume, enter a new cumulative limit in the web UI.
- The task is also paused on a subscription usage limit or an authentication error, and resuming runs the stopped step again (writing a fallback agent switches to it and continues; [Switching agents on failure](#switching-agents-on-failure)). An Operation that has started cannot be resumed and stays paused.

## Related pages

- [Secrets](secrets.en.md)
- [Gateway](gateway.en.md)
- [Container images](images.en.md)
