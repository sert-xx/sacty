<!-- Code: packages/core/src/projects.ts (SactySettings, TicketSourceConfig), apps/daemon/src/intake.ts, apps/daemon/src/tickets.ts, apps/daemon/src/review-stop-notice.ts, apps/web/src/i18n/messages/settings.ts, apps/web/src/i18n/messages/projects.ts -->

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
- For imported PRs, sacty only reviews them, without asking the Orchestrator to choose steps, and posts the review to the PR (as comments). It does no implementation or PR creation. When `images` is configured and no image is decided (not specified by the project's target, at creation, or on rerun), the Orchestrator chooses just the task image. This is because the review runs the project's verification such as tests (see [Container images](images.en.md#which-image-a-task-runs-in)).
- The agent fetches dependencies for the code at the PR's head commit and runs verification such as tests and type checks before reviewing. In a re-review, it runs them again on the new commit. For verification it could not run (such as checks that need services like a DB, or secrets), it writes the command and the reason in the body.
  - When the PR's main target is a document (a design document, requirements, an ADR, or user documentation) and it has no code changes, the agent runs only the checks that apply to the changed documents that the repository has (a document formatter, a markdown lint, a link check, and the like). It does not run code tests, builds, or type checks. If there is no such check, it runs no verification. A PR that changes both documents and code (even if its main target is a document) runs all the verification as before.
  - During verification, the PR's code (dependency install scripts and tests) runs in the agent's container. The PR's code can reach the same things as the agent.
    - It can read the agent's credentials in the container (such as the token for the AI service).
    - When codex runs with a subscription, it can rewrite `auth.json` in the container. The rewrite is written back to the host's `auth_file` after the run and stays.
    - During the run, through the gateway, it can read GitHub with the GitHub account chosen in the project and use the MCP servers given to the agent.
    - Even in a bot's dependency update PR (such as `dependabot[bot]`), the install scripts of the new versions run.
  - Do not put the review label on, or request a review for, PRs from forks or PRs whose author you do not trust. Intake does not filter by whether a PR comes from a fork or a bot. With settings that add labels automatically, or automatic review requests such as CODEOWNERS, PRs may be imported without a person deciding. The same applies when you choose "Review only" while creating a task.
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
- sacty reads the reviews and comments already on the PR and does not repeat the same problem.
  It checks whether an existing finding is unaddressed against the code and the author's replies. A thread that is merely not marked resolved does not count as unaddressed.
  Only when it confirms that a finding is unaddressed does the summary say that an existing finding is unaddressed, and then the verdict is not "no findings".
- When a review stops (an error, the AI usage limit, an authentication error, or the budget cap), sacty also tells the PR that asked for it, in a comment: that it stopped, the gist of the reason, and how to resume (a link to the task screen).
  - Open the task on the screen and press "Resume" to continue from the step that stopped (if the review run stopped, sacty runs it again; if posting stopped, sacty posts the review it already wrote).
  - If it stops for the same reason again, sacty does not write to the same PR again and again. If it stops for a different reason, it writes a separate comment.
  - When you resume and the review is posted, the stopped comment is rewritten as "resolved".
  - sacty does not write when you paused the task yourself. If sacty cannot write to the PR, the task stays paused (the screen and Slack notifications arrive separately).
  - When sacty's GitHub requests (checking the PR to review and posting the review) fail in a temporary way (a GitHub error, a rate limit, or a network failure), sacty does not stop. It waits and retries automatically (up to 4 times, after 15 seconds, 1 minute, 3 minutes, and 5 minutes).
    While it retries, it writes no comment to the PR. If it keeps failing, it stops and writes the comment above.
    The retries appear in the task's activity. A failure that waiting does not fix, such as missing permission or a PR that cannot be found, stops it right away.
  - For a temporary failure of an agent run, such as a busy model, sacty does not retry on its own. If you write a fallback agent, sacty switches to it instead of stopping ([Switching agents on failure](config.en.md#switching-agents-on-failure)).
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

For each PR sacty creates (Requirements and Design PRs, and the implementation PR), sacty creates a child task that reviews that PR.
No label setting is needed, and sacty does not add a label to the PR.
The implementation PR is opened as a draft before the final review, and the child task is created when it moves to review (when it is marked ready; [The implementation PR and CI](tasks.en.md#the-implementation-pr-and-ci)).
An implementation PR stacked on a dependency's PR waits for approval as a draft, so its child task is created when the dependency is merged and the draft is removed.

- The child task is a "PR review only" task titled "[PR #number] title of the original task" (the same whatever the screen language).
  In "Related tasks" of the task detail, links to each other appear as "PR review" on the original task and "Reviews the PR of" on the child task.
  The links on the original task also show the child task's status (queued, cancelled, and so on), so you can tell them apart when a reopened PR has several child tasks.
  Its cost counts toward the child task's budget.
- The child task's review is posted to the PR.
  - If its verdict is changes required or suggestions only (OK to merge), the review reaches the original task as PR findings.
    The Goal Guardian decides where to go back to and fixes them.
  - When the original task fixes them, updates the PR, and goes back to waiting for approval, the child task reviews the latest commit again.
    This repeats until there are "no findings" (there is no limit on the number of rounds; the cost of repetition stops at each task's budget).
  - A review with no findings is not delivered and does not request changes (the task waits for the PR to be merged).
  - The findings of this review are told apart as "AI review comments" from the comments you wrote.
    The review is posted with the same GitHub account as yours, but it is recognized by the marker (`sacty-review:`) put in the post.
    - The Activity, the approval screen, the dashboard, and the audit show them separately as "AI review".
    - A request for changes made only of AI review comments is not counted in the number of requests for changes by you, or in the limit on requests for changes to the same step (3).
    - They are passed to agents separately from your comments. "The previous comment" and similar words in your comments are treated as pointing to your comments.
  - If the PR was updated after the review was made (the commit the review targeted differs from the PR's current head), that review is discarded instead of delivered.
    That it was discarded, and why, remain in the Activity.
    The discarded comments are shown on the approval screen and the task detail as "AI review comments not taken in" (the reason, the PR's commit at the time of discarding, the target commit, the gist of each comment, and a link to GitHub). They stay until the PR is merged, so check them before you approve or merge.
    When the original task goes back to waiting for approval, the child task reviews the current PR again.
  - The approval screen and the task detail also show whether a Sacty AI review is attached to the current commit of the PR awaiting approval (not attached, reviewing, or attached). A review takes a while to reach a commit created by a rework, so approving or merging before it arrives means going ahead without seeing its comments. Approving and merging are not blocked. The "Conclusion" of the PR body also gets one line with the state when the body was written (a review that arrives later is not reflected, so check the approval screen for the latest state).
- There is one child task per PR. Updating the PR does not create a new child task. When the PR is recreated (it becomes a PR with a new number), one is created for the new PR.
- If you merge or close the PR before the child task finishes, the child task is cancelled. It is also cancelled when you cancel the original task.
  If you reopen a closed PR, a new child task is created and reviews it again (a child task you cancelled is not recreated).
- PRs sacty created are not taken in even if you add the review label or request a review (the child task reviews them).
  The same applies to PRs to which an older version of sacty added the label.

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
