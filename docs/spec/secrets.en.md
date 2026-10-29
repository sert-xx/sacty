[日本語](secrets.md) | **English**

# Secrets

Settings never contain secret values, only references (a keychain name or a 1Password reference). sacty retrieves values on the host when it uses them, and never shows them in the Activity, logs, the web UI, or containers (when going through the gateway).

Related ADR: [Also retrieve the secrets in project contexts all at once at startup and when saving](../adr/20261015-1303-prefetch-context-secrets.md)

## Reference forms

- Keychain name: `^[A-Za-z0-9._-]+$`
  - A generic password in the macOS keychain (service name `sacty`, with the name as the account).
  - `sacty secret set <name>` runs `security add-generic-password -U -s sacty -a <name> -w`, and `security` prompts for the value (sacty never touches the value).
  - sacty retrieves it with `security find-generic-password -s sacty -a <name> -w`. It does not cache it (it retrieves it each time it is used).
- 1Password reference: `op://<vault>/<item>[/<section>]/<field>[?<attribute>=<value>…]`
  - sacty retrieves it with `op read --no-newline [--account <account>]` (limit 120 seconds).
  - The account is `onepassword.account` (read from the settings on each retrieval).
  - sacty keeps retrieved values in memory only while the daemon is running, per pair of account and reference. It never writes them to disk. It combines concurrent requests into one, and references being retrieved in a bulk retrieval wait for its result. It does not keep failures.

When a value cannot be retrieved, the error is one of the following.

- `op` is missing: `secret.opMissing`
- Not signed in: `secret.opSignedOut`
- Other errors: `secret.opFailed`
- Not in the keychain: `run.secretNotFound`

If a value cannot be retrieved for a run, sacty fails the run (`auth`) and pauses the task. Resuming retrieves it again.

Code: `apps/daemon/src/secrets.ts` (`SecretRef`, `isOnePasswordRef`, `KeychainSecretStore`, `OnePasswordSecretStore`, `ResolvingSecretStore`, `KEYCHAIN_SERVICE`), `packages/cli/src/index.ts` (`secretSet`)

## Retrieving everything at startup

When the daemon starts listening, it retrieves the secrets it will use all at once (`prefetchSecrets`).

- Targets (`secretUses`)
  - `auth.secret` of the endpoints for the runtimes of the agents in use (default, Goal Guardian, audit (`audit_agent`), `step_agents`, and the agents in their `fallback`, including fallbacks of fallbacks) (`providers.<codex|claude>.auth.secret`; `providerKeyOf`)
  - `auth.secret` and `auth.token.secret` of `gateway.platforms`
  - Secrets in `env` of `gateway.mcp_servers`
  - The notification destination in the sacty settings (the Slack token or webhook URL; `settingsSecretUses`)
  - The secrets in the contexts of registered projects
- Not included (retrieved when used)
  - npm tokens (used only for building images)
  - gh tokens

### Context secrets

