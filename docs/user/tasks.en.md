<!-- Code: apps/daemon/src/service.ts, apps/daemon/src/pr-watcher.ts, apps/daemon/src/prompts.ts, packages/core/src/events.ts (StepKey, DEFAULT_DOCUMENTS_DIR), apps/web/src/i18n/messages/task.ts, apps/daemon/src/task-templates.ts, apps/web/src/components/new-task-dialog.tsx -->

[日本語](tasks.md) | **English**

# Working with tasks

When you create a task, the Orchestrator and the Goal Guardian move it through the steps. You make decisions only at approval gates.

## Create a task

- When you create a task in the web UI, you choose a repository from the project's targets ([Project settings](project-settings.en.md#targets)).
  You can also import tasks from issues, PRs, and tickets ([Intake](intake.en.md)).
- You can also create a task without choosing a repository (research, overall design, or a large task to split). The Orchestrator chooses how to proceed from the project's
  context (the rules in the context repository and the export destinations) and its targets (the list of repositories).
  - Work that does not change code (investigation only, design only) proceeds without a repository and finishes when you approve it in the sacty web UI (no PR or branch is created.
    If there is an export destination, the results are exported).
  - For a large task to split, Task split chooses a repository from the targets for each child task (and records why), and Integration review reads the latest base branch
    of each child task's repository.
  - For a task that needs code changes and is not split, the Orchestrator chooses a repository from the targets, prepares it, and then chooses the steps again. If it cannot choose, the task stops,
    and you can choose the repository in the task details and resume.
- The base branch and the test command are decided by the Orchestrator at the start of the task by reading the repository.
- Choosing the steps, and investigations that read and explain code or how things work, do not run the development setup (installing dependencies, building, and so on) (this takes precedence even if the repository's
  AGENTS.md or similar has setup instructions). Bug investigation, Reproduce, and Implementation set up the repository as its instructions say.

### Template "Sacty setup"

You can create a task that prepares the AI agent settings of a repository so that sacty can work with it, just by choosing the repository.

1. On the "Create task" screen, choose the "Sacty setup" template.
2. Choose the target repository and press "Create" (you do not enter a title or contents; sacty decides them).

Like a normal task, the Orchestrator chooses how to proceed, and the task goes through approvals and PRs. The agent checks the following and opens a PR
that fills in what is missing.

- Instructions for agents (AGENTS.md, CLAUDE.md, and so on)
- How to run the tests
- Services the tests need (databases, mocks, and so on)
- For repositories deployed by CI/CD, the deployment check skill `deployment-observer` (used by the after-merge watch). The original is
  `.agents/skills/deployment-observer/SKILL.md`, and `.claude/skills/deployment-observer` for Claude Code is a relative symbolic
  link to the original.

If everything is already in place and nothing needs to change, the task finishes without a PR, keeping the check results as investigation results (you approve it in the web UI to finish).
If, after Requirements, Design, and Implementation, it turns out that nothing needs to change, the task also finishes without a PR, keeping the check results in the implementation notes, when you approve it in the web UI
(see "When the implementation has no changes" below).
For tasks created from a template, the template name appears in "Started from" in the list, at the top of the details, and in "Task created" in the Activity.

From the API, send `{"template": "sacty-setup", "projectId": "<project ID>", "repo": "<repository URL>"}` to `POST /api/tasks`
(do not pass `title` or `body`). The CLI has no command to create tasks.

## When the implementation has no changes

When the Implementation step changes nothing (it decided the requirements are already met and no change is needed), no PR is created. This is the same for every task.

- The task becomes "Awaiting deliverable review with no changes". On the approval page, check the implementation notes (why no change is needed and the evidence), the test results, and the final
  review.
- If no changes is fine, press "Approve". The task becomes "Done (no changes)" without a PR.
- If changes are needed, write your feedback and request changes. Implementation starts over, and a PR is created if there are changes.
- In tasks whose Requirements and Design were approved in PRs, the task branch remains (delete it on GitHub if you do not need it).
- If a PR was already created and the implementation redone after a request for changes no longer changes anything, the task stops with an error (decide what to do with the open PR, then
  cancel the task or request changes again).

## Approval in PRs (Requirements, Design, Deliverable review)

Steps that need human approval (Requirements, Design, and the Deliverable review of the implementation) are decided in PRs to the target repository. Approval = merge, and steps that created a PR
are not approved from the sacty web UI (the web UI guides you to the PR and shows the status).

