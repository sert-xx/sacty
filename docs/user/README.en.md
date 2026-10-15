[日本語](README.md) | **English**

# User documentation

These pages explain how to install, configure, and use sacty, including its commands and web UI.
If you are new to sacty, start with [Getting started](getting-started.en.md). For details of how it works, see the [specifications](../spec/README.en.md).

## Contents

1. [Getting started](getting-started.en.md): installation, startup, your first project and task, where data is stored
2. [config.yaml settings](config.en.md): list of settings, agents and auth modes, models per step, budgets
3. [Secrets](secrets.en.md): Keychain, 1Password, what is fetched at startup
4. [Project settings](project-settings.en.md): targets, GitHub accounts, specifying the context repository, export
5. [Intake of issues, PRs, and tickets](intake.en.md): sacty settings, PR reviews, JIRA, running tasks in parallel
6. [Working with tasks](tasks.en.md): creating tasks, approving in PRs, asking the orchestrator, pausing and canceling
7. [Context repository](context.en.md): template, files to place, sacty-context.yaml, mcp.yaml, platforms.yaml, preview
8. [Gateway](gateway.en.md): relaying AI calls, providers, host MCP servers, organization platform (PF) APIs
9. [Container images](images.en.md): private registries, per-language images
10. [docker compose services](compose.en.md): databases, mock APIs, shared compose
11. [Exporting results](result-export.en.md): exporting to Confluence, Notion, and others
12. [Slack notifications](notifications.en.md): how notifications are sent, mentions
13. [After-merge watch](deployment-watch.en.md): checking CI/CD and the app after deployment, registering fix tasks automatically
14. [CLI](cli.en.md): the sacty command and its options
15. [Troubleshooting](troubleshooting.en.md): common ways things stop and what to check
