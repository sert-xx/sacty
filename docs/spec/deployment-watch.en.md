[日本語](deployment-watch.md) | **English**

# After-merge watch (CI/CD and deployment)

The after-merge watch is a step (`deployment`) placed after Implement. When the implementation PR of a sacty task is merged, sacty waits for
CI/CD on the merge commit (GitHub Actions workflow runs and checks). If they pass, an agent checks as the target repository's skill
`deployment-observer` says. If something fails, sacty registers a fix task automatically. There is no human approval.
Whether to do it is decided by sacty for each task when the steps are chosen, by whether the target repository has the skill. How far to check is left to the skill.

Related ADR: [Make the after-merge watch a step, decide per task by whether the target repository has the skill, and leave how far to check to the skill](../adr/20261016-0633-deployment-watch-step.md), [When the implementation PR of a sacty task is merged, watch CI/CD and the deployed app, and register a fix task on failure (superseded)](../adr/20261014-1439-superseded-deployment-watch-after-merge.md)

## Whether the step is included

- The combinations that include Implement (`standard`, `skip-design`, `bugfix`) have `deployment` at the end (after Implement) (`STEP_PLANS`). The parent of a task
  split does not have it (each subtask has it in its own combination).
- After the combination is chosen and before `StepsChosen` is recorded, sacty looks for the skill in the starting commit (the commit of the re-chosen base branch, if any)
  (see "Finding the skill" below). If found, `deployment` in `StepsChosen` holds `skill` (the path). If it is missing, unusable, or cannot be looked up, it holds `skipped`
  (`deploy.stepSkipped`; the detailed reason is `deploy.noSkill`, `deploy.skillOutside`, `deploy.skillUnreadable`, or `deploy.skillLookupFailed`),
  and this step is set to `skip`. When skipped, CI/CD is not watched either.
- When skipped, the reason for the default image of this step and the lack of one (`defaultImageReasons`, `imagesUnexplained`) are not recorded.
- The Orchestrator's instructions say, in the description of the combinations, that sacty decides it only when there is a skill (the AI does not decide it).
- When the skill is added or removed after the decision:
  - Added (the implementation PR adds the skill): this task does not watch (the step stays skipped). Later tasks do.
  - Removed (the implementation PR removes the skill): the step continues. sacty watches CI/CD, and when it passes, looks for the skill again in the merge commit; if it is missing,
    it skips the check by the skill and ends with `passed` (`no_skill`).
- If the implementation is approved without merging a PR (no changes, so no PR was created), there is no merge to watch, so this step is set to `skip`.
- When moving to the next step, a `skip` step is not entered (`advance`). Going back to an earlier step keeps a `skip` step as `skip` (`reopen`).

Code: `packages/core/src/events.ts` (`STEP_PLANS`, `StepsChosen`), `apps/daemon/src/service.ts` (`runNextInner`, `deploymentChoice`, `withDeploymentChoice`), `apps/daemon/src/prompts.ts` (`planDescriptions`), `packages/core/src/projection.ts` (`applyEvent`, `advance`, `reopen`)

## How the step proceeds

- It is not an executable step (`EXECUTABLE_STEPS`), so after the implementation is approved (the PR is merged), the task is idle (`idle`) with this step active.
- When the PR check (see "The PR check" in [Approval and request changes](approval.en.md)) records the merge of the implementation PR and this step is `todo`, the same append records
  `DeploymentWatchStarted` (PR number, repository, base branch, and merge commit). The merge commit is GitHub's
  `merge_commit_sha`. If it cannot be obtained, the event has no commit and the watch is skipped (reason `no_commit`).
- Each task is watched only once (a second start is not accepted). Fix tasks are watched in the same way when they are merged.
- When the watch ends (`state` below is no longer `waiting`, and for `failed`, after deciding about a fix task), this step becomes `done` and the task
  is completed (`settleDeploymentStep`). Even on failure, the task is not stopped.
