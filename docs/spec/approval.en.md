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
  - In the following cases, the link goes to the sacty approval screen (`/tasks/<ID>/review`).
    - Escalation (such as confirming the step to redo for PR comments)
    - The PR was closed, merged with different content, or does not exist
  - A link that opens outside is marked with "↗" and, for screen readers, "opens in a new tab" (`ActionLink`).
  - From the notifications, it opens without switching the project.
  - On the dashboard and in the notifications, the link is the task title, so only the title is truncated and the mark is placed outside the truncation. The mark stays even for a long title (PR #148 review suggestion).

Code (web UI links): `apps/web/src/lib/labels.ts` (`personAction`, `personLink`, `reviewPullRequestUrl`), `apps/web/src/components/action-link.tsx` (`ActionLink`, `ExternalMark`)

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

Every 60 seconds the daemon checks PRs waiting for approval (the next check does not start until the previous one finishes).

- Merged: `PullRequestMerged` and `StepApproved` (both with actor `person`) are recorded.
  - It is also approval when the PR was merged with content different from sacty's submission (the PR's head differs from sacty's commit) (`edited`).
  - For Requirements and Design, the file is read from the merge commit, and the version the person edited becomes the approved result. If the file was deleted or cannot be read, sacty's version is approved. If it cannot be fetched, nothing is recorded and the next check tries again.
- Closed without merging: `PullRequestClosed` is recorded, and instead of approving, the task waits for a person's decision. It cannot be approved from the web UI (request changes or cancel).
- Reopened: `PullRequestReopened` is recorded and watching continues.
- If the status, PR, or commit changes during the check, nothing is recorded.
- When an implementation PR is merged and the after-merge watch step is not skipped, the after-merge watch starts in the same append ([After-merge watch](deployment-watch.en.md)). At the end of the check, the CI/CD of tasks waiting for monitoring is checked (`checkDeployments`).

Code: `apps/daemon/src/service.ts` (`checkPullRequests`, `readMergedDocument`), `apps/daemon/src/pr-watcher.ts` (`PullRequestWatcher`)

## PR body and PR template

Related ADRs: [Fill the body of PRs sacty opens with fixed rules following the headings of the repository's or Org's PR template](../adr/20261014-1517-pr-body-follows-repository-template.md)

Whenever sacty opens or updates a PR, it looks for the PR template of the repository where the PR is opened, and if there is one, writes the body in the shape of its headings and items. This covers the implementation PR and the requirements and design PRs (the same goes for PRs of fix tasks created by the after-merge watch).

If there is no template or it cannot be used, sacty uses its own fixed body (`buildPullRequestBody`, `buildStepPullRequestBody`). In either case, opening the PR does not stop.

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
  - Purpose: the approved requirements (the bug reproduction for a reproduce task)
  - Changes: the Implementation step's output
  - Tests: the viewpoint → test → result table and the test results
  - Related Issue: `Closes #<number>` (for a task taken in from an Issue)
  - Exported results, the requirements and design PRs, and the Goal Guardian's final review go into "the sacty record".
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
  - Parts that cannot be cut (`keep`) are the task ID line, `Closes #<number>` (including one placed in a template heading), and the guidance that merging the requirements and design PRs means approval. If, after cutting, one of them does not remain in the body as a whole line (with line boundaries before and after) outside HTML comments and code blocks, it is put back before the last part. `Closes #12` is not considered to remain just because `Closes #123` is present.
- Secret values: secret values used in opening that PR (such as the GitHub token) are redacted from the body (`[REDACTED]`). The reason text kept in the ledger is also redacted.
- Ledger: `template` in `PullRequestPublished` and `StepPullRequestPublished` keeps the following.
  - The template used (`repo`: the URL of the repository where the template was, `path`)
  - Or the reason for using the fixed shape (`fallback`: `none` or `unusable`; `message`: `pr.templateFailed`, `pr.templateTooLarge`, `pr.templateInvalid`, `pr.templateEmpty`, `pr.templateOrgPrivate`, and so on)
  - `truncated` if it was cut
  - It is shown as "Body" in the PR section of the task screen. Records from before this version do not have it (nothing is shown in the web UI).

Code: `apps/daemon/src/pr-template.ts` (`GitHubPullRequestTemplates`, `fillTemplate`, `limitBody`, `CATEGORY_RULES`), `apps/daemon/src/service.ts` (`pullRequestBody`, `publish`, `publishStepPullRequest`), `apps/daemon/src/prompts.ts` (`buildPullRequestBodyParts`, `buildStepPullRequestBodyParts`, `buildPullRequestBodyText`, `buildStepPullRequestBodyText`), `packages/core/src/events.ts` (`PullRequestTemplateUse`), `apps/web/src/components/pull-request.tsx` (`TemplateUse`)

## Importing PR comments

- While a PR is open and waiting for approval, its reviews, line comments, and ordinary comments are imported as comments (`PullRequestReviewImported`, actor `person`).
  - They are imported after waiting 2 minutes from the last feedback (`FEEDBACK_QUIET_MS`).
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

Code: `apps/daemon/src/service.ts` (`importFeedback`, `sactyReviewsOf`, `feedbackRemarks`, `FEEDBACK_QUIET_MS`, `settleReview`, `judgeRework`), `apps/daemon/src/github.ts` (`GitHubPullRequests.feedback`)

## Request changes

- Steps that can be gone back to (`reworkTargets`) are the `REWORK_STEPS` that are the step waiting for approval or before it, nearest first.
  - `reproduce` and `investigate` only when they themselves are waiting for approval.
  - When Integration review is waiting for approval, only `split`.
  - If the target is omitted, the first one (`implement` when Implementation is waiting for approval).
- Requesting changes while waiting for approval needs at least one comment (`gate.remarksRequired`). A person can void comments, and voided comments are not passed to the agent.
- Going back to an earlier step revokes the approvals from that step onward and resets the verification result and failure count. In a task approved through PRs, merged PRs are not reverted.
- When a person requests changes to something that passed the final review or Integration review, a miss (`GuardianMissed`) is recorded.
- A person can change the step images and agents together with a request for changes (`images` and `agents` of `RequestChangesInput`). They are checked in the same way as changing them in the task details (`changeStepImage`, `changeStepAgent`), and `StepImageChanged` and `StepAgentChanged` are recorded in the same write before the request for changes (`ChangesRequested`) or the escalation at the limit (`TaskEscalated`) (the same name as now is not recorded). If any of them is wrong, nothing is recorded, including the request for changes. The screen shows the step to redo and the steps after it (except skipped steps), and loads the choices when the collapsed section is opened (`/step-options`). Only the steps a person changed are sent (`changedStepChoices`).
- The text of the comments in a request for changes can be read with "Details" on the request-for-changes line of the Activity in the task details, even when the task is not awaiting approval ([Screen wording and hints](ui-wording.en.md)).

Code: `apps/daemon/src/service.ts` (`requestChanges`, `stepSettingChanges`, `voidRemark`), `packages/core/src/projection.ts` (`reworkTargets`, `reopen`, `changeRounds`), `apps/web/src/lib/labels.ts` (`describeEventParts`), `apps/web/src/components/gate-form.tsx` (`GateStepSettings`)

## Escalation

| Reason | When |
| --- | --- |
| `too_many_changes` | A Request changes after requests for changes to the same step reached `MAX_CHANGE_REQUESTS` (3). Comments in progress are kept. To continue beyond the limit, request changes explicitly (`overLimit`) |
| `change_undecidable` | The Goal Guardian could not judge a change request. A person decides (`ChangeDecided`) |
| `rework_confirmation` | A record from an earlier version (no longer recorded) |

Code: `apps/daemon/src/service.ts` (`requestChanges`, `decideChange`), `packages/core/src/events.ts` (`TaskEscalated`, `MAX_CHANGE_REQUESTS`)
