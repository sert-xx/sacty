[日本語](daemon-lifecycle.md) | **English**

# Daemon startup and shutdown

`sacty up` starts the daemon (`apps/daemon`) and the web UI (Next.js in `apps/web`) as child processes, and stops both when either one ends.
Only one daemon runs per `SACTY_HOME` (determined by an OS file lock).

Related ADRs: none

## sacty up

- The options are `--port` (the web UI port; default `4700`) and `--daemon-port` (the daemon port; default `4710`). Both must be integers from 1 to 65535,
  and the same value for both is an error.
- On every start, it creates the token used between the daemon and the web UI (32 random bytes in hex).
- It starts the daemon with the environment variables `SACTY_DAEMON_PORT`, `SACTY_DAEMON_TOKEN`, and `SACTY_WEB_URL` (`http://127.0.0.1:<web-ui-port>`; used for links in notifications),
  and waits up to 15 seconds for `GET /api/health` to respond (checking every 200 milliseconds). If it does not respond, it stops.
- Once the daemon responds, it writes the daemon's address and token to `SACTY_HOME/daemon.json` (mode 0600) (read by `sacty context preview`).
  If the file already holds another sacty's address and that address responds with its token, it does not overwrite the file and shows a warning. When exiting, it removes the file only if it wrote it
  (the address and token are the same).
- Next, it starts the web UI with `next start -H 127.0.0.1 -p <web-ui-port>`, with `SACTY_DAEMON_URL` and `SACTY_DAEMON_TOKEN`.
- On SIGINT or SIGTERM, it sends SIGTERM to the child processes and exits after all of them have ended. Children still running after 30 seconds receive SIGKILL
  (it waits longer than the daemon's 20-second cleanup limit).
- When a child process ends unexpectedly, it stops the other one too and exits with a failure exit code (1 even if the child's exit code was 0). When the daemon
  exits with exit code `3` (`ALREADY_RUNNING_EXIT_CODE`), it reports that the daemon did not start because another sacty is running.

Code: `packages/cli/src/index.ts` (`up`, `waitForDaemon`, `parsePort`), `packages/cli/src/context-preview.ts` (`claimDaemonFile`, `removeDaemonFile`, `DAEMON_FILE`)

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
   - A deployment check that was in the middle of running is recorded as not determined (interrupted) ([After-merge watch](deployment-watch.en.md)).
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

1. It starts stopping the worker (no new runs start, and it waits for in-progress work to clean up), intake, and PR watching.
2. It starts stopping the host MCP servers and the context's command MCP servers (without waiting for cleanup; for the context's servers, the layer copies are also removed).
3. It stops the running agent and test containers.
4. It waits up to 20 seconds (`DRAIN_TIMEOUT_MS`) for the cleanup in step 1. After that, it shows a warning and continues.
5. It closes the gateway, waits for the host MCP servers to stop, closes the API listener, then closes the DB, releases the lock (also removing the
   `daemon-owner.json` it wrote), and exits with exit code 0.

When the daemon ends because of an exception or similar (`exit`), it also sends SIGTERM to the process groups of the host MCP servers.

Code: `apps/daemon/src/main.ts` (`shutdown`, `DRAIN_TIMEOUT_MS`), `apps/daemon/src/context-mcp.ts` (`ContextMcpServers.start`, `ContextMcpServers.stop`)
