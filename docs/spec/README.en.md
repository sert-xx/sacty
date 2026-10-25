[日本語](README.md) | **English**

# Specifications

These pages describe how sacty currently works, accurately and in a way people can follow. **They always match the implementation.** For the policy, see the [docs overview](../README.md) (in Japanese).

## How files are divided

- One file per feature or mechanism (for example `architecture.md` (overall structure), `tasks-and-steps.md`, `context.md`, `gateway.md`, `daemon-lifecycle.md`). Choose units so that a PR changing one feature usually needs to edit only one file.
- File names use only lowercase letters, digits, and `-`. Do not add dates (the files describe the current state).
- When a file grows large, split it into a `<feature>/` directory and put a `README.md` (overview and contents) in it.
- List links to all specifications in the "Contents" section of this file.

## Writing rules

- Describe the current behavior in the present tense. Do not write history or rejected alternatives; link to the related ADRs instead.
- Do not guess. Leave out anything that cannot be confirmed in the code or tests, or mark it as `(unverified)`.
- At the end of each main item (section), list the corresponding code locations. Write files as paths relative to the repository root, adding function or type names when helpful. Do not write line numbers (they shift quickly).

  ```markdown
  Code: `apps/daemon/src/<file>.ts` (`<function name>`), `packages/core/src/<file>.ts`
  ```

- `tests/docs/docs.test.ts` checks that each file in a "Code:" reference exists and that the names in the parentheses appear in that file (it checks only that the names exist, not that the description is correct).
- Write values that appear in the code, such as setting names, defaults, and state names, exactly as they are named in the code.
- In a PR that changes the implementation, find the sections that describe the changed behavior and fix them in the same PR. Also fix them when the corresponding code moves or is removed.
- Fix the English version (`*.en.md`) in the same PR as well. In the English version, start code references with `Code:` and use ASCII parentheses around the names (see ["English versions" in the docs overview](../README.md#英語の版), in Japanese).

## Template

```markdown
# <Feature name>

<What this feature does, in 2–3 sentences.>

Related ADR: [<title>](../adr/<file name>)

## <Item>

<Behavior: inputs, outputs, state changes, and error handling.>

Code: `<path>` (`<function name>`)
```

## Contents

- [Overall structure](architecture.en.md): packages (core, daemon, web, cli), processes and communication, where data is stored
- [Daemon startup and shutdown](daemon-lifecycle.en.md): `sacty up`, startup order, double starts, shutdown
- [Configuration (config.yaml)](configuration.en.md): settings and defaults, agents and auth modes, validation rules
- [Tasks and steps](tasks-and-steps.en.md): steps and how they are combined, the orchestrator, verification, the goal guardian, budget, pause, and cancel, questions, review-only tasks
- [Approval and request changes](approval.en.md): approving in the web UI, approving in PRs, taking in PR comments, request changes, escalation
- [Task split and integration review](split-and-integrate.en.md)
- [Audit of completed tasks](audit.en.md): audit states, causes and proposals, audit budget, mock, API, screens
- [Memory](memory.en.md): layers and locations, source of truth and writing, registration by the audit, what agents get, deletion by people
- [Activity log (events and projection)](event-log.en.md): events, storage, projection, costs, session logs
- [Agent execution](agent-execution.en.md): containers, commands, authentication, output handling, saving and reusing sessions, images, running tests
- [Context composition](context.en.md): layers, context repository files (`mcp.yaml`, `platforms.yaml`, and others), composition rules, preview
- [Gateway](gateway.en.md): relaying AI calls, relaying organization platform (PF) calls, relaying MCP, host MCP servers
- [Secrets](secrets.en.md): reference format, fetching all at startup, handling that keeps values out of output
- [Services (docker compose)](services.en.md): starting and stopping, safety checks, localhost forwarding, shared compose
- [Notifications](notifications.en.md): conditions, destinations, and message text for Slack notifications
- [Ticket intake and GitHub](intake.en.md): GitHub issues and PRs, JIRA, comments on the source, GitHub accounts
- [Export](export.en.md): exporting results, exporting and importing projects
- [Screen wording and hints](ui-wording.en.md): how body text and hints (tooltips) are split, the hint component, checks on the dictionaries
- [Scheduled tasks](scheduled-tasks.en.md): how schedules are defined, missed times (only the latest one), when offline, the contents of the task, API, web UI
- [After-merge watch (CI/CD and deployment)](deployment-watch.en.md): whether the step is included (the skill), monitoring CI/CD, the check by the skill and its answer format, registering fix tasks and the limit, pause, cancel, and restart
