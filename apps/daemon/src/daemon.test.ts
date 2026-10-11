import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@sacty/core";
import { message, renderMessage } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentExecutor } from "./agents/docker.js";
import type { Invocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { TestRunner, TestRunResult } from "./agents/test-runner.js";
import { type AgentConfig, type ConfigResult, loadConfig } from "./config.js";
import type { ContextFetcher, ContextRef } from "./context.js";
import { MessageError } from "./errors.js";
import type { GitHubAuth } from "./gh.js";
import type { PullRequestStatus, PullRequests } from "./github.js";
import { SqliteLedgerStore } from "./ledger.js";
import { MemoryProjectStore } from "./projects.js";
import type { RepositoryWorkspace } from "./repository.js";
import { MemorySecretStore } from "./secrets.js";
import { createApp } from "./server.js";
import { TaskService } from "./service.js";

/** 記録した文言（コードと引数）を、日本語の文にする（PBI-11）。 */
const ja = (text: unknown) => renderMessage(text, "ja");

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-test-"));
  dbPath = join(dir, "sacty.db");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: "claude-subscription",
  runtime: "claude-code",
  auth: { mode: "subscription", secret: "claude-oauth-token" },
  price_per_mtok_usd: { input: 3, cached_input: 0.3, cache_write: 3.75, output: 15 },
  price: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  ...overrides,
});

const configOf =
  (
    a: AgentConfig,
    budgetPerTaskUsd = 1,
    pullRequest: { provider: "github"; repo: string } | null = {
      provider: "github",
      repo: "acme/app",
    },
  ): (() => ConfigResult) =>
  () => ({
    ok: true,
    config: {
      image: "sacty-agent:test",
      defaultAgent: a,
      guardianAgent: a,
      budgetPerTaskUsd,
      repository: {
        url: "https://example.com/acme/app.git",
        baseBranch: "main",
        testCommand: "npm test",
        testImage: "sacty-agent:test",
        ...(pullRequest ? { pullRequest } : {}),
      },
    },
  });

/** gh の偽物。ログイン済みのアカウントごとのトークンを返す。 */
class FakeGitHub implements GitHubAuth {
  requested: string[] = [];
  constructor(private readonly tokens: Record<string, string> = { me: "ghp_secret" }) {}
  async accounts() {
    return Object.keys(this.tokens).map((login) => ({ login, active: login === "me" }));
  }
  async token(account: string) {
    this.requested.push(account);
    const token = this.tokens[account];
    if (!token) throw new MessageError(message("github.accountUnavailable", { account }));
    return token;
  }
}

/** 既定のプロジェクトに、gh のアカウント（偽物の me）を選んだプロジェクトの置き場所。 */
function projectsWithAccount(): MemoryProjectStore {
  const projects = new MemoryProjectStore();
  projects.put("default", {
    name: "デフォルト",
    sources: [],
    repositories: [],
    githubAccount: "me",
  });
  return projects;
}

/** clone の代わりに空のディレクトリを作り、決まった差分を返す偽物。 */
class FakeRepos implements RepositoryWorkspace {
  prepared: {
    dir: string;
    gitDir: string;
    url: string;
    baseBranch: string;
    authEnv?: Record<string, string>;
    recorded?: string;
  }[] = [];
  /** clone したときの、ブランチの最新のコミット。 */
  head = "base123";
  /** 記録済みの起点のコミットを取得できない（強制プッシュで消えたなど）。 */
  recordedMissing = false;
  diffText = "diff --git a/src/pay.ts b/src/pay.ts\n+export const pay = () => 1;";
  fail?: string;
  diffFail?: string;
  /** これが設定されていれば、clone を解決するまで待つ（準備中の一時停止のテスト用）。 */
  prepareGate?: Promise<void>;
  prepareStarted = Promise.withResolvers<void>();
  async prepare(
    dir: string,
    gitDir: string,
    url: string,
    baseBranch: string,
    authEnv?: Record<string, string>,
    recorded?: string,
  ) {
    if (this.fail) throw new Error(this.fail);
    if (recorded && this.recordedMissing) {
      throw new MessageError(message("git.baseCommitMissing", { commit: recorded }));
    }
    this.prepareStarted.resolve();
    if (this.prepareGate) await this.prepareGate;
    mkdirSync(dir, { recursive: true });
    mkdirSync(gitDir, { recursive: true });
    this.prepared.push({
      dir,
      gitDir,
      url,
      baseBranch,
      ...(authEnv ? { authEnv } : {}),
      ...(recorded ? { recorded } : {}),
    });
    // 用意し直すときは記録済みの起点、初めてならブランチの最新
    return { baseCommit: recorded ?? this.head };
  }
  deleted: string[] = [];
  deleteFail?: string;
  async deleteBranch(_gitDir: string, branch: string) {
    if (this.deleteFail) throw new Error(this.deleteFail);
    this.deleted.push(branch);
  }
  async diff() {
    if (this.diffFail) throw new Error(this.diffFail);
    return this.diffText;
  }
  /** 起点のコードの書き出し（要求要件・設計の工程。PBI-15）。 */
  snapshots: { gitDir: string; baseCommit: string; outDir: string }[] = [];
  snapshotFail?: string;
  async snapshot(gitDir: string, baseCommit: string, outDir: string) {
    if (this.snapshotFail) throw new Error(this.snapshotFail);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "README.md"), `base ${baseCommit}`);
    this.snapshots.push({ gitDir, baseCommit, outDir });
  }
  published: { parent: string; branch: string; message: string; date: string }[] = [];
  publishFail?: string;
  async publish(input: { parent: string; branch: string; message: string; date: string }) {
    if (this.publishFail) throw new Error(this.publishFail);
    this.published.push({
      parent: input.parent,
      branch: input.branch,
      message: input.message,
      date: input.date,
    });
    return { commit: `c${this.published.length}`.padEnd(40, "0") };
  }
}

/** リポジトリごとに決めたファイルを置く、コンテキストの取得の偽物。 */
class FakeContexts implements ContextFetcher {
  /** 取得ごとのリポジトリと、渡された git の認証の環境変数。 */
  fetched: { repo: string; authEnv?: Record<string, string> }[] = [];
  /** これが設定されていれば、取得に失敗する（エラー文に、渡されたトークンを含める）。 */
  fail?: boolean;
  constructor(private readonly repos: Record<string, Record<string, string>> = {}) {}
  async fetch(ref: ContextRef, out: string, authEnv?: Record<string, string>) {
    this.fetched.push({ repo: ref.repo, ...(authEnv ? { authEnv } : {}) });
    if (this.fail) throw new Error(`Authentication failed ${authEnv?.GIT_CONFIG_VALUE_0 ?? ""}`);
    const files = this.repos[ref.repo];
    if (!files) throw new Error("repository not found");
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(join(out, path, ".."), { recursive: true });
      writeFileSync(join(out, path), content);
    }
    return { commit: "c0ffee".padEnd(40, "0") };
  }
}

/** PRの作成を記録する偽物。 */
class FakePulls implements PullRequests {
  calls: Parameters<PullRequests["upsert"]>[0][] = [];
  fail?: string;
  /** 次に新しく作る PR の番号。 */
  nextNumber = 7;
  async upsert(input: Parameters<PullRequests["upsert"]>[0]) {
    if (this.fail) throw new Error(this.fail);
    this.calls.push(input);
    const number = input.number ?? this.nextNumber++;
    return { url: `https://github.com/acme/app/pull/${number}`, number };
  }
  closed: { repo: string; token: string; number: number }[] = [];
  closeFail?: string;
  async close(input: { repo: string; token: string; number: number }) {
    if (this.closeFail) throw new Error(this.closeFail);
    this.closed.push(input);
  }
  /** 返す PR の状態（成果物チェックの見守り。PBI-14a）。 */
  state: PullRequestStatus = { state: "open" };
  statusFail?: string;
  checked: { repo: string; token: string; number: number }[] = [];
  async status(input: { repo: string; token: string; number: number }) {
    this.checked.push(input);
    if (this.statusFail) throw new Error(this.statusFail);
    return this.state;
  }
}

/** 決まった結果を順に返す、テスト実行の偽物。 */
class FakeTests implements TestRunner {
  calls: { workspaceDir: string; command: string; image: string }[] = [];
  /** true なら、止められるまで終わらない（一時停止のテスト用）。 */
  hold = false;
  started = Promise.withResolvers<string>();
  private held = new Map<string, (r: TestRunResult) => void>();
  constructor(readonly results: TestRunResult[] = []) {}
  async run(input: { runId: string; workspaceDir: string; command: string; image: string }) {
    this.calls.push(input);
    if (this.hold) {
      this.hold = false;
      return new Promise<TestRunResult>((resolve) => {
        this.held.set(input.runId, resolve);
        this.started.resolve(input.runId);
      });
    }
    return this.results.shift() ?? { exitCode: 0, output: "ok", durationMs: 5 };
  }
  async ensureStopped() {
    return true;
  }
  kill(runId: string) {
    this.held.get(runId)?.({ exitCode: 137, output: "killed", durationMs: 1 });
    this.held.delete(runId);
  }
}

/** 決まった結果を順に返す偽物の実行器。渡された呼び出し内容も記録する。 */
/** 止められるまで終わらない実行（一時停止・中止のテスト用）。 */
const HOLD = { kind: "hold" } as const;

class FakeExecutor implements AgentExecutor {
  calls: Invocation[] = [];
  /** 実行ごとにマウントした作業領域。 */
  dirs: string[] = [];
  killed: string[] = [];
  /** 実行ごとに渡された CLAUDE.md（コンテキストが無ければ undefined）。 */
  contexts: (string | undefined)[] = [];
  /** 実行ごとに渡された MCP の設定（mcp.json。無ければ undefined）。 */
  mcpConfigs: (string | undefined)[] = [];
  /** HOLD の実行が始まったら解決する。 */
  started = Promise.withResolvers<string>();
  private held = new Map<string, (outcome: AgentOutcome) => void>();
  constructor(private readonly outcomes: (AgentOutcome | typeof HOLD)[]) {}
  /** 実行ごとに、作業領域を読み取り専用で渡したか。 */
  readOnly: boolean[] = [];
  /** 実行ごとに、作業領域にあったファイル（実行の後に消されるので、実行の間に読んでおく）。 */
  workspaceFiles: string[][] = [];
  async run({
    runId,
    invocation,
    workspaceDir,
    readOnlyWorkspace,
  }: {
    runId: string;
    invocation: Invocation;
    workspaceDir: string;
    readOnlyWorkspace?: boolean;
  }): Promise<AgentOutcome> {
    this.calls.push(invocation);
    this.dirs.push(workspaceDir);
    this.readOnly.push(readOnlyWorkspace === true);
    this.workspaceFiles.push(existsSync(workspaceDir) ? readdirSync(workspaceDir).sort() : []);
    // 渡されたコンテキスト（実行の後に消されるので、実行の間に読んでおく）
    const seed = invocation.stage?.seedDir;
    this.contexts.push(
      seed && existsSync(join(seed, "CLAUDE.md"))
        ? readFileSync(join(seed, "CLAUDE.md"), "utf8")
        : undefined,
    );
    this.mcpConfigs.push(
      seed && existsSync(join(seed, "mcp.json"))
        ? readFileSync(join(seed, "mcp.json"), "utf8")
        : undefined,
    );
    const next = this.outcomes.shift();
    if (!next) throw new Error("no more outcomes");
    if (next.kind === "hold") {
      return new Promise((resolve) => {
        this.held.set(runId, resolve);
        this.started.resolve(runId);
      });
    }
    return next;
  }
  /** false にすると、コンテナの停止を確かめられない（止まらないコンテナがある）ことにする。 */
  stops = true;
  async ensureStopped() {
    return this.stops;
  }
  kill(runId: string) {
    this.killed.push(runId);
    this.held.get(runId)?.({ kind: "failed", reason: "error", message: "container killed" });
    this.held.delete(runId);
  }
}

/** 100万出力トークン = $15 になる単価なので、output で費用を作る。 */
const completed = (outputTokens: number): AgentOutcome => ({
  kind: "completed",
  output: "# 要求要件",
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: outputTokens },
});

function makeService(
  ledger: SqliteLedgerStore,
  outcomes: AgentOutcome[] = [],
  options: {
    config?: () => ConfigResult;
    secrets?: Record<string, string>;
    repos?: FakeRepos;
    tests?: FakeTests;
    pulls?: FakePulls;
    projects?: MemoryProjectStore;
    contexts?: ContextFetcher;
    github?: FakeGitHub;
  } = {},
) {
  const executor = new FakeExecutor(outcomes);
  const repos = options.repos ?? new FakeRepos();
  const tests = options.tests ?? new FakeTests();
  const pulls = options.pulls ?? new FakePulls();
  const service = new TaskService({
    ledger,
    config: options.config ?? configOf(agent()),
    secrets: new MemorySecretStore(
      options.secrets ?? { "claude-oauth-token": "oauth-secret", "github-token": "ghp_secret" },
    ),
    executor,
    repos,
    tests,
    pulls,
    projects: options.projects ?? projectsWithAccount(),
    contexts: options.contexts ?? new FakeContexts(),
    github: options.github ?? new FakeGitHub(),
    workspaceRoot: join(dir, "workspaces"),
  });
  return { service, executor, repos, tests, pulls };
}

/** 画面が表示している（いま承認待ちの）提出回。 */
const current = (svc: TaskService, id: string) => {
  const t = svc.get(id)?.task;
  const step = t?.gate?.step ?? t?.escalation?.step ?? "requirements";
  return t?.gate?.submission ?? t?.submissions[step] ?? 1;
};

describe("台帳", () => {
  it("UPDATEとDELETEを拒否する", () => {
    const ledger = new SqliteLedgerStore(dbPath);
    makeService(ledger).service.createTicket({ title: "A" });
    expect(() => ledger.rawExecForTest("UPDATE ledger SET type = 'x'")).toThrow(/append-only/);
    expect(() => ledger.rawExecForTest("DELETE FROM ledger")).toThrow(/append-only/);
    expect(ledger.all()).toHaveLength(2);
    ledger.close();
  });

  it("再起動しても同じ状態を復元する", async () => {
    const first = new SqliteLedgerStore(dbPath);
    const { service } = makeService(first, [completed(20_000)]);
    const created = service.createTicket({ title: "A", body: "B" });
    await service.runNext(created.id);
    const before = service.get(created.id)?.task;
    first.close();

    const second = new SqliteLedgerStore(dbPath);
    expect(makeService(second).service.get(created.id)?.task).toEqual(before);
    second.close();
  });
});

