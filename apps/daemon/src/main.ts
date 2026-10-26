import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { renderMessage } from "@sacty/core";
import { purgeLegacyTasksAtStartup, SqliteActivityStore } from "./activity.js";
import { DockerExecutor } from "./agents/docker.js";
import { MockAuditService } from "./audits.js";
import { GitHubCiStatus } from "./ci.js";
import { loadConfig, resolveHome } from "./config.js";
import { DEFAULT_CONTEXT_DIR, GitContextFetcher } from "./context.js";
import { ContextMcpServers } from "./context-mcp.js";
import { ALREADY_RUNNING_EXIT_CODE, FORCE_STOP_SIGNAL } from "./exit-codes.js";
import { stopFetchProcessesSync } from "./fetch-processes.js";
import { AiGateway } from "./gateway.js";
import { GhCliAuth } from "./gh.js";
import { GitHubIssueSearch, GitHubPullRequests } from "./github.js";
import { HostMcpServers } from "./host-mcp.js";
import { HostMcpProcesses } from "./host-mcp-processes.js";
import {
  ImagePresenceChecker,
  imageTargets,
  inspectImage,
  pingDocker,
  startImagePresenceCheck,
} from "./image-presence.js";
import { acquireInstanceLock, alreadyRunningMessage } from "./instance-lock.js";
import { IssueIntake } from "./intake.js";
import { LedgerAuditService } from "./ledger-audits.js";
import { startMemoryCleanup } from "./memory.js";
import { SlackNotifier } from "./notifier.js";
import { OrchestratorSessionStore } from "./orchestrator-sessions.js";
import { PlatformCredentials } from "./platforms.js";
import { GitHubPullRequestTemplates } from "./pr-template.js";
import { PullRequestWatcher } from "./pr-watcher.js";
import { SqliteProjectStore } from "./projects.js";
import { GitRepositoryWorkspace } from "./repository.js";
import { ScheduledTasks, ScheduleRunner, SqliteScheduleStore } from "./schedules.js";
import { KeychainSecretStore, OnePasswordSecretStore, ResolvingSecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { TaskService } from "./service.js";
import { DockerComposeServices } from "./services.js";
import { SessionLogStore } from "./session-logs.js";
import { SqliteSettingsStore } from "./settings.js";
import { cleanupSharedComposeRuns, GitSharedComposeFetcher } from "./shared-compose.js";
import { waitNamed } from "./shutdown-report.js";
import { JiraTickets } from "./tickets.js";
import { packageVersion, startUpdateCheck, UpdateChecker } from "./update-check.js";
import { Worker } from "./worker.js";
import { runningContainerMounts, startAfterCleanup } from "./workspace-cleanup.js";

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
// 「PR作成」の工程（pr）を前提にした古いタスクの記録は、読めないので捨てる（PBI-110。互換の層は作らない）。
// 設定（config.yaml）に誤りがある間は消さずに、起動をやめる（古い step_agents.pr を直す前に、処理中のタスクを失わないように）
const legacy = purgeLegacyTasksAtStartup(activity, () => loadConfig(home));
if ("blocked" in legacy) {
  const problem = legacy.blocked.problem;
  console.error(
    `[daemon] 「PR作成」の工程を含む古いタスクが ${legacy.blocked.tasks.length} 件あります。設定ファイルの誤りを直すまで、消さずに起動をやめます。\n` +
      `[daemon] ${renderMessage(problem, "ja")}\n[daemon] ${renderMessage(problem, "en")}`,
  );
  activity.close();
  process.exit(1);
}
if (legacy.purged.length > 0) {
  console.log(
    `[daemon] 「PR作成」の工程を含む古いタスク ${legacy.purged.length} 件を作業履歴から消しました（処理中のものを含む）：${legacy.purged.join(", ")}`,
  );
}
const projects = new SqliteProjectStore(join(home, "sacty.db"));
const settings = new SqliteSettingsStore(join(home, "sacty.db"));
const scheduleStore = new SqliteScheduleStore(join(home, "sacty.db"));
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
  // GitHub の読み取りの中継は、プロジェクトの gh のアカウントのトークンで行う（常に有効）
  githubToken: (host, account) => github.token(host, account),
});
await gateway.listen();
// 監査の画面をモックで確かめるとき（SACTY_AUDIT_MOCK=1）は、実際の監査を動かさない（PBI-124・PBI-125）
const auditMock = process.env.SACTY_AUDIT_MOCK === "1";
// sacty の最新版の確かめ（PBI-135・PBI-147）。GitHub Releases の最新の版と比べる。設定を読めなければ確かめる（既定は ON）
const updates = new UpdateChecker({
  localVersion: () => packageVersion(),
  enabled: () => {
    const c = config();
    return c.ok ? c.config.updateCheck : true;
  },
});
// Docker が動いているか・エージェントのイメージが手元にあるか（PBI-148）。起動のときと1分ごとに確かめ、端末と画面で知らせる
const images = new ImagePresenceChecker({
  targets: () => imageTargets(config()),
  ping: (signal) => pingDocker({ signal }),
  inspect: (image, signal) => inspectImage(image, { signal }),
});
const service = new TaskService({
  activity,
  // 完了したタスクを監査する（PBI-125）
  audit: !auditMock,
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
  services: composeServices,
  sharedComposes: new GitSharedComposeFetcher(join(home, "cache", "shared-compose")),
  tickets,
  workspaceRoot,
  // 作業領域を消す前に、動いているコンテナがマウントしていないかを確かめる（PBI-157）
  containerMounts: () => runningContainerMounts(),
  // エージェントの実行ごとのセッションログ（PBI-62）。中止の掃除では消さない（監査に使うため）
  sessionLogs: new SessionLogStore(join(home, "runs")),
  // タスクごとのオーケストレーターのセッション（PBI-67）。台帳が正本で、これは使い回すためのキャッシュ
  orchestratorSessions: new OrchestratorSessionStore(join(home, "sessions")),
  // 監査が登録したメモリーの書き出し先（PBI-126）。正本は作業履歴
  memoryRoot: join(home, "memory"),
  gateway,
  platformProblems: (names) => credentials.unavailable(names),
  hostMcpProblems: () => hostMcp.problems(),
  imageProblems: () => images.problems(),
  // 実行の前に、使うホストの MCP サーバーを設定と突き合わせ、足したものは起動を待つ（PBI-77）
  hostMcpReady: (names) => hostMcp.ready(names),
  contextMcp,
  update: () => updates.status(),
  // 人間の出番を Slack に通知する（PBI-38）。リンクは、起動した画面の URL
  notifier: new SlackNotifier({
    // 通知先は sacty の設定（すべてのプロジェクトで共通。PBI-115）。本文にはタスクのプロジェクトの名前を入れる
    notification: () => settings.get().notification,
    project: (id) => projects.get(id),
    secrets,
    webUrl: process.env.SACTY_WEB_URL ?? "http://127.0.0.1:4700",
    log: (line) => console.warn(line),
  }),
});
service.recoverInterrupted();
// 前回、片付ける前にデーモンが終わって残った実行ごとの一時領域と、もう使わない完了したタスク・どのタスクのものでもない
// 作業領域を消す（PBI-157）。API の待ち受けは待たせず（sacty up の起動の確かめが時間切れにならないように）、ワーカーなどは
// 消し終えてから始める。消せなくても起動は続ける
const workspaceCleanup = service
  .cleanupWorkspacesAtStartup()
  .then((removed) => {
    if (removed > 0) console.log(`[daemon] 残っていた作業領域を ${removed} 件消しました。`);
  })
  .catch((error: unknown) => {
    console.warn("[daemon] 残っている作業領域を片付けられませんでした：", error);
  });
