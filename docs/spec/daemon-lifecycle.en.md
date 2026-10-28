[日本語](daemon-lifecycle.md) | **English**

# Daemon startup and shutdown

`sacty up` starts the daemon (`apps/daemon`) and the web UI (Next.js in `apps/web`) as child processes, and stops both when either one ends. Only one daemon runs per `SACTY_HOME` (an OS file lock decides this).

Related ADRs: [The web UI is usable only from browsers that signed in with the per-start secret](../adr/20261018-0414-web-session-auth.md), [Allow turning off web UI sign-in in the settings](../adr/20261018-0929-web-auth-off-setting.md), [Compare the running version with the latest GitHub release to report a newer sacty](../adr/20261020-0008-update-check-against-releases.md)

## sacty up

- The options are `--port` (the web UI port; default `4700`) and `--daemon-port` (the daemon port; default `4710`). Both must be integers from 1 to 65535, and the same value for both is an error.
- On every start, it creates two values.
  - The token used between the daemon and the web UI (32 random bytes in hex)
  - The web UI sign-in secret (32 random bytes in base64url; separate from the daemon token)
- It starts the daemon with the environment variables `SACTY_DAEMON_PORT`, `SACTY_DAEMON_TOKEN`, and `SACTY_WEB_URL` (`http://127.0.0.1:<web-ui-port>`; used for links in notifications). It removes the web UI sign-in secret `SACTY_WEB_TOKEN` from the daemon's environment even if the user's shell has it. It then waits up to 15 seconds for `GET /api/health` to respond (checking every 200 milliseconds), and stops the daemon if it does not respond.
- Once the daemon responds, it writes the daemon's address and token to `SACTY_HOME/daemon.json` (mode 0600), which `sacty context preview` reads.
  - If the file already holds another sacty's address and that address responds with its token, it does not overwrite the file and shows a warning.
  - When exiting, it removes the file only if it wrote it (the address and token are the same).
