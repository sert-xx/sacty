[日本語](intake.md) | **English**

# Ticket intake and GitHub

Periodically searches GitHub Issues and PRs and JIRA tickets and turns them into tasks. The intake sources and the GitHub account to use are set in the project, and the intake labels
in the sacty settings (shared by all projects). GitHub is accessed with the accounts logged in to `gh` on the host.

Related ADR: [Add the intake label to PRs created by sacty, and take in reviews from a separate task as comments on the original task's PR](../adr/20261014-1445-label-sacty-pull-requests-for-review.md)

## Interval

- Intake runs every `github.poll_interval_sec` in `config.yaml` (60 or more, default 300). If `github` is not set, no intake happens. Whether the interval has come is checked every 30 seconds,
  and the settings are reread each time. `POST /api/intake/run` runs intake without waiting for the interval.
- For each intake source, how far it has read (the update time) is kept in memory, and reading continues from there. When the project settings change or the daemon restarts,
  it reads again from the beginning (items already taken in are not taken in twice). A failure in one intake source does not stop the others.

Code: `apps/daemon/src/intake.ts` (`IssueIntake`), `apps/daemon/src/config.ts` (`ConfigFile`)

## GitHub Issues and PRs

For each item in the sacty settings, sacty searches the project's targets (an org or repositories) (`/search/issues`, 100 at a time, oldest update first).

| Setting | Search condition | Task |
| --- | --- | --- |
| `intakeLabel` | `is:open label:"<label>"` (`triageOff` can exclude Issues or PRs) | An ordinary task. For PRs created by sacty, a PR review only (`source.review: sacty`) |
| `reviewLabel` | `is:open is:pr label:"<label>"` | A PR review only (`source.review: label`) |
| `reviewRequested` | `is:open is:pr user-review-requested:<account>` | A PR review only (`source.review: requested`) |

- Labels are up to 50 characters (`"` and `\` cannot be used). Comparison is case-insensitive. If not set, nothing is taken in.
- Review requests are only those made to you as an individual (requests to teams are not included). Only requests to the account chosen for that host in the responsible project are taken in.
  A PR that matches a review is made a review-only task even if it has the intake label.
- If a PR created by sacty (one in the ledger: the implementation PR of a task, a Requirements or Design PR, or a PR given the intake label; see [The intake label on PRs](approval.en.md#the-intake-label-on-prs))
  has the intake label, it becomes a separate review-only task, not the task that created it (`source.review: sacty`; the Orchestrator does not
  choose steps, so that it does not implement again and add more PRs). If PR triage is Off, it is not taken in. Even if it also matches the review label or a review request,
  it is `sacty` (so that the review reaches the task that created the PR; also when the intake label and the review label are the same).
  - The number differs from the intake source (an Issue and so on) of the task that created the PR, so the PR is never skipped just because that task exists. The same PR is never
    taken in twice, so there is one review task per PR (updating the PR does not create a new review task).
  - Reviews that the review task posts on the PR are taken in as comments on the PR of the task that created it ([Importing PR comments](approval.en.md#importing-pr-comments)).
    The review task does not create PRs, so it does not itself add PRs that get the label.
- For the responsible project, a repository target takes precedence over an org target (`responsibleProject`). The same Issue or PR (`<repository>#<number>`) is never taken in twice.
- When a rate limit is hit (403 or 429 with 0 remaining, or `retry-after`), the other searches for that account are skipped.
- Intake sources with no account chosen are not searched, and `github.accountRequired` is recorded.

Code: `apps/daemon/src/service.ts` (`intakeSources`, `importIssues`, `sactyReviewsOf`), `apps/daemon/src/github.ts` (`GitHubIssueSearch`), `packages/core/src/projects.ts` (`SactySettings`, `responsibleProject`)

## JIRA tickets

The JIRA connection is written as an organization platform (PF) (`gateway.platforms`, or `platforms.yaml` in the project's context if not set), and the project's `tickets` holds
the connection (`platform`), the kind (`service`: `jira-cloud` | `jira-server`), and the project keys (`keys`, 1 to 50).

- sacty searches for unfinished tickets with the `ticketLabel`:
  `project in ("<key>", …) AND labels = "<label>" AND statusCategory != Done ORDER BY created ASC`.
  Cloud uses `GET /rest/api/3/search/jql` (continued with `nextPageToken`), and Server / Data Center uses `GET /rest/api/2/search` (`startAt`). 50 at a time, up to 10 pages.
- The daemon reads only the key and the summary (up to 200 characters). The daemon does not call APIs that are not in the PF's `allow` either (`ticket.notAllowed`).
- The task title is `<key> <summary>`, with `start: jira`. The responsible project is decided by the key prefix (`PAY` of `PAY-123`). The Orchestrator reads the ticket through the gateway
  and decides the repository, title, and summary ([Tasks and steps](tasks-and-steps.en.md)).
- The same key of the same connection can be written in only one project (PFs in a project's context are treated as separate for each project).

Code: `apps/daemon/src/tickets.ts` (`JiraTickets`, `ticketJql`), `apps/daemon/src/service.ts` (`importTickets`, `triageTicket`), `packages/core/src/projects.ts` (`projectConflicts`, `responsibleTicketProject`)

## Comments on the intake source

- When a task whose goal is investigation is approved, the result is posted as a comment on the intake source. On GitHub, the marker `<!-- sacty-investigation:<task ID> -->` is included, and if a comment
  was posted before, it is not posted twice (the body is up to 60000 characters). If there is a URL the result was exported to, it is added. Failures are recorded in `IssueCommentFailed`.
- On JIRA, sacty comments once with the investigation result and, if a PR was created, the PR URL (and the URL the result was exported to) (`POST /rest/api/2/issue/<key>/comment`).
  The ticket's status is not changed.

Code: `apps/daemon/src/service.ts` (`commentInvestigation`, `awaitingIssueComment`, `awaitingTicketPrComment`), `apps/daemon/src/prompts.ts` (`investigationMarker`, `buildInvestigationComment`, `buildTicketPullRequestComment`), `apps/daemon/src/tickets.ts` (`JiraTickets.comment`)

## GitHub accounts and APIs

- The account to use is chosen in the project's `githubAccounts` (per host). The active account of gh is not used. If none is chosen, the work stops.
- The list comes from `gh auth status --json hosts` (only successfully logged-in accounts), and the token from `gh auth token --hostname <host> --user <account>` each time it is used.
  gh receives only `GH_PROMPT_DISABLED=1`, `NO_COLOR=1`, and a limited set of the host's environment variables (`GH_TOKEN` and `GITHUB_TOKEN` are not passed).
- The API is `https://api.github.com` for github.com, and `https://<host>/api/v3` for others (GitHub Enterprise Server).
- Cloning and pushing HTTPS repositories pass the token of that host's account through `http.https://<host>/.extraheader`. SSH and local
  paths use the host's authentication.

Code: `apps/daemon/src/gh.ts` (`GhCliAuth`, `ghEnv`, `gitAuthEnv`), `packages/core/src/github-url.ts` (`githubApiBase`), `apps/daemon/src/github.ts`
