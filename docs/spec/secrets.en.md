[日本語](secrets.md) | **English**

# Secrets

Settings never contain secret values, only references (a keychain name or a 1Password reference). Values are retrieved on the host when used, and are not shown in the Activity,
logs, the web UI, or containers (when going through the gateway).

Related ADR: [Also retrieve the secrets in project contexts all at once at startup and when saving](../adr/20261015-1303-prefetch-context-secrets.md)

## Reference forms

- Keychain name: `^[A-Za-z0-9._-]+$`. A generic password in the macOS keychain (service name `sacty`, with the name as the account).
  `sacty secret set <name>` runs `security add-generic-password -U -s sacty -a <name> -w`, and `security` prompts for the value (sacty never touches the value).
  It is retrieved with `security find-generic-password -s sacty -a <name> -w`. It is not cached (it is retrieved each time it is used).
- 1Password reference: `op://<vault>/<item>[/<section>]/<field>[?<attribute>=<value>…]`. Retrieved with `op read --no-newline [--account <account>]`
  (limit 120 seconds). The account is `onepassword.account` (read from the settings on each retrieval).
- Retrieved 1Password values are kept in memory only while the daemon is running, per pair of account and reference (never written to disk; concurrent requests are
  combined into one, and references being retrieved in a bulk retrieval wait for its result; failures are not kept).
- When a value cannot be retrieved: `op` is missing (`secret.opMissing`), not signed in (`secret.opSignedOut`), other errors (`secret.opFailed`), or not in the keychain
  (`run.secretNotFound`). If it cannot be retrieved for a run, the run fails (`auth`) and the task is paused. Resuming retrieves it again.

Code: `apps/daemon/src/secrets.ts` (`SecretRef`, `isOnePasswordRef`, `KeychainSecretStore`, `OnePasswordSecretStore`, `ResolvingSecretStore`, `KEYCHAIN_SERVICE`), `packages/cli/src/index.ts` (`secretSet`)

## Retrieving everything at startup

- When the daemon starts listening, it retrieves the secrets it will use all at once (`prefetchSecrets`). The targets (`secretUses`) are `auth.secret` of the agents in use
  (default, Goal Guardian, `step_agents`), `providers.<name>.secret`, `auth.secret` and `auth.token.secret` of `gateway.platforms`,
  secrets in `env` of `gateway.mcp_servers`, the notification destination in the sacty settings (the Slack token or webhook URL; `settingsSecretUses`), and the secrets in the contexts of
  registered projects. npm tokens (used only for building images) and gh tokens are not included (they are retrieved when used).
- Context secrets (`contextSecretUses`): for each project with a context repository, sacty fetches and composes the context (including the upper layers of the
  inheritance chain and the default context; `contextSecretSources`), and collects `auth.secret` and `auth.token.secret` of the composed `platforms.yaml` and the secrets in
  `env` and `headers` of `mcp.yaml`. Platforms with the same name as a host platform (`gateway.platforms`), MCP servers with the same name as a host MCP server when there is a gateway
  (the layer's ones are not used in either case), and the gateway's per-run token are not included. The setting is shown like
  `プロジェクト「<name>」のコンテキスト（<layer>）の platforms.yaml の <PF>.auth.secret`.
- Contexts are fetched `CONTEXT_SECRETS_CONCURRENCY` (4) at a time, waiting at most `CONTEXT_SECRETS_TIMEOUT_MS` (30 seconds) in total. For projects whose context could not be
  fetched, or not within the time, the reason (`secret.contextUnavailable`; `secret.contextTimedOut` for the time limit) is shown as a warning, and that project's
  context secrets are retrieved when used. Fetch error messages are shown after redacting the gh token. When the time limit passes, fetches in progress are stopped
  (git is stopped together with its process group (`git.aborted`), and the temporary directory of the fetched repositories is removed). Because git runs in its own process group,
  fetches in progress are also stopped with their groups when the daemon ends (SIGINT, SIGTERM, `exit`) ([Daemon shutdown](daemon-lifecycle.en.md#daemon-shutdown)).
- Context secrets are retrieved in the same single retrieval as the other secrets (retrieval starts after the contexts are read).
- 1Password references are passed to a child process as environment variables with a single `op run --no-masking --env-file <a file containing only the references (0600)>`, and received
  as JSON (so authentication happens once). If retrieving them all at once fails, each reference is retrieved again individually, and the ones that could not be retrieved are collected. For the keychain,
  sacty only checks that each value can be retrieved.
- For values that could not be retrieved, the setting (such as `agents.<ID>.auth.secret`) and the reason are shown in the terminal and as a warning in the web UI (startup does not stop).
- `POST /api/secrets/prefetch` ("Get secrets again" in the web UI) discards the values it holds, fetches the contexts again, and retrieves the same targets as at startup.
  It returns the number retrieved (`fetched`), the number of targets (`total`), the number of contexts that could not be read (`unreadContexts`; the secrets in them are not counted in `total`),
  and the warnings (`problems`). If some contexts could not be read, the web UI says that some secrets were not checked.
- After a project is saved (`POST /api/projects`, `PUT /api/projects/:id`, `POST /api/projects/import`), sacty retrieves that project's
  context secrets all at once without holding up the response (`prefetchProjectSecrets`). References it already holds are not retrieved (1Password is not asked).
  Values that could not be retrieved (`secret.savePrefetchFailed`) and the reasons a context could not be fetched are shown as warnings in the web UI, replacing that project's previous warnings.
- After the sacty settings are saved (`PUT /api/settings`), sacty also retrieves the notification destination's secret without holding up the response (`prefetchSettingsSecrets`).
  References it already holds are not retrieved. Values that could not be retrieved (`secret.settingsSavePrefetchFailed`) are shown as warnings in the web UI, replacing the previous warnings of the sacty settings.
- Replacing warnings: each retrieval advances a generation when it starts, and sacty keeps the generation of the last retrieval started for the whole (the config file's secrets), for the sacty settings (the notification destination), and for each project.
  When startup, getting secrets again, or saving finishes, it does not rewrite the warnings of any scope for which a later retrieval has started (even if they overlap, older results never overwrite newer ones).
- Secrets added to a context repository after startup (the context is fetched at the head of the ref each time) are not retrieved in advance at any other point; they are retrieved
  when used (1Password may ask for authentication then). To retrieve them in advance, get the secrets again or save the project again.
- Starting the host's MCP servers and preparing authentication for organization platforms (PF) begin after the bulk retrieval.

Code: `apps/daemon/src/service.ts` (`prefetchSecrets`, `prefetchProjectSecrets`, `prefetchSettingsSecrets`, `contextSecretUsesOf`, `CONTEXT_SECRETS_TIMEOUT_MS`, `CONTEXT_SECRETS_CONCURRENCY`), `apps/daemon/src/secret-uses.ts` (`secretUses`, `settingsSecretUses`, `contextSecretUses`), `apps/daemon/src/context.ts` (`contextSecretSources`), `apps/daemon/src/secrets.ts` (`OnePasswordSecretStore.prefetch`, `ResolvingSecretStore.prefetch`), `apps/daemon/src/server.ts`, `apps/daemon/src/main.ts`

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
