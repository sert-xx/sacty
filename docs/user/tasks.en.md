<!-- Code: apps/daemon/src/service.ts, apps/daemon/src/pr-watcher.ts, apps/daemon/src/prompts.ts, packages/core/src/events.ts (StepKey, DEFAULT_DOCUMENTS_DIR), apps/web/src/i18n/messages/task.ts, apps/daemon/src/task-templates.ts, apps/daemon/src/test-files.ts, apps/web/src/components/new-task-dialog.tsx, apps/web/src/components/implementation.tsx -->

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
- The base branch and the test command are decided by the Orchestrator at the start of the task by reading the repository. In a repository without tests,
  the task proceeds without using tests ("Repositories without tests" below).
- Choosing the steps, and investigations that read and explain code or how things work, do not run the development setup (installing dependencies, building, and so on) (this takes precedence even if the repository's
  AGENTS.md or similar has setup instructions). Bug investigation, Reproduce, and Implementation set up the repository as its instructions say.

### Template "Sacty setup"

You can create a task that prepares the AI agent settings of a repository so that sacty can work with it, just by choosing the repository.

1. On the "Create task" screen, choose the "Sacty setup" template.
2. Choose the target repository and press "Create" (you do not enter a title or contents; sacty decides them).

Like a normal task, the Orchestrator chooses how to proceed, and the task goes through approvals and PRs. The agent checks the following and opens a PR
that fills in what is missing.

- Instructions for agents (AGENTS.md, CLAUDE.md, and so on)
- How to run the tests (if the repository has no tests yet, that there are none and how to check changes; this task does not add a new language or test framework)
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

## Repositories without tests

Even in a repository that has no tests at all, such as one with only a README, tasks proceed without stopping.

- The Orchestrator leaves the basis for judging that the repository has no tests. The step field of the task details shows "Test command: none (… Basis: …)"
  (it also appears in "Steps chosen" in the Activity).
- Verification of the implementation does not run tests. The Goal Guardian judges acceptance for each viewpoint from the task's goal, the requirements (and design), and the code after implementation, the diff, and the implementation's description.
  If it does not pass, the implementation is redone, as for a task with tests, and if it fails 3 times in a row, the task is paused.
- The implementation deliverable (the task details and the Deliverable review approval screen) shows "Not verified by tests". The test line of the PR body also
  includes the basis, with "テストのコマンドが無いため、テストでは検証していません。目的から判定しました。" (no test command, so it was not verified by tests; it was judged by the goal). Because nothing was checked by tests,
  check the content of the changes yourself before you approve.
- When the task is one that sets up tests (such as setting up a language) and the implementation adds tests, those tests are run before the judgment by the goal
  (the web UI shows "Verified by the tests added in the implementation" if they pass, and "The tests added in the implementation failed" if they do not.
  If they fail, the implementation is redone). If the implementation does not write the test command report (a code block whose language name is `sacty-test-command`) correctly (including when it cannot be read as JSON),
  the task
  is paused with an error (resuming redoes the implementation).
- While the implementation is being redone after failing the tests, the previous implementation's test results and final review are shown under headings such as "… for the previous submission (not yet … for the current one)".
  They are not results for the current implementation (this is the same for tasks with tests).
- A bug fix (Reproduce → Implementation) confirms the reproduction with tests, so it is not chosen for a repository without tests. If it is chosen, the task stops.

### When the task stopped instead of proceeding without tests

In the following cases, the task does not proceed without tests and is paused (the reason appears in the task details).

| Why it stopped | How to fix it |
| --- | --- |
| The repository has tests, but the Orchestrator could not determine the test command ("could not determine the test command") | Write how to run the tests (the command and prerequisites) in the task's description and create the task again. |
| The Orchestrator judged that there are no tests, but some files look like tests ("some files look like tests (…)"; the files found are shown) | If the files found **really are tests**, write how to run the tests in the task's description and create the task again, as above. If a file that is **not a test** (such as a script that is not for testing) was matched by mistake, creating the task again stops for the same reason. Change that file's name or location in the repository (move it out of `tests/` and similar directories, or remove `test` or `spec` from its name), merge that change into the base branch, and then create the task again. |
| There were too many files to confirm that there are no test files ("too many files to confirm …") | If there are tests, write how to run them in the task's description and create the task again. A large repository that really has no tests cannot proceed for now. |
| A workspace directory could not be read, so it could not be confirmed ("the workspace directory (…) could not be read (…)"; the location that could not be read and an error such as `EACCES` (no permission) are shown) | The location shown is a path relative to the task's workspace `$SACTY_HOME/workspaces/<task ID>/repo/` (`~/.sacty/workspaces/<task ID>/repo/` if you have not changed `SACTY_HOME`) (`.` is the workspace itself). The task ID is the end of the URL of the task details screen (`/tasks/<task ID>`). Check that the user running sacty can read that location (file permissions, disk state), fix it, and then create the task again. Resuming does not proceed without tests. |
| A bug fix was chosen ("a reproduction is confirmed by tests, so a test command is required") | Write how to run the tests and create the task again, or create it again as an ordinary task that describes what to fix instead of as a bug fix. |

Files that look like tests are files inside `test`, `tests`, and `__tests__` directories, and files with names like `*.test.*`, `*.spec.*`,
`*_test.*`, `*_spec.*`, `test_*`, `*Test.*`, or `Test*`. Document files (`.md`, `.txt`, `.rst`, `.adoc`,
and so on) do not match (`tests/README.md` does not match).

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

## Changing a step's image

The "Steps" section of the task detail shows the image of each step and where it came from (the Orchestrator, the project target, or a person).
If an image doesn't fit a step, you can choose again there. The changed image is used from the next run of the step (for a running step, from the next run).
See [Container images](images.en.md#changing-a-steps-image) for details.

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
