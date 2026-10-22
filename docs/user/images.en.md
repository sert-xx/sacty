<!-- Code: apps/daemon/src/config.ts (image_build, images, languageImageTag), apps/daemon/src/image.ts, packages/cli/docker/Dockerfile, packages/cli/docker/install-tools.sh, packages/cli/docker/install-drawio.sh, packages/cli/docker/drawio-shim.cjs, packages/cli/src/index.ts (imageBuild), apps/daemon/src/service.ts (changeStepImage), apps/web/src/components/step-image-form.tsx -->

[日本語](images.md) | **English**

# Container images

Build the container images that run agents with `npx sacty image build` ([CLI](cli.en.md#sacty-image-build)). Agents run in the built image (`image`; default `sacty-agent:1.8.0`). Tests also run inside agent containers.

The image includes a `gh` that can use only `gh api`. This `gh` is for reading GitHub through the gateway, and it takes precedence over a `gh` in the base image ([Gateway](gateway.en.md#reading-github)). After you update sacty, rebuild the images.

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
| `drawio` | Convert and export draw.io diagrams ([The draw.io CLI](#the-drawio-cli) below) |

- All of them are open-source software, installed from the OS distribution's packages (the mirrors configured in the base image). You get the versions that were current when the image was built.
- `npx sacty image build` uses Docker's build cache, so a rebuild alone may not fetch the packages again. To pick up OS security updates, do one of the following and then rebuild.
  - Use a newer base image (fetch it again with `docker pull <base image>`, or change to the tag of an updated version)
  - Clear the build cache with `docker builder prune`

  Commands that the base image already has are not reinstalled, so their updates come from the base image.
- If a command cannot be installed, for example because the package mirror is unreachable, sacty reports a warning in the build log and builds the image anyway (agents use other means instead).
- On RHEL-family base images, `rg`, `fd`, and `shellcheck` exist only in EPEL, so they are not installed if EPEL is not available. Because `packages` are installed before `run`, do not list EPEL packages in `packages`. Install them in the same `run`, after the command that enables EPEL.

  If your organization has an EPEL mirror, use a command that places that repository's settings instead of `epel-release`.

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

The default skill `drawio` ([Context repository](context.en.md)) uses the draw.io CLI for the following.

- Converting diagrams (from Mermaid to the draw.io format)
- Automatic layout
- Exporting to PNG, SVG, and PDF

sacty fetches the official release of draw.io Desktop (Apache-2.0) from GitHub and installs it after checking its version and hash against pinned values. It also installs CJK fonts (Noto CJK) so that Japanese labels can be exported.

- The image becomes larger (about 800MB uncompressed). In environments that cannot reach GitHub releases (`github.com` and `release-assets.githubusercontent.com`), or when you want a smaller image, set `image_build.drawio` to `false`. Even without the CLI, the skill can make diagrams (`.drawio`) in XML.
- When GitHub is unreachable, the build shows a warning in the build log and builds the image without the draw.io CLI. When the hash of the fetched file does not match, the build stops.

```yaml
image_build:
  drawio: false   # do not install the draw.io CLI
```

## Building images from a private registry

In environments where Docker Hub or the public npm registry cannot be used, write the base image and the npm registry in `image_build` in `config.yaml`, and then run `sacty image build`. If you omit them, the image is built from `node:22-bookworm-slim` on Docker Hub and the public npm registry.

```yaml
image: registry.example.com/sacty-agent:1.8.0
image_build:
  base_image: registry.example.com/library/node:22-bookworm-slim   # must have Node.js 18 or later and a node user
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
| `base_image` | The base image (must have Node.js 18 or later and a `node` user) | `node:22-bookworm-slim` |
| `npm_registry` | The npm registry (an `http` or `https` URL) | The public npm registry |
| `npm_token` | The authentication token for the npm registry (a secret name or a 1Password reference) | None |
| `npm_version` | The npm version installed in the image (`latest`, or a form like `11`, `11.4`, `11.4.2`) | The base image's npm |
| `npm_config` | npm-wide settings inside the container | None |
| `drawio` | Whether to install the draw.io CLI ([The draw.io CLI](#the-drawio-cli); also applies to per-language images) | `true` |

- The build reads the npm token only during the build (a BuildKit secret). The token does not remain in the image layers, history, or environment variables.
- If the base image has git, the image can be built even when Debian mirrors are unreachable.
- `npm_registry` also becomes the registry of npm inside the container (if `npm_config` has `registry`, that takes precedence). `npm_token` is used only when building the image, not inside the container.
- `npm_config` remains in the image and applies to every npm inside the container (such as `npm ci` in the target repository). If the target repository's `.npmrc` has the same item, that takes precedence. You cannot write authentication items (`_authToken`, `_auth`, `_password`, `username`, `email`, `certfile`, `keyfile`, `cert`, `key`), because they would remain in the image.

## Per-language images

For Python, Go, Java, and other repositories, build per-language images based on an image that has the language's tools (such as a CI image).

```yaml
images:
  java17:
    description: Java 17, Maven, Gradle          # description the orchestrator reads when choosing
    base_image: registry.example.com/ci/java:17   # Debian/Ubuntu-based or RHEL-based (Rocky Linux and so on)
    maven_mirror: https://maven.example.com/repository/maven-public/
  python:
    description: Python 3.12, pip, uv
    base_image: registry.example.com/ci/python:3.12
    env:                                          # passed to the agent containers (including the final review that runs the tests)
      PIP_INDEX_URL: https://pypi.example.com/simple
  go:
    description: Go 1.23
    base_image: registry.example.com/ci/go:1.23
    env:
      GOPROXY: https://goproxy.example.com
```

```sh
npx sacty image build            # the default image and everything in images
npx sacty image build java17     # build by name (default is the default image)
```

| Item | Meaning | Default |
| --- | --- | --- |
| (name) | Up to 40 characters of lowercase letters, digits, `_`, and `-`, starting with a lowercase letter or digit. `default` cannot be used | None |
| `description` | The description the orchestrator reads when choosing (up to 200 characters). Required | None |
| `base_image` | The base image. Required | None |
| `image` | The name of the image to build | `sacty-agent-<name>:1.8.0` |
| `node_image` | The image to copy Node.js from (when the base image does not have Node.js 18 or later and npm) | `image_build.base_image`, or `node:22-bookworm-slim` if absent |
| `env` | Environment variables for the agent containers (including the final review that runs the tests) | None |
| `maven_mirror` | Where Maven and Gradle fetch from | None |
| `packages` | OS packages to install when building the image | None |
| `enable_repos` | IDs of package repositories to enable when installing `packages` | None |
| `run` | Commands to run as root when building the image | None |

- sacty adds git, Claude Code, and Codex to the base image and runs as the `node` user.
  - If the base image has Node.js 18 or later and npm, sacty uses them; otherwise it copies them from `node_image`. It looks for npm in `npm root -g`, `/usr/local/lib/node_modules`, and `/usr/lib/node_modules`.
  - sacty uses the npm settings from `image_build`.
  - Because agents run as the `node` user, sacty sets `HOME` to `/home/node` and `GOPATH` to `/home/node/go`, and adds `/home/node/go/bin` to PATH. This lets agents write even if the CI image points these to root's locations. You can override `GOPATH` with `env`.
- In `env`, write things such as your organization's registries (`PIP_INDEX_URL`, `UV_DEFAULT_INDEX`, `GOPROXY`, `GONOSUMDB`, and so on).
  - Names consist of uppercase letters, digits, and `_`, starting with an uppercase letter or `_`.
  - Because the values are visible to every command inside the container, you cannot write authentication values (names containing `TOKEN`, `PASSWORD`, `SECRET`, `AUTH`, `API_KEY`, and so on, and URLs containing a user name or password).
  - You also cannot write `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `NODE_OPTIONS`, or names starting with `SACTY_`, `DOCKER_`, `CODEX_`, `CLAUDE_`, `ANTHROPIC_`, `OPENAI_`, or `NPM_CONFIG_`.
- `maven_mirror` points all fetches by Maven (a mirror in `settings.xml`) and Gradle (an init script) to that URL. You cannot write URLs containing a user name or password, or URLs containing symbols such as quotation marks.
- sacty installs the OS packages written in `packages` as root when building the image, using whichever of dnf, microdnf, yum, and apt-get the base image has. It runs the commands written in `run` as root, in order from the top, when building the image (setting up your organization's package repositories, installing CLIs, and so on). The build stops if one fails.

  Changing `packages` or `run` makes `sacty image build` rebuild the image. Because they remain in the image, do not write secrets in `run`.

  ```yaml
  images:
    node-pw:
      description: Node.js 22, Playwright
      base_image: registry.example.com/ci/node:22
      packages: [nss, nspr, atk, at-spi2-atk, cups-libs, libdrm, libxkbcommon, mesa-libgbm, pango, alsa-lib]   # RHEL-based
      run:
        # separate the download from the installation (so the build stops if the download fails)
        - curl -fsSL https://artifacts.example.com/pf-cli/install.sh -o /tmp/pf-install.sh
        - sh /tmp/pf-install.sh
  ```

  A `run` command stops the build if its exit code is not 0. If the base image has bash, sacty runs the commands with `pipefail`, so a failure in the middle of a pipe also stops the build. In images without bash (run with `sh`), only the exit code of the last command in a pipe is checked. For steps that download and run something, split them into separate items instead of connecting them with a pipe.

  Agents do not run as root, so they cannot install OS packages during a task. Get the Playwright browser itself during the task with `npx playwright install chromium`, matching the repository's version. Put only the OS libraries in the image; for Debian-based images, `run: [npx -y playwright@<version> install-deps chromium]` also works.
- For package repositories that are configured in the base image but disabled (such as your organization's rpm repositories), write their repo IDs in `enable_repos`, and sacty enables them when installing `packages` (`--enablerepo` for dnf, microdnf, and yum).
  - This cannot be used with apt-get images. The build stops and shows the reason, so set up repositories with `run`.
  - IDs start with an alphanumeric character and contain only alphanumerics and `. _ : -`.
  - Write it together with `packages` (it is an error without `packages`).
  - Changing `enable_repos` makes `sacty image build` rebuild the image.

  ```yaml
  images:
    rocky-pw:
      description: Rocky Linux 9, Playwright
      base_image: registry.example.com/ci/rocky:9
      enable_repos: [acme-baseos, acme-appstream]
      packages: [nss, nspr, atk, at-spi2-atk, cups-libs, libdrm, libxkbcommon, mesa-libgbm, pango, alsa-lib]
  ```

  You can check the repo IDs in the base image with `docker run --rm --user root --entrypoint dnf <base image> repolist --all`.

## Which image a step runs in

- When the orchestrator chooses the steps, it picks an image from `images` for each step. To choose, it reads the repository (`pom.xml`, `go.mod`, `pyproject.toml`, `package.json`, and so on; in a monorepo, the directories the step touches). The orchestrator itself runs in the default image.
- Tests run in the images of the following steps, so the orchestrator is asked to choose the image that runs the tests from the test command and the repository's dependencies (browser tests such as Playwright, DB clients, and so on).
  - The Implementation step (the Goal Guardian runs them in the final review)
  - For bug fixes, the Reproduce step (the reproduce agent runs them)
- The default image (`image`) is the last resort when none of `images` fits. It is a minimal image with only Node.js and git to run Claude Code and Codex; it has no test browsers, DB clients, or tools for other languages. Even for a Node.js repository, a matching image in `images` is used instead.
- For a step that runs in the default image, the reason why none of `images` fits is recorded in the Activity (the task page). If the orchestrator gave no reason for a step, the task does not stop; the step runs in the default image and the Activity shows "Runs on the default image with no reason". When tests fail, check this and add the tools each image includes (such as Playwright) to its `description` in `images`.
- If the Goal Guardian reports that a tool written in the test (verification) command is not in the image that runs the tests, sacty pauses the task and guides you to add the tool to the image ([When the verification tool is not in the image](tasks.en.md#when-the-verification-tool-is-not-in-the-image)).
- If you specify an image for a project target (a repository or an Org), the orchestrator does not choose, and every step uses that image. A repository's setting takes precedence over an Org's (see [Project settings](project-settings.en.md#targets)).
- For a PR-review-only task ([Intake](intake.en.md)) too, if no image is specified, the orchestrator chooses the image for the review step from `images`. The review runs the project's verification such as tests and lint, so the orchestrator is asked to choose an image that has those tools. If `images` is not configured, the review runs in the default image without the orchestrator.
- The chosen image and the reason are recorded in the Activity. If a name not in `images` is chosen or specified, sacty stops and shows the reason.

### Changing a step's image

If the orchestrator chooses an image that doesn't fit a step (for example, the default image for a repository that needs Playwright), you can choose again for each step. Make the change in "Step images" in the "Steps" section of the task detail.

- You can choose a name in `images` or `default` (the default image). Each description is shown.
- When the change is not possible, the screen shows the following.
  - A name not in `images` (such as a name removed from config.yaml) is refused with the reason.
  - When config.yaml can't be read, the change is refused with the settings problem as the reason.
  - When sacty's status can't be fetched, the screen says the choices can't be checked and doesn't offer the change (wait a moment and reopen the page).
- You can change a step in any state (yet to run, running, failed or paused, awaiting approval, or done).
  - The changed image is used from the next run of the step.
  - For a running step, the current run keeps its image and the next run uses the new one.
  - Each step on the screen shows when a change takes effect.
- The Goal Guardian runs the tests for verifying the implementation in the Implementation step's image. If you change the Implementation image, the next final review uses it.
- For a step that stopped with a failure or a pause, change the image and then retry with "Resume"; the step runs with the changed image.
- You can also change tasks whose project target specifies an image. Only the steps a person changed take precedence over the target's image.
- The Activity records a change as who changed which step from what to what.
  - The step images list shows when a person changed it and the previous name.
  - Why the Orchestrator left a step on the default image (or that no reason was given) is shown in the step images list until a person changes it.
  - The "Steps chosen" line in the Activity stays as it was recorded.

## Related pages

- [config.yaml settings](config.en.md)
- [docker compose services](compose.en.md)
