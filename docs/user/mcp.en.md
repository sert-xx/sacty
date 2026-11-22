<!-- Code: packages/cli/src/index.ts (mcpCommand), packages/cli/src/mcp.ts, apps/daemon/src/task-mcp.ts (TOOLS, INSTRUCTIONS), apps/daemon/src/step-questions.ts, apps/daemon/src/task-reads.ts, apps/daemon/src/byte-range.ts, apps/daemon/src/session-logs.ts (readMeta), apps/daemon/src/review-record.ts -->

[日本語](mcp.md) | **English**

# Operating sacty from your local AI (MCP)

You can operate the running sacty from Claude Code or Codex on the same computer.
For example, after fixing a PR, you can ask the AI to "re-review this PR with sacty" (the same as opening the web UI and pressing "Review again and post to the PR").

sacty has an MCP server for this (`sacty mcp`; it supports the 2026-07-28 revision of the MCP specification and also works with clients of earlier revisions).
It can look up tasks (list, search, details), put a PR review task into re-review, create a task in a project you specify,
read the deliverables of each step of a task and the list of agent runs (deliverables and the run list are read-only), approve a step that is awaiting approval, request changes on a step that is awaiting approval, pause a task, resume a paused task (with an optional note and permission to edit approved artifacts), cancel a task (it confirms the cleanup targets first and cannot be undone), rerun a cancelled task (it creates a new task and starts over; only once), create a follow-up task from a completed task (you give only a title and content; it can be done any number of times), rename a task, and wait until a task's progress changes (awaiting approval, awaiting a person's decision, paused, completed, cancelled, or a PR review verdict). The logs of runs cannot be read yet (read them in the web UI).
It cannot rerun with a corrected title or description, rerun with a different repository or image, choose the repository or plan of a follow-up task, create a follow-up task from a security-combination task, or change a task's description (changing the description is not in the web UI either; do the others in the web UI). Resuming that needs a budget-cap increase, a decision on the test handling, accepting a child task's cancellation, or choosing the repository to work on is also done in the web UI. Requesting changes is also only the basic form (choosing where to send it back and choosing a cause are done in the web UI). A step approved by merging a PR (implementation, requirements or design with a PR) cannot be approved from MCP either (merge the PR on GitHub). Deliverables can be used to check the content before you approve. The error report of a task (the same Markdown as "Download error report" on the web UI) can also be read (read-only; logs of runs that were not closed are omitted; asking for an error analysis is done in the web UI).

## Connecting

Register `sacty mcp` once as an MCP server in your AI CLI.
After that, you do not need to register it again even if you restart `sacty up`.