describe("工程の実行と費用", () => {
  it("実行すると、費用（換算値）と出力を台帳に記録して待機に戻る", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [completed(20_000)]);
    const task = service.createTicket({ title: "決済API", body: "冪等性" });
    expect(service.queuedTaskIds()).toEqual([task.id]);

    await service.runNext(task.id);
    const { task: after, ledger: events } = service.get(task.id) ?? {};
    expect(after?.status).toBe("awaiting_approval");
    expect(after?.budget.usedUsd).toBe(0.3);
    expect(after?.budget.estimated).toBe(true);
    expect(after?.outputs.requirements).toBe("# 要求要件");
    expect(events?.map((e) => e.type)).toEqual([
      "TaskCreated",
      "StepsChosen",
      // 対象リポジトリは、タスクの開始時（最初の実行）に用意する（PBI-15）
      "RepositoryPrepared",
      "AgentRunStarted",
      "AgentRunCompleted",
      "StepSubmitted",
    ]);
    // 指示にチケットの内容が入っている
    expect(executor.calls[0]?.command.join(" ")).toContain("冪等性");
    ledger.close();
  });

  it("予算の80%で通知し、上限を超えたら次の実行の前に一時停止する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [completed(55_000), completed(70_000)]);
    const warned = service.createTicket({ title: "A" });
    const capped = service.createTicket({ title: "B" });

    await service.runNext(warned.id); // $0.825
    expect(service.get(warned.id)?.task.budget.warned).toBe(true);
    expect(service.get(warned.id)?.ledger.at(-1)?.type).toBe("BudgetWarned");

    await service.runNext(capped.id); // $1.05 → 承認待ちで止まる（人間の判断待ちなので、ここでは止めない）
    expect(service.get(capped.id)?.task.status).toBe("awaiting_approval");
    service.requestChanges(capped.id, {
      step: "requirements",
      submission: current(service, capped.id),
      comments: ["直して"],
    });
    await service.runNext(capped.id); // 実行前の判定で予算超過 → 実行しない
    expect(executor.calls).toHaveLength(2);
    expect(service.get(capped.id)?.task.status).toBe("paused");
    expect(service.get(capped.id)?.task.pausedReason).toBe("budget");
    ledger.close();
  });

  it("予算で止まったタスクは、使用済みより大きい上限でだけ再開できる", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [completed(70_000)]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["直して"],
    });
    await service.runNext(task.id); // 予算超過で止まる

    expect(() => service.resume(task.id, {})).toThrow(/新しい上限が必要/);
    expect(() => service.resume(task.id, { capUsd: 1.05 })).toThrow(/より大きい金額/);
    const resumed = service.resume(task.id, { capUsd: 3 });
    expect(resumed.status).toBe("queued"); // まだ実行していないので、実行し直す
    expect(resumed.budget.capUsd).toBe(3);
    expect(() => service.resume(task.id, { capUsd: 5 })).toThrow(
      /一時停止中のタスクではありません/,
    );
    ledger.close();
  });

  it("実行前に予算を超えていれば、実行せずに止め、上限を上げると実行し直す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 70_000 }; // $1.05
    const { service, executor } = makeService(ledger, [
      { kind: "failed", reason: "usage_limit", message: "429", usage },
      completed(1_000),
    ]);
    const task = service.createTicket({ title: "A" });

    await service.runNext(task.id); // 利用上限で失敗（費用は予算を超える）
    expect(service.resume(task.id, {}).status).toBe("queued");

    await service.runNext(task.id); // 実行前の判定で予算超過 → 実行しない
    expect(executor.calls).toHaveLength(1);
    expect(service.get(task.id)?.task.pausedReason).toBe("budget");

    // まだ実行していないので、上限を上げて再開すると実行し直す
    expect(service.resume(task.id, { capUsd: 3 }).status).toBe("queued");
    await service.runNext(task.id);
    expect(executor.calls).toHaveLength(2);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    ledger.close();
  });

  it("利用上限で失敗したら一時停止し、再開すると実行し直す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [
      { kind: "failed", reason: "usage_limit", message: "You've hit your session limit" },
      completed(1_000),
    ]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const paused = service.get(task.id)?.task;
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("usage_limit");

    expect(service.resume(task.id, {}).status).toBe("queued");
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    expect(executor.calls).toHaveLength(2);
    ledger.close();
  });

  it("秘密情報が無ければ、認証エラーとして止める（値はどこにも出さない）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [], { secrets: {} });
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const after = service.get(task.id);
    expect(after?.task.pausedReason).toBe("auth");
    expect(executor.calls).toHaveLength(0);
    const failed = after?.ledger.find((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toContain(
      "sacty secret set claude-oauth-token",
    );
    ledger.close();
  });

  it("設定が無ければ実行せず、理由を状態として返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [], {
      config: () => loadConfig(join(dir, "nope")),
    });
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.status).toBe("queued");
    expect(executor.calls).toHaveLength(0);
    expect(ja(service.status().problems[0])).toMatch(/sacty config init/);
    ledger.close();
  });

  it("デーモンの停止で中断された実行は、再起動時に失敗として記録して一時停止する", () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger);
    const task = service.createTicket({ title: "A" });
    ledger.append({
      taskId: task.id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: { runId: "r1", step: "requirements", agentId: "a", authMode: "subscription" },
          },
        },
      ],
    });
    const { service: restarted } = makeService(ledger);
    restarted.recoverInterrupted();
    const after = restarted.get(task.id)?.task;
    expect(after?.status).toBe("paused");
    expect(after?.pausedReason).toBe("error");
    expect(restarted.resume(task.id, {}).status).toBe("queued");
    ledger.close();
  });
});

describe("秘密情報と予算の通知（レビュー指摘）", () => {
  it("出力・エラー文・例外に含まれた秘密情報を、台帳に残さない", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const leaked: AgentOutcome = {
      kind: "completed",
      output: "トークンは oauth-secret です",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
    };
    const { service } = makeService(ledger, [
      leaked,
      { kind: "failed", reason: "auth", message: "401 for oauth-secret" },
    ]);
    const a = service.createTicket({ title: "A" });
    const b = service.createTicket({ title: "B" });
    await service.runNext(a.id);
    await service.runNext(b.id);

    // 例外の経路
    const throwing = new TaskService({
      ledger,
      config: configOf(agent()),
      secrets: new MemorySecretStore({ "claude-oauth-token": "oauth-secret" }),
      executor: {
        run: async () => {
          throw new Error("docker failed with oauth-secret");
        },
      },
      repos: new FakeRepos(),
      tests: new FakeTests(),
      pulls: new FakePulls(),
      projects: new MemoryProjectStore(),
      contexts: new FakeContexts(),
      workspaceRoot: join(dir, "workspaces"),
    });
    const c = throwing.createTicket({ title: "C" });
    await throwing.runNext(c.id);

    const all = JSON.stringify(ledger.all());
    expect(all).not.toContain("oauth-secret");
    expect(all).toContain("[REDACTED]");
    ledger.close();
  });

  it("失敗した実行の費用でも、80%の通知を記録する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 57_000 }; // $0.855
    const { service } = makeService(ledger, [
      { kind: "failed", reason: "usage_limit", message: "429", usage },
    ]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const after = service.get(task.id);
    expect(after?.task.budget.warned).toBe(true);
    expect(after?.task.pausedReason).toBe("usage_limit");
    expect(after?.ledger.map((e) => e.type).slice(-3)).toEqual([
      "AgentRunFailed",
      "TaskPaused",
      "BudgetWarned",
    ]);
    ledger.close();
  });

  it("1回の実行で80%未満から上限を超えた場合も、通知を記録する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [completed(70_000)]); // $1.05
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    expect(
      service
        .get(task.id)
        ?.ledger.map((e) => e.type)
        .slice(-3),
    ).toEqual(["AgentRunCompleted", "StepSubmitted", "BudgetWarned"]);
    ledger.close();
  });

  it("空のキューを処理した後でも、作成・再開したタスクを実行する（回帰）", async () => {
    const { Worker } = await import("./worker.js");
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [
      { kind: "failed", reason: "usage_limit", message: "429" },
      completed(1_000),
    ]);
    const worker = new Worker(service, 60_000);

    await worker.tick(); // 空のキュー
    const task = service.createTicket({ title: "A" });
    await worker.tick();
    expect(executor.calls).toHaveLength(1);
    expect(service.get(task.id)?.task.status).toBe("paused");

    await worker.tick(); // また空のキュー
    service.resume(task.id, {});
    await worker.tick();
    expect(executor.calls).toHaveLength(2);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    ledger.close();
  });

  it("停止時は、実行中の処理が台帳に記録されるまで待つ", async () => {
    const { Worker } = await import("./worker.js");
    const ledger = new SqliteLedgerStore(dbPath);
    let finish: (o: AgentOutcome) => void = () => {};
    const service = new TaskService({
      ledger,
      config: configOf(agent()),
      secrets: new MemorySecretStore({ "claude-oauth-token": "oauth-secret" }),
      executor: { run: () => new Promise<AgentOutcome>((resolve) => (finish = resolve)) },
      repos: new FakeRepos(),
      tests: new FakeTests(),
      pulls: new FakePulls(),
      projects: new MemoryProjectStore(),
      contexts: new FakeContexts(),
      workspaceRoot: join(dir, "workspaces"),
    });
    const task = service.createTicket({ title: "A" });
    const worker = new Worker(service, 60_000);
    void worker.tick();
    await new Promise((r) => setTimeout(r, 20));
    let drained = false;
    const draining = worker.drain().then(() => {
      drained = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(drained).toBe(false); // まだ実行中
    finish({ kind: "failed", reason: "error", message: "中断" });
    await draining;
    expect(service.get(task.id)?.task.status).toBe("paused");
    ledger.close();
  });
});

describe("承認ゲート（PBI-7）", () => {
  const draft = (text: string, responses?: { remarkId: string; text: string }[]): AgentOutcome => ({
    kind: "completed",
    output: responses
      ? `${text}\n\n\`\`\`json\n${JSON.stringify({ "sacty-responses": responses })}\n\`\`\``
      : text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });

  it("要求要件を作ると承認待ちで止まり、承認すると設計が実行対象になって待機する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [draft("# 要求要件 v1")]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const waiting = service.get(task.id)?.task;
    expect(waiting?.status).toBe("awaiting_approval");
    expect(waiting?.gate).toEqual({ step: "requirements", submission: 1 });
    expect(service.queuedTaskIds()).toEqual([]);

    const approved = service.approve(task.id, {
      step: "requirements",
      submission: current(service, task.id),
    });
    expect(approved.status).toBe("queued"); // 設計の工程を実行する
    expect(approved.steps.map((s) => [s.key, s.state]).slice(0, 2)).toEqual([
      ["requirements", "done"],
      ["design", "active"],
    ]);
    expect(() =>
      service.approve(task.id, { step: "requirements", submission: current(service, task.id) }),
    ).toThrow(/承認待ちのタスクではありません/);
    ledger.close();
  });

  it("差し戻すと指摘を累積し、前回の下書きと有効な指摘の全件を渡して実行し直す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [
      draft("# v1"),
      draft("# v2", [{ remarkId: "requirements-1-1", text: "受け入れ条件を追加した" }]),
      draft("# v3", [
        { remarkId: "requirements-2-1", text: "対象外を明記した" },
        { remarkId: "unknown-id", text: "無視される" },
      ]),
    ]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);

    expect(() =>
      service.requestChanges(task.id, {
        step: "requirements",
        submission: current(service, task.id),
        comments: ["  ", ""],
      }),
    ).toThrow(/1件以上/);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["受け入れ条件が足りない"],
    });
    expect(service.get(task.id)?.task.status).toBe("queued");
    await service.runNext(task.id);

    const second = service.get(task.id)?.task;
    expect(second?.gate?.submission).toBe(2);
    expect(second?.outputs.requirements).toBe("# v2"); // 対応のJSONは本文から除く
    expect(second?.remarks[0]?.response).toBe("受け入れ条件を追加した");
    expect(executor.calls[1]?.command.join(" ")).toContain("# v1");
    expect(executor.calls[1]?.command.join(" ")).toContain(
      "[requirements-1-1] 受け入れ条件が足りない",
    );

    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["対象外が曖昧"],
    });
    service.voidRemark(task.id, "requirements-1-1"); // 前提が変わった
    await service.runNext(task.id);
    const prompt = executor.calls[2]?.command.join(" ") ?? "";
    expect(prompt).toContain("requirements-2-1");
    expect(prompt).not.toContain("requirements-1-1"); // 無効にした指摘は渡さない
    const third = service.get(task.id)?.task;
    expect(third?.remarks.find((r) => r.id === "requirements-1-1")?.voided).toBe(true);
    expect(third?.remarks.find((r) => r.id === "requirements-2-1")?.response).toBe(
      "対象外を明記した",
    );
    ledger.close();
  });

  it("表示していた提出回が最新でなければ、承認も差し戻しも拒否する（レビュー指摘）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [draft("# v1"), draft("# v2")]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    // タブAは1回目を表示したまま、タブBで差し戻して2回目が提出された
    service.requestChanges(task.id, { step: "requirements", submission: 1, comments: ["直して"] });
    await service.runNext(task.id);

    expect(() => service.approve(task.id, { step: "requirements", submission: 1 })).toThrow(
      /最新ではありません/,
    );
    expect(() =>
      service.requestChanges(task.id, { step: "requirements", submission: 1, comments: ["x"] }),
    ).toThrow(/最新ではありません/);
    expect(service.get(task.id)?.task.steps[0]?.state).toBe("active"); // 承認されていない
    expect(service.approve(task.id, { step: "requirements", submission: 2 }).status).toBe("queued");
    ledger.close();
  });

  it("今回の提出で回答のない指摘は、前回の対応文を残さず未回答にする（レビュー指摘）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [
      draft("# v1"),
      draft("# v2", [{ remarkId: "requirements-1-1", text: "v2で対応しました" }]),
      draft("# v3", [{ remarkId: "requirements-2-1", text: "Bに対応" }]),
    ]);
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    service.requestChanges(task.id, { step: "requirements", submission: 1, comments: ["A"] });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.remarks[0]).toMatchObject({
      response: "v2で対応しました",
      respondedIn: 2,
    });

    service.requestChanges(task.id, { step: "requirements", submission: 2, comments: ["B"] });
    await service.runNext(task.id);
    const remarks = service.get(task.id)?.task.remarks;
    expect(remarks?.find((r) => r.id === "requirements-1-1")).toMatchObject({
      response: undefined,
      respondedIn: undefined,
    });
    expect(remarks?.find((r) => r.id === "requirements-2-1")).toMatchObject({
      response: "Bに対応",
      respondedIn: 3,
    });
    ledger.close();
  });

  it("差し戻しが上限（3回）を超えるとエスカレーションになり、続けるか承認するかを選べる", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(
      ledger,
      Array.from({ length: 5 }, (_, i) => draft(`# v${i + 1}`)),
    );
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    for (let i = 1; i <= 3; i++) {
      service.requestChanges(task.id, {
        step: "requirements",
        submission: current(service, task.id),
        comments: [`指摘${i}`],
      });
      await service.runNext(task.id);
    }
    const escalated = service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["指摘4"],
    });
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalation?.pendingRemarks.map((r) => r.text)).toEqual(["指摘4"]);

    expect(() =>
      service.requestChanges(task.id, {
        step: "requirements",
        submission: current(service, task.id),
        comments: [],
      }),
    ).toThrow(/上限（3回）/);
    const continued = service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: [],
      continueOverLimit: true,
    });
    expect(continued.status).toBe("queued");
    expect(continued.remarks.at(-1)).toMatchObject({ id: "requirements-4-1", text: "指摘4" });
    const last = service.get(task.id)?.ledger.at(-1);
    expect(last?.type === "ChangesRequested" && last.payload.overLimit).toBe(true);

    await service.runNext(task.id);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["指摘5"],
    });
    expect(service.get(task.id)?.task.status).toBe("escalated");
    expect(
      service.approve(task.id, { step: "requirements", submission: current(service, task.id) })
        .status,
    ).toBe("queued");
    ledger.close();
  });

  it("承認待ちのあいだは予算超過で止めず、次の実行の前に判定する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [completed(70_000)]); // $1.05
    const task = service.createTicket({ title: "A" });
    await service.runNext(task.id);
    const after = service.get(task.id);
    expect(after?.task.status).toBe("awaiting_approval");
    expect(after?.ledger.map((e) => e.type).slice(-3)).toEqual([
      "AgentRunCompleted",
      "StepSubmitted",
      "BudgetWarned",
    ]);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: current(service, task.id),
      comments: ["直して"],
    });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.pausedReason).toBe("budget");
    ledger.close();
  });
});

