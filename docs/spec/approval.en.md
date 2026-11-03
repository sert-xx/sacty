[日本語](approval.md) | **English**

# Approval and request changes

At a step with an approval gate, the task moves to the next step when a person approves it. A person approves in sacty's web UI or by merging a PR to the target repository (approval = merge).

Requesting changes redoes the work from the chosen step. When requests for changes to the same step exceed the limit, the task goes to Escalation (waiting for a person's decision).
What counts toward the limit is the requests for changes by a person; a request for changes made only of comments from sacty's own AI review is not counted ([AI review comments](#ai-review-comments)).

Related ADRs: [Remove the "PR作成" step and open the PR and wait for approval inside the Implementation step](../adr/20261015-1430-superseded-implement-step-opens-pull-request.md), [Split intake into "Issue intake" and "PR review intake", and add the review label to sacty's PRs](../adr/20261015-0240-superseded-split-issue-and-pr-review-intake.md), [Label PRs sacty opens for intake, and import reviews from another task as comments on the original task's PR](../adr/20261014-1445-superseded-label-sacty-pull-requests-for-review.md), [Fill the body of PRs sacty opens with fixed rules following the headings of the repository's or Org's PR template](../adr/20261014-1517-pr-body-follows-repository-template.md), [If the implementation has no changes, open no PR and complete without changes after a person checks it](../adr/20261014-2216-superseded-complete-without-changes.md), [Import rounds with findings posted by a sacty task that refers to the PR as comments on the original task's PR, however that task was taken in](../adr/20261025-2245-import-sacty-reviews-from-any-intake.md), [Open the implementation PR as a draft before the final review, let the Goal Guardian judge after waiting for CI, and on a pass mark it ready for review](../adr/20261027-2330-draft-pull-request-before-final-review.md), [Treat comments from sacty's own AI review separately from a person's comments](../adr/20261102-0843-distinguish-ai-review-remarks.md)

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
  - When the PR is recreated (the earlier PR was closed and a PR with a new number was opened), the new PR gets the label.
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
- At the start of the check, the implementation PR of a task that is reworking the implementation (not waiting for approval) is also checked ([Merging during a rework of the implementation](#merging-during-a-rework-of-the-implementation)).
- At the end of the check, the following are done in order.
  1. Memories whose PR promoting them to context was merged are deleted (`cleanupPromotedMemories`; [Memory](memory.en.md#promotion-to-context)).
  2. For PR review intake tasks that have not finished, the PR is checked, and the task is cancelled if the PR was merged or closed without merging (`checkReviewPullRequests`).
  3. PRs that stopped after the publish but before the label was attached get the label (`resumePullRequestLabels`; [The review label on PRs](#the-review-label-on-prs)).
  4. The CI of tasks waiting for the CI of the implementation PR opened before the final review is checked (`checkVerificationCi`; [Tasks and steps](tasks-and-steps.en.md#the-implementation-pr-and-ci-before-the-final-review)).
  5. The CI/CD of tasks waiting for the after-merge watch is checked (`checkDeployments`).

### Merging during a rework of the implementation

If a person merges the implementation PR while the implementation is being reworked (after a rejection, imported PR comments, or a failed final review; the task is not waiting for approval), the merge is taken as the approval and the rework is stopped. No new PR is created.

- Targets (`reworkingPullRequest`): tasks whose active step is Implement and whose status is queued (`queued`), running (`running`), waiting (`idle`, for example in the final review), or paused (`paused`), and whose PR in `Task.pullRequest` is open (`pullRequestState` is `open`) or was closed while waiting for approval and then sent back (`closed`; it may be reopened and merged on GitHub, and whether it is merged is decided by GitHub's state).
  - The same applies when a person takes the draft PR before the final review out of draft and merges it.
  - A continued existing PR (`Task.continuedPullRequest`) has no `Task.pullRequest` until the first submission. During that time (for example while the implementation is reworked because the first final review failed), the continued PR is watched. The projection then records the continued PR as the implementation PR before recording the merge (the commit is the head of the PR when it was taken over).
  - While Requirements or Design is being redone (the active step is not Implement), nothing is watched. When the task reaches Implement and the PR is already merged, the rework is stopped in the same way.
  - Tasks waiting for approval or escalated are watched by the check above.
- Check: the PR status is read (with the project's gh account; if it cannot be read, the next check tries again). Only when it is merged, the following is done. Nothing is done while it is open or closed.
  1. If something is running, its containers are stopped and the task waits for it to end (the same as pause and cancel; the stopped run is not recorded as a person's pause). If it cannot be confirmed that the stopped containers are gone, the task is paused and does not move on (the next check confirms again).
     Until the approval or the pause is recorded, no run of the task is started (even if the stopped run ended normally, the worker does not start the next verification; `runNext` and `queuedTaskIds` look at `mergeStopping`).
     If the daemon stopped during an implementation run and was restarted, recovery (`recoverInterrupted`) keeps the run of an implementation rework (one with an open PR) in `unstoppedRuns` and pauses the task, so it does not move on to approval until the stop is confirmed.
     Runs whose containers could not be confirmed stopped when the task was paused (`unstoppedRuns`) are included in the stopped runs that are recorded.
     Even if the task had already paused because of the cost of the stopped run that ended normally (the budget, for example), the runs that could not be confirmed stopped are added to `unstoppedRuns` (the pause reason stays as it is; a `TaskPaused` for a task that is already paused is accepted only when it adds `unstoppedRuns`). The task does not move on to approval until they are confirmed.
  2. If, meanwhile, the task reached approval, was cancelled, or changed to another state, nothing is recorded here (a task that reached approval is handled by the check above).
  3. `ReworkStoppedByMerge` (actor `sacty`) is recorded, followed in the same append by `PullRequestMerged` and `StepApproved` (actor `person`; starting the after-merge watch is the same as in "Merged" above).
- Content of `ReworkStoppedByMerge`: the number of the merged PR, the stage when stopped (`was`: `queued`, `running`, `verifying`, `publishing`, `paused`), the stopped runs (`stoppedRuns`), the comments discarded before being passed to the rework (`discardedRemarks`: id and text; the comments of the last rejection that were not passed to a submitted PR), the kind of the discarded verification result (`discardedFeedback`: `tests`, `review`, `merge`), and the number of PR comments that arrived while paused and had not been applied (`discardedReview`; [Comments that arrive while paused](#comments-that-arrive-while-paused)). The reason is the merge.
  - The projection returns the task to waiting for the Implement approval (the gate's submission is the number of submissions so far, or 1 if there is none), voids the discarded comments, and clears the verification, the wait for PR creation, and the pause state. The following `PullRequestMerged` and `StepApproved` then approve it.
  - The body of the approved result (`approved.implement.output`) is the latest implementation report on record. The commit of the PR is the truth for what was merged.
- Just before the PR is updated (`publish`, including updating a continued existing PR), it is also checked whether the earlier PR has been merged. If it has, nothing is pushed and no PR is created; the same records approve it (for when the PR update starts before the check).
  If it is found merged by the check after the push (the check for whether to create a new PR, or the check of a continued PR), no new PR is created and the task is not paused either; the same records approve it (for when the PR is merged during the push).
- Later checks do not record again, because the task is already approved.

Code: `apps/daemon/src/service.ts` (`checkReworkMerges`, `stopReworkForMerge`, `endReworkByMerge`, `mergeApprovalItems`, `publish`, `pauseIfRequested`), `packages/core/src/projection.ts` (`reworkingPullRequest`, `unreflectedImplementRemarks`, `ReworkStoppedByMerge`)

### Comments that arrive while paused

Related ADR: [一時停止の間に届いた PR の指摘を、再開のときに取り込む](../adr/20261102-1900-hold-pr-comments-while-paused.md)

If a person writes comments on the implementation PR while the implementation rework is paused (for any reason: the budget cap, the AI usage limit, an authentication error, an error, or a person's pause), the comments are kept as not yet applied. After the task is resumed, they are applied before the step that stopped runs again.
The task is not waiting for approval, so "Importing PR comments" above does not run. The judgment is the same (the Goal Guardian decides where to send the task back).

- Targets: the same PR as in [Merging during a rework of the implementation](#merging-during-a-rework-of-the-implementation) (`reworkingPullRequest`). That is, tasks whose active step is Implement and whose implementation PR (including a continued existing PR) is open (or was closed while waiting for approval and then sent back).
  - A task that was paused while Requirements or Design was being redone is not a target. Comments that arrive then are imported as usual once the task reaches Implement and waits for approval.
- Keeping (`checkHeldFeedback`, `holdFeedback`): the PR check (every minute) reads the feedback on the implementation PR of paused (`paused`) tasks and records what has not been imported as `PullRequestReviewImported` (`held: true`).
  - They are marked as imported (`importedFeedback`) and added to `Task.pendingReview` (the same "imported but not yet applied comments" as for the import while waiting for approval). Comments are added to it, so comments that arrive in several batches become one. The limits (50 comments in total that are not yet applied, 2000 characters each) are the same as for the import while waiting for approval. While 50 are kept, a check cannot add any (the number that can be added is 0). The excess is not marked as imported; it is added after the kept comments are applied (by the usual import once the task waits for approval, or by the check if the task is paused again).
  - It does not wait for the writing to finish (they are applied on resume, so comments that arrive meanwhile can still be added).
  - It does not request changes, does not run the Goal Guardian, and costs nothing. The task stays paused.
  - sacty's own AI review comments are told apart from people's comments, as in [AI review comments](#ai-review-comments). `items[].source` of `PullRequestReviewImported` and `pendingReview.aiReview` are kept, and a batch of only AI review comments has actor `sacty`. Reviews of an old head are not kept; they are discarded with `PullRequestReviewDiscarded`.
  - If the PR feedback cannot be read, nothing is recorded and the next check tries again.
  - While there are comments the Goal Guardian has already judged, none are added. After the resume (waiting to run or waiting), the check for paused tasks adds none either (nor when the resume happens while it is reading; only the applying side adds, so that it does not disagree with the judgment made after the resume).
  - If another check running at the same time (the check for paused tasks and the check after the resume) tries to discard the same AI review of an old head, only what is not yet imported is recorded (nothing is recorded twice).
- Screen: the details of a paused task show the number of comments that arrived (with the AI review breakdown) and what happens on resume (`HeldReviewNotice`; `heldReview`). The import row in the activity says the comments arrived while paused and were kept as not yet applied.
- Applying (`reworkHeldReview`): when the resumed task runs next (the start of `runNextInner`), before the step that stopped (the final review, the PR update, the implementation, and so on). A task that was stopped while waiting for the CI of the PR opened before the final review, and so is outside the wait for verification, also counts as waiting to run for applying (`heldReviewDue`; `queuedTaskIds`).
  1. Right after the resume, the PR feedback is read once more and kept (to pick up comments written just before the resume; `heldRecheck`. It is in memory only; even if a restart loses it, the comments kept so far are in the activity). If it cannot be read, or the head that the AI reviews were made against cannot be confirmed, the task waits without running the step that stopped until it can be confirmed (the cause is logged as a warning with the task and the PR, with the token hidden; the mark is kept and it is read again in the next cycle), so that comments written just before are not dropped.
  2. If there are no comments that are not yet applied, nothing is done and the step that stopped runs again as before.
  3. If the PR is already merged, nothing is applied (no judgment, no request for changes). The step that stopped is not run either; the merge is taken as the approval on the spot, with the same records as the [rework stop](#merging-during-a-rework-of-the-implementation) (`ReworkStoppedByMerge`, `PullRequestMerged`, `StepApproved`; the kept comments are discarded; `endHeldByMerge`). If another rework stop is in progress (`mergeStopping`), it is left to that one.
  4. If the budget cap has been reached, the judgment is not run and the task is paused for the budget (the same check as before running a step; judging costs money). Otherwise, the Goal Guardian judges where to send the task back and the cause (`ReworkJudged`; the same judgment and instructions as [Importing PR comments](#importing-pr-comments), reading the implemented code). If the judgment cannot be adopted (the run was stopped by a pause, a rework stop (a PR merge), or the daemon stopping, the task was cancelled, or the comments or state changed), the judgment is not kept; only the cost and usage of the run are recorded in a `ReworkJudged` with `runResult: interrupted` (the comments stay unjudged and are judged again on resume). If it cannot judge, the implementation is redone. After the judgment is recorded, the PR status is read again just before sending back; if it is merged, the task is not sent back and the merge is taken as the approval on the spot (if the judged step were Design or Requirements, it would fall outside the rework stop, and the earlier step would run on a merged PR). If it cannot be read again, the task is sent back as it is. Just before sending back (also when a saved judgment is applied after a resume), a cancel, a rework stop in progress (a PR merge), or a pause request is checked; if there is one, the task is not sent back on the stale (still open) response and applying is skipped (the stop discards the kept comments and moves on as an approval).
  5. The task is sent back to the judged step (`ChangesRequested`; `settleHeldReview`). The actor is `sacty` if all the comments are AI review comments and `person` otherwise. The round number and comment IDs continue by the same rule as a send-back while waiting for approval. The progress of the step that stopped (the verification, the wait for the PR update, the wait for a step review) is not carried over. The runs after that are the same as after an ordinary send-back (the implementation is redone with the comments, or the task restarts from an earlier step).
- Limit on people's send-backs: there is no approval gate and no place for an escalation, so the limit (`MAX_CHANGE_REQUESTS`) does not stop the task even if it is reached. A person's resume is treated as the decision to continue, and it is recorded with `overLimit: true`. A batch of only AI review comments is still not counted as a person's send-back.
- A Goal Guardian miss (`GuardianMissed`) is not recorded, because the implementation of the step that stopped has not passed the final review. The send-back cause (`cause`) is recorded as judged.
- If the PR is merged while paused, the [rework stop](#merging-during-a-rework-of-the-implementation) discards the kept comments (`pendingReview`) and records their number in `discardedReview` of `ReworkStoppedByMerge`.

Code: `apps/daemon/src/service.ts` (`checkHeldFeedback`, `holdFeedback`, `reworkHeldReview`, `settleHeldReview`, `withoutStaleReviews`, `resume`, `heldRecheck`), `packages/core/src/projection.ts` (`heldReview`, `PullRequestReviewImported`, `ChangesRequested`), `apps/web/src/components/task-detail.tsx` (`HeldReviewNotice`), `apps/web/src/lib/labels.ts` (`statusText`)

### Pausing while waiting for approval

Related ADR: [承認待ち（PR のマージ待ち）でも一時停止できるようにする](../adr/20261103-2300-pause-while-awaiting-approval.md)

A person can also pause a task that is waiting for approval (`awaiting_approval`). Use it when you want to stop PR imports while you wait for the merge. A task in escalation (`escalated`) cannot be paused.

- Pausing: there is no agent run, so `TaskPaused` (actor `person`, reason `manual`) is recorded on the spot. The approval gate (`gate`) and the PR records stay as they are, and `resumeTo: awaiting_approval` is kept as where to resume to.
  As before, the task cannot be paused while the Goal Guardian is judging a change proposal.
- While paused, the task cannot be approved or sent back (its state is `paused`). What happens to the PR depends on the kind of PR.
  - The implementation PR: it is treated like the PR while the implementation is being reworked (`reworkingPullRequest`). If it is merged, `ReworkStoppedByMerge` (`was: paused`) is recorded, followed by `PullRequestMerged` and `StepApproved`, and the merge is taken as the approval ([Merging during a rework of the implementation](#merging-during-a-rework-of-the-implementation)). No resume is needed. Comments that arrive are kept as not yet applied ([Comments that arrive while paused](#comments-that-arrive-while-paused)). The Goal Guardian does not run.
  - A Requirements or Design PR: it is not watched while paused. Both merges and comments are handled by the check after the resume.
- Resuming: `TaskResumed` returns the task to waiting for approval (the approval gate is still there, so the approval screen can be used as it is). No agent runs.
  What happened while it was paused is picked up by the PR check after the resume (every 60 seconds).
  - If the PR was merged, the merge is taken as the approval ([The PR check](#the-pr-check)).
  - Comments that were kept (the implementation PR) are taken over by the import while waiting for approval as they are. The Goal Guardian decides where to send the task back. Comments written while paused are imported in the same check.
- Notification: a person paused it, so nothing is sent to Slack. When it is resumed and returns to the same approval gate, the approval notification is not sent again (`notificationFor`).

Code: `apps/daemon/src/service.ts` (`pause`), `apps/daemon/src/notifier.ts` (`notificationFor`), `packages/core/src/projection.ts` (`TaskPaused`, `TaskResumed`, `resumeTo`, `reworkingPullRequest`), `apps/web/src/components/task-detail.tsx` (`canPause`)

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
  - For a continued PR (`Task.continuedPullRequest`, which `mergesBase` does not merge into), the same places show how to resolve it on GitHub ("This is a continued PR, so the base branch is not merged in. Resolve the conflict on GitHub") instead of how to merge the base in. The conflict itself is shown as usual.
  - The Activity shows "PR #N conflicts with the base branch" and "The conflict on PR #N is resolved".
- The judgment does not decide whether the PR can be merged. If a person merges it while it conflicts, it is approved as a normal merge.

Code: `apps/daemon/src/service.ts` (`checkPullRequests`, `recordPullRequestConflict`), `apps/daemon/src/github.ts` (`GitHubPullRequests.status`), `packages/core/src/projection.ts` (`pullRequestConflict`, `Task.pullRequestConflict`), `apps/web/src/lib/labels.ts` (`statusText`, `prConflictNote`), `apps/web/src/lib/dashboard-data.ts` (`attentionRows`), `apps/web/src/lib/task-list-data.ts`, `apps/web/src/components/task-detail.tsx` (`GateNotice`), `apps/web/src/components/gate-form.tsx`

Code: `apps/daemon/src/service.ts` (`checkPullRequests`, `readMergedDocument`, `cleanupPromotedMemories`, `checkReviewPullRequests`, `resumePullRequestLabels`, `checkVerificationCi`, `checkDeployments`), `apps/daemon/src/pr-watcher.ts` (`PullRequestWatcher`)

## PR body and PR template

Related ADRs: [Fill the body of PRs sacty opens with fixed rules following the headings of the repository's or Org's PR template](../adr/20261014-1517-pr-body-follows-repository-template.md)

Whenever sacty opens or updates a PR, it looks for the PR template of the repository where the PR is opened, and if there is one, writes the body in the shape of its headings and items. This covers the implementation PR and the requirements and design PRs (the same goes for PRs of fix tasks created by the after-merge watch).

If there is no template or it cannot be used, sacty uses its own fixed body (`buildPullRequestBody`, `buildStepPullRequestBody`). In either case, opening the PR does not stop.

### Assembling the implementation PR body

The implementation PR body is written to be read short, conclusion first. The full text of the approved requirements and design, and long review text, are not included; they become a link or a collapsed section. The fixed body (`buildPullRequestBodyText`) contains, in this order:

1. The task ID line, and `Closes #<number>` (for a task taken in from an Issue)
2. "結論" (Conclusion)
   - Summary of the change: the head of the first paragraph (only lines without indentation; excluding headings, tables, code blocks, and indented lines) of the Implementation step's output. When there is no output, the line is left out. After a redo, the head of the description of the whole PR (see "Body after a redo" below).
   - The last fix: only after a redo, the head of the description of the last fix.
   - The final review's verdict and the head of its summary. "（なし）" when there is no final review yet, and a note when it is being verified.
   - The record that a person moved the task on despite the failed final review, and the failed points (if any; `overrideBodyLines`)
   - What a person should confirm (if any; `humanCheckBodyLines`)
3. The approved requirements (the bug reproduction for a reproduce task; `approvedBasisLines`)
   - The full text is not included; only the head of the first paragraph and where the full text is (`approvedBasisDigest`). The full text is at the URL and file path of the requirements and design PRs approved by merging. With no PR, "全文は sacty のタスクの画面で確かめてください。" is written.
   - A task that skipped the requirements step, and the fix scope of a security fix, are short, so they stay as before.
4. "変更" (Changes): the Implementation step's output (after a redo, the description of the whole PR) without the first paragraph that the conclusion's change summary already carries (so the conclusion's sentences are not repeated; PBI-301 A7; the F3 recurrence in experiments S16 and S19). When nothing but headings is left (the output is only the summary, or only headings remain), the whole section is left out. When the first paragraph was cut short in the conclusion, the full text is shown. When there is no output, the heading is left out too. In a body that follows a template, "変更" is the full text, because there is no summary in it.
5. "最後の直し" (The last fix): only after a redo. The description of the last fix (see "Body after a redo" below).
6. The exported results
7. Viewpoint → test → result
   - The table columns are "観点", "テスト", and "最終レビュー". The viewpoint is the ID and title (up to 60 characters), the test is the name of the first test (up to 70 characters) and "ほか N 件", and the final review is only ✅ or ❌.
   - Below the table is the test line (the "テスト：" line above).
   - Each viewpoint's input, expected result, all tests, and the final review's findings go into the collapsed section "観点ごとの詳細" outside the table.
8. The full text of the final review (collapsed). Shown only when it is longer than the head shown in the conclusion, or when there is a recurrence check of earlier remarks.

The common rules are as follows.

- Sentences that report the progress of the work are removed from the Implementation step's output (`withoutProgressReport`). The removed sentences are those of 100 characters or fewer that contain both a topic word (commit, push, reflecting to GitHub, and so on) and a state word (not done, incomplete, sacty does it, and so on). Only sentences in lines that are outside a code fence and do not start with whitespace are touched. Lines of code blocks (CommonMark fences: indentation of 0 to 3 spaces, closed by the same character at least as long as the opening), tables, and headings, and every indented line (code inside a list, indented code, and so on), are left alone. The rule does not parse Markdown piece by piece and errs on the side of keeping: one leftover progress sentence does less harm than broken code. The summary of the change (`leadParagraph`) also uses only lines without indentation. The Implementation step's output is saved with the indentation of its first line kept (only blank lines before and after and trailing whitespace are removed; `keepIndent` of `extractBlocks`; other steps still trim as before). The instructions for implementation also say that the notes are put into the PR body as they are and that progress reports are not to be written (`IMPLEMENT_REPORT_LINE`).
- The leading "合格。" or "不合格。" of the final review's summary is removed (the verdict is written separately, so it is not repeated as "合格。合格。").
- Paths inside sacty's workspace (such as `/sacty-input/task.md:77`, a path inside the container that a person cannot follow) are not shown in the PR body, in the requirements and design files, in the investigation result comment, in the comments a step requests (`sacty-github-comments`), or in the comment that tells people what to check (`withoutInternalPaths`; PBI-301 A7; experiment S16, where one appeared in the body of a Requirements PR). Input files are replaced with names such as "タスクの依頼" (the task request), "人の指摘" (a person's remarks), "調査の結果" (the investigation result), and "承認済みの要求要件" (the approved requirements); other internal paths (`/sacty-review`, `/sacty-memory`, and so on) are replaced with a name for the place, and line numbers of internal files are not written. Repository paths are not changed. The provenance classification prompt and the default skill `classify-provenance` also have the classifier not write the Input location in the references (`refs`).
- Body after a redo (PBI-299; experiment S5 r4, F44, where after two redos the conclusion, the changes, the verification, and the viewpoint table of the last body described only the last fix, and it was no longer clear what the PR was): however the redo started (a failed final review, a person's send-back, or the remarks of an AI review), the body written when the PR is updated describes the whole PR at that time.
  - The output of each implementation submission is kept in `Task.implementHistory`, oldest first (built from `AgentRunCompleted` of the implementation; up to 10). It also keeps in `Task.implementBase` the base of the description of the whole PR as of the earlier submissions (none before the first submission; the first submission, or the part other than the section of a submission that rewrote the whole with a "最後の直し" section; a submission without the section leaves the base unchanged; `advanceImplementBase`). The base survives when the history drops old submissions at its limit. Both are emptied when an upstream step such as the requirements or the design is approved again, and when a proposal that changes an approved upstream output is applied.
  - The instructions for implementation (`implementReworkLines`; when the previous description is attached) tell the agent that the description is a description of everything the PR adds (rewrite the previous description with this fix reflected, and fold the content of an earlier "最後の直し" section into the whole), that this fix goes only once in a separate section "## 最後の直し" (`LAST_FIX_HEADING`) at the end of the description, and that the viewpoint-test mapping is also the mapping for the whole PR.
  - The body splits the description into the "## 最後の直し" section (`splitLastFix`; headings inside code blocks are not read; the section runs to the next heading of the same or a higher level) and the rest. The rest is the description of the whole PR (the summary of the change in the conclusion, and "変更"), and the section is the last fix (the "最後の直し" line of the conclusion and the "最後の直し" section) (`implementDescription`). The body that follows a template puts the description of the whole PR in "変更", followed by a bold "最後の直し" and its text.
  - A submission that wrote only the last fix, without the section, is not taken as the description of the whole PR. The base as of the earlier submissions (`implementBase`) is used as the whole, and the entire description of the last submission becomes the last fix. When there is no earlier submission (the first implementation), the description is left as it is even if it has the section. The body of a task with no redo is the same as before.
  - The viewpoint-test mapping (`Task.testMap`), when there is an earlier submission, lists for each viewpoint in this report the tests mapped up to the earlier submissions first and this submission's tests after them (the same test once; `mergeTestMaps`). A viewpoint to be checked in the diff without tests (`tests` is empty) uses this report as it is. A viewpoint that does not appear in this report keeps no earlier mapping (it stays an unmapped viewpoint and fails the verification as before).
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
  - Changes: the Implementation step's output (without progress reports; after a redo, the description of the whole PR followed by a bold "最後の直し" and the description of the last fix)
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

- While a PR is open and waiting for approval, its reviews, line comments, and ordinary comments are imported as comments (`PullRequestReviewImported`, actor `person`; actor `sacty` for a round of sacty's own AI review comments only).
  - They are imported after waiting 2 minutes from the last feedback (`FEEDBACK_QUIET_MS`).
    The time of each feedback is the earlier of its GitHub time and the time the daemon first saw it (memory only; `feedbackSeenAt`).
    Even if GitHub's time is ahead of this machine's clock, the feedback is imported 2 minutes after it was first seen (it does not keep waiting for GitHub's time).
    If GitHub's time is behind, there is no wait when 2 minutes have already passed by the time it is seen.
    The times for tasks that are no longer in scope for import (no longer awaiting approval, cancelled, and so on) are dropped at the next check.
  - Up to 50 (`REMARKS_MAX`) are imported, oldest first, at up to 2000 characters each (`REMARK_MAX`).
  - The same item is not imported twice.
  - While the implementation rework is paused, the task is not waiting for approval, so comments are not imported; they are kept as not yet applied and applied on resume ([Comments that arrive while paused](#comments-that-arrive-while-paused)).
  - For a taken-over existing PR, comments passed to the prompt of the Implement step are not imported (the implementation addressed them; [Taking over an existing PR](tasks-and-steps.en.md#taking-over-an-existing-pr)).
- Posts by a sacty task that reviewed this PR (a task pointing to the PR: the PR it took in, or the PR URL in its body) are identified by two things. They are that task's project account (which may differ from the original task's account) and the round in the marker (`<!-- sacty-review:<task ID>[:<round>] -->`). This is checked before the bot check, so the same applies even if that account is a bot (such as a GitHub App).
  - That task's rounds with findings are imported as comments. How the task was taken in (the review label (`source.review: sacty`), a review request (`requested`), a task created manually (no `source`), and so on) does not matter, because each is a review that a person asked for. Rounds with findings are those where `verdict` in `reviewVerdicts` is `changes_required` or `suggestions`; rounds whose verdict could not be read are also included so as not to drop comments.

    This delivers a review by a task separate from the one that opened the PR to the original task so that it addresses them. Rounds with suggestions only are imported too, and the budget stops the cost of repetition. How the verdict is decided is in [Tasks and steps](tasks-and-steps.en.md#pr-review-only-tasks).
  - Other rounds (rounds with no findings, and rounds with no recorded verdict: rounds not yet run, or rounds of a task that only refers to the PR and has no review step) are not imported, even if the account differs from the original task's. There is no Request changes, and the Goal Guardian does not run either.
  - Re-reviews are judged per round. A marker copied by someone other than that task's account is treated as a person's comment.
  - The imported comments are told apart from a person's comments as AI review comments ("AI review comments" below).
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
- If the judgment run was stopped because the daemon is stopping or the task is cancelled, it is not adopted as a failed judgment (that would redo the implementation). The same applies to the judgment for the import while waiting for approval: only the cost of the run is recorded in a `ReworkJudged` with `runResult: interrupted`, the comments stay unjudged, and they are judged again at the next check (after the restart).
- Just before requesting changes, the PR's status is read once more (a person may have merged or closed it during the judgment, or before a resumed check after the judgment was recorded).
  - If it is still open, changes are requested.
  - If it was merged, or closed without merging, changes are not requested. The imported comments (`PullRequestReviewImported`) and the judgment (`ReworkJudged`) stay in the ledger, and the status is checked again within the same check and recorded as "Merged" or "Closed without merging" in [The PR check](#the-pr-check) (for a merge, `PullRequestMerged` and `StepApproved`; `StepApproved` clears the state of the comments that were being worked on).
  - If the PR is reopened after being closed without merging, changes are requested with the judgment already recorded (it is not judged again).
  - If the status changed during the re-read (a person requested changes, the task was cancelled, and so on), nothing is recorded. If it cannot be read, the next check tries again.
  - Comments that arrive after a merge are not turned into a follow-up task or the like.

### AI review comments

Related ADR: [Treat comments from sacty's own AI review separately from a person's comments](../adr/20261102-0843-distinguish-ai-review-remarks.md)

The reviews, line comments, and ordinary comments that sacty's review task posts on a PR still reach the original task as before.
They are, however, told apart from a person's comments.

- How they are told apart: by the marker of the post (`<!-- sacty-review:<task ID>[:<round>] -->`). The posts imported by the judgment of "a sacty task that reviewed this PR" above become AI review comments (`PullRequestFeedback.source: "sacty_review"`).
  The account that posted them is not used to tell them apart (the review is posted with the project's account, the same account as a person's).
  Even with the same account, a post without the marker stays a person's comment.
- Record: `PullRequestReviewImported` keeps `sacty_review` in `items[].source`.
  The positions of the AI review comments among the imported comments are kept in `pendingReview.aiReview`.
  They are carried over to the comments of the request for changes (`ChangesRequested`) (`remarks[].source`, `Task.remarks[].source`).
  - If an import has only AI review comments, the actor is `sacty` (not a person's action). If even one person's comment is mixed in, it is `person`.
  - The same goes for the request for changes: if all the comments are AI review comments, the actor is `sacty`.
- Counts and limit: a request for changes made only of AI review comments is not counted in the number of requests for changes by a person, or in the limit on requests for changes to the same step (`MAX_CHANGE_REQUESTS`).
  - The count for a person (`changeRounds`) is the number of rounds that have at least one person's comment. Rounds of AI review comments only are not counted.
  - The round number and the comment IDs (`<step>-<round>-<number>`) continue through the AI review rounds as well (`lastChangeRound`).
  - A request for changes made only of AI review comments does not escalate, even when the limit has been reached.
  - The cost limit works as before.
- Reviews of an old head: if the head of the PR the review targeted (the review's commit; for a line comment, the parent review's `commit_id` (or else `original_commit_id`), not its own `commit_id`, which GitHub re-points to the current head after later pushes; `PullRequestFeedback.commit`) differs from the PR's current head at import time (`headSha` of `status`), it is discarded without being imported.
  - What is discarded is kept in `PullRequestReviewDiscarded` (actor `sacty`; `reason: stale_head`, the current head, and the discarded comments with their target commits) and marked as imported (`importedFeedback`). Changes are not requested and the Goal Guardian does not run. It is never imported again.
  - A post whose target commit is unknown is imported, because it cannot be told whether it is old. A short commit is compared by prefix.
  - When the PR's head cannot be read, only the AI reviews are left out this time and checked again at the next check (a person's comments are imported).
  - A person's comments are imported whatever the head.
  - What is discarded is delivered to the person (PBI-291). `items[].summary` of `PullRequestReviewDiscarded` keeps the gist of the comment (the first 400 characters of the same text that would be imported, without the post's marker and heading, whitespace normalized; older records have none), and it is accumulated in `Task.discardedReviews`. `discardedAiReviews` returns those for the PR being watched (the gate's PR; the implementation PR while it is being reworked), oldest first, and returns none once the PR is merged (until then they stay, even after the PR is closed or the task is sent back).
  - The approval screen and the top of the task detail (`DiscardedReviewNotice`) show them as "AI review comments not taken in": the reason (the old head and the PR's head at the time of the last discard; it is not updated when the PR is updated afterwards), the target commit of each comment, the gist, and a link to GitHub, so that the person notices before approving or merging.
  - The discarded comments are not imported into the rework automatically, the AI review is not re-run on the new head, and sacty does not post to the PR. If the person judges that a comment also applies to the new head, they convey it as a change request (or a PR comment); it is treated as a person's comment (no `source`; it counts toward the change count).
- How they are passed to agents: a person's comments and AI review comments are passed separately.
  - In the instructions to step agents (Implementation, Requirements, Design, and so on), the final review, the integration review, the judgment of where to send back to, answers to questions, and the audit instructions, they are split into a "comments from a person" section and an "AI review comments (not from a person)" section (`remarkSections`, `reworkRemarkLines`).
  - When AI review comments are listed, a note is added to the person's section: "the previous comment" or "the earlier comment" in a person's comment refers to a person's comment, not an AI review comment.
  - In the judgment of where to send back to, a note says AI review comments are not a new request added by a person (`new_request`).
  - Even though the final review and the integration review get the sections separately, they are asked to judge the recurrence of past comments for both a person's comments and AI review comments (`REMARK_RECURRENCE_LINE`, `remarkVerdictLines`; ADR: [Ask the final review and the integration review to judge recurrence for past AI review comments too](../adr/20261103-0312-judge-ai-review-remarks-in-reviews.md)). When AI review comments are listed, the explanation of the output format adds that a verdict must be written for each AI review comment too, and that a missing verdict counts as recurred and fails the review.
- Passing the Goal Guardian's judgment text (PBI-300): the instructions of a redo run (Requirements, Design, or Implementation) that starts from that judgment (the target and the reasoning on how it read the comments) include the judgment text (`guardianJudgmentLines`).
  - It is passed only to a run that starts from the comments of the round the judgment sent back (when the target step, the round `round`, and the comment IDs `remarkIds` in `prRework` match the current comments of that step: the latest round, not voided, and not yet passed to a submission; if even one comment was voided after the judgment, nothing is passed, so that a judgment that interpreted the voided comment does not come back to the run). The instructions do not change for a run without a judgment (the first run, a redo after a final review failure or an upstream change, a rerun whose only comments are already submitted, or a round a person sent back from the screen).
  - The instructions say that the judgment text is the Goal Guardian's interpretation, not the person's comment itself. The original text of the person's comments is passed as before, and when the two disagree the run follows the original text (the person's comments first). Instructions written inside the judgment text are not followed.
  - The judgment text is treated as an outside string: secrets and URL credentials are hidden, it is cut at 3,000 characters, and it is passed as one line of JSON (`{"guardianJudgment": …}`) separate from the instructions.
  - When the target could not be decided (`decided` is false), the reason it could not be decided (what could not be read) is passed too. The run does not make big changes by guessing what it could not read: it checks against the original comments and the approved deliverables and makes the smallest change that clearly answers the comments. It concludes that no change is needed only when it can show with evidence that the comments' request is already met. It writes what it could not read and how it fixed it in the response to the comment (`text` in `sacty-responses`); for Requirements and Design it also adds to "確認したいこと" when something is left for a person to decide.
  - When the Goal Guardian's run failed or its output could not be read (the reason is sacty's own wording), it is not a reading of the comments, so nothing is passed.
- Display: the request-for-changes and import rows in the Activity show AI review comments separately ("3 comments (AI review)", "1 from a person, 2 from AI review"), and the comments on the approval screen carry an "AI review" mark. The expanded details of a request for changes in the Activity also mark the AI review comments. The approval screen adds "not counted" only when the round has no person's comment.
  The dashboard's quality signals count "Rework from AI review", and the audit's evidence counts "AI review remarks" (`aiReviewRemark`), separately from changes requested by a person and PR remarks ([Architecture](architecture.en.md), [Audit](audit.en.md)).

Code: `apps/daemon/src/service.ts` (`importFeedback`, `withoutStaleReviews`, `sactyReviewsOf`, `feedbackRemarks`, `FEEDBACK_QUIET_MS`, `feedbackSeenAt`, `settleReview`, `judgeRework`), `apps/daemon/src/prompts.ts` (`buildReworkPrompt`, `reworkDecisionLines`, `remarkSections`, `guardianJudgmentLines`), `apps/daemon/src/github.ts` (`GitHubPullRequests.feedback`), `packages/core/src/projection.ts` (`changeRounds`, `lastChangeRound`, `isAiReviewRemark`)

### Things for a person to check

Related ADR: [人に確かめてほしいことを、PR のコメントと承認の画面の目立つ所に出す](../adr/20261103-2302-surface-human-asks.md)

In a rework started by PR comments, there can be things only a person can check: whether the comments were read as meant. If they appear only in a corner of the approval screen or in the activity, the people looking at the PR do not notice them. The following two are collected as "things for a person to check" (`humanAsks`) and shown in the PR comment and in a prominent place on the approval screen and the task details.

- The reason it could not be decided (`undecided`): the Goal Guardian could not decide where to send the task back (`prRework.decided` is false), and the implementation or another step was redone. The reason is the text the Goal Guardian wrote (what could not be read). When the reason is sacty's own wording (the Goal Guardian's run failed or its output could not be read), it is not a reading of the comments, so it is not shown.
- A question or a guess from the run (`confirms`): a `confirm` that the rework run attached to its response to a comment (`sacty-responses`). The run is told to write it when it guessed because it could not read what the comment meant, when it recreated a value or wording it no longer had, when it changed something the comment did not ask for, or when it left a comment unaddressed (`confirmLines`). A response with nothing to check does not get one. It is cut at 1,000 characters. It is kept in `RemarkResponse.confirm`, and `Task.remarks[].confirm` holds only the one from the same submission as the response (it is cleared if the next submission has no response).

- When it is shown: the task is waiting for approval, for the comments (not voided) that the current gate's submission (`gate.submission`) received. The reason it could not be decided is shown only when the `prRework` target is the gate's step and its comment round (`round`) is the latest round of that step (an old judgment is not shown after a later send-back). Nothing is shown when the task is not waiting for approval (during a rework or while paused).
- Screen (`HumanAskNotice`): shown as "N things for you to check" at the top of the approval screen and in the task details below the approval notice (visible on every tab). The reason it could not be decided shows the gist (the first one or two sentences) first, and the full text opens below ("How the send-back judgment text is shown" below).
- PR comment: when the reworked deliverable is back to waiting for approval (a `StepSubmitted` that makes the gate's step or submission new; if it could not be written while the task was paused, sacty tries again when the resume brings the task back to waiting for approval on the same submission, and it does not write again if it finds a comment with the marker), one comment is posted on the PR of that gate (the implementation PR, the Requirements PR, or the Design PR) (`announceHumanAsks`, `buildHumanAskNotice`).
  - The comment starts with a marker (`<!-- sacty-human-ask:<task ID>:<step>:<submission> -->`). If a comment with the marker already exists for the same submission, nothing is posted.
  - It is not written for a task with a security plan (`security-check`, `security-fix`), because what the run wants checked can include details of a vulnerability or the fix scope (it still appears on the approval screen; this is the same rule as for requested comments).
  - Paths inside sacty's workspace (such as `/sacty-input/task.md:77`) in those outside strings are replaced with a name a person can follow (`withoutInternalPaths`).
  - The body quotes the reason it could not be decided and what the run wants checked. Because they are outside strings, secrets are hidden before cutting at 600 characters, and a zero-width space is put after `@` so that `@name` does not notify other people. It ends by telling the reader to comment on the PR or send the task back on the task screen if the result is not what was meant.
  - It is posted with the project's gh account (nothing is posted for a project with no GitHub account chosen; the screen still shows it). It does not wait for the post, and the request has a 30-second deadline. If posting fails, the task state does not change (a warning is logged).
  - This comment is not imported as a person's comment in the next PR check (comments from the task's account that start with the marker are excluded; if someone else copies the marker, it is imported as a person's comment).

Code: `apps/daemon/src/service.ts` (`announceHumanAsks`, `humanAskDue`), `apps/daemon/src/human-ask-notice.ts`, `apps/daemon/src/github.ts` (`isHumanAskNotice`, `GitHubPullRequests.feedback`), `apps/daemon/src/prompts.ts` (`confirmLines`, `extractBlocks`), `packages/core/src/projection.ts` (`humanAsks`), `apps/web/src/components/human-ask.tsx` (`HumanAskNotice`)

### How the send-back judgment text is shown

The Goal Guardian's judgment text for where to send a task back (`reason` of `ReworkJudged`) can run 600 to 1,000 characters, which is hard to read when shown as it is. The screen shows the gist first and lets you open the full text (`summarizeDecision`).

- Gist: up to the first two sentences (split at a Japanese full stop, an English period followed by a space, or a line break; a full stop inside brackets does not split). If it is longer than 160 characters, it is cut at 160 characters and "…" is added. If the full text is the same as the gist, nothing is collapsed.
- Where: the send-back row in the activity (the gist in the row, the full text in the details), the send-back target in the PR card (`prRework`; the gist, with the full text to open below it), and the reason it could not be decided in the things for a person to check.
- Not changed: the activity record (`reason` of `ReworkJudged`) and the judgment text passed to the rework run ([how the Goal Guardian's judgment text is passed](#ai-review-comments)) stay in full.

Code: `apps/web/src/lib/decision-summary.ts`, `apps/web/src/lib/labels.ts` (`describeEventParts`), `apps/web/src/components/pull-request.tsx` (`PullRequestCard`)

## Request changes

- Steps that can be gone back to (`reworkTargets`) are the `REWORK_STEPS` that are the step waiting for approval or before it, nearest first.
  - `reproduce` and `investigate` only when they themselves are waiting for approval.
  - When Integration review is waiting for approval, only `split`.
  - If the target is omitted, the first one (`implement` when Implementation is waiting for approval).
- Requesting changes while waiting for approval needs at least one comment (`gate.remarksRequired`). A person can void comments, and voided comments are not passed to the agent.
- A comment has a source (`remarks[].source`). Comments from sacty's own AI review are `sacty_review`; without it, it is a person's comment ([AI review comments](#ai-review-comments)).
  The count for the limit (`changeRounds`) is the number of rounds that have at least one person's comment. The round number and comment IDs continue through the AI review rounds as well (`lastChangeRound`).
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
| `too_many_changes` | A Request changes after requests for changes by a person to the same step reached `MAX_CHANGE_REQUESTS` (3) (rounds of AI review comments only are not counted). Comments in progress are kept. To continue beyond the limit, request changes explicitly (`overLimit`) |
| `change_undecidable` | The Goal Guardian could not judge a change request. A person decides (`ChangeDecided`) |
| `rework_confirmation` | A record from an earlier version (no longer recorded) |

Code: `apps/daemon/src/service.ts` (`requestChanges`, `decideChange`), `packages/core/src/events.ts` (`TaskEscalated`, `MAX_CHANGE_REQUESTS`), `packages/core/src/projection.ts` (`changeRounds`)