// 採用を記録したが、作る前に止まった監査の改修のタスクを作る（PBI-125）
service.resumeAuditFixTasks();
// 監査が登録したメモリーを、作業履歴に合わせて書き直す（PBI-126）。残す日数を過ぎたものも消す（PBI-127）
service.syncMemories();
// 残す日数を過ぎたメモリーを、定期的に消す（PBI-127）
const stopMemoryCleanup = startMemoryCleanup(() => service.cleanupMemories());
// sacty の最新版を、起動のときと1日ごとに確かめる（PBI-135・PBI-147）
const stopUpdateCheck = startUpdateCheck(updates);
// エージェントのイメージを確かめ、最初の結果は端末にも出す（sacty up の出力。PBI-148）
const stopImageCheck = startImagePresenceCheck(images, (problems) => {
  for (const problem of problems) console.warn(`[daemon] ${renderMessage(problem, "ja")}`);
});
service.queueWaitingSteps();

const status = service.status();
for (const problem of status.problems) console.warn(`[daemon] ${renderMessage(problem, "ja")}`);

const worker = new Worker(service);
const intake = new IssueIntake(service, new GitHubIssueSearch(), github, config, Date.now, tickets);
// 承認待ちの PR（実装・要求要件・設計）を見守る（マージで承認。PBI-14a）
const prWatcher = new PullRequestWatcher(service);
// 完了したタスクの監査（PBI-125）。作業履歴の記録から作る。SACTY_AUDIT_MOCK=1 なら、モックのデータを返す（PBI-124）
const audits = auditMock
  ? new MockAuditService({
      tasks: () => service.list(),
      activity: (id: string) => service.get(id)?.activity ?? [],
      projects: () => service.listProjects(),
      defaultCapUsd: () => service.auditBudgetUsd(),
    })
  : new LedgerAuditService(service);
