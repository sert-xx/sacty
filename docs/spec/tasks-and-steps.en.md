[日本語](tasks-and-steps.md) | **English**

# Tasks and steps

A task proceeds as a sequence of steps (Investigation, Requirements, Design, Implementation, and so on). Which combination of steps (plan) to use is
chosen by the Orchestrator when the task starts. Agents run the steps, and people decide only at approval steps (approval gates). The Goal Guardian
judges change requests, the final review, where to send PR comments back to, and Integration review.

Approval and Request changes are in [Approval and request changes](approval.en.md); Task split and Integration review are in [Task split and integration review](split-and-integrate.en.md).

Related ADRs: [Set up the agent configuration for handling a repository with sacty through the "Sacty setup" task template](../adr/20261014-1530-task-template-sacty-setup.md)

## How tasks are created

`start` in `TaskCreated` records where the task came from.

| `start` | How it was created |
| --- | --- |
| `sacty` | Created in the web UI (the older `ticket` is also read as `sacty`) |
| `github_issue`, `github_pull_request` | Intake of a GitHub Issue or PR ([Ticket intake](intake.en.md)) |
| `jira` | Intake of a JIRA ticket |
| `deployment` | A task to fix a failure found by the after-merge watch (`fix` holds the original task, the kind, the marker, and the level. [After-merge watch](deployment-watch.en.md)) |
| `split` | A child task of Task split (`parent` holds the parent's ID and the child tasks that must finish first, `dependsOn`) |

- A PR-review-only task has `source.review` (`requested` or `label`; `sacty` if it is a PR that has the intake label sacty creates and attaches).
- When creating a task in the web UI, if no repository is specified (`repo: null`), or the repository is omitted and the project's targets are not exactly one repository,
  the task becomes a task without a repository (`noRepo`). It cannot be created in a project with no targets (`task.repositoryMissing`).
- The initial budget cap is `budget.default_per_task_usd` (default 1 US dollar).
- The status values are in the "Projection" table of [Activity log](event-log.en.md). There is no "completed" status; a task is complete when every step is `done` or `skip` (`isCompleted`).

Code: `packages/core/src/events.ts` (`TaskCreated`, `TaskSource`), `packages/core/src/projection.ts` (`isCompleted`, `isRepoless`), `apps/daemon/src/service.ts` (`createTask`)

### Task templates

If the body of `POST /api/tasks` has `template`, the task is created from a template (`CreateTemplateTaskInput`). The only template is
`sacty-setup` (Sacty setup).

- Only `template`, `projectId`, and `repo` are accepted. Passing `title`, `body`, or any other item gives 400 (sacty decides the title and description).
  An unknown template, an empty `repo`, or `repo: null` also gives 400.
- The target repository is required. If omitted and the project's targets are exactly one repository, that one is used. Otherwise the task is not created
  (`task.templateRepositoryRequired`, 409). A repository outside the targets is not accepted, as with ordinary tasks (`task.repositoryUnknown`).
- `template` is recorded in `TaskCreated` (`start` is `sacty`, and `repo` is normalized to the registered name, as with ordinary tasks). It remains in the projection's
  `Task.template`.
- The title is `Sacty セットアップ（<owner>/<name>）`, and the description (goal) is the text decided by `templateTask`. After creation, as with an ordinary task,
  the Orchestrator chooses the plan (the template does not decide the steps).
- The goal of `sacty-setup` is to check the agent configuration needed to handle the target repository with sacty, and to open a PR that fills in what is missing.
  The text does not assume any particular language or tool. What it checks and fills in:
  1. Instructions for agents (AGENTS.md, CLAUDE.md, and so on; not maintained in two places)
  2. How to run tests (the command and prerequisites; whether they match the current configuration)
  3. Services needed for tests (how to start them and where to connect; if none are needed, say so)
  4. For repositories that deploy with CI/CD, the deployment-checking skill `deployment-observer`. The original goes in
     `.agents/skills/deployment-observer/SKILL.md`, and `.claude/skills/deployment-observer` is a relative symbolic link to `../../.agents/skills/deployment-observer`.
     It has the agent write the front matter (`name`, `description`), how to tell that a deployment finished, how to check it, and how to connect;
     the promises not to change anything, not to reveal secrets, and to answer `unknown` when it cannot judge; and the shape of the JSON answer under the heading `sacty-deployment`.
     The location, link target, and heading are built from the after-merge watch's `DEPLOYMENT_SKILL_PATHS` and `DEPLOYMENT_HEADING`
     ([After-merge watch](deployment-watch.en.md)).
- The goal also says that if everything is in place and no change is needed, the task ends with Investigation only, without a PR, and leaves the check result for each item (if the Orchestrator
  chooses `investigate`, the task completes when the investigation result is approved in the web UI). If it turns out after the steps have run that no change is needed, the agent is asked to
  leave the files unchanged and write the check results and reasons in the implementation notes (no PR is opened; a person checks it and the task completes without changes. [Approval and request changes](approval.en.md#when-the-implementation-has-no-changes)).

Code: `packages/core/src/events.ts` (`TaskTemplate`, `CreateTemplateTaskInput`, `TaskCreated`), `apps/daemon/src/service.ts` (`createTask`, `createTemplateTask`, `projectRepository`), `apps/daemon/src/task-templates.ts` (`templateTask`), `apps/daemon/src/deployment.ts` (`DEPLOYMENT_SKILL_PATHS`, `DEPLOYMENT_HEADING`)

## Steps

| Key | Step | What it does |
| --- | --- | --- |
| `investigate` | Investigation | Examines the code and reports |
| `review` | Review | Reviews an existing PR and posts to the PR |
| `requirements` | Requirements | Writes the requirements |
| `design` | Design | Writes the design and test viewpoints |
| `split` | Task split | Creates child tasks and waits for them to finish |
| `integrate` | Integration review | Checks whether the child tasks' results meet the parent's requirements |
| `reproduce` | Reproduce | Writes a test that reproduces the bug (fails) |
| `implement` | Implementation | Implements |
| `pr` | Deliverable review | sacty opens the PR (no agent is used) |

Step categories:

- Steps with an approval gate (`GATED_STEPS`): `investigate`, `requirements`, `design`, `integrate`, `pr`. However, Investigation at the start of a plan that implements
  (preliminary investigation) moves on to the next step without approval (`StepCompleted`). Only Investigation in a task whose purpose is investigation (the last step is `investigate`) is approved.
- Steps that can be redone through Request changes (`REWORK_STEPS`): `investigate`, `reproduce`, `requirements`, `design`, `implement`.
- Steps that need a repository (`REPO_STEPS`): `implement`, `reproduce`, `review`, `pr`.
- Steps that can use docker compose services (`SERVICE_STEPS`): `investigate` (only for bug investigation), `reproduce`, `implement`.
- Steps that can be exported (`EXPORT_STEPS`): `investigate` (only when it is the last step), `requirements`, `design`.

Code: `packages/core/src/events.ts` (`StepKey`, `GATED_STEPS`, `REWORK_STEPS`, `EXPORT_STEPS`, `exportSteps`), `packages/core/src/projection.ts` (`investigationIsGoal`), `apps/daemon/src/service.ts` (`REPO_STEPS`, `submitEvents`), `apps/daemon/src/prompts.ts` (`SERVICE_STEPS`)

## Plans

| `plan` | Steps |
| --- | --- |
| `standard` | `investigate` → `requirements` → `design` → `implement` → `pr` |
| `skip-design` | `investigate` → `requirements` → `implement` → `pr` |
| `investigate` | `investigate` (investigation only) |
| `design-only` | `requirements` → `design` (design only) |
| `review` | `review` (review only) |
| `split` | `investigate` → `requirements` → `design` → `split` → `integrate` |
| `bugfix` | `investigate` → `reproduce` → `implement` → `pr` |

Restrictions on which plans can be chosen (`allowedPlans`): `review` only when there is a repository and the task points to a PR. `design-only` only for tasks
without a repository. `split` cannot be chosen by child tasks (splitting is one level only).

Code: `packages/core/src/events.ts` (`STEP_PLANS`), `apps/daemon/src/prompts.ts` (`allowedPlans`, `REPO_PLANS`)

## Orchestrator

It runs once before the steps are chosen (when the task starts). The AI is `step_agents.orchestrator` (or `default_agent` if absent); it uses the default image and
reads a disposable copy of the code at the base commit. Its cost counts toward the task's budget. If the budget cap has been reached, the task is paused without running it.

The following are read from the answer (JSON under the heading `sacty-steps`) and recorded in `StepsChosen`.

| Item | Meaning and handling |
| --- | --- |
| `plan`, `reason` | The plan and the reason |
| `baseBranch` | The base branch. If it differs from the default branch, the workspace is prepared again on that branch (if it cannot be prepared, the task continues on the default branch and the reason is replaced) |
| `testCommand` | The test command (run with `sh -c`; exit code 0 passes; 1 to 1000 characters). If there is an Implementation step but no command, the task is paused |
| `investigation` | The kind of investigation (`content`: investigating content, `bug`: investigating a bug) |
| `images`, `imageReason` | The image per step. If the project's target specifies an image, it is used for all steps without asking. A name not in `images` stops the task |
| `services`, `servicesReason` | The compose files, services, and steps to start ([Services](services.en.md)). Shared compose files are chosen by name (an unknown name stops the task) |
| `exports` | The export destination and reason per step ([Export](export.en.md)) |
| `documentsDir` | The directory for the requirements and design files ([Approval and request changes](approval.en.md)) |
| `repo`, `repoReason` | For a task without a repository that chose a plan needing one, the repository to work in |

- When a task without a repository chooses steps that need a repository, `repo` is checked against the project's targets, `RepositoryChosen` is recorded,
  and the repository is prepared before asking to choose again. If it is not in the targets or is empty, the task stops, and a person can pick a repository in the web UI to resume (only while paused and
  waiting for a repository). If the plan does not need a repository, `testCommand`, `baseBranch`, `services`, and `documentsDir` are discarded.
- When the run fails or the answer cannot be read, `OrchestratorFailed` is recorded and the task is paused (it does not fall back to the standard plan).
- For a task taken in from a ticket, before choosing steps the Orchestrator reads the ticket and decides the repository, title, and summary (`TicketTriaged`).
- A PR-review-only task uses the `review` plan without the Orchestrator (`reviewOnlySteps`).
- Reuse of Orchestrator sessions is described in "Saving and reusing sessions" in [Agent execution](agent-execution.en.md).

Code: `apps/daemon/src/service.ts` (`askOrchestrator`, `runNextInner`, `withImages`, `withSharedCompose`, `withExports`, `repositoryFromPlan`, `chooseRepository`, `triageTicket`, `reviewOnlySteps`), `apps/daemon/src/prompts.ts` (`extractStepPlan`), `packages/core/src/events.ts` (`StepsChosen`)

## Verifying the implementation

- When the Implementation step finishes, the task waits for verification (`verification = "pending"`), and the test command is run in a test container. It passes when the exit code is 0 and
  every verification viewpoint corresponds to a test. The viewpoints are the design's test viewpoints if there is a design, `REPRO` if there is a reproduction, and otherwise `REQ`.
- After the tests pass, the task moves to the Goal Guardian's final review. The final review reads the code after implementation and the diff, judges each viewpoint and each comment,
  and passes only when all are met. If it passes, the task moves to the next step (Deliverable review).
- If the tests or the final review do not pass, the implementation is redone. If they fail `MAX_VERIFY_ATTEMPTS` (3) times in a row, the task is paused (`verification`).
  Resuming resets the count.
- After the Reproduce step, the reproduction test is run; if the exit code is not 0, the bug is treated as reproduced and the task moves to Implementation. If it is 0 (or no reproduction test
  was declared), the bug is treated as not reproduced and the task waits for a person's decision (the Reproduce step cannot be approved; request changes or cancel).
- The test image is the Implementation step's image (or Reproduce's if absent) for verification, and the Reproduce step's image (or Implementation's if absent) for checking reproduction.

Code: `apps/daemon/src/service.ts` (`verify`, `checkReproduction`, `pauseIfVerificationKeepsFailing`), `apps/daemon/src/prompts.ts` (`verificationBasis`), `packages/core/src/events.ts` (`MAX_VERIFY_ATTEMPTS`)

## Goal Guardian

The AI is `guardian_agent` (or `default_agent` if absent). For each run it makes a copy of the code in `workspaces/_guardian/<run ID>` and deletes it when done.

| Role | What it reads | Verdict |
| --- | --- | --- |
| Judging change requests | The code at the base | `approved`, `rejected`, `undecidable`. If it cannot read or fails, `undecidable`, which goes to a person's decision (Escalation) |
| Final review | The code after implementation and the diff | Pass or fail ("Verifying the implementation" above) |
| Deciding where to send PR comments back to | The code after implementation for Deliverable review; the code at the base for Requirements and Design | The step to go back to, or `undecidable` ([Approval and request changes](approval.en.md)) |
| Integration review | The latest base branch | This AI if `step_agents.integrate` is absent ([Task split and integration review](split-and-integrate.en.md)) |

Change requests: a step's agent can request a change to approved requirements or design (IDs are `CP-<number>`). If approved, the requirements
have their approval revoked and go back for re-approval, and the design replaces the approved version. If rejected, the requesting step submits its result.

Code: `apps/daemon/src/service.ts` (`judge`, `settleEvents`, `runGuardian`, `verify`, `judgeRework`), `apps/daemon/src/prompts.ts` (`extractVerdict`, `extractFinalReview`, `extractRework`)

## Budget, pause, resume, and cancel

- Budget: when spending reaches 80% of the cap (`BUDGET_WARN_RATIO`), `BudgetWarned` is recorded (once). When the cap is reached, the task is paused (`budget`) before choosing steps,
  before running a step (except Deliverable review), and before verification. Tasks waiting for approval are not stopped. Resuming a task stopped by the budget
  requires a new cumulative cap larger than the amount spent (up to 10000 US dollars) (`BudgetCapRaised`).
- Pause reasons (`PauseReason`): `budget`, `usage_limit` (the AI's usage limit), `auth` (an authentication error or missing secret), `error`,
  `verification`, `manual` (a person paused it), `child_cancelled` (a child task was canceled). A failed AI run pauses the task with that reason
  (`manual` if a person had paused it). There is no mechanism to resume automatically after a while.
- Pausing by a person: a task cannot be paused while waiting for approval, in Escalation, waiting for child tasks, or while the Goal Guardian is judging. If it is running, the container, tests,
  and service startup are stopped before recording. If any container cannot be confirmed as stopped, the task does not resume until that is confirmed.
- Resume: if the status before the pause was waiting to run, the stopped step is run again.
- Cancel: a task cannot be canceled while the Goal Guardian is judging. Cleanup proceeds in the following order, and the result (`done`, `skipped`, `failed`) for each target (`container`, `workspace`, `session`, `branch`,
  `pull_request`) is recorded in `TaskCancelled`.
  1. Stop runs answering questions and running containers.
  2. Delete the Orchestrator session.
  3. Close the implementation PR sacty opened and the open requirements and design PRs (without merging).
  4. Delete sacty's branches (the implementation PR's branch, the task branch, and step branches).
  5. Delete the workspace (not deleted if the containers cannot be confirmed as stopped).
  Session logs (`runs/`) are not deleted. Canceling a parent also cancels its unfinished child tasks.

Code: `apps/daemon/src/service.ts` (`warnIfNeeded`, `checkBudget`, `pause`, `resume`, `cancel`, `cleanupPlan`, `sactyBranches`, `stopReason`), `packages/core/src/events.ts` (`PauseReason`, `CleanupTarget`, `ResumeTaskInput`), `packages/core/src/cost.ts` (`budgetState`)

## Asking the Orchestrator

- Questions are up to 2000 characters (`QUESTION_MAX`), and answers up to 20000 characters (`ANSWER_MAX`; truncated if longer). At most one question can be awaiting an answer.
  Questions cannot be asked on canceled tasks or tasks that reached the budget cap. IDs are `Q-<number>`.
- The AI is the same as the Orchestrator; it reads a copy of the code at the base and answers by duplicating the saved Orchestrator session (the original session
  is not changed). The instructions include the task's title, status, steps, PR, cost and budget, body, approved results and latest outputs, verdicts, comments, recent questions and answers,
  and the Activity (as much as fits in 40000 characters in total).
- Session logs of each run: before the answering run, this task's per-run session logs (`SACTY_HOME/runs/<task ID>/` in [Agent execution](agent-execution.en.md))
  are laid out in a per-answer-run location (`<workspaces>/_question-logs/<run ID>/`) and mounted read-only at the container's
  `/sacty-logs` (Claude Code is also given `--add-dir /sacty-logs`). They are deleted when the answering run finishes.
  - What is laid out: `index.json` (the list of runs) and, for each finished run, `<run ID>/meta.json`, `events.jsonl`, and `stderr.log` (only those that exist),
    and the agent's original files recorded in the Activity's `AgentSessionArchived` (`<run ID>/agent/<relative path>`; files whose size differs from the record or that are not regular
    files are not laid out). Every run that goes through execute is covered: steps, the Orchestrator, the Goal Guardian, answers to earlier questions, and so on.
    Hard links are used on the same file system; otherwise the files are copied.
  - What is not laid out: other tasks' logs (only this task's location is looked at), files other than the above, the answering run itself, and runs whose end is not recorded
    (no `finishedAt` in `meta.json`; still running, or the daemon stopped. Secrets found after writing started are redacted again when the file is closed, so
    a file not yet closed may still contain them).
  - Status in the list: `available` (readable), `unfinished` (end not recorded), `missing` (the Activity has the run's ID but there is no log),
    `unreadable` (`meta.json` cannot be read). It also holds logs with the middle omitted due to limits, the number of agent files, reasons for not copying, and files that could not be laid out.
  - The instructions include, before the ledger, the location and how to read it (search rather than read everything; it cannot be modified; state which run of which step; say so if any run
    has no log, was omitted, or is unreadable), and the list of runs (the step or role name and which attempt, the run ID, the agent, start and end, the result, the log size, truncation;
    up to 8000 characters; if it does not fit, older runs are omitted and the agent is told to read `index.json`). The logs' contents are not included.
  - If the task's log location (`runs/<task ID>/`) does not exist, there are no runs yet (runs in the Activity are `missing`). If the location cannot be opened
    (no permission, not a directory, and so on, other than ENOENT), cannot be laid out, or no logs were kept, nothing is mounted; the instructions say the logs cannot be read and
    why (the kind of error, for example `ENOTDIR`), and the agent answers from the ledger (a warning goes to the daemon's log).
- Asking a question does not change the status, steps, or approved content, and does not stop a running task. The cost of answering (even when no answer could be given) counts toward the task's budget.

Code: `apps/daemon/src/service.ts` (`askQuestion`, `answerQuestion`, `stageQuestionLogs`), `apps/daemon/src/question-logs.ts` (`stageQuestionLogs`, `CONTAINER_LOGS_DIR`), `apps/daemon/src/prompts.ts` (`buildChatPrompt`, `CHAT_PROMPT_MAX`, `CHAT_LOGS_IN_PROMPT`), `packages/core/src/events.ts` (`QUESTION_MAX`, `ANSWER_MAX`), `packages/core/src/projection.ts` (`questionBlocked`)

## PR-review-only tasks

- The only step is `review`. Before running, the head of the target PR and the base commit are recorded (`ReviewTargetResolved`). The code at the PR's head commit and
  the whole diff (mounted read-only at `/sacty-review`; the first 100000 characters in the instructions) are passed.
- The agent is asked to add an assessment of whether there are comments to fix before merging (`changesRequested` in `sacty-review-verdict`). The assessment block is
  removed from the posted body and kept in `reviewChangesRequested` of `AgentRunCompleted` (per round in `reviewVerdicts`). If there are line comments
  (line comments and those moved into the body), it is set to `true` regardless of the assessment. If there is no assessment or it is not a boolean, nothing is kept (unreadable).
  It is used only to decide whether to deliver a review of a PR sacty opened to the original task ([Approval and request changes](approval.en.md#importing-pr-comments)).
- The result is posted to the PR as a review (`COMMENT`) without waiting for a person's approval. If line comments are rejected with 422, they are put into the body and posted again.
  The task completes once posted.
- Re-review: a task that completed after posting can put `review` back to waiting to run and review the latest commit again (`ReviewRestarted`).
- In the PR check (every 60 seconds), if the PR of an unfinished review task has been merged or closed, the task is canceled.

Code: `apps/daemon/src/service.ts` (`reviewOnlySteps`, `resolveReviewTarget`, `postReview`, `rereview`, `checkReviewPullRequests`), `apps/daemon/src/prompts.ts` (`PR_DIFF_IN_PROMPT`, `extractReviewComments`)
