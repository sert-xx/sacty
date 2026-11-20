<!-- Code: apps/daemon/src/service.ts (deploymentChoice, checkDeployments, checkDeployment, registerFixTask, recoverInterrupted), apps/daemon/src/ci.ts, apps/daemon/src/deployment.ts (DEPLOYMENT_SKILL_PATHS, CI_REFERENCE, DEPLOYMENT_HEADING, extractDeploymentCheck), apps/daemon/src/task-templates.ts, packages/core/src/events.ts (STEP_PLANS, MAX_FIX_CHAIN, DEPLOYMENT_CI_GRACE_MS, DEPLOYMENT_CI_TIMEOUT_MS), packages/core/src/projection.ts, apps/web/src/components/deployment.tsx, apps/web/src/i18n/messages/task.ts -->

[日本語](deployment-watch.md) | **English**

# After-merge watch (CI/CD and deployments)

When the Implementation PR of a sacty task is merged, sacty watches the following two things.

- Whether CI/CD passed for the base branch commit created by the merge
- Whether the deployed app is working

If something failed, sacty registers a fix task automatically. This is done as the step "After-merge watch" after Implement. To use this step, add a skill to the target repository that describes how to check ([Usage](#usage)).

## What it does

The after-merge watch proceeds as follows.

![After-merge watch flow](images/deployment-overview.en.svg)

1. When you merge the Implementation PR, the task moves to this step. The task is not completed; it appears as an unfinished task in the list and on the dashboard. The state is "After-merge watch · waiting for CI/CD" while waiting for CI/CD, and "After-merge watch · checking" while checking as the skill says. No human approval is needed.
2. sacty checks CI/CD for the merge commit (GitHub Actions workflow runs, checks from other apps, and commit statuses) every minute.
   - If nothing appears within 5 minutes, sacty treats it as having no CI/CD and skips the watch.
   - If it has not finished after 60 minutes, sacty ends with a timeout (no fix task is created).
   - `cancelled`, `skipped`, and `neutral` are not treated as failures.
3. If CI/CD fails, sacty registers a fix task. The body includes the original task, the PR, the commit, the failed workflows and jobs, links to the runs, and the end of the job logs (with secrets masked).
4. If CI/CD passes, an agent checks as the skill says.
   - What to check (only CI/CD, or also the deployed app) depends on how the skill is written.
   - If it finds a failure or an error, sacty registers a fix task with the result and evidence.
   - If it could not determine the result, sacty skips without creating a fix task.
5. When the watch ends, the task is completed. The watch ends in any of the following cases.
   - It passed
   - It was skipped
   - It timed out
   - It failed and sacty registered a fix task
   - It failed and sacty decided not to create a fix task ([Duplicate registration and limits](#duplicate-registration-and-limits))

On failure, the following happens.

- Even on failure, sacty does not stop the original task. If a fix task was registered, the fix task takes over.
- Fix tasks proceed as ordinary tasks (their merges are watched in the same way).
- If no fix task was created because of duplicate registration or the chain limit, check the reason shown in "After-merge watch" in the task's details. The reason is a link to the open fix task for the same failure, or the chain limit.

## Usage

1. Put the after-merge watch skill `deployment-observer` in the target repository ([Skill](#skill)).
2. Create a task.

When sacty chooses the task's steps, it checks whether the repository has the skill.

- If it does, the step "After-merge watch" is added after Implement.
- If not, sacty skips this step (it does not watch CI/CD either). The reason for skipping appears on the task's page and in the Activity.

The conditions and notes for using it are as follows.

- It is used in the plans that include Implement (Standard, Skip design, Skip requirements, Implement directly, Bug fix, and Security fix). For a task whose plan is "Split", sacty watches the Implementation PR of each subtask.
- The project's GitHub account needs permission to read Actions and checks in the target repository.
- If you add the skill after the task has started, that task does not watch (later tasks do). If the Implementation PR removes the skill, sacty watches only CI/CD.
- You do not need to turn it on or off in the project settings (there is no such setting).

## Skill

Put the skill in the target repository as follows.

- Put the original at `.agents/skills/deployment-observer/SKILL.md`, and make `.claude/skills/deployment-observer` for Claude Code a symbolic link to the original. Either one alone also works.
- For safety, sacty does not use symbolic links that point outside the repository (it treats the skill as missing and shows the reason on the web UI).
- You can also have an agent create a PR that adds this skill, with the task template "Sacty setup" ([Working with tasks](tasks.en.md#template-sacty-setup)). For repositories with CI/CD, the agent creates it even if they do not deploy.

Write the following in the skill.

- How to check CI/CD (which workflows and checks verify what, failures that can be ignored, and how to read results and logs). You may write it in a separate file such as `references/ci.md` and refer to it from SKILL.md.
- If the repository deploys, the following.
  - What counts as "the deployment has finished"
  - How to check the deployed app
  - How to connect to the app (external PFs or MCP servers in the project's context)
  - What counts as an error
- If it does not deploy: that the deployment check is skipped (set `result` of `deployment` to `skipped` and write the reason in `reason`). In this case, the check ends after checking only CI/CD.

For the check, the agent receives the following.

- A disposable copy of the code at the merge commit
- The CI/CD runs and checks sacty saw
- The project's context

sacty gives the agent the following three instructions.

- Only check and change nothing
- Do not wait long (sacty does the waiting)
- Answer at the end in this form

```json
{"sacty-deployment": {"ci": {"result": "passed", "summary": "The required workflows passed"}, "deployment": {"result": "skipped", "reason": "This repository does not deploy"}, "summary": "Checked only CI/CD", "evidence": ["CI: success"]}}
```

| Field | Values |
| --- | --- |
| `ci.result` | `passed` (passing), `failed` (something failed), `skipped` (not checked), `unknown` (cannot be determined) |
| `deployment.result` | `healthy` (working correctly), `unhealthy` (erroring), `skipped` (not checked), `unknown` (cannot be determined) |

The AI used for the check is the agent you set for this step (you can set it when creating the task, in the task details, when resuming, or when requesting changes; see [Changing a step's agent](tasks.en.md#changing-a-steps-agent)).
If none is set, it is the agent of `step_agents.deployment` in `config.yaml` (`default_agent` if omitted).

```yaml
step_agents:
  deployment: codex_lite
```

Like other steps, this step runs in the task image (changing the task image applies from the next run of this step).

## Cost and budget

- The cost of the check by the skill is added to the original task's cost ("After-merge watch" in the per-step cost table). Watching CI/CD does not use AI.
- If the budget cap has been reached, sacty skips the check without running it (the task is not stopped).

## Duplicate registration and limits

Even on failure, sacty does not create a fix task in the following two cases.

- **When it would be a duplicate registration**: if a fix task for the same failure is still open, sacty does not create a new one (the web UI shows a link to that task).
  - For a CI/CD failure, the same failure means the same workflow and job in the same repository.
  - For the check by the skill, the same failure means the same repository.
- **When it would exceed the chain limit**: if the merge of a fix task fails again, sacty creates the next fix task, but it does not create more than 3 levels (`MAX_FIX_CHAIN`) from the original task. In that case, please check it yourself.

## Viewing it on the web UI

The watch and its result appear in the following places.

- The task's steps show "After-merge watch" (if skipped, that it was skipped and why).
- "After-merge watch" in the task's details shows the following. While waiting, the page refreshes automatically.
  - The state (Watching, Passed, Failed, Skipped, Timed out) and the reason
  - The commit
  - The CI/CD runs and checks
  - The failed jobs and logs
  - The result of the check by the skill (each of the CI/CD check and the deployment check)
  - A link to the fix task
- A link to the original task appears in "Fix of" in the properties of the fix task's details.
- The Activity also records whether the step was included (or why it was skipped), the start of the watch, the CI/CD result, the check, and the fix task registration (or why one was not created).

## When it could not be checked

In the following cases, sacty ends the watch without creating a fix task, and the task is completed. sacty does not retry automatically.

| What happened | State |
| --- | --- |
| CI/CD did not finish within 60 minutes, or the GitHub API still could not be read after 60 minutes (no permission, cannot connect, and so on) | "Timed out" |
| No CI/CD appeared within 5 minutes | "Skipped" (no CI/CD) |
| The check by the skill could not determine the result, could not run, its answer could not be read, or the budget cap had been reached | "Skipped" with the reason |

You can notice it in the following places.

- "After-merge watch" in the task's details shows the state and the reason. The results of the CI/CD check and the deployment check are shown only when the agent's answer could be read. If the check could not run, its answer could not be read, or the budget cap had been reached, these results are not shown, so look at the overall state and reason.
- The Activity has lines such as "CI/CD did not finish in time" and "Check by the skill: could not determine".
- The reason the GitHub API could not be read appears in the daemon log (`[daemon] … の CI/CD の状態を読めませんでした`).
- The Slack completion notification has the same text regardless of the result of the watch. Open the task's details from the link in the notification to see the result.

To check again, check it yourself with the following steps.

1. Only if the GitHub API could not be read (the daemon log shows why), fix the permissions or the connection of the project's GitHub account. This is not needed for other reasons, such as the budget cap or an answer that could not be read.
2. From the "Merge commit" link in "After-merge watch" in the task's details, check the result of CI/CD (Actions and checks) for that commit on GitHub.
3. Check with the steps written in the skill (`.agents/skills/deployment-observer/SKILL.md` or `.claude/skills/deployment-observer/SKILL.md`).
   - Check the deployed app only when the skill asks for it (if the skill checks only CI/CD, step 2 is enough).
   - If the implementation PR removed the skill, the merge commit has no skill. Look at the skill in the commit the task started from, shown in "Target repository prepared" in the Activity.
4. If something needs fixing, create a new task.

## Pause, cancel, and restart

- During the watch, you can pause the task like other steps.
  - While paused, sacty does not watch CI/CD and does not check.
  - It continues when you resume (the 60-minute limit counts from when the watch started).
  - If you stop it during the check, it checks again when you resume.
- Canceling stops the watch. The merged Implementation PR stays as it is.
- When you restart the daemon, a watch waiting for CI/CD continues as is. If it stops during the check, sacty pauses the task. It checks again when you resume.

## Related pages

- [Project settings](project-settings.en.md)
- [config.yaml settings](config.en.md#models-per-step)
- [Context repository](context.en.md)
- [Working with tasks](tasks.en.md)
