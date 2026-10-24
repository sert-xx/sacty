<!-- Code: packages/core/src/projects.ts (SactySettings, TicketSourceConfig), apps/daemon/src/intake.ts, apps/daemon/src/tickets.ts, apps/web/src/i18n/messages/settings.ts, apps/web/src/i18n/messages/projects.ts -->

[日本語](intake.md) | **English**

# Issue, PR, and ticket intake

sacty regularly imports GitHub issues and PRs and JIRA tickets and turns them into tasks. Intake settings are shared by all projects. You set them in "Sacty settings" (the user menu) in the web UI.

## Intake intervals

Intake runs at a separate interval for each kind: "Issue intake", "PR review intake", and "Ticket intake". You set the interval in "Intake interval (seconds)" in each section of "Sacty settings".

- Enter an integer of 60 or more (seconds). If you leave it empty, it is 300 seconds. You cannot save values shorter than 60 or values that are not integers, and the web UI shows the reason.
- A changed interval takes effect from the next intake without stopping the daemon. When the daemon starts, it imports every kind right away.
- When you save "Sacty settings", sacty behaves as follows.
  - Kinds that are On and have their labels and so on set are imported within 30 seconds (without waiting for the interval to pass). After that, they are imported at the new interval.
  - Kinds that are Off, or that do not have their labels and so on set, are not imported even when you save.
  - If a kind is being imported when you save, the new intake starts at the check (every 30 seconds) after the current intake ends. If the intake takes long, it starts later than 30 seconds.
  - For a kind whose intake is stopped, the field shows the interval that will apply when intake starts.
- Even if one kind fails or hits a GitHub rate limit, the other kinds keep being imported.
- GitHub searches combine up to 30 targets of the same domain and account, across projects, for each kind. Beyond 30, sacty splits the search. So as long as there are at most 30 targets, adding projects does not add searches. sacty decides which project each item belongs to after it is found.
- "Import now" on the project page imports every kind without waiting for the interval. The project page shows the last intake for each kind, and the targets that could not be imported together with which kind they belong to (kinds that are not On are not shown).
- You do not need any intake settings in `config.yaml`. sacty imports JIRA tickets without `github:` too. sacty does not read `github:` (`poll_interval_sec`) from earlier versions even if it is written.

## Issues

