[日本語](intake.md) | **English**

# Ticket intake and GitHub

Periodically searches GitHub Issues and PRs and JIRA tickets and turns them into tasks. The intake sources and the GitHub account to use are set in the project, and the intake labels
in the sacty settings (shared by all projects). GitHub is accessed with the accounts logged in to `gh` on the host.

Related ADRs: [Allow the same name for the intake label and the review label](../adr/20261015-0850-allow-same-intake-and-review-label.md), [Keep the intake interval in the sacty settings, per kind of intake](../adr/20261015-0310-intake-intervals-per-kind.md), [Split intake into "Issue intake" and "PR review intake", and add the review label to sacty's PRs](../adr/20261015-0240-superseded-split-issue-and-pr-review-intake.md), [Add the intake label to PRs created by sacty, and take in reviews from a separate task as comments on the original task's PR](../adr/20261014-1445-superseded-label-sacty-pull-requests-for-review.md)

## Interval

- There are three kinds of intake (`IntakeKind`): `issues` (Issue intake; `intakeLabel`), `reviews` (PR review intake; `reviewLabel`,
  `reviewRequested`), and `tickets` (ticket intake; `ticketLabel`). Each kind is taken in separately, at its own interval in the sacty settings (`issueIntervalSec`, `reviewIntervalSec`,
  `ticketIntervalSec`; seconds; an integer of 60 or more; 300 if not set).
- Whether the interval has come is checked every 30 seconds, and the sacty settings are reread each time (a changed interval takes effect from the next check without restarting the daemon; it is measured from the time
  the last intake started). When the daemon starts, every kind is taken in right away. A round with no intake sources (no label, Off, or no targets) does not
  become the start of the interval, and that kind's record is cleared (the next check looks again, so turning it On takes it in at the next check).
  When the sacty settings are saved (what changed is not distinguished), the start of the interval of every kind is reset, and intake runs at the next check (intake reads the save count
  `settingsSaveCount`; in memory only). Turning it On, changing a label, and turning it Off and back On between checks all
  lead to intake at the next check this way. After that, the new interval is measured from the intake right after the save.
- If the sacty settings cannot be read, the reason is recorded as a failure of each kind that is not taking in, and the start of that kind's interval is reset (once fixed, intake runs at the next check;
  the periodic run does not stop). An unexpected failure during intake also resets the start of that kind's interval. Search failures and rate limits per intake source
  keep the start of the interval (intake runs at the next interval).
- The position read for each intake source (the GitHub update time, or where to continue for tickets) is advanced only after the intake (saving the tasks) succeeds. If the intake
  fails, the next round reads again from the previous position (items from the failed round are not skipped; items already taken in are not taken in twice).
  If the save count of the sacty settings (`settingsSaveCount`) or the version of the project settings (`projectsRevision`) differs between the start and the end of an intake,
  the position is not advanced (so that items not taken in, for example because intake was turned Off and back On midway, are not skipped; what changed is not distinguished).
- For a kind that is taking in when the sacty settings are saved, a new intake starts at the check after that intake ends (an intake in progress is not started twice).
- If the search finds nothing, the intake processing (`importIssues`, `importTickets`; they look through all tasks) is not called.
- Intake runs as long as `config.yaml` can be read (`config.yaml` has no intake items; `github:` is not read even if written). If it cannot be read, nothing is taken in.
- The kinds of intake run in parallel. A kind that is taking in is not started twice even when its interval comes (it waits for the intake to end). A failure, rate limit, or delay in one kind
  does not stop the other kinds (skipping searches because of a rate limit applies only within that kind in that round). Unexpected failures are also recorded as failures of that kind.
- `POST /api/intake/run` takes in every kind without waiting for the interval and returns the status after it ends (the kind cannot be chosen).
- The status (`intake.runs` of `GET /api/status`) has, for each kind, the time of the latest intake, the number of tasks created, and the intake sources that could not be taken in with the reasons
  (in memory only; cleared on restart). The web UI shows only the kinds that are On and configured, and adds the kind to targets that could not be taken in. Even when the sacty settings store
  cannot be read, the status returns the recorded intakes with `settingsUnreadable: true` and the reason it could not be read now (`settingsError`)
  (no labels and so on; the reason is known even before the periodic check. The web UI shows the reason and the records of every kind).
