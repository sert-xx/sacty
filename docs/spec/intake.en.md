[日本語](intake.md) | **English**

# Ticket intake and GitHub

sacty periodically searches GitHub Issues and PRs and JIRA tickets and turns them into tasks. The project holds the intake sources and the GitHub account to use, and the sacty settings (shared by all projects) hold the intake labels. sacty accesses GitHub with the accounts logged in to `gh` on the host.

Related ADRs: [Allow the same name for the intake label and the review label](../adr/20261015-0850-allow-same-intake-and-review-label.md), [Keep the intake interval in the sacty settings, per kind of intake](../adr/20261015-0310-intake-intervals-per-kind.md), [Split intake into "Issue intake" and "PR review intake", and add the review label to sacty's PRs](../adr/20261015-0240-superseded-split-issue-and-pr-review-intake.md), [Add the intake label to PRs created by sacty, and take in reviews from a separate task as comments on the original task's PR](../adr/20261014-1445-superseded-label-sacty-pull-requests-for-review.md), [Create a separate task for a GitHub review re-request](../adr/20261019-0503-review-rerequest-new-task.md)

## Interval

There are three kinds of intake (`IntakeKind`). sacty takes in each kind separately, at that kind's interval in the sacty settings. The interval is in seconds, an integer of 60 or more, and 300 if not set.

| Kind | Intake | Settings | Interval |
| --- | --- | --- | --- |
| `issues` | Issue intake | `intakeLabel` | `issueIntervalSec` |
| `reviews` | PR review intake | `reviewLabel`, `reviewRequested` | `reviewIntervalSec` |
| `tickets` | Ticket intake | `ticketLabel` | `ticketIntervalSec` |

- Checks and the start of the interval
  - sacty checks every 30 seconds whether the interval has come, and rereads the sacty settings each time. A changed interval takes effect from the next check without restarting the daemon. The interval is measured from the time the last intake started.
  - When the daemon starts, sacty takes in every kind right away.
  - A round with no intake sources (no label, Off, or no targets) does not become the start of the interval, and sacty clears that kind's record. The next check looks again, so turning it On takes it in at the next check.
- When the sacty settings are saved
  - Without distinguishing what changed, sacty resets the start of the interval of every kind and takes them in at the next check. Intake reads the save count `settingsSaveCount` (in memory only).
  - Turning it On, changing a label, and turning it Off and back On between checks all lead to intake at the next check this way.
  - After that, the new interval is measured from the intake right after the save.
  - For a kind that is taking in when the settings are saved, a new intake starts at the check after that intake ends (an intake in progress is not started twice).
- On failure
  - If the sacty settings cannot be read, sacty records the reason as a failure of each kind that is not taking in, and resets the start of that kind's interval. Once fixed, intake runs at the next check. The periodic run does not stop.
  - An unexpected failure during intake also resets the start of that kind's interval.
  - Search failures and rate limits per intake source do not change the start of the interval (intake runs at the next interval).
- Read position
  - sacty advances the read position of each intake source (the GitHub update time, or where to continue for tickets) only after the intake (saving the tasks) succeeds. If the intake fails, the next round reads again from the previous position. Items from the failed round are not skipped, and items already taken in are not taken in twice.
  - If the save count of the sacty settings (`settingsSaveCount`) or the version of the project settings (`projectsRevision`) differs between the start and the end of an intake, sacty does not advance the position. This keeps items that were not taken in, for example because intake was turned Off and back On midway, from being skipped. What changed is not distinguished.
  - For each intake source, sacty keeps how far it has read (the update time) in memory per kind, and continues from there. When the project settings, a label, or On/Off changes (not including the interval), or the daemon restarts, it reads again from the beginning (items already taken in are not taken in twice).
  - A failure in one intake source does not stop the other intake sources.
- If the search finds nothing, sacty does not call the intake processing (`importIssues`, `importTickets`; they look through all tasks).
- Intake runs as long as `config.yaml` can be read. `config.yaml` has no intake items, and `github:` is not read even if written. If it cannot be read, nothing is taken in.
- The kinds of intake run in parallel.
  - A kind that is taking in is not started twice even when its interval comes (it waits for the intake to end).
  - A failure, rate limit, or delay in one kind does not stop the other kinds. Skipping searches because of a rate limit applies only within that kind in that round.
  - Unexpected failures are also recorded as failures of that kind.
