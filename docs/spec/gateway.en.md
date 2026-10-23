[日本語](gateway.md) | **English**

# Gateway

An HTTP relay that runs inside the daemon. When an agent's container calls the AI, the API of an organization platform (PF), or an MCP server, the gateway attaches the authentication values and forwards the request. The authentication values are never passed to the container; the container receives only a per-run token.

Related ADRs: [Start command-type MCP servers in the context's mcp.yaml on the host by default and route them through the gateway](../adr/20261014-0927-context-command-mcp-on-host.md), [Limit the request bodies the gateway receives](../adr/20261018-0450-gateway-body-limit.md)

The paths through the gateway are as follows.

![Gateway relay paths](images/gateway.en.svg)

## Listening and tokens

- The gateway listens on a free port on `127.0.0.1` (there is no setting to choose the port). Containers connect through `http://host.docker.internal:<port>` (`--add-host host.docker.internal:<gateway.host_address>`; default `host-gateway`).
- For each run, the gateway issues a token `sacty-gw-<48 hex digits>` and binds to it the AI endpoint, MCP, and the project context's PFs that the run uses.
  - It deletes the token when the run ends (401 after that).
  - The token is included in the values hidden from output.
- A failure during relaying ends only that request (502 if the response has not started). Error responses are `{ error: { message, type: "sacty_gateway" } }`.
- Request bodies are limited (common to all relays; the gateway holds them in the host's memory before sending them upstream). Over a limit, the gateway stops holding more, returns the reason, and closes the connection.
  - One request may be up to 64 MiB (`GATEWAY_BODY_MAX`). Over that, 413. If `Content-Length` exceeds the limit, the gateway refuses the request before reading; without it (or chunked), it stops at the amount received.
  - The bodies being received at the same time may total up to 256 MiB (`GATEWAY_BODIES_MAX`). Over that, 503 (`Retry-After: 1`). Held bodies count until the response finishes (the connection closes).
  - The gateway copies received data into 16 KiB blocks (`GATEWAY_BODY_BLOCK`), and the total counts the size of the allocated blocks. So a flood of tiny chunks does not use more memory than is counted.
- The gateway does not send the destination, authentication, length, connection, compression, and `expect` (the `100-continue` that curl and others add to large bodies) headers upstream.

| Path | Purpose | Authentication |
| --- | --- | --- |
| `/r/<token>/pf/<PF name>/<path>` | Organization platform (PF) (the agent receives `SACTY_PF_URL` = `…/r/<token>/pf`) | The token in the URL |
| `/r/<token>/github/<host>/<path>` | Reading GitHub (the agent receives `SACTY_GITHUB_URL` = `…/r/<token>/github`) | The token in the URL |
| `/ctx-mcp/<name>` | Context repository MCP (relaying the URL type, and the command type started on the host) | `Authorization: Bearer <token>` |
| `/mcp/<name>` | Host MCP servers | `Authorization: Bearer <token>` |
| `/openai/v1/…` | AI calls (`bedrock` and `openai-compatible` of `providers.codex`) | `Authorization: Bearer <token>` (passed in `AWS_BEARER_TOKEN_BEDROCK` or `SACTY_PROVIDER_API_KEY`) |

Code: `apps/daemon/src/gateway.ts` (`AiGateway.listen`, `register`, `handle`, `containerOrigin`, `platformsUrl`, `DEFAULT_HOST_ADDRESS`, `readBody`, `GATEWAY_BODY_MAX`, `GATEWAY_BODIES_MAX`, `GATEWAY_BODY_BLOCK`, `DROP_REQUEST`), `apps/daemon/src/service.ts` (`executeLogged`)

## Relaying AI calls

- Destination
  - Bedrock: `https://bedrock-runtime.<region>.amazonaws.com/openai/v1` (`endpoint: runtime`; the default) or `https://bedrock-mantle.<region>.api.aws/openai/v1` (`mantle`)
  - `openai-compatible`: `base_url`
- The gateway retrieves the API key on the host and attaches it as `Authorization: Bearer`. It does not send headers the agent set, such as `authorization` and `host`.
- On 429, 500, 502, 503, 504, or when the upstream could not be reached, the gateway waits and retries.
  - The wait is `Retry-After` (seconds or a date). If absent, it is an interval that starts at 1 second and doubles (capped at 60 seconds, with jitter).
  - Any other response is streamed as is.
  - Once the response has started, there is no retry.
- The limits are `gateway.retry.max_attempts` (the number of sends for one request; default 8) and `max_wait_sec` (the total wait during a run of consecutive failures; default 600).
  - The gateway re-reads the settings for each request.
  - A success (2xx) resets the total wait.
  - When a limit is reached, the gateway returns the last upstream response or a reason text (502 and so on). It sends later requests in that run once without waiting.
  - Later agent failures are classified by the output text ("Output handling" in [Agent execution](agent-execution.en.md)).
- A run that retried records the count, the time waited, the causing statuses, and whether it gave up in `AiRequestsRetried`.

Code: `apps/daemon/src/gateway.ts` (`RETRYABLE`, `BASE_DELAY_MS`, `MAX_DELAY_MS`, `DEFAULT_RETRY_POLICY`, `retryAfterMs`, `GatewayStats`), `apps/daemon/src/service.ts` (`bedrockOrigin`, `recordRetries`)

## Relaying organization platforms (PF)

PFs are written in `gateway.platforms` of `config.yaml` (all projects) or in `platforms.yaml` of the context repository (that project).

| Field | Meaning |
| --- | --- |
| `upstream` | Destination (http or https) |
| `description` | Description for the agent (default empty) |
| `auth.header`, `auth.prefix` | The header to attach authentication to (default `Authorization`) and the string placed before the value (default empty) |
| `auth.secret` | A fixed key (a secret reference) |
| `auth.token` | Gets a token with the key: `url`, `method` (default `POST`), `headers`, `query`, `json`, `form` (`{{secret}}` is replaced with the key), `secret`, `token_path`, `expires_in_path`, `ttl_sec` (default 300) |
| `allow` | The list of usable APIs (`<method> /<path>`; at least one) |

Write only one of `auth.secret` and `auth.token`.

### Token fetch settings

When loading the settings, sacty rejects the following in `auth.token`.

- `url` is http or https. It cannot contain `{{secret}}` (to send the key in the query, write it in `query`; `config.platformTokenUrlSecret`).
- `query` is "name: value" (the name is a non-empty string and the value is a string; `config.platformTokenQuery`).
- When `method` is `GET` or `HEAD`, `json` and `form` cannot be written (`config.platformTokenBody`).

The gateway builds the token endpoint URL (`tokenUrl`) as follows.

- It replaces `{{secret}}` in the values of `query` with the key.
- It URL-encodes the names and values (in addition to `encodeURIComponent`, `!'()*` are also encoded; spaces become `%20`).
- It appends them with `&` after any query already in `url`. It does not rewrite the existing query.
- It does not send the part of `url` after `#`.
- When `query` is not written (or is empty), it sends `url` as is.
- For `GET` without `json` or `form`, it attaches no body and no `content-type`.

### Reasons a token could not be obtained

The reason a token could not be obtained is shown in the web UI, logs, the activity log, and gateway responses. sacty hides the key and then truncates the reason to 600 characters.

- Forms hidden (all 4 characters or longer; `HIDE_MIN_LENGTH`) (`hideSecret`, `urlPattern`)
  - The value itself
  - Its JSON string form
  - Forms that can appear in a URL
  - Each line
- Forms that can appear in a URL
  - Character by character, either as is or a UTF-8 percent escape (upper- or lowercase hex, including double encoding as `%25`). Spaces may also be `+`.
  - Each escaped position may differ.
  - Unpaired surrogates appear only as is.
- When the whole value of a query parameter is the key, it is hidden regardless of length (names up to 256 characters).
  - The whole value is the key when the value in `?name=value` or `&name=value` is in one of the forms above and is followed by a character that cannot continue the value (anything other than alphanumerics, `-._~`, `%`, and `+`).
  - That is, when it is followed by the end of the text, `&`, `#`, `:`, `)`, `]`, `,`, `;`, a space, a newline, a quote, and so on.
- In the reason for a failed token fetch, in addition to the key, the sent query values that contain the key are also hidden as whole values by the same rules (longest first; `sentQueryValues`). An example is `pre-<key>` substituted from `pre-{{secret}}`.
- The same hiding applies to send-failure text (which includes the URL) and to the body of HTTP errors from the endpoint.

However, when an endpoint that has the key (`{{secret}}`) in a `query` value returns a failure status (other than 2xx), the gateway does not copy the body into the reason; it uses only the status code (`token endpoint returned <status> (the response body is not shown because the key is sent in the query)`; `sendsKeyInQuery`). The endpoint may echo the sent names and values in its body in any form (the URL, `api_token=abc`, JSON, and so on). A short key cannot be hidden regardless of form.

Two forms remain when relying only on the hiding rules.

- In send-failure text (the text of a fetch exception), when a short key (under 4 characters) or a short sent value appears in a form that is not the whole value of a query parameter (`name=value` after `?` or `&`). Node's fetch failure text is `fetch failed` and does not include the URL. `cause` is not included in the reason.
- When a short key appears in the failure body of an endpoint that sends the key in the body or headers (not in `query`) (unchanged; 4 characters or longer are hidden).

### Relay behavior

The relay flows as follows.

![Relaying an internal PF request](images/gateway-pf.en.svg)

- Lookup order is the host's PFs, then, if not found, the PFs of the project context bound to the run's token. Tokens of tasks in other projects do not find them (404).
- Matching `allow`
  - `*` matches one segment and `**` matches everything below (a trailing `/**` also matches that segment itself).
  - The query is ignored.
  - Paths containing `.` or `..` segments, `%2e`, `%2f`, or `\` do not match.
  - A path that changes when made into a URL (containing `#` or spaces, for example) is 400.
  - If nothing matches, 403 (the list of usable APIs is returned).
- For a read-only run (information gathering at the start of a task; `readOnly` of `register`), anything other than GET and HEAD is 403 even if it matches `allow` (it is not sent upstream).
- The gateway removes the agent's authentication, `cookie`, and the PF's authentication header from the headers sent, and attaches the authentication value. It does not follow redirects.
- The gateway refetches the token from 30 seconds before its expiry (`expires_in_path`, or `ttl_sec` if absent). If a 401 or 403 is returned for an `auth.token` PF, it refetches the token and sends the request again once.
- If the authentication value cannot be prepared, 502 (naming the PF, and for a context PF, the layer); if the upstream cannot be reached, 502.
- The daemon prepares authentication for the host's PFs at startup. A host PF that cannot be prepared is shown as a warning in the web UI (other PFs remain usable).
- The agent's instructions include the PFs and APIs usable in that task. For a read-only run, only the GET and HEAD rules are included (a PF with none left is not shown).

Code: `apps/daemon/src/platforms.ts` (`PlatformFile`, `TokenRequest`, `tokenUrl`, `hideSecret`, `pathPattern`, `isAllowed`, `PlatformCredentials`, `REASON_MAX`, `REFRESH_MARGIN_MS`, `platformPromptLines`, `readOnlyPlatforms`), `apps/daemon/src/gateway.ts` (`handlePlatform`, `sentUrl`)

## Relaying GitHub reads

The gateway relays the GitHub API for reading only. It has no setting and is always available (it cannot be turned off).

- When a run is registered, the gateway binds to it the gh accounts chosen per host in the task's project (`githubAccounts`). It does not bind them for the following runs.
  - Tasks of a project with no host that has an account
  - Runs that are not tasks
- The gateway takes the token out with the host's gh (`gh auth token --hostname <host> --user <account>`) when the first request for that host arrives, and keeps it only for that run. If it cannot be taken out, the gateway returns 502 (naming the account), and the next request tries again. The token is not passed to the container.
- Destination

  | API | github.com | Other hosts |
  | --- | --- | --- |
  | REST | `https://api.github.com` | `https://<host>/api/v3` |
  | GraphQL (the path is `/graphql`) | `https://api.github.com/graphql` | `https://<host>/api/graphql` |

- The gateway accepts only `GET` and `HEAD` for REST and `POST` for GraphQL. Other methods get 405.
  - GraphQL is sent only when the `query` in the body is a read; others get 403. A read means that outside the brackets, excluding strings and comments, there is no `mutation` or `subscription`. Anything unreadable, unclosed, an array, or without `query` is not treated as a read.
  - A GraphQL body may be up to 256 KiB (`GITHUB_GRAPHQL_BODY_MAX`). Over that, 413 is returned before the body is fully received (with `Content-Length` or chunked).
- A host that is not bound gets 404 (the available hosts are returned). A path with `.` or `..` segments, `%2e`, `%2f`, or `\`, and a path that changes as a URL get 400.
- The gateway sends only `accept`, `content-type`, `x-github-api-version`, `if-none-match`, `if-modified-since`, and `user-agent` upstream, with `Authorization: Bearer <token>`. It does not follow redirects.
- In the response's `link` (pagination) and `location`, the gateway rewrites the host's REST API URL to the relay URL (`…/r/<token>/github/<host>`).
- The agent receives the following environment variables.
  - `SACTY_GITHUB_URL`
  - `SACTY_GITHUB_HOSTS`: the bound hosts separated by spaces
  - `GH_HOST`: the host of the task's repository, else github.com, else the first host
- The end of the instructions gets how to read and, for a step's run, how to request comments on PRs and issues ([Tasks and steps](tasks-and-steps.en.md#requesting-comments-on-prs-and-issues)).
- The `gh` in the agent image sends only `gh api` (REST GET and GraphQL) to this relay ([Agent execution](agent-execution.en.md)).

Code: `apps/daemon/src/gateway.ts` (`handleGitHub`, `githubUrl`), `apps/daemon/src/github-relay.ts` (`isReadOnlyGraphql`, `githubGraphqlUrl`, `relayHeaderValue`, `GITHUB_RELAY_REQUEST`, `GITHUB_GRAPHQL_BODY_MAX`, `githubRelayEnv`, `githubPromptLines`), `apps/daemon/src/service.ts` (`executeLogged`, `githubRelayHosts`, `githubDefaultHost`), `packages/cli/docker/gh-shim.cjs`

## Relaying context MCP

`/ctx-mcp/<name>` looks up only names bound to the run's token (those of other runs or other projects return 404 even if the name is known). Where the request goes depends on the binding.

- URL type: the gateway relays the request to that upstream.
- Command type started on the host: the gateway relays the request to the host MCP server with the name inside the gateway (`ctx-…`) ("Command-type MCP servers started on the host" in [Context composition](context.en.md)). Command types started on the host cannot be used through `/mcp/`.

Relaying the URL type works as follows.

- The gateway sends only the `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`, and `last-event-id` headers upstream, and attaches the headers written in `mcp.yaml` (secrets are retrieved on the host). It does not send authentication and the like set by the agent.
- Responses (including SSE) are streamed as is. Redirects are not followed. If the upstream cannot be reached, 502 (with the MCP server's name in `mcp.yaml`).
- The upstream wait limit defaults to 5 minutes (`FETCH_DEFAULT_TIMEOUT_MS`). If the larger of the server's `startup_timeout_sec` and `tool_timeout_sec` is longer, the limit is extended to that value.

Code: `apps/daemon/src/gateway.ts` (`handle`, `handleContextMcp`, `relayHostMcp`, `ContextMcpRoute`, `CONTEXT_MCP_REQUEST`, `FETCH_DEFAULT_TIMEOUT_MS`, `contextMcpDispatcher`), `apps/daemon/src/service.ts` (`executeLogged`)

## Host MCP servers

The gateway starts the command of `gateway.mcp_servers.<name>` on the host, keeps it running, and gives it to agents as an HTTP MCP (`/mcp/<name>`). Command-type MCP servers from the context repository are also started on the host with the same mechanism (a separate pool). There are three differences ([Context composition](context.en.md)).

- What to start is decided by each run's lease.
- The working directory is a copy of the layer.
- The readiness wait limit.

Before starting, the gateway checks that the command exists on the host (those containing `/` from the working directory, others from `PATH`).

| Field | Meaning |
| --- | --- |
| `command`, `args` | The command to start (no shell is used) |
| `env` | Environment variables (added to the host's environment variables). Values are a string or `{ secret, prefix }` |
| `description` | Description (default empty) |
| `restart_every_min` | Interval for restarting before authentication expires (1 to 10080 minutes; optional) |
| `ready_timeout_sec` | Limit for waiting from start until ready (initialized) (5 to 3600 seconds; default 300) |
| `startup_timeout_sec`, `tool_timeout_sec` | Timeouts passed to the agent (same as `mcp.yaml`) |

- The gateway reconciles the settings every 30 seconds and before each run. It stops removed entries, starts added ones, and restarts changed ones. Changing only timeouts does not restart.
- A restart happens on `restart_every_min`, process exit, a tool returning what looks like an authentication error, or a dropped connection.
  - The gateway switches once the new process is ready.
  - It closes the old connection after in-flight calls finish (up to 5 minutes).
  - For an authentication error, it restarts only once and adds to the result a note to retry after a while.
- If starting fails, the gateway shows the reason (with secrets hidden) as a warning in the web UI, and restarts every minute. Calls while not ready get 503. For context servers, the response includes the name in `mcp.yaml`, the layer, and the project name, and does not return the name inside the gateway.
- Logs (start, restart, not ready, stop, process record failures, cleanup of leftovers from the previous run) show which MCP server it is (`mcpLogName`).
  - Host MCP servers: `host MCP <name>`
  - Context ones: `context MCP "<name in mcp.yaml>" (project "<project name>" [<project ID>], context "<layer>", internal ctx-…)`
  - Process records ("Records" below) also contain this name, and it appears in the log when leftovers from the previous run are stopped.
  - Secrets in standard error and environment variables are hidden as in reasons (only the hidden reason is logged).
- Before a run, the gateway waits up to `ready_timeout_sec` for the MCP servers the run uses to be ready. If one is not, it leaves which server in the context warnings and the run proceeds (for export, export to that destination stops).
- Relay timeouts
  - Tool calls: the larger of 10 minutes (`CALL_TIMEOUT_MS`) and `tool_timeout_sec`
  - Listings: the larger of 60 seconds (`LIST_TIMEOUT_MS`) and `startup_timeout_sec`
- Each process starts in its own process group (`detached`). To close, the gateway closes standard input and waits 2 seconds, sends SIGTERM to the process group and descendants, and sends SIGKILL if they have not ended within 3 seconds.
- Records
  - The gateway writes started processes (PID, start time, descendants, and the daemon that started them) to `SACTY_HOME/host-mcp/processes/<PID>.json`, and rewrites descendants every 10 seconds.
  - At daemon startup, it stops only processes whose recording daemon is not running, and only when the PID and start time match. It does not stop other processes that reused the PID, or those of another sacty running with the same `SACTY_HOME`.
  - If `ps` cannot be read, nothing is stopped.

Code: `apps/daemon/src/host-mcp.ts` (`HostMcpFile`, `HostMcpServers`, `reconcile`, `ready`, `restart`, `drain`, `assertCommand`, `mcpLogName`, `AUTH_ERROR`, `RETRY_MS`, `CALL_TIMEOUT_MS`, `LIST_TIMEOUT_MS`), `apps/daemon/src/context-mcp.ts` (`ContextMcpServers`), `apps/daemon/src/host-mcp-processes.ts` (`HostMcpProcesses`, `GroupStdioTransport`, `cleanup`, `terminate`), `apps/daemon/src/service.ts` (`mcpRouting`, `runContext`)
