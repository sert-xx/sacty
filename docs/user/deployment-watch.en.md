<!-- Code: apps/daemon/src/service.ts (deploymentChoice, checkDeployments, checkDeployment, registerFixTask, recoverInterrupted), apps/daemon/src/ci.ts, apps/daemon/src/deployment.ts (DEPLOYMENT_SKILL_PATHS, CI_REFERENCE, DEPLOYMENT_HEADING, extractDeploymentCheck), apps/daemon/src/task-templates.ts, packages/core/src/events.ts (STEP_PLANS, MAX_FIX_CHAIN, DEPLOYMENT_CI_GRACE_MS, DEPLOYMENT_CI_TIMEOUT_MS), packages/core/src/projection.ts, apps/web/src/components/deployment.tsx, apps/web/src/i18n/messages/task.ts -->

[日本語](deployment-watch.md) | **English**

# After-merge watch (CI/CD and deployments)

When the Implementation PR of a sacty task is merged, sacty watches whether CI/CD passed for the base branch commit created by the merge and whether the deployed app is working,
and registers a fix task automatically if something failed. This is done as the step "After-merge watch" after Implement.

## Usage

1. Put the after-merge watch skill `deployment-observer` in the target repository (see "Skill" below).
2. When you create a task, sacty checks whether the repository has the skill when it chooses the steps.
   - If it does, the step "After-merge watch" is added after Implement.
   - If not, this step is skipped (CI/CD is not watched either). The reason for skipping appears on the task's page and in the Activity.

- You do not need to turn it on or off in the project settings (there is no such setting).
- It is used in the plans that include Implement (standard, skip design, and bug fix). For a task split, the Implementation PR of each subtask is watched.
- The project's GitHub account needs permission to read Actions and checks in the target repository.
- If you add the skill after the task has started, that task does not watch (later tasks do). If the Implementation PR removes the skill, only CI/CD is watched.

## What it does

1. When you merge the Implementation PR, the task moves to this step. The task is not completed; it appears as an unfinished task in the list and on the dashboard
   (the state is "After-merge watch"). No human approval is needed.
2. sacty checks CI/CD for the merge commit (GitHub Actions workflow runs, checks from other apps, and commit statuses) every minute.
   - If nothing appears within 5 minutes, sacty treats it as having no CI/CD and skips the watch.
   - If it has not finished after 60 minutes, sacty ends with a timeout (no fix task is created).
   - `cancelled`, `skipped`, and `neutral` are not treated as failures.
3. If CI/CD fails, sacty registers a fix task. The body includes the original task, the PR, the commit, the failed workflows and jobs, links to the runs,
   and the end of the job logs (with secrets masked).
4. If CI/CD passes, an agent checks as the skill says. What to check (only CI/CD, or also the deployed app) depends on
   how the skill is written. If it finds a failure or an error, sacty registers a fix task with the result and evidence. If it could not determine the result,
   sacty skips without creating a fix task.
5. When the watch ends, the task is completed. It ends when it passed, was skipped, or timed out, or when it failed and sacty registered a fix task or decided not to create
   one (see "Duplicate registration and limits" below). Even on failure, the original task is not stopped. If a fix task was registered, the fix task takes over.
   If none was created because of duplicate registration or the chain limit, check the reason shown in "After-merge watch" in the task's details (a link to the open fix task for
   the same failure, or the chain limit).

Fix tasks proceed as ordinary tasks (their merges are watched in the same way).

## Skill

- Put the original at `.agents/skills/deployment-observer/SKILL.md`, and make `.claude/skills/deployment-observer` for Claude Code a symbolic link
  to the original (either one alone also works).
