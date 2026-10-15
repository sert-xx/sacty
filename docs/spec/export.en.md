[日本語](export.md) | **English**

# Export

Exports human-approved Investigation results (for investigation-only tasks), Requirements, and Design to Confluence, Notion, and similar services. sacty has no
settings per kind of destination; it has an agent do the export using the connections written as organization platforms (PF) or MCP servers. Exporting and importing
project settings are also described in this document.

Related ADR: [Do not include Slack mentions (targets and kinds) in project exports, and reject version 3 files, which included them, with the reason](../adr/20261015-0850-export-without-mentions.md)

## What is exported and where

- The steps that can be exported are `investigate` (only when it is the last step), `requirements`, and `design` (`EXPORT_STEPS`).
- Whether to export and where are decided by the Orchestrator per step when it chooses the steps (`exports`: `to`, `via` (`platform` | `mcp`),
  `location`, `reason`). The available connections are the host's PFs, the PFs in the project's context, the host's MCP servers, and the MCP servers in the context. If there are no connections or no
  exportable steps, nothing is decided. Steps with no decision, or for which an unknown connection was chosen, are not exported.
- What is exported is the approved version (Design includes the Test viewpoints), with the submission number and a marker line `目印：sacty-export:<task ID>:<step>` added.

Code: `packages/core/src/events.ts` (`EXPORT_STEPS`, `exportSteps`), `apps/daemon/src/service.ts` (`withExports`, `exportDestinations`), `apps/daemon/src/prompts.ts` (`buildExportDocument`, `exportMarker`)

## Running the export

- It runs after the step is approved, before the next step and before the comment on the intake source (so that the comment can include the URL). It does not run for paused or running tasks.
- It runs with that step's AI, passing only the chosen connection (role `export`). The content to export is placed in `sacty-export.md` in the workspace `workspaces/_export/<run ID>`,
  which is deleted afterward. The answer is JSON under the heading `sacty-export` (`url` or `error`).
- If there is a previously exported URL, the agent updates that page (it does not create a new one). If a previous export stopped before it was recorded (only `ExportStarted` exists),
  the agent finds the same page by its marker and updates it.
- If the export fails (budget limit, no connection, unreadable answer, or agent failure), the reason is recorded in `OutputExported` and the task continues
  without stopping. If a person stops or cancels it, only the cost is recorded.
- Retrying an export: `POST /api/tasks/:id/exports/:step/retry` (only when the last export failed and is for the current approved version). Approving again exports again.
- The cost of exporting counts toward the task's cost ("Export" in the cost-per-step table).

Code: `apps/daemon/src/service.ts` (`awaitingExport`, `exportOutput`, `retryExport`), `apps/daemon/src/prompts.ts` (`buildExportPrompt`, `extractExport`, `EXPORT_FILE`), `packages/core/src/projection.ts` (`exportDue`, `canRetryExport`)

## Exporting and importing projects

- `GET /api/projects/:id/export` returns `{ sacty: "project", version: 4, project: { … } }` (`PROJECT_EXPORT_VERSION`). `project` contains
  `name`, `targets`, `context`, `notification` (secrets only as references), `tickets`, `sharedComposes`, and `deploymentWatch` (only when `true`). IDs, timestamps, and
  `githubAccounts` (personal settings) are not included. From the web UI, it downloads as `sacty-project-<name>.json`.
- `notification` does not include Slack mentions (`mention`). The targets (`targets`) differ per person and environment, and kinds (`kinds`) without targets
  mean nothing, so neither is included. The destination, channel, language, and secret references are included.
- `POST /api/projects/import` strictly checks the same shape (unknown fields, a different `sacty`, or a different version are errors) and saves it as a project with a new ID
  (checking for conflicts with other projects before saving). From the web UI, it reads files up to 1,000,000 bytes.
  - A `mention` in the notification destination is an unknown-field error (`input.unknownKeys`). The imported project has no mentions; set both the targets and the kinds again in
    the project settings (when added, the kinds default to `approval`, `escalation`, and `paused`).
  - Version 3 files (the version that included mentions) are rejected with or without mentions, with a message asking to export again (`input.exportVersionWithMentions`).
    Other version differences are `input.unsupportedVersion`. Either way, the version error is returned as the first error (the web UI shows the first error).

Code: `packages/core/src/projects.ts` (`ProjectExport`, `ExportNotification`, `exportProject`, `withoutMention`, `PROJECT_EXPORT_VERSION`), `apps/daemon/src/service.ts` (`exportProject`, `importProject`, `saveProject`), `apps/web/src/app/projects/[id]/export/route.ts`, `apps/web/src/app/actions.ts` (`importProjectAction`)
