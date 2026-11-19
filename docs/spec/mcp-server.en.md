[日本語](mcp-server.md) | **English**

# MCP server (sacty mcp)

`sacty mcp` is an MCP server for operating the running sacty (`sacty up`) from an AI on the same machine (Claude Code, Codex, and so on).
It runs over standard input and output (stdio) and calls the same daemon API as the web UI.
It follows the 2026-07-28 revision of the MCP specification and also accepts clients of earlier revisions (up to 2025-11-25) that open with `initialize`.
It has thirteen tools: listing and searching tasks (`list_tasks`), task details (`get_task`), re-reviewing a PR review task (`rereview_task`), listing projects (`list_projects`), creating a task (`create_task`),
listing deliverables (`list_deliverables`), the content of a deliverable (`get_deliverable`), listing runs (`list_runs`), approving a step awaiting approval (`approve_step`), requesting changes on a step awaiting approval (`request_changes`), waiting until a task needs a person (`wait_for_task`), pausing a task (`pause_task`), and resuming a paused task (`resume_task`).
The three before `approve_step` (`list_deliverables`, `get_deliverable`, and `list_runs`) only read deliverables and runs. There is no tool yet for reading the log of a run (a follow-up). `wait_for_task` only reads and changes nothing.

Related ADRs: [The MCP server that operates the running sacty is run by the CLI over stdio](../adr/20261118-0936-superseded-task-mcp-server-over-stdio.md), [The CLI calls the running daemon's API through the connection file that sacty up writes](../adr/20261014-0701-cli-daemon-connection-file.md), [The MCP create-task tool sends the same request as the web UI's defaults and reports that a task may have been created when no result arrives](../adr/20261119-0100-mcp-create-task-like-screen-with-uncertain-result.md), [Reading deliverables and the run list through sacty mcp sets limits and positions in bytes and adds read APIs to the daemon](../adr/20261119-0200-mcp-read-deliverables-and-runs-by-byte-range.md), [Approval through sacty mcp is limited to the same API as the web UI's Approve button and does not merge PRs](../adr/20261119-0300-mcp-approve-with-screen-api-not-merge.md), [Requesting changes through sacty mcp is limited to the basic form and stops before the limit](../adr/20261119-0400-mcp-request-changes-basic-stop-before-limit.md), [The sacty mcp wait tool polls from the MCP layer instead of adding a wait API to the daemon, and wakes only when a person's turn comes](../adr/20261119-0700-mcp-wait-for-task-poll-in-mcp-layer.md), [Resuming through sacty mcp is the minimal form with only a note, and pausing a completed task is refused in the MCP layer](../adr/20261119-0800-mcp-pause-resume-minimal-resume.md)

## Startup and connection

- `sacty mcp` creates an MCP server (name `sacty`, version taken from `packages/cli/package.json`) and connects it to standard input and output.
  Standard output is used only for the MCP exchange (nothing else is written to it; SDK error reports go to standard error). It ends when the other side closes standard input.
- It runs on `serveStdio` of v2 of the official SDK (`@modelcontextprotocol/server`). The opening exchange decides which revision is spoken.
  - A client that sends its revision with each request (2026-07-28; no handshake) is answered in that revision. `server/discover` returns the supported revision (`2026-07-28`), the capabilities (`tools`), and the usage instructions.
  - A client that opens with `initialize` is answered by the rules of the earlier revisions (up to 2025-11-25) for that connection.
  - The daemon's other MCP parts (the gateway relays; [Gateway](gateway.en.md)) stay on v1 of the SDK (`@modelcontextprotocol/sdk`).
- It does not query the daemon at startup. It can start even when sacty is not running.
- On every tool call, it reads the address and token from `SACTY_HOME/daemon.json` ([Daemon startup and shutdown](daemon-lifecycle.en.md)) and calls the daemon API.
  Restarting `sacty up` changes the token, but the next call uses the new address and token (the MCP server does not need a restart).