- `POST /api/intake/run` takes in every kind without waiting for the interval and returns the status after it ends (the kind cannot be chosen).
- Status (`intake.runs` of `GET /api/status`)
  - For each kind, it has the time of the latest intake, the number of tasks created, and the intake sources that could not be taken in with the reasons. It is kept in memory only and cleared on restart.
  - The web UI shows only the kinds that are On and configured, and adds the kind to targets that could not be taken in.
  - Even when the sacty settings store cannot be read, the status returns the recorded intakes with `settingsUnreadable: true` and the reason it could not be read now (`settingsError`). It has no labels and so on. The reason is known even before the periodic check, and the web UI shows the reason and the records of every kind.

Code: `apps/daemon/src/intake.ts` (`IssueIntake`), `packages/core/src/projects.ts` (`IntakeKind`, `intakeIntervalSec`, `SactySettings`), `apps/daemon/src/service.ts` (`recordIntake`, `settingsSaveCount`, `status`)

## GitHub Issues and PRs

For each item in the sacty settings, sacty searches the project's targets (an org or repositories) (`/search/issues`, 100 at a time, oldest update first). There are two kinds of intake: "Issue intake" (`intakeLabel`) and "PR review intake" (`reviewLabel`, `reviewRequested`). Only PR review intake takes in PRs.

- How searches are combined
  - sacty combines all projects' targets into one search per domain (host), account, and kind of search (Issues with the intake label / PRs with the review label / review requests to you). When the targets are listed like `repo:a/b repo:c/d org:e`, GitHub finds what matches any of them. This keeps the number of searches to GitHub to a minimum regardless of the number of projects and targets.
  - One search holds up to `INTAKE_SCOPES_PER_QUERY` (30) targets, and sacty splits it beyond that.
  - `importIssues` checks the responsible project, duplicates, and the requested person for each item found.
  - Targets of a project with no account chosen are not combined. They stay per project and are not searched, and sacty shows the reason.
  - A combined search returns the other targets' results even if it includes a repository that does not exist or cannot be viewed (it does not fail because of that target alone). If all its targets are like that, sacty records it as a failure of that search.

| Setting | Search condition | Task |
| --- | --- | --- |
| `intakeLabel` | `is:open is:issue label:"<label>"` | An ordinary task (issues only) |
| `reviewLabel` | `is:open is:pr label:"<label>"` | A PR review only (`source.review: label`; `sacty` for PRs created by sacty) |
| `reviewRequested` | `is:open is:pr user-review-requested:<account>` | A PR review only (`source.review: requested`) |

