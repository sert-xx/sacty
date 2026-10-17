[日本語](tasks-and-steps.md) | **English**

# Tasks and steps

A task proceeds as a sequence of steps (Investigation, Requirements, Design, Implementation, and so on). Which combination of steps (plan) to use is
chosen by the Orchestrator when the task starts. Agents run the steps, and people decide only at approval steps (approval gates). The Goal Guardian
judges change requests, the final review, where to send PR comments back to, and Integration review.

Approval and Request changes are in [Approval and request changes](approval.en.md); Task split and Integration review are in [Task split and integration review](split-and-integrate.en.md).

Related ADRs: [Remove the "PR作成" step and open the PR and wait for approval inside the Implementation step](../adr/20261015-1430-implement-step-opens-pull-request.md), [Set up the agent configuration for handling a repository with sacty through the "Sacty setup" task template](../adr/20261014-1530-task-template-sacty-setup.md), [In a repository without tests, skip the tests and let the Goal Guardian judge acceptance from the task's goal](../adr/20261015-0000-verify-without-test-command.md)

## How tasks are created

`start` in `TaskCreated` records where the task came from.

| `start` | How it was created |
| --- | --- |
| `sacty` | Created in the web UI (the older `ticket` is also read as `sacty`) |
| `github_issue`, `github_pull_request` | Intake of a GitHub Issue or PR ([Ticket intake](intake.en.md)) |
| `jira` | Intake of a JIRA ticket |
| `deployment` | A task to fix a failure found by the after-merge watch (`fix` holds the original task, the kind, the marker, and the level. [After-merge watch](deployment-watch.en.md)) |
| `split` | A child task of Task split (`parent` holds the parent's ID and the child tasks that must finish first, `dependsOn`) |

- A PR-review-only task has `source.review` (`requested` or `label`; `sacty` if it is a PR that sacty created and gave the review label).
- When creating a task in the web UI, if no repository is specified (`repo: null`), or the repository is omitted and the project's targets are not exactly one repository,
  the task becomes a task without a repository (`noRepo`). It cannot be created in a project with no targets (`task.repositoryMissing`).
- The "Create task" button in the web UI reads only the list's project (the ID in the URL) before it appears (it does not appear for a project that does not exist). The repository suggestions (the daemon's
  `GET /api/projects/:id/repositories`; org targets are read with `gh`) are read when the create dialog opens, through the web route
  `GET /projects/:id/repositories` (read again on every open; a late result from an earlier open is dropped). Rendering the task list and its
  automatic refresh do not read them. The dialog shows that the suggestions are loading, could not be read, or are empty, and in every state the
  repository can be typed and the task created. For an org that could not be read, it shows the reason. Projects without targets do not read them.
- The initial budget cap is `budget.default_per_task_usd` (default 1 US dollar).
- The status values are in the "Projection" table of [Activity log](event-log.en.md). There is no "completed" status; a task is complete when every step is `done` or `skip` (`isCompleted`).

Code: `packages/core/src/events.ts` (`TaskCreated`, `TaskSource`), `packages/core/src/projection.ts` (`isCompleted`, `isRepoless`), `apps/daemon/src/service.ts` (`createTask`), `apps/web/src/components/new-task.tsx` (`NewTask`, `NewTaskPlaceholder`), `apps/web/src/components/new-task-dialog.tsx` (`NewTaskDialog`, `CandidatesStatus`), `apps/web/src/lib/repository-candidates.ts` (`candidatesLoader`, `fetchRepositoryCandidates`), `apps/web/src/app/projects/[id]/repositories/route.ts` (`GET`)

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
  2. How to run tests (the command and prerequisites; whether they match the current configuration). If the repository has no tests yet, the agent writes that there are none and how to check changes,
     and does not add a new language or test framework (that is a separate task)
  3. Services needed for tests (how to start them and where to connect; if none are needed, say so)
  4. For repositories with CI/CD (even if they do not deploy), the after-merge watch skill `deployment-observer`. If there is no CI/CD, it is not created
     (the after-merge watch step is skipped). The original goes in `.agents/skills/deployment-observer/SKILL.md`, and `.claude/skills/deployment-observer` is
     a relative symbolic link to `../../.agents/skills/deployment-observer`. It has the agent write the front matter (`name`, `description`) and a reference on how to check
     CI/CD (`references/ci.md`: which workflows and checks verify what, failures that can be ignored, and how to read results and logs).
     If the repository deploys, the agent writes how to tell that a deployment finished, how to check it, how to connect, and what counts as an error; if it does not deploy, that the deployment check
     is skipped (`skipped` with a reason). It also writes the promises not to change anything, not to reveal secrets, not to wait long, and to answer `unknown` when it cannot judge, and the shape of
     the JSON answer under the heading `sacty-deployment` (the results of the CI/CD check and the deployment check). The location, link target, reference, and heading are built from
     the after-merge watch's `DEPLOYMENT_SKILL_PATHS`, `CI_REFERENCE`, and `DEPLOYMENT_HEADING` ([After-merge watch](deployment-watch.en.md)).
- The goal also says that if everything is in place and no change is needed, the task ends with Investigation only, without a PR, and leaves the check result for each item (if the Orchestrator
  chooses `investigate`, the task completes when the investigation result is approved in the web UI). If it turns out after the steps have run that no change is needed, the agent is asked to
  leave the files unchanged and write the check results and reasons in the implementation notes (no PR is opened; a person checks it and the task completes without changes. [Approval and request changes](approval.en.md#when-the-implementation-has-no-changes)).

Code: `packages/core/src/events.ts` (`TaskTemplate`, `CreateTemplateTaskInput`, `TaskCreated`), `apps/daemon/src/service.ts` (`createTask`, `createTemplateTask`, `projectRepository`), `apps/daemon/src/task-templates.ts` (`templateTask`), `apps/daemon/src/deployment.ts` (`DEPLOYMENT_SKILL_PATHS`, `CI_REFERENCE`, `DEPLOYMENT_HEADING`)

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
| `implement` | Implementation | Implements. After it passes verification, sacty opens the implementation PR and waits for a person's approval (merging the PR) |
| `deployment` | After-merge watch | After the implementation PR is merged, waits for CI/CD, checks as the skill says, and registers a fix task on failure (no human approval. [After-merge watch](deployment-watch.en.md)) |
| `document` | Document | Creates or edits a Markdown draft and waits for approval in the web UI |
| `operation` | Operation | Performs the requested external change once and submits evidence for result approval |

Step categories:

- Steps with an approval gate (`GATED_STEPS`): `investigate`, `requirements`, `design`, `integrate`, `implement`, `document`, `operation`. However, Investigation at the start of a plan that implements
  (preliminary investigation) moves on to the next step without approval (`StepCompleted`). Only Investigation in a task whose purpose is investigation (the last step is `investigate`) is approved.
  Implementation does not wait for approval as soon as the agent's run ends; it waits for approval only after it passes verification ("Verifying the implementation" below) and the implementation PR is opened.
- Steps that can be redone through Request changes (`REWORK_STEPS`): `investigate`, `reproduce`, `requirements`, `design`, `implement`, `document`.
- Steps that need a repository (`REPO_STEPS`): `implement`, `reproduce`, `review`.
- Steps that can use docker compose services (`SERVICE_STEPS`): `investigate` (only for bug investigation), `reproduce`, `implement`.
- Steps that can be exported (`EXPORT_STEPS`): `investigate` (only when it is the last step), `requirements`, `design`, `document`.
- Steps that are not run (not in `EXECUTABLE_STEPS`): `deployment`. After the previous step is approved, the task becomes idle and sacty advances it in the PR check. If the target repository
  has no skill, the step is skipped when the steps are chosen (`skip`. [After-merge watch](deployment-watch.en.md)). When moving to the next step, `skip` steps are passed over.

Code: `packages/core/src/events.ts` (`StepKey`, `GATED_STEPS`, `REWORK_STEPS`, `EXPORT_STEPS`, `exportSteps`), `packages/core/src/projection.ts` (`investigationIsGoal`), `apps/daemon/src/service.ts` (`REPO_STEPS`, `submitEvents`), `apps/daemon/src/prompts.ts` (`SERVICE_STEPS`)

### Self-review before submitting

- The instructions of the Requirements, Design, and Implementation steps (`SELF_REVIEW_STEPS`; Implementation includes bug fixes and tasks without tests) tell the agent to
  self-review with the `self-review` flow of the default skill `review-dispatch` before submitting, and to repeat fixing and re-reviewing until no `must` findings are left (it passes)
  (`selfReviewLines`). The target kind is `design-doc` for Requirements and Design (the draft is written to a temporary file outside the workspace and reviewed) and `code` for Implementation.
  The round limit follows the skill (up to 5 including the first); if `must` findings are still left at the limit, the agent reports them and submits. Redoing after requested changes or
  PR comments runs with the same instructions.
- The agent reports the result as JSON under the heading `sacty-self-review` (`rounds`, `passed`, `remaining`, `notReviewed`, `summary`). sacty reads only the last one (`extractBlocks`)
  and removes every report from the deliverable. A report is found as an object whose first key is the heading, even when it is not valid JSON (`headingSpans`). When the last
  report cannot be read, sacty does not fall back to an earlier one. The agent does not write the "self-review" section the skill puts at the end of the description.
- `rounds` is 1 to 5, and `passed: true` is allowed only when `remaining` is empty. A report that does not match is treated as a wrong shape (`SelfReview`).
- The report is recorded in `selfReview` of `AgentRunCompleted`. When there is no report, or it cannot be read or its shape is wrong, it is `null` (no record). The step does not stop.
  The projection keeps the report of the latest submission per step in `selfReviews` (absent for steps that do not self-review and for earlier records). When the text is replaced
  outside a step run (applying a change proposal, or a merge after a person edited the document in the PR), the earlier report did not see the new text, so it becomes no record.
- The screen shows passed (rounds), not passed (rounds and the number of findings left), or no record on the deliverable cards (not on approved deliverables), the Implementation card,
  and the approval screen. Not passed and no record use the warning color, and when it did not pass, the findings left and the viewpoints not reviewed are shown open.
  The "finished" line of the Activity also shows it.

Code: `apps/daemon/src/prompts.ts` (`selfReviewLines`, `SELF_REVIEW_HEADING`, `extractBlocks`), `packages/core/src/events.ts` (`SelfReview`, `SELF_REVIEW_STEPS`), `packages/core/src/projection.ts`, `apps/web/src/components/self-review.tsx` (`SelfReviewNote`)

## Plans

| `plan` | Steps |
| --- | --- |
| `standard` | `investigate` → `requirements` → `design` → `implement` → `deployment` |
| `skip-design` | `investigate` → `requirements` → `implement` → `deployment` |
| `investigate` | `investigate` (investigation only) |
| `design-only` | `requirements` → `design` (design only) |
| `review` | `review` (review only) |
| `split` | `investigate` → `requirements` → `design` → `split` → `integrate` |
| `bugfix` | `investigate` → `reproduce` → `implement` → `deployment` |
| `document` | `document` |
| `operation` | `operation` |

Restrictions on which plans can be chosen (`allowedPlans`): `review` only when there is a repository and the task points to a PR. `design-only` only for tasks
without a repository. `document` and `operation` are also restricted to tasks without a repository. `split` cannot be chosen by child tasks (splitting is one level only).

Code: `packages/core/src/events.ts` (`STEP_PLANS`), `apps/daemon/src/prompts.ts` (`allowedPlans`, `REPO_PLANS`)

## Non-development work and plan selection

The Orchestrator compares the purpose, deliverable, change target, and scope rather than recommending `standard` unconditionally. Questions and cause analysis use `investigate`, existing PR reviews use `review`, overall design uses `design-only`, and drafts use `document`. Repository file changes, including documentation, use `skip-design` for local changes, `standard` for broader design decisions, or `split` for work spanning multiple PRs. Reproducible bugs use `bugfix`; bugs requiring design decisions use `standard`.

- `document` produces a Markdown draft without enforcing the Requirements or Design format. A person can request changes and approve it in the web UI. Before approval, it receives no MCP/PF access or project context and does not read external drafts. Source text and rules must come from the task body or human feedback through Request changes. Optional export follows the existing export mechanism; an export failure does not stop task completion. Direct updates to existing external documents use `operation`.
- `operation` is a single step. The existing Orchestrator selects one destination, a unique target ID or URL, the requested change and its preconditions, and how to verify it. This does not add a preparation agent, proposal deliverable, or pre-execution approval gate. If the target or connection is missing, the task stops before execution starts.
- The task details display the selected operation settings (`name`, `via`, `target`, `change`, `verification`) as read-only information. They are execution settings selected by the Orchestrator, not a new deliverable or approval gate.
- The operation receives only the selected destination and performs the request. Its prompt requires checking the target and preconditions, sending one write request without retrying, and reading back the result. A successful result with evidence waits for human approval. Failure, interruption, restart, or an unknown result stops execution; the persisted start record rejects Resume and keeps the task paused. After execution starts, Request changes is unavailable. A person checks external state, cancels the task, and creates a new task for any remaining work.
- This is not an external exactly-once guarantee: one write and read-back verification are agent instructions. It does not add recurring work, monitoring, arbitrary integrations, or orchestration across several destinations. Separate mixed deliverables into tasks with explicit approval boundaries.

Code: `apps/daemon/src/prompts.ts`, `apps/daemon/src/service.ts`, `packages/core/src/events.ts`, `packages/core/src/projection.ts`, `apps/web/src/components/task-detail.tsx`

## Orchestrator

It runs once before the steps are chosen (when the task starts). The AI is `step_agents.orchestrator` (or `default_agent` if absent); it uses the default image and
reads a disposable copy of the code at the base commit. Its cost counts toward the task's budget. If the budget cap has been reached, the task is paused without running it.

The following are read from the answer (JSON under the heading `sacty-steps`) and recorded in `StepsChosen`.

| Item | Meaning and handling |
| --- | --- |
| `plan`, `reason` | The plan and the reason |
| `baseBranch` | The base branch. If it differs from the default branch, the workspace is prepared again on that branch (if it cannot be prepared, the task continues on the default branch and the reason is replaced) |
| `testCommand` | The test command (run with `sh -c`; exit code 0 passes; 1 to 1000 characters). If there is an Implementation step but no command and `noTests` below cannot be used either, the task is paused (`orchestrator.testCommandUnknown`) |
| `noTests` | Read only when `testCommand` is empty: the basis for judging that the repository has no tests (1 to 2000 characters). It is recorded in `noTestsReason` of `StepsChosen` ("Tasks without tests" below) |
| `investigation` | The kind of investigation (`content`: investigating content, `bug`: investigating a bug) |
| `images`, `imageReason` | The image per step. If the project's target specifies an image, it is used for all steps without asking. A name not in `images` stops the task |
| `defaultReasons` | For each step that uses the default image (`default`), why none of `images` fits ("Step images" below) |
| `services`, `servicesReason` | The compose files, services, and steps to start ([Services](services.en.md)). Shared compose files are chosen by name (an unknown name stops the task) |
| `exports` | The export destination and reason per step ([Export](export.en.md)) |
| `operation` | Execution settings for a one-off operation (`via`, `name`, `target`, `change`, `verification`). Part of step selection, not a separate deliverable. If the target is unknown, this is omitted and execution stops before starting. |
| `documentsDir` | The directory for the requirements and design files ([Approval and request changes](approval.en.md)) |
| `repo`, `repoReason` | For a task without a repository that chose a plan needing one, the repository to work in |

- Step images (when `images` is configured and the project's target does not specify an image):
  - The prompt asks for an image from `images` for every step in the chosen plan. The default image is not listed as a candidate; it is described as
    the last resort when none of `images` fits (only Node.js and git to run Claude Code and Codex, with no test browsers, DB clients, or tools for other languages),
    and for a step that uses it, the reason goes in `defaultReasons`. The image that runs the tests (Implementation, and Reproduce for bug fixes) is to be chosen from
    `testCommand` and the repository's dependencies (browser tests, DB clients, and so on).
  - For each step that runs in the default image (a chosen step whose image is absent or `default`), the reason is recorded in
    `defaultImageReasons` of `StepsChosen`; a step without a reason (no image written, or `default` without a reason) is recorded in `imagesUnexplained`.
    The task does not stop; it proceeds in the default image, and the Activity (the task page) shows that there is no reason.
  - Neither is recorded when `images` is not configured, when the project's target specifies an image, for a task that proceeds without a repository, or for a PR-review-only task.
- When a task without a repository chooses steps that need a repository, `repo` is checked against the project's targets, `RepositoryChosen` is recorded,
  and the repository is prepared before asking to choose again. If it is not in the targets or is empty, the task stops, and a person can pick a repository in the web UI to resume (only while paused and
  waiting for a repository). If the plan does not need a repository, `testCommand`, `baseBranch`, `services`, and `documentsDir` are discarded.
- When the run fails or the answer cannot be read, `OrchestratorFailed` is recorded and the task is paused (it does not fall back to the standard plan).
- For a task taken in from a ticket, before choosing steps the Orchestrator reads the ticket and decides the repository, title, and summary (`TicketTriaged`).
- A PR-review-only task uses the `review` plan without the Orchestrator (`reviewOnlySteps`).
- Reuse of Orchestrator sessions is described in "Saving and reusing sessions" in [Agent execution](agent-execution.en.md).

Code: `apps/daemon/src/service.ts` (`askOrchestrator`, `runNextInner`, `withImages`, `defaultImagesOf`, `withSharedCompose`, `withExports`, `repositoryFromPlan`, `chooseRepository`, `triageTicket`, `reviewOnlySteps`), `apps/daemon/src/prompts.ts` (`extractStepPlan`), `packages/core/src/events.ts` (`StepsChosen`)

## Changing a step's image

- On the task detail, a person can change the image of each step (`POST /api/tasks/:id/images`, input `step` and `image` of `ChangeStepImageInput`).
  The step's state does not matter (a step yet to run, running, failed or paused, awaiting approval, or done). A cancelled task cannot be changed.
- The choices are the names in `images` and `default` (the default image). The screen shows each description (`description` in `images`). These are
  refused with the reason (409): a name not in `images` (including a name removed from config.yaml; `image.notInImages`), the current name
  (`image.unchanged`), and a step the task doesn't have (`image.stepMissing`). Every step can be changed. When config.yaml can't be read or parsed, the names can't be checked, so the change is refused with the settings problem as the
  reason (`image.configUnavailable`; `default` too). When the daemon's status can't be fetched or the settings can't be read, the screen says the choices
  can't be checked and shows neither the warning that a name is not in `images` nor the change form (`stepImageOptions`; a temporary failure is not mistaken for a removed name).
- A change appends `StepImageChanged` (`step`, `from`, `to`; the actor is `person`). `from` is the name before the change (`default` if none was set).
  The projection sets the step's `images` to `to` and keeps the last change of each step in `imageChanges` (`from`, `to`, time). `StepsChosen` is not rewritten.
- The changed image is used from the next run of the step (starting a step that hasn't started, a retry, or a rerun after rework). The current run is not stopped.
  A step run fixes its image when `AgentRunStarted` is appended (a change while the run is being prepared does not change that run). The integration review works the same way.
- Test runs also use the image at the time the tests start (the test image in "Verifying the implementation" below). If the Implementation image is
  changed while the Implementation step runs, the tests after that run use the changed image.
- Tasks whose project target specifies an image can be changed too. The person's change takes precedence for that step only (other steps keep the target's image).
  Changing the target's image does not change the images of a task whose steps are already chosen.
- The screen shows, for each step, the image, where it came from (the time a person changed it and the previous name, the project target, the Orchestrator,
  or not set) and when a change takes effect (from the next run while running; from a retry or rework for a done step) (`stepImageRows`).
  Running means the agent run, the implementation verification, and the reproduction check (`stepRunning`). The Activity shows who changed which step, when, and from what to what.
- For a step the Orchestrator left on the default image, where it came from shows the reason for the default image (`defaultImageReasons`) or that no reason was
  given (`imagesUnexplained`) until a person changes it. After a person changes it, the person's change is shown. The "Steps chosen" line in the Activity stays as recorded
  when the steps were chosen (the later `StepImageChanged` line shows the change).

Code: `apps/daemon/src/service.ts` (`changeStepImage`, `runNextInner`, `integrate`), `apps/daemon/src/server.ts`, `packages/core/src/events.ts` (`StepImageChanged`, `ChangeStepImageInput`), `packages/core/src/projection.ts` (`stepRunning`), `apps/web/src/lib/labels.ts` (`stepImageRows`, `stepImageOptions`)

## Tasks from the version with the "PR作成" step

Earlier versions had a "PR作成" (open PR) step (`pr`) after Implementation. That step was removed, with no compatibility layer. Its records can't be read as a step name,
so at daemon startup, before the Activity is read, tasks with those records are deleted from the Activity (`purgeLegacyPrStepTasks`).

- Deleted tasks: tasks whose plan (`steps` in `StepsChosen`) contains `pr`, and tasks with a record that points to the `pr` step (`step` or `target` is `pr`).
  Tasks in progress (queued, waiting for approval, paused, and so on) are deleted too.
- Tasks deleted together: the parent and children of a task split (if either is deleted, the parent and all children), and a fix task from the watch after merge and its original task (if either
  is deleted, both). The links are followed through `parent` and `fix` of each `TaskCreated` (in both directions, repeatedly).
- Before deleting, the settings (`config.yaml`) are read and checked (`purgeLegacyTasksAtStartup`). If they have an error, nothing is deleted; the number of tasks and the settings error
  are written to the log and the daemon stops starting up (the old records can't be read). Fix the settings and start again to delete them. If there is nothing to delete, the settings are not read.
- The number of deleted tasks and their IDs are written to the daemon log. If there is nothing to delete, nothing is done.
- The Activity is append-only (a trigger rejects deletes), so the trigger is dropped only while deleting, inside the same transaction, and recreated afterwards.
- Not deleted: workspaces, session logs, Orchestrator sessions, and GitHub branches and PRs (open PRs stay open).
- `step_agents.pr` in `config.yaml` is a settings error. Instead of an unknown-step error, the message asks you to delete `pr` from `step_agents` (`config.stepAgentsPrRemoved`).

Code: `apps/daemon/src/activity.ts` (`purgeLegacyPrStepTasks`, `purgeLegacyTasksAtStartup`), `apps/daemon/src/main.ts`, `apps/daemon/src/config.ts` (`loadConfig`)

## Verifying the implementation

- When the Implementation step finishes, the task waits for verification (`verification = "pending"`), and the test command is run in a test container. It passes when the exit code is 0 and
  every verification viewpoint corresponds to a test. The viewpoints are the design's test viewpoints if there is a design, `REPRO` if there is a reproduction, and otherwise `REQ`.
- After the tests pass, the task moves to the Goal Guardian's final review. The final review reads the code after implementation and the diff, judges each viewpoint and each comment,
  and passes only when all are met. If it passes, the task stays in the Implementation step, and sacty opens the implementation PR and the task waits for the Implement approval ("The PR for a verified implementation" below).
- If the tests or the final review do not pass, the implementation is redone. If they fail `MAX_VERIFY_ATTEMPTS` (3) times in a row, the task is paused (`verification`).
  Resuming resets the count.
- After the Reproduce step, the reproduction test is run; if the exit code is not 0, the bug is treated as reproduced and the task moves to Implementation. If it is 0 (or no reproduction test
  was declared), the bug is treated as not reproduced and the task waits for a person's decision (the Reproduce step cannot be approved; request changes or cancel).
- The test image is the Implementation step's image (or Reproduce's if absent) for verification, and the Reproduce step's image (or Implementation's if absent) for checking reproduction.
- The implementation deliverable (the task screen and the Implement approval screen) shows the test results and the final review in the correspondence table only for the
  current submission's verification (`verificationResults`). Test results and final reviews after the verification of a redone implementation has started (`verification` is `pending`), and final
  reviews older than the latest test result (or, if tests were skipped, the time they were skipped), are treated as the previous submission's: they are shown under the headings "Test run for the
  previous submission" and "Final review of the previous submission" (that nothing has run or been judged for the current submission yet is shown in the hint (tooltip) next to the heading), and the result in the correspondence table is
  "Not run". For a task without tests, a viewpoint without tests is shown as "Judged by the goal" only when there is a final review of the current submission; while waiting for
  verification (before the judgment by the goal), it is "Not run" (`judgedByGoalForCurrent`).

### The PR for a verified implementation

- When the final review passes, the Implementation step is not finished; the task waits to open the PR (`Task.publishPending`; the status is queued). sacty then
  commits and pushes the implementation workspace and opens the PR ([Approval and request changes](approval.en.md#approval-through-prs)). No agent is used.
- After opening the PR, sacty records `PullRequestPublished` and the implementation submission (`StepSubmitted`, with `step` set to `implement`) in the same append, and the task waits for the Implement approval.
  If the implementation changed nothing, sacty records `NoChangesFound` and the implementation submission without opening a PR ([Approval and request changes](approval.en.md#when-the-implementation-has-no-changes)).
- If opening the PR fails, the reason is recorded and the task stops (`pr.failed` and so on). Resuming opens the PR again without redoing the implementation (waiting to open the PR
  survives a pause and a restart).
- The PR is opened even when the budget cap has been reached (it costs nothing and only waits for a person's approval; see "Budget, pause, resume, and cancel" below).
- Pausing by a person: if a pause or cancel has been requested before the push or right before opening the PR, the task stops without opening the PR (for a pause, it keeps waiting to open the PR;
  resuming opens it). If the request comes after opening the PR has started, the PR is finished and recorded first (stopping without recording the opened PR could open a second PR on resume,
  or leave a PR that cancelling can't close), and then the final state depends on the request.
  - Pause: the task stays waiting for the Implement approval and is not paused. The pause operation reports that the task was not paused because it is waiting for approval (`pause.reachedApproval`; 409).
  - Cancel: after opening the PR finishes, the recorded PR is closed and the task is cancelled (the cleanup in "Budget, pause, resume, and cancel" below).
- Waiting for approval (approval by merging the PR, Request changes, and importing PR comments) works the same as for Requirements and Design ([Approval and request changes](approval.en.md)).
  Approving the implementation by merging the PR moves on to the after-merge watch step (if it is skipped, the task is completed).

Code: `apps/daemon/src/service.ts` (`runNextInner`, `publish`, `implementSubmitted`, `submitEvents`, `pause`), `packages/core/src/projection.ts` (`publishPending`, `gatePullRequest`)

Code: `apps/daemon/src/service.ts` (`verify`, `checkReproduction`, `pauseIfVerificationKeepsFailing`), `apps/daemon/src/prompts.ts` (`verificationBasis`), `packages/core/src/events.ts` (`MAX_VERIFY_ATTEMPTS`), `apps/web/src/components/implementation.tsx`, `apps/web/src/lib/labels.ts` (`verificationResults`, `judgedByGoalForCurrent`)

### Tasks without tests

A task for which the Orchestrator left `testCommand` empty and wrote a basis in `noTests` (`Task.noTestsReason`) proceeds without stopping even though there is no
test command, and acceptance is judged from the task's goal instead of by tests.

- Conditions for treating a task as one without tests (`checkNoTests`; checked right after the steps are chosen, when the plan includes Implementation):
  - If there is a `testCommand`, `noTests` is discarded (the behavior with a test command does not change). If there is no `noTests` and `testCommand` is also empty,
    the task stops as before (`orchestrator.testCommandUnknown`).
  - If a bug fix (`bugfix`) is chosen, the task stops (`orchestrator.bugfixNeedsTests`). A reproduction is confirmed by tests, so it is not chosen for a task without
    tests (the instructions to the Orchestrator also ask it not to choose it).
  - If the base code of the target repository (the workspace, excluding `.git`) has a file that matches the naming conventions of test files, the task stops
    (`orchestrator.noTestsContradicted`; up to 5 found files are shown). Matches are files inside `test`, `tests`, and `__tests__`
    directories, and files whose name without the extension is `test`, `tests`, `test_*`, `test-*`, `*_test`, `*-test`, `*.test`, `*_spec`, `*.spec`
    (and plurals), `*Test`, `*Tests`, or `Test*` (camel case) (`looksLikeTestFile`). Document files (extensions `md`,
    `markdown`, `txt`, `rst`, `adoc`, `asciidoc`, `org`) do not match, even inside test directories.
  - The task also stops when the scan does not finish after 20,000 entries (`TEST_FILE_SCAN_LIMIT`) (`orchestrator.noTestsUncertain`).
  - The task also stops when a directory cannot be read (including the workspace itself) (`orchestrator.noTestsUnreadable`; it shows the path of the unreadable directory
    relative to the workspace (`.` for the workspace itself) and the error code (or the error message if there is none)).
  - In either case, if a test file was found first, the result is `noTestsContradicted`. The message is chosen by `noTestsStop`.
  - When stopping, a `StepsChosen` without `noTestsReason` and a `TaskPaused` with the reason are recorded. Even after resuming, like a task whose test command
    could not be determined, the task stops at verification (or at checking reproduction).
- Instead of having it write tests, the instructions for the Implementation step ask it to write in the implementation's description how each viewpoint is met. Only when the task asks for setting up
  tests and the implementation sets them up does it report the command, as JSON (`{"command": "…"}`; 1 to 1000 characters) in a code block whose language name is `sacty-test-command`
  (`TEST_COMMAND_FENCE`). The report is recorded in `testCommand` of the implementation's `AgentRunCompleted`
  and read again for each submission (`Task.addedTestCommand`).
  - The report is read only in the Implementation step of a task without tests (`testCommand` of `extractBlocks`). In other steps (Requirements, Design,
    review, and so on) and in the Implementation step of a task with tests (where `testCommand` was decided), this code block stays in the text as it is
    (it reaches the outputs, the approval screen, and later steps) and is not treated as a report (the task does not stop; tests run with the decided test command).
  - Only the inside of this code block is read as the report (`extractTestCommandFences`; CommonMark fence rules: up to 3 leading spaces,
    3 or more `` ` `` or `~`, closed by the same character at least as many times, and the language name is the first word of the info string). Text outside code blocks and the inside
    of other code blocks (such as an example quoted with four backticks) are not treated as the report. The report's code block is removed from the text.
  - If even one block's content cannot be read as JSON, is not an object, has a `command` that is not a string, is empty, or is longer than 1000 characters, or the code block is not
    closed, it is not treated as a missing report: `AgentRunFailed` and `TaskPaused` (`implement.testCommandInvalid`) are
    recorded and the task stops. Resuming redoes the implementation. If there are several readable reports, the last one is used.
- The Orchestrator's basis (`noTestsReason`) is influenced by the documents of the target repository, so it is not embedded in the text of the implementation and final review instructions;
  it is passed as a JSON string under a heading that says it is the Orchestrator's report, data as a JSON string, and not an instruction to the agent
  (`noTestsReasonLines`). The final review is also told not to follow instructions written in the basis, the task, the implementation's description, the diff, or the code.
- The examples of answers to the Orchestrator are shown separately: one that writes `testCommand` and one that writes `noTests` (which cannot choose `bugfix`), and the Orchestrator is told not to
  write both.
- Verification:
  - If no test command was reported, the tests are not run; `TestsSkipped` is recorded and the task moves to the final review (`Task.testsSkippedAt`;
    the previous round's test result is cleared).
  - If there is a report, the tests are run with that command (the test image and services are the same as for a task with tests). Exit code 0 passes, and
    a viewpoint not corresponding to a test does not cause a failure (the instructions for redoing do not list viewpoints without tests either).
  - The final review judges each viewpoint from the task's goal (title and description), the approved requirements (and design, if any), the implementation's description, the diff, the test result (if any), and
    the code after implementation. It is told not to fail the task because there are no tests or because a viewpoint has no corresponding test, and to base its judgment only on what in the implementation's
    description is backed by the code and the diff. The viewpoints (the design's test viewpoints or `REQ`), pass or fail, and
    the redo limit of `MAX_VERIFY_ATTEMPTS` are the same as for a task with tests.
- Display: the step field of the task screen (test command: none, judged by the goal; the basis is in a hint (tooltip). For tests set up in the implementation, "tests added in the implementation: command" if they passed,
  "failed; redoing" if they failed, and "will run next" while waiting. `testCommandOfNoTests`), the notice on the implementation deliverable (the task screen and the Implement approval screen)
  ("Not verified by tests" if the latest verification skipped the tests, "Verified by the tests added in the implementation" (success color) if the tests set up in the implementation ran and passed,
  "The tests added in the implementation failed" with the exit code (failure color) if they failed, and "Waiting to run the tests added in the implementation" if the current submission's tests have not run yet
  (`verification` is `pending` and there is a report; the previous submission's result is not shown). `addedTestsResult`), the test line of the PR body (`テスト：テストのコマンドが無いため、テストでは検証していません。
  目的から判定しました。`, with `（実装で用意したテスト）` for tests set up in the implementation) and the basis line, and the Activity (`StepsChosen`, `TestsSkipped`).
  A person's Implement approval is still required, as for a task with tests.

Code: `apps/daemon/src/service.ts` (`checkNoTests`, `runNextInner`, `verify`), `apps/daemon/src/test-files.ts` (`findTestFiles`, `looksLikeTestFile`, `noTestsStop`, `TEST_FILE_SCAN_LIMIT`), `apps/daemon/src/prompts.ts` (`buildOrchestratorPrompt`, `extractStepPlan`, `buildPrompt`, `extractBlocks`, `extractTestCommandFences`, `buildFinalReviewPrompt`, `noTestsReasonLines`, `resultTableLines`), `packages/core/src/events.ts` (`StepsChosen`, `AgentRunCompleted`, `TestsSkipped`), `packages/core/src/projection.ts` (`noTestsReason`, `addedTestCommand`, `testsSkippedAt`), `apps/web/src/components/implementation.tsx`, `apps/web/src/lib/labels.ts` (`addedTestsResult`, `testCommandOfNoTests`)

## Goal Guardian

The AI is `guardian_agent` (or `default_agent` if absent). For each run it makes a copy of the code in `workspaces/_guardian/<run ID>` and deletes it when done.

| Role | What it reads | Verdict |
| --- | --- | --- |
| Judging change requests | The code at the base | `approved`, `rejected`, `undecidable`. If it cannot read or fails, `undecidable`, which goes to a person's decision (Escalation) |
| Final review | The code after implementation and the diff (for a task without tests, also the task's goal and the implementation's description) | Pass or fail ("Verifying the implementation" above) |
| Deciding where to send PR comments back to | The code after implementation for the implementation PR; the code at the base for the Requirements and Design PRs | The step to go back to, or `undecidable` ([Approval and request changes](approval.en.md)) |
| Integration review | The latest base branch | This AI if `step_agents.integrate` is absent ([Task split and integration review](split-and-integrate.en.md)) |

Change requests: a step's agent can request a change to approved requirements or design (IDs are `CP-<number>`). If approved, the requirements
have their approval revoked and go back for re-approval, and the design replaces the approved version. If rejected, the requesting step submits its result.

Code: `apps/daemon/src/service.ts` (`judge`, `settleEvents`, `runGuardian`, `verify`, `judgeRework`), `apps/daemon/src/prompts.ts` (`extractVerdict`, `extractFinalReview`, `extractRework`)

## Budget, pause, resume, and cancel

- Budget: when spending reaches 80% of the cap (`BUDGET_WARN_RATIO`), `BudgetWarned` is recorded (once). When the cap is reached, the task is paused (`budget`) before choosing steps,
  before running a step (except opening the PR for a verified implementation), and before verification. Tasks waiting for approval are not stopped. Resuming a task stopped by the budget
  requires a new cumulative cap larger than the amount spent (up to 10000 US dollars) (`BudgetCapRaised`).
- Pause reasons (`PauseReason`): `budget`, `usage_limit` (the AI's usage limit), `auth` (an authentication error or missing secret), `error`,
  `verification`, `manual` (a person paused it), `child_cancelled` (a child task was canceled). A failed AI run pauses the task with that reason
  (`manual` if a person had paused it). There is no mechanism to resume automatically after a while.
- Pausing by a person: a task cannot be paused while waiting for approval, in Escalation, waiting for child tasks, or while the Goal Guardian is judging. If it is running, the container, tests,
  and service startup are stopped before recording. If any container cannot be confirmed as stopped, the task does not resume until that is confirmed.
- Resume: if the status before the pause was waiting to run, the stopped step is run again. Resume is rejected for an Operation that has started, keeping the task paused.
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

- The only step is `review`. Before running, the head of the target PR, the base commit, and the PR author's login are recorded (`ReviewTargetResolved`; empty if the author cannot be read).
  The code at the PR's head commit and the whole diff (mounted read-only at `/sacty-review`; the first 100000 characters in the instructions) are passed.
- sacty does the posting. The instructions tell the agent to use the default skills `review-dispatch` (with the `pr-review` flow) and `writing`, not to post by itself
  (not to write on the PR with gh or the GitHub API), and to give priority to the output format of the instructions when they conflict with the skills. sacty adds the verdict, the @ mention of the author,
  and the statement that AI posted the review, so the agent does not write them.
- Finding prefixes: `[要修正]` (must fix before merging) and `[提案]` (worth fixing). The agent adds them to findings in the body. For line comments
  (`sacty-review-comments`), the agent writes the severity (`severity`: `must` or `should`; `nit` is treated as `should`) and sacty adds the prefix at the start of the comment body
  (a prefix already at the start is replaced; with neither severity nor prefix, nothing is added). Findings with no line in the diff to attach to are written in the body without asking a person.
- Verdict: the agent adds `verdict` in `sacty-review-verdict` (`changes_required`: changes required, `suggestions`: suggestions only (OK to merge),
  `no_findings`: no findings). sacty raises it to `changes_required` if a line comment has `[要修正]`, and to `suggestions` if there are findings but the verdict is `no_findings`.
  Line comments alone do not make it `changes_required`. If there is no verdict or it is not one of the values, and there is no `[要修正]` finding,
  nothing is kept (unreadable). When the review could not be completed, the agent is told not to add a verdict. The verdict block is removed from the posted body and kept in
  `reviewVerdict` of `AgentRunCompleted` (per round in `reviewVerdicts`). A review of a PR sacty opened is delivered to the original task only for rounds with
  `changes_required` or an unreadable verdict ([Approval and request changes](approval.en.md#importing-pr-comments)).
- Posted body: the marker, the heading "sacty のレビュー", one line with the @ mention of the author and the verdict (no @ if the author is not in the form of a login; says so if the verdict is unreadable),
  the agent's body, and the fixed sentence saying that AI reviewed it, in this order.
- Right before posting, the PR's head commit is checked (not when an already posted review is found by the marker). If it differs from the reviewed commit
  (pushed in the meantime), the review is posted against the reviewed commit, and the body says which commit was reviewed and that "Re-review" reviews the latest one.
  That head is kept in `latestCommit` of `PullRequestReviewPosted`, and also in the body as a hidden marker. If it cannot be checked (including when the response has
  no head commit or an empty one), the task pauses without posting (`review.headUnknown`; resuming checks again). If sacty stopped after posting and before recording,
  the head is recorded again from the marker in the body of the posted review.
- The result is posted to the PR as a review (`COMMENT`) without waiting for a person's approval. If line comments are rejected with 422, they are put into the body and posted again.
  The task completes once posted.
- Re-review: a task that completed after posting can put `review` back to waiting to run and review the latest commit again (`ReviewRestarted`).
  The previous body, line comments, reviewed commit, and posting time are kept in `previousReview`. The instructions include the previous findings and the PR author's
  replies since the previous post (PR reviews, line comments, and regular comments by the author's login, excluding those starting with sacty's review marker; the newest 30, up to
  2000 characters each) as JSON data separate from the instructions, and the agent writes, for each previous finding, whether it confirmed the fix or it is still open. If the replies cannot be read
  (including when the author is unknown), the instructions say so and the review continues, and the reason is written to the daemon log with the task and the PR (secret values are masked).
- Language: the heading, verdict, note, and fixed sentence added by sacty, and the finding prefixes, are fixed in Japanese. The agent's body and findings follow the writing rules
  of the target repository (in the order of the skill `writing`), and Japanese when there are none.
- In the PR check (every 60 seconds), if the PR of an unfinished review task has been merged or closed, the task is canceled.

Code: `apps/daemon/src/service.ts` (`reviewOnlySteps`, `resolveReviewTarget`, `reviewReplies`, `postReview`, `rereview`, `checkReviewPullRequests`), `apps/daemon/src/prompts.ts` (`PR_DIFF_IN_PROMPT`, `extractReviewComments`, `buildReviewBody`, `MUST_TAG`, `SUGGESTION_TAG`), `packages/core/src/events.ts` (`ReviewVerdict`)
