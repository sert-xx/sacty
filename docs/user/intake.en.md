<!-- Code: packages/core/src/projects.ts (SactySettings, TicketSourceConfig), apps/daemon/src/intake.ts, apps/daemon/src/tickets.ts, apps/daemon/src/review-stop-notice.ts, apps/daemon/src/review-dispatch-count.ts, apps/web/src/i18n/messages/settings.ts, apps/web/src/i18n/messages/projects.ts, apps/daemon/src/suggestion-triage.ts, apps/daemon/src/triage-reply.ts -->

[日本語](intake.md) | **English**

# Issue, PR, and ticket intake

sacty regularly imports GitHub issues and PRs and JIRA tickets and turns them into tasks.
You set up intake in "Sacty settings" (the user menu) in the web UI.
The settings are shared by all projects (only the ticket intake sources are set per project, in the project settings).

This page explains, for each kind of intake, what is imported, how to set it up, what happens after the import, and what to watch out for.

- [Issues](#issues): issues with the label to import become tasks.
- [PR reviews](#pr-reviews): PRs that request your review and PRs with the review label become review-only tasks.
- [Reviewing PRs that sacty created](#reviewing-prs-that-sacty-created): for the PRs sacty creates, sacty creates a child task that reviews them (no label setting is needed).
- [JIRA tickets](#jira-tickets): tickets with the label to import become tasks.

For how often intake runs, see [Intake intervals](#intake-intervals); for how many tasks run at the same time, see [Running tasks in parallel](#running-tasks-in-parallel).

## Issues

sacty imports as tasks the open issues in the project's targets that have the label to import.

Set up intake as follows.

1. In the "Issue intake" section of "Sacty settings", enter the label in "Label to import".
2. Save.

These rules apply to the settings.

- If no label is set, nothing is imported.
- With "Import issues", you can turn this Off while keeping the label.
- The GitHub account used is the one chosen for that host in the project ([Project settings](project-settings.en.md#github-account)).

An imported issue proceeds as an ordinary task ([Working with tasks](tasks.en.md)).

PRs are not imported even if they have the label to import.

- PRs are imported by [PR reviews](#pr-reviews).
- If you want sacty to implement a PR, turn it into an issue and import that, or create a task from the web UI.
- Tasks of PRs that an earlier version imported with this label continue as they are.

## PR reviews

sacty imports PRs so that only their review is handed over.
It reviews an imported PR and posts the result to the PR as a review (comments).
It does no implementation or PR creation.

This section covers the following, in this order.

- What is imported and how to set it up: [Which PRs are imported](#which-prs-are-imported) and [Set up PR review intake](#set-up-pr-review-intake)
- After the import: [How a review proceeds](#how-a-review-proceeds), [The posted review](#the-posted-review), [After the review is posted](#after-the-review-is-posted), [Re-review](#re-review), and [When a review stops](#when-a-review-stops)
- Caution: [Do not import PRs you do not trust](#do-not-import-prs-you-do-not-trust)

### Which PRs are imported

sacty imports open PRs that match either of the following.

- PRs that request a review from you personally
  - These are requests to the GitHub account chosen for that host in the project (requests to teams are excluded).
- PRs with the review label

These rules apply to the intake.

- The same PR is never imported twice (except when a GitHub review re-request creates a new task; see [Re-review](#re-review)).
  A PR that already has a task (a task in any project, even a cancelled one) does not become a new task even if you add the label to it.
- PRs that sacty created are not imported ([Reviewing PRs that sacty created](#reviewing-prs-that-sacty-created)).
- Tasks of PRs imported by earlier versions remain as they are.

### Set up PR review intake

During a review, the PR's code runs in the agent's container.
Make sure you do not import PRs you do not trust ([Do not import PRs you do not trust](#do-not-import-prs-you-do-not-trust)).

1. In the "PR review intake" section of "Sacty settings", set either or both of the following, depending on which PRs you want to import.
   - To import PRs that request your review: turn on "Import PRs that request my review".
   - To import PRs with the review label: enter the label in "Label for PR reviews".
2. Save.

These rules apply to the review label.

- You can turn it Off with "Import PRs with the review label".
- The review label can have the same name as the label to import (for example, `sacty` for both; names that differ only in upper and lower case count as the same).
  - Even then, issues with that label are taken in as ordinary tasks and PRs as review-only tasks.
  - An issue is never taken in as a review, and a PR never as an ordinary task.

In the same section, you can also change who the posted review mentions ([The posted review](#the-posted-review)).

### How a review proceeds

For imported PRs, sacty only reviews them, without asking the Orchestrator to choose steps.
The task proceeds in this order.

1. The agent fetches dependencies for the code at the PR's head commit and runs verification such as tests and type checks.
2. The agent reviews the PR.
3. sacty posts the review to the PR ([The posted review](#the-posted-review)).
4. If the verdict is "no findings", the task is done. Otherwise it is not done, and sacty watches the PR for changes ([After the review is posted](#after-the-review-is-posted)).

When `images` is configured and no image is decided (not specified by the project's target, at creation, or on rerun), the Orchestrator chooses just the task image.
This is because the review runs the project's verification such as tests (see [Container images](images.en.md#which-image-a-task-runs-in)).

Verification runs as follows.

- In a re-review, the agent runs it again on the new commit. However, in a re-review of a PR whose main target is code, when the changes since the previous review are documents only, only the checks that apply to documents are run (the code tests are not run; see [Re-review](#re-review)).
- For verification it could not run (such as checks that need services like a DB, or secrets), the agent writes the command and the reason in the review body.
- When the PR's main target is a document (a design document, requirements, an ADR, or user documentation) and it has no code changes, the agent runs only the checks that apply to the changed documents.
  - Those are the checks the repository has, such as a document formatter, a markdown lint, and a link check.
  - The agent does not run code tests, builds, or type checks.
  - If there is no such check, it runs no verification.
- A PR that changes both documents and code (even if its main target is a document) runs all the verification.
- During verification, the PR's code runs in the agent's container ([Do not import PRs you do not trust](#do-not-import-prs-you-do-not-trust)).

If the PR description links to documents (such as a design written outside Git), the agent decides whether each is a review target or only background.
It decides from the PR title, description, and diff.

- The agent reviews documents it judges to be targets too.
  It cannot attach those findings to PR lines, so it writes them in the review body with the document and section.
- To let the agent read the documents, provide something that can read where they live, such as an MCP server, in the agent's environment.
- Documents it could not read are listed in the review's scope in the review body.

The agent reads the reviews and comments already on the PR and does not repeat the same problem.

- It checks whether an existing finding is unaddressed against the code and the author's replies.
  A thread that is merely not marked resolved does not count as unaddressed.
- Only when it confirms that a finding is unaddressed does the summary say that an existing finding is unaddressed, and then the verdict is not "no findings".

Requests outside the PR's purpose (the PR description, or the request, acceptance criteria or design it points to), such as adding a feature the change does not need or reworking an unrelated place, are not posted.
Only when some were dropped, the summary says the count in one line (not the content).
`[要修正]` findings are never dropped on the ground of being outside the purpose, and neither are findings when the purpose cannot be read or it is unclear whether they are inside.
In a re-review, when a previous finding is withdrawn as outside the purpose, its line in the previous-findings list says it was withdrawn and why.

If the PR changes before the review finishes, sacty behaves as follows.

- If the PR is pushed to while it is being reviewed, sacty posts the review against the reviewed commit and says in the review body which commit was reviewed.
- When the PR is merged or closed before the review is posted (also during a re-review run), the review task is cancelled.
  After the review is posted, the task is done instead of cancelled ([After the review is posted](#after-the-review-is-posted)).

### The posted review

The posted review starts with an @ mention of the PR author and the verdict ("修正が必要" (changes required), "提案あり（マージは可）" (suggestions only, OK to merge), or "指摘なし" (no findings)).
Findings start with `[要修正]` for those to fix before merging, and `[提案]` for those worth fixing.
The weight is decided from the size of the impact when the problem happens and how likely it is to happen.

- `[要修正]`: a problem with a large impact (data corruption or loss, security, an external effect that cannot be undone, a compatibility break), a failure to meet the acceptance criteria, or a defect that happens in ordinary use or under one condition.
- `[提案]`: a defect that happens only when two or more independent conditions coincide and whose impact is not large, or an improvement that breaks nothing if left alone.

Each finding states the conditions under which it happens and the harm when it does.

Who the @ mention goes to is decided as follows.

- When the PR author is a bot (such as `dependabot[bot]`), there is no @ mention, only the verdict.
- If you turn on "Mention me instead of the PR author in posted reviews" in "Sacty settings", the @ mention goes to the GitHub account chosen in the project (you, the poster) instead of the author (Off by default).
  - Only the @ mention in the body changes.
  - Even when it is on, the review is posted publicly on the PR.
    The author, who usually follows the PR, may still get GitHub's usual review notification.

When some viewpoints could not be checked (for example, checking documents against the implementation could not be finished), the review gives no verdict. The verdict line is "付いていません（レビューが判定を付けませんでした。…）" (the review gave no verdict), and the body starts with the viewpoints that could not be checked.
When the answer shows a verdict that sacty could not read, the verdict line is "読み取れませんでした" (could not be read).
In both cases, the round is not treated as having no findings. Read the body to check.
However, if what was checked has a `[要修正]` finding (including an earlier one, or another reviewer's, confirmed as unaddressed), the verdict is "修正が必要" (changes required).

For a PR that changes part of a long document, the review checks only the changed parts and the parts whose correctness those changes can affect against the implementation.
It does not check the whole of the unchanged text.

After the summary, the review body says in one line how the viewpoints were checked.
It gives the number of viewpoints when they were split among per-viewpoint reviewers, or says so when the reviewers could not be started and the viewpoints were checked one at a time.

At the end of the review, sacty writes in one line the kind of agent that reviewed (Claude Code or Codex), its model, and the number of per-viewpoint reviewers it started.
The agent names you gave in `config.yaml` are not written to the PR.
When the agent set for the review step was unavailable and its fallback agent ran the review, the line says so too ([Switching agents on failure](config.en.md#switching-agents-on-failure)).
sacty counts the reviewers from the run's records. When it cannot count them, the line says that the number could not be checked.
The review step of the task details shows the same information, together with the agent's name (the name you gave in `config.yaml`).

For a review imported from a GitHub PR (a review request or a label), a "リスク評価" (risk assessment) section for the PR is added right after the verdict, only in a round whose verdict is no findings. It is not added in a round with suggestions, required fixes, or no verdict.
It holds the level (low, medium, or high), the suggested review depth, the grounds, and the places to look at (the levels mean the same as in [PR risk assessment](tasks.en.md#pr-risk-assessment)).
The assessment is separate from the findings and the verdict, and does not change the verdict.
When it could not be assessed in a round with no findings, that is written and the review is posted as it is. A [review of a PR that sacty created](#reviewing-prs-that-sacty-created) gets this section in a round with no findings too, if it is a review of an implementation PR (not for a requirements or design PR, nor for a task that continues an existing PR; neither the section nor the "PR risk assessment" section appears for those).

The heading, verdict, and prefixes added by sacty are in Japanese.
The findings follow the writing rules of the repository (Japanese when there are none).

### After the review is posted

A review task is not done until the verdict becomes "no findings".
sacty watches the PR for changes and re-reviews automatically when the PR author responds.

While it watches, the task status is "Waiting on the PR", with the current verdict (changes required, suggestions, verdict unreadable, or no verdict given).
It waits for the PR author to respond, so nothing is needed from you.
It does not appear in "Needs you" or the bell in the header, and no completion notification is sent.

sacty handles changes of the PR as follows.

| What happened on the PR | What sacty does |
| --- | --- |
| A new commit was pushed | Re-reviews the latest commit |
| The PR author replied without adding a commit (an objection, "won't fix", and so on) | Reads the reply and judges the same commit again |
| It was merged, or closed without merging | Ends the watch and marks the task done |

- Consecutive pushes and replies are re-reviewed once, after things go quiet (2 minutes after the last change).
- A commit is re-reviewed only once, whether by a push or by a reply.
  If replies to the same commit continue after it was judged again, nothing starts automatically (use "Review again and post to the PR").
- Changes that happen during a re-review run are picked up after that review is posted.
  However, if the verdict of that review is "no findings", the task is done and a push during the run is not picked up (the posted review says that the latest commit was not reviewed; use "Review again and post to the PR").
- sacty's own posts (reviews and notices) and posts by bots are not treated as replies.
  This holds even when the PR author and sacty post from the same GitHub account.
- When the verdict becomes "no findings", the task is done.
  After that, nothing is re-reviewed automatically, whether a commit is pushed to the PR or the author replies. To review again after completion, use "Review again and post to the PR" (if the verdict of that round is not "no findings", the task is watched again).
- A task whose PR was merged or closed before reaching "no findings" has the status "Done (PR merged)" or "Done (PR closed)".
- There is no cap on the number of re-reviews.
  If a review run reaches the budget cap, the finished review is still posted to the PR. The task pauses before the next re-review, so raise the cap and resume it ([Pause, resume, and cancel](tasks.en.md#pause-resume-and-cancel)).
- For a PR whose last post was a while ago, it takes longer to notice a change (up to 5 minutes after 1 hour, up to 30 minutes after 24 hours).
- When 2 or more tasks review the same PR (for example, you also reviewed an imported PR with a review task you created), only the task created later re-reviews on changes of the PR.
- When you review a PR sacty created with a review task you created yourself, it is not re-reviewed on changes of the PR (the child task re-reviews that PR). It is done when the PR is merged or closed.

To stop the watch, pause or cancel the task in the task details.

- While paused, no re-review starts when the PR changes, and the task is not marked done when the PR is merged or closed.
  On resume it goes back to watching and picks up the changes that happened while it was paused.
- A cancelled task can no longer be re-reviewed.

A task that posted its review and completed in an earlier version stays done even if its verdict is not "no findings" (neither the watch nor an automatic re-review starts).
If you re-review such a task with "Review again and post to the PR", it is watched from that round on.

### Re-review

A re-review reviews the latest commit of the PR again and posts the result.
It says, for each previous finding, whether it is fixed or still open (it also reads the PR author's replies since the previous review; on a PR sacty created, the [replies to your comments](tasks.en.md#replies-to-your-comments) that sacty posted with the same GitHub account as the PR author are read as the author's replies too).
When a previous `[要修正]` is not fixed but turns out, on checking again, to be of `[提案]` weight, it is not counted as must-fix, and the summary says that the weight was reconsidered. This finding stays in the body only in the review of the round in which the weight was reconsidered. When it turns out to be of must-fix weight in a later round, it is raised as must-fix. A finding that the acceptance criteria or requirements are not met does not have its weight reconsidered and stays must-fix.

A re-review narrows what it looks at to the check of the previous findings and the changes from the head commit reviewed last time to the current head commit (the changes since the previous review).
Only a review that has a record of this sacty's own previous post is narrowed. A first review looks at the whole PR even when the PR already has reviews by other people or by other sacty instances.
The viewpoints it starts are those concerning the previous findings, the mismatch between the fix and the rest of the PR, those that match the changes since the previous review, and the safety viewpoint decided by the kind of those changes (C-3 for code, D-5 for a design document, U-5 for a user-facing document; for documents, the accuracy viewpoint too).
The "scope of the review" line of the review body says that the review was narrowed, the previous and current head commits, and the viewpoints that were not started.
Even a narrowed re-review runs the verification again on the new head commit. A `[要修正]` that it finds is reported even when it is outside the changes since the previous review.
A round where the author declined every finding, or replied without changing the code, has no changes since the previous review, so it only checks the previous findings.

In the following cases the re-review is not narrowed and reviews the whole PR with the same viewpoints as a first review:
the changes since the previous review cannot be confirmed (the previous head cannot be fetched, or the history was rewritten); the PR's target branch or the start of its diff (the target branch and the point where the PR branched from it) changed since last time; the previous round has no verdict (this includes a task created by a GitHub re-request); the previous round was counted as having started 0 per-viewpoint reviewers (a round whose reviewers could not be counted still narrows); a person pressed "review again" without adding a commit (a manual re-review of the same head looks at the whole PR); the lines changed since the previous review exceed half of the lines of the whole PR diff; many of the files changed since the previous review were not in the PR at the time of the previous review; the changes since the previous review cannot be handed over; or the task that made the PR submitted after going back to an earlier step and redoing it.
The reviewing AI may also decline to narrow when the previous body says some viewpoints were not covered, when the changes read as a rewrite, or when it is unsure. It then says so in one line of the "scope of the review".
How the verdict and the weight of findings are decided does not change. Even a narrowed re-review gives "changes required" when it finds a `[要修正]`.

When the changes since the previous review are documents only (documents such as `.md` files, not including instructions to agents, files under a directory that starts with `.`, or files under a skill's directory) and the PR's main target is code, the re-review also narrows the verification and runs only the checks that apply to documents (the code tests are not run).
The code tests that were not run are written in the "scope of the review" line of the review body.
When even one file that is not a document is included, when the difference from last time or the start of the PR diff cannot be confirmed, when there is no previous verdict, when a previous `[要修正]` reaches a file that is not a document, or when there is a file that is unclear as to whether it is a document, the verification is not narrowed either.

There are four ways to start a re-review.

- Do nothing: after posting the review, sacty watches the PR for changes and starts one automatically ([After the review is posted](#after-the-review-is-posted)).
- From the web UI: when you want it reviewed again right away, press "Review again and post to the PR" in the task details.
  sacty reruns the selected task. It works while the task is watching and after it is done.
- Ask your local AI: if you connect sacty's MCP server to Claude Code or Codex, you can ask it to "re-review this PR" ([Operating sacty from your local AI](mcp.en.md)).
  It is the same as starting from the web UI.
- Re-request the review on GitHub (Re-request review): this works for a PR taken in by a review request.
  sacty finds the re-request at the next intake and creates a new review task in the same project.

A re-request on GitHub is handled as follows.

- The original task keeps its status, post, activity, and cost.
  The new task reviews in a new execution session.
- If the original task was watching the PR, only the new task re-reviews on later changes of the PR (the same PR is not re-reviewed twice).
  The original task stays "Waiting on the PR" and is done when the PR is merged or closed.
- Each re-request creates one new task.
  Repeated intake of the same request and restarts do not add duplicates.
  A re-request after the new task completes creates another separate task.
- A new task is created only for requests made after the review was posted (after the task is done, or while it watches the PR).
  A request made during a review is not queued for another round.
  If you re-requested during a review, re-request again after the post or use "Review again and post to the PR" in the task details.
- For PRs taken in by the label, a re-request does not create a new task.
  While the task is watching, the same task re-reviews automatically on changes of the PR. After it is done with "no findings", use "Review again and post to the PR" in the task details.
- For PRs sacty created, a re-request does not create a new task either. A PR sacty created is re-reviewed by its child task ([Review of PRs sacty created](#the-review-child-task)).
- If the re-request cannot be checked, no automatic re-review starts; the intake result shows the reason, and sacty checks again next time.
  You can also start it manually with "Review again and post to the PR".

### When a review stops

When a review stops (an error, the AI usage limit, an authentication error, or the budget cap), sacty also tells the PR that asked for it, in a comment.
The comment says that the review stopped, the gist of the reason, and how to resume (a link to the task screen).

To resume, open the task on the screen and press "Resume".

- sacty continues from the step that stopped (if the review run stopped, sacty runs it again; if posting stopped, sacty posts the review it already wrote).
- When you resume and the review is posted, the stopped comment is rewritten as "resolved".

sacty writes the comment on the PR as follows.

- If the review stops for the same reason again, sacty does not write to the same PR again and again.
  If it stops for a different reason, sacty writes a separate comment.
- sacty does not write when you paused the task yourself.
- Even if sacty cannot write to the PR, the task stays paused (the screen and Slack notifications arrive separately).

Temporary failures are handled differently depending on their kind.

- When sacty's GitHub requests (checking the PR to review and posting the review) fail in a temporary way (a GitHub error, a rate limit, or a network failure), sacty does not stop. It waits and retries automatically (up to 4 times, after 15 seconds, 1 minute, 3 minutes, and 5 minutes).
  - While it retries, it writes no comment to the PR.
    If it keeps failing, it stops and writes the comment to the PR.
  - The retries appear in the task's activity.
  - A failure that waiting does not fix, such as missing permission or a PR that cannot be found, stops it right away.
- For a temporary failure of an agent run, such as a busy model, sacty does not retry on its own.
  If you write a fallback agent, sacty switches to it instead of stopping ([Switching agents on failure](config.en.md#switching-agents-on-failure)).

sacty does not use a review that was written without starting any per-viewpoint reviewer.

- sacty does not use that review's verdict and body, and does not post it to the PR.
  It tells the agent to start the reviewers and runs the review again automatically (up to 3 times).
  In the cost table of the task details, that run's result reads "Not used" (its cost is included in the task's cost).
- If reviews that start no reviewer continue after the retries, the task stops, and sacty also tells the PR in a comment.
  The reason reads "4 reviews in a row did not start any per-viewpoint reviewer (subagent)".
- When it stops, change the agent for the review step or fix the cause, then resume ([Changing a step's agent](tasks.en.md#changing-a-steps-agent)).
  Resuming reviews again.
- sacty retries only a run where it confirmed that the agent had a way to start reviewers.
  It does not retry a run where it could not confirm that, or a run whose reviewers it could not count, and uses that review.

### Do not import PRs you do not trust

During the verification of a review, the PR's code (dependency install scripts and tests) runs in the agent's container.
Do not put the review label on, or request a review for, PRs from forks or PRs whose author you do not trust.
The same applies when you choose "Review only" while creating a task.

The PR's code can reach the same things as the agent.

- It can read the agent's credentials in the container (such as the token for the AI service).
- When codex runs with a subscription, it can rewrite `auth.json` in the container.
  The rewrite is written back to the host's `auth_file` after the run and stays.
- During the run, through the gateway, it can read GitHub with the GitHub account chosen in the project and use the MCP servers given to the agent.
- Even in a bot's dependency update PR (such as `dependabot[bot]`), the install scripts of the new versions run.

Commits pushed to the PR after it was imported run in the same way.
This is because sacty keeps watching the PR for changes after posting its review until the verdict becomes "no findings" and, meanwhile, re-reviews automatically on every push ([After the review is posted](#after-the-review-is-posted)).
It does not check who pushed or whether the push comes from a fork. If a PR you trusted at import can later receive a push you do not trust, pause or cancel the task to stop the watch.
A task that is done with the verdict "no findings" does not move when a commit is pushed to the PR.

Intake does not filter by whether a PR comes from a fork or a bot.
With settings that add labels automatically, or automatic review requests such as CODEOWNERS, PRs may be imported without a person deciding.

## Reviewing PRs that sacty created

For each PR sacty creates (Requirements and Design PRs, and the implementation PR), sacty creates a child task that reviews that PR.
No label setting is needed.
sacty does not add a label to the PR either.

PRs sacty created are not taken in even if you add the review label or request a review (the child task reviews them).
The same applies to PRs to which an older version of sacty added the label.

This section covers the following, in this order.

- The child task: [The review child task](#the-review-child-task) and [When the child task is cancelled](#when-the-child-task-is-cancelled)
- The review findings: [How findings reach the original task](#how-findings-reach-the-original-task) and [How AI review comments are handled](#how-ai-review-comments-are-handled)
- Caution: [What to check before you approve or merge](#what-to-check-before-you-approve-or-merge)

### The review child task

sacty creates one child task per PR.

- sacty opens the implementation PR as a draft and creates the child task right after it is opened.
  When the child task gives "no findings", sacty removes the draft ([Review of the implementation PR](tasks.en.md#review-of-the-implementation-pr)).
- An implementation PR stacked on a dependency's PR gets its child task when the dependency is merged and the PR is retargeted.
- Updating the PR does not create a new child task.
- When the PR is recreated (it becomes a PR with a new number), a child task is created for the new PR.

For a requirements or design PR whose original task still has an implementation step, the child task looks only at direction and gaps (the implementation PR is reviewed separately later).
Implementation details (internal structure, names, procedures) and the values and granularity of test viewpoints are checked in the implementation PR review. If a written approach or test viewpoint misleads the direction or misses an acceptance criterion, it is still raised on the requirements or design PR.
Implementation PRs and PRs of tasks with no remaining implementation (design-only, task split) are reviewed with all viewpoints.

The child task appears on the screen as follows.

- The child task is a "PR review only" task titled "[PR #number] title of the original task" (the same whatever the screen language).
- In "Related tasks" of the task detail, links to each other appear.
  They appear as "PR review" on the original task and "Reviews the PR of" on the child task.
- The links on the original task also show the child task's status (queued, waiting on the PR, cancelled, and so on), so you can tell them apart when a reopened PR has several child tasks.
- Its cost counts toward the child task's budget.
- A child task, too, is not done until the verdict becomes "no findings", and shows "Waiting on the PR".
  What the child task waits for is the original task. Its re-review starts when, for example, the original task updates the PR and goes back to waiting for approval ([How findings reach the original task](#how-findings-reach-the-original-task)).
  Approving and merging the original task are not blocked while the child task is "Waiting on the PR".

### When the child task is cancelled

The child task is cancelled in these cases.

- You merge or close the PR before the child task posts its review (also during a re-review run)
- You cancel the original task

If you merge or close the PR after the review is posted, the child task is done instead of cancelled.

If you reopen the PR of a child task that was cancelled by the close, sacty creates a new child task and reviews it again (a child task you cancelled is not recreated).

### How findings reach the original task

The findings of the child task's review reach the original task as follows.

1. sacty posts the child task's review to the PR.
2. If its verdict is changes required or suggestions only (OK to merge), the review reaches the original task as PR findings right after it is posted.
   When your own comments arrive at the same time, sacty waits for you to finish writing, so they reach the task together after about 2 minutes.
   The original task fixes them in the step the child task gave for each finding ([Approval in PRs](tasks.en.md#approval-in-prs-requirements-design-implement)).
   For suggestions (`[提案]`) on an implementation PR, an AI decides, before fixing and with the scope of the PR in mind, whether this PR handles each one. Suggestions it does not handle are not fixed, and sacty replies on the PR with the reason. To have one fixed, comment on the PR asking for that suggestion to be fixed ([Sorting AI review suggestions](tasks.en.md#sorting-ai-review-suggestions)).
   Must-fix findings (`[要修正]`) are always fixed.
3. When the original task fixes them, updates the PR, and goes back to waiting for approval, the child task reviews the latest commit again right away.
4. Steps 2 and 3 repeat until there are "no findings" (there is no limit on the number of rounds; the cost of repetition stops at each task's budget).
   When every suggestion is declined and nothing is left to fix, the original task does not update the PR, and the child task reviews the same commit once more.
   A review with no findings is not delivered and does not request changes (the task waits for the PR to be merged).

The child task reviews with the same image as the original task. No agent run is needed to choose the image.
Only when the original task's image cannot be determined, an agent chooses the image.

### How AI review comments are handled

sacty tells the findings of the child task's review apart, as "AI review comments", from the comments you wrote.
The review is posted with the same GitHub account as yours, but sacty recognizes it by the marker (`sacty-review:`) put in the post.

- The Activity, the approval screen, the dashboard, and the audit show them separately as "AI review".
- A request for changes made only of AI review comments is not counted in the number of requests for changes by you.
- They are passed to agents separately from your comments.
  "The previous comment" and similar words in your comments are treated as pointing to your comments.

### What to check before you approve or merge

The approval screen and the task detail show the following two things about the AI review.

The first is the comments that sacty discarded without delivering them to the original task.

- If the PR was updated after the review was made (the commit the review targeted differs from the PR's current head), sacty discards that review instead of delivering it.
  That it was discarded, and why, remain in the Activity.
- The discarded comments are shown on the approval screen and the task detail as "AI review comments not taken in" (the reason, the PR's commit at the time of discarding, the target commit, the gist of each comment, and a link to GitHub).
  They stay until the PR is merged, so check them before you approve or merge.
- When the original task goes back to waiting for approval, the child task reviews the current PR again.

The second is whether a Sacty AI review is attached to the current commit of the PR awaiting approval (not attached, reviewing, or attached).

- A review takes a while to reach a commit created by a rework.
  Approving or merging before it arrives means going ahead without seeing its comments.
- sacty does not block approving or merging.
- The "Conclusion" of the PR body also gets one line with the state when the body was written.
  A review that arrives later is not reflected, so check the approval screen for the latest state.

## JIRA tickets

sacty turns unfinished JIRA tickets (Jira Cloud, Jira Server / Data Center) that have the label to import into tasks.
Set up intake in this order.

1. Write the JIRA connection as an organization platform (PF) ([Write the JIRA connection](#write-the-jira-connection)).
2. Write the ticket sources in the project settings, and set the label to import in "Sacty settings" ([Set the ticket sources and the label](#set-the-ticket-sources-and-the-label)).

For what happens after the import, see [After a ticket is imported](#after-a-ticket-is-imported).

### Write the JIRA connection

Write the JIRA connection as an organization platform (PF) (`gateway.platforms` in `config.yaml`, or `platforms.yaml` in the context repository).
There are no JIRA-specific settings (see [Gateway](gateway.en.md#organization-platform-pf-apis) for how to write a PF).

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

- The daemon does not call APIs that are not in `allow` either.
- Behavior is not guaranteed if you choose a connection that is not JIRA.

To keep the token out of command arguments and your shell history, create the Jira Cloud value (base64 of `email:API token`) as follows (bash or zsh).
The commands read the token with hidden input, pass it to `base64` on standard input, and put the result on the clipboard.
After you paste it into the 1Password item (`basic` of `JiraCloud` in the example settings), clear the clipboard.

```sh
printf 'API token: '; read -rs JIRA_TOKEN; echo
printf '%s' "me@example.com:$JIRA_TOKEN" | base64 | tr -d '\n' | pbcopy; unset JIRA_TOKEN
# after pasting it into 1Password
pbcopy < /dev/null
```

### Set the ticket sources and the label

1. In "Ticket sources" in the project settings, write the following three items.
   - The connection (the name you wrote for the organization platform)
   - The kind (Jira Cloud / Jira Server, Data Center)
   - The JIRA project key (such as `PAY`. Uppercase letters, digits, and `_`, starting with an uppercase letter)
2. In the "Ticket intake" section of "Sacty settings", enter the label to import and save.

These rules apply to the ticket sources and the label.

- You can write more than one source per project.
- The same key on the same connection of a PF in `config.yaml` can be written in only one project.
  sacty identifies PFs in `platforms.yaml` of the context repository together with the project, so you can write ticket sources with the same name and key in different projects (different connections).
- The label to import is shared by all ticket sources.
- You can turn ticket intake Off with "Import tickets".

### After a ticket is imported

Ticket intake and the task that follows proceed as follows.

- The daemon searches only for the ticket keys and summaries.
- When the task starts, the information gatherer reads the ticket through the gateway (up to the parent story and epic, linked tickets, and URLs in comments).
- From the gathered information, the information gatherer chooses the repository to work in from the project's targets and writes the task title and summary ([Information gathering at the start of a task](tasks.en.md#information-gathering-at-the-start-of-a-task)).
  - If it cannot choose a repository, the task stops.
  - You can choose the repository on the task page and resume.
- sacty comments the investigation results and the PR URL on the ticket (it does not change the ticket status).

## Intake intervals

Intake runs at a separate interval for each kind: "Issue intake", "PR review intake", and "Ticket intake".
You set the interval in "Intake interval (seconds)" in each section of "Sacty settings".

- Enter an integer of 60 or more (seconds).
  If you leave it empty, it is 300 seconds.
  You cannot save values shorter than 60 or values that are not integers, and the web UI shows the reason.
- A changed interval takes effect from the next intake without stopping the daemon.
- For a kind whose intake is stopped, the field shows the interval that will apply once intake starts.
- Even if one kind fails or hits a GitHub rate limit, the other kinds keep being imported.

In the following cases, sacty imports without waiting for the interval to pass.

- When the daemon starts: sacty imports every kind right away.
- When you press "Import now" on the project page: sacty imports every kind.
- When you save "Sacty settings": sacty imports the kinds that are On and have their labels and so on set, within 30 seconds.
  - After that, they are imported at the new interval.
  - Kinds that are Off, or that do not have their labels and so on set, are not imported even when you save.
  - If a kind is being imported when you save, the new intake starts at the check (every 30 seconds) after the current intake ends.
    If the intake takes long, it starts later than 30 seconds.

The project page shows the last intake for each kind, and the targets that could not be imported together with which kind they belong to (kinds that are not On are not shown).

As long as there are at most 30 targets, adding projects does not add GitHub searches.

- sacty combines up to 30 targets of the same domain and account, across projects, into one search for each kind.
  Beyond 30, sacty splits the search.
- sacty decides which project each item belongs to after it is found.

You do not need any intake settings in `config.yaml`.
sacty imports JIRA tickets without `github:` too.
sacty does not read `github:` (`poll_interval_sec`) from earlier versions even if it is written.

## Running tasks in parallel

sacty runs queued tasks at the same time, oldest first, up to "Tasks to run at the same time" in "Sacty settings" (1 to 10. 3 if empty).
The more you allow, the more load on your machine and the more of your AI usage limits are consumed.

## Related pages

- [Project settings](project-settings.en.md)
- [Working with tasks](tasks.en.md)