if (auditMock) console.warn("[daemon] 監査はモックのデータを返します（SACTY_AUDIT_MOCK=1）。");
// スケジュールタスク（決めた内容のタスクを、決めた予定で作る）。起動したときと1分ごとに、直前の予定の回を確かめる
const schedules = new ScheduledTasks({
  store: scheduleStore,
  tasks: service,
  log: (line) => console.warn(line),
});
const scheduleRunner = new ScheduleRunner(schedules);
const app = createApp(service, token, { intake, audits, schedules });

const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => {
  console.log(`[daemon] listening on http://127.0.0.1:${info.port} (data: ${home})`);
  // 使う秘密情報をまとめて取り出してから（1Password の認証は起動のときの1回。PBI-48）、タスクの実行と取り込みを始める。
  // プロジェクトのコンテキストの秘密情報も含める（コンテキストを読むのは、上限の時間まで待つ。PBI-107）
  void service
    .prefetchSecrets()
    .then(({ total, fetched, problems }) => {
      if (total > 0) {
        console.log(`[daemon] 秘密情報を取り出しました（${fetched}/${total} 件）。`);
      }
      for (const problem of problems) console.warn(`[daemon] ${renderMessage(problem, "ja")}`);
    })
    .catch((error: unknown) =>
      console.warn("[daemon] 秘密情報をまとめて取り出せませんでした：", error),
    )
    .finally(() =>
      // 残っていた作業領域を消し終えてから、タスクの実行を始める。その間に止め始めていたら、何も始めない（PBI-157）
      startAfterCleanup(workspaceCleanup, () => shuttingDown, startServices),
    );
});

/** 秘密情報をまとめて取り出し、残っていた作業領域を消し終えた後に始めるもの。 */
function startServices(): void {
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
  scheduleRunner.start();
}

/** 後処理を待つ上限。CLIはこれより長く待ってから強制終了する。 */
const DRAIN_TIMEOUT_MS = 20_000;
/** 後処理が長引いたとき、まだ終わっていない処理を表示するまでの時間。 */
const DRAIN_REPORT_MS = 3_000;

const log = (line: string) => console.log(line);
let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  // 秘密情報の取り出しのための、コンテキストの取得の git を止める（別のプロセスグループで動くので、Ctrl+C が届かない。
  // process.exit でも止めるが、後処理を待つ前に止める。PBI-107）
  stopFetchProcessesSync();
  // 作業履歴を閉じた後に、メモリーの掃除が記録しないように止める（PBI-127）
  stopMemoryCleanup();
  stopUpdateCheck();
  stopImageCheck();
  // 実行中のコンテナを止め、実行の後処理（作業履歴への記録、認証ファイルの書き戻し、
  // 一時ファイルの削除）が終わるのを待ってから、作業履歴を閉じて終了する。
  const draining = waitNamed(
    {
      実行中のタスク: worker.drain(),
      取り込み: intake.stop(),
      "PR の確認": prWatcher.stop(),
      スケジュールタスクの確認: scheduleRunner.stop(),
    },
    DRAIN_REPORT_MS,
    log,
  );
  // ホストの MCP サーバーは、実行中のコンテナを止めたら使わないので、後片付けを待たずに止め始める（後片付けが長引いて、
  // CLI に強制終了されても残らないように。PBI-78）
  const stoppingHostMcp = Promise.all([hostMcp.stop(), contextMcp.stop()]);
  // 止めるときの実行の終わりを、監査の失敗として記録しない（次の起動で、もう一度実行する。PBI-125）
  service.beginShutdown();
  executor.abortAll();
  const timedOut = await Promise.race([
    draining.then(() => false),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(true), DRAIN_TIMEOUT_MS).unref()),
  ]);
  if (timedOut) {
    console.warn("[daemon] 実行中の処理の後片付けが時間内に終わりませんでした。");
  }
  await gateway.close();
  await waitNamed({ "ホストの MCP サーバー": stoppingHostMcp }, DRAIN_REPORT_MS, log);
  server.close(() => {
    activity.close();
    projects.close();
    settings.close();
    scheduleStore.close();
    instanceLock.release();
    process.exit(0);
  });
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
// 止めている途中で、もう一度 Ctrl+C を押されたとき、CLI が送る（後片付けを待たずに終わる。exit の後処理で、ホストの
// MCP サーバーとコンテキストの取得の git は止める。中断した実行は、次の起動で回復する）。Ctrl+C では端末からの SIGINT と
// CLI からの SIGTERM が両方届くので、SIGINT を数えずに、別のシグナルにする
process.on(FORCE_STOP_SIGNAL, () => {
  console.warn("[daemon] 後片付けを待たずに止めます。");
  process.exit(1);
});