describe("設計の工程（PBI-8）", () => {
  const draft = (text: string, blocks: Record<string, unknown>[] = []): AgentOutcome => ({
    kind: "completed",
    output: [text, ...blocks.map((b) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``)].join("\n\n"),
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const viewpoints = (...titles: string[]) => ({
    "sacty-test-viewpoints": titles.map((title) => ({
      title,
      input: `${title}の入力`,
      expected: `${title}の期待結果`,
    })),
  });
  const gate = (svc: TaskService, id: string, step: "requirements" | "design") =>
    svc.approve(id, { step, submission: current(svc, id) });

  /** 要求要件を承認し、設計を1回提出したところまで進める。 */
  async function toDesignGate(outcomes: AgentOutcome[]) {
    const ledger = new SqliteLedgerStore(dbPath);
    const made = makeService(ledger, [draft("# 要求要件 v1"), ...outcomes]);
    const task = made.service.createTicket({ title: "決済API", body: "二重処理を防ぐ" });
    await made.service.runNext(task.id);
    gate(made.service, task.id, "requirements");
    await made.service.runNext(task.id);
    return { ledger, ...made, id: task.id };
  }

  it("承認済みの要求要件から設計とテスト観点を作り、承認ゲートで止まる", async () => {
    const { ledger, service, executor, id } = await toDesignGate([
      draft("# 設計 v1", [
        {
          "sacty-test-viewpoints": [
            { title: "同じキーの再送", input: "同じ冪等性キーで2回送る", expected: "処理は1回" },
            { title: "期待結果が無い", input: "x" }, // 項目が欠けたものは除く
            { title: " ", input: "x", expected: "y" },
          ],
        },
      ]),
    ]);
    const prompt = executor.calls[1]?.command.join(" ") ?? "";
    expect(prompt).toContain("--- 承認済みの要求要件 ---\n# 要求要件 v1");
    expect(prompt).toContain("sacty-test-viewpoints");

    const task = service.get(id)?.task;
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.gate).toEqual({ step: "design", submission: 1 });
    expect(task?.outputs.design).toBe("# 設計 v1"); // テスト観点のJSONは本文から除く
    expect(task?.testViewpoints).toEqual([
      {
        id: "TV-1",
        title: "同じキーの再送",
        input: "同じ冪等性キーで2回送る",
        expected: "処理は1回",
      },
    ]);

    const approved = gate(service, id, "design");
    expect(approved.status).toBe("queued"); // 実装の工程を実行する
    expect(approved.steps.map((s) => s.state)).toEqual(["done", "done", "active", "todo"]);
    expect(approved.approved.design).toMatchObject({
      submission: 1,
      output: "# 設計 v1",
      testViewpoints: [{ id: "TV-1" }],
    });
    expect(approved.approved.requirements?.output).toBe("# 要求要件 v1");
    ledger.close();
  });

  it("設計を差し戻すと、承認済みの要求要件はそのままで設計だけをやり直す", async () => {
    const { ledger, service, executor, id } = await toDesignGate([
      draft("# 設計 v1", [viewpoints("A")]),
      draft("# 設計 v2", [
        viewpoints("A", "B"),
        { "sacty-responses": [{ remarkId: "design-1-1", text: "異常系を足した" }] },
      ]),
    ]);
    const sent = service.requestChanges(id, {
      step: "design",
      submission: current(service, id),
      target: "design",
      comments: ["異常系のテスト観点が無い"],
    });
    expect(sent.status).toBe("queued");
    expect(sent.approved.requirements?.output).toBe("# 要求要件 v1");
    await service.runNext(id);

    const prompt = executor.calls[2]?.command.join(" ") ?? "";
    expect(prompt).toContain("# 設計 v1"); // 前回の下書き
    // 前回のテスト観点も、IDつきで全項目を渡す（指摘が TV-n を指しても分かるように。レビュー指摘）
    expect(prompt).toContain("- [TV-1] A\n  - 入力：Aの入力\n  - 期待結果：Aの期待結果");
    expect(prompt).toContain("[design-1-1] 異常系のテスト観点が無い");
    const task = service.get(id)?.task;
    expect(task?.gate).toEqual({ step: "design", submission: 2 });
    expect(task?.testViewpoints.map((v) => v.id)).toEqual(["TV-1", "TV-2"]);
    expect(task?.remarks.find((r) => r.id === "design-1-1")?.response).toBe("異常系を足した");
    expect(task?.steps[0]?.state).toBe("done");
    ledger.close();
  });

  it("要求要件へ差し戻すと承認を取り消し、再承認するまで設計を実行しない", async () => {
    const { ledger, service, executor, id } = await toDesignGate([
      draft("# 設計 v1", [viewpoints("A")]),
      draft("# 要求要件 v2", [
        { "sacty-responses": [{ remarkId: "requirements-1-1", text: "対象外を明記した" }] },
      ]),
      draft("# 設計 v2", [viewpoints("A", "B")]),
    ]);
    const sent = service.requestChanges(id, {
      step: "design",
      submission: current(service, id),
      target: "requirements",
      comments: ["対象外が決まっていない"],
    });
    expect(sent.status).toBe("queued");
    expect(sent.steps.map((s) => s.state)).toEqual(["active", "todo", "todo", "todo"]);
    expect(sent.approved).toEqual({});
    expect(sent.remarks.at(-1)).toMatchObject({ id: "requirements-1-1", step: "requirements" });

    await service.runNext(id);
    const resubmitted = service.get(id)?.task;
    expect(resubmitted?.gate).toEqual({ step: "requirements", submission: 2 }); // 再承認待ち
    expect(service.queuedTaskIds()).toEqual([]);

    gate(service, id, "requirements");
    await service.runNext(id);
    const prompt = executor.calls[3]?.command.join(" ") ?? "";
    expect(prompt).toContain("--- 承認済みの要求要件 ---\n# 要求要件 v2");
    expect(prompt).toContain("# 設計 v1"); // 前回の設計の下書きも渡す
    expect(service.get(id)?.task.gate).toEqual({ step: "design", submission: 2 });
    ledger.close();
  });

  it("差し戻せるのは、承認ゲートの工程かそれより前の承認ゲートのある工程だけ", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [draft("# 要求要件 v1")]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    for (const target of ["design", "implement"] as const) {
      expect(() =>
        service.requestChanges(id, {
          step: "requirements",
          submission: 1,
          target,
          comments: ["x"],
        }),
      ).toThrow(/差し戻せません/);
    }
    expect(service.get(id)?.task.status).toBe("awaiting_approval");
    ledger.close();
  });

  it("要求要件への差し戻しも上限を数え、エスカレーション後は同じ工程の書きかけの指摘を引き継ぐ", async () => {
    const outcomes: AgentOutcome[] = [draft("# 設計 v1", [viewpoints("A")])];
    for (let i = 2; i <= 4; i++) {
      outcomes.push(draft(`# 要求要件 v${i}`), draft(`# 設計 v${i}`, [viewpoints("A")]));
    }
    outcomes.push(draft("# 要求要件 v5"));
    const { ledger, service, id } = await toDesignGate(outcomes);
    const back = (comments: string[], extra: Record<string, unknown> = {}) =>
      service.requestChanges(id, {
        step: "design",
        submission: current(service, id),
        target: "requirements",
        comments,
        ...extra,
      });
    for (let i = 1; i <= 3; i++) {
      back([`指摘${i}`]);
      await service.runNext(id);
      gate(service, id, "requirements");
      await service.runNext(id);
    }
    const escalated = back(["指摘4"]);
    expect(escalated.status).toBe("escalated");
    expect(escalated.escalation).toMatchObject({ step: "design", target: "requirements" });

    // 上限に達していない設計へは、通常の差し戻しとして戻せる（書きかけの指摘は引き継がない）
    expect(() =>
      service.requestChanges(id, {
        step: "design",
        submission: current(service, id),
        target: "design",
        comments: [],
      }),
    ).toThrow(/1件以上/);

    const continued = back([], { continueOverLimit: true });
    expect(continued.remarks.at(-1)).toMatchObject({ id: "requirements-4-1", text: "指摘4" });
    expect(continued.steps[0]?.state).toBe("active");
    ledger.close();
  });

  it("PBI-7で承認され設計のまま待機していたタスクは、起動時に設計を実行待ちにする", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [
      draft("# 要求要件 v1"),
      draft("# 設計", [viewpoints("A")]),
    ]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    // PBI-7の台帳：設計を実行できなかったため、承認後に待機していた
    ledger.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: { type: "StepApproved", payload: { step: "requirements", next: "idle" } },
        },
      ],
    });
    const { service: restarted } = makeService(ledger, [draft("# 設計", [viewpoints("A")])]);
    expect(restarted.get(id)?.task.status).toBe("idle");
    restarted.queueWaitingSteps();
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    expect(restarted.get(id)?.task.gate).toEqual({ step: "design", submission: 1 });
    restarted.queueWaitingSteps(); // 承認待ちのタスクには何もしない
    expect(restarted.get(id)?.task.status).toBe("awaiting_approval");
    ledger.close();
  });

  it("承認済みの工程の成果物は凍結され、台帳でも書き換えを受け付けない", async () => {
    const { ledger, service, id } = await toDesignGate([draft("# 設計 v1", [viewpoints("A")])]);
    gate(service, id, "design");
    const task = service.get(id)?.task;
    expect(task?.outputs.requirements).toBe("# 要求要件 v1");
    expect(task?.approved.requirements?.output).toBe("# 要求要件 v1");
    // 承認済みの工程は、差し戻して承認を取り消さない限り実行対象にならない
    expect(task?.steps.find((s) => s.state === "active")?.key).toBe("implement");
    expect(() => gate(service, id, "requirements")).toThrow(/承認待ちのタスクではありません/);
    ledger.close();
  });
});

describe("ゴールガーディアン：変更の申し出の判定（PBI-9）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const designWithProposal = (target = "requirements") =>
    out(
      [
        "# 設計 v1",
        block({
          "sacty-test-viewpoints": [{ title: "A", input: "Aの入力", expected: "Aの期待結果" }],
        }),
        block({
          "sacty-change-proposal": {
            target,
            reason: "外部APIが冪等性キーに対応していない",
            facts: ["決済代行のAPI仕様書 v3 に Idempotency-Key が無い"],
            proposed: "# 要求要件 v2（sacty側で重複を防ぐ）",
          },
        }),
      ].join("\n\n"),
    );
  const verdict = (v: string, reason = "事実で裏付けられている") =>
    out(block({ "sacty-verdict": { verdict: v, reason } }), 1000);
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";

  /** 要求要件を承認し、設計の実行（申し出つき）とゴールガーディアンの判定まで進める。 */
  async function proposeAndJudge(outcomes: AgentOutcome[]) {
    const ledger = new SqliteLedgerStore(dbPath);
    const made = makeService(ledger, [out("# 要求要件 v1"), ...outcomes]);
    const task = made.service.createTicket({
      title: "決済API",
      body: "チケットの本文（秘密の経緯）",
    });
    await made.service.runNext(task.id);
    made.service.approve(task.id, { step: "requirements", submission: 1 });
    await made.service.runNext(task.id);
    return { ledger, ...made, id: task.id };
  }

  it("設計の工程は要求要件の変更を申し出られ、ゴールガーディアンは新しいセッションで必要な情報だけを受け取る", async () => {
    const { ledger, service, executor, id } = await proposeAndJudge([
      designWithProposal(),
      verdict("rejected", "代替手段がある"),
    ]);
    expect(promptOf(executor, 1)).toContain("sacty-change-proposal");

    const guardian = promptOf(executor, 2);
    expect(guardian).toContain("--- 承認済みの要求要件 ---\n# 要求要件 v1");
    expect(guardian).toContain("理由：外部APIが冪等性キーに対応していない");
    expect(guardian).toContain("- 決済代行のAPI仕様書 v3 に Idempotency-Key が無い");
    expect(guardian).toContain("# 要求要件 v2（sacty側で重複を防ぐ）");
    // チケットや工程の下書き、過去の経緯は渡さない
    expect(guardian).not.toContain("チケットの本文");
    expect(guardian).not.toContain("# 設計 v1");
    // 工程の作業領域とは別の、空の作業領域で実行する
    expect(executor.dirs[2]).not.toBe(executor.dirs[1]);
    expect(executor.dirs[2]).toContain("_guardian");
    expect(existsSync(executor.dirs[2] ?? "")).toBe(false);

    const task = service.get(id)?.task;
    expect(task?.proposals).toMatchObject([
      {
        id: "CP-1",
        fromStep: "design",
        target: "requirements",
        judgement: { verdict: "rejected", reason: "代替手段がある" },
        applied: false,
      },
    ]);
    // 却下されたら、設計をそのまま提出する。要求要件は承認済みのまま
    expect(task?.gate).toEqual({ step: "design", submission: 1 });
    expect(task?.outputs.design).toBe("# 設計 v1"); // 申し出のJSONは本文から除く
    expect(task?.approved.requirements?.output).toBe("# 要求要件 v1");
    // ゴールガーディアンの費用も予算に入る（100 + 100 + 1000 出力トークン × $15/M）
    expect(task?.budget.usedUsd).toBeCloseTo(0.018, 6);
    const types = service.get(id)?.ledger.map((e) => e.type) ?? [];
    expect(types.slice(-4)).toEqual([
      "AgentRunCompleted",
      "ChangeProposed",
      "ChangeJudged",
      "StepSubmitted",
    ]);
    expect(service.get(id)?.ledger.find((e) => e.type === "ChangeJudged")?.actor).toBe("guardian");
    ledger.close();
  });

  it("要求要件の変更が承認されても、人間の再承認が必要になる", async () => {
    const { ledger, service, executor, id } = await proposeAndJudge([
      designWithProposal(),
      verdict("approved"),
      out("# 設計 v2"),
    ]);
    const task = service.get(id)?.task;
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.gate).toEqual({ step: "requirements", submission: 2 });
    expect(task?.outputs.requirements).toBe("# 要求要件 v2（sacty側で重複を防ぐ）");
    expect(task?.approved).toEqual({});
    expect(task?.steps.map((s) => s.state)).toEqual(["active", "todo", "todo", "todo"]);
    expect(task?.proposals[0]?.applied).toBe(true);

    service.approve(id, { step: "requirements", submission: 2 });
    await service.runNext(id);
    expect(promptOf(executor, 3)).toContain(
      "--- 承認済みの要求要件 ---\n# 要求要件 v2（sacty側で重複を防ぐ）",
    );
    expect(service.get(id)?.task.gate).toEqual({ step: "design", submission: 1 });
    ledger.close();
  });

  it("判定できなければエスカレーションになり、人間が認めるか認めないかを決める", async () => {
    const { ledger, service, id } = await proposeAndJudge([
      designWithProposal(),
      out("判定の形式が無い出力"),
    ]);
    const escalated = service.get(id)?.task;
    expect(escalated?.status).toBe("escalated");
    expect(escalated?.proposals[0]?.judgement).toMatchObject({ verdict: "undecidable" });
    expect(() => service.approve(id, { step: "design", submission: 1 })).toThrow();
    expect(() => service.decideChange(id, "CP-9", { accept: true })).toThrow(
      /判断待ちではありません/,
    );

    const rejected = service.decideChange(id, "CP-1", { accept: false });
    expect(rejected.gate).toEqual({ step: "design", submission: 1 });
    expect(rejected.approved.requirements?.output).toBe("# 要求要件 v1");
    expect(() => service.decideChange(id, "CP-1", { accept: true })).toThrow(
      /判断待ちではありません/,
    );
    ledger.close();
  });

  it("人間が認めた要求要件の変更も、再承認に回す", async () => {
    const { ledger, service, id } = await proposeAndJudge([
      designWithProposal(),
      verdict("undecidable", "価値判断を含む"),
    ]);
    const accepted = service.decideChange(id, "CP-1", { accept: true });
    expect(accepted.gate).toEqual({ step: "requirements", submission: 2 });
    expect(accepted.proposals[0]).toMatchObject({ decision: { accept: true }, applied: true });
    expect(accepted.approved).toEqual({}); // 承認を取り消している
    expect(accepted.steps.map((st) => st.state)).toEqual(["active", "todo", "todo", "todo"]);
    const types = service.get(id)?.ledger.map((e) => e.type) ?? [];
    expect(types.slice(-4)).toEqual([
      "TaskEscalated",
      "ChangeDecided",
      "ChangeApplied",
      "StepSubmitted",
    ]);
    ledger.close();
  });

  it("ゴールガーディアンの実行に失敗したら、判定できなかったものとしてエスカレーションにする", async () => {
    const { ledger, service, id } = await proposeAndJudge([
      designWithProposal(),
      { kind: "failed", reason: "usage_limit", message: "You've hit your session limit" },
    ]);
    const task = service.get(id)?.task;
    expect(task?.status).toBe("escalated");
    expect(ja(task?.proposals[0]?.judgement?.reason)).toContain("session limit");
    ledger.close();
  });

  it("承認されていない工程への申し出は無視し、そのまま提出する", async () => {
    const { ledger, service, executor, id } = await proposeAndJudge([designWithProposal("design")]);
    expect(executor.calls).toHaveLength(2); // ゴールガーディアンは呼ばない
    const task = service.get(id)?.task;
    expect(task?.proposals).toEqual([]);
    expect(task?.gate).toEqual({ step: "design", submission: 1 });
    ledger.close();
  });

  it("デーモンの停止で中断された判定は、再起動時にエスカレーションにする", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [out("# 要求要件 v1")]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    // 設計の実行完了と申し出までを記録したところで、デーモンが止まった
    const runId = "run-x";
    ledger.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: { runId, step: "design", agentId: "a", authMode: "subscription" },
          },
        },
        {
          actor: "agent",
          event: {
            type: "AgentRunCompleted",
            payload: {
              runId,
              step: "design",
              agentId: "a",
              authMode: "subscription",
              usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
              costUsd: 0,
              estimated: true,
              output: "# 設計",
            },
          },
        },
        {
          actor: "agent",
          event: {
            type: "ChangeProposed",
            payload: {
              proposalId: "CP-1",
              fromStep: "design",
              target: "requirements",
              reason: "r",
              facts: [],
              proposed: "p",
            },
          },
        },
      ],
    });
    const { service: restarted } = makeService(ledger);
    restarted.recoverInterrupted();
    const task = restarted.get(id)?.task;
    expect(task?.status).toBe("escalated");
    expect(ja(task?.proposals[0]?.judgement?.reason)).toMatch(/中断/);
    ledger.close();
  });

  it("判定と後始末は、同じトランザクションで台帳に記録する（レビュー指摘）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const appended: string[][] = [];
    const original = ledger.append.bind(ledger);
    ledger.append = (entry) => {
      appended.push(entry.events.map((e) => e.event.type));
      return original(entry);
    };
    const { service } = makeService(ledger, [
      out("# 要求要件 v1"),
      designWithProposal(),
      verdict("approved"),
    ]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    expect(appended).toContainEqual(["ChangeJudged", "ChangeApplied", "StepSubmitted"]);
    // 申し出のない実行も、完了と提出を一緒に記録する
    expect(appended).toContainEqual(["AgentRunCompleted", "StepSubmitted"]);
    ledger.close();
  });

  /** 判定（と人間の判断）までが記録され、後始末が記録されていない台帳を作る。 */
  async function cutAfter(
    judged: "approved" | "rejected" | "undecidable",
    extra: { actor: "person" | "sacty"; event: EventInput }[] = [],
  ) {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [out("# 要求要件 v1")]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    const runId = "run-x";
    const append = (actor: "agent" | "guardian" | "sacty" | "person", event: EventInput) =>
      ledger.append({ taskId: id, projectId: "default", events: [{ actor, event }] });
    append("sacty", {
      type: "AgentRunStarted",
      payload: { runId, step: "design", agentId: "a", authMode: "subscription" },
    });
    append("agent", {
      type: "AgentRunCompleted",
      payload: {
        runId,
        step: "design",
        agentId: "a",
        authMode: "subscription",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        costUsd: 0,
        estimated: true,
        output: "# 設計",
      },
    });
    append("agent", {
      type: "ChangeProposed",
      payload: {
        proposalId: "CP-1",
        fromStep: "design",
        target: "requirements",
        reason: "r",
        facts: [],
        proposed: "# 要求要件 v2",
      },
    });
    append("guardian", {
      type: "ChangeJudged",
      payload: { proposalId: "CP-1", verdict: judged, reason: "x", agentId: "g" },
    });
    for (const e of extra) append(e.actor, e.event);
    const { service: restarted } = makeService(ledger);
    expect(restarted.get(id)?.task.status).toBe("idle"); // どの状態にも進んでいない
    restarted.recoverInterrupted();
    return { ledger, service: restarted, id };
  }

  it("判定まで記録されて止まった台帳も、再起動時に後始末を記録して先に進める（レビュー指摘）", async () => {
    const undecidable = await cutAfter("undecidable");
    expect(undecidable.service.get(undecidable.id)?.task.status).toBe("escalated");
    // 人間の判断も受け付ける
    expect(
      undecidable.service.decideChange(undecidable.id, "CP-1", { accept: false }).gate,
    ).toEqual({ step: "design", submission: 1 });
    undecidable.ledger.close();
    rmSync(dbPath, { force: true });

    const approved = await cutAfter("approved");
    expect(approved.service.get(approved.id)?.task.gate).toEqual({
      step: "requirements",
      submission: 2,
    });
    approved.service.recoverInterrupted(); // 何度呼んでも同じ（冪等）
    expect(
      approved.service.get(approved.id)?.ledger.filter((e) => e.type === "StepSubmitted"),
    ).toHaveLength(2);
    approved.ledger.close();
    rmSync(dbPath, { force: true });

    const rejected = await cutAfter("rejected");
    expect(rejected.service.get(rejected.id)?.task.gate).toEqual({ step: "design", submission: 1 });
    rejected.ledger.close();
  });

  it("人間の判断や反映まで記録されて止まった台帳も、再起動時に先に進める（レビュー指摘）", async () => {
    const decided = await cutAfter("undecidable", [
      {
        actor: "sacty",
        event: {
          type: "TaskEscalated",
          payload: {
            step: "design",
            target: "requirements",
            reason: "change_undecidable",
            proposalId: "CP-1",
          },
        },
      },
      {
        actor: "person",
        event: { type: "ChangeDecided", payload: { proposalId: "CP-1", accept: true } },
      },
    ]);
    expect(decided.service.get(decided.id)?.task.gate).toEqual({
      step: "requirements",
      submission: 2,
    });
    decided.ledger.close();
    rmSync(dbPath, { force: true });

    const applied = await cutAfter("approved", [
      { actor: "sacty", event: { type: "ChangeApplied", payload: { proposalId: "CP-1" } } },
    ]);
    expect(applied.service.get(applied.id)?.task.gate).toEqual({
      step: "requirements",
      submission: 2,
    });
    applied.ledger.close();
  });
});

