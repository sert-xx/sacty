import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  CiFailure,
  DaemonText,
  EventInput,
  ProjectDefinition,
  StepKey,
  Task,
} from "@sacty/core";
import {
  ANSWER_MAX,
  activeStep,
  budgetState,
  DEPLOYMENT_CI_GRACE_MS,
  DEPLOYMENT_CI_TIMEOUT_MS,
  deliveredWithoutChanges,
  exportDue,
  isCompleted,
  isFinished,
  MAX_CHANGE_REQUESTS,
  MAX_FIX_CHAIN,
  MAX_VERIFY_ATTEMPTS,
  MVP_STEPS,
  message,
  QUESTION_MAX,
  renderMessage,
  reworkTargets,
  STEP_PLANS,
  stepRunning,
} from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentExecutor } from "./agents/docker.js";
import type { LocalForward } from "./agents/forward.js";
import type { Invocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { DockerTestRunner, type TestRunner, type TestRunResult } from "./agents/test-runner.js";
import type { CiSnapshot, CiStatusReader } from "./ci.js";
import { type AgentConfig, type ConfigResult, loadConfig, type SactyConfig } from "./config.js";
import {
  type ContextFetcher,
  type ContextRef,
  DEFAULT_CONTEXT_DIR,
  GitContextFetcher,
} from "./context.js";
import { ContextMcpServers } from "./context-mcp.js";
import { MessageError } from "./errors.js";
import type { GitHubAuth } from "./gh.js";
import {
  type PullRequestFeedback,
  type PullRequestStatus,
  type PullRequests,
  type SactyReviewRound,
  sactyReviewTask,
} from "./github.js";
import { type HostMcpConnection, HostMcpFile, type HostMcpSpec, toHostMcp } from "./host-mcp.js";
import { SlackNotifier } from "./notifier.js";
import { OrchestratorSessionStore } from "./orchestrator-sessions.js";
import { type Platform, PlatformCredentials, PlatformFile, toPlatform } from "./platforms.js";
import { NOT_APPLICABLE, PR_BODY_MAX, type TemplateLookup } from "./pr-template.js";
import { MemoryProjectStore, SqliteProjectStore } from "./projects.js";
import { buildOrchestratorPrompt, buildPullRequestBody, changeableSteps } from "./prompts.js";
import { NothingToCommitError, type RepositoryWorkspace } from "./repository.js";
import {
  MemorySecretStore,
  OnePasswordSecretStore,
  type OpRunner,
  ResolvingSecretStore,
  SecretNotFoundError,
} from "./secrets.js";
import { createApp } from "./server.js";
import {
  awaitingIssueComment,
  InvalidOperationError,
  type ServiceDeps,
  TaskService,
} from "./service.js";
import type { ServiceRunner, ServicesSpec } from "./services.js";
import { type SessionLogSink, SessionLogStore } from "./session-logs.js";
import { MemorySettingsStore, SqliteSettingsStore } from "./settings.js";
import type { SharedComposeFetcher } from "./shared-compose.js";
import type { FoundTicket, TicketClient } from "./tickets.js";

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
    platforms: Platform[] = [],
    hostMcp: HostMcpSpec[] = [],
  ): (() => ConfigResult) =>
  () => ({
    ok: true,
    config: {
      image: "sacty-agent:test",
      defaultAgent: a,
      guardianAgent: a,
      budgetPerTaskUsd,
      gatewayRetry: { maxAttempts: 8, maxWaitMs: 600_000 },
      hostAddress: "host-gateway",
      imageBuild: {},
      platforms,
      hostMcp,
    },
  });

/** gh の偽物。ログイン済みのアカウントごとのトークンを返す。 */
class FakeGitHub implements GitHubAuth {
  requested: string[] = [];
  constructor(private readonly tokens: Record<string, string> = { me: "ghp_secret" }) {}
  /** github.com のアカウントは名前だけ、ほかのホストは「ホスト/名前」で持つ。 */
  async accounts() {
    return Object.keys(this.tokens).map((key) => {
      const [host, login] = key.includes("/") ? key.split("/") : ["github.com", key];
      return { host: host ?? "", login: login ?? "", active: login === "me" };
    });
  }
  async token(host: string, account: string) {
    const key = host === "github.com" ? account : `${host}/${account}`;
    this.requested.push(key);
    const token = this.tokens[key];
    if (!token) throw new MessageError(message("github.accountUnavailable", { account, host }));
    return token;
  }
}

/**
 * ID が default のプロジェクトに、gh のアカウント（偽物の me）と、対象（acme/app）を登録した
 * プロジェクトの置き場所。画面で作るタスクは、このリポジトリが対象になる（PBI-25）。
 */
function projectsWithAccount(): MemoryProjectStore {
  const projects = new MemoryProjectStore();
  projects.put("default", {
    name: "デフォルト",
    targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
    githubAccounts: { "github.com": "me" },
  });
  return projects;
}

/** docker compose のサービスの偽物（PBI-47）。起動と停止を記録する。 */
class FakeServices implements ServiceRunner {
  started: {
    runId: string;
    workspaceDir: string;
    spec: ServicesSpec;
    secrets?: readonly string[];
  }[] = [];
  stopped: string[] = [];
  constructor(
    private readonly fail?: DaemonText,
    private readonly services: { name: string; ports: number[] }[] = [
      { name: "db", ports: [5432] },
    ],
  ) {}
  async start(input: {
    runId: string;
    workspaceDir: string;
    spec: ServicesSpec;
    secrets?: readonly string[];
  }) {
    this.started.push(input);
    // 起動の待ち（up --wait）を、打ち切られるまで終わらせない（一時停止・中止のテスト）
    if (this.hold) {
      this.entered.resolve();
      await new Promise<void>((resolve) => {
        this.release = resolve;
      });
    }
    if (this.fail) return { ok: false as const, message: this.fail };
    return {
      ok: true as const,
      started: { network: `sacty-svc-${input.runId}_sacty`, services: this.services },
    };
  }
  async stop(runId: string) {
    this.stopped.push(runId);
  }
  /** true なら、起動を打ち切られるまで待つ。 */
  hold = false;
  entered = Promise.withResolvers<void>();
  aborted: string[] = [];
  private release?: () => void;
  abort(runId: string) {
    this.aborted.push(runId);
    this.release?.();
  }
}

/** 共用の compose のリポジトリの取得の偽物（PBI-70）。取得の呼び出しを記録し、compose ファイルを置く。 */
class FakeSharedComposes implements SharedComposeFetcher {
  calls: { repo: string; ref?: string; dest: string; authEnv?: Record<string, string> }[] = [];
  /** あれば、取得を、これが解決するまで終わらせない（一時停止・中止のテスト）。 */
  gate?: Promise<void>;
  entered = Promise.withResolvers<void>();
  constructor(public fail?: Error) {}
  async checkout(input: Parameters<SharedComposeFetcher["checkout"]>[0]) {
    this.calls.push(input);
    this.entered.resolve();
    if (this.gate) await this.gate;
    if (this.fail) {
      // 途中まで書いたディレクトリが残っても、sacty が消す
      mkdirSync(input.dest, { recursive: true });
      throw this.fail;
    }
    mkdirSync(join(input.dest, "compose"), { recursive: true });
    writeFileSync(
      join(input.dest, "compose", "redis.yml"),
      "services:\n  redis:\n    image: redis\n",
    );
    return { commit: "abc1234def5678" };
  }
}

/** clone の代わりに空のディレクトリを作り、決まった差分を返す偽物。 */
class FakeRepos implements RepositoryWorkspace {
  prepared: {
    dir: string;
    gitDir: string;
    url: string;
    baseBranch?: string;
    authEnv?: Record<string, string>;
    recorded?: string;
  }[] = [];
  /** clone したときの、ブランチの最新のコミット。 */
  head = "base123";
  /** リポジトリの既定のブランチと、ブランチごとの最新のコミット（PBI-25）。 */
  defaultBranch = "main";
  branchHeads: Record<string, string> = {};
  /** 無いブランチ。 */
  missingBranches: string[] = [];
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
    baseBranch: string | undefined,
    authEnv?: Record<string, string>,
    recorded?: string,
  ) {
    if (this.fail) throw new Error(this.fail);
    if (baseBranch && this.missingBranches.includes(baseBranch)) {
      throw new Error(`Remote branch ${baseBranch} not found`);
    }
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
      // ブランチを指定しなければ、既定のブランチを clone する（PBI-25）
      ...(baseBranch ? { baseBranch } : {}),
      ...(authEnv ? { authEnv } : {}),
      ...(recorded ? { recorded } : {}),
    });
    // 用意し直すときは記録済みの起点、初めてならブランチの最新
    return {
      baseCommit:
        recorded ?? (baseBranch ? (this.branchHeads[baseBranch] ?? this.head) : this.head),
      baseBranch: baseBranch ?? this.defaultBranch,
    };
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
  /** 実装後のコードの写し（ゴールガーディアン。PBI-16）。 */
  workingCopies: { dir: string; outDir: string }[] = [];
  copyFail?: string;
  async copyWorkingTree(dir: string, outDir: string) {
    if (this.copyFail) throw new Error(this.copyFail);
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "IMPLEMENTED.md"), "implemented");
    this.workingCopies.push({ dir, outDir });
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
  /** レビューの対象の PR のコミットの取得と、PR の差分（PBI-19）。 */
  fetchedCommits: { gitDir: string; commits: string[]; authEnv?: Record<string, string> }[] = [];
  fetchFail?: string;
  async fetchCommits(gitDir: string, commits: string[], authEnv?: Record<string, string>) {
    if (this.fetchFail) throw new Error(this.fetchFail);
    this.fetchedCommits.push({ gitDir, commits, ...(authEnv ? { authEnv } : {}) });
  }
  /** ベースブランチの最新の取得（統合レビュー。PBI-31）。 */
  branchHead = "c".repeat(40);
  fetchedBranches: { gitDir: string; branch: string; authEnv?: Record<string, string> }[] = [];
  fetchBranchFail?: string;
  async fetchBranch(gitDir: string, branch: string, authEnv?: Record<string, string>) {
    if (this.fetchBranchFail) throw new Error(this.fetchBranchFail);
    this.fetchedBranches.push({ gitDir, branch, ...(authEnv ? { authEnv } : {}) });
    return this.remote[branch] ?? this.branchHead;
  }
  /** タスクブランチの、sacty が積んだ後の変更（PBI-57）。テストで、人が直接積んだ変更を表す。 */
  changed: string[] = [];
  changedCalls: { from: string; to: string }[] = [];
  async changedPaths(_gitDir: string, from: string, to: string) {
    this.changedCalls.push({ from, to });
    return this.changed;
  }
  /** リモートのブランチの先頭（タスクブランチ・工程のブランチ。PBI-57）。PR のマージは、テストで書き換える。 */
  remote: Record<string, string> = {};
  /** プッシュしたコミット（タスクブランチの作成。PBI-57）。 */
  pushedCommits: { commit: string; branch: string }[] = [];
  pushFail?: string;
  async pushCommit(_gitDir: string, commit: string, branch: string) {
    if (this.pushFail) throw new Error(this.pushFail);
    this.pushedCommits.push({ commit, branch });
    this.remote[branch] = commit;
  }
  /** 成果のファイルのコミット（要求要件・設計の PR。PBI-57）。 */
  committedFiles: {
    parent: string;
    files: Record<string, string>;
    branch: string;
    message: string;
    date: string;
    allowEmpty?: boolean;
    commit: string;
  }[] = [];
  commitFilesFail?: string;
  async commitFiles(input: {
    parent: string;
    files: Record<string, string>;
    branch: string;
    message: string;
    date: string;
    allowEmpty?: boolean;
  }) {
    if (this.commitFilesFail) throw new Error(this.commitFilesFail);
    const commit = `d${this.committedFiles.length + 1}`.padEnd(40, "0");
    this.committedFiles.push({
      parent: input.parent,
      files: input.files,
      branch: input.branch,
      message: input.message,
      date: input.date,
      ...(input.allowEmpty ? { allowEmpty: true } : {}),
      commit,
    });
    this.remote[input.branch] = commit;
    return { commit };
  }
  /**
   * コミットにあるファイル（人が PR の中で直してマージした成果のファイル。PBI-63）。commit → path → 本文（null は
   * 消された）。無いコミットは、sacty が最後にコミットした本文を返す（そのままマージされた）。
   */
  files: Record<string, Record<string, string | null>> = {};
  readFail?: string;
  /** ファイルの問題ではない失敗（git を実行できないなど）。 */
  readError?: string;
  readCalls: { gitDir: string; commit: string; path: string }[] = [];
  async readFile(gitDir: string, commit: string, path: string) {
    this.readCalls.push({ gitDir, commit, path });
    if (this.readFail) throw new MessageError(message("git.fileNotText", { path }));
    if (this.readError) throw new Error(this.readError);
    const at = this.files[commit];
    if (at && path in at) return at[path] ?? undefined;
    return this.committedFiles.findLast((c) => path in c.files)?.files[path];
  }
  /** コミットにあるシンボリックリンク（commit → path → リンクの先。PBI-89）。 */
  links: Record<string, Record<string, string>> = {};
  async readLink(_gitDir: string, commit: string, path: string) {
    return this.links[commit]?.[path];
  }
  prDiff = [
    "diff --git a/src/retry.ts b/src/retry.ts",
    "--- a/src/retry.ts",
    "+++ b/src/retry.ts",
    "@@ -1,2 +1,3 @@",
    " import { pay } from './pay';",
    "+export const retry = 3;",
    " export const once = 1;",
  ].join("\n");
  diffedCommits: { baseCommit: string; headCommit: string }[] = [];
  diffFull: boolean[] = [];
  async diffCommits(
    _gitDir: string,
    baseCommit: string,
    headCommit: string,
    options?: { full?: boolean },
  ) {
    this.diffedCommits.push({ baseCommit, headCommit });
    this.diffFull.push(options?.full === true);
    return this.prDiff;
  }
  published: {
    parent: string;
    branch: string;
    message: string;
    date: string;
    keep?: { commit: string; paths: string[] };
  }[] = [];
  publishFail?: string;
  /** true なら、作業領域が起点から何も変わっていない（PBI-90）。 */
  unchanged = false;
  /** あれば、プッシュを、これが解決するまで終わらせない（PR の作成の前の一時停止のテスト。PBI-110）。 */
  publishGate?: Promise<void>;
  publishStarted = Promise.withResolvers<void>();
  async publish(input: {
    parent: string;
    branch: string;
    message: string;
    date: string;
    keep?: { commit: string; paths: string[] };
  }) {
    this.publishStarted.resolve();
    if (this.publishGate) await this.publishGate;
    if (this.publishFail) throw new Error(this.publishFail);
    if (this.unchanged) throw new NothingToCommitError(message("git.nothingToCommit"));
    this.published.push({
      parent: input.parent,
      branch: input.branch,
      message: input.message,
      date: input.date,
      ...(input.keep ? { keep: input.keep } : {}),
    });
    const commit = `c${this.published.length}`.padEnd(40, "0");
    this.remote[input.branch] = commit;
    return { commit };
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
  /** あれば、PR の作成を、これが解決するまで終わらせない（PR の作成中の一時停止のテスト。PBI-110）。 */
  upsertGate?: Promise<void>;
  upsertStarted = Promise.withResolvers<void>();
  async upsert(input: Parameters<PullRequests["upsert"]>[0]) {
    this.upsertStarted.resolve();
    if (this.upsertGate) await this.upsertGate;
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
    this.states[input.number] = { state: "closed" };
  }
  /** 返す PR の状態（承認待ちの見守り。PBI-14a）。states に番号があれば、その PR はそちら（PBI-57）。 */
  state: PullRequestStatus = { state: "open" };
  states: Record<number, PullRequestStatus> = {};
  statusFail?: string;
  checked: { repo: string; token: string; number: number }[] = [];
  async status(input: { repo: string; token: string; number: number }) {
    this.checked.push(input);
    if (this.statusFail) throw new Error(this.statusFail);
    // 先頭のコミットを指定していなければ、レビューの対象の PR の先頭とする（投稿の直前の確認。PBI-111）
    return { headSha: this.prInfo.headSha, ...(this.states[input.number] ?? this.state) };
  }
  /** Issue へのコメント（調査の結果。PBI-18）。 */
  issueComments: { repo: string; token: string; number: number; body: string }[] = [];
  commentFail?: string;
  async commentIssue(input: { repo: string; token: string; number: number; body: string }) {
    if (this.commentFail) throw new Error(this.commentFail);
    this.issueComments.push(input);
    return {
      url: `${input.repo}/issues/${input.number}#issuecomment-${this.issueComments.length}`,
    };
  }
  async findIssueComment(input: { repo: string; number: number; marker: string }) {
    const index = this.issueComments.findIndex(
      (c) => c.repo === input.repo && c.number === input.number && c.body.includes(input.marker),
    );
    return index < 0
      ? undefined
      : {
          url: `${input.repo}/issues/${input.number}#issuecomment-${index + 1}`,
        };
  }
  /** Org（ユーザー）ごとのリポジトリ（PBI-25）。 */
  ownerRepos: Record<string, string[]> = {};
  repositoriesFail?: string;
  repositoryRequests: { org: string; token: string }[] = [];
  async repositories(input: { org: string; token: string }) {
    this.repositoryRequests.push(input);
    if (this.repositoriesFail) throw new Error(this.repositoriesFail);
    return this.ownerRepos[input.org] ?? [];
  }
  /** レビューの対象の PR と、投稿したレビュー（PBI-19）。 */
  prInfo = {
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "再試行の回数を設定できるようにする",
    body: "回数を環境変数で変えられるようにした",
    headSha: "h".repeat(40),
    baseSha: "b".repeat(40),
    author: "alice",
  };
  prInfoFail?: string;
  prInfoRequests: { repo: string; token: string; number: number }[] = [];
  async pullRequest(input: { repo: string; token: string; number: number }) {
    this.prInfoRequests.push(input);
    if (this.prInfoFail) throw new Error(this.prInfoFail);
    return this.prInfo;
  }
  reviews: {
    repo: string;
    token: string;
    number: number;
    commit: string;
    body: string;
    comments?: { path: string; line: number; body: string }[];
  }[] = [];
  reviewFail?: string;
  /** 行へのコメントがあると、GitHub の 422 で失敗させる（行が差分に無いなど）。 */
  rejectComments = false;
  async postReview(input: {
    repo: string;
    token: string;
    number: number;
    commit: string;
    body: string;
    comments: { path: string; line: number; body: string }[];
  }) {
    if (this.reviewFail) throw new Error(this.reviewFail);
    if (this.rejectComments && input.comments.length > 0) {
      throw new MessageError(
        message("github.failed", {
          action: "postReview",
          status: 422,
          detail: "Line could not be resolved",
          hint: "none",
        }),
      );
    }
    this.reviews.push(input);
    return {
      url: `${input.repo}/pull/${input.number}#pullrequestreview-${this.reviews.length}`,
    };
  }
  findReviewAccounts: string[] = [];
  async findReview(input: { repo: string; number: number; account: string; marker: string }) {
    this.findReviewAccounts.push(input.account);
    const index = this.reviews.findIndex(
      (r) => r.repo === input.repo && r.number === input.number && r.body.startsWith(input.marker),
    );
    return index < 0
      ? undefined
      : {
          url: `${input.repo}/pull/${input.number}#pullrequestreview-${index + 1}`,
          body: this.reviews[index]?.body ?? "",
        };
  }
  /** 付けたラベル（PBI-88）。labelFail があれば失敗させる。labelCreated なら、リポジトリに無かったので作ったことにする。 */
  labels: { repo: string; token: string; number: number; label: string }[] = [];
  labelFail?: string;
  labelCreated = false;
  async addLabel(input: { repo: string; token: string; number: number; label: string }) {
    if (this.labelFail) throw new Error(this.labelFail);
    this.labels.push(input);
    return { created: this.labelCreated };
  }
  /** 返す PR へのフィードバック（PBI-14b）。 */
  feedbackList: PullRequestFeedback[] = [];
  /** PR ごとのフィードバック（番号があれば、その PR はそちら。PBI-57）。 */
  feedbackBy: Record<number, PullRequestFeedback[]> = {};
  /** フィードバックを読んだときの、プロジェクトのアカウント（sacty のレビューを除くため。PBI-19）。 */
  feedbackAccounts: (string | undefined)[] = [];
  feedbackNumbers: number[] = [];
  /** フィードバックを読んだときの、含める sacty のレビューのタスク（PBI-88）。 */
  feedbackSactyReviews: (readonly string[] | undefined)[] = [];
  /** 渡された、この PR をレビューした sacty のタスクの回（PBI-88）。 */
  feedbackSactyRounds: (readonly SactyReviewRound[] | undefined)[] = [];
  async feedback(input: {
    account?: string;
    number: number;
    sactyReviews?: readonly SactyReviewRound[];
  }) {
    const allowed = (input.sactyReviews ?? []).filter((r) => r.allowed).map((r) => r.key);
    this.feedbackSactyReviews.push(allowed.length > 0 ? allowed : undefined);
    this.feedbackSactyRounds.push(input.sactyReviews);
    this.feedbackAccounts.push(input.account);
    this.feedbackNumbers.push(input.number);
    // 本物と同じく、sacty のレビューのタスクの投稿は、そのアカウントと回で判定し、ほかのプロジェクトのアカウントの
    // sacty のレビューは除く（PBI-88）
    return (this.feedbackBy[input.number] ?? this.feedbackList).filter((item) => {
      const key = sactyReviewTask(item.body);
      const round = input.sactyReviews?.find((r) => r.key === key && r.account === item.author);
      if (round) return round.allowed;
      return !(key !== undefined && item.author === input.account);
    });
  }
}

/** 決まった結果を順に返す、テスト実行の偽物。 */
class FakeTests implements TestRunner {
  calls: {
    workspaceDir: string;
    command: string;
    image: string;
    env?: Record<string, string>;
    network?: string;
    forwards?: readonly LocalForward[];
  }[] = [];
  /** true なら、止められるまで終わらない（一時停止のテスト用）。 */
  hold = false;
  started = Promise.withResolvers<string>();
  private held = new Map<string, (r: TestRunResult) => void>();
  constructor(readonly results: TestRunResult[] = []) {}
  async run(input: {
    runId: string;
    workspaceDir: string;
    command: string;
    image: string;
    env?: Record<string, string>;
    network?: string;
    forwards?: readonly LocalForward[];
  }) {
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
  /** 実行ごとに渡された、設定のディレクトリに置くファイルのすべて（相対パス → 中身。PBI-76）。 */
  seeds: (Record<string, string> | undefined)[] = [];
  /** HOLD の実行が始まったら解決する。 */
  started = Promise.withResolvers<string>();
  private held = new Map<string, (outcome: AgentOutcome) => void>();
  constructor(private readonly outcomes: (AgentOutcome | typeof HOLD)[]) {}
  /** 実行ごとに、作業領域を読み取り専用で渡したか。 */
  /** 実行ごとに、使い捨ての写し（実装の作業領域ではない）を渡したか。 */
  scratch: boolean[] = [];
  /** 実行ごとに、作業領域にあったファイル（実行の後に消されるので、実行の間に読んでおく）。 */
  workspaceFiles: string[][] = [];
  reviewDiffFiles: (string | undefined)[] = [];
  /** 実行ごとのイメージと、イメージの環境変数（PBI-41）。 */
  images: { image: string; env?: Record<string, string> }[] = [];
  /** 実行ごとにつないだネットワーク（PBI-47）。 */
  networks: (string | undefined)[] = [];
  /** 実行ごとに渡された、localhost に転送するポート（PBI-60）。 */
  forwards: (readonly LocalForward[] | undefined)[] = [];
  /** 実行ごとにマウントされた各実行のセッションログ（PBI-91）。無ければ undefined。 */
  logMounts: ({ readOnly: boolean; files: Record<string, string>; dir: string } | undefined)[] = [];
  /** 渡された実行から結果を作る（エージェントがマウントされたファイルを読んで答える代わり）。undefined なら outcomes の順。 */
  respond?: (invocation: Invocation) => AgentOutcome | undefined;
  async run({
    runId,
    image,
    invocation,
    workspaceDir,
    imageEnv,
    network,
    forwards,
    log,
  }: {
    runId: string;
    image: string;
    invocation: Invocation;
    workspaceDir: string;
    imageEnv?: Record<string, string>;
    network?: string;
    forwards?: readonly LocalForward[];
    log?: SessionLogSink;
  }): Promise<AgentOutcome> {
    this.calls.push(invocation);
    // セッションログ（PBI-62）には、渡された環境変数の値（秘密情報を含む）を出してみる（伏せられることを確かめる）
    log?.stdout(`${JSON.stringify({ type: "fake", env: Object.values(invocation.env) })}\n`);
    log?.stderr(`env ${Object.values(invocation.env).join(" ")}\n`);
    this.networks.push(network);
    this.forwards.push(forwards);
    this.images.push({ image, ...(imageEnv ? { env: imageEnv } : {}) });
    this.dirs.push(workspaceDir);
    this.scratch.push(/[\\/]_(?:snapshots|guardian)[\\/]/.test(workspaceDir));
    this.workspaceFiles.push(existsSync(workspaceDir) ? readdirSync(workspaceDir).sort() : []);
    // レビューの工程で別にマウントされる、PR の差分の全体のファイル（PBI-65。実行の後に消される）
    const reviewMount = invocation.mounts?.find((m) => m.containerPath === "/sacty-review");
    this.reviewDiffFiles.push(
      reviewMount ? readFileSync(join(reviewMount.hostPath, "pr.diff"), "utf8") : undefined,
    );
    // 渡されたコンテキスト（実行の後に消されるので、実行の間に読んでおく）
    const seed = invocation.stage?.seedDir;
    this.contexts.push(
      seed && existsSync(join(seed, "CLAUDE.md"))
        ? readFileSync(join(seed, "CLAUDE.md"), "utf8")
        : undefined,
    );
    this.seeds.push(seed && existsSync(seed) ? readTree(seed) : undefined);
    this.mcpConfigs.push(
      seed && existsSync(join(seed, "mcp.json"))
        ? readFileSync(join(seed, "mcp.json"), "utf8")
        : undefined,
    );
    // 戻すように渡された、保存したセッションのファイル（PBI-67。実行の間に読んでおく）
    const restoredDir = invocation.stage?.sessionDir;
    this.restored.push(restoredDir ? readTree(restoredDir) : undefined);
    // 質問への答えで読み取り専用でマウントされる、各実行のセッションログ（PBI-91。実行の後に消される）
    const logsMount = invocation.mounts?.find((m) => m.containerPath === "/sacty-logs");
    this.logMounts.push(
      logsMount
        ? {
            readOnly: logsMount.readOnly,
            files: readTree(logsMount.hostPath),
            dir: logsMount.hostPath,
          }
        : undefined,
    );
    const responded = this.respond?.(invocation);
    const next = responded ?? this.outcomes.shift();
    if (!next) throw new Error("no more outcomes");
    const outcome =
      next.kind === "hold"
        ? await new Promise<AgentOutcome>((resolve) => {
            this.held.set(runId, resolve);
            this.started.resolve(runId);
          })
        : next;
    // エージェントが書いた元のファイル（PBI-66）を、実行ごとの設定の場所に置いて、実行器と同じように写させる
    if (this.sessionFiles && invocation.sessionFiles && log && this.containerUnconfirmed) {
      // 実行器と同じく、コンテナの停止を確かめられなければ写さず、その理由を残す
      log.agentFilesNotArchived({
        runtime: invocation.sessionFiles,
        reason: "container_not_confirmed",
        sessionId: this.sessionIdOf?.(invocation, runId) ?? `session-${runId}`,
      });
    } else if (this.sessionFiles && invocation.sessionFiles && log) {
      const config = mkdtempSync(join(tmpdir(), "sacty-fake-config-"));
      try {
        // 実行器と同じく、保存したセッション（PBI-67）を設定の場所に戻してから、エージェントが書き足す
        if (restoredDir) cpSync(restoredDir, config, { recursive: true });
        for (const [path, content] of Object.entries(this.sessionFiles(invocation, runId))) {
          mkdirSync(dirname(join(config, path)), { recursive: true });
          writeFileSync(join(config, path), content, { flag: this.appendSessionFiles ? "a" : "w" });
        }
        await log.archiveAgentFiles({
          dir: config,
          runtime: invocation.sessionFiles,
          sessionId: this.sessionIdOf?.(invocation, runId) ?? `session-${runId}`,
        });
      } finally {
        rmSync(config, { recursive: true, force: true });
      }
    }
    return outcome;
  }
  /** 実行ごとに、エージェントが設定の場所に書く元のファイル（相対パスと中身。PBI-66）。無ければ書かない。 */
  sessionFiles?: (invocation: Invocation, runId: string) => Record<string, string>;
  /** true なら、戻したセッションのファイルに書き足す（エージェントの再開と同じ。PBI-67）。 */
  appendSessionFiles = false;
  /** 出力から読むセッションの ID（PBI-67）。無ければ session-<実行>。 */
  sessionIdOf?: (invocation: Invocation, runId: string) => string;
  /** 実行ごとに、戻すように渡された保存したセッションのファイル（PBI-67）。無ければ undefined。 */
  restored: (Record<string, string> | undefined)[] = [];
  /** true にすると、実行の後にコンテナの停止を確かめられなかった（元のファイルを写さない）ことにする。 */
  containerUnconfirmed = false;
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

/** ディレクトリの下のファイル（相対パスと中身）。 */
function readTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path);
      else files[path] = readFileSync(join(root, path), "utf8");
    }
  };
  walk("");
  return files;
}

/** 100万出力トークン = $15 になる単価なので、output で費用を作る。 */
const completed = (outputTokens: number): AgentOutcome => ({
  kind: "completed",
  output: "# 要求要件",
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: outputTokens },
});

function makeService(
  activity: SqliteActivityStore,
  outcomes: AgentOutcome[] = [],
  options: {
    config?: () => ConfigResult;
    secrets?: Record<string, string>;
    repos?: FakeRepos;
    tests?: FakeTests;
    pulls?: FakePulls;
    projects?: MemoryProjectStore;
    settings?: MemorySettingsStore;
    contexts?: ContextFetcher;
    defaultContext?: string;
    github?: FakeGitHub;
    now?: () => number;
    planner?: ServiceDeps["planner"];
    /** オーケストレーターを差し替えず、エージェントで工程を選ばせる（PBI-17 のテスト）。 */
    realPlanner?: boolean;
    gateway?: ServiceDeps["gateway"];
    /** 秘密情報の取り出し口を差し替える（1Password。PBI-34）。 */
    secretStore?: ServiceDeps["secrets"];
    platformProblems?: ServiceDeps["platformProblems"];
    hostMcpProblems?: ServiceDeps["hostMcpProblems"];
    hostMcpReady?: ServiceDeps["hostMcpReady"];
    contextMcp?: ServiceDeps["contextMcp"];
    notifier?: ServiceDeps["notifier"];
    services?: ServiceRunner;
    sharedComposes?: SharedComposeFetcher;
    tickets?: ServiceDeps["tickets"];
    /** 要求要件・設計を PR のマージで承認する（PBI-57）。既定は、画面で承認する流れを確かめるので切る。 */
    stepPullRequests?: boolean;
    /** セッションログの置き場所（PBI-62）。 */
    sessionLogs?: SessionLogStore;
    /** オーケストレーターのセッションの置き場所（PBI-67）。 */
    orchestratorSessions?: OrchestratorSessionStore;
    /** PR テンプレートを探す口（PBI-87）。 */
    templates?: ServiceDeps["templates"];
    /** マージのコミットの CI/CD の状態（PBI-89）。 */
    ci?: ServiceDeps["ci"];
  } = {},
) {
  const executor = new FakeExecutor(outcomes);
  const repos = options.repos ?? new FakeRepos();
  const tests = options.tests ?? new FakeTests();
  const pulls = options.pulls ?? new FakePulls();
  const service = new TaskService({
    activity,
    config: options.config ?? configOf(agent()),
    secrets:
      options.secretStore ??
      new MemorySecretStore(
        options.secrets ?? { "claude-oauth-token": "oauth-secret", "github-token": "ghp_secret" },
      ),
    executor,
    repos,
    tests,
    pulls,
    projects: options.projects ?? projectsWithAccount(),
    // 取り込むラベルとレビュー用のラベル（sacty の設定。PBI-26・PBI-44。sacty の PR にはレビュー用のラベルを付ける。PBI-99）
    settings:
      options.settings ??
      new MemorySettingsStore({ intakeLabel: "sacty", reviewLabel: "sacty-review" }),
    contexts: options.contexts ?? new FakeContexts(),
    defaultContext: options.defaultContext,
    github: options.github ?? new FakeGitHub(),
    ...(options.now ? { now: options.now } : {}),
    // オーケストレーターの代わりに、標準の工程を選ぶ（オーケストレーターのテストでは差し替える）
    ...(options.realPlanner
      ? {}
      : {
          planner:
            options.planner ??
            (async () => ({
              steps: [...MVP_STEPS],
              fallback: false,
              testCommand: "npm test",
              costUsd: 0,
              estimated: false,
            })),
        }),
    workspaceRoot: join(dir, "workspaces"),
    ...(options.gateway ? { gateway: options.gateway } : {}),
    ...(options.platformProblems ? { platformProblems: options.platformProblems } : {}),
    ...(options.hostMcpProblems ? { hostMcpProblems: options.hostMcpProblems } : {}),
    ...(options.hostMcpReady ? { hostMcpReady: options.hostMcpReady } : {}),
    ...(options.contextMcp ? { contextMcp: options.contextMcp } : {}),
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.services ? { services: options.services } : {}),
    ...(options.sharedComposes ? { sharedComposes: options.sharedComposes } : {}),
    ...(options.tickets ? { tickets: options.tickets } : {}),
    stepPullRequests: options.stepPullRequests ?? false,
    ...(options.sessionLogs ? { sessionLogs: options.sessionLogs } : {}),
    ...(options.orchestratorSessions ? { orchestratorSessions: options.orchestratorSessions } : {}),
    ...(options.templates ? { templates: options.templates } : {}),
    ...(options.ci ? { ci: options.ci } : {}),
  });
  return { service, executor, repos, tests, pulls };
}

/** チケットの管理のサービス（JIRA）の偽物（PBI-52）。コメントを記録する。 */
class FakeTickets implements TicketClient {
  comments: { platform: string; service: string; key: string; body: string }[] = [];
  searched: { platform: string; service: string; keys: readonly string[]; label: string }[] = [];
  commentFail?: string;
  found: FoundTicket[] = [];
  async search(input: Parameters<TicketClient["search"]>[0]) {
    this.searched.push({ ...input, platform: input.platform.name });
    return { tickets: this.found };
  }
  async comment(input: Parameters<TicketClient["comment"]>[0]) {
    if (this.commentFail)
      throw new MessageError(
        message("ticket.requestFailed", {
          platform: input.platform.name,
          status: 500,
          detail: this.commentFail,
        }),
      );
    this.comments.push({ ...input, platform: input.platform.name });
    return {
      url: `${input.platform.upstream}/browse/${input.key}?focusedCommentId=${this.comments.length}`,
    };
  }
}

/** JIRA の接続先（gateway.platforms。PBI-52）。 */
const jiraPlatform = () =>
  toPlatform(
    "jira",
    PlatformFile.parse({
      upstream: "https://jira.example.com",
      description: "JIRA",
      auth: { header: "Authorization", prefix: "Bearer ", secret: "jira-token" },
      allow: ["GET /rest/api/**", "POST /rest/api/2/issue/*/comment"],
    }),
  );

/** ゲートウェイの偽物（実行ごとのトークンを返す）。 */
const fakeGateway = (): NonNullable<ServiceDeps["gateway"]> => ({
  containerOrigin: () => "http://host.docker.internal:5001",
  platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
  register: () => ({
    token: "sacty-gw-run",
    stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
    close: () => {},
  }),
});

/** チケットの取り込みの1段目の出力（PBI-52）。 */
const triageOut = (v: Record<string, unknown>, output = 100): AgentOutcome => ({
  kind: "completed",
  output: `読みました\n\n\`\`\`json\n${JSON.stringify({ "sacty-ticket": v })}\n\`\`\``,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
});

const foundTicket = (key: string, summary = `${key} の要約`): FoundTicket => ({
  platform: "jira",
  service: "jira-server",
  key,
  summary,
  url: `https://jira.example.com/browse/${key}`,
});

/** 画面が表示している（いま承認待ちの）提出回。 */
const current = (svc: TaskService, id: string) => {
  const t = svc.get(id)?.task;
  const step = t?.gate?.step ?? t?.escalation?.step ?? "requirements";
  return t?.gate?.submission ?? t?.submissions[step] ?? 1;
};

describe("作業履歴", () => {
  it("UPDATEとDELETEを拒否する", () => {
    const activity = new SqliteActivityStore(dbPath);
    makeService(activity).service.createTask({ projectId: "default", title: "A" });
    expect(() => activity.rawExecForTest("UPDATE activity SET type = 'x'")).toThrow(/append-only/);
    expect(() => activity.rawExecForTest("DELETE FROM activity")).toThrow(/append-only/);
    // 工程は、タスクの開始時にオーケストレーターが選ぶので、作った時点では TaskCreated だけ（PBI-17）
    expect(activity.all()).toHaveLength(1);
    activity.close();
  });

  it("再起動しても同じ状態を復元する", async () => {
    const first = new SqliteActivityStore(dbPath);
    const { service } = makeService(first, [completed(20_000)]);
    const created = service.createTask({ projectId: "default", title: "A", body: "B" });
    await service.runNext(created.id);
    const before = service.get(created.id)?.task;
    first.close();

    const second = new SqliteActivityStore(dbPath);
    expect(makeService(second).service.get(created.id)?.task).toEqual(before);
    second.close();
  });

  it("「PR作成」の工程を含む古いタスクを起動の前に捨てれば、残りのタスクでデーモンが起動し、進められる（PBI-110）", async () => {
    const first = new SqliteActivityStore(dbPath);
    const kept = makeService(first).service.createTask({ projectId: "default", title: "今の形" });
    first.close();
    const db = new DatabaseSync(dbPath);
    const insert = db.prepare(
      "INSERT INTO activity (id, task_id, project_id, at, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const at = "2026-10-15T00:00:00.000Z";
    insert.run(
      "legacy-1",
      "legacy",
      "default",
      at,
      "person",
      "TaskCreated",
      '{"title":"古い","body":"","start":"sacty","budgetCapUsd":1}',
    );
    insert.run(
      "legacy-2",
      "legacy",
      "default",
      at,
      "sacty",
      "StepsChosen",
      '{"steps":["requirements","design","implement","pr"]}',
    );
    insert.run(
      "legacy-3",
      "legacy",
      "default",
      at,
      "sacty",
      "StepSubmitted",
      '{"step":"pr","submission":1}',
    );
    db.close();
    const second = new SqliteActivityStore(dbPath);
    // 捨てなければ、古い記録を読めない（起動できない）
    expect(() => makeService(second)).toThrow();
    expect(second.purgeLegacyPrStepTasks()).toEqual(["legacy"]);
    const { service } = makeService(second, [completed(100)]);
    expect(service.list().map((t) => t.id)).toEqual([kept.id]);
    expect(service.get("legacy")).toBeUndefined();
    await service.runNext(kept.id);
    expect(service.get(kept.id)?.task.steps.map((s) => s.key)).toEqual([...MVP_STEPS]);
    second.close();
  });
});

describe("工程の実行と費用", () => {
  it("工程・オーケストレーターごとに選んだエージェントで実行し、その単価で費用を記録する（PBI-40）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const cheap = agent({
      id: "luna-low",
      price_per_mtok_usd: { input: 1, cached_input: 0.1, cache_write: 0, output: 1 },
      price: { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 1 },
    });
    const strong = agent({
      id: "sol-high",
      price_per_mtok_usd: { input: 1, cached_input: 0.1, cache_write: 0, output: 10 },
      price: { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 10 },
    });
    const orchestrator = agent({
      id: "orchestrator",
      price_per_mtok_usd: { input: 0, cached_input: 0, cache_write: 0, output: 0 },
      price: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
    });
    const plan = {
      kind: "completed" as const,
      output:
        '```json\n{"sacty-steps": {"plan": "skip-design", "reason": "小さい", "testCommand": "npm test"}}\n```',
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
    };
    const { service } = makeService(activity, [plan, completed(20_000), completed(20_000)], {
      realPlanner: true,
      config: () => ({
        ok: true,
        config: {
          ...(configOf(cheap)() as { ok: true; config: SactyConfig }).config,
          stepAgents: { orchestrator, requirements: strong },
        },
      }),
    });
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    await service.runNext(task.id);
    const events = service.get(task.id)?.activity ?? [];
    const chosen = events.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.agentId).toBe("orchestrator");
    // 前段の調査は default_agent、要求要件は step_agents の sol-high
    const started = events
      .filter((e) => e.type === "AgentRunStarted")
      .map((e) => (e.type === "AgentRunStarted" ? `${e.payload.step}:${e.payload.agentId}` : ""));
    expect(started).toEqual(["investigate:luna-low", "requirements:sol-high"]);
    // 要求要件の費用は sol-high の単価（出力 20,000 × $10/100万 = $0.2）
    const done = events.find(
      (e) => e.type === "AgentRunCompleted" && e.payload.step === "requirements",
    );
    expect(done?.type === "AgentRunCompleted" && done.payload.costUsd).toBe(0.2);
    activity.close();
  });

  it("実行に使った AI の接続先・モデル・リーズニングエフォートを記録する。書いていない設定は記録しない（PBI-46）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const plain = agent({ id: "luna" });
    const strong = agent({ id: "sol-high", model: "gpt-sol", reasoning_effort: "high" });
    const orchestrator = agent({ id: "orchestrator", model: "gpt-luna", reasoning_effort: "low" });
    const plan = {
      kind: "completed" as const,
      output:
        '```json\n{"sacty-steps": {"plan": "skip-design", "reason": "小さい", "testCommand": "npm test"}}\n```',
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
    };
    const { service } = makeService(activity, [plan, completed(20_000), completed(20_000)], {
      realPlanner: true,
      config: () => ({
        ok: true,
        config: {
          ...(configOf(plain)() as { ok: true; config: SactyConfig }).config,
          stepAgents: { orchestrator, requirements: strong },
        },
      }),
    });
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    await service.runNext(task.id);
    const events = service.get(task.id)?.activity ?? [];
    const chosen = events.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
      agentId: "orchestrator",
      authMode: plain.auth.mode,
      model: "gpt-luna",
      reasoningEffort: "low",
    });
    const started = events.flatMap((e) => (e.type === "AgentRunStarted" ? [e.payload] : []));
    expect(started.map(({ runId: _, ...rest }) => rest)).toEqual([
      { step: "investigate", agentId: "luna", authMode: plain.auth.mode },
      {
        step: "requirements",
        agentId: "sol-high",
        authMode: plain.auth.mode,
        model: "gpt-sol",
        reasoningEffort: "high",
      },
    ]);
    // 秘密情報の名前（認証の設定）は記録しない
    expect(JSON.stringify(events)).not.toContain("claude-oauth-token");
    activity.close();
  });

  it("承認待ち・一時停止・完了を通知し、人間が自分で止めたときは通知しない。送れなかったら画面に出す（PBI-38）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sent: string[] = [];
    const notifier: NonNullable<ServiceDeps["notifier"]> = {
      notify: async (task, kind) => {
        sent.push(`${kind}:${task.status}:${task.gate?.step ?? task.pausedReason ?? ""}`);
      },
      test: async () => {},
      problems: () => [message("notify.failed", { detail: "x" })],
    };
    const { service } = makeService(activity, [completed(20_000), completed(20_000)], {
      notifier,
      config: configOf(agent(), 1),
    });
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    expect(sent).toEqual(["approval:awaiting_approval:requirements"]);
    // 差し戻して出し直したら、もう一度知らせる
    service.requestChanges(task.id, { step: "requirements", submission: 1, comments: ["直して"] });
    await service.runNext(task.id);
    expect(sent.at(-1)).toBe("approval:awaiting_approval:requirements");
    expect(sent).toHaveLength(2);
    service.approve(task.id, { step: "requirements", submission: 2 });
    // 人間が自分で止めたときは通知しない
    await service.pause(task.id);
    expect(service.get(task.id)?.task.pausedReason).toBe("manual");
    expect(sent).toHaveLength(2);
    expect(service.status().warnings).toEqual([expect.objectContaining({ code: "notify.failed" })]);
    activity.close();
  });

  it("ホストの MCP サーバーを、ゲートウェイの HTTP の MCP として渡し、認証のヘッダーには実行ごとのトークンだけを入れる（PBI-36）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      containerOrigin: () => "http://host.docker.internal:5001",
      platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
      register: () => ({
        token: "sacty-gw-run",
        stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
        close: () => {},
      }),
    };
    const cloud = toHostMcp("private-cloud", HostMcpFile.parse({ command: "cloud-mcp" }));
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: configOf(agent(), 1, [], [cloud]),
      gateway,
      hostMcpProblems: () => [
        message("gateway.mcpUnavailable", { name: "private-cloud", detail: "x" }),
      ],
    });
    const task = service.createTask({ projectId: "default", title: "クラウドを調べる" });
    await service.runNext(task.id);
    const call = executor.calls[0];
    expect(call?.env.SACTY_MCP_SECRET_0).toBe("Bearer sacty-gw-run");
    expect(call?.hostGateway).toBe(true);
    // Claude Code には、その MCP のツールの使用を許可する
    expect(call?.command.join(" ")).toContain("mcp__private-cloud");
    expect(JSON.parse(executor.mcpConfigs[0] ?? "{}").mcpServers["private-cloud"]).toMatchObject({
      type: "http",
      url: "http://host.docker.internal:5001/mcp/private-cloud",
    });
    expect(service.status().warnings).toEqual([
      expect.objectContaining({ code: "gateway.mcpUnavailable" }),
    ]);
    activity.close();
  });

  it("実行の前に、使うホストの MCP サーバーの準備を待ってからエージェントを動かし、準備ができないものは、どれかがわかる注意を記録する（PBI-77）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const cloud = toHostMcp("private-cloud", HostMcpFile.parse({ command: "cloud-mcp" }));
    const wiki = toHostMcp("wiki", HostMcpFile.parse({ command: "wiki-mcp" }));
    const waits: { names: readonly string[]; executed: number }[] = [];
    let executed = () => 0;
    let ready: () => void = () => {};
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: configOf(agent(), 1, [], [cloud, wiki]),
      gateway: fakeGateway(),
      hostMcpReady: async (names) => {
        waits.push({ names, executed: executed() });
        // 起動を待つ間は、エージェントを動かさない
        await new Promise<void>((resolve) => {
          ready = resolve;
        });
        return [
          message("gateway.mcpUnavailable", {
            name: "wiki",
            detail: "Okta login did not complete",
          }),
        ];
      },
    });
    executed = () => executor.calls.length;
    const task = service.createTask({ projectId: "default", title: "クラウドを調べる" });
    const running = service.runNext(task.id);
    await vi.waitFor(() => expect(waits).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 20));
    expect(executor.calls).toHaveLength(0);
    ready();
    await running;
    expect(waits).toEqual([{ names: ["private-cloud", "wiki"], executed: 0 }]);
    expect(executor.calls).toHaveLength(1);
    // 準備ができないものも渡す（起動し直して準備ができれば、実行の途中から使える）
    const servers = JSON.parse(executor.mcpConfigs[0] ?? "{}").mcpServers;
    expect(Object.keys(servers).sort()).toEqual(["private-cloud", "wiki"]);
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.warnings).toEqual([
      message("gateway.mcpUnavailable", { name: "wiki", detail: "Okta login did not complete" }),
    ]);
    expect(
      renderMessage(message("gateway.mcpUnavailable", { name: "wiki", detail: "x" }), "ja"),
    ).toContain("「wiki」");
    activity.close();
  });

  it("ホストの MCP サーバーの準備を待つ間に人間が止めたら、上限まで待たずに止め、エージェントは動かさない（PBI-77）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const cloud = toHostMcp("private-cloud", HostMcpFile.parse({ command: "cloud-mcp" }));
    let waiting = false;
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: configOf(agent(), 1, [], [cloud]),
      gateway: fakeGateway(),
      // 起動がいつまでも終わらない
      hostMcpReady: () => {
        waiting = true;
        return new Promise(() => {});
      },
    });
    const task = service.createTask({ projectId: "default", title: "クラウドを調べる" });
    const running = service.runNext(task.id);
    await vi.waitFor(() => expect(waiting).toBe(true));
    const started = Date.now();
    await service.pause(task.id);
    await running;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(task.id)?.task.pausedReason).toBe("manual");
    activity.close();
  });

  it("ホストの MCP サーバーが無い・ゲートウェイが無いときは、準備を待たない（PBI-77）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const cloud = toHostMcp("private-cloud", HostMcpFile.parse({ command: "cloud-mcp" }));
    const waits: (readonly string[])[] = [];
    const hostMcpReady: ServiceDeps["hostMcpReady"] = async (names) => {
      waits.push(names);
      return [];
    };
    const none = makeService(activity, [completed(20_000)], {
      config: configOf(agent()),
      gateway: fakeGateway(),
      hostMcpReady,
    });
    await none.service.runNext(none.service.createTask({ projectId: "default", title: "A" }).id);
    expect(none.executor.calls).toHaveLength(1);
    const noGateway = makeService(activity, [completed(20_000)], {
      config: configOf(agent(), 1, [], [cloud]),
      hostMcpReady,
    });
    await noGateway.service.runNext(
      noGateway.service.createTask({ projectId: "default", title: "B" }).id,
    );
    expect(waits).toEqual([]);
    activity.close();
  });

  it("コンテキストの HTTP の MCP サーバーは、ゲートウェイに中継先と認証を渡し、コンテナには実行ごとのトークンだけを渡す（PBI-49）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const registered: unknown[] = [];
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      containerOrigin: () => "http://host.docker.internal:5001",
      platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
      register: (_route, mcp) => {
        registered.push(mcp);
        return {
          token: "sacty-gw-run",
          stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
          close: () => {},
        };
      },
    };
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "mcp.yaml": [
          "servers:",
          "  docs:",
          "    url: https://docs.example.com/mcp",
          "    headers:",
          "      Authorization: { secret: docs-token, prefix: 'Bearer ' }",
          "      X-Team: company",
        ].join("\n"),
      },
    });
    const { service, executor } = makeService(activity, [completed(20_000)], {
      gateway,
      contexts,
      secrets: {
        "claude-oauth-token": "oauth-secret",
        "github-token": "ghp_secret",
        "docs-token": "docs-secret-value",
      },
    });
    const project = service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const task = service.createTask({ projectId: project.id, title: "ドキュメントを調べる" });
    await service.runNext(task.id);
    // ゲートウェイには、元の URL と、ホストで取り出した認証を渡す
    expect(registered).toEqual([
      {
        docs: {
          url: "https://docs.example.com/mcp",
          headers: { Authorization: "Bearer docs-secret-value", "X-Team": "company" },
        },
      },
    ]);
    // コンテナには、ゲートウェイの URL と実行ごとのトークンだけ（認証の値は渡さない）
    const call = executor.calls[0];
    expect(JSON.stringify(call?.env)).not.toContain("docs-secret-value");
    expect(Object.values(call?.env ?? {})).toContain("Bearer sacty-gw-run");
    expect(call?.hostGateway).toBe(true);
    const mcp = JSON.parse(executor.mcpConfigs[0] ?? "{}").mcpServers.docs;
    expect(mcp.url).toBe("http://host.docker.internal:5001/ctx-mcp/docs");
    expect(JSON.stringify(executor.mcpConfigs[0])).not.toContain("docs.example.com");
    activity.close();
  });

  it("コンテキストの command の MCP サーバーは、ホストで起動してゲートウェイ経由にし、プロジェクトごとに分けて使い回す（PBI-84）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const registered: Record<string, unknown>[] = [];
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      containerOrigin: () => "http://host.docker.internal:5001",
      platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
      register: (_route, mcp) => {
        registered.push(mcp ?? {});
        return {
          token: "sacty-gw-run",
          stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
          close: () => {},
        };
      },
    };
    const mcpYaml = (args: string) =>
      [
        "servers:",
        "  tool:",
        "    command: tool-mcp",
        `    args: [${args}]`,
        "    env:",
        "      TOKEN: { secret: tool-token }",
        "  boxed:",
        "    command: boxed-mcp",
        "    via_gateway: false",
      ].join("\n");
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx-a.git": { "mcp.yaml": mcpYaml("a"), "marker.txt": "A" },
      "https://github.com/acme/ctx-b.git": { "mcp.yaml": mcpYaml("b"), "marker.txt": "B" },
    });
    // 起動はホストで（偽物の起動で、渡された env と作業ディレクトリを記録する）
    const started: { name: string; env: Record<string, string>; marker: string }[] = [];
    const contextMcp = new ContextMcpServers({
      root: join(dir, "context-mcp"),
      secrets: new MemorySecretStore({ "tool-token": "tool-secret-value" }),
      connect: async (spec, env) => {
        started.push({
          name: spec.name,
          env,
          marker: readFileSync(join(spec.cwd ?? "", "marker.txt"), "utf8"),
        });
        const client = {
          getServerCapabilities: () => ({}),
        } as unknown as HostMcpConnection["client"];
        return { client, close: async () => {}, onClose: () => {} };
      },
    });
    contextMcp.start();
    const { service, executor } = makeService(
      activity,
      [completed(20_000), completed(20_000), completed(20_000)],
      {
        gateway,
        contexts,
        contextMcp,
        secrets: {
          "claude-oauth-token": "oauth-secret",
          "github-token": "ghp_secret",
          "tool-token": "tool-secret-value",
        },
      },
    );
    const save = (id: string | undefined, repo: string) =>
      service.saveProject(id, {
        name: repo,
        targets: [{ scope: "repo", target: `https://github.com/acme/app-${repo}` }],
        githubAccounts: { "github.com": "me" },
        context: { repo: `https://github.com/acme/${repo}.git` },
      });
    const a = save("default", "ctx-a");
    const b = save(undefined, "ctx-b");
    await service.runNext(service.createTask({ projectId: a.id, title: "A の1回目" }).id);
    await service.runNext(service.createTask({ projectId: a.id, title: "A の2回目" }).id);
    await service.runNext(service.createTask({ projectId: b.id, title: "B" }).id);

    // ホストで起動し、秘密情報はホストで取り出す。同じプロジェクト・同じ中身は使い回す（起動は1度）
    expect(started.map((s) => [s.marker, s.env])).toEqual([
      ["A", { TOKEN: "tool-secret-value" }],
      ["B", { TOKEN: "tool-secret-value" }],
    ]);
    // ゲートウェイには、実行ごとに、そのプロジェクトのもの（中の名前）だけを結びつける
    const hosts = registered.map((r) => (r.tool as { host: string }).host);
    expect(hosts[0]).toBe(hosts[1]);
    expect(hosts[2]).not.toBe(hosts[0]);
    expect(registered.every((r) => Object.keys(r).join() === "tool")).toBe(true);
    expect(hosts).toEqual([started[0]?.name, started[0]?.name, started[1]?.name]);
    // コンテナには、ゲートウェイの URL と実行ごとのトークンだけ（ホストで起動したものの秘密情報は渡さない）
    for (const call of executor.calls) {
      expect(JSON.stringify(call.env)).not.toContain("tool-secret-value");
      expect(call.hostGateway).toBe(true);
    }
    const servers = JSON.parse(executor.mcpConfigs[0] ?? "{}").mcpServers;
    expect(servers.tool.url).toBe("http://host.docker.internal:5001/ctx-mcp/tool");
    expect(JSON.stringify(servers.tool)).not.toContain("tool-mcp");
    // via_gateway: false は、コンテナの中で起動する
    expect(servers.boxed.command).toBe("boxed-mcp");
    // 実行が終われば、使っている実行は無くなる（止めるのは、古くなったか、しばらく使われなかったとき）
    expect(contextMcp.running().map((r) => r.leases)).toEqual([0, 0]);
    await contextMcp.stop();
    activity.close();
  });

  it.each(["lease", "ready"] as const)(
    "ホストで起動するコンテキストの MCP の確保・準備（%s）で失敗したら、用意したコンテキストと確保を残さない（PR #89 レビュー指摘）",
    async (failAt) => {
      const activity = new SqliteActivityStore(dbPath);
      const gateway: NonNullable<ServiceDeps["gateway"]> = {
        containerOrigin: () => "http://host.docker.internal:5001",
        platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
        register: () => ({
          token: "sacty-gw-run",
          stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
          close: () => {},
        }),
      };
      const contexts = new FakeContexts({
        "https://github.com/acme/ctx.git": {
          "mcp.yaml": "servers:\n  tool:\n    command: tool-mcp\n",
        },
      });
      const layerDirs: string[] = [];
      let released = 0;
      const contextMcp: NonNullable<ServiceDeps["contextMcp"]> = {
        lease: (_projectId, servers) => {
          layerDirs.push(...servers.map((s) => s.layer.dir));
          if (failAt === "lease") throw new Error("no space left on device");
          return {
            relays: servers.map((s) => ({ name: s.name, host: "ctx-x" })),
            keys: ["ctx-x"],
            release: () => {
              released += 1;
            },
          };
        },
        ready: async () => {
          throw new Error("ready failed");
        },
      };
      const { service, executor } = makeService(activity, [completed(20_000)], {
        gateway,
        contexts,
        contextMcp,
      });
      const project = service.saveProject("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
        context: { repo: "https://github.com/acme/ctx.git" },
      });
      const task = service.createTask({ projectId: project.id, title: "調べる" });
      await service.runNext(task.id);
      // 実行せず、理由を残して止める
      expect(executor.calls).toHaveLength(0);
      expect(service.get(task.id)?.task.status).toBe("paused");
      // 取得した一時のコンテキストは消し、確保したものは返す
      expect(layerDirs).toHaveLength(1);
      expect(existsSync(layerDirs[0] ?? "")).toBe(false);
      expect(released).toBe(failAt === "ready" ? 1 : 0);
      activity.close();
    },
  );

  it("ホストで起動できなかったコンテキストの MCP サーバーは、どれかを作業履歴に残して実行する（PBI-84）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      containerOrigin: () => "http://host.docker.internal:5001",
      platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
      register: () => ({
        token: "sacty-gw-run",
        stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
        close: () => {},
      }),
    };
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "mcp.yaml": "servers:\n  tool:\n    command: sacty-no-such-command-84\n",
      },
    });
    const contextMcp = new ContextMcpServers({
      root: join(dir, "context-mcp"),
      secrets: new MemorySecretStore({}),
    });
    contextMcp.start();
    const { service, executor } = makeService(activity, [completed(20_000)], {
      gateway,
      contexts,
      contextMcp,
    });
    const project = service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const task = service.createTask({ projectId: project.id, title: "調べる" });
    await service.runNext(task.id);
    expect(executor.calls).toHaveLength(1);
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    const warnings = resolved?.type === "ContextResolved" ? resolved.payload.warnings : [];
    expect(warnings.map((w) => renderMessage(w, "ja"))).toEqual([
      expect.stringContaining(
        "「sacty-no-such-command-84」が、sacty を動かすホストに見つかりません",
      ),
    ]);
    // どのプロジェクトのものか（プロジェクトの名前）も残す（PBI-92）
    expect(warnings).toEqual([
      expect.objectContaining({
        params: expect.objectContaining({ name: "tool", project: "デフォルト" }),
      }),
    ]);
    expect(renderMessage(warnings[0], "ja")).toContain("プロジェクト「デフォルト」の ");
    await contextMcp.stop();
    activity.close();
  });

  it("mcp.yaml・gateway.mcp_servers の時間切れを、エージェントに渡し、ゲートウェイの中継もそれより先に切らない（PBI-75）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const registered: unknown[] = [];
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      containerOrigin: () => "http://host.docker.internal:5001",
      platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
      register: (_route, mcp) => {
        registered.push(mcp);
        return {
          token: "sacty-gw-run",
          stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
          close: () => {},
        };
      },
    };
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "mcp.yaml": [
          "servers:",
          "  docs:",
          "    url: https://docs.example.com/mcp",
          "    startup_timeout_sec: 400",
          "    tool_timeout_sec: 1800",
          "  wiki:",
          "    url: https://wiki.example.com/mcp",
        ].join("\n"),
      },
    });
    const cloud = toHostMcp(
      "private-cloud",
      HostMcpFile.parse({ command: "cloud-mcp", startup_timeout_sec: 90, tool_timeout_sec: 7200 }),
    );
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: configOf(agent(), 1, [], [cloud]),
      gateway,
      contexts,
    });
    const project = service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const task = service.createTask({ projectId: project.id, title: "ドキュメントを調べる" });
    await service.runNext(task.id);
    // ゲートウェイの中継は、書いた値の大きい方まで待つ。書いていないサーバーは、これまでどおり
    expect(registered).toEqual([
      {
        docs: { url: "https://docs.example.com/mcp", headers: {}, timeoutMs: 1_800_000 },
        wiki: { url: "https://wiki.example.com/mcp", headers: {} },
      },
    ]);
    const servers = JSON.parse(executor.mcpConfigs[0] ?? "{}").mcpServers;
    expect(servers.docs.timeout).toBe(1_800_000);
    expect(servers.wiki).not.toHaveProperty("timeout");
    expect(servers["private-cloud"]).toMatchObject({
      url: "http://host.docker.internal:5001/mcp/private-cloud",
      timeout: 7_200_000,
    });
    // Claude Code の起動の時間切れは、全体の MCP_TIMEOUT（書いた値の最大）
    expect(executor.calls[0]?.env.MCP_TIMEOUT).toBe("400000");
    // 実行全体の上限（30分）以上の時間切れは、作業履歴に警告を残す（docs の 1800 秒・ホストの MCP の 7200 秒）
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    expect(
      resolved?.type === "ContextResolved" &&
        resolved.payload.warnings.map((w) => (typeof w === "string" ? w : w.params)),
    ).toEqual([
      { name: "docs", key: "tool_timeout_sec", seconds: 1800, minutes: 30 },
      { name: "private-cloud", key: "tool_timeout_sec", seconds: 7200, minutes: 30 },
    ]);
    activity.close();
  });

  it("組織内 PF があれば、工程エージェントに PF の URL（実行のトークンを含む）と使える API を渡し、認証情報は渡さない（PBI-35）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const ticket = toPlatform(
      "ticket",
      PlatformFile.parse({
        upstream: "https://ticket.internal.example.com",
        description: "チケット管理",
        auth: { header: "X-Internal-Token", secret: "ticket-token" },
        allow: ["GET /api/v1/tickets/**"],
      }),
    );
    const closed: string[] = [];
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      containerOrigin: () => "http://host.docker.internal:5001",
      platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
      register: (route) => {
        // AI は中継しない（このエージェントはゲートウェイ経由ではない）
        expect(route).toBeUndefined();
        return {
          token: "sacty-gw-run",
          stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
          close: () => closed.push("sacty-gw-run"),
        };
      },
    };
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: configOf(agent(), 1, [ticket]),
      secrets: { "claude-oauth-token": "oauth-secret", "ticket-token": "tkt-secret" },
      gateway,
      platformProblems: (names) =>
        names.includes("ticket")
          ? [message("gateway.platformUnavailable", { name: "ticket", detail: "x" })]
          : [],
    });
    const task = service.createTask({ projectId: "default", title: "チケットを調べる" });
    await service.runNext(task.id);
    const call = executor.calls[0];
    expect(call?.env.SACTY_PF_URL).toBe("http://host.docker.internal:5001/r/sacty-gw-run/pf");
    expect(call?.hostGateway).toBe(true);
    expect(Object.values(call?.env ?? {})).not.toContain("tkt-secret");
    const prompt = call?.command.join(" ") ?? "";
    expect(prompt).toContain("- ticket：チケット管理（$SACTY_PF_URL/ticket）");
    expect(prompt).toContain("  - GET /api/v1/tickets/**");
    expect(closed).toEqual(["sacty-gw-run"]);
    // 認証情報を用意できない PF は、画面の状態に知らせる（工程は止めない）
    expect(service.status()).toMatchObject({
      problems: [],
      warnings: [{ code: "gateway.platformUnavailable", params: { name: "ticket" } }],
    });
    activity.close();
  });

  it("1Password の参照の秘密情報を取り出して渡し、取り出せなければ理由を記録して止める（PBI-34）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    let signedIn = false;
    const secretStore = new ResolvingSecretStore(
      new MemorySecretStore({}),
      new OnePasswordSecretStore({
        run: async () =>
          signedIn
            ? { code: 0, stdout: "oauth-from-1password", stderr: "" }
            : {
                code: 1,
                stdout: "",
                stderr: "[ERROR] 2026/10/12 12:00:00 You are not currently signed in.",
              },
      }),
    );
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: configOf(agent({ auth: { mode: "subscription", secret: "op://Work/Claude/token" } })),
      secretStore,
    });
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    const paused = service.get(task.id)?.task;
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("auth");
    const failed = service.get(task.id)?.activity.find((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toMatch(
      /1Password にサインインしていないため、「op:\/\/Work\/Claude\/token」を取り出せません/,
    );
    expect(executor.calls).toHaveLength(0);
    // サインインして再開すると、取り出した値をコンテナに渡す（作業履歴には出さない）
    signedIn = true;
    service.resume(task.id, {});
    await service.runNext(task.id);
    expect(executor.calls[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-from-1password");
    expect(JSON.stringify(service.get(task.id)?.activity)).not.toContain("oauth-from-1password");
    activity.close();
  });

  it("ゲートウェイ経由のエージェントは、API キーをゲートウェイに渡し、コンテナには実行ごとのトークンだけを渡す（PBI-37）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const registered: { base: string; apiKey?: string; closed: boolean }[] = [];
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      containerOrigin: () => "http://host.docker.internal:5001",
      platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
      register: (route) => {
        const entry = { ...route, closed: false };
        registered.push(entry);
        return {
          token: "sacty-gw-run-token",
          // ゲートウェイが、この実行で 429 を2回リトライした
          stats: () => ({ retries: 2, waitedMs: 9_000, statuses: [429], gaveUp: false }),
          close: () => {
            entry.closed = true;
          },
        };
      },
    };
    const bedrock = agent({
      id: "codex-bedrock",
      runtime: "codex",
      auth: { mode: "bedrock", secret: "bedrock-api-key", region: "us-east-2", endpoint: "mantle" },
      via_gateway: true,
    });
    // Rancher Desktop など、コンテナから見たホストのアドレスを設定で変えたとき（PBI-40）
    const config = configOf(bedrock);
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: () => {
        const c = config();
        return c.ok ? { ok: true, config: { ...c.config, hostAddress: "192.168.5.2" } } : c;
      },
      secrets: { "bedrock-api-key": "ABSK-real-key" },
      gateway,
    });
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    expect(executor.calls[0]).toMatchObject({ hostGateway: true, hostAddress: "192.168.5.2" });
    expect(registered).toEqual([
      {
        base: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
        apiKey: "ABSK-real-key",
        closed: true,
      },
    ]);
    const env = executor.calls[0]?.env ?? {};
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe("sacty-gw-run-token");
    expect(Object.values(env)).not.toContain("ABSK-real-key");
    const { activity: events } = service.get(task.id) ?? {};
    const started = events?.find((e) => e.type === "AgentRunStarted");
    const retried = events?.find((e) => e.type === "AiRequestsRetried");
    // どの実行のリトライかが分かる
    expect(retried?.payload).toEqual({
      runId: started?.type === "AgentRunStarted" ? started.payload.runId : "",
      agentId: "codex-bedrock",
      retries: 2,
      waitedMs: 9_000,
      statuses: [429],
      gaveUp: false,
    });
    expect(JSON.stringify(events)).not.toContain("ABSK-real-key");
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    activity.close();
  });

  it("ゲートウェイが動いていなければ、ゲートウェイ経由のエージェントは理由を記録して止める（PBI-37）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const bedrock = agent({
      id: "codex-bedrock",
      runtime: "codex",
      auth: { mode: "bedrock", secret: "bedrock-api-key", region: "us-east-2" },
      via_gateway: true,
    });
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: configOf(bedrock),
      secrets: { "bedrock-api-key": "ABSK-real-key" },
    });
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(task.id)?.task.status).toBe("paused");
    const failed = service.get(task.id)?.activity.find((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toMatch(
      /ゲートウェイが起動していない/,
    );
    activity.close();
  });

  it("Codex × Bedrock は、config.yaml の単価で計算した実際の請求として記録する（PBI-32）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const bedrock = agent({
      id: "codex-bedrock",
      runtime: "codex",
      model: "global.openai.gpt-6-sol",
      auth: { mode: "bedrock", secret: "bedrock-api-key", region: "us-east-2" },
      // 契約の単価（一般の価格ではない）
      price_per_mtok_usd: { input: 1, cached_input: 0.1, cache_write: 0, output: 4 },
      price: { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 4 },
    });
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: configOf(bedrock),
      secrets: { "bedrock-api-key": "bedrock-secret" },
    });
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    const after = service.get(task.id)?.task;
    // completed(20_000) は出力 20,000 トークン：20,000 × $4 / 100万 = $0.08
    expect(after?.budget.usedUsd).toBe(0.08);
    expect(after?.budget.estimated).toBe(false);
    expect(executor.calls[0]?.env.AWS_BEARER_TOKEN_BEDROCK).toBe("bedrock-secret");
    // API キーの値は作業履歴に出さない
    expect(JSON.stringify(service.get(task.id)?.activity)).not.toContain("bedrock-secret");
    activity.close();
  });

  it("実行すると、費用（換算値）と出力を作業履歴に記録して待機に戻る", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [completed(20_000)]);
    const task = service.createTask({ projectId: "default", title: "決済API", body: "冪等性" });
    expect(service.queuedTaskIds()).toEqual([task.id]);

    await service.runNext(task.id);
    const { task: after, activity: events } = service.get(task.id) ?? {};
    expect(after?.status).toBe("awaiting_approval");
    expect(after?.budget.usedUsd).toBe(0.3);
    expect(after?.budget.estimated).toBe(true);
    expect(after?.outputs.requirements).toBe("# 要求要件");
    expect(events?.map((e) => e.type)).toEqual([
      "TaskCreated",
      // 対象リポジトリは、タスクの開始時（最初の実行）に用意する（PBI-15）
      "RepositoryPrepared",
      // 工程は、リポジトリを用意した後に、オーケストレーターが選ぶ（PBI-17）
      "StepsChosen",
      "AgentRunStarted",
      "AgentRunCompleted",
      "StepSubmitted",
    ]);
    // 指示にタスクの内容が入っている
    expect(executor.calls[0]?.command.join(" ")).toContain("冪等性");
    activity.close();
  });

  it("予算の80%で通知し、上限を超えたら次の実行の前に一時停止する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [completed(55_000), completed(70_000)]);
    const warned = service.createTask({ projectId: "default", title: "A" });
    const capped = service.createTask({ projectId: "default", title: "B" });

    await service.runNext(warned.id); // $0.825
    expect(service.get(warned.id)?.task.budget.warned).toBe(true);
    expect(service.get(warned.id)?.activity.at(-1)?.type).toBe("BudgetWarned");

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
    activity.close();
  });

  it("予算で止まったタスクは、使用済みより大きい上限でだけ再開できる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [completed(70_000)]);
    const task = service.createTask({ projectId: "default", title: "A" });
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
    activity.close();
  });

  it("実行前に予算を超えていれば、実行せずに止め、上限を上げると実行し直す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 70_000 }; // $1.05
    const { service, executor } = makeService(activity, [
      { kind: "failed", reason: "usage_limit", message: "429", usage },
      completed(1_000),
    ]);
    const task = service.createTask({ projectId: "default", title: "A" });

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
    activity.close();
  });

  it("利用上限で失敗したら一時停止し、再開すると実行し直す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [
      { kind: "failed", reason: "usage_limit", message: "You've hit your session limit" },
      completed(1_000),
    ]);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const paused = service.get(task.id)?.task;
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("usage_limit");

    expect(service.resume(task.id, {}).status).toBe("queued");
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    expect(executor.calls).toHaveLength(2);
    activity.close();
  });

  it("秘密情報が無ければ、認証エラーとして止める（値はどこにも出さない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], { secrets: {} });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const after = service.get(task.id);
    expect(after?.task.pausedReason).toBe("auth");
    expect(executor.calls).toHaveLength(0);
    const failed = after?.activity.find((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toContain(
      "sacty secret set claude-oauth-token",
    );
    activity.close();
  });

  it("設定が無ければ実行せず、理由を状態として返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      config: () => loadConfig(join(dir, "nope")),
    });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.status).toBe("queued");
    expect(executor.calls).toHaveLength(0);
    expect(ja(service.status().problems[0])).toMatch(/sacty config init/);
    activity.close();
  });

  it("デーモンの停止で中断された実行は、再起動時に失敗として記録して一時停止する", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity);
    const task = service.createTask({ projectId: "default", title: "A" });
    activity.append({
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
    const { service: restarted } = makeService(activity);
    restarted.recoverInterrupted();
    const after = restarted.get(task.id)?.task;
    expect(after?.status).toBe("paused");
    expect(after?.pausedReason).toBe("error");
    expect(restarted.resume(task.id, {}).status).toBe("queued");
    activity.close();
  });
});

describe("秘密情報と予算の通知（レビュー指摘）", () => {
  it("出力・エラー文・例外に含まれた秘密情報を、作業履歴に残さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const leaked: AgentOutcome = {
      kind: "completed",
      output: "トークンは oauth-secret です",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
    };
    const { service } = makeService(activity, [
      leaked,
      { kind: "failed", reason: "auth", message: "401 for oauth-secret" },
    ]);
    const a = service.createTask({ projectId: "default", title: "A" });
    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(a.id);
    await service.runNext(b.id);

    // 例外の経路
    const throwing = new TaskService({
      activity,
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
      projects: projectsWithAccount(),
      contexts: new FakeContexts(),
      settings: new MemorySettingsStore(),
      workspaceRoot: join(dir, "workspaces"),
    });
    const c = throwing.createTask({ projectId: "default", title: "C" });
    await throwing.runNext(c.id);

    const all = JSON.stringify(activity.all());
    expect(all).not.toContain("oauth-secret");
    expect(all).toContain("[REDACTED]");
    activity.close();
  });

  it("失敗した実行の費用でも、80%の通知を記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 57_000 }; // $0.855
    const { service } = makeService(activity, [
      { kind: "failed", reason: "usage_limit", message: "429", usage },
    ]);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const after = service.get(task.id);
    expect(after?.task.budget.warned).toBe(true);
    expect(after?.task.pausedReason).toBe("usage_limit");
    expect(after?.activity.map((e) => e.type).slice(-3)).toEqual([
      "AgentRunFailed",
      "TaskPaused",
      "BudgetWarned",
    ]);
    activity.close();
  });

  it("1回の実行で80%未満から上限を超えた場合も、通知を記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [completed(70_000)]); // $1.05
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    expect(
      service
        .get(task.id)
        ?.activity.map((e) => e.type)
        .slice(-3),
    ).toEqual(["AgentRunCompleted", "StepSubmitted", "BudgetWarned"]);
    activity.close();
  });

  it("空のキューを処理した後でも、作成・再開したタスクを実行する（回帰）", async () => {
    const { Worker } = await import("./worker.js");
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [
      { kind: "failed", reason: "usage_limit", message: "429" },
      completed(1_000),
    ]);
    const worker = new Worker(service, 60_000);

    await worker.tick(); // 空のキュー
    const task = service.createTask({ projectId: "default", title: "A" });
    await worker.tick();
    expect(executor.calls).toHaveLength(1);
    expect(service.get(task.id)?.task.status).toBe("paused");

    await worker.tick(); // また空のキュー
    service.resume(task.id, {});
    await worker.tick();
    expect(executor.calls).toHaveLength(2);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    activity.close();
  });

  it("停止時は、実行中の処理が作業履歴に記録されるまで待つ", async () => {
    const { Worker } = await import("./worker.js");
    const activity = new SqliteActivityStore(dbPath);
    let finish: (o: AgentOutcome) => void = () => {};
    const service = new TaskService({
      activity,
      config: configOf(agent()),
      secrets: new MemorySecretStore({ "claude-oauth-token": "oauth-secret" }),
      executor: { run: () => new Promise<AgentOutcome>((resolve) => (finish = resolve)) },
      repos: new FakeRepos(),
      tests: new FakeTests(),
      pulls: new FakePulls(),
      projects: projectsWithAccount(),
      contexts: new FakeContexts(),
      settings: new MemorySettingsStore(),
      github: new FakeGitHub(),
      planner: async () => ({
        steps: [...MVP_STEPS],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      }),
      workspaceRoot: join(dir, "workspaces"),
    });
    const task = service.createTask({ projectId: "default", title: "A" });
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
    activity.close();
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
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [draft("# 要求要件 v1")]);
    const task = service.createTask({ projectId: "default", title: "A" });
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
    activity.close();
  });

  it("差し戻すと指摘を累積し、前回の下書きと有効な指摘の全件を渡して実行し直す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [
      draft("# v1"),
      draft("# v2", [{ remarkId: "requirements-1-1", text: "受け入れ条件を追加した" }]),
      draft("# v3", [
        { remarkId: "requirements-2-1", text: "対象外を明記した" },
        { remarkId: "unknown-id", text: "無視される" },
      ]),
    ]);
    const task = service.createTask({ projectId: "default", title: "A" });
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
    activity.close();
  });

  it("表示していた提出回が最新でなければ、承認も差し戻しも拒否する（レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [draft("# v1"), draft("# v2")]);
    const task = service.createTask({ projectId: "default", title: "A" });
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
    activity.close();
  });

  it("今回の提出で回答のない指摘は、前回の対応文を残さず未回答にする（レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [
      draft("# v1"),
      draft("# v2", [{ remarkId: "requirements-1-1", text: "v2で対応しました" }]),
      draft("# v3", [{ remarkId: "requirements-2-1", text: "Bに対応" }]),
    ]);
    const task = service.createTask({ projectId: "default", title: "A" });
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
    activity.close();
  });

  it("差し戻しが上限（3回）を超えるとエスカレーションになり、続けるか承認するかを選べる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      Array.from({ length: 5 }, (_, i) => draft(`# v${i + 1}`)),
    );
    const task = service.createTask({ projectId: "default", title: "A" });
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
    const last = service.get(task.id)?.activity.at(-1);
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
    activity.close();
  });

  it("承認待ちのあいだは予算超過で止めず、次の実行の前に判定する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [completed(70_000)]); // $1.05
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const after = service.get(task.id);
    expect(after?.task.status).toBe("awaiting_approval");
    expect(after?.activity.map((e) => e.type).slice(-3)).toEqual([
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
    activity.close();
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
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(activity, [draft("# 要求要件 v1"), ...outcomes]);
    const task = made.service.createTask({
      projectId: "default",
      title: "決済API",
      body: "二重処理を防ぐ",
    });
    await made.service.runNext(task.id);
    gate(made.service, task.id, "requirements");
    await made.service.runNext(task.id);
    return { activity, ...made, id: task.id };
  }

  it("承認済みの要求要件から設計とテスト観点を作り、承認ゲートで止まる", async () => {
    const { activity, service, executor, id } = await toDesignGate([
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
    expect(approved.steps.map((s) => s.state)).toEqual(["done", "done", "active"]);
    expect(approved.approved.design).toMatchObject({
      submission: 1,
      output: "# 設計 v1",
      testViewpoints: [{ id: "TV-1" }],
    });
    expect(approved.approved.requirements?.output).toBe("# 要求要件 v1");
    activity.close();
  });

  it("設計を差し戻すと、承認済みの要求要件はそのままで設計だけをやり直す", async () => {
    const { activity, service, executor, id } = await toDesignGate([
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
    activity.close();
  });

  it("要求要件へ差し戻すと承認を取り消し、再承認するまで設計を実行しない", async () => {
    const { activity, service, executor, id } = await toDesignGate([
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
    expect(sent.steps.map((s) => s.state)).toEqual(["active", "todo", "todo"]);
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
    activity.close();
  });

  it("差し戻せるのは、承認ゲートの工程かそれより前の承認ゲートのある工程だけ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [draft("# 要求要件 v1")]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
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
    activity.close();
  });

  it("要求要件への差し戻しも上限を数え、エスカレーション後は同じ工程の書きかけの指摘を引き継ぐ", async () => {
    const outcomes: AgentOutcome[] = [draft("# 設計 v1", [viewpoints("A")])];
    for (let i = 2; i <= 4; i++) {
      outcomes.push(draft(`# 要求要件 v${i}`), draft(`# 設計 v${i}`, [viewpoints("A")]));
    }
    outcomes.push(draft("# 要求要件 v5"));
    const { activity, service, id } = await toDesignGate(outcomes);
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
    activity.close();
  });

  it("PBI-7で承認され設計のまま待機していたタスクは、起動時に設計を実行待ちにする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [
      draft("# 要求要件 v1"),
      draft("# 設計", [viewpoints("A")]),
    ]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    // PBI-7の作業履歴：設計を実行できなかったため、承認後に待機していた
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: { type: "StepApproved", payload: { step: "requirements", next: "idle" } },
        },
      ],
    });
    const { service: restarted } = makeService(activity, [draft("# 設計", [viewpoints("A")])]);
    expect(restarted.get(id)?.task.status).toBe("idle");
    restarted.queueWaitingSteps();
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    expect(restarted.get(id)?.task.gate).toEqual({ step: "design", submission: 1 });
    restarted.queueWaitingSteps(); // 承認待ちのタスクには何もしない
    expect(restarted.get(id)?.task.status).toBe("awaiting_approval");
    activity.close();
  });

  it("承認済みの工程の成果物は凍結され、作業履歴でも書き換えを受け付けない", async () => {
    const { activity, service, id } = await toDesignGate([draft("# 設計 v1", [viewpoints("A")])]);
    gate(service, id, "design");
    const task = service.get(id)?.task;
    expect(task?.outputs.requirements).toBe("# 要求要件 v1");
    expect(task?.approved.requirements?.output).toBe("# 要求要件 v1");
    // 承認済みの工程は、差し戻して承認を取り消さない限り実行対象にならない
    expect(task?.steps.find((s) => s.state === "active")?.key).toBe("implement");
    expect(() => gate(service, id, "requirements")).toThrow(/承認待ちのタスクではありません/);
    activity.close();
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
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(activity, [out("# 要求要件 v1"), ...outcomes]);
    const task = made.service.createTask({
      projectId: "default",
      title: "決済API",
      body: "タスクの本文（秘密の経緯）",
    });
    await made.service.runNext(task.id);
    made.service.approve(task.id, { step: "requirements", submission: 1 });
    await made.service.runNext(task.id);
    return { activity, ...made, id: task.id };
  }

  it("設計の工程は要求要件の変更を申し出られ、ゴールガーディアンは新しいセッションで必要な情報だけを受け取る", async () => {
    const { activity, service, executor, id } = await proposeAndJudge([
      designWithProposal(),
      verdict("rejected", "代替手段がある"),
    ]);
    expect(promptOf(executor, 1)).toContain("sacty-change-proposal");

    const guardian = promptOf(executor, 2);
    expect(guardian).toContain("--- 承認済みの要求要件 ---\n# 要求要件 v1");
    expect(guardian).toContain("理由：外部APIが冪等性キーに対応していない");
    expect(guardian).toContain("- 決済代行のAPI仕様書 v3 に Idempotency-Key が無い");
    expect(guardian).toContain("# 要求要件 v2（sacty側で重複を防ぐ）");
    // タスクの内容や工程の下書き、過去の経緯は渡さない
    expect(guardian).not.toContain("タスクの本文");
    expect(guardian).not.toContain("# 設計 v1");
    // 工程の作業領域とは別の作業領域に、起点のコミットのコードを読み取り専用で渡す（PBI-16）
    expect(executor.dirs[2]).not.toBe(executor.dirs[1]);
    expect(executor.dirs[2]).toContain("_guardian");
    expect(executor.scratch[2]).toBe(true);
    expect(executor.workspaceFiles[2]).toEqual(["README.md"]);
    expect(guardian).toContain("起点のコミット（base123）のコードがあります");
    // コンテキスト（規約・スキル）は渡さない
    expect(executor.contexts[2]).toBeUndefined();
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
    const types = service.get(id)?.activity.map((e) => e.type) ?? [];
    expect(types.slice(-4)).toEqual([
      "AgentRunCompleted",
      "ChangeProposed",
      "ChangeJudged",
      "StepSubmitted",
    ]);
    expect(service.get(id)?.activity.find((e) => e.type === "ChangeJudged")?.actor).toBe(
      "guardian",
    );
    activity.close();
  });

  it("要求要件の変更が承認されても、人間の再承認が必要になる", async () => {
    const { activity, service, executor, id } = await proposeAndJudge([
      designWithProposal(),
      verdict("approved"),
      out("# 設計 v2"),
    ]);
    const task = service.get(id)?.task;
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.gate).toEqual({ step: "requirements", submission: 2 });
    expect(task?.outputs.requirements).toBe("# 要求要件 v2（sacty側で重複を防ぐ）");
    expect(task?.approved).toEqual({});
    expect(task?.steps.map((s) => s.state)).toEqual(["active", "todo", "todo"]);
    expect(task?.proposals[0]?.applied).toBe(true);

    service.approve(id, { step: "requirements", submission: 2 });
    await service.runNext(id);
    expect(promptOf(executor, 3)).toContain(
      "--- 承認済みの要求要件 ---\n# 要求要件 v2（sacty側で重複を防ぐ）",
    );
    expect(service.get(id)?.task.gate).toEqual({ step: "design", submission: 1 });
    activity.close();
  });

  it("ゴールガーディアンの実行に失敗したら、判定の記録に実行の失敗を残す（PBI-46 レビュー指摘）", async () => {
    const { activity, service, id } = await proposeAndJudge([
      designWithProposal(),
      { kind: "failed", reason: "auth", message: "401 Unauthorized" },
    ]);
    expect(service.get(id)?.task.status).toBe("escalated");
    expect(service.get(id)?.activity.find((e) => e.type === "ChangeJudged")?.payload).toMatchObject(
      { verdict: "undecidable", runResult: "failed" },
    );
    activity.close();
  });

  it("判定できなければエスカレーションになり、人間が認めるか認めないかを決める", async () => {
    const { activity, service, id } = await proposeAndJudge([
      designWithProposal(),
      out("判定の形式が無い出力"),
    ]);
    const escalated = service.get(id)?.task;
    expect(escalated?.status).toBe("escalated");
    expect(escalated?.proposals[0]?.judgement).toMatchObject({ verdict: "undecidable" });
    // 実行はできた（判断できなかっただけ）ことを記録する（PBI-46 レビュー指摘）
    expect(service.get(id)?.activity.find((e) => e.type === "ChangeJudged")?.payload).toMatchObject(
      { runResult: "completed" },
    );
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
    activity.close();
  });

  it("人間が認めた要求要件の変更も、再承認に回す", async () => {
    const { activity, service, id } = await proposeAndJudge([
      designWithProposal(),
      verdict("undecidable", "価値判断を含む"),
    ]);
    const accepted = service.decideChange(id, "CP-1", { accept: true });
    expect(accepted.gate).toEqual({ step: "requirements", submission: 2 });
    expect(accepted.proposals[0]).toMatchObject({ decision: { accept: true }, applied: true });
    expect(accepted.approved).toEqual({}); // 承認を取り消している
    expect(accepted.steps.map((st) => st.state)).toEqual(["active", "todo", "todo"]);
    const types = service.get(id)?.activity.map((e) => e.type) ?? [];
    expect(types.slice(-4)).toEqual([
      "TaskEscalated",
      "ChangeDecided",
      "ChangeApplied",
      "StepSubmitted",
    ]);
    activity.close();
  });

  it("ゴールガーディアンの実行に失敗したら、判定できなかったものとしてエスカレーションにする", async () => {
    const { activity, service, id } = await proposeAndJudge([
      designWithProposal(),
      { kind: "failed", reason: "usage_limit", message: "You've hit your session limit" },
    ]);
    const task = service.get(id)?.task;
    expect(task?.status).toBe("escalated");
    expect(ja(task?.proposals[0]?.judgement?.reason)).toContain("session limit");
    activity.close();
  });

  it("承認されていない工程への申し出は無視し、そのまま提出する", async () => {
    const { activity, service, executor, id } = await proposeAndJudge([
      designWithProposal("design"),
    ]);
    expect(executor.calls).toHaveLength(2); // ゴールガーディアンは呼ばない
    const task = service.get(id)?.task;
    expect(task?.proposals).toEqual([]);
    expect(task?.gate).toEqual({ step: "design", submission: 1 });
    activity.close();
  });

  it("デーモンの停止で中断された判定は、再起動時にエスカレーションにする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("# 要求要件 v1")]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    // 設計の実行完了と申し出までを記録したところで、デーモンが止まった
    const runId = "run-x";
    activity.append({
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
    const { service: restarted } = makeService(activity);
    restarted.recoverInterrupted();
    const task = restarted.get(id)?.task;
    expect(task?.status).toBe("escalated");
    expect(ja(task?.proposals[0]?.judgement?.reason)).toMatch(/中断/);
    expect(
      restarted.get(id)?.activity.find((e) => e.type === "ChangeJudged")?.payload,
    ).toMatchObject({ runResult: "interrupted" });
    activity.close();
  });

  it("判定と後始末は、同じトランザクションで作業履歴に記録する（レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const appended: string[][] = [];
    const original = activity.append.bind(activity);
    activity.append = (entry) => {
      appended.push(entry.events.map((e) => e.event.type));
      return original(entry);
    };
    const { service } = makeService(activity, [
      out("# 要求要件 v1"),
      designWithProposal(),
      verdict("approved"),
    ]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    expect(appended).toContainEqual(["ChangeJudged", "ChangeApplied", "StepSubmitted"]);
    // 申し出のない実行も、完了と提出を一緒に記録する
    expect(appended).toContainEqual(["AgentRunCompleted", "StepSubmitted"]);
    activity.close();
  });

  /** 判定（と人間の判断）までが記録され、後始末が記録されていない作業履歴を作る。 */
  async function cutAfter(
    judged: "approved" | "rejected" | "undecidable",
    extra: { actor: "person" | "sacty"; event: EventInput }[] = [],
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("# 要求要件 v1")]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    const runId = "run-x";
    const append = (actor: "agent" | "guardian" | "sacty" | "person", event: EventInput) =>
      activity.append({ taskId: id, projectId: "default", events: [{ actor, event }] });
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
    const { service: restarted } = makeService(activity);
    expect(restarted.get(id)?.task.status).toBe("idle"); // どの状態にも進んでいない
    restarted.recoverInterrupted();
    return { activity, service: restarted, id };
  }

  it("判定まで記録されて止まった作業履歴も、再起動時に後始末を記録して先に進める（レビュー指摘）", async () => {
    const undecidable = await cutAfter("undecidable");
    expect(undecidable.service.get(undecidable.id)?.task.status).toBe("escalated");
    // 人間の判断も受け付ける
    expect(
      undecidable.service.decideChange(undecidable.id, "CP-1", { accept: false }).gate,
    ).toEqual({ step: "design", submission: 1 });
    undecidable.activity.close();
    rmSync(dbPath, { force: true });

    const approved = await cutAfter("approved");
    expect(approved.service.get(approved.id)?.task.gate).toEqual({
      step: "requirements",
      submission: 2,
    });
    approved.service.recoverInterrupted(); // 何度呼んでも同じ（冪等）
    expect(
      approved.service.get(approved.id)?.activity.filter((e) => e.type === "StepSubmitted"),
    ).toHaveLength(2);
    approved.activity.close();
    rmSync(dbPath, { force: true });

    const rejected = await cutAfter("rejected");
    expect(rejected.service.get(rejected.id)?.task.gate).toEqual({ step: "design", submission: 1 });
    rejected.activity.close();
  });

  it("人間の判断や反映まで記録されて止まった作業履歴も、再起動時に先に進める（レビュー指摘）", async () => {
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
    decided.activity.close();
    rmSync(dbPath, { force: true });

    const applied = await cutAfter("approved", [
      { actor: "sacty", event: { type: "ChangeApplied", payload: { proposalId: "CP-1" } } },
    ]);
    expect(applied.service.get(applied.id)?.task.gate).toEqual({
      step: "requirements",
      submission: 2,
    });
    applied.activity.close();
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
  const types = (svc: TaskService, id: string) => svc.get(id)?.activity.map((e) => e.type) ?? [];

  /** 要求要件（差し戻し1回）と設計を承認し、実装の工程が実行待ちになったところまで進める。 */
  async function toImplement(
    outcomes: AgentOutcome[],
    options: {
      tests?: FakeTests;
      repos?: FakeRepos;
      pulls?: FakePulls;
      config?: () => ConfigResult;
      now?: () => number;
      planner?: ServiceDeps["planner"];
      services?: ServiceRunner;
      sharedComposes?: SharedComposeFetcher;
      projects?: MemoryProjectStore;
    } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(
      activity,
      [out("# 要求要件 v1"), out("# 要求要件 v2"), design, ...outcomes],
      options,
    );
    const { service } = made;
    const { id } = service.createTask({
      projectId: "default",
      title: "決済API",
      body: "タスクの本文",
    });
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
    return { activity, ...made, id };
  }

  /** 実装と検証を、止まるまで進める。 */
  async function drain(service: TaskService, max = 10) {
    for (let i = 0; i < max; i++) {
      const ids = service.queuedTaskIds();
      if (ids.length === 0) return;
      for (const id of ids) await service.runNext(id);
    }
  }

  describe("実装に変更が無い（PBI-90）", () => {
    const unchanged = () => {
      const repos = new FakeRepos();
      repos.unchanged = true;
      return repos;
    };

    it("工程を進めた後に変更が要らないとわかったら、PR を作らずに実装の承認待ちで止め、承認すると変更なしで完了する", async () => {
      const repos = unchanged();
      const { activity, service, executor, pulls, id } = await toImplement(
        [implement("# 変更は要らない\n\nすでに満たしている（src/pay.ts:3）"), review()],
        { repos },
      );
      await drain(service);
      // 実装の工程には、変更が要らないときの書き方を指示する
      expect(
        executor.calls.some((c) => c.command.join(" ").includes("変更が要らない理由と根拠")),
      ).toBe(true);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("awaiting_approval");
      expect(task?.gate).toEqual({ step: "implement", submission: 1 });
      expect(task?.noChanges).toEqual({ submission: 1 });
      expect(task?.pullRequest).toBeUndefined();
      expect(task && deliveredWithoutChanges(task)).toBe(true);
      expect(types(service, id)).toContain("NoChangesFound");
      expect(types(service, id)).not.toContain("TaskPaused");
      expect(pulls.calls).toEqual([]);
      expect(repos.published).toEqual([]);
      // 人が確かめて承認すると、変更なしで完了する（実装の説明は残る）
      const done = service.approve(id, { step: "implement", submission: 1 });
      expect(isCompleted(done)).toBe(true);
      expect(deliveredWithoutChanges(done)).toBe(true);
      expect(done.outputs.implement).toContain("すでに満たしている");
      expect(service.queuedTaskIds()).toEqual([]);
      // 作業履歴から作り直しても同じ
      const { service: restarted } = makeService(activity, []);
      expect(deliveredWithoutChanges(restarted.get(id)?.task as Task)).toBe(true);
      activity.close();
    });

    it("差し戻すと実装をやり直し、変更があれば今までどおり PR を作る（変更なしの扱いは引き継がない）", async () => {
      const repos = unchanged();
      const { activity, service, pulls, id } = await toImplement(
        [
          implement("# 変更は要らない"),
          review(),
          implement("# 実装 v2"),
          review(undefined, [
            ["requirements-1-1", true],
            ["implement-1-1", true],
          ]),
        ],
        { repos },
      );
      await drain(service);
      service.requestChanges(id, {
        step: "implement",
        submission: 1,
        comments: ["キーなしのとき 400 を返していない"],
      });
      repos.unchanged = false;
      await drain(service);
      const task = service.get(id)?.task as Task;
      expect(task.gate).toEqual({ step: "implement", submission: 2 });
      expect(task.pullRequest?.number).toBe(7);
      expect(pulls.calls).toHaveLength(1);
      expect(deliveredWithoutChanges(task)).toBe(false);
      expect(() => service.approve(id, { step: "implement", submission: 2 })).toThrow(/PR/);
      activity.close();
    });

    it("作った PR の作り直しで変更が無くなったときは、今までどおり理由を残して止める", async () => {
      const { activity, service, repos, id } = await toImplement([
        implement("# 実装"),
        review(),
        implement("# 実装 v2（戻した）"),
        review(undefined, [
          ["requirements-1-1", true],
          ["implement-1-1", true],
        ]),
      ]);
      await drain(service);
      expect(service.get(id)?.task.pullRequest?.number).toBe(7);
      service.requestChanges(id, {
        step: "implement",
        submission: 1,
        comments: ["やはり要らない"],
      });
      repos.unchanged = true;
      await drain(service);
      const task = service.get(id)?.task as Task;
      expect(task.status).toBe("paused");
      expect(task.pausedReason).toBe("error");
      expect(JSON.stringify(task.pausedMessage)).toContain("git.nothingToCommit");
      expect(types(service, id)).not.toContain("NoChangesFound");
      expect(deliveredWithoutChanges(task)).toBe(false);
      activity.close();
    });
  });

  describe("言語ごとのイメージ（PBI-41）", () => {
    const java = {
      name: "java",
      image: "sacty-agent-java:test",
      description: "Java 17・Maven",
      baseImage: "registry.example.com/ci/java:17",
      env: { GOPROXY: "https://proxy.example.com", MAVEN_OPTS: "-Xmx1g" },
    };
    const withImages = (): (() => ConfigResult) => () => ({
      ok: true,
      config: {
        ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
        images: { java },
      },
    });
    const planOutput = (extra: string) => ({
      kind: "completed" as const,
      output: `\`\`\`json\n{"sacty-steps": {"plan": "standard", "reason": "r", "testCommand": "mvn test"${extra}}}\n\`\`\``,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
    });

    it("オーケストレーターに候補を見せて工程ごとに選ばせ、工程とテストをそのイメージ・環境変数で実行する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          planOutput(
            ', "images": {"investigate": "default", "design": "java", "implement": "java", "pr": "java", "bogus": "java", "reproduce": "java"}, "imageReason": "pom.xml が Java 17"',
          ),
          completed(10),
        ],
        { realPlanner: true, config: withImages() },
      );
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const prompt = executor.calls[0]?.command.join(" ") ?? "";
      expect(prompt).toContain("- java：Java 17・Maven");
      // 既定のイメージは候補に並べない（PBI-105）
      expect(prompt).not.toContain("- default：既定のイメージ");
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      // 工程の名前でないもの（bogus・無くした工程 pr）と、選んだ工程に無いもの（reproduce）は捨てる
      expect(chosen?.type === "StepsChosen" && chosen.payload.images).toEqual({
        investigate: "default",
        design: "java",
        implement: "java",
      });
      expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
        imageSource: "orchestrator",
        imageReason: "pom.xml が Java 17",
        // 調査は default と書いて理由が無い、要求要件は書かなかった（PBI-105）
        imagesUnexplained: ["investigate", "requirements"],
      });
      // オーケストレーターは既定のイメージ。調査は default を選んだので既定のイメージ（環境変数なし）
      expect(executor.images.slice(0, 2)).toEqual([
        { image: "sacty-agent:test" },
        { image: "sacty-agent:test" },
      ]);
      activity.close();
    });

    it("images の候補を見せたら、既定のイメージで動かす工程ごとに、合わない理由か、理由が無いことを記録する（PBI-105）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          planOutput(
            ', "images": {"requirements": "default", "design": "java", "implement": "java"}, "imageReason": "pom.xml", "defaultReasons": {"requirements": "文書だけで、Java のツールは要らない", "design": "java を選んだ工程の理由は捨てる", "pr": "PR 作成は対象外", "reproduce": "選んでいない工程"}',
          ),
          completed(10),
        ],
        { realPlanner: true, config: withImages() },
      );
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload.defaultImageReasons).toEqual({
        requirements: "文書だけで、Java のツールは要らない",
      });
      // 調査はイメージを書かなかった。PR 作成は対象にしない
      expect(chosen?.type === "StepsChosen" && chosen.payload.imagesUnexplained).toEqual([
        "investigate",
      ]);
      // 理由が無くても止めずに、既定のイメージで進める（作業履歴と画面に出す）
      expect(executor.images[1]).toEqual({ image: "sacty-agent:test" });
      activity.close();
    });

    it("イメージを1つも書かなかったら、PR 作成を除く工程すべてを、理由が無いまま既定のイメージで動かすと記録する（PBI-105）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [planOutput(""), completed(10)], {
        realPlanner: true,
        config: withImages(),
      });
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
        imagesUnexplained: ["investigate", "requirements", "design", "implement"],
      });
      expect(chosen?.type === "StepsChosen" && chosen.payload.images).toBeUndefined();
      activity.close();
    });

    it("images が無い・プロジェクトの対象でイメージを指定しているときは、既定のイメージの理由を求めず、記録もしない（PBI-105）", async () => {
      const output = planOutput(
        ', "images": {"implement": "default"}, "defaultReasons": {"implement": "x"}',
      );
      // images が無い
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [output, completed(10)], {
        realPlanner: true,
      });
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const prompt = executor.calls[0]?.command.join(" ") ?? "";
      expect(prompt).not.toContain("defaultReasons");
      expect(prompt).not.toContain("最後の手段");
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
        "defaultImageReasons",
      );
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
        "imagesUnexplained",
      );
      activity.close();

      // プロジェクトの対象で指定している
      const second = new SqliteActivityStore(join(dir, "second.db"));
      const projects = new MemoryProjectStore();
      projects.put("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app", image: "default" }],
        githubAccounts: { "github.com": "me" },
      });
      const made = makeService(second, [output, completed(10)], {
        realPlanner: true,
        config: withImages(),
        projects,
      });
      const pinned = made.service.createTask({
        projectId: "default",
        title: "決済API",
        repo: "https://github.com/acme/app",
      });
      await made.service.runNext(pinned.id);
      expect(made.executor.calls[0]?.command.join(" ") ?? "").not.toContain("defaultReasons");
      const picked = made.service.get(pinned.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(picked?.type === "StepsChosen" && picked.payload).toMatchObject({
        imageSource: "project",
        images: { implement: "default" },
      });
      expect(picked?.type === "StepsChosen" && picked.payload).not.toHaveProperty(
        "defaultImageReasons",
      );
      expect(picked?.type === "StepsChosen" && picked.payload).not.toHaveProperty(
        "imagesUnexplained",
      );
      second.close();
    });

    it("実装の工程とテストは、選んだイメージとその環境変数で実行する", async () => {
      const tests = new FakeTests([{ exitCode: 0, output: "ok", durationMs: 1 }]);
      const { activity, service, executor } = await toImplement([implement("# 実装"), review()], {
        tests,
        config: withImages(),
        planner: async () => ({
          steps: [...MVP_STEPS],
          fallback: false,
          testCommand: "mvn test",
          costUsd: 0,
          estimated: false,
          images: { design: "java", implement: "java" },
        }),
      });
      await drain(service);
      // 要求要件（2回）は既定、設計・実装は java、最終レビュー（ゴールガーディアン）は既定
      expect(executor.images.slice(0, 5)).toEqual([
        { image: "sacty-agent:test" },
        { image: "sacty-agent:test" },
        { image: java.image, env: java.env },
        { image: java.image, env: java.env },
        { image: "sacty-agent:test" },
      ]);
      expect(tests.calls).toEqual([
        expect.objectContaining({ image: java.image, env: java.env, command: "mvn test" }),
      ]);
      activity.close();
    });

    it("プロジェクトの対象でイメージを指定したら、オーケストレーターに選ばせず、すべての工程でそれを使う", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const projects = new MemoryProjectStore();
      projects.put("default", {
        name: "デフォルト",
        targets: [
          { scope: "org", target: "https://github.com/acme", image: "default" },
          { scope: "repo", target: "https://github.com/acme/app", image: "java" },
        ],
        githubAccounts: { "github.com": "me" },
      });
      const { service, executor } = makeService(
        activity,
        [planOutput(', "images": {"implement": "default"}'), completed(10)],
        { realPlanner: true, config: withImages(), projects },
      );
      const task = service.createTask({
        projectId: "default",
        title: "決済API",
        repo: "https://github.com/acme/app",
      });
      await service.runNext(task.id);
      // 候補を見せない（リポジトリの対象の指定が、Org の対象の指定より優先する）
      expect(executor.calls[0]?.command.join(" ") ?? "").not.toContain("- java：");
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload.images).toEqual({
        investigate: "java",
        requirements: "java",
        design: "java",
        implement: "java",
        // マージの後の監視の工程も、ほかの工程と同じく対象の指定を使う（PBI-116）
        deployment: "java",
      });
      expect(chosen?.type === "StepsChosen" && chosen.payload.imageSource).toBe("project");
      expect(executor.images[1]).toEqual({ image: java.image, env: java.env });
      activity.close();
    });

    it("images に無いイメージを選んだ・指定したら、工程を決めずに理由を示して止まる", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [planOutput(', "images": {"implement": "python"}')],
        { realPlanner: true, config: withImages() },
      );
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const latest = service.get(task.id);
      expect(latest?.task.steps).toEqual([]);
      expect(latest?.task.status).toBe("paused");
      expect(ja(latest?.task.pausedMessage)).toContain(
        "イメージ「python」は config.yaml の images にありません",
      );
      expect(latest?.activity.some((e) => e.type === "OrchestratorFailed")).toBe(true);
      activity.close();

      // プロジェクトの対象の指定も同じ
      const second = new SqliteActivityStore(join(dir, "second.db"));
      const projects = new MemoryProjectStore();
      projects.put("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app", image: "python" }],
        githubAccounts: { "github.com": "me" },
      });
      const made = makeService(second, [], { config: withImages(), projects });
      const pinned = made.service.createTask({ projectId: "default", title: "x" });
      await made.service.runNext(pinned.id);
      expect(made.service.get(pinned.id)?.task.status).toBe("paused");
      expect(ja(made.service.get(pinned.id)?.task.pausedMessage)).toContain("イメージ「python」");
      second.close();
    });

    it("工程を決めた後に images からイメージを消したら、その工程を実行せずに理由を示して止まる", async () => {
      const activity = new SqliteActivityStore(dbPath);
      let config = withImages();
      const { service, executor } = makeService(activity, [out("# 要求要件")], {
        config: () => config(),
        planner: async () => ({
          steps: [...MVP_STEPS],
          fallback: false,
          testCommand: "mvn test",
          costUsd: 0,
          estimated: false,
          images: { design: "java" },
        }),
      });
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      service.approve(task.id, { step: "requirements", submission: 1 });
      config = configOf(agent());
      await service.runNext(task.id);
      // 設計の工程はコンテナを起動しない
      expect(executor.calls).toHaveLength(1);
      expect(service.get(task.id)?.task.status).toBe("paused");
      const failed = service.get(task.id)?.activity.find((e) => e.type === "AgentRunFailed");
      expect(ja(failed?.type === "AgentRunFailed" ? failed.payload.message : undefined)).toContain(
        "イメージ「java」",
      );
      activity.close();
    });
  });

  describe("工程のイメージを人が変える（PBI-106）", () => {
    const image = (name: string, description: string) => ({
      name,
      image: `sacty-agent-${name}:test`,
      description,
      env: { IMAGE_NAME: name },
    });
    const java = image("java", "Java 17・Maven");
    const playwright = image("playwright", "Node.js・Playwright");
    const withImages = (): (() => ConfigResult) => () => ({
      ok: true,
      config: {
        ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
        images: { java, playwright },
      },
    });
    const DEFAULT = { image: "sacty-agent:test" };
    const used = (i: { image: string; env: Record<string, string> }) => ({
      image: i.image,
      env: i.env,
    });
    const plan =
      (images: Partial<Record<StepKey, string>> = { design: "java" }) =>
      async () => ({
        steps: [...MVP_STEPS],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
        images,
      });
    const changes = (service: TaskService, id: string) =>
      service
        .get(id)
        ?.activity.filter((e) => e.type === "StepImageChanged")
        .map((e) => ({ actor: e.actor, ...(e.type === "StepImageChanged" ? e.payload : {}) }));

    it("これから実行する工程・承認待ちの工程・終わった工程を変え、次の実行（手戻りを含む）から使う", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [out("# 要求要件 v1"), out("# 要求要件 v2"), design],
        { config: withImages(), planner: plan() },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      // これから実行する工程（設計）と、承認待ちの工程（要求要件）を変える
      service.changeStepImage(id, { step: "design", image: "playwright" });
      service.changeStepImage(id, { step: "requirements", image: "java" });
      // 手戻り（差し戻し）でやり直す要求要件は、変えたイメージで実行する
      service.requestChanges(id, { step: "requirements", submission: 1, comments: ["足りない"] });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 2 });
      // 終わった工程も変えられる
      service.changeStepImage(id, { step: "requirements", image: "default" });
      await service.runNext(id);
      expect(executor.images).toEqual([DEFAULT, used(java), used(playwright)]);
      // 台帳に、人が・どの工程を・何から何に変えたかを、新しいイベントで足す（工程を決めた記録は変えない）
      expect(changes(service, id)).toEqual([
        { actor: "person", step: "design", from: "java", to: "playwright" },
        { actor: "person", step: "requirements", from: "default", to: "java" },
        { actor: "person", step: "requirements", from: "java", to: "default" },
      ]);
      const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload.images).toEqual({ design: "java" });
      const task = service.get(id)?.task;
      expect(task?.images).toEqual({ design: "playwright", requirements: "default" });
      expect(task?.imageSource).toBe("orchestrator");
      expect(task?.imageChanges?.design).toMatchObject({ from: "java", to: "playwright" });
      expect(task?.imageChanges?.requirements).toMatchObject({ from: "java", to: "default" });
      activity.close();
    });

    it("実行中の工程を変えても今の実行は変えず、次の実行から使う", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const repos = new FakeRepos();
      const { service, executor } = makeService(
        activity,
        [out("# 要求要件 v1"), out("# 要求要件 v2"), out("# 要求要件 v3")],
        { config: withImages(), planner: plan(), repos },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      service.requestChanges(id, { step: "requirements", submission: 1, comments: ["足りない"] });
      // 作業領域を消して、実行を始めた後の準備（用意し直し）で待たせる
      rmSync(join(dir, "workspaces", id), { recursive: true, force: true });
      const gate = Promise.withResolvers<void>();
      repos.prepareGate = gate.promise;
      repos.prepareStarted = Promise.withResolvers<void>();
      const running = service.runNext(id);
      await repos.prepareStarted.promise;
      const during = service.get(id)?.task;
      expect(during?.status).toBe("running");
      expect(during && stepRunning(during, "requirements")).toBe(true);
      // 実行中の工程も変えられる
      service.changeStepImage(id, { step: "requirements", image: "java" });
      gate.resolve();
      await running;
      // 今の実行は、始めたときのイメージ（既定）のまま
      expect(executor.images).toEqual([DEFAULT, DEFAULT]);
      repos.prepareGate = undefined;
      service.requestChanges(id, { step: "requirements", submission: 2, comments: ["まだ"] });
      await service.runNext(id);
      expect(executor.images).toEqual([DEFAULT, DEFAULT, used(java)]);
      activity.close();
    });

    it("失敗して一時停止した工程を変えて、やり直しで変えたイメージで実行する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [{ kind: "failed", reason: "error", message: "Playwright が無い" }, out("# 要求要件")],
        { config: withImages(), planner: plan() },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("paused");
      service.changeStepImage(id, { step: "requirements", image: "playwright" });
      service.resume(id, {});
      await service.runNext(id);
      expect(executor.images).toEqual([DEFAULT, used(playwright)]);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });

    it("実装の工程を変えたら、実装とそのテストを変えたイメージで実行する", async () => {
      const tests = new FakeTests([{ exitCode: 0, output: "ok", durationMs: 1 }]);
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装"), review()],
        {
          tests,
          config: withImages(),
          planner: plan({ implement: "java" }),
        },
      );
      service.changeStepImage(id, { step: "implement", image: "playwright" });
      await drain(service);
      // 要求要件（2回）・設計は既定、実装は変えたイメージ、最終レビュー（ゴールガーディアン）は既定
      expect(executor.images.slice(0, 5)).toEqual([
        DEFAULT,
        DEFAULT,
        DEFAULT,
        used(playwright),
        DEFAULT,
      ]);
      expect(tests.calls).toEqual([
        expect.objectContaining({ image: playwright.image, env: playwright.env }),
      ]);
      activity.close();
    });

    it("実装の実行中に変えたら、今の実装は始めたときのイメージで動き、その後のテストは変えたイメージで動く（PR #116 レビュー指摘）", async () => {
      const tests = new FakeTests([{ exitCode: 0, output: "ok", durationMs: 1 }]);
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装"), review()],
        {
          tests,
          config: withImages(),
          planner: plan({ implement: "java" }),
        },
      );
      // 実装のコンテナを起動した（イメージを決めた）後、実行の最中に変える
      let during: Task | undefined;
      executor.respond = () => {
        if (executor.calls.length === 4) {
          during = service.changeStepImage(id, { step: "implement", image: "playwright" });
        }
        return undefined;
      };
      await drain(service);
      expect(during && stepRunning(during, "implement")).toBe(true);
      // 今の実装は始めたときのイメージ（java）、その後のテストは変えたイメージ（playwright）
      expect(executor.images[3]).toEqual(used(java));
      expect(tests.calls).toEqual([
        expect.objectContaining({ image: playwright.image, env: playwright.env }),
      ]);
      expect(changes(service, id)).toEqual([
        { actor: "person", step: "implement", from: "java", to: "playwright" },
      ]);
      activity.close();
    });

    it("プロジェクトの対象の指定より、人の変更を優先する（ほかの工程は指定のまま）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const projects = new MemoryProjectStore();
      projects.put("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app", image: "java" }],
        githubAccounts: { "github.com": "me" },
      });
      const { service, executor } = makeService(activity, [out("# 要求要件"), design], {
        config: withImages(),
        projects,
      });
      const { id } = service.createTask({
        projectId: "default",
        title: "決済API",
        repo: "https://github.com/acme/app",
      });
      await service.runNext(id);
      service.changeStepImage(id, { step: "design", image: "playwright" });
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      expect(executor.images).toEqual([used(java), used(playwright)]);
      const task = service.get(id)?.task;
      expect(task?.imageSource).toBe("project");
      expect(task?.images?.implement).toBe("java");
      expect(task?.images?.design).toBe("playwright");
      activity.close();
    });

    it("images に無い名前・同じ名前・工程に無い工程・中止したタスクは、理由を示して断る（日本語・英語）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      let config = withImages();
      const { service } = makeService(activity, [out("# 要求要件")], {
        config: () => config(),
        planner: plan(),
      });
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      // 工程を決める前は、工程が無い
      expect(() => service.changeStepImage(id, { step: "design", image: "java" })).toThrow(
        "その工程は、このタスクの工程にありません。",
      );
      await service.runNext(id);
      const reject = (input: unknown) => {
        try {
          service.changeStepImage(id, input);
        } catch (error) {
          if (!(error instanceof InvalidOperationError)) throw error;
          return error.messages.map((m) => [ja(m), renderMessage(m, "en")]);
        }
        throw new Error("not rejected");
      };
      expect(reject({ step: "design", image: "python" })).toEqual([
        [
          "イメージ「python」は config.yaml の images にありません。images の名前か default を選んでください。",
          'The image "python" is not in images in config.yaml. Choose a name in images, or default.',
        ],
      ]);
      expect(reject({ step: "design", image: "java" })).toEqual([
        ["工程のイメージは、すでに「java」です。", 'The step already uses the image "java".'],
      ]);
      expect(reject({ step: "reproduce", image: "java" })[0]?.[1]).toBe(
        "This task does not have that step.",
      );
      // config.yaml の images から消した名前も断る（既定のイメージには戻せる）
      config = configOf(agent());
      expect(reject({ step: "requirements", image: "java" })[0]?.[0]).toContain(
        "イメージ「java」は config.yaml の images にありません",
      );
      expect(service.changeStepImage(id, { step: "design", image: "default" }).images?.design).toBe(
        "default",
      );
      // config.yaml を読めない・解析できないときは、名前の誤りではなく、設定の問題として断る（PR #116 レビュー指摘）
      config = () => ({
        ok: false,
        problem: message("config.missing", { path: "/x/config.yaml" }),
      });
      for (const name of ["playwright", "default"]) {
        const [[jaText, enText] = []] = reject({ step: "design", image: name });
        expect(jaText).toMatch(/^config\.yaml を読めないため、工程のイメージを変えられません/);
        expect(jaText).toContain("/x/config.yaml");
        expect(jaText).not.toContain("images にありません");
        expect(enText).toMatch(
          /^The step image can't be changed because config\.yaml can't be read/,
        );
      }
      config = withImages();
      // 入力の形が違えば、入力の誤り。「PR作成」の工程（pr）は無くしたので、工程の名前として受け付けない（PBI-110）
      expect(() => service.changeStepImage(id, { step: "deploy", image: "java" })).toThrow();
      expect(() => service.changeStepImage(id, { step: "pr", image: "java" })).toThrow();
      expect(() => service.changeStepImage(id, { step: "design", image: " " })).toThrow();
      await service.cancel(id);
      expect(reject({ step: "design", image: "default" })[0]?.[0]).toBe(
        ja(message("task.cancelled")),
      );
      expect(changes(service, id)).toEqual([
        { actor: "person", step: "design", from: "java", to: "default" },
      ]);
      activity.close();
    });

    it("API で変えられ、images に無い名前は 409 で理由を返す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out("# 要求要件")], {
        config: withImages(),
        planner: plan(),
      });
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      const app = createApp(service, "tok");
      const post = (body: unknown) =>
        app.request(`/api/tasks/${id}/images`, {
          method: "POST",
          headers: { authorization: "Bearer tok", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const ok = await post({ step: "design", image: "playwright" });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { task: Task }).task.images?.design).toBe("playwright");
      const ng = await post({ step: "design", image: "python" });
      expect(ng.status).toBe(409);
      expect(await ng.json()).toEqual({
        error: "invalid_operation",
        messages: [message("image.notInImages", { name: "python" })],
      });
      expect((await post({ step: "nope", image: "java" })).status).toBe(400);
      activity.close();
    });
  });

  describe("docker compose のサービス（PBI-47）", () => {
    const servicesPlan =
      (steps: StepKey[] = ["implement"], extra: Record<string, unknown> = {}) =>
      async () => ({
        steps: [...MVP_STEPS],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
        services: { file: "compose.yaml", names: ["db"], steps },
        ...extra,
      });

    it("サービスを使う工程とそのテストの前に起動してネットワークにつなぎ、終わったら消す。ほかの工程では起動しない", async () => {
      const services = new FakeServices();
      const tests = new FakeTests([{ exitCode: 0, output: "ok", durationMs: 1 }]);
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装"), review()],
        { tests, services, planner: servicesPlan() },
      );
      // 要求要件・設計では起動しない
      expect(services.started).toHaveLength(0);
      await drain(service);
      // 実装の実行と、そのテストの実行で、それぞれ起動して消す（実行ごとに別のプロジェクト）
      expect(services.started.map((s) => s.spec)).toEqual([
        { file: "compose.yaml", names: ["db"] },
        { file: "compose.yaml", names: ["db"] },
      ]);
      const [agentRun, testRun] = services.started;
      expect(agentRun?.workspaceDir).toBe(join(dir, "workspaces", id, "repo"));
      expect(services.stopped).toEqual([agentRun?.runId, testRun?.runId]);
      // 実装のエージェントとテストのコンテナを、サービスのネットワークにつなぐ
      expect(executor.networks[3]).toBe(`sacty-svc-${agentRun?.runId}_sacty`);
      expect(executor.networks.filter(Boolean)).toHaveLength(1);
      expect(tests.calls[0]?.network).toBe(`sacty-svc-${testRun?.runId}_sacty`);
      // 接続先をエージェントに伝える
      expect(promptOf(executor, 3)).toContain("--- 起動しているサービス（docker compose） ---");
      expect(promptOf(executor, 3)).toContain("- db：db:5432");
      expect(promptOf(executor, 2)).not.toContain("起動しているサービス");
      // 起動したことを作業履歴に残す
      const started = service.get(id)?.activity.filter((e) => e.type === "ServicesStarted") ?? [];
      expect(started.map((e) => e.type === "ServicesStarted" && e.payload.forTests)).toEqual([
        undefined,
        true,
      ]);
      // サービスのポートを localhost に転送する（PBI-60）。サービスを使わない工程では渡さない
      expect(executor.forwards[3]).toEqual([{ port: 5432, host: "db" }]);
      expect(executor.forwards.filter(Boolean)).toHaveLength(1);
      expect(tests.calls[0]?.forwards).toEqual([{ port: 5432, host: "db" }]);
      expect(started.every((e) => e.type === "ServicesStarted" && !e.payload.sharedPorts)).toBe(
        true,
      );
      activity.close();
    });

    it("複数のサービスが使うポートは localhost に転送せず、作業履歴と指示に残す。ポートが無ければ転送を渡さない（PBI-60）", async () => {
      const services = new FakeServices(undefined, [
        { name: "api", ports: [8080, 9000] },
        { name: "mock", ports: [8080] },
        { name: "worker", ports: [] },
      ]);
      const tests = new FakeTests([{ exitCode: 0, output: "ok", durationMs: 1 }]);
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装"), review()],
        { tests, services, planner: servicesPlan() },
      );
      await drain(service);
      expect(executor.forwards[3]).toEqual([{ port: 9000, host: "api" }]);
      expect(tests.calls[0]?.forwards).toEqual([{ port: 9000, host: "api" }]);
      const started = service.get(id)?.activity.filter((e) => e.type === "ServicesStarted") ?? [];
      expect(started.map((e) => e.type === "ServicesStarted" && e.payload.sharedPorts)).toEqual([
        [8080],
        [8080],
      ]);
      expect(promptOf(executor, 3)).toContain(
        "- mock：mock:8080（localhost:8080 は、複数のサービスが使う番号のため、転送していません）",
      );
      activity.close();

      // 転送するポートが無ければ、転送を渡さない（コマンドはこれまでどおり）
      const portless = new FakeServices(undefined, [{ name: "worker", ports: [] }]);
      const tests2 = new FakeTests([{ exitCode: 0, output: "ok", durationMs: 1 }]);
      const second = await toImplement([implement("# 実装"), review()], {
        tests: tests2,
        services: portless,
        planner: servicesPlan(),
      });
      await drain(second.service);
      expect(second.executor.networks[3]).toBeDefined();
      expect(second.executor.forwards.filter(Boolean)).toHaveLength(0);
      expect(tests2.calls[0]).not.toHaveProperty("forwards");
      second.activity.close();
    });

    it("サービスを起動できなければ、工程を実行せずに理由を示して止まる", async () => {
      const services = new FakeServices(
        message("services.unsafe", { file: "compose.yaml", detail: "db：privileged は使えません" }),
      );
      const { activity, service, executor, id } = await toImplement([], {
        services,
        planner: servicesPlan(),
      });
      const before = executor.calls.length;
      await drain(service);
      expect(executor.calls).toHaveLength(before);
      expect(service.get(id)?.task.status).toBe("paused");
      const failed = service.get(id)?.activity.find((e) => e.type === "AgentRunFailed");
      expect(ja(failed?.type === "AgentRunFailed" ? failed.payload.message : undefined)).toContain(
        "db：privileged は使えません",
      );
      activity.close();
    });

    it("テストの前にサービスを起動できなければ、テストを実行せずに止まる", async () => {
      const failing = new FakeServices();
      const tests = new FakeTests();
      const { activity, service, id } = await toImplement([implement("# 実装")], {
        tests,
        services: failing,
        planner: servicesPlan(),
      });
      await service.runNext(id); // 実装（起動できる）
      (failing as unknown as { fail: DaemonText }).fail = message("services.failed", {
        file: "compose.yaml",
        detail: "pull access denied",
      });
      await drain(service);
      expect(tests.calls).toHaveLength(0);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(ja(service.get(id)?.task.pausedMessage)).toContain("pull access denied");
      activity.close();
    });

    it("内容の調査では、指定があっても起動しない。不具合の調査では起動する", async () => {
      for (const [investigation, expected] of [
        ["content", 0],
        ["bug", 1],
      ] as const) {
        const activity = new SqliteActivityStore(join(dir, `${investigation}.db`));
        const services = new FakeServices();
        const { service } = makeService(activity, [out("# 調査")], {
          services,
          planner: async () => ({
            steps: [...STEP_PLANS.investigate],
            plan: "investigate" as const,
            reason: "調査",
            fallback: false,
            costUsd: 0,
            estimated: false,
            investigation,
            services: { file: "compose.yaml", names: [], steps: ["investigate"] as StepKey[] },
          }),
        });
        const task = service.createTask({ projectId: "default", title: "調べて" });
        await service.runNext(task.id);
        expect(services.started).toHaveLength(expected);
        expect(services.stopped).toHaveLength(expected);
        activity.close();
      }
    });
  });

  describe("共用の docker compose（PBI-70）", () => {
    /** 共用の compose を2つ持つプロジェクト（infra は github.com の HTTPS、kafka はローカルのパス）。 */
    const projectsWithShared = () => {
      const projects = projectsWithAccount();
      const project = projects.get("default");
      if (!project) throw new Error("no project");
      projects.put("default", {
        name: project.name,
        targets: project.targets,
        ...(project.githubAccounts ? { githubAccounts: project.githubAccounts } : {}),
        sharedComposes: [
          {
            name: "infra",
            repo: "https://github.com/acme/test-infra",
            ref: "main",
            file: "compose/redis.yml",
            description: "Redis。結合テストに要る",
          },
          { name: "kafka", repo: "/srv/kafka-compose", file: "compose.yaml" },
        ],
      });
      return projects;
    };
    const plan =
      (extra: Record<string, unknown> = {}) =>
      async () => ({
        steps: [...MVP_STEPS],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
        ...extra,
      });

    it("設定しただけでは取得も起動もしない。使わないと判断した理由と、選ばせた共用の compose を残す", async () => {
      const services = new FakeServices();
      const shared = new FakeSharedComposes();
      const tests = new FakeTests([{ exitCode: 0, output: "ok", durationMs: 1 }]);
      const { activity, service, id } = await toImplement([implement("# 実装"), review()], {
        tests,
        services,
        sharedComposes: shared,
        projects: projectsWithShared(),
        planner: plan({ servicesReason: "単体テストだけで、外部のサービスを使わない" }),
      });
      await drain(service);
      expect(shared.calls).toHaveLength(0);
      expect(services.started).toHaveLength(0);
      expect(services.stopped).toHaveLength(0);
      expect(tests.calls).toHaveLength(1);
      const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload.sharedComposes).toEqual([
        "infra",
        "kafka",
      ]);
      expect(chosen?.type === "StepsChosen" && chosen.payload.services).toBeUndefined();
      expect(service.get(id)?.task.servicesReason).toBe(
        "単体テストだけで、外部のサービスを使わない",
      );
      activity.close();
    });

    it("共用の compose を選ぶと、工程・テストの実行ごとに、実行専用のディレクトリに取得して起動し、終わったら消す", async () => {
      const services = new FakeServices(undefined, [{ name: "redis", ports: [6379] }]);
      const shared = new FakeSharedComposes();
      const tests = new FakeTests([{ exitCode: 0, output: "ok", durationMs: 1 }]);
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装"), review()],
        {
          tests,
          services,
          sharedComposes: shared,
          projects: projectsWithShared(),
          planner: plan({
            services: { compose: "infra", names: ["redis"], steps: ["implement"] },
            servicesReason: "結合テストが Redis を使う（README）",
          }),
        },
      );
      // 要求要件・設計では取得しない
      expect(shared.calls).toHaveLength(0);
      const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      // どの共用の compose を使うかを、作業履歴に残す
      expect(chosen?.type === "StepsChosen" && chosen.payload.services).toEqual({
        file: "compose/redis.yml",
        names: ["redis"],
        steps: ["implement"],
        compose: { name: "infra", repo: "https://github.com/acme/test-infra", ref: "main" },
      });
      expect(chosen?.type === "StepsChosen" && chosen.payload.servicesReason).toBe(
        "結合テストが Redis を使う（README）",
      );
      await drain(service);
      // 実装の実行と、そのテストの実行で、それぞれ取得する（実行ごとに別のディレクトリ）
      expect(shared.calls).toHaveLength(2);
      const [agentRun, testRun] = services.started;
      expect(agentRun?.runId).not.toBe(testRun?.runId);
      expect(shared.calls.map((c) => c.dest)).toEqual([
        join(dir, "workspaces", "_shared-compose", agentRun?.runId ?? ""),
        join(dir, "workspaces", "_shared-compose", testRun?.runId ?? ""),
      ]);
      expect(shared.calls[0]?.repo).toBe("https://github.com/acme/test-infra");
      expect(shared.calls[0]?.ref).toBe("main");
      // HTTPS の GitHub は、プロジェクトの gh のアカウントで取得する（環境変数でだけ渡す）
      expect(shared.calls[0]?.authEnv?.GIT_CONFIG_KEY_0).toBe(
        "http.https://github.com/.extraheader",
      );
      // 取得したディレクトリを作業領域として起動する。失敗の理由から取り除く値も渡す
      expect(services.started.map((s) => s.spec)).toEqual([
        { file: "compose/redis.yml", names: ["redis"], shared: "infra" },
        { file: "compose/redis.yml", names: ["redis"], shared: "infra" },
      ]);
      expect(agentRun?.workspaceDir).toBe(shared.calls[0]?.dest);
      expect(agentRun?.secrets).toContain("ghp_secret");
      expect(services.stopped).toEqual([agentRun?.runId, testRun?.runId]);
      // 終わったら、取得したディレクトリも消す
      for (const call of shared.calls) expect(existsSync(call.dest)).toBe(false);
      // サービス名でも localhost でも接続できる（PBI-60 と同じ）
      expect(executor.forwards[3]).toEqual([{ port: 6379, host: "redis" }]);
      expect(tests.calls[0]?.forwards).toEqual([{ port: 6379, host: "redis" }]);
      expect(promptOf(executor, 3)).toContain("- redis：redis:6379 または localhost:6379");
      const started = service.get(id)?.activity.filter((e) => e.type === "ServicesStarted") ?? [];
      expect(started.map((e) => e.type === "ServicesStarted" && e.payload.compose)).toEqual([
        { name: "infra", commit: "abc1234def5678" },
        { name: "infra", commit: "abc1234def5678" },
      ]);
      // 認証の値は、作業履歴に残さない
      expect(JSON.stringify(service.get(id)?.activity)).not.toContain("ghp_secret");
      activity.close();
    });

    it("ローカルのパスの共用の compose は、ホストの認証で取得する（トークンを取り出さない）", async () => {
      const services = new FakeServices();
      const shared = new FakeSharedComposes();
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out("# 調査")], {
        services,
        sharedComposes: shared,
        projects: projectsWithShared(),
        planner: async () => ({
          steps: [...STEP_PLANS.investigate],
          plan: "investigate" as const,
          reason: "調査",
          fallback: false,
          costUsd: 0,
          estimated: false,
          investigation: "bug" as const,
          services: { compose: "kafka", names: [], steps: ["investigate"] as StepKey[] },
        }),
      });
      const task = service.createTask({ projectId: "default", title: "落ちるテストを調べて" });
      await service.runNext(task.id);
      expect(shared.calls).toHaveLength(1);
      expect(shared.calls[0]?.repo).toBe("/srv/kafka-compose");
      expect(shared.calls[0]).not.toHaveProperty("ref");
      expect(shared.calls[0]).not.toHaveProperty("authEnv");
      expect(services.started[0]?.spec).toEqual({
        file: "compose.yaml",
        names: [],
        shared: "kafka",
      });
      expect(services.started[0]).not.toHaveProperty("secrets");
      activity.close();
    });

    it("取得に失敗したら、起動せずに、どの共用の compose の何が原因かを示して止まる。認証の値は伏せてから切り詰める", async () => {
      const services = new FakeServices();
      // git のエラーに認証の値が混ざっても、伏せてから切り詰める（切り詰めの境界をまたぐ位置）
      const shared = new FakeSharedComposes(
        new Error(`ghp_secret ${"x".repeat(1954)}ghp_secret fatal: repository not found`),
      );
      const { activity, service, executor, id } = await toImplement([], {
        services,
        sharedComposes: shared,
        projects: projectsWithShared(),
        planner: plan({ services: { compose: "infra", names: [], steps: ["implement"] } }),
      });
      const before = executor.calls.length;
      await drain(service);
      expect(executor.calls).toHaveLength(before);
      expect(services.started).toHaveLength(0);
      expect(service.get(id)?.task.status).toBe("paused");
      const failed = service.get(id)?.activity.find((e) => e.type === "AgentRunFailed");
      const raw = failed?.type === "AgentRunFailed" ? failed.payload.message : "";
      const text = ja(raw);
      expect(text).toContain(
        "共用の compose「infra」のリポジトリ（https://github.com/acme/test-infra）を取得できませんでした",
      );
      expect(text).toContain("repository not found");
      expect(text).toContain("[REDACTED]");
      // 伏せる前に切り詰めると、先頭の値の一部（"secret" など）が残る
      expect(JSON.stringify(service.get(id)?.activity)).not.toMatch(/ghp_|_secret|secret /);
      expect(renderMessage(raw, "en")).toContain('of the shared compose "infra"');
      // 取得に失敗したディレクトリも残さない
      expect(existsSync(shared.calls[0]?.dest ?? "")).toBe(false);
      activity.close();
    });

    for (const mode of ["pause", "cancel"] as const) {
      const label = mode === "pause" ? "一時停止" : "中止";
      it(`取得の待ちの間に${label}されたら、取得したものを片付けて起動しない（レビュー指摘）`, async () => {
        const services = new FakeServices();
        const shared = new FakeSharedComposes();
        const gate = Promise.withResolvers<void>();
        shared.gate = gate.promise;
        const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
          services,
          sharedComposes: shared,
          projects: projectsWithShared(),
          planner: plan({ services: { compose: "infra", names: [], steps: ["implement"] } }),
        });
        const before = executor.calls.length;
        const running = service.runNext(id);
        await shared.entered.promise;
        const stopping = mode === "pause" ? service.pause(id) : service.cancel(id);
        gate.resolve();
        await stopping;
        await running;
        expect(services.started).toHaveLength(0);
        expect(executor.calls).toHaveLength(before);
        expect(existsSync(shared.calls[0]?.dest ?? "")).toBe(false);
        expect(service.get(id)?.task.status).toBe(mode === "pause" ? "paused" : "cancelled");
        expect(service.get(id)?.activity.some((e) => e.type === "ServicesStarted")).toBe(false);
        activity.close();
      });

      it(`起動の待ち（up --wait）の間に${label}されたら、起動を打ち切って止めて消す（レビュー指摘）`, async () => {
        const services = new FakeServices();
        services.hold = true;
        const shared = new FakeSharedComposes();
        const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
          services,
          sharedComposes: shared,
          projects: projectsWithShared(),
          planner: plan({ services: { compose: "infra", names: [], steps: ["implement"] } }),
        });
        const before = executor.calls.length;
        const running = service.runNext(id);
        await services.entered.promise;
        await (mode === "pause" ? service.pause(id) : service.cancel(id));
        await running;
        const runId = services.started[0]?.runId;
        expect(services.aborted).toEqual([runId]);
        expect(services.stopped).toContain(runId);
        expect(executor.calls).toHaveLength(before);
        expect(existsSync(shared.calls[0]?.dest ?? "")).toBe(false);
        expect(service.get(id)?.task.status).toBe(mode === "pause" ? "paused" : "cancelled");
        expect(service.get(id)?.activity.some((e) => e.type === "ServicesStarted")).toBe(false);
        activity.close();
      });
    }

    it("テストの前のサービスの起動の待ちの間に一時停止されたら、テストを実行せず、失敗として記録しない（レビュー指摘）", async () => {
      const services = new FakeServices();
      const tests = new FakeTests();
      const { activity, service, id } = await toImplement([implement("# 実装")], {
        tests,
        services,
        planner: plan({ services: { file: "compose.yaml", names: ["db"], steps: ["implement"] } }),
      });
      await service.runNext(id); // 実装（起動できる）
      services.hold = true;
      const running = service.runNext(id); // テスト
      await services.entered.promise;
      await service.pause(id);
      await running;
      expect(tests.calls).toHaveLength(0);
      expect(services.aborted).toHaveLength(1);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.pausedReason).toBe("manual");
      activity.close();
    });

    it("設定に無い名前を選んだら、理由を示して止まる（取得しない）", async () => {
      const services = new FakeServices();
      const shared = new FakeSharedComposes();
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [], {
        services,
        sharedComposes: shared,
        projects: projectsWithShared(),
        planner: plan({ services: { compose: "cassandra", names: [], steps: ["implement"] } }),
      });
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const failed = service.get(task.id)?.activity.find((e) => e.type === "OrchestratorFailed");
      expect(ja(failed?.type === "OrchestratorFailed" ? failed.payload.message : "")).toContain(
        "共用の compose「cassandra」は、プロジェクトの設定にありません",
      );
      expect(service.get(task.id)?.task.status).toBe("paused");
      expect(shared.calls).toHaveLength(0);
      activity.close();
    });

    it("共用の compose を設定していないプロジェクトでは、選ばせず、これまでどおり動く", async () => {
      const services = new FakeServices();
      const shared = new FakeSharedComposes();
      const tests = new FakeTests([{ exitCode: 0, output: "ok", durationMs: 1 }]);
      const { activity, service, id } = await toImplement([implement("# 実装"), review()], {
        tests,
        services,
        sharedComposes: shared,
        planner: plan({ services: { file: "compose.yaml", names: ["db"], steps: ["implement"] } }),
      });
      await drain(service);
      expect(shared.calls).toHaveLength(0);
      expect(services.started.map((s) => s.spec)).toEqual([
        { file: "compose.yaml", names: ["db"] },
        { file: "compose.yaml", names: ["db"] },
      ]);
      expect(services.started[0]?.workspaceDir).toBe(join(dir, "workspaces", id, "repo"));
      expect(services.started[0]).not.toHaveProperty("secrets");
      const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty("sharedComposes");
      activity.close();
    });

    it("オーケストレーターに、共用の compose を名前・ファイル・説明で選ばせる（設定が無ければ出さない）", async () => {
      for (const [projects, expected] of [
        [projectsWithShared(), true],
        [projectsWithAccount(), false],
      ] as const) {
        const activity = new SqliteActivityStore(join(dir, `orch-${expected}.db`));
        const { service, executor } = makeService(
          activity,
          [
            out(
              '```json\n{"sacty-steps": {"plan": "standard", "reason": "変更", "testCommand": "npm test", "servicesReason": "Redis は使わない"}}\n```',
            ),
          ],
          { projects, realPlanner: true },
        );
        const task = service.createTask({ projectId: "default", title: "決済API" });
        await service.runNext(task.id);
        const prompt = promptOf(executor, 0);
        expect(
          prompt.includes("- infra：compose ファイル compose/redis.yml。Redis。結合テストに要る"),
        ).toBe(expected);
        expect(prompt.includes("- kafka：compose ファイル compose.yaml")).toBe(expected);
        expect(prompt.includes("servicesReason")).toBe(expected);
        expect(service.get(task.id)?.task.servicesReason).toBe("Redis は使わない");
        activity.close();
      }
    });
  });

  describe("調査の工程（PBI-18）", () => {
    const investigatePlanner = async () => ({
      steps: ["investigate" as const],
      plan: "investigate" as const,
      reason: "質問なので調査だけ",
      fallback: false,
      costUsd: 0,
      estimated: false,
    });

    it("起点のコードを読み取り専用で読んで調査の結果を書き、人間が承認すると完了する（差し戻しで調べ直す）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor, repos } = makeService(
        activity,
        [out("# 調査の結果 v1"), out("# 調査の結果 v2")],
        { planner: investigatePlanner },
      );
      const { id } = service.createTask({
        projectId: "default",
        title: "決済の再試行はどこで行っている？",
      });
      await service.runNext(id);
      expect(promptOf(executor, 0)).toContain("あなたはソフトウェア開発の調査エージェントです");
      expect(promptOf(executor, 0)).toContain("決済の再試行はどこで行っている？");
      expect(executor.scratch[0]).toBe(true);
      expect(executor.workspaceFiles[0]).toEqual(["README.md"]);
      expect(repos.snapshots).toHaveLength(1);
      expect(service.get(id)?.task.gate).toEqual({ step: "investigate", submission: 1 });

      service.requestChanges(id, {
        step: "investigate",
        submission: 1,
        comments: ["根拠の行が無い"],
      });
      await service.runNext(id);
      expect(promptOf(executor, 1)).toContain("[investigate-1-1] 根拠の行が無い");
      expect(promptOf(executor, 1)).toContain("# 調査の結果 v1");
      const done = service.approve(id, { step: "investigate", submission: 2 });
      expect(isCompleted(done)).toBe(true);
      expect(done.approved.investigate?.output).toBe("# 調査の結果 v2");
      // 画面で作ったタスクは、Issue には返さない
      expect(service.queuedTaskIds()).toEqual([]);
      activity.close();
    });

    it("Issue から取り込んだタスクは、完了したら結果をプロジェクトのアカウントで Issue にコメントし、二度は返さない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service } = makeService(activity, [out("# 調査の結果\n\n- src/pay.ts:12 で再試行")], {
        pulls,
        planner: investigatePlanner,
      });
      service.saveProject("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
      });
      const [task] = service.importIssues([
        {
          repo: "https://github.com/acme/app",
          number: 5,
          title: "再試行はどこ？",
          body: "",
          url: "https://github.com/acme/app/issues/5",
          labels: ["sacty"],
        },
      ]);
      const id = task?.id ?? "";
      await service.runNext(id);
      service.approve(id, { step: "investigate", submission: 1 });
      expect(service.queuedTaskIds()).toEqual([id]);
      await service.runNext(id);
      await service.runNext(id); // 二度は返さない
      expect(pulls.issueComments).toHaveLength(1);
      expect(pulls.issueComments[0]).toMatchObject({
        repo: "https://github.com/acme/app",
        number: 5,
        token: "ghp_secret",
      });
      expect(pulls.issueComments[0]?.body).toContain("src/pay.ts:12 で再試行");
      expect(service.get(id)?.task.issueComment).toEqual({
        url: "https://github.com/acme/app/issues/5#issuecomment-1",
      });
      expect(service.queuedTaskIds()).toEqual([]);
      activity.close();
    });

    it("投稿の後、記録の前に止まっても、次の実行で既存のコメントを使い、同じ結果を二度コメントしない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service } = makeService(activity, [out("# 調査の結果")], {
        pulls,
        planner: investigatePlanner,
      });
      service.saveProject("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
      });
      // ほかのタスクの調査の結果は、このタスクのものとして使わない
      pulls.issueComments.push({
        repo: "https://github.com/acme/app",
        token: "ghp_secret",
        number: 8,
        body: "<!-- sacty-investigation:other-task -->\n## sacty の調査の結果",
      });
      const [task] = service.importIssues([
        {
          repo: "https://github.com/acme/app",
          number: 8,
          title: "調べて",
          body: "",
          url: "https://github.com/acme/app/issues/8",
          labels: ["sacty"],
        },
      ]);
      const id = task?.id ?? "";
      await service.runNext(id);
      service.approve(id, { step: "investigate", submission: 1 });
      // IssueCommented の記録だけを一度失敗させる
      const append = activity.append.bind(activity);
      let failOnce = true;
      activity.append = (entry) => {
        if (failOnce && entry.events.some((e) => e.event.type === "IssueCommented")) {
          failOnce = false;
          throw new Error("disk full");
        }
        return append(entry);
      };
      await expect(service.runNext(id)).rejects.toThrow("disk full");
      expect(pulls.issueComments).toHaveLength(2);
      await service.runNext(id);
      expect(pulls.issueComments).toHaveLength(2);
      expect(service.get(id)?.task.issueComment).toEqual({
        url: "https://github.com/acme/app/issues/8#issuecomment-2",
      });
      expect(service.queuedTaskIds()).toEqual([]);
      activity.close();
    });

    it("Issue に返せなければ、理由を記録して、何度も返そうとしない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      pulls.commentFail = "403 Resource not accessible ghp_secret";
      const { service } = makeService(activity, [out("# 調査の結果")], {
        pulls,
        planner: investigatePlanner,
      });
      service.saveProject("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
      });
      const [task] = service.importIssues([
        {
          repo: "https://github.com/acme/app",
          number: 6,
          title: "調べて",
          body: "",
          url: "https://github.com/acme/app/issues/6",
          labels: ["sacty"],
        },
      ]);
      const id = task?.id ?? "";
      await service.runNext(id);
      service.approve(id, { step: "investigate", submission: 1 });
      await service.runNext(id);
      const comment = service.get(id)?.task.issueComment;
      expect(comment && "failed" in comment && ja(comment.failed)).toContain("403");
      expect(JSON.stringify(comment)).not.toContain("ghp_secret");
      expect(service.queuedTaskIds()).toEqual([]);
      activity.close();
    });
  });

  describe("レビューの工程（PBI-19）", () => {
    const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
    const reviewPlanner = async () => ({
      steps: ["review" as const],
      plan: "review" as const,
      reason: "PR のレビューの依頼",
      fallback: false,
      costUsd: 0,
      estimated: false,
    });
    /** PR の URL を本文に書いた Issue から取り込んだタスク。 */
    const importReviewIssue = (service: TaskService, body: string) => {
      service.saveProject("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
      });
      const [task] = service.importIssues([
        {
          repo: "https://github.com/acme/app",
          number: 30,
          title: "この PR をレビューして",
          body,
          url: "https://github.com/acme/app/issues/30",
          labels: ["sacty"],
        },
      ]);
      return task?.id ?? "";
    };

    it("タスクにある PR の先頭のコードと差分を読んでレビューを書き、人間の承認を待たずに PR に投稿して完了する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service, executor, repos } = makeService(
        activity,
        [out("# 評価\n\n- src/retry.ts:1 上限が無い")],
        { pulls, planner: reviewPlanner },
      );
      const id = importReviewIssue(
        service,
        "見てほしい：https://github.com/acme/app/pull/12 （ほかのリポジトリ https://github.com/other/app/pull/99 は対象外）",
      );
      await service.runNext(id);
      // 対象の PR を、プロジェクトのアカウントで確かめて記録する
      expect(pulls.prInfoRequests).toEqual([
        { repo: "https://github.com/acme/app", number: 12, token: "ghp_secret" },
      ]);
      const task = service.get(id)?.task;
      expect(task?.reviewTarget).toMatchObject({
        repo: "https://github.com/acme/app",
        number: 12,
        headCommit: "h".repeat(40),
        baseCommit: "b".repeat(40),
      });
      // PR のコミットを取得し、先頭のコードを読み取り専用で、差分と PR の説明をプロンプトで渡す
      expect(repos.fetchedCommits[0]?.commits).toEqual(["h".repeat(40), "b".repeat(40)]);
      expect(repos.fetchedCommits[0]?.authEnv).toBeDefined();
      expect(repos.diffedCommits).toEqual([
        { baseCommit: "b".repeat(40), headCommit: "h".repeat(40) },
      ]);
      expect(repos.snapshots.at(-1)?.baseCommit).toBe("h".repeat(40));
      expect(executor.scratch[0]).toBe(true);
      const prompt = promptOf(executor, 0);
      expect(prompt).toContain("あなたはソフトウェア開発のレビューエージェントです");
      expect(prompt).toContain("+export const retry = 3;");
      expect(prompt).toContain("回数を環境変数で変えられるようにした");
      // 写しに .git は無いので、差分の全体（切り詰めなし）をファイルで置き、プロンプトでその場所を伝える（PBI-65）。
      // ファイルは PR 由来の写しの中ではなく、sacty が管理する場所に置いて読み取り専用でマウントする（PR のリンクをたどらない）
      expect(repos.diffFull).toEqual([true]);
      expect(prompt).toContain("/sacty-review/pr.diff");
      expect(executor.reviewDiffFiles[0]).toContain("+export const retry = 3;");
      const mount = executor.calls[0]?.mounts?.[0];
      expect(mount).toMatchObject({ containerPath: "/sacty-review", readOnly: true });
      expect(mount?.hostPath).toMatch(/[\\/]_review[\\/]/);
      expect(executor.workspaceFiles[0]).not.toContain(".sacty");
      // 実行の後は消す
      expect(existsSync(mount?.hostPath ?? "")).toBe(false);
      // 承認ゲートは無い。書いたレビューは投稿待ち
      expect(task?.gate).toBeUndefined();
      expect(service.queuedTaskIds()).toEqual([id]);

      await service.runNext(id);
      expect(pulls.reviews).toHaveLength(1);
      expect(pulls.reviews[0]).toMatchObject({
        repo: "https://github.com/acme/app",
        number: 12,
        token: "ghp_secret",
        commit: "h".repeat(40),
      });
      expect(pulls.reviews[0]?.body).toContain(`<!-- sacty-review:${id} -->`);
      expect(pulls.reviews[0]?.body).toContain("src/retry.ts:1 上限が無い");
      const done = service.get(id)?.task;
      expect(done && isCompleted(done)).toBe(true);
      expect(done?.reviewPost).toMatchObject({
        url: "https://github.com/acme/app/pull/12#pullrequestreview-1",
      });
      // PR の先頭は変わっていない（投稿の直前に確かめる。PBI-111）
      expect(done?.reviewPost?.latestCommit).toBeUndefined();
      expect(pulls.reviews[0]?.body).not.toContain("このレビューは");
      // 調査ではないので Issue にはコメントしない。二度は投稿しない
      expect(service.queuedTaskIds()).toEqual([]);
      await service.runNext(id);
      expect(pulls.reviews).toHaveLength(1);
      expect(pulls.issueComments).toHaveLength(0);
      activity.close();
    });

    it("差分の行への指摘は行へのコメントにし、差分の外の指摘は本文に入れて、あわせて投稿する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const comments = [
        { path: "src/retry.ts", line: 2, body: "上限を設定から読む" },
        { path: "./src/retry.ts", line: 3, body: "前後の行にも付けられる" },
        { path: "src/retry.ts", line: 40, body: "差分の外の行" },
        { path: "src/other.ts", line: 1, body: "差分に無いファイル" },
      ];
      const { service } = makeService(
        activity,
        [out(`# 評価\n\n直す点があります。\n\n${block({ "sacty-review-comments": comments })}`)],
        { pulls, planner: reviewPlanner },
      );
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.reviewComments).toEqual([
        { path: "src/retry.ts", line: 2, body: "上限を設定から読む" },
        { path: "src/retry.ts", line: 3, body: "前後の行にも付けられる" },
      ]);
      expect(task?.outputs.review).not.toContain("sacty-review-comments");
      expect(task?.outputs.review).toContain("### 行についての指摘");
      expect(task?.outputs.review).toContain("`src/retry.ts:40` 差分の外の行");
      expect(task?.outputs.review).toContain("`src/other.ts:1` 差分に無いファイル");

      await service.runNext(id);
      expect(pulls.findReviewAccounts).toEqual(["me"]);
      expect(pulls.reviews).toHaveLength(1);
      expect(pulls.reviews[0]?.comments).toEqual([
        { path: "src/retry.ts", line: 2, body: `<!-- sacty-review:${id} -->\n上限を設定から読む` },
        {
          path: "src/retry.ts",
          line: 3,
          body: `<!-- sacty-review:${id} -->\n前後の行にも付けられる`,
        },
      ]);
      expect(pulls.reviews[0]?.body).toContain("`src/retry.ts:40` 差分の外の行");
      expect(pulls.reviews[0]?.body).not.toContain("上限を設定から読む");
      activity.close();
    });

    it("行へのコメントだけのレビューも投稿して完了し、二度は投稿しない（レビュー指摘）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service } = makeService(
        activity,
        [
          out(
            block({
              "sacty-review-comments": [{ path: "src/retry.ts", line: 2, body: "上限が無い" }],
            }),
          ),
        ],
        { pulls, planner: reviewPlanner },
      );
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      expect(service.get(id)?.task.outputs.review).toBe("");
      await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task && isCompleted(task)).toBe(true);
      expect(task?.reviewPost).toBeDefined();
      expect(pulls.reviews).toHaveLength(1);
      expect(pulls.reviews[0]?.comments).toHaveLength(1);
      expect(service.queuedTaskIds()).toEqual([]);
      activity.close();
    });

    it("行へのコメントを GitHub が受け付けなければ、本文に入れて投稿し直す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      pulls.rejectComments = true;
      const { service } = makeService(
        activity,
        [
          out(
            `# 評価\n\n${block({ "sacty-review-comments": [{ path: "src/retry.ts", line: 2, body: "上限が無い" }] })}`,
          ),
        ],
        { pulls, planner: reviewPlanner },
      );
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      await service.runNext(id);
      expect(pulls.reviews).toHaveLength(1);
      expect(pulls.reviews[0]?.comments).toEqual([]);
      expect(pulls.reviews[0]?.body).toContain("`src/retry.ts:2` 上限が無い");
      const task = service.get(id)?.task;
      expect(task && isCompleted(task)).toBe(true);
      activity.close();
    });

    it("投稿の後、記録の前に止まっても、次の実行で同じレビューを二度投稿しない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      // ほかのタスクのレビューは、このタスクのものとして使わない
      pulls.reviews.push({
        repo: "https://github.com/acme/app",
        token: "ghp_secret",
        number: 12,
        commit: "h".repeat(40),
        body: "<!-- sacty-review:other-task -->",
      });
      const { service } = makeService(activity, [out("# 評価")], { pulls, planner: reviewPlanner });
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      const append = activity.append.bind(activity);
      let failOnce = true;
      activity.append = (entry) => {
        if (failOnce && entry.events.some((e) => e.event.type === "PullRequestReviewPosted")) {
          failOnce = false;
          throw new Error("disk full");
        }
        return append(entry);
      };
      // 投稿の直前に PR の先頭が変わっていた（PBI-111）
      pulls.states[12] = { state: "open", headSha: "n".repeat(40) };
      await expect(service.runNext(id)).rejects.toThrow("disk full");
      expect(pulls.reviews).toHaveLength(2);
      // やり直しの前に、さらに push されても、投稿したときの先頭を記録する
      pulls.states[12] = { state: "open", headSha: "m".repeat(40) };
      await service.runNext(id);
      expect(pulls.reviews).toHaveLength(2);
      expect(service.get(id)?.task.reviewPost).toMatchObject({
        url: "https://github.com/acme/app/pull/12#pullrequestreview-2",
        latestCommit: "n".repeat(40),
      });
      activity.close();
    });

    it("投稿する本文の先頭に、PR の作者への @ メンションと判定を書く（PBI-111）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service } = makeService(
        activity,
        [out(`# 総評\n\n${block({ "sacty-review-verdict": { verdict: "suggestions" } })}`)],
        { pulls, planner: reviewPlanner },
      );
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      expect(service.get(id)?.task.reviewTarget?.author).toBe("alice");
      await service.runNext(id);
      const body = pulls.reviews[0]?.body ?? "";
      expect(body.split("\n").slice(0, 6)).toEqual([
        `<!-- sacty-review:${id} -->`,
        "## sacty のレビュー",
        "",
        "@alice 判定：提案あり（マージは可）",
        "",
        "# 総評",
      ]);
      activity.close();
    });

    it("投稿の直前に PR の先頭が変わっていたら、レビューしたコミットに投稿し、その旨を本文と作業履歴に残す（PBI-111）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service } = makeService(activity, [out("# 評価")], { pulls, planner: reviewPlanner });
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      // レビューの間に push された。確かめられなければ、投稿せずに止まる（再開すると確かめ直す）
      pulls.statusFail = "502 Bad Gateway";
      await service.runNext(id);
      expect(pulls.reviews).toHaveLength(0);
      expect(service.get(id)?.task.status).toBe("paused");
      pulls.statusFail = undefined;
      // 応答に先頭のコミットが無い・空でも、確かめられないので投稿しない（PR 121 レビュー指摘）
      for (const headSha of [undefined, "", "  "]) {
        service.resume(id, {});
        pulls.states[12] = { state: "open", ...(headSha === undefined ? {} : { headSha }) };
        if (headSha === undefined) pulls.prInfo = { ...pulls.prInfo, headSha: "" };
        await service.runNext(id);
        pulls.prInfo = { ...pulls.prInfo, headSha: "h".repeat(40) };
        expect(pulls.reviews, String(headSha)).toHaveLength(0);
        const paused = service.get(id)?.task;
        expect(paused?.status, String(headSha)).toBe("paused");
        expect(ja(paused?.pausedMessage), String(headSha)).toContain(
          "PR の先頭のコミットを確かめられませんでした",
        );
      }
      pulls.states[12] = { state: "open", headSha: "n".repeat(40) };
      service.resume(id, {});
      await service.runNext(id);
      expect(pulls.reviews).toHaveLength(1);
      expect(pulls.reviews[0]?.commit).toBe("h".repeat(40));
      expect(pulls.reviews[0]?.body).toContain(
        "> このレビューは hhhhhhh のコードに対するものです。レビューの間に、PR の先頭が nnnnnnn に変わりました。",
      );
      const task = service.get(id)?.task;
      expect(task && isCompleted(task)).toBe(true);
      expect(task?.reviewPost?.latestCommit).toBe("n".repeat(40));
      activity.close();
    });

    it("PR を確かめられなければ、エージェントを実行せずに理由を記録して止まり、再開すると確かめ直す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      pulls.prInfoFail = "404 Not Found ghp_secret";
      const { service, executor } = makeService(activity, [out("# 評価")], {
        pulls,
        planner: reviewPlanner,
      });
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      let task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.pausedReason).toBe("error");
      expect(JSON.stringify(task?.pausedMessage)).toContain("404 Not Found");
      expect(JSON.stringify(task?.pausedMessage)).not.toContain("ghp_secret");
      expect(executor.calls).toHaveLength(0);
      pulls.prInfoFail = undefined;
      service.resume(id, {});
      await service.runNext(id);
      task = service.get(id)?.task;
      expect(task?.reviewTarget?.number).toBe(12);
      expect(executor.calls).toHaveLength(1);
      activity.close();
    });

    it("タスクに対象リポジトリの PR が無ければ、理由を記録して止まる", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service, executor } = makeService(activity, [out("# 評価")], {
        pulls,
        planner: reviewPlanner,
      });
      const id = importReviewIssue(service, "https://github.com/other/app/pull/99");
      await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.pausedMessage).toEqual({
        code: "review.pullRequestMissing",
        params: { repo: "https://github.com/acme/app" },
      });
      expect(pulls.prInfoRequests).toHaveLength(0);
      expect(executor.calls).toHaveLength(0);
      activity.close();
    });

    it("投稿できなければ、理由を記録して止まり、再開するとエージェントを実行し直さずに投稿する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      pulls.reviewFail = "403 Resource not accessible ghp_secret";
      const { service, executor } = makeService(activity, [out("# 評価")], {
        pulls,
        planner: reviewPlanner,
      });
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      await service.runNext(id);
      let task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(JSON.stringify(task?.pausedMessage)).toContain("403");
      expect(JSON.stringify(task?.pausedMessage)).not.toContain("ghp_secret");
      // 止まっている間は投稿しない
      expect(service.queuedTaskIds()).toEqual([]);
      pulls.reviewFail = undefined;
      service.resume(id, {});
      expect(service.queuedTaskIds()).toEqual([id]);
      await service.runNext(id);
      task = service.get(id)?.task;
      expect(task && isCompleted(task)).toBe(true);
      expect(pulls.reviews).toHaveLength(1);
      expect(executor.calls).toHaveLength(1);
      activity.close();
    });

    it("オーケストレーターには、タスクに対象リポジトリの PR があるときだけ、レビューを候補に出す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const plan = (value: string) =>
        out(block({ "sacty-steps": { plan: value, reason: "レビューの依頼" } }), 200);
      const { service, executor } = makeService(
        activity,
        [plan("review"), out("# 評価"), plan("review"), out("# 要求要件")],
        { realPlanner: true },
      );
      const withPr = importReviewIssue(service, "https://github.com/ACME/app/pull/12");
      await service.runNext(withPr);
      expect(promptOf(executor, 0)).toContain("- review：");
      expect(service.get(withPr)?.task.steps.map((st) => st.key)).toEqual(["review"]);
      // PR の無いタスクでレビューを選んでも、選べない組み合わせとして止める（PBI-40）
      const { id } = service.createTask({
        projectId: "default",
        title: "レビューして",
        body: "PR は無い",
      });
      await service.runNext(id);
      expect(promptOf(executor, 2)).toContain("あなたはオーケストレーターです");
      expect(promptOf(executor, 2)).not.toContain("- review：");
      expect(service.get(id)?.task.steps).toEqual([]);
      expect(service.get(id)?.task.status).toBe("paused");
      activity.close();
    });
  });

  describe("オーケストレーターが工程を選ぶ（PBI-17）", () => {
    const plan = (
      value: string,
      reason = "小さな変更",
      extra: Record<string, string> = { testCommand: "npm test" },
    ) => out(block({ "sacty-steps": { plan: value, reason, ...extra } }), 200);

    it("タスクの内容と起点のコードを読んで工程を選び、理由と費用を記録して、最初の工程を続けて実行する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [plan("skip-design"), out("# 前段の調査\n\n- src/button.ts:3 に文言"), out("# 要求要件")],
        {
          realPlanner: true,
        },
      );
      const { id } = service.createTask({
        projectId: "default",
        title: "文言の修正",
        body: "ボタンの文言を変える",
      });
      await service.runNext(id);
      // オーケストレーターには、タスクの内容と起点のコードを読み取り専用で渡す
      const prompt = promptOf(executor, 0);
      expect(prompt).toContain("あなたはオーケストレーターです");
      expect(prompt).toContain("ボタンの文言を変える");
      expect(prompt).toContain("skip-design");
      // ベースブランチとテストのコマンドも、リポジトリを読んで決めさせる（PBI-25）
      expect(prompt).toContain("testCommand");
      expect(prompt).toContain("既定のブランチ（main）");
      expect(executor.scratch[0]).toBe(true);
      expect(executor.workspaceFiles[0]).toEqual(["README.md"]);
      const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.actor).toBe("orchestrator");
      expect(chosen?.payload).toMatchObject({
        steps: ["investigate", "requirements", "implement", "deployment"],
        plan: "skip-design",
        reason: "小さな変更",
        fallback: false,
        testCommand: "npm test",
        // 起点のコミットにデプロイの確認のスキルが無いので、マージの後の監視の工程は飛ばす（PBI-116）
        deployment: {
          skipped: { code: "deploy.stepSkipped", params: { detail: { code: "deploy.noSkill" } } },
        },
      });
      // 実装する組み合わせは、先頭の前段の調査を同じ実行で続けて行い、人間の承認なしに次の工程へ進む（PBI-29）
      expect(promptOf(executor, 1)).toContain("このあと 要求要件 → 実装 の工程で進めます");
      const investigated = service.get(id)?.task;
      expect(investigated?.steps.map((st) => [st.key, st.state])).toEqual([
        ["investigate", "done"],
        ["requirements", "active"],
        ["implement", "todo"],
        ["deployment", "skip"],
      ]);
      expect(investigated?.status).toBe("queued");
      expect(investigated?.gate).toBeUndefined();
      // 前段の調査の結果は、後の工程（要求要件）に渡す
      await service.runNext(id);
      expect(promptOf(executor, 2)).toContain("--- 前段の調査の結果");
      expect(promptOf(executor, 2)).toContain("src/button.ts:3 に文言");
      const task = service.get(id)?.task;
      expect(task?.steps.map((st) => st.key)).toEqual([
        "investigate",
        "requirements",
        "implement",
        "deployment",
      ]);
      expect(task?.stepsChoice).toEqual({
        plan: "skip-design",
        reason: "小さな変更",
        fallback: false,
      });
      // 判断の費用も予算に入る。最初の工程（要求要件）は、同じ実行で続けて行う
      expect(task?.budget.usedUsd).toBeGreaterThan(0.0015);
      expect(task?.gate).toEqual({ step: "requirements", submission: 1 });
      activity.close();
    });

    it("オーケストレーターが判断した調査の性質を記録し、内容の調査だけセットアップを省く指示を出す（PBI-43）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          plan("investigate", "仕組みの質問", { investigation: "content" }),
          out("# 調査の結果"),
          plan("investigate", "不具合の原因の調査", { investigation: "bug" }),
          out("# 調査の結果"),
        ],
        { realPlanner: true },
      );
      const noSetup =
        "開発のためのセットアップ（依存関係のインストール・ビルド・setup のスクリプトなど）は実行しない";
      const a = service.createTask({ projectId: "default", title: "仕組みを知りたい" });
      await service.runNext(a.id);
      expect(promptOf(executor, 0)).toContain(noSetup);
      expect(
        service.get(a.id)?.activity.find((e) => e.type === "StepsChosen")?.payload,
      ).toMatchObject({
        investigation: "content",
      });
      expect(service.get(a.id)?.task.investigation).toBe("content");
      expect(promptOf(executor, 1)).toContain(noSetup);

      const b = service.createTask({ projectId: "default", title: "落ちる原因を知りたい" });
      await service.runNext(b.id);
      expect(service.get(b.id)?.task.investigation).toBe("bug");
      expect(promptOf(executor, 3)).toContain("あなたはソフトウェア開発の調査エージェントです");
      expect(promptOf(executor, 3)).not.toContain(noSetup);
      activity.close();
    });

    it("選べない・読めない・実行に失敗したときは、標準の工程で代わりに進めず、理由を記録して止める。再開すると選び直す（PBI-40）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          plan("everything"),
          { kind: "failed", reason: "error", message: "connection reset" },
          // 再開すると、工程の選択からやり直す
          plan("investigate", "情報を求めている", {}),
          out("# 調査の結果"),
        ],
        { realPlanner: true },
      );
      const a = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(a.id);
      // 標準の工程（設計・実装）には進めず、テストのコマンドが無いことでも止めない
      expect(service.get(a.id)?.task.steps).toEqual([]);
      expect(service.get(a.id)?.task.status).toBe("paused");
      expect(service.get(a.id)?.task.pausedReason).toBe("error");
      expect(ja(service.get(a.id)?.task.pausedMessage)).toBe(
        "オーケストレーターを実行できませんでした：オーケストレーターの出力から、選んだ工程を読み取れませんでした。再開すると、工程の選択からやり直します。",
      );
      expect(service.get(a.id)?.activity.map((e) => e.type)).toContain("OrchestratorFailed");

      const b = service.createTask({ projectId: "default", title: "B の調査" });
      await service.runNext(b.id);
      expect(service.get(b.id)?.task.steps).toEqual([]);
      expect(ja(service.get(b.id)?.task.pausedMessage)).toContain("connection reset");
      // 再開すると、選び直して調査だけで進む
      service.resume(b.id, {});
      await service.runNext(b.id);
      expect(promptOf(executor, 2)).toContain("あなたはオーケストレーターです");
      expect(service.get(b.id)?.task.steps.map((st) => st.key)).toEqual(["investigate"]);
      expect(service.get(b.id)?.task.pausedMessage).toBeUndefined();
      activity.close();
    });

    it("認証の失敗・利用上限なら、標準の工程で進めずに理由を記録して止め、再開すると工程の選択からやり直す（PBI-32）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [
          { kind: "failed", reason: "auth", message: "unexpected status 401 Unauthorized" },
          {
            kind: "failed",
            reason: "usage_limit",
            message: "ThrottlingException",
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 20_000 },
          },
          plan("skip-design"),
        ],
        { realPlanner: true },
      );
      const a = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(a.id);
      const paused = service.get(a.id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.pausedReason).toBe("auth");
      expect(paused?.steps).toEqual([]);
      expect(ja(paused?.pausedMessage)).toBe(
        "オーケストレーターを実行できませんでした：unexpected status 401 Unauthorized。再開すると、工程の選択からやり直します。",
      );
      service.resume(a.id, {});
      await service.runNext(a.id);
      expect(service.get(a.id)?.task.pausedReason).toBe("usage_limit");
      expect(service.get(a.id)?.task.steps).toEqual([]);
      // 実行の途中で止まった分の費用も予算に入れる（出力 20,000 トークン × $15/100万 = $0.30。レビュー指摘）
      expect(service.get(a.id)?.task.budget.usedUsd).toBe(0.3);
      expect(
        service
          .get(a.id)
          ?.activity.filter((e) => e.type === "OrchestratorFailed")
          .map((e) => e.actor),
      ).toEqual(["orchestrator", "orchestrator"]);
      service.resume(a.id, {});
      await service.runNext(a.id);
      expect(service.get(a.id)?.task.stepsChoice?.plan).toBe("skip-design");
      activity.close();
    });

    it("設計を省いたタスクは、要求要件の受け入れ条件をテストと最終レビューで確かめて、実装の承認待ちに進む", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service, executor } = makeService(
        activity,
        [
          out("# 要求要件"),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["a.test.ts › 受け入れ条件"] }]),
          review([["REQ", true]], []),
        ],
        {
          pulls,
          planner: async () => ({
            steps: ["requirements", "implement"],
            plan: "skip-design",
            reason: "小さな変更",
            fallback: false,
            testCommand: "npm test",
            costUsd: 0,
            estimated: false,
          }),
        },
      );
      const { id } = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await drain(service);
      const implementPrompt = promptOf(executor, 1);
      expect(implementPrompt).toContain("設計の工程を省いています");
      expect(implementPrompt).toContain("[REQ] 承認済みの要求要件の受け入れ条件");
      const finalPrompt = promptOf(executor, 2);
      expect(finalPrompt).toContain("[REQ] 承認済みの要求要件の受け入れ条件");
      const task = service.get(id)?.task;
      expect(task?.lastReview).toMatchObject({
        passed: true,
        viewpoints: [{ viewpointId: "REQ" }],
      });
      expect(task?.gate).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });

    it("設計を省いたタスクで、受け入れ条件（REQ）にテストを対応させていなければ、テストの段階で通さない（レビュー指摘）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [out("# 要求要件"), implement("# 実装の説明", []), implement("# 実装の説明 v2", [])],
        {
          planner: async () => ({
            steps: ["requirements", "implement"],
            plan: "skip-design",
            reason: "小さな変更",
            fallback: false,
            testCommand: "npm test",
            costUsd: 0,
            estimated: false,
          }),
        },
      );
      const { id } = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id); // 実装
      await service.runNext(id); // テスト
      const tests = service.get(id)?.activity.find((e) => e.type === "TestsRun");
      expect(tests?.type === "TestsRun" && tests.payload).toMatchObject({
        passed: false,
        unmappedViewpoints: ["REQ"],
      });
      // 最終レビューはせずに、実装をやり直す
      expect(executor.calls.map((_, i) => promptOf(executor, i)).join()).not.toContain(
        "sacty-final-review",
      );
      expect(service.get(id)?.task.status).toBe("queued");
      activity.close();
    });
  });

  it("実装は対象リポジトリの clone で、承認済みの成果物と人間の指摘を受け取って実行する", async () => {
    const { activity, service, executor, repos, id } = await toImplement([
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
        url: "https://github.com/acme/app.git",
        // ブランチを指定せず、既定のブランチを clone する（PBI-25）
        // GitHub の HTTPS なので、プロジェクトの gh のアカウントで clone する
        authEnv: expect.any(Object),
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
      url: "https://github.com/acme/app.git",
      baseBranch: "main",
      baseCommit: "base123",
    });
    expect(task?.outputs.implement).toBe("# 実装の説明");
    expect(task?.testMap.map((m) => m.viewpointId)).toEqual(["TV-1", "TV-2"]);
    expect(task?.verification).toBe("pending");
    activity.close();
  });

  it("テストを別に実行して通れば、ゴールガーディアンが新しいセッションで最終レビューし、合格なら実装を完了にする", async () => {
    const tests = new FakeTests([{ exitCode: 0, output: "2 passed", durationMs: 1200 }]);
    const { activity, service, executor, id } = await toImplement(
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
    expect(guardian).not.toContain("タスクの本文");
    expect(executor.dirs[4]).toContain("_guardian");
    expect(existsSync(executor.dirs[4] ?? "")).toBe(false);

    const task = service.get(id)?.task;
    // 実装の工程の中で、sacty が PR を作り、実装の承認待ちで止まる（PBI-110）
    expect(task?.steps.map((st) => st.state)).toEqual(["done", "done", "active"]);
    expect(task?.gate?.step).toBe("implement");
    expect(task?.lastReview).toMatchObject({ passed: true, summary: "所見" });
    expect(task?.lastTests).toMatchObject({ passed: true, exitCode: 0, durationMs: 1200 });
    expect(types(service, id).slice(-7)).toEqual([
      "AgentRunCompleted",
      "TestsRun",
      "FinalReviewed",
      "BranchPushed",
      "PullRequestPublished",
      "StepSubmitted",
      // 取り込むラベル（PBI-88）
      "PullRequestLabeled",
    ]);
    expect(service.get(id)?.activity.find((e) => e.type === "FinalReviewed")?.actor).toBe(
      "guardian",
    );
    activity.close();
  });

  it("テストが通らなければ、出力を渡して実装をやり直す", async () => {
    const tests = new FakeTests([
      { exitCode: 1, output: "AssertionError: expected 2 to be 1", durationMs: 10 },
      { exitCode: 0, output: "ok", durationMs: 10 },
    ]);
    const { activity, service, executor, id } = await toImplement(
      [implement("# v1"), implement("# v2"), review()],
      { tests },
    );
    await drain(service);
    const retry = promptOf(executor, 4);
    expect(retry).toContain("--- 前回の検証：テストが通りませんでした ---");
    expect(retry).toContain("AssertionError: expected 2 to be 1");
    expect(retry).toContain("--- 前回の実装の説明 ---\n# v1");
    const task = service.get(id)?.task;
    expect(task?.gate?.step).toBe("implement");
    expect(task?.verifyFailures).toBe(0);
    activity.close();
  });

  it("テストが通っても、テストの対応していない観点があれば不合格にする", async () => {
    const { activity, service, id } = await toImplement([
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
    activity.close();
  });

  it("最終レビューで、観点を検証していない・指摘が再発している・判定が無いものは不合格にし、所見を渡してやり直す", async () => {
    const { activity, service, executor, id } = await toImplement([
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
    expect(service.get(id)?.task.gate?.step).toBe("implement");
    activity.close();
  });

  it("検証に3回続けて通らなければ一時停止し、再開すると数え直して実装をやり直す", async () => {
    const fail = { exitCode: 1, output: "fail", durationMs: 1 };
    const tests = new FakeTests([fail, fail, fail]);
    const { activity, service, id } = await toImplement(
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
    activity.close();
  });

  it("最終レビューを実行できなければ止め、再開するとテストを繰り返さずに最終レビューからやり直す", async () => {
    const tests = new FakeTests();
    const { activity, service, id } = await toImplement(
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
    expect(service.get(id)?.task.gate?.step).toBe("implement");
    activity.close();
  });

  it("最終レビューを実行できなかった分の費用も記録し、予算に入れる（レビュー指摘）", async () => {
    const { activity, service, id } = await toImplement([
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
    activity.close();
  });

  it("差分を取得できなければ最終レビューをせずに止め、再開すると差分の取得からやり直す（レビュー指摘）", async () => {
    const repos = new FakeRepos();
    const tests = new FakeTests();
    const { activity, service, executor, id } = await toImplement([implement("# v1"), review()], {
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
    expect(service.get(id)?.task.gate?.step).toBe("implement");
    activity.close();
  });

  it("対象リポジトリが無い・clone できなければ、タスクの開始時に理由を記録して止める（PBI-15）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const repos = new FakeRepos();
    repos.fail = "git clone に失敗しました：Repository not found";
    const { service, executor } = makeService(activity, [out("# 要求要件")], { repos });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.pausedReason).toBe("error");
    // エージェントは実行しない（費用をかける前に止める）
    expect(executor.calls).toHaveLength(0);
    // 工程を選ぶ前（オーケストレーターも実行しない）
    expect(task?.steps).toEqual([]);
    // タスクの開始時に止まるので、エージェントの実行の失敗ではなく、一時停止の理由として記録する（PBI-15）
    expect(service.get(id)?.task.pausedMessage).toContain("Repository not found");
    activity.close();
  });

  it("PBI-8・9で設計が承認され、実装の工程が無かったため待機していたタスクは、起動時に実装を実行待ちにする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("# 要求要件"), design]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    // PBI-9までの作業履歴：実装の工程を実行できなかったため、設計の承認後に待機していた
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: { type: "StepApproved", payload: { step: "design", next: "idle" } },
        },
      ],
    });
    const { service: restarted } = makeService(activity, [implement("# v1")]);
    restarted.queueWaitingSteps();
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    restarted.queueWaitingSteps(); // 実装済み（検証待ち）のタスクには何もしない
    expect(types(restarted, id).filter((t) => t === "StepQueued")).toHaveLength(1);
    activity.close();
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
    const { activity, service, id } = await toImplement([implement("# v1"), proposal, verdict], {
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
    activity.close();
  });

  /** 実装・検証を終え、実装の PR を作って実装の承認待ちまで進める（PBI-110）。 */
  async function toImplementGate(
    outcomes: AgentOutcome[] = [],
    options: {
      pulls?: FakePulls;
      repos?: FakeRepos;
      config?: () => ConfigResult;
      now?: () => number;
    } = {},
  ) {
    const made = await toImplement([implement("# 実装の説明"), review(), ...outcomes], options);
    await drain(made.service);
    return made;
  }

  it("最終レビューに通ったら、ブランチにプッシュしてPRを作り、実装の承認待ちで止まる（PBI-10b・PBI-110）", async () => {
    const { activity, service, repos, pulls, id } = await toImplementGate();
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
      repo: "https://github.com/acme/app",
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
    expect(task?.gate).toEqual({ step: "implement", submission: 1 });
    expect(task?.pullRequest).toMatchObject({
      url: "https://github.com/acme/app/pull/7",
      number: 7,
    });
    expect(types(service, id).slice(-4)).toEqual([
      "BranchPushed",
      "PullRequestPublished",
      "StepSubmitted",
      "PullRequestLabeled",
    ]);
    // 実装の PR に、レビュー用のラベルを付ける（PBI-88・PBI-99）
    expect(pulls.labels).toEqual([
      {
        repo: "https://github.com/acme/app",
        token: "ghp_secret",
        number: 7,
        label: "sacty-review",
      },
    ]);
    // トークンは作業履歴に残さない
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("ghp_secret");

    // PR を作ったタスクは、画面では承認できない（PR のマージで承認する。PBI-14a）
    expect(() => service.approve(id, { step: "implement", submission: 1 })).toThrow(/マージ/);
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
    activity.close();
  });

  describe("実装の工程の中で PR を作って承認を待つ（PBI-110）", () => {
    it("工程に「PR作成」は無く、検証に通った実装の工程のまま PR を作って実装の承認待ちになり、マージで完了する", async () => {
      const { activity, service, id } = await toImplement([implement("# 実装の説明"), review()]);
      expect(service.get(id)?.task.steps.map((s) => s.key)).toEqual([
        "requirements",
        "design",
        "implement",
      ]);
      await service.runNext(id); // 実装
      await service.runNext(id); // テストと最終レビュー
      const verified = service.get(id)?.task;
      expect(verified?.status).toBe("queued");
      expect(verified?.publishPending).toBe(true);
      expect(verified?.steps.at(-1)).toEqual({ key: "implement", state: "active" });
      expect(verified?.gate).toBeUndefined();
      await service.runNext(id); // 実装の工程の中で、sacty が PR を作る
      const gated = service.get(id)?.task;
      expect(gated?.gate).toEqual({ step: "implement", submission: 1 });
      expect(gated?.steps.at(-1)).toEqual({ key: "implement", state: "active" });
      expect(types(service, id).slice(-5)).toEqual([
        "FinalReviewed",
        "BranchPushed",
        "PullRequestPublished",
        "StepSubmitted",
        "PullRequestLabeled",
      ]);
      const submitted = service.get(id)?.activity.findLast((e) => e.type === "StepSubmitted");
      expect(submitted?.payload).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });

    it("最終レビューで予算の上限に達しても、PR を作って承認を待つ（PR の作成に費用はかからない）", async () => {
      const { activity, service, pulls, id } = await toImplement([
        implement("# 実装の説明"),
        review(undefined, undefined, 100_000),
      ]);
      await drain(service);
      const task = service.get(id)?.task;
      expect(budgetState(task?.budget as Task["budget"])).toBe("exceeded");
      expect(task?.status).toBe("awaiting_approval");
      expect(task?.gate).toEqual({ step: "implement", submission: 1 });
      expect(pulls.calls).toHaveLength(1);
      expect(types(service, id)).not.toContain("TaskPaused");
      activity.close();
    });

    it("PR を作っている途中に一時停止を求めたら、作り終えて承認待ちにし、一時停止しなかったとはっきり返す（レビュー指摘）", async () => {
      const pulls = new FakePulls();
      const gate = Promise.withResolvers<void>();
      pulls.upsertGate = gate.promise;
      const { activity, service, id } = await toImplement([implement("# 実装の説明"), review()], {
        pulls,
      });
      await service.runNext(id); // 実装
      await service.runNext(id); // テストと最終レビュー
      const publishing = service.runNext(id);
      await pulls.upsertStarted.promise;
      const pausing = service.pause(id);
      gate.resolve();
      await expect(pausing).rejects.toThrow(
        "止める前に作業が終わり、承認待ちになったため、一時停止しませんでした",
      );
      await publishing;
      const task = service.get(id)?.task;
      expect(task?.status).toBe("awaiting_approval");
      expect(task?.gate).toEqual({ step: "implement", submission: 1 });
      expect(task?.pullRequest?.number).toBe(7);
      expect(types(service, id)).not.toContain("TaskPaused");
      // 止める要求は残らない（後の確認・操作に影響しない）
      expect(() => service.approve(id, { step: "implement", submission: 1 })).toThrow(/マージ/);
      activity.close();
    });

    it("PR を作る前（プッシュの途中）に一時停止を求めたら、PR を作らずに一時停止し、再開すると PR を1つだけ作る（レビュー指摘）", async () => {
      const repos = new FakeRepos();
      const gate = Promise.withResolvers<void>();
      repos.publishGate = gate.promise;
      const { activity, service, pulls, id } = await toImplement(
        [implement("# 実装の説明"), review()],
        { repos },
      );
      await service.runNext(id);
      await service.runNext(id);
      const publishing = service.runNext(id);
      await repos.publishStarted.promise;
      const pausing = service.pause(id);
      gate.resolve();
      const paused = await pausing;
      await publishing;
      expect(paused.status).toBe("paused");
      expect(paused.publishPending).toBe(true);
      expect(pulls.calls).toHaveLength(0);
      repos.publishGate = undefined;
      service.resume(id, {});
      await drain(service);
      expect(pulls.calls).toHaveLength(1);
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });

    it("PR を作れずに止まったら、再開すると実装をやり直さずに PR を作り直す", async () => {
      const pulls = new FakePulls();
      pulls.fail = "boom";
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装の説明"), review()],
        { pulls },
      );
      await drain(service);
      const paused = service.get(id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.publishPending).toBe(true);
      const runs = executor.calls.length;
      pulls.fail = undefined;
      service.resume(id, {});
      await drain(service);
      expect(executor.calls).toHaveLength(runs);
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });
  });

  it("実装の承認待ちの間、プロジェクトの gh のアカウントで PR を見守り、閉じられたら記録して待ち、マージで完了する（PBI-14a）", async () => {
    const pulls = new FakePulls();
    const { activity, service, id } = await toImplementGate([], { pulls });
    // 開いたままなら何も記録しない
    await service.checkPullRequests();
    expect(pulls.checked).toEqual([
      { repo: "https://github.com/acme/app", token: "ghp_secret", number: 7 },
    ]);
    expect(types(service, id).at(-1)).toBe("PullRequestLabeled");

    // 確かめられなければ（ネットワークなど）、何も記録せずに次の確認でやり直す
    pulls.statusFail = "network";
    await service.checkPullRequests();
    expect(types(service, id).at(-1)).toBe("PullRequestLabeled");
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
    const activityEvents = service.get(id)?.activity ?? [];
    expect(activityEvents.slice(-2).map((e) => [e.type, e.actor])).toEqual([
      ["PullRequestMerged", "person"],
      ["StepApproved", "person"],
    ]);
    expect(activityEvents.at(-2)?.payload).toEqual({
      number: 7,
      by: "reviewer",
      commit,
      outdated: false,
      submitted: commit,
      edited: false,
    });
    expect(service.get(id)?.task.steps.every((st) => st.state === "done")).toBe(true);
    // 完了したタスクは、もう確かめない
    const checks = pulls.checked.length;
    await service.checkPullRequests();
    expect(pulls.checked).toHaveLength(checks);
    activity.close();
  });

  it("実装の承認待ちで差し戻すと見逃しを記録し、実装をやり直して同じPRを更新する（PBI-10b）", async () => {
    const { activity, service, executor, repos, pulls, id } = await toImplementGate([
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
      service.requestChanges(id, {
        step: "implement",
        submission: 1,
        target: "reproduce",
        comments: ["x"],
      }),
    ).toThrow(/差し戻せません/);
    const sent = service.requestChanges(id, {
      step: "implement",
      submission: 1,
      comments: ["失敗時のログが無い"],
    });
    expect(sent.status).toBe("queued");
    expect(sent.steps.map((st) => st.state)).toEqual(["done", "done", "active"]);
    expect(sent.remarks.at(-1)).toMatchObject({ id: "implement-1-1", step: "implement" });
    expect(sent.misses).toMatchObject([{ remarkIds: ["implement-1-1"] }]);
    expect(types(service, id).slice(-2)).toEqual(["GuardianMissed", "ChangesRequested"]);

    await drain(service);
    const prompt = promptOf(executor, 6);
    expect(prompt).toContain("[implement-1-1] 失敗時のログが無い");
    const task = service.get(id)?.task;
    expect(task?.remarks.at(-1)?.response).toBe("ログを足した");
    // 実装への対応は、実装の2回目の提出での対応として記録する（レビュー指摘）
    expect(task?.remarks.at(-1)?.respondedIn).toBe(2);
    expect(task?.gate).toEqual({ step: "implement", submission: 2 });
    // 前回プッシュしたコミットに積み、同じPRを更新する
    expect(repos.published[1]).toMatchObject({ parent: "c1".padEnd(40, "0") });
    expect(pulls.calls[1]?.number).toBe(7);
    activity.close();
  });

  it("差し戻しの間に前の PR がマージされたら、作り直した内容は新しい PR で出し、古い内容のマージでは承認しない（PBI-14a レビュー指摘）", async () => {
    const { activity, service, pulls, id } = await toImplementGate([
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
    service.requestChanges(id, {
      step: "implement",
      submission: 1,
      comments: ["失敗時のログが無い"],
    });
    // 作り直している間に、前の PR（1回目の提出）が GitHub でマージされた
    pulls.state = { state: "merged", mergedBy: "reviewer", headSha: first };
    await drain(service);
    // マージ済みの PR は更新せず、新しい PR を作る
    expect(pulls.calls[1]?.number).toBeUndefined();
    const task = service.get(id)?.task;
    expect(task?.pullRequest?.number).toBe(8);
    expect(task?.gate).toEqual({ step: "implement", submission: 2 });
    // 新しい PR はまだ開いている。見守っても、古い PR のマージで承認にはならない
    pulls.state = { state: "open", headSha: task?.pullRequest?.commit };
    await service.checkPullRequests();
    expect(service.get(id)?.task.steps.at(-1)?.state).not.toBe("done");
    activity.close();
  });

  describe("PR へのフィードバックの取り込み（PBI-14b）", () => {
    const rework = (target: string, reason = "理由") =>
      out(`\`\`\`json\n${JSON.stringify({ "sacty-rework": { target, reason } })}\n\`\`\``);
    const at = "2026-10-11T00:00:00Z";
    /** 最後のフィードバックから、書き終わるのを待つ時間がたった時刻。 */
    const later = () => Date.parse(at) + 3 * 60_000;
    const item = (key: string, patch: Partial<PullRequestFeedback> = {}): PullRequestFeedback => ({
      key,
      kind: "comment",
      author: "reviewer",
      at,
      url: `https://github.com/acme/app/pull/7#${key}`,
      body: "全体として、失敗時のログが足りない",
      ...patch,
    });

    it("レビュー・行のコメント・通常のコメントを指摘として取り込み、ゴールガーディアンが実装と判断したら差し戻す", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate(
        [rework("implement", "実装で直せる")],
        { pulls, now: later },
      );
      pulls.feedbackList = [
        item("review:1", { kind: "review", body: "", requestChanges: true }),
        item("review_comment:2", {
          kind: "review_comment",
          path: "src/pay.ts",
          line: 12,
          body: "ここで例外を握りつぶしている",
        }),
        item("comment:3"),
      ];
      const before = executor.calls.length;
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      const imported = events.find((e) => e.type === "PullRequestReviewImported");
      // sacty が投稿したレビューを除けるよう、プロジェクトのアカウントを渡して読む（PBI-19）
      expect(pulls.feedbackAccounts.at(-1)).toBe("me");
      expect(imported?.actor).toBe("person");
      expect(imported?.payload).toMatchObject({
        number: 7,
        items: [{ key: "review:1" }, { key: "review_comment:2" }, { key: "comment:3" }],
        remarks: [
          "reviewer が PR の変更を求めました（コメントなし）。",
          "src/pay.ts:12：ここで例外を握りつぶしている",
          "全体として、失敗時のログが足りない",
        ],
      });
      expect(events.slice(-3).map((e) => [e.type, e.actor])).toEqual([
        ["ReworkJudged", "guardian"],
        ["GuardianMissed", "sacty"],
        ["ChangesRequested", "person"],
      ]);
      // ゴールガーディアンには、承認済みの成果物と指摘だけを渡す（新しいセッション）
      expect(executor.calls.length).toBe(before + 1);
      const prompt = promptOf(executor, before);
      expect(prompt).toContain("src/pay.ts:12：ここで例外を握りつぶしている");
      expect(prompt).toContain("承認済みの要求要件");
      expect(prompt).not.toContain("タスクの本文");
      // 人間の確認を挟まず、判断した工程に差し戻すことを伝える（PBI-58）
      expect(prompt).toContain("判断した工程に、そのまま差し戻します");
      expect(prompt).not.toContain("人間の判断が必要");
      // 実装で直せるかを判断するので、実装後のコードを読み取り専用で渡す（PBI-16）
      expect(executor.scratch[before]).toBe(true);
      expect(executor.workspaceFiles[before]).toEqual(["IMPLEMENTED.md"]);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("queued");
      expect(task?.remarks.slice(-3).map((r) => r.step)).toEqual([
        "implement",
        "implement",
        "implement",
      ]);
      expect(task?.importedFeedback).toEqual(["review:1", "review_comment:2", "comment:3"]);
      activity.close();
    });

    it("最後のフィードバックから時間がたつまで待ち、取り込んだものは二重に取り込まない", async () => {
      const pulls = new FakePulls();
      let now = Date.parse(at) + 30_000; // 最後のコメントから30秒
      const { activity, service, id } = await toImplementGate(
        [rework("design", "観点が足りない")],
        { pulls, now: () => now },
      );
      pulls.feedbackList = [item("comment:10")];
      await service.checkPullRequests();
      expect(service.get(id)?.task.importedFeedback).toEqual([]);
      // 書き終わるのを待って、まとめて取り込む
      now = later();
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(
        service.get(id)?.activity.filter((e) => e.type === "PullRequestReviewImported"),
      ).toHaveLength(1);
      activity.close();
    });

    it("設計まで戻す判断なら、人間の確認を待たずに設計に差し戻し、作り直した設計を人間の承認に回す（PBI-58）", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate(
        [rework("design", "観点が足りない"), design],
        { pulls, now: later },
      );
      pulls.feedbackList = [
        item("review:201", { kind: "review", body: "観点が足りない", requestChanges: true }),
        item("comment:202"),
      ];
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      expect(events.some((e) => e.type === "TaskEscalated")).toBe(false);
      expect(events.slice(-3).map((e) => [e.type, e.actor])).toEqual([
        ["ReworkJudged", "guardian"],
        ["GuardianMissed", "sacty"],
        ["ChangesRequested", "person"],
      ]);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("queued");
      expect(task?.steps.map((st) => st.state)).toEqual(["done", "active", "todo"]);
      // 設計の承認は取り消し、指摘は設計への指摘として記録する
      expect(task?.approved.design).toBeUndefined();
      expect(task?.remarks.slice(-2).map((r) => [r.id, r.step, r.text])).toEqual([
        ["design-1-1", "design", "観点が足りない"],
        ["design-1-2", "design", "全体として、失敗時のログが足りない"],
      ]);
      // 戻し先と理由を、画面（PR の欄）に出せるよう残す
      expect(task?.prRework).toMatchObject({
        target: "design",
        decided: true,
        reason: "観点が足りない",
      });
      // 作り直した設計は、いつもどおり人間の承認を待つ
      const before = executor.calls.length;
      await service.runNext(id);
      expect(promptOf(executor, before)).toContain("[design-1-1] 観点が足りない");
      const redone = service.get(id)?.task;
      expect(redone?.status).toBe("awaiting_approval");
      expect(redone?.gate).toEqual({ step: "design", submission: 2 });
      activity.close();
    });

    it("要求要件まで戻す判断なら、人間の確認を待たずに要求要件に差し戻し、作り直した要求要件を人間の承認に回す（PBI-58）", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate(
        [rework("requirements", "前提が誤っている"), out("# 要求要件 v3")],
        { pulls, now: later },
      );
      pulls.feedbackList = [item("comment:211", { body: "そもそも対象が違う" })];
      await service.checkPullRequests();
      const task = service.get(id)?.task;
      expect(task?.status).toBe("queued");
      expect(task?.escalation).toBeUndefined();
      expect(task?.steps.map((st) => st.state)).toEqual(["active", "todo", "todo"]);
      expect(task?.approved).toEqual({});
      // 要求要件への差し戻しは2回目（作業の途中で1回差し戻している）
      expect(task?.remarks.at(-1)).toMatchObject({
        id: "requirements-2-1",
        step: "requirements",
        text: "そもそも対象が違う",
      });
      expect(task?.prRework).toMatchObject({ target: "requirements", decided: true });
      await service.runNext(id);
      const redone = service.get(id)?.task;
      expect(redone?.status).toBe("awaiting_approval");
      expect(redone?.gate).toEqual({ step: "requirements", submission: 3 });
      activity.close();
    });

    it("戻し先を判断できなければ、実装をやり直し、判断できなかったことと理由を台帳に残す（PBI-58）", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate(
        [rework("undecidable", "指摘の意図が読み取れない")],
        { pulls, now: later },
      );
      pulls.feedbackList = [item("comment:221")];
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      const judged = events.find((e) => e.type === "ReworkJudged");
      expect(judged?.type === "ReworkJudged" && judged.payload.target).toBeUndefined();
      expect(judged?.type === "ReworkJudged" && judged.payload.reason).toBe(
        "指摘の意図が読み取れない",
      );
      expect(events.at(-1)).toMatchObject({
        type: "ChangesRequested",
        payload: { step: "implement", target: "implement", round: 1 },
      });
      const task = service.get(id)?.task;
      expect(task?.status).toBe("queued");
      expect(task?.steps.map((st) => st.state)).toEqual(["done", "done", "active"]);
      expect(task?.remarks.at(-1)).toMatchObject({
        step: "implement",
        text: "全体として、失敗時のログが足りない",
      });
      expect(task?.prRework).toMatchObject({
        target: "implement",
        decided: false,
        reason: "指摘の意図が読み取れない",
      });
      activity.close();
    });

    it("一度に取り込むのは50件まで。残りは取り込み済みにせず、次の取り込みに残す（レビュー指摘）", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate(
        [rework("implement", "実装で直せる")],
        {
          pulls,
          now: later,
        },
      );
      pulls.feedbackList = Array.from({ length: 51 }, (_, i) =>
        item(`comment:${i}`, { body: `指摘${i}` }),
      );
      await service.checkPullRequests();
      const imported = service
        .get(id)
        ?.activity.find((e) => e.type === "PullRequestReviewImported");
      const payload = imported?.type === "PullRequestReviewImported" ? imported.payload : undefined;
      expect(payload?.items).toHaveLength(50);
      expect(payload?.remarks).toHaveLength(50);
      // 取り込み済みにするのは、指摘に反映した50件だけ。51件目は次の取り込みに残る
      const task = service.get(id)?.task;
      expect(task?.importedFeedback).toHaveLength(50);
      expect(task?.importedFeedback).not.toContain("comment:50");
      activity.close();
    });

    it("ゴールガーディアンの実行に失敗したら、判断できなかったものとして実装をやり直す（PBI-58）", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate(
        [{ kind: "failed", reason: "usage_limit", message: "session limit" }],
        { pulls, now: later },
      );
      pulls.feedbackList = [item("comment:301")];
      await service.checkPullRequests();
      const task = service.get(id)?.task;
      expect(task?.status).toBe("queued");
      expect(task?.escalation).toBeUndefined();
      expect(task?.remarks.at(-1)).toMatchObject({
        step: "implement",
        text: "全体として、失敗時のログが足りない",
      });
      expect(task?.prRework).toMatchObject({ target: "implement", decided: false });
      expect(ja(task?.prRework?.reason)).toContain("session limit");
      activity.close();
    });

    it("差し戻しの回数が上限を超えるなら、PR の指摘でもエスカレーションにする（PBI-58）", async () => {
      const pulls = new FakePulls();
      const round = (n: number) => [
        implement(`# 実装の説明 v${n + 1}`),
        review(undefined, [
          ["requirements-1-1", true],
          ...Array.from({ length: n }, (_, i): [string, boolean] => [`implement-${i + 1}-1`, true]),
        ]),
      ];
      const { activity, service, id } = await toImplementGate(
        [...round(1), ...round(2), ...round(3), rework("implement", "実装で直せる")],
        { pulls, now: later },
      );
      for (let n = 1; n <= 3; n++) {
        service.requestChanges(id, {
          step: "implement",
          submission: service.get(id)?.task.gate?.submission ?? 0,
          comments: [`指摘${n}`],
        });
        await drain(service);
        expect(service.get(id)?.task.gate?.step).toBe("implement");
      }
      pulls.feedbackList = [item("comment:401")];
      await service.checkPullRequests();
      const task = service.get(id)?.task;
      expect(task?.status).toBe("escalated");
      expect(task?.escalation).toMatchObject({ reason: "too_many_changes", target: "implement" });
      expect(task?.escalation?.pendingRemarks).toEqual([
        { id: "implement-4-1", text: "全体として、失敗時のログが足りない" },
      ]);
      activity.close();
    });

    /** 設計まで戻す判断を記録したところで止まった作業履歴（反映の前にデーモンが止まった）。 */
    async function judgedThenStopped(pulls: FakePulls) {
      const made = await toImplementGate([], { pulls, now: later });
      const { activity, id } = made;
      activity.append({
        taskId: id,
        projectId: made.service.get(id)?.task.projectId ?? "default",
        events: [
          {
            actor: "person",
            event: {
              type: "PullRequestReviewImported",
              payload: {
                number: 7,
                items: [{ key: "comment:601", author: "reviewer", at }],
                remarks: ["観点が足りない"],
              },
            },
          },
          {
            actor: "guardian",
            event: {
              type: "ReworkJudged",
              payload: { target: "design", reason: "観点が足りない", agentId: "luna" },
            },
          },
        ],
      });
      return { activity, id, ...makeService(activity, [], { pulls, now: later }) };
    }

    it("判断を記録して止まったら、再起動の後に、もう一度判断せずに判断した工程に差し戻す（PBI-58）", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await judgedThenStopped(pulls);
      await service.checkPullRequests();
      expect(executor.calls).toHaveLength(0);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("queued");
      expect(task?.remarks.at(-1)).toMatchObject({ step: "design", text: "観点が足りない" });
      expect(task?.prRework).toMatchObject({ target: "design", decided: true });
      activity.close();
    });

    it("判断の後、反映の前に人間が別の工程へ差し戻したら、ゴールガーディアンの判断としては残さない（PBI-58）", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await judgedThenStopped(pulls);
      const sent = service.requestChanges(id, {
        step: "implement",
        submission: service.get(id)?.task.gate?.submission ?? 1,
        target: "implement",
        comments: ["観点が足りない"],
      });
      expect(sent.remarks.at(-1)).toMatchObject({ step: "implement", text: "観点が足りない" });
      expect(sent.prRework).toBeUndefined();
      // 反映済みなので、続きの確認でもう一度差し戻さない
      await service.checkPullRequests();
      expect(service.get(id)?.activity.filter((e) => e.type === "ChangesRequested").length).toBe(2);
      activity.close();
    });

    it("人間が戻し先を確かめていた作業履歴（rework_confirmation）も読み込み、確かめた戻し先で指摘を引き継ぐ（PBI-58 より前）", async () => {
      const pulls = new FakePulls();
      const made = await toImplementGate([], { pulls, now: later });
      const { activity, id } = made;
      const projectId = made.service.get(id)?.task.projectId ?? "default";
      // PBI-58 より前の版が記録した、戻し先の確認のエスカレーション
      activity.append({
        taskId: id,
        projectId,
        events: [
          {
            actor: "person",
            event: {
              type: "PullRequestReviewImported",
              payload: {
                number: 7,
                items: [{ key: "comment:501", author: "reviewer", at }],
                remarks: ["観点が足りない"],
              },
            },
          },
          {
            actor: "guardian",
            event: {
              type: "ReworkJudged",
              payload: { target: "design", reason: "観点が足りない", agentId: "luna" },
            },
          },
          {
            actor: "sacty",
            event: {
              type: "TaskEscalated",
              payload: {
                step: "implement",
                target: "design",
                reason: "rework_confirmation",
                note: "観点が足りない",
                pendingRemarks: [{ id: "design-1-1", text: "観点が足りない" }],
              },
            },
          },
        ],
      });
      // 再起動して、作業履歴から状態を復元する
      const { service } = makeService(activity, [], { pulls, now: later });
      const task = service.get(id)?.task;
      expect(task?.status).toBe("escalated");
      expect(task?.escalation).toMatchObject({
        reason: "rework_confirmation",
        target: "design",
        note: "観点が足りない",
      });
      expect(task?.pendingReview).toBeUndefined();
      expect(task?.importedFeedback).toEqual(["comment:501"]);
      // 確かめを待っている間は、PR の指摘を取り込まない
      pulls.feedbackList = [item("comment:501"), item("comment:502")];
      await service.checkPullRequests();
      expect(service.get(id)?.task.importedFeedback).toEqual(["comment:501"]);
      // 人間が要求要件まで戻すと確かめたら、取り込んだ指摘を引き継いで差し戻す
      const sent = service.requestChanges(id, {
        step: "implement",
        submission: task?.gate?.submission ?? 1,
        target: "requirements",
        comments: [],
      });
      expect(sent.status).toBe("queued");
      expect(sent.remarks.at(-1)).toMatchObject({ step: "requirements", text: "観点が足りない" });
      // 人間が選んだ戻し先なので、ゴールガーディアンの判断としては残さない
      expect(sent.prRework).toBeUndefined();
      activity.close();
    });
  });

  it("人が PR の中で直してからマージしても、承認としてタスクを完了にし、sacty が出したコミットと人が直したコミットを残す（PBI-63）", async () => {
    const pulls = new FakePulls();
    const { activity, service, executor, id } = await toImplementGate([], { pulls });
    const submitted = service.get(id)?.task.pullRequest?.commit;
    const runs = executor.calls.length;
    pulls.state = {
      state: "merged",
      mergedBy: "reviewer",
      headSha: "f".repeat(40),
      mergeCommit: "e".repeat(40),
    };
    await service.checkPullRequests();
    await service.checkPullRequests(); // 二重に記録しない
    const task = service.get(id)?.task;
    expect(task?.status).toBe("idle");
    expect(task?.steps.every((st) => st.state === "done")).toBe(true);
    expect(task?.pullRequestState).toBe("merged");
    expect(task?.pullRequestMerge).toMatchObject({
      by: "reviewer",
      submitted,
      commit: "f".repeat(40),
      mergeCommit: "e".repeat(40),
      edited: true,
    });
    const merged = service.get(id)?.activity.filter((e) => e.type === "PullRequestMerged");
    expect(merged?.map((e) => [e.actor, e.payload])).toEqual([
      [
        "person",
        {
          number: 7,
          by: "reviewer",
          commit: "f".repeat(40),
          outdated: false,
          submitted,
          mergeCommit: "e".repeat(40),
          edited: true,
        },
      ],
    ]);
    // 人がマージした＝人が承認したので、最終レビューはやり直さない
    expect(executor.calls).toHaveLength(runs);
    activity.close();
  });

  it("前の版で、違う内容でのマージとして止めた（merged_outdated）実装の PR も、再起動の後の次の確認で完了にする（PBI-63）", async () => {
    const pulls = new FakePulls();
    const { activity, service, id } = await toImplementGate([], { pulls });
    const before = service.get(id)?.task;
    // 前の版が記録した作業履歴（outdated: true）
    activity.append({
      taskId: id,
      projectId: before?.projectId ?? "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "PullRequestMerged",
            payload: { number: 7, by: "reviewer", commit: "f".repeat(40), outdated: true },
          },
        },
      ],
    });
    // 再起動して、作業履歴から状態を復元する（過去の作業履歴を読める）
    const { service: again } = makeService(activity, [], { pulls });
    expect(again.get(id)?.task.pullRequestState).toBe("merged_outdated");
    expect(again.get(id)?.task.status).toBe("awaiting_approval");
    pulls.state = { state: "merged", mergedBy: "reviewer", headSha: "f".repeat(40) };
    await again.checkPullRequests();
    const task = again.get(id)?.task;
    expect(task?.status).toBe("idle");
    expect(task?.steps.every((st) => st.state === "done")).toBe(true);
    expect(task?.pullRequestMerge).toMatchObject({ commit: "f".repeat(40), edited: true });
    const merged = again.get(id)?.activity.filter((e) => e.type === "PullRequestMerged") ?? [];
    expect(merged.map((e) => e.payload.outdated)).toEqual([true, false]);
    activity.close();
  });

  it("実装の承認待ちから設計へ差し戻すと、設計の承認を取り消し、見逃しも記録する", async () => {
    const { activity, service, id } = await toImplementGate();
    const sent = service.requestChanges(id, {
      step: "implement",
      submission: 1,
      target: "design",
      comments: ["観点が足りない"],
    });
    expect(sent.steps.map((st) => st.state)).toEqual(["done", "active", "todo"]);
    expect(sent.approved.design).toBeUndefined();
    expect(sent.approved.requirements).toBeDefined();
    expect(sent.misses).toHaveLength(1);
    activity.close();
  });

  it("最終レビューのゴールガーディアンには、実装後のコードを読み取り専用で渡す（PBI-16）", async () => {
    const { activity, service, executor, repos, id } = await toImplement([
      implement("# v1"),
      review(),
    ]);
    await drain(service);
    const index = executor.calls.length - 1; // 最終レビュー
    expect(promptOf(executor, index)).toContain("sacty-final-review");
    expect(promptOf(executor, index)).toContain("実装後のコード");
    expect(executor.scratch[index]).toBe(true);
    expect(executor.workspaceFiles[index]).toEqual(["IMPLEMENTED.md"]);
    // 実装の作業領域そのものではなく、写しを渡し、終わったら消す
    expect(repos.workingCopies.at(-1)?.dir).toBe(repos.prepared[0]?.dir);
    expect(executor.dirs[index]).not.toBe(repos.prepared[0]?.dir);
    expect(existsSync(executor.dirs[index] ?? "")).toBe(false);
    expect(service.get(id)?.task.lastReview?.passed).toBe(true);
    activity.close();
  });

  it("実装後のコードを写せなければ、最終レビューの失敗として止める（PBI-16）", async () => {
    const repos = new FakeRepos();
    repos.copyFail = "写せません";
    const { activity, service, executor, id } = await toImplement([implement("# v1")], { repos });
    await drain(service);
    const task = service.get(id)?.task;
    expect(task?.pausedReason).toBe("error");
    expect(ja(task?.pausedMessage)).toContain("写せません");
    // ゴールガーディアン（最終レビュー）は実行しない
    expect(executor.calls.map((_, i) => promptOf(executor, i)).join()).not.toContain(
      "sacty-final-review",
    );
    activity.close();
  });

  it("要求要件・設計は、起点のコミットのコードを実行ごとの使い捨ての写しで渡し、実装は clone を渡す（PBI-15・PBI-40）", async () => {
    const { activity, service, executor, repos, id } = await toImplement([implement("# v1")]);
    await service.runNext(id); // 実装
    // 対象リポジトリは、要求要件の工程の前に1回だけ用意する
    expect(repos.prepared).toHaveLength(1);
    const repoDir = repos.prepared[0]?.dir;
    // 要求要件（2回）と設計は、起点のコミットのコードの使い捨ての写しで、実装は clone で
    expect(executor.scratch).toEqual([true, true, true, false]);
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
    // 指示で、コードがあることと、使い捨ての写し（セットアップなどは実行できるが、変更は残らない）であること、
    // コードを変更しないことを伝える
    for (const index of [0, 2]) {
      expect(promptOf(executor, index)).toContain("起点のコミット（base123）のコードがあります");
      expect(promptOf(executor, index)).toContain("使い捨ての写しです");
      expect(promptOf(executor, index)).toContain("セットアップ");
      expect(promptOf(executor, index)).toContain("コードの変更（実装）はしないでください");
      expect(promptOf(executor, index)).not.toContain("読み取り専用");
    }
    activity.close();
  });

  it("実装の後に設計へ差し戻しても、実装の変更を含まない起点のコミットのコードを読む（PBI-15）", async () => {
    const { activity, service, executor, repos, id } = await toImplementGate([design]);
    const repoDir = repos.prepared[0]?.dir ?? "";
    // 実装で作業領域が変わっている
    writeFileSync(join(repoDir, "changed-by-implement.ts"), "x");
    service.requestChanges(id, {
      step: "implement",
      submission: 1,
      target: "design",
      comments: ["観点"],
    });
    const before = executor.calls.length;
    await service.runNext(id); // 設計のやり直し
    expect(executor.scratch[before]).toBe(true);
    expect(executor.dirs[before]).not.toBe(repoDir);
    expect(executor.workspaceFiles[before]).toEqual(["README.md"]);
    expect(repos.snapshots.at(-1)?.baseCommit).toBe("base123");
    activity.close();
  });

  it("どの工程から始まるタスクでも、タスクの開始時に対象リポジトリを用意する（PBI-15）", async () => {
    // 今後のタスク種別のように、要求要件から始まらないタスク（実装から始まる）
    const activity = new SqliteActivityStore(dbPath);
    activity.append({
      taskId: "t-impl",
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: {
              title: "実装だけ",
              body: "",
              start: "sacty",
              repo: "https://github.com/acme/app",
              budgetCapUsd: 1,
            },
          },
        },
        { actor: "sacty", event: { type: "StepsChosen", payload: { steps: ["implement"] } } },
      ],
    });
    const { service, executor, repos } = makeService(activity, [implement("# v1")]);
    await service.runNext("t-impl");
    const types = service.get("t-impl")?.activity.map((e) => e.type) ?? [];
    expect(types.indexOf("RepositoryPrepared")).toBeLessThan(types.indexOf("AgentRunStarted"));
    expect(repos.prepared).toHaveLength(1);
    // 実装の工程は clone を書き込みできる形で使う
    expect(executor.dirs[0]).toBe(repos.prepared[0]?.dir);
    expect(executor.scratch).toEqual([false]);
    activity.close();
  });

  it("対象リポジトリを選ぶ前の版で clone 済みのタスクは、記録した URL のリポジトリに、PR を作るまで続ける（PBI-21 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    activity.append({
      taskId: "t-old",
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: { title: "古いタスク", body: "", start: "ticket", budgetCapUsd: 1 },
          },
        },
        {
          actor: "sacty",
          event: {
            type: "StepsChosen",
            payload: { steps: ["implement"], testCommand: "npm test" },
          },
        },
        {
          actor: "sacty",
          event: {
            type: "RepositoryPrepared",
            payload: {
              url: "git@github.com:acme/app.git",
              baseBranch: "main",
              baseCommit: "base123",
            },
          },
        },
      ],
    });
    const tests = new FakeTests();
    const pulls = new FakePulls();
    const { service } = makeService(
      activity,
      [
        implement("# v1", [{ viewpointId: "REQ", tests: ["a.test.ts › 受け入れ条件"] }]),
        review([["REQ", true]], []),
      ],
      { tests, pulls },
    );
    for (let i = 0; i < 4 && service.queuedTaskIds().includes("t-old"); i++) {
      await service.runNext("t-old");
    }
    const task = service.get("t-old")?.task;
    // オーケストレーターが決めたテストのコマンドで検証し、記録した URL のリポジトリ（acme/app）に PR を作る
    expect(tests.calls.map((c) => c.command)).toEqual(["npm test"]);
    expect(pulls.calls[0]?.repo).toBe("https://github.com/acme/app");
    expect(task?.gate).toEqual({ step: "implement", submission: 1 });
    expect(task?.pausedMessage).toBeUndefined();
    activity.close();
  });

  it("作業領域が消えて用意し直すときも、ブランチの最新ではなく記録済みの起点のコミットを使う（PBI-15 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const repos = new FakeRepos();
    const { service } = makeService(activity, [out("# 要求要件"), design, out("# 要求要件")], {
      repos,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    // 作業領域が消え、その間にベースブランチが進んだ
    rmSync(repos.prepared[0]?.dir ?? "", { recursive: true, force: true });
    repos.head = "newbase456";
    await service.runNext(id); // 設計
    expect(repos.prepared.map((p) => p.recorded)).toEqual([undefined, "base123"]);
    expect(repos.snapshots.map((x) => x.baseCommit)).toEqual(["base123", "base123"]);
    expect(service.get(id)?.task.repository?.baseCommit).toBe("base123");
    const prepared = service.get(id)?.activity.filter((e) => e.type === "RepositoryPrepared");
    expect(prepared).toHaveLength(1);

    // 記録済みの起点を取得できなければ、起点を変えずに止める
    const other = makeService(new SqliteActivityStore(join(dir, "other.db")), [out("# 要求要件")], {
      repos: Object.assign(new FakeRepos(), { recordedMissing: true }),
    });
    const t = other.service.createTask({ projectId: "default", title: "B" });
    await other.service.runNext(t.id);
    other.service.approve(t.id, { step: "requirements", submission: 1 });
    rmSync(other.repos.prepared[0]?.dir ?? "", { recursive: true, force: true });
    await other.service.runNext(t.id);
    expect(other.executor.calls).toHaveLength(1); // 設計のエージェントは実行しない
    expect(other.service.get(t.id)?.task.repository?.baseCommit).toBe("base123");
    expect(other.service.get(t.id)?.task.pausedReason).toBe("error");
    activity.close();
  });

  it("起点のコードを書き出せなければ、エージェントを実行せずに理由を記録して止める（PBI-15）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const repos = new FakeRepos();
    repos.snapshotFail = "git read-tree に失敗しました";
    const { service, executor } = makeService(activity, [out("# 要求要件")], { repos });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.pausedReason).toBe("error");
    const failed = service.get(id)?.activity.findLast((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && failed.payload.message).toContain("read-tree");
    activity.close();
  });

  it("プッシュやPRの作成に失敗したら理由を記録して止め、トークンは残さない", async () => {
    const pulls = new FakePulls();
    pulls.fail = "PRを作れませんでした：GitHub API 401 Bad credentials ghp_secret";
    const { activity, service, repos, id } = await toImplementGate([], { pulls });
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
    expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
    // プッシュの後で失敗して再開しても、同じ親・同じ日時でコミットを作り直す（同じコミットになる）
    const [first, retried] = repos.published;
    expect(retried).toEqual(first);
    activity.close();
  });

  it("実行待ちのタスクを人間が一時停止し、再開すると実行し直す（PBI-3）", async () => {
    const { activity, service, id } = await toImplement([implement("# v1"), review()]);
    const paused = await service.pause(id);
    expect(paused).toMatchObject({ status: "paused", pausedReason: "manual" });
    expect(service.queuedTaskIds()).toEqual([]);
    await expect(service.pause(id)).rejects.toThrow(/すでに一時停止/);
    expect(service.resume(id, {}).status).toBe("queued");
    await drain(service);
    expect(service.get(id)?.task.gate?.step).toBe("implement");
    activity.close();
  });

  it("実行中なら、コンテナを止めて中断を記録し、作業領域を残して一時停止する（PBI-3）", async () => {
    const { activity, service, executor, id } = await toImplement([
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
    expect(service.get(id)?.task.gate?.step).toBe("implement");
    activity.close();
  });

  it("テストの実行中に止めたら、結果を記録せず、再開するとテストからやり直す（PBI-3）", async () => {
    const tests = new FakeTests();
    tests.hold = true;
    const { activity, service, id } = await toImplement([implement("# v1"), review()], { tests });
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
    expect(service.get(id)?.task.gate?.step).toBe("implement");
    activity.close();
  });

  it("人間の判断待ち・中止済みのタスクは一時停止しない（PBI-3）", async () => {
    const { activity, service, id } = await toImplementGate();
    await expect(service.pause(id)).rejects.toThrow(/人間の判断待ち/);
    activity.close();
  });

  it("中止すると、PRを閉じ・sacty のブランチを消し・作業領域を消して記録し、作業履歴は残す（PBI-3）", async () => {
    const { activity, service, repos, pulls, id } = await toImplementGate();
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
    expect(pulls.closed).toEqual([
      { repo: "https://github.com/acme/app", token: "ghp_secret", number: 7 },
    ]);
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
    // 作業履歴は残り、中止したタスクへの操作は受け付けない
    expect(service.get(id)?.activity.at(-1)?.type).toBe("TaskCancelled");
    expect(service.get(id)?.activity.length).toBeGreaterThan(10);
    expect(() => service.approve(id, { step: "implement", submission: 1 })).toThrow();
    expect(() => service.resume(id, {})).toThrow();
    await expect(service.pause(id)).rejects.toThrow(/中止したタスク/);
    await expect(service.cancel(id)).rejects.toThrow(/すでに中止/);
    expect(service.queuedTaskIds()).toEqual([]);
    activity.close();
  });

  it("実行中に中止すると、コンテナを止めてから片付け、失敗した片付けも記録して続ける（PBI-3）", async () => {
    const pulls = new FakePulls();
    const repos = new FakeRepos();
    const { activity, service, executor, id } = await toImplementGate([HOLD], { pulls, repos });
    // 実装の承認待ちから実装へ差し戻し、実装の実行中に中止する
    service.requestChanges(id, { step: "implement", submission: 1, comments: ["直して"] });
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
    activity.close();
  });

  it("中止したタスクへの操作は拒否し、作業履歴に書かない（再起動できる。レビュー指摘）", async () => {
    const { activity, service, id } = await toImplementGate();
    service.requestChanges(id, { step: "implement", submission: 1, comments: ["直して"] });
    await service.cancel(id);
    const before = service.get(id)?.activity.length;
    expect(() => service.voidRemark(id, "implement-1-1")).toThrow(/中止したタスク/);
    expect(service.get(id)?.activity.length).toBe(before);
    // 再起動しても作業履歴から状態を復元できる
    const { service: restarted } = makeService(activity);
    expect(restarted.get(id)?.task.status).toBe("cancelled");
    activity.close();
  });

  it("状態の復元で受け付けられないイベントは、作業履歴に書く前に拒否する（レビュー指摘）", async () => {
    const { activity, service, id } = await toImplement([]);
    const before = service.get(id)?.activity.length;
    // 内部の操作の誤りで、受け付けられないイベントを書こうとした場合も作業履歴を汚さない
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
    expect(service.get(id)?.activity.length).toBe(before);
    activity.close();
  });

  it("中止で閉じるPRは、作ったときに記録したリポジトリのものだけ（レビュー指摘）", async () => {
    const pulls = new FakePulls();
    const projects = projectsWithAccount();
    const { activity, service, id } = await toImplementGate([], { pulls, projects });
    expect(service.get(id)?.task.pullRequest?.repo).toBe("https://github.com/acme/app");
    // プロジェクトのリポジトリの設定を変えてから中止した
    const project = projects.get("default");
    if (!project) throw new Error("unreachable");
    projects.put("default", {
      ...project,
    });
    await service.cancel(id);
    expect(pulls.closed).toEqual([
      { repo: "https://github.com/acme/app", token: "ghp_secret", number: 7 },
    ]);
    activity.close();
  });

  it("準備の間に一時停止したら、新しいコンテナを起動しない（レビュー指摘）", async () => {
    // 対象リポジトリは、要求要件の工程の前に用意する（PBI-15）
    const activity = new SqliteActivityStore(dbPath);
    const repos = new FakeRepos();
    const gate = Promise.withResolvers<void>();
    repos.prepareGate = gate.promise;
    const { service, executor } = makeService(activity, [out("# 要求要件")], { repos });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    const callsBefore = executor.calls.length;
    const running = service.runNext(id);
    await repos.prepareStarted.promise;
    const pausing = service.pause(id);
    gate.resolve();
    await Promise.all([running, pausing]);
    expect(executor.calls.length).toBe(callsBefore); // 要求要件のコンテナは起動していない
    expect(service.get(id)?.task).toMatchObject({ status: "paused", pausedReason: "manual" });
    activity.close();
  });

  it("PRの作成に失敗しても、プッシュ済みのブランチは中止で消す（レビュー指摘）", async () => {
    const pulls = new FakePulls();
    pulls.fail = "PRを作れませんでした：GitHub API 422";
    const repos = new FakeRepos();
    const { activity, service, id } = await toImplementGate([], { pulls, repos });
    expect(service.get(id)?.task.pullRequest).toBeUndefined();
    expect(service.get(id)?.task.pushedBranch?.branch).toBe(`sacty/task-${id.slice(0, 8)}`);
    expect(service.cleanupPlan(id)?.find((p) => p.target === "branch")?.present).toBe(true);
    await service.cancel(id);
    expect(repos.deleted).toEqual([`sacty/task-${id.slice(0, 8)}`]);
    activity.close();
  });

  it("止めたコンテナの停止を確かめられなければ、一時停止に記録して、再開や中止で確かめ直す（レビュー指摘）", async () => {
    const { activity, service, executor, id } = await toImplement([HOLD]);
    executor.stops = false;
    const running = service.runNext(id);
    const runId = await executor.started.promise;
    await service.pause(id);
    await running;
    const paused = service.get(id)?.task;
    expect(paused).toMatchObject({ pausedReason: "manual", unstoppedRuns: [runId] });
    expect(ja(paused?.pausedMessage)).toMatch(/停止を確認できませんでした/);

    // 再起動しても、作業履歴から追える
    const { service: restarted, executor: restartedExecutor } = makeService(activity);
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
    activity.close();
  });

  it("止まったことを確かめられたら、再開できる（レビュー指摘）", async () => {
    const { activity, service, executor, id } = await toImplement([
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
    activity.close();
  });

  it("一時停止は、停止の確認と記録が終わってから返る（レビュー指摘）", async () => {
    const tests = new FakeTests();
    tests.hold = true;
    const { activity, service, executor, id } = await toImplement([implement("# v1")], { tests });
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
    activity.close();
  });

  it("デーモンを再起動しても、テストの実行待ちから検証を続ける", async () => {
    const { activity, service, id } = await toImplement([implement("# v1")]);
    await service.runNext(id);
    const { service: restarted } = makeService(activity, [review()]);
    restarted.recoverInterrupted();
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    // 検証に通ったら、実装の工程のまま PR の作成を待つ。もう一度再起動しても、実装をやり直さずに PR を作る（PBI-110）
    expect(restarted.get(id)?.task.publishPending).toBe(true);
    const { service: again } = makeService(activity, []);
    again.recoverInterrupted();
    expect(again.queuedTaskIds()).toEqual([id]);
    await again.runNext(id);
    expect(again.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
    expect(again.get(id)?.task.pullRequest?.number).toBeDefined();
    activity.close();
  });
  describe("チケットへの結果のコメント（PBI-52）", () => {
    const ticketProjects = () => {
      const projects = new MemoryProjectStore();
      projects.put("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
        tickets: [{ platform: "jira", service: "jira-server", keys: ["PAY"] }],
      });
      return projects;
    };
    const chooseApp = triageOut({
      repo: "https://github.com/acme/app",
      title: "PAY-1 決済の再送",
      summary: "再送で二重に請求される",
      reason: "決済のコードがある",
    });
    const options = (tickets: FakeTickets, extra: Parameters<typeof makeService>[2] = {}) => ({
      config: configOf(agent(), 1, [jiraPlatform()]),
      secrets: { "claude-oauth-token": "oauth-secret", "jira-token": "jira-secret" },
      gateway: fakeGateway(),
      projects: ticketProjects(),
      settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
      tickets,
      ...extra,
    });

    it("調査の結果をチケットにコメントし、二度は返さない。返せなければ理由を記録する", async () => {
      for (const fail of [false, true]) {
        const activity = new SqliteActivityStore(join(dir, `ticket-${fail}.db`));
        const tickets = new FakeTickets();
        if (fail) tickets.commentFail = "boom";
        const { service, pulls } = makeService(
          activity,
          [chooseApp, out("# 調査の結果\n\n- src/pay.ts:12 で再送")],
          options(tickets, {
            planner: async () => ({
              steps: ["investigate" as const],
              plan: "investigate" as const,
              reason: "調査だけ",
              fallback: false,
              costUsd: 0,
              estimated: false,
            }),
          }),
        );
        const [task] = service.importTickets([foundTicket("PAY-1")]);
        const id = task?.id ?? "";
        await service.runNext(id); // チケットを読む
        await service.runNext(id); // 調査
        service.approve(id, { step: "investigate", submission: 1 });
        await service.runNext(id);
        await service.runNext(id); // 二度は返さない
        expect(pulls.issueComments).toEqual([]);
        if (fail) {
          expect(tickets.comments).toEqual([]);
          expect(ja(service.get(id)?.task.issueComment?.failed)).toContain("boom");
        } else {
          expect(tickets.comments).toHaveLength(1);
          expect(tickets.comments[0]).toMatchObject({
            platform: "jira",
            service: "jira-server",
            key: "PAY-1",
          });
          expect(tickets.comments[0]?.body).toContain("src/pay.ts:12 で再送");
          // GitHub の目印（HTML のコメント）は JIRA では文字のまま出るので付けない
          expect(tickets.comments[0]?.body).not.toContain("<!--");
          expect(service.get(id)?.task.issueComment).toEqual({
            url: "https://jira.example.com/browse/PAY-1?focusedCommentId=1",
          });
        }
        expect(service.queuedTaskIds()).toEqual([]);
        activity.close();
      }
    });

    it("PR を作ったら、PR の URL をチケットに1回だけコメントする", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const tickets = new FakeTickets();
      const { service, pulls } = makeService(
        activity,
        [chooseApp, out("# 要求要件"), design, implement("# 実装の説明"), review(undefined, [])],
        options(tickets),
      );
      const [task] = service.importTickets([foundTicket("PAY-1")]);
      const id = task?.id ?? "";
      await service.runNext(id); // チケットを読む
      await service.runNext(id); // 要求要件
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      service.approve(id, { step: "design", submission: 1 });
      await drain(service);
      await drain(service);
      expect(pulls.calls).toHaveLength(1);
      expect(pulls.calls[0]?.title).toBe("PAY-1 決済の再送");
      expect(tickets.comments).toHaveLength(1);
      expect(tickets.comments[0]?.body).toContain(
        "sacty が PR を作りました：https://github.com/acme/app/pull/7",
      );
      expect(service.get(id)?.task.ticketPrComment).toEqual({
        url: "https://jira.example.com/browse/PAY-1?focusedCommentId=1",
      });
      expect(service.queuedTaskIds()).toEqual([]);
      activity.close();
    });
  });
});

describe("プロジェクトの対象と、オーケストレーターが決めるベースブランチ・テストのコマンド（PBI-25）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const plan = (value: string, extra: Record<string, string> = {}) =>
    out(block({ "sacty-steps": { plan: value, reason: "理由", ...extra } }));
  /** 対象：リポジトリ acme/app と Org tools（tools/secret は、ほかのプロジェクトが担当）。 */
  const targets = () => {
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: "https://github.com/acme/app" },
        { scope: "org", target: "https://github.com/tools" },
      ],
      githubAccounts: { "github.com": "me" },
    });
    projects.put("other", {
      name: "ほか",
      targets: [{ scope: "repo", target: "https://github.com/tools/secret" }],
      githubAccounts: { "github.com": "me" },
    });
    return projects;
  };

  it("対象の中から選んだリポジトリで、ブランチを指定せずに既定のブランチを clone する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, repos } = makeService(activity, [out("# 要求要件")], { projects: targets() });
    // リポジトリの対象は、登録した名前にそろえる
    expect(
      service.createTask({ projectId: "default", title: "A", repo: "https://github.com/ACME/APP" })
        .repo,
    ).toBe("https://github.com/acme/app");
    // Org の対象の中のリポジトリも選べる
    const task = service.createTask({
      projectId: "default",
      title: "B",
      repo: "https://github.com/tools/cli",
    });
    expect(task.repo).toBe("https://github.com/tools/cli");
    await service.runNext(task.id);
    expect(repos.prepared[0]?.url).toBe("https://github.com/tools/cli.git");
    expect(repos.prepared[0]?.baseBranch).toBeUndefined();
    expect(service.get(task.id)?.task.repository).toMatchObject({
      baseBranch: "main",
      baseCommit: "base123",
    });
    activity.close();
  });

  it("GitHub Enterprise Server のリポジトリは、そのホストの、そのホストのアカウントのトークンで clone する（PBI-40）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const github = new FakeGitHub({ me: "ghp_secret", "ghe.example.co.jp/corp": "ghp_corp" });
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": { "rules.md": "# 規約" },
    });
    const { service, repos } = makeService(activity, [out("# 要求要件")], { github, contexts });
    // 1つのプロジェクトで、GHE の対象と、github.com のコンテキストリポジトリを使う
    const project = service.saveProject(undefined, {
      name: "GHE",
      targets: [{ scope: "repo", target: "https://ghe.example.co.jp/acme/app" }],
      githubAccounts: { "ghe.example.co.jp": "corp", "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const task = service.createTask({ projectId: project.id, title: "A" });
    expect(task.repo).toBe("https://ghe.example.co.jp/acme/app");
    await service.runNext(task.id);
    const header = (token: string) =>
      `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`;
    expect(repos.prepared[0]).toMatchObject({
      url: "https://ghe.example.co.jp/acme/app.git",
      authEnv: {
        GIT_CONFIG_KEY_0: "http.https://ghe.example.co.jp/.extraheader",
        GIT_CONFIG_VALUE_0: header("ghp_corp"),
      },
    });
    expect(contexts.fetched[0]?.authEnv).toMatchObject({
      GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
      GIT_CONFIG_VALUE_0: header("ghp_secret"),
    });
    activity.close();
  });

  // 選んでいない（対象が複数）ときは、リポジトリを指定しないタスクとして作る（PBI-73。別の describe で確かめる）
  it("対象の外・ほかのプロジェクトが担当するリポジトリは作らない", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: targets() });
    for (const repo of [
      "https://github.com/tools/secret",
      "https://github.com/other/app",
      "not a repo",
    ]) {
      expect(() =>
        service.createTask({ projectId: "default", title: "A", ...(repo ? { repo } : {}) }),
      ).toThrow(/対象リポジトリを、プロジェクト/);
    }
    expect(service.list()).toEqual([]);
    activity.close();
  });

  it("対象のリポジトリの候補は、リポジトリの対象と、gh で読んだ Org のリポジトリ（ほかのプロジェクトの担当を除く）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.ownerRepos = {
      "https://github.com/tools": [
        "https://github.com/tools/cli",
        "https://github.com/tools/secret",
        "https://github.com/tools/web",
      ],
    };
    const { service } = makeService(activity, [], { projects: targets(), pulls });
    expect(await service.projectRepositories("default")).toEqual({
      repositories: [
        "https://github.com/acme/app",
        "https://github.com/tools/cli",
        "https://github.com/tools/web",
      ],
      errors: [],
    });
    expect(pulls.repositoryRequests).toEqual([
      { org: "https://github.com/tools", token: "ghp_secret" },
    ]);
    // 読めなかった Org は、トークンを伏せた理由を返す（読めたものは返す）
    pulls.repositoriesFail = "404 Not Found ghp_secret";
    const failed = await service.projectRepositories("default");
    expect(failed?.repositories).toEqual(["https://github.com/acme/app"]);
    expect(failed?.errors[0]?.org).toBe("https://github.com/tools");
    expect(JSON.stringify(failed?.errors)).not.toContain("ghp_secret");
    expect(await service.projectRepositories("no-such")).toBeUndefined();
    activity.close();
  });

  it("オーケストレーターが既定と違うベースブランチを選べば、その最新で用意し直して記録し、用意できなければ既定のブランチで進める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const repos = new FakeRepos();
    repos.branchHeads = { develop: "dev456" };
    repos.missingBranches = ["nope"];
    const { service } = makeService(
      activity,
      [
        plan("skip-design", { baseBranch: "develop", testCommand: "make test" }),
        out("# 要求要件"),
        plan("skip-design", { baseBranch: "nope", testCommand: "make test" }),
        out("# 要求要件"),
      ],
      { repos, realPlanner: true },
    );
    const a = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(a.id);
    const task = service.get(a.id)?.task;
    expect(task?.repository).toMatchObject({ baseBranch: "develop", baseCommit: "dev456" });
    expect(task?.testCommand).toBe("make test");
    expect(repos.prepared.map((p) => p.baseBranch)).toEqual([undefined, "develop"]);
    expect(service.get(a.id)?.activity.filter((e) => e.type === "RepositoryPrepared")).toHaveLength(
      2,
    );
    // 先頭の前段の調査を終え、承認なしに要求要件へ進んでいる（PBI-29）
    expect(task?.steps.find((st) => st.state === "active")?.key).toBe("requirements");

    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(b.id);
    expect(service.get(b.id)?.task.repository?.baseBranch).toBe("main");
    expect(service.get(b.id)?.task.stepsChoice?.reason).toMatchObject({
      code: "orchestrator.baseBranchUnavailable",
      params: { branch: "nope" },
    });
    expect(service.get(b.id)?.task.steps.find((st) => st.state === "active")?.key).toBe(
      "requirements",
    );
    activity.close();
  });

  it("テストのコマンドが分からなければ、実装を含むタスクは費用をかける前に止め、調査だけのタスクは止めない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [plan("standard"), plan("investigate"), out("# 調査の結果")],
      { realPlanner: true },
    );
    const a = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(a.id);
    expect(service.get(a.id)?.task.status).toBe("paused");
    expect(service.get(a.id)?.task.pausedMessage).toEqual({
      code: "orchestrator.testCommandUnknown",
    });
    expect(executor.calls).toHaveLength(1);
    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(b.id);
    expect(service.get(b.id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    activity.close();
  });

  it("対象リポジトリを選ぶ前の版で作ったタスクは、理由を記録して止まる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    activity.append({
      taskId: "t-old",
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: { title: "古いタスク", body: "", start: "ticket", budgetCapUsd: 1 },
          },
        },
      ],
    });
    const { service, repos, executor } = makeService(activity, [out("# 要求要件")]);
    await service.runNext("t-old");
    const task = service.get("t-old")?.task;
    expect(task?.status).toBe("paused");
    expect(task?.pausedMessage).toEqual({ code: "run.repositoryNotConfigured" });
    expect(repos.prepared).toEqual([]);
    expect(executor.calls).toHaveLength(0);
    activity.close();
  });
});

describe("起動時に秘密情報をまとめて取り出す（PBI-48）", () => {
  /** まとめて取り出せる取り出し口の偽物。取り出せるものを持ち、呼ばれた参照を記録する。 */
  class PrefetchStore extends MemorySecretStore {
    prefetched: { refs: string[]; fresh?: boolean }[] = [];
    constructor(private readonly available: Record<string, string>) {
      super(available);
    }
    async prefetch(refs: readonly string[], options: { fresh?: boolean } = {}) {
      this.prefetched.push({ refs: [...refs], ...(options.fresh ? { fresh: true } : {}) });
      return refs
        .filter((ref) => !(ref in this.available))
        .map((ref) => ({ ref, error: new SecretNotFoundError(ref) }));
    }
  }

  it("使う参照をまとめて取り出し、取り出せなかったものを画面の警告に出す（値は出さない）。取り出し直すと消える", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const store = new PrefetchStore({});
    const { service } = makeService(activity, [], { secretStore: store });
    const first = await service.prefetchSecrets();
    // 既定のエージェントの Claude Code のトークン
    expect(store.prefetched).toEqual([{ refs: ["claude-oauth-token"] }]);
    expect(first.total).toBe(1);
    expect(service.status().warnings.map((w) => ja(w))).toEqual([
      expect.stringContaining(
        "起動のときに、秘密情報（agents.claude-subscription.auth.secret）を取り出せませんでした",
      ),
    ]);
    (store as unknown as { available: Record<string, string> }).available["claude-oauth-token"] =
      "oauth-secret";
    const again = await service.prefetchSecrets({ fresh: true });
    expect(store.prefetched.at(-1)).toEqual({ refs: ["claude-oauth-token"], fresh: true });
    expect(again.problems).toEqual([]);
    expect(service.status().warnings).toEqual([]);
    expect(JSON.stringify(service.status())).not.toContain("oauth-secret");
    activity.close();
  });

  it("まとめて取り出せない取り出し口や、設定に誤りがあるときは、何もしない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, []);
    expect(await service.prefetchSecrets()).toEqual({
      total: 0,
      fetched: 0,
      unreadContexts: 0,
      problems: [],
    });
    const broken = makeService(activity, [], {
      secretStore: new PrefetchStore({}),
      config: () => ({ ok: false, problem: message("config.missing", { path: "x" }) }),
    });
    expect(await broken.service.prefetchSecrets()).toEqual({
      total: 0,
      fetched: 0,
      unreadContexts: 0,
      problems: [],
    });
    activity.close();
  });
});

describe("プロジェクトのコンテキストの秘密情報も、まとめて取り出す（PBI-107）", () => {
  const baseRepo = "https://git.example.com/base-ctx.git";
  const teamRepo = "https://git.example.com/team-ctx.git";
  /** 1Password にある値（偽物）。 */
  const values: Record<string, string> = {
    "op://Work/Claude/token": "oauth-from-op",
    "op://Work/Docs/key": "docs-from-op",
    "op://Work/Wiki/token": "wiki-from-op",
    "op://Work/Search/key": "search-from-op",
    "op://Work/New/key": "new-from-op",
  };
  /** 偽の op。呼ばれた子プロセスと、取り出した参照を記録する（承認の回数を数える）。 */
  const fakeOp = () => {
    const calls: { command: string; refs: string[] }[] = [];
    /** これがあれば、op run は、これが終わるまで承認を待つ。 */
    const approval: { wait?: Promise<void> } = {};
    const run: OpRunner = async (args) => {
      if (args[0] === "run") {
        const file = args[args.indexOf("--env-file") + 1] ?? "";
        const refs = readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => line.replace(/^[^=]+="(.*)"$/, "$1"));
        calls.push({ command: "run", refs });
        await approval.wait;
        if (refs.some((ref) => !(ref in values))) {
          return { code: 1, stdout: "", stderr: "[ERROR] could not resolve a reference" };
        }
        return { code: 0, stdout: JSON.stringify(refs.map((ref) => values[ref])), stderr: "" };
      }
      const ref = args.at(-1) ?? "";
      calls.push({ command: "read", refs: [ref] });
      const value = values[ref];
      return value
        ? { code: 0, stdout: value, stderr: "" }
        : { code: 1, stdout: "", stderr: "[ERROR] 2026/10/15 00:00:00 item not found" };
    };
    return { calls, run, approval };
  };
  /** 継承の鎖（team → base）。base に PF、team に MCP サーバーを書く。 */
  const contextFiles = (): Record<string, Record<string, string>> => ({
    [baseRepo]: {
      "platforms.yaml": [
        "platforms:",
        "  docs:",
        "    upstream: https://docs.internal.example.com",
        "    description: チームのドキュメント",
        "    auth:",
        "      prefix: 'Bearer '",
        "      secret: op://Work/Docs/key",
        "    allow: [GET /api/pages/**]",
      ].join("\n"),
    },
    [teamRepo]: {
      "sacty-context.yaml": `extends: ${baseRepo}`,
      "mcp.yaml": [
        "servers:",
        "  wiki:",
        "    command: wiki-mcp",
        "    via_gateway: false",
        "    env:",
        "      TOKEN: { secret: op://Work/Wiki/token }",
        "  search:",
        "    url: https://search.example.com/mcp",
        "    headers:",
        "      Authorization: { secret: op://Work/Search/key, prefix: 'Bearer ' }",
      ].join("\n"),
    },
  });
  /** ゲートウェイの偽物。登録された PF の認証の値を、ゲートウェイと同じ取り出し口で用意する（PF の呼び出し）。 */
  const gatewayOf = (credentials: PlatformCredentials) => {
    const calls: Promise<string>[] = [];
    const mcp: Record<string, unknown>[] = [];
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      containerOrigin: () => "http://host.docker.internal:5001",
      platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
      register: (_route, contextMcp, platforms) => {
        mcp.push(contextMcp ?? {});
        for (const platform of platforms ?? []) calls.push(credentials.header(platform));
        return {
          token: "sacty-gw-run",
          stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
          close: () => {},
        };
      },
    };
    return { gateway, calls, mcp };
  };
  const setup = (
    outcomes: AgentOutcome[] = [],
    options: {
      contexts?: ContextFetcher;
      projects?: MemoryProjectStore;
      timeoutMs?: number;
      run?: OpRunner;
    } = {},
  ) => {
    const activity = new SqliteActivityStore(dbPath);
    const op = fakeOp();
    const store = new ResolvingSecretStore(
      new MemorySecretStore({}),
      new OnePasswordSecretStore({ run: options.run ?? op.run }),
    );
    const credentials = new PlatformCredentials({ secrets: store });
    const pf = gatewayOf(credentials);
    const contexts = options.contexts ?? new FakeContexts(contextFiles());
    const projects = options.projects ?? new MemoryProjectStore();
    if (!options.projects) {
      projects.put("a", {
        name: "A",
        targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
        githubAccounts: { "github.com": "me" },
        context: { repo: teamRepo },
        tickets: [{ platform: "docs", service: "jira-server", keys: ["DOC"] }],
      });
    }
    const made = makeService(activity, outcomes, {
      config: configOf(agent({ auth: { mode: "subscription", secret: "op://Work/Claude/token" } })),
      secretStore: store,
      gateway: pf.gateway,
      projects,
      contexts,
      settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
      tickets: new FakeTickets(),
    });
    if (options.timeoutMs !== undefined) {
      (made.service as unknown as { deps: ServiceDeps }).deps.contextSecretsTimeoutMs =
        options.timeoutMs;
    }
    return { activity, op, store, pf, contexts, projects, ...made };
  };
  const allRefs = [
    "op://Work/Claude/token",
    "op://Work/Docs/key",
    "op://Work/Wiki/token",
    "op://Work/Search/key",
  ];

  it("起動のときに、継承の鎖の上の層も含めたコンテキストの秘密情報を、ほかと一緒に1回の op run で取り出し、トリアージ・工程の実行・PF の呼び出しでは 1Password に問い合わせない", async () => {
    const { activity, op, pf, service, executor } = setup([
      triageOut({
        repo: "https://github.com/acme/a",
        title: "DOC-1 ページを直す",
        summary: "## 目的\nページを直す",
        reason: "対象は a だけ",
      }),
      completed(20_000),
    ]);
    const started = await service.prefetchSecrets();
    expect(started).toEqual({ total: 4, fetched: 4, unreadContexts: 0, problems: [] });
    expect(op.calls).toEqual([{ command: "run", refs: allRefs }]);
    // チケットのトリアージ（コンテキストの PF を、ゲートウェイで呼ぶ）
    const [ticketTask] = service.importTickets([
      { ...foundTicket("DOC-1"), platform: "docs", url: "https://docs.internal.example.com/DOC-1" },
    ]);
    await service.runNext(ticketTask?.id ?? "");
    expect(service.get(ticketTask?.id ?? "")?.task.repo).toBe("https://github.com/acme/a");
    // タスクの作成と工程の実行（コンテナの中の MCP の env・ゲートウェイ経由の MCP のヘッダー・PF）
    const task = service.createTask({ projectId: "a", title: "ドキュメントを直す" });
    await service.runNext(task.id);
    expect(executor.calls[1]?.env).toEqual(
      expect.objectContaining({ SACTY_MCP_SECRET_0: "wiki-from-op" }),
    );
    expect(pf.mcp.at(-1)).toEqual({
      search: {
        url: "https://search.example.com/mcp",
        headers: { Authorization: "Bearer search-from-op" },
      },
    });
    expect(await Promise.all(pf.calls)).toEqual(["Bearer docs-from-op", "Bearer docs-from-op"]);
    // 承認は起動のときの1回だけ（その後は op を呼ばない）
    expect(op.calls).toHaveLength(1);
    expect(service.status().warnings).toEqual([]);
    // 秘密の値は、画面（状態）・台帳に出さない
    const shown = JSON.stringify([
      service.status(),
      service.get(task.id)?.activity,
      service.get(ticketTask?.id ?? "")?.activity,
    ]);
    for (const value of Object.values(values)) expect(shown).not.toContain(value);
    activity.close();
  });

  it("コンテキストを取得できなくても止めずに理由を警告に出し、ほかの秘密情報は取り出す。使うときには、その場で取り出す（最後の手段）", async () => {
    let failOnce = true;
    const files = new FakeContexts(contextFiles());
    const contexts: ContextFetcher = {
      fetch: async (ref, out, authEnv) => {
        if (failOnce)
          throw new Error("fatal: unable to access 'https://git.example.com/': timeout");
        return files.fetch(ref, out, authEnv);
      },
    };
    const { activity, op, service, executor } = setup([completed(20_000)], { contexts });
    const started = await service.prefetchSecrets();
    expect(started.total).toBe(1);
    expect(started.fetched).toBe(1);
    expect(started.unreadContexts).toBe(1);
    expect(op.calls).toEqual([{ command: "run", refs: ["op://Work/Claude/token"] }]);
    expect(service.status().warnings.map((w) => ja(w))).toEqual([
      expect.stringMatching(
        /^プロジェクト「A」のコンテキストを読めず、その秘密情報を前もって取り出せませんでした（使うときに、その場で取り出します）：.*fatal: unable to access/,
      ),
    ]);
    failOnce = false;
    const task = service.createTask({ projectId: "a", title: "ドキュメントを直す" });
    await service.runNext(task.id);
    expect(executor.calls[0]?.env).toEqual(
      expect.objectContaining({ SACTY_MCP_SECRET_0: "wiki-from-op" }),
    );
    // 前もって取り出せなかった参照は、使うときに1件ずつ取り出す（MCP の env・ヘッダーと、PF の認証）
    expect(op.calls.slice(1).map((c) => c.command)).toEqual(["read", "read", "read"]);
    expect(
      op.calls
        .slice(1)
        .flatMap((c) => c.refs)
        .sort(),
    ).toEqual(allRefs.slice(1).sort());
    activity.close();
  });

  it("取得のエラー文に入った認証のトークンは、警告に出さない", async () => {
    const contexts = new FakeContexts({});
    contexts.fail = true;
    const projects = new MemoryProjectStore();
    projects.put("gh", {
      name: "GH",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { activity, service } = setup([], { contexts, projects });
    await service.prefetchSecrets();
    const authValue = contexts.fetched[0]?.authEnv?.GIT_CONFIG_VALUE_0 ?? "";
    expect(authValue).not.toBe("");
    const shown = JSON.stringify(service.status().warnings);
    expect(shown).toContain("Authentication failed");
    expect(shown).not.toContain(authValue);
    expect(shown).not.toContain("ghp_secret");
    activity.close();
  });

  it("プロジェクトが多くても、コンテキストを同時に読みすぎず、上限の時間を過ぎたら待たずに取り出す", async () => {
    let active = 0;
    let most = 0;
    const releases: (() => void)[] = [];
    const files = new FakeContexts(contextFiles());
    const contexts: ContextFetcher = {
      fetch: async (ref, out, authEnv) => {
        active++;
        most = Math.max(most, active);
        // 応答の無い git の取得（時間切れの後に返る）
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return files.fetch(ref, out, authEnv);
      },
    };
    const projects = new MemoryProjectStore();
    for (let i = 0; i < 10; i++) {
      projects.put(`p${i}`, {
        name: `P${i}`,
        targets: [{ scope: "repo", target: `https://github.com/acme/p${i}` }],
        githubAccounts: { "github.com": "me" },
        context: { repo: teamRepo },
      });
    }
    const { activity, op, service } = setup([], { contexts, projects, timeoutMs: 50 });
    const startedAt = Date.now();
    const started = await service.prefetchSecrets();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(most).toBeLessThanOrEqual(4);
    expect(op.calls).toEqual([{ command: "run", refs: ["op://Work/Claude/token"] }]);
    expect(started.problems).toHaveLength(10);
    expect(ja(started.problems[0])).toContain("1 秒のうちに取得できませんでした。");
    // 時間切れの後に返った取得は使わない（op を呼ばない）
    for (const release of releases) release();
    await new Promise((r) => setTimeout(r, 20));
    expect(op.calls).toHaveLength(1);
    activity.close();
  });

  it("プロジェクトを保存・作成・取り込みしたら、保存を止めずに、そのコンテキストの秘密情報を取り出す。持っている参照は問い合わせ直さない", async () => {
    const files = contextFiles();
    const contexts = new FakeContexts(files);
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
    });
    const { activity, op, service } = setup([], { contexts, projects });
    await service.prefetchSecrets();
    expect(op.calls).toEqual([{ command: "run", refs: ["op://Work/Claude/token"] }]);
    const app = createApp(service, "tok");
    const send = (method: string, path: string, body: unknown) =>
      app.request(path, {
        method,
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const definition = (name: string, repo: string, context?: string) => ({
      name,
      targets: [{ scope: "repo", target: `https://github.com/acme/${repo}` }],
      githubAccounts: { "github.com": "me" },
      ...(context ? { context: { repo: context } } : {}),
    });
    // コンテキストを変えて保存する
    expect((await send("PUT", "/api/projects/a", definition("A", "a", teamRepo))).status).toBe(200);
    await vi.waitFor(() => expect(op.calls).toHaveLength(2));
    expect(op.calls[1]).toEqual({ command: "run", refs: allRefs.slice(1) });
    // 同じ内容で保存し直しても、持っている参照は 1Password に問い合わせない
    expect((await send("PUT", "/api/projects/a", definition("A", "a", teamRepo))).status).toBe(200);
    await new Promise((r) => setTimeout(r, 50));
    expect(op.calls).toHaveLength(2);
    // 起動の後に足された秘密情報は、保存し直すと、それだけを取り出す。取り出せないものは画面の警告に出す
    files[baseRepo] = {
      ...files[baseRepo],
      "mcp.yaml": [
        "servers:",
        "  fresh:",
        "    url: https://fresh.example.com/mcp",
        "    headers:",
        "      Authorization: { secret: op://Work/New/key }",
        "  broken:",
        "    url: https://broken.example.com/mcp",
        "    headers:",
        "      Authorization: { secret: op://Work/Missing/key }",
      ].join("\n"),
    };
    expect((await send("PUT", "/api/projects/a", definition("A", "a", teamRepo))).status).toBe(200);
    await vi.waitFor(() => expect(service.status().warnings).toHaveLength(1));
    expect(op.calls.slice(2)).toEqual([
      { command: "run", refs: ["op://Work/New/key", "op://Work/Missing/key"] },
      { command: "read", refs: ["op://Work/New/key"] },
      { command: "read", refs: ["op://Work/Missing/key"] },
    ]);
    expect(ja(service.status().warnings[0])).toMatch(
      /^プロジェクトの設定を保存したときに、秘密情報（プロジェクト「A」のコンテキスト（https:\/\/git\.example\.com\/base-ctx\.git@c0ffee0）の mcp\.yaml の servers\.broken\.headers\.Authorization）を取り出せませんでした：/,
    );
    // 新しく作ったプロジェクトも同じ（警告は、プロジェクトごとに置き換える）
    files[baseRepo] = contextFiles()[baseRepo] ?? {};
    const created = await send("POST", "/api/projects", definition("B", "b", baseRepo));
    expect(created.status).toBe(201);
    await new Promise((r) => setTimeout(r, 50));
    expect(op.calls).toHaveLength(5);
    expect(service.status().warnings).toHaveLength(1);
    // 直してから保存し直すと、そのプロジェクトの警告は消える
    expect((await send("PUT", "/api/projects/a", definition("A", "a", teamRepo))).status).toBe(200);
    await vi.waitFor(() => expect(service.status().warnings).toEqual([]));
    expect(op.calls).toHaveLength(5);
    // インポートしたプロジェクトも、取り出す
    const otherRepo = "https://git.example.com/other-ctx.git";
    files[otherRepo] = {
      "platforms.yaml": [
        "platforms:",
        "  other:",
        "    upstream: https://other.example.com",
        "    auth:",
        "      secret: op://Work/Other/key",
        "    allow: [GET /**]",
      ].join("\n"),
    };
    values["op://Work/Other/key"] = "other-from-op";
    const exported = service.exportProject("a");
    const imported = await send("POST", "/api/projects/import", {
      ...exported,
      project: {
        ...exported?.project,
        name: "C",
        targets: [{ scope: "repo", target: "https://github.com/acme/c" }],
        context: { repo: otherRepo },
      },
    });
    expect(imported.status).toBe(201);
    await vi.waitFor(() => expect(op.calls).toHaveLength(6));
    expect(op.calls[5]).toEqual({ command: "run", refs: ["op://Work/Other/key"] });
    delete values["op://Work/Other/key"];
    activity.close();
  });

  it("保存は 1Password の承認を待たずに終わり、承認を待つ間にタスクが同じ参照を使っても、別に問い合わせない。続けて保存したら、最後の結果を警告にする", async () => {
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
    });
    const files = contextFiles();
    const { activity, op, service, executor } = setup([completed(20_000)], {
      contexts: new FakeContexts(files),
      projects,
    });
    await service.prefetchSecrets();
    let approve: (() => void) | undefined;
    op.approval.wait = new Promise<void>((resolve) => {
      approve = resolve;
    });
    const app = createApp(service, "tok");
    const save = () =>
      app.request("/api/projects/a", {
        method: "PUT",
        headers: { authorization: "Bearer tok", "content-type": "application/json" },
        body: JSON.stringify({
          name: "A",
          targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
          githubAccounts: { "github.com": "me" },
          context: { repo: teamRepo },
        }),
      });
    expect((await save()).status).toBe(200);
    await vi.waitFor(() => expect(op.calls).toHaveLength(2));
    // 承認を待っている間に、タスクを作って実行する
    const task = service.createTask({ projectId: "a", title: "ドキュメントを直す" });
    const running = service.runNext(task.id);
    await new Promise((r) => setTimeout(r, 30));
    approve?.();
    await running;
    expect(executor.calls[0]?.env).toEqual(
      expect.objectContaining({ SACTY_MCP_SECRET_0: "wiki-from-op" }),
    );
    expect(op.calls.map((c) => c.command)).toEqual(["run", "run"]);
    // 先の保存の取り出しが後から終わっても、後の保存の警告を上書きしない
    op.approval.wait = undefined;
    files[teamRepo] = {
      ...files[teamRepo],
      "mcp.yaml": [
        "servers:",
        "  broken:",
        "    url: https://broken.example.com/mcp",
        "    headers:",
        "      Authorization: { secret: op://Work/Missing/key }",
      ].join("\n"),
    };
    let slow: (() => void) | undefined;
    op.approval.wait = new Promise<void>((resolve) => {
      slow = resolve;
    });
    const first = service.prefetchProjectSecrets("a");
    await vi.waitFor(() => expect(op.calls).toHaveLength(3));
    op.approval.wait = undefined;
    delete files[teamRepo]?.["mcp.yaml"];
    await service.prefetchProjectSecrets("a");
    slow?.();
    expect(await first).toHaveLength(1);
    expect(service.status().warnings).toEqual([]);
    activity.close();
  });

  describe("起動・取り出し直しと保存が重なったとき（PR #117 レビュー指摘）", () => {
    /** op run を、1回ずつ止めておける偽の op（gates[i] で i 回目の op run を終える）。 */
    const gatedOp = () => {
      const gates: (() => void)[] = [];
      const runs: string[][] = [];
      const run: OpRunner = async (args) => {
        if (args[0] === "run") {
          const file = args[args.indexOf("--env-file") + 1] ?? "";
          const refs = readFileSync(file, "utf8")
            .trim()
            .split("\n")
            .map((line) => line.replace(/^[^=]+="(.*)"$/, "$1"));
          runs.push(refs);
          await new Promise<void>((resolve) => gates.push(resolve));
          return refs.every((ref) => ref in values)
            ? { code: 0, stdout: JSON.stringify(refs.map((ref) => values[ref])), stderr: "" }
            : { code: 1, stdout: "", stderr: "[ERROR] could not resolve a reference" };
        }
        const ref = args.at(-1) ?? "";
        const value = values[ref];
        return value
          ? { code: 0, stdout: value, stderr: "" }
          : { code: 1, stdout: "", stderr: "[ERROR] 2026/10/15 00:00:00 item not found" };
      };
      return { gates, runs, run };
    };
    /** 取り出せない参照を書いた mcp.yaml（保存のときの警告になる）。 */
    const brokenMcp = [
      "servers:",
      "  broken:",
      "    url: https://broken.example.com/mcp",
      "    headers:",
      "      Authorization: { secret: op://Work/Missing/key }",
    ].join("\n");
    const plainFiles = () => ({ [teamRepo]: { "rules.md": "規約だけ" } });

    it("起動側が先に始まり、保存側が先に終わっても、保存の後の警告を消さない", async () => {
      const files: Record<string, Record<string, string>> = plainFiles();
      const op = gatedOp();
      const { activity, service } = setup([], { contexts: new FakeContexts(files), run: op.run });
      const startup = service.prefetchSecrets();
      await vi.waitFor(() => expect(op.runs).toHaveLength(1));
      // 起動側が 1Password の承認を待っている間に、取り出せない参照を足して保存する
      files[teamRepo] = { "mcp.yaml": brokenMcp };
      const saving = service.prefetchProjectSecrets("a");
      await vi.waitFor(() => expect(op.runs).toHaveLength(2));
      op.gates[1]?.();
      expect(await saving).toHaveLength(1);
      expect(service.status().warnings).toHaveLength(1);
      // 後から起動側が終わっても、保存の後の警告は残る
      op.gates[0]?.();
      expect((await startup).problems).toEqual([]);
      expect(ja(service.status().warnings[0])).toContain("servers.broken.headers.Authorization");
      activity.close();
    });

    it("保存側が先に始まり、起動側（取り出し直し）が先に終わったら、後から終わった保存の古い警告を出さない", async () => {
      const files: Record<string, Record<string, string>> = {
        [teamRepo]: { "mcp.yaml": brokenMcp },
      };
      const op = gatedOp();
      const { activity, service } = setup([], { contexts: new FakeContexts(files), run: op.run });
      const saving = service.prefetchProjectSecrets("a");
      await vi.waitFor(() => expect(op.runs).toHaveLength(1));
      // 保存側が承認を待っている間に参照を直し、取り出し直す（こちらの方が新しい）
      files[teamRepo] = { "rules.md": "規約だけ" };
      const again = service.prefetchSecrets({ fresh: true });
      await vi.waitFor(() => expect(op.runs).toHaveLength(2));
      op.gates[1]?.();
      expect((await again).problems).toEqual([]);
      op.gates[0]?.();
      expect(await saving).toHaveLength(1);
      expect(service.status().warnings).toEqual([]);
      activity.close();
    });
  });

  it("上限の時間を過ぎたら、取得の git の子プロセスを止め、一時ディレクトリも残さない（PR #117 レビュー指摘）", async () => {
    const work = mkdtempSync(join(tmpdir(), "sacty-git-hang-"));
    const bin = join(work, "bin");
    const temp = join(work, "tmp");
    mkdirSync(bin);
    mkdirSync(temp);
    const pidFile = join(work, "pids");
    // 応答しない git（clone が止まったまま。子プロセスも作る）
    writeFileSync(
      join(bin, "git"),
      `#!/bin/sh\necho $$ >> "${pidFile}"\nsleep 30 &\necho $! >> "${pidFile}"\nwait\n`,
    );
    chmodSync(join(bin, "git"), 0o755);
    const path = process.env.PATH;
    const tmp = process.env.TMPDIR;
    process.env.PATH = `${bin}:${path}`;
    process.env.TMPDIR = temp;
    const pids = () =>
      existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split("\n").map(Number) : [];
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const { activity, service } = setup([], {
        contexts: new GitContextFetcher(),
        timeoutMs: 1000,
      });
      const started = await service.prefetchSecrets();
      expect(ja(started.problems[0])).toContain("1 秒のうちに取得できませんでした。");
      await vi.waitFor(() => expect(pids()).toHaveLength(2));
      await vi.waitFor(
        () => {
          expect(pids().filter(alive)).toEqual([]);
          expect(readdirSync(temp)).toEqual([]);
        },
        { timeout: 2_500 },
      );
      activity.close();
    } finally {
      process.env.PATH = path;
      if (tmp === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmp;
      for (const pid of pids()) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // 止まっている
        }
      }
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("「秘密情報を取り出し直す」は、持っている値を捨て、コンテキストの秘密情報も含めて取り出し直す", async () => {
    const { activity, op, service, executor } = setup([completed(20_000)]);
    await service.prefetchSecrets();
    const app = createApp(service, "tok");
    const res = await app.request("/api/secrets/prefetch", {
      method: "POST",
      headers: { authorization: "Bearer tok", "content-type": "application/json" },
      body: "{}",
    });
    expect(await res.json()).toEqual({
      total: 4,
      fetched: 4,
      unreadContexts: 0,
      problems: [],
    });
    expect(op.calls).toEqual([
      { command: "run", refs: allRefs },
      { command: "run", refs: allRefs },
    ]);
    const task = service.createTask({ projectId: "a", title: "ドキュメントを直す" });
    await service.runNext(task.id);
    expect(executor.calls[0]?.env).toEqual(
      expect.objectContaining({ SACTY_MCP_SECRET_0: "wiki-from-op" }),
    );
    expect(op.calls).toHaveLength(2);
    activity.close();
  });
});

describe("sacty の設定と、Issue・PR の取り込み（PBI-26）", () => {
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const found = (number: number, labels: string[], pullRequest = false) => ({
    repo: "https://github.com/acme/app",
    number,
    title: `${pullRequest ? "PR" : "Issue"} ${number}`,
    body: "本文",
    url: `https://github.com/acme/app/${pullRequest ? "pull" : "issues"}/${number}`,
    labels,
    ...(pullRequest ? { pullRequest: true } : {}),
  });
  /**
   * 取り込むラベルで PR を取り込んでいた（PBI-99 より前の）タスク。いまは取り込みでは作らないので、台帳に書いて作る。
   * すでに取り込んだタスクは、これまでどおり進む。
   */
  const importedPullRequest = (activity: SqliteActivityStore, number: number) => {
    const id = randomUUID();
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "TaskCreated",
            payload: {
              title: `PR ${number}`,
              body: "本文",
              start: "github_pull_request",
              budgetCapUsd: 5,
              source: {
                kind: "github_pull_request",
                repo: "https://github.com/acme/app",
                number,
                url: `https://github.com/acme/app/pull/${number}`,
              },
            },
          },
        },
      ],
    });
    return id;
  };

  it("取り込むラベルは sacty 全体の設定で、設定していなければ取り込まない。変えると取り込みは読み直す", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore();
    const { service } = makeService(activity, [], { settings });
    expect(service.getSettings()).toEqual({});
    expect(service.intakeSources()).toEqual([]);
    expect(service.importIssues([found(1, ["sacty"])])).toEqual([]);
    const before = service.projectsRevision();

    // 前後の空白は除き、空は「設定しない」
    expect(service.saveSettings({ intakeLabel: "  ai-task " })).toEqual({ intakeLabel: "ai-task" });
    expect(service.projectsRevision()).not.toBe(before);
    expect(service.intakeSources()).toEqual([
      {
        host: "github.com",
        query: 'is:open is:issue repo:acme/app label:"ai-task"',
        account: "me",
        project: "デフォルト",
      },
    ]);
    // ラベルの大文字・小文字は区別しない。ほかのラベルは取り込まない
    expect(
      service
        .importIssues([found(2, ["AI-Task"]), found(3, ["sacty"])])
        .map((t) => t.source?.number),
    ).toEqual([2]);
    expect(service.saveSettings({ intakeLabel: " " })).toEqual({});
    expect(service.intakeSources()).toEqual([]);
    // 検索の条件を壊す文字は受け付けない
    expect(() => service.saveSettings({ intakeLabel: 'a" OR label:"b' })).toThrow();
    activity.close();
  });

  it("取り込むラベルの付いた PR は取り込まない（PBI-99）。すでに PR から作ったタスクは、その PR をレビューの対象として工程を選ばせる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 8, url: "https://github.com/acme/app/pull/8" };
    const settings = new MemorySettingsStore({ intakeLabel: "sacty" });
    const first = makeService(activity, [], { pulls, settings });
    expect(first.service.importIssues([found(8, ["sacty"], true)])).toEqual([]);
    const id = importedPullRequest(activity, 8);
    const { service, executor } = makeService(
      activity,
      [out(block({ "sacty-steps": { plan: "review", reason: "PR のレビュー" } })), out("# 評価")],
      { pulls, settings, realPlanner: true },
    );
    expect(service.get(id)?.task.start).toBe("github_pull_request");
    await service.runNext(id);
    // 本文に PR の URL が無くても、取り込んだ PR そのものをレビューの対象にする
    expect(promptOf(executor, 0)).toContain("- review：");
    expect(pulls.prInfoRequests).toEqual([
      { repo: "https://github.com/acme/app", number: 8, token: "ghp_secret" },
    ]);
    await service.runNext(id);
    expect(pulls.reviews[0]?.number).toBe(8);
    activity.close();
  });

  it("すでに PR から作った調査のタスクは、結果を PR にコメントする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const id = importedPullRequest(activity, 9);
    const { service } = makeService(activity, [out("# 調査の結果")], {
      pulls,
      planner: async () => ({
        steps: ["investigate" as const],
        plan: "investigate" as const,
        reason: "質問",
        fallback: false,
        costUsd: 0,
        estimated: false,
      }),
    });
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    await service.runNext(id);
    expect(pulls.issueComments.map((c) => [c.repo, c.number])).toEqual([
      ["https://github.com/acme/app", 9],
    ]);
    expect(service.get(id)?.task.issueComment).toBeDefined();
    activity.close();
  });

  it("状態には、取り込むラベルを含める（設定していなければ無い）。取り込みに github: の設定は要らない（PBI-100）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore();
    const { service } = makeService(activity, [], { settings });
    expect(service.status().intake).toEqual({});
    service.saveSettings({ intakeLabel: "sacty" });
    expect(service.status().intake).toEqual({ label: "sacty" });
    activity.close();
  });
});

describe("自動のトリアージの種類ごとの On/Off（PBI-53）", () => {
  const found = (number: number, labels: string[], pullRequest = false) => ({
    repo: "https://github.com/acme/app",
    number,
    title: `#${number}`,
    body: "",
    url: `https://github.com/acme/app/${pullRequest ? "pull" : "issues"}/${number}`,
    labels,
    ...(pullRequest ? { pullRequest: true } : {}),
  });

  it("Off にした種類は検索せず、取り込まない。ラベルなどの設定は残る。項目の無い設定はすべて On", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      reviewRequested: true,
    });
    const { service } = makeService(activity, [], { settings });
    const queries = () => service.intakeSources().map((s) => s.query);
    // On/Off の項目が無い設定は、すべて On。取り込むラベルは Issue だけを探す（PBI-99）
    expect(queries()).toEqual([
      'is:open is:issue repo:acme/app label:"sacty"',
      'is:open is:pr repo:acme/app label:"sacty-review"',
      "is:open is:pr repo:acme/app user-review-requested:me",
    ]);
    // 取り込むラベルの付いた PR は取り込まない（PBI-99）
    expect(
      service
        .importIssues([found(1, ["sacty"]), found(2, ["sacty"], true)])
        .map((t) => t.source?.number),
    ).toEqual([1]);
    const before = service.projectsRevision();

    // Issue を Off：取り込むラベルの検索をしない。重ねて書いても1つ、並びはそろえる
    expect(
      service.saveSettings({
        intakeLabel: "sacty",
        reviewLabel: "sacty-review",
        reviewRequested: true,
        triageOff: ["issues", "issues"],
      }),
    ).toMatchObject({ intakeLabel: "sacty", reviewLabel: "sacty-review", triageOff: ["issues"] });
    expect(service.projectsRevision()).not.toBe(before);
    expect(queries()).toEqual([
      'is:open is:pr repo:acme/app label:"sacty-review"',
      "is:open is:pr repo:acme/app user-review-requested:me",
    ]);
    expect(service.importIssues([found(3, ["sacty"]), found(4, ["sacty"], true)])).toEqual([]);

    // Issue とレビュー用のラベルを Off：その検索をしない。ラベルは残る
    service.saveSettings({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      reviewRequested: true,
      triageOff: ["reviewLabel", "issues"],
    });
    expect(queries()).toEqual(["is:open is:pr repo:acme/app user-review-requested:me"]);
    expect(service.getSettings()).toMatchObject({
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      triageOff: ["issues", "reviewLabel"],
    });
    expect(service.importIssues([found(5, ["sacty"]), found(6, ["sacty-review"], true)])).toEqual(
      [],
    );
    // 状況（画面）にも出す
    expect(service.status().intake).toMatchObject({ triageOff: ["issues", "reviewLabel"] });
    // すべて On に戻すと、項目を持たない
    expect(service.saveSettings({ intakeLabel: "sacty", triageOff: [] })).toEqual({
      intakeLabel: "sacty",
    });
    expect(() => service.saveSettings({ triageOff: ["jira-unknown"] })).toThrow();
    // 消した種類（取り込むラベルの PR。PBI-99）は受け付けない
    expect(() => service.saveSettings({ triageOff: ["pullRequests"] })).toThrow();
    activity.close();
  });

  it("取り込むラベルとレビュー用のラベルに同じ名前（大文字・小文字だけ違う名前も）を保存でき、Issue は通常のタスク、PR はレビューだけのタスクにする（PBI-104）", () => {
    for (const [intakeLabel, reviewLabel] of [
      ["sacty", "sacty"],
      ["sacty", " SACTY "],
    ] as const) {
      const activity = new SqliteActivityStore(dbPath);
      const settings = new MemorySettingsStore({});
      const { service } = makeService(activity, [], { settings });
      expect(service.saveSettings({ intakeLabel, reviewLabel }), reviewLabel).toEqual({
        intakeLabel: "sacty",
        reviewLabel: reviewLabel.trim(),
      });
      // Issue と PR は検索の条件（is:issue・is:pr）で分かれる
      expect(service.intakeSources().map((s) => [s.query, s.review])).toEqual([
        ['is:open is:issue repo:acme/app label:"sacty"', undefined],
        [`is:open is:pr repo:acme/app label:"${reviewLabel.trim()}"`, "label"],
      ]);
      // 同じラベルの Issue は通常のタスク、PR はレビューだけのタスク。どちらの検索で見つかっても入れ替わらない
      const labeled = reviewLabel.trim();
      const created = service.importIssues([
        found(1, ["sacty"]),
        found(2, [labeled], true),
        { ...found(3, ["sacty"]), review: "label" },
        found(4, [labeled], true),
      ]);
      expect(created.map((t) => [t.source?.number, t.source?.kind, t.source?.review])).toEqual([
        [1, "github_issue", undefined],
        [2, "github_pull_request", "label"],
        [3, "github_issue", undefined],
        [4, "github_pull_request", "label"],
      ]);
      // 2つの検索の両方で見つかっても、同じ Issue・PR は二度取り込まない
      expect(
        service.importIssues([
          found(1, ["sacty"]),
          { ...found(1, ["sacty"]), review: "label" },
          found(2, [labeled], true),
          { ...found(2, [labeled], true), review: "label" },
        ]),
      ).toEqual([]);
      expect(service.list()).toHaveLength(4);
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("同じ名前の2つのラベルをすでに保存してある設定（SQLite）でも開け、Issue と PR の取り込みが続く（PBI-99 レビュー指摘）", () => {
    // 以前の版で保存した設定を、そのまま書く
    const raw = new DatabaseSync(dbPath);
    raw.exec(
      "CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), value TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    raw
      .prepare("INSERT INTO settings (id, value, updated_at) VALUES (1, ?, ?)")
      .run(
        JSON.stringify({ intakeLabel: "sacty", reviewLabel: "Sacty", triageOff: ["pullRequests"] }),
        "2026-10-14T00:00:00.000Z",
      );
    raw.close();
    const settings = new SqliteSettingsStore(dbPath);
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { settings });
    expect(service.getSettings()).toEqual({ intakeLabel: "sacty", reviewLabel: "Sacty" });
    expect(service.intakeSources().map((s) => s.query)).toEqual([
      'is:open is:issue repo:acme/app label:"sacty"',
      'is:open is:pr repo:acme/app label:"Sacty"',
    ]);
    // Issue は通常のタスク、PR はレビューだけのタスク
    expect(
      service
        .importIssues([found(1, ["sacty"]), found(2, ["sacty"], true)])
        .map((t) => [t.source?.number, t.source?.review]),
    ).toEqual([
      [1, undefined],
      [2, "label"],
    ]);
    // そのまま保存し直せる（PBI-104）
    expect(service.saveSettings({ intakeLabel: "sacty", reviewLabel: "Sacty" })).toEqual({
      intakeLabel: "sacty",
      reviewLabel: "Sacty",
    });
    activity.close();
    settings.close();
  });
});

describe("PR のレビューだけを行う取り込み（PBI-44）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const pr = (number: number, labels: string[], extra: Record<string, unknown> = {}) => ({
    repo: "https://github.com/acme/app",
    number,
    title: `PR ${number}`,
    body: "本文",
    url: `https://github.com/acme/app/pull/${number}`,
    labels,
    pullRequest: true,
    ...extra,
  });

  it("自分へのレビューの依頼とレビュー用のラベルで、ホストのアカウントごとに PR を探す（チームへの依頼は含めない）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore();
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: "https://github.com/acme/app" },
        { scope: "org", target: "https://ghe.example.com/corp" },
      ],
      githubAccounts: { "github.com": "me", "ghe.example.com": "me-corp" },
    });
    const { service } = makeService(activity, [], { settings, projects });
    expect(service.intakeSources()).toEqual([]);
    expect(service.saveSettings({ reviewRequested: "on", reviewLabel: " sacty-review " })).toEqual({
      reviewRequested: true,
      reviewLabel: "sacty-review",
    });
    expect(service.intakeSources()).toEqual([
      {
        host: "github.com",
        query: 'is:open is:pr repo:acme/app label:"sacty-review"',
        account: "me",
        project: "デフォルト",
        review: "label",
      },
      {
        host: "github.com",
        query: "is:open is:pr repo:acme/app user-review-requested:me",
        account: "me",
        project: "デフォルト",
        review: "requested",
      },
      {
        host: "ghe.example.com",
        query: 'is:open is:pr org:corp label:"sacty-review"',
        account: "me-corp",
        project: "デフォルト",
        review: "label",
      },
      {
        host: "ghe.example.com",
        query: "is:open is:pr org:corp user-review-requested:me-corp",
        account: "me-corp",
        project: "デフォルト",
        review: "requested",
      },
    ]);
    // 切り替えを切ると、依頼の検索はしない。取り込むラベル（Issue と PR）は別の設定
    service.saveSettings({ reviewLabel: "sacty-review", intakeLabel: "sacty" });
    expect(service.intakeSources().map((s) => s.review ?? "intake")).toEqual([
      "intake",
      "label",
      "intake",
      "label",
    ]);
    activity.close();
  });

  it("依頼された PR とレビュー用のラベルの PR を取り込み、レビュー用のラベルの Issue は取り込まない。同じ PR は1つ", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({
      reviewRequested: true,
      reviewLabel: "sacty-review",
    });
    const { service } = makeService(activity, [], { settings });
    const created = service.importIssues([
      pr(1, [], { review: "requested", requestedFor: "me" }),
      pr(2, ["Sacty-Review"]),
      // 依頼とラベルの両方に当てはまる
      pr(3, ["sacty-review"], { review: "requested", requestedFor: "me" }),
      pr(3, ["sacty-review"], { review: "label" }),
      // レビュー用のラベルの Issue は取り込まない
      {
        ...pr(4, ["sacty-review"]),
        pullRequest: undefined,
        url: "https://github.com/acme/app/issues/4",
      },
      // 依頼の検索で見つかっても、切り替えを切っていれば取り込まない（後で確かめる）
    ]);
    expect(created.map((t) => [t.source?.number, t.source?.review])).toEqual([
      [1, "requested"],
      [2, "label"],
      [3, "requested"],
    ]);
    // 二度は取り込まない
    expect(
      service.importIssues([
        pr(1, [], { review: "requested", requestedFor: "me" }),
        pr(2, ["sacty-review"]),
      ]),
    ).toEqual([]);
    service.saveSettings({ reviewLabel: "sacty-review" });
    expect(service.importIssues([pr(5, [], { review: "requested", requestedFor: "me" })])).toEqual(
      [],
    );
    activity.close();
  });

  it("依頼は、担当のプロジェクトでそのホストに選んだ本人への依頼だけを取り込む（レビュー指摘）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({ reviewRequested: true });
    const projects = new MemoryProjectStore();
    // Org のプロジェクトは alice、その中のリポジトリのプロジェクトは bob
    projects.put("org", {
      name: "Org",
      targets: [{ scope: "org", target: "https://github.com/acme" }],
      githubAccounts: { "github.com": "alice" },
    });
    projects.put("repo", {
      name: "リポジトリ",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "Bob" },
    });
    const { service } = makeService(activity, [], { settings, projects });
    const created = service.importIssues([
      // alice への依頼が Org の検索で見つかったが、acme/app の担当は bob のプロジェクト
      pr(20, [], { review: "requested", requestedFor: "alice" }),
      // bob への依頼（大文字・小文字は区別しない）
      pr(21, [], { review: "requested", requestedFor: "bob" }),
      // 誰への依頼かが分からないものは取り込まない
      pr(22, [], { review: "requested" }),
      // alice の担当のリポジトリ
      {
        ...pr(23, [], { review: "requested", requestedFor: "alice" }),
        repo: "https://github.com/acme/web",
        url: "https://github.com/acme/web/pull/23",
      },
    ]);
    expect(created.map((t) => [t.projectId, t.source?.repo, t.source?.number])).toEqual([
      ["repo", "https://github.com/acme/app", 21],
      ["org", "https://github.com/acme/web", 23],
    ]);
    activity.close();
  });

  it("プロジェクトの対象で指定したイメージを、レビューだけの工程にも使い、無い名前なら止まる（レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const java = {
      name: "java",
      image: "sacty-agent-java:test",
      description: "Java",
      baseImage: "java",
      env: { MAVEN_OPTS: "-Xmx1g" },
    };
    const projects = new MemoryProjectStore();
    const put = (image: string) =>
      projects.put("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app", image }],
        githubAccounts: { "github.com": "me" },
      });
    put("java");
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 30, url: "https://github.com/acme/app/pull/30" };
    const { service, executor } = makeService(activity, [out("# 評価")], {
      pulls,
      projects,
      settings: new MemorySettingsStore({ reviewLabel: "sacty-review" }),
      config: () => ({
        ok: true,
        config: {
          ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
          images: { java },
        },
      }),
    });
    const [task] = service.importIssues([pr(30, ["sacty-review"])]);
    await service.runNext(task?.id ?? "");
    const chosen = service.get(task?.id ?? "")?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.images).toEqual({ review: "java" });
    expect(executor.images[0]).toEqual({ image: java.image, env: java.env });

    // 無い名前を指定していたら、工程を決めずに止まる
    put("python");
    const [other] = service.importIssues([pr(31, ["sacty-review"])]);
    await service.runNext(other?.id ?? "");
    const stopped = service.get(other?.id ?? "")?.task;
    expect(stopped?.status).toBe("paused");
    expect(stopped?.steps).toEqual([]);
    expect(ja(stopped?.pausedMessage)).toContain("イメージ「python」");
    activity.close();
  });

  it("取り込むラベルとレビュー用のラベルの両方が付いた PR は、レビューだけのタスクにする。Issue の取り込みはこれまでどおり", () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({ intakeLabel: "sacty", reviewLabel: "sacty-review" });
    const { service } = makeService(activity, [], { settings });
    const created = service.importIssues([
      pr(6, ["sacty"]),
      pr(6, ["sacty", "sacty-review"], { review: "label" }),
      { ...pr(7, ["sacty"]), pullRequest: undefined, url: "https://github.com/acme/app/issues/7" },
    ]);
    expect(created.map((t) => [t.source?.number, t.source?.kind, t.source?.review])).toEqual([
      [6, "github_pull_request", "label"],
      [7, "github_issue", undefined],
    ]);
    activity.close();
  });

  it("レビューの取り込みのタスクは、オーケストレーターを使わずにレビューだけを行い、PR に投稿する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 8, url: "https://github.com/acme/app/pull/8" };
    const settings = new MemorySettingsStore({ reviewRequested: true });
    const { service, executor } = makeService(activity, [out("# 評価")], {
      pulls,
      settings,
      realPlanner: true,
    });
    const [task] = service.importIssues([pr(8, [], { review: "requested", requestedFor: "me" })]);
    const id = task?.id ?? "";
    await service.runNext(id);
    const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.actor).toBe("sacty");
    expect(chosen?.type === "StepsChosen" && chosen.payload.steps).toEqual(["review"]);
    expect(ja(chosen?.type === "StepsChosen" ? chosen.payload.reason : undefined)).toBe(
      "自分にレビューが依頼された PR なので、レビューだけを行います（オーケストレーターは使いません）。",
    );
    // エージェントの実行はレビューの1回だけ（オーケストレーターは動かさない）
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.command.join(" ")).toContain("レビューエージェント");
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);
    expect(service.get(id)?.task.reviewPost).toBeDefined();
    activity.close();
  });

  it("PR がマージ・クローズされたら、終わっていないレビューのタスクを中止する。完了したタスクと開いている PR はそのまま", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const settings = new MemorySettingsStore({ reviewLabel: "sacty-review", intakeLabel: "sacty" });
    const { service } = makeService(activity, [], { pulls, settings });
    const [merged, closed, issueTask] = service.importIssues([
      pr(10, ["sacty-review"]),
      pr(11, ["sacty-review"]),
      // 取り込むラベルの PR（レビューの取り込みではない）は、ここでは中止しない
      pr(12, ["sacty"]),
    ]);
    pulls.state = { state: "open" };
    await service.checkPullRequests();
    expect(service.get(merged?.id ?? "")?.task.status).not.toBe("cancelled");

    pulls.state = { state: "merged" };
    await service.checkPullRequests();
    const cancelled = service.get(merged?.id ?? "");
    expect(cancelled?.task.status).toBe("cancelled");
    const event = cancelled?.activity.find((e) => e.type === "TaskCancelled");
    expect(event?.actor).toBe("sacty");
    expect(event?.type === "TaskCancelled" && event.payload.reason).toBe("pull_request_merged");
    expect(service.get(closed?.id ?? "")?.task.status).toBe("cancelled");
    expect(service.get(issueTask?.id ?? "")?.task.status).not.toBe("cancelled");

    pulls.state = { state: "closed" };
    const [another] = service.importIssues([pr(13, ["sacty-review"])]);
    await service.checkPullRequests();
    const closedEvent = service
      .get(another?.id ?? "")
      ?.activity.find((e) => e.type === "TaskCancelled");
    expect(closedEvent?.type === "TaskCancelled" && closedEvent.payload.reason).toBe(
      "pull_request_closed",
    );
    activity.close();
  });

  it("再レビューで、PR の最新のコミットをもう一度レビューして投稿する。投稿して完了したタスクだけ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const settings = new MemorySettingsStore({ reviewLabel: "sacty-review" });
    const { service } = makeService(activity, [out("# 1回目"), out("# 2回目")], {
      pulls,
      settings,
    });
    const [task] = service.importIssues([pr(9, ["sacty-review"])]);
    const id = task?.id ?? "";
    // 投稿する前は、再レビューできない
    expect(() => service.rereview(id)).toThrow(/再レビューできるのは/);
    await service.runNext(id);
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(1);

    // PR に新しいコミットが積まれた
    pulls.prInfo = { ...pulls.prInfo, headSha: "n".repeat(40) };
    const restarted = service.rereview(id);
    expect(restarted.status).toBe("queued");
    expect(restarted.reviewRound).toBe(2);
    expect(restarted.reviewPost).toBeUndefined();
    await service.runNext(id);
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(2);
    expect(pulls.reviews[1]?.commit).toBe("n".repeat(40));
    expect(pulls.reviews[1]?.body).toContain("# 2回目");
    // 回ごとに別の目印（前回のレビューを、今回の投稿済みと見なさない）
    expect(pulls.reviews[1]?.body).toContain(`<!-- sacty-review:${id}:2 -->`);
    expect(service.get(id)?.activity.some((e) => e.type === "ReviewRestarted")).toBe(true);
    activity.close();
  });

  it("再レビューでは、前回の指摘と、前回の投稿の後の PR の作者の返答だけをプロンプトに渡す（PBI-111）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    pulls.prInfo = { ...pulls.prInfo, number: 9, url: "https://github.com/acme/app/pull/9" };
    const settings = new MemorySettingsStore({ reviewLabel: "sacty-review" });
    const first = [
      "# 1回目",
      `\`\`\`json\n${JSON.stringify({
        "sacty-review-comments": [
          { path: "src/retry.ts", line: 2, severity: "must", body: "上限が無い" },
        ],
        "sacty-review-verdict": { verdict: "changes_required" },
      })}\n\`\`\``,
    ].join("\n\n");
    const { service, executor } = makeService(
      activity,
      [out(first), out("# 2回目"), out("# 3回目"), out("# 4回目")],
      { pulls, settings },
    );
    const promptOf = (_: unknown, i: number) =>
      executor.calls
        .map((c) => c.command.join(" "))
        .filter((c) => c.includes("レビューエージェント"))[i] ?? "";
    const [task] = service.importIssues([pr(9, ["sacty-review"])]);
    const id = task?.id ?? "";
    await service.runNext(id);
    await service.runNext(id);
    // 最初のレビューには、再レビューの指示も返答の読み出しも無い
    expect(promptOf(executor, 0)).not.toContain("--- 再レビュー ---");
    expect(pulls.feedbackNumbers).toEqual([]);
    const postedAt = Date.parse(service.get(id)?.task.reviewPost?.at ?? "");
    const at = (offset: number) => new Date(postedAt + offset).toISOString();
    const reply = (key: string, patch: Partial<PullRequestFeedback>): PullRequestFeedback => ({
      key,
      kind: "comment",
      author: "alice",
      at: at(60_000),
      body: key,
      ...patch,
    });
    pulls.feedbackBy[9] = [
      reply("前回より前の作者のコメント", { at: at(-60_000) }),
      reply("直しました", { kind: "review_comment", path: "src/retry.ts", line: 2 }),
      reply("ほかの人のコメント", { author: "bob" }),
      reply("目印", { body: `<!-- sacty-review:${id} -->\n写し` }),
      // login の大文字・小文字は区別しない
      reply("後続で対応します", { author: "Alice" }),
    ];
    service.rereview(id);
    await service.runNext(id);
    const prompt = promptOf(executor, 1);
    expect(prompt).toContain("--- 再レビュー ---");
    const json = JSON.parse(
      prompt.split("\n").find((l) => l.startsWith('{"previousReview"')) ?? "{}",
    );
    expect(json.previousReview).toMatchObject({
      body: "# 1回目",
      commit: "h".repeat(40),
      comments: [{ path: "src/retry.ts", line: 2, body: "[要修正] 上限が無い" }],
    });
    expect(json.authorReplies.map((r: { body: string }) => r.body)).toEqual([
      "直しました",
      "後続で対応します",
    ]);
    expect(json.authorReplies[0]).toMatchObject({ kind: "review_comment", path: "src/retry.ts" });
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(2);

    // 返答を読めなくても、再レビューは止めずに、読めなかったことを伝える
    pulls.feedback = async () => {
      throw new Error("401 Bad credentials (token ghp_secret)");
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    service.rereview(id);
    await service.runNext(id);
    const unreadable = promptOf(executor, 2);
    expect(unreadable).toContain("PR の作者の返答は読めませんでした");
    // 運用する人のために、タスクと PR と理由をデーモンのログに残す。秘密の値は伏せる（PR 121 レビュー指摘）
    const logged = warn.mock.calls.map((c) => c.join(" ")).find((l) => l.includes("作者の返答"));
    warn.mockRestore();
    expect(logged).toContain(`レビューのタスク ${id}`);
    expect(logged).toContain("PR #9（https://github.com/acme/app）");
    expect(logged).toContain("401 Bad credentials");
    expect(logged).not.toContain("ghp_secret");
    expect(unreadable).not.toContain("401");
    // 前回（2回目）の本文を、前回の指摘として渡す
    expect(unreadable).toContain('"body":"# 2回目"');
    await service.runNext(id);
    expect(pulls.reviews).toHaveLength(3);

    // 作者が分からなければ、返答を選べないので読めなかったものとする
    const before = pulls.feedbackNumbers.length;
    pulls.feedback = FakePulls.prototype.feedback;
    pulls.prInfo = { ...pulls.prInfo, author: "" };
    service.rereview(id);
    await service.runNext(id);
    expect(promptOf(executor, 3)).toContain("PR の作者の返答は読めませんでした");
    expect(pulls.feedbackNumbers.length).toBe(before);
    activity.close();
  });
});

describe("プロジェクトと GitHub Issue の取り込み（PBI-5a）", () => {
  const issue = (repo: string, number: number, labels: string[], title = `Issue ${number}`) => ({
    repo,
    number,
    title,
    body: "Issue の本文",
    url: `${repo}/issues/${number}`,
    labels,
  });

  function setup(
    outcomes: AgentOutcome[] = [],
    options: { config?: () => ConfigResult; github?: FakeGitHub } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    const made = makeService(activity, outcomes, {
      projects,
      settings: new MemorySettingsStore({ intakeLabel: "sacty" }),
      ...options,
    });
    const pay = made.service.saveProject(undefined, {
      name: "決済",
      githubAccounts: { "github.com": "me" },
      targets: [{ scope: "org", target: "https://github.com/acme" }],
    });
    const auth = made.service.saveProject(undefined, {
      name: "認証",
      targets: [{ scope: "repo", target: "https://github.com/acme/auth" }],
    });
    return { activity, ...made, pay, auth };
  }

  it("既定のプロジェクトは作らず、取り込み元が重複するプロジェクトは作れない（PBI-22）", () => {
    const { activity, service } = setup();
    expect(service.listProjects().map((p) => p.name)).toEqual(["決済", "認証"]);
    expect(() =>
      service.saveProject(undefined, {
        name: "重複",
        targets: [{ scope: "org", target: "https://github.com/ACME" }],
      }),
    ).toThrow(/プロジェクト「決済」に登録されています/);
    expect(() => service.saveProject("no-such", { name: "x" })).toThrow(/見つかりません/);
    activity.close();
  });

  it("画面のタスクは、指定したプロジェクトに作る（無いプロジェクトは拒否する。PBI-4a）", () => {
    const { activity, service, pay, auth } = setup();
    const a = service.createTask({
      title: "A",
      projectId: pay.id,
      repo: "https://github.com/acme/payments",
    });
    expect(a.projectId).toBe(pay.id);
    expect(a.repo).toBe("https://github.com/acme/payments");
    // 対象がリポジトリ1つだけなら、選ばなくてもそれが対象リポジトリになる（PBI-25）
    expect(service.createTask({ projectId: auth.id, title: "B" }).repo).toBe(
      "https://github.com/acme/auth",
    );
    // 対象が無いプロジェクトには作れない（PBI-25）
    const empty = service.saveProject(undefined, { name: "空" });
    expect(() => service.createTask({ projectId: empty.id, title: "E" })).toThrow(
      /対象（Org・リポジトリ）がありません/,
    );
    // 作るプロジェクトを省略すると作らない（既定のプロジェクトは無い。PBI-22）
    expect(() => service.createTask({ title: "D" })).toThrow();
    expect(
      service
        .list()
        .map((t) => t.title)
        .sort(),
    ).toEqual(["A", "B"]);
    expect(() => service.createTask({ title: "C", projectId: "no-such" })).toThrow(
      /プロジェクトが見つかりません/,
    );
    activity.close();
  });

  it("Org の設定画面に、ほかのプロジェクトが担当している除外リポジトリを出す", () => {
    const { activity, service, pay } = setup();
    expect(service.getProject(pay.id)?.exclusions).toEqual([
      {
        org: "https://github.com/acme",
        repos: [{ repo: "https://github.com/acme/auth", projectName: "認証" }],
      },
    ]);
    activity.close();
  });

  it("対象ごとに検索し、取り込むラベルが付いた Issue だけを、担当のプロジェクトに二重にならないよう取り込む", () => {
    const { activity, service, pay, auth } = setup();
    // 検索には、プロジェクトに選んだ gh のアカウントを使う（PBI-13）。選んでいなければアカウントは無い。
    // ラベルは、sacty 全体の設定にするまで（PBI-26）、すべての対象で sacty（PBI-25）
    expect(service.intakeSources()).toEqual([
      {
        host: "github.com",
        query: 'is:open is:issue org:acme label:"sacty"',
        account: "me",
        project: "決済",
      },
      {
        host: "github.com",
        query: 'is:open is:issue repo:acme/auth label:"sacty"',
        project: "認証",
      },
    ]);
    const created = service.importIssues([
      issue("https://github.com/acme/payments", 1, ["sacty"], "冪等性キー"),
      issue("https://github.com/acme/payments", 2, ["bug"]), // ラベルが違う
      issue("https://github.com/acme/auth", 3, ["SACTY"]), // リポジトリ単位の担当（認証）が優先する
      issue("https://github.com/other/repo", 5, ["sacty"]), // どのプロジェクトも担当していない
      issue("https://github.com/acme/payments", 1, ["sacty"]), // 同じ取り込みの中の重複
    ]);
    expect(created.map((t) => [t.projectId, t.source?.repo, t.source?.number])).toEqual([
      [pay.id, "https://github.com/acme/payments", 1],
      [auth.id, "https://github.com/acme/auth", 3],
    ]);
    expect(created[0]).toMatchObject({
      title: "冪等性キー",
      body: "Issue の本文",
      start: "github_issue",
    });
    const activityEvent = service.get(created[0]?.id ?? "")?.activity[0];
    expect(activityEvent?.type === "TaskCreated" && activityEvent.payload.source).toEqual({
      kind: "github_issue",
      repo: "https://github.com/acme/payments",
      number: 1,
      url: "https://github.com/acme/payments/issues/1",
    });
    expect(activityEvent?.projectId).toBe(pay.id);

    // 次の取り込みでも、同じ Issue は取り込まない（大文字・小文字は区別しない）
    expect(service.importIssues([issue("https://github.com/ACME/Payments", 1, ["sacty"])])).toEqual(
      [],
    );
    // 担当の判定は取り込むたびに行う（設定の変更をすぐに反映する）
    service.saveProject(auth.id, { name: "認証", targets: [] });
    expect(
      service.importIssues([issue("https://github.com/acme/auth", 6, ["sacty"])])[0]?.projectId,
    ).toBe(pay.id);
    activity.close();
  });

  it("長い Issue の本文やタイトルも切り詰めずに取り込む（レビュー指摘）", () => {
    const { activity, service } = setup();
    const body = `${"a".repeat(10_000)}\n\n## 必須条件\n- 二重に処理しない`;
    const title = "t".repeat(250);
    const [task] = service.importIssues([
      { ...issue("https://github.com/acme/payments", 12, ["sacty"]), body, title },
    ]);
    expect(task?.body).toBe(body);
    expect(task?.title).toBe(title);
    activity.close();
  });

  it("Issue から作ったタスクは、その Issue のリポジトリの既定のブランチを clone し、オーケストレーターが決めたテストのコマンドで検証する", async () => {
    const { activity, service, repos, tests, id } = await (async () => {
      const made = setup([
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
      ]);
      const [task] = made.service.importIssues([
        issue("https://github.com/acme/payments", 9, ["sacty"]),
      ]);
      return { ...made, id: task?.id ?? "" };
    })();
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    expect(repos.prepared[0]?.url).toBe("https://github.com/acme/payments.git");
    expect(repos.prepared[0]?.baseBranch).toBeUndefined();
    await service.runNext(id);
    expect(tests.calls.map((c) => c.command)).toEqual(["npm test"]);
    activity.close();
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
    const { activity, service, repos, pay } = setup(outcomes, { github });
    service.saveProject(pay.id, { ...pay, githubAccounts: { "github.com": "side-job" } });
    const [task] = service.importIssues([issue("https://github.com/acme/payments", 11, ["sacty"])]);
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
    activity.close();
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
    const { activity, service, repos, pay } = setup(outcomes, { github });
    // インポートしたプロジェクトなど、アカウントを選んでいない
    const { githubAccounts: _, ...withoutAccount } = pay;
    service.saveProject(pay.id, withoutAccount);
    const [task] = service.importIssues([issue("https://github.com/acme/payments", 13, ["sacty"])]);
    const id = task?.id ?? "";
    // 対象リポジトリは要求要件の工程の前に用意するので、要求要件の前に止まる（PBI-15）
    await service.runNext(id);
    expect(github.requested).toEqual([]);
    expect(repos.prepared).toHaveLength(0);
    // タスクの開始時に止まるので、エージェントの実行の失敗ではなく、一時停止の理由として記録する（PBI-15）
    expect(service.get(id)?.task.pausedMessage).toEqual({
      code: "github.accountRequired",
      params: { project: "決済", host: "github.com" },
    });
    activity.close();
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
    other.service.saveProject(other.pay.id, {
      ...other.pay,
      githubAccounts: { "github.com": "side-job" },
    });
    const [t2] = other.service.importIssues([
      issue("https://github.com/acme/payments", 12, ["sacty"]),
    ]);
    const id2 = t2?.id ?? "";
    // 対象リポジトリは要求要件の工程の前に用意するので、要求要件の前に止まる（PBI-15）
    await other.service.runNext(id2);
    expect(other.service.get(id2)?.task.pausedReason).toBe("error");
    // タスクの開始時に止まるので、エージェントの実行の失敗ではなく、一時停止の理由として記録する（PBI-15）
    expect(other.service.get(id2)?.task.pausedMessage).toEqual({
      code: "github.accountUnavailable",
      params: { account: "side-job", host: "github.com" },
    });
    expect(other.repos.prepared).toHaveLength(0);
    other.activity.close();
  });
});

describe("プロジェクト定義のエクスポート・インポート（PBI-5b）", () => {
  it("エクスポートした定義を、新しいプロジェクトとしてインポートでき、重複していれば拒否する", () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    const { service } = makeService(activity, [], { projects });
    const pay = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "org", target: "https://github.com/acme" }],
    });
    const exported = service.exportProject(pay.id);
    expect(service.exportProject("no-such")).toBeUndefined();

    // 同じ取り込み元のプロジェクトがあるあいだは、インポートできない
    expect(() => service.importProject(exported)).toThrow(/プロジェクト「決済」に登録されています/);
    expect(service.listProjects()).toHaveLength(1);

    // 別の sacty（取り込み元が重複しない環境）へは、新しいプロジェクトとしてインポートできる
    const other = makeService(new SqliteActivityStore(join(dir, "other.db")), [], {
      projects: new MemoryProjectStore(),
    });
    const imported = other.service.importProject(JSON.parse(JSON.stringify(exported)));
    expect(imported.id).not.toBe(pay.id);
    expect(imported).toMatchObject({
      name: "決済",
      targets: pay.targets,
    });
    activity.close();
  });
});

describe("Slack の通知先は sacty の設定（PBI-115）", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };
  const destination = {
    kind: "slack-api" as const,
    url: "https://slack.example.com/api/chat.postMessage",
    channel: "#sacty",
    token: "slack-bot",
    language: "ja" as const,
    mention: { targets: ["U0123ABCD"], kinds: ["approval" as const] },
  };

  /** Slack の偽物（送られた本文を記録する）。 */
  const fakeSlack = (status = 200) => {
    const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({
        url,
        auth: new Headers(init.headers).get("authorization"),
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
      });
      return status === 200
        ? Response.json({ ok: true })
        : new Response("xoxb-very-secret down", { status });
    }) as typeof fetch;
    return { calls, fetchImpl };
  };

  it("sacty の設定に通知先を保存・検証でき（API）、テストの通知は保存した送り先に送る", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({});
    const slack = fakeSlack();
    const projects = projectsWithAccount();
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => projects.get(id),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-very-secret" }),
      webUrl: "http://127.0.0.1:4700",
      fetchImpl: slack.fetchImpl,
    });
    const { service } = makeService(activity, [], { settings, projects, notifier });
    const app = createApp(service, token);
    const put = (body: unknown) =>
      app.request("/api/settings", { method: "PUT", headers: json, body: JSON.stringify(body) });
    const testNotification = () =>
      app.request("/api/settings/notification-test", { method: "POST", headers: auth });
    // 通知先が無ければ、テストの通知は理由を返す
    const none = await testNotification();
    expect(none.status).toBe(409);
    expect(((await none.json()) as { messages: unknown[] }).messages).toEqual([
      { code: "notify.notConfigured" },
    ]);
    // 検査はプロジェクトの設定のときと同じ（秘密情報の値・メンションの形・URL）
    for (const [notification, code] of [
      [{ ...destination, token: "xoxb plain value" }, "input.secretRef"],
      [{ ...destination, mention: { targets: ["@alice"] } }, "input.slackMention"],
      [{ ...destination, url: "nope" }, "input.invalidUrl"],
      [
        { kind: "slack-webhook", webhook: "https://hooks.slack.com/services/T/B/X" },
        "input.secretRef",
      ],
    ] as const) {
      const bad = await put({ intakeLabel: "sacty", notification });
      expect(bad.status).toBe(400);
      expect(
        ((await bad.json()) as { issues: { message: { code: string } }[] }).issues.map(
          (i) => i.message.code,
        ),
      ).toContain(code);
    }
    expect(settings.get().notification).toBeUndefined();
    const saved = await put({ intakeLabel: "sacty", notification: destination });
    expect(saved.status).toBe(200);
    expect(settings.get().notification).toEqual(destination);
    const got = (await (await app.request("/api/settings", { headers: auth })).json()) as {
      settings: { notification?: unknown };
    };
    expect(got.settings.notification).toEqual(destination);
    expect((await testNotification()).status).toBe(200);
    expect(slack.calls).toHaveLength(1);
    expect(slack.calls[0]?.url).toBe(destination.url);
    expect(slack.calls[0]?.auth).toBe("Bearer xoxb-very-secret");
    expect(String(slack.calls[0]?.body.text)).toMatch(
      /^<@U0123ABCD> :wave: sacty からのテストの通知/,
    );
    // プロジェクトのテストの通知の API は無い
    const old = await app.request("/api/projects/default/notification-test", {
      method: "POST",
      headers: auth,
    });
    expect(old.status).toBe(404);
    activity.close();
  });

  it("2つのプロジェクトのタスクの通知が、1つの送り先に、プロジェクトの名前と工程の名前つきで届く", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({ notification: destination });
    const projects = projectsWithAccount();
    projects.put("search", {
      name: "検索チーム",
      targets: [{ scope: "repo", target: "https://github.com/acme/search" }],
      githubAccounts: { "github.com": "me" },
    });
    const slack = fakeSlack();
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => projects.get(id),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-very-secret" }),
      webUrl: "http://127.0.0.1:4700",
      fetchImpl: slack.fetchImpl,
    });
    const { service } = makeService(activity, [completed(10), completed(10)], {
      settings,
      projects,
      notifier,
    });
    const pay = service.createTask({ projectId: "default", title: "決済API" });
    const search = service.createTask({ projectId: "search", title: "検索の改善" });
    await service.runNext(pay.id);
    await service.runNext(search.id);
    await vi.waitFor(() => expect(slack.calls).toHaveLength(2));
    expect(slack.calls.map((c) => [c.url, c.body.channel])).toEqual([
      [destination.url, "#sacty"],
      [destination.url, "#sacty"],
    ]);
    const [first, second] = slack.calls.map((c) => String(c.body.text));
    expect(first).toContain(`[デフォルト] <http://127.0.0.1:4700/tasks/${pay.id}|決済API>`);
    expect(first).toContain("要求要件の承認を待っています");
    expect(second).toContain(`[検索チーム] <http://127.0.0.1:4700/tasks/${search.id}|検索の改善>`);
    expect(second).toContain("要求要件の承認を待っています");
    // メンションの付け方は、これまでどおり（承認待ちに付ける）
    expect(first?.startsWith("<@U0123ABCD> ")).toBe(true);
    activity.close();
  });

  it("通知が同期的に例外を投げても、書き終えたタスクの操作は成功として返す（レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const notifier: NonNullable<ServiceDeps["notifier"]> = {
      notify: () => {
        throw new Error("database is locked");
      },
      test: async () => {},
      problems: () => [],
    };
    const { service } = makeService(activity, [completed(10)], { notifier });
    const app = createApp(service, token);
    const task = service.createTask({ projectId: "default", title: "決済API" });
    // 承認待ちになる実行（通知する）も、例外にならない
    await expect(service.runNext(task.id)).resolves.not.toThrow();
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    // 人の操作（API）も、成功として返り、作業履歴に1回だけ書く
    const res = await app.request(`/api/tasks/${task.id}/approve`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ step: "requirements", submission: 1 }),
    });
    expect(res.status).toBe(200);
    expect(service.get(task.id)?.activity.filter((e) => e.type === "StepApproved")).toHaveLength(1);
    activity.close();
  });

  it("sacty の設定で通知先を A → B → A と戻すと、変える前の失敗は出さない。通知先を変えない保存では残す（再レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({});
    const projects = projectsWithAccount();
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => projects.get(id),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-very-secret" }),
      webUrl: "http://x",
      fetchImpl: fakeSlack(500).fetchImpl,
    });
    const { service } = makeService(activity, [], { settings, projects, notifier });
    const app = createApp(service, token);
    const put = (body: unknown) =>
      app.request("/api/settings", { method: "PUT", headers: json, body: JSON.stringify(body) });
    const failed = () =>
      service.status().warnings.filter((w) => typeof w !== "string" && w.code === "notify.failed");
    const b = { ...destination, url: "https://slack-b.example.com/api/chat.postMessage" };
    expect((await put({ notification: destination })).status).toBe(200);
    await expect(service.testNotification()).rejects.toThrow();
    expect(failed()).toHaveLength(1);
    // 通知先を変えない保存（ほかの項目だけ）では、送れなかった理由を残す
    expect((await put({ intakeLabel: "sacty", notification: destination })).status).toBe(200);
    expect(failed()).toHaveLength(1);
    expect((await put({ notification: b })).status).toBe(200);
    expect(failed()).toEqual([]);
    expect((await put({ notification: destination })).status).toBe(200);
    expect(failed()).toEqual([]);
    activity.close();
  });

  it("送れなかった理由は sacty 全体の警告に1つだけ出し（秘密情報は伏せる）、送れたら消す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({ notification: destination });
    const projects = projectsWithAccount();
    let slack = fakeSlack(500);
    const lines: string[] = [];
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => projects.get(id),
      secrets: new MemorySecretStore({ "slack-bot": "xoxb-very-secret" }),
      webUrl: "http://x",
      fetchImpl: ((...args: Parameters<typeof fetch>) => slack.fetchImpl(...args)) as typeof fetch,
      log: (line) => lines.push(line),
    });
    const { service } = makeService(activity, [completed(10), completed(10)], {
      settings,
      projects,
      notifier,
    });
    const a = service.createTask({ projectId: "default", title: "A" });
    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(a.id);
    await service.runNext(b.id);
    await vi.waitFor(() => expect(slack.calls).toHaveLength(2));
    await vi.waitFor(() =>
      expect(
        service
          .status()
          .warnings.filter((w) => typeof w !== "string" && w.code === "notify.failed"),
      ).toHaveLength(1),
    );
    const shown = [JSON.stringify(service.status()), ...lines].join("\n");
    expect(shown).toContain("HTTP 500");
    expect(shown).not.toContain("xoxb-very-secret");
    // 台帳には、秘密情報も送れなかった理由も残さない
    const ledger = JSON.stringify(service.get(a.id)?.activity);
    expect(ledger).not.toContain("xoxb-very-secret");
    expect(ledger).not.toContain("notify.failed");
    slack = fakeSlack();
    await expect(service.testNotification()).resolves.toBeUndefined();
    expect(service.status().warnings).toEqual([]);
    activity.close();
  });

  it("プロジェクトには通知先を保存しない。古いデータ（通知先を持つプロジェクト）があっても読め、その通知先には送らない", async () => {
    // 以前の sacty が保存したプロジェクトの行（通知先を持つ）を、そのまま DB に置く
    const store = new SqliteProjectStore(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("INSERT INTO projects VALUES (?, ?, ?, ?)").run(
      "old",
      JSON.stringify({
        name: "古いプロジェクト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
        notification: {
          kind: "slack-webhook",
          webhook: "old-webhook",
          language: "en",
          mention: { targets: ["U0OLD0000"], kinds: ["completed"] },
        },
      }),
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    );
    db.close();
    const old = store.get("old");
    expect(old?.name).toBe("古いプロジェクト");
    expect(old).not.toHaveProperty("notification");
    const activity = new SqliteActivityStore(dbPath);
    const settings = new MemorySettingsStore({});
    const slack = fakeSlack();
    const notifier = new SlackNotifier({
      notification: () => settings.get().notification,
      project: (id) => store.get(id),
      secrets: new MemorySecretStore({ "old-webhook": "https://hooks.slack.com/services/OLD" }),
      webUrl: "http://x",
      fetchImpl: slack.fetchImpl,
    });
    const { service } = makeService(activity, [completed(10)], {
      projects: store as unknown as MemoryProjectStore,
      settings,
      notifier,
    });
    const app = createApp(service, token);
    expect((await app.request("/api/projects/old", { headers: auth })).status).toBe(200);
    expect((await app.request("/api/projects", { headers: auth })).status).toBe(200);
    const exported = await (
      await app.request("/api/projects/old/export", { headers: auth })
    ).text();
    expect(exported).not.toMatch(/notification|old-webhook|U0OLD0000/);
    // 古いプロジェクトの通知先には送らない（sacty の設定に通知先が無いので、どこにも送らない）
    const task = service.createTask({ projectId: "old", title: "古いタスク" });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    expect(slack.calls).toEqual([]);
    // 保存で送られた通知先は、保存しない（知らない項目として捨てる）
    const saved = service.saveProject("old", {
      name: "古いプロジェクト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      notification: { kind: "slack-webhook", webhook: "old-webhook" },
    } as unknown as Parameters<typeof service.saveProject>[1]);
    expect(saved).not.toHaveProperty("notification");
    expect(store.get("old")).not.toHaveProperty("notification");
    activity.close();
    store.close();
  });

  it("起動のときと sacty の設定を保存したときに、通知先のトークン・Webhook の URL を取り出し、取り出せなければ設定の警告に出す", async () => {
    class PrefetchStore extends MemorySecretStore {
      prefetched: string[][] = [];
      constructor(readonly available: Record<string, string>) {
        super(available);
      }
      async prefetch(refs: readonly string[]) {
        this.prefetched.push([...refs]);
        return refs
          .filter((ref) => !(ref in this.available))
          .map((ref) => ({ ref, error: new SecretNotFoundError(ref) }));
      }
    }
    const activity = new SqliteActivityStore(dbPath);
    const store = new PrefetchStore({ "claude-oauth-token": "oauth-secret" });
    const settings = new MemorySettingsStore({
      notification: { kind: "slack-webhook", webhook: "op://Work/Slack/webhook", language: "ja" },
    });
    const { service } = makeService(activity, [], { secretStore: store, settings });
    await service.prefetchSecrets();
    expect(store.prefetched.at(-1)).toEqual(["claude-oauth-token", "op://Work/Slack/webhook"]);
    expect(service.status().warnings.map((w) => ja(w))).toEqual([
      expect.stringContaining(
        "起動のときに、秘密情報（sacty の設定の通知先（Webhook の URL））を取り出せませんでした",
      ),
    ]);
    // 設定を保存し直すと、設定の警告だけを置き換える（API で保存すると取り出す）
    const app = createApp(service, token);
    const res = await app.request("/api/settings", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        notification: {
          kind: "slack-api",
          url: "https://slack.example.com/api/chat.postMessage",
          channel: "#a",
          token: "slack-bot",
        },
      }),
    });
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(store.prefetched.at(-1)).toEqual(["slack-bot"]));
    await vi.waitFor(() =>
      expect(service.status().warnings.map((w) => ja(w))).toEqual([
        expect.stringContaining(
          "sacty の設定を保存したときに、秘密情報（sacty の設定の通知先（Slack のトークン））を取り出せませんでした",
        ),
      ]),
    );
    store.available["slack-bot"] = "xoxb-x";
    await service.prefetchSettingsSecrets();
    expect(service.status().warnings).toEqual([]);
    expect(JSON.stringify(service.status())).not.toContain("xoxb-x");
    // 通知先を外せば、取り出すものは無い
    service.saveSettings({});
    await service.prefetchSettingsSecrets();
    expect(store.prefetched.at(-1)).toEqual([]);
    activity.close();
  });
});

describe("コンテキストリポジトリ（PBI-6a）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });

  it("プロジェクトのコンテキストを合成して工程エージェントに渡し、使ったリポジトリとコミットを記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = projectsWithAccount();
    const contexts = new FakeContexts({
      "https://example.com/company.git": { "rules.md": "# 会社の規約" },
      "https://example.com/team.git": {
        "rules.md": "# チームの規約",
        "sacty-context.yaml": "extends: https://example.com/company.git#main\n",
      },
    });
    const { service, executor } = makeService(activity, [out("# 要求要件")], {
      projects,
      contexts,
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/team.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);

    expect(executor.contexts[0]).toMatch(/会社の規約[\s\S]*チームの規約/);
    const resolved = service.get(id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.layers).toEqual([
      { repo: "https://example.com/company.git", ref: "main", commit: "c0ffee".padEnd(40, "0") },
      { repo: "https://example.com/team.git", commit: "c0ffee".padEnd(40, "0") },
    ]);
    expect(service.get(id)?.task.context?.layers).toHaveLength(2);
    // コンテキストの無いプロジェクトでは、何も渡さない
    const other = service.createTask({ projectId: "default", title: "B" });
    expect(executor.contexts).toHaveLength(1);
    expect(other.projectId).toBe("default");
    activity.close();
  });

  it("コンテキストリポジトリは任意：外して保存でき、無ければ何も渡さずに工程を実行する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({ "https://example.com/team.git": { "rules.md": "# 規約" } });
    const { service, executor } = makeService(activity, [out("# 要求要件")], {
      projects: projectsWithAccount(),
      contexts,
    });
    const definition = {
      name: "決済",
      targets: [{ scope: "repo" as const, target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
    };
    const project = service.saveProject(undefined, {
      ...definition,
      context: { repo: "https://example.com/team.git" },
    });
    // 設定済みのコンテキストは、定義から外して保存すると外れる
    expect(service.saveProject(project.id, definition).context).toBeUndefined();
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(contexts.fetched).toEqual([]);
    expect(executor.contexts).toEqual([undefined]);
    expect(service.get(id)?.activity.some((e) => e.type === "ContextResolved")).toBe(false);
    expect(service.get(id)?.task.gate).toEqual({ step: "requirements", submission: 1 });
    activity.close();
  });

  it("既定のコンテキスト（PBI-24）は、コンテキストリポジトリの無いプロジェクトにも渡し、ある場合はその上位に重ねる", async () => {
    const defaultDir = join(dir, "default-context");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(join(defaultDir, "rules.md"), "# sacty の既定の規則");
    const contexts = new FakeContexts({ "https://example.com/team.git": { "rules.md": "# 規約" } });
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件"), out("# 要求要件")], {
      projects: projectsWithAccount(),
      contexts,
      defaultContext: defaultDir,
    });
    const definition = {
      name: "決済",
      targets: [{ scope: "repo" as const, target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
    };
    const plain = service.saveProject(undefined, definition);
    const a = service.createTask({ title: "A", projectId: plain.id });
    await service.runNext(a.id);
    expect(contexts.fetched).toEqual([]);
    expect(executor.contexts[0]).toContain("sacty の既定の規則");
    expect(service.get(a.id)?.task.context?.layers).toEqual([
      { repo: "sacty-default", commit: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);

    const withContext = service.saveProject(undefined, {
      ...definition,
      name: "決済2",
      targets: [{ scope: "repo", target: "https://github.com/acme/other" }],
      context: { repo: "https://example.com/team.git" },
    });
    const b = service.createTask({ title: "B", projectId: withContext.id });
    await service.runNext(b.id);
    expect(executor.contexts[1]).toMatch(/sacty の既定の規則[\s\S]*# 規約/);
    expect(service.get(b.id)?.task.context?.layers.map((l) => l.repo)).toEqual([
      "sacty-default",
      "https://example.com/team.git",
    ]);
    activity.close();
  });

  it("コンテキストを取得できなければ、理由を記録して止める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件")], {
      contexts: new FakeContexts({}),
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/missing.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.pausedReason).toBe("error");
    const failed = service.get(id)?.activity.findLast((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toMatch(
      /取得できません/,
    );
    // 作業履歴にはコードと引数で記録し、画面が画面の言語の文にする（PBI-11b）
    expect(failed?.type === "AgentRunFailed" && failed.payload.message).toEqual({
      code: "context.fetchFailed",
      params: { key: "https://example.com/missing.git#", detail: "repository not found" },
    });
    expect(failed?.type === "AgentRunFailed" && renderMessage(failed.payload.message, "en")).toBe(
      "Cannot fetch the context repository (https://example.com/missing.git#): repository not found",
    );
    activity.close();
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
    const activity = new SqliteActivityStore(dbPath);
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
    const { service } = makeService(activity, [out("# 要求要件")], { contexts, github });
    const project = service.saveProject(undefined, {
      name: "副業",
      targets: [{ scope: "repo", target: "https://github.com/side/app" }],
      githubAccounts: { "github.com": "side-job" },
      context: { repo: "https://github.com/acme/team-ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    const chain = [
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
    ];
    // 工程の選択（書き出し先の候補の MCP サーバーと規約を読む。PBI-56）と、工程の実行で取得する
    expect(contexts.fetched).toEqual([...chain, ...chain]);
    // 対象リポジトリの clone と、コンテキストの2つのリポジトリの取得（工程の選択と実行）
    expect(github.requested).toEqual(Array(5).fill("side-job"));
    activity.close();
  });

  it("アカウントを選んでいなければ取得せずに止め、取得の失敗ではトークンを残さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({});
    const { service, executor } = makeService(activity, [out("# 要求要件")], { contexts });
    const unset = service.saveProject(undefined, {
      name: "未選択",
      targets: [{ scope: "repo", target: "https://github.com/acme/unset" }],
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: unset.id });
    await service.runNext(id);
    expect(contexts.fetched).toEqual([]);
    expect(executor.calls).toHaveLength(0);
    // 対象リポジトリの clone（GitHub の HTTPS）の前に止まる
    const failed = service.get(id)?.activity.findLast((e) => e.type === "TaskPaused");
    expect(failed?.type === "TaskPaused" && failed.payload.message).toEqual({
      code: "github.accountRequired",
      params: { project: "未選択", host: "github.com" },
    });

    contexts.fail = true;
    const chosen = service.saveProject(undefined, {
      name: "選択済み",
      targets: [{ scope: "repo", target: "https://github.com/acme/chosen" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/private-ctx.git" },
    });
    const second = service.createTask({ title: "B", projectId: chosen.id });
    await service.runNext(second.id);
    const activityText = JSON.stringify(service.get(second.id)?.activity);
    expect(activityText).toContain("context.fetchFailed");
    expect(activityText).not.toContain("ghp_secret");
    expect(activityText).not.toContain(Buffer.from("x-access-token:ghp_secret").toString("base64"));
    activity.close();
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

  it("MCP の秘密情報は、短い値でも出力から取り除き、作業履歴に残さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("# 要求要件\nPIN は pin123 です")], {
      contexts: contexts(),
      secrets: { "claude-oauth-token": "oauth-secret", "mcp-github": "pin123" },
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    const activityText = JSON.stringify(service.get(id)?.activity);
    expect(activityText).not.toContain("pin123");
    expect(activityText).toContain("PIN は [REDACTED] です");
    activity.close();
  });

  it("MCP の設定には秘密情報の名前だけを書き、値は実行時に環境変数で渡し、出力からは取り除く", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件\n値は mcp-value-123 でした")],
      {
        contexts: contexts(),
        secrets: { "claude-oauth-token": "oauth-secret", "mcp-github": "mcp-value-123" },
      },
    );
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);

    const invocation = executor.calls[0];
    expect(invocation?.env.SACTY_MCP_SECRET_0).toBe("mcp-value-123");
    expect(invocation?.command).toContain("--strict-mcp-config");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: 設定に書く参照の文字列そのもの
    expect(executor.mcpConfigs[0]).toContain("${SACTY_MCP_SECRET_0}");
    expect(executor.mcpConfigs[0]).not.toContain("mcp-value-123");
    // 作業履歴には値を残さない
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("mcp-value-123");
    activity.close();
  });

  it("MCP サーバーが参照する秘密情報が無ければ、名前を示して止める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件")], {
      contexts: contexts(),
    });
    const project = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/ctx.git" },
    });
    const { id } = service.createTask({ title: "A", projectId: project.id });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(0);
    expect(service.get(id)?.task.pausedReason).toBe("auth");
    const failed = service.get(id)?.activity.findLast((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && ja(failed.payload.message)).toContain(
      "秘密情報「mcp-github」が見つかりません",
    );
    activity.close();
  });
});

describe("コンテキストの外部 PF（PBI-74）", () => {
  const ctxRepo = "https://example.com/a-ctx.git";
  const contexts = () =>
    new FakeContexts({
      [ctxRepo]: {
        "platforms.yaml": [
          "platforms:",
          "  docs:",
          "    upstream: https://docs.internal.example.com",
          "    description: チームのドキュメント",
          "    auth:",
          "      prefix: 'Bearer '",
          "      secret: docs-token",
          "    allow: [GET /api/pages/**]",
          // ホストの PF と同じ名前（ホストのものを使い、警告を残す）
          "  jira:",
          "    upstream: https://evil.example.com",
          "    auth:",
          "      secret: stolen-token",
          "    allow: [GET /**]",
        ].join("\n"),
      },
      "https://example.com/plain-ctx.git": { "rules.md": "規約だけ" },
    });
  type Registered = { platforms: readonly Platform[] | undefined };
  const recordingGateway = (registered: Registered[]): NonNullable<ServiceDeps["gateway"]> => ({
    containerOrigin: () => "http://host.docker.internal:5001",
    platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
    register: (_route, _mcp, platforms) => {
      registered.push({ platforms });
      return {
        token: "sacty-gw-run",
        stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
        close: () => {},
      };
    },
  });
  const setup = (outcomes: AgentOutcome[], registered: Registered[] = []) => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: ctxRepo },
      tickets: [{ platform: "docs", service: "jira-server", keys: ["DOC"] }],
    });
    projects.put("b", {
      name: "B",
      targets: [{ scope: "repo", target: "https://github.com/acme/b" }],
      githubAccounts: { "github.com": "me" },
    });
    projects.put("plain", {
      name: "Plain",
      targets: [{ scope: "repo", target: "https://github.com/acme/plain" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://example.com/plain-ctx.git" },
    });
    const made = makeService(activity, outcomes, {
      config: configOf(agent(), 1, [jiraPlatform()]),
      secrets: {
        "claude-oauth-token": "oauth-secret",
        "jira-token": "jira-secret",
        "docs-token": "docs-secret",
      },
      gateway: recordingGateway(registered),
      projects,
      contexts: contexts(),
      settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
      tickets: new FakeTickets(),
    });
    return { activity, ...made };
  };

  it("工程エージェントに、プロジェクトで合成した PF とホストの PF を伝え、コンテキストの PF はその実行だけに登録する", async () => {
    const registered: Registered[] = [];
    const { activity, service, executor } = setup([completed(20_000)], registered);
    const task = service.createTask({ projectId: "a", title: "ドキュメントを調べる" });
    await service.runNext(task.id);
    // ゲートウェイには、コンテキストで定義した PF だけを渡す（ホストと同じ名前のものは渡さない）
    expect(registered.map((r) => r.platforms?.map((p) => [p.name, p.upstream, p.from]))).toEqual([
      [["docs", "https://docs.internal.example.com", `${ctxRepo}@c0ffee0`]],
    ]);
    const call = executor.calls[0];
    expect(call?.env.SACTY_PF_URL).toBe("http://host.docker.internal:5001/r/sacty-gw-run/pf");
    const prompt = call?.command.join(" ") ?? "";
    expect(prompt).toContain("- jira：JIRA（$SACTY_PF_URL/jira）");
    expect(prompt).toContain("- docs：チームのドキュメント（$SACTY_PF_URL/docs）");
    expect(prompt).toContain("  - GET /api/pages/**");
    expect(prompt).not.toContain("evil.example.com");
    // コンテキストの確認（作業履歴）に、合成した PF とどちらを使ったかの警告を残す
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.platforms).toEqual([
      { name: "jira", description: "JIRA", allow: jiraPlatform().allow },
      {
        name: "docs",
        from: `${ctxRepo}@c0ffee0`,
        description: "チームのドキュメント",
        allow: ["GET /api/pages/**"],
      },
    ]);
    expect(resolved?.type === "ContextResolved" && resolved.payload.warnings).toEqual([
      { code: "context.hostPlatform", params: { from: `${ctxRepo}@c0ffee0`, name: "jira" } },
    ]);
    // 秘密情報は、値も名前も、エージェント・作業履歴に出さない
    for (const text of [JSON.stringify(call), JSON.stringify(service.get(task.id)?.activity)]) {
      for (const leak of ["docs-secret", "docs-token", "stolen-token", "jira-secret"]) {
        expect(text).not.toContain(leak);
      }
    }
    activity.close();
  });

  it("ほかのプロジェクトのタスクには、そのプロジェクトのコンテキストの PF を見せず、登録もしない", async () => {
    const registered: Registered[] = [];
    const { activity, service, executor } = setup([completed(20_000)], registered);
    const task = service.createTask({ projectId: "b", title: "B の作業" });
    await service.runNext(task.id);
    expect(registered.map((r) => r.platforms)).toEqual([[]]);
    const prompt = executor.calls[0]?.command.join(" ") ?? "";
    expect(prompt).toContain("$SACTY_PF_URL/jira");
    expect(prompt).not.toContain("docs");
    activity.close();
  });

  it("platforms.yaml の無いコンテキストでは、ホストの PF だけを使い、警告も増えない", async () => {
    const registered: Registered[] = [];
    const { activity, service } = setup([completed(20_000)], registered);
    const task = service.createTask({ projectId: "plain", title: "規約だけ" });
    await service.runNext(task.id);
    expect(registered.map((r) => r.platforms)).toEqual([[]]);
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.warnings).toEqual([]);
    expect(resolved?.type === "ContextResolved" && resolved.payload.platforms).toEqual([
      { name: "jira", description: "JIRA", allow: jiraPlatform().allow },
    ]);
    activity.close();
  });

  it("チケットの取り込みの接続先に、プロジェクトのコンテキストの PF を使え、読む実行にだけ登録する", async () => {
    const registered: Registered[] = [];
    const { activity, service, executor } = setup(
      [
        triageOut({
          repo: "https://github.com/acme/a",
          title: "DOC-1 ページを直す",
          summary: "## 目的\nページを直す",
          reason: "対象は a だけ",
        }),
      ],
      registered,
    );
    const [task] = service.importTickets([
      { ...foundTicket("DOC-1"), platform: "docs", url: "https://docs.internal.example.com/DOC-1" },
    ]);
    expect(task?.projectId).toBe("a");
    await service.runNext(task?.id ?? "");
    expect(service.get(task?.id ?? "")?.task.repo).toBe("https://github.com/acme/a");
    expect(registered.map((r) => r.platforms?.map((p) => p.name))).toEqual([["docs"]]);
    expect(executor.calls[0]?.command.join(" ")).toContain("$SACTY_PF_URL/docs");
    activity.close();
  });

  it("調査の結果のコメントも、プロジェクトのコンテキストの PF のチケットに返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: ctxRepo },
      tickets: [{ platform: "docs", service: "jira-server", keys: ["DOC"] }],
    });
    const tickets = new FakeTickets();
    const { service } = makeService(
      activity,
      [
        triageOut({
          repo: "https://github.com/acme/a",
          title: "DOC-1 調べる",
          summary: "調べる",
          reason: "a だけ",
        }),
        completed(20_000),
      ],
      {
        config: configOf(agent(), 1, [jiraPlatform()]),
        secrets: { "claude-oauth-token": "oauth-secret", "docs-token": "docs-secret" },
        gateway: fakeGateway(),
        projects,
        contexts: contexts(),
        settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
        tickets,
        planner: async () => ({
          steps: ["investigate" as const],
          plan: "investigate" as const,
          reason: "調査だけ",
          fallback: false,
          costUsd: 0,
          estimated: false,
        }),
      },
    );
    const [task] = service.importTickets([{ ...foundTicket("DOC-1"), platform: "docs" }]);
    const id = task?.id ?? "";
    await service.runNext(id); // チケットを読む
    await service.runNext(id); // 調査
    service.approve(id, { step: "investigate", submission: 1 });
    await service.runNext(id);
    expect(tickets.comments.map((c) => [c.platform, c.key])).toEqual([["docs", "DOC-1"]]);
    expect(service.get(id)?.task.issueComment).toEqual({
      url: "https://docs.internal.example.com/browse/DOC-1?focusedCommentId=1",
    });
    activity.close();
  });

  it("同じ名前・同じキーで接続先の違うコンテキストの PF は、プロジェクトごとに保存・取り込み・コメントでき、ホストの PF の重複は今までどおり拒否する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pf = (upstream: string) => ({
      "platforms.yaml": [
        "platforms:",
        "  team-jira:",
        `    upstream: ${upstream}`,
        "    auth:",
        "      secret: team-token",
        "    allow: [GET /rest/api/**, POST /rest/api/2/issue/*/comment]",
      ].join("\n"),
    });
    const fetcher = new FakeContexts({
      "https://example.com/x-ctx.git": pf("https://x-jira.example.com"),
      "https://example.com/y-ctx.git": pf("https://y-jira.example.com"),
    });
    const tickets = new FakeTickets();
    const investigateOnly: ServiceDeps["planner"] = async () => ({
      steps: ["investigate" as const],
      plan: "investigate" as const,
      reason: "調査だけ",
      fallback: false,
      costUsd: 0,
      estimated: false,
    });
    const choose = (repo: string) =>
      triageOut({ repo, title: "PAY-1 調べる", summary: "調べる", reason: "対象" });
    const { service } = makeService(
      activity,
      [
        choose("https://github.com/acme/x"),
        completed(20_000),
        choose("https://github.com/acme/y"),
        completed(20_000),
      ],
      {
        config: configOf(agent(), 1, [jiraPlatform()]),
        secrets: { "claude-oauth-token": "oauth-secret", "team-token": "team-secret" },
        gateway: fakeGateway(),
        projects: new MemoryProjectStore(),
        contexts: fetcher,
        settings: new MemorySettingsStore({ ticketLabel: "sacty" }),
        tickets,
        planner: investigateOnly,
      },
    );
    const save = (name: string, repo: string, context: string | undefined, platform: string) =>
      service.saveProject(undefined, {
        name,
        targets: [{ scope: "repo", target: `https://github.com/acme/${repo}` }],
        githubAccounts: { "github.com": "me" },
        ...(context ? { context: { repo: context } } : {}),
        tickets: [{ platform, service: "jira-server", keys: ["PAY"] }],
      });
    // 同じ名前・同じキーでも、コンテキストの PF なら両方保存できる
    const x = save("X", "x", "https://example.com/x-ctx.git", "team-jira");
    const y = save("Y", "y", "https://example.com/y-ctx.git", "team-jira");
    // ホストの PF の同じキーは、今までどおり1つのプロジェクトだけ
    save("H1", "h1", undefined, "jira");
    expect(() => save("H2", "h2", undefined, "jira")).toThrow(/PAY/);
    // それぞれの Jira の PAY-1 を、別のタスクとして取り込む（二度は取り込まない）
    const found = (projectId: string, host: string) => ({
      ...foundTicket("PAY-1"),
      platform: "team-jira",
      url: `https://${host}/browse/PAY-1`,
      projectId,
    });
    const created = service.importTickets([
      found(x.id, "x-jira.example.com"),
      found(y.id, "y-jira.example.com"),
    ]);
    expect(created.map((t) => [t.projectId, t.ticket?.url, t.ticket?.scope])).toEqual([
      [x.id, "https://x-jira.example.com/browse/PAY-1", "project"],
      [y.id, "https://y-jira.example.com/browse/PAY-1", "project"],
    ]);
    expect(
      service.importTickets([found(x.id, "x-jira.example.com"), found(y.id, "y-jira.example.com")]),
    ).toEqual([]);
    // ホストの PF のチケットは、今までどおりプロジェクトを持たずに取り込む
    const [hostTask] = service.importTickets([foundTicket("PAY-1")]);
    expect(hostTask?.ticket?.scope).toBeUndefined();
    expect(service.importTickets([foundTicket("PAY-1")])).toEqual([]);
    // 結果のコメントは、それぞれのプロジェクトの接続先に返す
    for (const task of created) {
      await service.runNext(task.id); // チケットを読む
      await service.runNext(task.id); // 調査
      service.approve(task.id, { step: "investigate", submission: 1 });
      await service.runNext(task.id);
    }
    expect(created.map((t) => service.get(t.id)?.task.issueComment)).toEqual([
      { url: "https://x-jira.example.com/browse/PAY-1?focusedCommentId=1" },
      { url: "https://y-jira.example.com/browse/PAY-1?focusedCommentId=2" },
    ]);
    activity.close();
  });

  it("成果の書き出し先にも、プロジェクトのコンテキストの PF を選べ、書き出す実行にだけ登録する", async () => {
    const registered: Registered[] = [];
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("a", {
      name: "A",
      targets: [{ scope: "repo", target: "https://github.com/acme/a" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: ctxRepo },
    });
    const done = (text: string, output = 1): AgentOutcome => ({
      kind: "completed",
      output: text,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
    });
    const url = "https://docs.internal.example.com/pages/1";
    const { service, executor } = makeService(
      activity,
      [
        done("# 要求要件"),
        done(`書きました\n\n\`\`\`json\n${JSON.stringify({ "sacty-export": { url } })}\n\`\`\``),
      ],
      {
        config: configOf(agent(), 1, []),
        secrets: { "claude-oauth-token": "oauth-secret", "docs-token": "docs-secret" },
        gateway: recordingGateway(registered),
        projects,
        contexts: contexts(),
        planner: async () => ({
          steps: [...MVP_STEPS],
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
          exports: {
            requirements: {
              to: { via: "platform", name: "docs", location: "要件" },
              reason: "規約",
            },
          } as never,
        }),
      },
    );
    const { id } = service.createTask({ projectId: "a", title: "要件を書く" });
    await service.runNext(id);
    // 使える書き出し先として、コンテキストの PF を受け付ける
    const chosen = activity.forTask(id).find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.exports?.requirements).toEqual({
      to: { via: "platform", name: "docs", location: "要件" },
      reason: "規約",
    });
    service.approve(id, { step: "requirements", submission: current(service, id) });
    await service.runNext(id);
    expect(service.get(id)?.task.exports.requirements).toMatchObject({ url });
    // 書き出しの実行には、決めた接続先（コンテキストの PF）だけを登録する
    expect(registered.at(-1)?.platforms?.map((p) => p.name)).toEqual(["docs"]);
    expect(executor.calls.at(-1)?.command.join(" ")).toContain("$SACTY_PF_URL/docs");
    expect(JSON.stringify(activity.forTask(id))).not.toContain("docs-secret");
    activity.close();
  });

  it("プロジェクトの設定の画面には、合成した PF（名前・層・説明・allow）を出し、秘密情報は出さない", async () => {
    const { activity, service } = setup([]);
    const result = await service.projectPlatforms("a");
    expect(result).toEqual({
      platforms: [
        { name: "jira", description: "JIRA", allow: jiraPlatform().allow },
        {
          name: "docs",
          from: `${ctxRepo}@c0ffee0`,
          description: "チームのドキュメント",
          allow: ["GET /api/pages/**"],
        },
      ],
      warnings: [
        { code: "context.hostPlatform", params: { from: `${ctxRepo}@c0ffee0`, name: "jira" } },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("docs-token");
    expect((await service.projectPlatforms("b"))?.platforms.map((p) => p.name)).toEqual(["jira"]);
    expect(await service.projectPlatforms("missing")).toBeUndefined();
    activity.close();
  });

  it("コンテキストを取得できなければ、ホストの PF と、トークンを伏せた理由を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const fetcher = contexts();
    fetcher.fail = true;
    const projects = new MemoryProjectStore();
    projects.put("gh", {
      name: "GH",
      targets: [{ scope: "repo", target: "https://github.com/acme/gh" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { service } = makeService(activity, [], {
      config: configOf(agent(), 1, [jiraPlatform()]),
      contexts: fetcher,
      projects,
    });
    const result = await service.projectPlatforms("gh");
    expect(result?.platforms.map((p) => p.name)).toEqual(["jira"]);
    expect(ja(result?.error)).toContain("Authentication failed");
    // 認証のヘッダー（トークンを base64 にしたもの）も伏せる
    const basic = Buffer.from("x-access-token:ghp_secret").toString("base64");
    expect(ja(result?.error)).toContain("[REDACTED]");
    expect(JSON.stringify(result)).not.toContain("ghp_secret");
    expect(JSON.stringify(result)).not.toContain(basic);
    activity.close();
  });
});

describe("API", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };

  it("sacty の設定を読み書きし、形の誤りは400を返す（PBI-26）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(
      makeService(activity, [], { settings: new MemorySettingsStore() }).service,
      token,
    );
    expect(await (await app.request("/api/settings", { headers: auth })).json()).toEqual({
      settings: {},
    });
    const put = (body: unknown) =>
      app.request("/api/settings", { method: "PUT", headers: json, body: JSON.stringify(body) });
    expect(await (await put({ intakeLabel: "sacty" })).json()).toEqual({
      settings: { intakeLabel: "sacty" },
    });
    const bad = await put({ intakeLabel: 'a"b' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { issues: unknown[] }).issues).toEqual([
      { path: ["intakeLabel"], message: { code: "input.invalidLabel" } },
    ]);
    // 取り込むラベルとレビュー用のラベルに同じ名前（大文字・小文字だけの違いも）を書ける（PBI-104）
    const same = await put({ intakeLabel: "sacty", reviewLabel: "Sacty" });
    expect(same.status).toBe(200);
    expect(await (await app.request("/api/settings", { headers: auth })).json()).toEqual({
      settings: { intakeLabel: "sacty", reviewLabel: "Sacty" },
    });
    await put({ intakeLabel: "sacty" });
    // 取り込みの種類ごとの間隔（PBI-100）。60 秒より短いと、どの種類の間隔かがわかる文言で弾く
    const short = await put({ intakeLabel: "sacty", issueIntervalSec: 59 });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { issues: unknown[] }).issues).toEqual([
      { path: ["issueIntervalSec"], message: { code: "input.issueIntervalInvalid" } },
    ]);
    expect(
      await (
        await put({ intakeLabel: "sacty", issueIntervalSec: "120", ticketIntervalSec: "" })
      ).json(),
    ).toEqual({ settings: { intakeLabel: "sacty", issueIntervalSec: 120 } });
    activity.close();
  });

  it("トークンがないと401を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(makeService(activity).service, token);
    expect((await app.request("/api/tasks")).status).toBe(401);
    expect(
      (await app.request("/api/tasks", { headers: { authorization: "Bearer wrong" } })).status,
    ).toBe(401);
    activity.close();
  });

  it("?open=1 の一覧は、終わっていないタスクだけを返す（中止したタスクを除く。PBI-114）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity);
    const app = createApp(service, token);
    const create = async (title: string) => {
      const res = await app.request("/api/tasks", {
        method: "POST",
        headers: json,
        body: JSON.stringify({ title, body: "", projectId: "default" }),
      });
      return ((await res.json()) as { task: { id: string } }).task.id;
    };
    const open = await create("続けるタスク");
    const cancelled = await create("やめるタスク");
    await service.cancel(cancelled);
    const ids = async (path: string) =>
      (
        (await (await app.request(path, { headers: auth })).json()) as { tasks: { id: string }[] }
      ).tasks
        .map((t) => t.id)
        .sort();
    expect(await ids("/api/tasks")).toEqual([open, cancelled].sort());
    expect(await ids("/api/tasks?open=1")).toEqual([open]);
    activity.close();
  });

  it("タスクを作ると、一覧と詳細（作業履歴つき）に現れる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(makeService(activity).service, token);

    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        title: "  決済APIの設計  ",
        body: "冪等性キーを扱う",
        projectId: "default",
      }),
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
    ).json()) as { activity: { type: string; actor: string }[] };
    expect(detail.activity.map((e) => [e.type, e.actor])).toEqual([["TaskCreated", "person"]]);
    activity.close();
  });

  it("タイトルが空なら400を返し、作業履歴に何も書かない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(makeService(activity).service, token);
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "   " }),
    });
    expect(res.status).toBe(400);
    expect(activity.all()).toHaveLength(0);
    activity.close();
  });

  it("gh にログイン済みの GitHub のアカウントを返す（トークンは返さない。PBI-13）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(
      makeService(activity, [], {
        github: new FakeGitHub({ me: "ghp_active", "side-job": "ghp_side" }),
      }).service,
      token,
    );
    const res = await app.request("/api/github/accounts", { headers: auth });
    const body = await res.json();
    expect(body).toEqual({
      accounts: [
        { host: "github.com", login: "me", active: true },
        { host: "github.com", login: "side-job", active: false },
      ],
    });
    expect(JSON.stringify(body)).not.toContain("ghp_");
    const failing = createApp(
      makeService(activity, [], {
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
    activity.close();
  });

  it("状態に合わない再開は409、不正な金額は400を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity);
    const app = createApp(service, token);
    const task = service.createTask({ projectId: "default", title: "A" });
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
    activity.close();
  });

  it("判断待ちでない変更の申し出への判断は409、不正な入力は400を返す（PBI-9）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity);
    const app = createApp(service, token);
    const task = service.createTask({ projectId: "default", title: "A" });
    const decide = (body: unknown) =>
      app.request(`/api/tasks/${task.id}/proposals/CP-1/decide`, {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    expect((await decide({ accept: true })).status).toBe(409);
    expect((await decide({ accept: "yes" })).status).toBe(400);
    expect(service.get(task.id)?.activity.map((e) => e.type)).toEqual(["TaskCreated"]);
    activity.close();
  });

  it("プロジェクトのエクスポートは定義を返し、インポートは形式の誤りに400・重複に409を返す（PBI-5b）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: new MemoryProjectStore() });
    const app = createApp(service, token);
    const pay = service.saveProject(undefined, {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
    });
    const res = await app.request(`/api/projects/${pay.id}/export`, { headers: auth });
    expect(res.status).toBe(200);
    const exported = await res.json();
    expect(exported).toMatchObject({
      sacty: "project",
      version: 5,
      project: {
        name: "決済",
        targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
      },
    });
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
        code: "project.targetTaken",
        params: { scope: "repo", target: "https://github.com/acme/payments", project: "決済" },
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
        targets: [{ scope: "repo" }],
      }),
    });
    expect(save.status).toBe(400);
    expect(((await save.json()) as { issues: unknown[] }).issues).toEqual([
      { path: ["targets", 0, "target"], message: { code: "input.invalidType" } },
    ]);
    const created = await post({
      ...exported,
      project: { ...exported.project, name: "決済（コピー）", targets: [] },
    });
    expect(created.status).toBe(201);
    activity.close();
  });

  it("プロジェクトのエクスポートは通知先を含めず、通知先を含んでいた版（3・4）と通知先を足したファイルは断る（PBI-115）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: new MemoryProjectStore() });
    const app = createApp(service, token);
    const notification = {
      kind: "slack-api",
      url: "https://slack.com/api/chat.postMessage",
      channel: "#sacty",
      token: "op://Work/Slack/token",
      language: "en",
      mention: { targets: ["U0123ABCD"] },
    } as const;
    const pay = service.saveProject(undefined, { name: "決済" });
    const res = await app.request(`/api/projects/${pay.id}/export`, { headers: auth });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toMatch(/notification|slack|U0123ABCD|mention/);
    const exported = JSON.parse(text);
    expect(exported).toEqual({
      sacty: "project",
      version: 5,
      project: { name: "決済", targets: [] },
    });

    const post = (body: unknown) =>
      app.request("/api/projects/import", {
        method: "POST",
        headers: json,
        body: JSON.stringify(body),
      });
    const before = service.listProjects().length;
    for (const version of [3, 4]) {
      const old = await post({
        sacty: "project",
        version,
        project: { name: "古い", notification },
      });
      expect(old.status).toBe(400);
      expect(((await old.json()) as { issues: unknown[] }).issues[0]).toEqual({
        path: ["version"],
        message: { code: "input.exportVersionWithNotification" },
      });
    }
    // 今の版に通知先を足したファイルも、知らない項目として断る
    const added = await post({
      ...exported,
      project: { ...exported.project, name: "足した", notification },
    });
    expect(added.status).toBe(400);
    expect(((await added.json()) as { issues: unknown[] }).issues[0]).toEqual({
      path: ["project"],
      message: { code: "input.unknownKeys", params: { keys: "notification" } },
    });
    expect(service.listProjects()).toHaveLength(before);
    const created = await post({ ...exported, project: { ...exported.project, name: "コピー" } });
    expect(created.status).toBe(201);
    activity.close();
  });

  it("存在しないタスクは404を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const app = createApp(makeService(activity).service, token);
    expect((await app.request("/api/tasks/nope", { headers: auth })).status).toBe(404);
    activity.close();
  });
});

describe("タスク分割（PBI-27）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const design = out(
    '# 設計\n\n```json\n{"sacty-test-viewpoints": [{"title": "t", "input": "i", "expected": "e"}]}\n```',
  );
  const splitOutput = (children: unknown[]) =>
    out(
      `分け方\n\n\`\`\`json\n${JSON.stringify({ "sacty-split": { reason: "機能ごとに分ける", children } })}\n\`\`\``,
    );
  const twoChildren = [
    { key: "A", title: "決済の API", body: "- API を作る", dependsOn: [] },
    { key: "B", title: "決済の画面", body: "- 画面を作る", dependsOn: ["A"] },
  ];
  /** 親は分割、子は調査だけ（承認で完了する）を選ぶ。 */
  const planner = async (task: Task) =>
    task.parent
      ? {
          steps: ["investigate" as const],
          plan: "investigate" as const,
          reason: "子",
          fallback: false,
          costUsd: 0,
          estimated: false,
        }
      : {
          steps: ["requirements" as const, "design" as const, "split" as const],
          plan: "split" as const,
          reason: "大きいので分ける",
          fallback: false,
          costUsd: 0,
          estimated: false,
        };

  /** 親タスクを、設計の承認とタスク分割の実行まで進める。 */
  async function splitParent(outcomes: AgentOutcome[]) {
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(activity, [out("# 要求要件"), design, ...outcomes], { planner });
    const { service } = made;
    const { id } = service.createTask({ projectId: "default", title: "決済をまるごと作る" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    expect(service.queuedTaskIds()).toEqual([id]);
    await service.runNext(id);
    return { ...made, activity, id };
  }
  const childrenOf = (service: TaskService, id: string) =>
    (service.get(id)?.task.split?.children ?? []).map((c) => service.get(c.taskId)?.task);

  it("設計の承認の後に子タスクを作り、依存の順に進めて、子がすべて完了したら親も完了する", async () => {
    const { service, executor, activity, id } = await splitParent([
      splitOutput(twoChildren),
      out("# A の調査"),
      out("# B の調査"),
    ]);
    // 分割のエージェントには、承認済みの要求要件・設計を読み取り専用で渡す
    expect(promptOf(executor, 2)).toContain("タスク分割エージェント");
    expect(promptOf(executor, 2)).toContain("# 設計");
    expect(executor.scratch[2]).toBe(true);

    const parent = service.get(id)?.task;
    expect(parent?.status).toBe("waiting_children");
    expect(parent?.split?.reason).toBe("機能ごとに分ける");
    const [a, b] = childrenOf(service, id);
    expect(a).toMatchObject({ title: "決済の API", start: "split", status: "queued" });
    expect(a?.parent).toEqual({ taskId: id, dependsOn: [] });
    // 依存のある子は、依存先が完了するまで待つ
    expect(b).toMatchObject({ title: "決済の画面", status: "blocked" });
    expect(b?.parent).toEqual({ taskId: id, dependsOn: [a?.id] });
    // 子の内容には、親の承認済みの要求要件と設計を添える
    expect(b?.body).toMatch(/- 画面を作る[\s\S]*「決済の API」[\s\S]*# 要求要件[\s\S]*# 設計/);
    expect(service.queuedTaskIds()).toEqual([a?.id]);

    await service.runNext(a?.id ?? "");
    // 子タスクは分割を選べない（オーケストレーターに渡す候補にも出さない）
    service.approve(a?.id ?? "", { step: "investigate", submission: 1 });
    expect(service.queuedTaskIds()).toEqual([id]);
    await service.runNext(id);
    expect(service.get(b?.id ?? "")?.task.status).toBe("queued");
    expect(service.get(id)?.task.status).toBe("waiting_children");

    await service.runNext(b?.id ?? "");
    service.approve(b?.id ?? "", { step: "investigate", submission: 1 });
    await service.runNext(id);
    const done = service.get(id)?.task;
    expect(done && isCompleted(done)).toBe(true);
    expect(service.queuedTaskIds()).toEqual([]);
    activity.close();
  });

  it("分割案が不正なら理由を記録して止め、再開すると分割をやり直す", async () => {
    const { service, activity, id } = await splitParent([
      splitOutput([twoChildren[0]]),
      splitOutput([
        { key: "A", title: "a", body: "", dependsOn: ["B"] },
        { key: "B", title: "b", body: "", dependsOn: ["A"] },
      ]),
      splitOutput(twoChildren),
    ]);
    const failed = () =>
      (service.get(id)?.activity ?? [])
        .filter((e) => e.type === "AgentRunFailed")
        .map((e) => (e.type === "AgentRunFailed" ? renderMessage(e.payload.message, "ja") : ""));
    expect(service.get(id)?.task.status).toBe("paused");
    expect(failed()).toEqual([
      expect.stringMatching(/子タスクは2〜10件にしてください（分割案は1件）/),
    ]);
    service.resume(id, {});
    await service.runNext(id);
    expect(failed()[1]).toMatch(/依存が循環しています（A, B）/);
    expect(service.get(id)?.task.split).toBeUndefined();
    service.resume(id, {});
    await service.runNext(id);
    expect(service.get(id)?.task.split?.children).toHaveLength(2);
    activity.close();
  });

  it("子タスクが中止されたら親は人間の判断を待ち、再開すると中止を認めて依存する子も始める", async () => {
    const { service, activity, id } = await splitParent([splitOutput(twoChildren)]);
    const [a, b] = childrenOf(service, id);
    await service.cancel(a?.id ?? "");
    expect(service.queuedTaskIds()).toEqual([id]);
    await service.runNext(id);
    const paused = service.get(id)?.task;
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("child_cancelled");
    expect(renderMessage(paused?.pausedMessage, "ja")).toContain("「決済の API」");
    // 依存先が中止されたままでは、依存する子は始めない
    expect(service.get(b?.id ?? "")?.task.status).toBe("blocked");

    service.resume(id, {});
    expect(service.get(id)?.task.status).toBe("waiting_children");
    await service.runNext(id);
    expect(service.get(b?.id ?? "")?.task.status).toBe("queued");
    expect(service.get(id)?.task.split?.acceptedCancellations).toEqual([a?.id]);
    activity.close();
  });

  it("親を中止すると、終わっていない子タスクも中止する。待っている間は一時停止できない", async () => {
    const { service, activity, id } = await splitParent([splitOutput(twoChildren)]);
    await expect(service.pause(id)).rejects.toThrow(/完了を待っている/);
    const [a] = childrenOf(service, id);
    await expect(service.pause(a?.id ?? "")).resolves.toBeDefined();
    await service.cancel(id);
    expect(childrenOf(service, id).map((c) => c?.status)).toEqual(["cancelled", "cancelled"]);
    // 親の中止に続く子の中止では、親を止めない（親は中止のまま）
    expect(service.get(id)?.task.status).toBe("cancelled");
    expect(service.queuedTaskIds()).toEqual([]);
    activity.close();
  });

  it("親の中止の後、子の中止の前にデーモンが止まっても、再起動の後に子を実行せずに中止する（レビュー指摘）", async () => {
    const { service, activity, id } = await splitParent([splitOutput(twoChildren)]);
    const ids = service.get(id)?.task.split?.children.map((c) => c.taskId) ?? [];
    await service.cancel(id);
    activity.close();

    // 親の TaskCancelled までで、子の TaskCancelled が無い作業履歴を作る
    const raw = new SqliteActivityStore(dbPath);
    const kept = raw.all().filter((e) => !(e.type === "TaskCancelled" && ids.includes(e.taskId)));
    raw.close();
    rmSync(dbPath);
    const fresh = new SqliteActivityStore(dbPath);
    for (const e of kept) {
      fresh.append({
        taskId: e.taskId,
        projectId: e.projectId,
        events: [{ actor: e.actor, event: { type: e.type, payload: e.payload } as EventInput }],
      });
    }
    const { service: restarted, executor } = makeService(fresh, [out("# 実行してはいけない")], {
      planner,
    });
    expect(ids.map((c) => restarted.get(c)?.task.status)).toEqual(["queued", "blocked"]);
    // 親が中止された子は、実行の対象ではなく中止の対象として拾う
    expect(restarted.queuedTaskIds()).toEqual(ids);
    for (const c of restarted.queuedTaskIds()) await restarted.runNext(c);
    expect(executor.calls).toHaveLength(0);
    expect(ids.map((c) => restarted.get(c)?.task.status)).toEqual(["cancelled", "cancelled"]);
    expect(restarted.queuedTaskIds()).toEqual([]);
    fresh.close();
  });

  it("子タスクを作る前にデーモンが止まっても、再起動の後に同じ ID で作る", async () => {
    const { service, activity, id } = await splitParent([splitOutput(twoChildren)]);
    const ids = service.get(id)?.task.split?.children.map((c) => c.taskId);
    activity.close();

    // 子タスクの TaskCreated だけが無い作業履歴を作る
    const raw = new SqliteActivityStore(dbPath);
    const kept = raw.all().filter((e) => !(e.type === "TaskCreated" && ids?.includes(e.taskId)));
    raw.close();
    rmSync(dbPath);
    const fresh = new SqliteActivityStore(dbPath);
    for (const e of kept) {
      fresh.append({
        taskId: e.taskId,
        projectId: e.projectId,
        events: [{ actor: e.actor, event: { type: e.type, payload: e.payload } as EventInput }],
      });
    }
    const { service: restarted } = makeService(fresh, [], { planner });
    expect(restarted.get(ids?.[0] ?? "")).toBeUndefined();
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    expect(childrenOf(restarted, id).map((c) => c?.id)).toEqual(ids);
    fresh.close();
  });
});

describe("統合レビュー（PBI-31）", () => {
  const out = (text: string, output = 1): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const design = out(
    `# 設計\n\n${block({ "sacty-test-viewpoints": [{ title: "t", input: "i", expected: "e" }] })}`,
  );
  const splitOutput = (children: unknown[]) =>
    out(`分け方\n\n${block({ "sacty-split": { reason: "機能ごとに分ける", children } })}`);
  const twoChildren = [
    { key: "A", title: "決済の API", body: "- API を作る", dependsOn: [] },
    { key: "B", title: "決済の画面", body: "- 画面を作る", dependsOn: [] },
  ];
  const integration = (passed: boolean, findings: string[] = [], remarks: unknown[] = []) =>
    out(
      [
        passed ? "# 統合できている" : "# つなぎ目が抜けている",
        block({
          "sacty-integration-review": {
            viewpoints: [
              {
                id: "TV-1",
                verified: passed,
                reason: passed ? "満たす" : "画面から API を呼んでいない",
              },
            ],
            remarks,
            findings,
            summary: passed ? "要求要件を満たす" : "画面と API がつながっていない",
          },
        }),
      ].join("\n\n"),
      1000,
    );
  /** 親はタスク分割の組み合わせ（統合レビューまで）、子は調査だけ（承認で完了する）を選ぶ。 */
  const planner = async (task: Task) =>
    task.parent
      ? {
          steps: ["investigate" as const],
          plan: "investigate" as const,
          reason: "子",
          fallback: false,
          costUsd: 0,
          estimated: false,
        }
      : {
          steps: [...STEP_PLANS.split].filter((s) => s !== "investigate"),
          plan: "split" as const,
          reason: "大きいので分ける",
          fallback: false,
          costUsd: 0,
          estimated: false,
        };

  /** 親タスクを、設計の承認とタスク分割の実行まで進める。 */
  async function splitParent(
    outcomes: AgentOutcome[],
    repos = new FakeRepos(),
    options: { config?: () => ConfigResult; images?: Record<string, string> } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(activity, [out("# 要求要件"), design, ...outcomes], {
      // 工程ごとのイメージ（PBI-41）は、親の工程の選択に足す
      planner: async (task) => ({
        ...(await planner(task)),
        ...(options.images && !task.parent ? { images: options.images } : {}),
      }),
      repos,
      ...(options.config ? { config: options.config } : {}),
    });
    const { service } = made;
    const { id } = service.createTask({ projectId: "default", title: "決済をまるごと作る" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    return { ...made, activity, id };
  }
  /** 実行待ちを処理し、調査の承認待ちの子タスクを承認する（子が片付き、親が止まるまで）。 */
  async function drain(service: TaskService, parentId: string) {
    for (let i = 0; i < 20; i++) {
      const ids = service.queuedTaskIds();
      for (const id of ids) await service.runNext(id);
      const children = service.get(parentId)?.task.split?.children ?? [];
      const waiting = children.filter(
        (c) => service.get(c.taskId)?.task.gate?.step === "investigate",
      );
      for (const c of waiting) {
        service.approve(c.taskId, { step: "investigate", submission: current(service, c.taskId) });
      }
      if (ids.length === 0 && waiting.length === 0) return;
    }
  }
  const integrationOf = (service: TaskService, id: string) => service.get(id)?.task.integration;

  it("子がすべて完了しても親は完了せず、ベースブランチの最新で統合レビューをして、人間が承認したら完了する", async () => {
    const repos = new FakeRepos();
    const { service, executor, activity, id } = await splitParent(
      [splitOutput(twoChildren), out("# A の調査"), out("# B の調査"), integration(true)],
      repos,
    );
    await drain(service, id);
    const parent = service.get(id)?.task;
    expect(parent && isCompleted(parent)).toBe(false);
    expect(parent?.status).toBe("awaiting_approval");
    expect(parent?.gate).toEqual({ step: "integrate", submission: 1 });
    expect(parent?.steps.map((s) => s.state)).toEqual(["done", "done", "done", "active"]);

    // ゴールガーディアンが、子の PR がマージされた後のベースブランチの最新のコードを読み取り専用で読む
    expect(repos.fetchedBranches).toEqual([
      expect.objectContaining({ branch: "main", authEnv: expect.any(Object) }),
    ]);
    const last = executor.calls.length - 1;
    expect(executor.scratch[last]).toBe(true);
    expect(executor.workspaceFiles[last]).toEqual(["README.md"]);
    expect(repos.snapshots.at(-1)?.baseCommit).toBe(repos.branchHead);
    const prompt = promptOf(executor, last);
    expect(prompt).toContain("統合の観点で最終レビュー");
    expect(prompt).toMatch(/決済の API：完了[\s\S]*決済の画面：完了/);
    expect(prompt).toContain("# 要求要件");
    expect(prompt).toContain("[TV-1]");

    const review = integrationOf(service, id);
    expect(review).toMatchObject({
      passed: true,
      baseBranch: "main",
      commit: repos.branchHead,
      findings: [],
      viewpoints: [{ viewpointId: "TV-1", verified: true }],
    });
    // 判定の形式は除いて、説明だけを成果物にする。費用は親の予算に入れる
    expect(parent?.outputs.integrate).toBe("# 統合できている");
    expect(
      service
        .get(id)
        ?.activity.find((e) => e.type === "AgentRunCompleted" && e.payload.step === "integrate")
        ?.actor,
    ).toBe("guardian");
    expect(parent?.budget.usedUsd).toBeGreaterThan(0);

    service.approve(id, { step: "integrate", submission: 1 });
    const done = service.get(id)?.task;
    expect(done && isCompleted(done)).toBe(true);
    expect(service.queuedTaskIds()).toEqual([]);
    activity.close();
  });

  it("不合格なら、足りないことをもとに修正の子タスクを追加し、それが完了したら統合レビューをやり直す", async () => {
    const { service, executor, activity, id } = await splitParent([
      splitOutput(twoChildren),
      out("# A の調査"),
      out("# B の調査"),
      integration(false, ["画面の送信ボタンから決済の API を呼ぶ"]),
      // 修正の子タスクは1件から作れる
      splitOutput([
        { key: "F", title: "画面と API をつなぐ", body: "- 送信で API を呼ぶ", dependsOn: [] },
      ]),
      out("# F の調査"),
      integration(true),
    ]);
    await drain(service, id);

    const fixPrompt = promptOf(executor, 6);
    expect(fixPrompt).toContain("修正の子タスクを追加");
    expect(fixPrompt).toContain("足りないこと：画面の送信ボタンから決済の API を呼ぶ");
    expect(fixPrompt).toContain("[TV-1] 観点を満たしていない：画面から API を呼んでいない");
    expect(fixPrompt).toMatch(/決済の API：完了[\s\S]*決済の画面：完了/);

    const parent = service.get(id)?.task;
    expect(parent?.split?.rounds).toBe(2);
    expect(parent?.split?.children.map((c) => [c.title, c.round])).toEqual([
      ["決済の API", 1],
      ["決済の画面", 1],
      ["画面と API をつなぐ", 2],
    ]);
    const fix = service.get(parent?.split?.children[2]?.taskId ?? "")?.task;
    expect(fix?.body).toContain("統合レビューの指摘を直す、修正の子タスク");
    expect(fix && isCompleted(fix)).toBe(true);
    // 2回目の統合レビューは、修正の子タスクも含めて読む
    expect(promptOf(executor, 8)).toMatch(/画面と API をつなぐ：完了［修正の子タスク］/);
    expect(parent?.gate).toEqual({ step: "integrate", submission: 1 });
    expect(parent?.integration?.passed).toBe(true);
    expect(parent?.integrationFailures).toBe(0);
    activity.close();
  });

  it("続けて3回通らなければ、不合格のまま人間の承認待ちにする。差し戻すと指摘をもとに修正の子タスクを追加し、回数を数え直す", async () => {
    const fixChild = (key: string) =>
      splitOutput([{ key, title: `修正 ${key}`, body: "-", dependsOn: [] }]);
    const { service, executor, activity, id } = await splitParent([
      splitOutput(twoChildren),
      out("# A"),
      out("# B"),
      integration(false, ["足りない 1"]),
      fixChild("F1"),
      out("# F1"),
      integration(false, ["足りない 2"]),
      fixChild("F2"),
      out("# F2"),
      integration(false, ["足りない 3"]),
      // 人間の差し戻しの後
      out(
        `直し方\n\n${block({ "sacty-split": { reason: "指摘に対応", children: [{ key: "H", title: "人間の指摘を直す", body: "-", dependsOn: [] }] } })}\n\n${block({ "sacty-responses": [{ remarkId: "split-1-1", text: "子タスクで直す" }] })}`,
      ),
      out("# H"),
      // 人間の指摘の再発の判定が無ければ合格にならないので、判定を付ける
      integration(true, [], [{ id: "split-1-1", notRecurred: true, reason: "表示している" }]),
    ]);
    await drain(service, id);
    let parent = service.get(id)?.task;
    expect(parent?.status).toBe("awaiting_approval");
    expect(parent?.gate?.step).toBe("integrate");
    expect(parent?.integration).toMatchObject({ passed: false, findings: ["足りない 3"] });
    expect(parent?.integrationFailures).toBe(3);
    expect(parent?.split?.rounds).toBe(3);
    // 差し戻すと、タスク分割をやり直す（親の要求要件・設計には戻せない）
    expect(reworkTargets(parent as Task, "integrate")).toEqual(["split"]);
    service.requestChanges(id, {
      step: "integrate",
      submission: current(service, id),
      comments: ["エラーの表示が無い"],
    });
    parent = service.get(id)?.task;
    expect(parent?.status).toBe("queued");
    expect(parent?.integrationFailures).toBe(0);
    // 不合格だった統合レビューを差し戻しても、見逃しにはしない
    expect(parent?.misses).toEqual([]);
    await drain(service, id);
    const prompt = promptOf(executor, 12);
    expect(prompt).toContain("[split-1-1] エラーの表示が無い");
    expect(prompt).toContain("足りないこと：足りない 3");
    parent = service.get(id)?.task;
    expect(parent?.remarks[0]).toMatchObject({ step: "split", response: "子タスクで直す" });
    expect(parent?.split?.children.at(-1)?.title).toBe("人間の指摘を直す");
    expect(parent?.gate?.step).toBe("integrate");
    expect(parent?.integration?.passed).toBe(true);
    // 統合レビューには、人間の指摘の再発の判定も求める
    expect(promptOf(executor, 14)).toContain("[split-1-1] エラーの表示が無い");
    activity.close();
  });

  it("合格だった統合レビューを人間が差し戻したら、ゴールガーディアンの見逃しとして記録する", async () => {
    const { service, activity, id } = await splitParent([
      splitOutput(twoChildren),
      out("# A"),
      out("# B"),
      integration(true),
    ]);
    await drain(service, id);
    const at = service.get(id)?.task.integration?.at;
    service.requestChanges(id, {
      step: "integrate",
      submission: current(service, id),
      comments: ["画面が崩れている"],
    });
    expect(service.get(id)?.task.misses).toEqual([
      expect.objectContaining({ reviewAt: at, remarkIds: ["split-1-1"] }),
    ]);
    activity.close();
  });

  it("統合レビューの実行中にイメージを変えても今のレビューは変えず、次の統合レビューから使う（PBI-106・PR #116 レビュー指摘）", async () => {
    const image = (name: string) => ({
      name,
      image: `sacty-agent-${name}:test`,
      description: name,
      env: { IMAGE_NAME: name },
    });
    const java = image("java");
    const playwright = image("playwright");
    const config = () => ({
      ok: true as const,
      config: {
        ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
        images: { java, playwright },
      },
    });
    const fixChild = splitOutput([{ key: "F1", title: "修正 F1", body: "-", dependsOn: [] }]);
    // 統合レビューを始めた後、ベースブランチの最新を取得している間（コンテナの起動の前）に、1回だけ変える
    let change: (() => void) | undefined;
    class ChangingRepos extends FakeRepos {
      override async fetchBranch(gitDir: string, branch: string, authEnv?: Record<string, string>) {
        const run = change;
        change = undefined;
        run?.();
        return super.fetchBranch(gitDir, branch, authEnv);
      }
    }
    const { service, executor, activity, id } = await splitParent(
      [
        splitOutput(twoChildren),
        out("# A の調査"),
        out("# B の調査"),
        integration(false, ["足りない 1"]),
        fixChild,
        out("# F1 の調査"),
        integration(true),
      ],
      new ChangingRepos(),
      { config, images: { integrate: "java" } },
    );
    let during: Task | undefined;
    change = () => {
      during = service.changeStepImage(id, { step: "integrate", image: "playwright" });
    };
    await drain(service, id);
    const parent = service.get(id)?.task;
    expect(parent?.gate).toEqual({ step: "integrate", submission: 1 });
    expect(parent?.integration?.passed).toBe(true);
    // 変えたのは、1回目の統合レビューの実行中
    expect(during && stepRunning(during, "integrate")).toBe(true);
    // 今の統合レビューは始めたときのイメージ（java）、修正の後の統合レビュー（9回目の実行）は変えたイメージ
    expect(executor.images[5]).toEqual({ image: java.image, env: java.env });
    expect(executor.images[8]).toEqual({ image: playwright.image, env: playwright.env });
    expect(executor.images).toHaveLength(9);
    activity.close();
  });

  it("統合レビューは、選んだイメージとその環境変数で実行し、設定から消したら実行せずに止まる（PBI-41 レビュー指摘）", async () => {
    const java = {
      name: "java",
      image: "sacty-agent-java:test",
      description: "Java",
      baseImage: "java",
      env: { MAVEN_OPTS: "-Xmx1g" },
    };
    let images: Record<string, typeof java> = { java };
    const config = () => ({
      ok: true as const,
      config: {
        ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
        images,
      },
    });
    const { service, executor, activity, id } = await splitParent(
      [splitOutput(twoChildren), out("# A の調査"), out("# B の調査"), integration(true)],
      new FakeRepos(),
      { config, images: { integrate: "java" } },
    );
    await drain(service, id);
    expect(service.get(id)?.task.gate).toEqual({ step: "integrate", submission: 1 });
    expect(executor.images.at(-1)).toEqual({ image: java.image, env: java.env });
    activity.close();

    // 工程を決めた後、統合レビューの前に images から消したら、実行せずに理由を示して止まる
    images = { java };
    const second = await splitParent(
      [splitOutput(twoChildren), out("# A の調査"), out("# B の調査")],
      new FakeRepos(),
      { config, images: { integrate: "java" } },
    );
    images = {};
    const calls = () => second.executor.calls.length;
    await drain(second.service, second.id);
    const parent = second.service.get(second.id);
    expect(parent?.task.status).toBe("paused");
    expect(calls()).toBe(5); // 要求要件・設計・分割・子の調査2件。統合レビューは実行しない
    const failed = parent?.activity.find(
      (e) => e.type === "AgentRunFailed" && e.payload.step === "integrate",
    );
    expect(ja(failed?.type === "AgentRunFailed" ? failed.payload.message : undefined)).toContain(
      "イメージ「java」",
    );
    second.activity.close();
  });

  it("ベースブランチを取得できなければ、理由を記録して止め、再開すると統合レビューからやり直す", async () => {
    const repos = new FakeRepos();
    repos.fetchBranchFail = "fatal: could not read from remote";
    const { service, executor, activity, id } = await splitParent(
      [splitOutput(twoChildren), out("# A"), out("# B"), integration(true)],
      repos,
    );
    await drain(service, id);
    const paused = service.get(id)?.task;
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("error");
    const failed = service.get(id)?.activity.findLast((e) => e.type === "AgentRunFailed");
    expect(
      failed?.type === "AgentRunFailed" && renderMessage(failed.payload.message, "ja"),
    ).toMatch(
      /ベースブランチ（main）の最新を取得できませんでした：fatal: could not read from remote/,
    );
    // ゴールガーディアンは実行していない（費用をかけていない）
    expect(executor.calls).toHaveLength(5);

    repos.fetchBranchFail = undefined;
    service.resume(id, {});
    await drain(service, id);
    expect(service.get(id)?.task.gate).toEqual({ step: "integrate", submission: 1 });
    activity.close();
  });

  it("この PBI より前に分割したタスク（統合レビューの工程が無い）は、これまでどおり子の完了で完了する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [out("# 要求要件"), design, splitOutput(twoChildren), out("# A"), out("# B")],
      {
        planner: async (task: Task) =>
          task.parent
            ? {
                steps: ["investigate" as const],
                plan: "investigate" as const,
                reason: "子",
                fallback: false,
                costUsd: 0,
                estimated: false,
              }
            : {
                steps: ["requirements" as const, "design" as const, "split" as const],
                plan: "split" as const,
                reason: "分ける",
                fallback: false,
                costUsd: 0,
                estimated: false,
              },
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "古い分割" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    await drain(service, id);
    const done = service.get(id)?.task;
    expect(done && isCompleted(done)).toBe(true);
    expect(done?.integration).toBeUndefined();
    activity.close();
  });
});

describe("再現の工程（PBI-29）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const reproduce = (text: string, tests: string[]) =>
    out([text, block({ "sacty-reproduction": { tests } })].join("\n\n"));
  const implement = (tests: string[] = ["pay.test.ts › 二重送信"]) =>
    out(
      ["# 修正の説明", block({ "sacty-test-map": [{ viewpointId: "REPRO", tests }] })].join("\n\n"),
    );
  const review = (verified = true) =>
    out(
      block({
        "sacty-final-review": {
          viewpoints: [{ id: "REPRO", verified, reason: "判定" }],
          remarks: [],
          summary: "所見",
        },
      }),
    );
  const planner = async () => ({
    steps: [...STEP_PLANS.bugfix],
    plan: "bugfix" as const,
    reason: "不具合の修正",
    fallback: false,
    testCommand: "npm test",
    costUsd: 0,
    estimated: false,
  });
  async function drain(service: TaskService, max = 10) {
    for (let i = 0; i < max; i++) {
      const ids = service.queuedTaskIds();
      if (ids.length === 0) return;
      for (const id of ids) await service.runNext(id);
    }
  }

  it("再現の確かめは再現の工程のイメージ、実装の検証は実装の工程のイメージで、テストを実行する（PBI-41）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const tests = new FakeTests([
      { exitCode: 1, output: "FAIL", durationMs: 5 },
      { exitCode: 0, output: "ok", durationMs: 5 },
    ]);
    const image = (name: string) => ({
      name,
      image: `sacty-agent-${name}:test`,
      description: name,
      baseImage: name,
      env: { TOOL: name },
    });
    const { service } = makeService(
      activity,
      [out("# 前段の調査"), reproduce("# 再現", ["pay.test.ts › 二重送信"]), implement(), review()],
      {
        tests,
        config: () => ({
          ok: true,
          config: {
            ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
            images: { go: image("go"), node: image("node") },
          },
        }),
        planner: async () => ({
          ...(await planner()),
          images: { reproduce: "go", implement: "node" },
        }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "二重に決済される" });
    await drain(service);
    expect(tests.calls.map((c) => [c.image, c.env])).toEqual([
      ["sacty-agent-go:test", { TOOL: "go" }],
      ["sacty-agent-node:test", { TOOL: "node" }],
    ]);
    expect(service.get(id)?.task.reproduction).toMatchObject({ reproduced: true });
    activity.close();
  });

  it("再現のテストが失敗したら、人間の承認なしに実装へ進み、再現のテストを観点にして検証する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const tests = new FakeTests([
      { exitCode: 1, output: "FAIL pay.test.ts › 二重送信", durationMs: 5 },
      { exitCode: 0, output: "ok", durationMs: 5 },
    ]);
    const pulls = new FakePulls();
    const { service, executor } = makeService(
      activity,
      [
        out("# 前段の調査\n\n- src/pay.ts:40 で冪等キーを見ていない"),
        reproduce("# 再現の説明", ["pay.test.ts › 二重送信"]),
        implement(),
        review(),
      ],
      { planner, tests, pulls },
    );
    const { id } = service.createTask({ projectId: "default", title: "二重に決済される" });
    // 前段の調査は、人間の承認なしに再現へ進む
    await service.runNext(id);
    // マージの後の監視は、スキルが無いので飛ばす（PBI-116）
    expect(service.get(id)?.task.steps.map((s) => s.state)).toEqual([
      "done",
      "active",
      "todo",
      "skip",
    ]);
    expect(service.get(id)?.activity.some((e) => e.type === "StepSubmitted")).toBe(false);
    executor.calls.shift();
    executor.scratch.shift();
    await service.runNext(id);
    // 再現は clone（書き込める作業領域）で、不具合を直さずにテストを書かせる
    expect(executor.scratch[0]).toBe(false);
    expect(promptOf(executor, 0)).toContain("再現エージェント");
    // 前段の調査の結果を、再現と実装に渡す
    expect(promptOf(executor, 0)).toContain("src/pay.ts:40 で冪等キーを見ていない");
    expect(promptOf(executor, 0)).toContain("npm test");
    expect(tests.calls).toHaveLength(1);
    const task = service.get(id)?.task;
    expect(task?.reproduction).toMatchObject({
      reproduced: true,
      exitCode: 1,
      tests: ["pay.test.ts › 二重送信"],
    });
    // 申告の形式のブロックは、再現の説明から取り除く
    expect(task?.outputs.reproduce).toBe("# 再現の説明");
    expect(task?.steps.map((s) => s.state)).toEqual(["done", "done", "active", "skip"]);
    expect(task?.status).toBe("queued");

    await drain(service);
    const fix = promptOf(executor, 1);
    expect(fix).toContain("そのテストが通るように不具合を直してください");
    expect(fix).toContain("# 再現の説明");
    expect(fix).toContain("- pay.test.ts › 二重送信");
    expect(fix).toContain("FAIL pay.test.ts › 二重送信");
    expect(fix).toContain("src/pay.ts:40 で冪等キーを見ていない");
    expect(promptOf(executor, 2)).toContain("[REPRO] 再現のテストが");
    const done = service.get(id)?.task;
    expect(done?.lastReview).toMatchObject({
      passed: true,
      viewpoints: [{ viewpointId: "REPRO" }],
    });
    expect(done?.gate).toEqual({ step: "implement", submission: 1 });
    // PR の本文には、再現の説明と、再現のテストの観点（REPRO）を載せる
    const body = pulls.calls[0]?.body ?? "";
    expect(body).toContain("## 不具合の再現");
    expect(body).toContain("# 再現の説明");
    expect(body).toMatch(/\| REPRO 再現のテストが通る \| pay\.test\.ts › 二重送信 \|.*✅/);
    expect(body).not.toContain("## 要求要件");
    // 実装の承認待ちから差し戻すときに、再現・前段の調査には戻せない（実装した後のコードでは再現できない。
    // 前段の調査は人間が承認しない工程）
    expect(reworkTargets(done as Task, "implement")).toEqual(["implement"]);
    // 実装の工程は、前段の調査・再現の変更を申し出られない（要求要件・設計だけ）
    expect(changeableSteps(done as Task, "implement")).toEqual([]);
    // 前段の調査の結果は、取り込み元の Issue に返さない（調査だけのタスクだけが返す）
    const finished = {
      ...done,
      steps: done?.steps.map((s) => ({ ...s, state: "done" })),
      source: { kind: "github_issue", repo: "https://github.com/acme/app", number: 1, url: "u" },
    } as Task;
    expect(awaitingIssueComment(finished)).toBe(false);
    expect(
      awaitingIssueComment({ ...finished, steps: [{ key: "investigate", state: "done" }] }),
    ).toBe(true);
    activity.close();
  });

  it("テストが通った・再現のテストが無いなら、人間の判断を待つ。承認では進めず、差し戻すと再現をやり直す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const tests = new FakeTests([
      { exitCode: 0, output: "all passed", durationMs: 5 },
      { exitCode: 1, output: "FAIL", durationMs: 5 },
    ]);
    const { service, executor } = makeService(
      activity,
      [
        out("# 前段の調査"),
        reproduce("# 再現できた？", ["pay.test.ts › 二重送信"]),
        reproduce("# テストでは再現できない", []),
        reproduce("# 再現した", ["pay.test.ts › 連打"]),
      ],
      { planner, tests },
    );
    const { id } = service.createTask({ projectId: "default", title: "二重に決済される" });
    await drain(service);
    let task = service.get(id)?.task;
    expect(task?.reproduction).toMatchObject({ reproduced: false, exitCode: 0 });
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.gate).toEqual({ step: "reproduce", submission: 1 });
    expect(() => service.approve(id, { step: "reproduce", submission: 1 })).toThrow(
      /再現できなかったので、先へは進めません/,
    );

    service.requestChanges(id, { step: "reproduce", submission: 1, comments: ["連打で起きる"] });
    await service.runNext(id);
    expect(promptOf(executor, 2)).toContain("[reproduce-1-1] 連打で起きる");
    expect(promptOf(executor, 2)).toContain("終了コード 0");
    task = service.get(id)?.task;
    // 再現のテストが申告されなければ、テストを実行せずに再現できなかったとする
    expect(tests.calls).toHaveLength(1);
    expect(renderMessage(task?.reproduction?.note, "ja")).toMatch(/申告しませんでした/);
    expect(task?.gate).toEqual({ step: "reproduce", submission: 2 });

    service.requestChanges(id, { step: "reproduce", submission: 2, comments: ["決済ボタン"] });
    await service.runNext(id);
    task = service.get(id)?.task;
    expect(task?.reproduction?.reproduced).toBe(true);
    expect(task?.approved.reproduce?.output).toContain("# 再現した");
    expect(task?.status).toBe("queued");
    activity.close();
  });

  it("テストの実行基盤の失敗は再現できたとせず、理由を示して止め、再開するとテストを実行し直す（レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const tests = new FakeTests([
      {
        exitCode: 127,
        output: "",
        note: message("run.dockerUnavailable", { detail: "spawn docker ENOENT" }),
        infrastructure: true,
        durationMs: 1,
      },
      { exitCode: 1, output: "FAIL", durationMs: 5 },
    ]);
    const { service } = makeService(
      activity,
      [out("# 前段の調査"), reproduce("# 再現", ["a.test.ts › x"])],
      { planner, tests },
    );
    const { id } = service.createTask({ projectId: "default", title: "不具合" });
    await drain(service);
    let task = service.get(id)?.task;
    expect(task?.status).toBe("paused");
    expect(task?.reproduction).toBeUndefined();
    expect(task?.steps.find((s) => s.state === "active")?.key).toBe("reproduce");
    expect(renderMessage(task?.pausedMessage, "ja")).toMatch(
      /^再現のテストを実行できませんでした（.*spawn docker ENOENT.*）。再現できたかは確かめていません/,
    );
    service.resume(id, {});
    await service.runNext(id);
    task = service.get(id)?.task;
    expect(tests.calls).toHaveLength(2);
    expect(task?.reproduction?.reproduced).toBe(true);
    expect(task?.steps.find((s) => s.state === "active")?.key).toBe("implement");
    activity.close();
  });

  it("docker run が Docker 自身の失敗（終了コード 125）で終わっても、再現できたとせずに止める（レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    // 実際のテストの実行基盤に、docker run が 125 で終わる docker を渡す
    const spawnImpl = (() => {
      const child = Object.assign(new EventEmitter(), {
        stdout: new EventEmitter(),
        stderr: new EventEmitter(),
        kill: () => true,
      });
      setTimeout(() => child.emit("close", 125), 0);
      return child;
    }) as never;
    const { service } = makeService(
      activity,
      [out("# 前段の調査"), reproduce("# 再現", ["a.test.ts › x"])],
      { planner, tests: new DockerTestRunner(60_000, spawnImpl) as unknown as FakeTests },
    );
    const { id } = service.createTask({ projectId: "default", title: "不具合" });
    await drain(service);
    const task = service.get(id)?.task;
    expect(task?.status).toBe("paused");
    expect(task?.reproduction).toBeUndefined();
    expect(task?.reproductionPending).toBe(true);
    expect(renderMessage(task?.pausedMessage, "ja")).toMatch(/docker run の終了コード 125/);
    activity.close();
  });

  it("再現の後、確かめる前にデーモンが止まっても、再起動の後に確かめる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const tests = new FakeTests([{ exitCode: 1, output: "FAIL", durationMs: 5 }]);
    tests.hold = true;
    const { service } = makeService(
      activity,
      [out("# 前段の調査"), reproduce("# 再現", ["a.test.ts › x"])],
      { planner, tests },
    );
    const { id } = service.createTask({ projectId: "default", title: "不具合" });
    await service.runNext(id);
    const running = service.runNext(id);
    await tests.started.promise;
    // テストの実行中（確かめる前）の状態は、作業履歴から復元できる
    const restored = new SqliteActivityStore(dbPath);
    const { service: restarted, tests: retests } = makeService(restored, [], { planner });
    expect(restarted.get(id)?.task.reproductionPending).toBe(true);
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    expect(retests.calls).toHaveLength(1);
    expect(restarted.get(id)?.task.reproduction).toBeDefined();
    restored.close();
    tests.kill((await tests.started.promise) as string);
    await running.catch(() => {});
    activity.close();
  });

  it("オーケストレーターは、不具合の修正に bugfix を選べる", () => {
    expect(buildOrchestratorPrompt({ title: "x", body: "" } as Task)).toContain(
      "- bugfix：調査 → 再現 → 実装",
    );
  });
});

describe("タスクの並行実行（PBI-30）", () => {
  /** 止めるか終えるまで返さない偽物（実行中のタスクを数える）。 */
  class HeldExecutor implements AgentExecutor {
    held = new Map<string, { title: string; resolve: (o: AgentOutcome) => void }>();
    killed: string[] = [];
    async run(input: { runId: string; invocation: Invocation }): Promise<AgentOutcome> {
      const prompt = input.invocation.command.join(" ");
      const title = /# (タスク\S+)/.exec(prompt)?.[1] ?? "?";
      return new Promise((resolve) => this.held.set(input.runId, { title, resolve }));
    }
    kill(runId: string) {
      this.killed.push(runId);
      this.held.get(runId)?.resolve({ kind: "failed", reason: "error", message: "stopped" });
      this.held.delete(runId);
    }
    async ensureStopped() {
      return true;
    }
    finish(title: string) {
      for (const [runId, h] of this.held) {
        if (h.title !== title) continue;
        h.resolve({
          kind: "completed",
          output: "# 要求要件",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
        });
        this.held.delete(runId);
      }
    }
    titles() {
      return [...this.held.values()].map((h) => h.title).sort();
    }
  }
  const settle = () => new Promise((r) => setTimeout(r, 30));

  function setup(settings: MemorySettingsStore, planner?: ServiceDeps["planner"]) {
    const activity = new SqliteActivityStore(dbPath);
    const executor = new HeldExecutor();
    const service = new TaskService({
      activity,
      config: configOf(agent()),
      secrets: new MemorySecretStore({ "claude-oauth-token": "oauth-secret" }),
      executor,
      repos: new FakeRepos(),
      tests: new FakeTests(),
      pulls: new FakePulls(),
      projects: projectsWithAccount(),
      contexts: new FakeContexts(),
      settings,
      github: new FakeGitHub(),
      planner:
        planner ??
        (async () => ({
          steps: [...MVP_STEPS],
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
        })),
      workspaceRoot: join(dir, "workspaces"),
    });
    return { activity, executor, service };
  }

  it("実行待ちのタスクを、古い順に上限の数まで同時に実行し、空いたら次を始める", async () => {
    const { Worker } = await import("./worker.js");
    const { activity, executor, service } = setup(new MemorySettingsStore({ maxParallelTasks: 2 }));
    for (const title of ["タスク1", "タスク2", "タスク3"]) {
      service.createTask({ projectId: "default", title });
    }
    const worker = new Worker(service, 60_000);
    void worker.tick();
    await settle();
    expect(executor.titles()).toEqual(["タスク1", "タスク2"]);
    // 実行中のタスクは、重ねて始めない（上限にも達している）
    void worker.tick();
    await settle();
    expect(executor.titles()).toEqual(["タスク1", "タスク2"]);

    executor.finish("タスク1");
    await settle();
    void worker.tick();
    await settle();
    expect(executor.titles()).toEqual(["タスク2", "タスク3"]);
    executor.finish("タスク2");
    executor.finish("タスク3");
    await worker.drain();
    expect(service.list().map((t) => t.status)).toEqual([
      "awaiting_approval",
      "awaiting_approval",
      "awaiting_approval",
    ]);
    activity.close();
  });

  it("同時に実行している中の1件を一時停止すると、そのタスクのコンテナだけを止める", async () => {
    const { Worker } = await import("./worker.js");
    const { activity, executor, service } = setup(new MemorySettingsStore());
    expect(service.maxParallelTasks()).toBe(3);
    const a = service.createTask({ projectId: "default", title: "タスクA" });
    const b = service.createTask({ projectId: "default", title: "タスクB" });
    const worker = new Worker(service, 60_000);
    void worker.tick();
    await settle();
    expect(executor.titles()).toEqual(["タスクA", "タスクB"]);
    const runOf = (id: string) => service.get(id)?.task.currentRunId ?? "";
    const runB = runOf(b.id);
    await service.pause(a.id);
    expect(executor.killed).toHaveLength(1);
    expect(executor.killed).not.toContain(runB);
    expect(service.get(a.id)?.task.status).toBe("paused");
    expect(service.get(b.id)?.task.status).toBe("running");
    executor.finish("タスクB");
    await worker.drain();
    expect(service.get(b.id)?.task.status).toBe("awaiting_approval");
    activity.close();
  });

  it("工程を選んでいる間（まだ実行待ちの状態）も、同じタスクを重ねて始めない", async () => {
    const { Worker } = await import("./worker.js");
    let calls = 0;
    const choosing = Promise.withResolvers<void>();
    const { activity, service } = setup(new MemorySettingsStore(), async () => {
      calls += 1;
      await choosing.promise;
      return {
        steps: [...MVP_STEPS],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      };
    });
    const task = service.createTask({ projectId: "default", title: "タスクA" });
    const worker = new Worker(service, 60_000);
    void worker.tick();
    await settle();
    expect(service.get(task.id)?.task.status).toBe("queued");
    void worker.tick();
    await settle();
    expect(calls).toBe(1);
    choosing.resolve();
    await settle();
    await service.pause(task.id);
    await worker.drain();
    activity.close();
  });

  it("上限は 1〜10 の整数で、空なら既定（3）", () => {
    const { activity, service } = setup(new MemorySettingsStore());
    expect(service.saveSettings({ intakeLabel: "", maxParallelTasks: "5" }).maxParallelTasks).toBe(
      5,
    );
    expect(service.maxParallelTasks()).toBe(5);
    expect(service.saveSettings({ maxParallelTasks: "" }).maxParallelTasks).toBeUndefined();
    expect(service.maxParallelTasks()).toBe(3);
    for (const bad of ["0", "11", "1.5", "abc", -1]) {
      expect(() => service.saveSettings({ maxParallelTasks: bad })).toThrow();
    }
    activity.close();
  });
});

describe("JIRA のチケットの取り込みとトリアージ（PBI-52）", () => {
  const projects = () => {
    const store = new MemoryProjectStore();
    store.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: "https://github.com/acme/app" },
        { scope: "repo", target: "https://github.com/acme/api" },
      ],
      githubAccounts: { "github.com": "me" },
      tickets: [{ platform: "jira", service: "jira-server", keys: ["PAY"] }],
    });
    store.put("ops", {
      name: "運用",
      targets: [{ scope: "repo", target: "https://github.com/acme/ops" }],
      githubAccounts: { "github.com": "me" },
      tickets: [
        { platform: "jira", service: "jira-server", keys: ["OPS", "PAY"] },
        { platform: "cloud", service: "jira-cloud", keys: ["WEB"] },
      ],
    });
    return store;
  };
  const setup = (
    outcomes: AgentOutcome[] = [],
    extra: { platforms?: Platform[]; settings?: MemorySettingsStore } = {},
  ) => {
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(activity, outcomes, {
      config: configOf(agent(), 1, extra.platforms ?? [jiraPlatform()]),
      secrets: { "claude-oauth-token": "oauth-secret", "jira-token": "jira-secret" },
      gateway: fakeGateway(),
      projects: projects(),
      settings: extra.settings ?? new MemorySettingsStore({ ticketLabel: "sacty" }),
      tickets: new FakeTickets(),
    });
    return { activity, ...made };
  };

  it("取り込み先を接続先と種類ごとにまとめ、ラベルが無いか Off なら探さない", () => {
    const settings = new MemorySettingsStore({});
    const { activity, service } = setup([], { settings });
    expect(service.ticketSources()).toEqual([]);
    expect(service.importTickets([foundTicket("PAY-1")])).toEqual([]);
    service.saveSettings({ ticketLabel: " sacty " });
    expect(service.ticketSources()).toEqual([
      { platform: "jira", service: "jira-server", keys: ["OPS", "PAY"], label: "sacty" },
      // ホストの PF に無い接続先は、プロジェクトのコンテキストの PF を引くため、プロジェクトごとにする（PBI-74）
      {
        platform: "cloud",
        service: "jira-cloud",
        keys: ["WEB"],
        label: "sacty",
        projectId: "ops",
      },
    ]);
    service.saveSettings({ ticketLabel: "sacty", triageOff: ["tickets"] });
    expect(service.ticketSources()).toEqual([]);
    expect(service.importTickets([foundTicket("PAY-1")])).toEqual([]);
    // ラベルは残る
    expect(service.getSettings()).toMatchObject({ ticketLabel: "sacty", triageOff: ["tickets"] });
    activity.close();
  });

  it("書いたキーのチケットだけを、担当のプロジェクトのタスクにし、二度は取り込まない", () => {
    const { activity, service } = setup();
    const created = service.importTickets([
      foundTicket("PAY-1", "決済の再送"),
      foundTicket("PAY-1", "決済の再送"),
      foundTicket("OPS-2"),
      foundTicket("ZZZ-3"),
      { ...foundTicket("WEB-4"), platform: "cloud", service: "jira-cloud" },
    ]);
    expect(created.map((t) => [t.title, t.projectId, t.start, t.repo])).toEqual([
      ["PAY-1 決済の再送", expect.any(String), "jira", undefined],
      ["OPS-2 OPS-2 の要約", "ops", "jira", undefined],
      ["WEB-4 WEB-4 の要約", "ops", "jira", undefined],
    ]);
    expect(created[0]?.ticket).toEqual({
      platform: "jira",
      service: "jira-server",
      key: "PAY-1",
      url: "https://jira.example.com/browse/PAY-1",
    });
    // 同じキーを書いたプロジェクトが複数あっても、1つのタスクだけ
    expect(service.importTickets([foundTicket("PAY-1"), foundTicket("OPS-2")])).toEqual([]);
    // ほかの接続先の同じキーは、別のチケット
    expect(
      service.importTickets([{ ...foundTicket("OPS-2"), platform: "cloud" }]).map((t) => t.title),
    ).toEqual([]);
    activity.close();
  });

  it("オーケストレーターがゲートウェイ経由でチケットを読み、リポジトリ・題・概要を決め、その後に工程を選ぶ", async () => {
    const { activity, service, executor, repos } = setup([
      triageOut({
        repo: "https://github.com/acme/api/",
        title: "PAY-1 決済の再送で二重に請求される",
        summary: "## 目的\n二重請求を防ぐ\n\n## スコープ\nAPI 側の再送の判定だけ",
        reason: "サブタスク。親は決済の改修。API の再送の判定を受け持つ",
      }),
      completed(20_000),
    ]);
    const [task] = service.importTickets([foundTicket("PAY-1")]);
    const id = task?.id ?? "";
    expect(service.queuedTaskIds()).toContain(id);
    await service.runNext(id);
    const triaged = service.get(id)?.task;
    expect(triaged).toMatchObject({
      repo: "https://github.com/acme/api",
      title: "PAY-1 決済の再送で二重に請求される",
      body: "## 目的\n二重請求を防ぐ\n\n## スコープ\nAPI 側の再送の判定だけ",
      ticketTriage: {
        by: "orchestrator",
        reason: "サブタスク。親は決済の改修。API の再送の判定を受け持つ",
      },
      status: "queued",
      steps: [],
    });
    expect(triaged?.budget.usedUsd).toBeGreaterThan(0);
    const call = executor.calls[0];
    const prompt = call?.command.join(" ") ?? "";
    expect(prompt).toContain("PAY-1");
    expect(prompt).toContain("$SACTY_PF_URL/jira");
    expect(prompt).toContain("   - https://github.com/acme/app");
    expect(prompt).toContain("   - https://github.com/acme/api");
    expect(call?.env.SACTY_PF_URL).toBe("http://host.docker.internal:5001/r/sacty-gw-run/pf");
    expect(JSON.stringify(call)).not.toContain("jira-secret");
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("jira-secret");
    // 次の実行で、選んだリポジトリを用意して工程を選ぶ
    await service.runNext(id);
    expect(repos.prepared[0]?.url).toBe("https://github.com/acme/api.git");
    expect(service.get(id)?.task.steps.length).toBeGreaterThan(0);
    activity.close();
  });

  it("選べなければ止まり、人が候補からリポジトリを選ぶと、そのリポジトリでチケットを読み直して題と概要を書く", async () => {
    // 人が選んだ後の読み直し。出力のリポジトリは使わない（人が決めたリポジトリに固定）
    const rewrite = triageOut({
      repo: "https://github.com/acme/api",
      title: "PAY-1 画面の再送ボタンを二重に押せないようにする",
      summary: "## 目的\n二重請求を防ぐ（画面側）",
      reason: "人が選んだリポジトリで書いた",
    });
    for (const bad of [
      triageOut({ repo: "", summary: "読んだ要件", reason: "どのリポジトリか分からない" }),
      triageOut({ repo: "https://github.com/evil/other", reason: "x" }),
      // 候補のリポジトリを選んでも、概要が無ければ止まる（通常の経路）
      triageOut({ repo: "https://github.com/acme/api", title: "PAY-1 題だけ", reason: "x" }),
      { kind: "completed", output: "JSON なし" } as AgentOutcome,
    ]) {
      const { activity, service, executor } = setup([bad, rewrite, completed(20_000)]);
      const [task] = service.importTickets([foundTicket("PAY-1")]);
      const id = task?.id ?? "";
      await service.runNext(id);
      const paused = service.get(id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.repo).toBeUndefined();
      expect(service.get(id)?.activity.map((e) => e.type)).toContain("OrchestratorFailed");
      await expect(
        service.chooseTicketRepository(id, "https://github.com/acme/ops"),
      ).rejects.toThrow();
      await service.chooseTicketRepository(id, "https://github.com/acme/app");
      expect(service.get(id)?.task).toMatchObject({
        repo: "https://github.com/acme/app",
        ticketTriage: { by: "person" },
      });
      service.resume(id, {});
      await service.runNext(id); // 選んだリポジトリで、チケットを読み直す
      const prompt = executor.calls[1]?.command.join(" ") ?? "";
      expect(prompt).toContain("人が次のリポジトリに決めました");
      expect(prompt).toContain("   - https://github.com/acme/app");
      expect(prompt).not.toContain("   - https://github.com/acme/api");
      expect(service.get(id)?.task).toMatchObject({
        repo: "https://github.com/acme/app",
        title: "PAY-1 画面の再送ボタンを二重に押せないようにする",
        body: "## 目的\n二重請求を防ぐ（画面側）",
        ticketTriage: { by: "orchestrator" },
        steps: [],
      });
      await service.runNext(id); // 工程を選ぶ
      expect(executor.calls).toHaveLength(3);
      expect(service.get(id)?.task.steps.length).toBeGreaterThan(0);
      // 工程を選んだ後は、リポジトリを変えられない
      await expect(
        service.chooseTicketRepository(id, "https://github.com/acme/api"),
      ).rejects.toThrow();
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("人が選んだリポジトリで読み直しても要件を書けなければ、工程を選ばずに止まり、選び直せる", async () => {
    const { activity, service, executor } = setup([
      triageOut({ repo: "", reason: "分からない" }),
      // 題だけで概要が無い
      triageOut({
        repo: "https://github.com/acme/app",
        title: "PAY-1 題のみ取得",
        summary: "",
        reason: "要件が読めない",
      }),
      triageOut({
        repo: "",
        title: "PAY-1 API の再送の判定",
        summary: "API 側",
        reason: "選び直したリポジトリで書いた",
      }),
    ]);
    const [task] = service.importTickets([foundTicket("PAY-1")]);
    const id = task?.id ?? "";
    await service.runNext(id);
    await service.chooseTicketRepository(id, "https://github.com/acme/app");
    service.resume(id, {});
    await service.runNext(id);
    expect(service.get(id)?.task).toMatchObject({ status: "paused", steps: [] });
    expect(service.get(id)?.task.repository).toBeUndefined();
    // 題も本文も、取り込んだときのまま（読めなかった題を使わない）
    expect(service.get(id)?.task.title).toBe("PAY-1 PAY-1 の要約");
    expect(service.get(id)?.task.ticketTriage?.by).toBe("person");
    // 選び直して再開すると、そのリポジトリで読み直す
    await service.chooseTicketRepository(id, "https://github.com/acme/api");
    service.resume(id, {});
    await service.runNext(id);
    expect(executor.calls[2]?.command.join(" ")).toContain("   - https://github.com/acme/api");
    expect(service.get(id)?.task).toMatchObject({
      repo: "https://github.com/acme/api",
      title: "PAY-1 API の再送の判定",
      ticketTriage: { by: "orchestrator" },
    });
    activity.close();
  });

  it("接続先が設定に無ければ、チケットを読まずに止まる。チケットでないタスクのリポジトリは選べない", async () => {
    const { activity, service, executor } = setup([], { platforms: [] });
    const [task] = service.importTickets([foundTicket("PAY-1")]);
    await service.runNext(task?.id ?? "");
    expect(executor.calls).toHaveLength(0);
    expect(service.get(task?.id ?? "")?.task.status).toBe("paused");
    expect(ja(service.get(task?.id ?? "")?.task.pausedMessage)).toContain("jira");
    const plain = service.createTask({
      projectId: "default",
      title: "A",
      repo: "https://github.com/acme/app",
    });
    await expect(
      service.chooseTicketRepository(plain.id, "https://github.com/acme/app"),
    ).rejects.toThrow();
    activity.close();
  });
});

describe("タスクの詳細での、オーケストレーターへの質問（PBI-54）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const promptOf = (executor: FakeExecutor, i: number) => executor.calls[i]?.command[2] ?? "";
  /** 質問しても変わってはいけない、タスクの状態・工程・承認済みの内容。 */
  const planOf = (task: Task | undefined) => ({
    status: task?.status,
    steps: task?.steps,
    approved: task?.approved,
    gate: task?.gate,
    outputs: task?.outputs,
    currentRunId: task?.currentRunId,
    pausedReason: task?.pausedReason,
  });

  /** 要求要件を承認して、設計の実行待ちにしたタスク（対象リポジトリを用意済み）。 */
  async function approvedRequirements(
    outcomes: (AgentOutcome | typeof HOLD)[],
    options: { repos?: FakeRepos } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(
      activity,
      [out("# 要求要件\n\n- 再試行は3回まで"), ...outcomes],
      options,
    );
    const { service } = made;
    const { id } = service.createTask({
      projectId: "default",
      title: "決済API",
      body: "冪等にする",
    });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    return { ...made, activity, id };
  }

  it("答えを記録できなければ、答えられなかったこととして記録し、次の質問を塞がない", async () => {
    const { activity, service, id } = await approvedRequirements([out("答え1"), out("答え2")]);
    // 答えの記録だけを一度失敗させる
    const append = activity.append.bind(activity);
    let failOnce = true;
    activity.append = (entry) => {
      if (
        failOnce &&
        entry.events.some((e) => e.event.type === "QuestionAnswered" && "answer" in e.event.payload)
      ) {
        failOnce = false;
        throw new Error("disk full");
      }
      return append(entry);
    };
    const usedBefore = service.get(id)?.task.budget.usedUsd ?? 0;
    await service.askQuestion(id, { text: "Q1" }).answered;
    // 実行にかかった費用（100出力トークン = $0.0015）は、答えられなかったときも記録する
    expect(service.get(id)?.task.budget.usedUsd).toBeCloseTo(usedBefore + 0.0015, 6);
    expect(service.get(id)?.task.budget.estimated).toBe(true);
    expect(service.get(id)?.activity.at(-1)).toMatchObject({
      type: "QuestionAnswered",
      payload: {
        runResult: "failed",
        costUsd: 0.0015,
        usage: { output: 100 },
        agentId: "claude-subscription",
      },
    });
    const first = service.get(id)?.task.questions[0]?.answer;
    expect(first && "failed" in first ? ja(first.failed) : "").toContain("disk full");
    await service.askQuestion(id, { text: "Q2" }).answered;
    expect(service.get(id)?.task.questions[1]?.answer?.text).toBe("答え2");
    activity.close();
  });

  it("質問すると、台帳を読んだオーケストレーターが答え、状態・工程・承認済みの内容は変わらない", async () => {
    const { activity, service, executor, repos, id } = await approvedRequirements([
      out("いまは**設計**の実行待ちです。", 1000),
    ]);
    const before = service.get(id)?.task;
    const usedBefore = before?.budget.usedUsd ?? 0;
    const { task: asked, answered } = service.askQuestion(id, { text: "  いまどこまで進んだ？  " });
    expect(asked.questions).toEqual([
      { id: "Q-1", text: "いまどこまで進んだ？", askedAt: expect.any(String) },
    ]);
    await answered;

    const task = service.get(id)?.task;
    expect(task?.questions).toEqual([
      {
        id: "Q-1",
        text: "いまどこまで進んだ？",
        askedAt: expect.any(String),
        answer: { text: "いまは**設計**の実行待ちです。", at: expect.any(String) },
      },
    ]);
    expect(planOf(task)).toEqual(planOf(before));
    expect(service.queuedTaskIds()).toEqual([id]);
    // 費用はタスクの費用に入る（1000出力トークン = $0.015）
    expect(task?.budget.usedUsd).toBeCloseTo(usedBefore + 0.015, 6);
    expect(service.get(id)?.activity.at(-1)).toMatchObject({
      type: "QuestionAnswered",
      actor: "orchestrator",
      payload: { questionId: "Q-1", runResult: "completed", agentId: "claude-subscription" },
    });

    // 台帳（承認済みの要求要件・工程・作業履歴・費用）と質問を渡し、計画は変えさせない
    const prompt = promptOf(executor, 1);
    expect(prompt).toContain("あなたはオーケストレーターです");
    expect(prompt).toContain("--- 承認済みの要求要件 ---\n# 要求要件\n\n- 再試行は3回まで");
    expect(prompt).toContain("要求要件（done） → 設計（active）");
    expect(prompt).toContain("StepApproved");
    expect(prompt).toContain(
      "タスクの計画（工程・承認済みの成果物・タスクの状態）は変えられません",
    );
    expect(prompt).toContain("--- 質問 ---\nいまどこまで進んだ？");
    // 用意済みのタスクは、対象リポジトリの起点のコードを使い捨ての写しで渡す
    expect(repos.snapshots.at(-1)?.baseCommit).toBe("base123");
    expect(executor.scratch[1]).toBe(true);
    expect(executor.workspaceFiles[1]).toEqual(["README.md"]);
    expect(existsSync(executor.dirs[1] ?? "")).toBe(false);
    expect(prompt).toContain("起点のコミット（base123）のコードがあります");

    // 開き直しても（作業履歴から復元しても）読める
    const reopened = makeService(activity).service;
    expect(reopened.get(id)?.task.questions).toEqual(task?.questions);
    activity.close();
  });

  it("まだ対象リポジトリを用意していないタスクでは、コードを渡さずに台帳だけで答える", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, repos } = makeService(activity, [out("工程はまだ決めていません。")]);
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    await service.askQuestion(id, { text: "工程は？" }).answered;
    expect(repos.snapshots).toEqual([]);
    expect(executor.workspaceFiles[0]).toEqual([]);
    expect(promptOf(executor, 0)).toContain("対象リポジトリはまだ用意されていないため");
    expect(service.get(id)?.task).toMatchObject({ status: "queued", steps: [] });
    activity.close();
  });

  it("作業中（工程の実行中）のタスクでも質問でき、作業中の実行を止めない", async () => {
    const { activity, service, executor, id } = await approvedRequirements([
      HOLD,
      out("設計を書いています。"),
    ]);
    const running = service.runNext(id);
    const stepRun = await executor.started.promise;
    const before = service.get(id)?.task;
    expect(before?.status).toBe("running");

    await service.askQuestion(id, { text: "いま何をしている？" }).answered;
    const task = service.get(id)?.task;
    expect(task?.questions[0]?.answer?.text).toBe("設計を書いています。");
    expect(planOf(task)).toEqual(planOf(before));
    expect(executor.killed).toEqual([]);
    // 作業中の実行には話しかけない（別の実行。プロンプトも別）
    expect(executor.dirs[2]).not.toBe(executor.dirs[1]);
    expect(promptOf(executor, 2)).toContain("--- 質問 ---\nいま何をしている？");

    // 一時停止は工程の実行だけを止める
    await service.pause(id);
    await running;
    expect(executor.killed).toEqual([stepRun]);
    activity.close();
  });

  it("答えを待っている間は次の質問を受け付けず、答えが出たら続けて質問でき、すべて残る", async () => {
    const { activity, service, executor, id } = await approvedRequirements([
      HOLD,
      out("2つ目の答え"),
      out("3つ目の答え"),
    ]);
    expect(service.get(id)?.task.questions).toEqual([]);
    const first = service.askQuestion(id, { text: "1つ目" });
    const chatRun = await executor.started.promise;
    expect(() => service.askQuestion(id, { text: "同時の質問" })).toThrow(
      expect.objectContaining({ messages: [{ code: "chat.answering" }] }),
    );
    // 1つ目の実行が失敗しても、使った分を記録して次の質問を受け付ける
    executor.kill(chatRun);
    await first.answered;
    expect(service.get(id)?.task.questions[0]?.answer).toEqual({
      failed: message("chat.failed", { detail: "container killed" }),
      at: expect.any(String),
    });

    await service.askQuestion(id, { text: "2つ目" }).answered;
    await service.askQuestion(id, { text: "3つ目" }).answered;
    const questions = service.get(id)?.task.questions ?? [];
    expect(questions.map((q) => [q.id, q.text, q.answer?.text])).toEqual([
      ["Q-1", "1つ目", undefined],
      ["Q-2", "2つ目", "2つ目の答え"],
      ["Q-3", "3つ目", "3つ目の答え"],
    ]);
    // 前の質問と答えも渡す（答えられなかったものは渡さない）
    const third = promptOf(executor, 3);
    expect(third).toContain("[Q-2] 質問：2つ目\n答え：2つ目の答え");
    expect(third).not.toContain("[Q-1]");
    expect(service.get(id)?.task.status).toBe("queued");
    activity.close();
  });

  it("予算の上限に達したタスク（ちょうど上限を含む）では質問できず、理由を返す", async () => {
    // 要求要件の実行で 1000 出力トークン = $0.015。上限 $0.015 ちょうどに達する
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件", 1000)], {
      config: configOf(agent(), 0.015),
    });
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    await service.runNext(id);
    expect(service.get(id)?.task.budget.usedUsd).toBe(0.015);
    expect(() => service.askQuestion(id, { text: "まだ質問できる？" })).toThrow(
      expect.objectContaining({
        messages: [message("chat.budgetExceeded", { usedUsd: 0.015, capUsd: 0.015 })],
      }),
    );
    expect(service.get(id)?.task.questions).toEqual([]);
    expect(executor.calls).toHaveLength(1);
    expect(ja(message("chat.budgetExceeded", { usedUsd: 0.015, capUsd: 0.015 }))).toContain(
      "予算の上限に達しているため、質問できません",
    );
    activity.close();
  });

  it("上限の手前なら質問でき、答えで上限を超えても、タスクの状態は変えない（次の実行の前に止まる）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("# 要求要件", 999), out("答え", 1000)], {
      config: configOf(agent(), 0.015),
    });
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    await service.runNext(id);
    const before = service.get(id)?.task;
    await service.askQuestion(id, { text: "質問" }).answered;
    const task = service.get(id)?.task;
    expect(task?.questions[0]?.answer?.text).toBe("答え");
    expect(task?.budget.usedUsd).toBeCloseTo(0.029985, 6);
    expect(task?.budget.warned).toBe(true);
    expect(planOf(task)).toEqual(planOf(before));
    expect(() => service.askQuestion(id, { text: "もう1つ" })).toThrow(
      expect.objectContaining({
        messages: [expect.objectContaining({ code: "chat.budgetExceeded" })],
      }),
    );
    activity.close();
  });

  it("答えに含まれる秘密情報は、切り詰める前に伏せ、答え・作業履歴に残さない", async () => {
    // 実行に渡した秘密情報（サブスクリプションのトークン）を、答えの切り詰めの境界をまたぐ位置に置く
    const secret = "oauth-secret";
    for (const pad of [ANSWER_MAX - 6, ANSWER_MAX - 1, ANSWER_MAX, 10]) {
      rmSync(dbPath, { force: true });
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out(`${"x".repeat(pad)}${secret}末尾`)]);
      const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
      await service.askQuestion(id, { text: "トークンを教えて" }).answered;
      const answer = service.get(id)?.task.questions[0]?.answer?.text ?? "";
      // 長い答えは、上限の長さで切り詰めて記録する（記録できずに答えを失わない）
      expect(answer.length).toBe(Math.min(ANSWER_MAX, pad + "[REDACTED]末尾".length));
      expect(answer.startsWith("x".repeat(Math.min(pad, ANSWER_MAX - 1)))).toBe(true);
      for (let n = 4; n <= secret.length; n++) {
        expect(answer).not.toContain(secret.slice(0, n));
      }
      expect(JSON.stringify(service.get(id)?.activity)).not.toContain(secret);
      activity.close();
    }
  });

  it("答えられなかったときも理由と費用を記録し、理由から秘密情報を除く", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [
      { kind: "failed", reason: "error", message: "boom oauth-secret" },
      out("   "),
    ]);
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    await service.askQuestion(id, { text: "1" }).answered;
    await service.askQuestion(id, { text: "2" }).answered;
    const [first, second] = service.get(id)?.task.questions ?? [];
    expect(ja(first?.answer?.failed)).toContain("boom [REDACTED]");
    expect(second?.answer?.failed).toEqual(message("chat.emptyAnswer"));
    expect(service.get(id)?.task.budget.usedUsd).toBeCloseTo(0.0015, 6);
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("oauth-secret");
    activity.close();
  });

  it("一時停止しても答えている実行は止めず、一時停止中のタスクにも答えを記録する（状態は一時停止のまま）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [HOLD]);
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    const { answered } = service.askQuestion(id, { text: "質問" });
    const chatRun = await executor.started.promise;
    const paused = await service.pause(id);
    expect(paused).toMatchObject({ status: "paused", pausedReason: "manual" });
    expect(executor.killed).toEqual([]);
    // 一時停止中も質問は1件ずつ
    expect(() => service.askQuestion(id, { text: "もう1つ" })).toThrow(
      expect.objectContaining({ messages: [{ code: "chat.answering" }] }),
    );
    executor.kill(chatRun);
    await answered;
    const task = service.get(id)?.task;
    expect(task).toMatchObject({ status: "paused", pausedReason: "manual" });
    expect(task?.questions[0]?.answer?.failed).toEqual(
      message("chat.failed", { detail: "container killed" }),
    );
    activity.close();
  });

  it("中止すると、答えている実行を止めて中断を記録してから中止し、以後は質問できない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [HOLD]);
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    const { answered } = service.askQuestion(id, { text: "質問" });
    const chatRun = await executor.started.promise;
    await service.cancel(id);
    await answered;
    expect(executor.killed).toEqual([chatRun]);
    const types = service.get(id)?.activity.map((e) => e.type) ?? [];
    expect(types.slice(-2)).toEqual(["QuestionAnswered", "TaskCancelled"]);
    expect(service.get(id)?.task.questions[0]?.answer?.failed).toEqual(message("chat.cancelled"));
    expect(() => service.askQuestion(id, { text: "もう1つ" })).toThrow(
      expect.objectContaining({ messages: [{ code: "task.cancelled" }] }),
    );
    activity.close();
  });

  it("コードを書き出している間に中止したら、コンテナを起動せずに中断を記録する", async () => {
    const gate = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    class GatedRepos extends FakeRepos {
      armed = false;
      override async snapshot(gitDir: string, baseCommit: string, outDir: string) {
        if (this.armed) {
          entered.resolve();
          await gate.promise;
        }
        return super.snapshot(gitDir, baseCommit, outDir);
      }
    }
    const repos = new GatedRepos();
    const { activity, service, executor, id } = await approvedRequirements([out("答え")], {
      repos,
    });
    repos.armed = true;
    const { answered } = service.askQuestion(id, { text: "質問" });
    await entered.promise;
    const cancelling = service.cancel(id);
    gate.resolve();
    await cancelling;
    await answered;
    expect(executor.calls).toHaveLength(1);
    const question = service.get(id)?.task.questions[0];
    expect(question?.answer?.failed).toEqual(message("chat.cancelled"));
    expect(service.get(id)?.activity.findLast((e) => e.type === "QuestionAnswered")).toMatchObject({
      payload: { runResult: "interrupted", costUsd: 0 },
    });
    expect(service.get(id)?.task.status).toBe("cancelled");
    activity.close();
  });

  it("デーモンが止まって答えられなかった質問は、起動のときに中断として記録し、また質問できる", async () => {
    const first = new SqliteActivityStore(dbPath);
    const { service: before } = makeService(first, [HOLD]);
    const { id } = before.createTask({ projectId: "default", title: "決済API", body: "" });
    before.askQuestion(id, { text: "質問" });

    const second = new SqliteActivityStore(dbPath);
    const { service } = makeService(second, [out("答え")]);
    expect(service.get(id)?.task.questions[0]?.answer).toBeUndefined();
    service.recoverInterrupted();
    expect(service.get(id)?.task.questions[0]?.answer?.failed).toEqual(
      message("run.daemonStopped"),
    );
    expect(service.get(id)?.task.status).toBe("queued");
    await service.askQuestion(id, { text: "もう一度" }).answered;
    expect(service.get(id)?.task.questions[1]?.answer?.text).toBe("答え");
    first.close();
    second.close();
  });

  it("API：質問を受け付けて 201、空・長すぎる質問は 400、質問できない状態は 409 で理由を返す", async () => {
    const token = "test-token";
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [HOLD]);
    const app = createApp(service, token);
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    const ask = (taskId: string, body: unknown) =>
      app.request(`/api/tasks/${taskId}/questions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    const empty = await ask(id, { text: "   " });
    expect(empty.status).toBe(400);
    expect(await empty.json()).toMatchObject({
      issues: [{ path: ["text"], message: { code: "input.questionRequired" } }],
    });
    expect((await ask(id, { text: "あ".repeat(QUESTION_MAX + 1) })).status).toBe(400);
    const ok = await ask(id, { text: "あ".repeat(QUESTION_MAX) });
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { task: Task }).task.questions).toHaveLength(1);
    const again = await ask(id, { text: "続けて" });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "invalid_operation",
      messages: [{ code: "chat.answering" }],
    });
    expect((await ask("nope", { text: "質問" })).status).toBe(409);
    activity.close();
  });

  it("設定に問題があれば、質問を記録せずに理由を返す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { id } = makeService(activity).service.createTask({
      projectId: "default",
      title: "決済API",
      body: "",
    });
    const { service } = makeService(activity, [], {
      config: () => ({ ok: false, problem: "config.yaml が読めません" }),
    });
    expect(() => service.askQuestion(id, { text: "質問" })).toThrow(
      expect.objectContaining({ messages: [{ code: "chat.unavailable" }] }),
    );
    expect(service.get(id)?.task.questions).toEqual([]);
    activity.close();
  });
});

describe("質問への答えで、各実行のセッションログを調べる（PBI-91）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const isChat = (invocation: Invocation) => (invocation.command[2] ?? "").includes("--- 質問 ---");
  const runIdOf = (service: TaskService, id: string, step: string) =>
    service.get(id)?.activity.find((e) => e.type === "AgentRunCompleted" && e.payload.step === step)
      ?.payload as { runId: string } | undefined;

  it("このタスクの各実行のログ（エージェントの元のファイルも）を読み取り専用で渡し、ログの中身から答えられる。ほかのタスクのログ・秘密の値は渡さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件 A"), out("# 要求要件 B")],
      { sessionLogs },
    );
    // 工程のエージェントが実際にしたこと（台帳には出ない）を、元のセッションのファイルに書かせる
    let did = "";
    executor.sessionFiles = () => ({
      "projects/w/session.jsonl": `${JSON.stringify({ type: "tool_use", name: "Bash", input: { command: did } })}\n`,
    });
    const a = service.createTask({ projectId: "default", title: "決済API", body: "冪等にする" });
    did = "npm test -- --grep 冪等キー";
    await service.runNext(a.id);
    const b = service.createTask({ projectId: "default", title: "別のタスク", body: "" });
    did = "cat 別のタスクの作業";
    await service.runNext(b.id);
    const reqRun = runIdOf(service, a.id, "requirements")?.runId ?? "";
    const otherRun = runIdOf(service, b.id, "requirements")?.runId ?? "";
    expect(reqRun).not.toBe("");

    // 答えの代わりに、マウントされたログを探して、何をしたかを答える
    executor.respond = (invocation) => {
      if (!isChat(invocation)) return undefined;
      const mount = invocation.mounts?.find((m) => m.containerPath === "/sacty-logs");
      if (!mount) return out("ログが無い");
      const files = readTree(mount.hostPath);
      const found = Object.entries(files).find(([path]) => path.includes("/agent/projects/"));
      const command = found ? /"command":"([^"]+)"/.exec(found[1])?.[1] : undefined;
      return out(`実行 ${found?.[0].split("/")[0]} で \`${command}\` を実行しました`, 1000);
    };
    const usedBefore = service.get(a.id)?.task.budget.usedUsd ?? 0;
    await service.askQuestion(a.id, { text: "要求要件でどんなコマンドを使った？" }).answered;

    const task = service.get(a.id)?.task;
    expect(task?.questions[0]?.answer?.text).toBe(
      `実行 ${reqRun} で \`npm test -- --grep 冪等キー\` を実行しました`,
    );
    // 費用はこれまでどおりタスクの予算に入る（1000出力トークン = $0.015）
    expect(task?.budget.usedUsd).toBeCloseTo(usedBefore + 0.015, 6);

    const mounted = executor.logMounts.at(-1);
    expect(mounted?.readOnly).toBe(true);
    expect(Object.keys(mounted?.files ?? {}).sort()).toEqual(
      [
        "index.json",
        `${reqRun}/agent/projects/w/session.jsonl`,
        `${reqRun}/events.jsonl`,
        `${reqRun}/meta.json`,
        `${reqRun}/stderr.log`,
      ].sort(),
    );
    const all = Object.values(mounted?.files ?? {}).join("\n");
    // ほかのタスクのログは渡さない
    expect(all).not.toContain(otherRun);
    expect(all).not.toContain("別のタスクの作業");
    // 実行に渡した秘密情報（偽の実行器がログに出している）は伏せてある
    expect(all).not.toContain("oauth-secret");
    expect(all).toContain("[REDACTED]");
    // 答えの実行の後に、並べた場所を消す（元のログは残る）
    expect(existsSync(mounted?.dir ?? "")).toBe(false);
    expect(sessionLogs.read(a.id, reqRun)).toBeTruthy();

    // Claude Code には、作業領域の外のログの場所を読める場所に足す（工程の実行には足さない）
    expect(executor.calls.at(-1)?.command).toEqual(
      expect.arrayContaining(["--add-dir", "/sacty-logs"]),
    );
    expect(executor.calls[0]?.command).not.toContain("--add-dir");
    // 指示には、一覧（どの工程・どの実行か）と読み方を入れる（中身は丸ごと入れない）
    const prompt = executor.calls.at(-1)?.command[2] ?? "";
    expect(prompt).toContain("/sacty-logs に読み取り専用で置きました");
    expect(prompt).toContain(
      `- [要求要件・1回目] 実行 ${reqRun} claude-subscription（claude-code）`,
    );
    expect(prompt).not.toContain("npm test -- --grep 冪等キー");
    expect(prompt).not.toContain(otherRun);
    activity.close();
  });

  it("オーケストレーター自身の実行と、これまでの質問への答えの実行のログも、どの実行かが分かる形で渡す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(
      activity,
      [
        out(
          '```json\n{"sacty-steps": {"plan": "skip-design", "reason": "小さい", "testCommand": "npm test"}}\n```',
        ),
        out("# 調査"),
        out("答え1"),
        out("答え2"),
      ],
      { realPlanner: true, sessionLogs },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    const orchestratorRun = (
      service.get(id)?.activity.find((e) => e.type === "StepsChosen")?.payload as
        | { runId?: string }
        | undefined
    )?.runId;
    const reqRun = runIdOf(service, id, "investigate")?.runId;
    await service.askQuestion(id, { text: "1つ目" }).answered;
    const chatRun = (
      service.get(id)?.activity.findLast((e) => e.type === "QuestionAnswered")?.payload as
        | { runId?: string }
        | undefined
    )?.runId;
    await service.askQuestion(id, { text: "2つ目" }).answered;
    const prompt = executor.calls.at(-1)?.command[2] ?? "";
    expect(prompt).toContain(`- [オーケストレーター・1回目] 実行 ${orchestratorRun} `);
    expect(prompt).toContain(`- [調査・1回目] 実行 ${reqRun} `);
    expect(prompt).toContain(`- [質問への答え（オーケストレーター）・1回目] 実行 ${chatRun} `);
    // 一覧は始めた順
    expect(prompt.indexOf(orchestratorRun ?? "")).toBeLessThan(prompt.indexOf(reqRun ?? ""));
    expect(prompt.indexOf(reqRun ?? "")).toBeLessThan(prompt.indexOf(chatRun ?? ""));
    const files = Object.keys(executor.logMounts.at(-1)?.files ?? {});
    expect(files).toContain(`${orchestratorRun}/events.jsonl`);
    expect(files).toContain(`${chatRun}/meta.json`);
    activity.close();
  });

  it("タスクのログの場所を開けないときは、ログの無い実行とせず、マウントせずに理由を伝えて台帳から答える", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), out("台帳から答えました")],
      {
        sessionLogs,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    await service.runNext(id);
    const reqRun = runIdOf(service, id, "requirements")?.runId ?? "";
    expect(reqRun).not.toBe("");
    // タスクのログの場所が、ディレクトリでなくなった
    const taskDir = join(dir, "runs", id);
    rmSync(taskDir, { recursive: true, force: true });
    writeFileSync(taskDir, "ディレクトリではない");
    await service.askQuestion(id, { text: "何をした？" }).answered;
    expect(service.get(id)?.task.questions[0]?.answer?.text).toBe("台帳から答えました");
    expect(executor.logMounts.at(-1)).toBeUndefined();
    const prompt = executor.calls.at(-1)?.command[2] ?? "";
    expect(prompt).toContain(
      "各実行のセッションログは、この質問では読めません（セッションログを用意できなかった：ENOTDIR）",
    );
    expect(prompt).not.toContain("/sacty-logs に読み取り専用で置きました");
    expect(prompt).not.toContain(`実行 ${reqRun}：ログが無い`);
    expect(executor.calls.at(-1)?.command).not.toContain("--add-dir");
    // 並べかけた場所は残さない
    expect(readdirSync(join(dir, "workspaces", "_question-logs"), { withFileTypes: true })).toEqual(
      [],
    );
    activity.close();
  });

  it("ログを用意できない・残していないときも、台帳から答え、ログを読めないことを伝える", async () => {
    class BrokenLogs extends SessionLogStore {
      override taskDir(): string | undefined {
        throw new Error("EACCES");
      }
    }
    for (const sessionLogs of [new BrokenLogs(join(dir, "runs")), undefined]) {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [out("工程はまだ決めていません。")], {
        ...(sessionLogs ? { sessionLogs } : {}),
      });
      const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
      await service.askQuestion(id, { text: "工程は？" }).answered;
      expect(service.get(id)?.task.questions[0]?.answer?.text).toBe("工程はまだ決めていません。");
      expect(executor.logMounts.at(-1)).toBeUndefined();
      expect(executor.calls.at(-1)?.command[2]).toContain(
        sessionLogs
          ? "各実行のセッションログは、この質問では読めません（セッションログを用意できなかった）"
          : "各実行のセッションログは、この質問では読めません（セッションログを残していない）",
      );
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });
});

describe("成果の書き出し（PBI-56）", () => {
  const out = (text: string, output = 1): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
  });
  /** 書き出しのエージェントの出力。100万出力トークン = $15 なので、1000 で $0.015。 */
  const exportOut = (v: Record<string, unknown>): AgentOutcome =>
    out(`書きました\n\n\`\`\`json\n${JSON.stringify({ "sacty-export": v })}\n\`\`\``, 1000);
  const URL1 = "https://wiki.example.com/pages/101";
  const confluence = () =>
    toPlatform(
      "confluence",
      PlatformFile.parse({
        upstream: "https://wiki.example.com",
        description: "Confluence（設計書は DEV スペース）",
        auth: { header: "Authorization", prefix: "Bearer ", secret: "wiki-token" },
        allow: ["GET /rest/api/content/**", "POST /rest/api/content", "PUT /rest/api/content/*"],
      }),
    );
  const secrets = {
    "claude-oauth-token": "oauth-secret",
    "github-token": "ghp_secret",
    "wiki-token": "wiki-secret-value",
    "docs-token": "docs-secret-value",
  };
  /** 決めた書き出し先を返す、オーケストレーターの代わり。 */
  const plannerWith =
    (exports: Record<string, unknown>): ServiceDeps["planner"] =>
    async () => ({
      steps: [...MVP_STEPS],
      fallback: false,
      testCommand: "npm test",
      costUsd: 0,
      estimated: false,
      exports: exports as never,
    });
  /** 要求要件を confluence に書き出し、設計は書き出さないと決める。 */
  const toConfluence = plannerWith({
    requirements: {
      to: { via: "platform", name: "confluence", location: "DEV スペースの「要件」" },
      reason: "規約で要件は Confluence に置く",
    },
    design: { reason: "設計は sacty の中だけで足りる" },
  });
  const investigateToConfluence: ServiceDeps["planner"] = async () => ({
    steps: [...STEP_PLANS.investigate],
    plan: "investigate",
    reason: "質問",
    fallback: false,
    costUsd: 0,
    estimated: false,
    exports: {
      investigate: { to: { via: "platform", name: "confluence", location: "" }, reason: "r" },
    },
  });
  const promptOf = (executor: { calls: Invocation[] }, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const exportEvents = (activity: SqliteActivityStore, id: string) =>
    activity.forTask(id).filter((e) => e.type === "OutputExported");
  const taskOf = (service: TaskService, id: string) => service.get(id)?.task as Task;
  const issue = {
    repo: "https://github.com/acme/app",
    number: 5,
    title: "再試行はどこ？",
    body: "",
    url: "https://github.com/acme/app/issues/5",
    labels: ["sacty"],
  };

  /** 工程を選んで要求要件を実行し、承認するところまで進める。 */
  async function approveRequirements(service: TaskService, id: string) {
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: current(service, id) });
  }

  it("オーケストレーターが決めた書き出し先と理由を記録し、承認した要求要件をゲートウェイの接続先に書き出して URL を残す（認証はコンテナにも作業履歴にも出ない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件 v1"), exportOut({ url: URL1 }), out("# 設計")],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
        secrets,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "決済の再送" });
    await approveRequirements(service, id);
    // 工程ごとの書き出し先（書き出さないことも含む）と理由（作業履歴と画面）
    const chosen = activity.forTask(id).find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.exports).toEqual({
      requirements: {
        to: { via: "platform", name: "confluence", location: "DEV スペースの「要件」" },
        reason: "規約で要件は Confluence に置く",
      },
      design: { reason: "設計は sacty の中だけで足りる" },
    });
    expect(exportDue(taskOf(service, id))).toBe("requirements");
    expect(service.queuedTaskIds()).toEqual([id]);

    // 承認の後、次の工程の前に書き出す
    await service.runNext(id);
    const call = executor.calls[1];
    expect(call?.env.SACTY_PF_URL).toBe("http://host.docker.internal:5001/r/sacty-gw-run/pf");
    const prompt = promptOf(executor, 1);
    expect(prompt).toContain("sacty-export.md");
    expect(prompt).toContain("$SACTY_PF_URL/confluence");
    expect(prompt).toContain("DEV スペースの「要件」");
    expect(prompt).toContain(
      "を含むページを探し、あればそのページを更新する（新しく作らない）。無ければ、新しいページを作る",
    );
    // 書き出す内容は、作業領域のファイルで渡す
    expect(executor.workspaceFiles[1]).toEqual(["sacty-export.md"]);
    const task = taskOf(service, id);
    expect(task.exports.requirements).toMatchObject({
      url: URL1,
      last: { submission: 1, via: "platform", name: "confluence", url: URL1 },
    });
    expect(task.status).toBe("queued");
    // 費用はタスクの予算に入る
    expect(task.budget.usedUsd).toBeCloseTo(0.015 + 0.000015, 6);
    const [exported] = exportEvents(activity, id);
    expect(exported).toMatchObject({
      actor: "agent",
      payload: { url: URL1, runResult: "completed", costUsd: 0.015 },
    });
    // 認証の値は、コンテナにも作業履歴にも出ない
    expect(JSON.stringify(executor.calls)).not.toContain("wiki-secret-value");
    expect(JSON.stringify(activity.forTask(id))).not.toContain("wiki-secret-value");

    // 続けて設計へ進む。書き出さないと決めた設計は、承認しても書き出さない
    await service.runNext(id);
    expect(executor.calls).toHaveLength(3);
    service.approve(id, { step: "design", submission: 1 });
    expect(exportDue(taskOf(service, id))).toBeUndefined();
    activity.close();
  });

  it("使える接続先が無ければ、書き出し先を決めさせず、承認しても書き出さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件"), out("# 設計")], {
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    const chosen = activity.forTask(id).find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.exports).toBeUndefined();
    await service.runNext(id);
    // 書き出さずに設計を実行した
    expect(executor.calls).toHaveLength(2);
    expect(exportEvents(activity, id)).toEqual([]);
    activity.close();
  });

  it("オーケストレーターに使える接続先（ゲートウェイの接続先・ホストの MCP）と規約を渡し、選んだ MCP サーバーで書き出す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const notion = toHostMcp(
      "notion",
      HostMcpFile.parse({ command: "notion-mcp", description: "Notion（チームのワークスペース）" }),
    );
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "rules.md": "# 規約\n\n要求要件は Notion の「仕様」に置く",
      },
    });
    const plan = out(
      `\`\`\`json\n${JSON.stringify({
        "sacty-steps": {
          plan: "skip-design",
          reason: "小さい",
          testCommand: "npm test",
          exports: {
            requirements: { to: "notion", via: "mcp", location: "仕様", reason: "規約で Notion" },
            design: { to: "confluence", reason: "設計も" },
          },
        },
      })}\n\`\`\``,
    );
    const { service, executor } = makeService(
      activity,
      [
        plan,
        out("# 調査の結果"),
        out("# 要求要件"),
        exportOut({ url: "https://notion.example.com/p/1" }),
      ],
      {
        config: configOf(agent(), 1, [confluence()], [notion]),
        gateway: fakeGateway(),
        contexts,
        realPlanner: true,
        secrets,
      },
    );
    service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    // 工程を選んで、前段の調査（人間の承認なし）と要求要件を実行する
    await service.runNext(id);
    await service.runNext(id);
    const orchestrator = promptOf(executor, 0);
    expect(orchestrator).toContain("confluence（via: platform・ゲートウェイの接続先）");
    expect(orchestrator).toContain(
      "notion（via: mcp・MCP サーバー）：Notion（チームのワークスペース）",
    );
    expect(orchestrator).toContain("要求要件は Notion の「仕様」に置く");
    // skip-design なので、書き出せる工程は要求要件だけ（設計の指定は使わない）
    expect(taskOf(service, id).exportPlans).toEqual({
      requirements: {
        to: { via: "mcp", name: "notion", location: "仕様" },
        reason: "規約で Notion",
      },
    });
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    // MCP サーバーは、ゲートウェイの HTTP の MCP として渡し、PF の URL は渡さない
    const call = executor.calls[3];
    expect(call?.env.SACTY_PF_URL).toBeUndefined();
    expect(JSON.parse(executor.mcpConfigs[3] ?? "{}").mcpServers.notion).toMatchObject({
      url: "http://host.docker.internal:5001/mcp/notion",
    });
    expect(promptOf(executor, 3)).toContain("MCP サーバー。そのツールで書く");
    expect(promptOf(executor, 3)).toContain("Notion（チームのワークスペース）");
    expect(taskOf(service, id).exports.requirements?.url).toBe("https://notion.example.com/p/1");
    activity.close();
  });

  it("ホストの MCP サーバーへの書き出しは、その MCP サーバーだけの準備を待ち、準備ができなければ、どれかがわかる理由を残して書き出さない（PBI-77）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const notion = toHostMcp("notion", HostMcpFile.parse({ command: "notion-mcp" }));
    const cloud = toHostMcp("private-cloud", HostMcpFile.parse({ command: "cloud-mcp" }));
    const waits: (readonly string[])[] = [];
    let notionProblem: ReturnType<typeof message>[] = [
      message("gateway.mcpReadyTimeout", { name: "notion", seconds: 300 }),
    ];
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ url: "https://notion.example.com/p/1" }), out("# 設計")],
      {
        config: configOf(agent(), 1, [], [notion, cloud]),
        gateway: fakeGateway(),
        planner: plannerWith({
          requirements: { to: { via: "mcp", name: "notion", location: "仕様" }, reason: "規約" },
        }),
        hostMcpReady: async (names) => {
          waits.push(names);
          return names.includes("notion") ? notionProblem : [];
        },
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    // 書き出しは、決めた接続先の MCP サーバーだけを待つ（エージェントは実行しない）
    expect(waits.at(-1)).toEqual(["notion"]);
    expect(executor.calls).toHaveLength(1);
    expect(taskOf(service, id).exports.requirements?.last?.failed).toEqual(
      message("export.failed", {
        detail: message("gateway.mcpReadyTimeout", { name: "notion", seconds: 300 }),
      }),
    );
    expect(taskOf(service, id).pausedReason).toBeUndefined();
    // 準備ができれば、書き出し直せる
    notionProblem = [];
    service.retryExport(id, "requirements");
    await service.runNext(id);
    expect(waits.at(-1)).toEqual(["notion"]);
    expect(taskOf(service, id).exports.requirements?.url).toBe("https://notion.example.com/p/1");
    activity.close();
  });

  it("使える接続先に無い名前・決めなかった工程は、理由を添えて書き出さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [out("# 要求要件")], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: plannerWith({ requirements: { to: { name: "nowhere" }, reason: "?" } }),
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    expect(taskOf(service, id).exportPlans).toEqual({
      requirements: { reason: message("export.destinationUnknown", { name: "nowhere" }) },
      design: { reason: message("export.notDecided") },
    });
    activity.close();
  });

  it("コンテキストの MCP サーバーでも書き出せる。認証のヘッダーはゲートウェイだけが持つ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "mcp.yaml": [
          "servers:",
          "  docs:",
          "    url: https://docs.example.com/mcp",
          "    headers:",
          "      Authorization: { secret: docs-token, prefix: 'Bearer ' }",
        ].join("\n"),
      },
    });
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ url: "https://docs.example.com/p/9" })],
      {
        gateway: fakeGateway(),
        contexts,
        secrets,
        planner: plannerWith({
          requirements: { to: { via: "mcp", name: "docs", location: "" }, reason: "規約" },
        }),
      },
    );
    service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    expect(taskOf(service, id).exportPlans?.requirements?.to?.name).toBe("docs");
    await service.runNext(id);
    const mcp = JSON.parse(executor.mcpConfigs[1] ?? "{}").mcpServers.docs;
    expect(mcp.url).toBe("http://host.docker.internal:5001/ctx-mcp/docs");
    expect(JSON.stringify(executor.calls[1])).not.toContain("docs-secret-value");
    expect(JSON.stringify(activity.forTask(id))).not.toContain("docs-secret-value");
    expect(taskOf(service, id).exports.requirements?.url).toBe("https://docs.example.com/p/9");
    activity.close();
  });

  it("書き出しには決めた MCP サーバーだけを渡す（ほかの MCP サーバーの認証が取れなくても書き出せる）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const contexts = new FakeContexts({
      "https://github.com/acme/ctx.git": {
        "mcp.yaml": [
          "servers:",
          "  docs:",
          "    url: https://docs.example.com/mcp",
          "    headers:",
          "      Authorization: { secret: docs-token, prefix: 'Bearer ' }",
          "  other:",
          "    url: https://other.example.com/mcp",
          "    headers:",
          "      Authorization: { secret: other-token, prefix: 'Bearer ' }",
        ].join("\n"),
      },
    });
    // 承認の後は、other の認証だけを取り出せなくする
    let otherGone = false;
    const values: Record<string, string> = { ...secrets, "other-token": "other-secret-value" };
    const secretStore = {
      async get(name: string) {
        if (name === "other-token" && otherGone) throw new Error("other-token を取り出せません");
        const value = values[name];
        if (value === undefined) throw new Error(`no secret ${name}`);
        return value;
      },
    };
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ url: "https://docs.example.com/p/9" })],
      {
        gateway: fakeGateway(),
        contexts,
        secretStore,
        planner: plannerWith({
          requirements: { to: { via: "mcp", name: "docs", location: "" }, reason: "規約" },
        }),
      },
    );
    service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/ctx.git" },
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    otherGone = true;
    await service.runNext(id);
    const servers = JSON.parse(executor.mcpConfigs[1] ?? "{}").mcpServers;
    expect(Object.keys(servers)).toEqual(["docs"]);
    expect(taskOf(service, id).exports.requirements?.url).toBe("https://docs.example.com/p/9");
    expect(JSON.stringify(executor.calls[1])).not.toContain("other");
    activity.close();
  });

  it("書き出せなければ理由を残して進め（タスクは止めない）、画面から書き出し直せる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        out("# 要求要件"),
        exportOut({ error: "スペース DEV に書き込む権限がありません" }),
        out("# 設計"),
        exportOut({ url: URL1 }),
      ],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
        secrets,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    // 書き出し直せるのは、書き出せなかったものだけ
    expect(() => service.retryExport(id, "requirements")).toThrow(InvalidOperationError);
    await service.runNext(id);
    const failed = taskOf(service, id).exports.requirements;
    expect(failed?.url).toBeUndefined();
    expect(ja(failed?.last?.failed)).toContain("スペース DEV に書き込む権限がありません");
    // タスクは止まらず、設計へ進む
    expect(taskOf(service, id).status).toBe("queued");
    await service.runNext(id);
    expect(taskOf(service, id).gate?.step).toBe("design");
    expect(() => service.retryExport(id, "design")).toThrow(InvalidOperationError);
    expect(() => service.retryExport(id, "nope")).toThrow(InvalidOperationError);
    // 画面から書き出し直す（設計の承認待ちのまま）
    service.retryExport(id, "requirements");
    expect(() => service.retryExport(id, "requirements")).toThrow(InvalidOperationError);
    expect(service.queuedTaskIds()).toEqual([id]);
    await service.runNext(id);
    expect(taskOf(service, id).exports.requirements).toMatchObject({
      url: URL1,
      last: { url: URL1 },
    });
    expect(taskOf(service, id).exports.requirements?.retry).toBeUndefined();
    expect(taskOf(service, id).status).toBe("awaiting_approval");
    expect(executor.calls).toHaveLength(4);
    expect(service.queuedTaskIds()).toEqual([]);
    activity.close();
  });

  it("結果を読めなかった（ページを作ったかもしれない）書き出しを書き出し直すと、作る前に目印で既存のページを探させる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        out("# 要求要件"),
        out("ページを作りました（結果の JSON を出し忘れた）"),
        out("# 設計"),
        exportOut({ url: URL1 }),
      ],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
        secrets,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id); // 書き出し（結果を読めない）
    expect(taskOf(service, id).exports.requirements?.last?.failed).toBeDefined();
    await service.runNext(id); // 設計
    service.retryExport(id, "requirements");
    await service.runNext(id);
    const retried = promptOf(executor, 3);
    expect(retried).toContain(
      "目印「sacty-export:" +
        id +
        ":requirements」を含むページを探し、あればそのページを更新する（新しく作らない）",
    );
    expect(retried).not.toContain("置き場所に、新しいページを作る");
    expect(taskOf(service, id).exports.requirements?.url).toBe(URL1);
    activity.close();
  });

  it("接続できない（エージェントの実行に失敗した・接続先が設定から消えた）ときも、理由を残して進める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    let platforms = [confluence()];
    const config = () => configOf(agent(), 1, platforms)();
    const { service, executor } = makeService(
      activity,
      [
        out("# 要求要件"),
        { kind: "failed", reason: "error", message: "connect ECONNREFUSED wiki.example.com" },
        out("# 設計"),
      ],
      { config, gateway: fakeGateway(), planner: toConfluence },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    expect(taskOf(service, id).exports.requirements?.last?.failed).toEqual(
      message("export.failed", { detail: "connect ECONNREFUSED wiki.example.com" }),
    );
    expect(taskOf(service, id).pausedReason).toBeUndefined();
    await service.runNext(id);
    expect(taskOf(service, id).gate?.step).toBe("design");
    // 接続先が設定から消えた（エージェントは実行しない）
    platforms = [];
    service.retryExport(id, "requirements");
    await service.runNext(id);
    expect(taskOf(service, id).exports.requirements?.last?.failed).toEqual(
      message("export.destinationMissing", { name: "confluence" }),
    );
    expect(executor.calls).toHaveLength(3);
    expect(taskOf(service, id).status).toBe("awaiting_approval");
    activity.close();
  });

  it("予算の上限に達していれば、書き出さずに理由を残す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件", 70_000)], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    expect(taskOf(service, id).exports.requirements?.last?.failed).toEqual(
      message("export.budgetExceeded"),
    );
    expect(executor.calls).toHaveLength(1);
    activity.close();
  });

  it("差し戻しの後に承認し直すと、前に書き出したページを更新させる（新しく作らない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        out("# 要求要件 v1"),
        exportOut({ url: URL1 }),
        out("# 設計"),
        out("# 要求要件 v2"),
        exportOut({ url: URL1 }),
      ],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    await service.runNext(id);
    // 設計の承認待ちで、要求要件まで差し戻す（承認を取り消すので、書き出しは待たない）
    service.requestChanges(id, {
      step: "design",
      submission: 1,
      target: "requirements",
      comments: ["受け入れ条件を足して"],
    });
    expect(exportDue(taskOf(service, id))).toBeUndefined();
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 2 });
    expect(exportDue(taskOf(service, id))).toBe("requirements");
    await service.runNext(id);
    const prompt = promptOf(executor, 4);
    expect(prompt).toContain(`前にこの成果を書き出したページ（${URL1}）を、この内容で更新する`);
    expect(prompt).not.toContain("新しいページを作る");
    expect(taskOf(service, id).exports.requirements).toMatchObject({
      url: URL1,
      last: { submission: 2, url: URL1 },
    });
    expect(exportEvents(activity, id)).toHaveLength(2);
    activity.close();
  });

  it("書き出しの後・記録の前にデーモンが止まったら、再起動の後に目印のあるページを探して更新させ、二重に書き出さない", async () => {
    const first = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(first, [out("# 要求要件"), HOLD as never], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    void service.runNext(id);
    await executor.started.promise;
    // 書き出しを始めた記録だけがある（ここでデーモンが止まった）
    expect(first.forTask(id).at(-1)?.type).toBe("ExportStarted");
    first.close();

    const second = new SqliteActivityStore(dbPath);
    const restarted = makeService(second, [exportOut({ url: URL1 }), out("# 設計")], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    restarted.service.recoverInterrupted();
    expect(restarted.service.queuedTaskIds()).toEqual([id]);
    await restarted.service.runNext(id);
    const prompt = promptOf(restarted.executor, 0);
    expect(prompt).toContain(`目印「sacty-export:${id}:requirements」を含むページを探し`);
    expect(restarted.executor.workspaceFiles[0]).toEqual(["sacty-export.md"]);
    const exported = taskOf(restarted.service, id).exports.requirements;
    expect(exported?.url).toBe(URL1);
    expect(exported?.started).toBeUndefined();
    // 書き出しの後は、続けて設計へ進む
    await restarted.service.runNext(id);
    expect(taskOf(restarted.service, id).gate?.step).toBe("design");
    second.close();
  });

  it("書き出し中に一時停止すると、結果を記録せずに止まり、再開すると目印で探して書き出しを続ける", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [out("# 要求要件"), HOLD as never, exportOut({ url: URL1 })],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    const running = service.runNext(id);
    await executor.started.promise;
    await service.pause(id);
    await running;
    const paused = taskOf(service, id);
    expect(paused.status).toBe("paused");
    expect(paused.exports.requirements?.started).toBeDefined();
    expect(paused.exports.requirements?.last).toBeUndefined();
    expect(exportEvents(activity, id).at(-1)?.payload).toMatchObject({
      runResult: "interrupted",
      failed: message("export.stopped"),
    });
    // 一時停止中は書き出さない
    expect(service.queuedTaskIds()).toEqual([]);
    service.resume(id, {});
    await service.runNext(id);
    expect(promptOf(executor, 2)).toContain(`目印「sacty-export:${id}:requirements」`);
    expect(taskOf(service, id).exports.requirements?.url).toBe(URL1);
    activity.close();
  });

  it("書き出し中に中止すると、コンテナを止めて中止できる（以後は書き出さない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [out("# 要求要件"), HOLD as never], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    const running = service.runNext(id);
    const runId = await executor.started.promise;
    const cancelled = await service.cancel(id);
    await running;
    expect(executor.killed).toContain(runId);
    expect(cancelled.status).toBe("cancelled");
    expect(exportDue(cancelled)).toBeUndefined();
    expect(service.queuedTaskIds()).toEqual([]);
    expect(() => service.retryExport(id, "requirements")).toThrow(InvalidOperationError);
    activity.close();
  });

  it("書き出せなかった理由は、秘密情報を伏せてから切り詰める（境界をまたぐトークンを残さない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    // 理由の上限（1000文字）の境界を、実行ごとのトークンがまたぐ
    const error = `${"x".repeat(995)}sacty-gw-run の認証で拒否されました`;
    const { service } = makeService(activity, [out("# 要求要件"), exportOut({ error })], {
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: toConfluence,
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    const failed = ja(taskOf(service, id).exports.requirements?.last?.failed);
    expect(failed).toContain("x".repeat(995));
    expect(failed).not.toContain("sacty");
    expect(JSON.stringify(activity.forTask(id))).not.toContain("sacty-gw");
    activity.close();
  });

  it("Issue から取り込んだ調査のタスクは、書き出してから、書き出した先の URL を添えて Issue にコメントする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const { service } = makeService(activity, [out("# 調査の結果"), exportOut({ url: URL1 })], {
      pulls,
      config: configOf(agent(), 1, [confluence()]),
      gateway: fakeGateway(),
      planner: investigateToConfluence,
    });
    const [task] = service.importIssues([issue]);
    const id = task?.id ?? "";
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    expect(awaitingIssueComment(taskOf(service, id))).toBe(false);
    await service.runNext(id);
    // 書き出しの前には、コメントしない
    expect(pulls.issueComments).toHaveLength(0);
    await service.runNext(id);
    expect(pulls.issueComments[0]?.body).toContain(`書き出した先：${URL1}`);
    expect(service.queuedTaskIds()).toEqual([]);
    activity.close();
  });

  it("書き出せなかったときは、URL を添えずに Issue にコメントする（いまの仕様にフォールバックする）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const { service } = makeService(
      activity,
      [out("# 調査の結果"), exportOut({ error: "接続できません" })],
      {
        pulls,
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: investigateToConfluence,
      },
    );
    const [task] = service.importIssues([issue]);
    const id = task?.id ?? "";
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    await service.runNext(id);
    await service.runNext(id);
    expect(pulls.issueComments).toHaveLength(1);
    expect(pulls.issueComments[0]?.body).toContain("# 調査の結果");
    expect(pulls.issueComments[0]?.body).not.toContain("書き出した先");
    activity.close();
  });

  it("書き出しの API から、承認済みの成果を書き出し直せる（書き出せないものは 409）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [out("# 要求要件"), exportOut({ error: "だめ" }), out("# 設計")],
      {
        config: configOf(agent(), 1, [confluence()]),
        gateway: fakeGateway(),
        planner: toConfluence,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await approveRequirements(service, id);
    await service.runNext(id);
    const app = createApp(service, "export-token");
    const headers = { authorization: "Bearer export-token" };
    const denied = await app.request(`/api/tasks/${id}/exports/design/retry`, {
      method: "POST",
      headers,
    });
    expect(denied.status).toBe(409);
    const ok = await app.request(`/api/tasks/${id}/exports/requirements/retry`, {
      method: "POST",
      headers,
    });
    expect(ok.status).toBe(200);
    expect(taskOf(service, id).exports.requirements?.retry).toBe(true);
    activity.close();
  });
});

describe("要求要件・設計の PR（タスクブランチへのフロー。PBI-57）", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const design = (title = "# 設計") =>
    out(
      [
        title,
        block({
          "sacty-test-viewpoints": [
            { title: "同じキーの再送", input: "同じキーで2回送る", expected: "決済は1回" },
          ],
        }),
      ].join("\n\n"),
    );
  const implement = (
    text = "# 実装の説明",
    map: { viewpointId: string; tests: string[] }[] = [
      { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] },
    ],
  ) => out([text, block({ "sacty-test-map": map })].join("\n\n"));
  const review = (viewpoints: string[] = ["TV-1"], remarks: string[] = []) =>
    out(
      block({
        "sacty-final-review": {
          viewpoints: viewpoints.map((id) => ({ id, verified: true, reason: `${id}の判定理由` })),
          remarks: remarks.map((id) => ({ id, notRecurred: true, reason: `${id}の判定理由` })),
          summary: "所見",
        },
      }),
    );
  const rework = (target: string, reason = "理由") =>
    out(block({ "sacty-rework": { target, reason } }));
  const at = "2026-10-11T00:00:00Z";
  /** 最後のフィードバックから、書き終わるのを待つ時間がたった時刻。 */
  const later = () => Date.parse(at) + 3 * 60_000;
  const item = (key: string, patch: Partial<PullRequestFeedback> = {}): PullRequestFeedback => ({
    key,
    kind: "comment",
    author: "reviewer",
    at,
    body: "受け入れ条件が曖昧",
    ...patch,
  });
  const types = (svc: TaskService, id: string) => svc.get(id)?.activity.map((e) => e.type) ?? [];
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const taskOf = (svc: TaskService, id: string) => svc.get(id)?.task as Task;
  const taskBranchOf = (id: string) => `sacty/task-${id.slice(0, 8)}`;
  const docOf = (id: string, step: string, dir = "docs/sacty") =>
    `${dir}/${id.slice(0, 8)}/${step}.md`;

  async function drain(service: TaskService, max = 12) {
    for (let i = 0; i < max; i++) {
      const ids = service.queuedTaskIds();
      if (ids.length === 0) return;
      for (const id of ids) await service.runNext(id);
    }
  }

  type Made = Awaited<ReturnType<typeof start>>;
  type Planned = Awaited<ReturnType<NonNullable<ServiceDeps["planner"]>>>;

  /** 要求要件・設計を PR で承認する設定で、タスクを作って最初の工程まで進める。 */
  async function start(
    outcomes: AgentOutcome[],
    options: {
      steps?: StepKey[];
      documentsDir?: string;
      exports?: Planned["exports"];
      pulls?: FakePulls;
      repos?: FakeRepos;
      projects?: MemoryProjectStore;
      config?: () => ConfigResult;
      gateway?: ServiceDeps["gateway"];
      db?: string;
      settings?: MemorySettingsStore;
      github?: FakeGitHub;
    } = {},
  ) {
    const activity = new SqliteActivityStore(options.db ?? dbPath);
    const pulls = options.pulls ?? new FakePulls();
    const repos = options.repos ?? new FakeRepos();
    const made = makeService(activity, outcomes, {
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.github ? { github: options.github } : {}),
      stepPullRequests: true,
      now: later,
      pulls,
      repos,
      ...(options.projects ? { projects: options.projects } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.gateway ? { gateway: options.gateway } : {}),
      planner: async () => ({
        steps: [...(options.steps ?? MVP_STEPS)],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
        ...(options.documentsDir ? { documentsDir: options.documentsDir } : {}),
        ...(options.exports ? { exports: options.exports } : {}),
      }),
    });
    const { id } = made.service.createTask({
      projectId: "default",
      title: "決済API",
      body: "タスクの本文",
    });
    await made.service.runNext(id);
    return { activity, ...made, id };
  }

  /** 工程の PR を、GitHub でマージしたことにする（タスクブランチは、マージのコミットに進む）。 */
  async function merge(made: Pick<Made, "service" | "pulls" | "repos" | "id">, step: StepKey) {
    const { service, pulls, repos, id } = made;
    const task = taskOf(service, id);
    const pr =
      step === "implement"
        ? { number: task.pullRequest?.number ?? 0, commit: task.pullRequest?.commit }
        : task.stepPullRequests.findLast((p) => p.step === step);
    if (!pr) throw new Error(`no pull request for ${step}`);
    pulls.states[pr.number] = { state: "merged", mergedBy: "reviewer", headSha: pr.commit };
    repos.remote[taskBranchOf(id)] = `m${pr.number}`.padEnd(40, "0");
    await service.checkPullRequests();
  }

  it("タスクブランチに sacty が積んでいない変更があれば、実装で消さないよう、実装の PR を出さずに止める（レビュー指摘）", async () => {
    const made = await start([
      out("# 要求要件"),
      design(),
      implement(),
      review(),
      rework("implement"),
      implement("# 直した実装"),
      review(["TV-1"], ["implement-1-1"]),
    ]);
    const { service, repos, pulls, id } = made;
    await merge(made, "requirements");
    await service.runNext(id);
    await merge(made, "design");
    // 人がタスクブランチに直接積んだ（要求要件・設計のファイルの変更は、sacty のものなので除く）
    repos.changed = [docOf(id, "requirements"), "human-fix.ts", "src/b.ts"];
    await drain(service);
    const task = taskOf(service, id);
    expect(task.status).toBe("paused");
    const text = ja(task.pausedMessage);
    expect(text).toContain(
      `タスクブランチ ${taskBranchOf(id)} に、sacty が積んでいない変更があります（human-fix.ts, src/b.ts）`,
    );
    expect(text).not.toContain("requirements.md");
    // 起点（sacty がまだ実装を積んでいない）から、タスクブランチの先頭までを確かめた
    expect(repos.changedCalls.at(-1)).toEqual({ from: "base123", to: "m8".padEnd(40, "0") });
    expect(repos.published).toEqual([]);
    expect(pulls.calls.filter((c) => c.baseBranch === "main")).toEqual([]);
    // 人が取り除いて再開すると、実装の PR を出す
    repos.changed = [docOf(id, "requirements"), docOf(id, "design")];
    service.resume(id, {});
    await drain(service);
    expect(repos.published).toHaveLength(1);
    const implPr = pulls.calls.filter((c) => c.baseBranch === "main");
    expect(implPr).toHaveLength(1);
    // 実装の PR の指摘で実装をやり直して出し直すときは、sacty が積んだ実装のコミットの後の変更を確かめる
    // （起点から確かめると、sacty 自身の実装の変更を人の変更と取り違える）
    const pushed = taskOf(service, id).pushedBranch?.commit ?? "";
    expect(pushed).not.toBe("");
    // タスクブランチは、sacty の実装のコミットの後に進んでいる（GitHub の画面で PR のブランチを更新したなど。中身は同じ）
    repos.remote[taskBranchOf(id)] = "d".repeat(40);
    repos.changed = [];
    const number = taskOf(service, id).pullRequest?.number ?? 0;
    pulls.feedbackBy[number] = [item("comment:50", { body: "エラー時の処理が無い" })];
    await service.checkPullRequests();
    await drain(service);
    expect(repos.changedCalls.at(-1)?.from).toBe(pushed);
    expect(repos.published).toHaveLength(2);
    made.activity.close();
  });

  it("タスクブランチを作り、要求要件・設計の PR を成果のファイル入りでタスクブランチに向けて順に作り、マージで承認して進み、実装の PR はベースブランチに向ける（受け入れ条件 1・2・4）", async () => {
    const made = await start([out("# 要求要件 v1"), design(), implement(), review()]);
    const { activity, service, repos, pulls, id } = made;
    const taskBranch = taskBranchOf(id);
    // 1. タスクブランチ（起点のコミットから）と、要求要件のブランチ・PR
    expect(repos.pushedCommits).toEqual([{ commit: "base123", branch: taskBranch }]);
    expect(types(service, id).slice(-6)).toEqual([
      "AgentRunCompleted",
      "TaskBranchCreated",
      "StepBranchPushed",
      "StepPullRequestPublished",
      "StepSubmitted",
      // 取り込むラベル（PBI-88）
      "PullRequestLabeled",
    ]);
    const completedAt = service
      .get(id)
      ?.activity.findLast((e) => e.type === "AgentRunCompleted")?.at;
    expect(repos.committedFiles[0]).toMatchObject({
      parent: "base123",
      branch: `${taskBranch}-requirements-1`,
      message: `[要求要件] 決済API\n\nsacty task ${id}`,
      // 再開しても同じコミットを作れるよう、成果ができた時刻にする
      date: completedAt,
      allowEmpty: true,
    });
    expect(Object.keys(repos.committedFiles[0]?.files ?? {})).toEqual([docOf(id, "requirements")]);
    expect(repos.committedFiles[0]?.files[docOf(id, "requirements")]).toContain("# 要求要件 v1");
    expect(pulls.calls[0]).toMatchObject({
      repo: "https://github.com/acme/app",
      token: "ghp_secret",
      branch: `${taskBranch}-requirements-1`,
      baseBranch: taskBranch,
      title: "[要求要件] 決済API",
    });
    expect(pulls.calls[0]?.number).toBeUndefined();
    expect(pulls.calls[0]?.body).toContain("この PR をマージすると、要求要件を承認したことになり");
    expect(pulls.calls[0]?.body).toContain(docOf(id, "requirements"));
    let task = taskOf(service, id);
    expect(task.status).toBe("awaiting_approval");
    expect(task.gate).toEqual({ step: "requirements", submission: 1 });
    expect(task.taskBranch).toEqual({ branch: taskBranch, commit: "base123" });
    expect(task.stepPullRequests).toMatchObject([
      { step: "requirements", number: 7, state: "open", submission: 1, base: "base123" },
    ]);
    // 2. PR を作った工程は、画面からは承認できない（PR への案内）
    expect(() => service.approve(id, { step: "requirements", submission: 1 })).toThrow(/pull\/7/);
    // 開いたままなら何も記録しない
    await service.checkPullRequests();
    expect(types(service, id).at(-1)).toBe("PullRequestLabeled");

    // マージで承認として記録し、次の工程（設計）に進む
    await merge(made, "requirements");
    const merged = service.get(id)?.activity.slice(-2) ?? [];
    expect(merged.map((e) => [e.type, e.actor])).toEqual([
      ["PullRequestMerged", "person"],
      ["StepApproved", "person"],
    ]);
    expect(merged[1]?.payload).toEqual({ step: "requirements", next: "queued" });
    task = taskOf(service, id);
    expect(task.approved.requirements?.output).toBe("# 要求要件 v1");
    expect(task.stepPullRequests[0]?.state).toBe("merged");
    expect(task.status).toBe("queued");

    // 3. 設計は、マージ後のタスクブランチの先頭から、設計のブランチ・PR を作る（テスト観点もファイルに入れる）
    await service.runNext(id);
    expect(repos.committedFiles[1]).toMatchObject({
      parent: "m7".padEnd(40, "0"),
      branch: `${taskBranch}-design-1`,
    });
    const designDoc = repos.committedFiles[1]?.files[docOf(id, "design")] ?? "";
    expect(designDoc).toContain("# 設計");
    expect(designDoc).toContain("## テスト観点");
    expect(designDoc).toContain("[TV-1] 同じキーの再送");
    expect(pulls.calls[1]).toMatchObject({
      branch: `${taskBranch}-design-1`,
      baseBranch: taskBranch,
      title: "[設計] 決済API",
    });
    expect(pulls.calls[1]?.body).toContain("https://github.com/acme/app/pull/7");
    expect(taskOf(service, id).gate).toEqual({ step: "design", submission: 1 });
    expect(() => service.approve(id, { step: "design", submission: 1 })).toThrow(/マージ/);
    await merge(made, "design");
    expect(taskOf(service, id).approved.design?.testViewpoints).toHaveLength(1);

    // 4. タスクブランチで実装し、実装の PR はタスクブランチからベースブランチに向ける（CI が動く）
    await drain(service);
    expect(repos.published).toEqual([
      {
        parent: "m8".padEnd(40, "0"),
        branch: taskBranch,
        message: `決済API\n\nsacty task ${id}`,
        date: taskOf(service, id).lastReview?.at,
        keep: {
          commit: "m8".padEnd(40, "0"),
          paths: [docOf(id, "requirements"), docOf(id, "design")],
        },
      },
    ]);
    expect(pulls.calls[2]).toMatchObject({
      branch: taskBranch,
      baseBranch: "main",
      title: "決済API",
    });
    expect(pulls.calls[2]?.body).toContain("## 要求要件・設計の PR（マージで承認済み）");
    expect(pulls.calls[2]?.body).toContain("- 設計：https://github.com/acme/app/pull/8");
    task = taskOf(service, id);
    expect(task.gate).toEqual({ step: "implement", submission: 1 });
    expect(task.pullRequest).toMatchObject({ number: 9, branch: taskBranch });
    // 要求要件・設計・実装の PR のすべてに、レビュー用のラベルを付ける（PBI-88・PBI-99）
    expect(pulls.labels.map((l) => [l.number, l.label])).toEqual([
      [7, "sacty-review"],
      [8, "sacty-review"],
      [9, "sacty-review"],
    ]);
    await merge(made, "implement");
    const done = taskOf(service, id);
    expect(isCompleted(done)).toBe(true);
    // トークンは作業履歴に残さない
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("ghp_secret");
    // 再起動しても同じ状態を復元する
    activity.close();
    const again = new SqliteActivityStore(dbPath);
    expect(makeService(again, [], { stepPullRequests: true }).service.get(id)?.task).toEqual(done);
    again.close();
  });

  it("PR の指摘でゴールガーディアンがこの工程と判断したら、要求要件をやり直して同じ PR を更新する。判断と理由は台帳に残る（受け入れ条件 3）", async () => {
    const made = await start([
      out("# 要求要件 v1"),
      rework("requirements", "要求要件で直せる"),
      out(
        [
          "# 要求要件 v2",
          block({ "sacty-responses": [{ remarkId: "requirements-1-1", text: "条件を書いた" }] }),
        ].join("\n\n"),
      ),
    ]);
    const { activity, service, executor, repos, pulls, id } = made;
    pulls.feedbackBy[7] = [
      item("review:1", { kind: "review", body: "", requestChanges: true }),
      item("review_comment:2", {
        kind: "review_comment",
        path: docOf(id, "requirements"),
        line: 3,
        body: "ここが曖昧",
      }),
      item("comment:3"),
    ];
    const before = executor.calls.length;
    await service.checkPullRequests();
    expect(pulls.feedbackNumbers).toContain(7);
    const events = service.get(id)?.activity ?? [];
    expect(events.find((e) => e.type === "PullRequestReviewImported")?.payload).toMatchObject({
      number: 7,
      items: [{ key: "review:1" }, { key: "review_comment:2" }, { key: "comment:3" }],
    });
    expect(events.slice(-2).map((e) => [e.type, e.actor])).toEqual([
      ["ReworkJudged", "guardian"],
      ["ChangesRequested", "person"],
    ]);
    expect(events.at(-2)?.payload).toMatchObject({
      target: "requirements",
      reason: "要求要件で直せる",
    });
    // ゴールガーディアンには、PR の要求要件と指摘を、起点のコードの写しとあわせて渡す
    const prompt = promptOf(executor, before);
    expect(prompt).toContain("要求要件の PR に人間が付けた指摘");
    expect(prompt).toContain("# 要求要件 v1");
    expect(prompt).toContain(`${docOf(id, "requirements")}:3：ここが曖昧`);
    expect(prompt).toContain("requirements（要求要件）：この PR の要求要件を直せば解消できる");
    expect(prompt).not.toContain("implement（実装）");
    expect(executor.workspaceFiles[before]).toEqual(["README.md"]);
    let task = taskOf(service, id);
    expect(task.status).toBe("queued");
    expect(task.remarks.map((r) => r.id)).toEqual([
      "requirements-1-1",
      "requirements-1-2",
      "requirements-1-3",
    ]);
    expect(task.prRework).toMatchObject({ target: "requirements", decided: true });

    // やり直した要求要件は、同じブランチの最新（人がレビューの提案をコミットしていれば、その上）に積んで同じ PR を更新する
    expect(repos.remote[`${taskBranchOf(id)}-requirements-1`]).toBe(
      repos.committedFiles[0]?.commit,
    );
    repos.remote[`${taskBranchOf(id)}-requirements-1`] = "e".repeat(40);
    await service.runNext(id);
    expect(repos.committedFiles[1]).toMatchObject({
      parent: "e".repeat(40),
      branch: `${taskBranchOf(id)}-requirements-1`,
    });
    expect(repos.committedFiles[1]?.allowEmpty).toBeUndefined();
    expect(pulls.calls[1]?.number).toBe(7);
    expect(pulls.calls[1]?.body).toContain("## 指摘への対応");
    expect(pulls.calls[1]?.body).toContain("対応：条件を書いた");
    task = taskOf(service, id);
    expect(task.gate).toEqual({ step: "requirements", submission: 2 });
    expect(task.stepPullRequests).toMatchObject([{ number: 7, submission: 2, state: "open" }]);
    // 取り込んだ指摘は二重に取り込まない
    await service.checkPullRequests();
    expect(
      service.get(id)?.activity.filter((e) => e.type === "PullRequestReviewImported"),
    ).toHaveLength(1);
    activity.close();
  });

  it("戻し先を判断できなければ、その工程（要求要件）をやり直し、判断できなかったことと理由を残す", async () => {
    const made = await start([
      out("# 要求要件 v1"),
      rework("undecidable", "読み取れない"),
      out("# v2"),
    ]);
    const { activity, service, pulls, id } = made;
    pulls.feedbackBy[7] = [item("comment:9")];
    await service.checkPullRequests();
    const task = taskOf(service, id);
    expect(task.remarks.at(-1)).toMatchObject({ step: "requirements" });
    expect(task.prRework).toMatchObject({
      target: "requirements",
      decided: false,
      reason: "読み取れない",
    });
    activity.close();
  });

  it("設計の PR の指摘で要求要件に戻したら、要求要件の直しの PR をタスクブランチに新しく作り、マージされたら設計の PR を作り直す（受け入れ条件 5）", async () => {
    const made = await start([
      out("# 要求要件 v1"),
      design("# 設計 v1"),
      rework("requirements", "前提が誤っている"),
      out("# 要求要件 v2"),
      design("# 設計 v2"),
    ]);
    const { activity, service, executor, repos, pulls, id } = made;
    const taskBranch = taskBranchOf(id);
    await merge(made, "requirements");
    await service.runNext(id);
    expect(taskOf(service, id).gate).toEqual({ step: "design", submission: 1 });
    pulls.feedbackBy[8] = [item("comment:20", { body: "そもそも対象が違う" })];
    const before = executor.calls.length;
    await service.checkPullRequests();
    // 設計の PR では、設計のやり直しか要求要件への差し戻しかを判断させる
    const prompt = promptOf(executor, before);
    expect(prompt).toContain("design（設計）：この PR の設計を直せば解消できる");
    expect(prompt).toContain("requirements（要求要件）：承認済みの要求要件そのもの");
    expect(prompt).toContain("--- 承認済みの要求要件 ---");
    let task = taskOf(service, id);
    expect(task.steps.map((s) => s.state)).toEqual(["active", "todo", "todo"]);
    expect(task.approved).toEqual({});
    expect(task.prRework).toMatchObject({ target: "requirements", decided: true });

    // マージ済みの要求要件の PR は戻さず、タスクブランチの最新から直しの PR を新しく作る
    await service.runNext(id);
    expect(repos.committedFiles[2]).toMatchObject({
      parent: "m7".padEnd(40, "0"),
      branch: `${taskBranch}-requirements-2`,
      allowEmpty: true,
    });
    expect(pulls.calls[2]).toMatchObject({ baseBranch: taskBranch });
    expect(pulls.calls[2]?.number).toBeUndefined();
    task = taskOf(service, id);
    expect(task.gate).toEqual({ step: "requirements", submission: 2 });
    expect(task.stepPullRequests.map((p) => [p.step, p.number, p.state])).toEqual([
      ["requirements", 7, "merged"],
      ["design", 8, "open"],
      ["requirements", 9, "open"],
    ]);

    // 直しがマージされたら、設計の PR を作り直す（前の設計の PR は閉じる）
    await merge(made, "requirements");
    await service.runNext(id);
    expect(pulls.closed.map((c) => c.number)).toEqual([8]);
    expect(repos.committedFiles[3]).toMatchObject({
      parent: "m9".padEnd(40, "0"),
      branch: `${taskBranch}-design-2`,
    });
    expect(repos.committedFiles[3]?.files[docOf(id, "design")]).toContain("# 設計 v2");
    task = taskOf(service, id);
    expect(task.gate).toEqual({ step: "design", submission: 2 });
    expect(task.stepPullRequests.map((p) => [p.step, p.number, p.state, p.superseded])).toEqual([
      ["requirements", 7, "merged", undefined],
      ["design", 8, "closed", true],
      ["requirements", 9, "merged", undefined],
      ["design", 10, "open", undefined],
    ]);
    expect(
      service.get(id)?.activity.findLast((e) => e.type === "StepPullRequestPublished")?.payload,
    ).toMatchObject({ number: 10, supersedes: 8 });
    // 作り直した PR（新しい番号）には、取り込むラベルを付ける（1つの PR に1回。PBI-88）
    expect(pulls.labels.map((l) => l.number)).toEqual([7, 8, 9, 10]);
    activity.close();
  });

  it("実装の PR の指摘で設計に戻したら、設計の直しの PR を作り、マージされたら実装をやり直して実装の PR を更新する（受け入れ条件 5）", async () => {
    const made = await start([
      out("# 要求要件 v1"),
      design("# 設計 v1"),
      implement(),
      review(),
      rework("design", "観点が足りない"),
      design("# 設計 v2"),
      implement("# 実装の説明 v2"),
      review(["TV-1"], ["design-1-1"]),
    ]);
    const { activity, service, repos, pulls, id } = made;
    const taskBranch = taskBranchOf(id);
    await merge(made, "requirements");
    await service.runNext(id);
    await merge(made, "design");
    await drain(service);
    expect(taskOf(service, id).gate).toEqual({ step: "implement", submission: 1 });
    pulls.feedbackBy[9] = [item("comment:30", { body: "観点が足りない" })];
    await service.checkPullRequests();
    expect(taskOf(service, id).steps.map((s) => s.state)).toEqual(["done", "active", "todo"]);
    await service.runNext(id);
    // 設計の直しは、タスクブランチの最新（実装を積んだもの）から新しい PR にする
    expect(repos.committedFiles.at(-1)).toMatchObject({
      parent: "c1".padEnd(40, "0"),
      branch: `${taskBranch}-design-2`,
    });
    expect(taskOf(service, id).gate).toEqual({ step: "design", submission: 2 });
    await merge(made, "design");
    await drain(service);
    // 実装をやり直し、タスクブランチの最新に積んで、同じ実装の PR を更新する
    expect(repos.published.at(-1)).toMatchObject({
      parent: "m10".padEnd(40, "0"),
      branch: taskBranch,
    });
    expect(pulls.calls.at(-1)).toMatchObject({ number: 9, baseBranch: "main" });
    expect(taskOf(service, id).gate).toEqual({ step: "implement", submission: 2 });
    activity.close();
  });

  it("設計を省いたタスクは要求要件の PR だけ、調査だけ・不具合の修正・PR を作れないタスクは要らない PR を作らない（受け入れ条件 6）", async () => {
    // 設計を省く：要求要件の PR だけ作り、実装の PR は要求要件のファイルだけを引き継ぐ
    const skip = await start(
      [
        out("# 要求要件"),
        implement("# 実装", [{ viewpointId: "REQ", tests: ["a"] }]),
        review(["REQ"]),
      ],
      { steps: ["requirements", "implement"] },
    );
    await merge(skip, "requirements");
    await drain(skip.service);
    expect(skip.pulls.calls.map((c) => c.title)).toEqual(["[要求要件] 決済API", "決済API"]);
    expect(skip.repos.published[0]?.keep?.paths).toEqual([docOf(skip.id, "requirements")]);
    skip.activity.close();

    // 調査だけ：タスクブランチも PR も作らず、画面で承認する
    const investigate = await start([out("# 調査の結果")], {
      steps: [...STEP_PLANS.investigate],
      db: join(dir, "investigate.db"),
    });
    expect(investigate.repos.pushedCommits).toEqual([]);
    expect(investigate.pulls.calls).toEqual([]);
    expect(taskOf(investigate.service, investigate.id).gate).toEqual({
      step: "investigate",
      submission: 1,
    });
    investigate.service.approve(investigate.id, { step: "investigate", submission: 1 });
    expect(isCompleted(taskOf(investigate.service, investigate.id))).toBe(true);
    investigate.activity.close();

    // 不具合の修正（要求要件・設計が無い）：タスクブランチを作らない
    const bugfix = await start([out("# 調査")], {
      steps: [...STEP_PLANS.bugfix],
      db: join(dir, "bugfix.db"),
    });
    expect(bugfix.repos.pushedCommits).toEqual([]);
    expect(taskOf(bugfix.service, bugfix.id).taskBranch).toBeUndefined();
    bugfix.activity.close();
  });

  it("中止したら、sacty が作った開いている PR をすべて閉じ、タスクブランチと工程のブランチを消す（受け入れ条件 7）", async () => {
    const made = await start([out("# 要求要件"), design()]);
    const { activity, service, repos, pulls, id } = made;
    const taskBranch = taskBranchOf(id);
    await merge(made, "requirements");
    await service.runNext(id);
    const plan = service.cleanupPlan(id) ?? [];
    expect(plan.find((p) => p.target === "pull_request")).toMatchObject({
      present: true,
      detail: "https://github.com/acme/app/pull/8",
    });
    expect(plan.find((p) => p.target === "branch")?.detail).toBe(
      [taskBranch, `${taskBranch}-requirements-1`, `${taskBranch}-design-1`].join(", "),
    );
    const cancelled = await service.cancel(id);
    // マージ済みの要求要件の PR は閉じない
    expect(pulls.closed.map((c) => c.number)).toEqual([8]);
    expect(repos.deleted).toEqual([
      taskBranch,
      `${taskBranch}-requirements-1`,
      `${taskBranch}-design-1`,
    ]);
    expect(
      cancelled.cancelled?.cleanup.filter(
        (c) => c.target === "pull_request" || c.target === "branch",
      ),
    ).toEqual([
      { target: "pull_request", result: "done", detail: "https://github.com/acme/app/pull/8" },
      { target: "branch", result: "done", detail: taskBranch },
      { target: "branch", result: "done", detail: `${taskBranch}-requirements-1` },
      { target: "branch", result: "done", detail: `${taskBranch}-design-1` },
    ]);
    // 中止の後に GitHub でマージされても、何も記録しない
    pulls.states[8] = { state: "merged", headSha: "x" };
    await service.checkPullRequests();
    expect(types(service, id).at(-1)).toBe("TaskCancelled");
    activity.close();
  });

  it("中止のとき、すでに閉じられた PR は閉じず、PR を作る前に止まったブランチも消す", async () => {
    const pulls = new FakePulls();
    pulls.fail = "GitHub が落ちている";
    const made = await start([out("# 要求要件")], { pulls });
    const { activity, service, repos, id } = made;
    const taskBranch = taskBranchOf(id);
    let task = taskOf(service, id);
    // PR を作れなければ、理由を記録して止める（タスクブランチ・プッシュしたブランチは記録してある）
    expect(task.status).toBe("paused");
    expect(ja(task.pausedMessage)).toContain("PRを作れませんでした");
    expect(ja(task.pausedMessage)).not.toContain("ghp_secret");
    expect(task.stepBranches).toEqual([`${taskBranch}-requirements-1`]);
    await service.cancel(id);
    expect(pulls.closed).toEqual([]);
    expect(repos.deleted).toEqual([taskBranch, `${taskBranch}-requirements-1`]);
    task = taskOf(service, id);
    expect(task.cancelled?.cleanup.find((c) => c.target === "pull_request")).toEqual({
      target: "pull_request",
      result: "skipped",
    });
    activity.close();

    // 開いていると記録していても、GitHub で閉じられていれば閉じない
    const closed = await start([out("# 要求要件")], { db: join(dir, "closed.db") });
    closed.pulls.states[7] = { state: "closed" };
    await closed.service.cancel(closed.id);
    expect(closed.pulls.closed).toEqual([]);
    closed.activity.close();
  });

  it("マージされずに閉じられたら承認にせず人の判断を待ち、画面で差し戻すと新しい PR で出す", async () => {
    const made = await start([out("# 要求要件 v1"), out("# 要求要件 v2")]);
    const { activity, service, pulls, id } = made;
    pulls.states[7] = { state: "closed" };
    await service.checkPullRequests();
    expect(types(service, id).at(-1)).toBe("PullRequestClosed");
    expect(taskOf(service, id).stepPullRequests[0]?.state).toBe("closed");
    expect(() => service.approve(id, { step: "requirements", submission: 1 })).toThrow(/マージ/);
    // 開き直されたら、マージを待つ
    pulls.states[7] = { state: "open" };
    await service.checkPullRequests();
    expect(taskOf(service, id).stepPullRequests[0]?.state).toBe("open");
    // もう一度閉じられた
    pulls.states[7] = { state: "closed" };
    await service.checkPullRequests();
    let task = taskOf(service, id);
    expect(task.stepPullRequests[0]?.state).toBe("closed");
    expect(task.approved.requirements).toBeUndefined();
    expect(task.status).toBe("awaiting_approval");
    // 画面から差し戻すと、作り直した要求要件を新しい PR で出す
    service.requestChanges(id, { step: "requirements", submission: 1, comments: ["やり直す"] });
    await service.runNext(id);
    task = taskOf(service, id);
    expect(task.gate).toEqual({ step: "requirements", submission: 2 });
    expect(
      task.stepPullRequests.map((p) => [p.number, p.branch.endsWith("-requirements-2")]),
    ).toEqual([
      [7, false],
      [8, true],
    ]);
    activity.close();
  });

  it("差し戻しが上限を超えたら、PR の指摘でもエスカレーションになる", async () => {
    const made = await start([
      out("# 要求要件 v1"),
      out("# v2"),
      out("# v3"),
      out("# v4"),
      rework("requirements", "まだ曖昧"),
    ]);
    const { activity, service, pulls, id } = made;
    for (let i = 1; i <= MAX_CHANGE_REQUESTS; i++) {
      service.requestChanges(id, { step: "requirements", submission: i, comments: [`指摘${i}`] });
      await service.runNext(id);
    }
    expect(pulls.calls.slice(1).every((c) => c.number === 7)).toBe(true);
    pulls.feedbackBy[7] = [item("comment:40")];
    await service.checkPullRequests();
    const task = taskOf(service, id);
    expect(task.status).toBe("escalated");
    expect(task.escalation).toMatchObject({ reason: "too_many_changes", target: "requirements" });
    activity.close();
  });

  it("PR を作る途中でデーモンが止まっても、再起動の後に同じブランチで続きから PR を作る", async () => {
    const pulls = new FakePulls();
    pulls.fail = "接続が切れた";
    const made = await start([out("# 要求要件")], { pulls });
    const { activity, repos, id } = made;
    expect(taskOf(made.service, id).status).toBe("paused");
    activity.close();
    // 再起動
    const again = new SqliteActivityStore(dbPath);
    pulls.fail = undefined;
    const { service } = makeService(again, [], { stepPullRequests: true, pulls, repos });
    service.resume(id, {});
    expect(service.queuedTaskIds()).toEqual([id]);
    await service.runNext(id);
    // タスクブランチは作り直さず、同じ工程のブランチに、同じ日時で積み直す
    expect(repos.pushedCommits).toHaveLength(1);
    expect(repos.committedFiles.map((c) => c.branch)).toEqual([
      `${taskBranchOf(id)}-requirements-1`,
      `${taskBranchOf(id)}-requirements-1`,
    ]);
    expect(repos.committedFiles[1]?.date).toBe(repos.committedFiles[0]?.date);
    const task = taskOf(service, id);
    expect(task.gate).toEqual({ step: "requirements", submission: 1 });
    expect(types(service, id).filter((t) => t === "TaskBranchCreated")).toHaveLength(1);
    again.close();
  });

  it("これまでの流れ（画面）で要求要件を提出した作業履歴のタスクは、そのまま画面で承認する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const old = makeService(activity, [out("# 要求要件")]);
    const { id } = old.service.createTask({ projectId: "default", title: "A" });
    await old.service.runNext(id);
    expect(taskOf(old.service, id).gate).toEqual({ step: "requirements", submission: 1 });
    // PR で承認する版に更新した
    const { service, repos } = makeService(activity, [design()], { stepPullRequests: true });
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    expect(repos.pushedCommits).toEqual([]);
    expect(taskOf(service, id).taskBranch).toBeUndefined();
    expect(taskOf(service, id).gate).toEqual({ step: "design", submission: 1 });
    service.approve(id, { step: "design", submission: 1 });
    activity.close();
  });

  it("オーケストレーターが決めた置き場所にファイルを置く。使えない形なら既定の置き場所にする", async () => {
    const made = await start([out("# 要求要件")], { documentsDir: "docs/specs" });
    expect(Object.keys(made.repos.committedFiles[0]?.files ?? {})).toEqual([
      docOf(made.id, "requirements", "docs/specs"),
    ]);
    made.activity.close();
    const bad = await start([out("# 要求要件")], {
      documentsDir: "../outside",
      db: join(dir, "bad.db"),
    });
    expect(Object.keys(bad.repos.committedFiles[0]?.files ?? {})).toEqual([
      docOf(bad.id, "requirements"),
    ]);
    bad.activity.close();
  });

  it("マージで承認した記録の後に、承認した成果を書き出す（PBI-56）", async () => {
    const confluence = toPlatform(
      "confluence",
      PlatformFile.parse({
        upstream: "https://wiki.example.com",
        description: "Confluence",
        auth: { header: "Authorization", prefix: "Bearer ", secret: "wiki-token" },
        allow: ["POST /rest/api/content"],
      }),
    );
    const made = await start([out("# 要求要件")], {
      config: configOf(agent(), 1, [confluence]),
      gateway: fakeGateway(),
      exports: {
        requirements: {
          to: { via: "platform", name: "confluence", location: "DEV" },
          reason: "規約",
        },
      },
    });
    const { activity, service, id } = made;
    // 承認の前は書き出さない
    expect(exportDue(taskOf(service, id))).toBeUndefined();
    await merge(made, "requirements");
    expect(types(service, id).slice(-2)).toEqual(["PullRequestMerged", "StepApproved"]);
    expect(exportDue(taskOf(service, id))).toBe("requirements");
    expect(service.queuedTaskIds()).toEqual([id]);
    activity.close();
  });

  it("タスクブランチを作る前に PR を作れなくなったら（アカウントの設定を外した）、PR を作らずに画面での承認待ちにする", async () => {
    const repos = new FakeRepos();
    repos.pushFail = "push rejected";
    const projects = projectsWithAccount();
    const made = await start([out("# 要求要件")], { repos, projects });
    const { activity, service, id } = made;
    expect(taskOf(service, id).status).toBe("paused");
    expect(taskOf(service, id).taskBranch).toBeUndefined();
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
    });
    service.resume(id, {});
    await service.runNext(id);
    const task = taskOf(service, id);
    expect(task.gate).toEqual({ step: "requirements", submission: 1 });
    expect(task.stepPullRequests).toEqual([]);
    service.approve(id, { step: "requirements", submission: 1 });
    expect(taskOf(service, id).approved.requirements).toBeDefined();
    activity.close();
  });

  it("作り直しで前の PR を閉じた後、新しい PR を作れずに止まっても、再開すると前の PR を閉じたものとして記録する", async () => {
    const made = await start([
      out("# 要求要件 v1"),
      design("# 設計 v1"),
      rework("requirements", "前提が誤っている"),
      out("# 要求要件 v2"),
      design("# 設計 v2"),
    ]);
    const { activity, service, pulls, id } = made;
    await merge(made, "requirements");
    await service.runNext(id);
    pulls.feedbackBy[8] = [item("comment:50")];
    await service.checkPullRequests();
    await service.runNext(id);
    await merge(made, "requirements");
    // 設計の作り直し：前の設計の PR（#8）は閉じたが、新しい PR を作れなかった
    pulls.fail = "接続が切れた";
    await service.runNext(id);
    expect(pulls.closed.map((c) => c.number)).toEqual([8]);
    expect(taskOf(service, id).status).toBe("paused");
    pulls.fail = undefined;
    service.resume(id, {});
    await service.runNext(id);
    const task = taskOf(service, id);
    expect(task.gate).toEqual({ step: "design", submission: 2 });
    expect(task.stepPullRequests.find((p) => p.number === 8)).toMatchObject({
      state: "closed",
      superseded: true,
    });
    // もう一度閉じようとはしない
    expect(pulls.closed.map((c) => c.number)).toEqual([8]);
    activity.close();
  });

  it("PR の状態を確かめている間に人が画面で差し戻したら、マージを承認として記録しない", async () => {
    const pulls = new FakePulls();
    const made = await start([out("# 要求要件 v1"), out("# 要求要件 v2")], { pulls });
    const { activity, service, id } = made;
    const status = pulls.status.bind(pulls);
    pulls.status = async (input) => {
      // GitHub に問い合わせている間に、人が画面で差し戻した
      if (taskOf(service, id).gate) {
        service.requestChanges(id, { step: "requirements", submission: 1, comments: ["違う"] });
      }
      return { ...(await status(input)), state: "merged", headSha: "x" };
    };
    await service.checkPullRequests();
    expect(types(service, id)).not.toContain("PullRequestMerged");
    expect(taskOf(service, id).status).toBe("queued");
    activity.close();
  });

  it("PR を作っている間に中止したら、作った PR も閉じ、ブランチを消す", async () => {
    const pulls = new FakePulls();
    const release = Promise.withResolvers<void>();
    const called = Promise.withResolvers<void>();
    const upsert = pulls.upsert.bind(pulls);
    pulls.upsert = async (input) => {
      called.resolve();
      await release.promise;
      return upsert(input);
    };
    const activity = new SqliteActivityStore(dbPath);
    const repos = new FakeRepos();
    const { service } = makeService(activity, [out("# 要求要件")], {
      stepPullRequests: true,
      pulls,
      repos,
    });
    const { id } = service.createTask({ projectId: "default", title: "決済API" });
    const running = service.runNext(id);
    await called.promise;
    const cancelling = service.cancel(id);
    release.resolve();
    await running;
    const cancelled = await cancelling;
    expect(cancelled.status).toBe("cancelled");
    // 作った PR は記録してから片付けるので、閉じられる
    expect(pulls.closed.map((c) => c.number)).toEqual([7]);
    expect(repos.deleted).toEqual([taskBranchOf(id), `${taskBranchOf(id)}-requirements-1`]);
    activity.close();
  });

  it("分割の子タスクは、親のタスクブランチではなく、それぞれ自分のタスクブランチを持つ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const repos = new FakeRepos();
    const split = out(
      `分け方\n\n${block({
        "sacty-split": {
          reason: "機能ごとに分ける",
          children: [
            { key: "A", title: "決済の API", body: "- API", dependsOn: [] },
            { key: "B", title: "決済の画面", body: "- 画面", dependsOn: [] },
          ],
        },
      })}`,
    );
    const made = makeService(
      activity,
      [out("# 親の要求要件"), design(), split, out("# 子 A の要求要件"), out("# 子 B の要求要件")],
      {
        stepPullRequests: true,
        now: later,
        pulls,
        repos,
        planner: async (task) => ({
          steps: task.parent
            ? ["requirements" as const, "design" as const]
            : [...STEP_PLANS.split].filter((s) => s !== "investigate"),
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
        }),
      },
    );
    const { service } = made;
    const { id } = service.createTask({ projectId: "default", title: "決済をまるごと作る" });
    await service.runNext(id);
    await merge({ ...made, id }, "requirements");
    await service.runNext(id);
    await merge({ ...made, id }, "design");
    await drain(service);
    const children = taskOf(service, id).split?.children.map((c) => c.taskId) ?? [];
    expect(children).toHaveLength(2);
    for (const child of children) {
      const task = taskOf(service, child);
      expect(task.taskBranch?.branch).toBe(taskBranchOf(child));
      expect(task.gate).toEqual({ step: "requirements", submission: 1 });
      expect(
        pulls.calls.find((c) => c.branch === `${taskBranchOf(child)}-requirements-1`),
      ).toMatchObject({ baseBranch: taskBranchOf(child) });
    }
    expect(repos.pushedCommits.map((p) => p.branch).sort()).toEqual(
      [id, ...children].map(taskBranchOf).sort(),
    );
    activity.close();
  });

  describe("人が PR の中で直してからマージした（PBI-63）", () => {
    /**
     * 工程の PR を、人が成果のファイルを直してからマージしたことにする（PR の先頭は sacty のコミットと違う）。
     * content は、マージ後のタスクブランチの成果のファイル（null は消された、undefined は sacty の版のまま）。
     */
    function mergeEdited(
      made: Pick<Made, "service" | "pulls" | "repos" | "id">,
      step: StepKey,
      content: string | null | undefined,
    ) {
      const { service, pulls, repos, id } = made;
      const task = taskOf(service, id);
      const pr =
        step === "implement"
          ? { number: task.pullRequest?.number ?? 0, path: "" }
          : task.stepPullRequests.findLast((p) => p.step === step);
      if (!pr) throw new Error(`no pull request for ${step}`);
      const head = `e${pr.number}`.padEnd(40, "0");
      const mergeCommit = `f${pr.number}`.padEnd(40, "0");
      pulls.states[pr.number] = {
        state: "merged",
        mergedBy: "reviewer",
        headSha: head,
        mergeCommit,
      };
      // マージの後、確認までの間に、タスクブランチへ未レビューの変更が積まれた（承認済みの成果にしてはいけない）
      const later = `a${pr.number}`.padEnd(40, "0");
      repos.remote[taskBranchOf(id)] = later;
      repos.files[later] = { [pr.path]: "Later unreviewed change\n" };
      if (content !== undefined) repos.files[mergeCommit] = { [pr.path]: content };
      return { head, mergeCommit };
    }
    const header = (id: string, name: string) =>
      `<!-- sacty task ${id} の${name}。sacty が作成しました。 -->\n\n`;
    const mergedOf = (svc: TaskService, id: string) =>
      svc.get(id)?.activity.filter((e) => e.type === "PullRequestMerged") ?? [];

    it("要求要件・設計・実装の PR を人が直してマージしても、承認として進み、人が直した版を承認済みにし、両方の版とコミットを残す（受け入れ条件 1・2・3）", async () => {
      const made = await start([out("# 要求要件 v1"), design(), implement(), review()]);
      const { activity, service, executor, repos, id } = made;
      const reqPr = taskOf(service, id).stepPullRequests[0];
      const sactyReq = repos.committedFiles[0]?.files[docOf(id, "requirements")] ?? "";
      // 要求要件：人が PR の中でファイルを直してマージした
      const human = `${header(id, "要求要件")}# 要求要件（人が直した）\n\n- 返金も扱う\n`;
      const req = mergeEdited(made, "requirements", human);
      await service.checkPullRequests();
      let task = taskOf(service, id);
      // 承認として次の工程（設計）に進み、承認済みの成果は人が直した版（sacty の目印の行は除く）
      expect(task.steps.map((s) => s.state)).toEqual(["done", "active", "todo"]);
      expect(task.status).toBe("queued");
      expect(task.approved.requirements).toMatchObject({
        submission: 1,
        output: "# 要求要件（人が直した）\n\n- 返金も扱う",
        edited: { sacty: "# 要求要件 v1" },
      });
      // 台帳に、sacty が出したコミット・人が直した最終のコミット・マージのコミット・違いの有無と、両方の版の本文
      expect(mergedOf(service, id).map((e) => [e.actor, e.payload])).toEqual([
        [
          "person",
          {
            number: reqPr?.number,
            by: "reviewer",
            commit: req.head,
            outdated: false,
            submitted: reqPr?.commit,
            mergeCommit: req.mergeCommit,
            edited: true,
            document: {
              path: docOf(id, "requirements"),
              commit: req.mergeCommit,
              sacty: sactyReq,
              final: human,
            },
          },
        ],
      ]);
      expect(task.stepPullRequests[0]?.merge).toMatchObject({
        submitted: reqPr?.commit,
        commit: req.head,
        mergeCommit: req.mergeCommit,
        edited: true,
      });
      // 読んだのは、マージ後のタスクブランチの、その PR の成果のファイルだけ（退避した git のメタデータで）
      expect(repos.readCalls).toEqual([
        {
          gitDir: join(dir, "workspaces", "_git", `${id}.git`),
          commit: req.mergeCommit,
          path: docOf(id, "requirements"),
        },
      ]);
      expect(repos.fetchedBranches.at(-1)?.branch).toBe(taskBranchOf(id));
      // マージのコミットが退避したメタデータに無ければ取得する
      expect(repos.fetchedCommits.at(-1)?.commits).toEqual([req.mergeCommit]);
      expect(JSON.stringify(task.approved)).not.toContain("Later unreviewed change");

      // 設計の工程は、人が直した要求要件を読んで作業する
      await service.runNext(id);
      expect(promptOf(executor, executor.calls.length - 1)).toContain("返金も扱う");
      expect(promptOf(executor, executor.calls.length - 1)).not.toContain("# 要求要件 v1");
      // 設計：人が直してマージした
      const humanDesign = "# 設計（人が直した）\n";
      mergeEdited(made, "design", humanDesign);
      await service.checkPullRequests();
      task = taskOf(service, id);
      expect(task.approved.design).toMatchObject({
        output: "# 設計（人が直した）",
        edited: { sacty: "# 設計" },
      });
      // テスト観点は、sacty が出したもの（最終レビューの基準）を引き継ぐ
      expect(task.approved.design?.testViewpoints.map((v) => v.id)).toEqual(["TV-1"]);
      await drain(service);
      // 実装の工程は、人が直した設計を読む
      const implementPrompt = executor.calls
        .map((c) => c.command.join(" "))
        .find((c) => c.includes("sacty-test-map"));
      expect(implementPrompt).toContain("設計（人が直した）");
      task = taskOf(service, id);
      expect(task.gate?.step).toBe("implement");

      // 実装の PR：人が直してマージしても、タスクを完了にする（最終レビューはやり直さない）
      const runs = executor.calls.length;
      const implSubmitted = task.pullRequest?.commit;
      const impl = mergeEdited(made, "implement", undefined);
      await service.checkPullRequests();
      task = taskOf(service, id);
      expect(task.status).toBe("idle");
      expect(task.steps.every((s) => s.state === "done")).toBe(true);
      expect(executor.calls).toHaveLength(runs);
      expect(task.pullRequestMerge).toMatchObject({
        submitted: implSubmitted,
        commit: impl.head,
        mergeCommit: impl.mergeCommit,
        edited: true,
      });
      expect(mergedOf(service, id).at(-1)?.payload.document).toBeUndefined();
      // 実装の PR では、成果のファイルは読まない
      expect(repos.readCalls).toHaveLength(2);

      // 再起動しても、作業履歴から同じ状態を復元する
      activity.close();
      const again = new SqliteActivityStore(dbPath);
      const restored = makeService(again, [], { stepPullRequests: true }).service;
      const back = taskOf(restored, id);
      expect(back.approved.requirements?.output).toBe(task.approved.requirements?.output);
      expect(back.approved.requirements?.edited).toEqual({ sacty: "# 要求要件 v1" });
      expect(back.stepPullRequests.map((p) => p.merge?.edited)).toEqual([true, true]);
      expect(back.pullRequestMerge?.commit).toBe(impl.head);
      again.close();
    });

    it("違うコミットでマージされても、成果のファイルが sacty の版と同じなら、sacty の版を承認済みにし、本文は残さない", async () => {
      const made = await start([out("# 要求要件 v1")]);
      const { activity, service, id } = made;
      mergeEdited(made, "requirements", undefined);
      await service.checkPullRequests();
      const task = taskOf(service, id);
      expect(task.approved.requirements).toMatchObject({ output: "# 要求要件 v1", edited: {} });
      const doc = mergedOf(service, id)[0]?.payload.document;
      expect(doc).toEqual({ path: docOf(id, "requirements"), commit: "f7".padEnd(40, "0") });
      activity.close();
    });

    it("成果のファイルが消された・読めないときは、止めずに sacty の版を承認済みにし、そのことを残す", async () => {
      // 消された
      const deleted = await start([out("# 要求要件 v1")]);
      mergeEdited(deleted, "requirements", null);
      await deleted.service.checkPullRequests();
      let task = taskOf(deleted.service, deleted.id);
      expect(task.status).toBe("queued");
      expect(task.approved.requirements).toMatchObject({
        output: "# 要求要件 v1",
        edited: { fallback: "deleted" },
      });
      expect(task.approved.requirements?.edited?.sacty).toBeUndefined();
      expect(mergedOf(deleted.service, deleted.id)[0]?.payload.document).toEqual({
        path: docOf(deleted.id, "requirements"),
        commit: "f7".padEnd(40, "0"),
        fallback: "deleted",
      });
      deleted.activity.close();

      // 読めない（テキストでないなど）
      const repos = new FakeRepos();
      repos.readFail = "binary";
      const unreadable = await start([out("# 要求要件 v1")], {
        repos,
        db: join(dir, "unreadable.db"),
      });
      mergeEdited(unreadable, "requirements", "人が直した");
      await unreadable.service.checkPullRequests();
      task = taskOf(unreadable.service, unreadable.id);
      expect(task.status).toBe("queued");
      expect(task.approved.requirements).toMatchObject({
        output: "# 要求要件 v1",
        edited: { fallback: "unreadable" },
      });
      const doc = mergedOf(unreadable.service, unreadable.id)[0]?.payload.document;
      expect(doc).toMatchObject({ fallback: "unreadable" });
      expect(ja(doc?.reason)).toContain("UTF-8 のテキストではありません");
      unreadable.activity.close();
    });

    it("読むコミット（マージのコミット）を取得できないときは、何も記録せずに次の確認でやり直し、取得できたらマージのコミットの本文で承認する", async () => {
      const repos = new FakeRepos();
      const made = await start([out("# 要求要件 v1")], { repos });
      const { activity, service, id } = made;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        repos.fetchFail = "not our ref";
        const { mergeCommit } = mergeEdited(made, "requirements", "# 承認する本文\n");
        await service.checkPullRequests();
        expect(types(service, id)).not.toContain("PullRequestMerged");
        expect(taskOf(service, id).status).toBe("awaiting_approval");
        repos.fetchFail = undefined;
        await service.checkPullRequests();
        const task = taskOf(service, id);
        expect(task.approved.requirements?.output).toBe("# 承認する本文");
        // 実際に読んだコミット（マージのコミット）を記録する
        expect(mergedOf(service, id)[0]?.payload).toMatchObject({
          mergeCommit,
          document: { commit: mergeCommit },
        });
      } finally {
        warn.mockRestore();
      }
      activity.close();
    });

    it("タスクブランチを取得できない・git を実行できないときは、何も記録せずにログに理由を出し、次の確認で取得できたら人の版で承認する", async () => {
      const repos = new FakeRepos();
      const made = await start([out("# 要求要件 v1")], { repos });
      const { activity, service, id } = made;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        repos.fetchBranchFail = "could not read ghp_secret";
        mergeEdited(made, "requirements", "# 人が直した要求要件\n");
        await service.checkPullRequests();
        await service.checkPullRequests();
        let task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(task.approved.requirements).toBeUndefined();
        expect(types(service, id)).not.toContain("PullRequestMerged");
        // 理由はデーモンのログに出す（トークンは伏せる）
        const logged = warn.mock.calls.map((c) => c.join(" ")).join("\n");
        expect(logged).toContain("次の確認でやり直します");
        expect(logged).toContain("could not read");
        expect(logged).not.toContain("ghp_secret");
        // ファイルの問題ではない読み取りの失敗も、やり直す
        repos.fetchBranchFail = undefined;
        repos.readError = "git が見つからない";
        await service.checkPullRequests();
        expect(types(service, id)).not.toContain("PullRequestMerged");
        // 取得できたら、人が直した版で承認する
        repos.readError = undefined;
        await service.checkPullRequests();
        task = taskOf(service, id);
        expect(task.status).toBe("queued");
        expect(task.approved.requirements).toMatchObject({
          output: "# 人が直した要求要件",
          edited: { sacty: "# 要求要件 v1" },
        });
        expect(mergedOf(service, id)).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
      activity.close();
    });

    it("前の版で merged_outdated のまま止まった要求要件・設計も、再起動の後の次の確認で、人が直した版を承認して進む（受け入れ条件 5・6）", async () => {
      const made = await start([out("# 要求要件 v1"), design()]);
      const { activity, service, pulls, repos, id } = made;
      await merge(made, "requirements");
      await service.runNext(id);
      const pr = taskOf(service, id).stepPullRequests.findLast((p) => p.step === "design");
      // 前の版が記録した作業履歴（違う内容でのマージで止めた）
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "sacty",
            event: {
              type: "PullRequestMerged",
              payload: {
                number: pr?.number ?? 0,
                by: "reviewer",
                commit: "e".repeat(40),
                outdated: true,
              },
            },
          },
        ],
      });
      activity.close();
      // 再起動
      const again = new SqliteActivityStore(dbPath);
      const restarted = makeService(again, [], { stepPullRequests: true, pulls, repos });
      let task = taskOf(restarted.service, id);
      expect(task.stepPullRequests.at(-1)?.state).toBe("merged_outdated");
      expect(task.stepPullRequests.at(-1)?.merge).toBeUndefined();
      expect(task.status).toBe("awaiting_approval");
      // 作業履歴の表示に使う、過去のイベントも読める
      expect(mergedOf(restarted.service, id).map((e) => e.payload.outdated)).toEqual([false, true]);
      pulls.states[pr?.number ?? 0] = {
        state: "merged",
        mergedBy: "reviewer",
        headSha: "e".repeat(40),
      };
      // マージのコミットが取れないときは、PR の先頭のコミットから読む（タスクブランチの先端は読まない）
      repos.remote[taskBranchOf(id)] = "a".repeat(40);
      repos.files["a".repeat(40)] = { [docOf(id, "design")]: "Later unreviewed change\n" };
      repos.files["e".repeat(40)] = { [docOf(id, "design")]: "# 人が直した設計\n" };
      await restarted.service.checkPullRequests();
      task = taskOf(restarted.service, id);
      expect(task.steps.map((s) => s.state)).toEqual(["done", "done", "active"]);
      expect(task.approved.design).toMatchObject({
        output: "# 人が直した設計",
        edited: { sacty: "# 設計" },
      });
      expect(mergedOf(restarted.service, id).at(-1)?.payload).toMatchObject({
        submitted: pr?.commit,
        commit: "e".repeat(40),
        edited: true,
      });
      again.close();
    });

    it("成果のファイルを読んでいる間に中止されたら、承認を記録しない", async () => {
      const repos = new FakeRepos();
      const made = await start([out("# 要求要件 v1")], { repos });
      const { activity, service, id } = made;
      mergeEdited(made, "requirements", "人が直した");
      const reading = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const original = repos.readFile.bind(repos);
      repos.readFile = async (gitDir: string, commit: string, path: string) => {
        reading.resolve();
        await release.promise;
        return original(gitDir, commit, path);
      };
      const checking = service.checkPullRequests();
      await reading.promise;
      const cancelling = service.cancel(id);
      release.resolve();
      await checking;
      await cancelling;
      const task = taskOf(service, id);
      expect(task.status).toBe("cancelled");
      expect(task.approved.requirements).toBeUndefined();
      expect(types(service, id)).not.toContain("PullRequestMerged");
      activity.close();
    });
  });

  describe("sacty が作る PR にレビュー用のラベルを付け、別のタスクでレビューさせる（PBI-88・PBI-99）", () => {
    const labeledPr = (number: number, labels = ["sacty-review"]) => ({
      repo: "https://github.com/acme/app",
      number,
      title: `PR ${number}`,
      body: "本文",
      url: `https://github.com/acme/app/pull/${number}`,
      labels,
      pullRequest: true,
    });

    it("要求要件の PR にレビュー用のラベルを付け（無ければ作り）、台帳に残す。PR を更新しても付け直さない（受け入れ条件 1・3・7）", async () => {
      const pulls = new FakePulls();
      pulls.labelCreated = true;
      const made = await start(
        [out("# 要求要件 v1"), rework("requirements", "要求要件で直せる"), out("# 要求要件 v2")],
        { pulls },
      );
      const { activity, service, id } = made;
      expect(pulls.labels).toEqual([
        {
          repo: "https://github.com/acme/app",
          token: "ghp_secret",
          number: 7,
          label: "sacty-review",
        },
      ]);
      const labeled = service.get(id)?.activity.at(-1);
      expect(labeled).toMatchObject({
        type: "PullRequestLabeled",
        actor: "sacty",
        payload: {
          repo: "https://github.com/acme/app",
          number: 7,
          label: "sacty-review",
          created: true,
        },
      });
      expect(taskOf(service, id).pullRequestLabels).toEqual([
        { repo: "https://github.com/acme/app", number: 7, label: "sacty-review", created: true },
      ]);
      // 指摘で同じ PR を更新しても、ラベルは付け直さない（人が外していても）
      pulls.feedbackBy[7] = [item("comment:1")];
      await service.checkPullRequests();
      await service.runNext(id);
      expect(pulls.calls.map((c) => c.number)).toEqual([undefined, 7]);
      expect(pulls.labels).toHaveLength(1);
      expect(types(service, id).filter((t) => t === "PullRequestLabeled")).toHaveLength(1);
      // 再起動しても、付けた記録を復元する
      const done = taskOf(service, id);
      activity.close();
      const again = new SqliteActivityStore(dbPath);
      expect(
        makeService(again, [], { stepPullRequests: true }).service.get(id)?.task.pullRequestLabels,
      ).toEqual(done.pullRequestLabels);
      again.close();
    });

    it("レビュー用のラベルを設定していない・そのトリアージを Off にしているなら、付けずに PR を作る（取り込むラベルは付けない。PBI-99）", async () => {
      for (const settings of [
        new MemorySettingsStore({}),
        new MemorySettingsStore({ intakeLabel: "sacty" }),
        new MemorySettingsStore({ reviewLabel: "sacty-review", triageOff: ["reviewLabel"] }),
      ]) {
        const pulls = new FakePulls();
        const { activity, service, id } = await start([out("# 要求要件 v1")], { pulls, settings });
        expect(pulls.labels).toEqual([]);
        expect(types(service, id).at(-1)).toBe("StepSubmitted");
        expect(taskOf(service, id).gate).toEqual({ step: "requirements", submission: 1 });
        activity.close();
        rmSync(dbPath, { force: true });
      }
    });

    it("ラベルを付けられなくても PR の作成は失敗にせず、理由を秘密の値を伏せて台帳に残し、付け直さない（受け入れ条件 4・7）", async () => {
      const pulls = new FakePulls();
      pulls.labelFail = "403 Resource not accessible (token ghp_secret)";
      const made = await start(
        [out("# 要求要件 v1"), rework("requirements", "要求要件で直せる"), out("# 要求要件 v2")],
        { pulls },
      );
      const { activity, service, id } = made;
      const task = taskOf(service, id);
      expect(task.status).toBe("awaiting_approval");
      expect(task.gate).toEqual({ step: "requirements", submission: 1 });
      const failed = service.get(id)?.activity.at(-1);
      expect(failed?.type).toBe("PullRequestLabelFailed");
      expect(failed?.payload).toMatchObject({ number: 7, label: "sacty-review" });
      const text = ja(failed?.type === "PullRequestLabelFailed" ? failed.payload.message : "");
      expect(text).toContain("403 Resource not accessible");
      expect(JSON.stringify(service.get(id)?.activity)).not.toContain("ghp_secret");
      expect(task.pullRequestLabels?.[0]?.failed).toBeDefined();
      // PR を更新しても、もう一度は付けない（失敗も1回だけ記録する）
      pulls.labelFail = undefined;
      pulls.feedbackBy[7] = [item("comment:1")];
      await service.checkPullRequests();
      await service.runNext(id);
      expect(pulls.calls.map((c) => c.number)).toEqual([undefined, 7]);
      expect(pulls.labels).toEqual([]);
      expect(types(service, id).filter((t) => t.startsWith("PullRequestLabel"))).toEqual([
        "PullRequestLabelFailed",
      ]);
      activity.close();
    });

    it("ラベルを付けた PR は、別のレビューだけのタスクとして1度だけ取り込まれ、その指摘が元のタスクの PR の指摘として届く（受け入れ条件 5・6）", async () => {
      const pulls = new FakePulls();
      pulls.prInfo = { ...pulls.prInfo, number: 7, url: "https://github.com/acme/app/pull/7" };
      const made = await start(
        [
          out("# 要求要件 v1"),
          out(
            [
              "# 評価\n\n受け入れ条件が足りない",
              block({ "sacty-review-verdict": { verdict: "changes_required" } }),
            ].join("\n\n"),
          ),
          rework("requirements", "要求要件で直せる"),
          out("# 要求要件 v2"),
        ],
        { pulls },
      );
      const { activity, service, executor, id } = made;
      // 取り込み：元のタスク（要求要件の PR の作り手）とは別の、レビューだけのタスクになる
      const [review, ...rest] = service.importIssues([labeledPr(7)]);
      expect(rest).toEqual([]);
      expect(review?.id).not.toBe(id);
      expect(review?.source).toMatchObject({
        kind: "github_pull_request",
        number: 7,
        review: "sacty",
      });
      const reviewId = review?.id ?? "";
      const before = executor.calls.length;
      await service.runNext(reviewId);
      const chosen = service.get(reviewId)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload.steps).toEqual(["review"]);
      expect(ja(chosen?.type === "StepsChosen" ? chosen.payload.reason : undefined)).toContain(
        "sacty がほかのタスクで作った PR",
      );
      expect(executor.calls[before]?.command.join(" ")).toContain("レビューエージェント");
      await service.runNext(reviewId);
      expect(pulls.reviews.map((r) => r.number)).toEqual([7]);
      expect(pulls.reviews[0]?.body).toContain(`<!-- sacty-review:${reviewId} -->`);
      // 評価のブロックは、投稿する本文に入れない
      expect(pulls.reviews[0]?.body).not.toContain("sacty-review-verdict");
      expect(taskOf(service, reviewId).reviewVerdicts).toEqual([
        { round: 1, verdict: "changes_required" },
      ]);

      // 元のタスクの PR の指摘の取り込みに、このレビューのタスクの投稿を含めるよう渡す
      pulls.feedbackBy[7] = [
        item("review:50", {
          kind: "review",
          author: "me",
          body: pulls.reviews[0]?.body ?? "",
        }),
      ];
      await service.checkPullRequests();
      expect(pulls.feedbackSactyReviews.at(-1)).toEqual([reviewId]);
      const imported = service
        .get(id)
        ?.activity.find((e) => e.type === "PullRequestReviewImported");
      expect(imported?.payload).toMatchObject({ number: 7, items: [{ key: "review:50" }] });
      expect(taskOf(service, id).remarks.at(-1)?.text).toContain("受け入れ条件が足りない");
      // 直して同じ PR を更新しても、ラベルは付け直さず、同じ PR はもうレビューのタスクにしない（繰り返さない）
      await service.runNext(id);
      expect(pulls.calls.map((c) => c.number)).toEqual([undefined, 7]);
      expect(pulls.labels).toHaveLength(1);
      expect(service.importIssues([labeledPr(7)])).toEqual([]);
      // レビューのタスクは、PR の指摘を取り込まない（自分の PR を持たない）
      expect(taskOf(service, reviewId).pullRequest).toBeUndefined();
      activity.close();
    });

    it("直すべき指摘の無い（そのままマージしてよい）レビューは、元のタスクに取り込まず差し戻さない。評価を読めなければ取り込む（PO の指摘）", async () => {
      const cases: { name: string; review: string; imported: boolean }[] = [
        {
          name: "指摘なし",
          review: [
            "# 評価\n\nマージしてよい",
            block({ "sacty-review-verdict": { verdict: "no_findings" } }),
          ].join("\n\n"),
          imported: false,
        },
        {
          // 提案だけなら、行へのコメントがあっても差し戻さない（PBI-111）
          name: "提案あり",
          review: [
            "# 評価\n\nマージしてよい",
            block({
              "sacty-review-comments": [
                { path: "src/retry.ts", line: 2, severity: "should", body: "名前を変える" },
              ],
            }),
            block({ "sacty-review-verdict": { verdict: "suggestions" } }),
          ].join("\n\n"),
          imported: false,
        },
        {
          // 判定が軽くても、[要修正] の指摘があれば差し戻す（PBI-111）
          name: "要修正の指摘",
          review: [
            "# 評価",
            block({
              "sacty-review-comments": [
                { path: "src/retry.ts", line: 2, severity: "must", body: "上限が無い" },
              ],
            }),
            block({ "sacty-review-verdict": { verdict: "suggestions" } }),
          ].join("\n\n"),
          imported: true,
        },
        { name: "評価なし", review: "# 評価\n\n直す点がある", imported: true },
      ];
      for (const c of cases) {
        rmSync(dbPath, { force: true });
        const pulls = new FakePulls();
        pulls.prInfo = { ...pulls.prInfo, number: 7, url: "https://github.com/acme/app/pull/7" };
        const made = await start(
          [
            out("# 要求要件 v1"),
            out(c.review),
            rework("requirements", "要求要件で直せる"),
            out("# 要求要件 v2"),
          ],
          { pulls },
        );
        const { activity, service, executor, id } = made;
        const [review] = service.importIssues([labeledPr(7)]);
        const reviewId = review?.id ?? "";
        await service.runNext(reviewId);
        await service.runNext(reviewId);
        expect(
          pulls.reviews.map((r) => r.number),
          c.name,
        ).toEqual([7]);
        pulls.feedbackBy[7] = [
          item("review:50", { kind: "review", author: "me", body: pulls.reviews[0]?.body ?? "" }),
        ];
        const before = executor.calls.length;
        await service.checkPullRequests();
        const task = taskOf(service, id);
        if (c.imported) {
          expect(pulls.feedbackSactyReviews.at(-1), c.name).toEqual([reviewId]);
          expect(task.importedFeedback, c.name).toEqual(["review:50"]);
          expect(taskOf(service, reviewId).reviewVerdicts, c.name).toEqual([
            { round: 1, ...(c.name === "要修正の指摘" ? { verdict: "changes_required" } : {}) },
          ]);
          expect(task.status, c.name).toBe("queued");
        } else {
          // 取り込まず、ゴールガーディアンも動かさず（費用がかからない）、承認待ちのまま
          expect(taskOf(service, reviewId).reviewVerdicts, c.name).toEqual([
            { round: 1, verdict: c.name === "提案あり" ? "suggestions" : "no_findings" },
          ]);
          expect(pulls.feedbackSactyReviews.at(-1), c.name).toBeUndefined();
          expect(task.importedFeedback, c.name).toEqual([]);
          expect(types(service, id), c.name).not.toContain("PullRequestReviewImported");
          expect(executor.calls.length, c.name).toBe(before);
          expect(task.status, c.name).toBe("awaiting_approval");
          // 人の指摘は、これまでどおり取り込む
          pulls.feedbackBy[7] = [...(pulls.feedbackBy[7] ?? []), item("comment:60")];
          await service.checkPullRequests();
          expect(taskOf(service, id).importedFeedback, c.name).toEqual(["comment:60"]);
        }
        activity.close();
      }
    });

    it("再レビューは回ごとに判定し、直すべき指摘のある回のレビューだけを取り込む（PO の指摘）", async () => {
      const pulls = new FakePulls();
      pulls.prInfo = { ...pulls.prInfo, number: 7, url: "https://github.com/acme/app/pull/7" };
      const verdict = (changesRequested: boolean) =>
        block({
          "sacty-review-verdict": {
            verdict: changesRequested ? "changes_required" : "no_findings",
          },
        });
      const made = await start(
        [
          out("# 要求要件 v1"),
          out(`# 評価\n\nマージしてよい\n\n${verdict(false)}`),
          out(`# 評価\n\n受け入れ条件が足りない\n\n${verdict(true)}`),
          rework("requirements", "要求要件で直せる"),
          out("# 要求要件 v2"),
        ],
        { pulls },
      );
      const { activity, service, id } = made;
      const [review] = service.importIssues([labeledPr(7)]);
      const reviewId = review?.id ?? "";
      await service.runNext(reviewId);
      await service.runNext(reviewId);
      const first = (n: number) =>
        item(`review:${50 + n}`, {
          kind: "review",
          author: "me",
          body: pulls.reviews[n]?.body ?? "",
        });
      pulls.feedbackBy[7] = [first(0)];
      await service.checkPullRequests();
      expect(taskOf(service, id).importedFeedback).toEqual([]);
      // 再レビュー（2回目）は直すべき指摘あり。1回目（指摘なし）のレビューは取り込まない
      service.rereview(reviewId);
      await service.runNext(reviewId);
      await service.runNext(reviewId);
      expect(pulls.reviews).toHaveLength(2);
      expect(taskOf(service, reviewId).reviewVerdicts).toEqual([
        { round: 1, verdict: "no_findings" },
        { round: 2, verdict: "changes_required" },
      ]);
      pulls.feedbackBy[7] = [first(0), first(1)];
      await service.checkPullRequests();
      expect(pulls.feedbackSactyReviews.at(-1)).toEqual([`${reviewId}:2`]);
      expect(taskOf(service, id).importedFeedback).toEqual(["review:51"]);
      expect(taskOf(service, id).status).toBe("queued");
      activity.close();
    });

    it("レビューのタスクが元のタスクと違うアカウントで投稿しても、そのアカウントと回で判定する（レビュー指摘）", async () => {
      // 元のタスクのプロジェクト（parent）。PR を作った後に Org の担当に変え、リポジトリを担当するプロジェクト（reviewer）を足す
      const projects = new MemoryProjectStore();
      projects.put("default", {
        name: "元",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "parent" },
      });
      const pulls = new FakePulls();
      pulls.prInfo = { ...pulls.prInfo, number: 7, url: "https://github.com/acme/app/pull/7" };
      const verdict = (changesRequested: boolean) =>
        block({
          "sacty-review-verdict": {
            verdict: changesRequested ? "changes_required" : "no_findings",
          },
        });
      const made = await start(
        [
          out("# 要求要件 v1"),
          out(`# 評価\n\nマージしてよい\n\n${verdict(false)}`),
          out(`# 評価\n\n受け入れ条件が足りない\n\n${verdict(true)}`),
          rework("requirements", "要求要件で直せる"),
        ],
        {
          pulls,
          projects,
          github: new FakeGitHub({ parent: "ghp_parent", reviewer: "ghp_reviewer" }),
        },
      );
      const { activity, service, id } = made;
      expect(taskOf(service, id).stepPullRequests.map((p) => p.number)).toEqual([7]);
      projects.put("default", {
        name: "元",
        targets: [{ scope: "org", target: "https://github.com/acme" }],
        githubAccounts: { "github.com": "parent" },
      });
      projects.put("app", {
        name: "リポジトリ",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "reviewer" },
      });
      const [review] = service.importIssues([labeledPr(7)]);
      expect(review?.projectId).toBe("app");
      const reviewId = review?.id ?? "";
      await service.runNext(reviewId);
      await service.runNext(reviewId);
      expect(pulls.reviews[0]?.token).toBe("ghp_reviewer");
      const posted = (n: number) =>
        item(`review:${50 + n}`, {
          kind: "review",
          author: "reviewer",
          body: pulls.reviews[n]?.body ?? "",
        });
      // 1回目（指摘なし）は、元のタスクと違うアカウントでも、人の指摘として取り込まない
      pulls.feedbackBy[7] = [posted(0)];
      await service.checkPullRequests();
      expect(pulls.feedbackAccounts.at(-1)).toBe("parent");
      expect(pulls.feedbackSactyRounds.at(-1)).toEqual([
        { key: reviewId, account: "reviewer", allowed: false },
      ]);
      expect(taskOf(service, id).importedFeedback).toEqual([]);
      // 2回目（指摘あり）は取り込む
      service.rereview(reviewId);
      await service.runNext(reviewId);
      await service.runNext(reviewId);
      pulls.feedbackBy[7] = [posted(0), posted(1)];
      await service.checkPullRequests();
      expect(pulls.feedbackSactyRounds.at(-1)).toEqual([
        { key: reviewId, account: "reviewer", allowed: false },
        { key: `${reviewId}:2`, account: "reviewer", allowed: true },
      ]);
      expect(taskOf(service, id).importedFeedback).toEqual(["review:51"]);
      activity.close();
    });

    it("公開を記録した後、ラベルを付ける前に止まっても、再起動後の PR の確認で付ける（要求要件・設計の PR と実装の PR。レビュー指摘）", async () => {
      /** 指定した番号の PR では、ラベルを付ける途中で止まる（止まったことを知らせる）。 */
      const stopAt = (pulls: FakePulls, number: number) => {
        const reached = Promise.withResolvers<void>();
        const original = pulls.addLabel.bind(pulls);
        const stop = { reached: reached.promise, calls: 0 };
        pulls.addLabel = (input) => {
          if (input.number !== number) return original(input);
          stop.calls += 1;
          reached.resolve();
          return new Promise(() => {});
        };
        return stop;
      };
      /** 同じ台帳でデーモンを起動し直し、PR の確認を行う。 */
      const restart = async (settings?: MemorySettingsStore) => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        const { service } = makeService(activity, [], {
          stepPullRequests: true,
          pulls,
          now: later,
          ...(settings ? { settings } : {}),
        });
        await service.checkPullRequests();
        return { activity, service, pulls };
      };

      // 要求要件の PR（7）：公開と承認待ちを記録した後、ラベルを付ける途中で止まる
      const pulls = new FakePulls();
      const stopped = stopAt(pulls, 7);
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out("# 要求要件 v1")], {
        stepPullRequests: true,
        pulls,
        now: later,
      });
      const { id } = service.createTask({ projectId: "default", title: "決済API", body: "本文" });
      void service.runNext(id);
      await stopped.reached;
      // 付けている途中に PR の確認が来ても、重ねて付けない
      await service.checkPullRequests();
      expect(stopped.calls).toBe(1);
      expect(types(service, id).slice(-2)).toEqual(["StepPullRequestPublished", "StepSubmitted"]);
      expect(taskOf(service, id).stepPullRequests[0]?.label).toBe("sacty-review");
      // 起動し直しても、いまはラベルを付けない設定（レビュー用のラベルが無い）なら付けない（記録もしない）
      const off = await restart(new MemorySettingsStore({ intakeLabel: "sacty" }));
      expect(off.pulls.labels).toEqual([]);
      expect(types(off.service, id).at(-1)).toBe("StepSubmitted");
      off.activity.close();
      // 起動し直した後の PR の確認で付けて記録する。次の確認では重ねて付けない
      const again = await restart();
      expect(again.pulls.labels.map((l) => [l.number, l.label])).toEqual([[7, "sacty-review"]]);
      expect(types(again.service, id).at(-1)).toBe("PullRequestLabeled");
      await again.service.checkPullRequests();
      expect(again.pulls.labels).toHaveLength(1);
      again.activity.close();
      activity.close();

      // 実装の PR（9）も同じ
      rmSync(dbPath, { force: true });
      const implPulls = new FakePulls();
      const made = await start([out("# 要求要件 v1"), design(), implement(), review()], {
        pulls: implPulls,
      });
      await merge(made, "requirements");
      await made.service.runNext(made.id);
      await merge(made, "design");
      const implStopped = stopAt(implPulls, 9);
      void drain(made.service);
      await implStopped.reached;
      expect(taskOf(made.service, made.id).pullRequest).toMatchObject({
        number: 9,
        label: "sacty-review",
      });
      expect(types(made.service, made.id).at(-1)).toBe("StepSubmitted");
      const resumed = await restart();
      expect(resumed.pulls.labels.map((l) => l.number)).toEqual([9]);
      expect(taskOf(resumed.service, made.id).pullRequestLabels?.map((l) => l.number)).toEqual([
        7, 8, 9,
      ]);
      resumed.activity.close();
      made.activity.close();
    });

    it("以前の版の記録（StepPullRequestPublished の intakeLabel）は読めるが、再開でラベルを付ける予定として扱わない（PBI-99 レビュー指摘）", async () => {
      // 要求要件の PR（7）：公開を記録した後、ラベルを付ける途中で止まる
      const pulls = new FakePulls();
      const reached = Promise.withResolvers<void>();
      pulls.addLabel = () => {
        reached.resolve();
        return new Promise(() => {});
      };
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out("# 要求要件 v1")], {
        stepPullRequests: true,
        pulls,
        now: later,
      });
      const { id } = service.createTask({ projectId: "default", title: "決済API", body: "本文" });
      void service.runNext(id);
      await reached.promise;
      expect(taskOf(service, id).stepPullRequests[0]?.label).toBe("sacty-review");
      // 同じ出来事を、以前の版の項目の名前（intakeLabel）で別の台帳に書き写す（以前の版が書いた台帳の代わり）
      const oldPath = join(dir, "old.db");
      new SqliteActivityStore(oldPath).close();
      const old = new DatabaseSync(oldPath);
      const insert = old.prepare(
        "INSERT INTO activity (id, task_id, project_id, at, actor, type, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const e of activity.all()) {
        const { label, ...rest } = e.payload as Record<string, unknown>;
        const payload =
          e.type === "StepPullRequestPublished" && label !== undefined
            ? { ...rest, intakeLabel: "sacty" }
            : e.payload;
        insert.run(e.id, e.taskId, e.projectId, e.at, e.actor, e.type, JSON.stringify(payload));
      }
      old.close();
      activity.close();
      const written = new DatabaseSync(oldPath);
      expect(
        (
          written
            .prepare("SELECT payload FROM activity WHERE type = 'StepPullRequestPublished'")
            .get() as { payload: string }
        ).payload,
      ).toContain('"intakeLabel":"sacty"');
      written.close();
      // 以前の記録で起動し直す：読めて、PR の確認でもラベルを付けない（記録もしない）
      const again = new SqliteActivityStore(oldPath);
      const restartedPulls = new FakePulls();
      const restarted = makeService(again, [], {
        stepPullRequests: true,
        pulls: restartedPulls,
        now: later,
      }).service;
      const task = taskOf(restarted, id);
      expect(task.stepPullRequests.map((p) => p.number)).toEqual([7]);
      expect(task.stepPullRequests[0]?.label).toBeUndefined();
      expect(JSON.stringify(task.stepPullRequests[0])).not.toContain("intakeLabel");
      await restarted.checkPullRequests();
      expect(restartedPulls.labels).toEqual([]);
      expect(types(restarted, id).at(-1)).toBe("StepSubmitted");
      again.close();
    });

    it("取り込むラベルだけの PR は、sacty の PR でも取り込まない。sacty が作っていない PR のレビュー用のラベルは、ふつうのレビューのタスク（PBI-99）", async () => {
      const { activity, service } = await start([out("# 要求要件 v1")]);
      // 取り込むラベル（Issue の取り込み）の付いた PR は、sacty が作った PR（7）でも、ほかの PR でも取り込まない
      expect(service.importIssues([labeledPr(7, ["sacty"]), labeledPr(40, ["sacty"])])).toEqual([]);
      // レビュー用のラベルの付いた、sacty が作っていない PR は、ふつうのレビューのタスク（元のタスクには届かない）
      const [other] = service.importIssues([labeledPr(41)]);
      expect(other?.source).toMatchObject({ number: 41, review: "label" });
      // 2つのラベルが両方付いていても、sacty の PR は sacty のレビュー
      expect(
        service
          .importIssues([labeledPr(7, ["sacty", "sacty-review"])])
          .map((t) => t.source?.review),
      ).toEqual(["sacty"]);
      activity.close();
      rmSync(dbPath, { force: true });
      // レビュー用のラベルのトリアージを Off にしていれば、sacty の PR も取り込まない
      const settings = new MemorySettingsStore({
        intakeLabel: "sacty",
        reviewLabel: "sacty-review",
        triageOff: ["reviewLabel"],
      });
      const off = await start([out("# 要求要件 v1")], { settings });
      expect(off.service.importIssues([labeledPr(7)])).toEqual([]);
      off.activity.close();
    });

    it("取り込むラベルとレビュー用のラベルが同じでも、sacty の PR はレビューだけのタスクとして1回だけ取り込まれ、実装のタスクにならず、指摘は元のタスクに届く（PBI-104）", async () => {
      const pulls = new FakePulls();
      pulls.prInfo = { ...pulls.prInfo, number: 7, url: "https://github.com/acme/app/pull/7" };
      const { activity, service, executor, id } = await start(
        [
          out("# 要求要件 v1"),
          out(
            [
              "# 評価\n\n受け入れ条件が足りない",
              block({ "sacty-review-verdict": { verdict: "changes_required" } }),
            ].join("\n\n"),
          ),
          rework("requirements", "要求要件で直せる"),
          out("# 要求要件 v2"),
        ],
        {
          pulls,
          settings: new MemorySettingsStore({ intakeLabel: "sacty", reviewLabel: "sacty" }),
        },
      );
      // sacty の PR には、レビュー用のラベル（取り込むラベルと同じ名前）を1回だけ付ける
      expect(pulls.labels.map((l) => [l.number, l.label])).toEqual([[7, "sacty"]]);
      // 大文字・小文字だけが違う名前でも保存でき、比べるときは同じとみなす
      expect(service.saveSettings({ intakeLabel: "sacty", reviewLabel: "SACTY" })).toEqual({
        intakeLabel: "sacty",
        reviewLabel: "SACTY",
      });
      // Issue の取り込みの検索（review なし）と PR のレビューの取り込みの検索の両方で見つかっても、レビューだけのタスク1つ
      const created = service.importIssues([
        labeledPr(7, ["sacty"]),
        {
          ...labeledPr(7, ["sacty"]),
          review: "label" as const,
        },
      ]);
      expect(created.map((t) => [t.source?.number, t.source?.review])).toEqual([[7, "sacty"]]);
      const reviewId = created[0]?.id ?? "";
      expect(reviewId).not.toBe(id);
      // 実装のタスク（source.review の無い、PR のタスク）にはならない
      expect(
        service.list().filter((t) => t.source?.kind === "github_pull_request" && !t.source.review),
      ).toEqual([]);
      const before = executor.calls.length;
      await service.runNext(reviewId);
      const chosen = service.get(reviewId)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload.steps).toEqual(["review"]);
      expect(executor.calls[before]?.command.join(" ")).toContain("レビューエージェント");
      await service.runNext(reviewId);
      expect(pulls.reviews.map((r) => r.number)).toEqual([7]);
      // そのレビューは、元のタスクに PR の指摘として届く
      pulls.feedbackBy[7] = [
        item("review:50", { kind: "review", author: "me", body: pulls.reviews[0]?.body ?? "" }),
      ];
      await service.checkPullRequests();
      expect(pulls.feedbackSactyReviews.at(-1)).toEqual([reviewId]);
      expect(
        service.get(id)?.activity.find((e) => e.type === "PullRequestReviewImported")?.payload,
      ).toMatchObject({ number: 7, items: [{ key: "review:50" }] });
      expect(taskOf(service, id).remarks.at(-1)?.text).toContain("受け入れ条件が足りない");
      // 直して PR を更新しても、ラベルは付け直さず、同じ PR はもう取り込まない
      await service.runNext(id);
      expect(pulls.labels).toHaveLength(1);
      expect(service.importIssues([labeledPr(7, ["sacty"])])).toEqual([]);
      expect(service.list().filter((t) => t.source?.number === 7)).toHaveLength(1);
      activity.close();
    });
  });
});

describe("エージェントの実行のセッションログ（PBI-62）", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const runIdOf = (events: { type: string; payload: unknown }[] | undefined, type: string) =>
    (events?.find((e) => e.type === type)?.payload as { runId?: string } | undefined)?.runId;

  it("工程の実行ごとにログを残し、秘密情報は伏せ、失敗した実行も結果と一緒に残す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service } = makeService(
      activity,
      [{ kind: "failed", reason: "usage_limit", message: "limit oauth-secret" }, completed(1_000)],
      { sessionLogs },
    );
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const failedRun = runIdOf(service.get(task.id)?.activity, "AgentRunFailed");
    expect(failedRun).toBeTruthy();
    const failed = sessionLogs.read(task.id, failedRun ?? "");
    expect(failed?.meta).toMatchObject({
      taskId: task.id,
      runId: failedRun,
      role: "requirements",
      agentId: "claude-subscription",
      runtime: "claude-code",
      outcome: { kind: "failed", reason: "usage_limit", message: "limit [REDACTED]" },
    });
    expect(failed?.events).toContain("[REDACTED]");
    expect(failed?.events).not.toContain("oauth-secret");
    expect(failed?.stderr).not.toContain("oauth-secret");

    service.resume(task.id, {});
    await service.runNext(task.id);
    const events = service.get(task.id)?.activity;
    const completedRun = runIdOf(events, "AgentRunCompleted");
    expect(completedRun).not.toBe(failedRun);
    // 開始の行と完了の行は、同じ実行のログを指す
    const started = events
      ?.filter((e) => e.type === "AgentRunStarted")
      .map((e) => runIdOf([e], e.type));
    expect(started).toEqual([failedRun, completedRun]);
    expect(sessionLogs.read(task.id, completedRun ?? "")?.meta.outcome).toEqual({
      kind: "completed",
    });
    activity.close();
  });

  it("コンテナを起動する前に止まった実行（秘密情報が無い）も、理由を残す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service } = makeService(activity, [], { secrets: {}, sessionLogs });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const runId = runIdOf(service.get(task.id)?.activity, "AgentRunFailed") ?? "";
    const log = sessionLogs.read(task.id, runId);
    expect(log?.meta.outcome).toMatchObject({ kind: "failed", reason: "auth" });
    expect(log?.events).toBe("");
    activity.close();
  });

  it("オーケストレーターの実行も、工程の選択の記録から実行の ID で辿れる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service } = makeService(
      activity,
      [
        {
          kind: "completed",
          output:
            '```json\n{"sacty-steps": {"plan": "skip-design", "reason": "小さい", "testCommand": "npm test"}}\n```',
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
        },
        completed(1_000),
      ],
      { realPlanner: true, sessionLogs },
    );
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const runId = runIdOf(service.get(task.id)?.activity, "StepsChosen");
    expect(runId).toBeTruthy();
    expect(sessionLogs.read(task.id, runId ?? "")?.meta).toMatchObject({
      role: "orchestrator",
      outcome: { kind: "completed" },
    });
    activity.close();
  });

  it("API：タスクの実行のログと生のファイルを返し、ほかのタスクの実行・不正な ID・無いログは返さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service } = makeService(activity, [completed(1_000)], { sessionLogs });
    const app = createApp(service, token);
    const task = service.createTask({ projectId: "default", title: "A" });
    const other = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(task.id);
    const runId = runIdOf(service.get(task.id)?.activity, "AgentRunCompleted") ?? "";

    const res = await app.request(`/api/tasks/${task.id}/runs/${runId}/log`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { meta: { runId: string }; events: string; stderr: string };
    expect(body.meta.runId).toBe(runId);
    expect(body.events).toContain('"type":"fake"');
    expect(JSON.stringify(body)).not.toContain("oauth-secret");

    // 実行中のログは、?eventsFrom= で足された分だけを返す（PR #119 レビュー指摘）
    const live = sessionLogs.open(
      {
        taskId: task.id,
        runId: "run-live",
        role: "implement",
        agentId: "claude",
        runtime: "claude-code",
        authMode: "subscription",
      },
      () => [],
    );
    live.stdout('{"type":"first"}\n');
    const r1 = (await (
      await app.request(`/api/tasks/${task.id}/runs/run-live/log`, { headers: auth })
    ).json()) as { events: string; offsets: { events: { from: number; next: number } } };
    expect(r1.events).toBe('{"type":"first"}\n');
    live.stdout('{"type":"second"}\n');
    const r2 = (await (
      await app.request(
        `/api/tasks/${task.id}/runs/run-live/log?eventsFrom=${r1.offsets.events.next}&stderrFrom=0`,
        { headers: auth },
      )
    ).json()) as { events: string; offsets: { events: { from: number; next: number } } };
    expect(r2.events).toBe('{"type":"second"}\n');
    expect(r2.offsets.events.from).toBe(r1.offsets.events.next);
    // 位置の形が違えば、全体を返す
    const r3 = (await (
      await app.request(`/api/tasks/${task.id}/runs/run-live/log?eventsFrom=abc`, {
        headers: auth,
      })
    ).json()) as { events: string };
    expect(r3.events).toBe('{"type":"first"}\n{"type":"second"}\n');
    live.close({
      kind: "completed",
      output: "",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
    });

    const raw = await app.request(`/api/tasks/${task.id}/runs/${runId}/files/events`, {
      headers: auth,
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("ndjson");
    expect(await raw.text()).toBe(body.events);
    const stderr = await app.request(`/api/tasks/${task.id}/runs/${runId}/files/stderr`, {
      headers: auth,
    });
    expect(await stderr.text()).toBe(body.stderr);

    // ほかのタスクの ID で、この実行のログは読めない
    expect(
      (await app.request(`/api/tasks/${other.id}/runs/${runId}/log`, { headers: auth })).status,
    ).toBe(404);
    expect(
      (await app.request(`/api/tasks/${other.id}/runs/${runId}/files/events`, { headers: auth }))
        .status,
    ).toBe(404);
    // 無いタスク・無い実行
    expect((await app.request(`/api/tasks/nope/runs/${runId}/log`, { headers: auth })).status).toBe(
      404,
    );
    expect(
      (await app.request(`/api/tasks/${task.id}/runs/missing/log`, { headers: auth })).status,
    ).toBe(404);
    // パスの不正
    expect(
      (await app.request(`/api/tasks/${task.id}/runs/a.b/log`, { headers: auth })).status,
    ).toBe(400);
    // 区切りを含む値は、経路にも合わないか ID の形で断る（どちらでもログの外は読ませない）
    for (const bad of ["..%2F..%2Fsacty", "%2E%2E", "..", `${runId}%2F..`]) {
      const res = await app.request(`/api/tasks/${task.id}/runs/${bad}/log`, { headers: auth });
      expect([400, 404]).toContain(res.status);
    }
    expect(
      (await app.request(`/api/tasks/${task.id}/runs/${runId}/files/meta`, { headers: auth }))
        .status,
    ).toBe(400);
    // トークンが無ければ読めない
    expect((await app.request(`/api/tasks/${task.id}/runs/${runId}/log`)).status).toBe(401);
    activity.close();
  });

  it("中止しても、セッションログは消さない（監査に使うため）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service } = makeService(activity, [completed(1_000)], { sessionLogs });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const runId = runIdOf(service.get(task.id)?.activity, "AgentRunCompleted") ?? "";
    await service.cancel(task.id);
    expect(service.get(task.id)?.task.status).toBe("cancelled");
    expect(sessionLogs.read(task.id, runId)).toBeTruthy();
    activity.close();
  });
});

describe("エージェントの元のセッションのファイル（PBI-66）", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const runIdOf = (events: { type: string; payload: unknown }[] | undefined, type: string) =>
    (events?.find((e) => e.type === type)?.payload as { runId?: string } | undefined)?.runId;
  const archivedOf = (service: TaskService, id: string) =>
    (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AgentSessionArchived" ? [e.payload] : [],
    );
  // Claude Code が CLAUDE_CONFIG_DIR に書く形（認証なしの起動で確かめた形と、公開されている形）
  const claudeFiles = (secret: string) => () => ({
    "projects/-workspace/main-session.jsonl": `${JSON.stringify({ type: "user", message: { content: `token ${secret}` } })}\n`,
    "projects/-workspace/main-session/subagents/agent-a1.jsonl": '{"type":"assistant"}\n',
    ".claude.json": `{"userID":"${secret}"}`,
    ".credentials.json": `{"claudeAiOauth":{"accessToken":"${secret}"}}`,
    "backups/.claude.json.backup.1": "{}",
  });

  it("実行ごとに元のファイルを写し、認証の情報は写さず、秘密情報を伏せ、大きさとハッシュを作業履歴に残す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(
      activity,
      [{ kind: "failed", reason: "usage_limit", message: "limit" }, completed(1_000)],
      { sessionLogs },
    );
    executor.sessionFiles = claudeFiles("oauth-secret");
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    // 失敗した実行も写す
    const failedRun = runIdOf(service.get(task.id)?.activity, "AgentRunFailed") ?? "";
    const [archived] = archivedOf(service, task.id);
    expect(archived).toMatchObject({
      runId: failedRun,
      role: "requirements",
      agentId: "claude-subscription",
      runtime: "claude-code",
      sessionId: `session-${failedRun}`,
      limitBytes: 200 * 1024 * 1024,
      skipped: [],
    });
    expect(archived?.files.map((f) => f.path)).toEqual([
      "projects/-workspace/main-session.jsonl",
      "projects/-workspace/main-session/subagents/agent-a1.jsonl",
    ]);
    const agentDir = join(dir, "runs", task.id, failedRun, "agent");
    const main = readFileSync(join(agentDir, "projects/-workspace/main-session.jsonl"), "utf8");
    expect(main).toContain("token [REDACTED]");
    expect(main).not.toContain("oauth-secret");
    expect(existsSync(join(agentDir, ".credentials.json"))).toBe(false);
    expect(existsSync(join(agentDir, ".claude.json"))).toBe(false);
    expect(existsSync(join(agentDir, "backups"))).toBe(false);
    const file = archived?.files[0];
    expect(file?.bytes).toBe(Buffer.byteLength(main));
    expect(file?.sha256).toBe(createHash("sha256").update(main).digest("hex"));
    // 利用者だけが読める
    expect(statSync(agentDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(agentDir, "projects/-workspace/main-session.jsonl")).mode & 0o777).toBe(
      0o600,
    );

    service.resume(task.id, {});
    await service.runNext(task.id);
    // 実行ごとに別の場所
    expect(archivedOf(service, task.id).map((e) => e.runId)).toEqual([
      failedRun,
      runIdOf(service.get(task.id)?.activity, "AgentRunCompleted"),
    ]);
    activity.close();
  });

  it("スタブ（元のファイルが無い）では、何も写さず記録もしない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(activity, [completed(1_000)], {
      sessionLogs,
      config: configOf(agent({ id: "stub", runtime: "stub", auth: { mode: "stub" } })),
    });
    executor.sessionFiles = claudeFiles("x");
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const runId = runIdOf(service.get(task.id)?.activity, "AgentRunCompleted") ?? "";
    expect(runId).toBeTruthy();
    expect(archivedOf(service, task.id)).toEqual([]);
    expect(existsSync(join(dir, "runs", task.id, runId))).toBe(false);
    activity.close();
  });

  it("コンテナの停止を確かめられなかった実行は写さず、写さなかった理由を作業履歴と API に残す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(activity, [completed(1_000)], { sessionLogs });
    executor.sessionFiles = claudeFiles("oauth-secret");
    executor.containerUnconfirmed = true;
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const runId = runIdOf(service.get(task.id)?.activity, "AgentRunCompleted") ?? "";
    expect(archivedOf(service, task.id)).toEqual([
      expect.objectContaining({
        runId,
        runtime: "claude-code",
        files: [],
        skipped: [],
        notArchived: "container_not_confirmed",
      }),
    ]);
    expect(existsSync(join(dir, "runs", task.id, runId, "agent"))).toBe(false);
    const files = await service.agentSessionFiles(task.id, runId);
    expect(files).toMatchObject({ notArchived: "container_not_confirmed", files: [] });
    activity.close();
  });

  it("中止で止めた実行も写し、中止の後でも記録する（中止の掃除でも消さない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(activity, [HOLD], { sessionLogs });
    executor.sessionFiles = claudeFiles("oauth-secret");
    const task = service.createTask({ projectId: "default", title: "A" });
    const running = service.runNext(task.id);
    const runId = await executor.started.promise;
    await service.cancel(task.id);
    await running;
    const types = service.get(task.id)?.activity.map((e) => e.type) ?? [];
    expect(types).toContain("TaskCancelled");
    expect(types).toContain("AgentSessionArchived");
    expect(service.get(task.id)?.task.status).toBe("cancelled");
    expect(archivedOf(service, task.id)[0]?.runId).toBe(runId);
    expect(
      existsSync(join(dir, "runs", task.id, runId, "agent/projects/-workspace/main-session.jsonl")),
    ).toBe(true);
    // 作業履歴から状態を復元できる
    const { service: restarted } = makeService(activity, [], { sessionLogs });
    expect(restarted.get(task.id)?.task.status).toBe("cancelled");
    activity.close();
  });

  it("中止で止めた質問への答えの実行（チャット）も写す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(activity, [HOLD], { sessionLogs });
    executor.sessionFiles = claudeFiles("oauth-secret");
    const task = service.createTask({ projectId: "default", title: "A" });
    const { answered } = service.askQuestion(task.id, { text: "質問" });
    const chatRun = await executor.started.promise;
    await service.cancel(task.id);
    await answered;
    expect(archivedOf(service, task.id)).toMatchObject([{ runId: chatRun, role: "chat" }]);
    expect(service.get(task.id)?.task.status).toBe("cancelled");
    activity.close();
  });

  it("API：一覧とハッシュの一致・書き換えると不一致・消すと無い。ほかのタスク・パスの不正・記録の無いファイルは返さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(activity, [completed(1_000)], { sessionLogs });
    executor.sessionFiles = claudeFiles("oauth-secret");
    const app = createApp(service, token);
    const task = service.createTask({ projectId: "default", title: "A" });
    const other = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(task.id);
    const runId = runIdOf(service.get(task.id)?.activity, "AgentRunCompleted") ?? "";
    const base = `/api/tasks/${task.id}/runs/${runId}/agent-files`;
    type Listed = {
      runtime: string;
      sessionId: string;
      files: { path: string; status: string; sha256: string; current?: { sha256: string } }[];
    };
    const list = async () => (await (await app.request(base, { headers: auth })).json()) as Listed;
    const first = await list();
    expect(first).toMatchObject({ runtime: "claude-code", sessionId: `session-${runId}` });
    expect(first.files.map((f) => f.status)).toEqual(["match", "match"]);

    const mainPath = "projects/-workspace/main-session.jsonl";
    const raw = await app.request(`${base}/raw?path=${encodeURIComponent(mainPath)}`, {
      headers: auth,
    });
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toContain("ndjson");
    expect(await raw.text()).toContain("token [REDACTED]");

    // 書き換えると不一致、消すと無い
    const agentDir = join(dir, "runs", task.id, runId, "agent");
    writeFileSync(join(agentDir, mainPath), '{"type":"user","message":{"content":"edited"}}\n');
    rmSync(join(agentDir, "projects/-workspace/main-session/subagents/agent-a1.jsonl"));
    const second = await list();
    expect(second.files.map((f) => f.status)).toEqual(["mismatch", "missing"]);
    expect(second.files[0]?.current?.sha256).not.toBe(second.files[0]?.sha256);

    // ほかのタスクの ID では読めない
    expect(
      (await app.request(`/api/tasks/${other.id}/runs/${runId}/agent-files`, { headers: auth }))
        .status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/api/tasks/${other.id}/runs/${runId}/agent-files/raw?path=${encodeURIComponent(mainPath)}`,
          { headers: auth },
        )
      ).status,
    ).toBe(404);
    // パスの不正（場所の外・絶対パス・空）は断る
    for (const bad of ["../../sacty.db", "/etc/passwd", "", "projects/../../x", "a//b", "a\\b"]) {
      const res = await app.request(`${base}/raw?path=${encodeURIComponent(bad)}`, {
        headers: auth,
      });
      expect(res.status, bad).toBe(400);
    }
    // 記録の無いファイルは、置かれていても返さない（後から置かれた .credentials.json など）
    writeFileSync(join(agentDir, ".credentials.json"), "{}");
    expect(
      (await app.request(`${base}/raw?path=.credentials.json`, { headers: auth })).status,
    ).toBe(404);
    // 記録したファイルがリンクに置き換えられたら返さない
    rmSync(join(agentDir, mainPath));
    symlinkSync(dbPath, join(agentDir, mainPath));
    expect(
      (await app.request(`${base}/raw?path=${encodeURIComponent(mainPath)}`, { headers: auth }))
        .status,
    ).toBe(404);
    expect((await list()).files[0]?.status).toBe("missing");
    // 写していない実行・不正な ID・トークンが無い
    expect(
      (await app.request(`/api/tasks/${task.id}/runs/missing/agent-files`, { headers: auth }))
        .status,
    ).toBe(404);
    expect(
      (await app.request(`/api/tasks/${task.id}/runs/a.b/agent-files`, { headers: auth })).status,
    ).toBe(400);
    expect((await app.request(base)).status).toBe(401);
    activity.close();
  });
});

describe("オーケストレーターのセッションの使い回し（PBI-67）", () => {
  const unreadable: AgentOutcome = {
    kind: "completed",
    output: "工程を決められませんでした",
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
  };
  const plan: AgentOutcome = {
    kind: "completed",
    output:
      '```json\n{"sacty-steps": {"plan": "skip-design", "reason": "小さい", "testCommand": "npm test"}}\n```',
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  };
  const answer: AgentOutcome = {
    kind: "completed",
    output: "答えです",
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
  };
  type Used = Extract<EventInput, { type: "OrchestratorSessionUsed" }>["payload"];
  const usedOf = (service: TaskService, id: string): Used[] =>
    (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "OrchestratorSessionUsed" ? [e.payload] : [],
    );
  /** コマンドの引数のうち、name の次のもの。 */
  const argAfter = (inv: Invocation | undefined, name: string) => {
    const i = inv?.command.indexOf(name) ?? -1;
    return i >= 0 ? inv?.command[i + 1] : undefined;
  };
  /**
   * Claude Code の振る舞いをまねる：--resume なら同じ ID のセッションに書き足し、--fork-session なら新しい ID の
   * セッションに複製する。どちらでもなければ新しいセッション。
   */
  const claudeId = (inv: Invocation, runId: string) => {
    const resumed = argAfter(inv, "--resume");
    if (resumed && inv.command.includes("--fork-session")) return `fork-${runId}`;
    return resumed ?? `session-${runId}`;
  };
  const emulateClaude = (executor: FakeExecutor) => {
    executor.appendSessionFiles = true;
    executor.sessionIdOf = claudeId;
    executor.sessionFiles = (inv, runId) => ({
      [`projects/-workspace/${claudeId(inv, runId)}.jsonl`]: `${JSON.stringify({ type: "user", run: runId })}\n`,
    });
  };
  const setup = (
    outcomes: (AgentOutcome | typeof HOLD)[],
    options: Parameters<typeof makeService>[2] = {},
  ) => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const orchestratorSessions = new OrchestratorSessionStore(join(dir, "sessions"));
    const made = makeService(activity, [], {
      realPlanner: true,
      sessionLogs,
      orchestratorSessions,
      ...options,
    });
    (made.executor as unknown as { outcomes: (AgentOutcome | typeof HOLD)[] }).outcomes.push(
      ...outcomes,
    );
    return { activity, orchestratorSessions, ...made };
  };
  const storedPath = (taskId: string) =>
    join(dir, "sessions", taskId, "orchestrator", "session.json");
  const stored = (taskId: string) =>
    JSON.parse(readFileSync(storedPath(taskId), "utf8")) as {
      agentId: string;
      runtime: string;
      sessionId: string;
      runId: string;
      files: { path: string; sha256: string }[];
    };
  const storedFile = (taskId: string, path: string) => {
    const s = stored(taskId);
    return readFileSync(
      join(dir, "sessions", taskId, "orchestrator", "generations", s.runId, "files", path),
      "utf8",
    );
  };
  /** 工程を決められずに止まった後、再開して、もう一度オーケストレーターに工程を選ばせる。 */
  const rerunOrchestrator = async (service: TaskService, id: string) => {
    expect(service.get(id)?.task.status).toBe("paused");
    service.resume(id, {});
    await service.runNext(id);
  };

  it("Claude Code：初回は新しく始めて保存し、2回目は前のセッションを再開する。工程のエージェントは毎回新しい", async () => {
    const { activity, service, executor } = setup([unreadable, plan, completed(1_000)]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const [first] = usedOf(service, task.id);
    const firstRun = first?.runId ?? "";
    expect(first).toEqual({
      runId: firstRun,
      role: "orchestrator",
      agentId: "claude-subscription",
      runtime: "claude-code",
      mode: "new",
      sessionId: `session-${firstRun}`,
      reason: "first",
      saved: true,
    });
    // 初回は再開しない（戻すファイルも無い）
    expect(argAfter(executor.calls[0], "--resume")).toBeUndefined();
    expect(executor.restored[0]).toBeUndefined();
    expect(stored(task.id)).toMatchObject({
      agentId: "claude-subscription",
      runtime: "claude-code",
      sessionId: `session-${firstRun}`,
      runId: firstRun,
    });
    expect(statSync(join(dir, "sessions", task.id, "orchestrator")).mode & 0o777).toBe(0o700);

    await rerunOrchestrator(service, task.id);
    const second = usedOf(service, task.id)[1];
    // 2回目は、前のセッションを再開する（ファイルを設定の場所に戻し、--resume で ID を渡す）
    expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${firstRun}`);
    expect(executor.calls[1]?.command).not.toContain("--fork-session");
    expect(executor.restored[1]).toEqual({
      [`projects/-workspace/session-${firstRun}.jsonl`]: `${JSON.stringify({ type: "user", run: firstRun })}\n`,
    });
    expect(second).toMatchObject({
      role: "orchestrator",
      mode: "resumed",
      sessionId: `session-${firstRun}`,
      resumedFrom: `session-${firstRun}`,
      saved: true,
    });
    expect(second?.reason).toBeUndefined();
    // 指示は、これまでどおり台帳から作る
    expect(executor.calls[1]?.command[2]).toContain("工程");
    // 保存したセッションに、2回目の実行の分が書き足されている
    const main = storedFile(task.id, `projects/-workspace/session-${firstRun}.jsonl`);
    expect(main.trim().split("\n")).toHaveLength(2);
    expect(service.get(task.id)?.task.orchestratorSession).toMatchObject({
      agentId: "claude-subscription",
      runtime: "claude-code",
      sessionId: `session-${firstRun}`,
      uses: 2,
      reason: "first",
      saved: true,
    });
    // 工程のエージェント（調査）は、新しいセッションのまま
    expect(service.get(task.id)?.task.steps.some((s) => s.state !== "todo")).toBe(true);
    expect(executor.calls[2]?.command).not.toContain("--resume");
    expect(executor.calls[2]?.stage?.sessionDir).toBeUndefined();
    expect(usedOf(service, task.id)).toHaveLength(2);
    // 作業履歴から復元できる
    const { service: restarted } = makeService(activity, []);
    expect(restarted.get(task.id)?.task.orchestratorSession?.uses).toBe(2);
    activity.close();
  });

  it("Codex：2回目は `codex exec … resume <ID> <指示>` で再開する", async () => {
    const codex = agent({
      id: "codex-key",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    const { activity, service, executor } = setup([unreadable, plan, completed(1_000)], {
      config: configOf(codex),
      secrets: { "openai-key": "sk-secret" },
    });
    const codexId = (inv: Invocation, runId: string) =>
      argAfter(inv, "resume") ?? `thread-${runId}`;
    executor.appendSessionFiles = true;
    executor.sessionIdOf = codexId;
    executor.sessionFiles = (inv, runId) => ({
      [`sessions/2026/10/14/rollout-2026-10-14T10-00-00-${codexId(inv, runId)}.jsonl`]: `{"run":"${runId}"}\n`,
    });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const firstRun = usedOf(service, task.id)[0]?.runId ?? "";
    expect(usedOf(service, task.id)[0]).toMatchObject({
      runtime: "codex",
      mode: "new",
      reason: "first",
      sessionId: `thread-${firstRun}`,
      saved: true,
    });
    expect(executor.calls[0]?.command).not.toContain("resume");
    await rerunOrchestrator(service, task.id);
    const command = executor.calls[1]?.command ?? [];
    // 指示（最後の引数）の直前に resume と ID
    expect(command.slice(-3, -1)).toEqual(["resume", `thread-${firstRun}`]);
    expect(command.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(Object.keys(executor.restored[1] ?? {})).toEqual([
      `sessions/2026/10/14/rollout-2026-10-14T10-00-00-thread-${firstRun}.jsonl`,
    ]);
    expect(usedOf(service, task.id)[1]).toMatchObject({
      runtime: "codex",
      mode: "resumed",
      resumedFrom: `thread-${firstRun}`,
      sessionId: `thread-${firstRun}`,
      saved: true,
    });
    activity.close();
  });

  it("エージェントを変えたら、新しいセッションで始めて理由を残す（タスクは止まらない）", async () => {
    let current = agent();
    const { activity, service, executor } = setup([unreadable, plan, completed(1_000)], {
      config: () => configOf(current)(),
    });
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    current = agent({ id: "claude-other" });
    await rerunOrchestrator(service, task.id);
    expect(executor.calls[1]?.command).not.toContain("--resume");
    expect(executor.restored[1]).toBeUndefined();
    const second = usedOf(service, task.id)[1];
    expect(second).toMatchObject({
      agentId: "claude-other",
      mode: "new",
      reason: "agent_changed",
      saved: true,
    });
    expect(second?.resumedFrom).toBeUndefined();
    expect(service.get(task.id)?.task.steps.length).toBeGreaterThan(0);
    expect(stored(task.id).agentId).toBe("claude-other");
    expect(service.get(task.id)?.task.orchestratorSession).toMatchObject({
      agentId: "claude-other",
      uses: 1,
      reason: "agent_changed",
    });
    activity.close();
  });

  it("AI の種類を変えたら（同じ ID でも）新しく始める", async () => {
    let current = agent({ id: "same" });
    const { activity, service, executor } = setup([unreadable, plan, completed(1_000)], {
      config: () => configOf(current)(),
      secrets: { "claude-oauth-token": "oauth-secret", "openai-key": "sk-secret" },
    });
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    current = agent({
      id: "same",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    await rerunOrchestrator(service, task.id);
    expect(executor.calls[1]?.command).not.toContain("resume");
    expect(usedOf(service, task.id)[1]).toMatchObject({
      runtime: "codex",
      mode: "new",
      reason: "agent_changed",
    });
    activity.close();
  });

  it("保存したファイルが壊れた（書き換えた・消した）・記録が読めないときは、新しく始めて理由を残す", async () => {
    for (const breakIt of [
      (taskId: string) => {
        const s = stored(taskId);
        const file = s.files[0]?.path ?? "";
        writeFileSync(
          join(dir, "sessions", taskId, "orchestrator", "generations", s.runId, "files", file),
          "edited\n",
        );
      },
      (taskId: string) => {
        const s = stored(taskId);
        rmSync(join(dir, "sessions", taskId, "orchestrator", "generations", s.runId), {
          recursive: true,
        });
      },
      (taskId: string) => writeFileSync(storedPath(taskId), "{not json"),
    ]) {
      rmSync(dbPath, { force: true });
      const { activity, service, executor } = setup([unreadable, plan, completed(1_000)]);
      emulateClaude(executor);
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      breakIt(task.id);
      await rerunOrchestrator(service, task.id);
      expect(executor.calls[1]?.command).not.toContain("--resume");
      expect(usedOf(service, task.id)[1]).toMatchObject({
        mode: "new",
        reason: "files_broken",
        saved: true,
      });
      expect(service.get(task.id)?.task.steps.length).toBeGreaterThan(0);
      activity.close();
    }
  });

  it("保存したセッションが上限で省かれていたら、新しく始める", async () => {
    const { activity, service, executor } = setup([unreadable, plan, completed(1_000)], {
      sessionLogs: new SessionLogStore(join(dir, "runs"), undefined, 300),
    });
    emulateClaude(executor);
    executor.sessionFiles = (inv, runId) => ({
      [`projects/-workspace/${claudeId(inv, runId)}.jsonl`]: `${JSON.stringify({ pad: "x".repeat(1_000) })}\n`,
    });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    expect(stored(task.id).files[0]).toHaveProperty("truncated");
    await rerunOrchestrator(service, task.id);
    expect(executor.calls[1]?.command).not.toContain("--resume");
    expect(usedOf(service, task.id)[1]).toMatchObject({ mode: "new", reason: "truncated" });
    activity.close();
  });

  it("AI が再開を受け付けなかったら、新しいセッションで始め直し、理由と受け付けなかった実行を残す", async () => {
    const rejected: AgentOutcome = {
      kind: "failed",
      reason: "error",
      message: "No conversation found with session ID: x",
    };
    const { activity, service, executor } = setup([unreadable, rejected, plan, completed(1_000)]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const firstRun = usedOf(service, task.id)[0]?.runId ?? "";
    await rerunOrchestrator(service, task.id);
    expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${firstRun}`);
    // 始め直した実行は、再開しない
    expect(executor.calls[2]?.command).not.toContain("--resume");
    expect(executor.restored[2]).toBeUndefined();
    const used = usedOf(service, task.id);
    expect(used).toHaveLength(2);
    const retried = used[1];
    expect(retried).toMatchObject({
      mode: "new",
      reason: "resume_failed",
      resumedFrom: `session-${firstRun}`,
      saved: true,
    });
    expect(retried?.failedRunId).toBeTruthy();
    expect(retried?.runId).not.toBe(retried?.failedRunId);
    // タスクは止まらず、工程を決めた（記録の実行の ID は、始め直した実行）
    const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.runId).toBe(retried?.runId);
    expect(stored(task.id).sessionId).toBe(`session-${retried?.runId}`);
    activity.close();
  });

  it("再開した実行が利用上限・認証で失敗したときは、始め直さない（同じ失敗になるため）", async () => {
    for (const reason of ["usage_limit", "auth"] as const) {
      rmSync(dbPath, { force: true });
      const { activity, service, executor } = setup([
        unreadable,
        { kind: "failed", reason, message: "x" },
      ]);
      emulateClaude(executor);
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      await rerunOrchestrator(service, task.id);
      expect(executor.calls).toHaveLength(2);
      expect(usedOf(service, task.id)[1]).toMatchObject({ mode: "resumed" });
      expect(service.get(task.id)?.task.pausedReason).toBe(reason);
      activity.close();
    }
  });

  it("タイムアウト・コンテナの停止を確かめられない・途中で落ちたときは、始め直さずにそのまま返す（P1 レビュー指摘）", async () => {
    const failures: AgentOutcome[] = [
      { kind: "failed", reason: "error", message: message("run.timeout", { minutes: 30 }) },
      {
        kind: "failed",
        reason: "error",
        message: message("run.containerNotConfirmed", { name: "sacty-run-x" }),
      },
      { kind: "failed", reason: "error", message: "exit code 137" },
      { kind: "failed", reason: "error", message: "Segmentation fault" },
      // Codex の文は、Claude Code の再開の拒否ではない
      { kind: "failed", reason: "error", message: "thread not found: x" },
    ];
    for (const failure of failures) {
      rmSync(dbPath, { force: true });
      const { activity, service, executor } = setup([unreadable, failure, plan]);
      emulateClaude(executor);
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      await rerunOrchestrator(service, task.id);
      expect(executor.calls, JSON.stringify(failure.message)).toHaveLength(2);
      expect(usedOf(service, task.id)[1]).toMatchObject({ mode: "resumed" });
      expect(usedOf(service, task.id)[1]?.reason).toBeUndefined();
      // 失敗は隠さず、タスクは止まる（工程は決まらない）
      expect(service.get(task.id)?.task.status).toBe("paused");
      expect(service.get(task.id)?.task.steps).toEqual([]);
      activity.close();
    }
  });

  it("エージェントが再開を拒んだ文（Claude Code・Codex）と、セッションを戻せなかったときは始め直す", async () => {
    const codex = agent({
      id: "codex-key",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    const cases: { runtime: "claude" | "codex"; message: AgentOutcome & { kind: "failed" } }[] = [
      ...[
        "No conversation found with session ID: abc",
        "--resume session load failed (ENOENT): x",
        "Failed to resume session abc: bad",
      ].map((text) => ({
        runtime: "claude" as const,
        message: { kind: "failed" as const, reason: "error" as const, message: text },
      })),
      ...[
        "Error: no rollout found for thread id abc",
        "no rollout found for conversation id abc",
        "rollout path missing for thread abc",
        "thread not found: abc",
        "error resuming thread: x",
      ].map((text) => ({
        runtime: "codex" as const,
        message: {
          kind: "failed" as const,
          reason: "error" as const,
          message: text,
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        },
      })),
      {
        runtime: "claude",
        message: {
          kind: "failed",
          reason: "error",
          message: message("run.sessionRestoreFailed", { detail: "ENOENT" }),
        },
      },
    ];
    for (const c of cases) {
      rmSync(dbPath, { force: true });
      const { activity, service, executor } = setup(
        [unreadable, c.message, plan, completed(1)],
        c.runtime === "codex"
          ? { config: configOf(codex), secrets: { "openai-key": "sk-secret" } }
          : {},
      );
      emulateClaude(executor);
      if (c.runtime === "codex") {
        const codexId = (inv: Invocation, runId: string) =>
          argAfter(inv, "resume") ?? `thread-${runId}`;
        executor.sessionIdOf = codexId;
        executor.sessionFiles = (inv, runId) => ({
          [`sessions/2026/10/14/rollout-2026-10-14T10-00-00-${codexId(inv, runId)}.jsonl`]: "{}\n",
        });
      }
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      await rerunOrchestrator(service, task.id);
      expect(executor.calls[1]?.command).toContain(c.runtime === "codex" ? "resume" : "--resume");
      // 始め直した実行は、再開しない
      expect(executor.calls[2]?.command, JSON.stringify(c.message.message)).not.toContain(
        c.runtime === "codex" ? "resume" : "--resume",
      );
      expect(usedOf(service, task.id)[1]).toMatchObject({ mode: "new", reason: "resume_failed" });
      expect(service.get(task.id)?.task.steps.length).toBeGreaterThan(0);
      activity.close();
    }
  });

  it("再開を指定したのに別のセッションで始めた（黙って新しく始めた）なら、新規として記録する", async () => {
    const codex = agent({
      id: "codex-key",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    const { activity, service, executor } = setup([unreadable, plan, completed(1)], {
      config: configOf(codex),
      secrets: { "openai-key": "sk-secret" },
    });
    // いつも新しいスレッドで始める Codex
    const codexId = (_inv: Invocation, runId: string) => `thread-${runId}`;
    executor.sessionIdOf = codexId;
    executor.sessionFiles = (inv, runId) => ({
      [`sessions/2026/10/14/rollout-2026-10-14T10-00-00-${codexId(inv, runId)}.jsonl`]: "{}\n",
    });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const firstRun = usedOf(service, task.id)[0]?.runId ?? "";
    await rerunOrchestrator(service, task.id);
    expect(executor.calls).toHaveLength(3);
    const second = usedOf(service, task.id)[1];
    expect(second).toMatchObject({
      mode: "new",
      reason: "resume_failed",
      resumedFrom: `thread-${firstRun}`,
      saved: true,
    });
    expect(second?.failedRunId).toBeUndefined();
    expect(service.get(task.id)?.task.orchestratorSession).toMatchObject({
      uses: 1,
      reason: "resume_failed",
    });
    activity.close();
  });

  it("再開した実行を人間が一時停止したときは、始め直さない", async () => {
    const { activity, service, executor } = setup([unreadable, HOLD]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    service.resume(task.id, {});
    executor.started = Promise.withResolvers<string>();
    const running = service.runNext(task.id);
    await executor.started.promise;
    await service.pause(task.id);
    await running;
    expect(executor.calls).toHaveLength(2);
    expect(usedOf(service, task.id)[1]).toMatchObject({ mode: "resumed" });
    expect(usedOf(service, task.id)[1]?.reason).toBeUndefined();
    expect(service.get(task.id)?.task.status).toBe("paused");
    activity.close();
  });

  it("再開した実行が使用量を使ってから失敗したときは、始め直さない", async () => {
    const { activity, service, executor } = setup([
      unreadable,
      {
        kind: "failed",
        reason: "error",
        message: "Failed to resume session abc（使ってから失敗）",
        usage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 1 },
      },
    ]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    await rerunOrchestrator(service, task.id);
    expect(executor.calls).toHaveLength(2);
    expect(usedOf(service, task.id)[1]?.mode).toBe("resumed");
    activity.close();
  });

  it("チャットは、保存したセッションを複製して答え、元のセッションに質問と答えが混ざらない", async () => {
    const { activity, service, executor } = setup([unreadable, answer, answer]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const firstRun = usedOf(service, task.id)[0]?.runId ?? "";
    const before = readFileSync(storedPath(task.id), "utf8");
    const beforeMain = storedFile(task.id, `projects/-workspace/session-${firstRun}.jsonl`);
    await service.askQuestion(task.id, { text: "いまどうなっている？" }).answered;
    const chat = executor.calls[1];
    expect(argAfter(chat, "--resume")).toBe(`session-${firstRun}`);
    expect(chat?.command).toContain("--fork-session");
    expect(executor.restored[1]).toEqual({
      [`projects/-workspace/session-${firstRun}.jsonl`]: beforeMain,
    });
    const chatUsed = usedOf(service, task.id)[1];
    expect(chatUsed).toMatchObject({
      role: "chat",
      mode: "forked",
      resumedFrom: `session-${firstRun}`,
    });
    expect(chatUsed?.sessionId).toMatch(/^fork-/);
    expect(chatUsed?.saved).toBeUndefined();
    // 保存したセッションは変わらない（チャットの実行は保存しない）
    expect(readFileSync(storedPath(task.id), "utf8")).toBe(before);
    expect(storedFile(task.id, `projects/-workspace/session-${firstRun}.jsonl`)).toBe(beforeMain);
    // 使った回数にも数えない
    expect(service.get(task.id)?.task.orchestratorSession?.uses).toBe(1);
    // 答えは記録される
    expect(service.get(task.id)?.task.questions[0]?.answer?.text).toBe("答えです");
    activity.close();
  });

  it("Codex のチャットは、使い捨ての場所で再開して答え（複製の引数は無い）、元のセッションは変わらない", async () => {
    const codex = agent({
      id: "codex-key",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    const { activity, service, executor } = setup([unreadable, answer], {
      config: configOf(codex),
      secrets: { "openai-key": "sk-secret" },
    });
    const codexId = (inv: Invocation, runId: string) =>
      argAfter(inv, "resume") ?? `thread-${runId}`;
    executor.appendSessionFiles = true;
    executor.sessionIdOf = codexId;
    executor.sessionFiles = (inv, runId) => ({
      [`sessions/2026/10/14/rollout-2026-10-14T10-00-00-${codexId(inv, runId)}.jsonl`]: `{"run":"${runId}"}\n`,
    });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const before = readFileSync(storedPath(task.id), "utf8");
    const firstRun = usedOf(service, task.id)[0]?.runId ?? "";
    await service.askQuestion(task.id, { text: "質問" }).answered;
    expect(executor.calls[1]?.command.slice(-3, -1)).toEqual(["resume", `thread-${firstRun}`]);
    expect(usedOf(service, task.id)[1]).toMatchObject({
      role: "chat",
      mode: "forked",
      runtime: "codex",
    });
    expect(readFileSync(storedPath(task.id), "utf8")).toBe(before);
    expect(
      storedFile(
        task.id,
        `sessions/2026/10/14/rollout-2026-10-14T10-00-00-thread-${firstRun}.jsonl`,
      ),
    ).toBe(`{"run":"${firstRun}"}\n`);
    activity.close();
  });

  it("セッションが無いタスクのチャットは新しいセッションで答え、保存しない", async () => {
    const { activity, service, executor } = setup([answer]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.askQuestion(task.id, { text: "質問" }).answered;
    expect(executor.calls[0]?.command).not.toContain("--resume");
    expect(usedOf(service, task.id)).toMatchObject([
      { role: "chat", mode: "new", reason: "first" },
    ]);
    expect(existsSync(storedPath(task.id))).toBe(false);
    expect(service.get(task.id)?.task.orchestratorSession).toBeUndefined();
    activity.close();
  });

  it("チャットで再開を受け付けなかったら、新しいセッションで答え直す（止める対象も、始め直した実行）", async () => {
    const { activity, service, executor } = setup([
      unreadable,
      { kind: "failed", reason: "error", message: "No conversation found with session ID: x" },
      answer,
    ]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    await service.askQuestion(task.id, { text: "質問" }).answered;
    expect(executor.calls[2]?.command).not.toContain("--resume");
    const used = usedOf(service, task.id)[1];
    expect(used).toMatchObject({ role: "chat", mode: "new", reason: "resume_failed" });
    const answered = service.get(task.id)?.activity.find((e) => e.type === "QuestionAnswered");
    expect(answered?.type === "QuestionAnswered" && answered.payload.runId).toBe(used?.runId);
    expect(service.get(task.id)?.task.questions[0]?.answer?.text).toBe("答えです");
    activity.close();
  });

  it("ほかのタスクのセッションとは混ざらない", async () => {
    const { activity, service, executor } = setup([unreadable, unreadable, plan, completed(1_000)]);
    emulateClaude(executor);
    const a = service.createTask({ projectId: "default", title: "A" });
    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(a.id);
    // B は A のセッションを使わない
    await service.runNext(b.id);
    expect(executor.calls[1]?.command).not.toContain("--resume");
    expect(usedOf(service, b.id)[0]).toMatchObject({ mode: "new", reason: "first" });
    const bRun = usedOf(service, b.id)[0]?.runId ?? "";
    // B の2回目は、B のセッションを再開する
    await rerunOrchestrator(service, b.id);
    expect(argAfter(executor.calls[2], "--resume")).toBe(`session-${bRun}`);
    expect(Object.keys(executor.restored[2] ?? {})).toEqual([
      `projects/-workspace/session-${bRun}.jsonl`,
    ]);
    expect(stored(a.id).sessionId).not.toBe(stored(b.id).sessionId);
    activity.close();
  });

  it("同じタスクのオーケストレーターの実行は同時に1つだけ（並ぶ）。ほかのタスク・工程のエージェントは並べない", async () => {
    const { activity, service, executor } = setup([HOLD, completed(1), completed(1), completed(1)]);
    const a = service.createTask({ projectId: "default", title: "A" });
    const b = service.createTask({ projectId: "default", title: "B" });
    type Run = {
      agent: AgentConfig;
      image: string;
      taskId: string;
      runId: string;
      prompt: string;
      role: string;
      workspaceDir: string;
    };
    const execute = (run: Run) =>
      (service as unknown as { execute(run: Run): Promise<{ outcome: AgentOutcome }> }).execute(
        run,
      );
    const runOf = (taskId: string, runId: string, role = "orchestrator"): Run => ({
      agent: agent(),
      image: "sacty-agent:test",
      taskId,
      runId,
      prompt: "p",
      role,
      workspaceDir: join(dir, "ws", runId),
    });
    const first = execute(runOf(a.id, "a1"));
    await executor.started.promise;
    const second = execute(runOf(a.id, "a2"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // 同じタスクの2つ目は、1つ目が終わるまで始まらない
    expect(executor.calls).toHaveLength(1);
    // ほかのタスクのオーケストレーター・同じタスクの工程のエージェントは待たない
    await execute(runOf(b.id, "b1"));
    await execute(runOf(a.id, "s1", "requirements"));
    expect(executor.calls).toHaveLength(3);
    executor.kill("a1");
    await first;
    await second;
    expect(executor.calls).toHaveLength(4);
    activity.close();
  });

  it("ゴールガーディアン（判定・最終レビュー・PR の指摘の判断）は、保存したセッションがあっても毎回新しい", async () => {
    const { activity, service, executor } = setup([
      unreadable,
      completed(1),
      completed(1),
      completed(1),
    ]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    expect(existsSync(storedPath(task.id))).toBe(true);
    const execute = (role: string, runId: string) =>
      (service as unknown as { execute(run: unknown): Promise<unknown> }).execute({
        agent: agent(),
        image: "sacty-agent:test",
        taskId: task.id,
        runId,
        prompt: "p",
        role,
        workspaceDir: join(dir, "ws", runId),
      });
    await execute("guardian", "g1");
    await execute("final-review", "g2");
    await execute("rework", "g3");
    for (const call of executor.calls.slice(1)) {
      expect(call.command).not.toContain("--resume");
      expect(call.stage?.sessionDir).toBeUndefined();
    }
    expect(usedOf(service, task.id)).toHaveLength(1);
    activity.close();
  });

  it("スタブ・セッションの置き場所が無いときは、これまでどおり毎回新しく、記録もしない", async () => {
    const { activity, service, executor } = setup([unreadable], {
      config: configOf(agent({ id: "stub", runtime: "stub", auth: { mode: "stub" } })),
    });
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    expect(usedOf(service, task.id)).toEqual([]);
    activity.close();

    rmSync(dbPath, { force: true });
    const second = new SqliteActivityStore(dbPath);
    const made = makeService(second, [unreadable], {
      realPlanner: true,
      sessionLogs: new SessionLogStore(join(dir, "runs2")),
    });
    emulateClaude(made.executor);
    const t = made.service.createTask({ projectId: "default", title: "A" });
    await made.service.runNext(t.id);
    expect(usedOf(made.service, t.id)).toEqual([]);
    expect(made.executor.calls[0]?.command).not.toContain("--resume");
    second.close();
  });

  it("元のファイルを写せなかった・セッションの ID が分からないときは保存せず、前に保存したものを再開する", async () => {
    const { activity, service, executor } = setup([unreadable, unreadable, plan, completed(1)]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const firstRun = usedOf(service, task.id)[0]?.runId ?? "";
    // 2回目：コンテナの停止を確かめられず、写せなかった
    executor.containerUnconfirmed = true;
    await rerunOrchestrator(service, task.id);
    expect(usedOf(service, task.id)[1]).toMatchObject({
      mode: "resumed",
      saved: false,
      notSaved: "not_archived",
    });
    expect(service.get(task.id)?.task.orchestratorSession?.saved).toBe(false);
    expect(stored(task.id).runId).toBe(firstRun);
    // 3回目：前に保存したもの（1回目）を再開する
    executor.containerUnconfirmed = false;
    await rerunOrchestrator(service, task.id);
    expect(argAfter(executor.calls[2], "--resume")).toBe(`session-${firstRun}`);
    expect(usedOf(service, task.id)[2]).toMatchObject({ mode: "resumed", saved: true });
    activity.close();
  });

  it("出力から読んだセッションの ID が、引数に使えない形なら保存しない", async () => {
    const { activity, service, executor } = setup([unreadable]);
    emulateClaude(executor);
    executor.sessionIdOf = () => "--dangerous";
    executor.sessionFiles = () => ({ "projects/-workspace/--dangerous.jsonl": "{}\n" });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    expect(usedOf(service, task.id)[0]).toMatchObject({ saved: false, notSaved: "no_session" });
    expect(existsSync(storedPath(task.id))).toBe(false);
    activity.close();
  });

  it("中止すると、オーケストレーターのセッションを片付ける（実行ごとに写した元のファイルは残す）", async () => {
    const { activity, service, executor } = setup([unreadable]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const runId = usedOf(service, task.id)[0]?.runId ?? "";
    expect(service.cleanupPlan(task.id)?.find((c) => c.target === "session")?.present).toBe(true);
    await service.cancel(task.id);
    expect(existsSync(join(dir, "sessions", task.id))).toBe(false);
    expect(existsSync(join(dir, "runs", task.id, runId, "agent"))).toBe(true);
    const cancelled = service.get(task.id)?.activity.find((e) => e.type === "TaskCancelled");
    expect(
      cancelled?.type === "TaskCancelled" &&
        cancelled.payload.cleanup.find((c) => c.target === "session")?.result,
    ).toBe("done");
    activity.close();
  });

  it("中止で止めたオーケストレーターの実行も、中止の後に記録する（状態は変えない）", async () => {
    const { activity, service, executor } = setup([HOLD]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    const running = service.runNext(task.id);
    await executor.started.promise;
    await service.cancel(task.id);
    await running;
    expect(service.get(task.id)?.task.status).toBe("cancelled");
    expect(usedOf(service, task.id)).toHaveLength(1);
    // 片付けの後に保存し直さない
    expect(existsSync(join(dir, "sessions", task.id))).toBe(false);
    const { service: restarted } = makeService(activity, []);
    expect(restarted.get(task.id)?.task.status).toBe("cancelled");
    activity.close();
  });
});

describe("リポジトリを指定しないタスク（PBI-73）", () => {
  const out = (text: string, output = 1): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const plan = (v: Record<string, unknown>, output = 1) =>
    out(block({ "sacty-steps": { reason: "理由", ...v } }), output);
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const design = out(
    `# 設計\n\n${block({ "sacty-test-viewpoints": [{ title: "t", input: "i", expected: "e" }] })}`,
  );
  const API = "https://github.com/acme/api";
  const WEB = "https://github.com/acme/web";
  /** 対象：リポジトリ acme/api と acme/web（tools/secret は、ほかのプロジェクトが担当）。 */
  const twoRepos = (withContext = false) => {
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: API },
        { scope: "repo", target: WEB },
      ],
      githubAccounts: { "github.com": "me" },
      ...(withContext ? { context: { repo: "https://github.com/acme/context" } } : {}),
    });
    projects.put("other", {
      name: "ほか",
      targets: [{ scope: "repo", target: "https://github.com/tools/secret" }],
      githubAccounts: { "github.com": "me" },
    });
    return projects;
  };
  const chosenOf = (activity: SqliteActivityStore, id: string) =>
    activity.forTask(id).find((e) => e.type === "StepsChosen");
  const textOf = (value: unknown) => renderMessage(value as DaemonText, "ja");

  it("リポジトリを選ばずに作れる（null・対象が複数で省略）。選んだとき・対象がリポジトリ1つで省略したときは今と同じ", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const omitted = service.createTask({ projectId: "default", title: "A" });
    expect(omitted.repo).toBeUndefined();
    expect(omitted.noRepo).toBe(true);
    const none = service.createTask({ projectId: "default", title: "B", repo: null });
    expect(none).toMatchObject({ noRepo: true, status: "queued" });
    // 選んだときは今と同じ（登録した名前にそろえる・noRepo は付けない）
    const chosen = service.createTask({
      projectId: "default",
      title: "C",
      repo: API.toUpperCase(),
    });
    expect(chosen.repo).toBe(API);
    expect(chosen.noRepo).toBeUndefined();
    // 対象の外のリポジトリは、今と同じく作らない
    expect(() =>
      service.createTask({
        projectId: "default",
        title: "D",
        repo: "https://github.com/tools/secret",
      }),
    ).toThrow(/対象リポジトリを、プロジェクト/);
    activity.close();

    // 対象がリポジトリ1つだけなら、省略するとそれにする（今と同じ）。null なら指定しない
    rmSync(dbPath);
    const single = new SqliteActivityStore(dbPath);
    const { service: one } = makeService(single, []);
    expect(one.createTask({ projectId: "default", title: "E" }).repo).toBe(
      "https://github.com/acme/app",
    );
    expect(one.createTask({ projectId: "default", title: "F", repo: null })).toMatchObject({
      noRepo: true,
    });
    single.close();
  });

  it("調べものは、オーケストレーターがプロジェクトのコンテキストと対象を読んで選び、リポジトリ無しのまま進めて完了する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, repos } = makeService(
      activity,
      [
        // リポジトリの無いタスクでは、テストのコマンド・サービス・ベースブランチは使わない
        plan({
          plan: "investigate",
          testCommand: "npm test",
          baseBranch: "develop",
          services: { file: "compose.yml", names: ["db"], steps: ["investigate"] },
          investigation: "content",
        }),
        out("# 調査の結果"),
      ],
      {
        projects: twoRepos(true),
        realPlanner: true,
        contexts: new FakeContexts({
          "https://github.com/acme/context": { "rules.md": "設計書は docs/ に置く" },
        }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "認証の仕組みを調べる" });
    await service.runNext(id);
    // オーケストレーターには、コードの代わりにプロジェクトの対象・コンテキストを渡す
    const prompt = promptOf(executor, 0);
    expect(prompt).toContain("このタスクには対象リポジトリがありません");
    expect(prompt).toContain(`- ${API}`);
    expect(prompt).toContain(`- ${WEB}`);
    expect(prompt).toContain(
      "プロジェクトのコンテキストリポジトリ：https://github.com/acme/context",
    );
    expect(prompt).toContain("設計書は docs/ に置く");
    expect(prompt).toContain("design-only");
    expect(prompt).not.toContain("review：");
    // リポジトリは用意しない。作業領域は空（コードの写しを作らない）
    expect(repos.prepared).toEqual([]);
    expect(repos.snapshots).toEqual([]);
    expect(executor.workspaceFiles).toEqual([[], []]);
    expect(promptOf(executor, 1)).toContain(
      "作業領域（カレントディレクトリ）は空で、コードはありません",
    );
    const chosen = chosenOf(activity, id);
    expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
      steps: ["investigate"],
      plan: "investigate",
    });
    expect(chosen?.type === "StepsChosen" && chosen.payload.testCommand).toBeUndefined();
    expect(chosen?.type === "StepsChosen" && chosen.payload.services).toBeUndefined();
    const task = service.get(id)?.task;
    expect(task?.gate).toEqual({ step: "investigate", submission: 1 });
    service.approve(id, { step: "investigate", submission: 1 });
    const done = service.get(id)?.task;
    expect(done && isCompleted(done)).toBe(true);
    expect(done?.repository).toBeUndefined();
    activity.close();
  });

  it("images があっても、リポジトリの無いまま進める工程には、既定のイメージの理由を求めない（PBI-105）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [plan({ plan: "investigate", investigation: "content" }), out("# 調査の結果")],
      {
        projects: twoRepos(),
        realPlanner: true,
        config: () => ({
          ok: true,
          config: {
            ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
            images: {
              java: { name: "java", image: "sacty-agent-java:test", description: "Java", env: {} },
            },
          },
        }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "認証の仕組みを調べる" });
    await service.runNext(id);
    expect(promptOf(executor, 0)).not.toContain("defaultReasons");
    const chosen = chosenOf(activity, id);
    expect(chosen?.type === "StepsChosen" && chosen.payload.steps).toEqual(["investigate"]);
    expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
      "imagesUnexplained",
    );
    expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
      "defaultImageReasons",
    );
    activity.close();
  });

  it("全体の設計は、要求要件・設計を sacty の画面で承認して完了し（PR は作らない）、書き出し先があれば書き出す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const confluence = toPlatform(
      "confluence",
      PlatformFile.parse({
        upstream: "https://wiki.example.com",
        description: "Confluence",
        auth: { header: "Authorization", prefix: "Bearer ", secret: "wiki-token" },
        allow: ["GET /rest/api/content/**", "POST /rest/api/content"],
      }),
    );
    const URL1 = "https://wiki.example.com/pages/9";
    const { service, executor, repos, pulls } = makeService(
      activity,
      [
        plan({
          plan: "design-only",
          exports: {
            requirements: { to: "", reason: "要件は書き出さない" },
            design: { to: "confluence", via: "platform", location: "DEV", reason: "規約" },
          },
        }),
        out("# 要求要件"),
        design,
        out(`書きました\n\n${block({ "sacty-export": { url: URL1 } })}`),
      ],
      {
        projects: twoRepos(),
        realPlanner: true,
        config: configOf(agent(), 1, [confluence]),
        gateway: fakeGateway(),
        secrets: { "claude-oauth-token": "oauth-secret", "wiki-token": "wiki-secret" },
        // PR でのレビュー（PBI-57）が使えるプロジェクトでも、リポジトリの無いタスクは画面で承認する
        stepPullRequests: true,
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "全体の設計" });
    await service.runNext(id);
    expect(service.get(id)?.task.gate).toEqual({ step: "requirements", submission: 1 });
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    expect(service.get(id)?.task.gate).toEqual({ step: "design", submission: 1 });
    service.approve(id, { step: "design", submission: 1 });
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.exports.design).toMatchObject({ url: URL1 });
    expect(task && isCompleted(task)).toBe(true);
    expect(task?.stepPullRequests).toEqual([]);
    expect(task?.taskBranch).toBeUndefined();
    expect(pulls.calls).toEqual([]);
    expect(repos.prepared).toEqual([]);
    expect(executor.calls).toHaveLength(4);
    activity.close();
  });

  it("コードの変更が要り分けないなら、オーケストレーターが対象からリポジトリを選び、用意してから工程を選び直す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, repos } = makeService(
      activity,
      [
        plan(
          { plan: "standard", repo: "https://github.com/ACME/web", repoReason: "画面の変更" },
          1000,
        ),
        plan({ plan: "investigate", testCommand: "npm test" }),
        out("# 調査"),
      ],
      { projects: twoRepos(), realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "ボタンの文言を直す" });
    await service.runNext(id);
    const chosen = service.get(id)?.task;
    // 登録した名前にそろえ、選んだ理由と費用を残す。まだ工程は決めない
    expect(chosen?.repo).toBe(WEB);
    expect(chosen?.repoChoice).toEqual({ reason: "画面の変更", by: "orchestrator" });
    expect(chosen?.steps).toEqual([]);
    expect(chosen?.budget.usedUsd).toBeCloseTo(0.015, 6);
    expect(activity.forTask(id).find((e) => e.type === "RepositoryChosen")).toMatchObject({
      actor: "orchestrator",
      payload: { repo: WEB },
    });
    expect(service.queuedTaskIds()).toEqual([id]);
    await service.runNext(id);
    // 選んだリポジトリを用意して、そのコードを読んで工程を選ぶ（いつもの流れ）
    expect(repos.prepared[0]?.url).toBe(`${WEB}.git`);
    expect(promptOf(executor, 1)).toContain(`対象リポジトリ（${WEB}.git）`);
    expect(service.get(id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    activity.close();
  });

  it("リポジトリを選べなかった・対象に無いリポジトリなら止め、人が対象から選んで再開できる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, repos } = makeService(
      activity,
      [
        plan({ plan: "skip-design", repo: "", repoReason: "api と web のどちらか分からない" }),
        plan({ plan: "bugfix", repo: "https://github.com/tools/secret", repoReason: "推測" }),
        plan({ plan: "investigate", testCommand: "npm test" }),
        out("# 調査"),
      ],
      { projects: twoRepos(), realPlanner: true },
    );
    const { id } = service.createTask({ projectId: "default", title: "不具合を直す" });
    await service.runNext(id);
    let task = service.get(id)?.task;
    expect(task?.status).toBe("paused");
    expect(textOf(task?.pausedMessage)).toMatch(
      /作業するリポジトリを決められませんでした：api と web のどちらか分からない/,
    );
    expect(task?.repo).toBeUndefined();
    service.resume(id, {});
    await service.runNext(id);
    task = service.get(id)?.task;
    expect(task?.status).toBe("paused");
    // 対象に無い（ほかのプロジェクトが担当する）リポジトリは使わない
    expect(textOf(task?.pausedMessage)).toMatch(
      /リポジトリ（https:\/\/github.com\/tools\/secret）は、プロジェクトの対象にありません/,
    );
    expect(task?.repo).toBeUndefined();
    expect(repos.prepared).toEqual([]);
    // 人が選ぶ。対象に無いものは選べない
    await expect(service.chooseRepository(id, "https://github.com/tools/secret")).rejects.toThrow(
      /プロジェクトの対象にありません/,
    );
    const picked = await service.chooseRepository(id, API);
    expect(picked.repo).toBe(API);
    expect(picked.repoChoice?.by).toBe("person");
    service.resume(id, {});
    await service.runNext(id);
    expect(repos.prepared[0]?.url).toBe(`${API}.git`);
    expect(service.get(id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    // 工程を決めた後は、選び直せない
    await expect(service.chooseRepository(id, WEB)).rejects.toThrow(
      /リポジトリを選べるのは、リポジトリを指定せずに作り/,
    );
    activity.close();
  });

  it("リポジトリを指定したタスクでは、リポジトリを選べない（今と同じ）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const { id } = service.createTask({ projectId: "default", title: "A", repo: API });
    await expect(service.chooseRepository(id, WEB)).rejects.toThrow(/リポジトリを選べるのは/);
    activity.close();
  });

  describe("分割する大きなタスク", () => {
    const splitOutput = (children: unknown[]) =>
      out(`分け方\n\n${block({ "sacty-split": { reason: "リポジトリごとに分ける", children } })}`);
    const children = [
      {
        key: "A",
        title: "API を作る",
        body: "- API",
        dependsOn: [],
        repo: "https://github.com/ACME/API",
        repoReason: "API はこちら",
      },
      {
        key: "B",
        title: "画面を作る",
        body: "- 画面",
        dependsOn: ["A"],
        repo: WEB,
        repoReason: "画面",
      },
    ];
    /** 親は分割（統合レビューまで）、子は調査だけ（承認で完了する）を選ぶ。 */
    const planner = async (task: Task) =>
      task.parent
        ? {
            steps: ["investigate" as const],
            plan: "investigate" as const,
            reason: "子",
            fallback: false,
            costUsd: 0,
            estimated: false,
          }
        : {
            steps: [...STEP_PLANS.split].filter((s) => s !== "investigate"),
            plan: "split" as const,
            reason: "大きいので分ける",
            fallback: false,
            // リポジトリの無いタスクでは使わない
            testCommand: "npm test",
            costUsd: 0,
            estimated: false,
          };
    const integration = out(
      block({
        "sacty-integration-review": {
          viewpoints: [{ id: "TV-1", verified: true, reason: "満たす" }],
          remarks: [],
          findings: [],
          summary: "要求要件を満たす",
        },
      }),
    );

    async function splitParent(outcomes: AgentOutcome[]) {
      const activity = new SqliteActivityStore(dbPath);
      const made = makeService(activity, [out("# 要求要件"), design, ...outcomes], {
        projects: twoRepos(),
        planner,
      });
      const { service } = made;
      const { id } = service.createTask({ projectId: "default", title: "決済をまるごと作る" });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      service.approve(id, { step: "design", submission: 1 });
      await service.runNext(id);
      return { ...made, activity, id };
    }

    it("子タスクごとに対象からリポジトリを付け（理由を残す）、親は統合レビューまで今の流れで進む", async () => {
      const { service, executor, repos, activity, id } = await splitParent([
        splitOutput(children),
        out("# A の調査"),
        out("# B の調査"),
        integration,
      ]);
      // 親はリポジトリを用意しない。分割のエージェントには、子に付けられるリポジトリを渡す
      const splitPrompt = promptOf(executor, 2);
      expect(splitPrompt).toContain(
        "子タスクごとに、作業するリポジトリ（repo）を次の候補から1つ選び",
      );
      expect(splitPrompt).toContain(`- ${API}`);
      expect(splitPrompt).toContain('"repoReason"');
      const parent = service.get(id)?.task;
      expect(parent?.status).toBe("waiting_children");
      expect(parent?.repository).toBeUndefined();
      expect(parent?.testCommand).toBeUndefined();
      const [a, b] = (parent?.split?.children ?? []).map((c) => service.get(c.taskId)?.task);
      // 登録した名前にそろえる。子タスクごとに違うリポジトリでよい
      expect(a).toMatchObject({
        repo: API,
        repoChoice: { reason: "API はこちら", by: "orchestrator" },
      });
      expect(b).toMatchObject({ repo: WEB, repoChoice: { reason: "画面", by: "orchestrator" } });
      expect(parent?.split?.children.map((c) => c.repo)).toEqual([API, WEB]);
      expect(repos.prepared).toEqual([]);

      await service.runNext(a?.id ?? "");
      expect(repos.prepared.map((p) => p.url)).toEqual([`${API}.git`]);
      service.approve(a?.id ?? "", { step: "investigate", submission: 1 });
      await service.runNext(id);
      await service.runNext(b?.id ?? "");
      expect(repos.prepared.map((p) => p.url)).toEqual([`${API}.git`, `${WEB}.git`]);
      service.approve(b?.id ?? "", { step: "investigate", submission: 1 });
      await service.runNext(id);
      expect(service.queuedTaskIds()).toEqual([id]);

      // 統合レビューは、子タスクのリポジトリごとにベースブランチの最新を読む
      await service.runNext(id);
      const review = service.get(id)?.task.integration;
      expect(review?.passed).toBe(true);
      expect(review?.repositories).toEqual([
        { repo: API, baseBranch: "main", commit: "c".repeat(40) },
        { repo: WEB, baseBranch: "main", commit: "c".repeat(40) },
      ]);
      expect(repos.fetchedBranches.map((f) => f.gitDir)).toEqual([
        expect.stringContaining(a?.id ?? "-"),
        expect.stringContaining(b?.id ?? "-"),
      ]);
      expect(executor.workspaceFiles.at(-1)).toEqual(["1-acme__api", "2-acme__web"]);
      const integrationPrompt = promptOf(executor, executor.calls.length - 1);
      expect(integrationPrompt).toContain(`- 1-acme__api/：${API} のベースブランチ（main）`);
      expect(integrationPrompt).toContain(`画面を作る（${WEB}）：完了`);
      expect(service.get(id)?.task.gate?.step).toBe("integrate");
      activity.close();
    });

    it("子タスクのリポジトリが無い・対象に無いなら使わず、再開すると分割をやり直して選び直す", async () => {
      const { service, activity, id } = await splitParent([
        splitOutput([{ ...children[0], repo: "" }, children[1]]),
        splitOutput([children[0], { ...children[1], repo: "https://github.com/tools/secret" }]),
        splitOutput(children),
      ]);
      const failed = () =>
        activity
          .forTask(id)
          .filter((e) => e.type === "AgentRunFailed")
          .map((e) => (e.type === "AgentRunFailed" ? textOf(e.payload.message) : ""));
      expect(service.get(id)?.task.status).toBe("paused");
      expect(failed()).toEqual([expect.stringMatching(/子タスク「A」にありません/)]);
      expect(service.get(id)?.task.split).toBeUndefined();
      service.resume(id, {});
      await service.runNext(id);
      expect(failed()[1]).toMatch(
        /子タスク「B」に付けたリポジトリ（https:\/\/github.com\/tools\/secret）は、プロジェクトの対象にありません/,
      );
      expect(service.get(id)?.task.split).toBeUndefined();
      service.resume(id, {});
      await service.runNext(id);
      expect(service.get(id)?.task.split?.children.map((c) => c.repo)).toEqual([API, WEB]);
      activity.close();
    });

    it("リポジトリのある親の分割は今と同じ（子は親のリポジトリ。分割案のリポジトリは使わない）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [out("# 要求要件"), design, splitOutput(children)],
        { projects: twoRepos(), planner },
      );
      const { id } = service.createTask({ projectId: "default", title: "大きい", repo: API });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      service.approve(id, { step: "design", submission: 1 });
      await service.runNext(id);
      expect(promptOf(executor, 2)).not.toContain("作業するリポジトリ（repo）");
      const kids = (service.get(id)?.task.split?.children ?? []).map(
        (c) => service.get(c.taskId)?.task,
      );
      expect(kids.map((k) => k?.repo)).toEqual([API, API]);
      expect(kids.map((k) => k?.repoChoice)).toEqual([undefined, undefined]);
      expect(service.get(id)?.task.split?.children.map((c) => c.repo)).toEqual([
        undefined,
        undefined,
      ]);
      activity.close();
    });
  });

  it("コードが要る工程は、リポジトリの無いまま実行しない（工程の実行の前に止める）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    // 作業履歴を手で作る：リポジトリの無いタスクに、実装の工程が選ばれていた
    activity.append({
      taskId: "t-norepo",
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "TaskCreated",
            payload: { title: "A", body: "", start: "sacty", noRepo: true, budgetCapUsd: 1 },
          },
        },
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: { steps: ["implement"], testCommand: "npm test", costUsd: 0 },
          },
        },
      ],
    });
    const { service, executor, repos } = makeService(activity, [out("# 実装")]);
    await service.runNext("t-norepo");
    const task = service.get("t-norepo")?.task;
    expect(task?.status).toBe("paused");
    const failed = activity.forTask("t-norepo").find((e) => e.type === "AgentRunFailed");
    expect(failed?.type === "AgentRunFailed" && textOf(failed.payload.message)).toMatch(
      /工程（implement）には対象リポジトリが要ります/,
    );
    expect(executor.calls).toHaveLength(0);
    expect(repos.prepared).toEqual([]);
    activity.close();
  });

  it("API でも、リポジトリを選ばずに作り、人がリポジトリを選べる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [plan({ plan: "standard", repo: "", repoReason: "分からない" })],
      { projects: twoRepos(), realPlanner: true },
    );
    const token = "test-token";
    const json = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const app = createApp(service, token);
    const res = await app.request("/api/tasks", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ projectId: "default", title: "API から", repo: null }),
    });
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: Task };
    expect(task.noRepo).toBe(true);
    await service.runNext(task.id);
    const bad = await app.request(`/api/tasks/${task.id}/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ repo: "https://github.com/tools/secret" }),
    });
    expect(bad.status).toBe(409);
    const ok = await app.request(`/api/tasks/${task.id}/repository`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ repo: WEB }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { task: Task }).task.repo).toBe(WEB);
    activity.close();
  });
});

describe("リポジトリを指定しないタスクのリポジトリの選び直し（PBI-73 レビュー指摘）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const plan = (v: Record<string, unknown>) =>
    out(`\`\`\`json\n${JSON.stringify({ "sacty-steps": { reason: "理由", ...v } })}\n\`\`\``);
  const API = "https://github.com/acme/api";
  const WEB = "https://github.com/acme/web";
  const twoRepos = () => {
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: API },
        { scope: "repo", target: WEB },
      ],
      githubAccounts: { "github.com": "me" },
    });
    return projects;
  };

  it("オーケストレーターが選んだリポジトリを用意できなければ止まり、人が別のリポジトリを選び直して再開できる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const repos = new FakeRepos();
    const { service } = makeService(
      activity,
      [
        plan({ plan: "standard", repo: API, repoReason: "API" }),
        plan({ plan: "investigate", testCommand: "npm test" }),
        out("# 調査"),
      ],
      { projects: twoRepos(), realPlanner: true, repos },
    );
    const { id } = service.createTask({ projectId: "default", title: "直す" });
    await service.runNext(id);
    expect(service.get(id)?.task.repo).toBe(API);
    repos.fail = "Repository not found";
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(service.get(id)?.task.repository).toBeUndefined();
    repos.fail = undefined;
    const picked = await service.chooseRepository(id, WEB);
    expect(picked).toMatchObject({ repo: WEB, repoChoice: { by: "person" } });
    service.resume(id, {});
    await service.runNext(id);
    expect(repos.prepared.map((p) => p.url)).toEqual([`${WEB}.git`]);
    expect(service.get(id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    activity.close();
  });

  it("止まっていないタスクでは、人はリポジトリを選べない（オーケストレーターの選択とぶつけない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos(), realPlanner: true });
    const { id } = service.createTask({ projectId: "default", title: "直す" });
    expect(service.get(id)?.task.status).toBe("queued");
    await expect(service.chooseRepository(id, WEB)).rejects.toThrow(/止まっているタスクだけ/);
    expect(service.get(id)?.task.repo).toBeUndefined();
    activity.close();
  });
});

describe("コンテキストのプレビュー（PBI-76）", () => {
  const token = "test-token";
  const auth = { authorization: `Bearer ${token}` };
  const json = { ...auth, "content-type": "application/json" };
  const ctxRepo = "https://github.com/acme/ctx.git";
  const files = {
    "rules.md": "# チームの規約",
    "skills/grp/deploy/SKILL.md": "---\ndescription: デプロイ手順\n---\n手順",
    "mcp.yaml": [
      "servers:",
      "  github:",
      "    command: server-github",
      "    env:",
      "      GITHUB_TOKEN: { secret: mcp-github }",
      "  docs:",
      "    url: https://docs.example.com/mcp",
      "    headers:",
      "      Authorization: { secret: docs-token, prefix: 'Bearer ' }",
      "  cloud:",
      "    command: shadowed",
      "    tool_timeout_sec: 1800",
    ].join("\n"),
    "platforms.yaml": [
      "platforms:",
      "  wiki:",
      "    upstream: https://wiki.example.com",
      "    description: Wiki",
      "    auth:",
      "      secret: wiki-token",
      "    allow: [GET /api/**]",
    ].join("\n"),
    "agents/claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }),
    "agents/codex/config.toml": 'model_reasoning_summary = "concise"\n',
  };
  /** 取得した場所も記録する（後片付けを確かめる）。 */
  class RecordingContexts extends FakeContexts {
    outs: string[] = [];
    override async fetch(ref: ContextRef, out: string, authEnv?: Record<string, string>) {
      this.outs.push(out);
      return super.fetch(ref, out, authEnv);
    }
  }
  const secretValues: Record<string, string> = {
    "claude-oauth-token": "oauth-secret",
    "openai-key": "openai-secret",
    "mcp-github": "mcp-github-value",
    "docs-token": "docs-secret-value",
    "wiki-token": "wiki-secret-value",
  };
  const setup = (
    a: AgentConfig = agent(),
    repos: Record<string, Record<string, string>> = { [ctxRepo]: files },
  ) => {
    const activity = new SqliteActivityStore(dbPath);
    const projects = new MemoryProjectStore();
    projects.put("p", {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: ctxRepo },
    });
    projects.put("bare", {
      name: "コンテキストなし",
      targets: [{ scope: "repo", target: "https://github.com/acme/bare" }],
      githubAccounts: { "github.com": "me" },
    });
    const contexts = new RecordingContexts(repos);
    const gets: string[] = [];
    const registered: unknown[] = [];
    /** ホストの MCP サーバーの準備を待った名前（PBI-77）。プレビューでは待たない。 */
    const ready: string[][] = [];
    const cloud = toHostMcp("cloud", HostMcpFile.parse({ command: "cloud-mcp" }));
    const made = makeService(activity, [completed(20_000)], {
      config: configOf(a, 1, [jiraPlatform()], [cloud]),
      projects,
      contexts,
      defaultContext: DEFAULT_CONTEXT_DIR,
      hostMcpReady: async (names) => {
        ready.push([...names]);
        return [message("gateway.mcpUnavailable", { name: "cloud", detail: "starting" })];
      },
      secretStore: {
        get: async (name) => {
          gets.push(name);
          const value = secretValues[name];
          if (value === undefined) throw new SecretNotFoundError(name);
          return value;
        },
      },
      gateway: {
        containerOrigin: () => "http://host.docker.internal:5001",
        platformsUrl: (t) => `http://host.docker.internal:5001/r/${t}/pf`,
        register: (_route, mcp) => {
          registered.push(mcp);
          return {
            token: "sacty-gw-run-token",
            stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
            close: () => {},
          };
        },
      },
    });
    return {
      ...made,
      activity,
      contexts,
      gets,
      registered,
      ready,
      app: createApp(made.service, token),
    };
  };
  const preview = async (
    app: ReturnType<typeof createApp>,
    id: string,
    body?: unknown,
    runtime = "claude-code",
  ) =>
    body === undefined
      ? app.request(`/api/projects/${id}/context-preview?runtime=${runtime}`, { headers: auth })
      : app.request(`/api/projects/${id}/context-preview`, {
          method: "POST",
          headers: json,
          body: JSON.stringify(body),
        });

  for (const [runtime, a] of [
    ["claude-code", agent()],
    [
      "codex",
      agent({ id: "codex-key", runtime: "codex", auth: { mode: "api-key", secret: "openai-key" } }),
    ],
  ] as const) {
    it(`${runtime}：API のプレビューのファイルは、工程の実行で実際に置いたファイルと一致する`, async () => {
      const { activity, service, executor, app } = setup(a);
      const res = await preview(app, "p", undefined, runtime);
      expect(res.status).toBe(200);
      const { preview: view } = (await res.json()) as {
        preview: { files: { path: string; content: string }[]; runtime: string };
      };
      expect(view.runtime).toBe(runtime);
      const { id } = service.createTask({ projectId: "p", title: "調べる" });
      await service.runNext(id);
      const placed = executor.seeds[0];
      expect(placed && Object.keys(placed).length).toBeGreaterThan(5);
      expect(Object.fromEntries(view.files.map((f) => [f.path, f.content]))).toEqual(placed);
      // AI の種類ごとの設定のファイル
      expect(Object.keys(placed ?? {})).toContain(
        runtime === "codex" ? "config.toml" : "settings.json",
      );
      activity.close();
    });
  }

  it("秘密情報の値・ゲートウェイの実行ごとのトークン・gh のトークンを出さず、秘密情報を取り出さない", async () => {
    const { activity, app, gets, registered, contexts, ready } = setup();
    const res = await preview(app, "p");
    const text = await res.text();
    for (const value of [...Object.values(secretValues), "sacty-gw-run-token", "ghp_secret"]) {
      expect(text).not.toContain(value);
    }
    expect(gets).toEqual([]);
    // ゲートウェイに実行を登録せず、ホストの MCP サーバーの準備も待たない（起動の副作用を起こさない。PBI-77）
    expect(registered).toEqual([]);
    expect(ready).toEqual([]);
    // コンテキストの取得には、プロジェクトの gh のアカウントを使う（実行と同じ）
    expect(contexts.fetched.at(-1)?.authEnv).toBeDefined();
    const view = JSON.parse(text).preview;
    expect(view.secrets).toEqual([
      { env: "SACTY_MCP_SECRET_0", secret: "mcp-github", prefix: "", gatewayToken: false },
      {
        env: "SACTY_MCP_SECRET_1",
        secret: "sacty:gateway-token",
        prefix: "Bearer ",
        gatewayToken: true,
      },
      {
        env: "SACTY_MCP_SECRET_2",
        secret: "sacty:gateway-token",
        prefix: "Bearer ",
        gatewayToken: true,
      },
    ]);
    // MCP は、ゲートウェイ経由に置き換えた形と元の接続先の両方
    expect(view.mcp).toEqual([
      expect.objectContaining({ name: "github", origin: { kind: "direct" } }),
      expect.objectContaining({
        name: "docs",
        agent: { url: "http://host.docker.internal:5001/ctx-mcp/docs" },
        origin: {
          kind: "gateway",
          url: "https://docs.example.com/mcp",
          headers: { Authorization: { secret: "docs-token", prefix: "Bearer " } },
        },
      }),
      expect.objectContaining({
        name: "cloud",
        from: "sacty-gateway",
        agent: { url: "http://host.docker.internal:5001/mcp/cloud" },
        origin: { kind: "host" },
      }),
    ]);
    // 使える外部 PF（ホストと層。秘密情報の名前も出さない）と、警告（ホストと同じ名前）
    expect(view.platforms.map((p: { name: string }) => p.name)).toEqual(["jira", "wiki"]);
    expect(text).not.toContain("wiki-token");
    expect(view.warnings.map((w: unknown) => (w as { code: string }).code)).toEqual([
      "context.hostMcpOverride",
    ]);
    activity.close();
  });

  it("工程の実行では、ホストの MCP の準備を待ち（PBI-77）、作業履歴にホストと同じ名前の警告と準備の警告を残す", async () => {
    const { activity, service, ready, app } = setup();
    // プレビュー・保存の検査は待たない
    await preview(app, "p", undefined, "codex");
    await app.request("/api/projects/p", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({
        name: "決済",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
        context: { repo: ctxRepo },
      }),
    });
    expect(ready).toEqual([]);
    const { id } = service.createTask({ projectId: "p", title: "調べる" });
    await service.runNext(id);
    expect(ready).toEqual([["cloud"]]);
    const resolved = activity.forTask(id).find((e) => e.type === "ContextResolved");
    expect(
      resolved?.type === "ContextResolved" &&
        resolved.payload.warnings.map((w) => (typeof w === "string" ? w : w.code)),
    ).toEqual(["context.hostMcpOverride", "gateway.mcpUnavailable"]);
    activity.close();
  });

  it("編集中の（保存していない）設定でプレビューでき、保存した設定・作業履歴は変えない", async () => {
    const { activity, service, app, contexts } = setup(agent(), {
      [ctxRepo]: files,
      "https://github.com/acme/other.git": { "rules.md": "# 別のコンテキスト" },
    });
    const before = service.getProject("bare");
    const saved = (await (await preview(app, "bare")).json()).preview;
    expect(saved.layers.map((l: { repo: string }) => l.repo)).toEqual(["sacty-default"]);
    const editing = await preview(app, "bare", {
      runtime: "codex",
      definition: {
        name: "コンテキストなし",
        targets: [{ scope: "repo", target: "https://github.com/acme/bare" }],
        githubAccounts: { "github.com": "me" },
        context: { repo: "https://github.com/acme/other.git", ref: "dev" },
      },
    });
    expect(editing.status).toBe(200);
    const view = (await editing.json()).preview;
    expect(view.runtime).toBe("codex");
    expect(
      view.layers.map((l: { repo: string; ref?: string }) => `${l.repo}#${l.ref ?? ""}`),
    ).toEqual(["sacty-default#", "https://github.com/acme/other.git#dev"]);
    const agents = view.files.find((f: { path: string }) => f.path === "AGENTS.md");
    expect(agents.content).toContain("# 別のコンテキスト");
    // 保存していない設定の gh のアカウントで取得する
    expect(contexts.fetched.at(-1)).toMatchObject({ repo: "https://github.com/acme/other.git" });
    expect(contexts.fetched.at(-1)?.authEnv).toBeDefined();
    // 保存した設定は変わらず、作業履歴にも何も残さない。取得したものは消す
    expect(service.getProject("bare")).toEqual(before);
    expect(service.list()).toEqual([]);
    for (const out of contexts.outs) expect(existsSync(out)).toBe(false);
    activity.close();
  });

  it("誤りは、どの層のどのファイルのどの項目かがわかる理由で返し、トークンは伏せる", async () => {
    const { activity, app } = setup(agent(), {
      [ctxRepo]: { "mcp.yaml": "servers:\n  bad:\n    url: ftp://x\n" },
    });
    const res = await preview(app, "p");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { error: unknown };
    expect(ja(body.error)).toContain(`${ctxRepo}# の mcp.yaml に誤りがあります（servers.bad.url）`);
    activity.close();

    const failing = setup();
    failing.contexts.fail = true;
    const failed = (await (await preview(failing.app, "p")).json()) as { error: unknown };
    expect(ja(failed.error)).toContain("Authentication failed");
    expect(JSON.stringify(failed)).not.toContain("ghp_secret");
    expect(ja(failed.error)).toContain("[REDACTED]");
    failing.activity.close();
  });

  it("保存するときも同じ検査をし、誤りがあれば保存したうえで知らせる（誤りが無ければ知らせない）", async () => {
    const { activity, app, service } = setup(agent(), {
      [ctxRepo]: files,
      "https://github.com/acme/broken.git": {
        "platforms.yaml": "platforms:\n  x: { upstream: 1 }\n",
      },
    });
    const definition = {
      name: "決済",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
    };
    const put = (body: unknown) =>
      app.request("/api/projects/p", { method: "PUT", headers: json, body: JSON.stringify(body) });
    const broken = await put({
      ...definition,
      context: { repo: "https://github.com/acme/broken.git" },
    });
    expect(broken.status).toBe(200);
    const saved = (await broken.json()) as { project: { context: unknown }; contextError: unknown };
    expect(saved.project.context).toEqual({ repo: "https://github.com/acme/broken.git" });
    expect(ja(saved.contextError)).toContain(
      "https://github.com/acme/broken.git# の platforms.yaml に誤りがあります（platforms.x",
    );
    expect(service.getProject("p")?.project.context).toEqual({
      repo: "https://github.com/acme/broken.git",
    });
    const fine = await put({ ...definition, context: { repo: ctxRepo } });
    expect(await fine.json()).not.toHaveProperty("contextError");
    // コンテキストリポジトリを外せば、確かめない
    const none = await put(definition);
    expect(await none.json()).not.toHaveProperty("contextError");
    const created = await app.request("/api/projects", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        name: "新規",
        context: { repo: "https://github.com/acme/broken.git" },
      }),
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toHaveProperty("contextError");
    activity.close();
  });

  it("無いプロジェクトは404、AI の種類・設定の誤りは400を返す", async () => {
    const { activity, app } = setup();
    expect((await preview(app, "missing")).status).toBe(404);
    expect((await preview(app, "missing", { runtime: "codex" })).status).toBe(404);
    expect((await preview(app, "p", undefined, "gpt")).status).toBe(400);
    expect((await preview(app, "p", { runtime: "gpt" })).status).toBe(400);
    const invalid = await preview(app, "p", { definition: { name: "" } });
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { issues: { path: unknown[] }[] }).issues[0]?.path).toEqual([
      "definition",
      "name",
    ]);
    expect((await preview(app, "p", { extra: 1 })).status).toBe(400);
    const notJson = await app.request("/api/projects/p/context-preview", {
      method: "POST",
      headers: json,
      body: "{",
    });
    expect(notJson.status).toBe(400);
    // 認証が無ければ 401
    expect((await app.request("/api/projects/p/context-preview")).status).toBe(401);
    activity.close();
  });
});

describe("タスクのテンプレート「Sacty セットアップ」（PBI-90）", () => {
  const out = (text: string, output = 1): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const API = "https://github.com/acme/api";
  const WEB = "https://github.com/acme/web";
  const twoRepos = () => {
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [
        { scope: "repo", target: API },
        { scope: "repo", target: WEB },
      ],
      githubAccounts: { "github.com": "me" },
    });
    projects.put("other", {
      name: "ほか",
      targets: [{ scope: "repo", target: "https://github.com/tools/secret" }],
      githubAccounts: { "github.com": "me" },
    });
    return projects;
  };
  const isZod = (fn: () => unknown) => {
    try {
      fn();
    } catch (error) {
      return error instanceof Error && error.name === "ZodError";
    }
    return false;
  };

  it("リポジトリだけで作り、題と説明（ゴール）は sacty が決め、テンプレートを記録する（再起動の後も残る）", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    const task = service.createTask({
      template: "sacty-setup",
      projectId: "default",
      repo: API.toUpperCase(),
    });
    // 通常のタスクと同じく、画面で作ったタスクとして実行待ちになる。リポジトリは登録した名前にそろえる
    expect(task).toMatchObject({
      template: "sacty-setup",
      start: "sacty",
      repo: API,
      status: "queued",
      title: "Sacty セットアップ（acme/api）",
    });
    expect(task.noRepo).toBeUndefined();
    // ゴール：エージェント向けの指示・テストの実行の仕方・テストに要るサービス・デプロイの確認のスキル
    // URL は行の末尾に置く（画面の Markdown で、後ろの文字までリンクにしない）
    expect(task.body).toContain(`- 対象のリポジトリ：${API}\n`);
    expect(task.body).toContain("AGENTS.md・CLAUDE.md");
    expect(task.body).toContain("テストの実行の仕方");
    expect(task.body).toContain("テストに要るサービス");
    // デプロイの確認のスキルは、マージの後の監視（PBI-89）が探す置き場所・名前・答えの形に合わせる
    expect(task.body).toContain(".agents/skills/deployment-observer/SKILL.md");
    expect(task.body).toContain(".claude/skills/deployment-observer");
    expect(task.body).toContain("../../.agents/skills/deployment-observer");
    expect(task.body).toContain("name: deployment-observer");
    expect(task.body).toContain(
      '{"sacty-deployment": {"ci": {"result": "passed | failed | skipped | unknown"',
    );
    expect(task.body).toContain(".agents/skills/deployment-observer/references/ci.md");
    // 変更が要らなければ、PR を作らずに検査の結果を残して終える
    expect(task.body).toContain("PR を作らずに");
    const created = activity.forTask(task.id).find((e) => e.type === "TaskCreated");
    expect(created?.payload).toMatchObject({ template: "sacty-setup", repo: API });
    // 作業履歴から復元しても、テンプレートで作ったことが残る
    const { service: restarted } = makeService(activity, [], { projects: twoRepos() });
    expect(restarted.get(task.id)?.task.template).toBe("sacty-setup");
    // 通常のタスクには、テンプレートは付かない
    expect(
      service.createTask({ projectId: "default", title: "A", repo: API }).template,
    ).toBeUndefined();
    activity.close();
  });

  it("ゴールは、特定の言語・ツール・sacty 自身に寄せない", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, []);
    const { body } = service.createTask({ template: "sacty-setup", projectId: "default" });
    for (const word of [
      "npm",
      "Node",
      "node_modules",
      "package.json",
      "vitest",
      "TypeScript",
      "Python",
      "pytest",
      "Maven",
      "Gradle",
      "GitHub Actions",
      "sacty リポジトリ",
    ]) {
      expect(body, word).not.toContain(word);
    }
    activity.close();
  });

  it("リポジトリは必須（対象がリポジトリ1つだけなら省略できる）。題・説明・null・対象の外・知らないテンプレートは受け付けない", () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { projects: twoRepos() });
    // 対象が複数で省略したら、理由を返して作らない
    expect(() => service.createTask({ template: "sacty-setup", projectId: "default" })).toThrow(
      /このテンプレートでは、対象リポジトリを選んでください/,
    );
    expect(
      isZod(() =>
        service.createTask({ template: "sacty-setup", projectId: "default", repo: "  " }),
      ),
    ).toBe(true);
    expect(
      isZod(() =>
        service.createTask({ template: "sacty-setup", projectId: "default", repo: null }),
      ),
    ).toBe(true);
    // 題・説明は sacty が決めるので、渡せば誤り
    expect(
      isZod(() =>
        service.createTask({
          template: "sacty-setup",
          projectId: "default",
          repo: API,
          title: "X",
        }),
      ),
    ).toBe(true);
    expect(
      isZod(() =>
        service.createTask({ template: "sacty-setup", projectId: "default", repo: API, body: "" }),
      ),
    ).toBe(true);
    expect(
      isZod(() => service.createTask({ template: "unknown", projectId: "default", repo: API })),
    ).toBe(true);
    expect(
      isZod(() =>
        service.createTask({ template: "", projectId: "default", title: "A", repo: API }),
      ),
    ).toBe(true);
    // 対象の外（ほかのプロジェクトのリポジトリ・URL でないもの）は作らない
    expect(() =>
      service.createTask({
        template: "sacty-setup",
        projectId: "default",
        repo: "https://github.com/tools/secret",
      }),
    ).toThrow(/対象リポジトリを、プロジェクト/);
    expect(() =>
      service.createTask({ template: "sacty-setup", projectId: "default", repo: "acme/api" }),
    ).toThrow(/対象リポジトリを、プロジェクト/);
    expect(() =>
      service.createTask({ template: "sacty-setup", projectId: "missing", repo: API }),
    ).toThrow(/プロジェクトが見つかりません/);
    expect(service.list()).toEqual([]);
    activity.close();

    // 対象がリポジトリ1つだけなら、省略するとそれにする
    rmSync(dbPath);
    const single = new SqliteActivityStore(dbPath);
    const { service: one } = makeService(single, []);
    expect(one.createTask({ template: "sacty-setup", projectId: "default" }).repo).toBe(
      "https://github.com/acme/app",
    );
    single.close();

    // 対象が Org なら、その Org のリポジトリを選べる（省略はできない）
    rmSync(dbPath);
    const org = new SqliteActivityStore(dbPath);
    const orgProjects = projectsWithAccount();
    orgProjects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "org", target: "https://github.com/acme" }],
      githubAccounts: { "github.com": "me" },
    });
    const { service: byOrg } = makeService(org, [], { projects: orgProjects });
    expect(() => byOrg.createTask({ template: "sacty-setup", projectId: "default" })).toThrow(
      /このテンプレートでは、対象リポジトリを選んでください/,
    );
    expect(
      byOrg.createTask({ template: "sacty-setup", projectId: "default", repo: `${API}.git` }).repo,
    ).toBe(API);
    org.close();
  });

  it("通常のタスクと同じく、オーケストレーターがリポジトリを読んで工程を選ぶ。整っていれば調査だけで終え、PR を作らない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, pulls } = makeService(
      activity,
      [
        out(
          block({
            "sacty-steps": {
              plan: "investigate",
              reason: "設定は整っていて、変更は要らない",
              testCommand: "make test",
            },
          }),
        ),
        out("# 検査の結果\n\n- AGENTS.md：ある"),
      ],
      { realPlanner: true },
    );
    const { id } = service.createTask({ template: "sacty-setup", projectId: "default" });
    await service.runNext(id);
    // オーケストレーターにも、調査のエージェントにも、ゴールが渡る
    expect(promptOf(executor, 0)).toContain("あなたはオーケストレーターです");
    expect(promptOf(executor, 0)).toContain(".agents/skills/deployment-observer/SKILL.md");
    expect(promptOf(executor, 1)).toContain("あなたはソフトウェア開発の調査エージェントです");
    expect(promptOf(executor, 1)).toContain(".agents/skills/deployment-observer/SKILL.md");
    expect(service.get(id)?.task.gate).toEqual({ step: "investigate", submission: 1 });
    const done = service.approve(id, { step: "investigate", submission: 1 });
    expect(isCompleted(done)).toBe(true);
    // 検査の結果が残り、PR は作らない
    expect(done.approved.investigate?.output).toContain("# 検査の結果");
    expect(done.template).toBe("sacty-setup");
    expect(pulls.calls).toEqual([]);
    activity.close();
  });

  it("API でも、テンプレートで作れる。題・説明・知らないテンプレートは400、リポジトリを選んでいなければ409", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const token = "test-token";
    const app = createApp(makeService(activity, [], { projects: twoRepos() }).service, token);
    const auth = { authorization: `Bearer ${token}` };
    const post = (body: unknown) =>
      app.request("/api/tasks", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    const res = await post({ template: "sacty-setup", projectId: "default", repo: WEB });
    expect(res.status).toBe(201);
    const { task } = (await res.json()) as { task: Task };
    expect(task).toMatchObject({ template: "sacty-setup", repo: WEB });
    const detail = (await (
      await app.request(`/api/tasks/${task.id}`, { headers: auth })
    ).json()) as { task: Task; activity: { type: string; payload: { template?: string } }[] };
    expect(detail.task.template).toBe("sacty-setup");
    expect(detail.activity[0]?.payload.template).toBe("sacty-setup");
    expect(
      (await post({ template: "sacty-setup", projectId: "default", repo: WEB, title: "X" })).status,
    ).toBe(400);
    expect((await post({ template: "nope", projectId: "default", repo: WEB })).status).toBe(400);
    const missing = await post({ template: "sacty-setup", projectId: "default" });
    expect(missing.status).toBe(409);
    activity.close();
  });
});

describe("PR テンプレート（PBI-87）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const design = out(
    [
      "# 設計",
      block({
        "sacty-test-viewpoints": [
          { title: "同じキーの再送", input: "同じキーで2回送る", expected: "決済は1回" },
        ],
      }),
    ].join("\n\n"),
  );
  const implement = (text = "# 実装の説明") =>
    out(
      [
        text,
        block({
          "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] }],
        }),
      ].join("\n\n"),
    );
  const review = out(
    block({
      "sacty-final-review": {
        viewpoints: [{ id: "TV-1", verified: true, reason: "TV-1の判定理由" }],
        remarks: [],
        summary: "所見",
      },
    }),
  );
  const template = [
    "## 概要",
    "<!-- 何のための PR か -->",
    "",
    "## 変更内容",
    "",
    "## テスト",
    "- [x] 単体テストを足した",
    "",
    "## スクリーンショット",
    "",
  ].join("\n");
  const taskOf = (svc: TaskService, id: string) => svc.get(id)?.task as Task;

  class FakeTemplates {
    calls: { repo: string; token: string }[] = [];
    constructor(private readonly result: () => Promise<TemplateLookup>) {}
    async find(input: { repo: string; token: string }) {
      this.calls.push(input);
      return this.result();
    }
  }
  const found = (text = template) =>
    new FakeTemplates(async () => ({
      kind: "found",
      template: {
        repo: "https://github.com/acme/.github",
        path: ".github/pull_request_template.md",
        text,
      },
    }));

  async function drain(service: TaskService, max = 12) {
    for (let i = 0; i < max; i++) {
      const ids = service.queuedTaskIds();
      if (ids.length === 0) return;
      for (const id of ids) await service.runNext(id);
    }
  }

  /** 要求要件・設計を PR で承認する流れで、実装の PR まで進める。 */
  async function toPullRequest(
    templates: FakeTemplates,
    implementation = implement(),
    requirements = "# 要求要件 v1",
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const repos = new FakeRepos();
    const made = makeService(activity, [out(requirements), design, implementation, review], {
      stepPullRequests: true,
      now: () => Date.parse("2026-10-11T00:03:00Z"),
      pulls,
      repos,
      templates,
    });
    const { service } = made;
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "本文" });
    const merge = async (step: "requirements" | "design") => {
      const pr = taskOf(service, id).stepPullRequests.findLast((p) => p.step === step);
      if (!pr) throw new Error(`no pull request for ${step}`);
      pulls.states[pr.number] = { state: "merged", mergedBy: "reviewer", headSha: pr.commit };
      repos.remote[`sacty/task-${id.slice(0, 8)}`] = `m${pr.number}`.padEnd(40, "0");
      await service.checkPullRequests();
    };
    await service.runNext(id); // 要求要件 → PR
    await merge("requirements");
    await service.runNext(id); // 設計 → PR
    await merge("design");
    await drain(service); // 実装・検証 → 実装の PR
    return { activity, service, pulls, id };
  }

  it("要求要件・設計の PR と実装の PR の本文を、テンプレートの見出しの形で埋め、使ったテンプレートを台帳に残す（受け入れ条件 1〜4）", async () => {
    const templates = found();
    const { activity, service, pulls, id } = await toPullRequest(templates);
    expect(pulls.calls).toHaveLength(3);
    // PR を作るたびに、PR を作るリポジトリでテンプレートを探す
    expect(templates.calls).toEqual(
      Array.from({ length: 3 }, () => ({
        repo: "https://github.com/acme/app",
        token: "ghp_secret",
      })),
    );
    const [requirements, designPr, impl] = pulls.calls.map((c) => c.body);
    // 要求要件の PR：テンプレートの見出しに沿い、承認の仕方とタスクの ID は最後に必ず入る
    expect(requirements).toMatch(
      /^## 概要\n\n<!-- 何のための PR か -->\n\nsacty のタスク「決済API」の要求要件です。/,
    );
    expect(requirements).toContain(
      `## 変更内容\n\n成果のファイル：\`docs/sacty/${id.slice(0, 8)}/requirements.md\``,
    );
    expect(requirements).toContain(`## テスト\n\n- [ ] 単体テストを足した`);
    expect(requirements).toContain(`## スクリーンショット\n\n${NOT_APPLICABLE}`);
    expect(requirements).toContain(`sacty task ${id}`);
    expect(requirements).toContain("この PR をマージすると、要求要件を承認したことになり");
    expect(designPr).toContain(
      "承認済みの前の工程：\n- 要求要件：https://github.com/acme/app/pull/7",
    );
    // 実装の PR：目的・変更・テストをそれぞれの見出しに入れ、最終レビューは sacty の記録にする
    expect(impl).toContain(
      "## 概要\n\n<!-- 何のための PR か -->\n\nsacty のタスク「決済API」の成果物です。",
    );
    expect(impl).toContain("**要求要件（人間が承認済み）**\n\n# 要求要件 v1");
    expect(impl).toContain("## 変更内容\n\n# 実装の説明");
    expect(impl).toContain("## テスト\n\n| 観点 | 入力 | 期待結果 | テスト | 最終レビュー |");
    expect(impl).toContain("テスト：`npm test` → 合格（終了コード 0）\n\n- [ ] 単体テストを足した");
    expect(impl).toContain("<summary>sacty の記録</summary>");
    expect(impl).toContain("**ゴールガーディアンの最終レビュー**\n\n合格。所見");
    expect(impl).not.toMatch(/\[[xX]\]/);
    // 最後の部分に、タスクの ID と、マージが実装の承認になることの案内（PBI-110）
    expect(impl).toContain(
      `sacty task ${id}）。\n\n- この PR をマージすると、実装を承認したことになり`,
    );
    expect(impl?.trimEnd().endsWith("人が直した最終のコミットの両方を記録に残します）。")).toBe(
      true,
    );
    expect(impl).not.toContain("成果物チェック");
    // 台帳と画面に、使ったテンプレートを残す
    const used = {
      repo: "https://github.com/acme/.github",
      path: ".github/pull_request_template.md",
    };
    const task = taskOf(service, id);
    expect(task.stepPullRequests.map((p) => p.template)).toEqual([used, used]);
    expect(task.pullRequest?.template).toEqual(used);
    // レビュー用のラベル（PBI-88・PBI-99）も、テンプレートの本文と一緒に3つの PR に付く
    expect(pulls.labels.map((l) => [l.number, l.label])).toEqual([
      [7, "sacty-review"],
      [8, "sacty-review"],
      [9, "sacty-review"],
    ]);
    expect(task.pullRequest?.label).toBe("sacty-review");
    activity.close();
  });

  it("テンプレートが無ければ今の本文で作り、無かったことを台帳に残す", async () => {
    const { activity, service, pulls, id } = await toPullRequest(
      new FakeTemplates(async () => ({ kind: "none" })),
    );
    const task = taskOf(service, id);
    expect(pulls.calls[2]?.body).toBe(buildPullRequestBody(task));
    expect(task.pullRequest?.template).toEqual({ fallback: "none" });
    expect(task.stepPullRequests[0]?.template).toEqual({ fallback: "none" });
    activity.close();
  });

  it("テンプレートを読めない・探す処理が失敗しても、PR の作成を止めずに今の本文で作り、理由を伏せて残す（受け入れ条件 4・5）", async () => {
    const unusable = await toPullRequest(
      new FakeTemplates(async () => ({
        kind: "unusable",
        repo: "https://github.com/acme/app",
        message: message("pr.templateFailed", {
          path: "/",
          status: 403,
          detail: "bad credentials ghp_secret",
        }),
      })),
    );
    let task = taskOf(unusable.service, unusable.id);
    expect(unusable.pulls.calls).toHaveLength(3);
    expect(unusable.pulls.calls[2]?.body).toBe(buildPullRequestBody(task));
    expect(task.pullRequest?.template?.fallback).toBe("unusable");
    expect(renderMessage(task.pullRequest?.template?.message, "ja")).toContain("HTTP 403");
    expect(JSON.stringify(unusable.service.get(unusable.id)?.activity)).not.toContain("ghp_secret");
    unusable.activity.close();

    const thrown = await toPullRequest(
      new FakeTemplates(async () => {
        throw new Error("boom ghp_secret");
      }),
    );
    task = taskOf(thrown.service, thrown.id);
    expect(thrown.pulls.calls).toHaveLength(3);
    expect(task.pullRequest?.template).toEqual({
      fallback: "unusable",
      message: "boom [REDACTED]",
    });
    thrown.activity.close();
  });

  it("本文が長さの上限を超えるなら、後ろを省いてタスクの ID を残し、省いたことを台帳に残す（受け入れ条件 5）", async () => {
    const long = implement(`# 実装の説明\n\n${"長い説明。".repeat(20_000)}`);
    const withTemplate = await toPullRequest(found(), long);
    const body = withTemplate.pulls.calls[2]?.body ?? "";
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(body).toContain(`sacty task ${withTemplate.id}`);
    expect(taskOf(withTemplate.service, withTemplate.id).pullRequest?.template?.truncated).toBe(
      true,
    );
    withTemplate.activity.close();
  });

  it("テンプレートが無い・使えないときも、本文を省くときに実装の承認の案内とタスクの ID を失わない（PR #99 レビュー指摘）", async () => {
    for (const templates of [
      new FakeTemplates(async () => ({ kind: "none" })),
      new FakeTemplates(async () => {
        throw new Error("boom");
      }),
    ]) {
      const made = await toPullRequest(
        templates,
        implement(),
        `# 要求要件 v1\n\n${"長い要求要件。".repeat(20_000)}`,
      );
      const body = made.pulls.calls[2]?.body ?? "";
      expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
      expect(body).toContain(`sacty task ${made.id}`);
      expect(body).toContain(
        "この PR は sacty が作成しました。\n\n- この PR をマージすると、実装を承認したことになり",
      );
      expect(body.endsWith("人が直した最終のコミットの両方を記録に残します）。")).toBe(true);
      expect(taskOf(made.service, made.id).pullRequest?.template?.truncated).toBe(true);
      made.activity.close();
    }
  });

  it("本文に秘密の値を出さない（エージェントの出力に紛れても伏せる）", async () => {
    const leaked = await toPullRequest(
      found(),
      implement("# 実装の説明\n\nトークン ghp_secret を使った"),
    );
    expect(leaked.pulls.calls[2]?.body).not.toContain("ghp_secret");
    leaked.activity.close();
  });
});

describe("マージの後の CI/CD とデプロイの監視（PBI-89）", () => {
  const MERGE = "a".repeat(40);
  const SKILL = ".agents/skills/deployment-observer/SKILL.md";

  /** CI/CD の状態の偽物。snap が Error なら読めない。 */
  class FakeCi implements CiStatusReader {
    snap: CiSnapshot | Error = { checks: [], failedRuns: [] };
    failuresList: CiFailure[] = [];
    calls: { repo: string; token: string; commit: string }[] = [];
    failureCalls: { secrets: readonly string[] }[] = [];
    async snapshot(input: { repo: string; token: string; commit: string }) {
      this.calls.push(input);
      if (this.snap instanceof Error) throw this.snap;
      return this.snap;
    }
    async failures(input: { secrets: readonly string[] }) {
      this.failureCalls.push({ secrets: [...input.secrets] });
      return this.failuresList;
    }
  }
  const success = (): CiSnapshot => ({
    checks: [{ kind: "workflow", name: "CI", status: "completed", conclusion: "success" }],
    failedRuns: [],
  });
  const failing = (): CiSnapshot => ({
    checks: [
      {
        kind: "workflow",
        name: "CI",
        status: "completed",
        conclusion: "failure",
        url: "https://github.com/acme/app/actions/runs/1",
      },
    ],
    failedRuns: [
      {
        id: 1,
        name: "CI",
        conclusion: "failure",
        url: "https://github.com/acme/app/actions/runs/1",
      },
    ],
  });
  const testFailure: CiFailure = {
    workflow: "CI",
    job: "test",
    conclusion: "failure",
    url: "https://github.com/acme/app/actions/runs/1/job/7",
    excerpt: "FAIL pay.test.ts\ntoken=[REDACTED]",
  };
  /** 起点のコミット（FakeRepos の clone の先頭）。 */
  const BASE = "base123";
  const watchedProjects = () => {
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
    });
    return projects;
  };
  const types = (svc: TaskService, id: string) => svc.get(id)?.activity.map((e) => e.type) ?? [];
  const deploymentTypes = (svc: TaskService, id: string) =>
    types(svc, id).filter((t) => t.startsWith("Deployment"));
  /** デプロイの確認の答え（PBI-116 の形）。ci は通った、deployment は result の結果。 */
  const answer = (
    result: string,
    rest: Record<string, unknown> = {},
    ci: Record<string, unknown> = { result: "passed", summary: "CI は通っている" },
  ) => ({ ci, deployment: { result, summary: "アプリの確認" }, ...rest });
  const checkOut = (v: Record<string, unknown>, output = 1000): AgentOutcome => ({
    kind: "completed",
    output: `確かめました\n\n\`\`\`json\n${JSON.stringify({ "sacty-deployment": v })}\n\`\`\``,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
  });

  const fenced = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const implemented: AgentOutcome = {
    kind: "completed",
    output: `# 実装\n\n${fenced({ "sacty-test-map": [{ viewpointId: "REQ", tests: ["pay.test.ts"] }] })}`,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  };
  const passedReview: AgentOutcome = {
    kind: "completed",
    output: fenced({
      "sacty-final-review": {
        viewpoints: [{ id: "REQ", verified: true, reason: "通る" }],
        remarks: [],
        summary: "所見",
      },
    }),
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
  };

  function setup(
    options: {
      projects?: MemoryProjectStore;
      outcomes?: (AgentOutcome | typeof HOLD)[];
      ci?: FakeCi;
      repos?: FakeRepos;
      config?: () => ConfigResult;
      activity?: SqliteActivityStore;
      pulls?: FakePulls;
      plannerCost?: number;
      templates?: ServiceDeps["templates"];
      /** 起点のコミットに、デプロイの確認のスキルを置くか（PBI-116。既定は置く）。 */
      skill?: boolean;
      /** オーケストレーターが選ぶ工程（既定は実装とマージの後の監視）。 */
      steps?: StepKey[];
    } = {},
  ) {
    const activity = options.activity ?? new SqliteActivityStore(dbPath);
    const ci = options.ci ?? new FakeCi();
    const repos = options.repos ?? new FakeRepos();
    if (options.skill !== false) {
      repos.files[BASE] = { ...repos.files[BASE], [SKILL]: "# deployment-observer" };
    }
    const clock = { offset: 0 };
    const made = makeService(activity, options.outcomes as AgentOutcome[], {
      projects: options.projects ?? watchedProjects(),
      ci,
      now: () => Date.now() + clock.offset,
      repos,
      ...(options.config ? { config: options.config } : {}),
      ...(options.pulls ? { pulls: options.pulls } : {}),
      ...(options.templates ? { templates: options.templates } : {}),
      planner: async () => ({
        steps: options.steps ?? ["implement", "deployment"],
        fallback: false,
        testCommand: "npm test",
        costUsd: options.plannerCost ?? 0,
        estimated: false,
      }),
    });
    // 実装の工程（PBI-110。PR は実装の工程の中で作る）は、どのタスクでも、実装と最終レビューに通るように答える
    // （outcomes は、マージの後のデプロイの確認の答えに使う）
    made.executor.respond = (invocation) => {
      const prompt = invocation.command.join(" ");
      if (prompt.includes("実装を最終レビューしてください")) return passedReview;
      if (prompt.includes("sacty-test-map")) return implemented;
      return undefined;
    };
    /** タスクを PR の承認待ちまで進め、PR をマージして確かめる。 */
    const merge = async (id: string, mergeCommit: string | null = MERGE) => {
      for (let i = 0; i < 5 && made.service.get(id)?.task.gate?.step !== "implement"; i++) {
        await made.service.runNext(id);
      }
      const pr = made.service.get(id)?.task.pullRequest;
      expect(pr?.number).toBeDefined();
      made.pulls.states[pr?.number ?? 0] = {
        state: "merged",
        mergedBy: "reviewer",
        ...(pr?.commit ? { headSha: pr.commit } : {}),
        ...(mergeCommit ? { mergeCommit } : {}),
      };
      await made.service.checkPullRequests();
      // すべて終わった CI/CD は、次の確認でも同じなら結果を決める
      await made.service.checkPullRequests();
    };
    const create = (title = "決済API") =>
      made.service.createTask({ projectId: "default", title, body: "本文" }).id;
    return { ...made, activity, ci, clock, merge, create };
  }

  it("起点のコミットにスキルが無ければ、工程を飛ばし（理由を残す）、マージの後に何も記録せず、CI/CD も読まない（PBI-116）", async () => {
    const t = setup({ skill: false });
    const id = t.create();
    await t.service.runNext(id);
    const chosen = t.service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.deployment).toEqual({
      skipped: { code: "deploy.stepSkipped", params: { detail: { code: "deploy.noSkill" } } },
    });
    expect(t.service.get(id)?.task.steps).toEqual([
      { key: "implement", state: "active" },
      { key: "deployment", state: "skip" },
    ]);
    // スキルは起点のコミットで探す
    expect(t.repos.readCalls.map((c) => c.commit)).toEqual([BASE, BASE]);
    await t.merge(id);
    const task = t.service.get(id)?.task as Task;
    expect(isCompleted(task)).toBe(true);
    expect(isFinished(task)).toBe(true);
    expect(deploymentTypes(t.service, id)).toEqual([]);
    expect(task.deployment).toBeUndefined();
    expect(t.ci.calls).toEqual([]);
    t.activity.close();
  });

  it("起点のコミットにスキルがあれば、工程に入れ、そのパスを残す（PBI-116）", async () => {
    const t = setup();
    const id = t.create();
    await t.service.runNext(id);
    const chosen = t.service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.deployment).toEqual({ skill: SKILL });
    expect(t.service.get(id)?.task.steps.map((s) => s.state)).toEqual(["active", "todo"]);
    expect(t.service.get(id)?.task.deploymentChoice).toEqual({ skill: SKILL });
    t.activity.close();
  });

  it("スキルを探せない（リポジトリの外を指す・読めない・git の失敗）なら、理由を付けて工程を飛ばす（PBI-116）", async () => {
    const repos = new FakeRepos();
    repos.links[BASE] = { ".agents/skills/deployment-observer": "../../../../etc" };
    const t = setup({ skill: false, repos });
    const id = t.create();
    await t.service.runNext(id);
    expect(t.service.get(id)?.task.deploymentChoice).toEqual({
      skipped: {
        code: "deploy.stepSkipped",
        params: {
          detail: {
            code: "deploy.skillOutside",
            params: { path: ".agents/skills/deployment-observer/SKILL.md" },
          },
        },
      },
    });
    t.activity.close();
    rmSync(dbPath, { force: true });
    const broken = new FakeRepos();
    broken.readLink = async () => {
      throw new Error("git が無い");
    };
    const u = setup({ skill: false, repos: broken });
    const other = u.create();
    await u.service.runNext(other);
    expect(u.service.get(other)?.task.deploymentChoice).toEqual({
      skipped: {
        code: "deploy.stepSkipped",
        params: { detail: { code: "deploy.skillLookupFailed", params: { detail: "git が無い" } } },
      },
    });
    expect(u.service.get(other)?.task.steps.at(-1)).toEqual({ key: "deployment", state: "skip" });
    u.activity.close();
  });

  it("工程を決めた後に実装の PR がスキルを足しても、このタスクでは見ない（PBI-116）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# deployment-observer" };
    const ci = new FakeCi();
    ci.snap = success();
    const t = setup({ skill: false, repos, ci });
    const id = t.create();
    await t.merge(id);
    expect(isFinished(t.service.get(id)?.task as Task)).toBe(true);
    expect(deploymentTypes(t.service, id)).toEqual([]);
    expect(ci.calls).toEqual([]);
    t.activity.close();
  });

  it("実装の PR のマージで、マージのコミットの CI/CD を待ち、通っても実装の PR がスキルを消していれば、デプロイの確認を飛ばして通ったにする", async () => {
    const ci = new FakeCi();
    ci.snap = {
      checks: [{ kind: "workflow", name: "CI", status: "pending" }],
      failedRuns: [],
    };
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    const started = t.service.get(id)?.activity.find((e) => e.type === "DeploymentWatchStarted");
    expect(started?.payload).toEqual({
      number: 7,
      repo: "https://github.com/acme/app",
      branch: "main",
      commit: MERGE,
    });
    // 監視の開始は、マージの記録と同じ追記（同じ時刻）
    const mergedAt = t.service.get(id)?.activity.find((e) => e.type === "PullRequestMerged")?.at;
    expect(started?.at).toBe(mergedAt);
    expect(ci.calls[0]).toEqual({
      repo: "https://github.com/acme/app",
      token: "ghp_secret",
      commit: MERGE,
    });
    expect(t.service.get(id)?.task.deployment).toMatchObject({ state: "waiting", phase: "ci" });
    // 監視の間は、タスクを完了にしない（終わっていないタスク。PBI-116）
    const waiting = t.service.get(id)?.task as Task;
    expect(waiting.status).toBe("idle");
    expect(activeStep(waiting)).toBe("deployment");
    expect(isCompleted(waiting)).toBe(false);
    expect(isFinished(waiting)).toBe(false);

    ci.snap = success();
    await t.service.checkPullRequests();
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment).toMatchObject({
      state: "passed",
      reason: "no_skill",
      detail: { code: "deploy.skillMissing" },
    });
    // スキルはマージのコミットから探す
    expect(t.repos.fetchedCommits.at(-1)?.commits).toEqual([MERGE]);
    expect(
      t.repos.readCalls.filter((c) => c.commit === MERGE).map((c) => [c.commit, c.path]),
    ).toEqual([
      [MERGE, ".agents/skills/deployment-observer/SKILL.md"],
      [MERGE, ".claude/skills/deployment-observer/SKILL.md"],
    ]);
    // 監視が終わったら、工程を終えてタスクを完了にする
    const done = t.service.get(id)?.task as Task;
    expect(done.steps.at(-1)).toEqual({ key: "deployment", state: "done" });
    expect(isFinished(done)).toBe(true);
    // 終わった監視は、もう確かめない。エージェントも実行しない
    const calls = ci.calls.length;
    await t.service.checkPullRequests();
    expect(ci.calls).toHaveLength(calls);
    expect(t.service.queuedTaskIds()).toEqual([]);
    // 実行したのは、マージの前の実装と最終レビューだけ
    expect(t.executor.calls).toHaveLength(2);
    t.activity.close();
  });

  it("すべて終わっても、次の確認で同じになるまで決めない（後から別のワークフローが現れるのを待つ）", async () => {
    const ci = new FakeCi();
    ci.snap = { checks: [{ kind: "workflow", name: "CI", status: "pending" }], failedRuns: [] };
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    ci.snap = success();
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment?.state).toBe("waiting");
    // CI の後に、デプロイのワークフローが現れて失敗した
    ci.snap = {
      checks: [
        ...success().checks,
        { kind: "workflow", name: "Deploy", status: "completed", conclusion: "failure" },
      ],
      failedRuns: [{ id: 2, name: "Deploy", conclusion: "failure" }],
    };
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment?.state).toBe("waiting");
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment).toMatchObject({
      state: "failed",
      ci: { failures: [{ workflow: "Deploy", conclusion: "failure" }] },
    });
    t.activity.close();
  });

  it("CI/CD が1つも無いまま5分たったら、CI/CD が無いとして飛ばす（それまでは待つ）", async () => {
    const t = setup();
    const id = t.create();
    await t.merge(id);
    t.clock.offset = DEPLOYMENT_CI_GRACE_MS - 10_000;
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment?.state).toBe("waiting");
    t.clock.offset = DEPLOYMENT_CI_GRACE_MS + 1_000;
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment).toMatchObject({ state: "skipped", reason: "no_ci" });
    expect(t.service.get(id)?.activity.at(-1)?.payload).toMatchObject({ result: "none" });
    t.activity.close();
  });

  it("マージのコミットが取れなければ、監視を飛ばす（理由を残す）", async () => {
    const t = setup();
    const id = t.create();
    await t.merge(id, null);
    expect(t.service.get(id)?.task.deployment).toMatchObject({
      state: "skipped",
      reason: "no_commit",
    });
    expect(t.ci.calls).toEqual([]);
    t.activity.close();
  });

  it("CI/CD が終わらなければ、監視を始めてから60分で時間切れ。デーモンを再起動しても待ちは続き、上限は延びない", async () => {
    const ci = new FakeCi();
    ci.snap = { checks: [{ kind: "workflow", name: "CI", status: "pending" }], failedRuns: [] };
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    // 再起動（作業履歴から作り直す）。待ちはそのまま
    const again = setup({ ci, activity: t.activity });
    again.service.recoverInterrupted();
    expect(again.service.get(id)?.task.deployment).toMatchObject({ state: "waiting", phase: "ci" });
    again.clock.offset = DEPLOYMENT_CI_TIMEOUT_MS - 60_000;
    await again.service.checkPullRequests();
    expect(again.service.get(id)?.task.deployment?.state).toBe("waiting");
    // 読めない（ネットワークなど）ときも、上限を過ぎれば時間切れ
    ci.snap = new Error("network");
    again.clock.offset = DEPLOYMENT_CI_TIMEOUT_MS + 1_000;
    await again.service.checkPullRequests();
    expect(again.service.get(id)?.task.deployment).toMatchObject({ state: "timed_out" });
    // 時間切れでは、修正のタスクを作らない
    expect(again.service.list()).toHaveLength(1);
    t.activity.close();
  });

  it("CI/CD が失敗したら、リンクとログの抜粋を入れた修正のタスクを登録し、元のタスクとたどれるようにする", async () => {
    const ci = new FakeCi();
    ci.snap = failing();
    ci.failuresList = [testFailure];
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    const task = t.service.get(id)?.task;
    expect(task?.deployment?.state).toBe("failed");
    expect(task?.deployment?.ci?.failures).toEqual([testFailure]);
    // ログの抜粋を伏せるため、使ったトークンを渡す
    expect(ci.failureCalls[0]?.secrets).toContain("ghp_secret");
    const fixId = task?.deployment?.fix?.taskId ?? "";
    const fix = t.service.get(fixId)?.task;
    expect(fix).toMatchObject({
      start: "deployment",
      repo: "https://github.com/acme/app",
      status: "queued",
      fix: { taskId: id, kind: "ci", depth: 1 },
    });
    expect(fix?.title).toBe(`CI/CD の失敗を直す：CI / test（${MERGE.slice(0, 7)}）`);
    for (const part of [
      `sacty のタスク ${id}`,
      "https://github.com/acme/app/pull/7",
      `https://github.com/acme/app/commit/${MERGE}`,
      "### CI / test（failure）",
      "https://github.com/acme/app/actions/runs/1/job/7",
      "FAIL pay.test.ts",
    ]) {
      expect(fix?.body).toContain(part);
    }
    expect(JSON.stringify(t.service.get(fixId)?.activity)).not.toContain("ghp_secret");
    expect(deploymentTypes(t.service, id)).toEqual([
      "DeploymentWatchStarted",
      "DeploymentCiFinished",
      "DeploymentFixRegistered",
    ]);
    // 次の確認でも、二重に登録しない
    await t.service.checkPullRequests();
    expect(t.service.list()).toHaveLength(2);
    t.activity.close();
  });

  it("同じ失敗の修正のタスクが終わっていなければ作らない。修正のタスクのマージでも監視し、連鎖は3段で止める", async () => {
    const ci = new FakeCi();
    ci.snap = failing();
    ci.failuresList = [testFailure];
    const t = setup({ ci });
    const first = t.create("一つ目");
    await t.merge(first);
    const f1 = t.service.get(first)?.task.deployment?.fix?.taskId ?? "";
    // 別のタスクが、同じ失敗のままマージされた
    const second = t.create("二つ目");
    await t.merge(second);
    expect(t.service.get(second)?.task.deployment?.suppressed).toMatchObject({
      reason: "duplicate",
      existing: f1,
    });
    expect(t.service.list().filter((x) => x.fix)).toHaveLength(1);

    // 修正のタスクをマージしても、同じ失敗が続く。修正のタスクから次の修正のタスク（段数 +1）を作る
    let current = f1;
    for (const depth of [2, 3]) {
      await t.merge(current);
      const next = t.service.get(current)?.task.deployment?.fix?.taskId ?? "";
      expect(t.service.get(next)?.task.fix).toMatchObject({ taskId: current, depth });
      current = next;
    }
    // 3段目の修正のタスクのマージでも失敗したら、もう作らない
    await t.merge(current);
    expect(t.service.get(current)?.task.deployment).toMatchObject({
      state: "failed",
      suppressed: { reason: "chain_limit" },
    });
    expect(t.service.get(current)?.task.deployment?.fix).toBeUndefined();
    expect(t.service.list().filter((x) => x.fix)).toHaveLength(MAX_FIX_CHAIN);
    t.activity.close();
  });

  it("修正のタスクを登録した後、作る前にデーモンが止まっても、次の確認で作る", async () => {
    const ci = new FakeCi();
    ci.snap = failing();
    ci.failuresList = [testFailure];
    const t = setup({ ci });
    const id = t.create();
    // 監視を始め、CI/CD の失敗の結果と登録だけを書いた（作る前に止まった）
    await t.merge(id, MERGE);
    const fixId = t.service.get(id)?.task.deployment?.fix?.taskId ?? "";
    expect(fixId).not.toBe("");
    // 作った記録を除いた作業履歴で作り直す
    const kept = t.activity.all().filter((e) => e.taskId !== fixId);
    rmSync(join(dir, "copy.db"), { force: true });
    const copy = new SqliteActivityStore(join(dir, "copy.db"));
    for (const e of kept) {
      copy.append({
        taskId: e.taskId,
        projectId: e.projectId,
        events: [{ actor: e.actor, event: { type: e.type, payload: e.payload } as EventInput }],
      });
    }
    const again = setup({ ci, activity: copy });
    expect(again.service.get(fixId)).toBeUndefined();
    await again.service.checkPullRequests();
    expect(again.service.get(fixId)?.task.fix).toMatchObject({ taskId: id, depth: 1 });
    copy.close();
    t.activity.close();
  });

  it("CI/CD が通り、スキルがあれば、マージのコミットの写しでエージェントに確かめさせ、費用をタスクの予算に入れる", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# deployment-observer" };
    const ci = new FakeCi();
    ci.snap = success();
    const t = setup({
      ci,
      repos,
      outcomes: [
        checkOut(answer("healthy", { summary: "200 を返す", evidence: ["GET /health → 200"] })),
      ],
    });
    const id = t.create();
    await t.merge(id);
    expect(t.service.get(id)?.task.deployment).toMatchObject({
      state: "waiting",
      phase: "check",
      ci: { result: "passed", skill: SKILL },
    });
    expect(t.service.queuedTaskIds()).toEqual([id]);
    // 確認の間も、タスクは終わっていない
    expect(isFinished(t.service.get(id)?.task as Task)).toBe(false);
    await t.service.runNext(id);
    const task = t.service.get(id)?.task;
    expect(task?.deployment).toMatchObject({
      state: "passed",
      check: {
        result: "healthy",
        ci: { result: "passed" },
        deployment: { result: "healthy" },
        summary: "200 を返す",
        evidence: ["GET /health → 200"],
      },
    });
    expect(isFinished(task as Task)).toBe(true);
    // マージのコミットのコードの写しを作業領域にし、スキルの場所を伝える
    expect(repos.snapshots.at(-1)?.baseCommit).toBe(MERGE);
    expect(t.executor.scratch.at(-1)).toBe(false);
    expect(t.executor.dirs.at(-1)).toContain("_deployment");
    const prompt = t.executor.calls.at(-1)?.command.join(" ") ?? "";
    expect(prompt).toContain(SKILL);
    expect(prompt).toContain(MERGE);
    // sacty が待って判定した CI/CD の結果をデータとして渡し、範囲はスキルに任せ、長く待たせない（PBI-116）
    expect(prompt).toContain(
      '[{"kind":"workflow","name":"CI","status":"completed","conclusion":"success"}]',
    );
    expect(prompt).toContain("どう確かめるかは、スキルに従います");
    expect(prompt).toContain("CI/CD やデプロイが終わるのを長く待たない");
    // 1000 出力トークン = $0.015 を予算に入れる
    expect(task?.budget.usedUsd).toBeCloseTo(0.015, 6);
    expect(t.service.get(id)?.activity.at(-1)).toMatchObject({
      type: "DeploymentChecked",
      actor: "agent",
      payload: { costUsd: 0.015, runResult: "completed", agentId: "claude-subscription" },
    });
    expect(t.service.queuedTaskIds()).toEqual([]);
    t.activity.close();
  });

  it("デプロイ後のアプリがエラーなら、結果と根拠を入れた修正のタスクを登録する。判断できなければ飛ばす（作らない）", async () => {
    for (const [result, state] of [
      ["unhealthy", "failed"],
      ["unknown", "skipped"],
    ] as const) {
      rmSync(dbPath, { force: true });
      const repos = new FakeRepos();
      repos.files[MERGE] = { [SKILL]: "# skill" };
      const ci = new FakeCi();
      ci.snap = success();
      const t = setup({
        ci,
        repos,
        outcomes: [
          checkOut(
            answer(result, { summary: "500 を返す", evidence: ["GET /pay → 500", "ログに NPE"] }),
          ),
        ],
      });
      const id = t.create();
      await t.merge(id);
      await t.service.runNext(id);
      const watch = t.service.get(id)?.task.deployment;
      expect(watch?.state).toBe(state);
      if (result === "unhealthy") {
        const fix = t.service.get(watch?.fix?.taskId ?? "")?.task;
        expect(fix?.fix).toMatchObject({ taskId: id, kind: "deployment", depth: 1 });
        expect(fix?.body).toContain("500 を返す");
        expect(fix?.body).toContain("- GET /pay → 500");
        expect(fix?.body).toContain(SKILL);
      } else {
        expect(watch).toMatchObject({ reason: "check_unknown" });
        expect(watch?.fix).toBeUndefined();
        expect(t.service.list()).toHaveLength(1);
      }
      // 失敗しても、元のタスクは止めずに完了にする（修正のタスクに引き継ぐ。PBI-116）
      expect(isFinished(t.service.get(id)?.task as Task)).toBe(true);
      t.activity.close();
    }
  });

  it("答えを読めない・実行に失敗したら、確かめられなかったとして飛ばし、使った費用は記録する", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    const t = setup({
      ci,
      repos,
      outcomes: [
        {
          kind: "completed",
          output: "結論を書き忘れた",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 2000 },
        },
      ],
    });
    const id = t.create();
    await t.merge(id);
    await t.service.runNext(id);
    expect(t.service.get(id)?.task.deployment).toMatchObject({
      state: "skipped",
      reason: "check_unknown",
      detail: { code: "deploy.unreadable" },
    });
    expect(t.service.get(id)?.task.budget.usedUsd).toBeCloseTo(0.03, 6);
    t.activity.close();
  });

  it("予算の上限に達していたら、デプロイの確認を実行せずに飛ばす（タスクは止めない）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    // 予算の上限（1 米ドル）は、最終レビューの費用で超える（PR は、実装の工程の中で予算に関わらず作る。PBI-110）
    const t = setup({ ci, repos, plannerCost: 0.99 });
    const respond = t.executor.respond;
    t.executor.respond = (invocation) => {
      const outcome = respond?.(invocation);
      return outcome === passedReview
        ? { ...passedReview, usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10_000 } }
        : outcome;
    };
    const id = t.create();
    await t.merge(id);
    expect(t.service.get(id)?.task.budget.usedUsd).toBeGreaterThanOrEqual(1);
    await t.service.runNext(id);
    const task = t.service.get(id)?.task;
    expect(task?.deployment).toMatchObject({
      state: "skipped",
      reason: "budget",
      detail: { code: "deploy.budgetExceeded" },
    });
    expect(task?.status).toBe("idle");
    // デプロイの確認のエージェントは実行しない（実行したのは、マージの前の実装と最終レビューだけ）
    expect(t.executor.calls).toHaveLength(2);
    t.activity.close();
  });

  it("確認の途中でデーモンが止まったら、ほかの工程と同じく中断として一時停止し、再開すると確かめ直す（PBI-116）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    const t = setup({ ci, repos, outcomes: [HOLD] });
    const id = t.create();
    await t.merge(id);
    void t.service.runNext(id);
    await t.executor.started.promise;
    expect(t.service.get(id)?.task.deployment?.check?.result).toBeUndefined();
    // 再起動
    const again = setup({
      ci,
      repos,
      activity: t.activity,
      outcomes: [checkOut(answer("healthy"))],
    });
    again.service.recoverInterrupted();
    const paused = again.service.get(id)?.task as Task;
    expect(paused).toMatchObject({
      status: "paused",
      pausedReason: "error",
      pausedMessage: { code: "run.daemonStopped" },
    });
    expect(paused.deployment).toMatchObject({ state: "waiting", phase: "check" });
    expect(paused.deployment?.check).toBeUndefined();
    expect(
      again.service.get(id)?.activity.find((e) => e.type === "DeploymentChecked")?.payload,
    ).toMatchObject({ result: "unknown", retry: true, runResult: "interrupted" });
    expect(again.service.queuedTaskIds()).toEqual([]);
    again.service.resume(id, {});
    expect(again.service.queuedTaskIds()).toEqual([id]);
    await again.service.runNext(id);
    const done = again.service.get(id)?.task as Task;
    expect(done.deployment).toMatchObject({ state: "passed", check: { result: "healthy" } });
    expect(isFinished(done)).toBe(true);
    t.activity.close();
  });

  it("工程の無い以前のタスクの監視（古い台帳）も読め、これまでどおり完了したタスクのまま見届ける。確認の途中で止まったら中断として飛ばす", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    // 以前の版のタスク：工程は実装だけで、完了した後に、マージの記録と同じく監視を始めた
    const t = setup({ ci, repos, steps: ["implement"], skill: false, outcomes: [HOLD] });
    const id = t.create();
    await t.merge(id);
    expect(deploymentTypes(t.service, id)).toEqual([]);
    t.activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "DeploymentWatchStarted",
            payload: {
              number: 7,
              repo: "https://github.com/acme/app",
              branch: "main",
              commit: MERGE,
            },
          },
        },
      ],
    });
    // 読み直す（再起動）
    const again = setup({
      ci,
      repos,
      activity: t.activity,
      steps: ["implement"],
      outcomes: [HOLD],
    });
    expect(again.service.get(id)?.task.deployment).toMatchObject({ state: "waiting", phase: "ci" });
    expect(isCompleted(again.service.get(id)?.task as Task)).toBe(true);
    await again.service.checkPullRequests();
    await again.service.checkPullRequests();
    expect(again.service.get(id)?.task.deployment).toMatchObject({
      state: "waiting",
      phase: "check",
      ci: { skill: SKILL },
    });
    void again.service.runNext(id);
    await again.executor.started.promise;
    const third = setup({ ci, repos, activity: t.activity, steps: ["implement"] });
    third.service.recoverInterrupted();
    const task = third.service.get(id)?.task as Task;
    expect(task.deployment).toMatchObject({
      state: "skipped",
      reason: "check_unknown",
      check: { result: "unknown", failed: { code: "run.daemonStopped" } },
    });
    // 以前のタスクは止めず、工程も変えない
    expect(task.status).toBe("idle");
    expect(task.steps).toEqual([{ key: "implement", state: "done" }]);
    t.activity.close();
  });

  it("スキルのリンクがリポジトリの外を指せば使わず、理由を残す。中を指せばたどった先を使う", async () => {
    for (const [target, expected] of [
      ["../../../../etc", undefined],
      ["../../.claude/skills/real", ".claude/skills/real/SKILL.md"],
    ] as const) {
      rmSync(dbPath, { force: true });
      const repos = new FakeRepos();
      repos.links[MERGE] = { ".agents/skills/deployment-observer": target };
      repos.files[MERGE] = { ".claude/skills/real/SKILL.md": "# skill" };
      const ci = new FakeCi();
      ci.snap = success();
      const t = setup({ ci, repos });
      const id = t.create();
      await t.merge(id);
      const watch = t.service.get(id)?.task.deployment;
      if (expected) {
        expect(watch?.ci?.skill).toBe(expected);
      } else {
        expect(watch).toMatchObject({
          state: "passed",
          reason: "no_skill",
          detail: {
            code: "deploy.skillOutside",
            params: { path: ".agents/skills/deployment-observer/SKILL.md" },
          },
        });
      }
      t.activity.close();
    }
  });

  it("修正のタスクの PR にもレビュー用のラベルを付け、レビューだけのタスクとして取り込める。そのマージでも監視する（PBI-88 と両立）", async () => {
    const ci = new FakeCi();
    ci.snap = failing();
    ci.failuresList = [testFailure];
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    // 元のタスクの実装の PR にもラベルを付けている
    expect(t.pulls.labels.map((l) => l.number)).toEqual([7]);
    const fixId = t.service.get(id)?.task.deployment?.fix?.taskId ?? "";
    for (let i = 0; i < 5 && t.service.get(fixId)?.task.gate?.step !== "implement"; i++) {
      await t.service.runNext(fixId);
    }
    const pr = t.service.get(fixId)?.task.pullRequest;
    expect(pr).toMatchObject({ number: 8, label: "sacty-review" });
    expect(t.pulls.labels.map((l) => [l.number, l.label])).toEqual([
      [7, "sacty-review"],
      [8, "sacty-review"],
    ]);
    // ラベルの付いた修正のタスクの PR は、レビューだけのタスクとして取り込む
    const [review] = t.service.importIssues([
      {
        repo: "https://github.com/acme/app",
        number: 8,
        title: "CI/CD の失敗を直す",
        body: "",
        url: "https://github.com/acme/app/pull/8",
        labels: ["sacty-review"],
        pullRequest: true,
      },
    ]);
    expect(review?.source).toMatchObject({ kind: "github_pull_request", number: 8 });
    expect(review?.source?.review).toBe("sacty");
    // 修正のタスクの PR のマージでも監視を始める（レビューのタスクは監視しない）
    await t.merge(fixId);
    expect(t.service.get(fixId)?.task.deployment?.state).toBe("failed");
    expect(t.service.get(review?.id ?? "")?.task.deployment).toBeUndefined();
    t.activity.close();
  });

  it("修正のタスクの PR の本文も、PR テンプレートに沿って書く（PBI-87 と両立）", async () => {
    const ci = new FakeCi();
    ci.snap = failing();
    ci.failuresList = [testFailure];
    const lookups: { repo: string }[] = [];
    const t = setup({
      ci,
      templates: {
        find: async (input) => {
          lookups.push({ repo: input.repo });
          return {
            kind: "found",
            template: {
              repo: "https://github.com/acme/app",
              path: ".github/pull_request_template.md",
              text: "## 概要\n\n## テスト\n- [x] 確かめた\n",
            },
          };
        },
      },
    });
    const id = t.create();
    await t.merge(id);
    const fixId = t.service.get(id)?.task.deployment?.fix?.taskId ?? "";
    for (let i = 0; i < 5 && t.service.get(fixId)?.task.gate?.step !== "implement"; i++) {
      await t.service.runNext(fixId);
    }
    const fix = t.service.get(fixId)?.task;
    expect(fix?.pullRequest).toMatchObject({
      number: 8,
      label: "sacty-review",
      template: { repo: "https://github.com/acme/app", path: ".github/pull_request_template.md" },
    });
    const body = t.pulls.calls.find((c) => c.title === fix?.title)?.body ?? "";
    expect(body).toMatch(/^## 概要\n/);
    expect(body).toContain("## テスト\n\n");
    expect(body).toContain("- [ ] 確かめた");
    expect(body).not.toContain("[x]");
    expect(body).toContain(`sacty task ${fixId}`);
    expect(lookups).toHaveLength(2);
    t.activity.close();
  });

  it("元のタスクを中止したら、監視をやめる", async () => {
    const ci = new FakeCi();
    ci.snap = { checks: [{ kind: "workflow", name: "CI", status: "pending" }], failedRuns: [] };
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    await t.service.cancel(id);
    const calls = ci.calls.length;
    ci.snap = failing();
    await t.service.checkPullRequests();
    expect(ci.calls).toHaveLength(calls);
    expect(t.service.list()).toHaveLength(1);
    t.activity.close();
  });

  it("スキルが CI/CD の確認だけを指すときは、デプロイの確認をしないで終わる（飛ばした理由を残す。PBI-116）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# CI/CD だけ" };
    const ci = new FakeCi();
    ci.snap = success();
    const t = setup({
      ci,
      repos,
      outcomes: [
        checkOut({
          ci: { result: "passed", summary: "必要なワークフローはすべて通った" },
          deployment: { result: "skipped", reason: "このリポジトリはデプロイしていない" },
          summary: "CI/CD だけ確かめた",
          evidence: ["CI: success"],
        }),
      ],
    });
    const id = t.create();
    await t.merge(id);
    await t.service.runNext(id);
    const task = t.service.get(id)?.task as Task;
    expect(task.deployment).toMatchObject({
      state: "passed",
      check: {
        result: "healthy",
        ci: { result: "passed" },
        deployment: { result: "skipped", reason: "このリポジトリはデプロイしていない" },
      },
    });
    expect(task.deployment?.fix).toBeUndefined();
    expect(isFinished(task)).toBe(true);
    expect(t.service.list()).toHaveLength(1);
    t.activity.close();
  });

  it("スキルに従った CI/CD の確認で失敗を見つけたら、修正のタスクを登録する（PBI-116）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    const t = setup({
      ci,
      repos,
      outcomes: [
        checkOut(
          answer(
            "skipped",
            { summary: "デプロイのワークフローが動いていない" },
            { result: "failed", summary: "Deploy のワークフローが実行されていない" },
          ),
        ),
      ],
    });
    const id = t.create();
    await t.merge(id);
    await t.service.runNext(id);
    const watch = t.service.get(id)?.task.deployment;
    expect(watch).toMatchObject({ state: "failed", check: { result: "unhealthy" } });
    const fix = t.service.get(watch?.fix?.taskId ?? "")?.task;
    expect(fix?.title).toBe(
      `マージの後の確認で見つけた CI/CD の失敗を直す（${MERGE.slice(0, 7)}）`,
    );
    expect(fix?.body).toContain(
      "- CI/CD の確認：failed（Deploy のワークフローが実行されていない）",
    );
    expect(isFinished(t.service.get(id)?.task as Task)).toBe(true);
    t.activity.close();
  });

  it("CI/CD を待つ間に一時停止すると CI/CD を見ず、再開すると続ける（PBI-116）", async () => {
    const ci = new FakeCi();
    ci.snap = { checks: [{ kind: "workflow", name: "CI", status: "pending" }], failedRuns: [] };
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    await t.service.pause(id);
    expect(t.service.get(id)?.task).toMatchObject({ status: "paused", pausedReason: "manual" });
    const calls = ci.calls.length;
    ci.snap = success();
    await t.service.checkPullRequests();
    await t.service.checkPullRequests();
    expect(ci.calls).toHaveLength(calls);
    expect(t.service.get(id)?.task.deployment?.state).toBe("waiting");
    t.service.resume(id, {});
    expect(t.service.get(id)?.task.status).toBe("idle");
    await t.service.checkPullRequests();
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment?.state).toBe("passed");
    expect(isFinished(t.service.get(id)?.task as Task)).toBe(true);
    t.activity.close();
  });

  it("確認の途中で一時停止すると、確認を結果にせずに止め、再開すると確かめ直す（PBI-116）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    const t = setup({ ci, repos, outcomes: [HOLD, checkOut(answer("healthy"))] });
    const id = t.create();
    await t.merge(id);
    const run = t.service.runNext(id);
    await t.executor.started.promise;
    await t.service.pause(id);
    await run;
    const paused = t.service.get(id)?.task as Task;
    expect(paused).toMatchObject({ status: "paused", pausedReason: "manual" });
    expect(paused.deployment).toMatchObject({ state: "waiting", phase: "check" });
    expect(paused.deployment?.check).toBeUndefined();
    expect(t.service.queuedTaskIds()).toEqual([]);
    t.service.resume(id, {});
    expect(t.service.queuedTaskIds()).toEqual([id]);
    await t.service.runNext(id);
    expect(t.service.get(id)?.task.deployment).toMatchObject({
      state: "passed",
      check: { result: "healthy" },
    });
    expect(
      t.service
        .get(id)
        ?.activity.filter((e) => e.type === "DeploymentChecked")
        .map((e) => e.type === "DeploymentChecked" && [e.payload.result, e.payload.retry]),
    ).toEqual([
      ["unknown", true],
      ["healthy", undefined],
    ]);
    t.activity.close();
  });

  it("監視の間に中止すると、マージした実装の PR は閉じずに、監視をやめる（PBI-116）", async () => {
    const ci = new FakeCi();
    ci.snap = { checks: [{ kind: "workflow", name: "CI", status: "pending" }], failedRuns: [] };
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    const cancelled = await t.service.cancel(id);
    expect(t.pulls.closed).toEqual([]);
    expect(cancelled.cancelled?.cleanup).toContainEqual({
      target: "pull_request",
      result: "skipped",
    });
    t.activity.close();
  });

  it("マージの後の監視の工程は、ほかの工程と同じく、工程のイメージで確かめる（PBI-116）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    const base = configOf(agent())() as { ok: true; config: SactyConfig };
    const config = (): ConfigResult => ({
      ok: true,
      config: {
        ...base.config,
        images: {
          java: { name: "java", image: "sacty-agent-java:test", description: "Java", env: {} },
          web: { name: "web", image: "sacty-agent-web:test", description: "ブラウザ", env: {} },
        },
      },
    });
    const t = setup({ ci, repos, config, outcomes: [checkOut(answer("healthy"))] });
    const id = t.create();
    await t.service.runNext(id);
    t.service.changeStepImage(id, { step: "implement", image: "java" });
    t.service.changeStepImage(id, { step: "deployment", image: "web" });
    await t.merge(id);
    await t.service.runNext(id);
    expect(t.executor.images.at(-1)?.image).toBe("sacty-agent-web:test");
    t.activity.close();
  });

  it("以前のデータでプロジェクトに deploymentWatch があっても読まず、スキルの有無だけで決める（PBI-116）", async () => {
    const projects = new MemoryProjectStore();
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      deploymentWatch: true,
    } as ProjectDefinition);
    const t = setup({ projects, skill: false });
    const id = t.create();
    await t.merge(id);
    expect(deploymentTypes(t.service, id)).toEqual([]);
    expect(isFinished(t.service.get(id)?.task as Task)).toBe(true);
    t.activity.close();
  });
});

describe("テストの仕組みが無いリポジトリ（PBI-94）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const NO_TESTS = "README.md だけで、テストのコード・設定・CI が無い";
  const plan = (extra: Record<string, unknown> = {}, value = "skip-design") =>
    out(block({ "sacty-steps": { plan: value, reason: "小さい", noTests: NO_TESTS, ...extra } }));
  const review = (verified = true) =>
    out(
      block({
        "sacty-final-review": {
          viewpoints: [{ id: "REQ", verified, reason: verified ? "目的を満たす" : "足りない" }],
          remarks: [],
          summary: verified ? "目的から見て受け入れられる" : "受け入れられない",
        },
      }),
    );
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const typesOf = (service: TaskService, id: string) =>
    service.get(id)?.activity.map((e) => e.type) ?? [];
  const taskOf = (service: TaskService, id: string) => service.get(id)?.task as Task;

  /** clone した作業領域に、ファイルを置く偽のリポジトリ（起点のコード）。 */
  class FilesRepos extends FakeRepos {
    constructor(private readonly files: Record<string, string>) {
      super();
    }
    override async prepare(...args: Parameters<FakeRepos["prepare"]>) {
      const result = await super.prepare(...args);
      for (const [path, content] of Object.entries(this.files)) {
        mkdirSync(dirname(join(args[0], path)), { recursive: true });
        writeFileSync(join(args[0], path), content);
      }
      return result;
    }
  }

  async function drain(service: TaskService, max = 12) {
    for (let i = 0; i < max; i++) {
      const ids = service.queuedTaskIds();
      if (ids.length === 0) return;
      for (const id of ids) await service.runNext(id);
    }
  }

  it("README だけのリポジトリで Sacty セットアップを実行すると、止まらずに実装の承認待ちまで進み、目的から判定したことがわかる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, tests, pulls } = makeService(
      activity,
      [
        plan(),
        out("# 前段の調査"),
        out("# 要求要件\n\n- AGENTS.md を足す"),
        out("# 実装の説明\n\n- AGENTS.md を足した"),
        review(),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ template: "sacty-setup", projectId: "default" });
    await service.runNext(id);
    // テストの仕組みが無いと判断した理由を台帳に残し、止めずに工程を進める
    const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.noTestsReason).toBe(NO_TESTS);
    expect(chosen?.type === "StepsChosen" && chosen.payload.testCommand).toBeUndefined();
    expect(taskOf(service, id).noTestsReason).toBe(NO_TESTS);
    // オーケストレーターには、テストの仕組みが無いときの答え方を伝える
    expect(promptOf(executor, 0)).toContain("noTests");
    await drain(service);
    expect(taskOf(service, id).gate).toEqual({ step: "requirements", submission: 1 });
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    const task = taskOf(service, id);
    // テストは実行せず、最終レビューで目的から判定して、実装の承認待ちになる
    expect(tests.calls).toEqual([]);
    expect(typesOf(service, id)).toContain("TestsSkipped");
    expect(task.testsSkippedAt).toBeDefined();
    expect(task.lastReview?.passed).toBe(true);
    expect(task.gate).toEqual({ step: "implement", submission: 1 });
    expect(task.status).toBe("awaiting_approval");
    // 実装の指示は、テストを書かせず、目的から判定されることを伝える
    const implementPrompt = promptOf(executor, 3);
    expect(implementPrompt).toContain("このリポジトリには、テストの仕組みがありません");
    expect(implementPrompt).toContain("sacty-test-command");
    // 最終レビューは、目的・実装の説明から判定させ、テストが無いことでは不合格にさせない
    const guardian = promptOf(executor, 4);
    expect(guardian).toContain("--- タスク（目的） ---");
    expect(guardian).toContain("Sacty セットアップ");
    expect(guardian).toContain("--- 実装の説明（工程エージェントの申告） ---");
    expect(guardian).toContain("- AGENTS.md を足した");
    expect(guardian).toContain(
      "テストが無い・観点にテストが対応していないことを理由に不合格にしない",
    );
    expect(guardian).toContain("（テストのコマンドが無いため、実行していません）");
    // PR の本文で、テストで検証していないことがわかる
    expect(pulls.calls).toHaveLength(1);
    const body = pulls.calls[0]?.body ?? "";
    expect(body).toContain(
      "テスト：テストのコマンドが無いため、テストでは検証していません。目的から判定しました。",
    );
    expect(body).toContain(`テストの仕組みが無いと判断した根拠（オーケストレーター）：${NO_TESTS}`);
    expect(body).toContain("（テストなし。目的から判定）");
    // 人の承認は今どおり要る
    expect(isCompleted(task)).toBe(false);
    activity.close();
  });

  it("テストのファイルがあるのにテストの仕組みが無いと答えたら、テストなしで進めずに止め、再開してもテストを飛ばさない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, tests } = makeService(
      activity,
      [plan(), out("# 前段の調査"), out("# 要求要件"), out("# 実装の説明")],
      {
        realPlanner: true,
        repos: new FilesRepos({ "README.md": "# app", "src/pay.test.js": "test()" }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(id);
    const task = taskOf(service, id);
    expect(task.status).toBe("paused");
    expect(task.pausedMessage).toEqual({
      code: "orchestrator.noTestsContradicted",
      params: { reason: NO_TESTS, files: "src/pay.test.js" },
    });
    // テストの無いタスクとして記録しない（費用をかける前に止める）
    expect(task.noTestsReason).toBeUndefined();
    const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.noTestsReason).toBeUndefined();
    expect(executor.calls).toHaveLength(1);
    // 再開して実装まで進めても、検証でテストを飛ばさずに止まる
    service.resume(id, {});
    await drain(service);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    expect(tests.calls).toEqual([]);
    expect(typesOf(service, id)).not.toContain("TestsSkipped");
    expect(taskOf(service, id).pausedMessage).toEqual({ code: "orchestrator.testCommandUnknown" });
    activity.close();
  });

  it("申告を読むのはテストの仕組みが無いタスクの実装だけ。ほかの工程やテストのあるタスクでは、コードブロックを本文に残す（PR #105 再レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const example = '```sacty-test-command\n{"command":"make test",}\n```';
    const { service, tests } = makeService(
      activity,
      [
        out(`# 要求要件\n\n申告の例：\n\n${example}`),
        out(
          `# 実装の説明\n\n${example}\n\n${block({ "sacty-test-map": [{ viewpointId: "REQ", tests: ["a.test › a"] }] })}`,
        ),
        review(),
      ],
      {
        planner: async () => ({
          steps: ["requirements", "implement"],
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
        }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "テストのあるタスク" });
    await drain(service);
    // 要求要件の本文から、例が消えない
    expect(taskOf(service, id).outputs.requirements).toContain(example);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    const task = taskOf(service, id);
    // テストのあるタスクの実装では、申告として扱わない（止めず、本文にも残し、決めたテストのコマンドで検証する）
    expect(task.pausedMessage).toBeUndefined();
    expect(task.outputs.implement).toContain(example);
    expect(task.addedTestCommand).toBeUndefined();
    expect(tests.calls.map((c) => c.command)).toEqual(["npm test"]);
    expect(task.gate).toEqual({ step: "implement", submission: 1 });
    activity.close();
  });

  it("テストの仕組みが無いタスクでも、要求要件・設計の本文の申告の例は取り除かず、申告として扱わない（PR #105 再レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const example = '```sacty-test-command\n{"command":"make test",}\n```';
    const { service } = makeService(
      activity,
      [
        plan({}, "standard"),
        out("# 前段の調査"),
        out(`# 要求要件\n\n申告の例：\n\n${example}`),
        out(
          `# 設計\n\n申告の例：\n\n${example}\n\n${block({
            "sacty-test-viewpoints": [{ title: "指示がある", input: "読む", expected: "ある" }],
          })}`,
        ),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ projectId: "default", title: "設計する" });
    await drain(service);
    expect(taskOf(service, id).noTestsReason).toBe(NO_TESTS);
    expect(taskOf(service, id).outputs.requirements).toContain(example);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    const task = taskOf(service, id);
    // 設計の本文にも残り、止まらずに設計の承認待ちになる
    expect(task.outputs.design).toContain(example);
    expect(task.pausedMessage).toBeUndefined();
    expect(task.gate).toEqual({ step: "design", submission: 1 });
    activity.close();
  });

  it("テストの仕組みが無いと答えなければ今どおり止め、テストのコマンドがあればテストの無い判断は捨てる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [
        out(block({ "sacty-steps": { plan: "skip-design", reason: "小さい" } })),
        plan({ testCommand: "make test" }),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const a = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(a.id);
    expect(taskOf(service, a.id).pausedMessage).toEqual({
      code: "orchestrator.testCommandUnknown",
    });
    const b = service.createTask({ projectId: "default", title: "B" });
    await service.runNext(b.id);
    const task = taskOf(service, b.id);
    expect(task.testCommand).toBe("make test");
    expect(task.noTestsReason).toBeUndefined();
    expect(task.pausedMessage).toBeUndefined();
    activity.close();
  });

  it("テストの仕組みが無いのに不具合の修正を選んだら、テストの無いタスクとして扱わずに止める", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [plan({ investigation: "bug" }, "bugfix")],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ projectId: "default", title: "不具合" });
    await service.runNext(id);
    const task = taskOf(service, id);
    expect(task.status).toBe("paused");
    expect(task.pausedMessage).toEqual({
      code: "orchestrator.bugfixNeedsTests",
      params: { reason: NO_TESTS },
    });
    expect(task.noTestsReason).toBeUndefined();
    expect(executor.calls).toHaveLength(1);
    activity.close();
  });

  it("実装がテストの仕組みを用意して申告したら、そのコマンドで検証し、通らなければやり直す。観点の対応が無いことでは落とさない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const implemented = (command: string) =>
      out(`# 実装の説明\n\n\`\`\`sacty-test-command\n${JSON.stringify({ command })}\n\`\`\``);
    const { service, executor, tests, pulls } = makeService(
      activity,
      [
        plan(),
        out("# 前段の調査"),
        out("# 要求要件\n\n- テストの仕組みを用意する"),
        implemented("make check"),
        implemented("make test"),
        review(),
      ],
      {
        realPlanner: true,
        repos: new FilesRepos({ "README.md": "# app" }),
        tests: new FakeTests([
          { exitCode: 1, output: "FAIL", durationMs: 5 },
          { exitCode: 0, output: "ok", durationMs: 5 },
        ]),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "テストを用意する" });
    await drain(service);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    // 申告したコマンドで実行する。1回目は通らずにやり直し、2回目のコマンドで通る
    expect(tests.calls.map((c) => c.command)).toEqual(["make check", "make test"]);
    const runs = service
      .get(id)
      ?.activity.flatMap((e) => (e.type === "TestsRun" ? [e.payload] : []));
    expect(runs?.map((r) => [r.passed, r.unmappedViewpoints])).toEqual([
      [false, ["REQ"]],
      [true, ["REQ"]],
    ]);
    // やり直しの指示に、テストの対応が無い観点を挙げない
    expect(promptOf(executor, 4)).toContain("前回の検証：テストが通りませんでした");
    expect(promptOf(executor, 4)).not.toContain("テストが対応していない観点");
    const task = taskOf(service, id);
    expect(task.addedTestCommand).toBe("make test");
    expect(task.testsSkippedAt).toBeUndefined();
    expect(task.gate).toEqual({ step: "implement", submission: 1 });
    // 最終レビューと PR の本文で、実装で用意したテストを使ったことがわかる
    expect(promptOf(executor, 5)).toContain("sacty は、実装が用意したテストを実行しました");
    expect(pulls.calls[0]?.body).toContain(
      "テスト：`make test` → 合格（終了コード 0）（実装で用意したテスト）",
    );
    activity.close();
  });

  it("目的からの判定に通らなければやり直し、続けて通らなければ上限で止める。再起動して再開しても、テストは実行しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const outcomes = [
      plan(),
      out("# 前段の調査"),
      out("# 要求要件"),
      ...Array.from({ length: MAX_VERIFY_ATTEMPTS }, () => [
        out("# 実装の説明"),
        review(false),
      ]).flat(),
    ];
    const { service, tests } = makeService(activity, outcomes, {
      realPlanner: true,
      repos: new FilesRepos({ "README.md": "# app" }),
    });
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await drain(service);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service, 20);
    const task = taskOf(service, id);
    expect(task.status).toBe("paused");
    expect(task.pausedReason).toBe("verification");
    expect(typesOf(service, id).filter((t) => t === "TestsSkipped")).toHaveLength(
      MAX_VERIFY_ATTEMPTS,
    );
    expect(tests.calls).toEqual([]);
    // 再起動（作業履歴から読み直す）して再開すると、テストを飛ばして目的から判定し直す
    const restarted = makeService(activity, [out("# 実装の説明"), review()], {
      realPlanner: true,
      tests,
    });
    expect(taskOf(restarted.service, id).noTestsReason).toBe(NO_TESTS);
    restarted.service.resume(id, {});
    await drain(restarted.service);
    const after = taskOf(restarted.service, id);
    expect(after.gate).toEqual({ step: "implement", submission: 1 });
    expect(tests.calls).toEqual([]);
    activity.close();
  });

  it("実装のテストのコマンドの申告の形が正しくなければ、テストを飛ばさずに止め、再開すると実装をやり直す（PR #105 レビュー指摘）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, tests } = makeService(
      activity,
      [
        plan(),
        out("# 前段の調査"),
        out("# 要求要件"),
        out('# 実装の説明\n\n```sacty-test-command\n{"command": ""}\n```'),
        // JSON として読めない申告も、テストを飛ばさずに止める（PR #105 再レビュー指摘）
        out('# 実装の説明\n\n```sacty-test-command\n{"command" "make test"}\n```'),
        out('# 実装の説明\n\n```sacty-test-command\n{"command": "make test"}\n```'),
        review(),
      ],
      { realPlanner: true, repos: new FilesRepos({ "README.md": "# app" }) },
    );
    const { id } = service.createTask({ projectId: "default", title: "テストを用意する" });
    await drain(service);
    service.approve(id, { step: "requirements", submission: 1 });
    await drain(service);
    const paused = taskOf(service, id);
    expect(paused.status).toBe("paused");
    expect(paused.pausedMessage).toEqual({ code: "implement.testCommandInvalid" });
    expect(typesOf(service, id)).not.toContain("TestsSkipped");
    expect(tests.calls).toEqual([]);
    // 再開すると実装をやり直す。読めない申告でも止まる
    service.resume(id, {});
    await drain(service);
    expect(taskOf(service, id).pausedMessage).toEqual({ code: "implement.testCommandInvalid" });
    expect(typesOf(service, id)).not.toContain("TestsSkipped");
    expect(tests.calls).toEqual([]);
    // もう一度再開すると、正しい申告のコマンドで検証する
    service.resume(id, {});
    await drain(service);
    expect(tests.calls.map((c) => c.command)).toEqual(["make test"]);
    expect(taskOf(service, id).gate).toEqual({ step: "implement", submission: 1 });
    activity.close();
  });
});

describe("非コードの成果と単発作業（PBI-112）", () => {
  const out = (output: string): AgentOutcome => ({
    kind: "completed",
    output,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (value: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
  const planner =
    (plan: "document" | "operation"): ServiceDeps["planner"] =>
    async () => ({
      steps: [...STEP_PLANS[plan]],
      plan,
      reason: "非コード作業",
      ...(plan === "operation" ? { operation } : {}),
      fallback: false,
      costUsd: 0,
      estimated: false,
    });
  const calendar = () =>
    toPlatform(
      "calendar",
      PlatformFile.parse({
        upstream: "https://calendar.example.com",
        description: "チームの予定表",
        auth: { header: "Authorization", prefix: "Bearer ", secret: "github-token" },
        allow: ["GET /**", "PUT /**"],
      }),
    );
  const operation = {
    via: "platform" as const,
    name: "calendar",
    target: "event-42",
    change: "開始時刻を10時から11時に変更する",
    verification: "event-42を再取得して開始時刻を確認する",
  };
  const success = out(
    block({
      "sacty-operation-result": {
        success: true,
        evidence: "event-42の開始時刻が11時であることを再取得して確認した",
      },
    }),
  );

  it("実オーケストレーターの1回の選択からoperationを直接実行して結果だけ承認する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const selected = out(
      block({ "sacty-steps": { plan: "operation", reason: "依頼された予定変更", operation } }),
    );
    const { service, executor } = makeService(activity, [selected, success], {
      realPlanner: true,
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({
      projectId: "default",
      title: "event-42の開始時刻を11時に変更",
      repo: null,
    });
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.steps.map((step) => step.key)).toEqual(["operation"]);
    expect(task?.operation).toEqual(operation);
    expect(task?.gate?.step).toBe("operation");
    expect(executor.calls).toHaveLength(2); // 工程選択 + 単発作業。準備の実行や承認はない。
    expect(executor.calls[0]?.command.join(" ")).toContain("実行設定を同じ回答に書く");
    expect(executor.calls[1]?.command.join(" ")).toContain("event-42の開始時刻を11時に変更");
    expect(activity.forTask(id).filter((e) => e.type === "StepSubmitted")).toHaveLength(1);
    const { service: restored } = makeService(activity);
    expect(restored.get(id)?.task.operation).toEqual(operation);
    restored.approve(id, { step: "operation", submission: 1 });
    expect(isCompleted(restored.get(id)?.task as Task)).toBe(true);
    activity.close();
  });

  it("ユーザー文書を実装なしで作成し、差戻し後の成果を承認して完了できる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, repos, tests, pulls } = makeService(
      activity,
      [out("# 利用手順 v1"), out("# 利用手順 v2")],
      { planner: planner("document") },
    );
    const { id } = service.createTask({
      projectId: "default",
      title: "利用手順を作る",
      repo: null,
    });
    await service.runNext(id);
    expect(service.get(id)?.task.gate?.step).toBe("document");
    service.requestChanges(id, {
      step: "document",
      submission: 1,
      comments: ["初回設定の説明を追加"],
    });
    await service.runNext(id);
    service.approve(id, { step: "document", submission: 2 });
    expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
    expect(executor.calls).toHaveLength(2);
    expect(repos.prepared).toEqual([]);
    expect(tests.calls).toEqual([]);
    expect(pulls.calls).toEqual([]);
    activity.close();
  });

  it("文書は承認後に指定先へ書き出し、URLを記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const selected: ServiceDeps["planner"] = async () => ({
      steps: [...STEP_PLANS.document],
      plan: "document",
      reason: "利用者向け手順",
      fallback: false,
      costUsd: 0,
      estimated: false,
      exports: {
        document: {
          to: { via: "platform", name: "calendar", location: "説明ページ" },
          reason: "依頼された保存先",
        },
      },
    });
    const { service, executor } = makeService(
      activity,
      [
        out("# 予定表の利用手順"),
        out(block({ "sacty-export": { url: "https://calendar.example.com/help" } })),
      ],
      { planner: selected, config: configOf(agent(), 1, [calendar()]), gateway: fakeGateway() },
    );
    const { id } = service.createTask({
      projectId: "default",
      title: "利用手順の作成と保存",
      repo: null,
    });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    service.approve(id, { step: "document", submission: 1 });
    expect(exportDue(service.get(id)?.task as Task)).toBe("document");
    await service.runNext(id);
    expect(service.get(id)?.task.exports.document?.url).toBe("https://calendar.example.com/help");
    expect(executor.calls).toHaveLength(2);
    activity.close();
  });

  it("オーケストレーターの作業指定を保存して一度実行し、結果だけの承認を待つ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [success], {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({
      projectId: "default",
      title: "予定を11時へ変更",
      repo: null,
    });
    await service.runNext(id);
    expect(service.get(id)?.task.operation).toEqual(operation);
    expect(service.get(id)?.task.operationAttempted).toBe(true);
    expect(service.get(id)?.task.gate?.step).toBe("operation");
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.env.SACTY_PF_URL).toBeDefined();
    expect(executor.calls[0]?.command.join(" ")).toContain("event-42");
    expect(() =>
      service.requestChanges(id, { step: "operation", submission: 1, comments: ["もう一度"] }),
    ).toThrow();
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    service.approve(id, { step: "operation", submission: 1 });
    expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
    activity.close();
  });

  it("成功根拠を返さない外部作業は停止し、再起動と再開後にも再実行しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const options = {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    };
    const { service, executor } = makeService(activity, [out("処理しました")], options);
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(executor.calls).toHaveLength(1);
    const restarted = makeService(activity, [success], options);
    restarted.service.recoverInterrupted();
    expect(restarted.service.get(id)?.task.operationAttempted).toBe(true);
    expect(() => restarted.service.resume(id, {})).toThrow();
    await restarted.service.runNext(id);
    expect(restarted.executor.calls).toEqual([]);
    expect(restarted.service.get(id)?.task.status).toBe("paused");
    activity.close();
  });

  it("外部作業の実行器がタイムアウトしても再開・再実行しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [{ kind: "failed", reason: "error", message: "Executor timeout" }],
      {
        planner: planner("operation"),
        config: configOf(agent(), 1, [calendar()]),
        gateway: fakeGateway(),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    await service.runNext(id);
    expect(service.get(id)?.task.operationAttempted).toBe(true);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(() => service.resume(id, {})).toThrow();
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    expect(service.get(id)?.task.status).toBe("paused");
    activity.close();
  });

  it.each([false, true])(
    "再起動した操作の元runを保存し中止で停止確認する（停止=%s）",
    async (stops) => {
      const activity = new SqliteActivityStore(dbPath);
      const options = {
        planner: planner("operation"),
        config: configOf(agent(), 1, [calendar()]),
        gateway: fakeGateway(),
      };
      const { service } = makeService(activity, [], options);
      const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "sacty",
            event: {
              type: "StepsChosen",
              payload: {
                steps: [...STEP_PLANS.operation],
                plan: "operation",
                reason: "予定更新",
                operation,
              },
            },
          },
          {
            actor: "sacty",
            event: {
              type: "AgentRunStarted",
              payload: {
                runId: "interrupted-operation",
                step: "operation",
                agentId: "claude-subscription",
                authMode: "subscription",
              },
            },
          },
        ],
      });
      const workspace = join(dir, "workspaces", id, "operation", "interrupted-operation");
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, "state.txt"), "実行中の状態");
      const restarted = makeService(activity, [success], options);
      restarted.service.recoverInterrupted();
      expect(restarted.service.get(id)?.task.unstoppedRuns).toEqual(["interrupted-operation"]);
      expect(restarted.service.get(id)?.task.operationAttempted).toBe(true);
      expect(restarted.service.get(id)?.task.status).toBe("paused");
      expect(() => restarted.service.resume(id, {})).toThrow();
      await restarted.service.runNext(id);
      expect(restarted.executor.calls).toEqual([]);
      expect(restarted.service.get(id)?.task.status).toBe("paused");
      // recoverInterruptedが記録したrun IDは、さらに読み直しても中止の確認対象になる。
      const restored = makeService(activity, [], options);
      restored.executor.stops = stops;
      const ensure = vi.spyOn(restored.executor, "ensureStopped");
      expect(restored.service.get(id)?.task.unstoppedRuns).toEqual(["interrupted-operation"]);
      const cancelled = await restored.service.cancel(id);
      expect(restored.executor.killed).toContain("interrupted-operation");
      expect(ensure).toHaveBeenCalledWith("interrupted-operation");
      expect(cancelled.cancelled?.cleanup.find((c) => c.target === "container")?.result).toBe(
        stops ? "done" : "failed",
      );
      expect(existsSync(workspace)).toBe(!stops);
      expect(restored.executor.calls).toEqual([]);
      activity.close();
    },
  );

  it("文書作成には登録済みPF・MCP・コンテキストを渡さず、承認前に外部更新できない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const gateway = fakeGateway();
    const register = vi.spyOn(gateway, "register");
    const projects = projectsWithAccount();
    projects.put("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
      context: { repo: "https://github.com/acme/context" },
    });
    const { service, executor } = makeService(activity, [out("# 利用者マニュアル")], {
      planner: planner("document"),
      projects,
      config: configOf(
        agent(),
        1,
        [calendar()],
        [toHostMcp("notion", HostMcpFile.parse({ command: "notion-mcp" }))],
      ),
      contexts: new FakeContexts({
        "https://github.com/acme/context": { "CLAUDE.md": "外部の予定を更新する" },
      }),
      gateway,
    });
    const { id } = service.createTask({
      projectId: "default",
      title: "利用者マニュアル作成",
      repo: null,
    });
    await service.runNext(id);
    expect(executor.calls).toHaveLength(1);
    expect(executor.calls[0]?.env.SACTY_PF_URL).toBeUndefined();
    expect(executor.mcpConfigs[0]).toBeUndefined();
    expect(executor.contexts[0]).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
    expect(service.get(id)?.task.gate?.step).toBe("document");
    activity.close();
  });

  it.each(["platform", "mcp"] as const)(
    "複数のPFとMCPがあっても指定された%s接続だけを実行に渡す",
    async (via) => {
      const activity = new SqliteActivityStore(dbPath);
      const gateway = fakeGateway();
      const register = vi.spyOn(gateway, "register");
      const name = via === "platform" ? "calendar" : "notion";
      const { service, executor } = makeService(activity, [success], {
        planner: async () => ({
          steps: [...STEP_PLANS.operation],
          plan: "operation",
          reason: "予定更新",
          fallback: false,
          costUsd: 0,
          estimated: false,
          operation: { ...operation, via, name },
        }),
        gateway,
        config: configOf(
          agent(),
          1,
          [calendar(), { ...calendar(), name: "other-calendar" }],
          [
            toHostMcp("notion", HostMcpFile.parse({ command: "notion-mcp" })),
            toHostMcp("other-mcp", HostMcpFile.parse({ command: "other-mcp" })),
          ],
        ),
      });
      const { id } = service.createTask({ projectId: "default", title: "予定変更", repo: null });
      await service.runNext(id);
      expect(service.get(id)?.task.gate?.step).toBe("operation");
      const invocation = executor.calls[0];
      expect(invocation?.env.SACTY_PF_URL !== undefined).toBe(via === "platform");
      const mcp = JSON.parse(executor.mcpConfigs[0] ?? "{}").mcpServers ?? {};
      expect(Object.keys(mcp)).toEqual(via === "mcp" ? ["notion"] : []);
      expect(register.mock.calls.at(-1)?.[3]).toEqual({
        platforms: via === "platform" ? ["calendar"] : [],
        hostMcp: via === "mcp" ? ["notion"] : [],
      });
      service.approve(id, { step: "operation", submission: 1 });
      expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
      activity.close();
    },
  );

  it("工程決定後に接続先が削除されたら外部実行を開始せず一時停止する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const gateway = fakeGateway();
    const register = vi.spyOn(gateway, "register");
    const { service, executor } = makeService(activity, [success], {
      planner: planner("operation"),
      config: configOf(agent(), 1, []),
      gateway,
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "StepsChosen",
            payload: {
              steps: [...STEP_PLANS.operation],
              plan: "operation",
              reason: "削除前の接続先を選択",
              operation,
            },
          },
        },
      ],
    });
    const restarted = makeService(activity, [success], {
      config: configOf(agent(), 1, []),
      gateway,
    });
    await restarted.service.runNext(id);
    expect(restarted.service.get(id)?.task.status).toBe("paused");
    expect(restarted.service.get(id)?.task.operationAttempted).toBeUndefined();
    expect(executor.calls).toEqual([]);
    expect(restarted.executor.calls).toEqual([]);
    expect(register).not.toHaveBeenCalled();
    expect(() => restarted.service.resume(id, {})).not.toThrow();
    activity.close();
  });

  it("外部実行中に中止した後で成功応答が届いても承認待ちにせず再実行しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [], {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    const started = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<AgentOutcome>();
    const run = vi.spyOn(executor, "run").mockImplementationOnce(async () => {
      started.resolve();
      return outcome.promise;
    });
    const running = service.runNext(id);
    await started.promise;
    expect(service.get(id)?.task.operationAttempted).toBe(true);
    const stopRequested = Promise.withResolvers<void>();
    vi.spyOn(executor, "kill").mockImplementation(() => {
      stopRequested.resolve();
    });
    const cancelling = service.cancel(id);
    await stopRequested.promise;
    outcome.resolve(success);
    await Promise.all([running, cancelling]);
    expect(service.get(id)?.task.status).toBe("cancelled");
    expect(service.get(id)?.task.gate).toBeUndefined();
    await service.runNext(id);
    expect(run).toHaveBeenCalledTimes(1);
    activity.close();
  });

  it.each([
    ["未指定", undefined],
    ["対象なし", { ...operation, target: "" }],
    ["変更内容なし", { ...operation, change: "" }],
    ["確認方法なし", { ...operation, verification: "" }],
    ["接続先名なし", { ...operation, name: "" }],
  ])("作業指定が不十分（%s）なら実行前に停止し再開は許可する", async (_name, specified) => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [success], {
      planner: async () => ({
        steps: [...STEP_PLANS.operation],
        plan: "operation",
        reason: "予定更新",
        fallback: false,
        costUsd: 0,
        estimated: false,
        operation: specified as typeof operation | undefined,
      }),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    await service.runNext(id);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(service.get(id)?.task.operationAttempted).toBeUndefined();
    expect(executor.calls).toEqual([]);
    expect(() => service.resume(id, {})).not.toThrow();
    activity.close();
  });

  it.each(["manual", "failed", "throw"] as const)(
    "外部実行の停止未確認を保持し、中止で再確認する（%s）",
    async (mode) => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [HOLD], {
        planner: planner("operation"),
        config: configOf(agent(), 1, [calendar()]),
        gateway: fakeGateway(),
      });
      const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
      executor.stops = false;
      if (mode === "failed")
        vi.spyOn(executor, "run").mockResolvedValueOnce({
          kind: "failed",
          reason: "error",
          message: "timeout",
        });
      if (mode === "throw")
        vi.spyOn(executor, "run").mockRejectedValueOnce(new Error("executor lost connection"));
      const running = service.runNext(id);
      if (mode === "manual") {
        await executor.started.promise;
        await service.pause(id);
      }
      await running;
      const stopped = service.get(id)?.task;
      const runId = activity
        .forTask(id)
        .filter((e) => e.type === "AgentRunStarted")
        .at(-1)?.payload.runId as string;
      expect(stopped?.status).toBe("paused");
      expect(stopped?.unstoppedRuns).toEqual([runId]);
      const workspace = join(dir, "workspaces", id, "operation", runId);
      expect(existsSync(workspace)).toBe(true);
      const { service: restarted, executor: restartedExecutor } = makeService(activity);
      expect(restarted.get(id)?.task.unstoppedRuns).toEqual([runId]);
      restartedExecutor.stops = false;
      expect(await restarted.confirmPausedContainers(id)).toBe(false);
      expect(restartedExecutor.killed).toContain(runId);
      const cancelled = await restarted.cancel(id);
      expect(cancelled.cancelled?.cleanup.find((c) => c.target === "container")?.result).toBe(
        "failed",
      );
      expect(cancelled.cancelled?.cleanup.find((c) => c.target === "workspace")?.result).toBe(
        "failed",
      );
      expect(existsSync(workspace)).toBe(true);
      activity.close();
    },
  );

  it("外部実行の停止を後から確認できれば中止で保持した作業領域を消す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [HOLD], {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    executor.stops = false;
    const running = service.runNext(id);
    const runId = await executor.started.promise;
    await service.pause(id);
    await running;
    const workspace = join(dir, "workspaces", id, "operation", runId);
    expect(existsSync(workspace)).toBe(true);
    executor.stops = true;
    const cancelled = await service.cancel(id);
    expect(cancelled.cancelled?.cleanup.find((c) => c.target === "container")?.result).toBe("done");
    expect(existsSync(workspace)).toBe(false);
    activity.close();
  });

  it("成功応答でもコンテナの停止未確認なら結果承認へ進めない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [success], {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    });
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    executor.stops = false;
    const ensure = vi.spyOn(executor, "ensureStopped");
    await service.runNext(id);
    const runId = activity.forTask(id).find((e) => e.type === "AgentRunStarted")?.payload.runId;
    expect(ensure).toHaveBeenCalledWith(runId);
    expect(service.get(id)?.task.status).toBe("paused");
    expect(service.get(id)?.task.gate).toBeUndefined();
    expect(service.get(id)?.task.unstoppedRuns).toEqual([runId]);
    expect(service.get(id)?.task.outputs.operation).toContain("event-42");
    expect(existsSync(executor.dirs[0] ?? "")).toBe(true);
    expect(() => service.approve(id, { step: "operation", submission: 1 })).toThrow();
    activity.close();
  });

  it("開始済みの操作が実行待ちに復元されてもserviceが明示理由で再開始を拒否する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const options = {
      planner: planner("operation"),
      config: configOf(agent(), 1, [calendar()]),
      gateway: fakeGateway(),
    };
    const { service } = makeService(activity, [], options);
    const { id } = service.createTask({ projectId: "default", title: "予定更新", repo: null });
    // 実行失敗を保存した直後、TaskPausedの記録より前にデーモンが停止した境界。
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: { steps: ["operation"], plan: "operation", operation },
          },
        },
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: {
              runId: "first-operation",
              step: "operation",
              agentId: "claude-subscription",
              authMode: "subscription",
            },
          },
        },
        {
          actor: "agent",
          event: {
            type: "AgentRunFailed",
            payload: {
              runId: "first-operation",
              step: "operation",
              agentId: "claude-subscription",
              reason: "error",
              message: "lost connection",
            },
          },
        },
      ],
    });
    const restored = makeService(activity, [success], options);
    expect(restored.service.get(id)?.task).toMatchObject({
      status: "queued",
      operationAttempted: true,
    });
    await restored.service.runNext(id);
    // 投影層の整合性エラーではなく、人に対処方法を示す通常の停止になる。
    expect(restored.service.get(id)?.task.pausedMessage).toEqual(message("operation.attempted"));
    expect(restored.service.get(id)?.task.status).toBe("paused");
    expect(restored.executor.calls).toEqual([]);
    expect(activity.forTask(id).filter((e) => e.type === "AgentRunStarted")).toHaveLength(1);
    activity.close();
  });
});
