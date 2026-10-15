<!-- Code: apps/daemon/src/config.ts (image_build, images, languageImageTag), apps/daemon/src/image.ts, packages/cli/docker/Dockerfile, packages/cli/src/index.ts (imageBuild), apps/daemon/src/service.ts (changeStepImage), apps/web/src/components/step-image-form.tsx -->

[日本語](images.md) | **English**

# Container images

This page explains how to build the container images used to run agents and tests. Build images with `npx sacty image build`
([CLI](cli.en.md#sacty-image-build)). The built image (`image`; default `sacty-agent:0.1.0`) is used both for running agents and for running tests.

## Building images from a private registry

In environments where Docker Hub or the public npm registry cannot be used, write the base image and the npm registry in `image_build` in `config.yaml`, then
run `sacty image build`. If you omit them, the image is built from `node:22-bookworm-slim` on Docker Hub and the public npm registry.

```yaml
image: registry.example.com/sacty-agent:0.1.0
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

- The npm token is made available only during the build (a BuildKit secret). It does not remain in the image layers, history, or environment variables.
- If the base image has git, the image can be built even if Debian mirrors are unreachable.
- `npm_registry` also becomes the registry of npm inside the container (if `npm_config` has `registry`, that takes precedence). `npm_token` is
  used only when building the image, not inside the container.
- `npm_config` remains in the image and applies to every npm inside the container (such as `npm ci` in the target repository). If the target repository's `.npmrc` has
  the same item, that takes precedence. Authentication items (`_authToken`, `_auth`, `_password`, `username`, `email`, `certfile`, `keyfile`,
  `cert`, `key`) cannot be written, because they would remain in the image.

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
    env:                                          # passed to the agent and test containers
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
| `image` | The name of the image to build | `sacty-agent-<name>:0.1.0` |
| `node_image` | The image to copy Node.js from (when the base image does not have Node.js 18 or later and npm) | `image_build.base_image`, or `node:22-bookworm-slim` if absent |
| `env` | Environment variables for the agent and test containers | None |
| `maven_mirror` | Where Maven and Gradle fetch from | None |
| `packages` | OS packages to install when building the image | None |
| `enable_repos` | IDs of package repositories to enable when installing `packages` | None |
| `run` | Commands to run as root when building the image | None |

- sacty adds git, Claude Code, and Codex to the base image and runs as the `node` user. If the base image has Node.js 18 or later and npm,
  they are used; otherwise they are copied from `node_image` (npm is looked for in `npm root -g`, `/usr/local/lib/node_modules`, and `/usr/lib/node_modules`).
  The npm settings from `image_build` are used. Because agents run as the `node` user, `HOME` is set to `/home/node` and `GOPATH` to
  `/home/node/go` (`/home/node/go/bin` is added to PATH), so they can write even if the CI image points these to root's locations (`GOPATH` can be
  overridden with `env`).
- In `env`, write things such as your organization's registries (`PIP_INDEX_URL`, `UV_DEFAULT_INDEX`, `GOPROXY`, `GONOSUMDB`, and so on). Names consist of uppercase letters, digits, and `_`, starting with an uppercase letter or `_`.
  Because they are visible to every command inside the container, authentication values (names containing `TOKEN`, `PASSWORD`, `SECRET`, `AUTH`, `API_KEY`, and so on, and
  URLs containing a user name or password) cannot be written. `PATH`, `HOME`, `USER`, `SHELL`, `TMPDIR`, `NODE_OPTIONS`, and names starting with `SACTY_`, `DOCKER_`, `CODEX_`, `CLAUDE_`,
  `ANTHROPIC_`, `OPENAI_`, or `NPM_CONFIG_` cannot be written either.
- `maven_mirror` points all fetches by Maven (a mirror in `settings.xml`) and Gradle (an init script) to that URL.
  URLs containing a user name or password, and URLs containing symbols such as quotation marks, cannot be written.
- The OS packages written in `packages` are installed as root when building the image (using whichever of dnf, microdnf, yum, and apt-get the base image
  has). Commands written in `run` are run as root, in order from the top, when building the image (setting up your organization's package repositories, installing CLIs,
  and so on; the build stops if one fails). Changing `packages` or `run` makes `sacty image build` rebuild the image. Because they remain in the image, do not write secrets
  in `run`.

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

  A `run` command stops the build if its exit code is not 0. If the base image has bash, commands run with `pipefail`, so a failure in the middle of a pipe also
  stops the build; but in images without bash (run with `sh`), only the exit code of the last command in a pipe is checked. For steps that download and run something,
  split them into separate items instead of connecting them with a pipe.

  Agents do not run as root, so they cannot install OS packages during a task. Get the Playwright browser itself during the task with `npx playwright install chromium`,
  matching the repository's version (put only the OS libraries in the image; for Debian-based images,
  `run: [npx -y playwright@<version> install-deps chromium]` also works).
- For package repositories that are configured in the base image but disabled (such as your organization's rpm repositories), write their repo IDs in `enable_repos`,
  and they are enabled when installing `packages` (`--enablerepo` for dnf, microdnf, and yum). This cannot be used with apt-get images (the build
  stops and shows the reason; set up repositories with `run`). IDs start with an alphanumeric character and contain only alphanumerics and `. _ : -`. Write it together with `packages` (it is
  an error without `packages`). Changing `enable_repos` makes `sacty image build` rebuild the image.

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

- The image for each step is chosen by the orchestrator when it chooses the steps, by reading the repository (`pom.xml`, `go.mod`, `pyproject.toml`, `package.json`,
  and so on; in a monorepo, the directories the step touches), and it picks one from `images` for every step. Tests run in the image of
  the Implementation step (Reproduce for bug fixes), so the image that runs the tests is chosen from the test command and the repository's dependencies
  (browser tests such as Playwright, DB clients, and so on). The orchestrator itself runs in the default image.
- The default image (`image`) is the last resort when none of `images` fits. It is a minimal image with only Node.js and git to run Claude Code and Codex;
  it has no test browsers, DB clients, or tools for other languages. Even for a Node.js repository, a matching image in `images` is used instead.
- For a step that runs in the default image, the reason why none of `images` fits is recorded in the Activity (the task page). If the orchestrator gave no reason
  for a step, the task does not stop; the step runs in the default image and the Activity shows "Runs on the default image with no reason". When tests fail,
  check this and add the tools each image includes (such as Playwright) to its `description` in `images`.
- If you specify an image for a project target (a repository or an Org), the orchestrator does not choose and that image is used for every step
  (a repository's setting takes precedence over an Org's; see [Project settings](project-settings.en.md#targets)).
- The chosen image and the reason are recorded in the Activity. If a name not in `images` is chosen or specified, sacty stops and shows the reason.

### Changing a step's image

If the orchestrator chooses an image that doesn't fit a step (for example, the default image for a repository that needs Playwright), you can choose again
for each step in "Step images" in the "Steps" section of the task detail.

- You can choose a name in `images` or `default` (the default image). Each description is shown. A name not in `images` (such as a name removed from config.yaml)
  is refused with the reason. When config.yaml can't be read, the change is refused with the settings problem as the reason. When sacty's status can't be
  fetched, the screen says the choices can't be checked and doesn't offer the change (wait a moment and reopen the page).
- You can change a step in any state (yet to run, running, failed or paused, awaiting approval, or done). The changed image is used from the next
  run of the step. For a running step, the current run keeps its image and the next run uses the new one. Each step on the screen shows when a change takes effect.
- Tests run in the image of the Implementation step (Reproduce for bug fixes). If you change the Implementation image, the next test run uses it.
- For a step that stopped with a failure or a pause, change the image and then retry with "Resume"; the step runs with the changed image.
- Tasks whose project target specifies an image can be changed too. Only the steps a person changed take precedence over the target's image.
- A change is recorded in the Activity as who changed which step from what to what. The step images list shows when a person changed it and the previous name.
  Why the Orchestrator left a step on the default image (or that no reason was given) is shown in the step images list until a person changes it. The "Steps chosen"
  line in the Activity stays as it was recorded.

## Related pages

- [config.yaml settings](config.en.md)
- [docker compose services](compose.en.md)
