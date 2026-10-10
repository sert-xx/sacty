import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { DockerExecutor } from "./agents/docker.js";
import { loadConfig, resolveHome } from "./config.js";
import { SqliteLedgerStore } from "./ledger.js";
import { KeychainSecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { TaskService } from "./service.js";
import { Worker } from "./worker.js";

const home = resolveHome();
const port = Number(process.env.SACTY_DAEMON_PORT ?? 4710);
const token = process.env.SACTY_DAEMON_TOKEN;

if (!token) {
  console.error("SACTY_DAEMON_TOKEN is required. Start sacty with `sacty up`.");
  process.exit(1);
}

mkdirSync(home, { recursive: true });
const ledger = new SqliteLedgerStore(join(home, "sacty.db"));
const executor = new DockerExecutor();
const service = new TaskService({
  ledger,
  config: () => loadConfig(home),
  secrets: new KeychainSecretStore(),
  executor,
  workspaceRoot: join(home, "workspaces"),
});
service.recoverInterrupted();

const status = service.status();
for (const problem of status.problems) console.warn(`[daemon] ${problem}`);

const worker = new Worker(service);
const app = createApp(service, token);

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`[daemon] listening on http://127.0.0.1:${info.port} (data: ${home})`);
  worker.start();
});

const shutdown = () => {
  worker.stop();
  executor.abortAll();
  server.close(() => {
    ledger.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