- Next, it starts the web UI with `next start -H 127.0.0.1 -p <web-ui-port>`. The environment variables are `SACTY_DAEMON_URL`, `SACTY_DAEMON_TOKEN`, `SACTY_WEB_TOKEN` (the web UI sign-in secret), and `SACTY_WEB_PORT` (the web UI port).
- It prints the web UI sign-in URL (`http://127.0.0.1:<web-ui-port>/auth?token=<sign-in secret>`) in the terminal (see "Web UI sign-in" below).
- On SIGINT or SIGTERM, it shows that it is stopping and that pressing Ctrl+C again stops without waiting, sends SIGTERM to the child processes, and exits after all of them have ended. Children still running after 30 seconds receive SIGKILL (it waits longer than the daemon's 20-second cleanup limit).
- On another SIGINT or SIGTERM while stopping, it stops without waiting for cleanup. It sends `FORCE_STOP_SIGNAL` (SIGUSR2) to the daemon and SIGKILL to the web UI, and sends SIGKILL to children still running after 5 seconds. With Ctrl+C, the SIGINT from the terminal also reaches the daemon directly and overlaps with the SIGTERM from the CLI, so the daemon does not count SIGINTs and tells the forced stop apart by a separate signal.
- When a child process ends unexpectedly, it stops the other one too and exits with a failure exit code (1 even if the child's exit code was 0). When the daemon exits with exit code `3` (`ALREADY_RUNNING_EXIT_CODE`), it reports that the daemon did not start because another sacty is running.

Code: `packages/cli/src/index.ts` (`up`, `waitForDaemon`, `parsePort`), `packages/cli/src/up-stop.ts` (`UpStopper`, `STOP_TIMEOUT_MS`, `FORCE_STOP_TIMEOUT_MS`), `apps/daemon/src/exit-codes.ts` (`FORCE_STOP_SIGNAL`), `packages/cli/src/up-env.ts` (`daemonEnv`, `webEnv`, `signInUrl`), `packages/cli/src/context-preview.ts` (`claimDaemonFile`, `removeDaemonFile`, `DAEMON_FILE`)

## Web UI sign-in

The web UI relays to the daemon only the requests from the browser of the person who started sacty, because step containers can also reach the host's 127.0.0.1 (`host.docker.internal`).

- A browser that opens the sign-in URL (`/auth?token=<secret>`) gets a cookie and is sent to the top (`/`).
  - The cookie is named `sacty-session-<web-ui-port>`, and its value is an HMAC-SHA256 made from the secret. Its attributes are `HttpOnly`, `SameSite=Lax`, `Path=/`, and 30 days.
  - The redirect keeps the Host the browser opened (`127.0.0.1` and `localhost` get separate cookies).
  - A wrong or empty secret gets 401 and no cookie.
  - Opening just `/auth` after signing in sends the browser to the top.
- The sign-in URL can be used any number of times while that start lasts (you can open it again in another browser). After a restart the secret changes, and the old cookie and URL no longer work.
- You can turn sign-in off with `web.auth: false` in `config.yaml` (on by default; also on when the settings file is missing or unreadable). When it is off, the following applies.
  - `sacty up` creates no secret and passes `SACTY_WEB_AUTH=off` to the web UI. It removes `SACTY_WEB_AUTH` from the user's shell environment, so only the settings file decides.
  - The web UI can be used without the cookie check. The Host check remains, and the sign-in URL just redirects to the top.
  - The terminal shows the web UI URL and a warning that step containers can operate the web UI.
- On every request (pages, live refreshes, downloads, and Server Actions; except built static files and icons), the Proxy (`apps/web/src/proxy.ts`) checks the following. When it refuses, it returns only a fixed text in the screen's language, without the page parts (which query the daemon).
  - If the Host is not a loopback name (`127.0.0.1`, `localhost`, `[::1]`; any port), 403 (against DNS rebinding).
  - Without the cookie of the current start, 401. Without the web UI secret (not started with `sacty up`), also 401, with how to start.
- Where the web UI relays requests to the daemon (`daemonFetch`), it checks the cookie of the current start again. Without it, it refuses the request without using the daemon token (even an entry point outside the Proxy's range is not relayed).
- The daemon API's authentication (`SACTY_DAEMON_TOKEN`) does not change. The web UI passes its secret to neither the daemon nor step containers.
- When a live refresh of a page left open gets 401, the page tells the user to open the new URL printed in the terminal. This happens when sacty was restarted and the old cookie no longer works, and the page reports it separately from the daemon being unreachable. The last fetched data stays on screen.

Code: `apps/web/src/proxy.ts`, `apps/web/src/lib/web-auth.ts`, `apps/web/src/lib/web-guard.ts`, `apps/web/src/lib/daemon.ts` (`daemonFetch`)

## Daemon startup order

1. If `SACTY_DAEMON_TOKEN` is missing, the daemon tells you to start it from `sacty up` and exits with exit code 1. The port is `SACTY_DAEMON_PORT` (default 4710).
2. It creates the `SACTY_HOME` directory and takes the instance lock (see "Duplicate start" below). If it cannot, it exits before touching the activity log or anything else.
3. It opens `SACTY_HOME/sacty.db` (activity log, projects, sacty settings). It rereads the configuration (`config.yaml`) every time it uses it.
4. It cleans up docker compose services left by the previous daemon, and the per-run fetches of shared compose.
5. It cleans up host MCP server processes left by the previous daemon ([Gateway](gateway.en.md)). It cleans up those of the context's command MCP servers too, from the same records.
6. It starts listening on the gateway.
7. It recovers interrupted runs (`recoverInterrupted`).
   - An "Ask the Orchestrator" that was in the middle of answering is recorded as interrupted.
   - A deployment check that was in the middle of running is recorded as interrupted. For the after-merge watch step, the task is paused (`TaskPaused`, reason `error`) and checked again on resume. For tasks from before the step, it ends as not determined ([After-merge watch](deployment-watch.en.md)).
   - A Goal Guardian judgment that was in the middle of judging is recorded as not judged (`undecidable`).
   - Tasks that were running (`running`) are recorded as a run failure (`AgentRunFailed`) and paused (`TaskPaused`, reason `error`).
8. It starts removing workspaces left by the previous daemon (`cleanupWorkspacesAtStartup`; [Tasks and steps](tasks-and-steps.en.md#cleaning-up-the-workspaces-of-finished-tasks)).
   - Per-run scratch directories that do not belong to a running run.
   - Workspaces and set-aside git metadata of completed tasks that no longer use them, and of no task.

   It moves on without waiting for the removal to finish (so listening for the API is not delayed; `sacty up` waits up to 15 seconds to confirm the start).
   If it cannot remove them, it prints the reason to the terminal and keeps starting.
9. It queues steps that were waiting because they could not run (`queueWaitingSteps`).
10. It prints startup problems (such as configuration errors) to the terminal.
11. It listens for the API on `127.0.0.1:<port>`. Once listening, it retrieves the secrets it uses all at once (including the secrets in project contexts; fetching the contexts waits at most 30 seconds; [Secrets](secrets.en.md)). After that, once the removal in step 8 has finished, it starts the following (not if it has started shutting down in the meantime).
    - Starting the host MCP servers
    - Preparing the context's command MCP servers (removing the previous layer copies in `SACTY_HOME/context-mcp/layers` and starting the check that stops ones no longer used)
    - Preparing authentication for organization platforms (PF)
    - The worker, intake, PR watching, and scheduled tasks

Every 2 seconds, the worker runs queued tasks in order of creation, oldest first. The limit of concurrent runs is `maxParallelTasks` in sacty settings (default `DEFAULT_MAX_PARALLEL_TASKS` = 3). It never runs the same task twice at the same time.

PR watching checks every 60 seconds, after the previous check has finished. CI/CD watching after merges also runs at the end of each check.

Code: `apps/daemon/src/main.ts`, `apps/daemon/src/workspace-cleanup.ts` (`startAfterCleanup`), `apps/daemon/src/service.ts` (`recoverInterrupted`, `cleanupWorkspacesAtStartup`, `queueWaitingSteps`, `maxParallelTasks`),
`apps/daemon/src/worker.ts` (`Worker`), `apps/daemon/src/pr-watcher.ts` (`PullRequestWatcher`), `packages/core/src/projects.ts` (`DEFAULT_MAX_PARALLEL_TASKS`)

## Checking for a newer version

The daemon compares the version of the running sacty (`version` in `apps/daemon/package.json`) with the latest release of the sacty repository on GitHub (`SACTY_REPOSITORY` = `sert-xx/sacty`; the `latest` of GitHub Releases, tag `v<version>`) (PBI-135, PBI-147). If the latest release is newer, it tells the web UI that a newer version is available. Before 1.0.0, it compared the local commit with `main`.

- The running version is `version` in `apps/daemon/package.json` (the same file whether running from src or dist).
  - Because it is the version of the running code, the daemon reads it once, at the first check after startup. After an update, it compares the previous version until a restart.
  - If it is not semver `MAJOR.MINOR.PATCH` (a leading `v` is optional; leading zeros, prereleases and builds are not accepted), no check is made.
- The daemon reads `tag_name` of GitHub's latest-release API (`GET /repos/sert-xx/sacty/releases/latest`) in the same form and compares numerically (`1.10.0` is newer than `1.9.0`).
  - If the latest release's version is greater than the running one, a newer version is available. Equal or smaller (the local one is a newer version under development) is not reported.
  - Drafts and prereleases are not used (`latest` does not return them, but they are ignored if returned).
  - No authentication is sent (the repository is public; well under the limit of 60 requests per hour).
- At startup and then every hour, the daemon asks if one day (`UPDATE_CHECK_INTERVAL_MS`) has passed since the last request. It records the time before asking, so requests do not overlap. After a failure, the next request is one day later.
- When it cannot check, it silently clears the notice. It is not an error or warning. It cannot check when the version cannot be read, there is no release at all (404), the network is unreachable, it is rate limited, the response has an unexpected form, the tag is not a version, or there is no response in 10 seconds.
- With `update_check: false` in `config.yaml`, the daemon does not ask (nor read the running version) and shows no notice (on if the config cannot be read).
  - It reads the setting on every use.
  - When it sees off (when checking or when returning the status), it clears the notice and the request time and advances the generation.
  - If the setting is turned off while waiting for the version or for the response, it does not ask or keep the result (even if the setting is back on by then).
  - Turning it back on checks within an hour.
- The notice is `update` (`latest`, `current`, `releaseUrl`) of `GET /api/status`. It is included even when the config has an error.
  - The web UI shows it above the content on every screen: the latest and running versions, a link to the release page (only one starting with `https://github.com/`), and the update commands.
  - The shared frame is not redrawn when moving between screens. So the web UI fetches `/live/update` every 30 seconds (`UPDATE_LIVE_INTERVAL_MS`), and the notice appears and disappears without reloading.
- The update commands are shown in the order of stopping the running `sacty up` first (`npm run build` deletes and recreates `.next` of the web UI). Because the default image name follows the version, `npx sacty image build` is included. Dependencies are reinstalled with `npm ci` (it does not rewrite `package-lock.json`, so even with a changed registry setting no changes are left in the working tree and the next `git pull` does not conflict).

Code: `apps/daemon/src/update-check.ts` (`UpdateChecker`, `packageVersion`, `parseVersion`, `compareVersions`, `startUpdateCheck`, `SACTY_REPOSITORY`, `UPDATE_CHECK_INTERVAL_MS`),
`apps/daemon/src/service.ts` (`TaskService.status`), `apps/web/src/components/shell/update-notice.tsx` (`UpdateNotice`),
`apps/web/src/components/shell/update-notice-live.tsx` (`UpdateNoticeLive`, `UPDATE_LIVE_INTERVAL_MS`), `apps/web/src/components/shell/update-notice-view.tsx` (`UpdateNoticeView`, `safeGitHubUrl`, `UPDATE_COMMANDS`)

## Checking Docker and the agent images

At startup and then every minute (`IMAGE_CHECK_INTERVAL_MS`), the daemon checks whether Docker is usable (PBI-148). It checks whether Docker is running, whether the agent images exist locally, and whether the configured images are the ones for the running version of sacty. This tells you about problems before a task runs and stops with `run.imageMissing` or similar.

- First it runs `docker version --format {{.Server.Version}}` to check whether Docker (the daemon) is running.
  - Exit code 0 means it is running.
  - If the docker command is not found (`ENOENT` on spawn), it shows a single `image.dockerNotInstalled` notice and does not check the images.
  - Otherwise (the daemon is not reachable, or no response in 10 seconds (`IMAGE_INSPECT_TIMEOUT_MS`); it is stopped if it does not respond), it shows a single `image.dockerUnreachable` notice and does not check the images.
- The images checked are `image` in `config.yaml` (default `sacty-agent:<version>`) and the images in `images.*` (each name once).
  - Without a config file, it checks only the default image.
  - With a config error, it checks no images. The config error is reported separately. It still checks whether Docker is running.
  - It reads the config on every check.
- When a configured image is one sacty names (`sacty-agent` for the default, `sacty-agent-<name>` per language) and only its tag differs from the running version of sacty, the daemon reports it as outdated (`image.outdated`).
  - An example is `image: sacty-agent:<previous version>` written by `sacty config init` that is still there after an upgrade. A missing tag counts too.
  - The notice gives the place to fix (`image` or `images.<name>.image`), the image name for the running version, and the command to create it.
  - It does not check whether that image exists locally.
  - It does not compare other names (names you chose, registry images).
- For the other images, it runs `docker image inspect --format {{.Id}} <name>`.
  - Exit code 0 means the image exists.
  - `No such image` or `No such object` on stderr means it is missing.
  - Anything else (Docker not reachable, no docker, or no response in 10 seconds; it is stopped if it does not respond) means it cannot be checked.
- For each missing image, the notice gives the name and the command to create it (`image.missing`).
  - The command is `npx sacty image build` for the default image, and `npx sacty image build <name>` for a per-language image.
  - For an image whose name includes a registry host (`.` or `:` before the first `/`, or `localhost`), it also says runs will try to pull it (`image.notLocal`).
  - If any image cannot be checked, it shows a single `image.dockerUnreachable` notice.
- The notices are in `docker` of `GET /api/status` (separate from `warnings`). They are included also when there is no config file (when `problems` has the config error).
  - The web UI shows them above the content on every screen as "Docker is not ready" (`DockerNotice`).
  - The web UI refetches them from `/live/docker` every 30 seconds (`DOCKER_LIVE_INTERVAL_MS`). Once fixed, they disappear without a reload. If the refetch fails, the last shown notices stay.
- The daemon also prints the result of the first check to the terminal (the output of `sacty up`). It does not stop startup, build anything automatically, or change the config. Once you fix the problem, the notice disappears at the next check. Checks do not overlap.
- When the daemon stops, it stops the interval and the running docker command (`SIGKILL`). It does not keep the result of an aborted check, and runs no further checks.

Code: `apps/daemon/src/image-presence.ts` (`ImagePresenceChecker`, `pingDocker`, `inspectImage`, `imageTargets`, `isOutdatedImage`, `isRegistryImage`, `buildCommand`, `startImagePresenceCheck`, `IMAGE_CHECK_INTERVAL_MS`, `IMAGE_INSPECT_TIMEOUT_MS`),
`apps/daemon/src/service.ts` (`TaskService.status`), `apps/daemon/src/main.ts`, `apps/web/src/components/shell/docker-notice.tsx` (`DockerNotice`),
`apps/web/src/components/shell/docker-notice-live.tsx` (`DockerNoticeLive`, `DOCKER_LIVE_INTERVAL_MS`), `apps/web/src/components/shell/docker-notice-view.tsx` (`DockerNoticeView`),
`apps/web/src/app/live/docker/route.ts`

## Duplicate start

- The lock file is `SACTY_HOME/daemon.lock`.
  - The daemon takes an SQLite exclusive lock (`PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;`) and keeps holding it without committing.
  - The OS holds the lock on behalf of the process, so the lock is released however the daemon ends (including SIGKILL).
  - The lock file is never removed.
  - Because the lock is on the file (inode), a second start is prevented even if the same directory is reached by a different path.
- The daemon that took the lock writes `SACTY_HOME/daemon-owner.json` (PID, address, start time) for display. It is not used for the decision.
- When a second daemon cannot take the lock (`SQLITE_BUSY`), it shows the running daemon's address, PID, and start time, and exits with exit code `3`. If it cannot read them, it says so. Other failures to take the lock (such as permissions) are left as exceptions, and the daemon does not start.
- Even with different ports, a daemon with the same `SACTY_HOME` does not start. With different `SACTY_HOME`s, daemons can run in parallel on different ports.

Code: `apps/daemon/src/instance-lock.ts` (`acquireInstanceLock`, `alreadyRunningMessage`, `LOCK_FILE`, `OWNER_FILE`), `apps/daemon/src/exit-codes.ts` (`ALREADY_RUNNING_EXIT_CODE`)

## Daemon shutdown

On SIGINT or SIGTERM, the daemon does the following, only once.

1. It stops the git processes fetching contexts for retrieving secrets, together with their process groups (`stopFetchProcessesSync`). These git processes run in their own process groups.
2. It starts stopping the worker, intake, and PR watching. The worker starts no new runs and waits for in-progress work to clean up.
3. It starts stopping the host MCP servers and the context's command MCP servers. It does not wait for cleanup. For the context's servers, it also removes the layer copies.
4. It stops the running agent containers. After this, it starts no new containers (a run that was copying its workspace ends with `run.daemonStopped` without starting, even after the copy finishes).
5. It waits up to 20 seconds (`DRAIN_TIMEOUT_MS`) for the cleanup in step 2. If it has not finished after 3 seconds (`DRAIN_REPORT_MS`), it shows what has not finished yet (running tasks, intake, PR checks, scheduled task checks). After 20 seconds, it shows a warning and continues.
6. It closes the gateway, waits for the host MCP servers to stop, and closes the API listener. If the host MCP servers have not stopped after 3 seconds, it also shows that it is waiting for them. Then it closes the DB, releases the lock (also removing the `daemon-owner.json` it wrote), and exits with exit code 0.

On `FORCE_STOP_SIGNAL` (SIGUSR2; `sacty up` sends it when Ctrl+C is pressed again) while stopping, it exits with exit code 1 without waiting for cleanup. Runs that were being cleaned up are recovered as interrupted at the next start (step 7 of "Daemon startup order" above).

When the daemon ends because of an exception or similar (`exit`, including when it ends on `FORCE_STOP_SIGNAL`), it also sends SIGTERM to the process groups of the host MCP servers, and SIGKILL to the process groups of the git processes fetching contexts ([Secrets](secrets.en.md)).

Code: `apps/daemon/src/main.ts` (`shutdown`, `DRAIN_TIMEOUT_MS`, `DRAIN_REPORT_MS`), `apps/daemon/src/shutdown-report.ts` (`waitNamed`), `apps/daemon/src/exit-codes.ts` (`FORCE_STOP_SIGNAL`), `apps/daemon/src/agents/docker.ts` (`DockerExecutor.abortAll`), `apps/daemon/src/context-mcp.ts` (`ContextMcpServers.start`, `ContextMcpServers.stop`), `apps/daemon/src/fetch-processes.ts` (`spawnStoppable`, `stopFetchProcessesSync`)
