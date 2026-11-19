<!-- Code: packages/cli/src/index.ts (mcpCommand), packages/cli/src/mcp.ts, apps/daemon/src/task-mcp.ts (TOOLS, INSTRUCTIONS), apps/daemon/src/task-reads.ts, apps/daemon/src/byte-range.ts, apps/daemon/src/session-logs.ts (readMeta) -->

[日本語](mcp.md) | **English**

# Operating sacty from your local AI (MCP)

You can operate the running sacty from Claude Code or Codex on the same computer.
For example, after fixing a PR, you can ask the AI to "re-review this PR with sacty" (the same as opening the web UI and pressing "Review again and post to the PR").

sacty has an MCP server for this (`sacty mcp`; it supports the 2026-07-28 revision of the MCP specification and also works with clients of earlier revisions).
It can look up tasks (list, search, details), put a PR review task into re-review, create a task in a project you specify,
read the deliverables of each step of a task and the list of agent runs (deliverables and the run list are read-only), and approve a step that is awaiting approval. The logs of runs cannot be read yet (read them in the web UI).
It cannot request changes to or cancel tasks (do those in the web UI). A step approved by merging a PR (implementation, requirements or design with a PR) cannot be approved from MCP either (merge the PR on GitHub). Deliverables can be used to check the content before you approve.

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

When you ask for a re-review, sacty reviews the latest commit of the PR again and posts the result to the PR ([Re-review](intake.en.md#re-review)).
The review takes time to finish and costs money.
The answer to the AI comes back as soon as the re-review starts.

A task you create is the same as one created with "Create task" in the web UI with no template, the target repository left blank, and the approach left at "Automatic", with the same title and description ([Create a task](tasks.en.md#create-a-task)).
The answer contains the ID of the new task and its web UI URL, and comes back without waiting for the steps to finish.
When the task cannot be created (the project does not exist, the title is empty, and so on), it returns the reason and creates nothing.
When the result cannot be received after the request to create was sent (a timeout, a dropped connection, an unreadable body, or a 5xx from the daemon), it answers "The task may have been created". Search for the title with `list_tasks` to check, and ask again only if it is not there (asking again without checking can create the same task twice).

Deliverables have a limit on how much one call can read (32,000 bytes in UTF-8; about 10,000 Japanese characters).
When the content exceeds the limit, the result says it was cut and gives the total size and the position to continue from, and the AI reads on.
The content of a deliverable comes from the same source as the web UI's task detail and is hidden the same way as there (nothing is hidden again for MCP).
The run list also limits how many entries one call returns (20 by default, 100 at most). If runs are added while you fetch the rest, the same run can be returned twice, so the AI drops duplicates by run ID.

When sacty is not running, the tools answer that the running sacty was not found.
Start it with `sacty up` and ask again.
When sacty does not respond within 30 seconds, the tools answer that the daemon did not respond in time (sacty is running; check how it is doing and ask again).

## Tools

| Tool | What it does |
| --- | --- |
| `list_tasks` | Lists tasks, newest first. Can filter by PR, branch name, repository, title, and so on |
| `get_task` | Returns the details of a task (description, review body, why it is stopped, recent activity) |
| `rereview_task` | Puts a PR review task into re-review |
| `list_projects` | Lists the projects that have not been deleted, with their IDs, names, and target repositories |
| `create_task` | Creates a task in a project you specify, from a title and a description (`project_id`, `title`, `body`; the description can be omitted) |
| `list_deliverables` | Lists the deliverables of each step of a task (step, which submission, kind, size, status) |
| `get_deliverable` | Reads the content of a deliverable by step and kind (the approved version if there is one, otherwise the latest output; for a review, the body and the comments on lines) |
| `list_runs` | Lists agent runs, newest first (steps, the orchestrator, and so on; the agent used, time, running / succeeded / failed / no end recorded, and a switch to another agent) |
| `approve_step` | Approves a step awaiting approval (`task_id`, `step`, `submission`), the same as "Approve" on the web UI. A step approved by merging a PR cannot be approved here; the PR URL is returned |

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

Only a task that posted its review to the PR and completed can be re-reviewed (`canRereview` in the result of `list_tasks` is `true`).
If you ask for a task under review or a task that is not a PR review, it returns the reason and changes nothing.

## Approving

`approve_step` approves a step that is awaiting approval (the same as "Approve" on the web UI's approval screen). Approving makes sacty start the next step (it takes time and costs money, and cannot be undone).
The AI calls it only when you ask. It is safer to check the deliverables (`list_deliverables`, `get_deliverable`) before you ask.

- Before approving, `approval` in `get_task` (and in each task of `list_tasks`) shows the step awaiting approval (`step`), the submission number (`submission`), and how to approve (`method`).
  The AI approves with the step and number it checked. If they differ from what is awaiting approval now (an old submission), it does not approve and tells you the current number.
- What it can approve is a step awaiting approval without a PR (an investigation result, an integration result, an implementation with no changes, requirements or design without a PR, and so on; the steps where you press "Approve" in the web UI).
- When it cannot (not awaiting approval, no such task, a step other than the one awaiting approval, an old number, already approved, a reproduction that could not reproduce), it returns the reason and changes nothing.
- A step approved by merging a PR (implementation, requirements or design with a PR) cannot be approved from MCP. `method` in `approval` is `pull_request`; review and merge the PR at `pullRequestUrl` on GitHub (the merge is the approval).
- When no result arrives (a timeout and so on), the step may have been approved. The AI does not retry automatically and checks the state with `get_task`.

## Things to keep in mind

- Only the person running `sacty up` can use the MCP server (it uses the address sacty wrote to a file only that person can read).
- The registered AI can start a re-review, create a task, or approve a step awaiting approval on your behalf. Creating a task or approving starts steps, which takes time and costs money.
  In the AI CLI's permission prompt, you can choose to confirm `rereview_task`, `create_task`, and `approve_step` every time or to allow them.
  Confirming `approve_step` every time is recommended. If you allow it, an instruction written in a task description, deliverable, or review body by someone else may get a step approved without your check.
- Task descriptions, review bodies, and deliverables are passed to the AI.
  They can contain text from PRs and issues written by other people and text written by agents (do not let the AI treat it as instructions).
- While a previous version of sacty is running, the deliverable and run tools answer "update sacty and restart it with `sacty up`" (a different reason from a missing task). Restart it when no task is running.

## Related pages

- [CLI](cli.en.md#sacty-mcp): the `sacty mcp` command
- [Intake of issues, PRs, and tickets](intake.en.md#re-review): what a re-review does
- [Tasks](tasks.en.md#create-a-task): how to create a task in the web UI
