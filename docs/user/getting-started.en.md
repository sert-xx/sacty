<!-- Code: package.json, packages/cli/src/index.ts, apps/web/src/lib/paths.ts, apps/web/src/components/dashboard.tsx, apps/web/src/components/shell/rail.tsx, apps/daemon/src/config.ts (CONFIG_TEMPLATE, resolveHome), apps/daemon/src/instance-lock.ts -->

[日本語](getting-started.md) | **English**

# Getting started

This page walks you through installing sacty, starting it, and running your first task.

## Requirements

- macOS
- Node.js 22.13 or later
- Docker (Docker Desktop, OrbStack, Colima, and so on. Steps run inside containers)
- GitHub CLI (`gh`). Sign in with the account you use to access GitHub ([Project settings](project-settings.en.md#github-account))

## Setup

```sh
npm install
npm run build
npx sacty config init   # creates ~/.sacty/config.yaml
```

1. Open the `~/.sacty/config.yaml` created by `npx sacty config init`, and set in `providers` the authentication method of the tool you use and the prices
   of the models you can use (`available_models`) ([config.yaml settings](config.en.md#connections-and-prices-providers)). The models of the AI that runs the steps come from sacty's
   defaults, so you do not have to write `agents`. The template uses a Codex API key (`providers.codex`).
2. Put the authentication tokens and API keys in the Keychain or 1Password ([Secrets](secrets.en.md)). If you keep the template as is,
   save your OpenAI API key using `npx sacty secret set openai-api-key`.
3. Build the container image for running agents with `npx sacty image build`. If your environment cannot use Docker Hub or the public npm registry,
   write `image_build` before you build it ([Container images](images.en.md)).

## Start

```sh
npx sacty up
```

This starts the daemon and the web UI and prints the web UI sign-in URL (`http://127.0.0.1:4700/auth?token=…`) in the terminal. Open it in your browser (it does not open automatically). Only browsers that opened this URL can use the web UI. Press Ctrl+C to stop both. You can change the ports with `--port` and `--daemon-port`
([CLI](cli.en.md#sacty-up)).

## Web UI screens

When you open the web UI, it shows the dashboard first.

| Screen | URL | Contents |
| --- | --- | --- |
| Dashboard | `/dashboard` (also when you open `/`) | Across all projects: what needs you, why tasks are paused, open tasks, cost and budget, the step queue, intake, throughput, and quality signals ([Dashboard](dashboard.en.md)). When Slack notifications could not be sent, the reason is shown above the sections |
| Task list | `/projects/<ID>/tasks` | The project's tasks. "Create task" is also here |
| Project settings | `/projects/<ID>/settings` | The project's settings ([Project settings](project-settings.en.md)) |
| Project list | `/projects` | Create and import projects |
| Task details | `/tasks/<ID>` | The task's progress, approvals, and run logs |

- In the header's project switcher, choosing "All projects" moves to the dashboard, and choosing a project moves to that project's task
  list. The header shows the project of the open screen ("All projects" on the dashboard and similar screens).
- "Tasks" and "Settings" in the side menu open the task list and settings of the project selected in the header. While "All projects" is
  selected, "Tasks" is not shown and "Settings" opens the project list.
- Opening `/projects/<ID>` moves to that project's task list. Opening the ID of a project that does not exist shows that the page was not found.

## First project and task

1. In the web UI, create a project and register its "Targets" (GitHub orgs or repositories) and a "GitHub account" for each host
   ([Project settings](project-settings.en.md)).
2. Create a task in the web UI ([Working with tasks](tasks.en.md)). To turn issues and PRs into tasks,
   set up [Issue, PR, and ticket intake](intake.en.md).

Note: once you register a target, sacty may push branches to the target repositories and open PRs, depending on the task.

## Updating sacty

Every day, sacty checks `main` of the sacty repository on GitHub, and if it has changes that the running version does not, every screen shows
"A new version of sacty is available" at the top. Update when you see it, to get the recommended models ([Default agents](config.en.md#default-agents)) and fixes.

```sh
git pull origin main
npm install
npm run build
```

Run the above in the sacty repository, then stop the running `sacty up` with Ctrl+C and start it again.

- "See the changes" in the notice opens the changes on GitHub.
- When it cannot check (no internet access, local-only commits, and so on), nothing is shown.
- Where the internet is not reachable, write `update_check: false` in `config.yaml` to stop the check ([config.yaml settings](config.en.md)).
- When the default models change, you may see a warning about a model with no price in `available_models`. Add the price of that model.

## Where data is stored

- The activity log, settings, and workspaces are stored in `~/.sacty/`. You can change this with the environment variable `SACTY_HOME`.
- You cannot run two instances of sacty with the same `SACTY_HOME` (even on different ports). A second `sacty up` shows the address and PID of
  the running daemon and fails before it touches any data. The check uses an OS file lock on `SACTY_HOME/daemon.lock`, so
  if the previous daemon dies suddenly (SIGKILL and so on), the next start is not blocked.
- With different `SACTY_HOME` directories, you can run instances side by side on different ports.

## Development

```sh
npm test          # unit tests
npm run lint      # Biome (formatter and linter)
npm run typecheck # type check
npm run build     # build
```

| Path | Role |
| --- | --- |
| `packages/core` | Activity events, rebuilding task state from events, and cost calculation |
| `apps/daemon` | The resident process. It writes the activity log (SQLite, append-only) and runs the steps (in containers) |
| `apps/web` | The web UI (Next.js, shadcn/ui). Operations are requested through the daemon's API |
| `packages/cli` | The `sacty` command and the Dockerfile of the image for running agents |

See the [specification](../spec/README.en.md) for how it works in detail.

## Related pages

- [config.yaml settings](config.en.md)
- [CLI](cli.en.md)
- [Troubleshooting](troubleshooting.en.md)
