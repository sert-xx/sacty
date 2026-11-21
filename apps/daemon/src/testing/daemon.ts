/**
 * デーモン（TaskService）のテストで共通に使う準備：偽の GitHub・偽のリポジトリ・偽のエージェントの実行と、それらを組んだ
 * サービスを作る makeService。テストは、題材ごとの daemon-*.test.ts に分けて置く（どのファイルに何を置くかは CONTRIBUTING.md）。
 * 本体のコードからは使わない（ビルドの対象から外している）。
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Actor, DaemonText, EventInput, StepKey, Task } from "@sacty/core";
import { MVP_STEPS, message, renderMessage } from "@sacty/core";
import { afterEach, beforeEach } from "vitest";
import type { SqliteActivityStore } from "../activity.js";
import type { AgentExecutor } from "../agents/docker.js";
import type { LocalForward } from "../agents/forward.js";
import type { Invocation } from "../agents/invocation.js";
import type { AgentOutcome } from "../agents/parse.js";
import { COMMIT_CONVENTION_FILES } from "../commit-message.js";
import { COMPLETION_FENCE, completionBlock } from "../completion.js";
import type { AgentConfig, ConfigResult } from "../config.js";
import type { ContextFetcher, ContextRef } from "../context.js";
import { MessageError } from "../errors.js";
import type { GitHubAuth } from "../gh.js";
import {
  isDecisionNotice,
  type PullRequestFeedback,
  type PullRequestInfo,
  type PullRequestStatus,
  type PullRequests,
  type SactyReviewRound,
  sactyReviewTask,
} from "../github.js";
import type { HostMcpSpec } from "../host-mcp.js";
import type { OrchestratorSessionStore } from "../orchestrator-sessions.js";
import { type Platform, PlatformFile, toPlatform } from "../platforms.js";
import { MemoryProjectStore } from "../projects.js";
import {
  type DiffFile,
  type FileChange,
  NothingToCommitError,
  type RepositoryWorkspace,
} from "../repository.js";
import { MemorySecretStore } from "../secrets.js";
import { type ServiceDeps, TaskService } from "../service.js";
import type { ServiceRunner, ServicesSpec } from "../services.js";
import type { SessionLogSink, SessionLogStore } from "../session-logs.js";
import { MemorySettingsStore } from "../settings.js";
import type { SharedComposeFetcher } from "../shared-compose.js";
import type { FoundTicket, TicketClient } from "../tickets.js";
import { waitFor } from "./wait.js";

/** 記録した文言（コードと引数）を、日本語の文にする（PBI-11）。 */
export const ja = (text: unknown) => renderMessage(text, "ja");

/**
 * 以前の版（最終レビュー・CI の待ちがあった版）が台帳に残した記録を、タスクに足す（PBI-336。今の版では作らない記録の
 * 読み込みと、新しい流れへの移行を確かめるため）。
 */
export function appendLegacy(
  service: TaskService,
  id: string,
  items: { actor: Actor; event: EventInput }[],
) {
  const internal = service as unknown as {
    append(task: Task, items: { actor: Actor; event: EventInput }[]): Task;
  };
  return internal.append(service.get(id)?.task as Task, items);
}

/** テストごとの作業用のディレクトリと、その中の台帳のパス（useTempDir を呼んだファイルで、テストごとに作り直す）。 */
export let dir: string;
export let dbPath: string;

/** テストごとに作業用のディレクトリを作り、終わったら消す。テストファイルの先頭で1回呼ぶ。 */
export function useTempDir() {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sacty-test-"));
    dbPath = join(dir, "sacty.db");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
}

export const agent = (overrides: Partial<AgentConfig> = {}): AgentConfig => ({
  id: "claude-subscription",
  runtime: "claude-code",
  auth: { mode: "subscription", secret: "claude-oauth-token" },
  price: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
  ...overrides,
});

export const configOf =
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
      auditAgent: a,
      budgetPerTaskUsd,
      budgetPerAuditUsd: 1,
      gatewayRetry: { maxAttempts: 8, maxWaitMs: 600_000 },
      hostAddress: "host-gateway",
      imageBuild: {},
      platforms,
      hostMcp,
    },
  });

/** run_timeout（PBI-150）を書いた設定。 */
export const configWithTimeouts =
  (runTimeouts: { agentMinutes: number; testMinutes: number; roles: Record<string, number> }) =>
  (): ConfigResult => {
    const base = configOf(agent())();
    return base.ok ? { ok: true, config: { ...base.config, runTimeouts } } : base;
  };

/** 偽の GitHub への投稿の投稿者（投稿に使ったトークンのアカウント。ghp_other は other、ほかは me）。 */
export function authorOfToken(token: string): string {
  return token === "ghp_other" ? "other" : "me";
}

/** GitHub が、レート制限で断ったときのエラー。retryAfterMs は、GitHub が示した、次に試せるまでの時間。 */
export function rateLimitError(retryAfterMs?: number, detail = RATE_LIMIT_DETAIL): Error {
  return Object.assign(
    new MessageError(
      message("github.failed", { action: "commentIssue", status: 403, detail, hint: "none" }),
    ),
    retryAfterMs !== undefined ? { retryAfterMs } : {},
  );
}
export const RATE_LIMIT_DETAIL =
  "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";

