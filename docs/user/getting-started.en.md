<!-- Code: package.json, packages/cli/src/index.ts, apps/web/src/lib/paths.ts, apps/web/src/components/dashboard.tsx, apps/web/src/components/shell/rail.tsx, apps/daemon/src/config.ts (CONFIG_TEMPLATE, resolveHome), apps/daemon/src/instance-lock.ts -->

[日本語](getting-started.md) | **English**

# Getting started

This page walks you through installing sacty, starting it, and running your first task.
Work through the sections in order, from "Requirements" to "First project and task".
The sections after that explain how to update sacty and where its data is stored.

## Requirements

- macOS
- Node.js 26.13.1 or later
  - The version is written in `.node-version` and `mise.toml` at the repository root.
  - If your version manager (mise, nodenv, fnm, and so on) is set up to switch versions by directory (such as `mise activate` for mise or `--use-on-cd` for fnm), it uses that version.
  - If not, switch with a command such as `fnm use` before `npm ci`.
- Docker (Docker Desktop, OrbStack, Colima, and so on. Steps run inside containers)
- GitHub CLI (`gh`)
  - Sign in with the account you use to access GitHub ([Project settings](project-settings.en.md#github-account)).

## Setup

Clone the sacty repository ([sert-xx/sacty](https://github.com/sert-xx/sacty)) and run the following at its root.

```sh
npm ci
npm run build
npx sacty config init   # creates ~/.sacty/config.yaml
```

Next, set up the AI connection, the keys, and the container image.

1. **Configure the AI connection.**
   Open `~/.sacty/config.yaml` and set in `providers` the authentication method of the tool you use and the prices of the models you can use (`available_models`) ([config.yaml settings](config.en.md#connections-and-prices-providers)).
   - The template is set up to use Codex with an API key (`providers.codex`).
   - The models of the AI that runs the steps come from sacty's defaults, so you do not have to write `agents`.
2. **Save the keys.**
   Put the authentication tokens and API keys in the Keychain or 1Password ([Secrets](secrets.en.md)).
   If you keep the template as is, save your OpenAI API key using `npx sacty secret set openai-api-key`.
3. **Build the container image.**
   Build the container image for running agents with `npx sacty image build`.
   - If your environment cannot use Docker Hub or the public npm registry, write `image_build` before you build it ([Container images](images.en.md)).
   - If you start without the image, the output of `sacty up` and the top of the screen show the command to create it.
     They also tell you when Docker is not running.

### Using sacty in any directory

`npx sacty` works only inside the sacty repository.
To use it by typing `sacty` in other directories as well (such as your local clone of a target repository), run the following in the sacty repository.

```sh
npm run cli:install
```

After building (`npm run build`), this command places a launcher for `sacty` and checks that `sacty --version` shows this repository's version.
You can run it any number of times.

Where the launcher is placed is decided as follows.

- If you use mise, it registers the launcher with mise (`mise use --global sacty@<version>`; you can check it with `mise ls sacty`).
  - If the same version is registered another way, it does not overwrite it.
  - If it cannot register it, it tells you why and places it in `~/.local/bin/sacty`.
  - After registering, it tells you if `sacty` is not found in your current shell.
    With `mise activate`, you can use it from a new shell.
    If you use shims, add mise's shims directory to your `PATH`.
- If you do not use mise, it places it in `~/.local/bin/sacty`.
- If you specify the environment variable `SACTY_BIN_DIR`, it places it there without using mise.
- When it is placed without mise and the location is not in your `PATH`, or another `sacty` is found earlier in your `PATH`, it tells you with `[sacty] 注意：`.

The launcher works as follows.

- The launcher points to this repository.
  After you update sacty and build again, it runs the new version.
  If you run the command in a sacty clone in another location, `sacty` switches to point to that clone.
- The launcher runs sacty with the Node.js used when you ran the command (the version that mise or a similar tool chose in the sacty repository).
  Even if the Node.js version differs per directory with mise or a similar tool, it works the same in every directory.
- If an update of sacty changes the Node.js version (`mise.toml`), run the command again.
  The launcher's Node.js switches to the new version.
  If you forget to run it after removing the old Node.js version, `sacty` tells you to run it again.

If another `sacty` is used first, check the following.

- The command removes a `sacty` you installed earlier with `npm link` (the one for the current Node.js version).
  If one installed with another Node.js version remains, it may be found first in directories where that version is active.
  Run `npm rm -g @sacty/cli` with that version to remove it.
- If you define `sacty` with a shell `alias`, that one is used first.

To remove the launcher, delete the following, depending on how it was installed.

- Installed with mise: remove the `sacty` line from `[tools]` in mise's user-wide settings (`~/.config/mise/config.toml`) and delete `~/.local/share/sacty/mise` (or `$XDG_DATA_HOME/sacty/mise` if you set `XDG_DATA_HOME`).
- Installed without mise: delete `~/.local/bin/sacty` (or `sacty` in `SACTY_BIN_DIR` if you specified it).

## Start

```sh
npx sacty up
```

`sacty up` starts the daemon and the web UI and prints the web UI sign-in URL (`http://127.0.0.1:4700/auth?token=…`) in the terminal.
Open it in your browser (it does not open automatically).
Only browsers that opened this URL can use the web UI.

Press Ctrl+C to stop both.
You can change the ports with `--port` and `--daemon-port` ([CLI](cli.en.md#sacty-up)).

## Web UI screens

When you open the web UI, it shows the dashboard first.

| Screen | URL | Contents |
| --- | --- | --- |
| Dashboard | `/dashboard` (also when you open `/`) | Across all projects: what needs you, why tasks are paused, open tasks, cost and budget, the step queue, intake, throughput, and quality signals ([Dashboard](dashboard.en.md)). When Slack notifications could not be sent, the reason is shown above the sections |
| Task list | `/projects/<ID>/tasks` | The project's tasks. "Create task" is also here |
| Project settings | `/projects/<ID>/settings` | The project's settings ([Project settings](project-settings.en.md)) |
| Project list | `/projects` | Create and import projects |
| Task details | `/tasks/<ID>` | The task's progress, approvals, and run logs |

You move between screens with the header and the side menu.

- In the header's project switcher, choosing "All projects" moves to the dashboard, and choosing a project moves to that project's task list.
  The header shows the project of the open screen ("All projects" on the dashboard and similar screens).
- "Tasks" and "Settings" in the side menu open the task list and settings of the project selected in the header.
  While "All projects" is selected, "Tasks" is not shown and "Settings" opens the project list.
- Opening `/projects/<ID>` moves to that project's task list.
  Opening the ID of a project that does not exist shows that the page was not found.

## First project and task

1. Create a project.
   On the project list (`/projects`), create a project and register its "Targets" (GitHub orgs or repositories) and a "GitHub account" for each host ([Project settings](project-settings.en.md)).
2. Create a task.
   On that project's task list, press "Create task" and create a task ([Working with tasks](tasks.en.md)).
   To turn issues and PRs into tasks, set up [Issue, PR, and ticket intake](intake.en.md).

Once you register a target, sacty may push branches to the target repositories and open PRs, depending on the task.

## Updating sacty

Every day, sacty checks the latest release of the sacty repository on GitHub.
If a version newer than the running one has been released, every screen shows "A new version of Sacty is available" at the top.
Update when you see it, to get the recommended models ([Default agents](config.en.md#default-agents)) and fixes.

- The notice also appears on screens that are already open, without reloading (they fetch it again every 30 seconds).
- "See the release notes" in the notice opens the release description on GitHub.
- When it cannot check (no internet access, no release yet, and so on), nothing is shown.
  A version under development (newer than the latest release) shows nothing either.
- Where the internet is not reachable, write `update_check: false` in `config.yaml` to stop the check ([config.yaml settings](config.en.md)).

Update in the following order.

1. Stop the running `sacty up` with Ctrl+C and wait for it to exit.
2. Back up your data ([Back up before updating and returning to an older version](#back-up-before-updating-and-returning-to-an-older-version)).
3. Run the following commands in the sacty repository.

```sh
git pull origin main
npm ci
npm run build
npx sacty image build
npx sacty up
```

Here is what to know about each command.

- `npm ci` reinstalls the dependencies exactly as written in `package-lock.json`.
  It does not rewrite `package-lock.json`, so even if you changed the npm registry in your settings, no changes are left in the working tree and the next `git pull` does not conflict.
- `npm run build` deletes and recreates the web UI build output (`apps/web/.next`).
  Running it while `sacty up` is running can break the web UI, so always stop it first.
  - If you installed `sacty` with `npm run cli:install`, run `npm run cli:install` instead of `npm run build` (the launcher also switches when the Node.js version changes).
- `npx sacty image build` rebuilds the agent image.
  The default image name (`sacty-agent:<version>`) follows the version, so without rebuilding, runs stop because the image is missing.
  - If `image` in `config.yaml` still has the previous version's name (`sacty-agent:<previous version>`), the output of `sacty up` and the top of the screen show how to fix it.
    Change it as shown, then rebuild.
  - Even if you set your own name in `image` of `config.yaml`, rebuilding is the safe choice,
    because a new version may raise the agent CLI versions.

When an update changes the default models, you may see a warning about a model with no price in `available_models`.
Add the price of that model.

### Back up before updating and returning to an older version

Before updating, stop the daemon and back up the data directory specified by `SACTY_HOME` (default: `~/.sacty`).
A database containing new kinds of records (tasks with Document or Operation, audits of completed tasks and their fix tasks, and so on) cannot be read by an older version that does not support them, and startup fails.

To return to an older version, do the following.

- Use the backup made before the update.
- If your settings include the new steps, also restore settings compatible with the older version.
- Keep a separate copy of the data before returning to the older version, and check which history will be lost.
  Restoring the backup does not restore tasks or progress recorded after it was made.

Restoring the backup does not undo what happened outside sacty.

- External changes, such as calendar updates, are not rolled back.
- Fix tasks created from adopted audit proposals may already have opened PRs.
- External operation start records made after the backup are also lost.
  Check the actual external state and do not repeat changes already made.

## Where data is stored

sacty stores the activity log, settings, and workspaces in `~/.sacty/`.
You can change this with the environment variable `SACTY_HOME`.

Workspaces (`~/.sacty/workspaces/`) hold the following.

- Each task's clone of the target repository and per-run temporary copies of the code
- A per-task dependency cache (`~/.sacty/workspaces/_task-cache/`).
  It lets the steps and runs of the same task reuse the results of package downloads and the like, and it is not shared with other tasks

sacty removes the parts of the workspaces it no longer needs by itself.

- A completed task's workspace is removed once it is no longer used (for an audited task, after the audit ends).
- A cancelled task's workspace is removed on cancel.
- The dependency cache is removed at the same time as the task's workspace.
- When the daemon starts, it also removes the following leftovers.
  - A dependency cache left because the daemon stopped in the middle of a cancel
  - Temporary copies left when the daemon was stopped or restarted during a run
  - Workspaces of tasks completed with an earlier version

The following are not removed.

- The activity log (session logs in `~/.sacty/runs/`), Orchestrator sessions, memories, and `sacty.db`
- Places used by a running container.
  Nothing is removed when Docker cannot be queried, either.
  If something cannot be removed, the reason appears in the daemon's terminal.

When a workspace is needed after it was removed (re-reviewing a completed task, or asking the Orchestrator about it), sacty recreates it from the same base commit (it clones again, so this takes a little longer).

You cannot run two instances of sacty with the same `SACTY_HOME` (even on different ports).

- A second `sacty up` shows the address and PID of the running daemon and fails before it touches any data.
- sacty checks this with an OS file lock on `SACTY_HOME/daemon.lock`.
  So if the previous daemon dies suddenly (SIGKILL and so on), the next start is not blocked.
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
