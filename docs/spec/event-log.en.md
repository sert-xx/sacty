[日本語](event-log.md) | **English**

# Activity log (events and projection)

Everything that happens to a task is recorded in the activity log (an append-only sequence of events). Task state is not stored; at startup the daemon rebuilds it by reading the activity log from the beginning (projection). The agent output of each run (the session log) is large, so it is kept in files, not in the activity log.

Related ADRs: none

## Event shape

The optional `documentFixes` on `BranchPushed` holds redacted and truncated paths, reasons, and diffs. `reasonTruncated` and `diffTruncated` indicate truncation. The projection retains fixes in push order.

- The shape for writing is `{ type, payload }`. It is validated with a zod discriminated union keyed on `type` (`EventInput`). There are 145 kinds (task creation and split, the merge of the dependency of a stacked child task, step progress, agent runs, budget, pause, resume, and cancel, changes to a task's title and image, change proposals and their decisions, verification, unfinished implementations and reworks that change nothing, git and PRs (including `StepBranchKept`, which records a step branch kept undeleted because a person added commits to it in a flow without an implementation, and `StepBranchesLeft`, which records the step branches the completion cleanup could not delete, with the reasons), marking a PR ready for review, retargeting it, requesting a CI rerun, recording the switches sacty made to remove a draft, and recording that it did not turn a PR back into a draft (a person removed it, it could not be read, or it could not be decided), merging commits a person added to a PR, recording PR bodies and reconciling bodies a person edited, CI of the draft PR before the final review in an earlier version, reviews, creating review child tasks of PRs, replies to the intake source, questions, error analysis, export, PR labels, the after-merge watch, requests for security-fix tasks, audits of completed tasks, and so on).
- The recorded shape (`ActivityEvent`) adds the following to the shape for writing.
  - `seq` (increasing monotonically across the whole activity log)
  - `id` (UUID)
  - `taskId`, `projectId`
  - `at` (events in the same append share the same time)
  - `actor`
- `actor` is one of `person`, `sacty`, `orchestrator`, `gatherer` (information gathering at the start of a task; [Tasks and steps](tasks-and-steps.en.md#information-gathering)), `guardian` (the final review and the AI verdicts of earlier versions), `agent`, or `auditor` (audits of completed tasks; [Audit](audit.en.md)).
- Most events that used AI carry the following.
  - Token counts (`usage`: `input`, `cacheRead`, `cacheWrite`, `output`)
  - Cost (`costUsd`), whether it is estimated (`estimated`), and whether the usage of the whole run could not be read (`costUnknown`; only on events that can record a failure)
  - The AI settings used (`authMode`, `model`, `reasoningEffort`)
  - The run ID (`runId`)
- Events have no version number. Older activity logs are read through schema defaults (`.default`), optional fields (`.optional`), and conversions (`.transform`).
- Text shown to users is held as `DaemonText` (a string, or a message code with arguments `{ code, params }`). The web UI and notifications render it in their language (`ja` or `en`). For an unknown code or mismatched arguments, they show the code string as is (no exception is thrown).

Code: `packages/core/src/events.ts` (`EventInput`, `ActivityEvent`, `Actor`, `TokenUsage`), `packages/core/src/message-code.ts` (`DaemonText`, `message`), `packages/core/src/messages.ts` (`renderMessage`, `DAEMON_MESSAGES`)

## Storage

- The activity log is kept in the `activity` table in `SACTY_HOME/sacty.db` (SQLite, `node:sqlite`, WAL). The columns are `seq` (auto-increment primary key), `id`, `task_id`, `project_id`, `at`, `actor`, `type`, and `payload` (JSON).
- Triggers (`activity_no_update`, `activity_no_delete`) reject updates and deletes (append-only).
- Appends are written between `BEGIN IMMEDIATE` and `COMMIT`, validating each event with `EventInput`. If anything fails, the whole append is rolled back.
- Reads also validate each event with `EventInput`.
- If a `ledger` table (the former name) exists and `activity` does not, it is renamed and carried over.
- The store's interface is only appending and reading (`append`, `all`, `forTask`, `close`).

Code: `apps/daemon/src/activity.ts` (`SqliteActivityStore`, `SCHEMA`, `RENAME_LEGACY`, `ActivityStore`)

## Projection

- At startup, the daemon reads all events with `project`, builds a `Task` per task ID, and holds them in memory.
  - If `seq` is not greater than the previous one, it throws an exception.
  - The same pass folds the events into the dashboard aggregates (`DashboardStats`) ([Dashboard aggregates](architecture.en.md#dashboard-aggregates)).
- Writing an event proceeds in this order.
  1. `applyEvent` checks that the event can be applied to the current state (if not, the error is `task.invalidState`).
  2. The event is written to the activity log.
  3. The event is applied to the in-memory state.
- Events that cannot be applied (duplicate creation, unknown tasks, events for cancelled tasks, mismatched state or run IDs, and so on) make the projection throw. Even for a cancelled task, however, the session-saving records `AgentSessionArchived` and `OrchestratorSessionUsed`, and `AuditMemoryDeleted` (deleting a memory the audit registered), are accepted.
- Some events are records only and do not change state (`AiRequestsRetried`, `SubagentNoticeImitated`, `RunCostRecorded`, `ReviewGitHubRetried`, `PushRetried`, `PushRetryEnded`, `AgentFellBack`, `ServicesStarted`, `AgentSessionArchived`, `AgentRunTimedOut`, `AgentRunContinued`, `WorkspaceFilesSkipped`, `PullRequestBodyResolved`; those with a cost are added to the budget as below).
- The sorting of suggestions before reworking (PBI-436; [Sorting suggestions before reworking](approval.en.md#sorting-suggestions-before-reworking)) is recorded as follows.
  - `StepSuggestionsHeld` (actor `sacty`): the step `step`, PR number `number`, head `commit`, review round `round`, and consecutive suggestion-only count `suggestionRounds` when rework on a requirements or design PR is held.
  - `SuggestionsTriaged` (actor `agent`): `items[]` (per suggestion, `id`, the position of the imported comment `remark`, the suggestion text `text`, the decision `decision` (`address` or `decline`), the reason `reason`, the mark `defaulted` for one set to be handled because there was no decision, and the URL of the original comment `url`), `dropped[]` (the positions of the comments removed from the request for changes because all their suggestions were declined), `round` and `suggestionRounds` (the review round and the number of rounds with suggestions only in a row, used for the decision), `stop` (the suggestions of the round judged again were all declined too, so after the replies the draft is removed without pausing; earlier versions paused), and the run record (`agentId`, `runResult`, `usage`, `costUsd`, and so on).
  - Records for stopping on findings a rework cannot resolve (PBI-452): the `needs_decision` reason and `commit` (the head of the stopped PR) of `TaskPaused`, `items[].by` (`person`, `unverified`) of `PullRequestReviewImported`, `decision` of `ReworkStoppedByMerge`, and `rework.findings[].needsDecision` in the verdict block (`reviewVerdicts[].rework` of the child task). The projection keeps `Task.decisionPauses` (per pause: the head, the findings and grounds, the person's decision text) and `pendingReview.unverified`. An earlier version drops the added fields without reading them, but it cannot read a `TaskPaused` with reason `needs_decision` (once one is recorded, the version cannot be rolled back). `securityScope.violation` of `FinalReviewSkipped` has no `lines` and writes a fixed 300 in `max` (earlier versions can read it).
  - Records that stop a requirements or design rework on a merge (PBI-462): the `step` field of `ReworkStoppedByMerge`. An earlier version drops `step` without reading it, projects the record as an implementation rework, and fails with an integrity error, so it cannot start (once one is recorded, the version cannot be rolled back). The projection keeps `Task.stepSubmitted`, `reworkOf`, `sentBackFrom` and `stepBranchCommits`, which are rebuilt from existing records and add no stored shape.
  - The projection keeps in `pendingReview.triage` that the sorting is done (a restart does not run it again), removes the `dropped` comments from `pendingReview`, and adds them to `Task.remarks` (`triaged: true`, `status: declined`, `round: 0`, `origin`; they are not counted in the rework round, the rework instructions, or the rewrite of responses at submission). A comment where only some suggestions are declined stays in `pendingReview`, and `pendingReview.triage.declined` holds the text and reason of the declined suggestions (carried over to `remarks[].declinedParts` of the request for changes). Declined suggestions are piled up in `Task.declinedSuggestions` (text, reason, URL, round) and never removed. `stop` is kept in `Task.triageStop` and cleared when the draft is removed (`PullRequestMarkedReady`); a pause does not clear it, so a task an earlier version paused also has its draft removed for the same head when resumed.
  - Retries of a PR push (PBI-467): `PushRetried` (`branch`, `commit`, `attempt`, `maxAttempts`, `waitMs`, and `message` (the failure text, secrets hidden)) and `PushRetryEnded` (`branch`, `commit`, `outcome` (`pushed` or `failed`), and `retries`). Both are records only and do not change state. A previous version cannot read these two types (its `EventInput` check rejects them) and cannot start (once recorded, you cannot go back to a previous version).
    - You can go back to a previous version only before either one is recorded. Before going back, check that the `activity` table has no row whose `type` is `PushRetried` or `PushRetryEnded`.
    - If the previous version cannot start after going back, move forward again to the version with this change.
  - Records of draft switches (PBI-468): `PullRequestUndraftNoted` (`number`, `eventId`: the GitHub event ID of the switch sacty made to remove the draft; `eventId` is absent when the ID of this removal could not be decided from the answer to the request) and `PullRequestRedraftSkipped` (`number`, `reason` (`person`, `unreadable`, `undetermined`), and `eventId` (`person` only: the ID of the person's removal)). `PullRequestMarkedReady` and `PullRequestRetargeted` with `ready` carry `undraftTracked` when written by the version that remembers its removals (a record without it was removed by an earlier version). State is kept only in `Task.draftTrail` (per PR number). The decision and the rules against duplicate records are in [The flow without the final review](tasks-and-steps.en.md#the-flow-without-the-final-review).
    - An earlier version cannot read these two types through the `EventInput` check and cannot start (`toEvent` in `activity.ts`). You can go back to an earlier version only before either one is recorded. There is no compatibility layer. A defect is fixed by releasing a fixed version, not by rolling back ([ADR](../adr/20261121-2022-do-not-redraft-pull-request-a-person-marked-ready.md)).
  - One whose `runResult` is `interrupted` (the decision was not adopted) only counts its cost and does not change the state.
  - `reason: triaged` of `ReviewRejudgeRequested`: the sorting left no comment to send back, so sacty asked for a judgment again without running the implementation. It is recorded for the implementation PR waiting for approval, in the same append as `SuggestionsTriaged` (`Task.reviewRejudge.reason`). One without `reason` records a submission of the implementation (PBI-357).
- The process record of a PR review (PBI-460; [PR review only task](tasks-and-steps.en.md#pr-review-only-tasks)) is kept as follows. It keeps the process details that are not posted to the PR, and is read on the task screen and through `get_task` of the MCP server.
  - `AgentRunCompleted` has, next to `reviewDispatch` (the number of per-viewpoint reviewers), the optional field `reviewRecord` (`ReviewRecord` or `null`). Only the field was added; no event kind or enumeration was added. A run that did not return the record block, and activity logs from before this, have no such field.
  - Only the first block of the answer whose info string contains `sacty-review-record` is read (`readReviewRecordBlock`). When that block is not closed, cannot be read as JSON, fails the shape check, exceeds a limit, or the masking of secret values fails, the record is `null`. Even with `null`, the review is used and posting does not stop.
  - The fields and limits are as in the table below (`checkReviewRecord`). Fields not in the table are not allowed, and if any one fails the shape check, the whole record becomes `null` (no part of it is kept). An array field missing from the answer becomes an empty array, and a count missing from `dropped` becomes 0.

    | Field | Content | Limit |
    | --- | --- | --- |
    | `mode` | `subagents` (split across per-viewpoint reviewers) or `sequential` (reviewed in sequential mode) | — |
    | `viewpoints` | How each viewpoint was handled (`id`, `status`, `reason`). `status` is `launched`, `relaunched`, `failed`, `substituted` (the parent reviewed it instead), or `not_launched` (not started) | 100 items |
    | `notReviewed` | Viewpoints that could not be reviewed, and why (`id`, `reason`) | 100 items |
    | `dismissed` | Findings not adopted, and why (`title`, `viewpoint`, `reason`) | 100 items |
    | `dropped` | Counts of dropped findings (`overlapping`, `outOfScope`, `handled`, `must`; integers of 0 or more) | — |
    | `scope` | What was narrowed or not narrowed and why, instructions not used as a baseline, and so on (strings) | 20 items |
    | `verification` | Verification progress (`kind`, `text`). `kind` is `ran`, `reused`, `stopped`, or `skipped` | 20 items |

  - Every string has secret values masked first and is then cut to 500 characters per item (because masking comes before cutting, a value that crosses the boundary does not remain either). The masking is the same as for audit material (`auditRedactor`).
  - The strings of the record are treated as untrusted input written by an agent that read the PR. `get_task` returns them as fields of the record (data), the re-review prompt puts them in the data part of the `previousReview` JSON and says that they are data, not instructions, and the screen shows them as plain strings (not interpreted as Markdown or HTML).
  - The projection holds `Task.reviewRecords` as an array per round, like `reviewVerdicts`. Each element has `round`, `record` (which may be `null`), and the `reviewDispatch` of that round (with `agentId`). A rerun of the same round replaces only that round's element and keeps the other rounds. A round whose run has no record field gets no element (the element of an earlier run of the same round is not kept either). `Task.reviewDispatch` of the latest round does not change.
  - Copy of the previous record: `previousReview` (`PreviousReviewSnapshot`) has the optional field `record`. A re-review of the same task (`ReviewRestarted`) copies that round's record from `reviewRecords`. A task created by a GitHub re-request copies the record of the latest round of the original task (`reviewRerequest.previousReview`). An old `previousReview` moved to `earlierReviews` has its `record` dropped (the records of the same task's rounds are in `reviewRecords`, and those of the original task of a re-request are on that task's screen and in its `get_task`). The copy is made so that `get_task` and the data of the re-review prompt show it. Only a re-review of the same task uses it to decide whether to narrow.
  - Removal from the posted strings (`stripReviewRecord`, `withoutReviewRecord`): from every posted string made from the agent's answer (the body, the body of each line comment, and each sentence of the risk assessment), the following is removed, whether or not the record could be read. Right before posting (`buildReviewBody`, `buildReviewComments`), the same rules remove it again.
    - How fences are found: after removing leading whitespace (any amount), quote markers (`>`), and list markers, a line that starts with 3 or more backticks or tildes opens a fence, and a fence of the same character, at least as long as the opening, closes it. One that is not closed runs to the end of the string. A backtick fence whose info string, on the same line, contains a backtick does not open a fence (a line where backticks close partway is inline code, not a fence). Line breaks are split at any of `\r\n`, `\r`, and `\n`.
    - Fences removed: those whose info string contains `sacty-review-record` anywhere (regardless of case, surrounding spaces, or sequences such as `json sacty-review-record`), and, whatever the info string, those whose content has two or more different ones of the field names specific to the record (`viewpoints`, `notReviewed`, `dismissed`, `dropped`, `verification`) as keys (whether or not it reads as JSON; a fence with only one such key, such as a configuration example, is kept). Fences that are not closed, and the second and later ones, are removed too. When another fence is nested inside a fence with the heading, the whole outer fence is removed, whether or not its content has any field names.
    - A key matches regardless of case, of quotes around the field name (double, single, or none), and of spaces before `:`. A word with a letter, digit, or `_` right before or after it (such as `myverification:`) does not match. `mode` and `scope` are common setting words, so they are not used for this.
    - Outside fences: from a line that starts with `{` or `[` after removing leading whitespace, quote markers, and list markers, to the line where the brackets balance (or to the end of the string if they never balance), is one range, and if two or more different keys match in it, the whole range is removed. Prose lines outside such a range are not removed even if a key matches.
    - A line in which the string `sacty-review-record` (in any case) remains after the removal is removed too.
    - The string after removal is checked again by the same rules, and this repeats until nothing more is removed (up to 20 times).
    - A line comment that becomes empty is discarded. When any sentence of the risk assessment becomes empty, the assessment of that round is not used.
- The records of stopping an unposted review (PBI-465; [Stopping a review before posting when the head changes](tasks-and-steps.en.md#stopping-a-review-before-posting-when-the-head-changes)) are as follows.
  - `ReviewRunStopped` (actor `sacty`): `reason` (`head_changed`: the PR head changed; `merged` or `closed`: the PR was merged or closed), `from` (the head being reviewed), `to` (the new head; only for `head_changed`), `runIds` (the stopped runs), and cost (`costUsd`, `estimated`, `usage`, `costUnknown`). It carries cost only for runs without `AgentRunCompleted` (a stop right before posting carries none, since that cost is already counted).
  - It can be recorded only for a review task that has not posted, while running, resolving the target, or waiting to post. While paused, complete, or waiting to start again, the projection raises `ActivityIntegrityError`.
  - The projection puts the task back to `queued` and clears the current run ID. For `head_changed`, it removes `reviewTarget`, `reviewResolvedAt`, `outputs.review`, `reviewComments`, and the current round's element from every per-round record (`reviewVerdicts`, `reviewRecords`, `reviewDispatch`), and holds `Task.reviewStop` (`from`, `to`, `at`, and the `repo` and `number` of the removed target). The next `ReviewTargetResolved` clears `reviewStop`. `reviewRound`, `previousReview`, and `earlierReviews` do not change. `merged` and `closed` are cancelled by the `TaskCancelled` that follows.
  - The projected `previousReview` and `earlierReviews` (`PreviousReviewSnapshot`) copy that round's `reviewPost.latestCommit` into `latestCommit` (to decide the rounds that did not reach the parent; the stored shape does not grow).
  - An earlier version of the daemon cannot read an activity log with `ReviewRunStopped` through `EventInput`, and not just that task: the daemon cannot start. A rollback is possible only until the first `ReviewRunStopped` is recorded.
- When an event that carries cost (the 20 kinds in [Cost](#cost)) is applied, its `costUsd` is added to the task's `budget.usedUsd` (rounded to 6 decimal places). If even one is `estimated`, `budget.estimated` is set.
- Main fields of `Task`
  - `status`
  - `steps` (`todo`, `active`, `done`, or `skip` per step)
  - Step outputs and approved results, the pending approval (`gate`)
  - Remarks (`remarks`), change proposals (`proposals`), budget (`budget`)
  - The ID of the run in progress
  - Results of verification, tests, and the integration review (and of the final review in an earlier version)
  - The PR and task branch, split parent and children
  - The pause reason, questions, export, the Orchestrator session
  - The after-merge watch (`deployment`) and the origin of a fix task (`fix`)

The values of `status` are as follows.

| Value | Meaning |
| --- | --- |
| `blocked` | A child task of a split, waiting for child tasks that must finish first (`dependsOn`) |
| `waiting_children` | The parent task of a split, waiting for its child tasks |
| `queued` | Waiting to run (a worker picks it up) |
| `running` | Running |
| `idle` | Not running (waiting for a judgment, a PR check, and so on) |
| `paused` | Paused (the reason is `pausedReason`) |
| `awaiting_approval` | Waiting for human approval |
| `escalated` | Escalated (waiting for a human decision) |
| `cancelled` | Cancelled |

Code: `packages/core/src/projection.ts` (`project`, `applyEvent`, `Task`, `TaskStatus`), `packages/core/src/cost.ts` (`chargeBudget`), `apps/daemon/src/service.ts` (`TaskService.append`, `reviewRecordOf`), `packages/core/src/events.ts` (`ReviewRecord`, `REVIEW_RECORD_LIST_MAX`, `REVIEW_RECORD_SHORT_LIST_MAX`, `REVIEW_RECORD_TEXT_MAX`), `apps/daemon/src/review-record.ts` (`readReviewRecordBlock`, `checkReviewRecord`, `stripReviewRecord`, `withoutReviewRecord`)

## Cost

- The unit price (`PricePerMTok`) is in US dollars per million tokens: `input`, `cachedInput`, `cacheWrite` (default 0), and `output`.
- Cost = (`input` × the `input` price + `cacheRead` × the `cachedInput` price + `cacheWrite` × the `cacheWrite` price + `output` × the `output` price) ÷ 10^6 (the numerator is rounded to an integer before dividing).
- Subscription and stub runs are treated as an estimated cost (`estimated`) converted at the same unit prices, and are used for budget checks.
- A run's cost is the amount the CLI reported (`total_cost_usd` for Claude Code) if there is one. Otherwise it is each model's usage converted with that model's price (a model with no configured price uses the step agent's price) ([Agent execution](agent-execution.en.md#output-handling)).
  For a run that used the CLI's report and a run converted per model, which one was used is recorded in `RunCostRecorded` (`reported` or `converted`, with the amount converted at the configured prices). Only the `costUsd` of the run's result event is added to the budget.
- The events that carry cost counted toward the task budget are the following 20 kinds (`CHARGED_EVENT_TYPES`). These are all the events that carry `costUsd`. The integration review's `IntegrationReviewed` carries no cost; its cost is recorded in the following `AgentRunCompleted`.

  | Event | Row in the per-step cost table |
  | --- | --- |
  | `InformationGathered` (and `OrchestratorFailed` whose actor is `gatherer`) | Information gathering (`gather`) |
  | `TicketTriaged` | Ticket reading (`triage`; when done by information gathering it carries no cost and gets no row) |
  | `RepositoryChosen` | Repository selection (`repository`) |
  | `StepsChosen`, `StepsSkipped`, `OrchestratorFailed` (except those whose actor is `gatherer`) | Orchestrator (`orchestrator`) |
  | `PullRequestBodyResolved` (PBI-334) | Orchestrator (`orchestrator`; a run that reconciled a person's edits to the PR body. One that ran no agent (no `agentId`) gets no row; [Updating a body a person edited](approval.en.md#updating-a-body-a-person-edited)) |
  | `PullRequestRiskAssessed` (PBI-362) | Orchestrator (`orchestrator`; the run of the risk assessment before a PR is opened, made before the version upgrade; after PBI-429 it is recorded only for the assessment read from the review step's answer (no run, so no row) and for the assessment-only run when the suggestions of a re-judged round are all declined (`via: suggestions_declined`; PBI-440). One that ran no agent (no `agentId`: not assessed because of the budget cap, read from the review step's answer, or carried over from the previous assessment (`inheritedFrom`; PBI-421)) gets no row; [PR risk assessment](risk-assessment.en.md)) |
  | `AgentRunCompleted`, `AgentRunFailed` | That step |
  | `ReviewRunStopped` (PBI-465) | Review (`review`; the part of a stopped run without `AgentRunCompleted`. A stop right before posting carries no cost) |
  | `OutputExported` | Export (`export`) |
  | `QuestionAnswered` | Answers to questions (`chat`) |
  | `ErrorAnalyzed` | Error analysis (`errorAnalysis`; [Error report](error-report.en.md)) |
  | `DeploymentChecked` | The after-merge watch step (`deployment`; [After-merge watch](deployment-watch.en.md)) |
  | `ReworkJudged` (actor `agent`; PBI-332) | Deciding the step to redo (`rework`). One with actor `sacty` (it has `reviewTaskId` and was decided from the answer of the PR review child task) is not a run and gets no row |
  | `SuggestionsTriaged` (PBI-436) | Sorting the suggestions (`suggestions`; the run that sorted the AI review suggestions before reworking. A run that was not adopted (`runResult: interrupted`) is also counted and shown in the row; [Sorting suggestions before reworking](approval.en.md#sorting-suggestions-before-reworking)) |
  | `ChangeJudged`, `ReworkJudged` (actor `guardian`; older versions), `FinalReviewed`, `FinalReviewFailed` | AI verdict in an earlier version (`guardian`; the final review also goes in this row) |

- For a run stopped (for example by a timeout) before the usage of the whole run could be read, sacty adds the part it could read (a lower bound) to `costUsd` and marks the event with `costUnknown` (PBI-281).
  - The mark goes on the events that can record a failed run: `AgentRunFailed`, `ReviewRunStopped`, `OrchestratorFailed`, `StepsSkipped`, `ChangeJudged`, `ReworkJudged`, `SuggestionsTriaged`, `FinalReviewFailed`, `QuestionAnswered`, `ErrorAnalyzed`, `OutputExported`, `DeploymentChecked`, `PullRequestBodyResolved`, and `PullRequestRiskAssessed`.
  - If nothing could be read, `costUsd` stays 0, and this 0 means unknown, not that nothing was spent. How it is read is under output handling in [Agent execution](agent-execution.en.md).
  - For a judgement redone with a fallback agent after a failure, or a run restarted in a new session after a resume was refused, the total is unknown if the earlier run was unknown. So the events that record a success (`AgentRunCompleted`, `StepsChosen`, `TicketTriaged`, `RepositoryChosen`, `InformationGathered`, and `FinalReviewed`) can carry `costUnknown` too.
  - `chargeBudget` counts the marked events in `budget.unknownRuns` (absent when none). The part that could be read counts toward the budget check.
  - The screen and the activity log show "or more" when some part could be read and "unknown" when none could, and never show $0. Success records whose line does not show cost (`StepsChosen`, `InformationGathered`, `TicketTriaged`, and `RepositoryChosen`) show the mark at the end too.
- The projection and the per-step cost table both add cost with the same rule (`chargeBudget`). If a kind not in the list carries `costUsd`, the type check fails and typecheck does not pass.
- The cost of audits of completed tasks (`Audit…` events) is held in `auditCostUsd` and is not counted toward the task budget. It is added to the audit's own budget (`usedUsd` in the task's audit state; [Audit](audit.en.md)).
- The budget state (`budgetState`) is as follows.

  | State | Condition |
  | --- | --- |
  | `exceeded` | The amount used is at or above the limit |
  | `warn` | Not yet notified, and at or above `BUDGET_WARN_RATIO` (0.8) of the limit |
  | `ok` | Otherwise |

Code: `packages/core/src/cost.ts` (`PricePerMTok`, `computeCostUsd`, `budgetState`, `CHARGED_EVENT_TYPES`, `isChargedEvent`, `addUsd`, `chargeBudget`), `packages/core/src/events.ts` (`BUDGET_WARN_RATIO`), `apps/daemon/src/service.ts` (`executeLogged`)

## Session logs (files per run)

- They are kept in `SACTY_HOME/runs/<task ID>/`. Files are 0600 and directories are 0700. Each run has the following files.

  | File | Contents |
  | --- | --- |
  | `<run ID>.jsonl` | The JSONL of the agent's standard output |
  | `<run ID>.stderr.log` | Standard error |
  | `<run ID>.meta.json` | Role, AI, start and end times, result, and whether it was truncated |

- Per run, the first 15MB and the last 3MB of events, and the first 1MB and the last 1MB of standard error, are kept. The middle is omitted, with a marker for the omission (for JSONL, a `{"type":"sacty.truncated", …}` line).
- Secrets are hidden before writing, including values that span chunk boundaries in the received output (the carried-over tail is matched before it is redacted). Values learned later are hidden again across the whole file on close.
- A write failure does not stop the run (a warning is emitted once).
- Snapshot of a running run: the daemon remembers the logs it has opened and not yet closed, and on request returns a snapshot of their current contents (`snapshot`). Answers to questions use it ([Tasks and steps](tasks-and-steps.en.md#asking-the-orchestrator)).
  - A snapshot joins what was written to the file and what is held in memory (the unfinished line of the head, the tail, and what is held back for values spanning chunk boundaries, redacted before use).
  - It hides secrets again with the secrets known at that time (including values learned later), and is cut at the last newline.
  - If the part before the tail was omitted, the same marker as on close is inserted.
  - The files themselves are not changed.
  - There is no snapshot of a closed run or of a run opened by another daemon.
- Copies of the session files from the agent's config location are placed in `runs/<task ID>/<run ID>/agent/` ([Agent execution](agent-execution.en.md)).
- They are not deleted when the task is cancelled.
- The web UI reads them through `GET /api/tasks/:id/runs/:runId/log` and similar, and parses Claude Code (stream-json) and Codex (`exec --json`) output separately for display.

Code: `apps/daemon/src/session-logs.ts` (`SessionLogStore`, `SessionLog.snapshot`, `SESSION_LOG_LIMITS`, `TRUNCATED_EVENT`, `StreamRedactor`), `apps/web/src/lib/session-log.ts` (`parseSessionLog`)

## Web UI display

- Task details read `{ task, activity }` from `GET /api/tasks/:id` and list the activity log newest first, with text for each event kind.
- The per-step cost table aggregates events that carry cost by row (the table in [Cost](#cost)). The rows are in the following order.
  1. Information gathering, ticket reading, repository selection, and the Orchestrator (only when recorded)
  2. The steps, in the task's step order
     - Steps that have not run are shown with 0 runs.
     - Records for steps not in the step list are also shown.
     - The deployment check goes in the row of the after-merge watch step. It is shown while running too.
  3. Export, answers to questions, error analysis, deciding the step to redo, sorting the suggestions, and the AI verdict in an earlier version (only when recorded)
- Ticket reading and repository selection decided by a person, and `StepsChosen` from the era of fixed steps (no agent, cost, or usage), are not counted as runs.
- The table's total cost and whether it is estimated are summed with `chargeBudget` in activity log order. So they match the task's cost (`budget.usedUsd`, `budget.estimated`).
- The result in the per-run breakdown is one of Completed, Failed, Interrupted, Running, and Not used. A stopped review run (`runIds` of `ReviewRunStopped`) is shown as Interrupted, with the cost of that record. "Not used" is a run where the agent finished but sacty did not use the result (a PR review that started no per-viewpoint reviewer; an `AgentRunFailed` with `reviewDispatch`; [PR-review-only tasks](tasks-and-steps.en.md#pr-review-only-tasks)). Its cost is counted like any other run.
- A run with `costUnknown` shows "or more" when some part could be read and "unknown" when none could, in the per-run breakdown, the step rows, and the total. Below the table, a note gives the number of unknown runs (`unknownRuns`; the total is the same as `budget.unknownRuns`). The "Cost" in the right column of the task detail shows the number too.
- The table's cells carry no mark for whether a cost is estimated (a converted estimate), to keep the table readable. The hint on the table's heading explains that converted values are not actual charges.

Code: `apps/web/src/lib/labels.ts` (`describeEvent`), `apps/web/src/lib/step-costs.ts` (`stepCosts`), `apps/web/src/components/step-costs.tsx` (`StepCosts`)

## Formatting check records

The `formattingBaseline` on `AgentRunStarted` holds the baseline tree and the trees before and after intervening merges. The `formatting` on `AgentRunCompleted` holds declared paths, and `FormattingOnlyRejected` holds only the count. The `formatting` on `FinalReviewSkipped` holds the remaining count and declarations; the projection replaces it with the latest submission's value.

An earlier version discards fields added to existing records but cannot read the new event type. Before downgrading, check the `activity` table for rows whose `type` is `FormattingOnlyRejected`. If any exist, use a fixed version instead of downgrading.

Code: `packages/core/src/events.ts`, `packages/core/src/projection.ts`