/** gh の偽物。ログイン済みのアカウントごとのトークンを返す。 */
export class FakeGitHub implements GitHubAuth {
  requested: string[] = [];
  constructor(private readonly tokens: Record<string, string> = { me: "ghp_secret" }) {}
  /** github.com のアカウントは名前だけ、ほかのホストは「ホスト/名前」で持つ。 */
  async accounts() {
    return Object.keys(this.tokens).map((key) => {
      const [host, login] = key.includes("/") ? key.split("/") : ["github.com", key];
      return {
        host: host ?? "",
        login: login ?? "",
        active: login === "me",
        state: "success",
      };
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
export function projectsWithAccount(): MemoryProjectStore {
  const projects = new MemoryProjectStore();
  projects.put("default", {
    name: "デフォルト",
    targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
    githubAccounts: { "github.com": "me" },
  });
  return projects;
}

/** docker compose のサービスの偽物（PBI-47）。起動と停止を記録する。 */
export class FakeServices implements ServiceRunner {
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
    this.order.push("start");
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
  /** イメージ ID（PBI-130）。決めた名前だけを確定させ、呼ばれた順を起動と同じ記録に残す。 */
  imageIds: Record<string, string> = {};
  order: string[] = [];
  imageRuns: string[] = [];
  /** true なら、イメージ ID の確定を、打ち切られるまで終わらせない（一時停止・中止のテスト。PBI-130 レビュー指摘）。 */
  imageHold = false;
  imageEntered = Promise.withResolvers<void>();
  private releaseImage?: () => void;
  async imageId(image: string, runId: string) {
    this.order.push(`imageId:${image}`);
    this.imageRuns.push(runId);
    if (this.imageHold) {
      this.imageEntered.resolve();
      await new Promise<void>((resolve) => {
        this.releaseImage = resolve;
      });
      return undefined;
    }
    return this.imageIds[image];
  }
  /** true なら、起動を打ち切られるまで待つ。 */
  hold = false;
  entered = Promise.withResolvers<void>();
  aborted: string[] = [];
  private release?: () => void;
  abort(runId: string) {
    this.aborted.push(runId);
    this.release?.();
    this.releaseImage?.();
  }
}

/** 共用の compose のリポジトリの取得の偽物（PBI-70）。取得の呼び出しを記録し、compose ファイルを置く。 */
export class FakeSharedComposes implements SharedComposeFetcher {
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
/** PR の本文に書く、今の head の AI のレビューの状況（レビューのタスクが無ければ付いていない。PBI-302 D1）。 */
export function noAiReview(task: Task) {
  return { aiReview: { head: task.pullRequest?.commit ?? "", status: "none" as const } };
}

export class FakeRepos implements RepositoryWorkspace {
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
  /** 差分の起点にしたコミット（ベースブランチを取り込んだら、その先頭）。 */
  diffBases: string[] = [];
  async diff(_dir?: string, _gitDir?: string, baseCommit?: string) {
    if (baseCommit) this.diffBases.push(baseCommit);
    if (this.diffFail) throw new Error(this.diffFail);
    return this.diffText;
  }
  /** 作業領域の内容の目印（ツリーの ID。PBI-347）。テストが、実行のたびに変えて「実装が進んだ」ことにする。 */
  tree = "t".padEnd(40, "0");
  treeFail: string | undefined;
  async treeId() {
    if (this.treeFail) throw new Error(this.treeFail);
    return this.tree;
  }
  /** diff と同じ差分のファイルの一覧。無ければ、diffText の見出し（引用の無い簡単な形）から作る。 */
  diffFileList: DiffFile[] | undefined;
  diffFilesFail: string | undefined;
  async diffFiles() {
    if (this.diffFilesFail) throw new Error(this.diffFilesFail);
    if (this.diffFileList) return this.diffFileList;
    return this.diffText
      .split("\n")
      .filter((line) => line.startsWith("diff --git "))
      .map((line) => ({ status: "M", path: line.replace(/^diff --git a\/.* b\//, "") }));
  }
  /** ファイルごとの変更（セキュリティ対応の範囲の照合）。 */
  changes: FileChange[] = [{ path: "src/pay.ts", added: 1, removed: 0 }];
  async diffStats() {
    if (this.diffFail) throw new Error(this.diffFail);
    return this.changes;
  }
  /** 実装後のコードの写し（PBI-16）。 */
  workingCopies: { dir: string; outDir: string; gitDir?: string }[] = [];
  copyFail?: string;
  /** 読めないために写さなかったファイル（権限 0000 のツールのファイルなど。PBI-278）。 */
  copySkipped: { count: number; paths: string[] } = { count: 0, paths: [] };
  /** 写しを始めたら解決する。copyGate があれば、それが解決するまで写し終えない（写しの途中で止めるテスト。PBI-156）。 */
  copyStarted = Promise.withResolvers<void>();
  copyGate?: Promise<void>;
  async copyWorkingTree(dir: string, outDir: string, gitDir?: string) {
    if (this.copyFail) throw new Error(this.copyFail);
    this.copyStarted.resolve();
    if (this.copyGate) {
      mkdirSync(outDir, { recursive: true });
      await this.copyGate;
    }
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "IMPLEMENTED.md"), "implemented");
    this.workingCopies.push({ dir, outDir, ...(gitDir ? { gitDir } : {}) });
    return { skipped: this.copySkipped };
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
  /** これを含む取得だけ失敗にする（前回の先頭・前回の起点が取得できない場合。PBI-421）。 */
  fetchFailFor: string[] = [];
  async fetchCommits(gitDir: string, commits: string[], authEnv?: Record<string, string>) {
    if (this.fetchFail) throw new Error(this.fetchFail);
    if (commits.some((c) => this.fetchFailFor.includes(c))) throw new Error("fetch failed");
    this.fetchedCommits.push({ gitDir, commits, ...(authEnv ? { authEnv } : {}) });
  }
  /** ベースブランチの最新の取得（統合レビュー。PBI-31）。 */
  branchHead = "c".repeat(40);
  fetchedBranches: { gitDir: string; branch: string; authEnv?: Record<string, string> }[] = [];
  fetchBranchFail?: string;
  async remoteDefaultBranch(
    _gitDir: string,
    _authEnv?: Record<string, string>,
    _signal?: AbortSignal,
  ) {
    return this.defaultBranch;
  }
  /** あれば、fetchBranch の中で呼ぶ（実行の中断（一時停止・中止）の再現。渡された signal を見られる）。 */
  onFetchBranch?: (signal?: AbortSignal) => void | Promise<void>;
  async fetchBranch(
    gitDir: string,
    branch: string,
    authEnv?: Record<string, string>,
    signal?: AbortSignal,
  ) {
    await this.onFetchBranch?.(signal);
    if (this.fetchBranchFail) throw new Error(this.fetchBranchFail);
    this.fetchedBranches.push({ gitDir, branch, ...(authEnv ? { authEnv } : {}) });
    return this.remote[branch] ?? this.branchHead;
  }
  /** タスクブランチの、sacty が積んだ後の変更（PBI-57）。テストで、人が直接積んだ変更を表す。 */
  changed: string[] = [];
  changedCalls: { from: string; to: string }[] = [];
  /** 2つのコミットの組（`from..to`）ごとの変更のパス。無ければ changed（PBI-421）。 */
  changedBetween: Record<string, string[]> = {};
  async changedPaths(_gitDir: string, from: string, to: string) {
    this.changedCalls.push({ from, to });
    return this.changedBetween[`${from}..${to}`] ?? this.changed;
  }
  /** isAncestor の結果（PBI-421）。ancestorFail があれば失敗にする。 */
  notAncestor = false;
  ancestorFail?: string;
  async isAncestor(_gitDir: string, _commit: string, _ancestorOf: string) {
    if (this.ancestorFail) throw new Error(this.ancestorFail);
    return !this.notAncestor;
  }
  /** mergeBaseOf の結果（PBI-421）。commit の組（`a..b`）ごとに決める。無ければ、すべて同じ値（起点が変わらない）。 */
  mergeBases: Record<string, string | undefined> = {};
  async mergeBaseOf(_gitDir: string, a: string, b: string) {
    const key = `${a}..${b}`;
    return key in this.mergeBases ? this.mergeBases[key] : "m".repeat(40);
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
  /** true なら、実際の git と同じく、anyName でない読み取りは ASCII の英数字と ._/- だけのパスしか受け付けない。 */
  strictNames = false;
  async readFile(
    gitDir: string,
    commit: string,
    path: string,
    options: { anyName?: boolean } = {},
  ) {
    if (this.strictNames && options.anyName !== true && !/^[A-Za-z0-9._/-]+$/.test(path)) {
      throw new MessageError(message("git.invalidPath"));
    }
    // コミットメッセージの形の定めを探す読み取り（PBI-301 A8）は、成果のファイルの読み取りの記録に入れない
    if (!COMMIT_CONVENTION_FILES.includes(path)) this.readCalls.push({ gitDir, commit, path });
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
  /** 前回の先頭から今回の先頭までなど、組（`base..head`）ごとの差分。無ければ prDiff。 */
  diffBetween: Record<string, string> = {};
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
    return this.diffBetween[`${baseCommit}..${headCommit}`] ?? this.prDiff;
  }
  /** ベースブランチの取り込み（mergeBase）の結果と、呼び出しの記録。 */
  mergeResult: { status: "unchanged" | "merged" | "conflicted"; conflicts: string[] } = {
    status: "merged",
    conflicts: [],
  };
  mergeFail?: string;
  merges: { dir: string; gitDir: string; base: string; target: string; exclude?: string[] }[] = [];
  async mergeBase(input: {
    dir: string;
    gitDir: string;
    base: string;
    target: string;
    maxConflicts?: number;
    exclude?: string[];
  }) {
    this.merges.push(input);
    if (this.mergeFail) throw new Error(this.mergeFail);
    // 実際の取り込みと同じく、競合が上限より多ければ、結果を返さずに失敗する
    if (
      input.maxConflicts !== undefined &&
      this.mergeResult.conflicts.length > input.maxConflicts
    ) {
      throw new Error(`競合が多すぎます（${this.mergeResult.conflicts.length} 件）`);
    }
    return this.mergeResult;
  }
  /** 競合の目印が残っているパス（解消すると、テストで外す）。 */
  markers: string[] = [];
  /** あれば、競合の目印の検査が、これで失敗する（ファイルを読めないなど）。 */
  markersFail?: string;
  async conflictMarkers(_dir: string, paths: string[]) {
    if (this.markersFail) throw new Error(this.markersFail);
    return paths.filter((p) => this.markers.includes(p));
  }
  published: {
    parent: string;
    branch: string;
    message: string;
    date: string;
    keep?: { commit: string; paths: string[] };
    overrides?: Record<string, string>;
  }[] = [];
  /** published と同じ順の、起点（作業領域のベース）と、第2の親にするコミット（ベースブランチの取り込み）。 */
  publishInputs: { baseCommit?: string; merge?: string }[] = [];
  publishFail?: string;
  /** あれば、プッシュはリモートに届いた後（ブランチを進めた後）に、この文で失敗する（応答の失敗・時間切れの再現）。 */
  publishFailAfterPush?: string;
  /** true なら、作業領域が起点から何も変わっていない（PBI-90）。 */
  unchanged = false;
  /** あれば、プッシュを、これが解決するまで終わらせない（PR の作成の前の一時停止のテスト。PBI-110）。 */
  publishGate?: Promise<void>;
  publishStarted = Promise.withResolvers<void>();
  /**
   * true なら、作業領域が前にプッシュした内容から変わっていない（実際の git と同じく、起点でない親のコミットをそのまま使い、
   * 新しいコミットを作らない）。
   */
  sameAsParent = false;
  async publish(input: {
    parent: string;
    branch: string;
    message: string;
    date: string;
    baseCommit?: string;
    merge?: string;
    keep?: { commit: string; paths: string[] };
    overrides?: Record<string, string>;
  }) {
    this.publishStarted.resolve();
    if (this.publishGate) await this.publishGate;
    if (this.publishFail) throw new Error(this.publishFail);
    if (this.unchanged) throw new NothingToCommitError(message("git.nothingToCommit"));
    if (this.sameAsParent && input.parent !== input.baseCommit) return { commit: input.parent };
    this.published.push({
      parent: input.parent,
      branch: input.branch,
      message: input.message,
      date: input.date,
      ...(input.keep ? { keep: input.keep } : {}),
      ...(input.overrides ? { overrides: input.overrides } : {}),
    });
    this.publishInputs.push({
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...(input.merge ? { merge: input.merge } : {}),
    });
    const commit = `c${this.published.length}`.padEnd(40, "0");
    // 引き継いだ（keep）ファイルは keep.commit の内容、置き換えた（overrides）ファイルは渡した内容を、このコミットのファイルにする
    const inherited: Record<string, string | null> = {};
    for (const path of input.keep?.paths ?? []) {
      const kept = input.keep
        ? (this.files[input.keep.commit]?.[path] ??
          this.committedFiles.findLast((c) => path in c.files)?.files[path])
        : undefined;
      if (kept !== undefined) inherited[path] = kept;
    }
    if (Object.keys(inherited).length > 0 || input.overrides) {
      this.files[commit] = { ...inherited, ...(input.overrides ?? {}) };
    }
    this.remote[input.branch] = commit;
    if (this.publishFailAfterPush) throw new Error(this.publishFailAfterPush);
    return { commit };
  }
}

/** リポジトリごとに決めたファイルを置く、コンテキストの取得の偽物。 */
export class FakeContexts implements ContextFetcher {
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
export class FakePulls implements PullRequests {
  calls: Parameters<PullRequests["upsert"]>[0][] = [];
  fail?: string;
  /** 次に新しく作る PR の番号。 */
  nextNumber = 7;
  /** あれば、PR の作成を、これが解決するまで終わらせない（PR の作成中の一時停止のテスト。PBI-110）。 */
  upsertGate?: Promise<void>;
  /** あれば、upsertGate で待たせるのは、この番号の PR の更新だけ（PBI-317）。 */
  upsertGateNumber?: number;
  upsertStarted = Promise.withResolvers<void>();
  async upsert(input: Parameters<PullRequests["upsert"]>[0]) {
    const gated = this.upsertGateNumber === undefined || input.number === this.upsertGateNumber;
    if (gated) this.upsertStarted.resolve();
    if (this.upsertGate && gated) await this.upsertGate;
    if (this.fail) throw new Error(this.fail);
    // ドラフトにしかできない PR（requireDraft。PBI-317）は、ドラフトを使えないリポジトリでは作らない
    if (!input.number && input.draft && input.requireDraft && this.draftUnsupported) {
      throw new Error("Draft pull requests are not supported in this repository");
    }
    this.calls.push(input);
    const number = input.number ?? this.nextNumber++;
    // GitHub と同じく、書いた本文を今の本文にする（本文を渡さない更新では変えない。PBI-334）
    if (input.body !== undefined) this.bodies[number] = input.body;
    this.bodyWrites += 1;
    // ドラフトを使えないリポジトリ（draftUnsupported）なら、ドラフトでない PR にする
    const draft = input.number
      ? (this.drafts[number] ?? false)
      : input.draft === true && !this.draftUnsupported;
    this.drafts[number] = draft;
    return { url: `https://github.com/acme/app/pull/${number}`, number, draft };
  }
  /** PR ごとの、GitHub の今の本文（upsert で書いたもの。人が直したことは、テストで書き換えて表す。PBI-334）。 */
  bodies: Record<number, string> = {};
  bodyFail?: string;
  bodyWrites = 0;
  /** あれば、本文を読むたびに呼ぶ（読んだ回数を渡す。本文の読み取りの後に人がまた直したことを表す。PBI-334）。 */
  onBodyRead?: (reads: number) => void;
  bodyReads = 0;
  async pullRequestBody(input: { repo: string; token: string; number: number }) {
    if (this.bodyFail) throw new Error(this.bodyFail);
    this.bodyReads += 1;
    const body = this.bodies[input.number] ?? "";
    this.onBodyRead?.(this.bodyReads);
    return body;
  }
  /** PR ごとの、ドラフトか。 */
  drafts: Record<number, boolean> = {};
  draftUnsupported = false;
  /** ドラフトの切り替え（順に）。 */
  draftChanges: { number: number; draft: boolean }[] = [];
  setDraftFail?: string;
  /** あれば、切り替えは GitHub で済むが、答えを受け取れずに失敗する。 */
  setDraftAnswerLost?: string;
  /** あれば、ドラフトの切り替えを済ませた後、答えを返す前に、これが解決するまで待つ（PBI-317）。 */
  setDraftGate?: Promise<void>;
  setDraftStarted = Promise.withResolvers<void>();
  async setDraft(input: Parameters<PullRequests["setDraft"]>[0]) {
    if (this.setDraftFail) throw new Error(this.setDraftFail);
    if ((this.drafts[input.number] ?? false) !== input.draft) {
      this.draftChanges.push({ number: input.number, draft: input.draft });
    }
    this.drafts[input.number] = input.draft;
    if (this.setDraftGate) {
      this.setDraftStarted.resolve();
      await this.setDraftGate;
    }
    if (this.setDraftAnswerLost) throw new Error(this.setDraftAnswerLost);
    return { draft: input.draft };
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
    const state = this.states[input.number] ?? this.state;
    const draft = this.drafts[input.number];
    // 指定が無ければ、同じリポジトリの PR（フォークでない。PBI-461）
    return {
      headSha: this.prInfo.headSha,
      fork: false,
      ...state,
      ...(state.state === "open" && draft !== undefined ? { draft } : {}),
    };
  }
  /** Issue へのコメント（調査の結果。PBI-18）。 */
  issueComments: { repo: string; token: string; number: number; body: string }[] = [];
  commentFail?: string;
  async commentIssue(input: {
    repo: string;
    token: string;
    number: number;
    body: string;
    signal?: AbortSignal;
  }) {
    // 本物の fetch と同じく、中断された通信は終わる（遅れて投稿されない。PBI-292）
    if (input.signal?.aborted) throw input.signal.reason;
    if (input.body.startsWith("<!-- sacty-reply:")) this.replyPostTimes.push(Date.now());
    if (this.rateLimited) throw rateLimitError(this.rateLimitRetryAfterMs, this.rateLimitDetail);
    if (this.commentFail) throw new Error(this.commentFail);
    this.issueComments.push(input);
    return {
      url: `${input.repo}/issues/${input.number}#issuecomment-${this.issueComments.length}`,
    };
  }
  /** 作った Issue（PBI-370）。issueFail があれば、作れない。 */
  createdIssues: { repo: string; token: string; title: string; body: string }[] = [];
  issueFail?: string;
  issueGate?: Promise<void>;
  /** Issue の作成を始めた回数（作成の最中であることを、テストが待つのに使う）。 */
  issueStarted = 0;
  async createIssue(input: {
    repo: string;
    token: string;
    title: string;
    body: string;
    signal?: AbortSignal;
  }) {
    this.issueStarted += 1;
    if (input.signal?.aborted) throw input.signal.reason;
    // あれば、これが解決するまで終わらせない（Issue を作っている最中の停止・期限切れのテスト）
    if (this.issueGate) {
      await Promise.race([
        this.issueGate,
        new Promise((_resolve, reject) => {
          input.signal?.addEventListener("abort", () => reject(input.signal?.reason));
        }),
      ]);
    }
    if (this.issueFail) throw new Error(this.issueFail);
    this.createdIssues.push(input);
    const number = 900 + this.createdIssues.length;
    return { url: `${input.repo}/issues/${number}`, number };
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
  /** あれば、書き込み（PR のコメント・行への返信）を、GitHub のレート制限で断る（PBI-352）。 */
  rateLimited = false;
  /** レート制限で断るときに、GitHub が示す、次に試せるまでの時間（ミリ秒）。 */
  rateLimitRetryAfterMs?: number;
  /** レート制限で断るときの、本文の説明（空なら、本文を読めず、ヘッダーだけが制限を示している）。 */
  rateLimitDetail = RATE_LIMIT_DETAIL;
  /** 指摘への返信（行への返信・PR のコメント）を始めた時刻（投稿の間隔を確かめる）。 */
  replyPostTimes: number[] = [];
  /** あれば、行へのコメントの一覧を、この回数だけ読めた後に、レート制限で断る。 */
  reviewListRateLimitedAfter?: number;
  /** 行へのコメントへの返信（指摘への対応の返信。PBI-352）。 */
  reviewReplies: {
    repo: string;
    token: string;
    number: number;
    commentId: number;
    body: string;
  }[] = [];
  /** あれば、行へのコメントへの返信を失敗させる（元のコメントが消えた・返信への返信は受け付けられない、など）。 */
  replyFail?: string;
  /** あれば、返信は GitHub で済むが、答えを受け取れずに失敗する。 */
  replyAnswerLost?: string;
  /** あれば、行へのコメントへの返信を、GitHub が断る（この状態コードの答え。404 は消えたコメント、422 は返信への返信）。 */
  replyRejected?: number;
  /** あれば、行へのコメントへの返信を、これが解決するまで終わらせない。 */
  replyGate?: Promise<void>;
  replyStarted = Promise.withResolvers<void>();
  async replyToReviewComment(input: {
    repo: string;
    token: string;
    number: number;
    commentId: number;
    body: string;
    signal?: AbortSignal;
  }) {
    if (input.signal?.aborted) throw input.signal.reason;
    this.replyPostTimes.push(Date.now());
    if (this.rateLimited) throw rateLimitError(this.rateLimitRetryAfterMs, this.rateLimitDetail);
    if (this.replyRejected) {
      throw new MessageError(
        message("github.failed", {
          action: "commentIssue",
          status: this.replyRejected,
          detail: "Not Found",
          hint: "none",
        }),
      );
    }
    if (this.replyFail) throw new Error(this.replyFail);
    this.replyStarted.resolve();
    if (this.replyGate) await this.replyGate;
    this.reviewReplies.push(input);
    if (this.replyAnswerLost) throw new Error(this.replyAnswerLost);
    return {
      url: `${input.repo}/pull/${input.number}#discussion_r${9000 + this.reviewReplies.length}`,
    };
  }
  /** 行へのコメントの一覧に混ぜる、ほかの人の投稿（目印をまねた・引用したもの）。 */
  foreignReviewComments: { number: number; author: string; body: string }[] = [];
  /** あれば、行へのコメントの一覧を、この回数だけ読めた後に失敗させる。 */
  reviewListFailAfter?: number;
  reviewListCalls = 0;
  /** 行へのコメントの一覧を読んだときの、アカウントと、最後まで読む指定。 */
  reviewListInputs: { account?: string; complete?: boolean; prefix: string }[] = [];
  async listReviewComments(input: {
    repo: string;
    number: number;
    prefix: string;
    account?: string;
    complete?: boolean;
    signal?: AbortSignal;
  }) {
    if (input.signal?.aborted) throw input.signal.reason;
    this.reviewListInputs.push({
      prefix: input.prefix,
      ...(input.account ? { account: input.account } : {}),
      ...(input.complete ? { complete: true } : {}),
    });
    if (
      this.reviewListRateLimitedAfter !== undefined &&
      this.reviewListCalls >= this.reviewListRateLimitedAfter
    ) {
      throw rateLimitError();
    }
    if (
      this.reviewListFailAfter !== undefined &&
      this.reviewListCalls >= this.reviewListFailAfter
    ) {
      throw new Error("502 Bad Gateway");
    }
    this.reviewListCalls += 1;
    // 本物と同じく、アカウントの投稿で、本文が prefix で始まるものだけ（FakeGitHub のアカウントは me）
    const own = this.reviewReplies.map((c, i) => ({
      id: 9000 + i + 1,
      number: c.number,
      author: authorOfToken(c.token),
      body: c.body,
    }));
    const foreign = this.foreignReviewComments.map((c, i) => ({ id: 8000 + i, ...c }));
    return [...foreign, ...own].flatMap((c) =>
      c.number === input.number &&
      c.body.trimStart().startsWith(input.prefix) &&
      (input.account === undefined || c.author === input.account)
        ? [
            {
              id: c.id,
              url: `${input.repo}/pull/${input.number}#discussion_r${c.id}`,
              body: c.body,
              author: c.author,
            },
          ]
        : [],
    );
  }
  /** 本文が prefix で始まるコメント（PBI-292）。id は issueComments の位置 + 1。 */
  listedAccounts: (string | undefined)[] = [];
  listFail?: string;
  async listIssueComments(input: {
    repo: string;
    number: number;
    prefix: string;
    account?: string;
    signal?: AbortSignal;
  }) {
    if (input.signal?.aborted) throw input.signal.reason;
    this.listedAccounts.push(input.account);
    if (this.listFail) throw new Error(this.listFail);
    // ほかの人の投稿（目印をまねた・引用したもの）は、アカウントを指定した読み取りには入らない
    const foreign = this.foreignIssueComments.flatMap((c, i) =>
      c.number === input.number &&
      c.body.trimStart().startsWith(input.prefix) &&
      (input.account === undefined || c.author === input.account)
        ? [
            {
              id: 8000 + i,
              url: `${input.repo}/issues/${input.number}#issuecomment-f${i}`,
              body: c.body,
              author: c.author,
            },
          ]
        : [],
    );
    return [
      ...foreign,
      ...this.issueComments.flatMap((c, i) =>
        c.repo === input.repo &&
        c.number === input.number &&
        c.body.trimStart().startsWith(input.prefix)
          ? [
              {
                id: i + 1,
                url: `${input.repo}/issues/${input.number}#issuecomment-${i + 1}`,
                body: c.body,
                author: authorOfToken(c.token),
              },
            ]
          : [],
      ),
    ];
  }
  /** PR のコメントの一覧に混ぜる、ほかの人の投稿（目印をまねた・引用したもの）。 */
  foreignIssueComments: { number: number; author: string; body: string }[] = [];
  editFail?: string;
  editAttempts = 0;
  async editIssueComment(input: { id: number; body: string; signal?: AbortSignal }) {
    if (input.signal?.aborted) throw input.signal.reason;
    this.editAttempts++;
    if (this.editFail) throw new Error(this.editFail);
    const comment = this.issueComments[input.id - 1];
    if (comment) comment.body = input.body;
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
  prInfo: PullRequestInfo = {
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "再試行の回数を設定できるようにする",
    body: "回数を環境変数で変えられるようにした",
    headSha: "h".repeat(40),
    baseSha: "b".repeat(40),
    author: "alice",
    /** 今レビューを依頼されている人（PBI-143）。 */
    requestedReviewers: [] as string[],
  };
  prInfoFail?: string;
  prInfoRequests: { repo: string; token: string; number: number }[] = [];
  async pullRequest(input: { repo: string; token: string; number: number }) {
    this.prInfoRequests.push(input);
    if (this.prInfoFail) throw new Error(this.prInfoFail);
    return this.prInfo;
  }
  /** 最後にレビューを依頼した日時（PBI-143）。 */
  lastRequestAt?: string;
  lastRequestFail?: string;
  lastRequestQueries: { repo: string; number: number; reviewer: string }[] = [];
  async lastReviewRequest(input: {
    repo: string;
    token: string;
    number: number;
    reviewer: string;
  }) {
    this.lastRequestQueries.push({
      repo: input.repo,
      number: input.number,
      reviewer: input.reviewer,
    });
    if (this.lastRequestFail) throw new Error(this.lastRequestFail);
    return this.lastRequestAt;
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
  /** 本文のある承認のレビューも含めるか（レビューの工程に渡す既存のレビューだけ true。PBI-144）。 */
  feedbackIncludeApprovals: (boolean | undefined)[] = [];
  /** 渡された、レビューが止まったことの投稿を除くための既知のアカウント（PBI-292）。 */
  feedbackNoticeAccounts: (readonly string[] | undefined)[] = [];
  /** sacty の、指摘への返信も含めるか（レビューの工程に渡す既存のレビューだけ true。PBI-352）。 */
  feedbackIncludeSactyReplies: (boolean | undefined)[] = [];
  /** 渡された、この PR を扱う sacty のタスクの ID（返信の目印のタスク ID と照らす。PBI-445）。 */
  feedbackSactyReplyTasks: (readonly string[] | undefined)[] = [];
  async feedback(input: {
    sactyReplyTasks?: readonly string[];
    account?: string;
    number: number;
    sactyReviews?: readonly SactyReviewRound[];
    includeApprovals?: boolean;
    noticeAccounts?: readonly string[];
    includeSactyReplies?: boolean;
  }) {
    this.feedbackNoticeAccounts.push(input.noticeAccounts);
    this.feedbackIncludeSactyReplies.push(input.includeSactyReplies);
    this.feedbackSactyReplyTasks.push(input.sactyReplyTasks);
    const allowed = (input.sactyReviews ?? []).filter((r) => r.allowed).map((r) => r.key);
    this.feedbackSactyReviews.push(allowed.length > 0 ? allowed : undefined);
    this.feedbackIncludeApprovals.push(input.includeApprovals);
    this.feedbackSactyRounds.push(input.sactyReviews);
    this.feedbackAccounts.push(input.account);
    this.feedbackNumbers.push(input.number);
    // 本物と同じく、sacty のレビューのタスクの投稿は、そのアカウントと回で判定し、ほかのプロジェクトのアカウントの
    // sacty のレビューは除く（PBI-88）
    // sacty のレビューのタスクの投稿には、本物と同じく、AI のレビューの印（source）を付ける（PBI-275）
    return (this.feedbackBy[input.number] ?? this.feedbackList).flatMap((item) => {
      // 本物と同じく、sacty が人の判断を待って止めたことを知らせる投稿（PBI-452）は、アカウントによらず取り込まない
      if (isDecisionNotice(item.body)) return [];
      const key = sactyReviewTask(item.body);
      const round = input.sactyReviews?.find((r) => r.key === key && r.account === item.author);
      // 投稿したレビューのタスクと回（目印の中身）も、本物と同じく添える（PBI-332）
      if (round) {
        return round.allowed ? [{ ...item, source: "sacty_review" as const, review: key }] : [];
      }
      // 本物と同じく、sacty の、指摘への返信（目印で始まる投稿）は、含める指定が無ければ除く（PBI-352。本物は、
      // sacty のアカウントの投稿だけを除く。それは github.test.ts で確かめる）
      if (!input.includeSactyReplies && item.body.trimStart().startsWith("<!-- sacty-reply:")) {
        return [];
      }
      // 本物と同じく、目印のタスク ID が、この PR を扱うタスクと一致する返信にだけ、sacty の返信の印を付ける（PBI-445）
      const replyTask = item.body.trimStart().startsWith("<!-- sacty-reply:")
        ? item.body.trimStart().slice("<!-- sacty-reply:".length).split(":")[0]
        : undefined;
      const marked =
        input.includeSactyReplies &&
        replyTask !== undefined &&
        (input.sactyReplyTasks ?? []).includes(replyTask)
          ? { ...item, bySacty: true as const }
          : item;
      return key !== undefined && item.author === input.account ? [] : [marked];
    });
  }
}

/** 決まった結果を順に返す偽物の実行器。渡された呼び出し内容も記録する。 */
/** 止められるまで終わらない実行（一時停止・中止のテスト用）。 */
export const HOLD = { kind: "hold" } as const;

/**
 * 指示を引数に戻した形（PBI-149 より前の形）。本物はエージェントへの指示を標準入力（invocation.stdin）で渡すが、指示の中身を
 * 確かめるテストがコマンドから読めるように、偽物の実行は戻した形で記録する（本物の形は agents.test.ts で確かめる）。
 */
export function withPromptArg(invocation: Invocation): Invocation {
  const { stdin, command } = invocation;
  if (stdin === undefined) return invocation;
  if (command[0] === "claude" && command[1] === "-p") {
    return { ...invocation, command: ["claude", "-p", stdin, ...command.slice(2)] };
  }
  if (command.at(-1) === "-" && command.at(-2) === "--") {
    return { ...invocation, command: [...command.slice(0, -1), stdin] };
  }
  return invocation;
}

/**
 * 秘密情報の取り出しを、合図のあとの最初の1回だけ止める（統合レビューの判定を読む前の待ちの間に、一時停止・
 * 中止を求めるため。PBI-298）。arm() のあとの最初の get が entered を解決し、gate が解けるまで返さない。
 */
export class GatedSecretStore extends MemorySecretStore {
  armed = false;
  entered = Promise.withResolvers<void>();
  gate = Promise.withResolvers<void>();
  arm() {
    this.armed = true;
  }
  override async get(name: string): Promise<string> {
    if (this.armed) {
      this.armed = false;
      this.entered.resolve();
      await this.gate.promise;
    }
    return super.get(name);
  }
}

export class FakeExecutor implements AgentExecutor {
  calls: Invocation[] = [];
  /** 実行ごとに標準入力で渡された指示（PBI-149）。 */
  stdins: (string | undefined)[] = [];
  /** 実行ごとの上限（ミリ秒。config.yaml の run_timeout。PBI-150）。 */
  timeouts: (number | undefined)[] = [];
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
  /** 実行ごとに、セッションログの標準出力に足す行（エージェントがファイルを読んだ記録の代わり。PBI-127）。 */
  logLines?: (invocation: Invocation) => string | undefined;
  /** 実行ごとに、作業領域を読み取り専用で渡したか。 */
  /** 実行ごとに、使い捨ての写し（実装の作業領域ではない）を渡したか。 */
  scratch: boolean[] = [];
  /** 実行ごとに、作業領域にあったファイル（実行の後に消されるので、実行の間に読んでおく）。 */
  workspaceFiles: string[][] = [];
  reviewDiffFiles: (string | undefined)[] = [];
  /** 実行ごとに、PR の差分と並べて置かれた、前回以降の差分のファイル（再レビューの絞り。PBI-432）。無ければ undefined。 */
  reviewSinceFiles: (string | undefined)[] = [];
  /** 実行ごとのイメージと、イメージの環境変数（PBI-41）。 */
  images: { image: string; env?: Record<string, string> }[] = [];
  /** 実行ごとにつないだネットワーク（PBI-47）。 */
  networks: (string | undefined)[] = [];
  /** 実行ごとに渡された、localhost に転送するポート（PBI-60）。 */
  forwards: (readonly LocalForward[] | undefined)[] = [];
  /** 実行ごとにマウントされた各実行のセッションログ（PBI-91）。無ければ undefined。 */
  logMounts: ({ readOnly: boolean; files: Record<string, string>; dir: string } | undefined)[] = [];
  /** 実行ごとにマウントされた、出典の分類の Input（要求要件・設計。実行の後に消される）。無ければ undefined。 */
  inputMounts: ({ readOnly: boolean; files: Record<string, string>; dir: string } | undefined)[] =
    [];
  /** 渡された実行から結果を作る（エージェントがマウントされたファイルを読んで答える代わり）。undefined なら outcomes の順。 */
  respond?: (invocation: Invocation) => AgentOutcome | undefined;
  async run({
    runId,
    image,
    invocation: actual,
    workspaceDir,
    imageEnv,
    network,
    forwards,
    log,
    timeoutMs,
  }: {
    runId: string;
    image: string;
    invocation: Invocation;
    workspaceDir: string;
    imageEnv?: Record<string, string>;
    network?: string;
    forwards?: readonly LocalForward[];
    log?: SessionLogSink;
    timeoutMs?: number;
  }): Promise<AgentOutcome> {
    this.timeouts.push(timeoutMs);
    // 本物は指示を標準入力で渡す（PBI-149）。標準入力に指示があることを記録し、指示は引数に戻した形で扱う
    this.stdins.push(actual.stdin);
    const invocation = withPromptArg(actual);
    this.calls.push(invocation);
    // セッションログ（PBI-62）には、渡された環境変数の値（秘密情報を含む）を出してみる（伏せられることを確かめる）
    log?.stdout(`${JSON.stringify({ type: "fake", env: Object.values(invocation.env) })}\n`);
    log?.stderr(`env ${Object.values(invocation.env).join(" ")}\n`);
    const extra = this.logLines?.(invocation);
    if (extra) log?.stdout(extra);
    this.networks.push(network);
    this.forwards.push(forwards);
    this.images.push({ image, ...(imageEnv ? { env: imageEnv } : {}) });
    this.dirs.push(workspaceDir);
    this.scratch.push(/[\\/]_(?:snapshots|guardian|code-copy)[\\/]/.test(workspaceDir));
    this.workspaceFiles.push(existsSync(workspaceDir) ? readdirSync(workspaceDir).sort() : []);
    // レビューの工程で別にマウントされる、PR の差分の全体のファイル（PBI-65。実行の後に消される）
    const reviewMount = invocation.mounts?.find((m) => m.containerPath === "/sacty-review");
    this.reviewDiffFiles.push(
      reviewMount ? readFileSync(join(reviewMount.hostPath, "pr.diff"), "utf8") : undefined,
    );
    this.reviewSinceFiles.push(
      reviewMount && existsSync(join(reviewMount.hostPath, "since.diff"))
        ? readFileSync(join(reviewMount.hostPath, "since.diff"), "utf8")
        : undefined,
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
    const inputMount = invocation.mounts?.find((m) => m.containerPath === "/sacty-input");
    this.inputMounts.push(
      inputMount
        ? {
            readOnly: inputMount.readOnly,
            files: readTree(inputMount.hostPath),
            dir: inputMount.hostPath,
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
    return this.withViewpointAssignment(invocation, this.withCompletion(invocation, outcome));
  }
  /**
   * true なら、分割の答えに、テスト観点の割り当てを足さない（割り当ての無い分割を確かめるテスト。PBI-348）。割り当てそのものを
   * 確かめるテストは、答えに自分で viewpoints か integrationViewpoints を書けば、足されない。
   */
  unassignedViewpoints = false;
  /**
   * 分割の工程の指示は、親の設計のテスト観点を、子タスクか統合レビューに割り当てるよう求める（PBI-348）。本物のエージェントが
   * 指示どおりに割り当てる代わりに、割り当てを書いていないテストの答えには、すべての観点を統合レビューで確かめる割り当てを
   * 足す（割り当てが無いと、sacty は子タスクを作らない。子タスクには割り当てないので、子タスクの実装は今までどおり進む）。
   */
  private withViewpointAssignment(invocation: Invocation, outcome: AgentOutcome): AgentOutcome {
    if (this.unassignedViewpoints || outcome.kind !== "completed") return outcome;
    const heading = "--- 承認済みのテスト観点 ---";
    const prompt = invocation.command.find((arg) => arg.includes(heading));
    if (!prompt || /"(?:viewpoints|integrationViewpoints)"/.test(outcome.output)) return outcome;
    const section = (prompt.split(heading)[1] ?? "").split("\n--- ")[0] ?? "";
    const ids = [...section.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1] ?? "");
    if (ids.length === 0) return outcome;
    const assigned = JSON.stringify(
      ids.map((id) => ({ id, reason: "子タスクを組み合わせた後に確かめる" })),
    );
    return {
      ...outcome,
      output: outcome.output.replace(
        /("sacty-split":\s*\{)/,
        `$1"integrationViewpoints":${assigned},`,
      ),
    };
  }
  /**
   * true なら、実装の工程の出力に、完了の申告を足さない（申告の無い実行を確かめるテスト。PBI-347）。申告そのものを確かめる
   * テストは、出力に自分で申告を書けば、足されない。
   */
  undeclaredCompletion = false;
  /**
   * 実装の工程の指示は、完了の申告（sacty-completion）を必ず付けるよう求める（PBI-347）。本物のエージェントが指示どおりに
   * 申告する代わりに、申告を書いていないテストの出力には、完了の申告を足す（申告が無いと、sacty は提出に進めない）。
   */
  private withCompletion(invocation: Invocation, outcome: AgentOutcome): AgentOutcome {
    if (this.undeclaredCompletion || outcome.kind !== "completed") return outcome;
    const asked = invocation.command.some((arg) => arg.includes("--- 完了の申告 ---"));
    if (!asked || outcome.output.includes(COMPLETION_FENCE)) return outcome;
    return {
      ...outcome,
      output: `${outcome.output}\n\n${completionBlock({ status: "complete" })}`,
    };
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
  /** HOLD の実行を、渡した結果で終える（PBI-128）。 */
  finishHeld(runId: string, outcome: AgentOutcome) {
    this.held.get(runId)?.(outcome);
    this.held.delete(runId);
  }
}

/** ディレクトリの下のファイル（相対パスと中身）。 */
export function readTree(root: string): Record<string, string> {
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
export const completed = (outputTokens: number): AgentOutcome => ({
  kind: "completed",
  output: "# 要求要件",
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: outputTokens },
});

/** 工程の見直し（オーケストレーター）の答え。skip が空なら、飛ばさずに進める。 */
export const stepReview = (skip: StepKey[] = [], reason = "要る"): AgentOutcome => ({
  kind: "completed",
  output: `\`\`\`json\n${JSON.stringify({ "sacty-step-review": { skip, reason } })}\n\`\`\``,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
});

export function makeService(
  activity: SqliteActivityStore,
  outcomes: AgentOutcome[] = [],
  options: {
    config?: () => ConfigResult;
    secrets?: Record<string, string>;
    repos?: FakeRepos;
    pulls?: FakePulls;
    /** レビューが止まったことの PR への知らせの期限（PBI-292）。 */
    stopNoticeTimeoutMs?: number;
    /** 指摘への返信の、投稿と投稿の間（ミリ秒。PBI-352）。 */
    remarkReplyIntervalMs?: number;
    /** 1件の記録に入れる、返信の結果の件数の上限（PBI-352）。 */
    remarkRepliesPerRecord?: number;
    /** GitHub のレート制限の待ちの保存（PBI-356）。 */
    rateLimits?: ServiceDeps["rateLimits"];
    /** 指摘への返信が制限に当たったときの、やり直しの決まり（PBI-356）。 */
    remarkReplyRateLimit?: ServiceDeps["remarkReplyRateLimit"];
    /** レビューのタスクが GitHub の一時的な失敗を自動でやり直すまでの待ち（ミリ秒。PBI-301）。 */
    reviewRetryDelaysMs?: readonly number[];
    projects?: MemoryProjectStore;
    settings?: MemorySettingsStore;
    contexts?: ContextFetcher;
    defaultContext?: string;
    github?: FakeGitHub;
    /** 知らせのタスクの画面の URL（SACTY_WEB_URL）。 */
    webUrl?: string;
    now?: () => number;
    planner?: ServiceDeps["planner"];
    /** オーケストレーターを差し替えず、エージェントで工程を選ばせる（PBI-17 のテスト）。 */
    realPlanner?: boolean;
    /** 情報収集を差し替える。既定は集めずに進める（realGatherer なら、エージェントで集める）。 */
    gatherer?: ServiceDeps["gatherer"];
    realGatherer?: boolean;
    gateway?: ServiceDeps["gateway"];
    /** 秘密情報の取り出し口を差し替える（1Password。PBI-34）。 */
    secretStore?: ServiceDeps["secrets"];
    platformProblems?: ServiceDeps["platformProblems"];
    hostMcpProblems?: ServiceDeps["hostMcpProblems"];
    imageProblems?: ServiceDeps["imageProblems"];
    hostMcpReady?: ServiceDeps["hostMcpReady"];
    contextMcp?: ServiceDeps["contextMcp"];
    notifier?: ServiceDeps["notifier"];
    feed?: ServiceDeps["feed"];
    /** sacty の新しい版の知らせ（PBI-135）。 */
    update?: ServiceDeps["update"];
    services?: ServiceRunner;
    sharedComposes?: SharedComposeFetcher;
    tickets?: ServiceDeps["tickets"];
    /** 要求要件・設計を PR のマージで承認する（PBI-57）。既定は、画面で承認する流れを確かめるので切る。 */
    stepPullRequests?: boolean;
    draftPullRequests?: boolean;
    /** ベースブランチの最新を作業領域に取り込む。既定は、取り込みを確かめるテスト以外では切る。 */
    mergeBase?: boolean;
    /** セッションログの置き場所（PBI-62）。 */
    sessionLogs?: SessionLogStore;
    /** オーケストレーターのセッションの置き場所（PBI-67）。 */
    orchestratorSessions?: OrchestratorSessionStore;
    /** PR テンプレートを探す口（PBI-87）。 */
    templates?: ServiceDeps["templates"];
    /** マージのコミットの CI/CD の状態（PBI-89）。 */
    ci?: ServiceDeps["ci"];
    /** 完了したタスクを監査する（PBI-125）。既定は監査しない。 */
    audit?: boolean;
    /** sacty が作った PR をレビューする子タスクを作る（PBI-330）。既定は作らない。 */
    reviewTasks?: boolean;
    /** リスク評価を有効にする（PBI-429。実装の PR のレビューの子タスクが、指摘なしの回に評価する）。既定は無効。 */
    riskAssessment?: boolean;
    /** レビューの子タスクが CI を読むのを待つ上限（ミリ秒。PBI-331）。 */
    reviewCiTimeoutMs?: number;
    /** ドラフトを外す・戻す・先頭を読む答えを待つ上限（ミリ秒。PBI-331）。 */
    draftTimeoutMs?: number;
    /** メモリーを書き出す（PBI-126）。既定は書き出さない。 */
    memory?: boolean;
    /** 階層ごとのメモリーの件数の上限（PBI-126）。 */
    memoryLimit?: number;
    /** 動いているコンテナがマウントしている場所（PBI-157）。既定は、動いているコンテナが無い。 */
    containerMounts?: ServiceDeps["containerMounts"];
    /** コンテキストのイメージ（PBI-325）。 */
    contextImages?: ServiceDeps["contextImages"];
    contextImagesWaitMs?: number;
  } = {},
) {
  const executor = new FakeExecutor(outcomes);
  const repos = options.repos ?? new FakeRepos();
  const pulls = options.pulls ?? new FakePulls();
  const service = new TaskService({
    activity,
    ...(options.webUrl !== undefined ? { webUrl: options.webUrl } : {}),
    config: options.config ?? configOf(agent()),
    secrets:
      options.secretStore ??
      new MemorySecretStore(
        options.secrets ?? { "claude-oauth-token": "oauth-secret", "github-token": "ghp_secret" },
      ),
    executor,
    repos,
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
    ...(options.stopNoticeTimeoutMs ? { stopNoticeTimeoutMs: options.stopNoticeTimeoutMs } : {}),
    // 指摘への返信（PBI-352）の、投稿と投稿の間は、確かめるテストのほかでは置かない
    remarkReplyIntervalMs: options.remarkReplyIntervalMs ?? 0,
    ...(options.remarkRepliesPerRecord
      ? { remarkRepliesPerRecord: options.remarkRepliesPerRecord }
      : {}),
    ...(options.rateLimits ? { rateLimits: options.rateLimits } : {}),
    ...(options.remarkReplyRateLimit ? { remarkReplyRateLimit: options.remarkReplyRateLimit } : {}),
    ...(options.reviewRetryDelaysMs ? { reviewRetryDelaysMs: options.reviewRetryDelaysMs } : {}),
    // 情報収集は、既定では集めずに進める（情報収集のテストでは差し替える）
    ...(options.realGatherer ? {} : { gatherer: options.gatherer ?? (async () => undefined) }),
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
    ...(options.imageProblems ? { imageProblems: options.imageProblems } : {}),
    ...(options.hostMcpReady ? { hostMcpReady: options.hostMcpReady } : {}),
    ...(options.contextMcp ? { contextMcp: options.contextMcp } : {}),
    ...(options.notifier ? { notifier: options.notifier } : {}),
    ...(options.feed ? { feed: options.feed } : {}),
    ...(options.update ? { update: options.update } : {}),
    ...(options.services ? { services: options.services } : {}),
    ...(options.sharedComposes ? { sharedComposes: options.sharedComposes } : {}),
    ...(options.tickets ? { tickets: options.tickets } : {}),
    stepPullRequests: options.stepPullRequests ?? false,
    // 実装の PR をドラフトで作り、レビューの子タスクの指摘なしを待つ流れは、既定では切る（そのテストでは入れる）
    draftPullRequests: options.draftPullRequests ?? false,
    mergeBase: options.mergeBase ?? false,
    ...(options.sessionLogs ? { sessionLogs: options.sessionLogs } : {}),
    ...(options.orchestratorSessions ? { orchestratorSessions: options.orchestratorSessions } : {}),
    ...(options.templates ? { templates: options.templates } : {}),
    ...(options.ci ? { ci: options.ci } : {}),
    ...(options.audit ? { audit: true } : {}),
    ...(options.reviewTasks ? { reviewTasks: true } : {}),
    ...(options.riskAssessment ? { riskAssessment: true } : {}),
    ...(options.reviewCiTimeoutMs ? { reviewCiTimeoutMs: options.reviewCiTimeoutMs } : {}),
    ...(options.draftTimeoutMs ? { draftTimeoutMs: options.draftTimeoutMs } : {}),
    ...(options.memory ? { memoryRoot: join(dir, "memory") } : {}),
    ...(options.memoryLimit ? { memoryLimit: options.memoryLimit } : {}),
    ...(options.containerMounts ? { containerMounts: options.containerMounts } : {}),
    ...(options.contextImages ? { contextImages: options.contextImages } : {}),
    ...(options.contextImagesWaitMs !== undefined
      ? { contextImagesWaitMs: options.contextImagesWaitMs }
      : {}),
  });
  return { service, executor, repos, pulls };
}

/** チケットの管理のサービス（JIRA）の偽物（PBI-52）。コメントを記録する。 */
export class FakeTickets implements TicketClient {
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
export const jiraPlatform = () =>
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
export const fakeGateway = (): NonNullable<ServiceDeps["gateway"]> => ({
  containerOrigin: () => "http://host.docker.internal:5001",
  platformsUrl: (token) => `http://host.docker.internal:5001/r/${token}/pf`,
  githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
  register: () => ({
    token: "sacty-gw-run",
    stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
    close: () => {},
  }),
});

/** 登録した実行の許可リスト（register の 4 つめの引数）を記録するゲートウェイの偽物（PBI-131）。 */
export const recordingGateway = () => {
  const access: unknown[] = [];
  const gateway: NonNullable<ServiceDeps["gateway"]> = {
    ...fakeGateway(),
    register: (...args: unknown[]) => {
      access.push(args[3]);
      return fakeGateway().register();
    },
  };
  return { gateway, access };
};

/** チケットの取り込みの1段目の出力（PBI-52）。 */
export const triageOut = (v: Record<string, unknown>, output = 100): AgentOutcome => ({
  kind: "completed",
  output: `読みました\n\n\`\`\`json\n${JSON.stringify({ "sacty-ticket": v })}\n\`\`\``,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output },
});

export const foundTicket = (key: string, summary = `${key} の要約`): FoundTicket => ({
  platform: "jira",
  service: "jira-server",
  key,
  summary,
  url: `https://jira.example.com/browse/${key}`,
});

/**
 * 待たずに送る処理（レビューが止まったことの PR への知らせと、順に処理するもの：人に確かめてほしいことの PR への知らせ・
 * 指摘への返信の投稿）が、すべて終わるまで待つ。これらは、タスクの状態が変わったときに同期で登録され、終わると登録が消える。
 * 登録が無ければ（送るものが無い）、すぐに戻る。本体に、これを待つ口は無いので、登録の表（private）を直接見る。
 * 表の名前が変わったら、ここが例外で落ちる（黙って通らない）。
 * 順に処理する仕組み（serialTails）に、長く終わらない処理を登録するようになったら、これは期限まで待ってから落ちる。
 * そのときは、ここで待つ対象を見直す。
 */
export function noticesSettled(service: TaskService): Promise<void> {
  const internals = service as unknown as {
    stopNotices: Map<string, Promise<void>>;
    serialTails: Map<string, Promise<void>>;
  };
  return waitFor(() => internals.stopNotices.size === 0 && internals.serialTails.size === 0, {
    what: "待たずに送る処理（PR への知らせ・返信の投稿）の終わり",
  });
}

/**
 * 終わっていないものとして数えている、PR のドラフトの切り替えの要求が、無くなるまで待つ（要求が終わるか、中断に応じない要求を
 * 数えるのをやめる上限を過ぎるまで）。noticesSettled と同じく、本体に待つ口が無いので、数の表（private）を直接見る。
 */
export function draftRequestsSettled(service: TaskService): Promise<void> {
  const internals = service as unknown as { draftRequests: Map<string, number> };
  return waitFor(() => internals.draftRequests.size === 0, {
    what: "終わっていないドラフトの切り替えの要求が、無くなること",
  });
}

/** 画面が表示している（いま承認待ちの）提出回。 */
export const current = (svc: TaskService, id: string) => {
  const t = svc.get(id)?.task;
  const step = t?.gate?.step ?? t?.escalation?.step ?? "requirements";
  return t?.gate?.submission ?? t?.submissions[step] ?? 1;
};
