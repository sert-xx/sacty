[日本語](memory.md) | **English**

# Memory

The audit of a completed task registers knowledge that will help later tasks as memories. Step agents read the memories of the task's
project and target repository, opening only the relevant ones from the index. Only the audit registers memories; people can delete wrong ones.

Related ADR: [監査が登録したメモリーを、作業履歴を正本にして、スキルの索引の形で書き出す](../adr/20261018-0130-audit-memory.md)

## Layers and locations

- There are two layers, project and repository (there is no global layer). Both live under `SACTY_HOME/memory`.

| Layer | Location | Contents |
| --- | --- | --- |
| Project | `memory/projects/<project ID>/` | Knowledge from that project's tasks |
| Repository | `memory/repos/<host>/<owner>/<name>/` | Knowledge about the repository itself. Kept outside projects, so it stays in use after project settings change |

- The repository layer's key is the GitHub repository URL without `.git`, lowercased (clone URLs and the SSH form are also read). Repositories
  that are not on GitHub (local paths and so on) get no repository layer.
- Names that cannot be used as a path segment (for example, ones containing `..`) become a hash (`_` plus the first 16 characters of SHA-256).
- Each layer is an index, `SKILL.md`, plus one file per memory, `references/<memory ID>.md`.
  - Each index line is only `- [title](references/<ID>.md)：summary（有効な最終利用日：YYYY-MM-DD）`. The contents are not in the index.
  - A memory file holds the title, summary, last useful date, registration date, and the contents (Markdown).
  - The last useful date is the date (UTC) of the registration time.

Code: `apps/daemon/src/memory.ts` (`memoryLayerDir`, `repositoryMemoryKey`, `renderMemoryIndex`, `renderMemoryReference`, `indexLine`)

## Source of truth and writing

- The activity log is the source of truth. Registrations are recorded in the deep-dive result (`memories` of `AuditDeepDived`), deletions in
  `AuditMemoryDeleted` (`memoryId`, `reason`). Both are appended to the activity log of the audited task that registered the memory. `reason` is
  `person` (a person deleted it) or `capacity` (the count limit).
- Only the daemon writes the files. After recording a registration or deletion, it rewrites that layer from the activity log. A layer with no
  memories left is removed with its directory.
  - The directory is not replaced; each file is written to a temporary file in the same directory and then renamed over the old one (so a running
    container keeps its mount and never reads a half-written file). Files whose contents are unchanged are not written.
  - If writing fails, the record remains and a warning is printed.
- At startup, the daemon removes memories over the count limit, then rewrites every layer to match the activity log. Directories of layers with
  no records are removed (this repairs a stop between recording and writing).
- With no place to write (`memoryRoot`), memories are not written and the deep dive is not asked to register any.

Code: `apps/daemon/src/memory.ts` (`liveMemories`, `writeMemoryLayer`, `syncMemoryLayers`), `apps/daemon/src/service.ts` (`writeMemories`, `syncMemories`),
`packages/core/src/events.ts` (`AuditMemoryRecord`, `MEMORY_DELETE_REASONS`), `packages/core/src/projection.ts` (`TaskAuditMemory`)

## Registration by the audit

- The deep-dive prompt includes the existing memories of the task's project and target repository (ID, layer, title, summary, and where to read
  the contents) and the registration rules.
  - Register only concrete knowledge that will also help the next task of the same kind. Do not register circumstances of this task alone or
    one-off events.
  - If the knowledge matches an existing memory, put its ID in `sameAs`; nothing is registered.
  - `scope` is `repository` for things about the repository itself (build, tests, conventions, structure), and `project` for things specific to
    the project or context. `repository` memories must not contain names or circumstances specific to a project, organization, or context. With
    no GitHub target repository, only `project` is allowed.
  - No secrets or personal information.
- The output's `memories` are read: at most 2 per deep dive (`AUDIT_MAX_MEMORIES`). The title (200 characters) and summary (300 characters) are
  made single-line; the contents are capped at 4000 characters. Items missing a title, summary, or contents, items whose `sameAs` is an existing
  ID, and `repository` items without a target repository are dropped. sacty sets the `repository` destination to the target repository (the
  output's destination is not used).
- Like other audit output, secrets are redacted before recording. The same redaction is also applied to the title, summary, and contents after
  decoding the JSON and before trimming, joining into one line, and truncation (values containing quotes, backslashes, or newlines are escaped in the JSON string and would not
  match there). sacty assigns the IDs.
- Deep dives of the same project run one at a time, so duplicates in the project layer are checked against the list at registration time. The
  repository layer can receive a registration from another project's deep dive at the same time; then the same knowledge may end up as two memories.
- Each layer holds at most 30 memories (`MEMORY_MAX_PER_LAYER`). When a registration exceeds it, the memories with the oldest last useful date
  (then the oldest registration) are deleted with `capacity`.

Code: `apps/daemon/src/audit-prompts.ts` (`buildAuditDivePrompt`, `extractAuditDive`, `AUDIT_MAX_MEMORIES`), `apps/daemon/src/service.ts` (`knownMemories`, `trimMemories`, `runAuditAgent`),
`apps/daemon/src/memory.ts` (`overCapacity`, `MEMORY_MAX_PER_LAYER`)

## Giving memories to agents

- Runs of steps (except the integration review) get the task's project layer at `/sacty-memory/project` and the
  target repository's layer at `/sacty-memory/repository`, mounted read-only. Layers without an index are not mounted. For Claude Code, they are
  added to the readable places with `--add-dir`.
- When something is mounted, reading instructions are added at the start of the prompt: read the index and open only the relevant files under
  `references/`. When a memory conflicts with the person's instructions, the context's rules and skills, or the target repository's AGENTS.md and
  so on, follow those instead.
- The audit (survey and deep dive) gets the same mounts (to check for duplicates), without the reading instructions.
- The Goal Guardian (change-request judgement, final review, integration review, and judging where to send PR remarks back (role `rework`)),
  the orchestrator, question answers, and exports get none. The rework after sending back runs again under the step's role, so it gets them.
- Other projects' project layers and other repositories' layers are never given.

Code: `apps/daemon/src/service.ts` (`withMemory`, `MEMORY_STEP_ROLES`), `apps/daemon/src/memory.ts` (`taskMemoryLayers`, `existingLayerDir`, `memoryPromptLines`)

## Default skill

The default context has a skill for reading memories, `memory`. It describes the locations, how to read (open only the relevant ones from the
index; check old memories against the actual repository), and the order to follow (the person's instructions → the context's and repository's
rules → the actual repository → memories).

Code: `apps/daemon/default-context/skills/memory/SKILL.md`

## Deletion by people

- The audit card shows the memories that audit registered (title, layer, repository, summary, contents). Memories not yet deleted have a Delete
  button; confirming deletes it (`POST /api/audits/memories/:id/delete`). People cannot register memories.
- Deleted memories show only a mark (deleted by a person, or deleted by the limit), without contents or the Delete button. A deleted memory cannot
  be deleted again (409).

Code: `apps/daemon/src/service.ts` (`deleteAuditMemory`), `apps/daemon/src/ledger-audits.ts` (`LedgerAuditService`), `apps/daemon/src/server.ts` (`createApp`),
`apps/web/src/components/audit.tsx` (`TaskAuditCard`)