- For each intake source, how far it has read (the update time) is kept in memory per kind, and reading continues from there. When the project settings, a label, or On/Off changes
  (not including the interval) or the daemon restarts, it reads again from the beginning (items already taken in are not taken in twice). A failure in one intake source does not stop the other
  intake sources.

Code: `apps/daemon/src/intake.ts` (`IssueIntake`), `packages/core/src/projects.ts` (`IntakeKind`, `intakeIntervalSec`, `SactySettings`), `apps/daemon/src/service.ts` (`recordIntake`, `settingsSaveCount`, `status`)

## GitHub Issues and PRs

For each item in the sacty settings, sacty searches the project's targets (an org or repositories) (`/search/issues`, 100 at a time, oldest update first).
There are two kinds of intake: "Issue intake" (`intakeLabel`) and "PR review intake" (`reviewLabel`, `reviewRequested`). Only PR review intake
takes in PRs.

| Setting | Search condition | Task |
| --- | --- | --- |
| `intakeLabel` | `is:open is:issue label:"<label>"` | An ordinary task (issues only) |
| `reviewLabel` | `is:open is:pr label:"<label>"` | A PR review only (`source.review: label`; `sacty` for PRs created by sacty) |
| `reviewRequested` | `is:open is:pr user-review-requested:<account>` | A PR review only (`source.review: requested`) |

- Labels are up to 50 characters (`"` and `\` cannot be used). Comparison is case-insensitive. If not set, nothing is taken in.
- The intake label and the review label can have the same name (including names that differ only in upper and lower case). Even then, issues become
  ordinary tasks by the intake label, and PRs become review-only tasks by the review label (the searches are split by `is:issue` and `is:pr`, and the
  intake decision also never makes an issue a review task or a PR an ordinary task). PRs created by sacty are also taken in once, as `sacty` review tasks.
- PRs with the intake label are not taken in (even if found by the search, they are not made ordinary tasks). Tasks of PRs taken in before that
  (`start: github_pull_request` without `source.review`) continue as they are (the Orchestrator chooses the steps).
- The kinds written in `triageOff` (the kinds turned Off: `issues`, `reviewLabel`, `tickets`) are neither searched nor taken in, while the label is kept. Unknown kinds
  are rejected when saving.
- Review requests are only those made to you as an individual (requests to teams are not included). Only requests to the account chosen for that host in the responsible project are taken in.
  Even if a PR matches both the review label and a request, there is one review task.
- If a PR created by sacty (one in the ledger: the implementation PR of a task, a Requirements or Design PR, or a PR given the label; see [The review label on PRs](approval.en.md#the-review-label-on-prs))
  has the review label, it becomes a separate review-only task, not the task that created it (`source.review: sacty`; the Orchestrator does not
  choose steps). Even if it also matches a review request, it is `sacty` (so that the review reaches the task that created the PR). If the review label's triage is
  Off, it is not taken in by the label (and is not made `sacty`). Intake from review requests works separately: if `reviewRequested` is On and
  there is a request to the account chosen in the responsible project itself, even a sacty PR is taken in as `requested` (it does not reach the original task).
  - The number differs from the intake source (an Issue and so on) of the task that created the PR, so the PR is never skipped just because that task exists. The same PR is never
    taken in twice, so there is one review task per PR (updating the PR does not create a new review task).
  - Reviews that the review task posts on the PR, in rounds that require changes (and rounds whose verdict could not be read), are taken in as comments on the PR of the task that created it
    ([Importing PR comments](approval.en.md#importing-pr-comments)). Rounds with suggestions only or no findings are not taken in.
    The review task does not create PRs, so it does not itself add PRs that get the label.
- For the responsible project, a repository target takes precedence over an org target (`responsibleProject`). The same Issue or PR (`<repository>#<number>`) is never taken in twice.
- When a rate limit is hit (403 or 429 with 0 remaining, or `retry-after`), the other searches for that account are skipped.
- Intake sources with no account chosen are not searched, and `github.accountRequired` is recorded.

Code: `apps/daemon/src/service.ts` (`intakeSources`, `importIssues`, `sactyReviewsOf`, `saveSettings`), `apps/daemon/src/github.ts` (`GitHubIssueSearch`), `packages/core/src/projects.ts` (`SactySettings`, `TriageKind`, `responsibleProject`)

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
