[日本語](audit.md) | **English**

# Audit of completed tasks

An AI agent examines the whole process of a completed task, from the step choices to completion. The agent finds the causes of changes requested, remarks, and trial and error, and proposes fixes that prevent them.

A person adopts or rejects each proposal, and an adopted proposal becomes a fix task. When adopting, they can also supplement the proposed fix or replace it with their own. Audits are recorded in the audited task's activity log.

Related ADRs: [Build the audit screens first, on a mock backend](../adr/20261017-1145-audit-ui-with-mock.md), [Group audit proposals by cause, show the top ones, and reject several at once](../adr/20261121-1400-audit-bulk-reject.md), [Audit completed tasks in two stages, recorded in the activity log](../adr/20261017-1310-audit-engine.md), [Derive the flaky test ledger from the activity log, and leave proposals to tasks a person creates](../adr/20261106-1105-superseded-derive-flaky-test-ledger-from-activity.md)

## When an audit starts, and what is audited

- sacty adds `AuditQueued` (the audit ID and budget cap) in the same append that completes a task (makes `status` `idle` with every step done or skipped). The audit is not lost if the daemon stops between completion and registering the audit. For a PR review task, the append that posts the review is this one (even while the verdict is not no findings and the task watches the PR for changes, its steps are finished, so it is an audit target; [Watching the PR after posting](tasks-and-steps.en.md#watching-the-pr-after-posting)).
- Cancelled tasks are not audited.
- Tasks that completed before this feature (only folded from the activity log at startup) get no `AuditQueued` and are not audited.
- A task waiting for its audit enters the worker's queue (it counts toward the limit on parallel runs). Tasks with nothing but the audit left are queued after other runs. Each run advances one agent run.
- The audit states are `waiting`, `surveying` (the survey is running), `deepDiving`, `completed`, `failed`, and `budgetPaused`.

Code: `apps/daemon/src/service.ts` (`auditQueueEvent`, `awaitingAudit`, `runAudit`), `packages/core/src/projection.ts` (`isAuditTarget`, `auditOpen`, `nextAuditDive`)

## Two stages

The audit flows as follows.

![Two-stage audit](images/audit-flow.en.svg)

1. **Survey** (role `audit`)
   - The agent reads the whole ledger of the task (body, approved outputs, evidence counts, human remarks, judgments, activity) and each run's session log.
   - It flags up to 3 steps of concern (`AuditSurveyed`).
   - With no steps of concern, the audit finishes without a deep dive.
2. **Deep dive** (role `audit-dive`)
   - For each flagged step, the agent gives causes (up to 3) and fix proposals per cause (up to 2) (`AuditDeepDived`).
   - The agent registers knowledge that will help later tasks as memories ([Memory](memory.en.md)).
   - After every step is deep-dived, `AuditCompleted`.

- Both stages run in a new session every time. The AI is `audit_agent` in config.yaml (or `default_agent`).
- What the agent sees
  - Session logs are mounted read-only at `/sacty-logs`, as for answers to questions.
  - The full ledger (one JSON event per line) is mounted read-only at `/sacty-ledger/ledger.jsonl`, because the instructions hold only the start of each row and omit the middle when long.
  - The workspace gets a disposable copy of the code, with an instruction not to change it. The copy is after the implementation if the task has an implement step, otherwise at the base commit.
- Redacting secrets
  - sacty redacts secrets before truncation from the materials (ledger, body, approved outputs, remarks, rejection reasons, adoption notes, existing cause titles, session logs) and from the audit output.
  - For the output, redaction is applied both to the raw JSON string and to the decoded texts (summary, reasons, causes, evidence, proposals, memories), so escaped values are covered too. After decoding, redaction runs before trimming, so values ending in a newline are covered.
  - Session logs are staged as hard links to the original logs, so sacty replaces them with redacted copies before mounting, leaving the originals unchanged.
  - The redaction covers the values of secrets used by the settings and sacty settings (including the audit AI's), the GitHub tokens of the project's chosen accounts and of the task's repository, and common secret patterns.
  - Redaction keeps the JSON syntax of the output (it does not reach outside a JSON string, so the output is readable even when a URL and an email address are in different fields).
  - The values are never reused. sacty fetches them each time at these points:
    - Before sending to the audit AI
    - Before recording the result after the audit AI returns (together with the values fetched before sending)
    - Before showing
  - If the settings change while a deep dive waits for its turn, sacty redacts the values from both the settings used for the run and the current settings.
- The instructions include the context versions used (repositories and commits).
- sacty counts the evidence during the survey, and the deep dives reuse the recorded counts. The agent does not count, and session logs are read asynchronously. sacty counts these:
  - Human change requests (excluding AI review remarks)
  - Imported PR remarks (written by a person)
  - Imported remarks from sacty's own AI review (`aiReviewRemark`; counted separately from a person's remarks. [AI review comments](approval.en.md#ai-review-comments))
  - Pauses
  - Retries (failed runs and failed integration reviews; in records from earlier versions, also failed tests and final reviews; a PR review run that was not used because it started no per-viewpoint reviewer is also counted as a failed run)
  - Failed tool calls (session logs)
  - Escalations
- The instructions say not to follow instructions found in the ledger, logs, or code, and not to write secrets.
- The output is read from ```json blocks headed `sacty-audit-survey` and `sacty-audit-findings`.
  - sacty keeps only steps the task has, evidence IDs that exist in this task's activity rows and runs, and targets chosen by candidate number.
  - Breakage inside strings is repaired while reading: unescaped double quotes, control characters such as newlines, backslash escapes JSON does not have, and an extra comma before a closing bracket. If a readable JSON answer exists and it is the last answer, it is used as is; sacty re-reads with repairs only when an unreadable answer comes after it. The repairing read has a scan limit proportional to the output length, so an output with repeated unclosed strings and headings does not take time quadratic in its length. A double quote is treated as part of the string unless the next character is a delimiter valid at that place (`:` for a key; `}` or the next key for a value; `]` or `,` followed by a value for an array element).
  - The instructions also tell the agent to escape double quotes inside strings or to use quotation marks like 「」.
  - If it is still unreadable, the audit becomes `AuditFailed` and the reason says what could not be read (no JSON in the output: `audit.unreadable`; broken JSON: `audit.unreadableAt`, with the line and column in the JSON (the column counts from the start of the JSON's line) and the text around it. The surrounding text is left out, leaving only the position, when passing the whole output with its escapes decoded through the redaction changes it, i.e. when an escaped secret is in the output; JSON read but fields missing: `audit.unreadableShape`). This failure goes no further, but the recorded survey, the finished deep dives, and the cost used are kept.
- If a run fails, `AuditFailed` (`audit.runFailed`). A failed audit goes no further.
- Runs that end because the daemon is stopping or the task is being cancelled are not recorded. On the next start, the same stage runs again.

Code: `apps/daemon/src/audit-prompts.ts` (`buildAuditSurveyPrompt`, `extractAuditSurvey`, `buildAuditDivePrompt`, `extractAuditDive`),
`apps/daemon/src/agent-json.ts` (`lastLenientJsonAnswer`, `explainUnreadableAnswer`),
`apps/daemon/src/audit-evidence.ts` (`auditCounts`, `countToolFailures`, `redactDeep`), `apps/daemon/src/service.ts` (`runAuditAgent`, `auditRedactor`, `withAuditDiveLock`)

## Causes and proposals

- Deep dives in the same project run one at a time (reading the existing causes and recording the result do not overlap).
  - A task cancelled while waiting for its turn stops waiting (cancelling does not wait for the earlier deep dive).
  - The queue entry stays until the earlier deep dive finishes, so deep dives that arrive later still run after it.
- Causes are grouped within a project by a cause key (`causeKey`).
  - The deep dive gets these:
    - The project's existing causes (key, title, whether a fix was adopted)
    - The rejected proposals with their reasons (a bulk rejection becomes one line per operation; see "Reject" below)
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
  - A record made by rejecting in bulk has the optional field `bulk` (`{ id, count }`).
    - `id` is the same for one operation, and `count` is the number that passed the checks and were to be written (an integer, 1 or more; decided before writing). A failed write for one source task is returned in `failed` (`audit.bulkWriteFailed`) whatever the error, and no record is made, so `count` can be larger than the number actually recorded. It is set even when only one proposal was selected (`count: 1`).
    - There is one record per proposal, written where a one-by-one rejection is written (the activity log of the task of the audit that made the proposal, as a person's action).
    - A record without `bulk` (from earlier versions, or a one-by-one rejection) is read as before. Records are not converted.
    - `bulk` is copied to the `decision` of a `rejected` proposal. The audit page's rejected proposals and the activity row show the bulk mark (the proposal view: "1 of N rejected in bulk"; the activity row: "Rejected a proposal (1 of N rejected in bulk)").
  - The "rejected proposals and reasons" given to the deep dive take this form, so lines and characters do not grow with the number rejected in bulk.
    - A rejection without `bulk` is one line per proposal as before (`- title: reason`).
    - Rejections with `bulk` are merged into one line per `bulk.id`: `- まとめて却下（N 件。例：title1／title2／title3 ほか K 件）：reason` (the line is written in Japanese like the rest of the prompt).
    - N is the number of records merged into the line, not `bulk.count`. Proposals of cancelled tasks and memory-to-context proposals (cause key starting with `memory:`) are removed before merging. K is N − 3 (omitted if 0 or less).
    - Only the first 3 titles are written; the titles from the 4th on are not passed (omitted). A title is cut at 100 characters and the reason at 300, and line breaks become spaces.
    - Rejections of memory-to-context proposals are still not in "rejected proposals and reasons"; they appear as the rejection reason on the memory's row in the memory list.
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

## The flaky test ledger

sacty counts, per project, the flaky failures the final review accepted in earlier versions (`tests.flakyFailures` of `FinalReviewed`, and `ciFlakyFailures`, accepted from the CI results for a task with no test command; [the step specification](tasks-and-steps.en.md)).
This is separate from running audits and does not use the audit budget.
The current version runs no final review ([Verifying the implementation](tasks-and-steps.en.md#verifying-the-implementation)), so no new entries are added. It is not shown on the screen either (the API that reads the ledger, `/api/projects/:id/flaky-tests`, and the way to create a task from it remain for older records).

- There is no new store; the ledger is derived from the activity log.
  Because `lastReview` is replaced on each round, `flakySightings` in the task state folds in the accepted failures of every round.
- A test is the combination of the repository, the file (without a leading `/`, with `.` and any `..` that can go back removed, and `\` changed to `/`), and the name.
  The same name in another repository or file counts as another test.
  Tasks of other projects are not counted.
- Each entry has an identifier (`id`; a hash of the repository, file, and name, from which the name cannot be read), the name, file, repository, the number of tasks that saw it, when it was last seen, the last reason, and the tasks (newest first, with links to the task and PR).
  Several times in the same task count as one.
- A test seen in `FLAKY_KNOWN_MIN_TASKS` (3) or more tasks is known.
  - Known tests were passed to the final review prompt in earlier versions (only those of the task's repository).
  - For a known test, a task to fix it is proposed (on the screen of the earlier version; the current screen does not show the ledger, so it shows no proposal either). It showed the repository along with the name and file.
- A proposal only opened the task creation dialog with the title, description, and target repository filled in.
  No task is created until a person presses create, and the created task runs as a normal task.
  - Reading the ledger records nothing.
  - sacty does not quarantine or disable tests automatically.
  - The description has no PR links (a PR in a task's description is read as the PR the task is about).
- A task created from a proposal is linked to the ledger by `flakyFix` of `TaskCreated` (the test's name and file). The repository is the task's.
  - Because the name on the screen is redacted, the create input sends only the identifier (`flakyFixTest`). sacty looks up the unredacted name and file in the ledger and records them.
    No task is created for an identifier not in the ledger, or for a repository other than the test's (including a task with no repository).
  - When a cancelled task is rerun in the same repository, `flakyFix` is carried over. It is not carried over to another repository.
  - While such a task is unfinished, no second proposal is shown; a link to the task is shown instead.
  - If the task is cancelled or finishes without merging a PR, the test is proposed again.
  - Once its PR is merged, records from before the merge are not counted. Later records are counted anew. When the task was split, merges of PRs of its descendant tasks count too.

Code: `packages/core/src/flaky-tests.ts` (`flakyTests`, `knownFlakyTests`, `findFlakyTest`, `repoPath`), `packages/core/src/projection.ts` (`flakySightings`), `apps/daemon/src/service.ts` (`projectFlakyTests`, `createTask`, `rerunTask`),
`apps/web/src/components/new-task-dialog.tsx` (`NewTaskDialog`)

## Audit budget

- The cap per audit is recorded in `AuditQueued`. The default is `budget.default_per_audit_usd` in config.yaml (default 1 US dollar).
- Audit cost is held in `auditCostUsd` and added to `usedUsd` in the audit state. It is not counted toward the task budget.
- After an agent run, reaching 80% of the cap records `AuditBudgetWarned` (once per cap).
- If the cap is reached before the next run, `AuditBudgetPaused`. If no deep dive remains, the audit becomes `AuditCompleted` even over the cap.
- When a person enters a new cap (cumulative; more than the amount used), `AuditCapRaised` resumes the audit from the next stage.

Code: `apps/daemon/src/service.ts` (`warnAuditBudget`, `resumeAudit`, `auditBudgetUsd`), `apps/daemon/src/config.ts` (`budgetPerAuditUsd`)

## Mock

- Started with the environment variable `SACTY_AUDIT_MOCK=1`, the daemon does not run audits (`audit: false`) and returns mock data (`MockAuditService`) to the screens.
  - Adopting, rejecting (including rejecting in bulk), and resuming are kept only in the daemon's memory.
  - The returned data has `mock: true`.
- The mock assigns scenes to the project's completed tasks in the order they completed. The scenes go in the order audited, deep dive, paused by budget, failed, surveying, and waiting. From the 9th task on, two kinds of audited alternate.

Code: `apps/daemon/src/audits.ts` (`MockAuditService`, `AuditService`), `apps/daemon/src/main.ts`

## API

| Method and path | Content |
| --- | --- |
| `GET /api/tasks/:id/audit` | The task's audit (`{ audit }`; null if none) |
| `POST /api/tasks/:id/audit/resume` | Resume an audit paused by its budget (`{ capUsd }`) |
| `GET /api/projects/:id/audits` | The project's audits (causes, proposals, audited tasks). 404 if the project does not exist |
| `GET /api/projects/:id/flaky-tests` | The project's flaky test ledger (read only). 404 if the project does not exist |
| `GET /api/audits/dashboard` | Counts for the dashboard (per project and per week) |
| `POST /api/audits/proposals/:id/adopt` | Adopt a proposal (`{ target, note? }`, where `note` is `{ kind, text }`) |
| `POST /api/audits/proposals/:id/reject` | Reject a proposal (`{ reason }`) |
| `POST /api/audits/proposals/reject` | Reject proposals in bulk (`{ projectId, proposalIds, reason }`; see [Reject in bulk](#reject-in-bulk)) |
| `POST /api/audits/memories/:id/delete` | Delete a memory the audit registered ([Memory](memory.en.md)). Returns the audit that registered it (`{ audit }`) |

- Invalid input is 400 (message codes).
- An operation that does not fit the state (already decided, a target not in the candidates, a cancelled task, not paused, too low a cap) is 409.

### Reject in bulk

- Input: `projectId`, `proposalIds` (1–2,000, no duplicates), and `reason` (1–2000 characters after trimming). A wrong shape, count, duplicate, or reason is 400 and nothing is recorded for any proposal.
- Response: `{ rejected, failed }`.
  - `rejected` holds the rejected proposals (the same shape a one-by-one rejection returns).
  - `failed` holds `{ proposalId, messages }` for each proposal that could not be rejected. `messages` are message codes with parameters (the screen renders them in its language).
  - Even when some or all fail, the response is 200 and the failures are in `failed`.
- Each proposal goes through the same checks as a one-by-one rejection. A proposal that fails goes to `failed`.
  - A missing proposal, or one of a project other than `projectId`: `audit.proposalNotFound` (nothing is recorded).
  - A proposal of a cancelled task: `audit.notAdoptable`. A decided proposal: `audit.alreadyDecided`.
- The reason is redacted once. The secret values from the settings and the GitHub tokens are fetched once per project (not once per original task).
- A proposal decided by another operation while the secrets are fetched is checked again without waiting and moved to `failed` (no double record is made).
- Only the proposals that pass are written, in one append per original task. `bulk.count` is the number that passed (decided before writing). A failed append for a task is returned as a failure whatever the error, so the count can exceed the number actually recorded.
- `rejected` is picked up by rebuilding the audit page's data once after writing.
- The target for 2,000 proposals (50 original tasks) is within 5 seconds.

Code: `apps/daemon/src/service.ts` (`rejectAuditProposals`), `apps/daemon/src/ledger-audits.ts` (`rejectMany`)

Code: `apps/daemon/src/server.ts` (`createApp`)

## Screens

- Task details
  - Completed tasks have an "Audit" tab (if not audited yet, it says so; state, cost, survey, steps of concern, causes and proposals, registered memories, resume form).
  - Evidence links to the activity row (`#event-<ID>`) and the run log.
  - Activity rows of audit runs also open their logs.
- Audit page (`/projects/<ID>/audit`; "Audit" in the side menu)
  - It shows causes, audited tasks, and report export (it does not show the flaky test ledger; [Flaky test ledger](#the-flaky-test-ledger)). Proposals are read and decided inside their cause (one section for causes and proposals).
  - Causes keep the current order (recurred, proposed, adopted, fixed, rejected; the same state by the number of tasks it was found in) and show the top 20 as collapsed rows.
    - "Show more" adds 20 at a time. The note reads "Showing M of N". "Show more" is not shown when there are 20 or fewer.
    - The filter and the number shown stay in the URL: `?causes=pending|recurred` (missing or unknown means all) and `?shown=<a multiple of 20>`. The page's server filters and cuts, and passes only the causes shown and their proposals to the browser.
    - "Needs decision" means a cause with at least one proposal needing a decision (these can remain on recurred and fixed causes, so it is not the same as the state "proposed").
    - A collapsed row shows the state (recurred in the warning color and bold), the title, how many times it was found, and the number needing a decision.
    - Opening a cause shows its tasks (the first 5 and "N more") and its proposals (those needing a decision first, newest first; the first 10, and "N more" adds 10 at a time). Adopt, edit, and reject (one at a time) are done only inside the open cause (decision inputs are not shown twice).
    - The open causes and the selection are kept in the page, so they survive the redraw after a decision.
  - Proposals needing a decision can be selected and rejected together with one reason.
    - Each proposal has a checkbox, and each cause has "Select all needing a decision" (only the proposals shown at that moment; partly selected shows the mixed state). The selection can span causes and survives collapsing a cause.
    - A bar above the list shows "N selected" and "Reject selected" (disabled with 0 selected; the bar is not shown when the project has no proposal needing a decision).
    - The confirmation dialog shows the count, the titles grouped by cause (scrolling inside the dialog), that rejecting cannot be undone, and the reason (required, up to 2,000 characters). "Cancel" and Escape close it without recording anything and keep the selection. Closing returns focus to "Reject selected".
    - Up to 2,000 can be selected. Beyond that the confirm button is disabled and the limit is explained.
    - The result appears under the bar. When all are rejected it says "Rejected N"; when some could not be, it says "Rejected N; M could not be rejected" and lists the titles and reasons of those. The selection is cleared when at least one was rejected.
  - An adoption for sacty shows that no task was created in the project.
  - For a proposal that needs a decision, the adopt form can open an edit to the proposed fix (supplement or replacement).
  - A note attached to an adoption is shown under the proposal with its kind (and in reports).
  - A proposal rejected in bulk shows "1 of N rejected in bulk" with its reason (the task details' "Audit" tab uses the same proposal view).
- Dashboard
  - The "Audit" card shows, per project, causes, recurred, and needing-decision counts and the adoption rate.
  - It also shows, per week, the changes requested and PR remarks per task (from the evidence counts of finished audits).
- Report (`/projects/<ID>/audit/report?from=&to=`)
  - Markdown with the causes, proposals, and decisions of audits finished in the period.
  - The period is in UTC dates, through the end of the last day. A date that does not exist or a start after the end is 400.
  - Headings follow the UI language; audit text is not translated.
  - Times are UTC with the year.
  - The rejection reason is shown per proposal. A proposal rejected in bulk also gets the same reason once per proposal, with no bulk mark (the report is unchanged).

Code: `apps/web/src/components/audit.tsx` (`TaskAuditCard`, `ProposalView`), `apps/web/src/components/audit-screen.tsx` (`AuditScreen`), `apps/web/src/components/audit-causes.tsx` (`AuditCauses`), `apps/web/src/lib/audit-view.ts` (`sliceAudits`),
`apps/web/src/components/dashboard.tsx` (`AuditCard`), `apps/web/src/lib/audit-report.ts` (`auditReport`, `reportPeriod`)
