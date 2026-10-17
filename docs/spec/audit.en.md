[日本語](audit.md) | **English**

# Audit of completed tasks

An audit examines the whole process of a completed task, from the step choices to completion. It finds the causes of
changes requested, remarks, and trial and error, and proposes fixes that prevent them. A person adopts or rejects each
proposal, and an adopted proposal becomes a fix task. For now only the screens and the API exist, and the daemon returns
mock data (the real audit comes in PBI-125).

Related ADR: [Build the audit screens first, on a mock backend](../adr/20261017-1145-audit-ui-with-mock.md)

## What is audited, and states

- Only completed tasks are audited (`status` is `idle` and every step is done or skipped). Cancelled tasks are not audited.
- The audit states are `waiting`, `surveying`, `deepDiving`, `completed`, `failed`, and `budgetPaused`.
- An audit first surveys the whole task (`survey`: a summary and the counts of evidence) and flags steps of concern. Each
  flagged step is deep-dived in its own session (`deepDives`).
- The evidence kinds are `changesRequested`, `pullRequestRemark`, `pause`, `retry`, `toolFailure`, and `escalation`.
  Evidence can point to an activity row (`eventId`) and an agent run (`runId`).

Code: `packages/core/src/audit.ts` (`TaskAudit`, `AuditStatus`, `AuditEvidence`), `apps/daemon/src/audits.ts` (`isAuditTarget`)

## Causes and proposals

- A completed audit has proposals for each cause (`findings`). Each proposal has a target: the target repository
  (`repository`), a context repository (`context`; `depth` counts the layers up through `extends`, with the project's
  context as 0), or the sacty default context (`sacty`: the goal guardian's prompts and the default skills).
- The target candidates are the task's target repository, the context layers the task used (without the sacty default
  layer; if there is no record, the project's context as depth 0), and the sacty default.
- A person adopts or rejects each proposal that needs a decision. When adopting, they can choose another target from the
  candidates. Adopting creates a fix task (the mock only pretends to). Rejecting needs a reason (1–2000 characters after
  trimming). A decided proposal cannot be decided again.
- Causes are grouped across tasks within a project. A cause is `recurred` if found again after its fix was merged,
  `fixed` if not, `adopted` if a proposal was adopted, `proposed` if a proposal needs a decision, and `rejected` if all
  proposals were rejected.
- Nothing is aggregated across projects. The dashboard shows only counts.

Code: `packages/core/src/audit.ts` (`AuditTarget`, `AdoptAuditProposalInput`, `RejectAuditProposalInput`),
`apps/daemon/src/audits.ts` (`auditTargetCandidates`, `causeStatus`, `sortCauses`)

## Audit budget

- Each audit has its own budget cap, separate from the task's budget. The default is `budget.default_per_audit_usd` in
  config.yaml (default 1 US dollar).
- An audit that reaches its cap becomes `budgetPaused`. A person resumes it with a new cap (cumulative; more than the
  amount used).

Code: `apps/daemon/src/config.ts` (`budgetPerAuditUsd`), `apps/daemon/src/service.ts` (`auditBudgetUsd`),
`packages/core/src/audit.ts` (`ResumeAuditInput`)

## Mock

- The daemon uses the mock (`MockAuditService`) only when started with the environment variable `SACTY_AUDIT_MOCK=1`. By
  default it uses the implementation without audits (`NoAuditService`): tasks have no audit, the audit page is empty, and
  adopting, rejecting, and resuming are refused as not found.
- The mock assigns scenes to the project's completed tasks in the order they completed (audited, deep dive, paused by
  budget, failed, surveying, waiting; from the 9th task on, two kinds of audited alternate). The first 3 tasks show every cause state, and the 9th
  shows a proposal targeting the sacty default (every task has the sacty default among its candidates).
- Adopting, rejecting, and resuming are kept only in the daemon's memory and reset when it restarts. The data has
  `mock: true`, and the screens show a "Mock" badge.

Code: `apps/daemon/src/audits.ts` (`MockAuditService`, `NoAuditService`, `AuditService`), `apps/daemon/src/main.ts`

## API

| Method and path | Content |
| --- | --- |
| `GET /api/tasks/:id/audit` | The task's audit (`{ audit }`; null if none) |
| `POST /api/tasks/:id/audit/resume` | Resume an audit paused by its budget (`{ capUsd }`) |
| `GET /api/projects/:id/audits` | The project's audits (causes, proposals, audited tasks). 404 if the project does not exist |
| `GET /api/audits/dashboard` | Counts for the dashboard (per project and per week) |
| `POST /api/audits/proposals/:id/adopt` | Adopt a proposal (`{ target }`) |
| `POST /api/audits/proposals/:id/reject` | Reject a proposal (`{ reason }`) |

Invalid input is 400 (message codes). An operation that does not fit the state (already decided, a target not in the
candidates, not paused, too low a cap) is 409.

Code: `apps/daemon/src/server.ts` (`createApp`)

## Screens

- Task details: completed tasks have an "Audit" card (state, cost, survey, steps of concern, causes and proposals, resume
  form). Evidence links to the activity row (`#event-<ID>`) and the run log.
- Audit page (`/projects/<ID>/audit`; "Audit" in the side menu): causes (recurred first), proposals (those needing a
  decision first), audited tasks, and report export.
- Dashboard: the "Audit" card shows, per project, causes, recurred, and needing-decision counts and the adoption rate, and,
  per week, the changes requested and PR remarks per task.
- Report (`/projects/<ID>/audit/report?from=&to=`; a date that does not exist or a start after the end is 400): Markdown with the causes, proposals, and decisions of audits finished
  in the period (UTC dates, through the end of the last day). Headings follow the UI language; audit text is not
  translated. Times are UTC with the year.

Code: `apps/web/src/components/audit.tsx` (`TaskAuditCard`, `ProposalView`), `apps/web/src/components/audit-screen.tsx` (`AuditScreen`),
`apps/web/src/components/dashboard.tsx` (`AuditCard`), `apps/web/src/lib/audit-report.ts` (`auditReport`, `reportPeriod`)
