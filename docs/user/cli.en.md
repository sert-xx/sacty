<!-- Code: packages/cli/src/index.ts (USAGE, main, parsePort), scripts/cli-install.mjs, packages/cli/src/context-preview.ts, packages/cli/src/launch.ts, apps/daemon/src/local-launch.ts, apps/daemon/src/context-template.ts, apps/daemon/src/config.ts (CONFIG_TEMPLATE), apps/daemon/src/image.ts (pruneOldImages, BUILD_CACHE_MAX_UNUSED_DAYS) -->

[日本語](cli.md) | **English**

# CLI (the sacty command)

Run it as `npx sacty <command>` (inside the sacty repository). If you install it with `npm run cli:install`, you can use it as `sacty <command>` in any directory ([Getting started](getting-started.en.md#using-sacty-in-any-directory)).

The commands are as follows.

| Command | What it does |
| --- | --- |
| [`sacty up`](#sacty-up) | Starts the daemon and the web UI |
| [`sacty config init`](#sacty-config-init) | Creates a template of the configuration file |
| [`sacty secret set`](#sacty-secret-set) | Saves a secret in the macOS Keychain |
| [`sacty image build`](#sacty-image-build) | Builds the container images for running agents |
| [`sacty context init`](#sacty-context-init) | Creates a template of a context repository |
| [`sacty context preview`](#sacty-context-preview) | Shows the result of composing the context of a project |
| [`sacty launch`](#sacty-launch) | Starts your local Claude Code or Codex interactively with the context of a project |

The following applies to every command.

- `npx sacty --help` (`-h`) shows the usage, and `npx sacty --version` shows the version.
- `--help` and `--version` show the usage or the version without running the command, whichever command they follow (those written after `--` of `sacty launch` are passed to the AI CLI).
- If you specify an unknown command, it shows the usage and exits with a failure.

## sacty up

This command starts the daemon and the web UI (Next.js) and prints the web UI sign-in URL (`http://127.0.0.1:4700/auth?token=…`) in the terminal (it does not open a browser). Ctrl+C stops both.

```sh
npx sacty up [--port <web-ui-port>] [--daemon-port <daemon-port>]
```

| Option | Default | Description |
| --- | --- | --- |
| `--port` | `4700` | Port of the web UI |
| `--daemon-port` | `4710` | Port of the daemon |

Ports must be between 1 and 65535, and `--port` and `--daemon-port` must be different numbers. You cannot start it twice with the same `SACTY_HOME` ([Getting started](getting-started.en.md#where-data-is-stored)).

When stopping, it works as follows.

- sacty waits up to 30 seconds for in-progress work to clean up (such as recording to the activity log). If the cleanup takes long, it shows what it is waiting for (running tasks, PR checks, and so on).
- To stop without waiting, press Ctrl+C again while it is stopping. Runs whose cleanup was not finished are treated as interrupted at the next start, and tasks that were running are paused.

Both the web UI and the daemon listen only on 127.0.0.1. Only browsers that opened the sign-in URL can use the web UI (so that step containers cannot operate it).

- The URL changes on every start, and while that start lasts you can open it in another browser too.
- A browser that has not signed in sees only how to sign in.
- Writing `web: { auth: false }` in `~/.sacty/config.yaml` turns this sign-in off, and you can just open `http://127.0.0.1:4700` shown in the terminal. However, code running in step containers (tests in the target repository, prompt injection) can then approve or change settings through the web UI. While it is off, sacty shows a warning on every start.
  - `sacty up` reads `web.auth` only when it starts. After changing it, stop the running `sacty up` with Ctrl+C and start it again (while it keeps running, the previous setting stays in effect).
  - You can tell whether it is on or off from the terminal output at startup. When on, it shows the sign-in URL (`…/auth?token=…`); when off, it shows `http://127.0.0.1:4700` and a warning.

## sacty config init

This command creates a template of the configuration file (`~/.sacty/config.yaml`, or `$SACTY_HOME/config.yaml` if you changed `SACTY_HOME`) ([config.yaml settings](config.en.md)).

```sh
npx sacty config init [--force]
```

If the configuration file already exists, it stops without creating one. To overwrite it, add `--force`.

## sacty secret set

This command saves a secret (a token or API key) in the macOS Keychain ([Secrets](secrets.en.md)).

```sh
npx sacty secret set <name>
```

Names can contain only letters, digits, `.`, `_`, and `-`. The `security` command prompts you for the value.

## sacty image build

This command builds the container images for running agents ([Container images](images.en.md)).

```sh
npx sacty image build [<name>...]
```

Which images it builds is decided as follows.

- If you omit the names, it builds the default image and every per-language image listed under `images` in `config.yaml` (`default` is the default image).
- If you specify a name that is not in `images`, it stops and shows the names it can build.
- If `config.yaml` has an error, it stops without building.
- It does not build the images in `images.yaml` of context repositories (Sacty builds them in the background after `sacty up`. [Context images](images.en.md#context-images)).

Once everything is built, it cleans up old images and build cache.

- It removes old image versions (`sacty-agent` and `sacty-agent-<name>` images with `X.Y.Z` tags), keeping the two newest versions of each name.
- It also removes build cache unused for more than 3 days (the build cache of the whole Docker is the target).
- It does not remove the following images.
  - Images listed in `image` or `images`
  - Images with other tags or names
  - Images that containers use

## sacty context init

This command creates a template of a context repository ([Context repository](context.en.md#creating-the-template)).

```sh
npx sacty context init [<directory>] [--force]
```

The directory defaults to the current directory. If a file (or `rules/`) with the same name as one in the template exists, it stops. To overwrite, add `--force`.

## sacty context preview

This command shows the result of composing the context of a project (by ID or name): the files placed at run time, the layers, warnings, and so on. It queries the running sacty (`sacty up`) (it stops if sacty is not running).

```sh
npx sacty context preview <project> [--runtime claude-code|codex] [--json] [--no-content]
```

| Option | Default | Description |
| --- | --- | --- |
| `--runtime` | `claude-code` | Which AI's format to show (`claude-code` or `codex`) |
| `--json` | None | Output the API result as is (JSON) |
| `--no-content` | None | Omit file contents |

It shows secrets only as reference names. However, it shows values written in the context repository as is, such as the contents of layer settings and string values in `mcp.yaml`.

If the context has an error, it exits with exit code 1.

## sacty launch

This command starts your local Claude Code or Codex interactively with the context of a project (by ID or name): its rules, skills, MCP servers, external PFs, agent settings, and tier subagents. It queries the running sacty (`sacty up`) (it stops if sacty is not running).

```sh
npx sacty launch <project> [--runtime claude-code|codex] [--cwd <directory>] [-- <arguments for the AI CLI>...]
```

| Option | Default | Description |
| --- | --- | --- |
| `--runtime` | `claude-code` | Which AI to start (`claude-code` or `codex`) |
| `--cwd` | Current directory | The directory the AI works in |

What the started AI uses and how sacty treats it are as follows.

- **Account and settings**: The AI uses the account you are logged in with locally (for both Claude Code and Codex, whether the login is stored in the keychain or in a file) and your local settings as they are. It does not use the `agents` settings of sacty or the API keys saved in sacty.
- **Working directory**: It is `--cwd` (the current directory by default). Clone the target repository locally beforehand.
- **MCP servers**: Only the MCP servers in the project's context are used.
  - The MCP servers written in your local settings files (Claude Code's settings and `.mcp.json`, and Codex's `config.toml` and the target repository's `.codex/config.toml`) are not used.
  - MCP servers added in other ways, such as plugins, may not be stopped.
  - With Codex, if your local settings have an MCP server with the same name, sacty passes the one from the context under the name `<name>-sacty` (because Codex would mix settings with the same name). In that case, it tells you with `[sacty] 注意：` before starting.
- **Permission checks**: sacty does not pass settings that skip permission checks.
  - Claude Code starts in the mode that asks for permission (`--permission-mode default`).
  - Codex starts with the sandbox that can write only to the workspace and the policy that asks for approval when needed (`--sandbox workspace-write --ask-for-approval on-request`).
- **Arguments after `--`**: They are passed to the AI CLI as they are (for example `-- --model claude-opus-5-5`). If you pass the same argument as one sacty passes, the one after `--` takes effect.
  - Claude Code uses the one given later.
  - Codex's `-c` uses the one given later.
  - For Codex's `--sandbox` and `--ask-for-approval`, sacty does not pass its own when you pass them.
- **Records and cost**: Nothing is recorded in the activity log. sacty does not count costs or budgets for it either.
- **Quitting**: When you quit the AI CLI, sacty also exits and deletes the temporary files it placed. Ctrl+C goes to the AI CLI.

If something cannot be passed locally, it is shown with `[sacty] 注意：` before starting.

- When sacty's AI definition uses Bedrock or a `providers` endpoint, tier subagents are not passed (their model names may not work with your local login).
- Files that cannot be passed as arguments, such as `commands/` in `agents/claude/` of the context repository, are not passed.
- With Codex, if the rules and the skill list are too large to pass as an argument, it stops without starting.

## Environment variables

| Name | Description | Default |
| --- | --- | --- |
| `SACTY_HOME` | Where data (Activity, settings, workspaces) is stored | `~/.sacty` |

## Related pages

- [Getting started](getting-started.en.md)
- [Troubleshooting](troubleshooting.en.md)
