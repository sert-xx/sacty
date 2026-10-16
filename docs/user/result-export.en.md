<!-- Code: apps/daemon/src/service.ts, apps/daemon/src/prompts.ts, apps/daemon/src/platforms.ts, apps/daemon/src/host-mcp.ts -->

[日本語](result-export.md) | **English**

# Exporting results (Confluence, Notion, and so on)

You can export results that a human has approved, namely Investigation results (for Investigation-only tasks), Requirements, Design (including Test viewpoints), and document drafts, to Confluence, Notion, and similar services.

## Configure the destinations

sacty has no settings specific to each kind of destination. You configure a destination either as an organization platform (PF) (`gateway.platforms` in `config.yaml`, or
`platforms.yaml` in the context repository) or as an MCP server (`mcp.yaml` in the context repository, or `gateway.mcp_servers` in `config.yaml`); which one you
use is up to you ([Gateway](gateway.en.md), [Context repository](context.en.md)). Writing the rules for where things go in the description (`description`)
gives the Orchestrator a hint for its decision.

```yaml
gateway:
  platforms:
    confluence:
      upstream: https://wiki.example.com
      description: Confluence (put design documents under "Design" in the DEV space)
      auth: { header: Authorization, prefix: "Bearer ", secret: op://Work/Confluence/token }
      allow:
        - GET /rest/api/content/**            # find the location and pages exported earlier
        - POST /rest/api/content              # create a page
        - PUT /rest/api/content/*             # update the same page with the re-approved version
```

## How exporting works

- Whether to export, and where, is decided by the Orchestrator for each step when it chooses the steps (based on the available destinations and their descriptions, the task's content,
  the intake source, and the conventions in the project's context; it may also decide not to export). The chosen destination and the reason appear in the Activity and in the step's field
  on the task page. If no destination is available, nothing is decided.
- After a step is approved, that step's agent exports using only the chosen destination. The gateway adds the authentication, and the container receives only a per-run
  token. The URL of the exported page is shown in the Activity and on the task page, and is also included in the comment on the intake source (Issue, JIRA).
- When you approve again after Request changes, the previously exported page is updated (no new page is created). If sacty stops after exporting but before recording it, it finds
  the same page by a marker in the body and updates it.
- When the destination cannot be reached or the export fails, sacty records the reason and continues by keeping the result in sacty and commenting on the intake source. The task does not stop,
  and you can export again with "Export again" on the task page.
- The cost of exporting is included in the task's cost and appears as "Export" in the cost-per-step table.

## Related pages

- [Working with tasks](tasks.en.md)
- [Gateway](gateway.en.md)
