import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { renderMessage } from "@sacty/core";
import { SqliteActivityStore } from "./activity.js";
import { DockerExecutor } from "./agents/docker.js";
import { DockerTestRunner } from "./agents/test-runner.js";
import { GitHubCiStatus } from "./ci.js";
import { loadConfig, resolveHome } from "./config.js";
import { DEFAULT_CONTEXT_DIR, GitContextFetcher } from "./context.js";
import { ContextMcpServers } from "./context-mcp.js";
import { ALREADY_RUNNING_EXIT_CODE } from "./exit-codes.js";
import { AiGateway } from "./gateway.js";
import { GhCliAuth } from "./gh.js";
import { GitHubIssueSearch, GitHubPullRequests } from "./github.js";
import { HostMcpServers } from "./host-mcp.js";
import { HostMcpProcesses } from "./host-mcp-processes.js";
import { acquireInstanceLock, alreadyRunningMessage } from "./instance-lock.js";
import { IssueIntake } from "./intake.js";
import { SlackNotifier } from "./notifier.js";
import { OrchestratorSessionStore } from "./orchestrator-sessions.js";
import { PlatformCredentials } from "./platforms.js";
import { GitHubPullRequestTemplates } from "./pr-template.js";
import { PullRequestWatcher } from "./pr-watcher.js";
import { SqliteProjectStore } from "./projects.js";
import { GitRepositoryWorkspace } from "./repository.js";
import { KeychainSecretStore, OnePasswordSecretStore, ResolvingSecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { TaskService } from "./service.js";
import { DockerComposeServices } from "./services.js";
import { SessionLogStore } from "./session-logs.js";
import { SqliteSettingsStore } from "./settings.js";
import { cleanupSharedComposeRuns, GitSharedComposeFetcher } from "./shared-compose.js";
import { JiraTickets } from "./tickets.js";
import { Worker } from "./worker.js";

const home = resolveHome();
const port = Number(process.env.SACTY_DAEMON_PORT ?? 4710);
const token = process.env.SACTY_DAEMON_TOKEN;

if (!token) {
  console.error("SACTY_DAEMON_TOKEN is required. Start sacty with `sacty up`.");
  process.exit(1);
}

mkdirSync(home, { recursive: true });
// 同じ SACTY_HOME で、ほかのデーモンが動いていれば、データを触る起動の処理（作業履歴を開く・片付け・中断の回復・listen
// など）に入る前に終わる（PBI-79）。ロックは OS が持つので、前のデーモンが突然落ちても、次の起動を妨げない
const locked = acquireInstanceLock(home, `http://127.0.0.1:${port}`);
if (!locked.ok) {
  console.error(alreadyRunningMessage(home, locked.owner));
  process.exit(ALREADY_RUNNING_EXIT_CODE);
}
const instanceLock = locked.lock;
const activity = new SqliteActivityStore(join(home, "sacty.db"));
// 「PR作成」の工程（pr）を前提にした古いタスクの記録は、読めないので捨てる（PBI-110。互換の層は作らない）
const purged = activity.purgeLegacyPrStepTasks();
if (purged.length > 0) {
  console.log(
    `[daemon] 「PR作成」の工程を含む古いタスク ${purged.length} 件を作業履歴から消しました（処理中のものを含む）：${purged.join(", ")}`,
  );
}
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
// docker compose のサービス（PBI-47）。前回、止める前にデーモンが終わって残ったサービスを片付ける（起動したデーモンが
// 動いているもの、つまりほかの sacty が使っているものは止めない。PBI-78 レビュー指摘）
const composeServices = new DockerComposeServices();
void composeServices.cleanupAll();
// 共用の compose（PBI-70）。リポジトリのキャッシュは残し、前回の実行ごとの取得は消す
const workspaceRoot = join(home, "workspaces");
cleanupSharedComposeRuns(workspaceRoot);
// GitHub へのアクセスは、ホストの gh のアカウントで行う（PBI-13）
const github = new GhCliAuth();
// ホストのゲートウェイ（PBI-37）。リトライの上限は、リクエストごとに設定から読み直す
// 組織内 PF の API（PBI-35）。認証情報はゲートウェイの中だけに持ち、起動時にまとめて用意する
const platforms = () => {
  const c = config();
  return c.ok ? c.config.platforms : [];
};
const credentials = new PlatformCredentials({ secrets });
// チケット（JIRA など）の検索とコメント。接続先と認証は gateway.platforms のもの（PBI-52）
const tickets = new JiraTickets({ credentials });
// ホストの MCP サーバーのプロセス（PBI-78）。前回、止める前にデーモンが落ちて残ったもの（記録と PID・開始時刻が
// 一致するものだけ。記録を書いたデーモンが動いているもの＝同じ SACTY_HOME のほかの sacty のものは止めない）を、新しく
// 起動する前に片付ける。デーモンが例外などで終わるときも、グループに SIGTERM を送る
const hostMcpProcesses = new HostMcpProcesses(join(home, "host-mcp", "processes"), {
  log: (line) => console.log(line),
});
await hostMcpProcesses.cleanup();
process.on("exit", () => hostMcpProcesses.signalAllSync());
// ホストで動かす MCP サーバー（PBI-36）。認証の期限の前に、起動し直して再認証する
const hostMcp = new HostMcpServers({
  specs: () => {
    const c = config();
    return c.ok ? c.config.hostMcp : [];
  },
  secrets,
  processes: hostMcpProcesses,
  log: (line) => console.log(line),
});
// コンテキストの mcp.yaml の command の MCP サーバーも、ホストで起動してゲートウェイ経由にする（PBI-84）。プロセスの
// 記録・片付けは、ホストの MCP サーバーと同じもの（前回の残りは、上の片付けで止めてある。層の写しは start で消す）
const contextMcp = new ContextMcpServers({
  root: join(home, "context-mcp"),
  secrets,
  processes: hostMcpProcesses,
  log: (line) => console.log(line),
});
const gateway = new AiGateway({
  hostMcp,
  contextHostMcp: contextMcp,
  policy: () => {
    const c = config();
    return c.ok ? c.config.gatewayRetry : undefined;
  },
  platforms,
  credentials,
});
await gateway.listen();
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
  templates: new GitHubPullRequestTemplates(),
  // マージの後の CI/CD の状態（PBI-89）
  ci: new GitHubCiStatus(),
  github,
  tests,
  services: composeServices,
  sharedComposes: new GitSharedComposeFetcher(join(home, "cache", "shared-compose")),
  tickets,
  workspaceRoot,
  // エージェントの実行ごとのセッションログ（PBI-62）。中止の掃除では消さない（監査に使うため）
  sessionLogs: new SessionLogStore(join(home, "runs")),
  // タスクごとのオーケストレーターのセッション（PBI-67）。台帳が正本で、これは使い回すためのキャッシュ
  orchestratorSessions: new OrchestratorSessionStore(join(home, "sessions")),
  gateway,
  platformProblems: (names) => credentials.unavailable(names),
  hostMcpProblems: () => hostMcp.problems(),
  // 実行の前に、使うホストの MCP サーバーを設定と突き合わせ、足したものは起動を待つ（PBI-77）
  hostMcpReady: (names) => hostMcp.ready(names),
  contextMcp,
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
const intake = new IssueIntake(service, new GitHubIssueSearch(), github, config, Date.now, tickets);
// 承認待ちの PR（実装・要求要件・設計）を見守る（マージで承認。PBI-14a）
const prWatcher = new PullRequestWatcher(service);
const app = createApp(service, token, { intake });

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`[daemon] listening on http://127.0.0.1:${info.port} (data: ${home})`);
  // 使う秘密情報をまとめて取り出してから（1Password の認証は起動のときの1回。PBI-48）、タスクの実行と取り込みを始める
  void service
    .prefetchSecrets()
    .then(({ total, problems }) => {
      if (total > 0) {
        console.log(
          `[daemon] 秘密情報を取り出しました（${total - problems.length}/${total} 件）。`,
        );
      }
      for (const problem of problems) console.warn(`[daemon] ${renderMessage(problem, "ja")}`);
    })
    .catch((error: unknown) =>
      console.warn("[daemon] 秘密情報をまとめて取り出せませんでした：", error),
    )
    .finally(() => {
      // 秘密情報を使うホストの MCP サーバーの起動と、組織内 PF の認証の用意も、まとめて取り出した後にする
      // （先に始めると、それぞれが個別に 1Password に問い合わせるため。PBI-48 レビュー指摘）
      hostMcp.start();
      contextMcp.start();
      for (const platform of platforms()) {
        credentials.header(platform).catch((error) => {
          console.warn(
            `[daemon] internal platform ${platform.name}: ${error instanceof Error ? error.message : error}`,
          );
        });
      }
      worker.start();
      intake.start();
      prWatcher.start();
    });
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
  // ホストの MCP サーバーは、実行中のコンテナを止めたら使わないので、後片付けを待たずに止め始める（後片付けが長引いて、
  // CLI に強制終了されても残らないように。PBI-78）
  const stoppingHostMcp = Promise.all([hostMcp.stop(), contextMcp.stop()]);
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
  await stoppingHostMcp;
  server.close(() => {
    activity.close();
    projects.close();
    settings.close();
    instanceLock.release();
    process.exit(0);
  });
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
