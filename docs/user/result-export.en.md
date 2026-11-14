<!-- Code: apps/daemon/src/service.ts, apps/daemon/src/prompts.ts, apps/daemon/src/platforms.ts, apps/daemon/src/host-mcp.ts -->

[日本語](result-export.md) | **English**

# Exporting results (Confluence, Notion, and so on)

sacty can export results that a human has approved to Confluence, Notion, and similar services. It can export the following results.

- Investigation results (for Investigation-only tasks)
- Requirements
- Design (including Test viewpoints)
- Document drafts

In a Document task, when the agent wrote external documents directly as the task body instructed, those documents are the deliverable and nothing is exported ([Working with tasks](tasks.en.md#documents-and-one-off-external-work)).

To export, write the connection for the destination beforehand ([Configure the destinations](#configure-the-destinations)). The Orchestrator decides whether to export and where ([How exporting works](#how-exporting-works)).

## Configure the destinations

You configure a destination as one of the following, and which one you use is up to you ([Gateway](gateway.en.md), [Context repository](context.en.md)).

- Organization platform (PF): `gateway.platforms` in `config.yaml`, or `platforms.yaml` in the context repository
- MCP server: `mcp.yaml` in the context repository, or `gateway.mcp_servers` in `config.yaml`

sacty has no settings specific to each kind of destination. If you write the rules for where things go in the description (`description`), the Orchestrator uses them as a hint for its decision.

The following example writes Confluence as an organization platform.

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

Exporting proceeds in this order.

1. When the Orchestrator chooses the steps, it decides, for each step, whether to export and where.
2. After a step is approved, that step's agent exports using only the chosen destination.
3. sacty shows the URL of the exported page in the Activity and on the task page, and also includes it in the comment on the intake source (Issue, JIRA).

The Orchestrator decides as follows.

- It decides based on the available destinations and their descriptions, the task's content, the intake source, and the conventions in the project's context. It may also decide not to export.
- If no destination is available, it decides nothing.
- The chosen destination and the reason appear in the Activity and on the "Step settings" tab of the task details.

The gateway adds the authentication for the export. The container receives only a per-run token.

When you approve again, or when the export fails, sacty behaves as follows.

- When you approve again after Request changes, sacty updates the previously exported page (it does not create a new one). If sacty stops after exporting but before recording it, it finds the same page by a marker in the body and updates it.
- When the destination cannot be reached or the export fails, sacty records the reason, keeps the result in sacty, comments on the intake source, and goes on. The task does not stop. You can export again with "Export again" on the task page.

The cost of exporting is included in the task's cost. It appears as "Export" in the cost-per-step table.

## Related pages

- [Working with tasks](tasks.en.md)
- [Gateway](gateway.en.md)