- Labels
  - Labels are up to 50 characters (`"` and `\` cannot be used). Comparison is case-insensitive. If not set, nothing is taken in.
  - The intake label and the review label can have the same name (including names that differ only in upper and lower case). Even then, issues become ordinary tasks by the intake label, and PRs become review-only tasks by the review label. The searches are split by `is:issue` and `is:pr`, and the intake decision also never makes an issue a review task or a PR an ordinary task. PRs created by sacty are also taken in once, as `sacty` review tasks.
  - PRs with the intake label are not taken in (even if found by the search, they are not made ordinary tasks). Tasks of PRs taken in before that (`start: github_pull_request` without `source.review`) continue as they are (the Orchestrator chooses the steps).
  - The kinds written in `triageOff` (the kinds turned Off: `issues`, `reviewLabel`, `tickets`) are neither searched nor taken in, while the label is kept. Saving rejects unknown kinds.
- Review requests
  - Only requests made to you as an individual are taken in; requests to teams are not included. sacty takes in only requests to the account chosen for that host in the responsible project.
  - Even if a PR matches both the review label and a request, there is one review task.
- Review re-requests
  - When the request search finds the PR of a task taken in by a request (`source.review: requested`) that can be reviewed again (`canRereview`), sacty reads two things:
    - The PR's current requested reviewers (`requested_reviewers`)
    - The time of the last request to the task's account (`review_requested` in the PR events)
  - If the account is still requested and the last request is after the previous post, sacty creates a review-only task with a new ID in the same project (`reviewRerequest` in `TaskCreated`; `restartRerequestedReviews`).
    - The original task's completion status, post, history, cost, and execution session stay unchanged. The new task does not resume the original session.
    - sacty carries a snapshot of the previous review into `previousReview` of the new task.
    - `reviewRound` adds 1 to the previous round and continues the review count.
  - GitHub removes a request when the requested person posts a review, so a post normally clears it. Search results lag (a removed request can remain right after the post), so they alone never start a re-review. If a post did not clear the request (for example, the account changed after intake), the last request is older than the post, so it does not repeat after every post.
  - The most recently created task for the same PR is the predecessor only if it has posted and completed; an older completed task is never used as a fallback. sacty saves the request time, account, and predecessor task in the event, so repeated polling of the same request, concurrent processing, and daemon restarts create no duplicates. A later request after the new task has posted and completed creates another separate task.
  - Tasks that are running, not yet posted, or cancelled, tasks taken in by the label, and tasks for PRs sacty created are excluded. Nothing is checked while `reviewRequested` is Off.
  - If the current requested reviewers or the request time cannot be read, sacty starts no re-review, records `intake.rerequestUnchecked`, and does not advance that search's read position. The same PR is found again at the next intake. Each PR is checked once per intake.
  - If the same PR appears in searches for multiple accounts, sacty removes duplicates only after matching the task's account.
  - sacty reads PR events up to 50 pages. If another page remains, it records the read as failed and does not use partial results to decide whether a review was re-requested.
  - After the API reads, sacty confirms that intake is still On and that the selected account, review round, and posting time are unchanged before it creates a new task.
- PRs created by sacty (ones in the ledger: the implementation PR of a task, a Requirements or Design PR, or a PR given the label; see [The review label on PRs](approval.en.md#the-review-label-on-prs))
  - If such a PR has the review label, it becomes a separate review-only task, not the task that created it (`source.review: sacty`; the Orchestrator does not choose steps).
  - Even if it also matches a review request, it is `sacty` (so that the review reaches the task that created the PR).
  - If the review label's triage is Off, it is not taken in by the label (and is not made `sacty`).
  - Intake from review requests works separately. If `reviewRequested` is On and there is a request to the account chosen in the responsible project itself, even a sacty PR is taken in as `requested` (it does not reach the original task).
  - The number differs from the intake source (an Issue and so on) of the task that created the PR, so the PR is never skipped just because that task exists. The same PR is never taken in twice, so there is one review task per PR (updating the PR does not create a new review task).
  - Reviews that the review task posts on the PR, in rounds with findings (changes required or suggestions; and rounds whose verdict could not be read), are taken in as comments on the PR of the task that created it ([Importing PR comments](approval.en.md#importing-pr-comments)). Rounds with no findings are not taken in. The review task does not create PRs, so it does not itself add PRs that get the label.
- For the responsible project, a repository target takes precedence over an org target (`responsibleProject`). The same Issue or PR (`<repository>#<number>`) is never taken in twice (except for new tasks created by review re-requests as described above).
- When a rate limit is hit (403 or 429 with 0 remaining, or `retry-after`), sacty skips the other searches for that account.
- sacty does not search intake sources with no account chosen, and records `github.accountRequired`.

Code: `apps/daemon/src/service.ts` (`intakeSources`, `importIssues`, `restartRerequestedReviews`, `sactyReviewsOf`, `saveSettings`), `apps/daemon/src/github.ts` (`GitHubIssueSearch`), `packages/core/src/projects.ts` (`SactySettings`, `TriageKind`, `responsibleProject`), `packages/core/src/events.ts` (`TaskCreated`), `packages/core/src/projection.ts` (`applyEvent`)

## JIRA tickets

The JIRA connection is written as an organization platform (PF) (`gateway.platforms`, or `platforms.yaml` in the project's context if not set). The project's `tickets` holds the connection (`platform`), the kind (`service`: `jira-cloud` | `jira-server`), and the project keys (`keys`, 1 to 50).

- sacty searches for unfinished tickets with the `ticketLabel` with this JQL:
  `project in ("<key>", …) AND labels = "<label>" AND statusCategory != Done ORDER BY created ASC`
  - Cloud uses `GET /rest/api/3/search/jql` (continued with `nextPageToken`).
  - Server / Data Center uses `GET /rest/api/2/search` (`startAt`).
  - sacty reads 50 at a time, up to 10 pages.
- The daemon reads only the key and the summary (up to 200 characters). The daemon does not call APIs that are not in the PF's `allow` either (`ticket.notAllowed`).
- The task title is `<key> <summary>`, with `start: jira`. The key prefix (`PAY` of `PAY-123`) decides the responsible project. The Orchestrator reads the ticket through the gateway and decides the repository, title, and summary ([Tasks and steps](tasks-and-steps.en.md)).
- The same key of the same connection can be written in only one project (PFs in a project's context are treated as separate for each project).

Code: `apps/daemon/src/tickets.ts` (`JiraTickets`, `ticketJql`), `apps/daemon/src/service.ts` (`importTickets`, `triageTicket`), `packages/core/src/projects.ts` (`projectConflicts`, `responsibleTicketProject`)

## Comments on the intake source

- When a task whose goal is investigation is approved, sacty posts the result as a comment on the intake source.
- GitHub
  - sacty includes the marker `<!-- sacty-investigation:<task ID> -->`, and does not post twice if it posted a comment before.
  - The body is up to 60000 characters.
  - If there is a URL the result was exported to, sacty adds it.
  - Failures are recorded in `IssueCommentFailed`.
- JIRA
  - sacty comments once with the investigation result and, if a PR was created, the PR URL (and the URL the result was exported to) (`POST /rest/api/2/issue/<key>/comment`).
  - sacty does not change the ticket's status.

Code: `apps/daemon/src/service.ts` (`commentInvestigation`, `awaitingIssueComment`, `awaitingTicketPrComment`), `apps/daemon/src/prompts.ts` (`investigationMarker`, `buildInvestigationComment`, `buildTicketPullRequestComment`), `apps/daemon/src/tickets.ts` (`JiraTickets.comment`)

## GitHub accounts and APIs

- The project's `githubAccounts` (per host) chooses the account to use. sacty does not use the active account of gh. If none is chosen, the work stops.
- Account list and tokens
  - sacty reads the list with `gh auth status --json hosts`, and reads the token with `gh auth token --hostname <host> --user <account>` each time it uses it.
  - The list also includes accounts whose token gh could not verify (`state` is `error` or `timeout`), with `state` and `error` (gh's reason).
  - The project settings screen lets you choose such an account, marked "not verified", and also shows the list of accounts read (host, account, status).
  - sacty passes gh only `GH_PROMPT_DISABLED=1`, `NO_COLOR=1`, and a limited set of the host's environment variables (config, keyring, proxy, and CA locations). It does not pass `GH_TOKEN`, `GITHUB_TOKEN`, or `GH_ENTERPRISE_TOKEN`.
- sacty reads the target host from the target URL (`https://<host>/<owner>[/<name>]`).
  - Before reading, it converts full-width characters with NFKC, removes invisible characters (zero-width spaces, BOM), the query, the fragment, a trailing `/`, and `.git`, and lowercases the host.
  - A target that can't be read has no host, so it does not appear in the account section.
  - The reason a target can't be read (SSH, http, a user name and so on, host characters, an extra path, or org and repository mixed up) is shown under the input and when saving.
- The API is `https://api.github.com` for github.com, and `https://<host>/api/v3` for others (GitHub Enterprise Server).
- When cloning and pushing HTTPS repositories, sacty passes the token of that host's account through `http.https://<host>/.extraheader`. SSH and local paths use the host's authentication.

Code: `apps/daemon/src/gh.ts` (`GhCliAuth`, `ghEnv`, `gitAuthEnv`), `apps/web/src/components/project-editor.tsx`, `packages/core/src/github-url.ts` (`githubApiBase`, `targetUrlProblem`), `apps/daemon/src/github.ts`
