import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { DockerExecutor } from "./agents/docker.js";
import { DockerTestRunner } from "./agents/test-runner.js";
import { loadConfig, resolveHome } from "./config.js";
import { GitHubPullRequests } from "./github.js";
import { SqliteLedgerStore } from "./ledger.js";
import { GitRepositoryWorkspace } from "./repository.js";
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
const tests = new DockerTestRunner();
const service = new TaskService({
  ledger,
  config: () => loadConfig(home),
  secrets: new KeychainSecretStore(),
  executor,
  repos: new GitRepositoryWorkspace(),
  pulls: new GitHubPullRequests(),
  tests,
  workspaceRoot: join(home, "workspaces"),
});
service.recoverInterrupted();
service.queueWaitingSteps();

const status = service.status();
for (const problem of status.problems) console.warn(`[daemon] ${problem}`);

const worker = new Worker(service);
const app = createApp(service, token);

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`[daemon] listening on http://127.0.0.1:${info.port} (data: ${home})`);
  worker.start();
});

/** 後処理を待つ上限。CLIはこれより長く待ってから強制終了する。 */
const DRAIN_TIMEOUT_MS = 20_000;

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // 実行中のコンテナを止め、実行の後処理（台帳への記録、認証ファイルの書き戻し、
  // 一時ファイルの削除）が終わるのを待ってから、台帳を閉じて終了する。
  const draining = worker.drain();
  executor.abortAll();
  tests.abortAll();
  const timedOut = await Promise.race([
    draining.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), DRAIN_TIMEOUT_MS).unref()),
  ]);
  if (timedOut) {
    console.warn("[daemon] 実行中の処理の後片付けが時間内に終わりませんでした。");
  }
  server.close(() => {
    ledger.close();
    process.exit(0);
  });
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
