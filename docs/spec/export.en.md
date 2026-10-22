[日本語](export.md) | **English**

# Export

sacty exports human-approved Investigation results (for investigation-only tasks), Requirements, Design, and document drafts to Confluence, Notion, and similar services. sacty has no settings per kind of destination. Instead, it has an agent do the export using the connections written as organization platforms (PF) or MCP servers.

This document also describes exporting and importing project settings.

Related ADR: [Move the Slack notification destination from project settings to the sacty settings, and send notifications of every project to one destination](../adr/20261016-0421-slack-notification-in-sacty-settings.md)

## What is exported and where

- The steps that can be exported are `investigate` (only when it is the last step), `requirements`, `design`, and `document` (`EXPORT_STEPS`).
- When the Orchestrator chooses the steps, it decides per step whether to export and where (`exports`: `to`, `via` (`platform` | `mcp`), `location`, `reason`).
  - The available connections are the host's PFs, the PFs in the project's context, the host's MCP servers, and the MCP servers in the context.
  - If there are no connections or no exportable steps, the Orchestrator decides nothing.
  - sacty does not export steps with no decision or steps for which the Orchestrator chose an unknown connection.
- sacty exports the approved version (Design includes the Test viewpoints) with the submission number and a marker line `目印：sacty-export:<task ID>:<step>` added.

Code: `packages/core/src/events.ts` (`EXPORT_STEPS`, `exportSteps`), `apps/daemon/src/service.ts` (`withExports`, `exportDestinations`), `apps/daemon/src/prompts.ts` (`buildExportDocument`, `exportMarker`)

## Running the export

- The export runs after the step is approved, before the next step and before the comment on the intake source, so that the comment can include the URL. It does not run for paused or running tasks.
- sacty runs it with that step's AI and passes only the chosen connection (role `export`).
  - With the run's token, the agent can use only the chosen PF or MCP server through the gateway. Calls to other host PFs and MCP servers get 403.
  - sacty places the content to export in `sacty-export.md` in the workspace `workspaces/_export/<run ID>` and deletes it afterward.
  - The answer is JSON under the heading `sacty-export` (`url` or `error`).
- If there is a previously exported URL, the agent updates that page instead of creating a new one. If a previous export stopped before it was recorded (only `ExportStarted` exists), the agent finds the same page by its marker and updates it.
- If the export fails (budget limit, no connection, unreadable answer, or agent failure), sacty records the reason in `OutputExported` and continues the task without stopping. If a person stops or cancels it, sacty records only the cost.
- Retrying an export: `POST /api/tasks/:id/exports/:step/retry` (only when the last export failed and is for the current approved version). Approving again exports again.
- The cost of exporting counts toward the task's cost ("Export" in the cost-per-step table).

Code: `apps/daemon/src/service.ts` (`awaitingExport`, `exportOutput`, `retryExport`), `apps/daemon/src/prompts.ts` (`buildExportPrompt`, `extractExport`, `EXPORT_FILE`), `packages/core/src/projection.ts` (`exportDue`, `canRetryExport`)

## Exporting and importing projects

- `GET /api/projects/:id/export` returns `{ sacty: "project", version: 5, project: { … } }` (`PROJECT_EXPORT_VERSION`).
  - `project` contains `name`, `targets`, `context`, `tickets`, and `sharedComposes`.
  - It does not include IDs, timestamps, or `githubAccounts` (personal settings).
  - From the web UI, it downloads as `sacty-project-<name>.json`.
- The export does not include the Slack notification destination. The destination is in the sacty settings ([Notifications](notifications.en.md)), not in the project definition.
- `POST /api/projects/import` strictly checks the same shape and saves it as a project with a new ID. Unknown fields, a different `sacty`, or a different version are errors. Before saving, it checks for conflicts with other projects. From the web UI, it reads files up to 1,000,000 bytes.
  - A `notification` in `project` is an unknown-field error (`input.unknownKeys`).
  - Version 3 and 4 files (the versions that included the notification destination) are rejected with or without it, with a message asking to export again (`input.exportVersionWithNotification`). Other version differences are `input.unsupportedVersion`. Either way, the version error is returned as the first error (the web UI shows the first error).

Code: `packages/core/src/projects.ts` (`ProjectExport`, `exportProject`, `PROJECT_EXPORT_VERSION`), `apps/daemon/src/service.ts` (`exportProject`, `importProject`, `saveProject`), `apps/web/src/app/projects/[id]/export/route.ts`, `apps/web/src/app/actions.ts` (`importProjectAction`)