- You can also have an agent create a PR that adds this skill, with the task template "Sacty setup"
  ([Working with tasks](tasks.en.md#template-sacty-setup)). For repositories with CI/CD, it is created even if they do not deploy.
- For safety, symbolic links that point outside the repository are not used (sacty treats the skill as missing and shows the reason on the web UI).
- What to write in the skill:
  - How to check CI/CD (which workflows and checks verify what, failures that can be ignored, and how to read results and logs). You may write it in a separate file such as
    `references/ci.md` and refer to it from SKILL.md.
  - If the repository deploys: what counts as "the deployment has finished", how to check the deployed app, how to connect to the app (external PFs or MCP servers in the project's
    context), and what counts as an error.
  - If it does not deploy: that the deployment check is skipped (set `result` of `deployment` to `skipped` and write the reason in `reason`). The check ends after checking
    only CI/CD.
- The agent receives a disposable copy of the code at the merge commit, the CI/CD runs and checks sacty saw, and the project's context.
  sacty instructs it to only check and change nothing, not to wait long (sacty does the waiting), and to answer at the end in this form.

```json
{"sacty-deployment": {"ci": {"result": "passed", "summary": "The required workflows passed"}, "deployment": {"result": "skipped", "reason": "This repository does not deploy"}, "summary": "Checked only CI/CD", "evidence": ["CI: success"]}}
```

| Field | Values |
| --- | --- |
| `ci.result` | `passed` (passing), `failed` (something failed), `skipped` (not checked), `unknown` (cannot be determined) |
| `deployment.result` | `healthy` (working correctly), `unhealthy` (erroring), `skipped` (not checked), `unknown` (cannot be determined) |

- The AI used for the check is `step_agents.deployment` in `config.yaml` (`default_agent` if omitted).

```yaml
step_agents:
  deployment: luna-low
```

## Cost and budget

- The cost of the check by the skill is added to the original task's cost ("After-merge watch" in the per-step cost table). Watching CI/CD does not use AI.
- If the budget cap has been reached, the check is skipped without running (the task is not stopped).

## Duplicate registration and limits

- If a fix task for the same failure (the same workflow and job in the same repository, or the same repository for the check by the skill) is still open, no new one is created
  (the web UI shows a link to that task).
- If the merge of a fix task fails again, the next fix task is created. sacty does not create more than 3 levels (`MAX_FIX_CHAIN`) from the original task. In that case,
  please check it yourself.

## Viewing it on the web UI

- The task's steps show "After-merge watch" (if skipped, that it was skipped and why). The step's image can be changed like other steps.
- "After-merge watch" in the task's details shows the state (Waiting, Passed, Failed, Skipped, Timed out), the reason, the commit, the CI/CD runs and checks,
  the failed jobs and logs, the result of the check by the skill (each of the CI/CD check and the deployment check), and a link to the fix task.
  While waiting, the page refreshes automatically.
- A link to the original task appears at the top of the fix task's details.
- The Activity also records whether the step was included (or why it was skipped), the start of the watch, the CI/CD result, the check, and the fix task registration (or why one was not created).

## When it could not be checked

In the following cases, sacty ends the watch without creating a fix task, and the task is completed. sacty does not retry automatically.

- CI/CD did not finish within 60 minutes, or the GitHub API could not be read (no permission, cannot connect, and so on): the state is "Timed out".
- No CI/CD appeared within 5 minutes: the state is "Skipped" (no CI/CD).
- The check by the skill could not determine the result, could not run, its answer could not be read, or the budget cap had been reached: the state is "Skipped" with the reason.

How to notice:

- "After-merge watch" in the task's details shows the state and the reason. The results of the CI/CD check and the deployment check are shown only when the agent's answer
  could be read. If the check could not run, its answer could not be read, or the budget cap had been reached, these results are not shown, so look at the overall state and
  reason.
- The Activity has lines such as "CI/CD did not finish in time (timed out)" and "Result of the check by the skill: could not determine".
- The reason the GitHub API could not be read appears in the daemon log (`[daemon] … の CI/CD の状態を読めませんでした`).
- The Slack completion notification has the same text regardless of the result of the watch. Open the task's details from the link in the notification to see the result.

How to check again (by hand):

1. Fix the permissions or the connection of the project's GitHub account.
2. From the "Merge commit" link in the card, check the result of CI/CD (Actions and checks) for that commit on GitHub.
3. Check the deployed app with the steps written in the skill (`.agents/skills/deployment-observer/SKILL.md` or `.claude/skills/deployment-observer/SKILL.md`).
   If the implementation PR removed the skill, the merge commit has no skill. Look at the skill in the commit the task started from, shown in "Target repository prepared"
   in the Activity.
4. If something needs fixing, create a new task.

## Pause, cancel, and restart

- During the watch, you can pause the task like other steps. While paused, sacty does not watch CI/CD and does not check. It continues when you resume (the 60-minute limit
  counts from when the watch started). If you stop it during the check, it checks again when you resume.
- Canceling stops the watch. The merged Implementation PR stays as it is.
- When you restart the daemon, a watch waiting for CI/CD continues as is. If it stops during the check, the task is paused. It checks again when you resume.

## Related pages

- [Project settings](project-settings.en.md)
- [config.yaml settings](config.en.md#models-per-step)
- [Context repository](context.en.md)
- [Working with tasks](tasks.en.md)