describe("実装の工程と最終レビュー（PBI-10a）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const design = out(
    [
      "# 設計",
      block({
        "sacty-test-viewpoints": [
          { title: "同じキーの再送", input: "同じキーで2回送る", expected: "決済は1回" },
          { title: "キーなし", input: "キーを付けない", expected: "400" },
        ],
      }),
    ].join("\n\n"),
  );
  const implement = (
    text: string,
    map: { viewpointId: string; tests: string[] }[] = [
      { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] },
      { viewpointId: "TV-2", tests: ["pay.test.ts › キーなし"] },
    ],
  ) => out([text, block({ "sacty-test-map": map })].join("\n\n"));
  const review = (
    viewpoints: [string, boolean][] = [
      ["TV-1", true],
      ["TV-2", true],
    ],
    remarks: [string, boolean][] = [["requirements-1-1", true]],
    usageOutput = 1000,
  ) =>
    out(
      block({
        "sacty-final-review": {
          viewpoints: viewpoints.map(([id, verified]) => ({
            id,
            verified,
            reason: `${id}の判定理由`,
          })),
          remarks: remarks.map(([id, notRecurred]) => ({
            id,
            notRecurred,
            reason: `${id}の判定理由`,
          })),
          summary: "所見",
        },
      }),
      usageOutput,
    );
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const types = (svc: TaskService, id: string) => svc.get(id)?.ledger.map((e) => e.type) ?? [];

  /** 要求要件（差し戻し1回）と設計を承認し、実装の工程が実行待ちになったところまで進める。 */
  async function toImplement(
    outcomes: AgentOutcome[],
    options: { tests?: FakeTests; repos?: FakeRepos; config?: () => ConfigResult } = {},
  ) {
    const ledger = new SqliteLedgerStore(dbPath);
    const made = makeService(
      ledger,
      [out("# 要求要件 v1"), out("# 要求要件 v2"), design, ...outcomes],
      options,
    );
    const { service } = made;
    const { id } = service.createTicket({ title: "決済API", body: "チケットの本文" });
    await service.runNext(id);
    service.requestChanges(id, {
      step: "requirements",
      submission: 1,
      comments: ["失敗時の再試行の条件が無い"],
    });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 2 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    return { ledger, ...made, id };
  }

  /** 実装と検証を、止まるまで進める。 */
  async function drain(service: TaskService, max = 10) {
    for (let i = 0; i < max; i++) {
      const ids = service.queuedTaskIds();
      if (ids.length === 0) return;
      for (const id of ids) await service.runNext(id);
    }
  }

  it("実装は対象リポジトリの clone で、承認済みの成果物と人間の指摘を受け取って実行する", async () => {
    const { ledger, service, executor, repos, id } = await toImplement([
      implement("# 実装の説明"),
      review(),
    ]);
    expect(service.queuedTaskIds()).toEqual([id]);
    await service.runNext(id);

    expect(repos.prepared).toEqual([
      {
        dir: join(dir, "workspaces", id, "repo"),
        // 退避先は、どのコンテナにもマウントしない場所（タスクの作業領域の外）
        gitDir: join(dir, "workspaces", "_git", `${id}.git`),
        url: "https://example.com/acme/app.git",
        baseBranch: "main",
      },
    ]);
    expect(executor.dirs[3]).toBe(join(dir, "workspaces", id, "repo"));
    const prompt = promptOf(executor, 3);
    expect(prompt).toContain("--- 承認済みの要求要件 ---\n# 要求要件 v2");
    expect(prompt).toContain("--- 承認済みの設計 ---\n# 設計");
    expect(prompt).toContain(
      "- [TV-1] 同じキーの再送\n  - 入力：同じキーで2回送る\n  - 期待結果：決済は1回",
    );
    expect(prompt).toContain("[requirements-1-1] 失敗時の再試行の条件が無い");
    expect(prompt).toContain("sacty-test-map");

    const task = service.get(id)?.task;
    expect(task?.repository).toEqual({
      url: "https://example.com/acme/app.git",
      baseBranch: "main",
      baseCommit: "base123",
    });
    expect(task?.outputs.implement).toBe("# 実装の説明");
    expect(task?.testMap.map((m) => m.viewpointId)).toEqual(["TV-1", "TV-2"]);
    expect(task?.verification).toBe("pending");
    ledger.close();
  });

  it("テストを別に実行して通れば、ゴールガーディアンが新しいセッションで最終レビューし、合格なら実装を完了にする", async () => {
    const tests = new FakeTests([{ exitCode: 0, output: "2 passed", durationMs: 1200 }]);
    const { ledger, service, executor, id } = await toImplement(
      [implement("# 実装の説明（ガーディアンには渡さない）"), review()],
      { tests },
    );
    await drain(service);

    expect(tests.calls).toEqual([
      {
        runId: expect.any(String),
        image: "sacty-agent:test",
        workspaceDir: join(dir, "workspaces", id, "repo"),
        command: "npm test",
      },
    ]);
    const guardian = promptOf(executor, 4);
    expect(guardian).toContain("--- 承認済みの要求要件 ---\n# 要求要件 v2");
    expect(guardian).toContain("- [TV-2] キーなし");
    expect(guardian).toContain("- [TV-1] pay.test.ts › 同じキーの再送");
    expect(guardian).toContain("コマンド：npm test（終了コード 0）\n出力の末尾：\n2 passed");
    expect(guardian).toContain("- [requirements-1-1] 失敗時の再試行の条件が無い");
    expect(guardian).toContain("+export const pay = () => 1;");
    expect(guardian).not.toContain("ガーディアンには渡さない");
    expect(guardian).not.toContain("チケットの本文");
    expect(executor.dirs[4]).toContain("_guardian");
    expect(existsSync(executor.dirs[4] ?? "")).toBe(false);

    const task = service.get(id)?.task;
    // 実装を完了にし、PR作成（sacty が実行）を経て成果物チェックのゲートで止まる
    expect(task?.steps.map((st) => st.state)).toEqual(["done", "done", "done", "active"]);
    expect(task?.gate?.step).toBe("pr");
    expect(task?.lastReview).toMatchObject({ passed: true, summary: "所見" });
    expect(task?.lastTests).toMatchObject({ passed: true, exitCode: 0, durationMs: 1200 });
    expect(types(service, id).slice(-6)).toEqual([
      "AgentRunCompleted",
      "TestsRun",
      "FinalReviewed",
      "BranchPushed",
      "PullRequestPublished",
      "StepSubmitted",
    ]);
    expect(service.get(id)?.ledger.find((e) => e.type === "FinalReviewed")?.actor).toBe("guardian");
    ledger.close();
  });

  it("テストが通らなければ、出力を渡して実装をやり直す", async () => {
    const tests = new FakeTests([
      { exitCode: 1, output: "AssertionError: expected 2 to be 1", durationMs: 10 },
      { exitCode: 0, output: "ok", durationMs: 10 },
    ]);
    const { ledger, service, executor, id } = await toImplement(
      [implement("# v1"), implement("# v2"), review()],
      { tests },
    );
    await drain(service);
    const retry = promptOf(executor, 4);
    expect(retry).toContain("--- 前回の検証：テストが通りませんでした ---");
    expect(retry).toContain("AssertionError: expected 2 to be 1");
    expect(retry).toContain("--- 前回の実装の説明 ---\n# v1");
    const task = service.get(id)?.task;
    expect(task?.steps[2]?.state).toBe("done");
    expect(task?.verifyFailures).toBe(0);
    ledger.close();
  });

  it("テストが通っても、テストの対応していない観点があれば不合格にする", async () => {
    const { ledger, service, id } = await toImplement([
      implement("# v1", [{ viewpointId: "TV-1", tests: ["a"] }]),
    ]);
    await service.runNext(id);
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.lastTests).toMatchObject({
      exitCode: 0,
      passed: false,
      unmappedViewpoints: ["TV-2"],
    });
    expect(task?.status).toBe("queued");
    ledger.close();
  });

  it("最終レビューで、観点を検証していない・指摘が再発している・判定が無いものは不合格にし、所見を渡してやり直す", async () => {
    const { ledger, service, executor, id } = await toImplement([
      implement("# v1"),
      review([["TV-1", true]], [["requirements-1-1", false]]),
      implement("# v2"),
      review(),
    ]);
    await service.runNext(id); // 実装
    await service.runNext(id); // テストと最終レビュー
    const failed = service.get(id)?.task;
    expect(failed?.status).toBe("queued");
    expect(failed?.lastReview?.passed).toBe(false);
    expect(failed?.lastReview?.viewpoints).toEqual([
      { viewpointId: "TV-1", verified: true, reason: "TV-1の判定理由" },
      // 判定が無いことは sacty の文言なので、コードで記録する（PBI-11b）。指示には日本語の文で入れる
      { viewpointId: "TV-2", verified: false, reason: { code: "review.verdictMissing" } },
    ]);

    await drain(service);
    const retry = promptOf(executor, 5);
    expect(retry).toContain("ゴールガーディアンの最終レビューに通りませんでした");
    expect(retry).toContain("- [TV-2] 観点を検証できていない：判定がありません。");
    expect(retry).toContain(
      "- [requirements-1-1] 過去の指摘が再発している：requirements-1-1の判定理由",
    );
    // 2回目の最終レビューには、1回目の判定を渡さない
    const second = promptOf(executor, 6);
    expect(second).toContain("sacty-final-review");
    expect(second).not.toContain("判定理由");
    expect(second).not.toContain("判定がありません");
    expect(service.get(id)?.task.steps[2]?.state).toBe("done");
    ledger.close();
  });

  it("検証に3回続けて通らなければ一時停止し、再開すると数え直して実装をやり直す", async () => {
    const fail = { exitCode: 1, output: "fail", durationMs: 1 };
    const tests = new FakeTests([fail, fail, fail]);
    const { ledger, service, id } = await toImplement(
      [implement("# v1"), implement("# v2"), implement("# v3"), implement("# v4")],
      { tests },
    );
    await drain(service);
    const paused = service.get(id)?.task;
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("verification");
    expect(ja(paused?.pausedMessage)).toMatch(/3回続けて/);
    expect(paused?.verifyFailures).toBe(3);

    const resumed = service.resume(id, {});
    expect(resumed.status).toBe("queued");
    expect(resumed.verifyFailures).toBe(0);
    ledger.close();
  });

  it("最終レビューを実行できなければ止め、再開するとテストを繰り返さずに最終レビューからやり直す", async () => {
    const tests = new FakeTests();
    const { ledger, service, id } = await toImplement(
      [
        implement("# v1"),
        { kind: "failed", reason: "usage_limit", message: "You've hit your session limit" },
        review(),
      ],
      { tests },
    );
    await service.runNext(id);
    await service.runNext(id);
    const paused = service.get(id)?.task;
    expect(paused?.pausedReason).toBe("usage_limit");
    expect(ja(paused?.pausedMessage)).toContain("session limit");
    expect(paused?.verification).toBe("tests_passed");

    service.resume(id, {});
    await drain(service);
    expect(tests.calls).toHaveLength(1);
    expect(service.get(id)?.task.steps[2]?.state).toBe("done");
    ledger.close();
  });

  it("最終レビューを実行できなかった分の費用も記録し、予算に入れる（レビュー指摘）", async () => {
    const { ledger, service, id } = await toImplement([
      implement("# v1"),
      {
        kind: "failed",
        reason: "usage_limit",
        message: "You've hit your session limit",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }, // $15
      },
    ]);
    const before = service.get(id)?.task.budget.usedUsd ?? 0;
    await service.runNext(id);
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.budget.usedUsd).toBeCloseTo(before + 0.0015 + 15, 6);
    expect(task?.budget.warned).toBe(true);
    expect(types(service, id).slice(-3)).toEqual([
      "FinalReviewFailed",
      "TaskPaused",
      "BudgetWarned",
    ]);
    // 再開するには、使用済みより大きい上限が必要（予算の判定にも入っている）
    expect(task?.pausedReason).toBe("usage_limit");
    service.resume(id, {});
    await service.runNext(id);
    expect(service.get(id)?.task.pausedReason).toBe("budget");
    ledger.close();
  });

  it("差分を取得できなければ最終レビューをせずに止め、再開すると差分の取得からやり直す（レビュー指摘）", async () => {
    const repos = new FakeRepos();
    const tests = new FakeTests();
    const { ledger, service, executor, id } = await toImplement([implement("# v1"), review()], {
      repos,
      tests,
    });
    repos.diffFail = "git diff に失敗しました：bad object";
    await service.runNext(id);
    await service.runNext(id);
    const paused = service.get(id)?.task;
    expect(paused?.pausedReason).toBe("error");
    expect(ja(paused?.pausedMessage)).toContain(
      "差分を取得できないため、最終レビューをしていません",
    );
    expect(paused?.verification).toBe("tests_passed");
    expect(paused?.steps[2]?.state).toBe("active");
    expect(executor.calls).toHaveLength(4); // ゴールガーディアンは呼んでいない

    repos.diffFail = undefined;
    service.resume(id, {});
    await drain(service);
    expect(tests.calls).toHaveLength(1);
    expect(service.get(id)?.task.steps[2]?.state).toBe("done");
    ledger.close();
  });

  it("対象リポジトリが無い・clone できなければ、タスクの開始時に理由を記録して止める（PBI-15）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const repos = new FakeRepos();
    repos.fail = "git clone に失敗しました：Repository not found";
    const { service, executor } = makeService(ledger, [out("# 要求要件")], { repos });
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.pausedReason).toBe("error");
    // エージェントは実行しない（費用をかける前に止める）
    expect(executor.calls).toHaveLength(0);
    expect(task?.steps[0]).toMatchObject({ key: "requirements", state: "active" });
    // タスクの開始時に止まるので、エージェントの実行の失敗ではなく、一時停止の理由として記録する（PBI-15）
    expect(service.get(id)?.task.pausedMessage).toContain("Repository not found");
    ledger.close();
  });

  it("PBI-8・9で設計が承認され、実装の工程が無かったため待機していたタスクは、起動時に実装を実行待ちにする", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [out("# 要求要件"), design]);
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    // PBI-9までの台帳：実装の工程を実行できなかったため、設計の承認後に待機していた
    ledger.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: { type: "StepApproved", payload: { step: "design", next: "idle" } },
        },
      ],
    });
    const { service: restarted } = makeService(ledger, [implement("# v1")]);
    restarted.queueWaitingSteps();
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    restarted.queueWaitingSteps(); // 実装済み（検証待ち）のタスクには何もしない
    expect(types(restarted, id).filter((t) => t === "StepQueued")).toHaveLength(1);
    ledger.close();
  });

  it("前の工程に戻ったら、検証の失敗の回数と内容を持ち越さない", async () => {
    const tests = new FakeTests([{ exitCode: 1, output: "fail", durationMs: 1 }]);
    const proposal = out(
      [
        "# v2",
        block({
          "sacty-change-proposal": {
            target: "requirements",
            reason: "前提が誤っている",
            facts: ["事実"],
            proposed: "# 要求要件 v3",
          },
        }),
      ].join("\n\n"),
    );
    const verdict = out(block({ "sacty-verdict": { verdict: "approved", reason: "ok" } }));
    const { ledger, service, id } = await toImplement([implement("# v1"), proposal, verdict], {
      tests,
    });
    await service.runNext(id); // 実装
    await service.runNext(id); // テストが通らない
    expect(service.get(id)?.task.verifyFailures).toBe(1);
    await service.runNext(id); // 実装のやり直しで、要求要件の変更を申し出て認められる
    const task = service.get(id)?.task;
    expect(task?.gate).toEqual({ step: "requirements", submission: 3 });
    expect(task?.verifyFailures).toBe(0);
    expect(task?.verifyFeedback).toBeUndefined();
    expect(task?.verification).toBeUndefined();
    ledger.close();
  });

  /** 実装・検証を終え、成果物チェックのゲートまで進める。 */
  async function toDeliverableGate(
    outcomes: AgentOutcome[] = [],
    options: { pulls?: FakePulls; repos?: FakeRepos; config?: () => ConfigResult } = {},
  ) {
    const made = await toImplement([implement("# 実装の説明"), review(), ...outcomes], options);
    await drain(made.service);
    return made;
  }

  it("最終レビューに通ったら、ブランチにプッシュしてPRを作り、成果物チェックのゲートで止まる（PBI-10b）", async () => {
    const { ledger, service, repos, pulls, id } = await toDeliverableGate();
    expect(repos.published).toEqual([
      {
        parent: "base123",
        branch: `sacty/task-${id.slice(0, 8)}`,
        message: `決済API\n\nsacty task ${id}`,
        date: service.get(id)?.task.lastReview?.at,
      },
    ]);
    expect(pulls.calls).toHaveLength(1);
    const call = pulls.calls[0];
    expect(call).toMatchObject({
      repo: "acme/app",
      token: "ghp_secret",
      branch: `sacty/task-${id.slice(0, 8)}`,
      baseBranch: "main",
      title: "決済API",
      number: undefined,
    });
    expect(call?.body).toContain(
      "| TV-1 同じキーの再送 | 同じキーで2回送る | 決済は1回 | pay.test.ts › 同じキーの再送 | ✅ TV-1の判定理由 |",
    );
    expect(call?.body).toContain("requirements-1-1：再発なし");

    const task = service.get(id)?.task;
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.gate).toEqual({ step: "pr", submission: 1 });
    expect(task?.pullRequest).toMatchObject({
      url: "https://github.com/acme/app/pull/7",
      number: 7,
    });
    expect(types(service, id).slice(-3)).toEqual([
      "BranchPushed",
      "PullRequestPublished",
      "StepSubmitted",
    ]);
    // トークンは台帳に残さない
    expect(JSON.stringify(service.get(id)?.ledger)).not.toContain("ghp_secret");

    // PR を作ったタスクは、画面では承認できない（PR のマージで承認する。PBI-14a）
    expect(() => service.approve(id, { step: "pr", submission: 1 })).toThrow(/マージ/);
    pulls.state = {
      state: "merged",
      mergedBy: "reviewer",
      headSha: service.get(id)?.task.pullRequest?.commit,
    };
    await service.checkPullRequests();
    const done = service.get(id)?.task;
    expect(done?.steps.every((st) => st.state === "done")).toBe(true);
    expect(done?.status).toBe("idle");
    expect(service.queuedTaskIds()).toEqual([]);
    ledger.close();
  });

  it("成果物チェックの間、プロジェクトの gh のアカウントで PR を見守り、閉じられたら記録して待ち、マージで完了する（PBI-14a）", async () => {
    const pulls = new FakePulls();
    const { ledger, service, id } = await toDeliverableGate([], { pulls });
    // 開いたままなら何も記録しない
    await service.checkPullRequests();
    expect(pulls.checked).toEqual([{ repo: "acme/app", token: "ghp_secret", number: 7 }]);
    expect(types(service, id).at(-1)).toBe("StepSubmitted");

    // 確かめられなければ（ネットワークなど）、何も記録せずに次の確認でやり直す
    pulls.statusFail = "network";
    await service.checkPullRequests();
    expect(types(service, id).at(-1)).toBe("StepSubmitted");
    pulls.statusFail = undefined;

    // マージせずに閉じられたら、記録して人間の判断を待つ
    pulls.state = { state: "closed" };
    await service.checkPullRequests();
    await service.checkPullRequests(); // 同じ状態は二重に記録しない
    expect(types(service, id).slice(-1)).toEqual(["PullRequestClosed"]);
    expect(service.get(id)?.task).toMatchObject({
      status: "awaiting_approval",
      pullRequestState: "closed",
    });

    // 開き直されたら、マージを待つ
    pulls.state = { state: "open" };
    await service.checkPullRequests();
    expect(service.get(id)?.task.pullRequestState).toBe("open");

    // 最新の提出（記録したコミット）のマージは、人間の承認として記録し、タスクを完了にする
    const commit = service.get(id)?.task.pullRequest?.commit;
    pulls.state = { state: "merged", mergedBy: "reviewer", headSha: commit };
    await service.checkPullRequests();
    const ledgerEvents = service.get(id)?.ledger ?? [];
    expect(ledgerEvents.slice(-2).map((e) => [e.type, e.actor])).toEqual([
      ["PullRequestMerged", "person"],
      ["StepApproved", "person"],
    ]);
    expect(ledgerEvents.at(-2)?.payload).toEqual({
      number: 7,
      by: "reviewer",
      commit,
      outdated: false,
    });
    expect(service.get(id)?.task.steps.every((st) => st.state === "done")).toBe(true);
    // 完了したタスクは、もう確かめない
    const checks = pulls.checked.length;
    await service.checkPullRequests();
    expect(pulls.checked).toHaveLength(checks);
    ledger.close();
  });

  it("PRの作成先が設定されていなければ、ブランチのプッシュまでで成果物チェックに進む", async () => {
    const pulls = new FakePulls();
    const { ledger, service, id } = await toDeliverableGate([], {
      pulls,
      config: configOf(agent(), 1, null),
    });
    expect(pulls.calls).toEqual([]);
    const task = service.get(id)?.task;
    expect(task?.gate).toEqual({ step: "pr", submission: 1 });
    expect(task?.pullRequest?.url).toBeUndefined();
    ledger.close();
  });

  it("成果物チェックで差し戻すと見逃しを記録し、実装をやり直して同じPRを更新する（PBI-10b）", async () => {
    const { ledger, service, executor, repos, pulls, id } = await toDeliverableGate([
      out(
        [
          "# 実装の説明 v2",
          block({
            "sacty-test-map": [
              { viewpointId: "TV-1", tests: ["a"] },
              { viewpointId: "TV-2", tests: ["b"] },
            ],
          }),
          block({ "sacty-responses": [{ remarkId: "implement-1-1", text: "ログを足した" }] }),
        ].join("\n\n"),
      ),
      // 判定の無い指摘は不合格になるので、実装への指摘にも判定を返す
      review(undefined, [
        ["requirements-1-1", true],
        ["implement-1-1", true],
      ]),
    ]);
    expect(() =>
      service.requestChanges(id, { step: "pr", submission: 1, target: "pr", comments: ["x"] }),
    ).toThrow(/差し戻せません/);
    const sent = service.requestChanges(id, {
      step: "pr",
      submission: 1,
      comments: ["失敗時のログが無い"],
    });
    expect(sent.status).toBe("queued");
    expect(sent.steps.map((st) => st.state)).toEqual(["done", "done", "active", "todo"]);
    expect(sent.remarks.at(-1)).toMatchObject({ id: "implement-1-1", step: "implement" });
    expect(sent.misses).toMatchObject([{ remarkIds: ["implement-1-1"] }]);
    expect(types(service, id).slice(-2)).toEqual(["GuardianMissed", "ChangesRequested"]);

    await drain(service);
    const prompt = promptOf(executor, 6);
    expect(prompt).toContain("[implement-1-1] 失敗時のログが無い");
    const task = service.get(id)?.task;
    expect(task?.remarks.at(-1)?.response).toBe("ログを足した");
    // 実装への対応は、成果物チェックの2回目の提出での対応として記録する（レビュー指摘）
    expect(task?.remarks.at(-1)?.respondedIn).toBe(2);
    expect(task?.gate).toEqual({ step: "pr", submission: 2 });
    // 前回プッシュしたコミットに積み、同じPRを更新する
    expect(repos.published[1]).toMatchObject({ parent: "c1".padEnd(40, "0") });
    expect(pulls.calls[1]?.number).toBe(7);
    ledger.close();
  });

  it("差し戻しの間に前の PR がマージされたら、作り直した内容は新しい PR で出し、古い内容のマージでは承認しない（PBI-14a レビュー指摘）", async () => {
    const { ledger, service, pulls, id } = await toDeliverableGate([
      out(
        [
          "# 実装の説明 v2",
          block({
            "sacty-test-map": [
              { viewpointId: "TV-1", tests: ["a"] },
              { viewpointId: "TV-2", tests: ["b"] },
            ],
          }),
          block({ "sacty-responses": [{ remarkId: "implement-1-1", text: "ログを足した" }] }),
        ].join("\n\n"),
      ),
      review(undefined, [
        ["requirements-1-1", true],
        ["implement-1-1", true],
      ]),
    ]);
    const first = service.get(id)?.task.pullRequest?.commit;
    service.requestChanges(id, { step: "pr", submission: 1, comments: ["失敗時のログが無い"] });
    // 作り直している間に、前の PR（1回目の提出）が GitHub でマージされた
    pulls.state = { state: "merged", mergedBy: "reviewer", headSha: first };
    await drain(service);
    // マージ済みの PR は更新せず、新しい PR を作る
    expect(pulls.calls[1]?.number).toBeUndefined();
    const task = service.get(id)?.task;
    expect(task?.pullRequest?.number).toBe(8);
    expect(task?.gate).toEqual({ step: "pr", submission: 2 });
    // 新しい PR はまだ開いている。見守っても、古い PR のマージで承認にはならない
    pulls.state = { state: "open", headSha: task?.pullRequest?.commit };
    await service.checkPullRequests();
    expect(service.get(id)?.task.steps.at(-1)?.state).not.toBe("done");
    ledger.close();
  });

  it("最新の提出より前の内容でマージされたら、承認にせず記録して人間の判断を待つ（PBI-14a レビュー指摘）", async () => {
    const pulls = new FakePulls();
    const { ledger, service, id } = await toDeliverableGate([], { pulls });
    pulls.state = { state: "merged", mergedBy: "reviewer", headSha: "f".repeat(40) };
    await service.checkPullRequests();
    await service.checkPullRequests(); // 二重に記録しない
    const task = service.get(id)?.task;
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.pullRequestState).toBe("merged_outdated");
    expect(task?.steps.at(-1)?.state).not.toBe("done");
    const merged = service.get(id)?.ledger.filter((e) => e.type === "PullRequestMerged");
    expect(merged?.map((e) => e.payload)).toEqual([
      { number: 7, by: "reviewer", commit: "f".repeat(40), outdated: true },
    ]);
    ledger.close();
  });

  it("成果物チェックから設計へ差し戻すと、設計の承認を取り消し、見逃しも記録する", async () => {
    const { ledger, service, id } = await toDeliverableGate();
    const sent = service.requestChanges(id, {
      step: "pr",
      submission: 1,
      target: "design",
      comments: ["観点が足りない"],
    });
    expect(sent.steps.map((st) => st.state)).toEqual(["done", "active", "todo", "todo"]);
    expect(sent.approved.design).toBeUndefined();
    expect(sent.approved.requirements).toBeDefined();
    expect(sent.misses).toHaveLength(1);
    ledger.close();
  });

  it("要求要件・設計は、起点のコミットのコードを実行ごとのディレクトリに書き出して読み取り専用で渡し、実装は clone を渡す（PBI-15）", async () => {
    const { ledger, service, executor, repos, id } = await toImplement([implement("# v1")]);
    await service.runNext(id); // 実装
    // 対象リポジトリは、要求要件の工程の前に1回だけ用意する
    expect(repos.prepared).toHaveLength(1);
    const repoDir = repos.prepared[0]?.dir;
    // 要求要件（2回）と設計は、起点のコミットのコードを読み取り専用で、実装は clone を書き込みできる形で
    expect(executor.readOnly).toEqual([true, true, true, false]);
    expect(repos.snapshots.map((x) => x.baseCommit)).toEqual(["base123", "base123", "base123"]);
    expect(executor.workspaceFiles.slice(0, 3)).toEqual([
      ["README.md"],
      ["README.md"],
      ["README.md"],
    ]);
    expect(executor.dirs[3]).toBe(repoDir);
    for (const used of executor.dirs.slice(0, 3)) {
      expect(used).not.toBe(repoDir);
      // 書き出したコードは、実行が終わったら消す
      expect(existsSync(used)).toBe(false);
    }
    // 指示で、コードがあることと、読むだけであることを伝える
    for (const index of [0, 2]) {
      expect(promptOf(executor, index)).toContain("起点のコミット（base123）のコードがあります");
      expect(promptOf(executor, index)).toContain("読み取り専用");
    }
    ledger.close();
  });

  it("実装の後に設計へ差し戻しても、実装の変更を含まない起点のコミットのコードを読む（PBI-15）", async () => {
    const { ledger, service, executor, repos, id } = await toDeliverableGate([design]);
    const repoDir = repos.prepared[0]?.dir ?? "";
    // 実装で作業領域が変わっている
    writeFileSync(join(repoDir, "changed-by-implement.ts"), "x");
    service.requestChanges(id, { step: "pr", submission: 1, target: "design", comments: ["観点"] });
    const before = executor.calls.length;
    await service.runNext(id); // 設計のやり直し
    expect(executor.readOnly[before]).toBe(true);
    expect(executor.dirs[before]).not.toBe(repoDir);
    expect(executor.workspaceFiles[before]).toEqual(["README.md"]);
    expect(repos.snapshots.at(-1)?.baseCommit).toBe("base123");
    ledger.close();
  });

  it("どの工程から始まるタスクでも、タスクの開始時に対象リポジトリを用意する（PBI-15）", async () => {
    // 今後のタスク種別のように、要求要件から始まらないタスク（実装から始まる）
    const ledger = new SqliteLedgerStore(dbPath);
    ledger.append({
      taskId: "t-impl",
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: { title: "実装だけ", body: "", start: "ticket", budgetCapUsd: 1 },
          },
        },
        { actor: "sacty", event: { type: "StepsChosen", payload: { steps: ["implement", "pr"] } } },
      ],
    });
    const { service, executor, repos } = makeService(ledger, [implement("# v1")]);
    await service.runNext("t-impl");
    const types = service.get("t-impl")?.ledger.map((e) => e.type) ?? [];
    expect(types.indexOf("RepositoryPrepared")).toBeLessThan(types.indexOf("AgentRunStarted"));
    expect(repos.prepared).toHaveLength(1);
    // 実装の工程は clone を書き込みできる形で使う
    expect(executor.dirs[0]).toBe(repos.prepared[0]?.dir);
    expect(executor.readOnly).toEqual([false]);
    ledger.close();
  });

  it("作業領域が消えて用意し直すときも、ブランチの最新ではなく記録済みの起点のコミットを使う（PBI-15 レビュー指摘）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const repos = new FakeRepos();
    const { service } = makeService(ledger, [out("# 要求要件"), design, out("# 要求要件")], {
      repos,
    });
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    // 作業領域が消え、その間にベースブランチが進んだ
    rmSync(repos.prepared[0]?.dir ?? "", { recursive: true, force: true });
    repos.head = "newbase456";
    await service.runNext(id); // 設計
    expect(repos.prepared.map((p) => p.recorded)).toEqual([undefined, "base123"]);
    expect(repos.snapshots.map((x) => x.baseCommit)).toEqual(["base123", "base123"]);
    expect(service.get(id)?.task.repository?.baseCommit).toBe("base123");
    const prepared = service.get(id)?.ledger.filter((e) => e.type === "RepositoryPrepared");
    expect(prepared).toHaveLength(1);

    // 記録済みの起点を取得できなければ、起点を変えずに止める
    const other = makeService(new SqliteLedgerStore(join(dir, "other.db")), [out("# 要求要件")], {
      repos: Object.assign(new FakeRepos(), { recordedMissing: true }),
    });
    const t = other.service.createTicket({ title: "B" });
    await other.service.runNext(t.id);
    other.service.approve(t.id, { step: "requirements", submission: 1 });
    rmSync(other.repos.prepared[0]?.dir ?? "", { recursive: true, force: true });
    await other.service.runNext(t.id);
    expect(other.executor.calls).toHaveLength(1); // 設計のエージェントは実行しない
    expect(other.service.get(t.id)?.task.repository?.baseCommit).toBe("base123");
    expect(other.service.get(t.id)?.task.pausedReason).toBe("error");
    ledger.close();
  });

  it("起点のコードを書き出せなければ、エージェントを実行せずに理由を記録して止める（PBI-15）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const repos = new FakeRepos();
    repos.snapshotFail = "git read-tree に失敗しました";
    const { service, executor } = makeService(ledger, [out("# 要求要件")], { repos });
    const { id } = service.createTicket({ title: "A" });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.pausedReason).toBe("error");
    const failed = service.get(id)?.ledger.findLast((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && failed.payload.message).toContain("read-tree");
    ledger.close();
  });

  it("プッシュやPRの作成に失敗したら理由を記録して止め、トークンは残さない", async () => {
    const pulls = new FakePulls();
    pulls.fail = "PRを作れませんでした：GitHub API 401 Bad credentials ghp_secret";
    const { ledger, service, repos, id } = await toDeliverableGate([], { pulls });
    const task = service.get(id)?.task;
    expect(task?.pausedReason).toBe("error");
    expect(ja(task?.pausedMessage)).toContain("401 Bad credentials");
    // sacty の文言はコードと引数で記録し、外から来た文（ここでは PR の作成のエラー）は引数のまま（PBI-11b）
    expect(task?.pausedMessage).toMatchObject({
      code: "pr.failed",
      params: { detail: expect.stringContaining("401 Bad credentials") },
    });
    expect(JSON.stringify(task?.pausedMessage)).not.toContain("ghp_secret");

    pulls.fail = undefined;
    service.resume(id, {});
    await drain(service);
    expect(service.get(id)?.task.gate).toEqual({ step: "pr", submission: 1 });
    // プッシュの後で失敗して再開しても、同じ親・同じ日時でコミットを作り直す（同じコミットになる）
    const [first, retried] = repos.published;
    expect(retried).toEqual(first);
    ledger.close();
  });

  it("実行待ちのタスクを人間が一時停止し、再開すると実行し直す（PBI-3）", async () => {
    const { ledger, service, id } = await toImplement([implement("# v1"), review()]);
    const paused = await service.pause(id);
    expect(paused).toMatchObject({ status: "paused", pausedReason: "manual" });
    expect(service.queuedTaskIds()).toEqual([]);
    await expect(service.pause(id)).rejects.toThrow(/すでに一時停止/);
    expect(service.resume(id, {}).status).toBe("queued");
    await drain(service);
    expect(service.get(id)?.task.steps[2]?.state).toBe("done");
    ledger.close();
  });

  it("実行中なら、コンテナを止めて中断を記録し、作業領域を残して一時停止する（PBI-3）", async () => {
    const { ledger, service, executor, id } = await toImplement([
      HOLD,
      implement("# v1"),
      review(),
    ]);
    const running = service.runNext(id);
    const runId = await executor.started.promise;
    expect(service.get(id)?.task.status).toBe("running");
    const paused = await service.pause(id);
    await running;
    expect(executor.killed).toEqual([runId]);
    expect(paused).toMatchObject({ status: "paused", pausedReason: "manual", resumeTo: "queued" });
    expect(types(service, id).slice(-2)).toEqual(["AgentRunFailed", "TaskPaused"]);
    expect(existsSync(join(dir, "workspaces", id, "repo"))).toBe(true); // 作業中のものは残す

    service.resume(id, {});
    await drain(service);
    expect(service.get(id)?.task.steps[2]?.state).toBe("done");
    ledger.close();
  });

  it("テストの実行中に止めたら、結果を記録せず、再開するとテストからやり直す（PBI-3）", async () => {
    const tests = new FakeTests();
    tests.hold = true;
    const { ledger, service, id } = await toImplement([implement("# v1"), review()], { tests });
    await service.runNext(id); // 実装
    const verifying = service.runNext(id);
    await tests.started.promise;
    await service.pause(id);
    await verifying;
    const paused = service.get(id)?.task;
    expect(paused).toMatchObject({ pausedReason: "manual", verification: "pending" });
    expect(types(service, id)).not.toContain("TestsRun");

    service.resume(id, {});
    await drain(service);
    expect(tests.calls).toHaveLength(2);
    expect(service.get(id)?.task.steps[2]?.state).toBe("done");
    ledger.close();
  });

  it("人間の判断待ち・中止済みのタスクは一時停止しない（PBI-3）", async () => {
    const { ledger, service, id } = await toDeliverableGate();
    await expect(service.pause(id)).rejects.toThrow(/人間の判断待ち/);
    ledger.close();
  });

  it("中止すると、PRを閉じ・sacty のブランチを消し・作業領域を消して記録し、台帳は残す（PBI-3）", async () => {
    const { ledger, service, repos, pulls, id } = await toDeliverableGate();
    const plan = service.cleanupPlan(id);
    expect(plan?.map((p) => [p.target, p.present])).toEqual([
      ["container", false],
      ["workspace", true],
      ["session", false],
      ["branch", true],
      ["pull_request", true],
    ]);

    const cancelled = await service.cancel(id);
    expect(cancelled.status).toBe("cancelled");
    expect(pulls.closed).toEqual([{ repo: "acme/app", token: "ghp_secret", number: 7 }]);
    expect(repos.deleted).toEqual([`sacty/task-${id.slice(0, 8)}`]);
    expect(existsSync(join(dir, "workspaces", id))).toBe(false);
    expect(existsSync(join(dir, "workspaces", "_git", `${id}.git`))).toBe(false);
    expect(cancelled.cancelled?.cleanup).toEqual([
      { target: "container", result: "skipped" },
      { target: "session", result: "skipped" },
      { target: "pull_request", result: "done", detail: "https://github.com/acme/app/pull/7" },
      { target: "branch", result: "done", detail: `sacty/task-${id.slice(0, 8)}` },
      { target: "workspace", result: "done" },
    ]);
    // 台帳は残り、中止したタスクへの操作は受け付けない
    expect(service.get(id)?.ledger.at(-1)?.type).toBe("TaskCancelled");
    expect(service.get(id)?.ledger.length).toBeGreaterThan(10);
    expect(() => service.approve(id, { step: "pr", submission: 1 })).toThrow();
    expect(() => service.resume(id, {})).toThrow();
    await expect(service.pause(id)).rejects.toThrow(/中止したタスク/);
    await expect(service.cancel(id)).rejects.toThrow(/すでに中止/);
    expect(service.queuedTaskIds()).toEqual([]);
    ledger.close();
  });

  it("実行中に中止すると、コンテナを止めてから片付け、失敗した片付けも記録して続ける（PBI-3）", async () => {
    const pulls = new FakePulls();
    const repos = new FakeRepos();
    const { ledger, service, executor, id } = await toDeliverableGate([HOLD], { pulls, repos });
    // 成果物チェックから実装へ差し戻し、実装の実行中に中止する
    service.requestChanges(id, { step: "pr", submission: 1, comments: ["直して"] });
    const running = service.runNext(id);
    await executor.started.promise;
    expect(service.cleanupPlan(id)?.[0]).toMatchObject({ target: "container", present: true });
    pulls.closeFail = "PRを閉じられませんでした：GitHub API 401 Bad credentials ghp_secret";
    const cancelled = await service.cancel(id);
    await running;
    expect(executor.killed).toHaveLength(1);
    expect(cancelled.status).toBe("cancelled");
    const results = Object.fromEntries(
      (cancelled.cancelled?.cleanup ?? []).map((c) => [c.target, c]),
    );
    expect(results.container?.result).toBe("done");
    expect(results.pull_request).toMatchObject({ result: "failed" });
    expect(results.pull_request?.detail).not.toContain("ghp_secret");
    expect(results.branch?.result).toBe("done");
    expect(results.workspace?.result).toBe("done");
    ledger.close();
  });

  it("中止したタスクへの操作は拒否し、台帳に書かない（再起動できる。レビュー指摘）", async () => {
    const { ledger, service, id } = await toDeliverableGate();
    service.requestChanges(id, { step: "pr", submission: 1, comments: ["直して"] });
    await service.cancel(id);
    const before = service.get(id)?.ledger.length;
    expect(() => service.voidRemark(id, "implement-1-1")).toThrow(/中止したタスク/);
    expect(service.get(id)?.ledger.length).toBe(before);
    // 再起動しても台帳から状態を復元できる
    const { service: restarted } = makeService(ledger);
    expect(restarted.get(id)?.task.status).toBe("cancelled");
    ledger.close();
  });

  it("状態の復元で受け付けられないイベントは、台帳に書く前に拒否する（レビュー指摘）", async () => {
    const { ledger, service, id } = await toImplement([]);
    const before = service.get(id)?.ledger.length;
    // 内部の操作の誤りで、受け付けられないイベントを書こうとした場合も台帳を汚さない
    const append = (
      service as unknown as {
        append: (task: { id: string; projectId: string }, events: unknown[]) => unknown;
      }
    ).append.bind(service);
    expect(() =>
      append({ id, projectId: "default" }, [
        {
          actor: "sacty",
          event: {
            type: "TestsRun",
            payload: {
              command: "x",
              exitCode: 0,
              unmappedViewpoints: [],
              passed: true,
              output: "",
              durationMs: 1,
            },
          },
        },
      ]),
    ).toThrow(/その操作はできません/);
    expect(service.get(id)?.ledger.length).toBe(before);
    ledger.close();
  });

  it("中止で閉じるPRは、作ったときに記録したリポジトリのものだけ（レビュー指摘）", async () => {
    let prRepo = "acme/app";
    const config = (): ConfigResult => {
      const base = configOf(agent())();
      if (!base.ok || !base.config.repository) throw new Error("unreachable");
      return {
        ok: true,
        config: {
          ...base.config,
          repository: {
            ...base.config.repository,
            pullRequest: { provider: "github", repo: prRepo },
          },
        },
      };
    };
    const pulls = new FakePulls();
    const { ledger, service, id } = await toDeliverableGate([], { pulls, config });
    expect(service.get(id)?.task.pullRequest?.repo).toBe("acme/app");
    prRepo = "acme/other"; // 設定を変えてから中止した
    await service.cancel(id);
    expect(pulls.closed).toEqual([{ repo: "acme/app", token: "ghp_secret", number: 7 }]);
    ledger.close();
  });

  it("準備の間に一時停止したら、新しいコンテナを起動しない（レビュー指摘）", async () => {
    // 対象リポジトリは、要求要件の工程の前に用意する（PBI-15）
    const ledger = new SqliteLedgerStore(dbPath);
    const repos = new FakeRepos();
    const gate = Promise.withResolvers<void>();
    repos.prepareGate = gate.promise;
    const { service, executor } = makeService(ledger, [out("# 要求要件")], { repos });
    const { id } = service.createTicket({ title: "A" });
    const callsBefore = executor.calls.length;
    const running = service.runNext(id);
    await repos.prepareStarted.promise;
    const pausing = service.pause(id);
    gate.resolve();
    await Promise.all([running, pausing]);
    expect(executor.calls.length).toBe(callsBefore); // 要求要件のコンテナは起動していない
    expect(service.get(id)?.task).toMatchObject({ status: "paused", pausedReason: "manual" });
    ledger.close();
  });

  it("PRの作成に失敗しても、プッシュ済みのブランチは中止で消す（レビュー指摘）", async () => {
    const pulls = new FakePulls();
    pulls.fail = "PRを作れませんでした：GitHub API 422";
    const repos = new FakeRepos();
    const { ledger, service, id } = await toDeliverableGate([], { pulls, repos });
    expect(service.get(id)?.task.pullRequest).toBeUndefined();
    expect(service.get(id)?.task.pushedBranch?.branch).toBe(`sacty/task-${id.slice(0, 8)}`);
    expect(service.cleanupPlan(id)?.find((p) => p.target === "branch")?.present).toBe(true);
    await service.cancel(id);
    expect(repos.deleted).toEqual([`sacty/task-${id.slice(0, 8)}`]);
    ledger.close();
  });

  it("止めたコンテナの停止を確かめられなければ、一時停止に記録して、再開や中止で確かめ直す（レビュー指摘）", async () => {
    const { ledger, service, executor, id } = await toImplement([HOLD]);
    executor.stops = false;
    const running = service.runNext(id);
    const runId = await executor.started.promise;
    await service.pause(id);
    await running;
    const paused = service.get(id)?.task;
    expect(paused).toMatchObject({ pausedReason: "manual", unstoppedRuns: [runId] });
    expect(ja(paused?.pausedMessage)).toMatch(/停止を確認できませんでした/);

    // 再起動しても、台帳から追える
    const { service: restarted, executor: restartedExecutor } = makeService(ledger);
    restartedExecutor.stops = false;
    expect(restarted.get(id)?.task.unstoppedRuns).toEqual([runId]);
    // 止まったことを確かめられないうちは、再開しない
    expect(await restarted.confirmPausedContainers(id)).toBe(false);
    expect(() => restarted.resume(id, {})).toThrow(/停止を確認できませんでした/);
    // 一時停止のまま中止しても、作業領域は消さない
    const cancelled = await restarted.cancel(id);
    const results = Object.fromEntries(
      (cancelled.cancelled?.cleanup ?? []).map((c) => [c.target, c]),
    );
    expect(results.container?.result).toBe("failed");
    expect(results.workspace?.result).toBe("failed");
    expect(existsSync(join(dir, "workspaces", id, "repo"))).toBe(true);
    ledger.close();
  });

  it("止まったことを確かめられたら、再開できる（レビュー指摘）", async () => {
    const { ledger, service, executor, id } = await toImplement([
      HOLD,
      implement("# v1"),
      review(),
    ]);
    executor.stops = false;
    const running = service.runNext(id);
    await executor.started.promise;
    await service.pause(id);
    await running;
    executor.stops = true; // 遅れて止まった
    expect(await service.confirmPausedContainers(id)).toBe(true);
    expect(service.resume(id, {}, { containersConfirmed: true }).status).toBe("queued");
    expect(service.get(id)?.task.unstoppedRuns).toBeUndefined();
    ledger.close();
  });

  it("一時停止は、停止の確認と記録が終わってから返る（レビュー指摘）", async () => {
    const tests = new FakeTests();
    tests.hold = true;
    const { ledger, service, executor, id } = await toImplement([implement("# v1")], { tests });
    await service.runNext(id); // 実装
    // 停止の確認に時間がかかる
    const gate = Promise.withResolvers<boolean>();
    executor.ensureStopped = () => gate.promise;
    const verifying = service.runNext(id);
    await tests.started.promise;
    let returned = false;
    const pausing = service.pause(id).then((t) => {
      returned = true;
      return t;
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(returned).toBe(false); // 確認が終わるまで返らない
    gate.resolve(true);
    const paused = await pausing;
    await verifying;
    expect(paused.status).toBe("paused");
    ledger.close();
  });

  it("デーモンを再起動しても、テストの実行待ちから検証を続ける", async () => {
    const { ledger, service, id } = await toImplement([implement("# v1")]);
    await service.runNext(id);
    const { service: restarted } = makeService(ledger, [review()]);
    restarted.recoverInterrupted();
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    expect(restarted.get(id)?.task.steps[2]?.state).toBe("done");
    ledger.close();
  });
});

