<!-- Code: packages/core/src/projects.ts (ProjectDefinition, ProjectTarget, ProjectExport), packages/core/src/github-url.ts, apps/daemon/src/gh.ts, apps/daemon/src/github.ts, apps/web/src/components/project-editor.tsx, apps/web/src/i18n/messages/projects.ts -->

[日本語](project-settings.md) | **English**

# Project settings

You register per-project settings in the project settings of the web UI (they do not go in config.yaml).

| Field | Contents | Details |
| --- | --- | --- |
| Name | The name of the project (up to 80 characters) | |
| Targets | The orgs and repositories to create tasks for and import issues and PRs from | [Targets](#targets) |
| Ticket sources (optional) | The connection and keys for importing JIRA tickets | [Intake](intake.en.md#jira-tickets) |
| Context repository (optional) | Rules, skills, MCP, and external platforms passed to step agents | [Context repository](context.en.md) |
| Available external platforms | APIs that step agents can call through `$SACTY_PF_URL` (display only) | [Gateway](gateway.en.md#organization-platform-pf-apis) |
| GitHub account | The `gh` account to use for each host | [GitHub account](#github-account) |
| Shared compose (optional) | A team-shared docker compose used for tests | [docker compose services](compose.en.md#shared-compose) |
| After-merge watch | After an implementation PR is merged, check CI/CD and the deployed app, and register a fix task if something fails (Off by default) | [After-merge watch](deployment-watch.en.md) |
| Slack notifications (optional) | Tell you when you are needed and when tasks finish | [Notifications](notifications.en.md) |

## Targets

Write each target (a GitHub org or repository) as an `https://` URL that includes the host (for example `https://github.com/acme/app` or
`https://ghe.example.com/acme`. github.com and GitHub Enterprise Server use the same form). A trailing `/` or `.git` is ignored.

- When you create a task in the web UI, you choose a repository from the targets (for an org target, you choose from that org's repositories read with `gh`).
- Open issues and PRs in the targets that have the intake label are imported as tasks ([Intake](intake.en.md)).
- The same org or repository cannot be registered in another project. If an org and a repository in it are in different projects, the repository
  takes precedence (it is excluded from the org's project).
- If you choose an "Image" for a target (a name in `images` of `config.yaml`, or `default`), the Orchestrator does not choose one, and every step uses
  it (a repository's choice takes precedence over its org's. [Container images](images.en.md#which-image-a-step-runs-in)).

Note: once you register a target, sacty may push branches to the target repositories and open PRs, depending on the task.

## GitHub account

Access to GitHub (importing issues, cloning, pushing, creating PRs, commenting investigation results on issues, and posting reviews on PRs) uses
the accounts signed in to the GitHub CLI (`gh`) on the host. You can use github.com and any number of GitHub Enterprise Server instances at the same time.

```sh
gh auth login                                 # github.com. Sign in with each account you use
gh auth login --hostname ghe.example.com      # Sign in to each GitHub Enterprise Server host as well
```

- Always choose the account to use for each target host in the project settings (at first, the active `gh` account on that host is
  selected). Even if you switch accounts in `gh`, the account chosen for each project is used. Until you choose one, access to that host
  is stopped with the reason.
- An account is optional for hosts used only by the context repository or a shared compose. If you do not choose one, the host's git authentication is used.
- The API is `https://api.github.com` for github.com and `https://<host>/api/v3` for GitHub Enterprise Server.
- HTTPS repositories are cloned and pushed with the token of that host's account (you do not need to set up git authentication on the host). SSH URLs and
  local paths use the host's authentication (ssh-agent and so on).
- The token is fetched from `gh` each time it is used and never appears in the activity log, logs, the web UI, or containers.

## Context repository

In the "Context repository" field, write the repository (a git URL or a local path) and, optionally, a branch or tag (the default branch if empty).
See [Context repository](context.en.md) for how to write it and what it contains. To remove it, clear the repository and save.

When you save, sacty reads and checks the context, and tells you if `mcp.yaml`, `platforms.yaml`, or other files have errors (the settings are still saved, but as they are,
step runs will stop).

## Export and import

You can export a project definition and import it into another sacty.

- Included: the name, targets (including image choices), the context repository, notification destinations (secrets only as names or references; mention IDs are included),
  ticket sources, shared composes, and the after-merge watch (only when On).
- Not included: GitHub accounts (personal settings) and tokens.
- On import, files with unknown fields are rejected.

## Related pages

- [Issue, PR, and ticket intake](intake.en.md)
- [Working with tasks](tasks.en.md)
- [Context repository](context.en.md)
