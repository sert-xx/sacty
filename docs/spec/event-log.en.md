[日本語](event-log.md) | **English**

# Activity log (events and projection)

Everything that happens to a task is recorded in the activity log (an append-only sequence of events). Task state is not stored; at startup it is rebuilt by reading the activity log
from the beginning (projection). The agent output of each run (the session log) is large, so it is kept in files, not in the activity log.

Related ADRs: none

## Event shape

- The shape for writing is `{ type, payload }`. It is validated with a zod discriminated union keyed on `type` (`EventInput`). There are 83 kinds (task creation and split,
  step progress, agent runs, budget, pause, resume, and cancel, change proposals and their judgments, verification, git and PRs, reviews, replies to the intake source,
  questions, export, PR labels, the after-merge watch, audits of completed tasks, and so on).
- The recorded shape (`ActivityEvent`) adds `seq` (increasing monotonically across the whole activity log), `id` (UUID), `taskId`, `projectId`, `at`
  (events in the same append share the same time), and `actor`.
- `actor` is one of `person`, `sacty`, `orchestrator`, `guardian`, `agent`, or `auditor` (audits of completed tasks; [Audit](audit.en.md)).
- Most events that used AI carry token counts (`usage`: `input`, `cacheRead`, `cacheWrite`, `output`), cost (`costUsd`), whether it is estimated
  (`estimated`), the AI settings used (`authMode`, `model`, `reasoningEffort`), and the run ID (`runId`).
- Events have no version number. Older activity logs are read through schema defaults (`.default`), optional fields (`.optional`), and conversions (`.transform`).
- Text shown to users is held as `DaemonText` (a string, or a message code with arguments `{ code, params }`). The web UI and notifications render it in their language (`ja` or `en`).
  For an unknown code or mismatched arguments, the code string is shown as is (no exception is thrown).

Code: `packages/core/src/events.ts` (`EventInput`, `ActivityEvent`, `Actor`, `TokenUsage`), `packages/core/src/message-code.ts` (`DaemonText`, `message`), `packages/core/src/messages.ts` (`renderMessage`, `DAEMON_MESSAGES`)

## Storage

- The `activity` table in `SACTY_HOME/sacty.db` (SQLite, `node:sqlite`, WAL). The columns are `seq` (auto-increment primary key), `id`, `task_id`, `project_id`,
  `at`, `actor`, `type`, and `payload` (JSON).
- Updates and deletes are rejected by triggers (`activity_no_update`, `activity_no_delete`) (append-only).
- Appends are written between `BEGIN IMMEDIATE` and `COMMIT`, validating each event with `EventInput`. If anything fails, the whole append is rolled back.
- Reads also validate each event with `EventInput`.
- If a `ledger` table (the former name) exists and `activity` does not, it is renamed and carried over.
- The store's interface is only appending and reading (`append`, `all`, `forTask`, `close`).

Code: `apps/daemon/src/activity.ts` (`SqliteActivityStore`, `SCHEMA`, `RENAME_LEGACY`, `ActivityStore`)

## Projection

