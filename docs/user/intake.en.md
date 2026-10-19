<!-- Code: packages/core/src/projects.ts (SactySettings, TicketSourceConfig), apps/daemon/src/intake.ts, apps/daemon/src/tickets.ts, apps/web/src/i18n/messages/settings.ts, apps/web/src/i18n/messages/projects.ts -->

[日本語](intake.md) | **English**

# Issue, PR, and ticket intake

sacty regularly imports GitHub issues and PRs and JIRA tickets and turns them into tasks. Intake settings are shared by all projects, and
you set them in "sacty settings" (the user menu) in the web UI.

## Intake intervals

Intake runs at a separate interval for each kind: "Issue intake", "PR review intake", and "Ticket intake".
You set the interval in "Intake interval (seconds)" in each section of "sacty settings".

- Enter an integer of 60 or more (seconds). If you leave it empty, it is 300 seconds. Values shorter than 60 or not integers cannot be saved, and the reason is shown in the web UI.
- A changed interval takes effect from the next intake without stopping the daemon. When the daemon starts, every kind is imported right away.
- When you save "sacty settings", the kinds that are On and have their labels and so on set are imported within 30 seconds (without waiting for the interval to pass).
  After that, they are imported at the new interval. Kinds that are Off, or that do not have their labels and so on set, are not imported even when you save.
  If a kind is being imported when you save, the new intake starts at the check (every 30 seconds) after the current intake ends
  (if the intake takes long, it starts later than 30 seconds). For a kind whose intake is stopped, the field shows
  the interval that will apply when intake starts.
- Even if one kind fails or hits a GitHub rate limit, the other kinds keep being imported.
- GitHub searches combine up to 30 targets of the same domain and account, across projects, for each kind (beyond 30, the search is split).
  So as long as there are at most 30 targets, adding projects does not add searches. sacty decides which project each item belongs to after it is found.
- "Import now" on the project page imports every kind without waiting for the interval. The project page shows the last intake for each kind, and
  the targets that could not be imported together with which kind they belong to (kinds that are not On are not shown).
- You do not need any intake settings in `config.yaml`. JIRA tickets are imported without writing `github:` too. `github:`
  (`poll_interval_sec`) from earlier versions is not read even if written.

## Issues

- Open issues in the project's targets that have the "Label to import" in "Issue intake" of "sacty settings" are imported as tasks.
  If no label is set, nothing is imported.
- PRs are not imported even if they have the label to import. PRs are imported by "PR reviews" below (if you want sacty to implement a PR, turn it into an issue
  and import that, or create a task from the web UI). Tasks of PRs that were already imported continue as they are.
- With "Import issues", you can turn this Off while keeping the label.
- The GitHub account used is the one chosen for that host in the project ([Project settings](project-settings.en.md#github-account)).

## PR reviews

PRs are imported so that only their review is handed over ("PR review intake" in "sacty settings").

- If you turn on "Import PRs that request my review", PRs that request a review personally from the GitHub account chosen for that host in the project
  are imported (requests to teams are excluded).
- PRs with the "Label for PR reviews" are imported too. You can turn this Off with "Import PRs with the review label".
- The review label can have the same name as the label to import (for example, `sacty` for both; names that differ only in upper and lower case count as the same).
  Even then, issues with that label are taken in as ordinary tasks and PRs as review-only tasks. An issue is never taken in as a review, and a PR
  never as an ordinary task.
- Imported PRs are only reviewed, without the Orchestrator, and the review is posted to the PR (as comments). No implementation or PR creation is done.
- If the PR description links to documents (such as a design written outside Git), the agent decides from the PR title, description, and diff whether each is a review target or only background.
  Documents judged to be targets are reviewed too, and their findings go in the body (they cannot be attached to PR lines), with the document and section.
  To let the agent read them, provide something that can read where the documents live, such as an MCP server, in the agent's environment. Documents it could not read are listed in the review's scope in the body.
- When the PR is merged or closed, review tasks that have not finished are cancelled.
- The posted review starts with an @ mention of the PR author and the verdict ("修正が必要" (changes required), "提案あり（マージは可）" (suggestions only, OK to merge), or "指摘なし" (no findings)).
  When the PR author is a bot (such as `dependabot[bot]`), there is no @ mention, only the verdict.
  Findings start with `[要修正]` for those to fix before merging, and `[提案]` for those worth fixing.
  The heading, verdict, and prefixes added by sacty are in Japanese. The findings follow the writing rules of the repository (Japanese when there are none).
- If the PR is pushed to while it is being reviewed, the review is posted against the reviewed commit, and the body says which commit was reviewed.
- When new commits are pushed, use "Review again" in the task details to review the latest commit again and post it.
  For a PR taken in by a review request, re-requesting the review on GitHub (Re-request review) makes sacty find it at the next intake and review it again automatically.
  Each re-request starts one re-review. PRs taken in by the label and PRs sacty created are not re-reviewed by a re-request (use "Review again").
  The activity shows "Started a re-review because a review was re-requested on the PR".
  A re-review says, for each previous finding, whether it is fixed or still open (it also reads the PR author's replies since the previous review).
- Only open PRs are imported for review.
- The same PR is never imported twice. A PR that already has a task (a task in any project, even a cancelled one) does not become a new task even if you add the label
  to it.
- Tasks of PRs imported by earlier versions remain as they are.

## Reviewing PRs that sacty created

If the "Label for PR reviews" is set, sacty adds that label to every PR it creates (implementation PRs, and Requirements and Design PRs)
(it does not add the label to import).

- If the repository does not have the label, sacty creates it first. If the label cannot be added (permissions and so on), the PR is left as it is, and the reason appears in the task's Activity.
- A labeled PR becomes, at the next intake, a separate "PR review only" task apart from the task that created it. The review is posted to the PR, and if its verdict is changes
  required, it reaches the creating task as PR findings, and the Goal Guardian decides where to go back to and fixes them. A review with suggestions only (OK to merge)
  or no findings is not delivered and does not request changes (the task waits for the PR to be merged).
- Even if the review label has the same name as the label to import, a labeled PR becomes a "PR review only" task only once, and never an
  implementation task. Its findings reach the creating task in the same way.
- The label is added once per PR. Updating the PR with fixes does not add it again or create a new review task (to have it reviewed again,
  use "Review again" on the review task). A label that someone removed is not added again either.
- Even if "Import PRs with the review label" is Off, the label is still added. While it is Off, the PRs are not imported; once you turn it back On, the PRs still
  open at that time are imported (PRs merged or closed while it was Off are not, because intake only searches open PRs).

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
        secret: op://Work/JiraCloud/basic     # see below for how to create the value
      allow:
        - GET /rest/api/3/search/jql
        - GET /rest/api/2/issue/**
        - GET /rest/api/3/issue/**
        - POST /rest/api/2/issue/*/comment
```

To keep the token out of command arguments and your shell history, create the Jira Cloud value (base64 of `email:API token`) as follows
(bash or zsh). The token is read with hidden input, passed to `base64` on standard input, and the result is put on the clipboard. After you paste it into
the 1Password item (`basic` of `JiraCloud` in the example above), clear the clipboard.

```sh
printf 'API token: '; read -rs JIRA_TOKEN; echo
printf '%s' "me@example.com:$JIRA_TOKEN" | base64 | tr -d '\n' | pbcopy; unset JIRA_TOKEN
# after pasting it into 1Password
pbcopy < /dev/null
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
