<!-- Code: packages/core/src/projects.ts (SactySettings, TicketSourceConfig), apps/daemon/src/intake.ts, apps/daemon/src/tickets.ts, apps/daemon/src/config.ts (github), apps/web/src/i18n/messages/settings.ts -->

[日本語](intake.md) | **English**

# Issue, PR, and ticket intake

sacty regularly imports GitHub issues and PRs and JIRA tickets and turns them into tasks. Intake settings are shared by all projects, and
you set them in "sacty settings" (the user menu) in the web UI.

## Turn on intake

Intake runs only when you write `github:` in `config.yaml` (if you omit it, no issues, PRs, or tickets are imported, not even with
"Import now" in the web UI).

```yaml
github:
  poll_interval_sec: 300   # how often to import (seconds. 60 or more. Default 300)
```

You can change the interval without stopping the daemon. Use "Import now" on the project page to import without waiting for the interval.

## Issues and PRs

- Open issues and PRs in the project's targets that have the "Label to import" from "sacty settings" are imported as tasks.
  If no label is set, nothing is imported.
- With "Import issues" and "Import PRs", you can turn them Off while keeping the label.
- The GitHub account used is the one chosen for that host in the project ([Project settings](project-settings.en.md#github-account)).

## PR reviews

You can also hand over just the review of PRs ("PR review intake" in "sacty settings").

- If you turn on "Import PRs that request my review", PRs that request a review personally from the GitHub account chosen for that host in the project
  are imported (requests to teams are excluded).
- PRs with the "Label for PR reviews" (separate from the label to import) are imported too. You can turn this Off with "Import PRs with the review label".
- Imported PRs are only reviewed, without the Orchestrator, and the review is posted to the PR (as comments). No implementation or PR creation is done.
- When the PR is merged or closed, review tasks that have not finished are cancelled.
- When new commits are pushed, use "Review again" in the task details to review the latest commit again and post it.

## Reviewing PRs that sacty created

If the "Label to import" is set, sacty adds that label to every PR it creates (implementation PRs, and Requirements and Design PRs).

- If the repository does not have the label, sacty creates it first. If the label cannot be added (permissions and so on), the PR is left as it is, and the reason appears in the task's Activity.
- A labeled PR becomes, at the next intake, a separate "PR review only" task apart from the task that created it. The review is posted to the PR, and if it has findings that
  should be fixed, they reach the creating task as PR findings, and the Goal Guardian decides where to go back to and fixes them. A review with nothing to fix (the PR can be merged
  as is) is not delivered and does not request changes (the task waits for the PR to be merged).
- The label is added once per PR. Updating the PR with fixes does not add it again or create a new review task (to have it reviewed again,
  use "Review again" on the review task). A label that someone removed is not added again either.
- If "Import PRs" is Off, the label is not added (because the PR would not be imported).

## JIRA tickets

Write the JIRA connection (Jira Cloud, Jira Server / Data Center) as an organization platform (PF) (`gateway.platforms` in `config.yaml`, or
`platforms.yaml` in the context repository). There are no JIRA-specific settings (see [Gateway](gateway.en.md#organization-platform-pf-apis) for how to write a PF).

```yaml
gateway:
  platforms:
    jira:                                     # Jira Server / Data Center (personal access token)
      upstream: https://jira.example.com
      description: JIRA
      auth:
        header: Authorization
        prefix: "Bearer "
        secret: op://Work/Jira/token
      allow:
        - GET /rest/api/2/search              # intake (the daemon searches for tickets)
        - GET /rest/api/2/issue/**            # the Orchestrator reads the ticket, its parent, and subtasks
        - POST /rest/api/2/issue/*/comment    # comments the investigation results and the PR URL
    jira-cloud:                               # Jira Cloud (base64 of email:API token)
      upstream: https://acme.atlassian.net
      description: JIRA Cloud
      auth:
        header: Authorization
        prefix: "Basic "
        secret: op://Work/JiraCloud/basic     # echo -n 'me@example.com:<API token>' | base64
      allow:
        - GET /rest/api/3/search/jql
        - GET /rest/api/2/issue/**
        - GET /rest/api/3/issue/**
        - POST /rest/api/2/issue/*/comment
```

- In "Ticket sources" in the project settings, write the connection (the name above), the kind (Jira Cloud / Jira Server, Data Center), and the JIRA project
  key (such as `PAY`. Uppercase letters, digits, and `_`, starting with an uppercase letter). You can write more than one per project.
- The same key on the same connection of a PF in `config.yaml` can be written in only one project. PFs in `platforms.yaml` of the context repository
  are identified together with the project, so you can write ticket sources with the same name and key in different projects (different connections).
- Unfinished tickets with the label to import in "Ticket intake" of "sacty settings" (shared by all ticket sources) become tasks.
  You can turn this Off with "Import tickets".
- The daemon searches only for the ticket keys and summaries. The Orchestrator reads the ticket through the gateway (and, for a subtask, its parent and the other subtasks),
  chooses the repository to work in from the project's targets, and writes the task title and summary. If it cannot choose, the task stops, and you can
  choose the repository on the task page and resume.
- The investigation results and the PR URL are commented on the ticket (the ticket status is not changed).
- APIs not in `allow` are not called by the daemon either. Behavior is not guaranteed if you choose a connection that is not JIRA.

## Running tasks in parallel

Queued tasks run at the same time, oldest first, up to "Tasks to run at the same time" in "sacty settings" (1 to 10. 3 if empty).
The more you allow, the more load on your machine and the more of your AI usage limits are consumed.

## Related pages

- [Project settings](project-settings.en.md)
- [Working with tasks](tasks.en.md)
