import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { renderMessage } from "@sacty/core";
import { SqliteActivityStore } from "./activity.js";
import { DockerExecutor } from "./agents/docker.js";
import { DockerTestRunner } from "./agents/test-runner.js";
import { loadConfig, resolveHome } from "./config.js";
import { DEFAULT_CONTEXT_DIR, GitContextFetcher } from "./context.js";
import { AiGateway } from "./gateway.js";
import { GhCliAuth } from "./gh.js";
import { GitHubIssueSearch, GitHubPullRequests } from "./github.js";
import { HostMcpServers } from "./host-mcp.js";
import { IssueIntake } from "./intake.js";
import { SlackNotifier } from "./notifier.js";
import { PlatformCredentials } from "./platforms.js";
import { PullRequestWatcher } from "./pr-watcher.js";
import { SqliteProjectStore } from "./projects.js";
import { GitRepositoryWorkspace } from "./repository.js";
import { KeychainSecretStore, OnePasswordSecretStore, ResolvingSecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { TaskService } from "./service.js";
import { DockerComposeServices } from "./services.js";
import { SqliteSettingsStore } from "./settings.js";
import { Worker } from "./worker.js";

const home = resolveHome();
const port = Number(process.env.SACTY_DAEMON_PORT ?? 4710);
const token = process.env.SACTY_DAEMON_TOKEN;

if (!token) {
  console.error("SACTY_DAEMON_TOKEN is required. Start sacty with `sacty up`.");
  process.exit(1);
}

mkdirSync(home, { recursive: true });
const activity = new SqliteActivityStore(join(home, "sacty.db"));
const projects = new SqliteProjectStore(join(home, "sacty.db"));
const settings = new SqliteSettingsStore(join(home, "sacty.db"));
const config = () => loadConfig(home);
// 秘密情報は、キーチェーンの名前か 1Password の参照（op://…。PBI-34）
const secrets = new ResolvingSecretStore(
  new KeychainSecretStore(),
  new OnePasswordSecretStore({
    account: () => {
      const c = config();
      return c.ok ? c.config.onePasswordAccount : undefined;
    },
  }),
);
const executor = new DockerExecutor();
const tests = new DockerTestRunner();
// docker compose のサービス（PBI-47）。前回、止める前にデーモンが終わって残ったサービスを片付ける
const composeServices = new DockerComposeServices();
void composeServices.cleanupAll();
// GitHub へのアクセスは、ホストの gh のアカウントで行う（PBI-13）
const github = new GhCliAuth();
// ホストのゲートウェイ（PBI-37）。リトライの上限は、リクエストごとに設定から読み直す
// 組織内 PF の API（PBI-35）。認証情報はゲートウェイの中だけに持ち、起動時にまとめて用意する
const platforms = () => {
  const c = config();
  return c.ok ? c.config.platforms : [];
};
const credentials = new PlatformCredentials({ secrets });
// ホストで動かす MCP サーバー（PBI-36）。認証の期限の前に、起動し直して再認証する
const hostMcp = new HostMcpServers({
  specs: () => {
    const c = config();
    return c.ok ? c.config.hostMcp : [];
  },
  secrets,
  log: (line) => console.log(line),
});
hostMcp.start();
const gateway = new AiGateway({
  hostMcp,
  policy: () => {
    const c = config();
    return c.ok ? c.config.gatewayRetry : undefined;
  },
  platforms,
  credentials,
});
await gateway.listen();
for (const platform of platforms()) {
  credentials.header(platform).catch((error) => {
    console.warn(
      `[daemon] internal platform ${platform.name}: ${error instanceof Error ? error.message : error}`,
    );
  });
}
const service = new TaskService({
  activity,
  config,
  secrets,
  projects,
  settings,
  contexts: new GitContextFetcher(),
  defaultContext: DEFAULT_CONTEXT_DIR,
  executor,
  repos: new GitRepositoryWorkspace(),
  pulls: new GitHubPullRequests(),
  github,
  tests,
  services: composeServices,
  workspaceRoot: join(home, "workspaces"),
  gateway,
  platformProblems: (names) => credentials.unavailable(names),
  hostMcpProblems: () => hostMcp.problems(),
  // 人間の出番を Slack に通知する（PBI-38）。リンクは、起動した画面の URL
  notifier: new SlackNotifier({
    project: (id) => projects.get(id),
    secrets,
    webUrl: process.env.SACTY_WEB_URL ?? "http://127.0.0.1:4700",
    log: (line) => console.warn(line),
  }),
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
  // 実行中のコンテナを止め、実行の後処理（作業履歴への記録、認証ファイルの書き戻し、
  // 一時ファイルの削除）が終わるのを待ってから、作業履歴を閉じて終了する。
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
  await gateway.close();
  await hostMcp.stop();
  server.close(() => {
    activity.close();
    projects.close();
    settings.close();
    process.exit(0);
  });
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
