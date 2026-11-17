<!-- Code: apps/daemon/src/config.ts (image_build, images, languageImageTag), apps/daemon/src/image.ts, packages/cli/docker/Dockerfile, packages/cli/docker/install-tools.sh, packages/cli/docker/install-drawio.sh, packages/cli/docker/install-security-tools.sh, packages/cli/docker/drawio-shim.cjs, packages/cli/src/index.ts (imageBuild), apps/daemon/src/service.ts (changeTaskImage, withImages, pinnedImage, stepSettingChanges), apps/web/src/components/task-image-form.tsx, apps/daemon/src/context-images.ts, apps/daemon/src/main.ts, apps/web/src/components/shell/context-images-notice-view.tsx -->

[日本語](images.md) | **English**

# Container images

Agents run in containers created from a container image. Tests also run inside agent containers.

First, build the image with `npx sacty image build` ([CLI](cli.en.md#sacty-image-build)). Agents run in the built image (`image` in `config.yaml`; default `sacty-agent:1.26.0`). After you update sacty, rebuild the images.

You need additional settings in the following cases. If none of them applies to you, you do not need any additional settings.

| When | Section to read |
| --- | --- |
| You cannot use Docker Hub or the public npm registry | [Building images from a private registry](#building-images-from-a-private-registry) |
| Your repositories need tools that the default image does not have, such as Python, Go, or Java repositories and repositories that use test browsers | [Per-language images](#per-language-images) |
| You want to write images used only by one project in that project's context repository | [Context images](#context-images) |

The tools in the image are described in [Tools in the image](#tools-in-the-image). Which image a task runs in, and how to choose again, are described in [Which image a task runs in](#which-image-a-task-runs-in).

## Tools in the image

The image includes the following commands that agents use in their work. Commands that the base image already has are not reinstalled; agents use them as they are.

| Command | Use |
| --- | --- |
| `jq` | Read and transform JSON (`gh api --jq` also uses it) |
| `rg` (ripgrep), `fd` | Quickly search file contents and file names |
| `tree`, `file`, `less` | View directory structure, file types, and long files |
| `curl` | Fetch over HTTP |
| `zip`, `unzip`, `xz`, `bzip2` | Create and extract compressed files |
| `patch`, `diff`, `find`, `make`, `ps` | Apply patches, compare, find files, run build recipes, check processes |
| `sqlite3`, `python3` | Inspect SQLite databases, and write scripts to check things |
| `shellcheck` | Check shell scripts |
| `drawio` | Convert and export draw.io diagrams ([The draw.io CLI](#the-drawio-cli)) |
| `osv-scanner`, `gitleaks` | Check for dependency vulnerabilities and leaked secrets (used by security checks and security fixes; [Working with tasks](tasks.en.md#security-checks-and-fixes)) |

In addition, the image includes a `gh` that can use only `gh api`. This `gh` is for reading GitHub through the gateway, and it takes precedence over a `gh` in the base image ([Gateway](gateway.en.md#reading-github)).

The commands in the table are installed as follows.

- All of them are open-source software, installed from the OS distribution's packages (the mirrors configured in the base image). You get the versions that were current when the image was built.
- `osv-scanner` and `gitleaks` are not OS packages: sacty fetches a pinned version from the official GitHub releases and checks it against a hash pinned in sacty before installing it. If the GitHub releases cannot be reached, sacty reports a warning in the build log and builds the image without them (the steps report those categories as unchecked scope). If a hash does not match, the build stops.
- If a command cannot be installed, for example because the package mirror is unreachable, sacty reports a warning in the build log and builds the image anyway (agents use other means instead).

### Picking up OS security updates

`npx sacty image build` uses Docker's build cache, so a rebuild alone may not fetch the packages again. To pick up OS security updates, do one of the following and then rebuild.

- Use a newer base image. Update to a sacty version whose base image digest is updated, or write an updated base image in `image_build.base_image` (a tag such as `node:26-bookworm-slim`, or `<tag>@sha256:<digest>`). If the image in `image_build.base_image` is a tag only, fetch it again with `docker pull <base image>`. sacty pins the default base image by its digest, so `docker pull` does not change it.
- Clear the build cache with `docker builder prune` (the packages sacty installs are fetched again, but the base image does not change)

Commands that the base image already has are not reinstalled, so their updates come from the base image.

### RHEL-family base images

On RHEL-family base images, `rg`, `fd`, and `shellcheck` exist only in EPEL, so they are not installed if EPEL is not available. To install them, write `run` of a per-language image ([Per-language images](#per-language-images)) as follows.

- Install them in the same `run`, after the command that enables EPEL.
- If your organization has an EPEL mirror, use a command that places that repository's settings instead of `epel-release`.
- Because `packages` are installed before `run`, do not list EPEL packages in `packages`.

```yaml
images:
  rocky:
    description: Rocky Linux 9
    base_image: registry.example.com/ci/rocky:9
    run:
      - dnf install -y epel-release
      - dnf install -y ripgrep fd-find ShellCheck
```

### The draw.io CLI

The default skill `drawio` ([Context repository](context.en.md#diagram-skill)) uses the draw.io CLI for the following.

- Converting diagrams (from Mermaid to the draw.io format)
- Automatic layout
- Exporting to PNG, SVG, and PDF

sacty fetches the official release of draw.io Desktop (Apache-2.0) from GitHub and installs it after checking its version and hash against pinned values. It also installs CJK fonts (Noto CJK) so that Japanese labels can be exported.

Installing the draw.io CLI makes the image larger (about 800MB uncompressed). In environments that cannot reach GitHub releases (`github.com` and `release-assets.githubusercontent.com`), or when you want a smaller image, set `image_build.drawio` to `false`. Even without the CLI, the skill can make diagrams (`.drawio`) in XML.

```yaml
image_build:
  drawio: false   # do not install the draw.io CLI
```

If something goes wrong during the installation, the build behaves as follows.

- When GitHub is unreachable, the build shows a warning in the build log and builds the image without the draw.io CLI.
- When the hash of the fetched file does not match, the build stops.
- When the installed draw.io CLI cannot load some libraries, the build also shows a warning with their names in the build log (`drawio` does not start in that case).

## Building images from a private registry

In environments where Docker Hub or the public npm registry cannot be used, build the image in this order.

1. Write the base image and the npm registry in `image_build` in `config.yaml`.
2. Run `sacty image build`.

If you omit `image_build`, the image is built from `node:26-bookworm-slim` on Docker Hub and the public npm registry.

```yaml
image: registry.example.com/sacty-agent:1.26.0
image_build:
  base_image: registry.example.com/library/node:26-bookworm-slim   # must have Node.js 18 or later and a node user
  npm_registry: https://npm.example.com/repository/npm/
  npm_token: npm-token   # when authentication is needed. Save the value with sacty secret set npm-token
  npm_version: 11        # npm version installed in the image (if omitted, the base image's npm)
  npm_config:            # npm-wide settings inside the container (the global npmrc)
    replace-registry-host: always   # replace old source URLs in package-lock.json with the current registry
    audit: false
    min-release-age: 7              # do not install versions published less than 7 days ago (npm 11 and later)
```

| Item | Meaning | Default |
| --- | --- | --- |
| `base_image` | The base image (must have Node.js 18 or later and a `node` user) | `node:26-bookworm-slim` |
| `npm_registry` | The npm registry (an `http` or `https` URL) | The public npm registry |
| `npm_token` | The authentication token for the npm registry (a secret name or a 1Password reference) | None |
| `npm_version` | The npm version installed in the image (`latest`, or a form like `11`, `11.4`, `11.4.2`) | The base image's npm |
| `npm_config` | npm-wide settings inside the container | None |
| `drawio` | Whether to install the draw.io CLI ([The draw.io CLI](#the-drawio-cli); also applies to per-language images) | `true` |

When building the image, sacty works as follows.

- Claude Code, Codex, and their dependencies are fetched from the `npm_registry` registry at the versions sacty pins in a lockfile. If the registry does not have those versions, or their contents differ from the public registry (`integrity` does not match), the build fails.
- The default base image is pinned by its digest in addition to the tag (the same sacty version builds from the same base image).
- The build reads the npm token only during the build (a BuildKit secret). The token does not remain in the image layers, history, or environment variables.
- If the base image has git, the image can be built even when Debian mirrors are unreachable.

The following settings apply to npm inside the containers of the built image.

- `npm_registry` also becomes the registry of npm inside the container (if `npm_config` has `registry`, that takes precedence). `npm_token` is used only when building the image, not inside the container.
- `npm_config` remains in the image and applies to every npm inside the container (such as `npm ci` in the target repository). If the target repository's `.npmrc` has the same item, that takes precedence. You cannot write authentication items (`_authToken`, `_auth`, `_password`, `username`, `email`, `certfile`, `keyfile`, `cert`, `key`), because they would remain in the image.

## Per-language images

For Python, Go, Java, and other repositories, build per-language images based on an image that has the language's tools (such as a CI image). Which of the built images a task runs in is described in [Which image a task runs in](#which-image-a-task-runs-in).

In `images` in `config.yaml`, write, for each name, the base image (`base_image`) and the description the Orchestrator reads when choosing (`description`).

```yaml
images:
  java17:
    description: Java 17, Maven, Gradle          # description the orchestrator reads when choosing
    base_image: registry.example.com/ci/java:17   # Debian/Ubuntu-based or RHEL-based (Rocky Linux and so on)
    maven_mirror: https://maven.example.com/repository/maven-public/
  python:
    description: Python 3.12, pip, uv
    base_image: registry.example.com/ci/python:3.12
    env:                                          # passed to the agent containers
      PIP_INDEX_URL: https://pypi.example.com/simple
  go:
    description: Go 1.23
    base_image: registry.example.com/ci/go:1.23
    env:
      GOPROXY: https://goproxy.example.com
```

Then build them with the following commands.

```sh
npx sacty image build            # the default image and everything in images
npx sacty image build java17     # build by name (default is the default image)
```

| Item | Meaning | Default |
| --- | --- | --- |
| (name) | Up to 40 characters of lowercase letters, digits, `_`, and `-`, starting with a lowercase letter or digit. `default` cannot be used | None |
| `description` | The description the Orchestrator reads when choosing (up to 200 characters). Required | None |
| `base_image` | The base image. Required | None |
| `image` | The name of the image to build | `sacty-agent-<name>:1.26.0` |
| `node_image` | The image to copy Node.js from (when the base image does not have Node.js 18 or later and npm) | `image_build.base_image`, or `node:26-bookworm-slim` if absent |
| `env` | Environment variables for the agent containers | None |
| `maven_mirror` | Where Maven and Gradle fetch from | None |
| `packages` | OS packages to install when building the image | None |
| `enable_repos` | IDs of package repositories to enable when installing `packages` | None |
| `run` | Commands to run as root when building the image | None |

### What sacty adds to the base image

sacty adds git, Claude Code, and Codex to the base image and runs as the `node` user.

- If the base image has Node.js 18 or later and npm, sacty uses them; otherwise it copies them from `node_image`. It looks for npm in `npm root -g`, `/usr/local/lib/node_modules`, and `/usr/lib/node_modules`.
- sacty uses the npm settings from `image_build`.
- Because agents run as the `node` user, sacty sets `HOME` to `/home/node` and `GOPATH` to `/home/node/go`, and adds `/home/node/go/bin` to PATH. This lets agents write even if the CI image points these to root's locations. You can override `GOPATH` with `env`.

If the copied Node.js does not run (for example, a plain image such as `ubuntu:24.04` lacks shared libraries), the following happens.

- sacty installs `libatomic` and `libstdc++` with whichever of apt-get, dnf, microdnf, or yum the base image has.
- If it still does not run, the build stops with the reason ("写した Node.js … が、元のイメージで動きません"). In that case, set `node_image` to a Node.js image that runs on the base image (one with the same C library), or use a base image that has Node.js 18 or later and npm.
- Node.js from the default `node_image` (glibc) cannot be copied into musl images such as Alpine.
- This check runs before `packages` and `run`, so installing the missing libraries with `packages` or `run` is too late.

### Environment variables and where Maven and Gradle fetch from (`env`, `maven_mirror`)

In `env`, write things such as your organization's registries (`PIP_INDEX_URL`, `UV_DEFAULT_INDEX`, `GOPROXY`, `GONOSUMDB`, and so on).

- Names consist of uppercase letters, digits, and `_`, starting with an uppercase letter or `_`.
- Because the values are visible to every command inside the container, you cannot write authentication values (names containing `TOKEN`, `PASSWORD`, `SECRET`, `AUTH`, `API_KEY`, and so on, and URLs containing a user name or password).
- You also cannot write `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `NODE_OPTIONS`, or names starting with `SACTY_`, `DOCKER_`, `CODEX_`, `CLAUDE_`, `ANTHROPIC_`, `OPENAI_`, or `NPM_CONFIG_`.

`maven_mirror` points all fetches by Maven (a mirror in `settings.xml`) and Gradle (an init script) to that URL. You cannot write URLs containing a user name or password, or URLs containing symbols such as quotation marks.

### Installing OS packages and running commands (`packages`, `run`)

When building the image, sacty can install OS packages and run commands.

- sacty installs the OS packages written in `packages` as root when building the image, using whichever of dnf, microdnf, yum, and apt-get the base image has.
- It runs the commands written in `run` as root, in order from the top, when building the image (setting up your organization's package repositories, installing CLIs, and so on). The build stops if one fails.
- Changing `packages` or `run` makes `sacty image build` rebuild the image.
- Because they remain in the image, do not write secrets in `run`.

```yaml
images:
  node-pw:
    description: Node.js 26, Playwright
    base_image: registry.example.com/ci/node:26
    packages: [nss, nspr, atk, at-spi2-atk, cups-libs, libdrm, libxkbcommon, mesa-libgbm, pango, alsa-lib]   # RHEL-based
    run:
      # separate the download from the installation (so the build stops if the download fails)
      - curl -fsSL https://artifacts.example.com/pf-cli/install.sh -o /tmp/pf-install.sh
      - sh /tmp/pf-install.sh
```

A `run` command stops the build if its exit code is not 0. If the base image has bash, sacty runs the commands with `pipefail`, so a failure in the middle of a pipe also stops the build. In images without bash (run with `sh`), only the exit code of the last command in a pipe is checked. For steps that download and run something, split them into separate items instead of connecting them with a pipe.

Agents do not run as root, so they cannot install OS packages during a task. Get the Playwright browser itself during the task with `npx playwright install chromium`, matching the repository's version. Put only the OS libraries in the image; for Debian-based images, `run: [npx -y playwright@<version> install-deps chromium]` also works.

### Enabling disabled repositories (`enable_repos`)

For package repositories that are configured in the base image but disabled (such as your organization's rpm repositories), write their repo IDs in `enable_repos`, and sacty enables them when installing `packages` (`--enablerepo` for dnf, microdnf, and yum).

```yaml
images:
  rocky-pw:
    description: Rocky Linux 9, Playwright
    base_image: registry.example.com/ci/rocky:9
    enable_repos: [acme-baseos, acme-appstream]
    packages: [nss, nspr, atk, at-spi2-atk, cups-libs, libdrm, libxkbcommon, mesa-libgbm, pango, alsa-lib]
```

- Write it together with `packages` (it is an error without `packages`).
- IDs start with an alphanumeric character and contain only alphanumerics and `. _ : -`. You can check the repo IDs in the base image with `docker run --rm --user root --entrypoint dnf <base image> repolist --all`.
- This cannot be used with apt-get images. The build stops and shows the reason, so set up repositories with `run`.
- Changing `enable_repos` makes `sacty image build` rebuild the image.

## Context images

Images written in `images.yaml` of the project's context repository ([images.yaml](context.en.md#imagesyaml)) can be used only by that project's tasks.
sacty builds the context images in the background after you start it with `sacty up`.
`sacty image build` builds only the images in `config.yaml`.

sacty starts building at the following times.

- When `sacty up` starts (after it fetches the secrets together)
- When you save the project settings
- Every 5 minutes (a definition you push to the context repository starts building within this interval at the latest)

When building, sacty works as follows.

- Images that are already on the machine are not built.
  If a built image has disappeared (`docker image prune`, for example), sacty builds it again on the next read.
  When the definition, `image_build` in `config.yaml`, or the sacty version changes, sacty builds it again under a new name.
- To keep the load on Docker down, sacty builds them one at a time.
- Context images that are no longer used (from old definitions or deleted projects) are removed after builds finish.
  Images that containers use, and images built by sacty for another `SACTY_HOME` on the same Docker, are kept.
- At that time, sacty also removes build cache unused for more than 3 days (the build cache of the whole Docker is the target).
  What was removed, and what could not be removed, appears in the log of the terminal where you started sacty.
- If fetching one project's context repository does not finish within 5 minutes, sacty stops it and treats it as unreadable (other projects go ahead).

### While images are being built

On every screen, "Image builds" appears above the content with the images being built or queued and the tail of the build log.
When they are built, it goes away without reloading.

While they are being built, tasks that may use those images do not start (they stay queued).

- Tasks that have not chosen an image yet (before the steps are chosen) wait.
  The Orchestrator chooses after the images are built, so a build in progress never leads to a mismatched image.
- Tasks that are set to use the default image or an image in `config.yaml` do not wait.

The following applies to waiting tasks.

- They do not count toward the number of tasks run at the same time (other tasks go ahead).
- You can pause or cancel a task while it waits.
- If the images are not built within 60 minutes, sacty pauses the task with the reason.
  Resume it after they are built.

### When an image could not be built

"Image builds" shows the image that could not be built, the reason, the tail of the log, and "Rebuild".
If building one image does not finish within 60 minutes, sacty also stops it and marks it failed (so the later images can be built).

Images that failed are not rebuilt automatically (so the same failure is not repeated).
Do the following, depending on the cause.

- For a temporary failure (such as the network), press "Rebuild".
- For a mistake in the definition, fix `images.yaml` and push it.
  sacty builds it again with the new definition.

In the following cases, sacty builds the image again or checks it again.

- When you start `sacty up` again, sacty builds them again (failures are not recorded).
- Only when Docker was not reachable does sacty check again the next time it reads the context (every 5 minutes).

The following applies to images that failed and to an `images.yaml` that could not be read.

- An image that failed can still be chosen as the task image.
  Steps that run in that image do not run; the task pauses with the reason.
  Resume it after rebuilding.
- If `images.yaml` cannot be read (for example, the context repository cannot be fetched), a warning appears.
  If an earlier definition was read, sacty keeps using it.

## Which image a task runs in

A task has one image. Every step and the tests of the task run in the same image.

The Orchestrator and people can choose from `images` in `config.yaml` and the [context images](#context-images) of the task's project.

The image is decided in the following order (earlier ones take precedence).

1. The image chosen when rerunning a cancelled task
2. The image a person specified when creating the task ([Set the task image and the agent for each step](tasks.en.md#set-the-task-image-and-the-agent-for-each-step))
3. The image for the project target (a repository or an Org). A repository's setting takes precedence over an Org's (see [Project settings](project-settings.en.md#targets))
4. The Orchestrator's choice (the default image if `images` is not configured)

The chosen image and the reason are recorded in the Activity. If a name not in `images` is chosen or specified, sacty stops and shows the reason. If the decided image doesn't fit the task, you can choose again ([Changing the task image](#changing-the-task-image)).

### How the Orchestrator chooses

When the Orchestrator chooses the steps, it picks one image for the task from `images`. The Orchestrator itself runs in the default image.

- To choose, it reads the repository (`pom.xml`, `go.mod`, `pyproject.toml`, `package.json`, and so on; in a monorepo, the directories the work touches).
- Tests also run in the task image (the agent of the implementation step runs them; for bug fixes, the reproduce agent runs them too). So the Orchestrator is asked to choose the image from the test command and the repository's dependencies (browser tests such as Playwright, DB clients, and so on). An image that has the tools of the test command is preferred. Only when no image has them does the Orchestrator write the test command anyway and note that in the reason for its image choice.
- For a PR-review-only task ([Intake](intake.en.md)) too, if no image is specified, the Orchestrator chooses the task image from `images`. The review runs the project's verification such as tests and lint, so the Orchestrator is asked to choose an image that has those tools. If `images` is not configured, the review runs in the default image without the Orchestrator.

### The default image

The default image (`image`) is the last resort when none of `images` fits. Even for a Node.js repository, a matching image in `images` is used instead.

The default image is a minimal image that includes the following.

- Node.js, npm, git, Claude Code, and Codex
- Work CLIs (`jq`, `rg`, `fd`, `tree`, `curl`, `zip`, `make`, `python3`, `sqlite3`, `shellcheck`, and others; [Tools in the image](#tools-in-the-image))
- `drawio`, `osv-scanner`, and `gitleaks`

It does not include the following.

- Tools for other languages, such as Go, Java, pnpm, yarn, a C compiler, or `golangci-lint`
- Test browsers
- DB clients (except `sqlite3`)
- Verification tools such as `kustomize` or `helm`

For a task that runs in the default image, the reason why none of `images` fits is recorded in the Activity and the task details. If the Orchestrator gave no reason, the task does not stop; it runs in the default image. In that case, the "Steps chosen" line in the Activity shows "Default image without a reason", and the task image section shows "the Orchestrator chose the default (no reason)". When tests fail, check this reason and add the tools each image includes (such as Playwright) to its `description` in `images`.

### Changing the task image

If the Orchestrator chooses an image that doesn't fit the task (for example, the default image for a repository that needs Playwright), you can choose again. Make the change in "Task image" on the "Step settings" tab of the task detail. When resuming a paused task and when requesting changes on the approval screen, you can also choose again together, under "Change the task image and step agents" (open it to use it; [Pause, resume, and cancel](tasks.en.md#pause-resume-and-cancel), [Changing a step's agent](tasks.en.md#changing-a-steps-agent)). An image changed when resuming or requesting changes is handled the same way as a change on the task detail.

The images you can choose and the tasks you can change are as follows.

- You can choose a name in `images` or `default` (the default image). The list shows only the names, and the description of the chosen image (`description` in `images`) appears below it.
- Once the steps are chosen, you can change it at any time (running, failed or paused, or awaiting approval).
- You can also change tasks whose image was set by the project target, by a person at creation, or by a person on rerun.

The changed image is used from the next run of every step.

- For a running step, the current run keeps its image and the next run uses the new one.
- The agent of the implementation step also runs the tests for verifying the implementation in the task image. If you change it, the next implementation run uses it.
- For a step that stopped with a failure or a pause, change the image and then retry with "Resume"; the step runs with the changed image.

When the change is not possible, the screen shows the following.

- A name not in `images` (such as a name removed from config.yaml) is refused with the reason.
- When config.yaml can't be read, the change is refused with the settings problem as the reason.
- When sacty's status can't be fetched, the screen says the choices can't be checked and doesn't offer the change (wait a moment and reopen the page).

A change is recorded as follows.

- The Activity records a change as who changed it from what to what.
- The task image section shows when a person changed it and the previous name.
- Why the Orchestrator left the task on the default image (or that no reason was given) is shown in the task image section until a person changes it.
- The "Steps chosen" line in the Activity stays as it was recorded.

### Tasks created by an earlier version

A task created by an earlier version of sacty may have an image decided per step.

- Such a task keeps running each step in that step's image.
- The task details show "per step (older version)" and, for each step, the image set last and the images used in its runs.
- A step whose image set last is not in `images` stops when it runs, so a warning is shown. Choose the task image again ([Changing the task image](#changing-the-task-image)).
- Once you choose a task image, every step runs in that image from then on.

## Related pages

- [config.yaml settings](config.en.md)
- [docker compose services](compose.en.md)
