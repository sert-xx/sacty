[日本語](secrets.md) | **English**

# Secrets

Settings never contain secret values, only references (a keychain name or a 1Password reference). Values are retrieved on the host when used, and are not shown in the Activity,
logs, the web UI, or containers (when going through the gateway).

Related ADR: none

## Reference forms

- Keychain name: `^[A-Za-z0-9._-]+$`. A generic password in the macOS keychain (service name `sacty`, with the name as the account).
  `sacty secret set <name>` runs `security add-generic-password -U -s sacty -a <name> -w`, and `security` prompts for the value (sacty never touches the value).
  It is retrieved with `security find-generic-password -s sacty -a <name> -w`. It is not cached (it is retrieved each time it is used).
- 1Password reference: `op://<vault>/<item>[/<section>]/<field>[?<attribute>=<value>…]`. Retrieved with `op read --no-newline [--account <account>]`
  (limit 120 seconds). The account is `onepassword.account` (read from the settings on each retrieval).
- Retrieved 1Password values are kept in memory only while the daemon is running, per pair of account and reference (never written to disk; concurrent requests are
  combined into one; failures are not kept).
- When a value cannot be retrieved: `op` is missing (`secret.opMissing`), not signed in (`secret.opSignedOut`), other errors (`secret.opFailed`), or not in the keychain
  (`run.secretNotFound`). If it cannot be retrieved for a run, the run fails (`auth`) and the task is paused. Resuming retrieves it again.

Code: `apps/daemon/src/secrets.ts` (`SecretRef`, `isOnePasswordRef`, `KeychainSecretStore`, `OnePasswordSecretStore`, `ResolvingSecretStore`, `KEYCHAIN_SERVICE`), `packages/cli/src/index.ts` (`secretSet`)

## Retrieving everything at startup

- When the daemon starts listening, it retrieves the secrets it will use all at once (`prefetchSecrets`). The targets (`secretUses`) are `auth.secret` of the agents in use
  (default, Goal Guardian, `step_agents`), `providers.<name>.secret`, `auth.secret` and `auth.token.secret` of `gateway.platforms`,
  secrets in `env` of `gateway.mcp_servers`, and the projects' notification destinations (Slack tokens and webhook URLs). npm tokens (used only for
  building images), gh tokens, and secrets in the context repository's `mcp.yaml` and `platforms.yaml` are not included (they are retrieved when used).
- 1Password references are passed to a child process as environment variables with a single `op run --no-masking --env-file <a file containing only the references (0600)>`, and received
  as JSON (so authentication happens once). If retrieving them all at once fails, each reference is retrieved again individually, and the ones that could not be retrieved are collected. For the keychain,
  sacty only checks that each value can be retrieved.
- For values that could not be retrieved, the setting (such as `agents.<ID>.auth.secret`) and the reason are shown in the terminal and as a warning in the web UI (startup does not stop).
- `POST /api/secrets/prefetch` ("Get secrets again" in the web UI) discards the values it holds and retrieves them again.
- Starting the host's MCP servers and preparing authentication for organization platforms (PF) begin after the bulk retrieval.

Code: `apps/daemon/src/service.ts` (`prefetchSecrets`), `apps/daemon/src/secret-uses.ts` (`secretUses`), `apps/daemon/src/secrets.ts` (`OnePasswordSecretStore.prefetch`, `ResolvingSecretStore.prefetch`), `apps/daemon/src/main.ts`

## Keeping values from being shown

- In the agent's result text and output, the values used in that run (retrieved secrets, the gateway token, MCP header values, the gh token, and
  strings of 16 or more characters in auth files) are replaced with `[REDACTED]` before being recorded in the Activity (longest values first, regardless of length).
  Message codes and arguments with fixed values are not changed; only free text is replaced.
- Session logs are written after redacting both the values themselves and their JSON-string forms ([Activity log](event-log.en.md)).
- Reasons for failures in getting PF tokens, starting the host's MCP servers, and notifications are truncated after redacting the values (and their JSON forms and each line).
- For AI, PFs, and context MCP servers going through the gateway (including `env` of command-type servers started on the host), values are not passed to containers. For settings
  used directly from the container (AI auth not going through the gateway, MCP with `via_gateway: false`), values are passed to the container as environment variables.
- npm tokens for building images are passed only as BuildKit secrets. Auth values cannot be written in `images.<name>.env` or `image_build.npm_config`
  ([Configuration](configuration.en.md)).
- gh tokens are retrieved each time they are used with `gh auth token --hostname <host> --user <account>`, and are not stored.

Code: `apps/daemon/src/agents/redact.ts` (`redact`, `redactText`, `secretStringsInJson`, `REDACTED`), `apps/daemon/src/session-logs.ts` (`secretForms`), `apps/daemon/src/platforms.ts` (`hideSecret`), `apps/daemon/src/gh.ts` (`GhCliAuth`)