- During the watch, the task is not completed (`isCompleted` and `isFinished` are false; the dashboard and the task list show it as an unfinished task).
  The task's state shows "After-merge watch (waiting for CI/CD)" or "After-merge watch (checking with the skill)". It is not waiting for a person.

Code: `apps/daemon/src/service.ts` (`checkPullRequests`, `deploymentWatchEvents`, `nextAfterApproval`), `packages/core/src/projection.ts` (`settleDeploymentStep`, `isCompleted`, `isFinished`), `packages/core/src/events.ts` (`DeploymentWatchStarted`), `apps/web/src/lib/labels.ts` (`statusText`)

## States

Stored in the task's `deployment` (`DeploymentWatch`).

| `state` | Meaning |
| --- | --- |
| `waiting` | Waiting. If `phase` is `ci`, for the CI/CD result; if `check`, for the check by the skill (running if `check` is present) |
| `passed` | Passed (CI/CD passed and the overall result of the check is `healthy`. If the merge commit has no skill, only CI/CD passed, and `reason` is `no_skill`) |
| `failed` | Failed (CI/CD failed, or the overall result of the check is `unhealthy`) |
| `skipped` | Skipped (the reason is in `reason`) |
| `timed_out` | CI/CD did not finish in time |

`reason` (`DeploymentWatchReason`): `no_commit` (the merge commit is unknown), `no_ci` (there is no CI/CD), `no_skill` (the merge commit has
no skill), `budget` (budget limit), `check_unknown` (the check could not determine the result). The detailed reason is kept in `detail` (a message code).

Code: `packages/core/src/projection.ts` (`DeploymentWatch`, `DeploymentWatchState`, `DeploymentWatchReason`, `applyEvent`, `awaitingDeploymentCi`, `awaitingDeploymentCheck`, `deploymentCheckRunning`)

## Watching CI/CD

sacty does the waiting (the agent is not made to wait). At the end of the PR check (every 60 seconds), for each task waiting for CI/CD (except paused ones),
sacty reads the following with the project's GitHub account for that host.

| Kind (`kind`) | API | Handling |
| --- | --- | --- |
| `workflow` | `/repos/<owner>/<name>/actions/runs?head_sha=<commit>` | For the same workflow (`workflow_id`), only the newest run (`newerRun`: different runs are compared by `run_number`, `created_at`, then ID; within the same run, by `run_attempt`) |
| `check` | `/repos/<owner>/<name>/commits/<commit>/check-runs` | Those from GitHub Actions (`app.slug` is `github-actions`) are excluded (they are seen through the workflow runs) |
| `status` | `statuses` of `/repos/<owner>/<name>/commits/<commit>/status` | Anything other than `pending` is treated as finished |

The decision is made in this order. Time is counted from the time of `DeploymentWatchStarted` (neither restarting the daemon nor pausing extends it).

1. Cannot read (authentication, network, or no way to read CI/CD): nothing is recorded (the reason goes to the daemon log). If `DEPLOYMENT_CI_TIMEOUT_MS` (60 minutes)
   has passed, `timed_out`.
2. None at all: if `DEPLOYMENT_CI_GRACE_MS` (5 minutes) has passed, `none` (`skipped`, `no_ci`). Until then, keep waiting.
3. Some are not finished: if 60 minutes have passed, `timed_out`. Until then, keep waiting.
   Even when all are finished, no decision is made until the list (kind, name, URL, conclusion) is the same as in the previous check (this waits one check for
   another workflow to appear after CI, for example through `workflow_run`. The previous list is kept only in memory, so after a restart it waits one extra check.
   If 60 minutes have passed, it does not wait).
4. Some failed (`isFailedCiCheck`: the conclusion is `failure`, `timed_out`, `action_required`, or `startup_failure`; for commit statuses, `failure` or `error`.
   `cancelled`, `skipped`, `neutral`, and `stale` are not failures): `failed`. sacty reads the failed jobs of the failed workflow runs (`/actions/runs/<ID>/jobs?filter=latest`)
   and the end of each job's log (`/actions/jobs/<ID>/logs`), up to `CI_FAILURES_MAX` (5) in total. If the jobs cannot be read,
   only the workflow run is written. Failures outside workflow runs (checks from other apps, commit statuses) are also written with their name, conclusion, and URL.
   No agent is used.
