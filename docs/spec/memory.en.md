[日本語](memory.md) | **English**

# Memory

The audit of a completed task registers knowledge that will help later tasks as memories. Step agents read the memories of the task's project and target repository, opening only the relevant ones from the index. Only the audit registers memories; people can delete wrong ones.

Related ADR: [監査が登録したメモリーを、作業履歴を正本にして、スキルの索引の形で書き出す](../adr/20261018-0130-audit-memory.md)

The flow from registering a memory to an agent reading it is as follows.

![From registering a memory to reading it](images/memory-flow.en.svg)

## Layers and locations

- There are two layers, project and repository (there is no global layer). Both live under `SACTY_HOME/memory`.

| Layer | Location | Contents |
| --- | --- | --- |
| Project | `memory/projects/<project ID>/` | Knowledge from that project's tasks |
| Repository | `memory/repos/<host>/<owner>/<name>/` | Knowledge about the repository itself. Kept outside projects, so it stays in use after project settings change |

- The repository layer's key is the GitHub repository URL without `.git`, lowercased (clone URLs and the SSH form are also read). Repositories that are not on GitHub (local paths and so on) get no repository layer.
- Names that cannot be used as a path segment (for example, ones containing `..`) become a hash (`_` plus the first 16 characters of SHA-256).
- Each layer is an index, `SKILL.md`, plus one file per memory, `references/<memory ID>.md`.
  - Each index line is only `- [title](references/<ID>.md)：summary（有効な最終利用日：YYYY-MM-DD）`. The contents are not in the index.
  - A memory file holds the title, summary, last useful date, registration date, and the contents (Markdown).
  - The last useful date moves forward when the audit judges the memory helpful in a task ([Updating the last useful date](#updating-the-last-useful-date)). Dates are UTC.

Code: `apps/daemon/src/memory.ts` (`memoryLayerDir`, `repositoryMemoryKey`, `renderMemoryIndex`, `renderMemoryReference`, `indexLine`)

## Source of truth and writing

The activity log is the source of truth. The daemon records registrations in the deep-dive result (`memories` of `AuditDeepDived`) and deletions in `AuditMemoryDeleted` (`memoryId`, `reason`). It appends both to the activity log of the audited task that registered the memory. `reason` is one of the following.

| Value | Why it was deleted |
| --- | --- |
| `person` | A person deleted it |
| `capacity` | The count limit |
| `expired` | Past the retention period |
| `promoted` | The PR of the fix that made it context was merged |

- Only the daemon writes the files. After recording a registration or deletion, it rewrites that layer from the activity log. It removes a layer with no memories left together with its directory.
  - The daemon does not replace the directory; it writes each file to a temporary file in the same directory and then renames it over the old one. This way a running container keeps its mount and never reads a half-written file.
  - It does not write files whose contents are unchanged.
  - If writing fails, the record remains and the daemon prints a warning.
- At startup, the daemon removes expired memories and memories over the count limit, then rewrites every layer to match the activity log. It removes directories of layers with no records (this repairs a stop between recording and writing).
- With no place to write (`memoryRoot`), the daemon does not write memories and does not ask the deep dive to register any.

Code: `apps/daemon/src/memory.ts` (`liveMemories`, `writeMemoryLayer`, `syncMemoryLayers`), `apps/daemon/src/service.ts` (`writeMemories`, `syncMemories`), `packages/core/src/events.ts` (`AuditMemoryRecord`, `MEMORY_DELETE_REASONS`), `packages/core/src/projection.ts` (`TaskAuditMemory`)

## Registration by the audit

- The deep-dive prompt includes the existing memories of the task's project and target repository (ID, layer, title, summary, and where to read the contents) and the registration rules.
  - Register only concrete knowledge that will also help the next task of the same kind. Do not register circumstances of this task alone or one-off events.
  - If the knowledge matches an existing memory, put its ID in `sameAs`; nothing is registered.
  - `scope` is `repository` for things about the repository itself (build, tests, conventions, structure), and `project` for things specific to the project or context. `repository` memories must not contain names or circumstances specific to a project, organization, or context. With no GitHub target repository, only `project` is allowed.
  - No secrets or personal information.
- sacty reads the output's `memories` as follows.
  - At most 2 per deep dive (`AUDIT_MAX_MEMORIES`).
  - The title (200 characters) and summary (300 characters) are made single-line; the contents are capped at 4000 characters.
  - sacty drops the following.
    - Items missing a title, summary, or contents
    - Items whose `sameAs` is an existing ID
    - `repository` items without a target repository
  - sacty sets the `repository` destination to the target repository (the output's destination is not used).
- Like other audit output, sacty redacts secrets before recording. It also applies the same redaction to the title, summary, and contents after decoding the JSON and before trimming, joining into one line, and truncation. This is because values containing quotes, backslashes, or newlines are escaped in the JSON string and would not match there. sacty assigns the IDs.
- Deep dives of the same project run one at a time, so duplicates in the project layer are checked against the list at registration time. The repository layer can receive a registration from another project's deep dive at the same time; then the same knowledge may end up as two memories.
- Each layer holds at most 30 memories (`MEMORY_MAX_PER_LAYER`). When a registration exceeds it, sacty deletes the memories with the oldest last useful date (then the oldest registration) with `capacity`.

Code: `apps/daemon/src/audit-prompts.ts` (`buildAuditDivePrompt`, `extractAuditDive`, `AUDIT_MAX_MEMORIES`), `apps/daemon/src/service.ts` (`knownMemories`, `trimMemories`, `runAuditAgent`), `apps/daemon/src/memory.ts` (`overCapacity`, `MEMORY_MAX_PER_LAYER`)

## Updating the last useful date

- Before the survey, sacty counts how many times memories were opened, using the session logs (stdout JSONL) of the task's runs.
  - It counts the non-deleted memories of the task's project and target repository whose file location (`/sacty-memory/<layer>/references/<ID>.md`) appears. A relative index link (`references/<ID>.md`) alone does not count.
  - It counts only the task's own run logs and excludes audit runs (the `runId` of audit records, and session records whose role is `audit` or `audit-dive`). This is because stopping the daemon during a survey leaves the session record without an audit record.
  - Runs without a log are not counted. Logs unreadable for other reasons are not counted either, and a warning gives the task and run IDs and the error code (not the log contents).
- The survey prompt includes the opened memories (ID, title, summary, times opened) and the judging rules, and asks for the IDs of the helpful ones in `usefulMemories`. A helpful memory is one where the work followed that knowledge and avoided a detour or a change request. IDs that were not opened are dropped.
- `AuditSurveyed` records the opened memories (`openedMemories`) and the helpful ones (`usefulMemories`). After recording, sacty rewrites the helpful memories' layers.
- The last useful date is the later of the registration time and the latest completion time (the time of `AuditQueued`) of a task that judged it helpful. A late audit of an older task never moves it back. Memories that were not opened or did not help keep their dates.
- The Audit tab shows the memories that helped (title, layer) and the last useful date of registered memories.

Code: `apps/daemon/src/memory.ts` (`countOpenedMemories`, `usefulDates`, `lastUsefulAt`), `apps/daemon/src/service.ts` (`openedMemories`), `apps/daemon/src/audit-prompts.ts` (`buildAuditSurveyPrompt`, `extractAuditSurvey`), `apps/daemon/src/ledger-audits.ts` (`LedgerAuditService`)

## Promotion

The survey (when there is a place to write memories) includes the material for promotion.

- The non-deleted memories of the task's project and target repository
  - ID, layer, title, summary, last useful date, times helpful, whether a promotion to context is pending, the rejection reason, and where the contents are
  - Times helpful is the number of tasks that judged the memory helpful.
- The candidate targets for a promotion to context (the fix proposal targets minus sacty's default context)

The audit outputs two kinds of promotion: moving between layers and promotion to context.

| Kind | Output | Limit per survey |
| --- | --- | --- |
| Moving between layers | `memoryMoves` | 3 (`AUDIT_MAX_MEMORY_MOVES`) |
| Promotion to context | `memoryPromotions` | 2 (`AUDIT_MAX_MEMORY_PROMOTIONS`) |

The promotions the audit outputs flow as follows.

![Promoting memories](images/memory-promotion.en.svg)

### Moving between layers

The audit moves memories in the wrong layer to the task's project or target repository layer. Things about the repository itself (helpful to other projects' tasks too) go to `repository`; things specific to the project or context go to `project`. Memories containing names or circumstances specific to a project, organization, or context must not be moved to `repository`.

- When reading: only memories in the material, only to a different layer, each memory once. With no target repository, nothing moves to `repository`.
- When recording
  - sacty checks again that the memory still exists, is still in the task's layers, and is in a different layer. This is because surveys of the same project can run at the same time.
  - `memoryMoves` of `AuditSurveyed` records the destination (the project ID for `project`, the repository for `repository`).
- sacty decides a memory's place by applying every task's moves in the order the surveys were appended (`seq`; the last move wins). It does not decide by time (so records with the same time do not fall back to task creation order). The memory's last useful date, registering task, and ID do not change.
- After recording, if the destination exceeds the count limit, sacty deletes the memories with the oldest last useful date with `capacity`, as on registration. Then it rewrites the layers before and after the move and any trimmed layers.

### Promotion to context

For memories that helped repeatedly (about 2 times or more) and became rules worth keeping, the audit proposes a fix. The fix writes the memory into the context (skills, conventions) or the target repository (AGENTS.md and so on).

- When reading: only memories without a pending promotion, only targets from the candidate numbers, and only items with a title.
- When recording
  - sacty checks again that the memory still exists, is still in the task's layers, and has no pending promotion.
  - It records the promotion as a cause in `promotions` of `AuditSurveyed` (cause key `memory:<memory ID>`).
  - The proposal holds the original memory's ID in `memoryId` and its title, summary, and contents in `memoryOriginal`. This field is separate from the proposal body, so neither is cut short.
  - sacty redacts the original with the current secret values before copying (values that became secrets after registration are covered).
  - The fix task's body puts the proposal body and the original memory side by side.
- The cause is recorded with the original memory's title and an empty description. The screen and report show "Make memory context: <title>" and a fixed description in the screen's language.
- Adopting and rejecting work as for other fix proposals. Adopting creates a fix task on the target repository that goes through to a PR (context changes always go through a human PR review).
- A memory with a pending or adopted proposal counts as "being promoted" and gets no duplicate proposal. A rejected memory stays, and the rejection reason is added to the material.
- The list of existing causes given to deep dives leaves out promotions to context.

### Deleting the original memory

When the PR of the fix task from an adopted proposal is merged, sacty deletes the original memory with `AuditMemoryDeleted` (`reason: "promoted"`). It checks this on each PR watch pass, each cleanup, and at startup.

The Audit tab shows the moved memories (title, destination) and a mark on memories deleted after becoming context.

Code: `apps/daemon/src/audit-prompts.ts` (`buildAuditSurveyPrompt`, `extractAuditSurvey`, `AUDIT_MAX_MEMORY_MOVES`, `AUDIT_MAX_MEMORY_PROMOTIONS`), `apps/daemon/src/service.ts` (`promotionInput`, `surveyPromotionRecord`, `retirePromotedMemories`, `knownAuditCauses`), `apps/daemon/src/memory.ts` (`memoryPlacements`, `usefulCounts`, `promotedMemories`), `packages/core/src/events.ts` (`MemoryMove`, `AuditProposalRecord`)

## Cleanup

- sacty deletes memories whose last useful date is more than `memoryRetentionDays` in the sacty settings (1 to 3650; 90 days if not set; `DEFAULT_MEMORY_RETENTION_DAYS`) old. It keeps memories exactly that many days old.
- It records the deletion in the activity log of the task that registered the memory as `AuditMemoryDeleted` (`reason: "expired"`), and rewrites that layer.
- The daemon cleans up at startup and every hour (`MEMORY_CLEANUP_INTERVAL_MS`). It deletes memories that expired while it was stopped at the next startup. On shutdown, it stops the cleanup before closing the activity log.
- Cleanup and audit recording both run synchronously in the daemon, so neither interrupts the other's recording. A memory can disappear while an audit run is reading it (even if that audit judges it helpful, a deleted memory does not come back).
- With no place to write (`memoryRoot`), nothing is cleaned up.

Code: `apps/daemon/src/memory.ts` (`expiredMemories`, `MEMORY_CLEANUP_INTERVAL_MS`), `apps/daemon/src/service.ts` (`cleanupMemories`, `syncMemories`), `apps/daemon/src/main.ts`, `packages/core/src/projects.ts` (`SactySettings`, `DEFAULT_MEMORY_RETENTION_DAYS`)

## Giving memories to agents

- Runs of steps (except the integration review) get the task's project layer at `/sacty-memory/project` and the target repository's layer at `/sacty-memory/repository`, mounted read-only.
  - Layers without an index are not mounted.
  - For Claude Code, sacty adds them to the readable places with `--add-dir`.
- When something is mounted, sacty adds reading instructions at the start of the prompt.
  - Read the index and open only the relevant files under `references/`.
  - When a memory conflicts with the person's instructions, the context's rules and skills, or the target repository's AGENTS.md and so on, follow those instead.
- The audit (survey and deep dive) gets the same mounts (to check for duplicates). sacty does not add the reading instructions there.
- The following get none.
  - The Goal Guardian (change-request judgement, final review, integration review, and judging where to send PR remarks back (role `rework`))
  - The orchestrator
  - Question answers
  - Exports
- The rework after sending back runs again under the step's role, so it gets them.
- Other projects' project layers and other repositories' layers are never given.

Code: `apps/daemon/src/service.ts` (`withMemory`, `MEMORY_STEP_ROLES`), `apps/daemon/src/memory.ts` (`taskMemoryLayers`, `existingLayerDir`, `memoryPromptLines`)

## Default skill

The default context has a skill for reading memories, `memory`. The skill describes the following.

- The locations
- How to read: open only the relevant ones from the index. Check old memories against the actual repository.
- The order to follow: the person's instructions → the context's and repository's rules → the actual repository → memories

Code: `apps/daemon/default-context/skills/memory/SKILL.md`

## Deletion by people

- The Audit tab shows the memories that audit registered (title, layer, repository, summary, contents). Memories not yet deleted have a Delete button; confirming deletes it (`POST /api/audits/memories/:id/delete`).
- People cannot register memories.
- Deleted memories show only a mark (deleted by a person, by the limit, by expiry, or after becoming context), without contents or the Delete button. A deleted memory cannot be deleted again (409).
- After deleting, sacty rewrites the layer where the memory currently lives (the destination, if the audit moved it).

Code: `apps/daemon/src/service.ts` (`deleteAuditMemory`), `apps/daemon/src/ledger-audits.ts` (`LedgerAuditService`), `apps/daemon/src/server.ts` (`createApp`), `apps/web/src/components/audit.tsx` (`TaskAuditCard`)
