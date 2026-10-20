[日本語](audit.md) | **English**

# Audit of completed tasks

An AI agent examines the whole process of a completed task, from the step choices to completion. It finds the causes of
changes requested, remarks, and trial and error, and proposes fixes that prevent them. A person adopts or rejects each
proposal, and an adopted proposal becomes a fix task. When adopting, they can also supplement the proposed fix or replace it with their own. Audits are recorded in the audited task's activity log.

Related ADRs: [Build the audit screens first, on a mock backend](../adr/20261017-1145-audit-ui-with-mock.md), [Audit completed tasks in two stages, recorded in the activity log](../adr/20261017-1310-audit-engine.md)

## When an audit starts, and what is audited

- `AuditQueued` (the audit ID and budget cap) is added in the same append that completes a task (makes `status` `idle` with every step done or
  skipped), so the audit is not lost if the daemon stops in between. Cancelled tasks are not audited.
- Tasks that completed before this feature (only folded from the activity log at startup) get no `AuditQueued` and are not audited.
- A task waiting for its audit enters the worker's queue (it counts toward the limit on parallel runs). Tasks with nothing but the audit left
  are queued after other runs. Each run advances one agent run.
- The audit states are `waiting`, `surveying` (the survey is running), `deepDiving`, `completed`, `failed`, and `budgetPaused`.

Code: `apps/daemon/src/service.ts` (`auditQueueEvent`, `awaitingAudit`, `runAudit`), `packages/core/src/projection.ts` (`isAuditTarget`, `auditOpen`, `nextAuditDive`)

## Two stages

1. **Survey** (role `audit`): the agent reads the whole ledger of the task (body, approved outputs, evidence counts, human remarks,
   judgments, activity) and each run's session log, and flags up to 3 steps of concern (`AuditSurveyed`).
2. **Deep dive** (role `audit-dive`): for each flagged step, the agent gives causes (up to 3) and fix proposals per cause (up to 2)
   (`AuditDeepDived`). Knowledge that will help later tasks is registered as memories ([Memory](memory.en.md)). After every step is deep-dived,
   `AuditCompleted`. With no steps of concern, the audit finishes without a deep dive.

- Both run in a new session every time, with `audit_agent` in config.yaml (or `guardian_agent`, or `default_agent`).
- Session logs are mounted read-only at `/sacty-logs`, as for answers to questions. The full ledger (one JSON event per line) is mounted read-only
  at `/sacty-ledger/ledger.jsonl` (the instructions hold only the start of each row and omit the middle when long). The workspace gets a
  disposable copy of the code, after the implementation if the task has an implement step, otherwise at the base commit, with an instruction
  not to change it.
