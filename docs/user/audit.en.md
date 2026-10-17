<!-- Code: apps/web/src/components/audit.tsx, apps/web/src/components/audit-screen.tsx, apps/web/src/lib/audit-report.ts, apps/web/src/i18n/messages/audit.ts, apps/daemon/src/audits.ts, packages/core/src/audit.ts -->

[日本語](audit.md) | **English**

# Viewing audits

An audit examines the whole process of a completed task, from the step choices to completion. It looks for the causes of
changes requested, remarks, and the agents' trial and error, and proposes fixes that prevent them (context, skills, agent
rules, linters, tests, and so on). Adopting a proposal creates a fix task.

> In this version, audits are screens only. The audit data is a mock, shown only when sacty is started with
> `SACTY_AUDIT_MOCK=1`. Without it, the audit card and page show "No audits yet."

```sh
SACTY_AUDIT_MOCK=1 npx sacty up
```

The mock assigns various audit states to the project's completed tasks. Adopting, rejecting, and resuming are kept only in
the daemon's memory and reset when you restart sacty.

## The audit card in task details

Completed tasks have an "Audit" card in their details.

| Item | What it shows |
| --- | --- |
| State | Waiting for audit, Surveying, Deep dive, Audited, Audit failed, or Paused by budget |
| Cost | The cost and cap of the audit. Audits have their own budget, separate from the task's |
| Survey | A summary and the counts of evidence (changes requested, PR remarks, pauses, retries, failed tool calls, escalations) |
| Steps of concern | The steps the survey flagged, and the deep-dive result for each |
| Causes and proposals | Causes, evidence, and proposals. "Activity" and "Log" in the evidence move to that row and run log. A cause found again after its fix shows "Recurred" |

To resume an audit paused by its budget, enter a new cap (more than the amount used) in the card.

## Adopting and rejecting proposals

A proposal that needs a decision shows a target choice and "Adopt" and "Reject".

- Choose the target from the target repository, a context (the project layer or an upper layer), or the sacty default
  context (the goal guardian's prompts and the default skills). The target the audit chose is selected first.
- "Adopt" creates a task that makes the fix in the chosen target (the mock does not create it; it only records that it did).
- "Reject" opens a reason field. The reason is required. It is passed to later audits so they do not repeat the same
  proposal.
- A decided proposal cannot be changed.

## The audit page

"Audit" in the side menu opens the audit page of the project you are viewing (`/projects/<ID>/audit`).

- **Causes**: the same cause grouped across tasks, with its state (Recurred, Proposed, Adopted, Fixed, Rejected), how many
  times it was found, and the tasks. Recurred causes come first and stand out.
- **Proposals**: those needing a decision come first. Each shows which task's audit it came from, and you can adopt or
  reject it here too.
- **Audited tasks**: state, remarks, cost, and when the audit finished.
- **Report**: choose a start and end date and press "Export report" to download a Markdown file with the causes,
  proposals, and decisions of audits finished in the period. Headings follow the UI language; audit text is not
  translated. Times are UTC.

Audit results are not combined across projects.

## Dashboard

The "Audit" card on the dashboard shows, per project, the causes, recurred and needing-decision counts, and the adoption
rate, and, per week, the changes requested and PR remarks per task ([Dashboard](dashboard.en.md)). Press a project name
to open its audit page.

## Budget

The default cap per audit is `budget.default_per_audit_usd` in config.yaml (default $1) ([config.yaml settings](config.en.md)).

## Related pages

- [Working on tasks](tasks.en.md)
- [Dashboard](dashboard.en.md)
