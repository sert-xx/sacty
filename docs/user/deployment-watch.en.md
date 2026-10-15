<!-- Code: apps/daemon/src/service.ts (checkDeployments, checkDeployment, registerFixTask), apps/daemon/src/ci.ts, apps/daemon/src/deployment.ts, packages/core/src/events.ts (MAX_FIX_CHAIN, DEPLOYMENT_CI_GRACE_MS, DEPLOYMENT_CI_TIMEOUT_MS), packages/core/src/projects.ts (deploymentWatch), apps/web/src/components/deployment.tsx, apps/web/src/components/project-editor.tsx, apps/web/src/i18n/messages/task.ts -->

[日本語](deployment-watch.md) | **English**

# After-merge watch (CI/CD and deployments)

When the Implementation PR of a sacty task is merged, sacty watches whether CI/CD passed for the base branch commit created by the merge and whether the deployed app is working,
and registers a fix task automatically if something failed.

## Usage

1. In the project settings, check "After-merge watch" and save (Off by default. Nothing happens for projects where it is Off).
2. If you also want to check the app after deployment, put the deployment check skill `deployment-observer` in the target repository (see "Skill" below).
   Without it, only CI/CD is watched.

- The project's GitHub account needs permission to read Actions and checks in the target repository.
- Only merges of a sacty task's Implementation PR (Deliverable review) are watched (Requirements and Design PRs, and PRs made by people, are not).

## What it does

1. Every minute, sacty checks CI/CD for the merge commit (GitHub Actions workflow runs, checks from other apps, and commit statuses).
   - If none has appeared after 5 minutes, it assumes there is no CI/CD and skips the watch.
   - If CI/CD has not finished after 60 minutes, the watch ends as timed out (no fix task is created).
   - `cancelled`, `skipped`, and `neutral` are not treated as failures.
2. If CI/CD fails, sacty registers a fix task. Its body contains the original task, the PR, the commit, the failed workflows and jobs, links to the runs, and
   the end of the job logs (with secrets masked).
3. If CI/CD passes and the skill exists, an agent follows the skill to check that the deployment has finished and how the deployed app is doing. If the app is erroring,
   sacty registers a fix task containing the check's results and evidence. If the agent cannot determine the state, it skips without creating a fix task.

A fix task proceeds as a normal task (its merge is watched in the same way).

## Skill

- Put the original at `.agents/skills/deployment-observer/SKILL.md`, and make `.claude/skills/deployment-observer` for Claude Code a symbolic link
  to the original (either one alone also works).
- You can also have an agent create a PR that adds this skill, with the task template "Sacty setup"
  ([Working with tasks](tasks.en.md#template-sacty-setup)).
- For safety, symbolic links that point outside the repository are not used (sacty treats the skill as missing and shows the reason on the web UI).
- Write in the skill what counts as "the deployment has finished" and how to connect to the app (external PFs or MCP servers in the project's context).
  The agent receives a disposable copy of the code at the merge commit and the project's context.
- The agent is instructed to only check and change nothing, and at the end to answer with a result (`healthy`, `unhealthy`, or `unknown`), a summary, and evidence.
- The AI used for the check is `step_agents.deployment` in `config.yaml` (`default_agent` if omitted).

```yaml
step_agents:
  deployment: luna-low
```

## Cost and budget

- The cost of the deployment check is included in the original task's cost ("Deployment check" in the cost-per-step table). CI/CD watching does not use AI.
- If the budget cap has been reached, the deployment check is skipped without running (the task does not stop).

## Duplicate registration and limits

- If a fix task for the same failure (the same workflow and job in the same repository, or the same repository for deployment checks) has not finished, no new one is created
  (the web UI shows a link to that task).
- If the merge of a fix task fails again, the next fix task is created. No more than 3 levels (`MAX_FIX_CHAIN`) from the original task are created. Beyond that, a person
  needs to look into it.

## Viewing it on the web UI

- "After-merge watch" in the original task's details shows the state (Waiting, Passed, Failed, Skipped, Timed out), the reason, the commit, the CI/CD runs and checks,
  the failed jobs and logs, the deployment check result, and links to fix tasks. It updates automatically while waiting.
- The top of a fix task's details shows a link to the original task.
- The Activity also records the start of the watch, the CI/CD result, the deployment check, and the registration of fix tasks (or why none was created).

## When you restart the daemon

- Watches waiting for CI/CD continue as they are (the 60-minute limit is counted from the time the watch started).
- If the daemon stops during a deployment check, the check is skipped as not determined (it is not retried).

## Related pages

- [Project settings](project-settings.en.md)
- [config.yaml settings](config.en.md#models-per-step)
- [Context repository](context.en.md)
- [Working with tasks](tasks.en.md)
