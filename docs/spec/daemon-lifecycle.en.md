[日本語](daemon-lifecycle.md) | **English**

# Daemon startup and shutdown

`sacty up` starts the daemon (`apps/daemon`) and the web UI (Next.js in `apps/web`) as child processes, and stops both when either one ends.
Only one daemon runs per `SACTY_HOME` (determined by an OS file lock).

Related ADRs: [The web UI is usable only from browsers that signed in with the per-start secret](../adr/20261018-0414-web-session-auth.md), [Allow turning off web UI sign-in in the settings](../adr/20261018-0929-web-auth-off-setting.md), [Tell users about newer sacty by comparing the local commit with main on GitHub](../adr/20261018-1213-update-check-against-main.md)

## sacty up

- The options are `--port` (the web UI port; default `4700`) and `--daemon-port` (the daemon port; default `4710`). Both must be integers from 1 to 65535,
  and the same value for both is an error.
- On every start, it creates the token used between the daemon and the web UI (32 random bytes in hex) and the web UI sign-in secret
  (32 random bytes in base64url; separate from the daemon token).
- It starts the daemon with the environment variables `SACTY_DAEMON_PORT`, `SACTY_DAEMON_TOKEN`, and `SACTY_WEB_URL` (`http://127.0.0.1:<web-ui-port>`; used for links in notifications),
  (removing the web UI sign-in secret `SACTY_WEB_TOKEN` even if the user's shell has it), and waits up to 15 seconds for `GET /api/health` to respond (checking every 200 milliseconds). If it does not respond, it stops.
- Once the daemon responds, it writes the daemon's address and token to `SACTY_HOME/daemon.json` (mode 0600) (read by `sacty context preview`).
  If the file already holds another sacty's address and that address responds with its token, it does not overwrite the file and shows a warning. When exiting, it removes the file only if it wrote it
  (the address and token are the same).
- Next, it starts the web UI with `next start -H 127.0.0.1 -p <web-ui-port>`, with `SACTY_DAEMON_URL`, `SACTY_DAEMON_TOKEN`,
  `SACTY_WEB_TOKEN` (the web UI sign-in secret), and `SACTY_WEB_PORT` (the web UI port).
- It prints the web UI sign-in URL (`http://127.0.0.1:<web-ui-port>/auth?token=<sign-in secret>`) in the terminal (see "Web UI sign-in" below).
- On SIGINT or SIGTERM, it sends SIGTERM to the child processes and exits after all of them have ended. Children still running after 30 seconds receive SIGKILL
  (it waits longer than the daemon's 20-second cleanup limit).
- When a child process ends unexpectedly, it stops the other one too and exits with a failure exit code (1 even if the child's exit code was 0). When the daemon
  exits with exit code `3` (`ALREADY_RUNNING_EXIT_CODE`), it reports that the daemon did not start because another sacty is running.

Code: `packages/cli/src/index.ts` (`up`, `waitForDaemon`, `parsePort`), `packages/cli/src/up-env.ts` (`daemonEnv`, `webEnv`, `signInUrl`), `packages/cli/src/context-preview.ts` (`claimDaemonFile`, `removeDaemonFile`, `DAEMON_FILE`)

## Web UI sign-in

Step containers can also reach the host's 127.0.0.1 (`host.docker.internal`), so the web UI relays to the daemon only the requests from the
browser of the person who started sacty.

- A browser that opens the sign-in URL (`/auth?token=<secret>`) gets a cookie (named `sacty-session-<web-ui-port>`; the value is an
  HMAC-SHA256 made from the secret; `HttpOnly`, `SameSite=Lax`, `Path=/`, 30 days) and is sent to the top (`/`). The redirect keeps the Host
  the browser opened (`127.0.0.1` and `localhost` get separate cookies). A wrong or empty secret gets 401 and no cookie. Opening just `/auth`
  after signing in sends the browser to the top.
- The sign-in URL can be used any number of times while that start lasts (you can open it again in another browser). After a restart the
  secret changes, and the old cookie and URL no longer work.
- It can be turned off with `web.auth: false` in `config.yaml` (on by default; also on when the settings file is missing or unreadable). When off, `sacty up`
  creates no secret and passes `SACTY_WEB_AUTH=off` to the web UI (it removes `SACTY_WEB_AUTH` from the user's shell, so only the settings file decides).
  The web UI can be used without checking the cookie (the Host check remains; the sign-in URL just redirects to the top), and the terminal shows the web UI URL
  and a warning that step containers can operate the web UI.
- On every request (pages, live refreshes, downloads, and Server Actions; except built static files and icons), the Proxy
  (`apps/web/src/proxy.ts`) checks the following. When it refuses, it returns only a fixed text in the screen's language, without the page
  parts (which query the daemon).
  - If the Host is not a loopback name (`127.0.0.1`, `localhost`, `[::1]`; any port), 403 (against DNS rebinding).
  - Without the cookie of the current start, 401. Without the web UI secret (not started with `sacty up`), also 401, with how to start.
- Where requests are relayed to the daemon (`daemonFetch`), the cookie of the current start is checked again, and without it the request is
  refused without using the daemon token (even an entry point outside the Proxy's range is not relayed).
- The daemon API's authentication (`SACTY_DAEMON_TOKEN`) does not change. The web UI secret is passed to neither the daemon nor step containers.
- When a live refresh of a page left open gets 401 (sacty was restarted and the old cookie no longer works), the page tells the user to open the new URL
  printed in the terminal, separately from the daemon being unreachable (the last fetched data stays on screen).

Code: `apps/web/src/proxy.ts`, `apps/web/src/lib/web-auth.ts`, `apps/web/src/lib/web-guard.ts`, `apps/web/src/lib/daemon.ts` (`daemonFetch`)

## Daemon startup order

1. If `SACTY_DAEMON_TOKEN` is missing, it tells you to start it from `sacty up` and exits with exit code 1. The port is `SACTY_DAEMON_PORT` (default 4710).
2. It creates the `SACTY_HOME` directory and takes the instance lock (see "Duplicate start" below). If it cannot, it exits before touching the activity log or anything else.
3. It opens `SACTY_HOME/sacty.db` (activity log, projects, sacty settings). The configuration (`config.yaml`) is reread every time it is used.
4. It cleans up docker compose services left by the previous daemon, and the per-run fetches of shared compose.
5. It cleans up host MCP server processes left by the previous daemon (including those of the context's command MCP servers, from the same records)
   ([Gateway](gateway.en.md)).
6. It starts listening on the gateway.
7. It recovers interrupted runs (`recoverInterrupted`):
   - An "Ask the Orchestrator" that was in the middle of answering is recorded as interrupted.
   - A deployment check that was in the middle of running is recorded as interrupted. For the after-merge watch step, the task is paused (`TaskPaused`, reason `error`) and checked again on resume. For tasks from before the step, it ends as not determined ([After-merge watch](deployment-watch.en.md)).
   - A Goal Guardian judgment that was in the middle of judging is recorded as not judged (`undecidable`).
   - Tasks that were running (`running`) are recorded as a run failure (`AgentRunFailed`) and paused (`TaskPaused`, reason `error`).
8. Steps that were waiting because they could not run are queued (`queueWaitingSteps`).
9. Startup problems (such as configuration errors) are printed to the terminal.
10. It listens for the API on `127.0.0.1:<port>`. Once listening, it retrieves the secrets it uses all at once (including the secrets in project contexts;
    fetching the contexts waits at most 30 seconds; [Secrets](secrets.en.md)),
    and then starts the host MCP servers, prepares the context's command MCP servers (removes the previous layer copies in `SACTY_HOME/context-mcp/layers`
    and starts the check that stops ones no longer used), prepares authentication for organization platforms (PF), and starts the worker, intake, and PR watching.

Every 2 seconds, the worker runs queued tasks in order of creation, oldest first, up to the limit of concurrent runs (`maxParallelTasks` in sacty settings; default
`DEFAULT_MAX_PARALLEL_TASKS` = 3). It never runs the same task twice at the same time. PR watching checks every 60 seconds, after the previous check has finished (CI/CD watching after merges is also done at the end of it).

Code: `apps/daemon/src/main.ts`, `apps/daemon/src/service.ts` (`recoverInterrupted`, `queueWaitingSteps`, `maxParallelTasks`),
`apps/daemon/src/worker.ts` (`Worker`), `apps/daemon/src/pr-watcher.ts` (`PullRequestWatcher`), `packages/core/src/projects.ts` (`DEFAULT_MAX_PARALLEL_TASKS`)

## Checking for a newer version

The daemon compares the commit of the running sacty with `main` of the sacty repository on GitHub (`SACTY_REPOSITORY` = `sert-xx/sacty`),
and if `main` has commits that the local one does not, it tells the web UI that a newer version is available (PBI-135). When releases start
being published, this switches to GitHub Releases.

- The local commit is `git rev-parse HEAD` of the sacty repository (three directories above `apps/daemon`). Because it is the commit of the
  running code, it is read once, at the first check after startup (after `git pull`, the previous commit is compared until a restart). If it is not
  40 hexadecimal digits, no check is made.
- If `ahead_by` of GitHub's compare API (`GET /repos/sert-xx/sacty/compare/<local>...main`; the number of commits in `main` that the local
  one lacks, seen from the local base toward the `main` head) is 1 or more, a newer version is available (`status` is `ahead` or `diverged`). `identical` and `behind` (the local one is only ahead) are not reported. No authentication is sent (the repository is public; well under
  the limit of 60 requests per hour).
- At startup and then every hour, it asks if one day (`UPDATE_CHECK_INTERVAL_MS`) has passed since the last request. The time is recorded
  before asking, so requests do not overlap. After a failure, the next request is one day later.
- When it cannot check (not a git working tree, a commit GitHub does not know, network unreachable, rate limited, an unexpected response,
  or no response in 10 seconds), it silently clears the notice. It is not an error or warning.
- With `update_check: false` in `config.yaml`, it does not ask and shows no notice (on if the config cannot be read). Since it is read on every
  use, turning it back on checks within an hour.
- The notice is `update` (`behindBy`, `compareUrl`) of `GET /api/status`, included even when the config has an error. The web UI shows it above
  the content on every screen: how many commits behind, a link to the compare page (only one starting with `https://github.com/`), and the update commands.

Code: `apps/daemon/src/update-check.ts` (`UpdateChecker`, `gitHeadCommit`, `startUpdateCheck`, `SACTY_REPOSITORY`, `UPDATE_CHECK_INTERVAL_MS`),
`apps/daemon/src/service.ts` (`TaskService.status`), `apps/web/src/components/shell/update-notice.tsx` (`UpdateNotice`, `safeCompareUrl`)

## Duplicate start

- The lock file is `SACTY_HOME/daemon.lock`. The daemon takes an SQLite exclusive lock (`PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;`) and
  keeps holding it without committing. The OS holds the lock on behalf of the process, so it is released however the daemon ends (including SIGKILL).
  The lock file is never removed. Because the lock is on the file (inode), a second start is prevented even if the same directory is reached by a different path.
- The daemon that took the lock writes `SACTY_HOME/daemon-owner.json` (PID, address, start time) for display. It is not used for the decision.
- When a second daemon cannot take the lock (`SQLITE_BUSY`), it shows the running daemon's address, PID, and start time (or that they could not be read)
  and exits with exit code `3`. Other failures to take the lock (such as permissions) are left as exceptions, and the daemon does not start.
- Even with different ports, a daemon with the same `SACTY_HOME` does not start. With different `SACTY_HOME`s, daemons can run in parallel on different ports.

Code: `apps/daemon/src/instance-lock.ts` (`acquireInstanceLock`, `alreadyRunningMessage`, `LOCK_FILE`, `OWNER_FILE`), `apps/daemon/src/exit-codes.ts` (`ALREADY_RUNNING_EXIT_CODE`)

## Daemon shutdown

On SIGINT or SIGTERM, the daemon does the following, only once.

1. It stops the git processes fetching contexts for retrieving secrets (they run in their own process groups) together with their groups (`stopFetchProcessesSync`).
2. It starts stopping the worker (no new runs start, and it waits for in-progress work to clean up), intake, and PR watching.
3. It starts stopping the host MCP servers and the context's command MCP servers (without waiting for cleanup; for the context's servers, the layer copies are also removed).
4. It stops the running agent and test containers.
5. It waits up to 20 seconds (`DRAIN_TIMEOUT_MS`) for the cleanup in step 2. After that, it shows a warning and continues.
6. It closes the gateway, waits for the host MCP servers to stop, closes the API listener, then closes the DB, releases the lock (also removing the
   `daemon-owner.json` it wrote), and exits with exit code 0.

When the daemon ends because of an exception or similar (`exit`), it also sends SIGTERM to the process groups of the host MCP servers, and SIGKILL to the process groups
of the git processes fetching contexts ([Secrets](secrets.en.md)).

Code: `apps/daemon/src/main.ts` (`shutdown`, `DRAIN_TIMEOUT_MS`), `apps/daemon/src/context-mcp.ts` (`ContextMcpServers.start`, `ContextMcpServers.stop`), `apps/daemon/src/fetch-processes.ts` (`spawnStoppable`, `stopFetchProcessesSync`)
