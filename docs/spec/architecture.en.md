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

## Web UI structure (URLs)

| URL | Content |
| --- | --- |
| `/` | Moves to `/dashboard` |
| `/dashboard` | The dashboard. Looks across all projects |
| `/projects` | The project list (create, import) |
| `/projects/<ID>` | Moves to `/projects/<ID>/tasks` |
| `/projects/<ID>/tasks` | The project's task list (cards for tasks that need a human decision, "Create task") |
| `/projects/<ID>/settings` | The project's settings |
| `/projects/current`, `/projects/current/tasks` | Moves (303) to the settings or the task list of the displayed project (cookie). Any other `/projects/current/…` is 404 |
| `/tasks/<ID>`, `/tasks/<ID>/review`, `/tasks/<ID>/runs/<run ID>` | The task details, the deliverable review, the run log |
| `/settings` | The sacty settings |

- Links and destinations in the web UI are built in `apps/web/src/lib/paths.ts` (project IDs are encoded). After creating or importing a
  project, the UI moves to that project's settings (`/projects/<ID>/settings`). "Tasks" (the breadcrumb) on the task details goes back to the
  task list of the task's project (`/projects/current/tasks` before the task is read and while the daemon is unreachable).
- The project of a project screen is decided by the ID in the URL. An ID that is not in the daemon's project list is 404.
- The dashboard lays out sections (cards). They sit side by side when there is room and stack otherwise (a single section takes the full
  width). The only section for now is "Open tasks".
  - It shows the tasks of all projects except completed and cancelled ones (including awaiting approval, paused, and escalated; those whose
    `statusTone` is not `completed` or `cancelled`), most recently updated first (`updatedAt`, newest first). There is no limit on the count.
    Tasks of deleted projects are not shown.
  - Each row shows the title (a link to the task details), the project name, and the state. A row is 4rem high and the section is 5 rows high
    (20rem); with more rows, the section scrolls inside (the section takes focus so it can also be scrolled with the keyboard).
  - When there are no projects or no open tasks, it says so.
  - To add a section, add its data to `DashboardData` (`loadDashboard`) and add a `DashboardCard` to `LiveDashboard` (one refetch per screen).

Code: `apps/web/src/lib/paths.ts`, `apps/web/src/app/page.tsx`, `apps/web/src/app/dashboard/page.tsx`,
`apps/web/src/app/projects/[id]/page.tsx`, `apps/web/src/app/projects/[id]/tasks/page.tsx`, `apps/web/src/app/projects/[id]/settings/page.tsx`,
`apps/web/src/app/projects/current/[[...view]]/route.ts`, `apps/web/src/app/tasks/[id]/page.tsx` (`Breadcrumb`),
`apps/web/src/lib/dashboard-data.ts` (`loadDashboard`, `isOpenTask`, `openTaskRows`), `apps/web/src/components/dashboard.tsx` (`LiveDashboard`, `DashboardGrid`, `DashboardCard`, `OpenTasksCard`)

## Web UI header and side menu (the displayed project and notices)

- Which project the open screen belongs to is decided by the URL (`pageScope`). Project screens are `/projects/<ID>/tasks` and
  `/projects/<ID>/settings` (the URL's project) and `/tasks/…` (task details, review, run log; the displayed project). Everything else
  (the dashboard, the project list, the sacty settings, and so on) is an "All projects" screen.
- The header's project switcher shows "All projects" first (moves to `/dashboard`), followed by each project (changes the cookie with `/switch`,
  then moves to `/projects/<ID>/tasks`). On a project screen, the switcher shows that project as selected ("All projects" if the URL's ID is
  not in the project list); on an "All projects" screen, it shows "All projects" (the count is the total of tasks that need you in all projects).
- The displayed project is kept in the cookie `sacty-project` (httpOnly, `SameSite=Lax`, 1 year). The header's selection on screens such as the
  task details, and "Tasks" (`/projects/current/tasks`) and "Settings" (`/projects/current`) in the side menu, use the cookie's project. If the
  cookie has no project or the project no longer exists, the first project is used. Only IDs of the form `^[\w-]{1,100}$` are put in the cookie.
- The cookie changes in these cases: switching in the header and notices (`/switch`; without a destination, it moves to the switched project's
  task list), creating or importing a project (it becomes the created project), and opening a project's screen (task list, project settings, task
  details, review, run log). When a screen is opened, the cookie is changed only if it differs from the screen's project, by a server action after
  rendering (the screen and the header are redrawn). If the project is not in the daemon's project list (a task of a deleted project), it is not
  changed. If the list cannot be fetched, the project is not treated as missing and the cookie is changed.
- On an "All projects" screen, the side menu shows only "Dashboard" and "Settings", and "Settings" moves to the project list (`/projects`), so it
  never jumps to a project. The notices are not split by project and are listed newest first; opening one switches to the task's project and
  opens the task. On a project screen, the side menu shows "Dashboard", "Tasks", and "Settings", and the notices are split into "Other projects"
  and "This project".
