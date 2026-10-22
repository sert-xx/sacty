<!-- Code: packages/cli/src/index.ts (USAGE, main, parsePort), packages/cli/src/context-preview.ts, apps/daemon/src/context-template.ts, apps/daemon/src/config.ts (CONFIG_TEMPLATE) -->

[日本語](cli.md) | **English**

# CLI (the sacty command)

Run it as `npx sacty <command>`. `npx sacty --help` (`-h`) shows the usage. If you specify an unknown command, it shows the usage and exits with a failure.

## sacty up

```sh
npx sacty up [--port <web-ui-port>] [--daemon-port <daemon-port>]
```

This command starts the daemon and the web UI (Next.js) and prints the web UI sign-in URL (`http://127.0.0.1:4700/auth?token=…`) in the terminal (it does not open a browser). Ctrl+C stops both.

| Option | Default | Description |
| --- | --- | --- |
| `--port` | `4700` | Port of the web UI |
| `--daemon-port` | `4710` | Port of the daemon |

- Both the web UI and the daemon listen only on 127.0.0.1.
- Only browsers that opened the sign-in URL can use the web UI (so that step containers cannot operate it). The URL changes on every start, and while that start lasts you can open it in another browser too. A browser that has not signed in sees only how to sign in.
- Writing `web: { auth: false }` in `~/.sacty/config.yaml` turns this sign-in off, and you can just open `http://127.0.0.1:4700` shown in the terminal. However, code running in step containers (tests in the target repository, prompt injection) can then approve or change settings through the web UI. While it is off, sacty shows a warning on every start.
  - `sacty up` reads `web.auth` only when it starts. After changing it, stop the running `sacty up` with Ctrl+C and start it again (while it keeps running, the previous setting stays in effect).
  - You can tell whether it is on or off from the terminal output at startup. When on, it shows the sign-in URL (`…/auth?token=…`); when off, it shows `http://127.0.0.1:4700` and a warning.
- Ports must be between 1 and 65535, and `--port` and `--daemon-port` must be different numbers.
- You cannot start it twice with the same `SACTY_HOME` ([Getting started](getting-started.en.md#where-data-is-stored)).

## sacty config init

```sh
npx sacty config init [--force]
```

This command creates a template of the configuration file (`~/.sacty/config.yaml`, or `$SACTY_HOME/config.yaml` if you changed `SACTY_HOME`) ([config.yaml settings](config.en.md)).
If the file already exists, it stops. To overwrite it, add `--force`.

## sacty secret set

```sh
npx sacty secret set <name>
```

This command saves a secret (a token or API key) in the macOS Keychain ([Secrets](secrets.en.md)). Names can contain only letters, digits, `.`, `_`, and `-`. The `security` command prompts you for the value.

## sacty image build

```sh
npx sacty image build [<name>...]
```

This command builds the container images for running agents ([Container images](images.en.md)).

- If you omit the names, it builds the default image and every per-language image listed under `images` in `config.yaml` (`default` is the default image).
- If you specify a name that is not in `images`, it stops and shows the names it can build.
- If `config.yaml` has an error, it stops without building.

## sacty context init

```sh
npx sacty context init [<directory>] [--force]
```

This command creates a template of a context repository ([Context repository](context.en.md#creating-the-template)). The directory defaults to the current directory. If a file (or `rules/`) with the same name as one in the template exists, it stops. To overwrite, add `--force`.

## sacty context preview

```sh
npx sacty context preview <project> [--runtime claude-code|codex] [--json] [--no-content]
```

This command shows the result of composing the context of a project (by ID or name): the files placed at run time, the layers, warnings, and so on. It queries the running sacty (`sacty up`) (it stops if sacty is not running).

It shows secrets only as reference names. However, it shows values written in the context repository as is, such as the contents of layer settings and string values in `mcp.yaml`.

| Option | Default | Description |
| --- | --- | --- |
| `--runtime` | `claude-code` | Which AI's format to show (`claude-code` or `codex`) |
| `--json` | None | Output the API result as is (JSON) |
| `--no-content` | None | Omit file contents |

If the context has an error, it exits with exit code 1.

## Environment variables

| Name | Description | Default |
| --- | --- | --- |
| `SACTY_HOME` | Where data (Activity, settings, workspaces) is stored | `~/.sacty` |

## Related pages

- [Getting started](getting-started.en.md)
- [Troubleshooting](troubleshooting.en.md)
