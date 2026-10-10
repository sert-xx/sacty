import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { SqliteLedgerStore } from "./ledger.js";
import { createApp } from "./server.js";
import { TaskService } from "./service.js";

const home = process.env.SACTY_HOME ?? join(homedir(), ".sacty");
const port = Number(process.env.SACTY_DAEMON_PORT ?? 4710);
const token = process.env.SACTY_DAEMON_TOKEN;

if (!token) {
  console.error("SACTY_DAEMON_TOKEN is required. Start sacty with `sacty up`.");
  process.exit(1);
}

mkdirSync(home, { recursive: true });
const ledger = new SqliteLedgerStore(join(home, "sacty.db"));
const service = new TaskService(ledger);
const app = createApp(service, token);

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`[daemon] listening on http://127.0.0.1:${info.port} (data: ${home})`);
});

const shutdown = () => {
  server.close(() => {
    ledger.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