- How they are collected (`contextSecretUses`)
  - For each project with a context repository, sacty fetches and composes the context (including the upper layers of the inheritance chain and the default context; `contextSecretSources`).
  - It collects `auth.secret` and `auth.token.secret` of the composed `platforms.yaml` and the secrets in `env` and `headers` of `mcp.yaml`.
  - It does not include the following.
    - Platforms with the same name as a host platform (`gateway.platforms`) (the layer's ones are not used)
    - MCP servers with the same name as a host MCP server when there is a gateway (the layer's ones are not used)
    - The gateway's per-run token
  - The setting is shown like `プロジェクト「<name>」のコンテキスト（<layer>）の platforms.yaml の <PF>.auth.secret`.
- Fetch limits
  - sacty fetches contexts `CONTEXT_SECRETS_CONCURRENCY` (4) at a time, waiting at most `CONTEXT_SECRETS_TIMEOUT_MS` (30 seconds) in total.
  - For projects whose context could not be fetched, or not within the time, sacty shows the reason (`secret.contextUnavailable`; `secret.contextTimedOut` for the time limit) as a warning. It retrieves that project's context secrets when they are used.
  - sacty shows fetch error messages after redacting the gh token.
  - When the time limit passes, sacty stops fetches in progress. It stops git together with its process group (`git.aborted`) and removes the temporary directory of the fetched repositories.
  - git runs in its own process group. So when the daemon ends (SIGINT, SIGTERM, `exit`), sacty also stops fetches in progress with their groups ([Daemon shutdown](daemon-lifecycle.en.md#daemon-shutdown)).
- sacty retrieves context secrets in the same single retrieval as the other secrets (retrieval starts after the contexts are read).

### Retrieval and warnings

- sacty passes 1Password references to a child process as environment variables with a single `op run --no-masking --env-file <a file containing only the references (0600)>`, and receives them as JSON (so authentication happens once). If retrieving them all at once fails, it retrieves each reference again individually and collects the ones that could not be retrieved.
- For the keychain, sacty only checks that each value can be retrieved.
- For values that could not be retrieved, sacty shows the setting (such as `providers.codex.auth.secret`) and the reason in the terminal and as a warning in the web UI. Startup does not stop.
- Starting the host's MCP servers and preparing authentication for organization platforms (PF) begin after the bulk retrieval.

### Retrieving again and after saving

- `POST /api/secrets/prefetch` ("Get secrets again" in the web UI)
  - It discards the values it holds, fetches the contexts again, and retrieves the same targets as at startup.
  - Return values
    - The number retrieved (`fetched`)
    - The number of targets (`total`)
    - The number of contexts that could not be read (`unreadContexts`; the secrets in them are not counted in `total`)
    - The warnings (`problems`)
  - If some contexts could not be read, the web UI says that some secrets were not checked.
- After a project is saved (`POST /api/projects`, `PUT /api/projects/:id`, `POST /api/projects/import`)
  - sacty retrieves that project's context secrets all at once without holding up the response (`prefetchProjectSecrets`).
  - It does not retrieve references it already holds (it does not ask 1Password).
  - It shows values that could not be retrieved (`secret.savePrefetchFailed`) and the reasons a context could not be fetched as warnings in the web UI, replacing that project's previous warnings.
- After the sacty settings are saved (`PUT /api/settings`)
  - sacty retrieves the notification destination's secret without holding up the response (`prefetchSettingsSecrets`).
  - It does not retrieve references it already holds.
  - It shows values that could not be retrieved (`secret.settingsSavePrefetchFailed`) as warnings in the web UI, replacing the previous warnings of the sacty settings.

When replacing warnings, older results never overwrite newer ones. Each retrieval advances a generation when it starts, and sacty keeps the generation of the last retrieval started for the whole (the config file's secrets), for the sacty settings (the notification destination), and for each project. When startup, getting secrets again, or saving finishes, it does not rewrite the warnings of any scope for which a later retrieval has started (even if they overlap).

sacty does not retrieve secrets added to a context repository after startup in advance at any other point; it retrieves them when used (the context is fetched at the head of the ref each time). 1Password may ask for authentication then. To retrieve them in advance, get the secrets again or save the project again.

Code: `apps/daemon/src/service.ts` (`prefetchSecrets`, `prefetchProjectSecrets`, `prefetchSettingsSecrets`, `contextSecretUsesOf`, `CONTEXT_SECRETS_TIMEOUT_MS`, `CONTEXT_SECRETS_CONCURRENCY`), `apps/daemon/src/secret-uses.ts` (`secretUses`, `settingsSecretUses`, `contextSecretUses`), `apps/daemon/src/context.ts` (`contextSecretSources`), `apps/daemon/src/secrets.ts` (`OnePasswordSecretStore.prefetch`, `ResolvingSecretStore.prefetch`), `apps/daemon/src/server.ts`, `apps/daemon/src/main.ts`

## Keeping values from being shown

- Before recording to the Activity, sacty replaces the values used in that run with `[REDACTED]` in the agent's result text and output.
  - Target values: retrieved secrets, the gateway token, MCP header values, the gh token, and strings of 16 or more characters in auth files
  - It replaces the longest values first, regardless of length.
  - It does not change message codes and arguments with fixed values; it replaces only free text.
- sacty also replaces JSON strings (`"…"`) in the output that contain a value once their escapes (such as `\u0073`) are decoded with redacted strings. This is because sacty decodes the output's JSON for review comments, audits, reproduction tests, and so on.
  - A string may start at any `"` in the output (except escaped `"`). Each position is read once, so the time is proportional to the output length.
  - JSON inside escaped JSON is checked too.
- sacty writes session logs after redacting both the values themselves and their JSON-string forms ([Activity log](event-log.en.md)).
- sacty truncates the reasons for failures in getting PF tokens, starting the host's MCP servers, and notifications after redacting the values (and their JSON forms and each line).
- Passing values to containers
  - For AI, PFs, and context MCP servers going through the gateway (including `env` of command-type servers started on the host), sacty does not pass values to containers.
  - For settings used directly from the container (AI auth not going through the gateway, MCP with `via_gateway: false`), sacty passes values to the container as environment variables.
- sacty passes npm tokens for building images only as BuildKit secrets. Auth values cannot be written in `images.<name>.env` or `image_build.npm_config` ([Configuration](configuration.en.md)).
- sacty retrieves gh tokens each time it uses them with `gh auth token --hostname <host> --user <account>`, and does not store them.

Code: `apps/daemon/src/agents/redact.ts` (`redact`, `redactEscaped`, `redactText`, `secretStringsInJson`, `REDACTED`), `apps/daemon/src/session-logs.ts` (`secretForms`), `apps/daemon/src/platforms.ts` (`hideSecret`), `apps/daemon/src/gh.ts` (`GhCliAuth`)