- The header is in the root layout, so it is not redrawn by navigation (links) within the web UI (the selection is decided in the browser from the
  screen's URL). Server actions for operations that change what the notices cover (approve, request changes, pause, resume, cancel, create task,
  and so on) call `refresh()` so that the header is redrawn too (they call it before moving with `redirect` as well).
- Changes made in other tabs, the CLI, or the daemon (tasks added by intake, approvals, resumes, tasks the daemon picked up and started, and so on) are
  reflected in the header's project switcher (the counts that need you) and notices by "Refetching screen data" below. This applies on every screen,
  whatever the state of the tasks.

Code: `apps/web/src/components/shell/header.tsx` (`AppHeader`, `HeaderFallback`), `apps/web/src/components/shell/live-header.tsx` (`LiveHeaderMenus`, `selectedProject`),
`apps/web/src/components/shell/menus.tsx` (`ProjectMenu`, `NotificationsMenu`), `apps/web/src/components/shell/rail.tsx` (`railItems`), `apps/web/src/lib/page-scope.ts` (`pageScope`),
`apps/web/src/lib/header-data.ts` (`loadHeaderData`), `apps/web/src/components/shell/follow-project.tsx` (`FollowProject`),
`apps/web/src/lib/project-select.ts`, `apps/web/src/lib/current-project.ts` (`selectProject`),
`apps/web/src/app/switch/route.ts`, `apps/web/src/app/actions.ts`

## Refetching screen data

The dashboard, the task list, the task details, the deliverable review, the run log, the project list (the intake status), and the header's notices do not reload the screen (redraw the whole screen, including `router.refresh`). They refetch
only the data at a fixed interval, and only the parts that changed are reflected on the screen. Text being typed, selections, open dialogs and sections
(`details`), focus, and the scroll position are not lost, because the elements on the screen stay as they are.

- Where the data is refetched from (routes of the web UI's server), and what they return:

  | Route | Returns |
  | --- | --- |
  | `GET /live/dashboard` | The data of the dashboard's sections (open tasks. `loadDashboard`) |
  | `GET /live/tasks?project=<ID>` | The rows of the task list of the URL's project and the cards of tasks that need a person (only what is shown. `loadTaskList`). `{ missing: true }` if the project does not exist or the ID has the wrong form |
  | `GET /live/tasks/<ID>` | What the task details show (the task, the activity, the parent, the subtasks, what to clean up, the image choices, and so on. `loadTaskDetail`) |
  | `GET /live/header?current=<ID>` | The header's project switcher (the counts that need you) and notices (`loadHeaderData`) |
  | `GET /live/tasks/<ID>/review` | The task for the deliverable review screen |
  | `GET /live/tasks/<ID>/runs/<run ID>?events=&stderr=` | What was added to the run log after what the screen has (see below) |
  | `GET /live/projects` | The project list and the intake status (`loadProjectList`) |

- The interval is 3 seconds (`LIVE_INTERVAL_MS`). The data is refetched whatever the state of the tasks, including when there are no tasks and when every task
  is awaiting approval, paused, or completed. The next interval starts after the previous refetch has finished, so requests do not overlap.
- While the screen is not visible (the tab is hidden), the web UI does not poll. When it becomes visible, the data is refetched once right away.
- The task list is refetched for the URL's project, and the header for the project shown when the screen was drawn (so that switching the project in another
  tab does not change only the contents of this screen). The project changes when the screen is opened again (`/switch` and so on).
- The screen sends the version of the data it last received (a hash of the contents) in the header `x-sacty-live-version`. If it is the same, the web UI's
  server does not send the contents (`{ unchanged: true }`).
- Each refetch has a 10-second deadline (`LIVE_TIMEOUT_MS`), including reading the response body. At the deadline it is aborted and the next refetch is
  scheduled (so that refetching does not stay stuck on a web UI server or daemon that does not respond). The web UI's server also passes the browser's abort
  (the request being aborted) and an 8-second deadline (`LIVE_SERVER_TIMEOUT_MS`) to its requests to the daemon, and stops them including reading the body
  (`withDaemonSignal`, so that requests to a daemon that does not respond do not pile up with each refetch). If the server redraws the screen while a refetch is
  in progress, the result of that refetch (including a failure) is discarded.
- When the daemon cannot be reached or read, the route returns `{ unavailable: true }` with 200 (it does not keep showing errors). The screen keeps showing the
  data it last fetched and shows that it cannot update (that what is shown may not be current; the header shows "Updates paused"). The same applies when the
  deadline passes or the web UI's server cannot be reached. When the daemon can be reached again, the next interval reflects the changes and removes that notice.
