[日本語](README.md) | **English**

# User documentation

These pages explain how to install, configure, and use sacty, including its commands and web UI.
To learn what sacty is, start with [Introducing sacty](introduction.en.md). If you are new to sacty, start with [Getting started](getting-started.en.md). For details of how it works, see the [specifications](../spec/README.en.md).

Here is an overview of sacty.

![sacty at a glance](images/overview.en.svg)

## Contents

- [Desktop app](desktop.en.md): run and build the proposal application

1. [Introducing sacty](introduction.en.md): what sacty does, what makes it different, and the work you can hand over
2. [Getting started](getting-started.en.md): installation, startup, your first project and task, where data is stored
3. [Dashboard](dashboard.en.md): what each section shows, how periods are counted, empty states
4. [config.yaml settings](config.en.md): list of settings, connections and prices, auth modes, default agents and overrides, models per step, budgets
5. [Secrets](secrets.en.md): Keychain, 1Password, what is fetched at startup
6. [Project settings](project-settings.en.md): targets, GitHub accounts, specifying the context repository, export, deletion
7. [Intake of issues, PRs, and tickets](intake.en.md): Sacty settings, PR reviews, JIRA, running tasks in parallel
8. [Working with tasks](tasks.en.md): creating tasks, approving in PRs, asking the orchestrator, pausing and canceling
9. [Context repository](context.en.md): template, files to place, sacty-context.yaml, mcp.yaml, platforms.yaml, preview
10. [Gateway](gateway.en.md): relaying AI calls, OpenAI-compatible endpoints, host MCP servers, organization platform (PF) APIs
11. [Container images](images.en.md): private registries, per-language images
12. [docker compose services](compose.en.md): databases, mock APIs, shared compose
13. [Exporting results](result-export.en.md): exporting to Confluence, Notion, and others
14. [Notifications (Slack and desktop)](notifications.en.md): the destination in the Sacty settings, mentions, turning on and off, browser desktop notifications
15. [After-merge watch](deployment-watch.en.md): the step after Implement. Checking CI/CD and the app after deployment, placing the skill, registering fix tasks automatically
16. [CLI](cli.en.md): the sacty command and its options
17. [Troubleshooting](troubleshooting.en.md): common ways things stop and what to check
18. [Audits](audit.en.md): audits of completed tasks, adopting and rejecting proposals, the audit page, reports
19. [Scheduled tasks](scheduled-tasks.en.md): creating tasks on a schedule, what happens when the computer was off, editing and deleting, the tasks it created
