[日本語](deployment-watch.md) | **English**

# After-merge watch (CI/CD and deployment)

When the implementation PR of a sacty task is merged, sacty waits for CI/CD on the merge commit (GitHub Actions workflow runs and checks).
If they pass, an agent checks the deployed app using the deployment check skill. If something fails, sacty registers a fix task automatically.
This happens only when the project setting `deploymentWatch` is `true`.

Related ADR: [When the implementation PR of a sacty task is merged, watch CI/CD and the deployed app, and register a fix task on failure](../adr/20261014-1439-deployment-watch-after-merge.md)

## Scope and start

- Only when the project's `deploymentWatch` is `true`. If it is not set or is `false`, nothing happens (no records are added).
- Only merges of implementation PRs (the approval of the step `implement`) are watched. PRs for Requirements and Design are not. Merges of fix tasks are watched in the same way.
- When the PR check (see "The PR check" in [Approval and request changes](approval.en.md)) records the merge, the same append records `DeploymentWatchStarted` (PR number,
  repository, base branch, and merge commit). The merge commit is GitHub's `merge_commit_sha`. If it cannot be obtained, the event has
  no commit and the watch is skipped (reason `no_commit`).
- Each task is watched only once (a second start is not accepted).

Code: `apps/daemon/src/service.ts` (`checkPullRequests`, `deploymentWatchEvents`), `packages/core/src/projects.ts` (`ProjectDefinition`), `packages/core/src/events.ts` (`DeploymentWatchStarted`)

## States

Stored in the task's `deployment` (`DeploymentWatch`). The task's `status` and steps do not change (the task stays completed).

| `state` | Meaning |
| --- | --- |
| `waiting` | Waiting. If `phase` is `ci`, for the CI/CD result; if `check`, for the deployment check (running if `check` is present) |
| `passed` | Passed (CI/CD passed and the deployment check returned `healthy`. Without a skill, only CI/CD passed, and `reason` is `no_skill`) |
| `failed` | Failed (CI/CD failed, or the deployment check returned `unhealthy`) |
| `skipped` | Skipped (the reason is in `reason`) |
| `timed_out` | CI/CD did not finish in time |

`reason` (`DeploymentWatchReason`): `no_commit` (the merge commit is unknown), `no_ci` (there is no CI/CD), `no_skill` (there is no skill),
`budget` (budget limit), `check_unknown` (the deployment check could not determine the result). The detailed reason is kept in `detail` (a message code).

Code: `packages/core/src/projection.ts` (`DeploymentWatch`, `DeploymentWatchState`, `DeploymentWatchReason`, `applyEvent`, `awaitingDeploymentCi`, `awaitingDeploymentCheck`, `deploymentCheckRunning`)

## Watching CI/CD

At the end of the PR check (every 60 seconds), for each task waiting for CI/CD, sacty reads the following with the project's GitHub account for that host.

| Kind (`kind`) | API | Handling |
| --- | --- | --- |
| `workflow` | `/repos/<owner>/<name>/actions/runs?head_sha=<commit>` | For the same workflow (`workflow_id`), only the newest run (`newerRun`: different runs are compared by `run_number`, `created_at`, then ID; within the same run, by `run_attempt`) |
| `check` | `/repos/<owner>/<name>/commits/<commit>/check-runs` | Those from GitHub Actions (`app.slug` is `github-actions`) are excluded (they are seen through the workflow runs) |
| `status` | `statuses` of `/repos/<owner>/<name>/commits/<commit>/status` | Anything other than `pending` is treated as finished |

The decision is made in this order. Time is counted from the time of `DeploymentWatchStarted` (restarting the daemon does not extend it).

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

- sacty looks for `.agents/skills/deployment-observer/SKILL.md`, then `.claude/skills/deployment-observer/SKILL.md`, in the merge commit
  (`DEPLOYMENT_SKILL_PATHS`). The first usable one is used.
- Symbolic links along the path (including `SKILL.md` itself) are followed when the target is inside the repository. Links that point to an absolute path, above the repository root,
  or the root itself, and links followed more than 8 times (such as loops), are not used (reason `deploy.skillOutside`).
- A file that cannot be read (not a regular file, too large, or not text) is not used (reason `deploy.skillUnreadable`). If none is found, `deploy.skillMissing`.
- The recorded path is the resolved path (from the repository root).

Code: `apps/daemon/src/deployment.ts` (`findDeploymentSkill`, `resolveInRepository`, `DEPLOYMENT_SKILL_PATHS`), `apps/daemon/src/repository.ts` (`readLink`, `readFile`)

## Deployment check

- Tasks that have a skill and are waiting for the check (`awaitingDeploymentCheck`) are picked up by the worker as queued work (paused tasks are not picked up).
  The limit on concurrent runs, Pause, and Cancel work the same as for other runs.
- If the budget limit has been reached, the check does not run and `DeploymentWatchSkipped` (`budget`) is recorded (the task is not stopped).
- The AI is `step_agents.deployment` (or `default_agent` if not set). The image is the image of the Implementation step (or the default image). The workspace is
  a copy of the code at the merge commit, written to `workspaces/_deployment/<run ID>` (deleted afterward). The project's context (external PFs and
  MCP servers) is passed in the same way as for step agents.