- Secrets are redacted before truncation from the materials (ledger, body, approved outputs, remarks, rejection reasons, adoption notes, existing cause
  titles, session logs) and from the audit output. For the output, redaction is applied both to the raw JSON string and to the decoded texts
  (summary, reasons, causes, evidence, proposals, memories), so escaped values are covered too. After decoding, redaction runs before trimming, so values ending in a newline are covered. Session logs are staged as hard links to the original logs, so they are replaced with
  redacted copies before mounting, leaving the originals unchanged. The redaction covers the values of secrets used by the settings and sacty settings (including the audit AI's), the GitHub
  tokens of the project's chosen accounts and of the task's repository, and common secret patterns. The values are never reused: they are fetched
  each time before sending to the audit AI, before recording the result after the audit AI returns (together with the values fetched before
  sending), and before showing. If the settings change while a deep dive waits for its
  turn, the values from both the settings used for the run and the current settings are redacted.
- The instructions include the context versions used (repositories and commits).
- sacty counts the evidence during the survey, and the deep dives reuse the recorded counts (the agent does not count; session logs are read
  asynchronously): human change requests, imported PR remarks, pauses, retries (failed runs, failed
  tests, final reviews, and integration reviews), failed tool calls (session logs), and escalations.
- The instructions say not to follow instructions found in the ledger, logs, or code, and not to write secrets.
- The output is read from ```json blocks headed `sacty-audit-survey` and `sacty-audit-findings`. Only steps the task has, evidence IDs that
  exist in this task's activity rows and runs, and targets chosen by candidate number are kept. If unreadable, `AuditFailed` (`audit.unreadable`).
- If a run fails, `AuditFailed` (`audit.runFailed`). A failed audit goes no further.
- Runs that end because the daemon is stopping or the task is being cancelled are not recorded. On the next start, the same stage runs again.

Code: `apps/daemon/src/audit-prompts.ts` (`buildAuditSurveyPrompt`, `extractAuditSurvey`, `buildAuditDivePrompt`, `extractAuditDive`),
`apps/daemon/src/audit-evidence.ts` (`auditCounts`, `countToolFailures`, `redactDeep`), `apps/daemon/src/service.ts` (`runAuditAgent`, `auditRedactor`, `withAuditDiveLock`)

## Causes and proposals

- Deep dives in the same project run one at a time (reading the existing causes and recording the result do not overlap). A task cancelled
  while waiting for its turn stops waiting (cancelling does not wait for the earlier deep dive). The queue entry stays until the earlier deep
  dive finishes, so deep dives that arrive later still run after it.
- Causes are grouped within a project by a cause key (`causeKey`). The deep dive gets the project's existing causes (key, title, whether a
  fix was adopted), the rejected proposals with their reasons, and the proposals a person edited when adopting. If a cause is the same as an existing one, the agent uses its key
  (`sameAs`). A new cause key is `<audit ID>:<step>:<number>`.
- The target candidates are the task's target repository, the context layers the task used (without the sacty default layer; if there is no
  record, the project's context as depth 0), and the sacty default context. Repositories are normalized to the fix task's form (a GitHub
  repository URL without `.git`), and non-GitHub ones (such as local paths) are not candidates. Each proposal is recorded with its candidates.
- Adopt (`AuditProposalAdopted`): another target can be chosen from the candidates. If the target is the target repository or a context
  repository, a fix task (`start: "audit"`, `auditFix` holding the original task and proposal) is created for that repository. The
  adoption is recorded first; if the daemon stops before the task is created, it is created at the next start. If the target is the sacty
  default context, no task is created in the user's project.
- The note on an adoption (`note` of `AuditProposalAdopted`): to accept the cause but edit the proposed fix, a person attaches a kind
  (`supplement` or `replace`) and a text (1–4000 characters after trimming); without it, the audit's proposal is adopted as it is.
  A `supplement` is added to the fix task's details after the proposal, under "人が足した補足：". A `replace` makes the person's text the
  instruction for the fix and keeps the audit's proposal after it, under "人が改善案を差し替えました。監査が出した改善案：" (the cause's
  detail and the original memory for a context proposal are attached either way). Like a rejection reason, the note has secrets redacted
  before it is recorded (older records get common secret patterns redacted when shown). The deep dive also gets the proposals a person
  edited (title, kind, text), so it does not repeat proposals that need the same edit.
- Reject (`AuditProposalRejected`): needs a reason (1–2000 characters after trimming). The reason also appears on the audit page and in
  reports, so secrets are redacted before it is recorded (older records get common secret patterns redacted when shown). A decided proposal cannot be decided again. Proposals
  of a cancelled task cannot be decided.
- Cause state: `recurred` if a cause with the same key is found after the merge of its fix task's PR (`pullRequestMerge.at`), `fixed` if not,
  `adopted` if a proposal was adopted, `proposed` if a proposal needs a decision, and `rejected` if all were rejected.
- Task titles shown on the audit page and in reports (audited tasks, the audit a proposal came from, a cause's tasks, fix tasks) are
  redacted by the same rule (the tasks themselves are unchanged).
- Nothing is aggregated across projects. The dashboard shows only counts.

Code: `apps/daemon/src/service.ts` (`adoptAuditProposal`, `createAuditFixTask`, `resumeAuditFixTasks`, `rejectAuditProposal`, `knownAuditCauses`),
`apps/daemon/src/audit-targets.ts` (`auditTargetCandidates`), `apps/daemon/src/ledger-audits.ts` (`LedgerAuditService`), `apps/daemon/src/audits.ts` (`causeStatus`, `sortCauses`)

## Audit budget

- The cap per audit is recorded in `AuditQueued`. The default is `budget.default_per_audit_usd` in config.yaml (default 1 US dollar).
- Audit cost is held in `auditCostUsd` and added to `usedUsd` in the audit state. It is not counted toward the task budget.
- After a run, reaching 80% of the cap records `AuditBudgetWarned` (once per cap). If the cap is reached before the next run,
  `AuditBudgetPaused`. If no deep dive remains, the audit becomes `AuditCompleted` even over the cap.
- When a person enters a new cap (cumulative; more than the amount used), `AuditCapRaised` resumes it from the next stage.

Code: `apps/daemon/src/service.ts` (`warnAuditBudget`, `resumeAudit`, `auditBudgetUsd`), `apps/daemon/src/config.ts` (`budgetPerAuditUsd`)

## Mock

- Started with the environment variable `SACTY_AUDIT_MOCK=1`, the daemon does not run audits (`audit: false`) and returns mock data
  (`MockAuditService`) to the screens. Adopting, rejecting, and resuming are kept only in memory, and the data has `mock: true`.
- The mock assigns scenes to the project's completed tasks in the order they completed (audited, deep dive, paused by budget, failed,
  surveying, waiting; from the 9th task on, two kinds of audited alternate).

Code: `apps/daemon/src/audits.ts` (`MockAuditService`, `AuditService`), `apps/daemon/src/main.ts`

## API

| Method and path | Content |
| --- | --- |
| `GET /api/tasks/:id/audit` | The task's audit (`{ audit }`; null if none) |
| `POST /api/tasks/:id/audit/resume` | Resume an audit paused by its budget (`{ capUsd }`) |
| `GET /api/projects/:id/audits` | The project's audits (causes, proposals, audited tasks). 404 if the project does not exist |
| `GET /api/audits/dashboard` | Counts for the dashboard (per project and per week) |
| `POST /api/audits/proposals/:id/adopt` | Adopt a proposal (`{ target, note? }`, where `note` is `{ kind, text }`) |
| `POST /api/audits/proposals/:id/reject` | Reject a proposal (`{ reason }`) |
| `POST /api/audits/memories/:id/delete` | Delete a memory the audit registered ([Memory](memory.en.md)). Returns the audit that registered it (`{ audit }`) |

Invalid input is 400 (message codes). An operation that does not fit the state (already decided, a target not in the candidates, a
cancelled task, not paused, too low a cap) is 409.

Code: `apps/daemon/src/server.ts` (`createApp`)

## Screens

- Task details: completed tasks have an "Audit" card (state, cost, survey, steps of concern, causes and proposals, registered memories, resume form).
  Evidence links to the activity row (`#event-<ID>`) and the run log. Activity rows of audit runs also open their logs.
- Audit page (`/projects/<ID>/audit`; "Audit" in the side menu): causes (recurred first), proposals (those needing a decision first),
  audited tasks, and report export. An adoption for sacty shows that no task was created in the project. For a proposal that needs a
  decision, the adopt form can open an edit to the proposed fix (supplement or replacement). A note attached to an adoption is shown under
  the proposal with its kind (and in reports).
- Dashboard: the "Audit" card shows, per project, causes, recurred, and needing-decision counts and the adoption rate, and, per week,
  the changes requested and PR remarks per task (from the evidence counts of finished audits).
- Report (`/projects/<ID>/audit/report?from=&to=`; a date that does not exist or a start after the end is 400): Markdown with the causes,
  proposals, and decisions of audits finished in the period (UTC dates, through the end of the last day). Headings follow the UI language;
  audit text is not translated. Times are UTC with the year.

Code: `apps/web/src/components/audit.tsx` (`TaskAuditCard`, `ProposalView`), `apps/web/src/components/audit-screen.tsx` (`AuditScreen`),
`apps/web/src/components/dashboard.tsx` (`AuditCard`), `apps/web/src/lib/audit-report.ts` (`auditReport`, `reportPeriod`)
