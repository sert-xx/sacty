[日本語](split-and-integrate.md) | **English**

# Task split and integration review

With the `split` plan, an agent creates child tasks based on the approved design. When all child tasks are settled, Integration review checks whether the child tasks' results meet the parent's requirements. If it does not pass, the agent adds fix child tasks.

Related ADRs: [Dependent child tasks start stacked on the dependency's PR branch once that PR passes the final review](../adr/20261108-0615-stack-dependent-subtasks-on-reviewed-pull-requests.md)

## Splitting

- The number of child tasks is from `MIN_SPLIT_CHILDREN` (2) to `MAX_SPLIT_CHILDREN` (10). From the second round, which adds fix child tasks, a single one can be created.
- The agent's answer (heading `sacty-split`) is checked for the count, duplicate `key` values, missing dependencies, self-dependencies, and dependency cycles. If it cannot be read, the task is paused.
- Child tasks are created with `start: split` and `parent` (the parent's ID and `dependsOn`). The body includes the parent's approved requirements and design, and the information the parent gathered at the start of the task (if any). Child tasks do not gather information again ([Tasks and steps](tasks-and-steps.en.md#information-gathering)). Child tasks without dependencies start waiting to run; child tasks with dependencies start as `blocked` and become waiting to run once all their dependencies are settled (`TaskUnblocked`).
  When a dependency's PR passes the final review, a child task may also start stacked on that PR without waiting for it to be settled (see "Child tasks stacked on a dependency's PR" below).
- A child task's repository is the child task's `repo`, or the parent's repository if absent. When splitting a parent without a repository, each child task's `repo` is checked against the project's targets; if it is missing or not in the targets, sacty does not use the split and stops the task. The instructions tell the agent to complete each child task within one repository, and to split changes across repositories and connect them with `dependsOn`.
- Splitting is one level only (child tasks cannot choose `split`).
- The parent waits for child tasks in `waiting_children`. When all child tasks are settled (completed, or canceled with a person's acknowledgment), it moves to the next step with `SplitCompleted`.
- When a child task is canceled, the parent is paused (`child_cancelled`). Resuming the parent counts as acknowledging that cancellation.

Code: `apps/daemon/src/service.ts` (`settleSplit`, `childSettled`, `splitWithRepositories`), `apps/daemon/src/prompts.ts` (`extractSplitPlan`, `buildChildBody`, `splitRepositoryLines`), `packages/core/src/events.ts` (`MIN_SPLIT_CHILDREN`, `MAX_SPLIT_CHILDREN`)

## Child tasks stacked on a dependency's PR

A child task with dependencies starts, without waiting for the merge, from the branch of a dependency's implementation PR once that PR passes the final review (stacked PRs; PBI-317).

- Deciding whether to start (`blockedStart`; in the parent's `settleSplit`, for each `blocked` child task): dependencies are sorted into the following. When it cannot be decided, the child task waits.
  - In the base branch (`landed`): canceled with a person's acknowledgment, or completed or with its implementation PR merged (`implementationMerged`; the after-merge watch is under way), and not stacked on another PR.
    A dependency whose PR was merged while still stacked (a person marked it ready and merged it before the PR it is stacked on) is not in it yet, because its changes are only in the branch of the PR it is stacked on. It gets in once that PR is merged and its starting branch is changed (`StackedDependencyMerged`)
  - Stackable: an open implementation PR made after passing the final review, with the task waiting for approval of the implementation (`reviewedPullRequest`). A PR made for the verification wait (`verifying`), the PR of the current submission that a person moved to review despite a failed final review, and a person's PR that was taken over are excluded. Only those in the same repository as the child task
  - Others
- How it starts:
  - When all dependencies are in the base branch, it starts from the base branch (`TaskUnblocked`; not stacked).
  - When one of the dependencies (X) is stackable, and all other dependencies can be confirmed to be in X's passing commit, it starts stacked on X (`stackedOn` of `TaskUnblocked`: X's ID, PR branch, and passing commit).
    A dependency can be confirmed to be in it when X waited for it (including dependencies of dependencies; `waitedOn`) and it is in the base branch or in the chain X is stacked on (the chain followed from X through the tasks it is stacked on; `stackChain`). The starting point is decided by this rule also when there are two or more dependencies.
  - Otherwise (no single target can be decided, another repository, not passed), it waits.
    For example, a child task that depends on A and B, which do not depend on each other, is not stacked on B when A is merged, because B's passing commit does not contain A's changes; it waits until B is also in the base branch.
- Starting point: a stacked child task (`Task.stack`), when its workspace is first prepared, clones X's PR branch and checks out the passing commit (`prepareRepositoryNow`).
  The recorded starting branch (`repository.baseBranch`) is X's PR branch, and the base commit is the passing commit. The workspace is not prepared again on the base branch the orchestrator chose.
  When X's PR is merged before the workspace is prepared, it is prepared on the latest of the changed starting branch (`Task.stackedBase`; `baseBranch` of `StackedDependencyMerged`). In this case too, the workspace is not prepared again on the base branch the orchestrator chose.
- Merging in (`syncBase`): it merges at the same points as the base branch merge ([Merging the base branch](tasks-and-steps.en.md#merging-the-base-branch)). While stacked, it merges X's PR's passing commit instead of the base branch (when X was fixed and passed again).
  It fetches X's PR branch, and does a three-way merge of the passing commit (not the branch head), with the commit the workspace is currently based on as the common ancestor. It is recorded as `BaseBranchMerged`.
  It does not merge when X has no passing PR (being reworked, or closed) or when the passing commit is the current base. Conflicts and failures are handled the same as in the base branch merge. It does not merge while waiting for approval.
- PR (`publish`): a stacked child task's implementation PR targets X's PR branch, and stays a draft while waiting for approval even after passing verification (to keep the merge order; GitHub cannot merge a draft PR).
  When the PR cannot be made a draft, the task stops instead of waiting for approval (`pr.stackDraftFailed`). Even when the repository cannot use draft PRs, it does not make a PR that is not a draft (`requireDraft` of `PullRequests.upsert`; it stops with `pr.failed` without making one). It also stops when an updated PR cannot be turned back into a draft, or the answer says it is not a draft. Resuming tries again from making or updating the PR.
  The target is also sent when the PR is updated (`retarget` of `PullRequests.upsert`), and it is recorded in `baseBranch` of `PullRequestPublished`. It is not recorded for the PRs of tasks that are not stacked (their target stays the base branch decided when the PR was made).
  At the top of the body (at the top of the summary when following a template), it writes X's PR number, URL, and the child task's title, that it must not be merged before X, and that sacty changes the target to the base branch and marks it ready for review once X is merged (`stackedBodyLines`; not cut by the body length limit).
- When X's PR is merged (`merged` of `stackAction`): sacty records `StackedDependencyMerged` on the child task and changes the starting branch to the branch X's PR went into (X's starting branch). If X was itself still stacked on another dependency (a person marked it ready and merged it first), the child task is stacked again on that dependency (`stackedOn`). Otherwise it is no longer stacked.
  The recorded base commit and merge are not changed, so the next merge takes in the latest of the new branch with X's passing commit as the common ancestor.
  It is recorded even when the child task is completed.
- Changing the target of a PR waiting for approval (`retargetDue`, `retargetPullRequest`): at each PR check (every 60 seconds; `checkPullRequests`), when the recorded target of the PR of a child task waiting for approval differs from the current starting branch, sacty changes the target of the PR on GitHub and rewrites the body. When it is no longer stacked, it marks the PR ready for review (it is a PR that passed verification). It records `PullRequestRetargeted`.
  On failure, it records nothing, writes it to the daemon log, and tries again at the next check (the task is not stopped). The PR of a child task that is not waiting for approval is changed the next time the PR is updated.
  It does not start for a child task that is running, and the child task is not run while its target is being changed. When the task changed while waiting for GitHub (by a send-back, a pause, a cancellation, and so on: it is no longer waiting for approval, or its PR, commit, submission, starting branch, or stacked target differs), sacty neither marks the PR ready nor records it (the reworked submission updates the PR with the target and draft state at that time).
- When X is canceled (`cancelled` of `stackAction`; something in the chain of tasks it is stacked on was canceled): when the child task is waiting to run, idle, or waiting for approval, it is paused (`stack.dependencyCancelled`). When it is running, it is stopped after that run ends.
  It was built on top of X's changes, so resuming is not accepted (it can be canceled; the parent's `child_cancelled` handling is as before). When X is canceled before passing, the child task does not start, as before (it stays `blocked`; once a person acknowledges the cancellation, it starts from the base branch).
- Merge order: when a person marks the child task's PR ready and merges it before X, the merge is taken as the approval, as before (the child task's changes go into X's PR branch).
  They are not in the base branch yet, so child tasks that depend on this child task wait until X is merged (`landed` above).
- The state is derived from the activity log (`stackedOn` of `TaskUnblocked`, `StackedDependencyMerged`, `baseBranch` of `PullRequestPublished`, `PullRequestRetargeted`, `BaseBranchMerged`), so it is not lost when the daemon restarts.
- Child tasks without dependencies and tasks that are not split have neither a stacked target nor a recorded PR target, and their behavior does not change.

Code: `apps/daemon/src/service.ts` (`blockedStart`, `landed`, `waitedOn`, `stackChain`, `cancelledInStack`, `stackAction`, `settleStack`, `retargetDue`, `retargetPullRequest`, `recordsPullRequestBase`, `stackedPullRequest`, `prepareRepositoryNow`, `syncBase`, `publish`, `resume`), `apps/daemon/src/prompts.ts` (`stackedBodyLines`), `apps/daemon/src/github.ts` (`GitHubPullRequests.upsert`), `packages/core/src/events.ts` (`TaskUnblocked`, `StackedDependencyMerged`, `PullRequestRetargeted`), `packages/core/src/projection.ts` (`stack`, `stackedBase`, `reviewedPullRequest`, `implementationMerged`)

## Integration review

- The AI is `step_agents.integrate`, or `guardian_agent` if absent (or `default_agent` if that is absent too).
- The latest base branch is fetched and passed as a disposable copy. For a parent without a repository, copies are laid out per child task repository and base branch. The instructions include the approved requirements and design, the test viewpoints (`REQ` if none), a summary of the child tasks (title, status, PR URL, round, repository), the person's past comments, and the AI review's past comments (in separate sections). The viewpoint IDs in the output format example are the viewpoint IDs under review (`integrationViewpointIds`; PBI-137).
- As in the final review, the instructions keep the check of the acceptance criteria from shrinking to confirming that a name, item, file, or link exists (`ACCEPTANCE_DEPTH_REVIEW_LINE`), have the Goal Guardian check, when the diff newly adds or changes a shared mechanism (a queue, a lock, a cache, a flag, and so on), that later processing continues after an anomaly or failure (`sharedMechanismLines`; there is no field for what a person should check, so what could not be checked is written in the explanation of the verdict), and have it write its output in the language of the task (`OUTPUT_LANGUAGE_LINE`; PBI-301; see the final review in [Tasks and steps](tasks-and-steps.en.md)).
- The answer (heading `sacty-integration-review`) passes only when every viewpoint is met, no comment has recurred, and `findings` is empty.
  The comments are both the person's and the AI review's, and the instructions ask for a recurrence verdict on both (as in the final review; see [Tasks and steps](tasks-and-steps.en.md)). An AI review comment with no verdict fails the review.
- A broken JSON answer is read with repairs, as for the final review (PBI-298: double quotes and control characters inside strings, and so on; the answer has no nested object, so a missing closing bracket is not added). A read with repairs is recorded in `outputRepaired` of `IntegrationReviewed`. If it still cannot be read, the review stays failed, and the summary says where it is broken (the line and column in the JSON; `integrate.unreadableAt`) or that fields are missing (`integrate.unreadableShape`).
- If it passes, the task waits for a person's approval. If it fails, it goes back to `split` to add fix child tasks. If it fails `MAX_INTEGRATION_ATTEMPTS` (3) times in a row, it waits for a person's approval while still failing, without adding fix child tasks. Requesting changes while Integration review is waiting for approval resets the count.

Code: `apps/daemon/src/service.ts` (`integrate`, `childRepositories`), `apps/daemon/src/prompts.ts` (`buildIntegrationReviewPrompt`, `extractIntegrationReview`, `integrationViewpointIds`), `apps/daemon/src/config.ts` (`agentFor`), `packages/core/src/events.ts` (`MAX_INTEGRATION_ATTEMPTS`)
