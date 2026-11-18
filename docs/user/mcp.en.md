<!-- Code: packages/cli/src/index.ts (mcpCommand), packages/cli/src/mcp.ts, apps/daemon/src/task-mcp.ts (TOOLS, INSTRUCTIONS) -->

[日本語](mcp.md) | **English**

# Operating sacty from your local AI (MCP)

You can operate the running sacty from Claude Code or Codex on the same computer.
For example, after fixing a PR, you can ask the AI to "re-review this PR with sacty" (the same as opening the web UI and pressing "Review again and post to the PR").

sacty has an MCP server for this (`sacty mcp`; it supports the 2026-07-28 revision of the MCP specification and also works with clients of earlier revisions).
It can look up tasks (list, search, details), put a PR review task into re-review, and create a task in a project you specify.
It cannot approve or cancel tasks (do those in the web UI).

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

When you ask for a re-review, sacty reviews the latest commit of the PR again and posts the result to the PR ([Re-review](intake.en.md#re-review)).
The review takes time to finish and costs money.
The answer to the AI comes back as soon as the re-review starts.

A task you create is the same as one created with "Create task" in the web UI with no template, the target repository left blank, and the approach left at "Automatic", with the same title and description ([Create a task](tasks.en.md#create-a-task)).
The answer contains the ID of the new task and its web UI URL, and comes back without waiting for the steps to finish.
When the task cannot be created (the project does not exist, the title is empty, and so on), it returns the reason and creates nothing.
When the result cannot be received after the request to create was sent, it answers "The task may have been created". Search for the title with `list_tasks` to check, and ask again only if it is not there (asking again without checking can create the same task twice).

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

Only a task that posted its review to the PR and completed can be re-reviewed (`canRereview` in the result of `list_tasks` is `true`).
If you ask for a task under review or a task that is not a PR review, it returns the reason and changes nothing.

## Things to keep in mind

- Only the person running `sacty up` can use the MCP server (it uses the address sacty wrote to a file only that person can read).
- The registered AI can start a re-review or create a task on your behalf. Creating a task starts its steps, which takes time and costs money.
  In the AI CLI's permission prompt, you can choose to confirm `rereview_task` and `create_task` every time or to allow them.
- Task descriptions and review bodies are passed to the AI.
  They can contain text from PRs and issues written by other people (do not let the AI treat it as instructions).

## Related pages

- [CLI](cli.en.md#sacty-mcp): the `sacty mcp` command
- [Intake of issues, PRs, and tickets](intake.en.md#re-review): what a re-review does
- [Tasks](tasks.en.md#create-a-task): how to create a task in the web UI