- It waits up to 30 seconds per request (`MCP_REQUEST_TIMEOUT_MS`) for the daemon's response (including reading the body).
- No authentication is added (the MCP authorization specification is for HTTP; on stdio the rule is to take credentials from the environment). Only a user who can read `daemon.json` (mode 0600) can use it.
- It calls the following APIs ([Overall structure](architecture.en.md#processes-and-communication)). `list_tasks`, `get_task`, `rereview_task`, `list_projects`, `create_task`, `approve_step`, and `request_changes` call the same APIs as the web UI. `list_deliverables`, `get_deliverable`, and `list_runs` call read-only APIs (their three rows in the table below; the web UI does not call them). `wait_for_task` calls only `GET /api/tasks/:id`, the same as `get_task` (no wait API is added to the daemon). `pause_task` and `resume_task` call the same APIs as the web UI (no new API is added).

| Tool | Daemon API |
| --- | --- |
| `list_tasks` | `GET /api/tasks`, `GET /api/projects` |
| `get_task` | `GET /api/tasks/:id` |
| `rereview_task` | `GET /api/tasks/:id`, `POST /api/tasks/:id/rereview` |
| `list_projects` | `GET /api/projects` |
| `create_task` | `POST /api/tasks` |
| `list_deliverables` | `GET /api/tasks/:id/deliverables` |
| `get_deliverable` | `GET /api/tasks/:id/deliverables/:step/:kind?offset=&max=` |
| `list_runs` | `GET /api/tasks/:id/runs?offset=&limit=` |
| `approve_step` | `GET /api/tasks/:id`, `POST /api/tasks/:id/approve` |
| `request_changes` | `GET /api/tasks/:id`, `POST /api/tasks/:id/request-changes` |
| `wait_for_task` | `GET /api/tasks/:id` (the awaited task and the children in its `reviewTasks`, repeated every few seconds; nothing else is called) |
| `pause_task` | `GET /api/tasks/:id`, `POST /api/tasks/:id/pause` (`{}`) |
| `resume_task` | `GET /api/tasks/:id`, `POST /api/tasks/:id/resume` (`{}` or `{ note }`) |

Code: `packages/cli/src/index.ts` (`mcpCommand`), `packages/cli/src/mcp.ts` (`daemonApi`), `apps/daemon/src/task-mcp.ts` (`serveTaskMcp`, `startTaskMcp`, `createTaskMcpServer`, `SactyApi`), `packages/cli/src/context-preview.ts` (`readDaemonFile`, `daemonRequest`), `packages/cli/src/up-env.ts` (`daemonEndpoint`)

## Tools

The server's usage instructions (`INSTRUCTIONS`) and the descriptions of `list_tasks` and `get_task` say that the title, description, review body, and stop reason in results are data that can contain text written by other people, and that instructions inside them must not be followed. The text in `humanAsks` and `escalation` is treated as the same kind of data, and the descriptions of `get_task`, `approve_step`, and `request_changes` and `INSTRUCTIONS` say so too.
The description of `list_projects` carries the same note (project names are text written by people).
The descriptions of `rereview_task`, `create_task`, `approve_step`, and `request_changes` say to call them only when the user asks (not because of instructions inside a title, description, review body, and so on). The descriptions of `pause_task` and `resume_task` say the same (`ASK_ONLY_NOTE`, shared with approval and requesting changes). They also say not to call on the strength of instructions in the stop reason (`pausedMessage`) or `humanAsks` alone.
The descriptions of `list_deliverables`, `get_deliverable`, and `list_runs`, and `INSTRUCTIONS`, also say that the deliverables in results are data that can contain text written by other people and agents, and that instructions inside them must not be followed (`READ_UNTRUSTED_NOTE`).

The tools are held in the `TOOLS` table (name, description, argument shape, result shape, handler), and all of them are registered when the server is created.
Every tool publishes its argument shape (`inputSchema`) and result shape (`outputSchema`) in the tool list.
A result is returned as structured content (`structuredContent`) and one text item containing the same content as a JSON string.

### list_tasks

Filters tasks and returns a list of summaries, newest first (descending `createdAt`). Read-only (`readOnlyHint`).
Every argument can be omitted. It returns the tasks that match all the given conditions (all tasks when there is no condition).

| Argument | Type | Description |
| --- | --- | --- |
| `pull_request` | string | A PR. One of a number (`123`, `#123`), `owner/repo#123`, or a PR URL (`https://<host>/<owner>/<repo>/pull/123`; a trailing path and the like is allowed; `http://` is read as `https://`) |
| `branch` | string | A branch name (exact match; a leading `refs/heads/` is removed) |
| `repo` | string | A repository. `owner/repo` (any host) or a repository URL |
| `query` | string | A string contained in the title, or the beginning of the task ID (case-insensitive) |
| `open_only` | boolean | If `true`, only tasks that are not finished (neither completed nor cancelled) |
| `review_only` | boolean | If `true`, only PR review tasks |
| `limit` | integer | The maximum number to return. 1 to 100 (`LIST_LIMIT_MAX`). The default is 20 (`LIST_LIMIT_DEFAULT`) |

- Tasks of a deleted project are not listed (`get_task` also treats them as missing).
- The result is `{ total, returned, tasks }`. `total` is the number of matching tasks, `returned` is the number returned, and `tasks` holds [task summaries](#task-summary).
- If `pull_request` cannot be read, it returns the reason (and no list).
- The PR condition: one of the [PRs tied to the task](#prs-and-branches-tied-to-a-task) has the same number.
  When the repository is given (`owner/repo#123` or a URL), the repository must also be the same. With only a number, any repository matches.
- The branch condition: either of the following holds. The repository is not checked (a task for a branch of the same name in another repository also matches; combine with the `repo` condition to narrow down).
  - The [branches tied to the task](#prs-and-branches-tied-to-a-task) include that name.
  - The PR the task reviews is the same as another task's PR on that branch (a PR that task created or took over, not one it reviews; a PR a task was imported from is not included, because no branch is recorded for it).
    This finds the review child task of a PR sacty created from the parent's branch name.
- The repository condition: one of the task's target repositories (`repository.url`, `repo`, `repos`, `source.repo`) or the repositories of its tied PRs is the same.

### get_task

Returns the details of a task. Read-only. The argument is `task_id` (the whole task ID).

- The result is the [task summary](#task-summary) plus the following.
  - `body`: the description (the part beyond 4000 characters is omitted).
  - `pausedMessage`: the text of the reason it is stopped (in Japanese; only when present).
  - `reviewBody`: the output of the review step (the review body; the part beyond 12000 characters is omitted; only when present).
  - `previousReview`: the previous round of review (round, URL of the post, time, and the head commit reviewed; only when present).
  - `reviewHeadCommit`: the head commit of the PR reviewed in the current round (only after the target is resolved).
  - `costUsd`: the cost used (`budget.usedUsd`).
  - `recentActivity`: the time, actor, and event type of the last 30 Activity events (without their contents). `activityCount` is the total number.
  - `humanAsks`: only while awaiting approval and there is something to confirm with a person ([Things to confirm with a person](#things-to-confirm-with-a-person)).
  - `escalation`: only when the state is `escalated` ([Why a person's decision is awaited](#why-a-persons-decision-is-awaited)).
  - `resumeBlocked`: only when the task is paused and `resume_task` cannot resume it. `reason` (the reason sentence) and `decideOnScreen` (what a person decides on the screen).
- If the task does not exist (including tasks of a deleted project), it returns the reason.

### rereview_task

Puts a PR review task into re-review. The argument is `task_id`.
It calls the same API as "Re-review" in the web UI, so the result is the same (it records `ReviewRestarted` with actor `person`, reviews the latest commit of the PR again, and posts it. [Tasks and steps](tasks-and-steps.en.md#pr-review-only-tasks)).

- Once started, it returns a message and the [task summary](#task-summary) after starting (it does not wait for the review to finish).
- It first checks with `GET /api/tasks/:id` that the task exists. If it does not (including tasks of a deleted project), it answers that the task was not found and does not call the re-review API.
- When the result cannot be received after calling the re-review API (a timeout, a dropped connection, an unreadable body), it answers with that reason followed by a note that the re-review may have started and to check with `get_task` before calling again (the daemon may have recorded it before the response failed to arrive). When the daemon refuses in its response (`DaemonRefusal`), only the reason for the refusal is returned.
- It works only for a task that posted its review to the PR and completed (`canRereview` in the summary is `true`).
  For a task that cannot be re-reviewed or does not exist, it returns the text of the reason the daemon refused and records nothing.
- The tool annotations say it is not read-only (`readOnlyHint: false`) and writes outside sacty (`openWorldHint: true`).

### list_projects

Returns the projects that have not been deleted. Read-only (`readOnlyHint`). It takes no arguments.
It is used to specify which project `create_task` creates the task in.

- The result is `{ projects }`. Each entry has `id` (passed as `project_id` to `create_task`), `name`, and `targets` (the project's targets: `scope`, which is `org` (a whole organization) or `repo` (one repository), and the target's URL `target`).
  Other project settings (context, tickets, GitHub accounts, and so on) are not included.
- A deleted project does not appear, because the daemon removes it with its definition.

### create_task

Creates a task in a given project from a title and a description.

| Argument | Type | Description |
| --- | --- | --- |
| `project_id` | string (required) | The ID of the project to create the task in (`id` from `list_projects`) |
| `title` | string (required) | The title. 1 to 200 characters after trimming (`TASK_TITLE_MAX`) |
| `body` | string | The description. Up to 10000 characters after trimming (`TASK_BODY_MAX`). Empty if omitted |

- It is the same as "Create task" in the web UI with no template, the target repository left blank, and the approach left at "Automatic".
  It sends `{ projectId, title, body, repo: null }` to `POST /api/tasks` (`repo: null` means no repository, even for a project with exactly one repository target, like a blank field in the web UI). It does not send an approach, a template, or per-step settings.
  The record (`TaskCreated`, with actor `person` and `start: "sacty"`) and how the steps start (the orchestrator chooses the approach) are the same as in the web UI.
- Once created, it returns a message and the [task summary](#task-summary) of the new task (including its ID and the web UI URL). It does not wait for the steps to finish. The returned ID can be passed straight to `get_task`.
- When it cannot create the task, it returns the reason and creates nothing.
  - A title that is empty after trimming, a title that is too long, and a description that is too long are refused before the API is called, with the same check as the web UI (`CreateTaskInput`; lengths are counted after trimming, and the argument schema only checks that `title` and `project_id` are non-empty; the upper limits and emptiness after trimming are checked by `CreateTaskInput`).
  - A missing or deleted project is refused by the daemon with `project.notFound` (409). The reason is "Project not found." (in Japanese).
  - For the daemon's `invalid_input` (400), it returns the messages in `issues` rendered in Japanese (the same applies when a daemon of an earlier version refuses the input).
- When the result cannot be received after calling the create API (a timeout, a dropped connection, an unreadable body, or a 5xx from the daemon), it answers with that reason followed by a note that the task may have been created and to check with `list_tasks` (the title in `query`) before calling again (the daemon may have recorded it before the response failed to arrive; the create API has no mechanism to prevent a duplicate). When the daemon refuses in its response (`DaemonRefusal`, other than a 5xx), when authentication fails (401), when the connection is refused, and when it fails before calling (no `daemon.json`), nothing was processed, so only the reason is returned.
- Daemons of earlier versions: `POST /api/tasks` and `GET /api/projects` were not added for MCP, so earlier daemons have them. If a call does not go through, it returns the reason the daemon refused (the status code if that cannot be read), and the MCP server does not exit.
- The tool annotations say it is not read-only (`readOnlyHint: false`), not destructive (`destructiveHint: false`), not idempotent (`idempotentHint: false`), and writes outside sacty (`openWorldHint: true`; the steps that start write to PRs and so on).

### approve_step

Approves a step that is awaiting approval (the same as "Approve" on the web UI's approval screen).

| Argument | Type | Meaning |
| --- | --- | --- |
| `task_id` | string (required) | The task ID |
| `step` | step name (required) | The step to approve (`approval.step` from `get_task`) |
| `submission` | integer, 1 or more (required) | The submission number to approve (`approval.submission` from `get_task`) |

- It only sends `{ step, submission }` to `POST /api/tasks/:id/approve`, the same request the web UI sends. The decision (`service.approve`), the record (`StepApproved`, actor `person`), and how the next step starts are the same as in the web UI. There is no MCP-only route or record. Wherever the web UI refuses, it refuses for the same reason.
- When approved, it returns a sentence, the approved target (`approved`: `taskId`, `step`, `submission`), and the [task summary](#task-summary) after approval (it does not wait for the next step to finish).
- The caller specifies the submission to approve (so an old submission is not approved by mistake). If it differs from the step and number now awaiting approval, nothing is approved and the reason is returned. For an old number the reason includes the current number and tells the caller to check again with `get_task` (the daemon's "refresh the screen" wording does not fit an MCP user, so the MCP layer replaces it).
- Only steps approved on screen (awaiting approval without a PR) can be approved. A task not awaiting approval (running, paused, completed, cancelled, and so on), a missing task (including a task of a deleted project, checked first with `GET /api/tasks/:id`), a step other than the one awaiting approval, an old number, a reproduction that could not reproduce, and a repeated call (the second is "not awaiting approval" or a different number) get the daemon's reason, and nothing is recorded.
  A decision waiting after the changes-requested limit (`escalated`) can be approved, as in the web UI.
- A step approved by merging a PR (implementation, requirements or design with a PR) is not approved. The daemon's reason (merging the PR is the approval, and the PR URL) is returned. Merging a PR from MCP is out of scope for this version (it writes to GitHub; see the [ADR](../adr/20261119-0300-mcp-approve-with-screen-api-not-merge.md)).
- To check before approving, the task summary (`list_tasks`, `get_task`, and others) has `approval`. It appears only while awaiting approval (`awaiting_approval`, `escalated`) and has `step` (the step awaiting approval), `submission` (the submission number awaiting approval; 0 if none), and `method` (`approve_step`: this tool can approve; `pull_request`: merging the PR approves, and the PR to merge is `pullRequestUrl`; `not_approvable`: a reproduction that could not reproduce; request changes or cancel).
- When no result arrives after calling the approval API (timeout, connection dropped, body unreadable, or the daemon returned 5xx), the result says: the step may have been approved, it is not retried automatically, and check with `get_task` before calling again. The text before that guidance is the daemon's reason (such as the status code) for 5xx, and a fixed sentence ("The approval result could not be received (timeout, disconnect, etc.)") for a timeout, a dropped connection, or an unreadable body. The original exception's text ("try again" and the like) is not used because it contradicts the guidance. When the daemon refuses in a response, authentication fails (401), the connection is refused, or the call fails before sending, nothing was approved, so only the reason is returned.
- Earlier daemon versions: `POST /api/tasks/:id/approve` has long existed, so it works with an earlier daemon. If it fails, the daemon's reason (or the status code if unreadable) is returned. `approval` is built by the MCP layer, so it is present with an earlier daemon too.
- The description says to call it only when the user asks, that approving starts the next step (it takes time and money and cannot be undone), to check the deliverables first with `list_deliverables` and `get_deliverable`, and to check with `get_task` before calling again. `INSTRUCTIONS` says the same.
- Annotations: not read-only (`readOnlyHint: false`), not destructive (`destructiveHint: false`), not idempotent (`idempotentHint: false`; the second call is refused), and may write outside sacty (`openWorldHint: true`; the next step may write).

### request_changes

Requests changes on a step awaiting approval (the same as writing only remarks, without choosing where to send it back or a cause, and pressing "Request changes" on the approval screen).

| Argument | Type | Meaning |
| --- | --- | --- |
| `task_id` | string (required) | The task ID |
| `step` | step name (required) | The step to send back (`approval.step` from `get_task`) |
| `submission` | integer, 1 or more (required) | The submission number to send back (`approval.submission` from `get_task`) |
| `comments` | array of strings (required; 1 or more) | Remarks on what to fix |

- It sends only `{ step, submission, comments }` to `POST /api/tasks/:id/request-changes`. The decision (`service.requestChanges`), the record (`ChangesRequested`, actor `person`, no `cause`, `overLimit` false), and how the rework starts are the same as in the web UI. There is no MCP-only path or record. `target`, `cause`, `answer`, `image`, `agents`, and `continueOverLimit` are not arguments and are not sent (the step to redo is the default: the redoable step closest to the step awaiting approval, usually the step awaiting approval itself, or task splitting for an integration review).
- On success it returns a message, the target of the request (`requested`: `taskId`, `step`, `submission`, the step that will be redone `reworkStep`, and the number of remarks `comments`), and the [task summary](#task-summary) after the request (it does not wait for the rework to finish).
- The caller specifies the submission (so a stale submission is not sent back by mistake). If the step or submission differs from the one now awaiting approval, nothing is sent back and the reason says which submission is current and to check again with `get_task` (the wording says "did not request changes").
- Shape of the remarks: each string in `comments` is split at line breaks into one remark per line, surrounding whitespace is removed, and empty lines are dropped (the same as the web UI's field; each becomes one remark and no line break remains inside one). If none remain, nothing is sent back and the reason is returned. The limits are the same as the API's: 50 remarks and 2,000 characters each (measured after removing surrounding whitespace). Over the limits, nothing is sent back and the reason is returned. The text of the remarks is not copied into reasons or standard error.
- Changes can be requested only while the status is `awaiting_approval`. Before calling the API, the MCP layer checks the task from `GET /api/tasks/:id` (`checkRequestChanges`; a read-side copy of the daemon's `gateTask` and `requestChanges` and of the web UI's request-changes field; update it when those change). The order is: not found (including a task of a deleted project), `escalated`, not awaiting approval, a step other than the one awaiting approval, a stale submission, no redoable step (such as the result of work after an operation ran; the API's `gate.invalidTarget`), empty remarks, too many or too long remarks, and the limit. In every case nothing is recorded and the status does not change. For a repeated call, the second is refused because the task is no longer awaiting approval (or the submission differs), and the record stays at one.
- A task whose status is `escalated` (waiting for a decision on the limit or on a change proposal) is not sent back, whatever the reason; the reason says a person decides on the screen.
- **It does not request changes over the limit**: when human requests for changes to the step to redo have reached `MAX_CHANGE_REQUESTS` (3) (`changeRounds`: the number of rounds with at least one human remark; rounds with only AI review remarks are not counted, as in the web UI), the API is not called. The reason says the limit is reached and that a person decides on the screen whether to continue. The task stays `awaiting_approval` and nothing is added to the activity log. Because the API does not refuse a request to a step at its limit but escalates the task (`TaskEscalated`), the request is refused before it is sent. There is no way to send `continueOverLimit`.
- If, after the check, the status changes and the task in the API's result is `escalated`, it does not say "requested changes"; it says the task was escalated (waiting for a person) without being sent back.
- A step that made a PR (implementation, or requirements or design with a PR) can also be sent back, as in the web UI (unlike approval, the API does not refuse). The remarks are not left on the PR and count as a human request for changes. To leave a record on the PR, write a comment on the PR (sacty imports it and sends the step back; see [Approval](approval.en.md)). Writing a comment on a PR from MCP is out of scope.
- If the result cannot be received after calling the API (timeout, connection dropped, body unreadable, or the daemon returned 5xx), the reason says changes may have been requested, that it does not retry automatically, and to check with `get_task` before calling again (`CHANGES_UNCERTAIN`; retrying could request changes twice or use up the count toward the limit). The sentence before that guidance is the daemon's reason (such as the status code) for 5xx, and the fixed sentence "The result of requesting changes could not be received (timeout, disconnection, and so on)." (in Japanese) for timeout, disconnection, or unreadable body. If the daemon refused in its response, authentication failed (401), the connection was refused, or the failure came before the call, changes were not requested, so only the reason is returned.
- Daemon from a previous version: `POST /api/tasks/:id/request-changes` has existed for a long time, so it works with a previous daemon. If it does not, the reason the daemon refused (or the status code if unreadable) is returned.
- The description says to call it only when the user asks, that requesting changes makes sacty redo the step (it takes time and costs money, cannot be undone, and human requests for changes to the same step are limited to 3, which the tool does not exceed), to check `approval` from `get_task` and the deliverables (`list_deliverables`, `get_deliverable`) first, that a step with a PR can also be sent back by a PR comment (which leaves a record on the PR), and to check with `get_task` before calling again. `INSTRUCTIONS` says the same.
- The annotations are: not read-only (`readOnlyHint: false`), not destructive (`destructiveHint: false`), not idempotent (`idempotentHint: false`), and may write outside sacty (`openWorldHint: true`; the rework writes).

### list_deliverables

Lists the deliverables of a task, step by step. Read-only (`readOnlyHint: true`, `openWorldHint: false`; the same for the next two tools). The argument is `task_id`.
It covers what the web UI's task detail shows: for each step, the approved version if there is one, otherwise the latest output. For the review step, the body and the comments on lines.
Deliverables from before a rework (earlier rounds) and the agent's original files (`agent-files`) cannot be read.

- The result is `{ deliverables }`. Each entry has `step`, `kind`, `submission`, `previousSubmission`, `status`, and `bytes` (the size of the body in UTF-8 bytes). A task with no deliverables yet returns an empty list that is not an `isError`.
- `kind` has four values: `output` (the body: the approved version, otherwise the latest output), `test_viewpoints` (the JSON of the design step's test viewpoints), `sacty_version` (sacty's version when a person edited it), and `review_comments` (the comments on lines of the review, one `<file>:<line>` and body each).
- Only pairs with a non-empty body are listed. Steps come in the task's step order, then the other steps.
- `status` is decided from the top row of the table below down, using the first row that matches.

| `status` | Condition | `submission` |
| --- | --- | --- |
| `approved` | The step is approved (`approved[step]`) | The approved submission number |
| `posted` | Review step, and the review is posted to the PR (`reviewPost`) | The review round (`reviewRound`; 1 if absent) |
| `not_submitted` | Review step, and not posted yet | null (`previousSubmission` is `reviewRound` − 1; null if below 1) |
| `awaiting_approval` | The approval gate is at the step (`gate.step`) | The gate's submission number |
| `not_submitted` | The step's last run completion (`AgentRunCompleted`) is after its last submission (`StepSubmitted`) | null (`previousSubmission` is the number of submissions so far; null if none) |
| `changes_requested` | None of the above, and an output remains (after a rework request, until the redo completes) | The number of submissions |
| `none` | No body (a candidate step with no output, `sacty_version` of a step with no human-edited version, `test_viewpoints` outside design, `review_comments` outside review) | null |

- An output that is not submitted yet (`not_submitted`) has a null `submission`, and the earlier round is shown in `previousSubmission`, so it is not mistaken for the earlier submission.

### get_deliverable

Reads the content of a deliverable by range.

| Argument | Type | Meaning |
| --- | --- | --- |
| `task_id` | string (required) | The task ID |
| `step` | enum (required) | The step (`investigate`, `review`, `requirements`, `design`, `split`, `integrate`, `reproduce`, `implement`, `deployment`, `document`, `operation`) |
| `kind` | enum (required) | The kind of deliverable (the four above) |
| `offset` | integer (0 or more) | The position to start reading (bytes). 0 if omitted |
| `max_bytes` | integer (1 or more) | The most to return (bytes). 32,000 if omitted (`RANGE_MAX_BYTES`). A larger value is clamped to 32,000 |

- The result has `step`, `kind`, `submission`, `previousSubmission`, `status`, `text` (the range of the body), and the [range fields](#ranges-and-results).
- A pair that is a candidate but has no body returns `status: none`, an empty `text`, and `totalBytes: 0`, not an `isError`.
- A step or kind that is not a candidate is rejected by the argument enum in the SDK. The daemon API rejects it with a 404 of `{ error: "not_found", what: "step" }` or `"kind"` (inherited properties such as `constructor` are not looked up).
- The daemon takes the body from the task in memory and returns only the UTF-8 range. It is the same source the web UI shows, and secrets were already hidden before it was written to the activity log. Nothing is hidden again for MCP (no more is shown than in the web UI).

### list_runs

Lists the agent runs, newest first. The arguments are `task_id`, `offset` (0 or more; default 0), and `limit` (1 or more; default 20; a value over 100 is clamped to 100).

- Every run that has a log link in the web UI: collected from the activity-log rows whose `runId` can be picked by the same rule as the web UI (`RUN_EVENTS`, `runLogId`; `@sacty/core`). This includes steps, the orchestrator, the guardian, exports, and audits. Rows without a `runId` are not listed.
- The result has `total` (the number of runs), `returned`, `clipped` (whether the count limit cut the list), `clamped` (whether `limit` was clamped), `nextOffset` (the `offset` for the rest; null when there is none), and `runs`.
- Each entry has `runId`, `role`, `agentId`, `startedAt`, `state`, and `fallback`.
  - `role`, `agentId`, `startedAt`: the run record's (`meta.json`) value if it has one. Otherwise taken from the first activity-log row for that `runId` (the role decided from `step` or the event type, the `agentId`, and the time). null if neither has it.
  - `state`: `running` (the daemon has it open), `succeeded` or `failed` (the `outcome` in `meta.json`; without `meta.json`, the activity log's `AgentRunCompleted` or `AgentRunFailed`), or `unknown` (`meta.json` has no finish time and it is not open, or neither record exists).
  - `fallback`: `{ from, to }` (the agents before and after the switch) for a run that switched to another agent; null otherwise. It is decided from the whole activity log, before cutting into pages. The failed run is the `runId` in `AgentFellBack`. The run that ran instead is the first later run whose role equals the `role` in `AgentFellBack` and whose `agentId` is the fallback agent (`meta.json` is not used). The value is the same from any page.
- `meta.json` is read only for the entries returned (at most 100), for the role, agent, and state. The content of a log is not read.
- If runs are added while you fetch the rest, positions shift and the same run can be returned twice (drop duplicates by `runId`).

### Ranges and results

The content of a deliverable returns at most 32,000 bytes (UTF-8; about 10,000 Japanese characters) per call. Positions and sizes are UTF-8 bytes of the body.

| Result field | Meaning |
| --- | --- |
| `offset` | The position of the start of what was returned |
| `next` | The position to continue from (the end of what was returned). Pass it as `offset` to read on |
| `totalBytes` | The total size |
| `clipped` | Whether it was cut (whether more remains) |
| `clamped` | Whether `max_bytes` exceeded the limit and was clamped to it |

- Boundaries are aligned to the start of a UTF-8 character (a multi-byte character or a surrogate pair is not split). Even a `max_bytes` too small for one character returns one character, so the next position advances.
- An `offset` at or beyond the total size is not a failure; it returns an empty `text` and `totalBytes` (so that, when re-reading from a position, "has not grown yet" is told apart from a failure).
- A `max_bytes` or `limit` of 0 or less, or a negative `offset`, is rejected by the SDK from the argument shape (the minimum). The API rejects it with 400 (`invalid_range`).

### Failures of the deliverable and run tools

| Case | Text of the reason |
| --- | --- |
| The task does not exist, or belongs to a deleted project (the API returns a 404 of `{ error: "not_found" }`) | The `task.notFound` message (task not found) |
| The step or kind is not a candidate (API) | Step not found, deliverable kind not found |
| `task_id` does not match `[A-Za-z0-9_-]{1,128}` (including `..`, `/`, `%2F`) | The form of `task_id` is wrong (the tool does not call the API; the API also rejects with 400 (`invalid_id`)) |
| The range is invalid (the API's 400 `invalid_range`) | The range is invalid |
| An earlier daemon version (no new API, and a 404 whose body is not JSON with `error`) | The running sacty does not support this; asks to update sacty and restart with `sacty up` when no task is running |
| A 200 response cannot be read as JSON | The response from sacty could not be read |
| A failure other than 404 (such as 500) whose body cannot be read as JSON | sacty returned <status code> (the body is not included) |
| The body is JSON but `error` matches none of the forms above (other than 400) | sacty returned <status code> (neither the `error` value nor the body is included) |
| Cannot connect, timed out, cannot authenticate, or not running | The same text as the existing tools |

- The reason text is limited to the text in this table. The one line on standard error carries the tool name, `task_id` (if any), this reason, and the cause (below). Neither ever contains the daemon's response body, the content of a deliverable, the token in `daemon.json`, the value of an environment variable, or an absolute path of the daemon.
- The cause on the one line of standard error (`failureLine`) is limited to the kind of connection failure (a `code` such as `ECONNREFUSED`) and a timeout mark (an exception message is not shown, because it can contain part of a response body).
- An earlier daemon version returns Hono's default 404 (the body is `404 Not Found`) for the new API URLs. A 404 for a missing task is JSON with `error`, so the two can be told apart.

Code: `apps/daemon/src/task-mcp.ts` (`READ_REASONS`, `readFailure`, `RunListSchema`), `apps/daemon/src/task-reads.ts` (`stepState`, `readDeliverable`, `listDeliverables`, `runEntries`), `apps/daemon/src/byte-range.ts` (`readByteRange`, `RANGE_MAX_BYTES`), `apps/daemon/src/session-logs.ts` (`readMeta`, `isLive`), `apps/daemon/src/server.ts`, `apps/daemon/src/service.ts` (`deliverables`, `deliverable`, `runList`), `packages/core/src/session-log.ts` (`RUN_EVENTS`, `runLogId`), `packages/cli/src/mcp.ts` (`readApi`)

### wait_for_task

Waits until one task needs a person. It only reads and changes nothing (it calls no write API; calling it does not change the task's state or activity log).
Its annotations are the same as the other read tools (`readOnlyHint: true`, `openWorldHint: false`). The arguments are `task_id`, `timeout_seconds` (an integer of 1 or more; the default if omitted), and `cursor` (the value from the previous result; if omitted, the moment of the call is the baseline).

- The daemon has no wait API or push. The MCP layer calls `GET /api/tasks/:id` (`SactyApi.getTask`) at a fixed interval and compares fields of the summary (`summarizeTask`) with the previous values. The MCP layer does not re-implement the judgments it compares (the step and submission awaiting approval come from `approvalOf`, the count of things to confirm from `humanAsks`, and the review round, post, verdict, and PR state from the summary).
- It works with a daemon of an earlier version (it calls no new API).
- It calls `GET /api/tasks/:id` only for the awaited task and for the children in its `reviewTasks` (tasks that review its PR). Split children (`split.children`) are not fetched and their changes do not wake it.

**Changes that wake it** (it stops waiting and returns `changed: true`, `changes`, and the current summary)

| Target | Change |
| --- | --- |
| Task | It became awaiting approval (`awaiting_approval`). The step or submission awaiting approval changed (even while staying awaiting approval) |
| Task | It became awaiting a person's decision (`escalated`), paused (`paused`), completed, or cancelled. The pause reason changed |
| Task | It started moving again from awaiting approval, paused, or awaiting a person's decision |
| Task | The count of things to confirm with a person (`asks`) changed. A PR's state (`pullRequests[].state`) changed (merged, closed, and so on) |
| Child | A child (`reviewTasks`) was added |
| Child | A child's state became one of the "person's turn" states above (awaiting approval, awaiting a decision, paused, completed, cancelled), or it moved out of one |
| Child | The review round changed (a re-review). A review was posted. A verdict appeared or changed |

- A child's change wakes it even if the parent's state does not change (the parent stays `awaiting_approval` waiting for the PR to be merged and only the child's verdict appears).
- A child that could not be fetched (`available: false`) is not compared with the previous value (it is not treated as a change between fetches). When a baseline child was unfetchable and is now fetched, its value becomes the baseline and later changes are compared with it.
- The per-request deadline is rounded down to a positive whole number of milliseconds even when the remaining time is fractional.

**Changes that do not wake it**: a step advancing (`steps`), a run starting or ending (moving among `queued`, `running`, and `idle`), cost (`costUsd`) or the activity log growing, and `updatedAt` changing do not wake it by themselves.
`blocked` (waiting for another task to complete) and `waiting_children` (waiting for split children) need nothing from a person, so they count as the moving side (the same class as `queued`, `running`, and `idle`). In `changes`, this class is written `active` in `state:`.

**Result**

| Field | Content |
| --- | --- |
| `changed` | Whether a "person's turn" change happened. `false` means the wait timed out (not a failure) |
| `changes` | A short list of what changed (`state: active → awaiting_approval`, `approval: requirements#1 → design#1`, `asks: 0 → 2`, `reviewTask <ID> verdict: なし → suggestions`, and so on; only values such as states, steps, rounds, and counts, no sentences) |
| `task` | The current summary (same as `list_tasks`; the title and pause reason are data that include text written by other people) |
| `costUsd` | The current cost (USD) |
| `reviewTasks` | For each child: `taskId`, `number` (the PR number), `available` (whether it was fetched), `state`, `round`, `postedUrl`, `verdict`, and `costUsd`. No sentences (not the review body); read the body with `get_task` on the child's `task_id` |
| `reviewTasksOmitted` | The number of children left out because of the per-call limit (5, newest first) |
| `cursor` | The value to pass to the next call (the moment this result was returned becomes the baseline) |
| `waitedSeconds` | Seconds waited |
| `timeoutSeconds`, `clamped` | The limit actually used (seconds), and whether `timeout_seconds` exceeded the maximum and was clamped |

The description, review body, text of things to confirm, and activity log are not included (use `get_task`).

**Time** (`WAIT_DEFAULT_SECONDS`, `WAIT_MAX_SECONDS`, `WAIT_POLL_MS`, `WAIT_GRACE_MS`, `WAIT_REQUEST_MS`, `WAIT_CHILD_LIMIT`)

| Value | Meaning | Reason |
| --- | --- | --- |
| Default 30 s, maximum 50 s | The limit on how long to wait. A larger value is clamped to 50 s and the result has `clamped: true` | Clients cancel a single tool call after 60 s by default (Codex's `tool_timeout_sec` and the official SDK client); the limit is well below that. Claude Code moves a call to the background after 2 minutes in the main conversation |
| 5 s | The interval between checks | Not shorter than the web UI's fetch interval (`LIVE_INTERVAL_MS`, 3 s). `GET /api/tasks/:id` returns the whole activity log every time (about 0.8 MB for a long task) and children are fetched too, so it is longer than the web UI's |
| Specified time + 5 s | The bound by which the tool always returns. Even for the maximum it is 55 s, never over 60 s | So that one last request near the limit cannot extend the call when the daemon does not respond |
| 10 s | How long to wait for a single request (the time remaining, if shorter) | The 30 s of the existing tools (`MCP_REQUEST_TIMEOUT_MS`) is unchanged |
| 5 | The most children fetched per call | A child is normally one per PR (re-creating a PR adds one). Each fetch returns the whole activity log, so it is not raised |

- A timeout is not a failure. If nothing changes up to the limit, it returns `changed: false`, the current summary, and `cursor`. To keep waiting, call again with `cursor`. No setting to lengthen a client's cancel time is needed.
- The clock is used only to judge the deadline and to report `waitedSeconds` (tests replace the clock and the waiting; `clock` of `startTaskMcp`).

**`cursor`**

- A string that encodes only the values compared (JSON in base64url). It holds the awaited task's ID, the state class (`active` and so on), the step and submission awaiting approval, the pause reason (an enumeration), the count of things to confirm, PR states, and for each child its ID, state class, round, whether a review is posted, and verdict. It holds no titles, descriptions, reason sentences, URLs, or secrets. It stays usable after sacty restarts.
- When passed, the result of the first request is compared with it, and if anything changed in between, the call returns at once without waiting (`waitedSeconds` is 0).
- If omitted, the moment of the call (the first request) is the baseline. Waiting on a task already awaiting approval without `cursor` waits for the next change.
- A malformed value (wrong shape or type) and a value from waiting on another task are refused with a reason (the baseline is not silently re-taken, and the daemon is not called).
- A child that could not be fetched keeps its last known value in `cursor`.

**Cancellation and cleanup**

- When the client cancels the call (`notifications/cancelled`; the SDK's `ctx.mcpReq.signal`), the wait stops at once. The request in flight is aborted and the daemon is not called afterward. The caller that cancelled does not read the result.
- When the peer closes standard input (`close`), the waiting calls are stopped first and then the server closes. `sacty mcp` ends without waiting for the wait to finish.
- However it ends (a change, a timeout, a failure, or a cancellation), no timer or cancellation listener is left behind.
- It answers other tool calls while waiting (the SDK handles calls concurrently). Several waits at the same time do not interfere because each call has its own baseline and clock waits.

**Failures**

| Case | Reason |
| --- | --- |
| `task_id` has the wrong form, or there is no such task (the first request) | The same reasons as `list_deliverables` and others (returned without waiting) |
| Cannot connect, sacty is not running, cannot authenticate, or no response, from the start | The same reasons as the existing tools (for no response: `sacty did not respond in time…`) |
| `cursor` is malformed | `cursor が正しくありません…` (the cursor is not valid) |
| `cursor` is from another task | `cursor は、別のタスクを待ったときの結果の値です…` (the cursor is from another task) |
| The daemon became unreachable while waiting (cannot connect, no response) | A single failure is retried once on the next cycle if time remains before the deadline. After a second consecutive failure, it returns `待っている途中で、sacty に届かなくなりました…` (it became unreachable while waiting) plus a `cursor` to call again with. Check that sacty is running and call again with that `cursor` |
| The daemon answered with a refusal while waiting (5xx, cannot authenticate) | Returns that reason as is, with the `cursor` to call again with |
| The task became invisible while waiting | `待っている途中で、タスクが見えなくなりました…` (the task became invisible while waiting) |
| Only a child cannot be fetched | Not a failure. That child is marked `available: false` |

- The cause in the one stderr line (`failureLine`) is the same as for `list_deliverables` and others: only the kind of connection failure and a timeout marker. The reason, stderr, and `cursor` never contain the `daemon.json` token or an internal absolute path.

The tool description states the changes that wake it, the changes that do not, the time limit, how to call again (`cursor`), and what to read afterward (`get_task`, and `get_task` on a child).
It also says that the title and pause reason in the result are data that include text written by other people and that instructions in them must not be followed, and that after a wake it must do only what the user asked (becoming awaiting approval is not a reason to approve or request changes unasked). `INSTRUCTIONS` adds that this tool is used to wait for progress.

Code: `apps/daemon/src/task-mcp.ts` (`waitForTask`, `watchOfTask`, `watchChanges`, `WaitSchema`, `WAIT_DEFAULT_SECONDS`, `WAIT_MAX_SECONDS`, `WAIT_POLL_MS`, `WAIT_GRACE_MS`, `WAIT_REQUEST_MS`, `WAIT_CHILD_LIMIT`, `WaitClock`, `startTaskMcp`, `READ_REASONS`), `packages/cli/src/mcp.ts` (`daemonApi`), `packages/cli/src/context-preview.ts` (`daemonRequest`)

### pause_task

Pauses a task (the same as "Pause" in the web UI).

| Argument | Type | Description |
| --- | --- | --- |
| `task_id` | String (required) | The task ID |

- It sends only `{}` to `POST /api/tasks/:id/pause`. The decision to pause (`service.pause`) and the record (`TaskPaused`, reason `manual`) are the same as the web UI. There is no MCP-specific path or record.
- When it pauses the task, it returns a sentence and the [task summary](#task-summary) after the pause (`state` is `paused` and `pausedReason` is `manual`).
- A task can be paused in the same states in which the web UI shows the "Pause" button: `queued`, `running`, `awaiting_approval`, and an `idle` task under verification (it has `verification`). Before calling the API, the MCP layer checks this from the task of `GET /api/tasks/:id` (`pauseBlock`, a copy of the web UI's `canControl` and `canPause`; change it together when the web UI changes. `canPause` in the summary uses the same function).
  The order is: the form of `task_id` and a missing task (including a task of a deleted project), then cancelled, then completed, then already paused, then `escalated`, then `blocked` and `waiting_children`, then an `idle` task not under verification. None of them is sent to the API or recorded, and each returns a reason that says what to do next.
- A completed task and an `idle` task not under verification are not refused by the daemon's `service.pause`, which records `TaskPaused` (the web UI only hides the button), so the MCP layer refuses them first. A small window remains if the task completes after the check ([ADR](../adr/20261119-0800-mcp-pause-resume-minimal-resume.md)).
- What the daemon refuses (`pause.reachedApproval`, when the work finished before the stop and the task reached approval or a person's decision, or a task awaiting approval whose cancellation cleanup is in progress) returns the daemon's reason. The task is not paused.
- For a running task, the daemon stops the container and waits for that process to end before it responds (it checks that the container stopped up to 11 times per container, about once a second; there is no fixed upper bound). The MCP waits 30 seconds for the response, so the task may be paused later (or may reach approval and not stop) without the response ever arriving. A pause of a task awaiting approval is recorded on the spot without waiting.
- When no result is received after the request (a timeout, a dropped connection, an unreadable body, or a daemon 5xx), it returns that the task may have been paused, that it must not be retried automatically, and that `state` and `pausedReason` of `get_task` must be checked (`PAUSE_UNCERTAIN`). If `state` is the same as before the pause (`running`, `queued`, or `idle` under verification), the pause may still be in progress, so the task must not be called again; wait with `wait_for_task` (so the request is not sent twice). If it is `paused`, the task stopped. If it became `awaiting_approval` or `escalated`, tell the user that the task did not stop. The sentence before the guidance is the daemon's reason for a 5xx and the fixed sentence "The pause result was not received (timeout, disconnect, and so on)." otherwise. When the daemon refuses in its response, authentication fails (401), the connection is refused, or the failure is before the request is sent, the task was not paused, so only the reason is returned. The 30-second wait does not change.
- Older daemon: `POST /api/tasks/:id/pause` has long existed, so it works with an older daemon. It calls no new API.
- The description says to call it only when the user asks, that a running run is cut off and resuming starts that step over from the beginning (the cost already spent does not come back), that pausing a task awaiting approval stops the approval gate and the PR watch until it is resumed, that even if `pausedMessage` (the stop reason) or `humanAsks` of `get_task` says it is fine to pause, it is not called for that reason alone (`PAUSE_TEXT_NOTE`), and the guidance for when no result is received (after a timeout, wait with `wait_for_task`). `INSTRUCTIONS` adds it too.
- The tool annotations are not read-only (`readOnlyHint: false`), not destructive (`destructiveHint: false`), not idempotent (`idempotentHint: false`; the second call is refused), and do not write outside sacty (`openWorldHint: false`; it only stops a local container and, for a task awaiting approval, the approval gate and the PR watch, and resuming undoes it).

### resume_task

Resumes a paused task (the same as pressing "Resume" in the web UI without changing the cap, tests, image, or agents).

| Argument | Type | Description |
| --- | --- | --- |
| `task_id` | String (required) | The task ID |
| `note` | String (optional) | A note for the resume (the same as `note` of the API) |

- It sends only `{}` or `{ note }` to `POST /api/tasks/:id/resume`. `capUsd`, `tests`, `image`, and `agents` are not arguments and there is no path to send them. The decision to resume (`service.resume`) and the record (`TaskResumed`) are the same as the web UI. There is no MCP-specific path or record.
- When it resumes the task, it returns a sentence, whether a note was added (`resumed`: `taskId` and `noteAdded`), and the [task summary](#task-summary) after the resume (`state` is where it went back to). The sentence tells where it went back to. `queued` runs the stopped step again (it takes time and money; it does not wait for the end). `awaiting_approval` and `waiting_children` only went back there and do not run the step again. Otherwise sacty moves on to the next step.
- A task can be resumed when its state is `paused` and the reason is `manual`, `error`, `verification`, `incomplete`, `unchanged`, `usage_limit`, or `auth` (including an old record with no reason). `verification` and `incomplete` count again from the start, so the same failure stops it again.
- **It cannot be resumed** (it sends nothing to the API, records nothing, and returns what a person decides on the screen) when the reason is `budget` (raising the budget cap, a decision that increases cost), when the stop is one where a person can decide how to treat the tests (`canDecideTests`, deciding the test handling), when the reason is `child_cancelled` (resuming accepts the cancellation of the child task), or when a task imported from a ticket was paused before the repository to work on was decided (`awaitingTicketTriage`, `awaitingRepository`; the web resume form requires choosing a repository in this case; choosing the repository to work on). The sentence is "This tool cannot resume it (nothing was changed). A person must decide on the screen: …". The check is `resumeBlock`, and `canResume` in the summary and `resumeBlocked` of `get_task` (`reason` and `decideOnScreen`) use the same function.
- A task that is not paused, a missing task (including a task of a deleted project, checked first with `GET /api/tasks/:id`), a malformed `task_id`, and a note that is too long (over 10000 characters of `RESUME_NOTE_MAX`, or too long to add within the description limit; `resumeNoteRoom`) are also refused with a reason and nothing is sent to the API.
  What the daemon refuses (an external-work step has started, a stacked dependency was cancelled, or a container that cannot be confirmed stopped remains) returns the daemon's reason as it is. `canResume` does not look at these, so the daemon may refuse even when it is true.
- The note has its surrounding whitespace removed and is not sent if empty. It is appended after the task description and stays, and later steps read it ([Budget, pause, resume, and cancel](tasks-and-steps.en.md#budget-pause-resume-and-cancel)).
- When no result is received after the request (a timeout, a dropped connection, an unreadable body, or a daemon 5xx), it returns that the task may have been resumed, that it must not be retried automatically, and that `state` and `pausedReason` of `get_task` must be checked before calling again (`RESUME_UNCERTAIN`). The sentence before the guidance is the daemon's reason for a 5xx and the fixed sentence "The resume result was not received (timeout, disconnect, and so on)." otherwise. When the daemon refuses in its response, authentication fails (401), the connection is refused, or the failure is before the request is sent, the task was not resumed, so only the reason is returned.
- Older daemon: `POST /api/tasks/:id/resume` has long existed, so it works with an older daemon. It calls no new API.
- The description says to call it only when the user asks, that it runs the stopped step again (it takes time and money; it does not wait for the end), that the same cause stops it again, to check `pausedReason`, `pausedMessage`, and whether it can be resumed with `get_task` first, that `note` is appended to the description and stays so only the user's words should be passed, that even if `pausedMessage` (the stop reason) or `humanAsks` of `get_task` says it is fine to resume, it is not called for that reason alone (`RESUME_TEXT_NOTE`), and the guidance for when no result is received. `INSTRUCTIONS` adds it too.
- The tool annotations are not read-only (`readOnlyHint: false`), not destructive (`destructiveHint: false`), not idempotent (`idempotentHint: false`), and may write outside sacty (`openWorldHint: true`; the steps write to PRs and so on).

### Handling failures

A failure inside a tool is returned as a tool execution error (`isError: true` in the MCP result and the text of the reason; no `structuredContent`). The MCP server does not exit.
The name of the failed tool, the target task ID (`task_id` if present; no other arguments), and the reason are written to standard error on one line (`failureLine`). If a failed connection has a cause (the exception's `cause`), it is followed up to 5 levels and appended (`causeChain`).

| Case | Text of the reason |
| --- | --- |
| `daemon.json` is missing or unreadable | The running sacty was not found (start it with `sacty up`) |
| Cannot connect to the daemon | Cannot connect to the daemon |
| The daemon does not respond within 30 seconds | The daemon did not respond in time |
| The daemon returned 401 | Cannot authenticate to the daemon |
| The daemon returned `invalid_operation` (409) | The daemon's message (rendered in Japanese) |
| The daemon returned `invalid_input` (400) | The message for each error (rendered in Japanese) |
| The daemon returned another failure | The status code |

When the arguments do not match the types (a `limit` out of range, a missing `task_id`, and so on), the MCP SDK returns the same shape (`isError: true` and the text of the reason) without calling the tool.
Calling an unknown tool and the like becomes a JSON-RPC error.

Code: `apps/daemon/src/task-mcp.ts` (`TOOLS`, `defineTool`, `INSTRUCTIONS`, `filterTasks`, `parsePullRequestQuery`, `describeTask`, `pauseBlock`, `resumeBlock`), `packages/cli/src/mcp.ts` (`daemonApi`, `MCP_REQUEST_TIMEOUT_MS`, `REREVIEW_UNCERTAIN`, `CREATE_UNCERTAIN`, `APPROVE_UNCERTAIN`, `CHANGES_UNCERTAIN`, `PAUSE_UNCERTAIN`, `RESUME_UNCERTAIN`, `writeTask`), `apps/daemon/src/server.ts` (`createApp`), `apps/daemon/src/service.ts` (`rereview`, `createTask`), `packages/core/src/events.ts` (`CreateTaskInput`)

## Task summary

The result of `list_tasks`, `rereview_task`, `create_task`, `approve_step`, `request_changes`, `pause_task`, and `resume_task`, and the base of the result of `get_task`.

| Field | Description |
| --- | --- |
| `id`, `title`, `projectId` | The task ID, the title, and the project ID |
| `state` | `cancelled` (cancelled), `completed` (stopped with all steps finished), otherwise the task status (`status`) as it is |
| `steps` | Steps and their states (`<step>:<state>`, in order) |
| `reviewTask` | Whether it is a PR review task (imported as a PR review (`source.review` is set) or has the review step) |
| `canRereview` | Whether it can be re-reviewed (`canRereview`) |
| `canPause` | Whether `pause_task` can pause it (the states in which the web UI shows the pause button; `pauseBlock`) |
| `canResume` | Whether `resume_task` can resume it (paused, and no decision on the budget cap, the test handling, the child task's cancellation, or the repository to work on is needed; `resumeBlock`. It does not see refusals only the daemon knows, so the daemon may refuse even when it is true) |
| `pullRequests` | The [tied PRs](#prs-and-branches-tied-to-a-task) |
| `branches` | The [tied branches](#prs-and-branches-tied-to-a-task) |
| `review` | Only for PR review tasks. The review round (`round`), and the URL of the post (`postedUrl`) and the verdict (`verdict`) of the current round. The post and the verdict are present only when they exist |
| `reviewOf` | For a PR review child task, the ID of the parent task |
| `reviewTasks` | The child tasks that review this task's PRs (task ID and PR number) |
| `pausedReason` | The reason for the pause (only while paused) |
| `approval` | Only while awaiting approval (`awaiting_approval`, `escalated`): the step and submission awaiting approval and how to approve ([approve_step](#approve_step)) |
| `asks` | The number of things to confirm with a person (absent when 0). Counted the same way as the web UI; a small value only, no text (the text is in `humanAsks` of `get_task`) |
| `createdAt`, `updatedAt` | The time it was created and the time of the last record |
| `url` | The URL of the task details in the web UI (only when `daemon.json` has the web UI URL) |

`asks` is counted from `humanAsks` in `@sacty/core` (the same as `HumanAskNotice` in the web UI).
Code: `apps/daemon/src/task-mcp.ts` (`summarizeTask`, `isReviewTask`, `TaskSummarySchema`), `packages/core/src/projection.ts` (`canRereview`, `isFinished`)

## Things to confirm with a person

`humanAsks` of `get_task`. It appears only while awaiting approval (`awaiting_approval`) and when the web UI's approval screen shows "things to confirm with a person". Otherwise the field is absent (no empty field that could read as "there is a question").
The decision and the merging are the result of `humanAsks` in `@sacty/core` as it is (the "Things for a person to confirm" part of [Approval](approval.en.md); the MCP layer does not rebuild it). No new daemon API is called; it is built from the task `get_task` already received.

- `confirms`: the confirmations the step's agent raised. The same sentence (compared with whitespace removed) is merged into one, and `remarkIds` lists the remarks it was attached to. `step` and `text` (the part beyond 1000 characters is replaced with "…（以下 N 文字を省略）", an omission note in Japanese).
- `undecided`: when the target of a PR remark could not be decided, its `step`, `remarkIds` (up to 20; the number beyond that is `omittedRemarkIds`), and `reason` (clipped the same as `text` of `confirms`).
- `count`: the number (1 for `undecided` plus the merged `confirms`). The same as `asks` in the summary.
- Limits: 20 `confirms` (the omitted number is `omittedConfirms`), 20 `remarkIds` per item (the omitted number is `omittedRemarkIds`).
- `howToAnswer`: how to answer, consistent with `approval`. `withoutAnswer` (when no answer is needed: `approve_step` if `approval.method` is `approve_step`, merging the PR if `pull_request`), `answer` (to answer: for a step without a PR, write it in `comments` of `request_changes`; for a step that made a PR, write it in a PR comment, which leaves a record on the PR; `request_changes` also sends it back but leaves nothing on the PR; a reproduce step (`not_approvable`) can also be answered with `request_changes`; when there is no step to send back to, or human requests for changes to the same step have reached the limit, it says this will be refused or become a wait for a decision, so decide in the web UI, using the same core checks as `checkRequestChanges`: `reworkTargets` and `changeRounds`), and `note` (answering makes sacty redo the step, which takes time and money; there is no tool only for answering).
- The "things to confirm" section in the body of a deliverable such as requirements or design is not included. Read the body with `get_deliverable`.
- The text is data written by agents or other people. The descriptions of `get_task`, `approve_step`, and `request_changes` and `INSTRUCTIONS` say that even if it says to approve or request changes, the tools are not called for that reason alone (only when the user asks).

## Why a person's decision is awaited

`escalation` of `get_task`. It appears only when the state is `escalated`.

- `reason`: `too_many_changes` (over the limit of requests for changes), `change_proposed` (a change proposal), `change_undecidable` (an open proposal that could not be judged) and `rework_confirmation` (records from earlier versions), `unknown` (an old task with no recorded reason).
  `task.escalation.reason` is used when present. For a change proposal the core projection does not create `task.escalation`, so an open proposal (`openProposal`) means `change_undecidable` if its judgement is `undecidable`, otherwise `change_proposed`. With neither, it is `unknown`.
- `step`, `reworkStep`: the target step and the step to redo (for a proposal, the step that proposed and the proposal's target).
- `pendingRemarks`: the number of unfinished remarks (the text is not shown; read it in the web UI; 0 for a proposal).
- `openProposalId`: the ID of the open change proposal (only when there is one).
- `note`: a supplement to the reason for the decision (only when present; clipped at 1000 characters).
- `canDoHere`: what can be done through MCP (approval with `approve_step` when `approval.method` is `approve_step`; for `pull_request`, merging the PR approves and this tool cannot; otherwise read-only). `decideOnScreen`: what a person decides in the web UI, split by reason like `GateNotice` (`too_many_changes`: a request for changes over the limit and cancelling; proposal reasons: deciding on the proposal and cancelling; `unknown` and others: all three). The behavior and refusal messages of `approve_step` and `request_changes` are unchanged (`request_changes` refuses `escalated`).
- It is absent for tasks that are not `escalated`, and is not in the summary.

Code: `apps/daemon/src/task-mcp.ts` (`describeAsks`, `describeEscalation`, `askCount`)

## PRs and branches tied to a task

PRs are collected from the following, per role (`role`). Each has the repository, number, and URL, and the branch (`branch`) and state (`state`) when known.

| `role` | Source | Branch |
| --- | --- | --- |
| `review` | The PR a PR review task reviews. The record of the resolved target (`reviewTarget`). Without it (before resolving, or after a re-review started), the PR it was imported from (`source`) or a PR of the target repository in the title or description (`referencedPullRequest`) | `reviewBranch` (below) |
| `source` | The PR it was imported from (when it is not a PR review task) | None |
| `implement` | The implementation PR this task created (`pullRequest`; only when it has a number) | `pullRequest.branch` |
| `requirements`, `design` | The PR of a step output this task created (`stepPullRequests`) | The branch of that PR |
| `continued` | The existing PR this task took over (`continuedPullRequest`) | The head branch of that PR |

Branches are collected, without duplicates, from the task branch (`taskBranch`), the step branches (`stepBranches`, `stepPullRequests`), the pushed branch (`pushedBranch`), the branch of the implementation PR, the head branch of the PR taken over, and the head branch of the PR under review (`reviewBranch`).

The name of the head branch of the PR under review is recorded in `headBranch` when the review target is resolved (`ReviewTargetResolved`), if it can be read from GitHub.

- The task keeps the last name read in `reviewBranch`. It is not cleared when a re-review starts (`reviewTarget` is cleared).
- Tasks resolved by a version before `headBranch` was recorded do not have it. Until the target is resolved again (a re-review), they do not match the branch condition (they do match the PR condition).

Code: `apps/daemon/src/task-mcp.ts` (`taskPullRequests`, `taskBranches`), `apps/daemon/src/prompts.ts` (`referencedPullRequest`), `apps/daemon/src/service.ts` (`resolveReviewTarget`), `packages/core/src/events.ts` (`ReviewTargetResolved`), `packages/core/src/projection.ts` (`reviewBranch`)