5. All passed: sacty looks for the deployment check skill in the merge commit (see "Finding the skill" below) and records `passed` with `skill` if found, or with `skipCheck`
   (the reason) if not. If the commit cannot be fetched, nothing is recorded and the next check tries again (if 60 minutes have passed, it is recorded as having no skill).

The runs and checks recorded in `DeploymentCiFinished` are limited to 50, with failed and unfinished ones first.

Log excerpt (`logExcerpt`): while reading the log, sacty keeps only the last `CI_LOG_BYTES` (2,000,000 bytes) (`readTail`; the whole log is not loaded into memory.
When cut, the partial first line is dropped). It redacts secrets, removes the timestamp at the start of each line,
takes the last `CI_LOG_LINES` (80) lines, and truncates to `CI_EXCERPT_MAX` (3000) characters (keeping the end if longer). What is redacted: the GitHub
token used, and common forms of secrets (`redactLog`: GitHub, Slack, and AWS tokens, JWTs, private keys, `Authorization` values, and values of `password`, `token`, `api_key`,
and similar).

Code: `apps/daemon/src/service.ts` (`checkDeployments`, `pollDeploymentCi`, `deploymentSkill`), `apps/daemon/src/ci.ts` (`GitHubCiStatus`, `newerRun`, `readTail`, `redactLog`, `logExcerpt`, `CI_FAILURES_MAX`, `CI_LOG_LINES`, `CI_EXCERPT_MAX`), `packages/core/src/events.ts` (`DeploymentCiFinished`, `isFailedCiCheck`, `DEPLOYMENT_CI_GRACE_MS`, `DEPLOYMENT_CI_TIMEOUT_MS`)

## Finding the skill

- sacty looks for it when the steps are chosen (in the starting commit) and when CI/CD passes (in the merge commit).
- sacty looks for `.agents/skills/deployment-observer/SKILL.md`, then `.claude/skills/deployment-observer/SKILL.md`
  (`DEPLOYMENT_SKILL_PATHS`). The first usable one is used.
- Symbolic links along the path (including `SKILL.md` itself) are followed when the target is inside the repository. Links that point to an absolute path, above the repository root,
  or the root itself, and links followed more than 8 times (such as loops), are not used (reason `deploy.skillOutside`).
- A file that cannot be read (not a regular file, too large, or not text) is not used (reason `deploy.skillUnreadable`). If none is found, `deploy.skillMissing`.
- The recorded path is the resolved path (from the repository root).
- sacty does not read the files the skill refers to (such as the reference on how to check CI/CD, `references/ci.md`; the agent reads them as the skill says).

Code: `apps/daemon/src/deployment.ts` (`findDeploymentSkill`, `resolveInRepository`, `DEPLOYMENT_SKILL_PATHS`, `CI_REFERENCE`), `apps/daemon/src/repository.ts` (`readLink`, `readFile`)

## Check by the skill

- Tasks that have a skill and are waiting for the check (`awaitingDeploymentCheck`) are picked up by the worker as queued work (paused tasks are not picked up).
  The limit on concurrent runs is the same as for other runs.
