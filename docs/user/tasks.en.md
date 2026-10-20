<!-- Code: apps/daemon/src/config.ts, apps/web/src/components/task-detail.tsx, apps/daemon/src/service.ts, apps/daemon/src/activity.ts, apps/daemon/src/pr-watcher.ts, apps/daemon/src/prompts.ts, packages/core/src/events.ts (StepKey, DEFAULT_DOCUMENTS_DIR), apps/web/src/i18n/messages/task.ts, apps/daemon/src/task-templates.ts, apps/daemon/src/test-files.ts, apps/web/src/components/new-task-dialog.tsx, apps/web/src/components/implementation.tsx -->

[日本語](tasks.md) | **English**

# Working with tasks

When you create a task, the Orchestrator and the Goal Guardian move it through the steps. You make decisions only at approval gates.

## Create a task

- When you create a task in the web UI, you choose a repository from the project's targets ([Project settings](project-settings.en.md#targets)).
  - The repository suggestions are read when you press "Create task" and the dialog opens (for an org target, `gh` asks GitHub, which can
    take a few seconds). While they load, when they cannot be read, or when there are none, the dialog says so. In every case, you can type
    the repository URL and create the task.
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
- For repositories with CI/CD (even if they do not deploy), the after-merge watch skill `deployment-observer`. The original is
  `.agents/skills/deployment-observer/SKILL.md`, and `.claude/skills/deployment-observer` for Claude Code is a relative symbolic
  link to the original. A reference on how to check CI/CD (`references/ci.md`) is also created, and if the repository does not deploy, the skill says to skip the deployment check
  ([After-merge watch](deployment-watch.en.md#skill)). If there is no CI/CD, it is not created.

If everything is already in place and nothing needs to change, the task finishes without a PR, keeping the check results as investigation results (you approve it in the web UI to finish).
If, after Requirements, Design, and Implementation, it turns out that nothing needs to change, the task also finishes without a PR, keeping the check results in the implementation notes, when you approve it in the web UI
(see "When the implementation has no changes" below).
For tasks created from a template, the template name appears in "Started from" in the list, at the top of the details, and in "Task created" in the Activity.

From the API, send `{"template": "sacty-setup", "projectId": "<project ID>", "repo": "<repository URL>"}` to `POST /api/tasks`
(do not pass `title` or `body`). The CLI has no command to create tasks.

## Documents and one-off external work

To create a user guide, meeting notes, or a translated draft, leave the repository unselected and include the audience, purpose, and source contents in the task. Review the Markdown draft in Document, request changes, and approve it. Export follows approval only if the Orchestrator selected a destination. Check the selected destination and reason in the task’s steps section ([Exporting results](result-export.en.md)). An export failure does not stop completion of the draft, so also check the external publication result. To change documentation files in a repository, choose that repository. The change follows the normal Implementation and PR approval flow.

Document does not use external connections or project context and does not read drafts from external sources. Include the source text and any necessary rules in the task body; supply missing details through Request changes. Providing only a URL does not let this step retrieve the page’s contents to write the draft.

You can also request a calendar, register, or existing external page update without choosing a repository. This covers one-off changes that use one configured destination.

1. Include the specific target ID/URL, change and preconditions, and desired result in the request. The Orchestrator selects the destination, target, requested change, and verification method. Missing target or connection details stop the task before execution starts.
2. The single Operation step performs the request once. There is no separate preparation step or pre-execution approval, so confirm the request is correct before starting the task.
3. Check the evidence in the successful result and approve it to complete the task. Failure or an unknown result does not count as completion.

After step selection, the task details show the selected destination and connection type, target, requested change, and verification method as read-only information. This view does not add a pre-execution approval gate or pause the task.

If target details are missing, create a new task with the missing information included in the request. If the selected connection became unavailable before execution started, correct its configuration and resume the task.

You cannot request changes after execution starts. Resume is rejected after interruption, restart, or failure, and the task stays paused. Check the actual state in the external service, cancel the task, and create a new task for only the changes that remain undone. The agent is instructed to write once and check the result, but this does not guarantee duplicate prevention by the external service.

Recurring updates, monitoring, and automation of long-running work across several destinations are outside this scope. Split requests with several deliverables, such as a draft and an external update, into units you can review and approve.

## Repositories without tests

Even in a repository that has no tests at all, such as one with only a README, tasks proceed without stopping.

- The Orchestrator leaves the basis for judging that the repository has no tests. The step field of the task details shows "Test command: none · judged by the goal",
  and the hint mark (i) next to it shows the basis (it also appears in "Steps chosen" in the Activity).
- Verification of the implementation does not run tests. The Goal Guardian judges acceptance for each viewpoint from the task's goal, the requirements (and design), and the code after implementation, the diff, and the implementation's description.
  If it does not pass, the implementation is redone, as for a task with tests, and if it fails 3 times in a row, the task is paused.
- The implementation deliverable (the task details and the Implement approval screen) shows "Not verified by tests". The test line of the PR body also
  includes the basis, with "テストのコマンドが無いため、テストでは検証していません。目的から判定しました。" (no test command, so it was not verified by tests; it was judged by the goal). Because nothing was checked by tests,
  check the content of the changes yourself before you approve.
- When the task is one that sets up tests (such as setting up a language) and the implementation adds tests, those tests are run before the judgment by the goal
  (the web UI shows "Verified by the tests added in the implementation" if they pass, and "The tests added in the implementation failed" if they do not.
  If they fail, the implementation is redone). If the implementation does not write the test command report (a code block whose language name is `sacty-test-command`) correctly (including when it cannot be read as JSON),
  the task
  is paused with an error (resuming redoes the implementation).
- While the implementation is being redone after failing the tests, the previous implementation's test results and final review are shown under headings such as "… for the previous submission"
  (the hint mark next to them says that nothing has run or been judged for the current submission yet). They are not results for the current implementation (this is the same for tasks with tests).
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

- The task becomes "Implement awaiting approval with no changes". On the approval page, check the implementation notes (why no change is needed and the evidence), the test results, and the final
  review.
- If no changes is fine, press "Approve". The task becomes "Done (no changes)" without a PR.
- If changes are needed, write your feedback and request changes. Implementation starts over, and a PR is created if there are changes.
- In tasks whose Requirements and Design were approved in PRs, the task branch remains (delete it on GitHub if you do not need it).
- If a PR was already created and the implementation redone after a request for changes no longer changes anything, the task stops with an error (decide what to do with the open PR, then
  cancel the task or request changes again).

## Approval in PRs (Requirements, Design, Implement)

Steps that need human approval (Requirements, Design, and Implement) are decided in PRs to the target repository. Approval = merge, and steps that created a PR
are not approved from the sacty web UI (the web UI guides you to the PR and shows the status).

While awaiting approval, if the PR of the current submission is open, you can open the GitHub PR directly in a new tab (without the sacty approval screen in between).

- In the task details and "Needs you" in the task list: press "Review on the PR ↗".
- In "Needs you" on the dashboard and the header notifications: press the task title (marked with ↗ at the end).

Once you merge the PR, the task moves on at the next check without returning to the sacty web UI. In the following cases, you are taken to the sacty
approval screen as before ("Review" or "Decide" in the task details and the task list, and a task title without ↗ on the dashboard and in the notifications).

- When the task is escalated, such as when a person chooses the step to redo for PR comments.
- When the PR was closed without merging, was merged with content different from the submission, or does not exist yet.

1. sacty creates a task branch (`sacty/task-<short task ID>`) from the starting commit of the base branch.
2. The Requirements are written to a file (by default `docs/sacty/<short task ID>/requirements.md`) and opened as a PR to the task branch. When it is merged,
   it is recorded as approval of the Requirements and the task moves to the next step.
3. The Design (including Test viewpoints. `design.md`) is likewise opened as a PR to the task branch.
4. When the Design PR is merged, the task moves to the Implementation step. When the implementation passes the tests and the Goal Guardian's final review, within the Implementation step the
   implementation is committed to the task branch and opened as a PR from the task branch to the base branch (CI runs). Implement waits for approval, and merging the PR approves the implementation and
   moves on to the after-merge watch step (if the target repository has no skill and the step was skipped, the task is completed). The implementation PR also contains the Requirements and Design
   files. In the after-merge watch, sacty follows CI/CD and the deployment, and the task is completed when it ends ([After-merge watch](deployment-watch.en.md)).

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

## Self-review before submitting

In the Requirements, Design, and Implementation steps, the agent self-reviews the work by viewpoint with the default skill `review-dispatch` before submitting,
and fixes it until no `must` findings are left (up to 5 rounds including the first).

The result appears on the deliverable cards, the Implementation card, and the approval screen.

| Shown | Meaning |
| --- | --- |
| Self-review: passed · n rounds | Fixed until no `must` findings were left |
| Self-review: not passed · n rounds · m findings left | `must` findings were still left at the limit. Check them before deciding |
| No self-review record | The agent did not report a result. Check the deliverable yourself |

The cost of the self-review is included in the cost of that step.

## Changing a step's image

The "Steps" section of the task detail shows the image of each step and where it came from (the Orchestrator, the project target, or a person).
It is usually left as is, so only its heading is shown, collapsed (click the heading to open it). If an image doesn't fit a step, you can choose again there. The changed image is used from the next run of the step (for a running step, from the next run).
See [Container images](images.en.md#changing-a-steps-image) for details.

## Changing a step's agent

In "Step agents" in the "Steps" section of the task details, you can choose again the agent each step uses, from the usable agents (sacty's defaults and `agents` in config.yaml that have a connection and a price).
It is usually left as is, so only its heading is shown, collapsed (it is shown open when something needs checking, such as a name removed from the settings).
For example, run only a step that stopped on an error or was sent back with a stronger agent (one with a stronger model or reasoning effort, written as in [Models per step](config.en.md#models-per-step)).

- The changed agent is used from the next run of the step. It takes precedence over `step_agents` in config.yaml. Other tasks are not affected.
- Who changed what, when, and from what to what is kept in the Activity.
- If the chosen agent can no longer be used (you deleted it from config.yaml, removed its price, and so on), the task pauses when the step runs. Choose again, then resume.
- Integration review (the Goal Guardian) and the Orchestrator cannot be changed here.

## Pause, resume, and cancel

- For a task stopped by the budget limit, an AI usage limit, an authentication error, an error, and so on, check the cause and then resume it in the web UI (for the budget, see
  [config.yaml settings](config.en.md#budget)).
- Cancelling closes all open PRs that sacty created and deletes the task branch and the step branches (branches and PRs created by people are not touched).
  A cancelled task cannot be resumed.
- A cancelled task can be started over from "Rerun" on its detail page. In the dialog, you can change the repository to work in (empty means no
  repository), the image, the title, and the description, and add notes. It creates a new task that takes over the cancelled one, and adds the notes and
  the record of the previous attempt (step outputs, remarks, questions and answers, why it stopped) after the description. A task imported from a ticket
  keeps the ticket and doesn't read it again. A task can be rerun only once; afterwards, the cancelled task shows a link to the new task.
- If you pause while the implementation PR is being opened, the PR is finished and Implement waits for approval; the task is not paused (the screen says it was not paused).
  Decide on the PR, or cancel the task to stop it.

## Task list

Each row of the task list shows the name of the repository the task works on (only `repo` of `org/repo`) under its title. Tasks whose repository
is not decided yet show none (a task created without a repository shows "No repository"). Tasks taken in from an Issue or PR show its number
(such as `#7`) under where they started.

## Hints on the screen

The text on the screen says only the current state and what to do next, briefly. How things work and why is shown when you hover over the hint mark (i) next to a heading or item.
With the keyboard, it opens when you stop on the mark with Tab; on a phone, it opens on tap. Esc or a tap outside closes it. Items without a hint have no mark.

## Automatic updates on the screen

While they are open, the dashboard, the task list, the task details, and the header's notices fetch the latest state every 3 seconds and show it. They do this whatever
the state of the tasks (including when there are no tasks and when every task is awaiting approval, paused, or completed), so tasks added by intake,
approvals and resumes in other tabs or the CLI, tasks the daemon picked up and started, and tasks that became awaiting approval appear without any action.

- The screen is not reloaded; only the parts that changed are shown again. Questions, comments, and form values you are writing, what you selected, open
  dialogs and sections, focus, and the scroll position stay as they are.
- While the tab is hidden, nothing is fetched. When you come back to the tab, the screen is brought up to date right away.
- While the daemon cannot be reached, the screen stays as it is and shows "The daemon cannot be reached" (the header shows "Updates paused"). What is shown is what
  was last fetched. When the daemon can be reached again, the screen is brought up to date again and the notice goes away.
- The Approval screen and the project list (the intake status) are also brought up to date in the same way, without reloading. Comments you are
  writing are not lost.
- While a run is in progress, the run log adds new lines at the end automatically. The scroll position does not move while you are reading in the middle;
  the screen follows new lines only while you are looking at the bottom. If the list of the agent's original files cannot be read after the run has finished,
  the screen shows that and that it is retrying, and shows the list once it can be read.
- The Sacty settings and project settings screens are not updated automatically (only the header's notices are). To see the latest, open the screen
  again or reload it in the browser.

## Back up before updating and returning to an older version

A database containing new kinds of records (tasks with Document or Operation, audits of completed tasks and their fix tasks, and so on) cannot be read by an older version that does not support them, and startup fails. Stop the daemon and back up the data directory specified by `SACTY_HOME` (default: `~/.sacty`) before updating. To return to an older version, use the backup made before the update. If your settings include the new steps, also restore settings compatible with the older version.

Restoring the backup does not restore tasks or progress recorded after it was made. Keep a separate copy of the data before returning to the older version, and check which history will be lost. External changes, such as calendar updates, are not rolled back. Fix tasks created from adopted audit proposals may already have opened PRs. External operation start records made after the backup are also lost, so check the actual external state and do not repeat changes already made.

## Tasks from earlier versions (with the Open PR step)

Earlier versions had an "Open PR" step (`pr`; "PR作成" on the Japanese screen) after Implementation, whose approval screen was titled "Deliverable review". The current version removes this step:
the PR is opened inside the Implementation step, which then waits for the Implement approval (on the Approval screen). Tasks from earlier versions cannot be carried over as they are.

- Tasks created in an earlier version that contain the Open PR step (`pr`) are deleted from the Activity when the daemon starts. **Tasks in progress (running, awaiting approval,
  paused, and so on) are deleted too.** The parent and children of a task split, and a fix task from the after-merge watch and its original task, are deleted together when either is deleted.
- The number and IDs of the deleted tasks are written to the daemon log.
- GitHub branches and PRs are left as they are. If you won't use an open PR, close it on GitHub. Create the work you want to continue as a new
  task.
- If you wrote `pr` in `step_agents` in `config.yaml`, delete it. Leaving it is a settings error, and while there are old tasks, the daemon does not start
  and does not delete them (the log shows the settings error and asks you to delete it). Delete it and start again.

## Related pages

- [Exporting results](result-export.en.md)
- [After-merge watch](deployment-watch.en.md)
- [Notifications](notifications.en.md)
- [Troubleshooting](troubleshooting.en.md)
