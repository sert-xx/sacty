<!-- Code: package.json, packages/cli/src/index.ts, apps/daemon/src/config.ts (CONFIG_TEMPLATE, resolveHome), apps/daemon/src/instance-lock.ts -->

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
npx sacty image build   # builds the container image for running agents
```

1. Open the `~/.sacty/config.yaml` created by `npx sacty config init`, and set the AI that runs the steps (`default_agent` and `agents`),
   the authentication method, and the unit prices ([config.yaml settings](config.en.md)). In the template, `default_agent` is a Claude Code subscription (`claude-subscription`).
2. Put the authentication tokens and API keys in the Keychain or 1Password ([Secrets](secrets.en.md)). If you keep the template as is,
   save the token created with `claude setup-token` using `npx sacty secret set claude-oauth-token`.
3. Build the image with `npx sacty image build`. If your environment cannot use Docker Hub or the public npm registry, write `image_build` first
   ([Container images](images.en.md)).

## Start

```sh
npx sacty up
```

This starts the daemon and the web UI and opens `http://127.0.0.1:4700`. Press Ctrl+C to stop both. You can change the ports with `--port` and `--daemon-port`
([CLI](cli.en.md#sacty-up)).

## First project and task

1. In the web UI, create a project and register its "Targets" (GitHub orgs or repositories) and a "GitHub account" for each host
   ([Project settings](project-settings.en.md)).
2. Create a task in the web UI ([Working with tasks](tasks.en.md)). To turn issues and PRs into tasks,
   set up [Issue, PR, and ticket intake](intake.en.md).

Note: once you register a target, sacty may push branches to the target repositories and open PRs, depending on the task.

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