- Before the run, `DeploymentCheckStarted` (run ID and skill) is recorded. The instructions (`buildDeploymentPrompt`) ask the agent to read and follow the skill, to only check
  and change nothing, and not to write secrets.
- The answer is JSON under the heading `sacty-deployment` (`extractDeploymentCheck`): `result` (`healthy`, `unhealthy`, `unknown`), `summary` (up to 4000 characters), and
  `evidence` (20 items, up to 2000 characters each).
- Result (`DeploymentChecked`): `healthy` becomes `passed`, `unhealthy` becomes `failed`, and anything else becomes `skipped` (`check_unknown`). A failed run
  (`deploy.checkFailed`), an unreadable answer (`deploy.unreadable`), `unknown` (`deploy.undetermined`), and a run stopped or canceled by a person (`deploy.stopped`) are also
  `check_unknown`. The cost (even on failure) counts toward the original task's budget, and the 80% notification is evaluated.

Code: `apps/daemon/src/service.ts` (`queuedTaskIds`, `runNextInner`, `checkDeployment`), `apps/daemon/src/deployment.ts` (`buildDeploymentPrompt`, `extractDeploymentCheck`, `DEPLOYMENT_HEADING`), `apps/daemon/src/config.ts` (`agentFor`)

## Fix tasks

On a failure (`failed`), when no decision about a fix task has been made yet (`fixDecisionPending`), sacty makes exactly one decision per watch.

- Fingerprint (`fingerprint`): for CI/CD, `ci|<repository>|<list of failed workflow / job names>` (`ciFingerprint`); for the deployment check,
  `deployment|<repository>` (`deploymentFingerprint`). The repository is lowercased, with a trailing `/` and `.git` removed.
- Duplicates: if the same project has an unfinished fix task with the same fingerprint (`fixTaskOpen`: not canceled, and either not completed, or completed but its watch is
  `waiting`), or one that has been registered but not yet created, no task is created and `DeploymentFixSuppressed` (`duplicate`, with that task's ID) is recorded.
- Chain limit: if the depth (the original task's `fix.depth`, or 0 if none) + 1 exceeds `MAX_FIX_CHAIN` (3), no task is created and `DeploymentFixSuppressed`
  (`chain_limit`) is recorded.
- To create one, sacty records `DeploymentFixRegistered` (the new task's ID, kind, fingerprint, depth, title, and body) on the original task, then records `TaskCreated` with that ID
  (`start: deployment`, `repo` is the watched repository, `fix` holds the original task, kind, fingerprint, and depth, and the budget is `budget.default_per_task_usd`).
  If the daemon stops before creating it, the next check creates it (`createRegisteredFixTask`).
- Body (`buildCiFixTask`, `buildDeploymentFixTask`; up to `TASK_BODY_MAX`): the original task's title and ID, the merged PR, the repository and base branch,
  and the merge commit with its link. For CI/CD, the failed workflows, jobs, conclusions, links to the runs, and the log excerpts (if they do not fit, the excerpts are
  truncated evenly from the end). For the deployment check, the skill, the summary of the result, and the evidence. The title is up to `TASK_TITLE_MAX`.
- A fix task is queued as an ordinary task (the Orchestrator chooses how to proceed).

Code: `apps/daemon/src/service.ts` (`registerFixTask`, `createRegisteredFixTask`), `apps/daemon/src/deployment.ts` (`ciFingerprint`, `deploymentFingerprint`, `buildCiFixTask`, `buildDeploymentFixTask`), `packages/core/src/projection.ts` (`fixDecisionPending`, `fixTaskOpen`), `packages/core/src/events.ts` (`MAX_FIX_CHAIN`, `DeploymentFixRegistered`, `DeploymentFixSuppressed`)

## Restart and cancel

- A watch waiting for CI/CD continues after a restart (the time limit is counted from when the watch started).
- If the daemon stops while a deployment check is running, at startup (`recoverInterrupted`) sacty records `DeploymentChecked` (`unknown`, `interrupted`, `run.daemonStopped`)
  and sets it to `skipped` (it is not retried). A check that had not started yet is run by the worker after startup.
- When the original task is canceled, the watch ends (nothing is recorded on a canceled task). If a check is running, it is stopped like any other run.

Code: `apps/daemon/src/service.ts` (`recoverInterrupted`, `checkDeployments`)

## Web UI

- The "After-merge watch" section of the task details shows the state, the reason, the merge commit (link) and base branch, the time the watch started and the CI/CD wait limit, the CI/CD
  runs and checks (failed and running ones first, up to 20), the failed workflows and jobs (links and log excerpts), the deployment check (skill, result, summary, evidence),
  and the fix task (link) or the reason none was created. While waiting, the page refreshes automatically.
- The top of a fix task's details shows a link to the original task and the depth.
- The Activity shows the seven events as sentences. The cost-per-step table shows a "Deployment check" row (`deployment`).
- The project settings show an "After-merge watch" checkbox (Off by default).

Code: `apps/web/src/components/deployment.tsx` (`DeploymentWatchCard`), `apps/web/src/app/tasks/[id]/page.tsx`, `apps/web/src/lib/labels.ts` (`describeEvent`), `apps/web/src/lib/step-costs.ts` (`stepCosts`), `apps/web/src/components/project-editor.tsx`