- If the daemon could not be reached when the screen was drawn, the screen shows that it cannot connect until the daemon is reached, and then shows the contents.
  The task list, the task details, the deliverable review, and the run log then make the project of what they show the displayed project (`followProjectAction`; only when it
  differs from the cookie. If the daemon was reached when the screen was drawn, the server's `FollowProject` does this).
- The header refetches even when there are no projects (it does not show the switcher or notices). When the first project is created in another tab or the CLI,
  it shows the switcher and notices.
- Refetching does not fetch the target repository choices (for an Org target, `gh` queries GitHub). The choices in the create-task dialog are read once, when
  the dialog is opened ([Tasks and steps](tasks-and-steps.en.md)). In the task details, the choices for a person to pick a repository for a paused task are requested only while the screen
  does not have them yet (`?repositories=1`). If they could not be fetched (`ticketRepositoriesFailed`, kept apart from fetching zero choices), they are requested
  again after 30 seconds (`REPOSITORIES_RETRY_MS`).
- When a server action for an operation (approve, pause, resume, and so on) redraws the screen with `refresh()`, the data from that redraw is used.
- For the run log, the screen sends where what it has ends (a byte position in the file). While the run is in progress, the daemon
  (`?eventsFrom=&stderrFrom=` on `GET /api/tasks/:id/runs/:runId/log`) also reads only what comes after that position, and only what was added is sent to the
  web UI's server and the screen. The positions of what was returned are in `offsets` (`from`, `next`), and a character being written (in the middle of a
  multi-byte UTF-8 sequence) is left for the next read. After the run has finished (the file may be rewritten when it is closed, by redacting again or by the
  limits) and when the position is past the end of the file, the whole file is returned and the screen replaces what it has. The scroll position is not moved
  while you are reading in the middle; the screen follows new lines only while you are looking at the bottom. The list of the agent's original files (which
  computes hashes) is fetched after the run has finished. If only the list cannot be read, the log and the fact that the run finished are still returned
  (`agentFilesFailed`), and the screen shows that the list could not be read and is being retried, and refetches only the list. Refetching stops when the run has finished and the list has been fetched.
- The sacty settings and project settings screens are not redrawn automatically (only the header's notices are refetched). Their contents are settings
  that people edit, and they do not change with the state of tasks. To see the latest, open the screen again or reload it.

Code: `apps/web/src/lib/live.ts` (`pollWhileVisible`, `fetchLive`, `LIVE_INTERVAL_MS`, `LIVE_TIMEOUT_MS`), `apps/web/src/lib/use-live-data.ts` (`useLiveData`),
`apps/web/src/lib/live-server.ts` (`liveResponse`, `liveVersion`), `apps/web/src/app/live/tasks/route.ts`, `apps/web/src/app/live/tasks/[id]/route.ts`, `apps/web/src/app/live/header/route.ts`, `apps/web/src/app/live/dashboard/route.ts`, `apps/web/src/lib/task-list-data.ts` (`loadTaskList`),
`apps/web/src/lib/task-detail-data.ts` (`loadTaskDetail`), `apps/web/src/components/task-list.tsx` (`LiveTaskList`),
`apps/web/src/components/task-detail.tsx` (`LiveTaskDetail`), `apps/web/src/components/review.tsx` (`LiveReview`),
`apps/web/src/components/run-log.tsx` (`LiveRunLog`, `applyChunk`), `apps/web/src/lib/run-log-data.ts` (`loadAgentFiles`),
`apps/web/src/components/live-status.tsx` (`StaleNotice`, `FollowProjectAfterRecovery`), `apps/daemon/src/session-logs.ts` (`completeUtf8Length`), `apps/web/src/lib/daemon-signal.ts` (`withDaemonSignal`, `LIVE_SERVER_TIMEOUT_MS`),
`apps/web/src/components/project-list.tsx` (`LiveProjectList`), `apps/web/src/lib/project-list-data.ts` (`loadProjectList`)

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

- `config.yaml` (file): machine settings such as AI agents, authentication, images, and gateway. For the items, see
  [Configuration (config.yaml)](configuration.en.md).
- sacty settings (one row of the `settings` table in `sacty.db`): settings common to all projects, changed in "sacty settings" on the web UI.
  The intake label (`intakeLabel`; issues only), the ticket intake label (`ticketLabel`), the PR review label (`reviewLabel`),
  intake of review requests to yourself (`reviewRequested`), the triage kinds turned Off (`triageOff`; `issues`, `reviewLabel`, `tickets`), and
  the number of tasks run at the same time (`maxParallelTasks`; default 3), and the interval per kind of intake (`issueIntervalSec`, `reviewIntervalSec`,
  `ticketIntervalSec`; seconds; 60 or more; default 300; [Intake](intake.en.md#interval)).
  - When the settings store is opened (when the daemon starts), a removed item (`pullRequests` in `triageOff`) that is still saved is removed and the settings are rewritten
    (nothing is written if there is nothing to remove).
- Projects (`sacty.db`): targets, GitHub account, context repository, notifications, shared compose, ticket intake, and so on.

Code: `apps/daemon/src/settings.ts` (`SqliteSettingsStore`, `dropRemovedItems`), `packages/core/src/projects.ts` (`SactySettings`, `DEFAULT_MAX_PARALLEL_TASKS`), `apps/daemon/src/projects.ts`