describe("プロジェクトと GitHub Issue の取り込み（PBI-5a）", () => {
  const issue = (repo: string, number: number, labels: string[], title = `Issue ${number}`) => ({
    repo,
    number,
    title,
    body: "Issue の本文",
    url: `https://github.com/${repo}/issues/${number}`,
    labels,
  });

  function setup(
    outcomes: AgentOutcome[] = [],
    options: { config?: () => ConfigResult; github?: FakeGitHub } = {},
  ) {
    const ledger = new SqliteLedgerStore(dbPath);
    const projects = new MemoryProjectStore();
    const made = makeService(ledger, outcomes, { projects, ...options });
    const pay = made.service.saveProject(undefined, {
      name: "決済",
      githubAccount: "me",
      sources: [{ scope: "org", target: "acme", label: "sacty" }],
      repositories: [
        {
          repo: "acme/payments",
          baseBranch: "develop",
          testCommand: "pnpm test",
          pullRequest: true,
        },
      ],
    });
    const auth = made.service.saveProject(undefined, {
      name: "認証",
      sources: [{ scope: "repo", target: "acme/auth", label: "ai" }],
    });
    return { ledger, ...made, pay, auth };
  }

  it("既定のプロジェクトがあり、取り込み元が重複するプロジェクトは作れない", () => {
    const { ledger, service } = setup();
    expect(service.listProjects().map((p) => p.name)).toEqual(["デフォルト", "決済", "認証"]);
    expect(() =>
      service.saveProject(undefined, {
        name: "重複",
        sources: [{ scope: "org", target: "ACME", label: "x" }],
      }),
    ).toThrow(/プロジェクト「決済」に登録されています/);
    expect(() => service.saveProject("no-such", { name: "x" })).toThrow(/見つかりません/);
    ledger.close();
  });

  it("画面のチケットは、指定したプロジェクトに作る（無いプロジェクトは拒否する。PBI-4a）", () => {
    const { ledger, service, pay } = setup();
    expect(service.createTicket({ title: "A", projectId: pay.id }).projectId).toBe(pay.id);
    expect(service.createTicket({ title: "B" }).projectId).toBe("default");
    expect(() => service.createTicket({ title: "C", projectId: "no-such" })).toThrow(
      /プロジェクトが見つかりません/,
    );
    ledger.close();
  });

  it("Org の設定画面に、ほかのプロジェクトが担当している除外リポジトリを出す", () => {
    const { ledger, service, pay } = setup();
    expect(service.getProject(pay.id)?.exclusions).toEqual([
      { org: "acme", repos: [{ repo: "acme/auth", projectName: "認証" }] },
    ]);
    ledger.close();
  });

  it("取り込み元ごとに検索し、担当のプロジェクトのラベルが付いた Issue だけを、二重にならないよう取り込む", () => {
    const { ledger, service, pay, auth } = setup();
    // 検索には、プロジェクトに選んだ gh のアカウントを使う（PBI-13）。選んでいなければアカウントは無い
    expect(service.intakeSources()).toEqual([
      { query: 'is:issue is:open org:acme label:"sacty"', account: "me", project: "決済" },
      { query: 'is:issue is:open repo:acme/auth label:"ai"', project: "認証" },
    ]);
    const created = service.importIssues([
      issue("acme/payments", 1, ["sacty"], "冪等性キー"),
      issue("acme/payments", 2, ["bug"]), // ラベルが違う
      issue("acme/auth", 3, ["sacty"]), // リポジトリ単位の担当（認証）が優先し、ラベル ai が必要
      issue("acme/auth", 4, ["AI"]),
      issue("other/repo", 5, ["sacty"]), // どのプロジェクトも担当していない
      issue("acme/payments", 1, ["sacty"]), // 同じ取り込みの中の重複
    ]);
    expect(created.map((t) => [t.projectId, t.source?.repo, t.source?.number])).toEqual([
      [pay.id, "acme/payments", 1],
      [auth.id, "acme/auth", 4],
    ]);
    expect(created[0]).toMatchObject({
      title: "冪等性キー",
      body: "Issue の本文",
      start: "github_issue",
    });
    const ledgerEvent = service.get(created[0]?.id ?? "")?.ledger[0];
    expect(ledgerEvent?.type === "TaskCreated" && ledgerEvent.payload.source).toEqual({
      kind: "github_issue",
      repo: "acme/payments",
      number: 1,
      url: "https://github.com/acme/payments/issues/1",
    });
    expect(ledgerEvent?.projectId).toBe(pay.id);

    // 次の取り込みでも、同じ Issue は取り込まない（大文字・小文字は区別しない）
    expect(service.importIssues([issue("ACME/Payments", 1, ["sacty"])])).toEqual([]);
    // 担当の判定は取り込むたびに行う（設定の変更をすぐに反映する）
    service.saveProject(auth.id, { name: "認証", sources: [] });
    expect(service.importIssues([issue("acme/auth", 6, ["sacty"])])[0]?.projectId).toBe(pay.id);
    ledger.close();
  });

  /** GitHub のトークンも設定した設定。 */
  const withGitHub = (): ConfigResult => {
    const base = configOf(agent())();
    if (!base.ok) throw new Error("unreachable");
    return {
      ok: true,
      config: { ...base.config, github: { pollIntervalSec: 300 } },
    };
  };

  it("長い Issue の本文やタイトルも切り詰めずに取り込む（レビュー指摘）", () => {
    const { ledger, service } = setup();
    const body = `${"a".repeat(10_000)}\n\n## 必須条件\n- 二重に処理しない`;
    const title = "t".repeat(250);
    const [task] = service.importIssues([
      { ...issue("acme/payments", 12, ["sacty"]), body, title },
    ]);
    expect(task?.body).toBe(body);
    expect(task?.title).toBe(title);
    ledger.close();
  });

  it("Issue から作ったタスクは、その Issue のリポジトリに、プロジェクトの設定で実装する", async () => {
    const { ledger, service, repos, id } = await (async () => {
      const made = setup(
        [
          {
            kind: "completed",
            output: "# 要求要件",
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
          },
          {
            kind: "completed",
            output: `# 設計\n\n\`\`\`json\n${JSON.stringify({ "sacty-test-viewpoints": [{ title: "a", input: "b", expected: "c" }] })}\n\`\`\``,
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
          },
          {
            kind: "completed",
            output: `# 実装\n\n\`\`\`json\n${JSON.stringify({ "sacty-test-map": [{ viewpointId: "TV-1", tests: ["t"] }] })}\n\`\`\``,
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
          },
        ],
        { config: withGitHub },
      );
      const [task] = made.service.importIssues([issue("acme/payments", 9, ["sacty"])]);
      return { ...made, id: task?.id ?? "" };
    })();
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    expect(repos.prepared[0]).toMatchObject({
      url: "https://github.com/acme/payments.git",
      baseBranch: "develop",
    });
    ledger.close();
  });

  it("プロジェクトに選んだ gh のアカウントでトークンを取り出し、HTTPS の clone を認証する（PBI-13）", async () => {
    const outcomes: AgentOutcome[] = [
      {
        kind: "completed",
        output: "# 要求要件",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
      {
        kind: "completed",
        output: "# 設計",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
    ];
    // アクティブなアカウントは別のもの。プロジェクトに選んだアカウントのトークンを使う
    const github = new FakeGitHub({ me: "ghp_active", "side-job": "ghp_side" });
    const { ledger, service, repos, pay } = setup(outcomes, { github });
    service.saveProject(pay.id, { ...pay, githubAccount: "side-job" });
    const [task] = service.importIssues([issue("acme/payments", 11, ["sacty"])]);
    const id = task?.id ?? "";
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    expect(github.requested).toEqual(["side-job"]);
    expect(repos.prepared[0]?.url).toBe("https://github.com/acme/payments.git");
    // トークンは環境変数でだけ渡し、選んだアカウントのものを使う
    expect(repos.prepared[0]?.authEnv?.GIT_CONFIG_VALUE_0).toBe(
      `Authorization: Basic ${Buffer.from("x-access-token:ghp_side").toString("base64")}`,
    );
    ledger.close();
  });

  it("GitHub のアカウントを選んでいないプロジェクトは、アクティブなアカウントを使わずに理由を記録して止める（PBI-13）", async () => {
    const outcomes: AgentOutcome[] = [
      {
        kind: "completed",
        output: "# 要求要件",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
      {
        kind: "completed",
        output: "# 設計",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
    ];
    const github = new FakeGitHub({ me: "ghp_active" });
    const { ledger, service, repos, pay } = setup(outcomes, { github });
    // インポートしたプロジェクトなど、アカウントを選んでいない
    const { githubAccount: _, ...withoutAccount } = pay;
    service.saveProject(pay.id, withoutAccount);
    const [task] = service.importIssues([issue("acme/payments", 13, ["sacty"])]);
    const id = task?.id ?? "";
    // 対象リポジトリは要求要件の工程の前に用意するので、要求要件の前に止まる（PBI-15）
    await service.runNext(id);
    expect(github.requested).toEqual([]);
    expect(repos.prepared).toHaveLength(0);
    // タスクの開始時に止まるので、エージェントの実行の失敗ではなく、一時停止の理由として記録する（PBI-15）
    expect(service.get(id)?.task.pausedMessage).toEqual({
      code: "github.accountRequired",
      params: { project: "決済" },
    });
    ledger.close();
  });

  it("プロジェクトに選んだ gh のアカウントでログインしていなければ、理由を記録して止める（PBI-13）", async () => {
    const outcomes: AgentOutcome[] = [
      {
        kind: "completed",
        output: "# 要求要件",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
      {
        kind: "completed",
        output: "# 設計",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
    ];
    const other = setup(outcomes, { github: new FakeGitHub({ me: "ghp_active" }) });
    other.service.saveProject(other.pay.id, { ...other.pay, githubAccount: "side-job" });
    const [t2] = other.service.importIssues([issue("acme/payments", 12, ["sacty"])]);
    const id2 = t2?.id ?? "";
    // 対象リポジトリは要求要件の工程の前に用意するので、要求要件の前に止まる（PBI-15）
    await other.service.runNext(id2);
    expect(other.service.get(id2)?.task.pausedReason).toBe("error");
    // タスクの開始時に止まるので、エージェントの実行の失敗ではなく、一時停止の理由として記録する（PBI-15）
    expect(other.service.get(id2)?.task.pausedMessage).toEqual({
      code: "github.accountUnavailable",
      params: { account: "side-job" },
    });
    expect(other.repos.prepared).toHaveLength(0);
    other.ledger.close();
  });

  it("Issue のリポジトリの設定がプロジェクトに無ければ、理由を記録して止める", async () => {
    const { ledger, service } = setup([
      {
        kind: "completed",
        output: "# 要求要件",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
      {
        kind: "completed",
        output: "# 設計",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
    ]);
    const [task] = service.importIssues([issue("acme/ledger", 10, ["sacty"])]);
    const id = task?.id ?? "";
    // 対象リポジトリは要求要件の工程の前に用意するので、要求要件の前に止まる（PBI-15）
    await service.runNext(id);
    // タスクの開始時に止まるので、エージェントの実行の失敗ではなく、一時停止の理由として記録する（PBI-15）
    expect(ja(service.get(id)?.task.pausedMessage)).toContain(
      "プロジェクト「決済」に、acme/ledger のリポジトリの設定",
    );
    ledger.close();
  });
});

describe("プロジェクト定義のエクスポート・インポート（PBI-5b）", () => {
  it("エクスポートした定義を、新しいプロジェクトとしてインポートでき、重複していれば拒否する", () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const projects = new MemoryProjectStore();
    const { service } = makeService(ledger, [], { projects });
    const pay = service.saveProject(undefined, {
      name: "決済",
      sources: [{ scope: "org", target: "acme", label: "sacty" }],
      repositories: [{ repo: "acme/payments", testCommand: "npm test" }],
    });
    const exported = service.exportProject(pay.id);
    expect(service.exportProject("no-such")).toBeUndefined();

    // 同じ取り込み元のプロジェクトがあるあいだは、インポートできない
    expect(() => service.importProject(exported)).toThrow(/プロジェクト「決済」に登録されています/);
    expect(service.listProjects()).toHaveLength(2);

    // 別の sacty（取り込み元が重複しない環境）へは、新しいプロジェクトとしてインポートできる
    const other = makeService(new SqliteLedgerStore(join(dir, "other.db")), [], {
      projects: new MemoryProjectStore(),
    });
    const imported = other.service.importProject(JSON.parse(JSON.stringify(exported)));
    expect(imported.id).not.toBe(pay.id);
    expect(imported).toMatchObject({
      name: "決済",
      sources: pay.sources,
      repositories: pay.repositories,
    });
    ledger.close();
  });
});

describe("コンテキストリポジトリ（PBI-6a）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });

  it("プロジェクトのコンテキストを合成して工程エージェントに渡し、使ったリポジトリとコミットを記録する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const projects = new MemoryProjectStore();
    const contexts = new FakeContexts({
      "https://example.com/company.git": { "rules.md": "# 会社の規約" },
      "https://example.com/team.git": {
        "rules.md": "# チームの規約",
        "sacty-context.yaml": "extends: https://example.com/company.git#main\n",
      },
    });
    const { service, executor } = makeService(ledger, [out("# 要求要件")], { projects, contexts });
    const project = service.saveProject(undefined, {
      name: "決済",
      context: { repo: "https://example.com/team.git" },
    });
    const { id } = service.createTicket({ title: "A", projectId: project.id });
    await service.runNext(id);

    expect(executor.contexts[0]).toMatch(/会社の規約[\s\S]*チームの規約/);
    const resolved = service.get(id)?.ledger.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.layers).toEqual([
      { repo: "https://example.com/company.git", ref: "main", commit: "c0ffee".padEnd(40, "0") },
      { repo: "https://example.com/team.git", commit: "c0ffee".padEnd(40, "0") },
    ]);
    expect(service.get(id)?.task.context?.layers).toHaveLength(2);
    // コンテキストの無いプロジェクトでは、何も渡さない
    const other = service.createTicket({ title: "B" });
    expect(executor.contexts).toHaveLength(1);
    expect(other.projectId).toBe("default");
    ledger.close();
  });

  it("コンテキストを取得できなければ、理由を記録して止める", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [out("# 要求要件")], {
      contexts: new FakeContexts({}),
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      context: { repo: "https://example.com/missing.git" },
    });
    const { id } = service.createTicket({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.pausedReason).toBe("error");
    const failed = service.get(id)?.ledger.findLast((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toMatch(
      /取得できません/,
    );
    // 台帳にはコードと引数で記録し、画面が画面の言語の文にする（PBI-11b）
    expect(failed?.type === "AgentRunFailed" && failed.payload.message).toEqual({
      code: "context.fetchFailed",
      params: { key: "https://example.com/missing.git#", detail: "repository not found" },
    });
    expect(failed?.type === "AgentRunFailed" && renderMessage(failed.payload.message, "en")).toBe(
      "Cannot fetch the context repository (https://example.com/missing.git#): repository not found",
    );
    ledger.close();
  });
});

describe("コンテキストの取得の認証（PBI-13 レビュー指摘）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const basic = (token: string) =>
    `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;

  it("HTTPS の GitHub のコンテキストと継承先は、プロジェクトに選んだ gh のアカウントで取得する", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const github = new FakeGitHub({ me: "ghp_active", "side-job": "ghp_side" });
    const contexts = new FakeContexts({
      "https://github.com/acme/team-ctx.git": {
        "rules.md": "# チーム",
        "sacty-context.yaml": "extends: https://github.com/acme/company-ctx.git#main\n",
      },
      "https://github.com/acme/company-ctx.git": {
        "rules.md": "# 会社",
        "sacty-context.yaml": "extends: /local/base\n",
      },
      "/local/base": { "rules.md": "# 共通" },
    });
    const { service } = makeService(ledger, [out("# 要求要件")], { contexts, github });
    const project = service.saveProject(undefined, {
      name: "副業",
      githubAccount: "side-job",
      context: { repo: "https://github.com/acme/team-ctx.git" },
    });
    const { id } = service.createTicket({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(contexts.fetched).toEqual([
      {
        repo: "https://github.com/acme/team-ctx.git",
        authEnv: expect.objectContaining({ GIT_CONFIG_VALUE_0: basic("ghp_side") }),
      },
      {
        repo: "https://github.com/acme/company-ctx.git",
        authEnv: expect.objectContaining({ GIT_CONFIG_VALUE_0: basic("ghp_side") }),
      },
      // GitHub の HTTPS でないもの（ローカルのパス・SSH）は、ホストの認証のまま
      { repo: "/local/base" },
    ]);
    expect(github.requested).toEqual(["side-job", "side-job"]);
    ledger.close();
  });

  it("アカウントを選んでいなければ取得せずに止め、取得の失敗ではトークンを残さない", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const contexts = new FakeContexts({});
    const { service, executor } = makeService(ledger, [out("# 要求要件")], { contexts });
    const unset = service.saveProject(undefined, {
      name: "未選択",
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTicket({ title: "A", projectId: unset.id });
    await service.runNext(id);
    expect(contexts.fetched).toEqual([]);
    expect(executor.calls).toHaveLength(0);
    const failed = service.get(id)?.ledger.findLast((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && failed.payload.message).toEqual({
      code: "github.accountRequired",
      params: { project: "未選択" },
    });

    contexts.fail = true;
    const chosen = service.saveProject(undefined, {
      name: "選択済み",
      githubAccount: "me",
      context: { repo: "https://github.com/acme/private-ctx.git" },
    });
    const second = service.createTicket({ title: "B", projectId: chosen.id });
    await service.runNext(second.id);
    const ledgerText = JSON.stringify(service.get(second.id)?.ledger);
    expect(ledgerText).toContain("context.fetchFailed");
    expect(ledgerText).not.toContain("ghp_secret");
    expect(ledgerText).not.toContain(Buffer.from("x-access-token:ghp_secret").toString("base64"));
    ledger.close();
  });
});

describe("コンテキストの MCP サーバー（PBI-6b）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const contexts = () =>
    new FakeContexts({
      "https://example.com/ctx.git": {
        "mcp.yaml":
          "servers:\n  github:\n    command: server-github\n    env:\n      GITHUB_TOKEN: { secret: mcp-github }\n",
      },
    });

  it("MCP の秘密情報は、短い値でも出力から取り除き、台帳に残さない", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [out("# 要求要件\nPIN は pin123 です")], {
      contexts: contexts(),
      secrets: { "claude-oauth-token": "oauth-secret", "mcp-github": "pin123" },
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      context: { repo: "https://example.com/ctx.git" },
    });
    const { id } = service.createTicket({ title: "A", projectId: project.id });
    await service.runNext(id);
    const ledgerText = JSON.stringify(service.get(id)?.ledger);
    expect(ledgerText).not.toContain("pin123");
    expect(ledgerText).toContain("PIN は [REDACTED] です");
    ledger.close();
  });

  it("MCP の設定には秘密情報の名前だけを書き、値は実行時に環境変数で渡し、出力からは取り除く", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(
      ledger,
      [out("# 要求要件\n値は mcp-value-123 でした")],
      {
        contexts: contexts(),
        secrets: { "claude-oauth-token": "oauth-secret", "mcp-github": "mcp-value-123" },
      },
    );
    const project = service.saveProject(undefined, {
      name: "決済",
      context: { repo: "https://example.com/ctx.git" },
    });
    const { id } = service.createTicket({ title: "A", projectId: project.id });
    await service.runNext(id);

    const invocation = executor.calls[0];
    expect(invocation?.env.SACTY_MCP_SECRET_0).toBe("mcp-value-123");
    expect(invocation?.command).toContain("--strict-mcp-config");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 設定に書く参照の文字列そのもの
    expect(executor.mcpConfigs[0]).toContain("${SACTY_MCP_SECRET_0}");
    expect(executor.mcpConfigs[0]).not.toContain("mcp-value-123");
    // 台帳には値を残さない
    expect(JSON.stringify(service.get(id)?.ledger)).not.toContain("mcp-value-123");
    ledger.close();
  });

  it("MCP サーバーが参照する秘密情報が無ければ、名前を示して止める", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service, executor } = makeService(ledger, [out("# 要求要件")], {
      contexts: contexts(),
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      context: { repo: "https://example.com/ctx.git" },
    });
    const { id } = service.createTicket({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.pausedReason).toBe("auth");
    const failed = service.get(id)?.ledger.findLast((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toContain(
      "秘密情報「mcp-github」が見つかりません",
    );
    ledger.close();
  });
});

describe("API", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };

  it("トークンがないと401を返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(makeService(ledger).service, token);
    expect((await app.request("/api/tasks")).status).toBe(401);
    expect(
      (await app.request("/api/tasks", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    ledger.close();
  });

  it("チケットを作ると、一覧と詳細（台帳つき）に現れる", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(makeService(ledger).service, token);

    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "  決済APIの設計  ", body: "冪等性キーを扱う" }),
    });
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: { id: string; title: string } };
    expect(task.title).toBe("決済APIの設計");

    const list = (await (await app.request("/api/tasks", { headers: auth })).json()) as {
      tasks: { id: string }[];
    };
    expect(list.tasks.map((t) => t.id)).toEqual([task.id]);

    const detail = (await (
      await app.request(`/api/tasks/${task.id}`, { headers: auth })
    ).json()) as { ledger: { type: string; actor: string }[] };
    expect(detail.ledger.map((e) => [e.type, e.actor])).toEqual([
      ["TaskCreated", "person"],
      ["StepsChosen", "sacty"],
    ]);
    ledger.close();
  });

  it("タイトルが空なら400を返し、台帳に何も書かない", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(makeService(ledger).service, token);
    const res = await app.request("/api/tickets", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
    expect(ledger.all()).toHaveLength(0);
    ledger.close();
  });

  it("gh にログイン済みの GitHub のアカウントを返す（トークンは返さない。PBI-13）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(
      makeService(ledger, [], {
        github: new FakeGitHub({ me: "ghp_active", "side-job": "ghp_side" }),
      }).service,
      token,
    );
    const res = await app.request("/api/github/accounts", { headers: auth });
    const body = await res.json();
    expect(body).toEqual({
      accounts: [
        { login: "me", active: true },
        { login: "side-job", active: false },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("ghp_");
    const failing = createApp(
      makeService(ledger, [], {
        github: Object.assign(new FakeGitHub(), {
          accounts: () => Promise.reject(new MessageError(message("github.ghMissing"))),
        }),
      }).service,
      token,
    );
    expect(await (await failing.request("/api/github/accounts", { headers: auth })).json()).toEqual(
      {
        error: { code: "github.ghMissing" },
      },
    );
    ledger.close();
  });

  it("状態に合わない再開は409、不正な金額は400を返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger);
    const app = createApp(service, token);
    const task = service.createTicket({ title: "A" });
    const resume = (body: unknown) =>
      app.request(`/api/tasks/${task.id}/resume`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    const rejected = await resume({});
    expect(rejected.status).toBe(409);
    // 理由は文言のコードと引数で返し、画面が画面の言語の文言にする（PBI-11）
    expect(await rejected.json()).toEqual({
      error: "invalid_operation",
      messages: [{ code: "resume.notPaused" }],
    });
    expect((await resume({ capUsd: -1 })).status).toBe(400);
    expect((await resume({ capUsd: "3" })).status).toBe(400);
    ledger.close();
  });

  it("判断待ちでない変更の申し出への判断は409、不正な入力は400を返す（PBI-9）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger);
    const app = createApp(service, token);
    const task = service.createTicket({ title: "A" });
    const decide = (body: unknown) =>
      app.request(`/api/tasks/${task.id}/proposals/CP-1/decide`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    expect((await decide({ accept: true })).status).toBe(409);
    expect((await decide({ accept: "yes" })).status).toBe(400);
    expect(service.get(task.id)?.ledger.map((e) => e.type)).toEqual(["TaskCreated", "StepsChosen"]);
    ledger.close();
  });

  it("プロジェクトのエクスポートは定義を返し、インポートは形式の誤りに400・重複に409を返す（PBI-5b）", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const { service } = makeService(ledger, [], { projects: new MemoryProjectStore() });
    const app = createApp(service, token);
    const pay = service.saveProject(undefined, {
      name: "決済",
      sources: [{ scope: "repo", target: "acme/payments", label: "sacty" }],
    });
    const res = await app.request(`/api/projects/${pay.id}/export`, { headers: auth });
    expect(res.status).toBe(200);
    const exported = await res.json();
    expect(exported).toMatchObject({ sacty: "project", version: 1, project: { name: "決済" } });
    expect((await app.request("/api/projects/no-such/export", { headers: auth })).status).toBe(404);

    const post = (body: unknown) =>
      app.request("/api/projects/import", {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    const conflict = await post(exported);
    expect(conflict.status).toBe(409);
    expect(((await conflict.json()) as { messages: unknown[] }).messages).toEqual([
      {
        code: "project.sourceTaken",
        params: { scope: "repo", target: "acme/payments", project: "決済" },
      },
    ]);
    expect((await post({ ...exported, extra: 1 })).status).toBe(400);
    const badVersion = await post({ sacty: "project", version: 9, project: { name: "x" } });
    expect(badVersion.status).toBe(400);
    expect(((await badVersion.json()) as { issues: unknown[] }).issues[0]).toEqual({
      path: ["version"],
      message: { code: "input.unsupportedVersion" },
    });
    // コードを指定していない標準の検査も、コードと引数で返す（zod の英語の文は返さない）
    const save = await app.request(`/api/projects/${pay.id}`, {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        name: "決済",
        repositories: [{ repo: "acme/payments", testCommand: "t", baseBranch: "" }],
      }),
    });
    expect(save.status).toBe(400);
    expect(((await save.json()) as { issues: unknown[] }).issues).toEqual([
      { path: ["repositories", 0, "baseBranch"], message: { code: "input.required" } },
    ]);
    const created = await post({
      ...exported,
      project: { ...exported.project, name: "決済（コピー）", sources: [] },
    });
    expect(created.status).toBe(201);
    ledger.close();
  });

  it("存在しないタスクは404を返す", async () => {
    const ledger = new SqliteLedgerStore(dbPath);
    const app = createApp(makeService(ledger).service, token);
    expect((await app.request("/api/tasks/nope", { headers: auth })).status).toBe(404);
    ledger.close();
  });
});
