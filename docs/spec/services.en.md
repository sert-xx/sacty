[日本語](services.md) | **English**

# Services (docker compose)

When tests or checks need a database, a mock API, or similar, sacty starts docker compose services on the host and connects the agent and test containers
to their network (agents are not given Docker permissions). The compose file is either the target repository's own or a shared compose
(in another repository) written in the project, never both.

Related ADR: [Service builds cannot tag shared images, and the agent image is pinned to an ID](../adr/20261018-0430-compose-build-image-isolation.md)

## When services start

- Which services of which compose file are used in which step is decided by the Orchestrator when it chooses the steps ([Tasks and steps](tasks-and-steps.en.md)).
  The steps that can use them are `investigate` (only when investigating a bug), `reproduce`, and `implement`.
- Services start for each step agent run and each test run, and are removed afterward.
- A shared compose does not start just by being written in the project. It is fetched and started only when the Orchestrator chooses it by name (only for tasks
  that have a target repository). If a name not in the settings is chosen, the step stops (`services.sharedUnknown`).

Code: `apps/daemon/src/service.ts` (`serviceSpec`, `startServices`, `stopServices`, `runTests`, `withSharedCompose`), `apps/daemon/src/prompts.ts` (`SERVICE_STEPS`, `composeServicesOf`)

## Starting and stopping

1. If the compose file is outside the workspace, the step stops. sacty checks that referenced files (`include`, `extends`, `env_file`, `label_file`, `project_directory`) are inside the workspace
   (`$` cannot be used in paths).
2. The file is normalized with `docker compose -f <file> config --format json --no-env-resolution`.
3. Only the services in use and their dependencies (`depends_on`, `network_mode: service:`) are kept, and the safety check runs (below).
4. `ports` and `container_name` are removed from each service, and each is put on the network `sacty`. Fixed names of networks and volumes are removed.
   From services with `build`, `image` and `build.tags` are removed and `pull_policy: build` is set (so built images cannot take tags shared on the host, such
   as the agent image; compose names them `<project>-<service>`).
   The owner label `io.sacty.owner` (the PID and start time of the daemon that started it) is added.
5. With the settings written to a temporary file, the services start with `docker compose -p sacty-svc-<name derived from the run ID> -f <settings> up -d --wait --wait-timeout 300 <services>`.
   The agent and test containers connect with `--network sacty-svc-…_sacty`, and reach the services by service name and container port.
6. Afterward (even on failure or timeout), `docker compose -p <name> down -v --remove-orphans --rmi local` removes the containers, networks, volumes,
   and built images.
- In steps that use services, before starting them, the agent image (the step's image) is pinned to its image ID with `docker image inspect`, and the run uses
  that ID (it keeps the pinned image even if the tag changes after the services start). If the ID cannot be read, the run uses the name.
- Failure reasons are the last 2000 characters after redacting secrets.
- At daemon startup, projects whose names start with `sacty-svc-` and whose owner-label daemon is not running (including those without the label) are
  removed. If `ps` cannot be read, nothing is removed.

Code: `apps/daemon/src/services.ts` (`DockerComposeServices.startOnce`, `stop`, `cleanupAll`, `imageId`, `sanitizeCompose`, `composeProject`, `labelOwner`, `OWNER_LABEL`, `LOG_TAIL`)

## Safety check

If the services in use or their dependencies have any of the following, sacty does not start them and stops with the reason (`services.unsafe`).

- `privileged`, `cap_add`, `devices`, `device_cgroup_rules`, `volumes_from`, `cgroup_parent`, `use_api_socket`, `provider`
- `network_mode` (other than `service:` and `bridge`), `host` or `container:` for `pid`, `ipc`, `uts`, `userns_mode`, or `cgroup`, and `unconfined` in `security_opt`
- Bind mounts outside the workspace (including types other than `volume` and `tmpfs`), a `build` context or Dockerfile outside the workspace, `additional_contexts`,
  `ssh`, `network: host`, `privileged`, `entitlements`, or `cache_to` in `build`, and `env_file` outside the workspace
- Top-level `external` networks or volumes, network `driver` other than `bridge`, volume `driver` or `driver_opts`,
  and `secrets` or `configs` that are `external` or have a `file` outside the workspace

Code: `apps/daemon/src/services.ts` (`sanitizeCompose`, `checkComposeSources`)

## Forwarding localhost

In runs that started services, `127.0.0.1:<port>` (and `[::1]` if available) inside the agent and test containers is forwarded to the same port of the service
(so that it is reachable even if the repository's settings still point to localhost).

- What is forwarded: the services' TCP container ports (`ports`, `expose`) and the numbers published to the host in `ports` (for `"15432:5432"`, `localhost:15432` also goes
  to `db:5432`). Within the same service, the mapping of published host numbers takes precedence. Non-TCP ports are not forwarded.
- When multiple services use the same localhost number, that number is not forwarded (it appears in `sharedPorts` in the record and in the instructions to the agent).
- Forwarding is done by a small Node.js script that sacty starts inside the container before the command, and it stops when the command ends (the exit code is unchanged).
  If the port is already in use, sacty continues without forwarding and reports it on standard error with `[sacty] localhost の転送：` (the daemon copies it to its log).

Code: `apps/daemon/src/services.ts` (`composePorts`, `localForwards`), `apps/daemon/src/agents/forward.ts` (`FORWARD_SCRIPT`, `withLocalForwards`, `forwardNotices`), `apps/daemon/src/prompts.ts` (`servicePromptLines`)

## Shared compose

Written in the project's `sharedComposes` (up to 20; names must be unique).

| Field | Meaning |
| --- | --- |
| `name` | `^[a-z0-9][a-z0-9_-]{0,39}$` |
| `repo` | A git URL or an absolute local path (up to 500 characters). The URL cannot contain a user name, password, or token |
| `ref` | A branch or tag (the default branch if omitted) |
| `file` | A path relative to the repository root (not containing `..` or `$`) |
| `description` | A hint for the Orchestrator when choosing (up to 1000 characters) |

- Fetching: for each run, sacty fetches the latest of the ref with `git fetch --depth 1` into a per-repository cache `SACTY_HOME/cache/shared-compose/<first 24 digits of the URL's SHA-256>.git` (bare),
  writes that commit out to `workspaces/_shared-compose/<run ID>`, and starts the services with it as the workspace
  (deleted afterward; the whole `_shared-compose` is deleted at daemon startup). Fetches into the same cache do not run in parallel.
- Authentication is the same as for the context repository (the gh token for HTTPS when there is a GitHub account; otherwise the host's git authentication).
- The original `container_name` becomes an alias on sacty's network (only when it does not conflict with a service name).
- If it cannot be fetched, the file is missing, it fails the safety check, or it cannot start, the step stops with an indication of which shared compose
  (`services.sharedFetchFailed`, `services.sharedMissing`, `services.sharedUnsafe`, `services.sharedFailed`).

Code: `packages/core/src/projects.ts` (`SharedCompose`, `SharedComposeName`), `apps/daemon/src/shared-compose.ts` (`GitSharedComposeFetcher`, `sharedComposeRunDir`, `cleanupSharedComposeRuns`), `apps/daemon/src/service.ts` (`startServices`, `gitAuth`)