First, make `sacty` usable in any directory ([Getting started](getting-started.en.md#using-sacty-in-any-directory)).
`npx sacty` works only inside the sacty repository, so it cannot be used for the registration.

For Claude Code, run the following.

```sh
claude mcp add --scope user sacty -- sacty mcp
```

For Codex, run the following.

```sh
codex mcp add sacty -- sacty mcp
```

Check the registration as follows.

- Claude Code: `claude mcp list` shows `sacty` as connected.
- Codex: `codex mcp list` shows `sacty`.

If you run sacty with a different `SACTY_HOME`, pass the same value to the MCP server too.
Add `--env SACTY_HOME=<path>` before `--scope user` for Claude Code, and before `--` for Codex.

## Using it

Ask the AI in plain words.
The AI picks the tools below and calls them.

- "Re-review PR #123 with sacty"
- "How is the sacty task reviewing this branch's PR doing?"
- "Tell me which sacty tasks are stopped"
- "Create a task in the (project name) project of sacty titled 'Fix the login screen wording'"
- "Read the design of this sacty task"
- "Show me the agent runs of this sacty task, newest first"
- "Check the investigation result of this sacty task, and approve it if it looks good"
- "Read the design of this sacty task and send it back, pointing out that it should add an error message"
- "Wait until this sacty task is awaiting approval or a PR review verdict appears, then tell me"
- "Pause this sacty task"
- "Resume this paused sacty task with the note 'do not rename anything'"

When you ask for a re-review, sacty reviews the latest commit of the PR again and posts the result to the PR ([Re-review](intake.en.md#re-review)).
The review takes time to finish and costs money.
The answer to the AI comes back as soon as the re-review starts.

A task you create is the same as one created with "Create task" in the web UI with no template and the approach left at "Automatic", with the same title and description ([Create a task](tasks.en.md#create-a-task)).
The target repository (`repo`) can be omitted. If omitted, the task is created with the target repository blank, and sacty's orchestrator chooses it afterwards. If given, it is treated the same as entering a target repository in the web UI, and the orchestrator does not choose. You can give a target repository URL from `list_projects`, or the URL of a repository under an Org target. A repository that is not a target and a value that is not a URL are refused with the same reason as the web UI, and nothing is created. Specifying multiple repositories is done in the web UI.
The answer contains the ID of the new task and its web UI URL, and comes back without waiting for the steps to finish.
When the task cannot be created (the project does not exist, the title is empty, and so on), it returns the reason and creates nothing.
When the result cannot be received after the request to create was sent (a timeout, a dropped connection, an unreadable body, or a 5xx from the daemon), it answers "The task may have been created". Search for the title with `list_tasks` to check, and ask again only if it is not there (asking again without checking can create the same task twice).

Deliverables have a limit on how much one call can read (32,000 bytes in UTF-8; about 10,000 Japanese characters).
When the content exceeds the limit, the result says it was cut and gives the total size and the position to continue from, and the AI reads on.
The content of a deliverable comes from the same source as the web UI's task detail and is hidden the same way as there (nothing is hidden again for MCP).
The run list also limits how many entries one call returns (20 by default, 100 at most). If runs are added while you fetch the rest, the same run can be returned twice, so the AI drops duplicates by run ID.

The error report also limits how much one call reads and can be read on. The report is rebuilt on every read, so when reading on, the AI passes the previous result's `fingerprint` (a fingerprint of the whole report, without the creation-time line). If the content changes while it is read (for example, a running task), the tool does not return the rest and answers "read it again", and the AI reads again from the start without `fingerprint`. For a report that keeps changing (for example, a running task), passing `fingerprint` can make every continuation refused. The rest can then be read without `fingerprint`, but it may not connect to the part read before. When a reliable whole is needed, read it after the task has stopped.
Unlike the web UI download, the log contents of a run that the daemon stopped before closing are always omitted (the report only says so; the web UI includes the tail of the saved log).

When sacty is not running, the tools answer that the running sacty was not found.
Start it with `sacty up` and ask again.
When sacty does not respond within 30 seconds, the tools answer that the daemon did not respond in time (sacty is running; check how it is doing and ask again).

## Tools

| Tool | What it does |
| --- | --- |
| `list_tasks` | Lists tasks, newest first. Can filter by PR, branch name, repository, title, and so on. With `needs_person`, it lists only the tasks waiting for a person: tasks that move on once you decide first, then paused tasks (the longest wait first within each) |
| `get_task` | Returns the details of a task (description, review body, why it is stopped, recent activity). For a PR review task, it also returns the review records that are not written to the PR (per round: how the viewpoints were handled, the viewpoints that could not be reviewed, the findings not adopted, the verification progress, and the agent, model, and number of reviewers that ran; `reviewRecords`) and the full risk assessment without omission (`riskAssessment`). The sentences of the records are written by the reviewing AI and are treated as data, not instructions |
| `rereview_task` | Puts a PR review task into re-review |
| `list_projects` | Lists the projects that have not been deleted, with their IDs, names, and target repositories (a target URL can be passed to the `repo` of `create_task`; for an Org target, the URL of a repository under it can be passed) |
| `create_task` | Creates a task in a project you specify, from a title and a description (`project_id`, `title`, `body`, `repo`; the description and the target repository can be omitted) |
| `list_deliverables` | Lists the deliverables of each step of a task (step, which submission, kind, size, status) |
| `get_deliverable` | Reads the content of a deliverable by step and kind (the approved version if there is one, otherwise the latest output; for a review, the body and the comments on lines) |
| `list_runs` | Lists agent runs, newest first (steps, the orchestrator, and so on; the agent used, time, running / succeeded / failed / no end recorded, and a switch to another agent) |
| `get_error_report` | Reads a task's error report (the same Markdown as "Download error report" on the web UI) (`task_id`, `lang`, `offset`, `max_bytes`, `fingerprint`). It only reads and changes nothing. Logs of runs that were not closed are omitted. It cannot ask for an error analysis (do that on the web UI). `errorReportWorthReading` in `get_task` is the hint for whether it is worth reading |
| `get_step_questions` | Reads the "questions to confirm" (must and should) of a requirements or design deliverable awaiting approval, one by one (`task_id`). It only reads and changes nothing. When it cannot read them, it says "could not be read" |
| `approve_step` | Approves a step awaiting approval (`task_id`, `step`, `submission`), the same as "Approve" on the web UI. A step approved by merging a PR cannot be approved here; the PR URL is returned |
| `request_changes` | Requests changes on a step awaiting approval (`task_id`, `step`, `submission`, `comments`), the same as writing only remarks and pressing "Request changes" on the web UI without choosing where to send it back or a cause. There is no limit on the number of requests for changes to the step |
| `wait_for_task` | Waits until one task needs a person (awaiting approval, awaiting a decision, paused, completed, cancelled, or a PR review verdict) (`task_id`, `timeout_seconds`, `cursor`). It only reads and changes nothing |
| `pause_task` | Pauses a task (`task_id`), the same as "Pause" on the web UI. Only for queued, running, awaiting-approval, and under-verification tasks; it does not stop completed or cancelled tasks and the like |
| `resume_task` | Resumes a paused task (`task_id`, `note`, `allow_approved_edits`; the note and permission are optional). It does not resume a stop that needs a budget-cap increase, a decision on the test handling, accepting a child task's cancellation, or choosing the repository to work on, and returns what to decide on the screen |
| `get_cancel_plan` | Reads what would happen if a task were cancelled (`task_id`). Returns the runs to stop, the PRs to close, the branches to delete, whether a workspace and a session exist, and what remains. It only reads and changes nothing |
| `cancel_task` | Cancels a task (`task_id`, `close_pull_requests`, `delete_branches`), the same as "Cancel" on the web UI. **It cannot be undone; it closes PRs and deletes branches and the workspace.** Pass the PRs and branches `get_cancel_plan` returned; it cancels only when they match |
| `rerun_task` | Reruns a cancelled task (`task_id`, `note`; the note is optional), the same as pressing "Rerun" on the web UI with the default values and only a note added. **It creates a new task and starts its steps, and the original task can never be rerun again** |
| `derive_task` | Creates a follow-up task from a completed task (`task_id`, `title`, `body`; all are required), the same as pressing "Create a follow-up task" on the web UI with the repository and the plan left at their defaults and only a title and content entered. **It creates a new task and starts its steps, and each call makes a different task.** The original task does not change. The repository is the original task's and the plan is automatic. For a follow-up of a security-combination task, it refuses and says to use the web UI |
| `rename_task` | Renames a task (`task_id`, `title`; both are required), the same as "Rename the task" in the task details on the web UI. It works in any state except a cancelled task. It does not stop the current run, and the title and branch name of a PR already created do not change |

The filters of `list_tasks` are as follows (all can be omitted; with several, only tasks matching all of them are returned).

| Argument | Description |
| --- | --- |
| `pull_request` | A PR. One of a number (`123`), `owner/repo#123`, or a PR URL |
| `branch` | A branch name (exact match) |
| `repo` | A repository. `owner/repo` or a URL |
| `query` | A string contained in the title, or the beginning of the task ID |
| `open_only` | If `true`, only tasks that are not finished |
| `review_only` | If `true`, only PR review tasks |
| `limit` | The maximum number to return (default 20, maximum 100) |
| `offset` | The position to start reading from (default 0). Pass the `nextOffset` of the result to get the rest |
| `needs_person` | If `true`, only tasks that need a person ([Find the tasks waiting for a person](#find-the-tasks-waiting-for-a-person)) |
| `state` | Filter by state (one or more). The values are those of `state` in the result. An unknown value is rejected |
| `project_id` | Filter by project (the `id` of `list_projects`). A project that does not exist or was deleted is rejected |

An unknown argument (`status`, `project`, and so on) is rejected, not ignored (the reason contains the argument's name).

Finding the task that reviews a PR by the PR number or URL is the reliable way.
You can also search by branch name, but note the following.

- Branches with the same name: searching by branch name alone also finds tasks for a branch of the same name in other repositories (`main`, `patch-1`, and so on).
  Specify `repo` too, or search by the PR URL.
- PRs sacty created: both the task that created the branch and the task that reviews the PR are found.
- PRs created outside sacty: sacty records the branch name when it checks the PR before reviewing.
  Tasks reviewed before this feature was added are not found by branch name until they are re-reviewed once (search by the PR number).

The status of a deliverable is as follows.

| Status | Meaning |
| --- | --- |
| `approved` | The approved version |
| `posted` | The review posted to the PR |
| `awaiting_approval` | The version waiting for approval |
| `not_submitted` | The latest output that is not submitted yet (not the earlier round's submission; the earlier round is in `previousSubmission`) |
| `changes_requested` | The earlier output that remains after a rework request (until the redo finishes) |
| `none` | There is no deliverable (this is not a failure) |

Deliverables from before a rework (earlier rounds) and the agent's original files cannot be read (look at them in the web UI).

Only a task that has posted its review to the PR (done, or watching the PR for changes) can be re-reviewed (`canRereview` in the result of `list_tasks` is `true`).
A PR review task is not done until the verdict becomes "no findings" or the watch ends (the PR is merged or closed, or the parent task is done); meanwhile `state` is `idle` and `review.watching` is `true` ([After the review is posted](intake.en.md#after-the-review-is-posted)).
If you ask for a task under review or a task that is not a PR review, it returns the reason and changes nothing.

## Find the tasks waiting for a person

Ask "Which sacty tasks are waiting for me?" and the AI calls `list_tasks` with `needs_person: true`.

- The condition is the same as "Needs you" on the web dashboard, the header bell, and the cards above the task list. Tasks that are awaiting approval, escalated, or paused, minus those awaiting approval while the AI is deciding where to send back the PR remarks. The number excluded is `excludedAiJudging` in the result.
- They are sorted with the upper group first (`personTurnGroup` is `decision`: awaiting approval, escalated), then the lower group (`paused`). Within a group, the longest wait comes first (by ID when equal). The result's `order` is `personTurnGroup_waitingSince_asc`.
- Each task gets `personTurnGroup`, which says which group it is in, and the time it started waiting (`waitingSince`). If `waitingSinceSource` is `dashboard`, it is the time from the daemon's aggregate; if `updatedAt`, there was no record, so `updatedAt` stands in.
- When the result includes `nextOffset`, pass it as `offset` to get the rest. `nextOffset` is absent once everything has been returned.
- When the wait times cannot be read, it fails with the reason instead of replacing them with `updatedAt`.
- The web UI's status text and color, the link to where a person decides, and the PR conflict note are not shown. Use `state`, `approval`, `asks`, `pausedReason`, and `url`.
- When a task whose `state` is `queued` has `preparing`, sacty is processing it right now before its first step starts (the value is `repository`, `gathering`, `triage`, `planning`, `review_target`, or `starting`; [Status before the first step starts](tasks.en.md#status-before-the-first-step-starts)). When a task whose first step has not started has no `preparing`, it is waiting for its turn and the like. After the first step has started, a task can be processed even without `preparing` (between steps, retrying a failed run, at the start of a re-review, and so on).
- The list is read-only. Approving, requesting changes, resuming, and so on are done only when you ask.

## Approving

`approve_step` approves a step that is awaiting approval (the same as "Approve" on the web UI's approval screen). Approving makes sacty start the next step (it takes time and costs money, and cannot be undone).
The AI calls it only when you ask. It is safer to check the deliverables (`list_deliverables`, `get_deliverable`) before you ask.

- Before approving, `approval` in `get_task` (and in each task of `list_tasks`) shows the step awaiting approval (`step`), the submission number (`submission`), and how to approve (`method`).
  The AI approves with the step and number it checked. If they differ from what is awaiting approval now (an old submission), it does not approve and tells you the current number.
- What it can approve is a step awaiting approval without a PR (an investigation result, an integration result, an implementation with no changes, requirements or design without a PR, and so on; the steps where you press "Approve" in the web UI).
- When it cannot (not awaiting approval, no such task, a step other than the one awaiting approval, an old number, already approved, a reproduction that could not reproduce), it returns the reason and changes nothing.
- A step approved by merging a PR (implementation, requirements or design with a PR) cannot be approved from MCP. `method` in `approval` is `pull_request`; review and merge the PR at `pullRequestUrl` on GitHub (the merge is the approval).
- When no result arrives (a timeout and so on), the step may have been approved. The AI does not retry automatically and checks the state with `get_task`.

## Requesting changes

`request_changes` requests changes on a step that is awaiting approval (the same as writing only remarks, without choosing where to send it back or a cause, and pressing "Request changes" on the web UI's approval screen). Requesting changes makes sacty redo the step (it takes time and costs money, and cannot be undone).
The AI calls it only when you ask. It is safer to ask after it has checked `approval` from `get_task` and the deliverables (`list_deliverables`, `get_deliverable`).

- You specify the task, the step (`step`), the submission number (`submission`), and the remarks (`comments`; 1 or more). The step and submission are the values of `approval`, as with approval. If they differ from the step or submission now awaiting approval (a stale submission), nothing is sent back and the AI is told the current submission.
- Each line becomes one remark (the same as the web UI's field). Surrounding whitespace and empty lines are removed. You can send up to 50 remarks of 2,000 characters each at a time. If only empty remarks are given or the limits are exceeded, nothing is sent back and the reason is returned.
- The step that is redone is the redoable step closest to the step awaiting approval (usually the step awaiting approval itself; task splitting for an integration review). The result's `reworkStep` says which step is redone.
- You cannot specify the cause, the step to send it back to, or a change of the task's image or agents (do those in the web UI).
- There is no limit on the number of human requests for changes to the same step. Requesting changes makes sacty redo the step, which takes time and money, so the AI does it only when asked.
- A task whose status is "escalated" (waiting for a decision on the limit of an earlier version or on a change proposal) cannot be sent back from MCP. Decide on the web UI.
- When it cannot send back (not awaiting approval, no such task, a step other than the one awaiting approval, a stale submission, already sent back, no redoable step), it returns the reason and changes nothing.
- A step that made a PR (implementation, or requirements or design with a PR) can also be sent back. The remarks are not left on the PR and count as a human request for changes. To leave a record on the PR, write a comment on the PR (sacty imports it and sends the step back; [Requesting changes with PR comments](tasks.en.md#requesting-changes-with-pr-comments)). Writing a comment on a PR from MCP is not possible.
- If the result could not be received (a timeout, for example), changes may have been requested. The AI does not retry automatically and checks the state with `get_task` (retrying without checking could request changes twice).

## Pausing

`pause_task` pauses a task (the same as "Pause" in the web UI). The AI calls it only when you ask.

- It can stop a queued, running, awaiting-approval, or under-verification task, and a task that watches the PR for changes after posting a review (the same states in which the web UI shows the "Pause" button; `canPause` of `get_task` is `true`).
- A completed or cancelled task, a task that is already paused, a task awaiting a person's decision (escalation), and a task waiting for another task or for its child tasks are not stopped; it returns the reason and changes nothing.
- A running run is cut off, and resuming starts that step over from the beginning (the cost already spent does not come back).
- Pausing a task awaiting approval stops the approval gate and the PR watch until you resume it (while it is paused, you can neither approve nor request changes).
- If the work finished before the stop and the task reached approval or similar, it does not stop it and says so.
- To stop a running task, sacty stops the container and waits for the process to end, which can take time. Even if no response comes within 30 seconds, the task may be paused later (or may reach approval and not stop). In that case the AI returns "it may have been paused", does not retry automatically, and checks the state with `get_task`. If `state` is the same as before the pause (`running`, `queued`, or `idle` under verification), the pause may still be in progress, so it does not call again and waits with `wait_for_task`. If it is `paused`, the task stopped. If it became `awaiting_approval` or `escalated`, the task did not stop, and the AI tells you.
- Cancelling is done with `cancel_task` ([Cancelling](#cancelling)). When you ask it to "stop", that is pausing, not cancelling.

## Resuming

`resume_task` resumes a paused task (the same as pressing "Resume" in the web UI without changing the cap, tests, image, or agents). The AI calls it only when you ask.
It first checks with `get_task` why the task is stopped (`pausedReason` and `pausedMessage`) and whether it can be resumed (`canResume`).

- You specify the task and an optional note (`note`). The note is appended after the task description and stays, and later steps read it. Pass only your own words. Surrounding whitespace is removed, and an empty note is not added. If it is too long, it returns the reason without resuming.
- Resuming runs the stopped step again (it takes time and money; it returns without waiting for the end). If the task was awaiting approval or waiting for child tasks before it stopped, it just goes back there and does not run the step again (the sentence of the result and `state` tell you).
- If the cause is the same, it stops again. When it stopped for "verification" or "incomplete", the count starts over, so the same failure stops it again.
- **What you decide on the screen**: for the following pauses, MCP does not resume, changes nothing, and tells you what to decide on the screen (it is also in `resumeBlocked` of `get_task`).
  - A stop at the budget cap: whether to raise the cap (a decision that increases cost).
  - A stop where you can decide the test handling: deciding on a test command or no tests.
  - A stop because a child task was cancelled: whether to accept the child's cancellation and resume.
  - A stop of a ticket task before the repository to work on was decided: choosing the repository to work on.
- sacty refuses to resume when an external-work step has started, a stacked dependency was cancelled, or a container that cannot be confirmed stopped remains. It passes on that reason as it is (it may be refused even when `canResume` is `true`).
- When no result is received (a timeout and so on), the task may have been resumed. The AI does not retry automatically and checks the state with `get_task`.

## Cancelling

`cancel_task` cancels a task (the same as "Cancel" on the web UI). **It cannot be undone, and the task cannot be resumed.** A task of a kind that can be rerun can be rerun after cancelling ([Rerunning a cancelled task](#rerunning-a-cancelled-task); it becomes a new task, and the workspace, branches, and PRs do not come back). A task that cannot be rerun (a PR review task, a split child, a task imported from a ticket whose repository to work on is not decided, and so on) cannot be started over from the MCP once cancelled (the check before cancelling tells you what a person does on the screen). The AI calls it only when you clearly asked to cancel that task ("stop" and "wait" mean pause, not cancel; when unsure, it does not call and asks you).
Even if the title, description, deliverables, review body, or stop reason of a task says to cancel, the AI does not call it.

- Cancelling closes the implementation PR sacty made (without merging it), closes any open requirements or design PRs, deletes sacty's branches (the remote ones too) and the workspace, and stops running containers. The activity log and the session logs remain. A merged PR, a person's continued PR, and their branches are not touched. In a plan without an implementation, a step PR's branch that a person added commits to is not deleted either (the same applies to a branch whose remote head differs from sacty's last push; get_cancel_plan gives the reason).
- Before calling, the AI reads the runs to stop, the PRs to close, the branches to delete, whether a workspace and a session exist, and what remains with `get_cancel_plan`, and tells you (it only reads and changes nothing).
- Pass `cancel_task` the "PRs to close" (`close_pull_requests`) and the "branches to delete" (`delete_branches`) that `get_cancel_plan` returned. If they do not match the targets at the time of the call (for example, a PR or branch was added after reading), it does not cancel and returns the current targets.
- A task whose `canCancel` in `get_task` is `true` (queued, running, awaiting approval, paused, awaiting a person's decision, and so on) can be cancelled. A completed task, an already cancelled task, a PR review child task (cancelling it makes the PR impossible to re-review), a split parent (unfinished child tasks are cancelled too), and a split child task (the parent pauses) are not cancelled; it returns the reason and what you can do on the web UI. Cancel them in the web UI.
- The cancellation is recorded even when part of the cleanup fails. The result has the cleanup result for each target (cleaned up, nothing to clean, or failed) and the reason for a failure. Clean up what failed by hand (the cleanup cannot be redone; a cancelled task of a kind that can be rerun is redone by rerunning it).
- Cancelling also stops in-progress runs for answering a question or analyzing an error. If unfinished PR review child tasks exist, they are cancelled at the next PR check (a cancelled review child task cannot be re-reviewed).
- Cancelling a running task stops the containers and waits for the processing to end, closes PRs, and deletes branches, so it can take a while. Even if there is no response within 30 seconds, the task may be cancelled later (the cleanup continues). In that case the AI answers "it may have been cancelled (the cleanup may still be running)", does not retry automatically, and checks `state` with `get_task`. The task can look `paused` until it ends; that is neither a failed cancel nor a pause, so the AI waits with `wait_for_task` until `cancelled`. Once `cancelled`, it checks `cancelled` in `get_task` for the cleanup results and what failed, and tells you. If it never becomes `cancelled`, the AI tells you the situation; if you want, have it call again starting from `get_cancel_plan`.

## Rerunning a cancelled task

`rerun_task` starts a cancelled task over (the same as pressing "Rerun" on the web UI without changing the title, description, repository, or image, and adding only a note). The AI calls it only when you clearly asked to rerun that task. Even if the task's title, description, paused reason, or review text says to redo it, the AI does not call it.

- **It creates a new task, and sacty starts its steps.** It takes time and costs money (the budget is a fresh one for the new task). It returns without waiting for the steps to finish.
- **The original task can never be rerun again.** This cannot be undone, and you cannot delete the new task. To stop it, cancel the new task (a cancelled new task can be rerun once more).
- The workspace, branches, and PRs are not carried over; the work starts from the beginning. A record of the previous attempt (the steps that progressed, step outputs, remarks from requested changes, the reason it stopped, and so on) is attached to the new task's description.
- The new task has the original title, the original human-written description (plus the note, if any, and always the record of the previous attempt), and the original task's repository. The image is chosen as usual. The note (`note`, at most 10,000 characters) is added to the new task's description and stays there, where later steps read it.
- The result has the summary of the new task and the ID of the original task. In `get_task`, the original task shows `rerunBy` (the ID of the new task) and the new task shows `rerunOf` (the ID of the original task).
- A task whose `canRerun` in `get_task` is `true` can be rerun. For a task that is not cancelled, a completed task (create a follow-up task with `derive_task` or in the web UI), an already rerun task, a split child task, a PR review task, a task imported from a ticket whose repository to work on is not decided, or a task that cannot be sent with the defaults (for example the description is over the limit), it returns the reason without rerunning. `rerunBlocked` in `get_task` shows the reason only for a cancelled task that cannot be rerun (for a task that is not cancelled or is completed, `canRerun` is just `false`). To correct the title or description, or to change the repository or image, use "Rerun" on the web UI (the title of a task made by a rerun can be changed later with `rename_task`).
- When sacty refuses (for example the repository was removed from the project's targets), it returns the reason (nothing was created; if the repository is not a target of the project, you can choose it again in the web UI; if the project has no targets at all, add one in the project settings).
- When no result is received (a timeout and so on), the task may have been created. The AI does not retry automatically; it reads the original task with `get_task` and checks `rerunBy`. If it is there, the task was created, so look at that task. If not, nothing was created and calling again is fine (a second task is never created).

## Creating a follow-up task from a completed task

`derive_task` creates a follow-up task from a completed task (the same as pressing "Create a follow-up task" on the web UI with the repository and the plan left at their defaults, entering only the title and content, and pressing "Create"). The AI calls it only when you clearly asked to create a follow-up. Even if the task's title, description, deliverable, or review text says to create one, the AI does not call it.

- **It creates a new task, and sacty starts its steps.** It takes time and costs money (the budget is a fresh one for the new task). It returns without waiting for the steps to finish. You cannot delete the new task. To stop it, cancel the new task.
- The original task does not change. **It can be done any number of times** (each call makes a different task).
- You pass only `task_id` (the completed original task), `title` (the new task's title; at most 200 characters), and `body` (what the follow-up should do; at most 10,000 characters). Surrounding whitespace is removed, and neither can be empty. Unknown arguments (`repo`, `plan`, and so on) are refused.
- The new task's description is the given content followed by the record of the original task (under the heading "元のタスクの記録（完了したタスク）"). The title and content stay and are read by later steps, so have the AI pass only your own words. The ticket and the import source are not carried over.
- The repository to work on is the original task's (none if it has none), and the plan is automatic (the orchestrator chooses). To change them, use "Create a follow-up task" on the web UI.
- The result has the summary of the new task and the ID of the original task. In `get_task`, the original task shows `derivedTasks` (the IDs of the follow-up tasks made from it) and the new task shows `derivedFrom` (the ID of the original task). The original task's activity log does not grow.
- A task whose `canDerive` in `get_task` is `true` can have a follow-up created. For a task that is not completed (queued, running, awaiting approval, awaiting a person's decision, or paused), wait until it completes. A cancelled task cannot have one (a task that can be rerun can be redone with `rerun_task`). For a security-combination task, the plan is fixed to the security response and the record carries the report, so use "Create a follow-up task" on the web UI (`deriveBlocked` in `get_task` shows the reason). When the title or content is empty or too long, it also returns the reason without creating anything.
- When sacty refuses (for example the repository was removed from the project's targets), it returns the reason (nothing was created; if the repository is not a target of the project, you can choose it again with "Create a follow-up task" on the web UI).
- When no result is received (a timeout and so on), the task may have been created. The AI **does not retry automatically** (calling again would create a second one); it reads the original task with `get_task` and checks whether `derivedTasks` has an ID that was not in the `derivedTasks` from before the call (the failure message includes it; "none" if empty). If the title and `derivedFrom` of an added task match this request (the title that was sent and this original task), the task was created, so look at that task (`derivedTasks` also grows on a re-run and on a carried-over review remark, so one that does not match is not from this call). If nothing was added, nothing was created and calling again is fine. On a timeout or a disconnect, the daemon may still be processing, so the AI does not call again right away but waits a little and then checks.

## Renaming a task

`rename_task` renames a task (the same as "Rename the task" in the task details on the web UI). The AI calls it only when you ask it to rename a task.

- It works in any state except a cancelled task (a running, awaiting approval, paused, or completed task can be renamed). The previous title stays in the activity log.
- You pass only `task_id` and `title` (the new title; surrounding whitespace is removed; 1 to 200 characters). The description (body) cannot be changed. The title goes into later step instructions, so have the AI pass only your own words.
- It does not stop the current run. The new title is used from the step instructions, notifications, PR bodies, commits of work delivered after this, and the title of a PR created after this. **The title and branch name of a PR already created do not change.**
- It returns the reason without renaming when: the task is cancelled, the title is empty or too long, the title is the same as now, or the title changes the PR number decided from the title and description (it adds, removes, or changes a PR link) for a task whose working repository is decided (a task imported from a pull request is excluded).
- The result has the title before, the new title, and the summary of the updated task.
- When no result is received (a timeout and so on), the title may have been changed. The AI checks `title` with `get_task`. If it changed, it is done. If not, calling again is fine (a second call with the same title is only refused).

## Waiting for a state change

`wait_for_task` waits until one task needs a person (it only reads and changes nothing).
The AI can wait for awaiting approval, awaiting a person's decision, paused, completed, cancelled, or a PR review verdict without calling `get_task` over and over.

An example of how to wait:

1. **Register**: register `sacty mcp` once, as in [Connecting](#connecting). No setting is needed just for waiting.
2. **Wait**: ask the AI "wait until this task is awaiting approval". The AI calls `wait_for_task` with the `task_id`.
3. **Read what happened**: when something changes, you get what changed (`changes`), the current summary, and the state of the child tasks that review the PR. The AI reads details with `get_task` (a child's review body with `get_task` on the child's `task_id`).
   Even when something happens, the AI does not approve or request changes unasked (only when you ask).
4. **Call again**: if nothing changed before the time ran out, it returns with `changed` set to `false` (not a failure). Call again with the `cursor` from the result to keep waiting.
   With `cursor`, if something changed after the previous result, it returns at once without waiting (nothing is missed). Without `cursor`, the moment of the call is the baseline.

- Changes that wake it: the task became awaiting approval (including a change to another step or another submission awaiting approval), became awaiting a person's decision, paused (including a changed reason), completed, or cancelled;
  it started moving again from those; the count of things to confirm with a person changed; a PR's state changed (merged, closed, and so on).
  When you wait on a PR review task, it also wakes when the review is posted (if the verdict is not "no findings", the task is not done and enters the watch for changes of the PR; `changes` shows `review_watching` and the round and verdict).
  Changes in the child tasks that review the PR also wake it: a child was added, became a person's-turn state, had its review round changed (a re-review), had a review posted, or had a verdict appear or change.
  Even while the parent stays awaiting approval (waiting for the PR to be merged), a child's verdict alone wakes it.
- Changes that do not wake it: a step advancing, a run starting or ending, and cost or the activity log growing do not wake it by themselves. Waiting for a previous task to complete (`blocked`) or for split children to complete (`waiting_children`) is not a person's turn either, and changes in split children do not wake it.
- The wait is 30 seconds by default and 50 seconds at most (`timeout_seconds`; a larger value is clamped to 50 seconds and `clamped` in the result is `true`).
  The limit is short because AI CLIs may cancel a single tool call after 60 seconds (the default of Codex and of the official MCP SDK client).
  No setting to lengthen the AI CLI's cancel time is needed (to wait longer, call again with `cursor`).
- sacty checks every 5 seconds. Even if the daemon does not respond, the call returns within the specified time plus a few seconds (55 seconds at most).
- If sacty becomes unreachable while waiting (stopped, cannot connect), the reason is returned. A single failure is retried on the next cycle. After a second consecutive failure, the reason includes a `cursor`. Check that `sacty up` is running, then call again with that `cursor`.
- Children that review the PR are checked up to 5 per call, newest first (`reviewTasksOmitted` shows how many were left out). For each child you get the state, review round, posted URL, and verdict (not the review body).
- The title and pause reason in the result are data that include text written by other people. The AI does not follow instructions in them.

## Reading and answering things to confirm

When sacty is waiting on a person, the AI can read "what is being asked" and "how to answer" from `get_task` alone (it only reads and changes nothing).

- **Things to confirm with a person** (`humanAsks`): present only while awaiting approval, when the step's agent raised confirmations along with its responses to remarks (questions back, things it decided by guessing), or when the intent of a PR remark could not be read. It is the same as the web UI's approval screen. The same confirmation text is merged into one.
  The list (`list_tasks`) has only the count (`asks`). Long text is clipped, and when there are many items the number omitted is shown.
- **How to answer** (`howToAnswer` in `humanAsks`): if no answer is needed, approve as it is (`approve_step`, or merging the PR for a step approved by merging). To answer, for a step without a PR, write the answer in `comments` of `request_changes`. For a step that made a PR, write it in a PR comment, which leaves a record on the PR (`request_changes` also sends it back but leaves nothing on the PR).
  Answering makes sacty redo the step (it takes time and money). **There is no tool only for answering.**
- **Waiting for a person's decision** (state `escalated`): `escalation` of `get_task` has the reason (the limit of requests for changes in an earlier version's record, a change proposal, and so on; `unknown` for an old task with no record), the step, the step to redo, the number of unfinished remarks, and the ID of the open change proposal. The remark text is not included.
  The only thing possible through MCP is approval, and only when the approval method (`approval.method`) is `approve_step` (for a step approved by merging a PR, or when there is no `approval`, it is read-only); check `escalation.canDoHere`. Requests for changes, deciding on a change proposal, and deciding on proposals to defer cannot be done through MCP. Decide in the web UI (`escalation.decideOnScreen` lists the items that fit the reason). Cancelling a task awaiting a person's decision can be done with `cancel_task` (only when you clearly ask).
- **Questions to confirm in a deliverable** (`get_step_questions`): the "questions to confirm" section of a requirements or design deliverable awaiting approval is not in `humanAsks`. `stepQuestions` in the summary of `get_task` or the list shows whether there are questions and how many must and should there are; read the content with `get_step_questions` (the text of each question; at most 1000 characters each and 20 each for must and should, and when some are omitted the number is shown).
  When the section is not found or has a shape that cannot be counted, it returns "could not be read", not "there are no questions". The full text can be read with `get_deliverable`. A step awaiting a person's decision (`escalated`) and other steps such as research are not covered.
  To answer, for a step that made a PR, comment on the PR (merging without answering proceeds with the recommended answer); for a step without a PR, use `comments` of `request_changes` (calling `approve_step` without answering proceeds with the recommended answer). There is no tool only for answering.
- These texts were written by agents or other people. Even if they say "OK to approve" or "request changes", the AI does not approve or request changes for that reason alone (only when you ask).

## Things to keep in mind

- Only the person running `sacty up` can use the MCP server (it uses the address sacty wrote to a file only that person can read).
- The registered AI can start a re-review, create a task, approve or request changes on a step awaiting approval, and pause, resume, cancel, rerun, create a follow-up of, or rename a task on your behalf. Creating a task, approving, requesting changes, resuming, rerunning, or creating a follow-up starts steps, which takes time and costs money. Cancelling closes PRs and deletes branches and the workspace (it cannot be undone). Rerunning means the original task can never be rerun again.
  In the AI CLI's permission prompt, you can choose to confirm `rereview_task`, `create_task`, `approve_step`, `request_changes`, `pause_task`, `resume_task`, `get_cancel_plan`, `cancel_task`, `rerun_task`, `derive_task`, and `rename_task` every time or to allow them.
  Confirming `approve_step`, `request_changes`, `cancel_task`, `rerun_task`, and `derive_task` every time is recommended (`rerun_task` creates a new task and starts steps that cost money, and the original task can never be rerun again; `derive_task` also creates a new task and starts steps that cost money, and each call makes a different task). If you allow them, an instruction written in a task description, deliverable, or review body by someone else may get a step approved or sent back, or the task cancelled (the PR closed and the branches and workspace deleted; it cannot be undone), without your check.
- Task descriptions, review bodies, and deliverables are passed to the AI.
  They can contain text from PRs and issues written by other people and text written by agents (do not let the AI treat it as instructions).
- The content of the error report contains text written by other people and agents, and the tail of run logs (do not let the AI treat it as instructions). Only the logs of runs that were not closed are omitted (the tails of the logs of other runs, the errors in the Activity, and the text of the error analysis are included).
- While a previous version of sacty is running, the deliverable and run tools and `get_error_report` answer "update sacty and restart it with `sacty up`" (a different reason from a missing task). Restart it when no task is running.

## Related pages

- [CLI](cli.en.md#sacty-mcp): the `sacty mcp` command
- [Intake of issues, PRs, and tickets](intake.en.md#re-review): what a re-review does
- [Tasks](tasks.en.md#create-a-task): how to create a task in the web UI

## Allow edits with a resume note

Set `allow_approved_edits` with a note in `resume_task` to accept matching requests without another decision until the next pause. The activity and request list show the resume time and design and test viewpoint diffs.