- If the budget limit has been reached, the check does not run and `DeploymentWatchSkipped` (`budget`) is recorded (the task is not stopped).
- The AI is the agent a person chose in the task details ([Changing a step's agent](tasks-and-steps.en.md#changing-a-steps-agent)), otherwise `step_agents.deployment` (or `default_agent` if not set). The image is the image of this step (as for other steps, the Orchestrator chooses it and
  a person can change it; the default image if none). The workspace is a copy of the code at the merge commit, written to `workspaces/_deployment/<run ID>`
  (deleted afterward). The project's context (external PFs and MCP servers) is passed in the same way as for step agents.
- Before the run, `DeploymentCheckStarted` (run ID and skill) is recorded.
- Instructions (`buildDeploymentPrompt`): read and follow the skill. What to check (CI/CD, the deployment, or both) and how to check it follow
  the skill. The CI/CD runs and checks sacty saw (up to 50) are passed as JSON data that is not instructions. The agent is asked to only check and change nothing
  (no re-running CI/CD, no redeploying, no rollback), not to write secrets, not to wait long for CI/CD or the deployment to finish
  (`unknown` if not finished or cannot be determined), to mark what the skill says not to check as `skipped` with a reason, and to prefer the instructed answer format even if
  the skill describes a different one.
- Answer (`extractDeploymentCheck`): JSON under the heading `sacty-deployment`.

  ```json
  {"sacty-deployment": {"ci": {"result": "passed", "summary": "Summary of the CI/CD check", "reason": "Why it was skipped or could not be determined"}, "deployment": {"result": "skipped", "summary": "Summary of the deployment check", "reason": "This repository does not deploy"}, "summary": "Overall summary", "evidence": ["Evidence"]}}
  ```

  | Field | Values |
  | --- | --- |
  | `ci.result` | `passed` (checked as the skill says, and passing), `failed` (something failed), `skipped` (not checked), `unknown` (cannot be determined) |
  | `deployment.result` | `healthy` (the deployed app works correctly), `unhealthy` (it is erroring), `skipped` (not checked), `unknown` (cannot be determined) |
  | `summary` and `reason` (each) | Up to 2000 characters |
  | `summary` (overall) | Up to 4000 characters |
  | `evidence` | 20 items, up to 2000 characters each |

  Both `ci` and `deployment` need a `result` with one of the defined values. If missing, an unknown value, or the old form (only `result`), the answer cannot be read (`deploy.unreadable`).
- Overall result (`overallDeploymentResult`): `unhealthy` if either is `failed` or `unhealthy`; otherwise `unknown` if either is `unknown`;
  otherwise (even if both were skipped) `healthy`.
- Result (`DeploymentChecked`; holds the overall result and `ci` and `deployment`): `healthy` becomes `passed`, `unhealthy` becomes `failed`, and anything else becomes `skipped`
  (`check_unknown`). A failed run (`deploy.checkFailed`), an unreadable answer (`deploy.unreadable`), and `unknown` (`deploy.undetermined`) are also
  `check_unknown`. If the run exceeds the limit (`AGENT_RUN_TIMEOUT_MS`, 30 minutes; [Agent execution](agent-execution.en.md)), it is stopped like other runs and
  treated as a failed run. The cost (even on failure) counts toward the task's budget, and the 80% notification is evaluated.
- When a person stops it (Pause or Cancel), it is not turned into a result: sacty records `DeploymentChecked` with `retry` (`unknown`, `interrupted`, `deploy.stopped`, and the cost)
  and goes back to waiting for the check (it is checked again on resume).

Code: `apps/daemon/src/service.ts` (`queuedTaskIds`, `runNextInner`, `checkDeployment`), `apps/daemon/src/deployment.ts` (`buildDeploymentPrompt`, `extractDeploymentCheck`, `overallDeploymentResult`, `DEPLOYMENT_HEADING`), `apps/daemon/src/config.ts` (`agentFor`)

## Fix tasks

On a failure (`failed`), when no decision about a fix task has been made yet (`fixDecisionPending`), sacty makes exactly one decision per watch.

- Kind: `ci` if CI/CD failed by sacty's judgment; `deployment` if the check by the skill found a failure (`ci.result` is `failed` or `deployment.result` is
  `unhealthy`).
- Fingerprint (`fingerprint`): for `ci`, `ci|<repository>|<list of failed workflow / job names>` (`ciFingerprint`); for `deployment`,
  `deployment|<repository>` (`deploymentFingerprint`). The repository is lowercased, with a trailing `/` and `.git` removed.