1. sacty creates a task branch (`sacty/task-<short task ID>`) from the starting commit of the base branch.
2. The Requirements are written to a file (by default `docs/sacty/<short task ID>/requirements.md`) and opened as a PR to the task branch. When it is merged,
   it is recorded as approval of the Requirements and the task moves to the next step.
3. The Design (including Test viewpoints. `design.md`) is likewise opened as a PR to the task branch.
4. When the Design PR is merged, the implementation is committed to the task branch and opened as a PR from the task branch to the base branch (Deliverable review)
   (CI runs). The implementation PR also contains the Requirements and Design files. If you turn it On in the project settings, sacty
   follows CI/CD and the deployment after the merge ([After-merge watch](deployment-watch.en.md)).

- If the rules of the repository or the project's context decide where the files go, the Orchestrator follows them.
- PR reviews, line comments, and regular comments (excluding bots and sacty's own posts, but including posts by the sacty review task that imported that PR.
  [Reviewing PRs that sacty created](intake.en.md#reviewing-prs-that-sacty-created)) are taken in as findings (checked every minute, 2 minutes after the last
  comment), and the Goal Guardian decides whether to redo that step (updating the same PR) or request changes back to an earlier step (no human check in between; the decision and
  its reasons are kept in the Activity and the PR section). If requests for changes to the same step exceed the limit, it becomes an Escalation.
- When the task goes back to an earlier step, the merged PR is not reverted; a new fix PR to the task branch is created. When the fix is merged, the PRs of the later steps are
  recreated (the previous open PRs are closed. The implementation PR is updated in place).
- If a PR is closed without being merged, or merged with contents different from what sacty submitted, it is not treated as approval and sacty waits for your decision (if you request changes from the web UI, the
  redone contents are submitted in a new PR).
- Steps that need no approval (such as an earlier Investigation), and tasks that are investigation only, review only, or bug fixes (tasks without Requirements and Design), do not create Requirements or Design
  PRs (investigation-only tasks are approved in the web UI). Tasks that submitted Requirements or Design in the web UI in a version before approval in PRs existed
  are still approved in the web UI.
- Each child task of a Task split has its own task branch (the parent's Requirements and Design are also approved in PRs to the parent's task branch, but the parent's
  task branch is not merged into the base branch).
- If the target repository (or, if it has none, the org's public `.github` repository) has a PR template (`pull_request_template.md`), the PR body
  follows its headings. Headings sacty cannot fill are marked "該当なし" (not applicable), and checkboxes are left unchecked (the reviewer
  checks them). If there is no template or it cannot be read, sacty uses its own format. Which one was used appears in "Body" in the PR section of the task page.
  See the [specification](../spec/approval.en.md#pr-body-and-pr-template) for the detailed rules on where templates are looked for and how they are filled.

## Ask the Orchestrator

Use "Ask the Orchestrator" in the task details to ask about the status of the task.

- The Orchestrator (`step_agents.orchestrator` or `default_agent`) answers by reading the task's ledger (the Activity, approved deliverables, step outputs, verdicts, and
  costs) and, if prepared, the code of the target repository at the starting commit (a disposable copy).
- It also examines, read-only, the session logs of each run, such as the agents of each step and the Orchestrator itself (with secrets masked; this includes the original files written by
  Claude Code and Codex), and answers what the agents actually did. Answers state which step and which run the log is from.
  For runs that are still running, runs without logs, logs with parts omitted due to limits, and logs that cannot be read, the answer says so.
- Asking does not change the steps or approved contents, and does not stop work, even on a task in progress.
- The cost of the answer is added to the task's cost. You cannot ask on a task that has reached its budget limit.

## Pause, resume, and cancel

- For a task stopped by the budget limit, an AI usage limit, an authentication error, an error, and so on, check the cause and then resume it in the web UI (for the budget, see
  [config.yaml settings](config.en.md#budget)).
- Cancelling closes all open PRs that sacty created and deletes the task branch and the step branches (branches and PRs created by people are not touched).
  A cancelled task cannot be resumed.

## Related pages

- [Exporting results](result-export.en.md)
- [After-merge watch](deployment-watch.en.md)
- [Notifications](notifications.en.md)
- [Troubleshooting](troubleshooting.en.md)
