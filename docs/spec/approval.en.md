[日本語](approval.md) | **English**

# Approval and request changes

At a step with an approval gate, the task moves to the next step when a person approves it. A person approves in sacty's web UI or by merging a PR to the target repository (approval = merge).

Requesting changes redoes the work from the chosen step. When requests for changes to the same step exceed the limit, the task goes to Escalation (waiting for a person's decision).

Related ADRs: [Remove the "PR作成" step and open the PR and wait for approval inside the Implementation step](../adr/20261015-1430-superseded-implement-step-opens-pull-request.md), [Split intake into "Issue intake" and "PR review intake", and add the review label to sacty's PRs](../adr/20261015-0240-superseded-split-issue-and-pr-review-intake.md), [Label PRs sacty opens for intake, and import reviews from another task as comments on the original task's PR](../adr/20261014-1445-superseded-label-sacty-pull-requests-for-review.md), [Fill the body of PRs sacty opens with fixed rules following the headings of the repository's or Org's PR template](../adr/20261014-1517-pr-body-follows-repository-template.md), [If the implementation has no changes, open no PR and complete without changes after a person checks it](../adr/20261014-2216-superseded-complete-without-changes.md), [Import rounds with findings posted by a sacty task that refers to the PR as comments on the original task's PR, however that task was taken in](../adr/20261025-2245-import-sacty-reviews-from-any-intake.md), [Open the implementation PR as a draft before the final review, let the Goal Guardian judge after waiting for CI, and on a pass mark it ready for review](../adr/20261027-2330-draft-pull-request-before-final-review.md)

## Approval in the web UI

- Approval is possible when all of the following hold.
  - The status is `awaiting_approval` or `escalated`
  - The step is the step waiting for approval (`gate.step`)
  - The submission round the web UI was showing (`submission`) is the current round (otherwise `gate.staleSubmission`)
- Document drafts and successful Operation results are approved in the web UI.
  - Operation has no pre-execution approval gate; it performs the request and then waits for result approval.
  - Changes cannot be requested after execution starts.
  - Failure or an unknown result cannot be approved to complete the task and requires checking external state.
- A Reproduce (`reproduce`) awaiting approval (the bug was not reproduced) cannot be approved.
- Steps that opened a PR (Implementation, and Requirements or Design with a PR) cannot be approved from the web UI (`gate.approveOnPullRequest`). An implementation for which no PR was opened because the implementation had no changes is approved in the web UI ("When the implementation has no changes" below).
- Approved results are fixed (an approved step's output does not change later). After approval, the next step becomes waiting to run if it can run, and otherwise the task becomes `idle`.

Code: `apps/daemon/src/service.ts` (`approve`, `gateTask`, `nextAfterApproval`), `packages/core/src/projection.ts` (`StepApproved` in `applyEvent`)

## Approval through PRs

Requirements and Design (`StepPullRequestKey`) and Implementation are approved through PRs. The implementation PR is opened as a draft inside the Implementation step before the final review ([Tasks and steps](tasks-and-steps.en.md#the-implementation-pr-and-ci-before-the-final-review)), and is marked ready for review once it passes verification ([Tasks and steps](tasks-and-steps.en.md#the-pr-for-a-verified-implementation)). Approval, Request changes, approval by merging the PR, and importing PR comments work the same for the three steps.

When Requirements, Design, and Implementation are all approved through PRs, the branches look like this (an example where the task ID starts with 1a2b3c4d).

![Branches when approving through PRs](images/approval-branches.en.svg)

- Whether a task is approved through PRs (`stepPullRequestsOn`)
  - If it has a task branch, it is always approved through PRs.
  - A task that takes over an existing PR (`Task.continuedPullRequest`) does not open Requirements and Design as PRs ([Taking over an existing PR](tasks-and-steps.en.md#taking-over-an-existing-pr)).
  - Without a task branch, it is approved through PRs when all of the following hold.
    - There is a target repository
    - The requirements and design have not yet been submitted in the web UI
    - The project has a GitHub account for that host
- The task branch `sacty/task-<first 8 chars of task ID>` is created from the base commit of the base branch (`TaskBranchCreated`).
- PRs for Requirements and Design
  - sacty writes the result to the file `<documentsDir>/<first 8 chars of task ID>/<step>.md` and opens it as a PR from the step branch `<task branch>-<step>-<round>` to the task branch.
  - The Orchestrator decides `documentsDir`. If its shape is not usable, the default `docs/sacty` (`DEFAULT_DOCUMENTS_DIR`) is used.
  - An HTML comment saying sacty created the file is put at its top, and the design includes the test viewpoints.
- Whether the Requirements or Design PR is recreated
  - If that step's PR is open and the head of the task branch has not changed, the same PR is updated (redoing that step).
  - In the following cases, a new branch and PR are created from the latest task branch, and the earlier open PR is closed.
    - The PR has been merged or closed
    - The task branch moved because a fix to an earlier step was merged
  - If a PR cannot be opened, the reason is recorded and the task stops.
- The implementation PR
  - If there is a task branch, the implementation is stacked on the latest task branch and opened as a PR from the task branch to the base branch (the implementation PR).
  - If there is no task branch, it is opened as a PR from a sacty branch (`sacty/task-<first 8 characters of the task ID>`) to the base branch.
  - If changes other than the requirements and design files have been stacked on the task branch, publishing stops (`pr.taskBranchChanged`).
  - A task that takes over an existing PR opens no PR; it pushes to the source branch of the taken-over PR and uses that PR as the implementation PR.
- Each child task of Task split has its own task branch.
- The "review" link in the web UI (`personAction`)
  - The link appears in the task details, the task list, "Needs you" on the dashboard, and the header notifications.
  - When all of the following hold, the link opens the PR in a new tab (`reviewPullRequestUrl`). The label is "Review on the PR", and the sacty approval screen is skipped (PBI-136).
    - The task is `awaiting_approval`
    - The PR of the current submission (`gatePullRequest`) is `open`
    - The PR's URL starts with `https://`
  - In an escalation with a change proposal the Goal Guardian could not judge (`change_undecidable`; one a person has not decided yet; `openProposal`), the link goes to "Change requests and verdicts" in the task details (`/tasks/<ID>#proposals`).
  - In the following cases, the link goes to the sacty approval screen (`/tasks/<ID>/review`).
    - Any other escalation (such as confirming the step to redo for PR comments)
    - The task is `awaiting_approval` and the PR for the current submission is not open (it was closed, or it was merged and the next check has not recorded the approval yet) or does not exist
  - A link that opens outside is marked with "↗" and, for screen readers, "opens in a new tab" (`ActionLink`).
  - From the notifications, it opens without switching the project.
  - On the dashboard and in the notifications, the link is the task title, so only the title is truncated and the mark is placed outside the truncation. The mark stays even for a long title (PR #148 review suggestion).

Code (web UI links): `apps/web/src/lib/labels.ts` (`personAction`, `personLink`, `reviewPullRequestUrl`), `packages/core/src/projection.ts` (`openProposal`), `apps/web/src/components/action-link.tsx` (`ActionLink`, `ExternalMark`)

Code: `apps/daemon/src/service.ts` (`stepPullRequestsOn`, `taskBranchName`, `publishStepPullRequest`, `publish`), `packages/core/src/events.ts` (`StepPullRequestKey`, `DEFAULT_DOCUMENTS_DIR`, `isDocumentsDir`), `packages/core/src/projection.ts` (`stepDocumentPath`), `apps/daemon/src/prompts.ts` (`buildStepDocument`)

## When the implementation has no changes

When opening the PR for a verified implementation, if the implementation workspace has not changed at all from the base commit (`NothingToCommitError`), no PR is opened.

- If no implementation PR has been opened yet, `NoChangesFound` (the Implementation round to be submitted next) is recorded, and the implementation is submitted (`StepSubmitted`). Since there is no PR, it can be approved in the web UI. This applies to every task (not only template tasks).
- Before the submission, the tests and the final review (verification per viewpoint) have passed as usual. The web UI shows the approval wait as "Implement awaiting approval with no changes". The approval screen says the implementation changed nothing and asks you to check the reason no change is needed in the implementation notes.
- Approving completes the task without opening a PR ("Done (no changes)"). Requesting changes redoes the work from Implementation as usual, and a PR is opened if there are changes. The no-changes handling applies only to that submission round (`deliveredWithoutChanges`: `noChanges.submission` is the current Implementation round and there is no PR).
- The same applies when there is a task branch (with the requirements and design PRs merged). No PR to the base branch is opened, and the task branch remains.
- In a task that already opened an implementation PR, if the redone implementation ends up with no changes, the reason (`pr.failed`, `git.nothingToCommit`) is recorded and the task stops, as before. A person decides what to do with the open PR.
- The Implementation step's instructions say that if it turns out no change is needed, the agent should leave the files unchanged and write the reason and evidence in the notes.

Code: `apps/daemon/src/service.ts` (`publish`), `packages/core/src/events.ts` (`NoChangesFound`), `packages/core/src/projection.ts` (`noChanges`, `deliveredWithoutChanges`), `apps/daemon/src/prompts.ts` (`NO_CHANGE_LINE`), `apps/web/src/lib/labels.ts` (`statusText`)

## The review label on PRs

sacty adds the review label (sacty's setting `reviewLabel`) to every PR it opens (the implementation PR and the requirements and design PRs).
Requirements and design PRs get it right after being opened, and the implementation PR when it moves to review (when it is marked ready).
While it is a draft before the final review, the label is not added (the record has no `label` either). This is so that the PR is taken in as a separate task (a PR-review-only task) and reviewed in a context separate from the task that opened it ([Ticket intake and GitHub](intake.en.md)). The intake label (`intakeLabel`) is not attached.

- If no review label is configured, the label is not attached. Nothing is recorded.
- It is attached even if its triage is Off (`reviewLabel` in `triageOff`). This is so that PRs opened while it was temporarily Off are taken in once it is back On, if they are still open then. Nothing is taken in while it is Off. Intake searches with `is:open is:pr`, so PRs merged or closed while it was Off are not taken in.
- If the repository does not have the label (`GET /repos/<owner>/<name>/labels/<label>` returns 404), it is created (`POST .../labels`, color `0e8a16`) and then attached to the PR (`POST .../issues/<number>/labels`). If it was created elsewhere in the meantime (422 `already_exists`), it is attached as is.
- The result is recorded as follows and appears on the task's Activity screen.
  - Once attached, `PullRequestLabeled` (`created`: the label was created)
  - If it could not be attached, `PullRequestLabelFailed`. It holds which operation failed (`getLabel`, `createLabel`, or `addLabel` of `github.failed`) and GitHub's response. The secret values used are redacted.
  - Failing to attach the label does not make opening the PR fail (the task proceeds to waiting for approval).
- The label is attached only once per PR (repository and number).
  - A PR with a record does not get the label again when the same PR is updated. There are no duplicate labels, no re-adding a label a person removed, and no retry after failure.
  - A PR without a record (for example, one opened before the setting was configured) gets the label the next time it is updated.
  - When the PR is recreated (the earlier PR was merged or closed and a PR with a new number was opened), the new PR gets the label.
- If cancel or pause was requested and the requirements or design PR was not recorded, the label is not attached.
- The plan to attach is kept in the PR's publish record (`label` in `PullRequestPublished` and `StepPullRequestPublished`) before attaching.
  - A PR that stopped (shutdown or crash) after the publish was recorded but before the label was attached gets the label from the PR check (every 60 seconds, also after restart). The check attaches it when there is a plan, there is no record of attaching or failing, and the PR is open.
  - The label attached is the review label in the settings at that time.
  - It is not attached for canceled tasks or if the current setting does not attach (no review label).
  - If the same PR is in the middle of being labeled, it is not labeled again.
- `intakeLabel` in older records (a plan to attach the intake label) can still be read but is not treated as a plan to attach (the ledger is not rewritten).

Code: `apps/daemon/src/service.ts` (`labelPullRequest`, `labelDue`, `resumePullRequestLabels`, `publishStepPullRequest`, `publish`), `apps/daemon/src/github.ts` (`GitHubPullRequests.addLabel`), `packages/core/src/projection.ts` (`pullRequestLabels`)

## The PR check

Every 60 seconds the daemon checks the PRs of tasks that have a PR for the current submission (`gatePullRequest`) and are waiting for approval (`awaiting_approval`) or escalated (`escalated`) (the next check does not start until the previous one finishes).

- Merged: `PullRequestMerged` and `StepApproved` (both with actor `person`) are recorded.
  - It is also approval when the PR was merged with content different from sacty's submission (the PR's head differs from sacty's commit) (`edited`).
  - For Requirements and Design, the file is read from the merge commit, and the version the person edited becomes the approved result. If the file was deleted or cannot be read, sacty's version is approved. If it cannot be fetched, nothing is recorded and the next check tries again.
- Closed without merging: `PullRequestClosed` is recorded, and instead of approving, the task waits for a person's decision. It cannot be approved from the web UI (request changes or cancel).
- Reopened: `PullRequestReopened` is recorded and watching continues.
- Unchanged: if the PR is still open and the task is `awaiting_approval`, the following are done in order.
  1. For an implementation PR, a change in the conflict with the base branch is recorded ([Showing a conflict with the base branch](#showing-a-conflict-with-the-base-branch)).
  2. Reviews and comments are imported as comments to address ([Importing PR comments](#importing-pr-comments)).
- If the status, PR, or commit changes during the check, nothing is recorded.
- If the PR is merged, or closed without merging, while comments are being imported (for example while the Goal Guardian is judging), changes are not requested. The status is read again within the same check and recorded as the merged or closed case above ([Importing PR comments](#importing-pr-comments)).
- When an implementation PR is merged and the after-merge watch step is not skipped, the after-merge watch starts in the same append ([After-merge watch](deployment-watch.en.md)).
- At the end of the check, the following are done in order.
  1. Memories whose PR promoting them to context was merged are deleted (`cleanupPromotedMemories`; [Memory](memory.en.md#promotion-to-context)).
  2. For PR review intake tasks that have not finished, the PR is checked, and the task is cancelled if the PR was merged or closed without merging (`checkReviewPullRequests`).
  3. PRs that stopped after the publish but before the label was attached get the label (`resumePullRequestLabels`; [The review label on PRs](#the-review-label-on-prs)).
  4. The CI of tasks waiting for the CI of the implementation PR opened before the final review is checked (`checkVerificationCi`; [Tasks and steps](tasks-and-steps.en.md#the-implementation-pr-and-ci-before-the-final-review)).
  5. The CI/CD of tasks waiting for the after-merge watch is checked (`checkDeployments`).

### Showing a conflict with the base branch

When another PR is merged while the task waits for approval and the implementation PR conflicts with the base branch, the task screen and "Needs you" show it.
It only shows it; the base branch is not merged in (it is merged in, before the implementation is redone, when a person rejects the task or writes a PR comment. [Merging the base branch](tasks-and-steps.en.md#merging-the-base-branch)).

- How a conflict is judged: the `mergeable` of the GitHub PR that the PR status check (`GitHubPullRequests.status`) reads.
  `false` is a conflict and `true` is no conflict. While GitHub is still computing it (`null`), or when it cannot be read, the answer is unknown and the earlier record is kept (`mergeable` of `PullRequestStatus` is present only for `true` and `false`).
  It is part of the one request that reads the PR status, so the number of requests to GitHub does not grow.
- Recording: it is recorded with actor `sacty`, only when the conflict changes. The same state is not recorded twice.
  - Conflicted: `PullRequestConflicted`. It is held in `Task.pullRequestConflict` (the PR number, the commit of the submission at that time, and the time).
  - Resolved (a person fixed it on GitHub, or the base branch went back): `PullRequestConflictResolved`. It clears `Task.pullRequestConflict`.
  - Only the implementation PR of a task in `awaiting_approval` is recorded. The Requirements and Design PRs (PRs to the task branch) and escalated tasks are not.
  - Nothing is started: no run, no merge, no PR update, and no write to GitHub.
- When it is shown (`pullRequestConflict`): the task is waiting for approval, the PR of the Implement gate is open, the recorded PR number and commit are the same as the current submission, and the Goal Guardian is not judging PR comments (`pendingReview`).
  - The record is cleared when the PR is created again or updated (`PullRequestPublished`), and when it is merged, closed, or reopened (`PullRequestMerged`, `PullRequestClosed`, `PullRequestReopened`).
    When it is reopened, the next check looks again.
  - It is not shown once the task is rejected and no longer waits for approval.
- Where it is shown:
  - The status text (`statusText`) becomes "Implement PR conflicts with the base branch". It is the same in "Needs you" on the dashboard, in the header notifications, and in the task list and details. The task still needs you, and the row in "Needs you" opens the PR.
  - The rows of "Needs you" (the dashboard, and the cards above the task list) carry a note on how to merge the base in ("Send it back or comment on the PR to merge the base branch in"; `AttentionRow.note`, `NeedsYouCard.note`). The header notifications show only the status.
  - The waiting-for-approval notice in the task details and the PR block of the approval screen explain how to merge the base in (send the task back with a comment from this screen, or write a comment on the GitHub PR).
  - The Activity shows "PR #N conflicts with the base branch" and "The conflict on PR #N is resolved".
- The judgment does not decide whether the PR can be merged. If a person merges it while it conflicts, it is approved as a normal merge.

Code: `apps/daemon/src/service.ts` (`checkPullRequests`, `recordPullRequestConflict`), `apps/daemon/src/github.ts` (`GitHubPullRequests.status`), `packages/core/src/projection.ts` (`pullRequestConflict`, `Task.pullRequestConflict`), `apps/web/src/lib/labels.ts` (`statusText`), `apps/web/src/lib/dashboard-data.ts` (`attentionRows`), `apps/web/src/lib/task-list-data.ts`, `apps/web/src/components/task-detail.tsx` (`GateNotice`), `apps/web/src/components/gate-form.tsx`

Code: `apps/daemon/src/service.ts` (`checkPullRequests`, `readMergedDocument`, `cleanupPromotedMemories`, `checkReviewPullRequests`, `resumePullRequestLabels`, `checkVerificationCi`, `checkDeployments`), `apps/daemon/src/pr-watcher.ts` (`PullRequestWatcher`)

## PR body and PR template

Related ADRs: [Fill the body of PRs sacty opens with fixed rules following the headings of the repository's or Org's PR template](../adr/20261014-1517-pr-body-follows-repository-template.md)

Whenever sacty opens or updates a PR, it looks for the PR template of the repository where the PR is opened, and if there is one, writes the body in the shape of its headings and items. This covers the implementation PR and the requirements and design PRs (the same goes for PRs of fix tasks created by the after-merge watch).

If there is no template or it cannot be used, sacty uses its own fixed body (`buildPullRequestBody`, `buildStepPullRequestBody`). In either case, opening the PR does not stop.

### Assembling the implementation PR body

The implementation PR body is written to be read short, conclusion first. The full text of the approved requirements and design, and long review text, are not included; they become a link or a collapsed section. The fixed body (`buildPullRequestBodyText`) contains, in this order:

1. The task ID line, and `Closes #<number>` (for a task taken in from an Issue)
2. "結論" (Conclusion)
   - Summary of the change: the head of the first paragraph (only lines without indentation; excluding headings, tables, code blocks, and indented lines) of the Implementation step's output. When there is no output, the line is left out.
   - The final review's verdict and the head of its summary. "（なし）" when there is no final review yet, and a note when it is being verified.
   - The record that a person moved the task on despite the failed final review, and the failed points (if any; `overrideBodyLines`)
   - What a person should confirm (if any; `humanCheckBodyLines`)
3. The approved requirements (the bug reproduction for a reproduce task; `approvedBasisLines`)
   - The full text is not included; only the head of the first paragraph and where the full text is (`approvedBasisDigest`). The full text is at the URL and file path of the requirements and design PRs approved by merging. With no PR, "全文は sacty のタスクの画面で確かめてください。" is written.
   - A task that skipped the requirements step, and the fix scope of a security fix, are short, so they stay as before.
4. "変更" (Changes): the Implementation step's output. Left out when it is the same as the change summary in the conclusion. When there is no output, the heading is left out too.
5. The exported results
6. Viewpoint → test → result
   - The table columns are "観点", "テスト", and "最終レビュー". The viewpoint is the ID and title (up to 60 characters), the test is the name of the first test (up to 70 characters) and "ほか N 件", and the final review is only ✅ or ❌.
   - Below the table is the test line (the "テスト：" line above).
   - Each viewpoint's input, expected result, all tests, and the final review's findings go into the collapsed section "観点ごとの詳細" outside the table.
7. The full text of the final review (collapsed). Shown only when it is longer than the head shown in the conclusion, or when there is a recurrence check of earlier remarks.

The common rules are as follows.

- Sentences that report the progress of the work are removed from the Implementation step's output (`withoutProgressReport`). The removed sentences are those of 100 characters or fewer that contain both a topic word (commit, push, reflecting to GitHub, and so on) and a state word (not done, incomplete, sacty does it, and so on). Only sentences in lines that are outside a code fence and do not start with whitespace are touched. Lines of code blocks (CommonMark fences: indentation of 0 to 3 spaces, closed by the same character at least as long as the opening), tables, and headings, and every indented line (code inside a list, indented code, and so on), are left alone. The rule does not parse Markdown piece by piece and errs on the side of keeping: one leftover progress sentence does less harm than broken code. The summary of the change (`leadParagraph`) also uses only lines without indentation. The Implementation step's output is saved with the indentation of its first line kept (only blank lines before and after and trailing whitespace are removed; `keepIndent` of `extractBlocks`; other steps still trim as before). The instructions for implementation also say that the notes are put into the PR body as they are and that progress reports are not to be written (`IMPLEMENT_REPORT_LINE`).
- The leading "合格。" or "不合格。" of the final review's summary is removed (the verdict is written separately, so it is not repeated as "合格。合格。").
- A long sentence in the conclusion is cut at a sentence break ("。") within `BODY_LEAD_MAX` (240 characters). If there is no break, "…" is added.

### Finding the template

sacty looks on the default branch, and file and directory names are case-insensitive. Once one is found in an earlier position, it is read at that point, and the listings of directories later in the order (such as `docs/`) are not fetched.

1. In the target repository, `.github/pull_request_template.md` → `pull_request_template.md` at the root → `docs/pull_request_template.md`
2. If none exist, the first `.md` by name order (case-insensitive) in the `PULL_REQUEST_TEMPLATE/` directories in the same order (`.github/`, the root, `docs/`). GitHub does not use multiple templates in a directory as the default, but sacty picks one.
3. If the target repository has none, the same locations in the Org's (or user's) `.github` repository (`https://<host>/<owner>/.github`). As with GitHub, only a public one (`private: false`) is used. If private, it is not used and this is noted. If the target is the `.github` repository itself, it is not searched.

A template is judged absent or unusable as follows.

- Treated as absent: a 404 on the repository or directory listing (including empty repositories and repositories that cannot be seen).
- Unusable (`unusable`)
  - A failure other than 404 when fetching a listing or file, a network failure, or a timeout (30 seconds for the whole search)
  - Larger than 32 KiB (`TEMPLATE_MAX_BYTES`; the size is judged from the listing's value without reading the content)
  - Not readable as UTF-8
  - Whitespace only
- If it is unusable in the target repository, the Org's `.github` is not searched.

### Filling the template

`fillTemplate` fills it, and no agent is used.

- The template is split by headings, and the kind is decided from the heading text.
  - Headings are lines `#` to `######` and lines that are bold in full such as `**概要**`. Those inside code blocks and HTML comments are excluded.
  - The kind is decided by matching `CATEGORY_RULES` from the top. The kinds are headings that cannot be filled (checklists, screenshots, breaking changes, other, and so on), related Issues, tests, changes, and purpose/summary.
  - For each kind, sacty's content goes only into the first matching heading.
- Explanations, example text, and code blocks in a heading are removed; HTML comments and checkboxes are kept. All checkboxes are unchecked, even if checked in the template (because sacty has not checked them).
- Headings with no content or that do not apply get "該当なし（sacty は記入していません）" (Not applicable; sacty did not fill this in) (`NOT_APPLICABLE`). Headings with checkboxes do not get it (only the unchecked checkboxes remain). Before the first heading, only comments and checkboxes remain.
- Content of the implementation PR (`buildPullRequestBodyParts`)
  - Purpose: the final review's verdict and the head of its summary, the number of items for a person to confirm (if any, "この PR の末尾にあります" (it is at the end of this PR)), and the head and the location of the full text of the approved requirements (the bug reproduction for a reproduce task)
  - Changes: the Implementation step's output (without progress reports)
  - Tests: the viewpoint → test → result table and the test results (6 in [Assembling the implementation PR body](#assembling-the-implementation-pr-body))
  - Related Issue: `Closes #<number>` (for a task taken in from an Issue)
  - The exported results and the full text of the Goal Guardian's final review go into "the sacty record".
  - What a person should confirm and the record that a person moved on despite the failure go into the last part (footer).
- Content of the requirements and design PRs (`buildStepPullRequestBodyParts`)
  - Purpose: which step's result it is (and the approved earlier steps)
  - Changes: the result's file and the responses to comments
  - Related Issue: `#<number>` (a reference only; merging into the task branch does not close it)
  - There are no tests.
- Content that did not fit into a heading and "the sacty record" are placed at the end of the body in a collapsible section (`<details>`). If no heading could take any content (such as a template without headings), the purpose, changes, and tests are placed without collapsing. If the related Issue does not fit into a heading, it is placed before the last part.
- The last part (footer) always contains the following.
  - A note that sacty created the PR and the task's ID (`sacty task <ID>`)
  - Guidance that merging means approval of that step, and how to give comments (the implementation PR, and the requirements and design PRs)

### Length, secret values, and the ledger

- Length (`limitBody`)
  - The body is kept to 65,000 characters (`PR_BODY_MAX`). This is a bit shorter than GitHub's limit of 65,536 characters and is measured by JavaScript length.
  - If it is longer, the end of the part before the last part is cut, and a note that it was cut (`TRUNCATED_NOTE`) is written. HTML comments, code blocks, and collapsible sections left open at the cut are closed.
  - The same limit applies to bodies that do not use a template (`buildPullRequestBodyText`, `buildStepPullRequestBodyText`). The last part (the note that sacty created the PR and the guidance that merging means approval of the implementation) is not cut.
  - Parts that cannot be cut (`keep`) are the task ID line, `Closes #<number>` (including one placed in a template heading), the guidance that merging the requirements and design PRs means approval, and, in the fixed body, what a person should confirm and the record that a person moved on despite the failure, both placed in the conclusion. If, after cutting, one of them does not remain in the body as a whole line (with line boundaries before and after) outside HTML comments and code blocks, it is put back before the last part. `Closes #12` is not considered to remain just because `Closes #123` is present.
- Secret values: secret values used in opening that PR (such as the GitHub token) are redacted from the body (`[REDACTED]`). So that the cut-off head of a secret is not left by a summary or truncation (the summary of the change, test names and viewpoint titles in the table, the items a person should check, the findings of an override, and so on), they are redacted from every string of the task before the body is built (`PullRequestBodyStage.secrets`). The replacement just before publishing is kept too. The reason text kept in the ledger is also redacted.
- Ledger: `template` in `PullRequestPublished` and `StepPullRequestPublished` keeps the following.
  - The template used (`repo`: the URL of the repository where the template was, `path`)
  - Or the reason for using the fixed shape (`fallback`: `none` or `unusable`; `message`: `pr.templateFailed`, `pr.templateTooLarge`, `pr.templateInvalid`, `pr.templateEmpty`, `pr.templateOrgPrivate`, and so on)
  - `truncated` if it was cut
  - It is shown as "Body" in the PR section of the task screen. Records from before this version do not have it (nothing is shown in the web UI).

Code: `apps/daemon/src/pr-template.ts` (`GitHubPullRequestTemplates`, `fillTemplate`, `limitBody`, `CATEGORY_RULES`), `apps/daemon/src/service.ts` (`pullRequestBody`, `publish`, `publishStepPullRequest`), `apps/daemon/src/prompts.ts` (`buildPullRequestBodyParts`, `buildStepPullRequestBodyParts`, `buildPullRequestBodyText`, `buildStepPullRequestBodyText`, `resultTableLines`, `approvedBasisLines`, `withoutProgressReport`), `packages/core/src/events.ts` (`PullRequestTemplateUse`), `apps/web/src/components/pull-request.tsx` (`TemplateUse`)

## Importing PR comments

- While a PR is open and waiting for approval, its reviews, line comments, and ordinary comments are imported as comments (`PullRequestReviewImported`, actor `person`).
  - They are imported after waiting 2 minutes from the last feedback (`FEEDBACK_QUIET_MS`).
    The time of each feedback is the earlier of its GitHub time and the time the daemon first saw it (memory only; `feedbackSeenAt`).
    Even if GitHub's time is ahead of this machine's clock, the feedback is imported 2 minutes after it was first seen (it does not keep waiting for GitHub's time).
    If GitHub's time is behind, there is no wait when 2 minutes have already passed by the time it is seen.
    The times for tasks that are no longer in scope for import (no longer awaiting approval, cancelled, and so on) are dropped at the next check.
  - Up to 50 (`REMARKS_MAX`) are imported, oldest first, at up to 2000 characters each (`REMARK_MAX`).
  - The same item is not imported twice.
  - For a taken-over existing PR, comments passed to the prompt of the Implement step are not imported (the implementation addressed them; [Taking over an existing PR](tasks-and-steps.en.md#taking-over-an-existing-pr)).
- Posts by a sacty task that reviewed this PR (a task pointing to the PR: the PR it took in, or the PR URL in its body) are identified by two things. They are that task's project account (which may differ from the original task's account) and the round in the marker (`<!-- sacty-review:<task ID>[:<round>] -->`). This is checked before the bot check, so the same applies even if that account is a bot (such as a GitHub App).
  - That task's rounds with findings are imported as comments. How the task was taken in (the review label (`source.review: sacty`), a review request (`requested`), a task created manually (no `source`), and so on) does not matter, because each is a review that a person asked for. Rounds with findings are those where `verdict` in `reviewVerdicts` is `changes_required` or `suggestions`; rounds whose verdict could not be read are also included so as not to drop comments.

    This delivers a review by a task separate from the one that opened the PR to the original task so that it addresses them. Rounds with suggestions only are imported too, and the budget stops the cost of repetition. How the verdict is decided is in [Tasks and steps](tasks-and-steps.en.md#pr-review-only-tasks).
  - Other rounds (rounds with no findings, and rounds with no recorded verdict: rounds not yet run, or rounds of a task that only refers to the PR and has no review step) are not imported, even if the account differs from the original task's. There is no Request changes, and the Goal Guardian does not run either.
  - Re-reviews are judged per round. A marker copied by someone other than that task's account is treated as a person's comment.
- Otherwise, the following posts are not imported.
  - Posts by bots
  - Reviews and line comments posted by the original task's project account that start with sacty's review marker
- Once imported, the Goal Guardian decides where to send them back to (redoing that step, or requesting changes to an earlier step) (`ReworkJudged`), and changes are requested without a person's confirmation. If it cannot decide, the first step that can be redone (Implementation for the implementation PR, that step for Requirements or Design) is redone.
  - The target depends on whether the comment changes a decision already approved in an earlier step (acceptance criteria, behavior, screens, the shape of APIs and data, test viewpoints, and what was confirmed and decided).
    - A comment that does not change a decision goes back to the step of that PR (Implementation for the implementation PR). Adding to documents, fixing the implementation, and reflecting something already decided are such comments.
      Even if an approved output left something out (it is not in the list of what is affected, or not in the test viewpoints), the comment is not treated as changing a decision when what it asks for follows from the approved decisions.
    - Only a comment that changes the decision itself goes back to the step that holds it (Design or Requirements). If even one of several comments changes a decision, it goes back to the step that holds that decision; if they span several steps, to the earlier step.
    - Going back to an earlier step re-creates the approved output and has it approved again, which costs more effort and money.
  - The Goal Guardian is asked to start the reason (`reason` of `ReworkJudged`) with which decision the comment changes or does not change.
    The format is only requested in the instruction; sacty does not check it (a reason is recorded whatever its format, as long as it can be read).
- Along with where to send them back to, the Goal Guardian also decides the cause of the request for changes (`cause`; see [Request changes](#request-changes)). It is one of `guardian_missed`, `new_request`, and `base_changed`; if it cannot decide (no answer, `undecidable`, or an unknown value), no cause is set (counted as rework with an unknown cause). The judgment is kept in `cause` of `ReworkJudged` and carried over to the request for changes (`ChangesRequested`).
  For a task with no approved requirements (one that skipped the Requirements step), the original request that the final review used as its standard (the task's title and body) is also given to this judgment. A task with approved requirements does not get it (the requirements are the standard).
- Just before requesting changes, the PR's status is read once more (a person may have merged or closed it during the judgment, or before a resumed check after the judgment was recorded).
  - If it is still open, changes are requested.
  - If it was merged, or closed without merging, changes are not requested. The imported comments (`PullRequestReviewImported`) and the judgment (`ReworkJudged`) stay in the ledger, and the status is checked again within the same check and recorded as "Merged" or "Closed without merging" in [The PR check](#the-pr-check) (for a merge, `PullRequestMerged` and `StepApproved`; `StepApproved` clears the state of the comments that were being worked on).
  - If the PR is reopened after being closed without merging, changes are requested with the judgment already recorded (it is not judged again).
  - If the status changed during the re-read (a person requested changes, the task was cancelled, and so on), nothing is recorded. If it cannot be read, the next check tries again.
  - Comments that arrive after a merge are not turned into a follow-up task or the like.

Code: `apps/daemon/src/service.ts` (`importFeedback`, `sactyReviewsOf`, `feedbackRemarks`, `FEEDBACK_QUIET_MS`, `feedbackSeenAt`, `settleReview`, `judgeRework`), `apps/daemon/src/prompts.ts` (`buildReworkPrompt`, `reworkDecisionLines`), `apps/daemon/src/github.ts` (`GitHubPullRequests.feedback`)

## Request changes

- Steps that can be gone back to (`reworkTargets`) are the `REWORK_STEPS` that are the step waiting for approval or before it, nearest first.
  - `reproduce` and `investigate` only when they themselves are waiting for approval.
  - When Integration review is waiting for approval, only `split`.
  - If the target is omitted, the first one (`implement` when Implementation is waiting for approval).
- Requesting changes while waiting for approval needs at least one comment (`gate.remarksRequired`). A person can void comments, and voided comments are not passed to the agent.
- Going back to an earlier step revokes the approvals from that step onward and resets the verification result and failure count. In a task approved through PRs, merged PRs are not reverted.
- A request for changes can carry a cause (`ReworkCause`; `cause` of `ChangesRequested`). If omitted, it is recorded as a request for changes with no cause decided and counted as rework with an "unknown cause" in the summary.
  - A person chooses it with "Cause of the rework" on the approval screen (initially "Don't choose"). When a person requests changes on the approval screen (the `request-changes` API), the person chooses where to send it back, so it does not go through the Goal Guardian's judgment (`judgeRework`). If no cause is chosen, the cause is not judged and the rework has an unknown cause (no extra run is made just for the judgment).
  - For a request for changes from PR feedback, the cause the Goal Guardian judged together with where to send it back is used (`settleReview`).
  - The cause is shown on the request-for-changes line of the Activity and in the PR section's "Redo from" (for PR feedback; `cause` of `prRework`).
  - A request for changes that ends in an escalation at the limit (`TaskEscalated`) does not keep a cause. A person chooses it again when requesting changes beyond the limit.
- A miss (`GuardianMissed`) is recorded only when the cause is `guardian_missed` and the deliverable sent back had passed the final review (Implementation waiting for approval) or Integration review (Integration review waiting for approval).
  - It is not recorded when the cause is `new_request` or `base_changed`, or when no cause is decided (a request for changes with no cause is shown under "unknown cause" in the summary, next to the miss count, because it is not known whether it was a miss).
  - A miss for the same review is recorded once.
  - The activity log from before causes were recorded is read as it is (a request for changes without a cause is in the summary it counts as a miss when a miss record (`GuardianMissed`) comes right before it, and as "unknown cause" otherwise; a miss already recorded is still counted as a miss).

| Cause (`ReworkCause`) | Meaning |
| --- | --- |
| `guardian_missed` | The Goal Guardian missed a flaw it could have caught |
| `new_request` | A new request or change of direction a person added that is not in the approved requirements or design |
| `base_changed` | A conflict or clash caused by the base branch moving on (such as an earlier PR being merged), not a flaw in the deliverable itself |

- A person can change the step images and agents together with a request for changes (`images` and `agents` of `RequestChangesInput`). They are checked in the same way as changing them in the task details (`changeStepImage`, `changeStepAgent`), and `StepImageChanged` and `StepAgentChanged` are recorded in the same write before the request for changes (`ChangesRequested`) or the escalation at the limit (`TaskEscalated`) (the same name as now is not recorded). If any of them is wrong, nothing is recorded, including the request for changes. The screen shows the step to redo and the steps after it (except skipped steps), and loads the choices when the collapsed section is opened (`/step-options`). Only the steps a person changed are sent (`changedStepChoices`).
- The text of the comments in a request for changes can be read with "Details" on the request-for-changes line of the Activity in the task details, even when the task is not awaiting approval ([Screen wording and hints](ui-wording.en.md)).

Code: `apps/daemon/src/service.ts` (`requestChanges`, `stepSettingChanges`, `voidRemark`), `packages/core/src/events.ts` (`ReworkCause`, `RequestChangesInput`), `packages/core/src/projection.ts` (`reworkTargets`, `reopen`, `changeRounds`), `apps/daemon/src/prompts.ts` (`buildReworkPrompt`, `extractRework`), `apps/web/src/lib/labels.ts` (`describeEventParts`), `apps/web/src/components/gate-form.tsx` (`GateStepSettings`)

## Escalation

| Reason | When |
| --- | --- |
| `too_many_changes` | A Request changes after requests for changes to the same step reached `MAX_CHANGE_REQUESTS` (3). Comments in progress are kept. To continue beyond the limit, request changes explicitly (`overLimit`) |
| `change_undecidable` | The Goal Guardian could not judge a change request. A person decides (`ChangeDecided`) |
| `rework_confirmation` | A record from an earlier version (no longer recorded) |

Code: `apps/daemon/src/service.ts` (`requestChanges`, `decideChange`), `packages/core/src/events.ts` (`TaskEscalated`, `MAX_CHANGE_REQUESTS`)