- Duplicates: if the same project has an unfinished fix task with the same fingerprint (`fixTaskOpen`: not canceled, and either not completed, or completed but its watch is
  `waiting`), or one that has been registered but not yet created, no task is created and `DeploymentFixSuppressed` (`duplicate`, with that task's ID) is recorded. The watched
  task itself (watching the merge of a fix task) is excluded.
- Chain limit: if the depth (the original task's `fix.depth`, or 0 if none) + 1 exceeds `MAX_FIX_CHAIN` (3), no task is created and `DeploymentFixSuppressed`
  (`chain_limit`) is recorded.
- To create one, sacty records `DeploymentFixRegistered` (the new task's ID, kind, fingerprint, depth, title, and body) on the original task, then records `TaskCreated` with that ID
  (`start: deployment`, `repo` is the watched repository, `fix` holds the original task, kind, fingerprint, and depth, and the budget is `budget.default_per_task_usd`).
  If the daemon stops before creating it, the next check creates it (`createRegisteredFixTask`).
- Body (`buildCiFixTask`, `buildDeploymentFixTask`; up to `TASK_BODY_MAX`): the original task's title and ID, the merged PR, the repository and base branch,
  and the merge commit with its link. For `ci`, the failed workflows, jobs, conclusions, links to the runs, and the log excerpts (if they do not fit, the excerpts are
  truncated evenly from the end). For `deployment`, the skill, the results and reasons of the CI/CD check and the deployment check, the overall summary, and the evidence. The title
  is "デプロイ後のアプリのエラーを直す" if the deployment check is `unhealthy`, or "マージの後の確認で見つけた
  CI/CD の失敗を直す" if only the CI/CD check is `failed` (up to `TASK_TITLE_MAX`).
- A fix task is queued as an ordinary task (the Orchestrator chooses how to proceed).

Code: `apps/daemon/src/service.ts` (`registerFixTask`, `createRegisteredFixTask`), `apps/daemon/src/deployment.ts` (`ciFingerprint`, `deploymentFingerprint`, `buildCiFixTask`, `buildDeploymentFixTask`), `packages/core/src/projection.ts` (`fixDecisionPending`, `fixTaskOpen`), `packages/core/src/events.ts` (`MAX_FIX_CHAIN`, `DeploymentFixRegistered`, `DeploymentFixSuppressed`)

## When it could not be checked

In the following cases, sacty ends the watch without creating a fix task (it is not a failure), ends the step, and completes the task. There is no automatic retry.

| Case | `state` and `reason` | Where to notice |
| --- | --- | --- |
| CI/CD does not finish in 60 minutes, or 60 minutes pass while the GitHub API cannot be read | `timed_out` | The watch card, the Activity (`timed_out` of `DeploymentCiFinished`), and the daemon log for why it could not be read |
| No CI/CD at all after 5 minutes | `skipped`, `no_ci` | The watch card, the Activity |
| The check by the skill cannot determine the result, the run fails, or the answer cannot be read | `skipped`, `check_unknown` (`detail`) | The watch card (also the results and reasons of the CI/CD check and the deployment check, only when the answer could be read), the Activity |
| The budget cap | `skipped`, `budget` | The watch card, the Activity |

- The Slack completion notification ([Slack notifications](notifications.en.md)) has the same text regardless of the result of the watch and does not include the result (check it from the link to the task).
- There is no mechanism to check again. A person fixes the permissions or connection of the project's GitHub account only if the GitHub API could not be read, checks the CI/CD of the merge commit
  (the link in the card) on GitHub, checks with the skill's steps (the deployed app only when the skill asks for it), and creates a new task if something needs fixing.

Code: `apps/daemon/src/service.ts` (`pollDeploymentCi`, `checkDeployment`), `apps/web/src/components/deployment.tsx` (`DeploymentWatchCard`), `apps/daemon/src/notifier.ts` (`notificationText`)

## Pause, cancel, and restart

- Pause: during the watch (idle), the task can be paused like other steps. While paused, sacty does not watch CI/CD and does not run the check (registering a fix task also waits
  until resume). If it is paused while CI/CD is being read, the result read is discarded without being recorded, even if it was resumed right away (it is read again after resume. This is told apart
  by the number of times a person asked to pause (`pauseCounts`, kept only in memory) when reading started and just before recording. Reading in progress disappears on a restart,
  so counting again after a restart is fine). While the check is being prepared or running, the task cannot be resumed until it has stopped, so an old preparation result never arrives after resume. On resume, it goes back to idle and continues.
  If the check is being prepared or running, the container is stopped, the check is not turned into a result (`retry`), the task is paused, and it is checked again on resume (the same applies if the preparation fails because it was stopped).
- Cancel: the watch ends (nothing is recorded on a canceled task). If a check is running, it is stopped like any other run (`retry` is recorded, then the task is canceled).
  The merged implementation PR is not closed (the cleanup of the PR is `skipped`). Branches and the workspace are cleaned up as for other steps.
- Restart: a watch waiting for CI/CD continues after a restart (the time limit is counted from when the watch started). If the daemon stops while a check is running, at startup
  (`recoverInterrupted`), like a run of other steps, sacty records `DeploymentChecked` (`retry`, `unknown`, `interrupted`, `run.daemonStopped`) and
  `TaskPaused` (`error`, `run.daemonStopped`). It is checked again on resume. A check that had not started yet is run by the worker after startup.

Code: `apps/daemon/src/service.ts` (`pause`, `resume`, `cancel`, `recoverInterrupted`, `checkDeployments`, `pollDeploymentCi`, `checkDeployment`)

## Tasks from before the step

- Activity from before PBI-116 (no `deployment` step, and `DeploymentWatchStarted` on a completed task) is read as is, without rewriting it.
- Such a watch proceeds as before, with the task staying completed (steps and status do not change). The image for the check is the image of the Implementation step. A check that was
  stopped or interrupted by the daemon stopping ends as not determined (`deploy.stopped`, `run.daemonStopped`; `check_unknown`) and is not retried.
  The answer format is the current one.
- The project setting `deploymentWatch` is not read (it is dropped from saved definitions, and if an older export file has it, it is dropped without stopping the import.
  [Export and import](export.en.md)).

Code: `packages/core/src/projection.ts` (`applyEvent`), `apps/daemon/src/service.ts` (`checkDeployment`, `recoverInterrupted`), `packages/core/src/projects.ts` (`ProjectDefinition`, `ProjectExport`)

## Web UI

- The task's steps show "After-merge watch" (and that it was skipped, if so). The image of the step can be changed as for other steps.
- "After-merge watch" in the task details: before the watch starts, it shows that it is waiting for the merge and the skill to use, or the reason if skipped (the reason from when the steps
  were chosen, or that the implementation was approved with no changes). After it starts, it shows the state, the reason, the merge commit (link) and base branch, the time the watch started and the CI/CD wait limit,
  the CI/CD runs and checks (failed and running ones first, up to 20), the failed workflows and jobs (links and log excerpts), the check by the skill
  (skill, overall result, the results and reasons of the CI/CD check and the deployment check, summary, evidence), and the fix task (link) or the reason none was created.
- The top of a fix task's details shows a link to the original task and the depth.
- The Activity shows the seven events as sentences. The record of choosing steps shows whether to watch (the skill) or the reason for skipping, and a stopped check shows that it will be checked again.
- The cost-per-step table shows the runs of the check (including running and stopped ones) in this step's row (in step order). For tasks from before the step, they are shown as a row
  for a step not in the task's list of steps.
- Notifications ([Slack notifications](notifications.en.md)): the completion notification is sent when the watch ends and the task is completed. The notification when the task stops names the step (After-merge watch).
- The project settings have no setting for the after-merge watch.

Code: `apps/web/src/components/deployment.tsx` (`DeploymentWatchCard`), `apps/web/src/components/task-detail.tsx`, `apps/web/src/lib/labels.ts` (`describeEvent`, `statusText`), `apps/web/src/lib/step-costs.ts` (`stepCosts`), `apps/daemon/src/notifier.ts` (`notificationFor`, `notificationText`)
