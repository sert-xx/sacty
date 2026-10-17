<!-- Code: apps/daemon/src/config.ts (ConfigFile, Agent, Auth, Provider, CONFIG_TEMPLATE), packages/core/src/events.ts (StepKey, DEFAULT_BUDGET_USD) -->

[日本語](config.md) | **English**

# config.yaml settings

These are the settings for all of sacty, written in `~/.sacty/config.yaml` (`$SACTY_HOME/config.yaml` if you change `SACTY_HOME`).
Create the template with `npx sacty config init` ([CLI](cli.en.md#sacty-config-init)).

Per-project settings (targets, GitHub accounts, the context repository, and so on) go in
[Project settings](project-settings.en.md) in the web UI, not in config.yaml.

## Settings

| Setting | Meaning | Default |
| --- | --- | --- |
| `default_agent` | The AI that runs the steps (a name in `agents`). Required | None |
| `guardian_agent` | The AI used for the Goal Guardian | `default_agent` |
| `step_agents` | The AI to use for each step (including the after-merge watch) and the Orchestrator ([Models per step](#models-per-step)) | `default_agent` if omitted (`guardian_agent` for Integration review) |
| `agents` | AI definitions (by name. [Agents](#agents)). Required | None |
| `providers` | OpenAI-compatible connections ([Gateway](gateway.en.md#openai-compatible-endpoints-providers)) | None |
| `budget.default_per_task_usd` | Budget per task (US dollars. A number greater than 0) | `1` |
| `budget.default_per_audit_usd` | Budget per audit (US dollars. A number greater than 0. Separate from the task budget. [Audits](audit.en.md#budget)) | `1` |
| `image` | The image used to run agents and tests | `sacty-agent:0.1.0` |
| `image_build` | The base image and npm settings for `sacty image build` ([Container images](images.en.md)) | None |
| `images` | Images per language ([Container images](images.en.md#per-language-images)) | None |
| `onepassword.account` | The 1Password account to use ([Secrets](secrets.en.md#1password)) | None |
| `gateway` | The gateway on the host ([Gateway](gateway.en.md)) | None |

You set the intake interval for each kind of intake in "sacty settings" in the web UI, not in config.yaml ([Intake](intake.en.md#intake-intervals)).
`github:` (`poll_interval_sec`) from earlier versions is not read even if written. You can delete it.

If a setting is wrong, the web UI shows which setting (for example `agents.claude-subscription.auth.secret`) is wrong and why.

## Agents

In `agents`, write each AI under a name.

```yaml
agents:
  claude-subscription:
    runtime: claude-code
    auth:
      mode: subscription
      secret: claude-oauth-token
    price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 }
```

| Setting | Meaning | Default |
| --- | --- | --- |
| `runtime` | `claude-code`, `codex`, or `stub` (for trying things out. It does not call a real AI) | Required |
| `model` | The model | The agent's default |
| `reasoning_effort` | The reasoning effort (`model_reasoning_effort` for Codex, `--effort` for Claude Code). Lowercase letters, digits, `_`, and `-`, starting with a lowercase letter | The agent's default |
| `auth` | The authentication method ([Authentication](#authentication)). Omit it when you write `provider` | Required |
| `provider` | Instead of `auth`, the name of a connection in `providers` (Codex only) | None |
| `price_per_mtok_usd` | The unit price per million tokens (US dollars). `input`, `cached_input`, and `output` are required; `cache_write` is optional | `cache_write` is `0` |
| `via_gateway` | Route AI calls through the gateway on the host (Codex with Bedrock only. [Gateway](gateway.en.md#relaying-ai-calls)) | `false` |

Keep the unit prices in line with the latest prices of the models you use. If your contract has different prices, write those. Costs are calculated from these unit prices and the token counts.
With a subscription you are not actually billed, but sacty treats the value converted at the same unit prices as the cost and uses it to check the budget.

## Authentication

| AI | Authentication method (`auth.mode`) | What you need |
| --- | --- | --- |
| Claude Code | `subscription` | A token created with `claude setup-token` (`secret` is required) |
| Claude Code | `api-key` | An Anthropic API key |
| Claude Code | `bedrock` | A Bedrock API key and `region`. `model` is an inference profile ID |
| Codex | `subscription` | Sign-in with ChatGPT (`auth_file`. Default `~/.codex/auth.json`) |
| Codex | `api-key` | An OpenAI API key |
| Codex | `bedrock` | A Bedrock API key and `region`. `endpoint` is `runtime` (the default. `model` is an inference profile ID, for example `global.openai.gpt-6-sol`) or `mantle` (`model` is, for example, `openai.gpt-6-sol`) |
| (For trying things out) | `stub` | None. Only available with `runtime: stub` |

- For tokens and API keys, write only a name (or a 1Password reference) in `secret`, and keep the value in the Keychain or 1Password ([Secrets](secrets.en.md)).
- `endpoint` is used only by Codex. Writing it for Claude Code's `bedrock` is an error.
- Only the environment variables of the chosen authentication method are passed to the container (host variables such as `ANTHROPIC_API_KEY` are not inherited).

```yaml
agents:
  codex-bedrock:
    runtime: codex
    model: global.openai.gpt-6-sol
    auth:
      mode: bedrock
      secret: bedrock-api-key
      region: us-east-2
      endpoint: runtime
    via_gateway: true
    price_per_mtok_usd: { input: 1.25, cached_input: 0.125, output: 10 }
```

## Models per step

Write each agent as a set of "connection, model, reasoning effort, and unit price", and choose one for each step and the Orchestrator in `step_agents`.

```yaml
default_agent: luna-low
guardian_agent: sol-high
step_agents:          # default_agent if omitted (guardian_agent for Integration review)
  orchestrator: luna-low
  requirements: sol-high
  design: sol-high
```

The keys you can write in `step_agents` are `orchestrator`, the steps `investigate` (Investigation), `review` (Review), `requirements` (Requirements),
`design` (Design), `split` (Task split), `integrate` (Integration review), `reproduce` (Reproduce), `implement` (Implementation),
`document` (Document), `operation` (Operation), and
`deployment` (the check in the after-merge watch step. [After-merge watch](deployment-watch.en.md)).
Writing a name that is not in `agents` in `default_agent`, `guardian_agent`, or `step_agents` is an error.
The `pr` key (PR作成) of earlier versions can no longer be written because the step was removed (it is an error; delete it).

## Agent tiers

If you sort your agents into tiers, skills (such as the default `review`) start a subagent by tier name for each viewpoint, and the same
tier runs in both Claude Code and Codex. When a new model generation comes out, you only change the tier's `model`.

Write them in `agents` under the names `claude_<tier>` and `codex_<tier>`. The tiers are `lite`, `entry`, `standard`, `advanced`, and `ultimate`,
and only the tiers you write are placed. The template from `npx sacty config init` has commented examples of all five tiers for both tools.

```yaml
agents:
  claude_lite:
    runtime: claude-code
    model: claude-haiku-5-5
    auth: { mode: subscription, secret: claude-oauth-token }
    price_per_mtok_usd: { input: 1, cached_input: 0.1, cache_write: 1.25, output: 5 }
  claude_ultimate:
    runtime: claude-code
    model: claude-opus-5-5
    reasoning_effort: high
    auth: { mode: subscription, secret: claude-oauth-token }
    price_per_mtok_usd: { input: 15, cached_input: 1.5, cache_write: 18.75, output: 75 }
```

| Tier | Meaning | Intended use |
| --- | --- | --- |
| `lite` | Fastest and cheapest | Mechanical checks such as wording and links |
| `entry` | Enough for everyday work | Wording and fit for the reader |
| `standard` | Standard | The default for most viewpoints |
| `advanced` | Hard reasoning | Correctness, robustness, security, concurrency, and design consistency |
| `ultimate` | The top tier | Defect hunting not bound to a viewpoint |

- When a step runs, sacty places the tiers of that tool (`claude_*` for Claude Code, `codex_*` for Codex) in the config location as subagent
  definitions named without the prefix (`agents/<tier>.md` for Claude Code, `agents/<tier>.toml` for Codex).
- Subagents run in the same process as the step agent, so give a tier the same `auth`, `provider`, and `via_gateway` as the step agent
  (`default_agent`, `step_agents`). A tier that differs is not placed, and a note is left in the Activity.
- It is an error when the prefix of a tier name does not match its `runtime` (for example `claude_lite` with `runtime: codex`).
- You can see the placed tiers in the details of "Context prepared" in the Activity and in the context preview of the project settings.
- If you write no tiers, subagents run with the same model as the step agent.
- A tier agent is an ordinary agent too, so you can write it in `step_agents` to use it for a step.
- Costs are calculated from the step agent's usage and unit prices, not from each reviewer's model. The cost of a run that placed tiers is recorded as an estimate
  and marked "Estimate" on the screen. A tier's `price_per_mtok_usd` is the unit price used when that tier runs a step through `step_agents`.
- Definitions of the same name in the context repository (`agents/claude/agents/<tier>.md`, `agents/codex/agents/<tier>.toml`, and `[agents.<tier>]` in Codex's
  `config.toml`) are not used (a warning is left).

## Budget

- The default budget per task is `budget.default_per_task_usd` (default $1).
- At 80% of the budget, a notice is recorded in the activity log, and when the limit is reached the task is paused (the work is kept). To resume, enter a new cumulative limit in the web UI.
- The task is also paused on a subscription usage limit or an authentication error, and resuming runs the stopped step again. An Operation that has started cannot be resumed and stays paused.

## Related pages

- [Secrets](secrets.en.md)
- [Gateway](gateway.en.md)
- [Container images](images.en.md)
