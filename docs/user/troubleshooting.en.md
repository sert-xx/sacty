<!-- Code: packages/cli/src/index.ts, apps/daemon/src/config.ts (loadConfig), apps/daemon/src/instance-lock.ts, apps/daemon/src/intake.ts, apps/daemon/src/secrets.ts, apps/daemon/src/host-mcp.ts, apps/daemon/src/services.ts, apps/daemon/src/notifier.ts -->

[日本語](troubleshooting.md) | **English**

# Troubleshooting

This page lists common ways sacty stops and what to check.

## Startup and configuration

| Symptom | What to check |
| --- | --- |
| `sacty up` exits saying another sacty is running | A sacty is running with the same `SACTY_HOME`. Stop the sacty at the address and PID shown, or start with a different `SACTY_HOME` and ports ([Getting started](getting-started.en.md#where-data-is-stored)) |
| It exits with `--port and --daemon-port must be different` | Specify different numbers for `--port` and `--daemon-port` ([CLI](cli.en.md#sacty-up)) |
| The web UI shows an error in the configuration file | Look at the item (for example `providers.codex.auth.secret`) and the reason shown on the web UI, and fix `config.yaml` ([config.yaml settings](config.en.md)). If the file does not exist, create it with `npx sacty config init` |
| `sacty context preview` exits saying it cannot find a running sacty | Start sacty first with `npx sacty up` (with the same `SACTY_HOME`) |

## Secrets

| Symptom | What to check |
| --- | --- |
| A warning at startup says a secret could not be retrieved | Prepare the secret for the setting named in the warning (for the Keychain, `npx sacty secret set <name>`; for 1Password, sign in and check the reference). Then press "Get secrets again" in "Sacty settings" ([Secrets](secrets.en.md)) |
| A task stopped on a 1Password reference | Sign in with `op signin` (or through the 1Password app integration), then resume the task |
| At startup or at the top of the screen, "The agent image (…) is missing" appears | Create the image with the command shown (such as `npx sacty image build`). After raising the version, the image name changes, so it has to be rebuilt. Once created, the notice disappears in about a minute |
| "image in config.yaml (…) does not match the image for the running version of Sacty (…)" appears | Sacty was updated, but `image` (or `images.<name>.image`) in `config.yaml` still has the image name of the previous version. Change it as shown, then create the image with the command shown. The notice disappears in about a minute |
| "Docker is not reachable" appears | Start Docker (Docker Desktop and so on). Once it is running, the check runs again in about a minute and the notice disappears. Tasks cannot run until then |
| "The docker command was not found" appears | Install Docker and make the `docker` command available in the terminal where you run `sacty up` (put it on PATH) |
| `sacty image build` says there is no npm token | Save it with `npx sacty secret set <name>` (for a 1Password reference, check the sign-in and the reference) |

## Tasks stop or do not progress

| Symptom | What to check |
| --- | --- |
| Issues are not taken in | Check that you set the label to import and turned it On in "Issue intake" of "Sacty settings", and that you chose the project's targets and GitHub account. The reason may appear in "Some targets could not be imported" on the project page ([Intake](intake.en.md)) |
| Tickets are not taken in | Check that you set the label and turned it On in "Ticket intake" of "Sacty settings", that the ticket has that label and is not finished (not in a done status), and that you wrote the connection, the kind, and the JIRA project key in "Ticket sources" in the project settings. Also check the `upstream`, the authentication, and `allow` (the search API) of the connection's PF (`gateway.platforms` in `config.yaml`, or `platforms.yaml` in the context repository). The issue label to import and the GitHub account are not used for ticket intake. The reason may appear in "Some targets could not be imported" on the project page ([JIRA tickets](intake.en.md#jira-tickets)) |
| A labeled PR is not taken in | Check that you saved the "Label for PR reviews" and turned "Import PRs with the review label" On in "Sacty settings", that the label on the PR has that name (PRs with the label to import are not taken in), that the PR is open, that the PR does not already have a task (the same PR is never taken in twice, for a task in any project, even a cancelled one), and that you chose the project's targets and GitHub account ([PR reviews](intake.en.md#pr-reviews)) |
| A PR that requests your review is not taken in | Check that you turned "Import PRs that request my review" On in "Sacty settings", and that the review request is to the GitHub account chosen for that host in the project itself (requests to teams are not taken in) ([PR reviews](intake.en.md#pr-reviews)) |
| Paused at the budget cap | Enter a new cumulative cap on the web UI and resume ([config.yaml settings](config.en.md#budget)) |
| Paused at the AI usage limit | Resume after the subscription limit or rate limit resets. If you write a fallback agent, Sacty switches to it instead of pausing ([Switching agents on failure](config.en.md#switching-agents-on-failure)). The same applies when the gateway reaches its retry limit ([Gateway](gateway.en.md#relaying-ai-calls)) |
| Stopped with "Stopped the agent because it ran longer than N minutes" | If the step takes a long time, raise the limit with `run_timeout` in `config.yaml` (for example `roles: { implement: 90 }`; for a final review whose tests take long, `test_minutes` or `roles: { final-review: 90 }`; [config.yaml settings](config.en.md)), then resume. It applies from the next run |
| The Goal Guardian or another run fails with `exec /tini: argument list too long` | The prompt was too large for a command argument. Update Sacty to the latest version, then resume the stopped task (prompts are passed through stdin, so there is no size limit) |
| Codex with Bedrock or similar stays at `Reconnecting... error sending request` | With Docker inside a virtual machine (such as Rancher Desktop), set `gateway.host_address` to an address that reaches the host ([Gateway](gateway.en.md#host-address)) |
| The task list says a host MCP server is not ready | Check that authentication works on the host, and check `command` and `env`. sacty restarts it every minute ([Gateway](gateway.en.md#host-mcp-servers)) |
| The Activity says the command of an MCP server in `mcp.yaml` is not found on the host | `command` servers start on the host by default. Install `npx`, `uvx`, and so on on the host, or add `via_gateway: false` to that server to start it inside the container ([Context repository](context.en.md#command-mcp-servers-run-on-the-host)) |
| A step stopped on a context error | Use "Context preview" in the project settings or `npx sacty context preview` to find which item in which file of which layer ([Context repository](context.en.md#checking-the-composed-result)) |
| Stopped on an image name that is not in `images` | Add it to `images` in `config.yaml`, or fix the image specified for the project's target ([Container images](images.en.md#which-image-a-step-runs-in)) |
| Stopped because docker compose services could not start | Check whether the settings named in the reason (`privileged`, host networking, mounts outside the workspace, and so on) are used ([docker compose services](compose.en.md#unsupported-settings)) |
| Cannot connect to MySQL or similar with `localhost` | Write `127.0.0.1`, or connect by service name ([docker compose services](compose.en.md#reaching-services-via-localhost)) |

## Notifications

| Symptom | What to check |
| --- | --- |
| Slack notifications do not arrive | Look at the reason shown on the dashboard or in "Slack notifications" in the "Sacty settings". You can check with "Send a test notification" in the "Sacty settings". Notifications set in projects with an earlier sacty are not used, so set them again in the "Sacty settings" ([Notifications](notifications.en.md)) |
| Mentions do not arrive | Write people by ID (`U…`, `W…`, `S…`) instead of @display name |
| The sender name and icon are not `Sacty` | Give the Slack app's bot token the `chat:write.customize` scope |

## Related pages

- [User documentation contents](README.en.md#contents)
