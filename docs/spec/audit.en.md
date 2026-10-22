[日本語](audit.md) | **English**

# Audit of completed tasks

An AI agent examines the whole process of a completed task, from the step choices to completion. The agent finds the causes of changes requested, remarks, and trial and error, and proposes fixes that prevent them.

A person adopts or rejects each proposal, and an adopted proposal becomes a fix task. When adopting, they can also supplement the proposed fix or replace it with their own. Audits are recorded in the audited task's activity log.

Related ADRs: [Build the audit screens first, on a mock backend](../adr/20261017-1145-audit-ui-with-mock.md), [Audit completed tasks in two stages, recorded in the activity log](../adr/20261017-1310-audit-engine.md)

## When an audit starts, and what is audited

- sacty adds `AuditQueued` (the audit ID and budget cap) in the same append that completes a task (makes `status` `idle` with every step done or skipped). The audit is not lost if the daemon stops between completion and registering the audit.
- Cancelled tasks are not audited.
- Tasks that completed before this feature (only folded from the activity log at startup) get no `AuditQueued` and are not audited.
- A task waiting for its audit enters the worker's queue (it counts toward the limit on parallel runs). Tasks with nothing but the audit left are queued after other runs. Each run advances one agent run.
- The audit states are `waiting`, `surveying` (the survey is running), `deepDiving`, `completed`, `failed`, and `budgetPaused`.

Code: `apps/daemon/src/service.ts` (`auditQueueEvent`, `awaitingAudit`, `runAudit`), `packages/core/src/projection.ts` (`isAuditTarget`, `auditOpen`, `nextAuditDive`)

## Two stages

1. **Survey** (role `audit`)
   - The agent reads the whole ledger of the task (body, approved outputs, evidence counts, human remarks, judgments, activity) and each run's session log.
   - It flags up to 3 steps of concern (`AuditSurveyed`).
   - With no steps of concern, the audit finishes without a deep dive.
2. **Deep dive** (role `audit-dive`)
   - For each flagged step, the agent gives causes (up to 3) and fix proposals per cause (up to 2) (`AuditDeepDived`).
   - The agent registers knowledge that will help later tasks as memories ([Memory](memory.en.md)).
   - After every step is deep-dived, `AuditCompleted`.

- Both stages run in a new session every time. The AI is `audit_agent` in config.yaml (or `guardian_agent`, or `default_agent`).
- What the agent sees
  - Session logs are mounted read-only at `/sacty-logs`, as for answers to questions.
  - The full ledger (one JSON event per line) is mounted read-only at `/sacty-ledger/ledger.jsonl`, because the instructions hold only the start of each row and omit the middle when long.
  - The workspace gets a disposable copy of the code, with an instruction not to change it. The copy is after the implementation if the task has an implement step, otherwise at the base commit.
