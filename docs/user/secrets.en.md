<!-- Code: packages/cli/src/index.ts (secretSet), apps/daemon/src/secrets.ts, apps/daemon/src/secret-uses.ts, apps/daemon/src/config.ts (onepassword) -->

[日本語](secrets.md) | **English**

# Secrets (Keychain, 1Password)

For tokens and API keys, write only a name (or a 1Password reference) in the settings files, and keep the value in the Keychain or 1Password. sacty never shows the values on the command line, in the activity log, in logs, or in the web UI.

## Store in the Keychain

Store a secret's value in the Keychain under a name, and write that name in the settings file.

1. Decide the name, and run the following command (the example name is `claude-oauth-token`).

   ```sh
   npx sacty secret set claude-oauth-token
   ```

2. The `security` command asks for the value, so enter it. The input is hidden, and it asks twice to confirm.
3. Write that name in the settings file (for example `secret: claude-oauth-token`).

The following rules apply to the name and to storing.

- Names can contain only letters, digits, `.`, `_`, and `-`.
- If the name already exists, it is overwritten.

## 1Password

For secrets stored in 1Password, write a reference (`op://vault/item/field`) instead of a name. sacty fetches values with the 1Password CLI (`op`), so sign in first with `op signin` (or through the 1Password app integration).

You can use references anywhere a secret goes, such as the following places.

- Authentication in `providers`
- `gateway.platforms`, `gateway.mcp_servers`
- `mcp.yaml` and `platforms.yaml` in the context repository
- The Slack notification destination in the "Sacty settings"
- npm tokens

The following example writes a reference for the authentication in `providers`. If you are signed in to more than one 1Password account, write the account to use in `onepassword.account`, as in the example.

```yaml
providers:
  codex:
    auth: { mode: api-key, secret: "op://Work/OpenAI/api-key" }
    available_models:
      gpt-6.1-terra: { input: 1, cached_input: 0.05, output: 5 }
# If you are signed in to more than one 1Password account, write the account to use
onepassword:
  account: acme.1password.com
```

The following describes how fetched values are kept and what happens when a value cannot be fetched.

- sacty keeps fetched values in memory only while the daemon is running (nothing is written to disk). It does not query the same reference again and again.
- If you are not signed in or the reference does not exist, sacty records which reference failed and why, and stops the task. Sign in and resume, and sacty fetches the value again.

## What is fetched at startup

When `sacty up` starts, it fetches the secrets in use all at once from the following places.

- Authentication in `providers` of the agents in use
- The authentication of `gateway.platforms` (`auth.secret`, `auth.token.secret`)
- The environment variables of `gateway.mcp_servers`
- The Slack notification destination in the "Sacty settings"
- `mcp.yaml` and `platforms.yaml` in the projects' context repositories

The secrets are fetched as follows.

- 1Password references are fetched with a single `op run`, so you authenticate only once, at startup.
- For Keychain secrets, sacty checks that they can be fetched (they are fetched each time they are used).
- Secrets in context repositories are collected by fetching each project's context (including the upper layers inherited with `extends`). Fetching waits at most 30 seconds. For projects whose context could not be fetched, the web UI shows a warning with the reason (those secrets are fetched when used).

Startup does not stop even if some secrets could not be fetched.

- For anything that could not be fetched at startup, sacty shows which setting failed and why, in a warning in the web UI and in the terminal.
- Once it is ready, press "Get secrets again" in "Sacty settings" in the web UI.
  - Getting the secrets again also fetches the contexts again.
  - If some contexts could not be read, the result says that the secrets in them were not checked.

The following are not fetched at startup.

- npm tokens used only for building images (they are fetched when used)
- GitHub tokens (they are fetched from `gh` each time they are used)

## What is fetched when you save a project or the Sacty settings

When you save settings, sacty also fetches the secrets that those settings use.

- When you save project settings (including when you create or import a project), sacty fetches that project's context secrets all at once. 1Password asks for authentication only when there are references not fetched yet.
- When you save the "Sacty settings", sacty fetches the secret of the Slack notification destination (the token or webhook URL). 1Password asks for authentication only when it has not been fetched yet.

In both cases, saving does not stop (it finishes without waiting for the fetch). Anything that could not be fetched is shown as a warning in the web UI.

## Secrets added to a context later

Secrets you add to the context repository after startup have not been fetched in advance. This is because sacty fetches the latest state of the context repository each time it uses it.

- The added secrets are fetched when used (running a step, ticket triage, calling an external platform, and so on). 1Password asks for authentication then.
- To fetch them in advance, do one of the following after changing the context repository.
  - Press "Get secrets again".
  - Save the project settings again.

## Related pages

- [config.yaml settings](config.en.md)
- [Troubleshooting](troubleshooting.en.md)
