<!-- Code: packages/cli/src/index.ts (secretSet), apps/daemon/src/secrets.ts, apps/daemon/src/secret-uses.ts, apps/daemon/src/config.ts (onepassword) -->

[日本語](secrets.md) | **English**

# Secrets (Keychain, 1Password)

For tokens and API keys, write only a name (or a 1Password reference) in the settings files, and keep the value in the Keychain or 1Password.
sacty never shows the values on the command line, in the activity log, in logs, or in the web UI.

## Store in the Keychain

```sh
npx sacty secret set claude-oauth-token
```

- Names can contain only letters, digits, `.`, `_`, and `-`.
- The `security` command asks for the value (the input is hidden, and it asks twice to confirm). If the name already exists, it is overwritten.
- Write that name in the settings file (for example `secret: claude-oauth-token`).

## 1Password

For secrets stored in 1Password, write a reference (`op://vault/item/field`) instead of a name. You can use references anywhere a secret goes:
agent authentication, `providers`, `gateway.platforms`, `gateway.mcp_servers`, `mcp.yaml` and `platforms.yaml` in the context repository, project notification destinations,
npm tokens, and so on.

```yaml
agents:
  codex-bedrock:
    runtime: codex
    auth: { mode: bedrock, secret: "op://Work/Bedrock/credential", region: us-east-2 }
    price_per_mtok_usd: { input: 1.25, cached_input: 0.125, output: 10 }
# If you are signed in to more than one 1Password account, write the account to use
onepassword:
  account: acme.1password.com
```

- Values are fetched with the 1Password CLI (`op`). Sign in first with `op signin` (or through the 1Password app integration).
- Fetched values are kept in memory only while the daemon is running, and the same reference is not queried again and again (nothing is written to disk).
- If you are not signed in or the reference does not exist, sacty records which reference failed and why, and stops the task. Sign in and resume, and the value is fetched again.

## What is fetched at startup

- When `sacty up` starts, it fetches the secrets in use all at once (authentication of the agents in use, `providers`, the environment variables of `gateway.platforms` and `gateway.mcp_servers`,
  project notification destinations, and `mcp.yaml` and `platforms.yaml` in the projects' context repositories).
  1Password references are fetched with a single `op run`, so you authenticate only once, at startup.
  For Keychain secrets, it checks that they can be fetched (they are fetched each time they are used).
- Secrets in context repositories are collected by fetching each project's context (including the upper layers inherited with `extends`).
  Fetching waits at most 30 seconds. For projects whose context could not be fetched, the web UI shows a warning with the reason (those secrets are fetched when used).
- For anything that could not be fetched at startup, the web UI shows a warning and the terminal shows which setting failed and why (startup does not stop). Once it is ready, press
  "Get secrets again" in "sacty settings" in the web UI. Getting the secrets again also fetches the contexts again.
- npm tokens used only for building images are not fetched at startup (they are fetched when used). GitHub tokens are fetched from `gh` each time they are used.

## What is fetched when you save a project

- When you save project settings (including when you create or import a project), sacty fetches that project's notification destination and context secrets
  all at once. 1Password asks for authentication only when there are references not fetched yet.
- Saving does not stop (it finishes without waiting for the fetch). Anything that could not be fetched is shown as a warning in the web UI.

## Secrets added to a context later

- The context repository is fetched at its latest state each time it is used. So secrets you add to the context repository after startup have not been fetched in advance.
- They are fetched when used (running a step, ticket triage, calling an external platform, and so on). 1Password asks for authentication then.
- To fetch them in advance, press "Get secrets again" after changing the context repository, or save the project settings again.

## Related pages

- [config.yaml settings](config.en.md)
- [Troubleshooting](troubleshooting.en.md)
