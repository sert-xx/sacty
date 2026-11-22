<!-- Code: apps/daemon/src/services.ts, apps/daemon/src/shared-compose.ts, packages/core/src/projects.ts (SharedCompose) -->

[日本語](compose.md) | **English**

# docker compose services (databases, mock APIs, and so on)

For repositories that need a database or mock API started with docker compose for tests or manual checks, sacty starts the services on the host. sacty connects the step agent containers to the services' network, so agents (and the tests they run) can connect to the services. Agents are not given Docker privileges.

## What you need to prepare

What you prepare depends on where the compose file is.

- When you use the target repository's own compose file, no configuration is needed.
- When you use a compose file in a separate repository shared by your team, add it under "Shared compose" in the project settings ([Shared compose](#shared-compose)).

In either case, check the following.

- Images: if you use images in your organization's registry, run `docker login` on the host beforehand ([How services are started](#how-services-are-started)).
- Compose file settings: if the file has [unsupported settings](#unsupported-settings), sacty stops without starting the services.
- Connection targets: sacty attempts forwarding when the repository's configuration points at localhost ([Forwarding via localhost](#forwarding-via-localhost)). There are cases where they are not reachable ([When localhost does not reach a service](#when-localhost-does-not-reach-a-service)).

## How services are started

sacty starts the services and cleans them up as follows.

- Services and steps to use: the Orchestrator decides them when it chooses the steps.
  - The Orchestrator reads the repository (compose files, README, AGENTS.md, and test configuration) and decides which services in which compose file to use, and in which steps (Implementation, Reproduce, bug Investigation).
  - The instructions ask it to search subdirectories and various names for compose files, including files referenced by test and development instructions or skills.
  - When it does not select services needed for tests or manual checks, the instructions ask it to record the services and reason in the activity history.
  - If the information gathering at the start of the task has sorted the services needed for tests and manual checks, the Orchestrator bases its choice on that.
  - Services are not started for an Investigation of content (as opposed to a bug Investigation).
- What is started: sacty starts dependency apps managed elsewhere (ones that do not run the target repository's code) and databases, caches, mocks, and so on.
  - Apps that run the target repository's code are started by the step agent inside the agent's container and connected to the services.
  - The grouping depends on what each service runs, not on whether it has `build` in compose (a database built from the target repository's Dockerfile is also a dependency).
- Starting and cleaning up: sacty starts the services under a separate project name (`docker compose up --wait`) for each agent run of a step.
  - When a run finishes, sacty removes the containers, networks, and volumes. Data is discarded after each run.
  - Tasks in the same repository can run in parallel without colliding.
- Connecting: agents (and the tests they run) connect by service name and container port (for example `db:5432`). sacty starts the services with `ports` (host ports) and `container_name` removed.
- Images
  - Images of services that do not build (only `image`) are pulled by the host's Docker, using the names written in the compose file. For images in your organization's registry, run `docker login` on the host beforehand.
  - Services that build (`build`) do not use the written `image` name; they are built under a name for each run ([Unsupported settings](#unsupported-settings)).
- Leftover services: services left behind when the daemon ends unexpectedly are removed the next time it starts.
  - sacty records the daemon that started them in the container label `io.sacty.owner`.
  - Services whose daemon is still running (those of another sacty running with the same `SACTY_HOME`) are not removed.

Each step receives the generated `docker-services` skill, including steps without services. It takes precedence for starting and connecting services; a layered skill of the same name is ignored and produces `context.reservedSkill`. The instructions also ask the agent to read it first.

The skill explains that docker commands are unavailable and that sacty starts and stops services. Connection addresses are candidates, and localhost forwarding is planned rather than guaranteed. The agent tries another candidate if needed and reports what could not be verified if all fail; when no services are started, it reports checks blocked by their absence.

## Forwarding via localhost

When the repository's configuration points at localhost, sacty attempts forwarding. In runs that start services, sacty forwards `127.0.0.1:<port>` (and `[::1]:<port>` when available) inside the agent containers to the same port of the service (`<service-name>:<port>`).

For example, connecting to a db service looks like this.

![Forwarding localhost](images/compose-forwarding.en.svg)

The forwarding is done by a small TCP forwarder that sacty starts inside the container before the command. It runs on the Node.js in the image, so no extra packages are needed. The forwarder stops when the command finishes, and the command's exit code and output do not change. In runs that do not start services, nothing changes (the command is the same).

### Ports that are forwarded

sacty forwards the following ports.

- The service's container ports (the right-hand side of `ports`, and `expose`)
- The ports published to the host by `ports`. This is because local development configuration often points at the host-side port.

With `ports: ["15432:5432"]`, sacty attempts to forward both `localhost:15432` and `localhost:5432` to `db:5432`. sacty does not publish anything on the host's ports; the forwarding exists only inside the container.

`ports` is read in both the short syntax and the long syntax.

- Short syntax: `"5432"`, `"15432:5432"`, `"127.0.0.1:15432:5432"`, and ranges such as `"8000-8001:8000-8001"`
- Long syntax: `target`, `published`

Entries without a published port, or whose range lengths do not match, forward only the container port.

Within one service, when a port published to the host has the same number as another container port (`ports: ["8080:80", "18080:8080"]`), the mapping as seen from the host takes priority. sacty attempts to forward `localhost:8080` to `app:80` and `localhost:18080` to `app:8080`.

### When localhost does not reach a service

The following ports are not forwarded.

- UDP and other non-TCP ports (`/udp` in `ports`, `"8125/udp"` in `expose`) are not forwarded and are not counted when checking for collisions (a TCP port with the same number is forwarded).
- When several services use the same number on localhost (host side or container side), that number is not forwarded, because sacty cannot decide which one to connect to. Try the service name as another candidate. The number is shown in the service start record in the Activity and in the instructions to the agent.
- When something else inside the container is already using the port, that port is not forwarded and the run continues (it does not fail). The reason is written to the daemon log (from the standard error of the agent run).

The forwarding has the following limitations.

- Forwarding is TCP only. Clients such as the MySQL client that connect over a UNIX socket instead of TCP when the host is written as `localhost` cannot reach the service (try `127.0.0.1`).
- If the app under test listens on the same port as a service, it collides with the forwarding and cannot listen. Change the app's port, or connect by service name.

## Unsupported settings

If the services to be used or their dependencies have any of the following settings, sacty stops without starting the services and shows the reason. sacty normalizes the compose file with `docker compose config` before checking it.

- Service settings
  - `privileged`, `cap_add`, `devices`, and `volumes_from`
  - Host networking, host PID, and similar (`network_mode: host`, `pid: host`, and so on)
  - unconfined in `security_opt`
  - `use_api_socket`, which passes the Docker API socket
  - `provider`, which runs a command on the host
- Build settings: `ssh`, `network: host`, `privileged`, `entitlements`, and `cache_to`
- Paths that point outside the workspace
  - Mounts of paths outside the workspace (including the Docker socket)
  - `build`, `env_file`, `label_file`, `secrets`, `include`, or `extends` files outside the workspace (variables cannot be used in these paths)
- Networks and volumes
  - External networks and volumes
  - Network drivers other than bridge
  - Volume driver settings

For services that build (`build`), sacty does not stop on `image` and `build.tags`, but it does not use them either. It builds the services every time under a name for that run only. This keeps host images, such as the agent image, from being overwritten. Built images are removed when the services stop.

## Shared compose

When the compose file for Cassandra, Redis, or other services your tests need lives in a separate repository shared by your team, add it under "Shared compose" in the project settings. You can add more than one. When you export the project, the shared compose entries are included.

Fill in the fields as follows.

| Field | Description |
| --- | --- |
| Name | Up to 40 characters of lowercase letters, digits, `_`, and `-`, starting with a lowercase letter or digit. Must be unique within the project |
| Repository | A git URL (`https://`, `ssh://`, `git@<host>:<path>`, and so on) or an absolute local path (relative paths are not allowed) |
| Branch or tag | Optional. The default branch if omitted |
| Compose file | A path relative to the repository root (paths starting with `/` or `-`, or containing `..` or `$`, are not allowed) |
| Description | Optional (up to 1000 characters). A hint for the Orchestrator's decision |

### Authentication for fetching

The authentication used to fetch the repository is decided as follows.

- HTTPS GitHub repositories are fetched with the `gh` account chosen for the project, the same as the target repository and context repository. You can choose the account for that host under "GitHub account" in the project settings ([Project settings](project-settings.en.md#github-account)).
- SSH and local paths use the host's git authentication.
- URLs cannot contain a user name, password, or token.

### Deciding whether to use it

For each task, the Orchestrator decides whether to use a shared compose. Adding it does not start anything by itself.

- The Orchestrator decides whether it is needed from the repository (test configuration, README, AGENTS.md) and the description, and selects it by name only when needed.
- It selects either the target repository's compose or a shared compose, not both.
- Tasks that do not need it neither fetch nor start it.

The reason for using or not using it, and which shared compose (repository, ref, file) is used, are recorded in the Activity (the task page). Writing in the description which services it starts and which tests need them helps the decision.

### Fetching and starting

sacty fetches and starts the shared compose that the Orchestrator selected as follows.

- Before a step run, sacty fetches the repository.
  - It updates the per-repository cache (`$SACTY_HOME/cache/shared-compose`) to the latest commit of the ref on every run.
  - It writes that commit's contents to a per-run directory, starts the services from there, and removes the directory when finished. This keeps parallel tasks from overwriting each other's initialization scripts.
- Startup and safety checks are the same as for the target repository's compose (a per-run project name, `up --wait` to wait for healthchecks, and no host ports published; see [How services are started](#how-services-are-started) and [Unsupported settings](#unsupported-settings)).
- Only paths inside the fetched repository can be mounted (mounts relative to the compose file work).
- sacty starts the services with `container_name` removed and uses that name as an alias on the sacty network. They are reachable by that name or by service name, without colliding with other tasks.

### When the step stops

In the following cases, sacty stops the step and shows which shared compose caused it and why.

- The repository cannot be fetched
- The compose file is missing
- A safety check ([Unsupported settings](#unsupported-settings)) fails
- The services cannot start

## Related pages

- [Project settings](project-settings.en.md)
- [Container images](images.en.md)
