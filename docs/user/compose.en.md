<!-- Code: apps/daemon/src/services.ts, apps/daemon/src/shared-compose.ts, packages/core/src/projects.ts (SharedCompose) -->

[日本語](compose.md) | **English**

# docker compose services (databases, mock APIs, and so on)

For repositories that need a database or mock API started with docker compose for tests or manual checks, sacty starts the services on the host and connects
the agent and test containers to their network (agents are not given Docker privileges). When you use the target repository's own compose file,
no configuration is needed.

## How services are started

- The Orchestrator decides which services in which compose file to use, and in which steps (Implementation, Reproduce, bug Investigation), when it chooses the steps,
  by reading the repository (compose files, README, AGENTS.md, and test configuration). Services are not started for an Investigation of content (as opposed to a bug Investigation).
- For each agent run of a step and each test run, sacty starts the services under a separate project name (`docker compose up --wait`) and removes the containers,
  networks, and volumes when it finishes. Tasks in the same repository can run in parallel without colliding. Data is discarded after each run.
- Agents and tests connect by service name and container port (for example `db:5432`). sacty starts the services with `ports` (host ports) and `container_name`
  removed.
- Service images are pulled and built by the host's Docker, using the names written in the compose file (for images in your organization's registry, run
  `docker login` on the host beforehand).
- Services left behind when the daemon ends unexpectedly are removed the next time it starts (the daemon that started them is recorded in the container label `io.sacty.owner`,
  and services whose daemon is still running, that is, those of another sacty running with the same `SACTY_HOME`, are not removed).

## Reaching services via localhost

So that the repository's configuration still works when it points at localhost, in runs that start services, sacty forwards
`127.0.0.1:<port>` (and `[::1]:<port>` when available) inside the agent and test containers to the same port of the service (`<service-name>:<port>`). The forwarding is a small TCP forwarder
that sacty starts inside the container before the command (it runs on the Node.js in the image, so no extra packages are needed), and it
stops when the command finishes. The command's exit code and output do not change. In runs that do not start services, nothing changes (the command is the same).

- sacty forwards the service's container ports (the right-hand side of `ports`, and `expose`) and the ports published to the host by `ports`. Local development
  configuration often points at the host-side port, so with `ports: ["15432:5432"]`, both `localhost:15432` and `localhost:5432`
  reach `db:5432` (sacty does not publish anything on the host's ports; the forwarding exists only inside the container).
- `ports` is read in both the short syntax (`"5432"`, `"15432:5432"`, `"127.0.0.1:15432:5432"`, and ranges such as `"8000-8001:8000-8001"`) and the long syntax (`target`,
  `published`). Entries without a published port, or whose range lengths do not match, forward only the container port. UDP and other non-TCP ports
  (`/udp` in `ports`, `"8125/udp"` in `expose`) are not forwarded and are not counted when checking for collisions (a TCP port with the same number is forwarded).
- Within one service, when a port published to the host has the same number as another container port (`ports: ["8080:80", "18080:8080"]`), the mapping as seen from
  the host takes priority (`localhost:8080` → `app:80`; `app:8080` is reached from `localhost:18080`).
- When several services use the same number on localhost (host side or container side), that number is not forwarded (because sacty cannot decide
  which one to connect to; connect by service name instead). The number is shown in the service start record in the Activity and in the instructions to the agent.
- When something else inside the container is already using the port, that port is not forwarded and the run continues (it does not fail). The reason is written to the test output
  (standard error) or to the daemon log (agent runs).
- Limitations: forwarding is TCP only. Clients such as the MySQL client that connect over a UNIX socket instead of TCP when the host is written as `localhost` cannot reach the service
  (writing `127.0.0.1` works). Also, if the app under test listens on the same port as a service, it collides with the forwarding and cannot listen
  (change the app's port, or connect by service name).

## Unsupported settings

sacty normalizes the compose file with `docker compose config` before checking it. If the services to be used or their dependencies have any of the following settings, sacty stops without starting them and shows the reason.

- `privileged`, `cap_add`, `devices`, `volumes_from`, host networking, host PID, and similar (`network_mode: host`, `pid: host`, and so on), and
  unconfined in `security_opt`
- `use_api_socket` (which passes the Docker API socket), `provider` (which runs a command on the host), and in build: `ssh`, `network: host`, `privileged`,
  `entitlements`, and `cache_to`
- Mounts of paths outside the workspace (including the Docker socket), and `build`, `env_file`, `label_file`, `secrets`, `include`, or
  `extends` files outside the workspace (variables cannot be used in these paths)
- External networks and volumes, network drivers other than bridge, and volume driver settings

For services that build (`build`), `image` and `build.tags` are not used; sacty builds them every time under a name for that run only (so that host images,
such as the agent image, are not overwritten). Built images are removed when the services stop.

## Shared compose

When the compose file for Cassandra, Redis, or other services your tests need lives in a separate repository shared by your team, add it under "Shared
compose" in the project settings (you can add more than one; it is included in exports).

| Field | Description |
| --- | --- |
| Name | Up to 40 characters of lowercase letters, digits, `_`, and `-`, starting with a lowercase letter or digit. Must be unique within the project |
| Repository | A git URL (`https://`, `ssh://`, `git@<host>:<path>`, and so on) or an absolute local path (relative paths are not allowed) |
| Branch or tag | Optional. The default branch if omitted |
| Compose file | A path relative to the repository root (paths starting with `/` or `-`, or containing `..` or `$`, are not allowed) |
| Description | Optional (up to 1000 characters). A hint for the Orchestrator's decision |

- Adding it does not start anything by itself. For each task, the Orchestrator decides whether it is needed from the repository (test configuration, README, AGENTS.md) and the description,
  and selects it by name only when needed (either it or the target repository's compose, not both). Tasks that do not need it neither fetch nor start it. The reason for using or not using it,
  and which shared compose (repository, ref, file) is used, are recorded in the Activity (the task page). In the description, writing which services it starts and which
  tests need them helps the decision.
- Before a step or test run, sacty fetches the repository. It updates the per-repository cache (`$SACTY_HOME/cache/shared-compose`) to the latest commit of the ref on every
  run, writes that commit's contents to a per-run directory, starts the services from there, and removes it when finished (so that parallel tasks do not overwrite
  each other's initialization scripts). Startup and safety checks are the same as for the target repository's compose (a per-run project name,
  `up --wait` to wait for healthchecks, and no host ports published). Only paths inside the fetched repository can be mounted (mounts relative to the compose file
  work).
- sacty starts the services with `container_name` removed and uses that name as an alias on the sacty network (they are reachable by that name or by service name, without colliding with other tasks).
- HTTPS GitHub repositories are fetched with the `gh` account chosen for the project, the same as the target repository and context repository (you can choose the host under "GitHub
  account"). SSH and local paths use the host's git authentication. URLs cannot contain a user name, password, or token.
- When the repository cannot be fetched, the compose file is missing, a safety check fails, or the services cannot start, sacty stops the step and shows which shared compose caused it and why.

## Related pages

- [Project settings](project-settings.en.md)
- [Container images](images.en.md)