- At startup, all events are read with `project`, and a `Task` per task ID is built and held in memory. If `seq` is not greater than the previous one,
  an exception is thrown. The same pass folds the events into the dashboard aggregates (`DashboardStats`) ([Dashboard aggregates](architecture.en.md#dashboard-aggregates)).
- When writing an event, `applyEvent` first checks that it can be applied to the current state (if not, the error is `task.invalidState`); the event is written to the activity log
  and then applied to the in-memory state.
- Events that cannot be applied (duplicate creation, unknown tasks, events for cancelled tasks, mismatched state or run IDs, and so on) make the projection throw
  (even for a cancelled task, the session-saving records `AgentSessionArchived` and `OrchestratorSessionUsed` are accepted).
- Some events are records only and do not change state (`AiRequestsRetried`, `AgentFellBack`, `ServicesStarted`, `AgentSessionArchived`).
- When an event that carries cost (the 13 kinds in [Cost](#cost)) is applied, its `costUsd` is added to the task's `budget.usedUsd`
  (rounded to 6 decimal places). If even one is `estimated`, `budget.estimated` is set.
- Main fields of `Task`: `status`, `steps` (`todo`, `active`, `done`, or `skip` per step), step outputs and approved results, the pending approval (`gate`),
  remarks (`remarks`), change proposals (`proposals`), budget (`budget`), the ID of the run in progress, results of verification, tests, the final review, and the integration review,
  the PR and task branch, split parent and children, the pause reason, questions, export, the Orchestrator session, the after-merge watch (`deployment`), and
  the origin of a fix task (`fix`).

Values of `status`:

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

Code: `packages/core/src/projection.ts` (`project`, `applyEvent`, `Task`, `TaskStatus`), `packages/core/src/cost.ts` (`chargeBudget`), `apps/daemon/src/service.ts` (`TaskService.append`)

## Cost

- The unit price (`PricePerMTok`) is in US dollars per million tokens: `input`, `cachedInput`, `cacheWrite` (default 0), and `output`.
- Cost = (`input` × the `input` price + `cacheRead` × the `cachedInput` price + `cacheWrite` × the `cacheWrite` price + `output` × the `output` price) ÷ 10^6
  (the numerator is rounded to an integer before dividing).
- Subscription and stub runs are treated as an estimated cost (`estimated`) converted at the same unit prices, and are used for budget checks.
- The events that carry cost counted toward the task budget are the following 13 kinds (`CHARGED_EVENT_TYPES`). These are all the events that carry `costUsd`
  (the integration review's `IntegrationReviewed` carries no cost; it is recorded in the following `AgentRunCompleted`).

  | Event | Row in the per-step cost table |
  | --- | --- |
  | `TicketTriaged` | Ticket reading (`triage`) |
  | `RepositoryChosen` | Repository selection (`repository`) |
  | `StepsChosen`, `OrchestratorFailed` | Orchestrator (`orchestrator`) |
  | `AgentRunCompleted`, `AgentRunFailed` | That step |
  | `OutputExported` | Export (`export`) |
  | `QuestionAnswered` | Answers to questions (`chat`) |
  | `DeploymentChecked` | The after-merge watch step (`deployment`; [After-merge watch](deployment-watch.en.md)) |
  | `ChangeJudged`, `ReworkJudged`, `FinalReviewed`, `FinalReviewFailed` | Goal Guardian (`guardian`) |

- The projection and the per-step cost table both add cost with the same rule (`chargeBudget`). If a kind not in the list carries `costUsd`, the type check
  fails and typecheck does not pass.
- The cost of audits of completed tasks (`Audit…` events) is held in `auditCostUsd` and is not counted toward the task budget. It is added to the audit's own
  budget (`usedUsd` in the task's audit state; [Audit](audit.en.md)).
- Budget state (`budgetState`): `exceeded` if the amount used is at or above the limit; `warn` if not yet notified and at or above `BUDGET_WARN_RATIO` (0.8) of the limit;
  otherwise `ok`.

Code: `packages/core/src/cost.ts` (`PricePerMTok`, `computeCostUsd`, `budgetState`, `CHARGED_EVENT_TYPES`, `isChargedEvent`, `addUsd`, `chargeBudget`), `packages/core/src/events.ts` (`BUDGET_WARN_RATIO`), `apps/daemon/src/service.ts` (`executeLogged`)

## Session logs (files per run)

- They are kept in `SACTY_HOME/runs/<task ID>/`. Per run: `<run ID>.jsonl` (the JSONL of the agent's standard output), `<run ID>.stderr.log`
  (standard error), and `<run ID>.meta.json` (role, AI, start and end times, result, and whether it was truncated). Files are 0600 and directories are 0700.
- Per run, the first 15MB and the last 3MB of events, and the first 1MB and the last 1MB of standard error, are kept, with a marker for the omitted middle (for JSONL, a
  `{"type":"sacty.truncated", …}` line).
- Secrets are hidden before writing (including values that span chunk boundaries in the received output; values learned later are hidden again across the whole file on close).
- A write failure does not stop the run (a warning is emitted once).
- Snapshot of a running run: the daemon remembers the logs it has opened and not yet closed, and on request returns a snapshot of their current contents (`snapshot`)
  (used for answers to questions; [Tasks and steps](tasks-and-steps.en.md#asking-the-orchestrator)). A snapshot joins what was written to the file and what is held in memory
  (the unfinished line of the head, the tail, and what is held back for redaction), hides secrets again with the secrets known at that time (including values learned later), and is cut at the last newline.
  If the part before the tail was omitted, the same marker as on close is inserted. The files themselves are not changed. There is no snapshot of a closed run or of a run opened by another daemon.
- Copies of the session files from the agent's config location are placed in `runs/<task ID>/<run ID>/agent/` ([Agent execution](agent-execution.en.md)).
- They are not deleted when the task is cancelled.
- The web UI reads them through `GET /api/tasks/:id/runs/:runId/log` and similar, and parses Claude Code (stream-json) and Codex (`exec --json`) output separately for display.

Code: `apps/daemon/src/session-logs.ts` (`SessionLogStore`, `SessionLog.snapshot`, `SESSION_LOG_LIMITS`, `TRUNCATED_EVENT`, `StreamRedactor`), `apps/web/src/lib/session-log.ts` (`parseSessionLog`)

## Web UI display

- Task details read `{ task, activity }` from `GET /api/tasks/:id` and list the activity log newest first, with text for each event kind.
- The per-step cost table aggregates events that carry cost by row (the table in [Cost](#cost)). The rows are ordered: ticket reading,
  repository selection, and the Orchestrator (only when recorded); the steps in the task's step order (steps that have not run are shown with 0 runs; records for steps
  not in the step list are also shown. The deployment check goes in the row of the after-merge watch step, including while running); then export, answers to questions, and the Goal Guardian (only when recorded).
- Ticket reading and repository selection decided by a person, and `StepsChosen` from the era of fixed steps (no agent, cost, or usage), are
  not counted as runs.
- The table's total cost and whether it is estimated are summed with `chargeBudget` in activity log order, so they
  match the task's cost (`budget.usedUsd`, `budget.estimated`).
- The table's cells carry no mark for whether a cost is estimated (a converted estimate), to keep the table readable. The hint on the
  table's heading explains that converted values are not actual charges.

Code: `apps/web/src/lib/labels.ts` (`describeEvent`), `apps/web/src/lib/step-costs.ts` (`stepCosts`), `apps/web/src/components/step-costs.tsx` (`StepCosts`)
