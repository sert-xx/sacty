<!-- Code: packages/core/src/projects.ts (ProjectDefinition, ProjectTarget, ProjectExport), packages/core/src/github-url.ts, apps/daemon/src/gh.ts, apps/daemon/src/github.ts, apps/web/src/components/project-editor.tsx, apps/web/src/i18n/messages/projects.ts, apps/web/src/components/shell/follow-project.tsx, apps/web/src/components/delete-project.tsx, apps/web/src/app/actions.ts (saveProjectAction, deleteProjectAction) -->

[日本語](project-settings.md) | **English**

# Project settings

You register per-project settings in the project settings of the web UI (they do not go in config.yaml).

You open a project's settings in either of the following ways.

- Click "Settings" in the side menu (it opens the settings of the project selected in the header).
- Open `/projects/<ID>/settings`.

When you create or import a project, the web UI switches to that project and opens its settings.

You switch the displayed project in the header of the web UI (choosing one moves to that project's task list). When you open a task or a project's settings (from a list, a notification link, or a URL), the header also switches to that project ([Web UI screens](getting-started.en.md#web-ui-screens)).

The project settings have the following fields.

| Field | Contents | Details |
| --- | --- | --- |
| Name | The name of the project (up to 80 characters) | |
| Targets | The orgs and repositories to create tasks for and import issues and PRs from | [Targets](#targets) |
| Ticket sources (optional) | The connection and keys for importing JIRA tickets | [Intake](intake.en.md#jira-tickets) |
| Context repository (optional) | Rules, skills, MCP, and external platforms passed to step agents | [Context repository](context.en.md) |
| Available external platforms | APIs that step agents can call through `$SACTY_PF_URL` (display only) | [Gateway](gateway.en.md#organization-platform-pf-apis) |
| GitHub account | The `gh` account to use for each host | [GitHub account](#github-account) |
| Shared compose (optional) | A team-shared docker compose used for tests | [docker compose services](compose.en.md#shared-compose) |

The following two are not set in project settings.

- Slack notifications: set one destination shared by all projects in the "Sacty settings" ([Notifications](notifications.en.md)).
- The after-merge watch: it is not turned on or off in project settings. If the target repository has the skill, it is added to the task's steps ([After-merge watch](deployment-watch.en.md)).

The project settings page looks like this.

![Project settings (name, targets, context repository)](images/project-settings.en.png)

## Targets

In the targets, you register the GitHub orgs or repositories that sacty creates tasks for and imports issues and PRs from.

Write each target as an `https://` URL that includes the host (for example `https://github.com/acme/app` or `https://ghe.example.com/acme`). github.com and GitHub Enterprise Server use the same form.

- sacty corrects a trailing `/` or `.git`, a query (`?…`) or `#…`, full-width characters, and invisible characters that slip in when pasting, when it reads the URL.
- For a URL that can't be read, the reason (http, SSH, an extra `/tree/…`, org and repository scope mixed up, and so on) is shown under the input.
- The host of a target that can't be read does not appear in the "GitHub account" section.

sacty uses the targets as follows.

- When you create a task in the web UI, you choose a repository from the targets (for an org target, you choose from that org's repositories read with `gh`).
- sacty imports open issues and PRs in the targets ([Intake](intake.en.md)).
  - Issues that have the label to import are imported as tasks.
  - PRs that have the review label (or that request your review) are imported as review-only tasks.

Once you register a target, sacty may push branches to the target repositories and open PRs, depending on the task.

The same org or repository cannot be registered in another project. If an org and a repository in it are in different projects, the repository takes precedence (it is excluded from the org's project).

If you choose an "Image" for a target (a name in `images` of `config.yaml`, or `default`), the Orchestrator does not choose one, and every step uses it.

- However, the task image a person chose when creating the task, and an image chosen when rerunning a cancelled task, take precedence.
- A repository's choice takes precedence over its org's ([Container images](images.en.md#which-image-a-task-runs-in)).
- The list shows only the image names, and the description of the chosen image (`description` in `images`) appears below the target's row.

## GitHub account

sacty accesses GitHub with the accounts signed in to the GitHub CLI (`gh`) on the host. It accesses GitHub to import issues, clone, push, create PRs, comment investigation results on issues, and post reviews on PRs. You can use github.com and any number of GitHub Enterprise Server instances at the same time.

Set up the accounts with the following steps.

1. Sign in to `gh` with the accounts you use.

   ```sh
   gh auth login                                 # github.com. Sign in with each account you use
   gh auth login --hostname ghe.example.com      # Sign in to each GitHub Enterprise Server host as well
   ```

2. In the "GitHub account" section of the project settings, always choose the account to use for each target host. At first, the active `gh` account on that host is selected.

The following rules apply to choosing accounts.

- Until you choose one, sacty stops access to that host with the reason.
- Even if you switch accounts in `gh`, sacty uses the account chosen for each project.
- An account is optional for hosts used only by the context repository or a shared compose. If you do not choose one, sacty uses the host's git authentication.

sacty uses the chosen account as follows.

- The API is `https://api.github.com` for github.com and `https://<host>/api/v3` for GitHub Enterprise Server.
- sacty clones and pushes HTTPS repositories with the token of that host's account (you do not need to set up git authentication on the host). SSH URLs and local paths use the host's authentication (ssh-agent and so on).
- sacty fetches the token from `gh` each time it uses it, and the token never appears in the activity log, logs, the web UI, or containers.

Check the accounts you can choose as follows.

- Open "gh accounts Sacty can see" in the "GitHub account" section to check the accounts the daemon read from `gh auth status`, listed by host, account, and status. If a host is missing, it is not signed in to `gh` for the user running the daemon (also check differences such as `GH_CONFIG_DIR`).
- After you sign in to `gh` again or add an account, press "Reload accounts" in the "GitHub account" section. The daemon checks `gh auth status` again and updates the accounts you can choose and the list. Your unsaved input stays.
- An account with the status "Not verified" is one whose token `gh` could not verify (the reason is shown in the list). You can still choose it, but for a GitHub Enterprise Server behind a corporate proxy, make sure `HTTPS_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, and similar are set in the shell that starts the daemon. The daemon passes them to `gh`.

## Context repository

In the "Context repository" field, write the following.

- Repository: a git URL or an absolute local path (a path starting with `~/` also works).
- Branch or tag (optional): if empty, a git URL uses the default branch, and a local path uses the current contents of the directory.
- Directory (optional): to use part of a monorepo as the context, the path relative to the repository root (e.g. `contexts/team`). If empty, the repository root is used.

See [Context repository](context.en.md) ([Where to put it](context.en.md#where-to-put-it)) for how to write it and what it contains. To remove it, clear the repository and save.

When you save, sacty reads and checks the context, and tells you if `mcp.yaml`, `platforms.yaml`, or other files have errors. sacty still saves the settings, but as they are, step runs will stop.

## When several people change the settings

When several people (or agents) open and save the settings of the same project, sacty does not silently erase a change that was saved first with a later save.

After you save, you can save again. When another save changed the project's settings after you opened the settings page, what happens depends on whether the changes overlap.

### When the changes do not overlap

As long as the changes do not overlap, sacty keeps both sets of changes and saves (a merge). The changes do not overlap in cases like the following.

- You each added a different target (a repository or an org).
- One of you added a target and another removed a different one.
- You changed different items (such as the name and the context).

When sacty saved by merging, the page says so and shows a "Reload to see the latest settings" button.

- This page has not seen the other save's changes. Reload to check them.
- Until you reload, you cannot save again (a change such as removing a target you just added would not take effect).

### When your save is not applied

sacty does not save in the following cases.

- You changed the same item or the same target in different ways
- The version you opened is too old (50 or more saves have happened since)

The page shows the reason and a "Reload to see the latest settings" button. Make your change again in the following order.

1. First, copy any change you want to keep. The input you were editing stays on the page until you reload, but reloading discards it (the page also says this next to the button).
2. Click the button to reload the page, and check the latest settings.
3. Make your change again.

## Export and import

You can export a project definition and import it into another sacty.

The exported file contains the following.

- Included: the name, targets (including image choices), the context repository, ticket sources, and shared composes.
- Not included: GitHub accounts (personal settings), tokens, and Slack notifications (they are in the "Sacty settings", not in project settings).

On import, files with unknown fields are rejected.

Files exported by an earlier version are handled as follows.

- Even if a file has the after-merge watch setting, it is imported without reading that setting.
- Files exported with an earlier version (version 3 or 4) cannot be imported, whether or not they include a notification destination. The web UI shows the reason; export the project again with the current sacty.

## Deleting a project

You can delete a project from the "Danger zone" at the end of the project settings page. A deleted project cannot be restored. If you want to keep its definition, export it first.

1. Click "Delete project".
2. In the confirmation dialog, type the project name exactly.
3. When the name matches, you can click "Delete", so click it.

After deleting, the web UI moves to the project list. What is deleted and what is kept are as follows.

- Deleted: the project settings and the project's [scheduled tasks](scheduled-tasks.en.md).
- Kept: tasks (including tasks that scheduled tasks created) and the activity log. However, they no longer appear on any screen (opening a task's URL shows that it is not found) or count on the dashboard.

A project cannot be deleted while it has any of the following.

- Unfinished tasks (other than completed and cancelled ones)
- Work still running or queued (such as audits)
- A question being answered

The dialog shows the count; complete or cancel the tasks, then delete the project again.

## Related pages

- [Issue, PR, and ticket intake](intake.en.md)
- [Working with tasks](tasks.en.md)
- [Context repository](context.en.md)
