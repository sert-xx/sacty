[日本語](architecture.md) | **English**

# Overall structure

sacty consists of four packages in npm workspaces. The `sacty` command (cli) starts the resident daemon (daemon) and the web UI (web).
The web UI calls only the daemon's API, and the daemon records to the activity log and runs steps (in containers).

Related ADRs: none

## Packages

| Path | Package | Role | Dependencies (within sacty) |
| --- | --- | --- | --- |
| `packages/core` | `@sacty/core` | Event types of the activity log, the projection that builds task state from events, cost calculation, types for project and sacty settings, message codes | None (the only external one is `zod`) |
| `apps/daemon` | `@sacty/daemon` | Resident process. HTTP API, activity log (SQLite), step execution, gateway, intake, notifications | `@sacty/core` |
| `apps/web` | `@sacty/web` | Web UI (Next.js). Delegates operations to the daemon's API | `@sacty/core` |
| `packages/cli` | `sacty` command | Commands such as `sacty up`, and the Dockerfile of the image for running agents (`packages/cli/docker/Dockerfile`) | `@sacty/core`, `@sacty/daemon`, `@sacty/web` |

Code: `packages/core/package.json`, `apps/daemon/package.json`, `apps/web/package.json`, `packages/cli/package.json`

## Processes and communication

```text
sacty up (packages/cli)
 ├─ daemon (apps/daemon)  127.0.0.1:<--daemon-port; default 4710>
 │    ├─ gateway (AI relay, PF relay, MCP relay)  127.0.0.1
 │    └─ docker (agent and test containers, compose services)
 └─ web UI (apps/web, next start)  127.0.0.1:<--port; default 4700>
```

- The daemon's API (`/api/*`) requires the token that `sacty up` creates on every start, as `Authorization: Bearer` (compared with `timingSafeEqual`),
  and returns 401 (`unauthorized`) if it does not match. It listens only on `127.0.0.1`.
- The web UI calls the daemon only from the Next.js server side (the token is not passed to the browser). The address and token are read on every request from the environment variables
  `SACTY_DAEMON_URL` and `SACTY_DAEMON_TOKEN`.
- Input errors (zod validation) return 400 with `invalid_input`, and operations not allowed in the current state return 409 with `invalid_operation`; both return a message code and
  arguments (the web UI turns them into text in the UI language).

Main APIs (`apps/daemon/src/server.ts`):

| Kind | Path |
| --- | --- |
| Status | `GET /api/health`, `GET /api/status`, `GET /api/github/accounts` |
| Tasks | `GET/POST /api/tasks`, `GET /api/tasks/:id`, `POST /api/tasks/:id/{approve,request-changes,pause,resume,cancel,repository,questions,rereview}`, `GET /api/tasks/:id/cleanup-plan`, `POST /api/tasks/:id/remarks/:remarkId/void`, `POST /api/tasks/:id/proposals/:proposalId/decide`, `POST /api/tasks/:id/exports/:step/retry` |
| Run records | `GET /api/tasks/:id/runs/:runId/log`, `…/files/:file`, `…/agent-files`, `…/agent-files/raw` |
| Projects | `GET/POST /api/projects`, `GET/PUT /api/projects/:id`, `GET /api/projects/:id/{repositories,platforms,export}`, `GET/POST /api/projects/:id/context-preview`, `POST /api/projects/import`, `POST /api/projects/:id/notification-test` |
| sacty settings | `GET/PUT /api/settings`, `POST /api/intake/run`, `POST /api/secrets/prefetch` |

Code: `apps/daemon/src/server.ts` (`createApp`, `handleError`), `apps/web/src/lib/daemon.ts` (`daemonFetch`), `packages/cli/src/index.ts` (`up`)

## Data location (SACTY_HOME)

Data is stored under `SACTY_HOME` (default `~/.sacty`).

| Path | Contents |
| --- | --- |
| `config.yaml` | sacty configuration (AI, authentication, images, gateway, and so on). The daemon rereads it every time it uses it |
| `sacty.db` | SQLite. Activity log (events), projects, sacty settings ("sacty settings" on the web UI) |
| `daemon.lock`, `daemon-owner.json` | Detecting and reporting a second start ([Daemon startup and shutdown](daemon-lifecycle.en.md)) |
| `daemon.json` | The running daemon's address and token, queried by `sacty context preview` |
| `workspaces/` | Workspaces. `<task-id>/repo` (clone of the target repository), `<task-id>/empty` (tasks without a repository), `_git/<task-id>.git` (git metadata set aside right after the clone; never mounted into any container), and per-run `_guardian/<run-id>`, `_snapshots/<run-id>`, `_review/<run-id>`, `_export/<run-id>`, `_shared-compose/<run-id>` (all of `_shared-compose` is removed at startup) |
| `runs/` | Session logs for each agent run |
| `sessions/` | The Orchestrator's session for each task (a cache for reuse) |
| `cache/shared-compose/` | Cache of shared compose repositories |
| `host-mcp/processes/` | Process records of host MCP servers (including the context's command MCP servers) |
| `context-mcp/layers/` | Working directories of the context's command MCP servers started on the host (copies of the layer repositories) |

Code: `apps/daemon/src/config.ts` (`resolveHome`, `configPath`), `apps/daemon/src/main.ts`, `apps/daemon/src/service.ts` (`repoDir`, `trustedGitDir`), `apps/daemon/src/instance-lock.ts`, `packages/cli/src/context-preview.ts` (`DAEMON_FILE`)

## Two places for settings

- `config.yaml` (file): machine settings such as AI agents, authentication, images, gateway, and the intake interval. For the items, see
  [Configuration (config.yaml)](configuration.en.md).
- sacty settings (one row of the `settings` table in `sacty.db`): settings common to all projects, changed in "sacty settings" on the web UI.
  The intake label (`intakeLabel`), the ticket intake label (`ticketLabel`), the PR review label (`reviewLabel`),
  intake of review requests to yourself (`reviewRequested`), the triage kinds turned Off (`triageOff`), and the number of tasks run at the same time
  (`maxParallelTasks`; default 3).
- Projects (`sacty.db`): targets, GitHub account, context repository, notifications, shared compose, ticket intake, and so on.

Code: `apps/daemon/src/settings.ts` (`SqliteSettingsStore`), `packages/core/src/projects.ts` (`SactySettings`, `DEFAULT_MAX_PARALLEL_TASKS`), `apps/daemon/src/projects.ts`
