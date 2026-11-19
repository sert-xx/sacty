[日本語](README.md) | **English**

# User documentation

These pages explain how to install, configure, and use sacty, including its commands and web UI.

- To learn what sacty is, start with [Introducing sacty](introduction.en.md).
- If you are new to sacty, follow [Getting started](getting-started.en.md) to start it, then [Working with tasks](tasks.en.md) to run your first task.
- For details of how it works, see the [specifications](../spec/README.en.md).

Here is an overview of sacty.

![sacty at a glance](images/overview.en.svg)

## Contents

The pages are grouped by purpose and listed in reading order.

### Get started

- [Introducing sacty](introduction.en.md): what sacty does, what makes it different, and the work you can hand over
- [Getting started](getting-started.en.md): from installation to startup and your first project and task. Updating sacty and where data is stored
- [Desktop app](desktop.en.md): how to start and build the prototype macOS app

### Hand over tasks

- [Working with tasks](tasks.en.md): creating tasks, reading the screens, approving and requesting changes in PRs, asking the orchestrator, pausing and canceling
- [Dashboard](dashboard.en.md): see your turn, stopped tasks, and costs across all projects on one screen
- [Intake of issues, PRs, and tickets](intake.en.md): create tasks automatically from GitHub issues and PRs and JIRA tickets. PR reviews and running tasks in parallel
- [Operating sacty from your local AI (MCP)](mcp.en.md): look up tasks and ask for a PR re-review, to create a task, to approve or request changes on a step, and read deliverables and the agent run list from Claude Code or Codex. How to connect and the available tools
- [Scheduled tasks](scheduled-tasks.en.md): create tasks automatically on a schedule. What happens when the computer was off, editing and deleting
- [After-merge watch](deployment-watch.en.md): check CI/CD and the deployed app after the implementation PR is merged. Placing the skill and registering fix tasks automatically
- [Audits](audit.en.md): audits of completed tasks, adopting and rejecting proposals, the audit page, reports
- [Notifications (Slack and desktop)](notifications.en.md): get notified of your turn and of completed tasks through Slack and browser desktop notifications
- [Exporting results](result-export.en.md): export approved results to Confluence, Notion, and others

### Configure

- [config.yaml settings](config.en.md): list of settings, connections and prices, auth modes, default agents and overrides, models per step, budgets
- [Secrets](secrets.en.md): keep tokens and API keys in Keychain or 1Password. What is fetched at startup
- [Project settings](project-settings.en.md): targets, GitHub accounts, specifying the context repository, export, deletion
- [Context repository](context.en.md): give agents your rules, skills, MCP servers, and external platforms. Template, files to place, preview
- [Gateway](gateway.en.md): relaying AI calls, OpenAI-compatible endpoints, host MCP servers, organization platform (PF) APIs
- [Container images](images.en.md): build the image that agents run in. Private registries and per-language images
- [docker compose services](compose.en.md): start the databases and mock APIs that tests need. Shared compose

### Look things up

- [CLI](cli.en.md): the sacty command and its options
- [Troubleshooting](troubleshooting.en.md): common ways things stop and what to check
