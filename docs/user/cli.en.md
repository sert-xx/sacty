<!-- Code: packages/cli/src/index.ts (USAGE, main, parsePort), packages/cli/src/context-preview.ts, apps/daemon/src/context-template.ts, apps/daemon/src/config.ts (CONFIG_TEMPLATE) -->

[日本語](cli.md) | **English**

# CLI (the sacty command)

Run it as `npx sacty <command>`. `npx sacty --help` (`-h`) shows the usage. If you specify an unknown command, it shows the usage and exits with a failure.

## sacty up

```sh
npx sacty up [--port <web-ui-port>] [--daemon-port <daemon-port>]
```

Starts the daemon and the web UI (Next.js) and prints `http://127.0.0.1:4700` in the terminal (it does not open a browser). Ctrl+C stops both.

| Option | Default | Description |
| --- | --- | --- |
| `--port` | `4700` | Port of the web UI |
| `--daemon-port` | `4710` | Port of the daemon |

- Both the web UI and the daemon listen only on 127.0.0.1.
- Ports must be between 1 and 65535, and `--port` and `--daemon-port` must be different numbers.
- You cannot start it twice with the same `SACTY_HOME` ([Getting started](getting-started.en.md#where-data-is-stored)).

## sacty config init

```sh
npx sacty config init [--force]
```

Creates a template of the configuration file (`~/.sacty/config.yaml`, or `$SACTY_HOME/config.yaml` if you changed `SACTY_HOME`) ([config.yaml settings](config.en.md)).
If the file already exists, it stops. To overwrite it, add `--force`.

## sacty secret set

```sh
npx sacty secret set <name>
```

Saves a secret (a token or API key) in the macOS Keychain. Names can contain only letters, digits, `.`, `_`, and `-`. The value is prompted for by the `security` command
([Secrets](secrets.en.md)).

## sacty image build

```sh
npx sacty image build [<name>...]
```

Builds the container images for running agents. If you omit the names, it builds the default image and every per-language image listed under `images` in `config.yaml`
(`default` is the default image). If you specify a name that is not in `images`, it stops and shows the names it can build. If `config.yaml` has an error, it stops without building
([Container images](images.en.md)).

## sacty context init

```sh
npx sacty context init [<directory>] [--force]
```

Creates a template of a context repository. The directory defaults to the current directory. If a file (or `rules/`) with the same name as one in the template exists, it stops.
To overwrite, add `--force` ([Context repository](context.en.md#creating-the-template)).

## sacty context preview

```sh
npx sacty context preview <project> [--runtime claude-code|codex] [--json] [--no-content]
```

Shows the result of composing the context of a project (by ID or name): the files placed at run time, the layers, warnings, and so on. It queries the running sacty (`sacty up`)
(it stops if sacty is not running). Secrets are shown only as reference names. However, values written in the context repository, such as the contents of layer settings and string values in `mcp.yaml`,
are shown as is.

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