- Redacting secrets
  - sacty redacts secrets before truncation from the materials (ledger, body, approved outputs, remarks, rejection reasons, adoption notes, existing cause titles, session logs) and from the audit output.
  - For the output, redaction is applied both to the raw JSON string and to the decoded texts (summary, reasons, causes, evidence, proposals, memories), so escaped values are covered too. After decoding, redaction runs before trimming, so values ending in a newline are covered.
  - Session logs are staged as hard links to the original logs, so sacty replaces them with redacted copies before mounting, leaving the originals unchanged.
  - The redaction covers the values of secrets used by the settings and sacty settings (including the audit AI's), the GitHub tokens of the project's chosen accounts and of the task's repository, and common secret patterns.
  - The values are never reused. sacty fetches them each time at these points:
    - Before sending to the audit AI
    - Before recording the result after the audit AI returns (together with the values fetched before sending)
    - Before showing
  - If the settings change while a deep dive waits for its turn, sacty redacts the values from both the settings used for the run and the current settings.
- The instructions include the context versions used (repositories and commits).
- sacty counts the evidence during the survey, and the deep dives reuse the recorded counts. The agent does not count, and session logs are read asynchronously. sacty counts these:
  - Human change requests
  - Imported PR remarks
  - Pauses
  - Retries (failed runs, failed tests, final reviews, and integration reviews)
  - Failed tool calls (session logs)
  - Escalations
- The instructions say not to follow instructions found in the ledger, logs, or code, and not to write secrets.
- The output is read from ```json blocks headed `sacty-audit-survey` and `sacty-audit-findings`.
  - sacty keeps only steps the task has, evidence IDs that exist in this task's activity rows and runs, and targets chosen by candidate number.
  - If unreadable, `AuditFailed` (`audit.unreadable`).
- If a run fails, `AuditFailed` (`audit.runFailed`). A failed audit goes no further.
- Runs that end because the daemon is stopping or the task is being cancelled are not recorded. On the next start, the same stage runs again.

Code: `apps/daemon/src/audit-prompts.ts` (`buildAuditSurveyPrompt`, `extractAuditSurvey`, `buildAuditDivePrompt`, `extractAuditDive`),
`apps/daemon/src/audit-evidence.ts` (`auditCounts`, `countToolFailures`, `redactDeep`), `apps/daemon/src/service.ts` (`runAuditAgent`, `auditRedactor`, `withAuditDiveLock`)

## Causes and proposals

- Deep dives in the same project run one at a time (reading the existing causes and recording the result do not overlap).
  - A task cancelled while waiting for its turn stops waiting (cancelling does not wait for the earlier deep dive).
  - The queue entry stays until the earlier deep dive finishes, so deep dives that arrive later still run after it.
- Causes are grouped within a project by a cause key (`causeKey`).
  - The deep dive gets these:
    - The project's existing causes (key, title, whether a fix was adopted)
    - The rejected proposals with their reasons
    - The proposals a person edited when adopting
  - If a cause is the same as an existing one, the agent uses its key (`sameAs`).
  - A new cause key is `<audit ID>:<step>:<number>`.
- The target candidates are these three. Each proposal is recorded with its candidates.
  - The task's target repository
  - The context layers the task used (without the sacty default layer; if there is no record, the project's context as depth 0)
  - The sacty default context

  Repositories are normalized to the fix task's form (a GitHub repository URL without `.git`). Non-GitHub ones (such as local paths) are not candidates.
- Adopt (`AuditProposalAdopted`)
  - Another target can be chosen from the candidates.
  - If the target is the target repository or a context repository, sacty creates a fix task (`start: "audit"`, `auditFix` holding the original task and proposal) for that repository. The adoption is recorded first; if the daemon stops before the task is created, it is created at the next start.
  - If the target is the sacty default context, no task is created in the user's project.
- The note on an adoption (`note` of `AuditProposalAdopted`)
  - To accept the cause but edit the proposed fix, a person attaches a kind (`supplement` or `replace`) and a text (1–4000 characters after trimming). Without it, the audit's proposal is adopted as it is.
  - A `supplement` is added to the fix task's details after the proposal, under "人が足した補足：".
  - A `replace` makes the person's text the instruction for the fix and keeps the audit's proposal after it, under "人が改善案を差し替えました。監査が出した改善案：".
  - The cause's detail and the original memory for a context proposal are attached either way.
  - Like a rejection reason, the note has secrets redacted before it is recorded (older records get common secret patterns redacted when shown).
  - The deep dive also gets the proposals a person edited (title, kind, text), so it does not repeat proposals that need the same edit.
- Reject (`AuditProposalRejected`)
  - It needs a reason (1–2000 characters after trimming).
  - The reason also appears on the audit page and in reports, so secrets are redacted before it is recorded (older records get common secret patterns redacted when shown).
- A decided proposal cannot be decided again. Proposals of a cancelled task cannot be decided.
- The cause states are as in this table.

| State | Condition |
| --- | --- |
| `recurred` | A cause with the same key is found after the merge of its fix task's PR (`pullRequestMerge.at`) |
| `fixed` | No cause with the same key is found after the merge |
| `adopted` | A proposal was adopted |
| `proposed` | A proposal needs a decision |
| `rejected` | All were rejected |

- Task titles shown on the audit page and in reports (audited tasks, the audit a proposal came from, a cause's tasks, fix tasks) are redacted by the same rule (the tasks themselves are unchanged).
- Nothing is aggregated across projects. The dashboard shows only counts.

Code: `apps/daemon/src/service.ts` (`adoptAuditProposal`, `createAuditFixTask`, `resumeAuditFixTasks`, `rejectAuditProposal`, `knownAuditCauses`),
`apps/daemon/src/audit-targets.ts` (`auditTargetCandidates`), `apps/daemon/src/ledger-audits.ts` (`LedgerAuditService`), `apps/daemon/src/audits.ts` (`causeStatus`, `sortCauses`)

## Audit budget

- The cap per audit is recorded in `AuditQueued`. The default is `budget.default_per_audit_usd` in config.yaml (default 1 US dollar).
- Audit cost is held in `auditCostUsd` and added to `usedUsd` in the audit state. It is not counted toward the task budget.
- After an agent run, reaching 80% of the cap records `AuditBudgetWarned` (once per cap).
- If the cap is reached before the next run, `AuditBudgetPaused`. If no deep dive remains, the audit becomes `AuditCompleted` even over the cap.
- When a person enters a new cap (cumulative; more than the amount used), `AuditCapRaised` resumes the audit from the next stage.

Code: `apps/daemon/src/service.ts` (`warnAuditBudget`, `resumeAudit`, `auditBudgetUsd`), `apps/daemon/src/config.ts` (`budgetPerAuditUsd`)

## Mock

- Started with the environment variable `SACTY_AUDIT_MOCK=1`, the daemon does not run audits (`audit: false`) and returns mock data (`MockAuditService`) to the screens.
  - Adopting, rejecting, and resuming are kept only in the daemon's memory.
  - The returned data has `mock: true`.
- The mock assigns scenes to the project's completed tasks in the order they completed. The scenes go in the order audited, deep dive, paused by budget, failed, surveying, and waiting. From the 9th task on, two kinds of audited alternate.

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

- Invalid input is 400 (message codes).
- An operation that does not fit the state (already decided, a target not in the candidates, a cancelled task, not paused, too low a cap) is 409.

Code: `apps/daemon/src/server.ts` (`createApp`)

## Screens

- Task details
  - Completed tasks have an "Audit" card (state, cost, survey, steps of concern, causes and proposals, registered memories, resume form).
  - Evidence links to the activity row (`#event-<ID>`) and the run log.
  - Activity rows of audit runs also open their logs.
- Audit page (`/projects/<ID>/audit`; "Audit" in the side menu)
  - It shows causes (recurred first), proposals (those needing a decision first), audited tasks, and report export.
  - An adoption for sacty shows that no task was created in the project.
  - For a proposal that needs a decision, the adopt form can open an edit to the proposed fix (supplement or replacement).
  - A note attached to an adoption is shown under the proposal with its kind (and in reports).
- Dashboard
  - The "Audit" card shows, per project, causes, recurred, and needing-decision counts and the adoption rate.
  - It also shows, per week, the changes requested and PR remarks per task (from the evidence counts of finished audits).
- Report (`/projects/<ID>/audit/report?from=&to=`)
  - Markdown with the causes, proposals, and decisions of audits finished in the period.
  - The period is in UTC dates, through the end of the last day. A date that does not exist or a start after the end is 400.
  - Headings follow the UI language; audit text is not translated.
  - Times are UTC with the year.

Code: `apps/web/src/components/audit.tsx` (`TaskAuditCard`, `ProposalView`), `apps/web/src/components/audit-screen.tsx` (`AuditScreen`),
`apps/web/src/components/dashboard.tsx` (`AuditCard`), `apps/web/src/lib/audit-report.ts` (`auditReport`, `reportPeriod`)
