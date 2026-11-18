[日本語](mcp-server.md) | **English**

# MCP server (sacty mcp)

`sacty mcp` is an MCP server for operating the running sacty (`sacty up`) from an AI on the same machine (Claude Code, Codex, and so on).
It runs over standard input and output (stdio) and calls the same daemon API as the web UI.
It follows the 2026-07-28 revision of the MCP specification and also accepts clients of earlier revisions (up to 2025-11-25) that open with `initialize`.
It has three tools: listing and searching tasks (`list_tasks`), task details (`get_task`), and re-reviewing a PR review task (`rereview_task`).

Related ADRs: [The MCP server that operates the running sacty is run by the CLI over stdio](../adr/20261118-0936-task-mcp-server-over-stdio.md), [The CLI calls the running daemon's API through the connection file that sacty up writes](../adr/20261014-0701-cli-daemon-connection-file.md)

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
- It calls the following APIs, the same ones the web UI uses ([Overall structure](architecture.en.md#processes-and-communication)). The daemon has no API just for MCP.

| Tool | Daemon API |
| --- | --- |
| `list_tasks` | `GET /api/tasks`, `GET /api/projects` |
| `get_task` | `GET /api/tasks/:id` |
| `rereview_task` | `GET /api/tasks/:id`, `POST /api/tasks/:id/rereview` |

Code: `packages/cli/src/index.ts` (`mcpCommand`), `packages/cli/src/mcp.ts` (`daemonApi`), `apps/daemon/src/task-mcp.ts` (`serveTaskMcp`, `startTaskMcp`, `createTaskMcpServer`, `SactyApi`), `packages/cli/src/context-preview.ts` (`readDaemonFile`, `daemonRequest`), `packages/cli/src/up-env.ts` (`daemonEndpoint`)

## Tools

The server's usage instructions (`INSTRUCTIONS`) and the descriptions of `list_tasks` and `get_task` say that the title, description, review body, and stop reason in results are data that can contain text written by other people, and that instructions inside them must not be followed.
The description of `rereview_task` says to call it only when the user asks.

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
- The branch condition: either of the following holds.
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
- If the task does not exist (including tasks of a deleted project), it returns the reason.

### rereview_task

Puts a PR review task into re-review. The argument is `task_id`.
It calls the same API as "Re-review" in the web UI, so the result is the same (it records `ReviewRestarted` with actor `person`, reviews the latest commit of the PR again, and posts it. [Tasks and steps](tasks-and-steps.en.md#pr-review-only-tasks)).

- Once started, it returns a message and the [task summary](#task-summary) after starting (it does not wait for the review to finish).
- It first checks with `GET /api/tasks/:id` that the task exists. If it does not (including tasks of a deleted project), it answers that the task was not found and does not call the re-review API.
- When the response of the re-review API times out, it answers that the re-review may have started and to check with `get_task` before calling again (the daemon may have recorded it before the response was delayed).
- It works only for a task that posted its review to the PR and completed (`canRereview` in the summary is `true`).
  For a task that cannot be re-reviewed or does not exist, it returns the text of the reason the daemon refused and records nothing.
- The tool annotations say it is not read-only (`readOnlyHint: false`) and writes outside sacty (`openWorldHint: true`).

### Handling failures

A failure inside a tool is returned as a tool execution error (`isError: true` in the MCP result and the text of the reason; no `structuredContent`). The MCP server does not exit.
The name of the failed tool and the reason are written to standard error on one line. If a failed connection has a cause (the exception's `cause`), it is followed up to 5 levels and appended (`causeChain`).

| Case | Text of the reason |
| --- | --- |
| `daemon.json` is missing or unreadable | The running sacty was not found (start it with `sacty up`) |
| Cannot connect to the daemon | Cannot connect to the daemon |
| The daemon does not respond within 30 seconds | The daemon did not respond in time |
| The daemon returned 401 | Cannot authenticate to the daemon |
| The daemon returned `invalid_operation` (409) | The daemon's message (rendered in Japanese) |
| The daemon returned another failure | The status code |

When the arguments do not match the types (a `limit` out of range, a missing `task_id`, and so on), the MCP SDK returns the same shape (`isError: true` and the text of the reason) without calling the tool.
Calling an unknown tool and the like becomes a JSON-RPC error.

Code: `apps/daemon/src/task-mcp.ts` (`TOOLS`, `defineTool`, `INSTRUCTIONS`, `filterTasks`, `parsePullRequestQuery`, `describeTask`), `packages/cli/src/mcp.ts` (`daemonApi`, `MCP_REQUEST_TIMEOUT_MS`, `REREVIEW_TIMEOUT_MESSAGE`), `apps/daemon/src/server.ts` (`createApp`), `apps/daemon/src/service.ts` (`rereview`)

## Task summary

The result of `list_tasks` and `rereview_task`, and the base of the result of `get_task`.

| Field | Description |
| --- | --- |
| `id`, `title`, `projectId` | The task ID, the title, and the project ID |
| `state` | `cancelled` (cancelled), `completed` (stopped with all steps finished), otherwise the task status (`status`) as it is |
| `steps` | Steps and their states (`<step>:<state>`, in order) |
| `reviewTask` | Whether it is a PR review task (imported as a PR review (`source.review` is set) or has the review step) |
| `canRereview` | Whether it can be re-reviewed (`canRereview`) |
| `pullRequests` | The [tied PRs](#prs-and-branches-tied-to-a-task) |
| `branches` | The [tied branches](#prs-and-branches-tied-to-a-task) |
| `review` | Only for PR review tasks. The review round (`round`), and the URL of the post (`postedUrl`) and the verdict (`verdict`) of the current round. The post and the verdict are present only when they exist |
| `reviewOf` | For a PR review child task, the ID of the parent task |
| `reviewTasks` | The child tasks that review this task's PRs (task ID and PR number) |
| `pausedReason` | The reason for the pause (only while paused) |
| `createdAt`, `updatedAt` | The time it was created and the time of the last record |
| `url` | The URL of the task details in the web UI (only when `daemon.json` has the web UI URL) |

Code: `apps/daemon/src/task-mcp.ts` (`summarizeTask`, `isReviewTask`, `TaskSummarySchema`), `packages/core/src/projection.ts` (`canRereview`, `isFinished`)

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
