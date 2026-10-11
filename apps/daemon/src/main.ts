import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { renderMessage } from "@sacty/core";
import { DockerExecutor } from "./agents/docker.js";
import { DockerTestRunner } from "./agents/test-runner.js";
import { loadConfig, resolveHome } from "./config.js";
import { GitContextFetcher } from "./context.js";
import { GhCliAuth } from "./gh.js";
import { GitHubIssueSearch, GitHubPullRequests } from "./github.js";
import { IssueIntake } from "./intake.js";
import { SqliteLedgerStore } from "./ledger.js";
import { PullRequestWatcher } from "./pr-watcher.js";
import { SqliteProjectStore } from "./projects.js";
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
const projects = new SqliteProjectStore(join(home, "sacty.db"));
const secrets = new KeychainSecretStore();
const config = () => loadConfig(home);
const executor = new DockerExecutor();
const tests = new DockerTestRunner();
// GitHub へのアクセスは、ホストの gh のアカウントで行う（PBI-13）
const github = new GhCliAuth();
const service = new TaskService({
  ledger,
  config,
  secrets,
  projects,
  contexts: new GitContextFetcher(),
  executor,
  repos: new GitRepositoryWorkspace(),
  pulls: new GitHubPullRequests(),
  github,
  tests,
  workspaceRoot: join(home, "workspaces"),
});
service.recoverInterrupted();
service.queueWaitingSteps();

const status = service.status();
for (const problem of status.problems) console.warn(`[daemon] ${renderMessage(problem, "ja")}`);

const worker = new Worker(service);
const intake = new IssueIntake(service, new GitHubIssueSearch(), github, config);
// 成果物チェックで待っている PR を見守る（マージで承認。PBI-14a）
const prWatcher = new PullRequestWatcher(service);
const app = createApp(service, token, { intake });

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`[daemon] listening on http://127.0.0.1:${info.port} (data: ${home})`);
  worker.start();
  intake.start();
  prWatcher.start();
});

/** 後処理を待つ上限。CLIはこれより長く待ってから強制終了する。 */
const DRAIN_TIMEOUT_MS = 20_000;

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // 実行中のコンテナを止め、実行の後処理（台帳への記録、認証ファイルの書き戻し、
  // 一時ファイルの削除）が終わるのを待ってから、台帳を閉じて終了する。
  const draining = Promise.all([worker.drain(), intake.stop(), prWatcher.stop()]);
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
    projects.close();
    process.exit(0);
  });
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