- sacty imports as tasks the open issues in the project's targets that have the "Label to import" in "Issue intake" of "Sacty settings". If no label is set, nothing is imported.
- PRs are not imported even if they have the label to import. PRs are imported by "PR reviews" below. If you want sacty to implement a PR, turn it into an issue and import that, or create a task from the web UI. Tasks of PRs that were already imported continue as they are.
- With "Import issues", you can turn this Off while keeping the label.
- The GitHub account used is the one chosen for that host in the project ([Project settings](project-settings.en.md#github-account)).

## PR reviews

PRs are imported so that only their review is handed over ("PR review intake" in "Sacty settings").

- If you turn on "Import PRs that request my review", sacty imports PRs that request a review from you personally. These are requests to the GitHub account chosen for that host in the project (requests to teams are excluded).
- PRs with the "Label for PR reviews" are imported too. You can turn this Off with "Import PRs with the review label".
- The review label can have the same name as the label to import (for example, `sacty` for both; names that differ only in upper and lower case count as the same). Even then, issues with that label are taken in as ordinary tasks and PRs as review-only tasks. An issue is never taken in as a review, and a PR never as an ordinary task.
- For imported PRs, sacty only reviews them, without asking the Orchestrator to choose steps, and posts the review to the PR (as comments). It does no implementation or PR creation. When `images` is configured and the project's target does not specify an image, the Orchestrator chooses just the image for the review step. This is because the review runs the project's verification such as tests (see [Container images](images.en.md#which-image-a-step-runs-in)).
- The agent fetches dependencies for the code at the PR's head commit and runs verification such as tests and type checks before reviewing. In a re-review, it runs them again on the new commit. For verification it could not run (such as checks that need services like a DB, or secrets), it writes the command and the reason in the body.
- If the PR description links to documents (such as a design written outside Git), the agent decides from the PR title, description, and diff whether each is a review target or only background.
  - The agent reviews documents it judges to be targets too. It cannot attach those findings to PR lines, so it writes them in the body with the document and section.
  - To let the agent read the documents, provide something that can read where they live, such as an MCP server, in the agent's environment.
  - Documents it could not read are listed in the review's scope in the body.
- When the PR is merged or closed, review tasks that have not finished are cancelled.
- The posted review starts with an @ mention of the PR author and the verdict ("修正が必要" (changes required), "提案あり（マージは可）" (suggestions only, OK to merge), or "指摘なし" (no findings)).
  - When the PR author is a bot (such as `dependabot[bot]`), there is no @ mention, only the verdict.
  - If you turn on "Mention me instead of the PR author in posted reviews" in "Sacty settings", the @ mention goes to the GitHub account chosen in the project (you, the poster) instead of the author (Off by default). Only the @ mention in the body changes. The review is still posted publicly on the PR, and the author, who usually follows the PR, may still get GitHub's usual review notification.
  - Findings start with `[要修正]` for those to fix before merging, and `[提案]` for those worth fixing.
  - The heading, verdict, and prefixes added by sacty are in Japanese. The findings follow the writing rules of the repository (Japanese when there are none).
- If the PR is pushed to while it is being reviewed, sacty posts the review against the reviewed commit and says in the body which commit was reviewed.
- When new commits are pushed, use "Review again" in the task details to review the latest commit again and post it.
  - For a PR taken in by a review request, re-requesting the review on GitHub (Re-request review) makes Sacty find it at the next intake and create a new review task in the same project. The original completed task keeps its status, post, activity, and cost, while the new task reviews in a new execution session.
  - Each re-request creates one new task. Repeated intake of the same request and restarts do not add duplicates. A re-request after the new task completes creates another separate task.
  - PRs taken in by the label and PRs sacty created are not re-reviewed by a re-request (use "Review again").
  - Automatic re-review applies only to requests made after the review was posted and the task completed. A request made during a review is not queued for another round. If you re-requested during a review, re-request again after completion or use "Review again" in the task details.
  - If the re-request cannot be checked, no automatic re-review starts; the intake result shows the reason, and sacty checks again next time. You can also start it manually with "Review again".
  - "Review again" in the UI continues to rerun the selected task as before.
  - A re-review says, for each previous finding, whether it is fixed or still open (it also reads the PR author's replies since the previous review).
- Only open PRs are imported for review.
- Except when a GitHub review re-request creates a new task, the same PR is never imported twice. A PR that already has a task (a task in any project, even a cancelled one) does not become a new task even if you add the label to it.
- Tasks of PRs imported by earlier versions remain as they are.

## Reviewing PRs that sacty created

If the "Label for PR reviews" is set, sacty adds that label to every PR it creates (implementation PRs, and Requirements and Design PRs). It does not add the label to import.

- If the repository does not have the label, sacty creates it first. If sacty cannot add the label (permissions and so on), the PR is left as it is, and the reason appears in the task's Activity.
- A labeled PR becomes, at the next intake, a separate "PR review only" task apart from the task that created it. The review is posted to the PR.
  - If its verdict is changes required or suggestions only (OK to merge), the review reaches the creating task as PR findings. The Goal Guardian decides where to go back to and fixes them (the task's budget stops the cost of repetition).
  - A review with no findings is not delivered and does not request changes (the task waits for the PR to be merged).
- Even if the review label has the same name as the label to import, a labeled PR becomes a "PR review only" task only once, and never an implementation task. Its findings reach the creating task in the same way.
- sacty adds the label once per PR. Updating the PR with fixes does not add it again or create a new review task (to have it reviewed again, use "Review again" on the review task). sacty does not add back a label that someone removed either.
- Even if "Import PRs with the review label" is Off, sacty still adds the label. While it is Off, the PRs are not imported; once you turn it back On, the PRs still open at that time are imported. Intake only searches open PRs, so PRs merged or closed while it was Off are not imported.

## JIRA tickets

Write the JIRA connection (Jira Cloud, Jira Server / Data Center) as an organization platform (PF) (`gateway.platforms` in `config.yaml`, or `platforms.yaml` in the context repository). There are no JIRA-specific settings (see [Gateway](gateway.en.md#organization-platform-pf-apis) for how to write a PF).

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
        - GET /rest/api/2/issue/**            # the information gatherer reads the ticket, its parent, and subtasks
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

To keep the token out of command arguments and your shell history, create the Jira Cloud value (base64 of `email:API token`) as follows (bash or zsh). The commands read the token with hidden input, pass it to `base64` on standard input, and put the result on the clipboard. After you paste it into the 1Password item (`basic` of `JiraCloud` in the example above), clear the clipboard.

```sh
printf 'API token: '; read -rs JIRA_TOKEN; echo
printf '%s' "me@example.com:$JIRA_TOKEN" | base64 | tr -d '\n' | pbcopy; unset JIRA_TOKEN
# after pasting it into 1Password
pbcopy < /dev/null
```

- In "Ticket sources" in the project settings, write the following three items. You can write more than one source per project.
  - The connection (the name above)
  - The kind (Jira Cloud / Jira Server, Data Center)
  - The JIRA project key (such as `PAY`. Uppercase letters, digits, and `_`, starting with an uppercase letter)
- The same key on the same connection of a PF in `config.yaml` can be written in only one project. sacty identifies PFs in `platforms.yaml` of the context repository together with the project, so you can write ticket sources with the same name and key in different projects (different connections).
- sacty turns unfinished tickets with the label to import in "Ticket intake" of "Sacty settings" (shared by all ticket sources) into tasks. You can turn this Off with "Import tickets".
- The daemon searches only for the ticket keys and summaries. When the task starts, the information gatherer reads the ticket through the gateway (up to the parent story and epic, linked tickets, and URLs in comments), chooses the repository to work in from the project's targets based on the gathered information, and writes the task title and summary ([Information gathering at the start of a task](tasks.en.md#information-gathering-at-the-start-of-a-task)). If it cannot choose, the task stops. You can choose the repository on the task page and resume.
- sacty comments the investigation results and the PR URL on the ticket (it does not change the ticket status).
- The daemon does not call APIs that are not in `allow` either. Behavior is not guaranteed if you choose a connection that is not JIRA.

## Running tasks in parallel

sacty runs queued tasks at the same time, oldest first, up to "Tasks to run at the same time" in "Sacty settings" (1 to 10. 3 if empty). The more you allow, the more load on your machine and the more of your AI usage limits are consumed.

## Related pages

- [Project settings](project-settings.en.md)
- [Working with tasks](tasks.en.md)
