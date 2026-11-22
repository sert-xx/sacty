import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CiCheck, DaemonText, Remark, StepKey, Task } from "@sacty/core";
import {
  activeStep,
  budgetState,
  canOverrideVerification,
  changeRounds,
  deliveredWithoutChanges,
  discardedAiReviews,
  heldReview,
  isCompleted,
  lastChangeRound,
  MAX_BASE_CONFLICTS,
  MAX_VERIFY_ATTEMPTS,
  MVP_STEPS,
  message,
  PR_CI_FAILED_CHECKS_MAX,
  pendingHeadMerge,
  pullRequestCiFailure,
  pullRequestConflict,
  RESUME_NOTE_HEADING,
  renderMessage,
  resumeNoteRoom,
  STEP_PLANS,
  stepRunning,
  TASK_BODY_MAX,
  TASK_TITLE_MAX,
} from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { SqliteActivityStore } from "./activity.js";
import type { Invocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { CiStatusReader } from "./ci.js";
import { COMPLETION_FENCE } from "./completion.js";
import type { ConfigResult, SactyConfig } from "./config.js";
import { AgentTimeoutError, MessageError } from "./errors.js";
import type { PullRequestFeedback, PullRequestInfo, PullRequestStatus } from "./github.js";
import { GitHubRateLimitStore } from "./github-rate-limits.js";
import { unlinkedGeneratedBody, unlinkedMergedBody } from "./pr-body-links.js";
import { convertWorkspaceLinks } from "./pr-body-links-worker.js";
import { BODY_BEGIN, BODY_END } from "./pr-body-merge.js";
import { PR_BODY_MAX } from "./pr-template.js";
import { MemoryProjectStore } from "./projects.js";
import { buildPullRequestBody } from "./prompts.js";
import { GitRepositoryWorkspace } from "./repository.js";
import { isOpenStopNotice } from "./review-stop-notice.js";
import { createApp } from "./server.js";
import {
  awaitingRemarkReplies,
  FEEDBACK_QUIET_MS,
  InvalidOperationError,
  PR_CI_READ_INTERVAL_MS,
  PR_CI_READS_MAX,
  type ServiceDeps,
  type TaskService,
} from "./service.js";
import type { ServiceRunner } from "./services.js";
import { SessionLogStore } from "./session-logs.js";
import { MemorySettingsStore } from "./settings.js";
import type { SharedComposeFetcher } from "./shared-compose.js";
import {
  agent,
  appendLegacy,
  completed,
  configOf,
  dbPath,
  dir,
  type FakeExecutor,
  FakeGitHub,
  FakePulls,
  FakeRepos,
  FakeServices,
  FakeSharedComposes,
  FakeTickets,
  fakeGateway,
  foundTicket,
  HOLD,
  ja,
  jiraPlatform,
  makeService,
  noticesSettled,
  projectsWithAccount,
  rateLimitError,
  stepReview,
  triageOut,
  useTempDir,
} from "./testing/daemon.js";
import { idleFor, loopTurn, waitFor, waitForAssertion } from "./testing/wait.js";

useTempDir();

// 作業領域へのリンクを外す処理は、ふだんは本物を動かす（別スレッドで解析する）。外せなかったとき（時間切れ・失敗）の
// サービスの扱いは、テストごとに結果を差し替えて確かめる（PBI-372。本物で起こすと、時間やスタックの大きさに依存する）
vi.mock("./pr-body-links.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./pr-body-links.js")>();
  return {
    ...actual,
    unlinkedGeneratedBody: vi.fn(actual.unlinkedGeneratedBody),
    unlinkedMergedBody: vi.fn(actual.unlinkedMergedBody),
  };
});

/** 変換の本体を、このスレッドで直接呼ぶ（外した後の本文）。変換の途中の例外が無かったことも、ここで確かめる。 */
const withoutWorkspaceLinks = (body: string) => {
  const converted = convertWorkspaceLinks(body, "/workspace");
  expect(converted.failed).toBeUndefined();
  return converted.body;
};

/** 警告のログのうち、作業領域へのリンクを外せなかったことの行。 */
const linksKeptLogs = (warn: { mock: { calls: unknown[][] } }) =>
  warn.mock.calls
    .map((call) => String(call[0]))
    .filter((line) => line.includes("作業領域へのリンクを外せませんでした"));

const skillWriteFailure = vi.hoisted(() => ({ enabled: false }));
vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    writeFileSync: (...args: Parameters<typeof original.writeFileSync>) => {
      if (
        skillWriteFailure.enabled &&
        String(args[0]).endsWith("skills/docker-services/SKILL.md") &&
        String(args[1]).includes("db:5432")
      ) {
        throw new Error("skill write failed");
      }
      return original.writeFileSync(...args);
    },
  };
});

describe("実装の工程と実装の PR（PBI-10a）", () => {
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
    map: { viewpointId: string; tests: string[]; untested?: string }[] = [
      { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] },
      { viewpointId: "TV-2", tests: ["pay.test.ts › キーなし"] },
    ],
  ) => out([text, block({ "sacty-test-map": map })].join("\n\n"));
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  const types = (svc: TaskService, id: string) => svc.get(id)?.activity.map((e) => e.type) ?? [];

  /** 要求要件（差し戻し1回）と設計を承認し、実装の工程が実行待ちになったところまで進める。 */
  async function toImplement(
    outcomes: AgentOutcome[],
    options: {
      repos?: FakeRepos;
      pulls?: FakePulls;
      config?: () => ConfigResult;
      now?: () => number;
      planner?: ServiceDeps["planner"];
      services?: ServiceRunner;
      sharedComposes?: SharedComposeFetcher;
      projects?: MemoryProjectStore;
      /** メモリーを書き出す・渡す（PBI-126）。 */
      memory?: boolean;
      /** 実装の PR をドラフトで作り、レビューの子タスクの指摘なしを待つ。 */
      draftPullRequests?: boolean;
      /** ベースブランチの最新を作業領域に取り込む。 */
      mergeBase?: boolean;
      ci?: CiStatusReader;
      sessionLogs?: SessionLogStore;
      secretStore?: ServiceDeps["secrets"];
      /** PR テンプレートを探す（PBI-87）。 */
      templates?: ServiceDeps["templates"];
      stopNoticeTimeoutMs?: number;
      remarkReplyIntervalMs?: number;
      remarkRepliesPerRecord?: number;
      rateLimits?: ServiceDeps["rateLimits"];
      remarkReplyRateLimit?: ServiceDeps["remarkReplyRateLimit"];
      github?: FakeGitHub;
      /** 承認する要求要件（2 回目の提出）の全文。 */
      requirements?: string;
      /** 知らせのタスクの画面の URL（SACTY_WEB_URL）。 */
      webUrl?: string;
      /** push のやり直しの待ち時間（PBI-467）。 */
      pushRetryDelaysMs?: readonly number[];
    } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const made = makeService(
      activity,
      [out("# 要求要件 v1"), out(options.requirements ?? "# 要求要件 v2"), design, ...outcomes],
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

  it("実際の Git 作業領域で整形だけのファイルを戻してから残りを提出する", async () => {
    const origin = join(dir, "format-origin");
    mkdirSync(origin);
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: origin, encoding: "utf8" }).trim();
    git("init", "--initial-branch=main");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    const original = "export const data = { first: 1, second: 2 };\n";
    const formatted = "export const data = {\n  first: 1,\n  second: 2,\n};\n";
    writeFileSync(join(origin, "a.ts"), original);
    writeFileSync(join(origin, "b.ts"), original);
    git("add", "--all");
    git("commit", "-m", "base");
    class GitBackedRepos extends FakeRepos {
      readonly git = new GitRepositoryWorkspace();
      clone = "";
      metadata = "";
      publishedDiff: string[] = [];
      async prepare(work: string, metadata: string) {
        this.clone = work;
        this.metadata = metadata;
        return this.git.prepare(work, metadata, origin, undefined);
      }
      async treeId(work: string, metadata: string, base: string) {
        return this.git.treeId(work, metadata, base);
      }
      async treeChanges(metadata: string, from: string, to: string) {
        return this.git.treeChanges(metadata, from, to);
      }
      async treeBlob(metadata: string, object: string) {
        return this.git.treeBlob(metadata, object);
      }
      async publish(input: Parameters<FakeRepos["publish"]>[0]) {
        const tree = await this.git.treeId(this.clone, this.metadata, input.baseCommit ?? "");
        this.publishedDiff = (
          await this.git.treeChanges(this.metadata, input.baseCommit ?? "", tree)
        ).map((c) => c.path);
        return super.publish(input);
      }
    }
    const repos = new GitBackedRepos();
    const pulls = new FakePulls();
    const { activity, service, executor, id } = await toImplement(
      [implement("# 実装"), implement("# 整形を戻した")],
      { repos, pulls },
    );
    let runs = 0;
    executor.respond = (invocation) => {
      if (invocation.command.join(" ").includes("テスト観点（承認済み")) {
        if (++runs === 1) {
          writeFileSync(join(repos.clone, "a.ts"), formatted);
          writeFileSync(join(repos.clone, "b.ts"), `${formatted}export function added() {}\n`);
        } else {
          const patch = execFileSync("git", ["diff", "--", "a.ts"], { cwd: repos.clone });
          execFileSync("git", ["apply", "--reverse"], { cwd: repos.clone, input: patch });
        }
      }
      return undefined;
    };
    await service.runNext(id);
    await service.runNext(id);
    expect(pulls.calls).toHaveLength(0);
    expect(
      service
        .get(id)
        ?.activity.filter((event) => event.type === "FormattingOnlyRejected")
        .at(-1)?.payload,
    ).toEqual({ count: 1 });
    await drain(service);
    const retryPrompt = promptOf(executor, executor.calls.length - 1);
    expect(retryPrompt).toContain("a.ts");
    expect(retryPrompt).toContain("git diff で差分を見て、自分の整形の変更だけを戻す");
    expect(retryPrompt).toContain("ファイルを丸ごと書き戻さず");
    expect(retryPrompt).toContain("sacty-formatting");
    expect(retryPrompt).not.toContain("+export const data");
    expect(repos.publishedDiff).toEqual(["b.ts"]);
    expect(readFileSync(join(repos.clone, "b.ts"), "utf8")).toBe(
      `${formatted}export function added() {}\n`,
    );
    expect(pulls.calls).toHaveLength(1);
    activity.close();
  });

  it("未申告の整形を2回検出し、上限後は件数を本文に載せる", async () => {
    const repos = new FakeRepos();
    const pulls = new FakePulls();
    const base = repos.tree;
    const submitted = "a".repeat(40);
    repos.treeDiffs.set(`${base}:${submitted}`, [
      {
        status: "M",
        path: "a.ts",
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      },
      {
        status: "M",
        path: "c.ts",
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      },
    ]);
    repos.treeBlobs.set("old", "const x = { a: 1, b: 2 };\n");
    repos.treeBlobs.set("new", "const x = {\n  a: 1,\n  b: 2,\n};\n");
    const { activity, service, executor, id } = await toImplement(
      [implement("# 実装"), implement("# 出し直し"), implement("# 出し直し 2")],
      { repos, pulls },
    );
    await service.runNext(id);
    repos.tree = submitted;
    await service.runNext(id);
    expect(types(service, id).filter((type) => type === "FormattingOnlyRejected")).toHaveLength(1);
    expect(pulls.calls).toHaveLength(0);
    await service.runNext(id);
    expect(promptOf(executor, executor.calls.length - 1)).toContain("a.ts");
    expect(promptOf(executor, executor.calls.length - 1)).toContain("c.ts");
    await service.runNext(id);
    expect(types(service, id).filter((type) => type === "FormattingOnlyRejected")).toHaveLength(2);
    await drain(service);
    expect(service.get(id)?.task.formattingCheck).toEqual({ remained: 2, declared: [] });
    expect(
      service
        .get(id)
        ?.activity.filter((event) => event.type === "FormattingOnlyRejected")
        .map((event) => event.payload),
    ).toEqual([{ count: 2 }, { count: 2 }]);
    expect(promptOf(executor, executor.calls.length - 1)).toContain("a.ts");
    expect(promptOf(executor, executor.calls.length - 1)).toContain("c.ts");
    const finalTask = service.get(id)?.task;
    if (!finalTask) throw new Error("task missing");
    expect(buildPullRequestBody(finalTask)).toContain(
      "整形だけで変わったファイルが 2 件残っています",
    );
    expect(buildPullRequestBody(finalTask)).not.toContain("a.ts");
    expect(buildPullRequestBody(finalTask)).not.toContain("c.ts");
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("a.ts");
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("c.ts");
    activity.close();
  });

  it("依頼された整形の申告を記録し、出し直さず本文に示す", async () => {
    const repos = new FakeRepos();
    repos.diffFileList = [{ status: "M", path: "a.ts" }];
    const base = repos.tree;
    const submitted = "a".repeat(40);
    repos.treeDiffs.set(`${base}:${submitted}`, [
      {
        status: "M",
        path: "a.ts",
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      },
    ]);
    repos.treeBlobs.set("old", "const x = { a: 1 };\n");
    repos.treeBlobs.set("new", "const x = {\n  a: 1,\n};\n");
    const { activity, service, executor, id } = await toImplement(
      [
        implement(
          `# 実装\n\n${block({ "sacty-formatting": { files: [{ path: "a.ts", reason: "依頼の整形" }] } })}`,
        ),
      ],
      { repos },
    );
    executor.respond = (invocation) => {
      if (invocation.command.join(" ").includes("テスト観点（承認済み")) repos.tree = submitted;
      return undefined;
    };
    await drain(service);
    expect(types(service, id)).not.toContain("FormattingOnlyRejected");
    expect(service.get(id)?.task.formattingCheck).toEqual({
      remained: 0,
      declared: [{ path: "a.ts", reason: "依頼の整形" }],
    });
    const finalTask = service.get(id)?.task;
    if (!finalTask) throw new Error("task missing");
    expect(buildPullRequestBody(finalTask)).toContain("a.ts: 依頼の整形");
    activity.close();
  });

  it("前の実装で申告した整形は、直しの回で再申告しなくても残る", async () => {
    const repos = new FakeRepos();
    repos.diffFileList = [{ status: "M", path: "a.ts" }];
    const base = repos.tree;
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const change = (oldObject: string, newObject: string) => ({
      status: "M",
      path: "a.ts",
      oldMode: "100644",
      newMode: "100644",
      oldObject,
      newObject,
    });
    repos.treeDiffs.set(`${base}:${first}`, [change("old", "first")]);
    repos.treeDiffs.set(`${first}:${second}`, [change("first", "second")]);
    repos.treeBlobs.set("old", "const x={a:1};");
    repos.treeBlobs.set("first", "const x = { a: 1, };");
    repos.treeBlobs.set("second", "const x = {\n  a: 1,\n};");
    const declaration = block({
      "sacty-formatting": { files: [{ path: "a.ts", reason: "依頼の整形" }] },
    });
    const { activity, service, executor, id } = await toImplement(
      [implement(`# 実装\n\n${declaration}`), implement("# 直し")],
      { repos },
    );
    executor.respond = () => {
      repos.tree = first;
      return undefined;
    };
    await drain(service);
    service.requestChanges(id, { step: "implement", submission: 1, comments: ["直す"] });
    executor.respond = () => {
      repos.tree = second;
      return undefined;
    };
    await drain(service);
    expect(types(service, id)).not.toContain("FormattingOnlyRejected");
    expect(service.get(id)?.task.formattingCheck?.declared).toEqual([
      { path: "a.ts", reason: "依頼の整形" },
    ]);
    activity.close();
  });

  it("直しの回で触れていない申告済みファイルも PR の申告に残る", async () => {
    const repos = new FakeRepos();
    repos.diffFileList = [
      { status: "M", path: "a.ts" },
      { status: "M", path: "b.ts" },
    ];
    const base = repos.tree;
    const first = "a".repeat(40);
    const second = "b".repeat(40);
    const change = (path: string, oldObject: string, newObject: string) => ({
      status: "M",
      path,
      oldMode: "100644",
      newMode: "100644",
      oldObject,
      newObject,
    });
    repos.treeDiffs.set(`${base}:${first}`, [change("a.ts", "old", "formatted")]);
    repos.treeDiffs.set(`${first}:${second}`, [change("b.ts", "old", "changed")]);
    repos.treeBlobs.set("old", "const x={a:1};");
    repos.treeBlobs.set("formatted", "const x = { a: 1, };");
    repos.treeBlobs.set("changed", "const x={a:2};");
    const declaration = block({
      "sacty-formatting": { files: [{ path: "a.ts", reason: "依頼の整形" }] },
    });
    const { activity, service, executor, id } = await toImplement(
      [implement(`# 実装\n\n${declaration}`), implement("# 直し")],
      { repos },
    );
    executor.respond = () => {
      repos.tree = first;
      return undefined;
    };
    await drain(service);
    service.requestChanges(id, { step: "implement", submission: 1, comments: ["直す"] });
    executor.respond = () => {
      repos.tree = second;
      return undefined;
    };
    await drain(service);
    expect(service.get(id)?.task.formattingCheck?.declared).toEqual([
      { path: "a.ts", reason: "依頼の整形" },
    ]);
    activity.close();
  });

  it("整形だけを戻した出し直しを受け付け、残った機能変更を保持する", async () => {
    const repos = new FakeRepos();
    const pulls = new FakePulls();
    const base = repos.tree;
    const submitted = "a".repeat(40);
    const fixed = "b".repeat(40);
    const formatting = {
      status: "M",
      path: "a.ts",
      oldMode: "100644",
      newMode: "100644",
      oldObject: "old",
      newObject: "new",
    };
    const functional = {
      status: "M",
      path: "b.ts",
      oldMode: "100644",
      newMode: "100644",
      oldObject: "old",
      newObject: "function",
    };
    repos.treeDiffs.set(`${base}:${submitted}`, [formatting, functional]);
    repos.treeDiffs.set(`${base}:${fixed}`, [functional]);
    repos.treeBlobs.set("old", "const x = { a: 1 };\n");
    repos.treeBlobs.set("new", "const x = {\n  a: 1,\n};\n");
    repos.treeBlobs.set("function", "const x = {\n  a: 1,\n};\nfunction added() {}\n");
    const { activity, service, executor, id } = await toImplement(
      [implement("# 実装"), implement("# 戻した")],
      { repos, pulls },
    );
    await service.runNext(id);
    repos.tree = submitted;
    await service.runNext(id);
    expect(pulls.calls).toHaveLength(0);
    executor.respond = () => {
      repos.tree = fixed;
      return undefined;
    };
    await drain(service);
    expect(promptOf(executor, executor.calls.length - 1)).toContain("a.ts");
    expect(types(service, id).filter((type) => type === "FormattingOnlyRejected")).toHaveLength(1);
    expect(service.get(id)?.task.formattingCheck).toBeUndefined();
    expect(pulls.calls).toHaveLength(1);
    activity.close();
  });

  it("整形をすべて戻した提出は変更なしとして PR を作らない", async () => {
    const repos = new FakeRepos();
    const pulls = new FakePulls();
    const base = repos.tree;
    const submitted = "a".repeat(40);
    repos.treeDiffs.set(`${base}:${submitted}`, [
      {
        status: "M",
        path: "a.ts",
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      },
    ]);
    repos.treeBlobs.set("old", "const x={a:1};");
    repos.treeBlobs.set("new", "const x = { a: 1, };");
    const { activity, service, executor, id } = await toImplement(
      [implement("# 実装"), implement("# 戻した")],
      { repos, pulls },
    );
    await service.runNext(id);
    repos.tree = submitted;
    await service.runNext(id);
    executor.respond = () => {
      repos.tree = base;
      repos.unchanged = true;
      return undefined;
    };
    await drain(service);
    expect(types(service, id)).toContain("NoChangesFound");
    expect(pulls.calls).toHaveLength(0);
    expect(service.get(id)?.task.formattingCheck).toBeUndefined();
    activity.close();
  });

  it("未完了の続きで起点を保持し、取り込みで変わったファイルを除外する", async () => {
    const repos = new FakeRepos();
    const base = repos.tree;
    const before = "a".repeat(40);
    const after = "b".repeat(40);
    const change = (path: string) => ({
      status: "M",
      path,
      oldMode: "100644",
      newMode: "100644",
      oldObject: "old",
      newObject: "new",
    });
    repos.treeDiffs.set(`${base}:${after}`, [change("a.ts"), change("r.ts")]);
    repos.treeDiffs.set(`${before}:${after}`, [change("r.ts")]);
    repos.treeBlobs.set("old", "const x = { a: 1 };\n");
    repos.treeBlobs.set("new", "const x = {\n  a: 1,\n};\n");
    repos.branchHead = repos.head;
    const incomplete = out(
      [
        implement("# 実装").output,
        `\`\`\`sacty-completion\n${JSON.stringify({ status: "incomplete", remaining: ["続き"] })}\n\`\`\``,
      ].join("\n\n"),
    );
    const { activity, service, executor, id } = await toImplement(
      [incomplete, implement("# 完了"), implement("# 続き")],
      { repos, mergeBase: true },
    );
    await service.runNext(id);
    repos.tree = before;
    await service.runNext(id);
    repos.branchHead = "c".repeat(40);
    const originalMerge = repos.mergeBase.bind(repos);
    vi.spyOn(repos, "mergeBase").mockImplementation(async (input) => {
      const result = await originalMerge(input);
      repos.tree = after;
      return result;
    });
    await service.runNext(id);
    const starts =
      service
        .get(id)
        ?.activity.filter(
          (event) => event.type === "AgentRunStarted" && event.payload.step === "implement",
        ) ?? [];
    expect(starts.at(-1)?.payload).toMatchObject({
      formattingBaseline: { tree: base, merged: [{ before, after }] },
    });
    await service.runNext(id);
    expect(
      service
        .get(id)
        ?.activity.filter((event) => event.type === "FormattingOnlyRejected")
        .at(-1)?.payload,
    ).toEqual({ count: 1 });
    await service.runNext(id);
    const prompt = promptOf(executor, executor.calls.length - 1);
    expect(prompt).toContain("a.ts");
    expect(prompt).not.toContain("- r.ts");
    activity.close();
  });

  it("取り込み記録の直後に停止しても、再開後は取り込んだファイルを除外する", async () => {
    const repos = new FakeRepos();
    const baseline = repos.tree;
    const submitted = "a".repeat(40);
    const from = "b".repeat(40);
    const to = "c".repeat(40);
    const change = (path: string) => ({
      status: "M",
      path,
      oldMode: "100644",
      newMode: "100644",
      oldObject: "old",
      newObject: "new",
    });
    repos.treeDiffs.set(`${baseline}:${submitted}`, [change("a.ts"), change("r.ts")]);
    repos.treeDiffs.set(`${from}:${to}`, [change("r.ts")]);
    repos.treeBlobs.set("old", "const x={a:1};");
    repos.treeBlobs.set("new", "const x = { a: 1, };");
    const incomplete = out(
      [
        implement("# 未完了").output,
        `\`\`\`sacty-completion\n${JSON.stringify({ status: "incomplete", remaining: ["続き"] })}\n\`\`\``,
      ].join("\n\n"),
    );
    const { activity, service, id } = await toImplement([incomplete], { repos });
    await service.runNext(id);
    repos.tree = submitted;
    await service.runNext(id);
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: { type: "BaseBranchMerged", payload: { from, commit: to, conflicts: [] } },
        },
      ],
    });
    const restarted = makeService(activity, [implement("# 続き"), implement("# 整形の修正")], {
      repos,
    });
    await restarted.service.runNext(id);
    const starts = (restarted.service.get(id)?.activity ?? []).filter(
      (event) => event.type === "AgentRunStarted" && event.payload.step === "implement",
    );
    expect(starts.at(-1)?.payload).toMatchObject({
      formattingBaseline: { tree: baseline, merged: [{ before: from, after: to }] },
    });
    await restarted.service.runNext(id);
    expect(
      restarted.service
        .get(id)
        ?.activity.filter((event) => event.type === "FormattingOnlyRejected")
        .at(-1)?.payload,
    ).toEqual({ count: 1 });
    await restarted.service.runNext(id);
    const prompt = promptOf(restarted.executor, restarted.executor.calls.length - 1);
    expect(prompt).toContain("- a.ts");
    expect(prompt).not.toContain("- r.ts");
    activity.close();
  });

  it("続きの実行前の取り込みが失敗しても起点を引き継ぐ", async () => {
    const repos = new FakeRepos();
    repos.branchHead = repos.head;
    const base = repos.tree;
    const submitted = "a".repeat(40);
    repos.treeDiffs.set(`${base}:${submitted}`, [
      {
        status: "M",
        path: "a.ts",
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      },
    ]);
    repos.treeBlobs.set("old", "const x={a:1};");
    repos.treeBlobs.set("new", "const x = { a: 1, };");
    const unfinished = out(
      `${implement("# 未完了").output}\n\n\`\`\`sacty-completion\n${JSON.stringify({ status: "incomplete", remaining: ["続き"] })}\n\`\`\``,
    );
    const { activity, service, id } = await toImplement([unfinished, implement("# 完了")], {
      repos,
      mergeBase: true,
    });
    await service.runNext(id);
    repos.tree = submitted;
    await service.runNext(id);
    repos.branchHead = "b".repeat(40);
    const original = repos.mergeBase.bind(repos);
    const merge = vi.spyOn(repos, "mergeBase").mockRejectedValueOnce(new Error("merge failed"));
    await service.runNext(id);
    expect(
      service
        .get(id)
        ?.activity.filter((e) => e.type === "AgentRunFailed")
        .at(-1)?.payload,
    ).toMatchObject({
      preparationFailed: true,
    });
    merge.mockImplementation(original);
    service.resume(id, {});
    await service.runNext(id);
    const starts =
      service
        .get(id)
        ?.activity.filter(
          (event) => event.type === "AgentRunStarted" && event.payload.step === "implement",
        ) ?? [];
    expect(starts.at(-1)?.payload.formattingBaseline?.tree).toBe(base);
    await service.runNext(id);
    expect(
      service
        .get(id)
        ?.activity.filter((e) => e.type === "FormattingOnlyRejected")
        .at(-1)?.payload,
    ).toEqual({ count: 1 });
    activity.close();
  });

  it.each(["incomplete", "formatting"] as const)(
    "%s の続きのコンテキスト準備失敗後も起点とセッションを引き継ぐ",
    async (kind) => {
      const repos = new FakeRepos();
      const base = repos.tree;
      const submitted = "a".repeat(40);
      repos.treeDiffs.set(`${base}:${submitted}`, [
        {
          status: "M",
          path: "a.ts",
          oldMode: "100644",
          newMode: "100644",
          oldObject: "old",
          newObject: "new",
        },
      ]);
      repos.treeBlobs.set("old", "const x={a:1};");
      repos.treeBlobs.set("new", "const x = { a: 1, };");
      const first =
        kind === "incomplete"
          ? out(
              `${implement("# 未完了").output}\n\n\`\`\`sacty-completion\n${JSON.stringify({ status: "incomplete", remaining: ["続き"] })}\n\`\`\``,
            )
          : implement("# 実装");
      const sessionLogs = new SessionLogStore(join(dir, `runs-${kind}`));
      const { activity, service, executor, id } = await toImplement([first, implement("# 続き")], {
        repos,
        sessionLogs,
      });
      executor.appendSessionFiles = true;
      executor.sessionIdOf = (inv, runId) => {
        const index = inv.command.indexOf("--resume");
        return index < 0 ? `session-${runId}` : (inv.command[index + 1] ?? "");
      };
      executor.sessionFiles = (inv, runId) => ({
        [`projects/-workspace/${executor.sessionIdOf?.(inv, runId)}.jsonl`]: "{}\n",
      });
      await service.runNext(id);
      repos.tree = submitted;
      await service.runNext(id);
      const previous = service
        .get(id)
        ?.activity.findLast(
          (e) => e.type === "AgentRunCompleted" && e.payload.step === "implement",
        );
      if (previous?.type !== "AgentRunCompleted") throw new Error("completed run missing");
      const context = vi
        .spyOn(service as never, "runContext")
        .mockRejectedValueOnce(new Error("context failed"));
      await service.runNext(id);
      expect(
        service.get(id)?.activity.findLast((e) => e.type === "AgentRunFailed")?.payload,
      ).toMatchObject({ preparationFailed: true });
      context.mockRestore();
      service.resume(id, {});
      await service.runNext(id);
      const start = service
        .get(id)
        ?.activity.findLast((e) => e.type === "AgentRunStarted" && e.payload.step === "implement");
      expect(start?.type === "AgentRunStarted" && start.payload.formattingBaseline?.tree).toBe(
        base,
      );
      expect(executor.calls.at(-1)?.command).toContain(`session-${previous.payload.runId}`);
      activity.close();
    },
  );

  it.each(
    (["incomplete", "formatting", "timeout"] as const).flatMap((continuation) =>
      (["workspace", "merge", "documents", "context", "services"] as const).map((failure) => ({
        continuation,
        failure,
      })),
    ),
  )(
    "$continuation の続行で $failure の準備に失敗しても元の起点とセッションを使う",
    async ({ continuation, failure }) => {
      const repos = new FakeRepos();
      const base = repos.tree;
      const submitted = "a".repeat(40);
      repos.treeDiffs.set(`${base}:${submitted}`, [
        {
          status: "M",
          path: "a.ts",
          oldMode: "100644",
          newMode: "100644",
          oldObject: "old",
          newObject: "new",
        },
      ]);
      repos.treeBlobs.set("old", "const x={a:1};");
      repos.treeBlobs.set("new", "const x = { a: 1, };");
      const incomplete = out(
        `${implement("# 未完了").output}\n\n\`\`\`sacty-completion\n${JSON.stringify({ status: "incomplete", remaining: ["続き"] })}\n\`\`\``,
      );
      const timeout: AgentOutcome = {
        kind: "failed",
        reason: "error",
        message: message("run.timeout", { minutes: 3 }),
      };
      const first =
        continuation === "timeout"
          ? timeout
          : continuation === "incomplete"
            ? incomplete
            : implement("# 実装");
      const sessionLogs = new SessionLogStore(join(dir, `matrix-${continuation}-${failure}`));
      const { activity, service, executor, id } = await toImplement([first, implement("# 続き")], {
        repos,
        sessionLogs,
        mergeBase: true,
      });
      executor.appendSessionFiles = true;
      executor.sessionIdOf = (inv, runId) => {
        const index = inv.command.indexOf("--resume");
        return index < 0 ? `session-${runId}` : (inv.command[index + 1] ?? "");
      };
      executor.sessionFiles = (inv, runId) => ({
        [`projects/-workspace/${executor.sessionIdOf?.(inv, runId)}.jsonl`]: "{}\n",
      });
      await service.runNext(id);
      repos.tree = submitted;
      if (continuation === "timeout") service.resume(id, {});
      else await service.runNext(id);
      const previous = service
        .get(id)
        ?.activity.findLast((e) => e.type === "AgentRunStarted" && e.payload.step === "implement");
      if (previous?.type !== "AgentRunStarted") throw new Error("started run missing");
      if (failure === "documents")
        activity.append({
          taskId: id,
          projectId: "default",
          events: [
            {
              actor: "sacty",
              event: {
                type: "TaskBranchCreated",
                payload: { branch: "sacty/test", commit: repos.head },
              },
            },
          ],
        });
      const failed =
        failure === "workspace"
          ? vi
              .spyOn(service as never, "prepareRepository")
              .mockResolvedValueOnce({ ok: false, message: "prepare failed" } as never)
          : failure === "merge"
            ? vi
                .spyOn(service as never, "syncBase")
                .mockResolvedValueOnce({ kind: "failed", message: "merge failed" } as never)
            : failure === "documents"
              ? vi.spyOn(repos, "fetchBranch").mockRejectedValueOnce(new Error("fetch failed"))
              : failure === "context"
                ? vi
                    .spyOn(service as never, "runContext")
                    .mockRejectedValueOnce(new Error("context failed"))
                : vi
                    .spyOn(service as never, "startServices")
                    .mockResolvedValueOnce({ ok: false, message: "service failed" } as never);
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(
        service.get(id)?.activity.findLast((e) => e.type === "AgentRunFailed")?.payload,
      ).toMatchObject({ preparationFailed: true });
      failed.mockRestore();
      service.resume(id, {});
      await service.runNext(id);
      const started = service
        .get(id)
        ?.activity.findLast((e) => e.type === "AgentRunStarted" && e.payload.step === "implement");
      expect(started?.type === "AgentRunStarted" && started.payload.formattingBaseline?.tree).toBe(
        base,
      );
      expect(executor.calls.at(-1)?.command).toContain(`session-${previous.payload.runId}`);
      await service.runNext(id);
      expect(
        service.get(id)?.activity.findLast((e) => e.type === "FormattingOnlyRejected")?.payload,
      ).toEqual({ count: 1 });
      activity.close();
    },
  );

  it("申告されたパスと理由の秘密値を伏せて照合し、記録と本文に残さない", async () => {
    const repos = new FakeRepos();
    repos.diffFileList = [{ status: "M", path: "oauth-secret.ts" }];
    const base = repos.tree;
    const submitted = "a".repeat(40);
    repos.treeDiffs.set(`${base}:${submitted}`, [
      {
        status: "M",
        path: "oauth-secret.ts",
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      },
    ]);
    repos.treeBlobs.set("old", "const x = { a: 1 };\n");
    repos.treeBlobs.set("new", "const x = {\n  a: 1,\n};\n");
    const declaration = block({
      "sacty-formatting": { files: [{ path: "oauth-secret.ts", reason: "oauth-secret の整形" }] },
    });
    const { activity, service, executor, id } = await toImplement(
      [implement(`# 実装\n\n${declaration}`)],
      { repos },
    );
    executor.respond = (invocation) => {
      if (invocation.command.join(" ").includes("テスト観点（承認済み")) repos.tree = submitted;
      return undefined;
    };
    await drain(service);
    const result = service.get(id);
    if (!result) throw new Error("task missing");
    expect(types(service, id)).not.toContain("FormattingOnlyRejected");
    expect(result.task.formattingCheck?.declared).toEqual([
      { path: "[REDACTED].ts", reason: "[REDACTED] の整形" },
    ]);
    expect(JSON.stringify(result.activity)).not.toContain("oauth-secret");
    expect(buildPullRequestBody(result.task)).not.toContain("oauth-secret");
    activity.close();
  });

  it("申告理由は実行に使わない秘密値も切り詰める前に伏せる", async () => {
    const repos = new FakeRepos();
    repos.diffFileList = [{ status: "M", path: "a.ts" }];
    const base = repos.tree;
    const submitted = "a".repeat(40);
    repos.treeDiffs.set(`${base}:${submitted}`, [
      {
        status: "M",
        path: "a.ts",
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      },
    ]);
    repos.treeBlobs.set("old", "const x = { a: 1 };\n");
    repos.treeBlobs.set("new", "const x = {\n  a: 1,\n};\n");
    const reason = `${"x".repeat(294)}😀ghp_secret`;
    const declaration = block({ "sacty-formatting": { files: [{ path: "a.ts", reason }] } });
    const { activity, service, executor, id } = await toImplement(
      [implement(`# 実装\n\n${declaration}`)],
      { repos },
    );
    executor.respond = (invocation) => {
      if (invocation.command.join(" ").includes("テスト観点（承認済み")) repos.tree = submitted;
      return undefined;
    };
    await drain(service);
    const result = service.get(id);
    if (!result) throw new Error("task missing");
    expect(result.task.formattingCheck?.declared[0]?.reason).toBe(`${"x".repeat(294)}😀[REDA`);
    expect(JSON.stringify(result.activity)).not.toContain("ghp_");
    expect(buildPullRequestBody(result.task)).not.toContain("ghp_");
    activity.close();
  });

  it("未申告のパスに秘密値があっても、上限後の記録と本文に出さない", async () => {
    const repos = new FakeRepos();
    const base = repos.tree;
    const submitted = "a".repeat(40);
    repos.treeDiffs.set(`${base}:${submitted}`, [
      {
        status: "M",
        path: "oauth-secret.ts",
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      },
    ]);
    repos.treeBlobs.set("old", "const x={a:1};");
    repos.treeBlobs.set("new", "const x = { a: 1, };");
    const { activity, service, id } = await toImplement(
      [implement("# 実装"), implement("# 続き"), implement("# 続き 2")],
      { repos },
    );
    await service.runNext(id);
    repos.tree = submitted;
    await drain(service);
    const result = service.get(id);
    if (!result) throw new Error("task missing");
    expect(result.task.formattingCheck).toEqual({ remained: 1, declared: [] });
    expect(JSON.stringify(result.activity)).not.toContain("oauth-secret");
    expect(buildPullRequestBody(result.task)).not.toContain("oauth-secret");
    activity.close();
  });

  it("ツリーの差分を読めない場合は停止せず提出する", async () => {
    const repos = new FakeRepos();
    repos.treeDiffFail = true;
    const pulls = new FakePulls();
    const { activity, service, id } = await toImplement([implement("# 実装")], { repos, pulls });
    await drain(service);
    expect(types(service, id)).not.toContain("TaskPaused");
    expect(types(service, id)).not.toContain("FormattingOnlyRejected");
    expect(pulls.calls).toHaveLength(1);
    activity.close();
  });

  it("起点のツリーが Git に存在しなくても停止せず提出する", async () => {
    const gitDir = join(dir, "missing-baseline");
    mkdirSync(gitDir);
    execFileSync("git", ["init", "--quiet", gitDir]);
    const repos = new FakeRepos();
    repos.tree = "f".repeat(40);
    const real = new GitRepositoryWorkspace();
    vi.spyOn(repos, "treeChanges").mockImplementation((_ignored, from, to) =>
      real.treeChanges(join(gitDir, ".git"), from, to),
    );
    const pulls = new FakePulls();
    const { activity, service, id } = await toImplement([implement("# 実装")], { repos, pulls });
    await service.runNext(id);
    repos.tree = "a".repeat(40);
    await drain(service);
    expect(types(service, id)).not.toContain("TaskPaused");
    expect(types(service, id)).not.toContain("FormattingOnlyRejected");
    expect(pulls.calls).toHaveLength(1);
    activity.close();
  });

  it("検査対象外のファイルは提出時に内容とモードを保つ", async () => {
    const origin = join(dir, "excluded-origin");
    mkdirSync(origin);
    const git = (...args: string[]) => execFileSync("git", args, { cwd: origin });
    git("init", "--initial-branch=main");
    git("config", "user.name", "test");
    git("config", "user.email", "test@example.com");
    for (const path of ["m.ts", "日本語.ts"]) writeFileSync(join(origin, path), "const x={a:1};\n");
    git("add", "--all");
    git("commit", "-m", "base");
    class GitRepos extends FakeRepos {
      real = new GitRepositoryWorkspace();
      work = "";
      metadata = "";
      published: { path: string; mode: string; content: string }[] = [];
      async prepare(work: string, metadata: string) {
        this.work = work;
        this.metadata = metadata;
        return this.real.prepare(work, metadata, origin, undefined);
      }
      async treeId(work: string, metadata: string, base: string) {
        return this.real.treeId(work, metadata, base);
      }
      async treeChanges(metadata: string, from: string, to: string) {
        return this.real.treeChanges(metadata, from, to);
      }
      async treeBlob(metadata: string, object: string) {
        return this.real.treeBlob(metadata, object);
      }
      async publish(input: Parameters<FakeRepos["publish"]>[0]) {
        const tree = await this.real.treeId(this.work, this.metadata, input.baseCommit ?? "");
        const changes = await this.real.treeChanges(this.metadata, input.baseCommit ?? "", tree);
        this.published = await Promise.all(
          changes.map(async (change) => ({
            path: change.path,
            mode: change.newMode,
            content: await this.real.treeBlob(this.metadata, change.newObject),
          })),
        );
        return super.publish(input);
      }
    }
    const repos = new GitRepos();
    const { activity, service, executor, id } = await toImplement([implement("# 実装")], { repos });
    executor.respond = () => {
      for (const path of ["m.ts", "日本語.ts"])
        writeFileSync(join(repos.work, path), "const x = { a: 1, };\n");
      execFileSync("chmod", ["+x", join(repos.work, "m.ts")]);
      return undefined;
    };
    await drain(service);
    expect(types(service, id)).not.toContain("FormattingOnlyRejected");
    expect(repos.published).toEqual(
      expect.arrayContaining([
        { path: "m.ts", mode: "100755", content: "const x = { a: 1, };\n" },
        { path: "日本語.ts", mode: "100644", content: "const x = { a: 1, };\n" },
      ]),
    );
    activity.close();
  });

  it("伏せる秘密値を取得できないときはパスを指示に渡さず受け付ける", async () => {
    let unavailable = false;
    const secretStore = {
      get: async () => {
        if (unavailable) throw new Error("secret unavailable");
        return "oauth-secret";
      },
    };
    const repos = new FakeRepos();
    const base = repos.tree;
    const submitted = "a".repeat(40);
    repos.treeDiffs.set(`${base}:${submitted}`, [
      {
        status: "M",
        path: "oauth-secret.ts",
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      },
    ]);
    repos.treeBlobs.set("old", "const x={a:1};");
    repos.treeBlobs.set("new", "const x = { a: 1, };");
    const pulls = new FakePulls();
    const { activity, service, id } = await toImplement([implement("# 実装")], {
      repos,
      pulls,
      secretStore,
    });
    await service.runNext(id);
    repos.tree = submitted;
    unavailable = true;
    await service.runNext(id);
    expect(types(service, id)).not.toContain("FormattingOnlyRejected");
    expect(types(service, id)).not.toContain("TaskPaused");
    unavailable = false;
    await drain(service);
    expect(pulls.calls).toHaveLength(1);
    expect(JSON.stringify(service.get(id)?.activity)).not.toContain("oauth-secret");
    activity.close();
  });

  it("解析不能な内容やモード変更・対象外パスを含む提出を受け付ける", async () => {
    const repos = new FakeRepos();
    const base = repos.tree;
    const submitted = "a".repeat(40);
    const change = (path: string, oldObject: string, newObject: string, newMode = "100644") => ({
      status: "M",
      path,
      oldMode: "100644",
      newMode,
      oldObject,
      newObject,
    });
    repos.treeDiffs.set(`${base}:${submitted}`, [
      change("x.py", "old", "new"),
      change("c.ts", "old", "broken"),
      change("d.json", "json", "badjson"),
      change("e.jsonc", "json", "new"),
      change("binary.ts", "old", "binary"),
      change("unreadable.ts", "old", "missing"),
      change("m.ts", "old", "new", "100755"),
      change("日本語.ts", "old", "new"),
    ]);
    repos.treeBlobs.set("old", "const x={a:1};");
    repos.treeBlobs.set("new", "const x = { a: 1, };");
    repos.treeBlobs.set("broken", "const x = ;");
    repos.treeBlobs.set("json", '{"a":1}');
    repos.treeBlobs.set("badjson", '{"a":1,}');
    repos.treeBlobs.set("binary", "\0");
    const pulls = new FakePulls();
    const { activity, service, id } = await toImplement([implement("# 実装")], { repos, pulls });
    await service.runNext(id);
    repos.tree = submitted;
    await drain(service);
    expect(types(service, id)).not.toContain("FormattingOnlyRejected");
    expect(pulls.calls).toHaveLength(1);
    expect(repos.tree).toBe(submitted);
    activity.close();
  });

  it.each([
    ["a.ts", "const x = { a: 1 };", "const x = {\n a: 1,\n};", true],
    ["a.tsx", "const x = <A p={1}/>;", "const x = <A\n p={1}\n/>;", true],
    ["a.js", "f(a,b);", "f(\n a,\n b,\n);", true],
    ["a.json", '{"a":1}', '{\n "a": 1\n}', true],
    ["b.ts", "export const value = 1;", "export const value = 2;", false],
    ["a.js", 'const x="New York";', 'const x="NewYork";', false],
    ["a.js", "function f(){return x}", "function f(){return\nx}", false],
    ["a.tsx", "const x=<p>hello world</p>;", "const x=<p>helloworld</p>;", false],
    ["a.js", "const x=`a\nb`;", "const x=`ab`;", false],
    ["a.js", "const x=/a b/;", "const x=/ab/;", false],
    ["a.js", "const x=[a,,b];", "const x=[a,b];", false],
    ["a.js", "// old\nf();", "// new\nf();", false],
    ["a.js", "const x='a';", 'const x="a";', false],
  ])(
    "提出した %s の構文とトークンに応じて出し直しを決める",
    async (path, before, after, reject) => {
      const repos = new FakeRepos();
      const base = repos.tree;
      const submitted = "a".repeat(40);
      repos.treeDiffs.set(`${base}:${submitted}`, [
        {
          status: "M",
          path,
          oldMode: "100644",
          newMode: "100644",
          oldObject: "old",
          newObject: "new",
        },
      ]);
      repos.treeBlobs.set("old", before);
      repos.treeBlobs.set("new", after);
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplement([implement("# 実装")], { repos, pulls });
      await service.runNext(id);
      repos.tree = submitted;
      await service.runNext(id);
      expect(types(service, id).includes("FormattingOnlyRejected")).toBe(reject);
      if (reject) expect(pulls.calls).toHaveLength(0);
      else {
        await drain(service);
        expect(pulls.calls).toHaveLength(1);
        expect(repos.tree).toBe(submitted);
        const task = service.get(id)?.task;
        if (!task) throw new Error("task missing");
        expect(buildPullRequestBody(task)).not.toContain("整形だけで変わったファイルが");
      }
      activity.close();
    },
  );

  describe("観点とテストの対応に、設計のテスト観点が欠けた実装は提出しない（PBI-348）", () => {
    const TV1 = { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] };
    const TV2 = { viewpointId: "TV-2", tests: ["pay.test.ts › キーなし"] };

    it("設計のテスト観点にテストの対応が欠けていたら、完了と申告していても PR を作らず、欠けた観点を渡して実装をやり直す（受け入れ条件 5）", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装", [TV1]), implement("# 実装 v2", [TV1, TV2])],
        { pulls },
      );
      await service.runNext(id);
      await service.runNext(id);
      const incomplete = service
        .get(id)
        ?.activity.find((e) => e.type === "ImplementationIncomplete");
      expect(incomplete?.payload).toMatchObject({
        remaining: ["TV-2 キーなし"],
        unmapped: ["TV-2"],
      });
      expect(pulls.calls).toHaveLength(0);
      expect(service.get(id)?.task.status).toBe("queued");
      await drain(service);
      const prompt = promptOf(executor, executor.calls.length - 1);
      expect(prompt).toContain("--- 前回の実行：テストが対応していないテスト観点がありました ---");
      expect(prompt).toContain("- [TV-2] キーなし");
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(pulls.calls).toHaveLength(1);
      activity.close();
    });

    it("実装の工程の実行には、完了の申告のコードブロックを含む最後の result を答えにする目印を渡す（PBI-415）", async () => {
      const { activity, service, executor, id } = await toImplement([implement("# 実装")]);
      await service.runNext(id);
      expect(executor.calls.at(-1)?.preferResult).toBe("sacty-completion");
      activity.close();
    });

    it("実装の工程の指示に、時計の時刻を入れる（PBI-469）", async () => {
      const { activity, service, executor } = await toImplement([implement("# 実装", [TV1, TV2])], {
        now: () => Date.UTC(2026, 10, 21, 10, 30, 0),
      });
      await drain(service);
      const prompt = executor.calls
        .map((_, i) => promptOf(executor, i))
        .find((p) => p.includes("--- テスト観点（承認済み・すべてにテストを対応させる） ---"));
      expect(prompt).toContain("2026-11-21T10:30:00Z");
      activity.close();
    });

    it("設計のある実装の指示は、観点の対応が欠けると提出されないことと、変更が要らないときも対応させることを伝える", async () => {
      const { activity, service, executor } = await toImplement([implement("# 実装", [TV1, TV2])]);
      await drain(service);
      const prompt = executor.calls
        .map((_, i) => promptOf(executor, i))
        .find((p) => p.includes("--- テスト観点（承認済み・すべてにテストを対応させる） ---"));
      expect(prompt).toContain(
        "- 観点とテストの対応に、上の観点が1つでも欠けていると、sacty は提出しない（欠けている観点を渡して、実装をやり直す）",
      );
      expect(prompt).toContain(
        "変更が要らないとわかったときも、観点ごとに、その観点を確かめている既存のテスト（か、テストを書かない理由）を対応させる",
      );
      activity.close();
    });

    it("変更が要らないとわかった実行も、観点の対応が欠けていれば、対応を出し直させてから、変更なしの確認に進む", async () => {
      const repos = new FakeRepos();
      repos.unchanged = true;
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplement(
        [implement("# 変更は要らない", [TV1]), implement("# 変更は要らない v2", [TV1, TV2])],
        { repos, pulls },
      );
      await drain(service);
      const recorded = types(service, id);
      expect(recorded.filter((t) => t === "ImplementationIncomplete")).toHaveLength(1);
      expect(recorded.indexOf("ImplementationIncomplete")).toBeLessThan(
        recorded.indexOf("NoChangesFound"),
      );
      expect(recorded).not.toContain("TaskPaused");
      const task = service.get(id)?.task;
      expect(task?.status).toBe("awaiting_approval");
      expect(task?.noChanges).toEqual({ submission: 1 });
      expect(pulls.calls).toEqual([]);
      activity.close();
    });

    it("テストを書かない理由（untested）を対応させた観点は、欠けていない", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplement(
        [
          implement("# 実装", [
            TV1,
            { viewpointId: "TV-2", tests: [], untested: "文言だけを直したため" },
          ]),
        ],
        { pulls },
      );
      await drain(service);
      expect(types(service, id)).not.toContain("ImplementationIncomplete");
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });
  });

  describe("申告だけが欠けて進まないときは、止める前に申告だけを求める実行を1回足す（PBI-416）", () => {
    const TV1 = { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] };
    const TV2 = { viewpointId: "TV-2", tests: ["pay.test.ts › キーなし"] };
    const declare = (value: unknown) =>
      `\`\`\`${COMPLETION_FENCE}\n${JSON.stringify(value)}\n\`\`\``;
    const withDeclaration = (map: (typeof TV1)[]) =>
      out([implement("# 実装", map).output, declare({ status: "complete" })].join("\n\n"));
    /** 完了と申告したが、観点とテストの対応に TV-2 が欠けた実行。 */
    const missingMap = () => withDeclaration([TV1]);
    /** 完了と申告し、すべての観点を対応させた実行。 */
    const fullMap = () => withDeclaration([TV1, TV2]);
    /** 完了の申告が無い実行。 */
    const noDeclaration = () =>
      out(["# 実装", `\`\`\`${COMPLETION_FENCE}\n{"status": "complete",}\n\`\`\``].join("\n\n"));
    const incompleteRun = () =>
      out(["# 実装", declare({ status: "incomplete", remaining: ["docs の更新"] })].join("\n\n"));
    const declarationRuns = (svc: TaskService, id: string) =>
      (svc.get(id)?.activity ?? []).filter(
        (e) =>
          e.type === "ImplementationIncomplete" &&
          (e.payload as { declarationOnly?: boolean }).declarationOnly,
      );
    /** 実行のたびに作業領域の内容の目印を決める（足りない分は最後のまま）。 */
    const treeByRun = (executor: FakeExecutor, repos: FakeRepos, trees: string[]) => {
      let n = 0;
      executor.logLines = () => {
        repos.tree = (trees[Math.min(n, trees.length - 1)] ?? "t").padEnd(40, "0");
        n += 1;
        return undefined;
      };
    };

    it("完了と申告したが観点が欠け、作業領域が変わらないとき、止めずに、欠けた観点を伝える申告だけの実行を1回行い、そろえば提出に進む（受け入れ条件 6〜8）", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplement(
        [missingMap(), missingMap(), fullMap()],
        { pulls },
      );
      await drain(service);
      const recorded = types(service, id);
      expect(recorded).not.toContain("TaskPaused");
      expect(recorded.filter((t) => t === "ImplementationIncomplete")).toHaveLength(2);
      expect(declarationRuns(service, id)).toHaveLength(1);
      const prompt = promptOf(executor, executor.calls.length - 1);
      expect(prompt).toContain("申告だけが欠けています");
      expect(prompt).toContain("コードは変えなくてよい");
      expect(prompt).toContain("- TV-2");
      expect(prompt).toContain("すべてのテスト観点の対応");
      expect(prompt).toContain("未完了と申告する");
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(pulls.calls).toHaveLength(1);
      activity.close();
    });

    it("完了の申告が無い・読めないときも、同じ条件で、申告が読めなかったことを伝える申告だけの実行を1回行う（受け入れ条件 6・7）", async () => {
      const { activity, service, executor, id } = await toImplement([
        noDeclaration(),
        noDeclaration(),
        fullMap(),
      ]);
      await drain(service);
      expect(types(service, id)).not.toContain("TaskPaused");
      expect(declarationRuns(service, id)).toHaveLength(1);
      const prompt = promptOf(executor, executor.calls.length - 1);
      expect(prompt).toContain("完了の申告が無いか、決まった形どおりに読めませんでした");
      expect(prompt).toContain("コードは変えなくてよい");
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });

    it("申告だけを求めても申告がそろわず作業領域も変わらなければ、2回目は行わずに一時停止し、文言で申告だけを求めたことが分かる（受け入れ条件 9・12）", async () => {
      const { activity, service, id } = await toImplement([
        missingMap(),
        missingMap(),
        missingMap(),
        fullMap(),
      ]);
      await drain(service);
      expect(declarationRuns(service, id)).toHaveLength(1);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.pausedReason).toBe("incomplete");
      expect(task?.pausedMessage).toMatchObject({
        code: "implement.unmappedViewpoints",
        params: { count: 3, stalled: true, declarationAsked: true },
      });
      expect(ja(task?.pausedMessage as never)).toContain("申告だけを求めても");
      activity.close();
    });

    it("申告だけを求める実行で作業領域が変わったときは、今までどおり続ける（一時停止しない。受け入れ条件 9）", async () => {
      const repos = new FakeRepos();
      const { activity, service, executor, id } = await toImplement(
        [missingMap(), missingMap(), missingMap(), fullMap()],
        { repos },
      );
      treeByRun(executor, repos, ["a", "a", "b", "c"]);
      await drain(service);
      expect(types(service, id)).not.toContain("TaskPaused");
      expect(declarationRuns(service, id)).toHaveLength(1);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });

    it("未完了と申告した実行が続いて作業領域が変わらないときは、今までどおり、申告だけを求めずにすぐ一時停止する（受け入れ条件 10）", async () => {
      const { activity, service, id } = await toImplement([
        incompleteRun(),
        incompleteRun(),
        fullMap(),
      ]);
      await drain(service);
      expect(declarationRuns(service, id)).toHaveLength(0);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(types(service, id).filter((t) => t === "ImplementationIncomplete")).toHaveLength(2);
      expect(task?.pausedMessage).toMatchObject({
        code: "implement.incomplete",
        params: { stalled: true },
      });
      expect(task?.pausedMessage?.params).not.toHaveProperty("declarationAsked");
      expect(ja(task?.pausedMessage as never)).not.toContain("申告だけを求めても");
      activity.close();
    });

    it("申告だけを求める実行も未完了の1回に数え、上限（10 回）は変えない（受け入れ条件 11）", async () => {
      const repos = new FakeRepos();
      const { activity, service, executor, id } = await toImplement(
        Array.from({ length: 14 }, () => missingMap()),
        { repos },
      );
      // 1・2回目は同じ目印（2回目で申告だけを求める）、3回目からは毎回変わる
      treeByRun(executor, repos, ["a", "a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k"]);
      await drain(service, 40);
      expect(declarationRuns(service, id)).toHaveLength(1);
      const task = service.get(id)?.task;
      expect(types(service, id).filter((t) => t === "ImplementationIncomplete")).toHaveLength(11);
      expect(task?.status).toBe("paused");
      expect(task?.pausedMessage).toMatchObject({ params: { count: 11, stalled: false } });
      activity.close();
    });

    it("申告だけを求めたことは台帳の記録（ImplementationIncomplete）から決まり、投影に残る（受け入れ条件 13）", async () => {
      const { activity, service, id } = await toImplement([missingMap(), missingMap()]);
      for (let i = 0; i < 8 && !service.get(id)?.task.incompleteRuns?.declarationAsked; i++) {
        await service.runNext(id);
      }
      expect(service.get(id)?.task.incompleteRuns).toMatchObject({
        runs: 2,
        stalled: true,
        declarationAsked: true,
      });
      expect(service.get(id)?.task.verifyFeedback).toMatchObject({
        kind: "incomplete",
        declarationOnly: true,
      });
      expect(service.get(id)?.task.status).toBe("queued");
      activity.close();
    });

    it("申告だけを求める実行で作業領域が変わると declarationAsked は消え、後の別の止まりでは、もう1回求める（受け入れ条件 9・13）", async () => {
      const repos = new FakeRepos();
      const { activity, service, executor, id } = await toImplement(
        [missingMap(), missingMap(), missingMap(), missingMap(), fullMap()],
        { repos },
      );
      treeByRun(executor, repos, ["a", "a", "b", "b", "c"]);
      const count = () => types(service, id).filter((t) => t === "ImplementationIncomplete").length;
      for (let i = 0; i < 30 && count() < 2; i++) await service.runNext(id);
      expect(service.get(id)?.task.incompleteRuns?.declarationAsked).toBe(true);
      for (let i = 0; i < 30 && count() < 3; i++) await service.runNext(id);
      // 3回目で作業領域が変わった：記録は消え、止まらない
      expect(service.get(id)?.task.incompleteRuns?.declarationAsked).toBeFalsy();
      expect(service.get(id)?.task.status).toBe("queued");
      await drain(service);
      expect(declarationRuns(service, id)).toHaveLength(2);
      expect(types(service, id)).not.toContain("TaskPaused");
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });

    it("人が再開すると declarationAsked も数え直し、再開の後に同じ条件になれば、もう1回求める（受け入れ条件 9）", async () => {
      const { activity, service, id } = await toImplement([
        missingMap(),
        missingMap(),
        missingMap(),
        missingMap(),
        fullMap(),
      ]);
      for (let i = 0; i < 30 && service.get(id)?.task.status !== "paused"; i++) {
        await service.runNext(id);
      }
      expect(service.get(id)?.task.pausedReason).toBe("incomplete");
      service.resume(id, {});
      expect(service.get(id)?.task.incompleteRuns?.declarationAsked).toBeFalsy();
      await drain(service);
      expect(declarationRuns(service, id)).toHaveLength(2);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });

    it("申告が無いまま申告だけを求めても変わらなければ、implement.incomplete の文言（日英）で申告だけを求めたことが分かる（受け入れ条件 12）", async () => {
      const { activity, service, id } = await toImplement([
        noDeclaration(),
        noDeclaration(),
        noDeclaration(),
      ]);
      await drain(service);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.pausedMessage).toMatchObject({
        code: "implement.incomplete",
        params: { stalled: true, declarationAsked: true },
      });
      expect(ja(task?.pausedMessage as never)).toContain("申告だけを求めても");
      expect(renderMessage(task?.pausedMessage, "en")).toContain(
        "asking only for the declaration changed nothing",
      );
      activity.close();
    });

    it("上限の11回目は、作業領域の目印が前と同じでも、申告だけを求めずに止まる（受け入れ条件 11）", async () => {
      const repos = new FakeRepos();
      const { activity, service, executor, id } = await toImplement(
        Array.from({ length: 14 }, () => missingMap()),
        { repos },
      );
      // 1〜10回目は毎回変わり、11回目は10回目と同じ目印
      treeByRun(executor, repos, ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "j"]);
      await drain(service, 40);
      expect(declarationRuns(service, id)).toHaveLength(0);
      const task = service.get(id)?.task;
      expect(types(service, id).filter((t) => t === "ImplementationIncomplete")).toHaveLength(11);
      expect(task?.status).toBe("paused");
      expect(task?.pausedMessage).toMatchObject({ params: { count: 11, stalled: true } });
      activity.close();
    });

    it("デーモンを再起動して台帳から作り直しても、申告だけを求めたことが残り、2回目は行わず、続きは行う（受け入れ条件 13）", async () => {
      const { activity, service, id } = await toImplement([missingMap(), missingMap()]);
      for (let i = 0; i < 8 && !service.get(id)?.task.incompleteRuns?.declarationAsked; i++) {
        await service.runNext(id);
      }
      const again = new SqliteActivityStore(dbPath);
      const restarted = makeService(again, [missingMap()]);
      expect(restarted.service.get(id)?.task.incompleteRuns).toMatchObject({
        runs: 2,
        stalled: true,
        declarationAsked: true,
      });
      // 申告だけを求める実行の続きが、再起動の後に1回行われる。それでもそろわなければ、2回目は行わずに止まる
      await drain(restarted.service);
      expect(declarationRuns(restarted.service, id)).toHaveLength(1);
      expect(restarted.service.get(id)?.task.status).toBe("paused");
      again.close();
      activity.close();
    });

    it("実装の指示は、テストで確かめようがない観点を、tests を空にした untested（理由と確かめ方）で申告すると伝え、テストを書ける観点の抜け道にしない（受け入れ条件 1・3）", async () => {
      const { activity, service, executor } = await toImplement([implement("# 実装", [TV1, TV2])]);
      await drain(service);
      const prompt = executor.calls
        .map((_, i) => promptOf(executor, i))
        .find((p) => p.includes("--- テスト観点（承認済み・すべてにテストを対応させる） ---"));
      expect(prompt).toContain(
        "テストで確かめようがない観点（検査の実行そのもの・人が確かめること など）",
      );
      expect(prompt).toContain("どう確かめたか（または誰が確かめるか）");
      expect(prompt).toContain("テストを書ける観点（実行される振る舞いを変えるもの）には使わない");
      expect(prompt).toContain(
        "実行される振る舞い（コード・設定の値・スクリプトなど）を変える観点は、untested にせず、テストを書く",
      );
      activity.close();
    });

    it("観点が欠けたときのやり直しの指示も、テストで確かめようがない観点の untested の申告を伝える（受け入れ条件 2）", async () => {
      const { activity, service, executor, id } = await toImplement([missingMap(), fullMap()]);
      await drain(service);
      const prompt = promptOf(executor, executor.calls.length - 1);
      expect(prompt).toContain("--- 前回の実行：テストが対応していないテスト観点がありました ---");
      expect(prompt).toContain(
        "テストで確かめようがない観点（検査の実行そのもの・人が確かめること など）",
      );
      expect(prompt).toContain("テストを書ける観点は、untested にしない");
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });

    it("検査の実行そのものの観点を、理由つきの untested で申告すれば、欠けと見なさず提出に進む（受け入れ条件 4）", async () => {
      const { activity, service, id } = await toImplement([
        out(
          [
            implement("# 実装", [
              TV1,
              {
                viewpointId: "TV-2",
                tests: [],
                untested: "検査の実行そのもの。検査を実行して通ったことを説明に書いた",
              },
            ]).output,
            declare({ status: "complete" }),
          ].join("\n\n"),
        ),
      ]);
      await drain(service);
      expect(types(service, id)).not.toContain("ImplementationIncomplete");
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });
  });

  describe("ベースブランチの取り込み（競合の解消）", () => {
    const tip = "e".repeat(40);
    const withBaseMoved = () => {
      const repos = new FakeRepos();
      // 作業領域を用意した後に、ベースブランチ（main）が進んだ
      repos.remote.main = tip;
      return repos;
    };
    const conflictedFiles = ["README.md", ".prettierignore"];
    const conflicted = () => {
      const repos = withBaseMoved();
      repos.mergeResult = { status: "conflicted", conflicts: conflictedFiles };
      repos.markers = [...conflictedFiles];
      return repos;
    };

    it("実装を始める前にベースブランチの最新を取り込んで記録し、競合が無ければ、取り込んだ先頭を第2の親にしたマージコミットで出す", async () => {
      const repos = withBaseMoved();
      const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
        repos,
        mergeBase: true,
      });
      await drain(service);
      // 取り込みは1回（PR を作る前には取り込み直さない）。起点を共通の祖先にする
      expect(repos.merges).toMatchObject([{ base: "base123", target: tip }]);
      const task = service.get(id)?.task as Task;
      expect(task.baseMerge).toMatchObject({ from: "base123", commit: tip, conflicts: [] });
      expect(types(service, id).filter((t) => t === "BaseBranchMerged")).toHaveLength(1);
      // 競合が無いので、実装の指示に競合の節は入れない
      expect(promptOf(executor, 3)).not.toContain("ベースブランチとの競合");
      // 起点は変えず（元の起点は記録のまま）、実装の差分・コミットの起点は取り込んだ先頭にする
      expect(task.repository?.baseCommit).toBe("base123");
      expect(repos.publishInputs).toEqual([{ baseCommit: tip, merge: tip }]);
      expect(task.gate).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });

    it("ベースブランチが進んでいなければ、取り込まず、記録も残さない（これまでどおりのコミット）", async () => {
      const repos = new FakeRepos();
      repos.remote.main = "base123";
      const { activity, service, id } = await toImplement([implement("# 実装")], {
        repos,
        mergeBase: true,
      });
      await drain(service);
      expect(repos.merges).toEqual([]);
      expect(types(service, id)).not.toContain("BaseBranchMerged");
      expect(repos.publishInputs).toEqual([{ baseCommit: "base123" }]);
      activity.close();
    });

    it("前の工程に戻ったら、検証の失敗の回数と内容を持ち越さない", async () => {
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
      const { activity, service, id } = await toImplement([implement("# v1"), proposal], {
        repos: conflicted(),
        mergeBase: true,
      });
      await service.runNext(id); // 実装（競合の目印が入った作業領域）
      await service.runNext(id); // 目印が残っていて、検証に通らない
      expect(service.get(id)?.task.verifyFailures).toBe(1);
      expect(service.get(id)?.task.verifyFeedback).toBeDefined();
      await service.runNext(id); // 実装のやり直しで、要求要件の変更を申し出る
      const task = service.decideChange(id, "CP-1", { accept: true }); // 人が認める
      expect(task?.gate).toEqual({ step: "requirements", submission: 3 });
      expect(task?.verifyFailures).toBe(0);
      expect(task?.verifyFeedback).toBeUndefined();
      expect(task?.verification).toBeUndefined();
      activity.close();
    });

    it("競合したファイルを実装の指示に渡し、目印が残ったまま提出されたら、PR を作らずに競合したファイルを渡して実装をやり直す", async () => {
      const repos = conflicted();
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装 v1"), implement("# 実装 v2")],
        { repos, mergeBase: true },
      );
      await service.runNext(id); // 実装（競合の目印が入った作業領域）
      const first = promptOf(executor, 3);
      expect(first).toContain("ベースブランチとの競合");
      expect(first).toContain("README.md");
      expect(first).toContain(".prettierignore");
      expect(first).toContain("目印の行をすべて消す");
      expect(first).toContain("マージ・リベース・フェッチ・コミット・プッシュはしない");
      expect(service.get(id)?.task.baseMerge?.conflicts).toEqual(conflictedFiles);

      // 目印が残ったまま：PR の作成に進まない（エージェントも実行しない）
      const runs = executor.calls.length;
      await service.runNext(id);
      expect(executor.calls.length).toBe(runs);
      const failed = service.get(id)?.task as Task;
      expect(failed.status).toBe("queued");
      expect(failed.verification).toBeUndefined();
      expect(failed.verifyFailures).toBe(1);
      expect(failed.verifyFeedback).toEqual({ kind: "merge", files: conflictedFiles });
      expect(types(service, id).at(-1)).toBe("BaseConflictsRemained");
      expect(repos.published).toEqual([]);

      // やり直し：目印が残っているうちは取り込み直さず、前回の検証の結果と競合したファイルを渡す。解消すれば PR の作成へ進む
      repos.markers = [];
      await service.runNext(id);
      const second = promptOf(executor, executor.calls.length - 1);
      expect(second).toContain("前回の検証：ベースブランチとの競合の目印が残っていました");
      expect(repos.merges).toHaveLength(1);
      await drain(service);
      expect(types(service, id)).toContain("FinalReviewSkipped");
      expect(repos.publishInputs).toEqual([{ baseCommit: tip, merge: tip }]);
      const done = service.get(id)?.task as Task;
      expect(done.gate).toEqual({ step: "implement", submission: 1 });
      expect(done.verifyFeedback).toBeUndefined();
      activity.close();
    });

    it("実装の実行の間に人が PR のブランチに足したコミットも、PR を出す前に取り込んで、その先頭に積む（PBI-334）", async () => {
      const repos = new FakeRepos();
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装 v1"), HOLD],
        { repos },
      );
      await drain(service);
      const pushed = service.get(id)?.task.pushedBranch;
      if (!pushed) throw new Error("no pushed branch");
      service.requestChanges(id, { step: "implement", submission: 1, comments: ["直して"] });
      const running = service.runNext(id);
      const runId = await executor.started.promise;
      // 実装の実行の間に、人が PR のブランチにコミットを足した
      const human = "d".repeat(40);
      repos.remote[pushed.branch] = human;
      executor.finishHeld(runId, implement("# 実装 v2"));
      await running;
      await drain(service);
      expect(repos.merges).toEqual([
        expect.objectContaining({ base: pushed.commit, target: human }),
      ]);
      expect(repos.published.at(-1)).toMatchObject({ parent: human, branch: pushed.branch });
      expect(types(service, id)).toContain("FinalReviewSkipped");
      activity.close();
    });

    it("前の人のコミットとの競合の目印が残っていれば、実装の間に新しく足されたコミットを取り込まず、目印の解消を先にさせる（PBI-334）", async () => {
      const repos = new FakeRepos();
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装 v1"), HOLD, implement("# 実装 v3")],
        { repos },
      );
      await drain(service);
      const pushed = service.get(id)?.task.pushedBranch;
      if (!pushed) throw new Error("no pushed branch");
      // 人がコミットを足し、実装のやり直しの前の取り込みで競合した
      repos.remote[pushed.branch] = "d".repeat(40);
      repos.mergeResult = { status: "conflicted", conflicts: ["src/retry.ts"] };
      repos.markers = ["src/retry.ts"];
      service.requestChanges(id, { step: "implement", submission: 1, comments: ["直して"] });
      const running = service.runNext(id);
      const runId = await executor.started.promise;
      // 実装の間に、人がさらにコミットを足した（今度は競合しない）。エージェントは目印を消さずに提出する
      repos.remote[pushed.branch] = "e".repeat(40);
      repos.mergeResult = { status: "merged", conflicts: [] };
      executor.finishHeld(runId, implement("# 実装 v2"));
      await running;
      await service.runNext(id);
      // 新しい先頭は取り込まない（取り込むと、残った目印の記録が消えて、目印のまま PR を出してしまう）
      expect(
        service
          .get(id)
          ?.activity.filter((e) => e.type === "PullRequestHeadMerged")
          .map((e) => (e.payload as { commit: string }).commit),
      ).toEqual(["d".repeat(40)]);
      expect(types(service, id).at(-1)).toBe("BaseConflictsRemained");
      expect(repos.published).toHaveLength(1);
      activity.close();
    });

    it("PR を出す前の取り込みが人のコミットと競合したら、PR を出さずに実装をやり直す（数えない。PBI-334）", async () => {
      const repos = new FakeRepos();
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装 v1"), HOLD, implement("# 実装 v3")],
        { repos },
      );
      await drain(service);
      const pushed = service.get(id)?.task.pushedBranch;
      if (!pushed) throw new Error("no pushed branch");
      service.requestChanges(id, { step: "implement", submission: 1, comments: ["直して"] });
      const running = service.runNext(id);
      const runId = await executor.started.promise;
      repos.remote[pushed.branch] = "d".repeat(40);
      repos.mergeResult = { status: "conflicted", conflicts: ["src/retry.ts"] };
      repos.markers = ["src/retry.ts"];
      executor.finishHeld(runId, implement("# 実装 v2"));
      await running;
      await service.runNext(id);
      const failed = service.get(id)?.task as Task;
      expect(types(service, id).at(-1)).toBe("BaseConflictsRemained");
      expect(failed.verifyFeedback).toEqual({ kind: "merge", files: ["src/retry.ts"] });
      expect(failed.verifyFailures ?? 0).toBe(0);
      expect(repos.published).toHaveLength(1);
      // やり直しの実装に、人の側の競合として渡し、解消したら人の先頭に積む
      repos.markers = [];
      await drain(service);
      const prompt = promptOf(executor, executor.calls.length - 1);
      expect(prompt).toContain(
        "--- 前回の検証：人が PR に足したコミットとの競合の目印が残っていました ---",
      );
      expect(prompt).toContain("--- 人が PR に足したコミット ---");
      expect(repos.published.at(-1)).toMatchObject({ parent: "d".repeat(40) });
      activity.close();
    });

    it("実装の前に変えた題を、実装の PR のコミットに使う（PR #348 11回目のレビュー指摘）", async () => {
      const repos = new FakeRepos();
      const { activity, service, id } = await toImplement([implement("# 実装")], {
        repos,
      });
      service.renameTask(id, { title: "設計の承認の後に変えた題" });
      await drain(service);
      const done = service
        .get(id)
        ?.activity.findLast(
          (e) => e.type === "AgentRunCompleted" && e.payload.step === "implement",
        );
      expect(repos.published.at(-1)?.date).toBe(done?.at);
      expect(repos.published.at(-1)?.message).toContain("設計の承認の後に変えた題");
      activity.close();
    });

    it("競合したファイルが100件を超えても全件を記録し、先頭の100件だけを解消して101件目以降に目印が残っていれば、PR を作らない", async () => {
      const files = Array.from({ length: 150 }, (_, i) => `src/file-${i}.ts`);
      const repos = withBaseMoved();
      repos.mergeResult = { status: "conflicted", conflicts: files };
      repos.markers = [...files];
      const { activity, service, id } = await toImplement(
        [implement("# 実装 v1"), implement("# 実装 v2")],
        { repos, mergeBase: true },
      );
      await service.runNext(id);
      // 切り捨てずに、150件すべてを記録する
      expect(service.get(id)?.task.baseMerge?.conflicts).toEqual(files);
      // 先頭の100件だけを解消した
      repos.markers = files.slice(100);
      await service.runNext(id);
      const failed = service.get(id)?.task as Task;
      expect(failed.verifyFeedback).toEqual({ kind: "merge", files: files.slice(100) });
      expect(types(service, id).at(-1)).toBe("BaseConflictsRemained");
      expect(types(service, id)).not.toContain("FinalReviewSkipped");
      // 残りも解消すれば、PR の作成へ進む
      repos.markers = [];
      await drain(service);
      expect(types(service, id)).toContain("FinalReviewSkipped");
      activity.close();
    });

    it("目印の検査でファイルを読めなければ、目印なしとして PR を作らず、理由を示して止める。直れば続ける", async () => {
      const files = ["README.md", ".prettierignore"];
      const repos = withBaseMoved();
      repos.mergeResult = { status: "conflicted", conflicts: files };
      repos.markers = [...files];
      const { activity, service, id } = await toImplement(
        [implement("# 実装 v1"), implement("# 実装 v2")],
        { repos, mergeBase: true },
      );
      await service.runNext(id);
      repos.markersFail = "EACCES: permission denied, open 'README.md'";
      await service.runNext(id);
      expect(types(service, id)).not.toContain("FinalReviewSkipped");
      const task = service.get(id)?.task as Task;
      expect(task.status).toBe("paused");
      const shown = JSON.stringify(service.get(id)?.activity.slice(-3));
      expect(shown).toContain("merge.failed");
      expect(shown).toContain("EACCES");
      activity.close();
    });

    it("競合したファイルが上限（MAX_BASE_CONFLICTS）を超えるときは、取り込みを記録せずに理由を示して一時停止する", async () => {
      const repos = withBaseMoved();
      repos.mergeResult = {
        status: "conflicted",
        conflicts: Array.from({ length: MAX_BASE_CONFLICTS + 1 }, (_, i) => `f-${i}.ts`),
      };
      const { activity, service, id } = await toImplement([implement("# 実装")], {
        repos,
        mergeBase: true,
      });
      await drain(service);
      expect(repos.merges).toMatchObject([{ maxConflicts: MAX_BASE_CONFLICTS }]);
      const task = service.get(id)?.task as Task;
      expect(task.status).toBe("paused");
      expect(types(service, id)).not.toContain("BaseBranchMerged");
      expect(JSON.stringify(service.get(id)?.activity.at(-2)?.payload)).toContain("merge.failed");
      expect(task.baseMerge).toBeUndefined();
      activity.close();
    });

    it("解消できないまま続けて通らなければ一時停止し、競合の目印が残った実装は、レビューへ進められない", async () => {
      const repos = conflicted();
      const { activity, service, executor, id } = await toImplement(
        [implement("# 実装 v1"), implement("# 実装 v2"), implement("# 実装 v3")],
        { repos, mergeBase: true },
      );
      await drain(service);
      const task = service.get(id)?.task as Task;
      expect(task.status).toBe("paused");
      expect(task.pausedReason).toBe("verification");
      expect(JSON.stringify(task.pausedMessage)).toContain("verify.mergeConflictsRemain");
      expect(task.verifyFailures).toBe(MAX_VERIFY_ATTEMPTS);
      expect(types(service, id).filter((t) => t === "BaseConflictsRemained")).toHaveLength(3);
      expect(types(service, id)).not.toContain("FinalReviewSkipped");
      // 実行したのは、要求要件 2・設計 1・実装 3
      expect(executor.calls).toHaveLength(6);
      expect(canOverrideVerification(task)).toBe(false);
      expect(repos.published).toEqual([]);
      activity.close();
    });

    it("ベースブランチの最新を取得できなければ、実装を実行せず、理由を示して止める", async () => {
      const repos = withBaseMoved();
      repos.fetchBranchFail = "network is down";
      const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
        repos,
        mergeBase: true,
      });
      const runs = executor.calls.length;
      await service.runNext(id);
      expect(executor.calls.length).toBe(runs);
      const task = service.get(id)?.task as Task;
      expect(task.status).toBe("paused");
      expect(types(service, id)).toContain("AgentRunFailed");
      expect(JSON.stringify(service.get(id)?.activity.at(-2)?.payload)).toContain("merge.failed");
      expect(JSON.stringify(service.get(id)?.activity.at(-2)?.payload)).toContain(
        "network is down",
      );
      expect(task.baseMerge).toBeUndefined();
      activity.close();
    });

    it("取り込みを切ると（既定のテストの設定）、取り込まず、これまでどおり出す", async () => {
      const repos = withBaseMoved();
      const { activity, service } = await toImplement([implement("# 実装")], { repos });
      await drain(service);
      expect(repos.merges).toEqual([]);
      expect(repos.publishInputs).toEqual([{ baseCommit: "base123" }]);
      activity.close();
    });
  });

  describe("実装に変更が無い（PBI-90）", () => {
    const unchanged = () => {
      const repos = new FakeRepos();
      repos.unchanged = true;
      return repos;
    };

    it("工程を進めた後に変更が要らないとわかったら、PR を作らずに実装の承認待ちで止め、承認すると変更なしで完了する", async () => {
      const repos = unchanged();
      const { activity, service, executor, pulls, id } = await toImplement(
        [implement("# 変更は要らない\n\nすでに満たしている（src/pay.ts:3）")],
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
        [implement("# 変更は要らない"), implement("# 実装 v2")],
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
        implement("# 実装 v2（戻した）"),
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

    it("オーケストレーターに候補を見せてタスクに1つ選ばせ、すべての工程をそのイメージ・環境変数で実行する（PBI-318）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          planOutput(
            ', "image": "java", "images": {"requirements": "default"}, "imageReason": "pom.xml が Java 17"',
          ),
          completed(10),
        ],
        { realPlanner: true, config: withImages() },
      );
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const prompt = executor.calls[0]?.command.join(" ") ?? "";
      expect(prompt).toContain("- java：Java 17・Maven");
      // 工程ごとには選ばせない
      expect(prompt).toContain('"image": "イメージの名前"');
      expect(prompt).not.toContain('"images":');
      // 既定のイメージは候補に並べない（PBI-105）
      expect(prompt).not.toContain("- default：既定のイメージ");
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      // 工程ごとのイメージ（古い版の答えの形）は読まず、記録にも書かない
      expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
        image: "java",
        imageSource: "orchestrator",
        imageReason: "pom.xml が Java 17",
      });
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty("images");
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
        "imageUnexplained",
      );
      // オーケストレーターは既定のイメージ。要求要件もタスクのイメージ（java とその環境変数）
      expect(executor.images.slice(0, 2)).toEqual([
        { image: "sacty-agent:test" },
        { image: java.image, env: java.env },
      ]);
      expect(service.get(task.id)?.task.image).toBe("java");
      activity.close();
    });

    it("images の候補を見せて既定のイメージを選んだら、合わない理由を1つ記録する（PBI-318）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          planOutput(
            ', "image": "default", "imageReason": "pom.xml", "defaultReason": "文書だけで、Java のツールは要らない"',
          ),
          completed(10),
        ],
        { realPlanner: true, config: withImages() },
      );
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
        image: "default",
        defaultImageReason: "文書だけで、Java のツールは要らない",
      });
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
        "imageUnexplained",
      );
      expect(service.get(task.id)?.task.defaultImageReason).toBe(
        "文書だけで、Java のツールは要らない",
      );
      expect(executor.images[1]).toEqual({ image: "sacty-agent:test" });
      activity.close();
    });

    it("images の候補を見せて java を選んだら、既定のイメージの理由は書いても記録しない（PBI-318）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [planOutput(', "image": "java", "defaultReason": "要らない理由"'), completed(10)],
        { realPlanner: true, config: withImages() },
      );
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
        "defaultImageReason",
      );
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
        "imageUnexplained",
      );
      activity.close();
    });

    it("イメージを書かなかった・default と書いて理由が無いなら、理由が無いまま既定のイメージで動かすと記録する（PBI-318）", async () => {
      for (const extra of ["", ', "image": "default"']) {
        const activity = new SqliteActivityStore(join(dir, `unexplained-${extra.length}.db`));
        const { service, executor } = makeService(activity, [planOutput(extra), completed(10)], {
          realPlanner: true,
          config: withImages(),
        });
        const task = service.createTask({ projectId: "default", title: "決済API" });
        await service.runNext(task.id);
        const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
        expect(chosen?.type === "StepsChosen" && chosen.payload).toMatchObject({
          imageUnexplained: true,
        });
        expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
          "defaultImageReason",
        );
        expect(service.get(task.id)?.task.imageUnexplained).toBe(true);
        // 理由が無くても止めずに、既定のイメージで進める（作業履歴と画面に出す）
        expect(executor.images[1]).toEqual({ image: "sacty-agent:test" });
        activity.close();
      }
    });

    it("images が無い・プロジェクトの対象でイメージを指定しているときは、既定のイメージの理由を求めず、記録もしない（PBI-105）", async () => {
      const output = planOutput(', "image": "default", "defaultReason": "x"');
      // images が無い
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [output, completed(10)], {
        realPlanner: true,
      });
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const prompt = executor.calls[0]?.command.join(" ") ?? "";
      expect(prompt).not.toContain("defaultReason");
      expect(prompt).not.toContain("最後の手段");
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
        "defaultImageReason",
      );
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty(
        "imageUnexplained",
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
      expect(made.executor.calls[0]?.command.join(" ") ?? "").not.toContain("defaultReason");
      const picked = made.service.get(pinned.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(picked?.type === "StepsChosen" && picked.payload).toMatchObject({
        imageSource: "project",
        image: "default",
      });
      expect(picked?.type === "StepsChosen" && picked.payload).not.toHaveProperty(
        "defaultImageReason",
      );
      expect(picked?.type === "StepsChosen" && picked.payload).not.toHaveProperty(
        "imageUnexplained",
      );
      second.close();
    });

    it("実装の工程は、選んだイメージとその環境変数で実行する", async () => {
      const { activity, service, executor } = await toImplement([implement("# 実装")], {
        config: withImages(),
        planner: async () => ({
          steps: [...MVP_STEPS],
          fallback: false,
          testCommand: "mvn test",
          costUsd: 0,
          estimated: false,
          image: "java",
        }),
      });
      await drain(service);
      // 要求要件（2回）・設計・実装は、すべてタスクの java
      expect(executor.images).toEqual([
        { image: java.image, env: java.env },
        { image: java.image, env: java.env },
        { image: java.image, env: java.env },
        { image: java.image, env: java.env },
      ]);
      // sacty はテストを実行しない。実装の後に工程は走らない
      expect(executor.calls).toHaveLength(4);
      activity.close();
    });

    it("プロジェクトの対象でイメージを指定したら、オーケストレーターに選ばせず、タスクのイメージにする", async () => {
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
        [planOutput(', "image": "default"'), completed(10)],
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
      expect(chosen?.type === "StepsChosen" && chosen.payload.image).toBe("java");
      expect(chosen?.type === "StepsChosen" && chosen.payload).not.toHaveProperty("images");
      expect(chosen?.type === "StepsChosen" && chosen.payload.imageSource).toBe("project");
      expect(executor.images[1]).toEqual({ image: java.image, env: java.env });
      activity.close();
    });

    it("オーケストレーターの実行が結果の前に止まったら、読めた分の費用と不明の印を記録する（PBI-281）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 20_000 }; // $0.30
      const { service } = makeService(
        activity,
        [
          {
            kind: "failed",
            reason: "error",
            message: message("run.timeout", { minutes: 3 }),
            usage,
            costUnknown: true,
          },
        ],
        { realPlanner: true },
      );
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const latest = service.get(task.id);
      const failed = latest?.activity.find((e) => e.type === "OrchestratorFailed");
      expect(failed?.payload).toMatchObject({ usage, costUsd: 0.3, costUnknown: true });
      expect(latest?.task.budget).toMatchObject({ usedUsd: 0.3, unknownRuns: 1 });
      activity.close();
    });

    it("images に無いイメージを選んだ・指定したら、工程を決めずに理由を示して止まる", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [planOutput(', "image": "python"')], {
        realPlanner: true,
        config: withImages(),
      });
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
          image: "java",
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

  describe("タスクのイメージを人が変える（PBI-318）", () => {
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
    const plan = (chosen?: string) => async () => ({
      steps: [...MVP_STEPS],
      fallback: false,
      testCommand: "npm test",
      costUsd: 0,
      estimated: false,
      ...(chosen ? { image: chosen } : {}),
    });
    const changes = (service: TaskService, id: string) =>
      service
        .get(id)
        ?.activity.filter((e) => e.type === "TaskImageChanged")
        .map((e) => ({ actor: e.actor, ...(e.type === "TaskImageChanged" ? e.payload : {}) }));

    it("承認待ちの工程・終わった工程があっても変え、すべての工程の次の実行（手戻りを含む）から使う", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [out("# 要求要件 v1"), out("# 要求要件 v2"), design],
        { config: withImages(), planner: plan("java") },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      // 承認待ちの工程（要求要件）があっても変えられる
      service.changeTaskImage(id, { image: "playwright" });
      // 手戻り（差し戻し）でやり直す要求要件は、変えたイメージで実行する
      service.requestChanges(id, { step: "requirements", submission: 1, comments: ["足りない"] });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 2 });
      // 終わった工程があっても変えられ、次の工程（設計）から使う
      service.changeTaskImage(id, { image: "default" });
      await service.runNext(id);
      expect(executor.images).toEqual([used(java), used(playwright), DEFAULT]);
      // 台帳に、人が・何から何に変えたかを、新しいイベントで足す（工程を決めた記録は変えない）
      expect(changes(service, id)).toEqual([
        { actor: "person", from: "java", to: "playwright" },
        { actor: "person", from: "playwright", to: "default" },
      ]);
      const chosen = service.get(id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.type === "StepsChosen" && chosen.payload.image).toBe("java");
      const task = service.get(id)?.task;
      expect(task?.image).toBe("default");
      expect(task?.images).toBeUndefined();
      expect(task?.imageSource).toBe("orchestrator");
      expect(task?.imageChange).toMatchObject({ from: "playwright", to: "default" });
      activity.close();
    });

    it("実行中に変えても今の実行は変えず、次の実行から使う", async () => {
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
      // 実行中でも変えられる
      service.changeTaskImage(id, { image: "java" });
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

    it("失敗して一時停止したタスクのイメージを変えて、やり直しで変えたイメージで実行する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [{ kind: "failed", reason: "error", message: "Playwright が無い" }, out("# 要求要件")],
        { config: withImages(), planner: plan() },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("paused");
      service.changeTaskImage(id, { image: "playwright" });
      service.resume(id, {});
      await service.runNext(id);
      expect(executor.images).toEqual([DEFAULT, used(playwright)]);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });

    it("再開と一緒にタスクのイメージ・工程のエージェントを変え、補足を説明に足して、やり直しから使う", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const strong = agent({ id: "strong", model: "claude-opus-5-5" });
      const config = (): ConfigResult => {
        const loaded = withImages()() as { ok: true; config: SactyConfig };
        return {
          ok: true,
          config: {
            ...loaded.config,
            agents: Object.fromEntries([agent(), strong].map((a) => [a.id, a])),
          },
        };
      };
      const { service, executor } = makeService(
        activity,
        [{ kind: "failed", reason: "error", message: "Playwright が無い" }, out("# 要求要件")],
        { config, planner: plan() },
      );
      const { id } = service.createTask({
        projectId: "default",
        title: "決済API",
        body: "決済を作る",
      });
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("paused");
      service.resume(id, {
        note: "Playwright のイメージを使ってください。",
        image: "playwright",
        agents: { requirements: "strong" },
      });
      const after = service.get(id);
      // 設定の変更を、再開より前に記録する
      expect(
        after?.activity
          .filter((e) => ["TaskImageChanged", "StepAgentChanged", "TaskResumed"].includes(e.type))
          .map((e) => ({ type: e.type, actor: e.actor, payload: e.payload })),
      ).toEqual([
        {
          type: "TaskImageChanged",
          actor: "person",
          payload: { from: "default", to: "playwright" },
        },
        {
          type: "StepAgentChanged",
          actor: "person",
          payload: { step: "requirements", from: "claude-subscription", to: "strong" },
        },
        {
          type: "TaskResumed",
          actor: "person",
          payload: { retry: true, note: "Playwright のイメージを使ってください。" },
        },
      ]);
      expect(after?.task.body).toBe(
        "決済を作る\n\n## 補足（再開で人が足したもの）\n\nPlaywright のイメージを使ってください。",
      );
      await service.runNext(id);
      expect(executor.images).toEqual([DEFAULT, used(playwright)]);
      expect(promptOf(executor, 1)).toContain("Playwright のイメージを使ってください。");
      expect(promptOf(executor, 1)).toContain("claude-opus-5-5");
      activity.close();
    });

    it("再開と一緒に今と同じイメージを指定したら、変更を記録しない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [{ kind: "failed", reason: "error", message: "失敗" }],
        { config: withImages(), planner: plan("java") },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      service.resume(id, { image: "java" });
      expect(changes(service, id)).toEqual([]);
      expect(service.get(id)?.task.status).toBe("queued");
      activity.close();
    });

    it("再開の設定・補足が1つでも誤っていれば、正しいものも含めて何も記録せずに断る", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [{ kind: "failed", reason: "error", message: "失敗" }],
        { config: withImages(), planner: plan() },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済API", body: "説明" });
      await service.runNext(id);
      const before = service.get(id);
      const rejects = (input: unknown, code: string) =>
        expect(() => service.resume(id, input)).toThrow(
          expect.objectContaining({ messages: [expect.objectContaining({ code })] }),
        );
      // 正しいイメージの変更と、誤ったエージェント
      rejects(
        { note: "補足", image: "playwright", agents: { requirements: "missing" } },
        "agent.notInAgents",
      );
      rejects({ image: "missing" }, "image.notInImages");
      // 選んでいない工程（統合レビューのエージェントは、選んだ工程でも stepAgentChange が断る）
      rejects({ agents: { integrate: "claude-subscription" } }, "agent.stepMissing");
      // 補足の長さ（入力の上限と、説明に足した後の上限）
      expect(() => service.resume(id, { note: "あ".repeat(10_001) })).toThrow(
        expect.objectContaining({ name: "ZodError" }),
      );
      const after = service.get(id);
      expect(after?.activity.length).toBe(before?.activity.length);
      expect(after?.task).toMatchObject({ status: "paused", body: "説明" });
      expect(after?.task.image).toEqual(before?.task.image);
      expect(after?.task.agents).toEqual(before?.task.agents);
      activity.close();
    });

    it("差し戻しと一緒にタスクのイメージ・工程のエージェントを変え、やり直しから使う", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const strong = agent({ id: "strong", model: "claude-opus-5-5" });
      const config = (): ConfigResult => {
        const loaded = withImages()() as { ok: true; config: SactyConfig };
        return {
          ok: true,
          config: {
            ...loaded.config,
            agents: Object.fromEntries([agent(), strong].map((a) => [a.id, a])),
          },
        };
      };
      const { service, executor } = makeService(
        activity,
        [out("# 要求要件 v1"), out("# 要求要件 v2")],
        { config, planner: plan("java") },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      service.requestChanges(id, {
        step: "requirements",
        submission: 1,
        comments: ["足りない"],
        image: "playwright",
        agents: { requirements: "strong" },
      });
      const after = service.get(id);
      // 設定の変更を、差し戻しより前に記録する
      expect(
        after?.activity
          .filter((e) =>
            ["TaskImageChanged", "StepAgentChanged", "ChangesRequested"].includes(e.type),
          )
          .map((e) => ({ type: e.type, actor: e.actor })),
      ).toEqual([
        { type: "TaskImageChanged", actor: "person" },
        { type: "StepAgentChanged", actor: "person" },
        { type: "ChangesRequested", actor: "person" },
      ]);
      expect(after?.task.image).toBe("playwright");
      expect(after?.task.agents).toEqual({ requirements: "strong" });
      await service.runNext(id);
      expect(executor.images).toEqual([used(java), used(playwright)]);
      expect(promptOf(executor, 1)).toContain("claude-opus-5-5");
      activity.close();
    });

    it("差し戻しの設定が誤っていれば、差し戻しも含めて何も記録せずに断る", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out("# 要求要件")], {
        config: withImages(),
        planner: plan(),
      });
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      const before = service.get(id);
      const request = { step: "requirements", submission: 1, comments: ["足りない"] };
      expect(() =>
        service.requestChanges(id, {
          ...request,
          image: "playwright",
          agents: { requirements: "missing" },
        }),
      ).toThrow(
        expect.objectContaining({
          messages: [expect.objectContaining({ code: "agent.notInAgents" })],
        }),
      );
      expect(() => service.requestChanges(id, { ...request, image: "python" })).toThrow(
        expect.objectContaining({
          messages: [expect.objectContaining({ code: "image.notInImages" })],
        }),
      );
      const after = service.get(id);
      expect(after?.activity.length).toBe(before?.activity.length);
      expect(after?.task.status).toBe("awaiting_approval");
      expect(after?.task.image).toEqual(before?.task.image);
      activity.close();
    });

    it("差し戻しが 4 回目でも、設定を差し戻しの前に記録する（誤っていれば何も記録しない）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const outputs = Array.from({ length: 5 }, (_, i) => out(`# 要求要件 v${i + 1}`));
      const { service } = makeService(activity, outputs, {
        config: withImages(),
        planner: plan(),
      });
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      for (let i = 1; i <= 3; i++) {
        service.requestChanges(id, { step: "requirements", submission: i, comments: [`指摘${i}`] });
        await service.runNext(id);
      }
      const request = {
        step: "requirements",
        submission: 4,
        comments: ["まだ"],
      };
      // 誤った設定なら、設定の変更も差し戻しも記録しない
      const before = service.get(id);
      expect(() =>
        service.requestChanges(id, {
          ...request,
          image: "playwright",
          agents: { requirements: "missing" },
        }),
      ).toThrow(
        expect.objectContaining({
          messages: [expect.objectContaining({ code: "agent.notInAgents" })],
        }),
      );
      expect(service.get(id)?.activity.length).toBe(before?.activity.length);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");

      service.requestChanges(id, { ...request, image: "playwright" });
      const after = service.get(id);
      expect(after?.task.status).toBe("queued");
      expect(after?.task.escalation).toBeUndefined();
      expect(
        after?.activity
          .slice(before?.activity.length)
          .map((e) => ({ type: e.type, actor: e.actor })),
      ).toEqual([
        { type: "TaskImageChanged", actor: "person" },
        { type: "ChangesRequested", actor: "person" },
      ]);
      expect(after?.task.image).toBe("playwright");
      activity.close();
    });

    it("補足を足した説明が、再実行で直す説明の上限を超えるなら断る", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [{ kind: "failed", reason: "error", message: "失敗" }],
        { config: withImages(), planner: plan() },
      );
      const { id } = service.createTask({
        projectId: "default",
        title: "決済API",
        body: "あ".repeat(9_000),
      });
      await service.runNext(id);
      const room = resumeNoteRoom(service.get(id)?.task as Task);
      expect(room).toBe(TASK_BODY_MAX - 9_000 - `\n\n${RESUME_NOTE_HEADING}\n\n`.length);
      expect(() => service.resume(id, { note: "い".repeat(room + 1) })).toThrow(
        expect.objectContaining({ messages: [message("resume.bodyTooLong", { room })] }),
      );
      expect(service.get(id)?.task.status).toBe("paused");
      service.resume(id, { note: "い".repeat(room) });
      expect(service.get(id)?.task.status).toBe("queued");
      activity.close();
    });

    it("説明が上限ちょうどで補足を足せないときは、足せないことと取れる手を示して断る", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [{ kind: "failed", reason: "error", message: "失敗" }],
        { config: withImages(), planner: plan() },
      );
      const { id } = service.createTask({
        projectId: "default",
        title: "決済API",
        body: "あ".repeat(TASK_BODY_MAX),
      });
      await service.runNext(id);
      expect(resumeNoteRoom(service.get(id)?.task as Task)).toBeLessThan(0);
      let thrown: unknown;
      try {
        service.resume(id, { note: "い" });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ messages: [message("resume.bodyTooLong", { room: 0 })] });
      expect(renderMessage(message("resume.bodyTooLong", { room: 0 }), "ja")).toContain(
        "補足なしで再開するか",
      );
      expect(service.get(id)?.task.status).toBe("paused");
      // 補足なしなら再開できる
      service.resume(id, {});
      expect(service.get(id)?.task.status).toBe("queued");
      activity.close();
    });

    it("タスクのイメージを変えたら、実装を変えたイメージで実行する", async () => {
      const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
        config: withImages(),
        planner: plan("java"),
      });
      service.changeTaskImage(id, { image: "playwright" });
      await drain(service);
      // 要求要件（2回）・設計は java、変えた後の実装は変えたイメージ
      expect(executor.images).toEqual([used(java), used(java), used(java), used(playwright)]);
      activity.close();
    });

    it("実装の実行中に変えたら、今の実装は始めたときのイメージで動き、変えたことを記録する（PR #116 レビュー指摘）", async () => {
      const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
        config: withImages(),
        planner: plan("java"),
      });
      // 実装のコンテナを起動した（イメージを決めた）後、実行の最中に変える
      let during: Task | undefined;
      executor.respond = () => {
        if (executor.calls.length === 4) {
          during = service.changeTaskImage(id, { image: "playwright" });
        }
        return undefined;
      };
      await drain(service);
      expect(during && stepRunning(during, "implement")).toBe(true);
      // 今の実装は始めたときのイメージ（java）
      expect(executor.images[3]).toEqual(used(java));
      expect(service.get(id)?.task.image).toBe("playwright");
      expect(changes(service, id)).toEqual([{ actor: "person", from: "java", to: "playwright" }]);
      // 実行の記録には、実行を始めたときに使った名前を残す（PBI-318 レビュー指摘）
      expect(
        service
          .get(id)
          ?.activity.flatMap((e) =>
            e.type === "AgentRunStarted" && e.payload.step === "implement" ? [e.payload.image] : [],
          ),
      ).toEqual(["java"]);
      activity.close();
    });

    it("プロジェクトの対象の指定より、人の変更を優先する", async () => {
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
      service.changeTaskImage(id, { image: "playwright" });
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      expect(executor.images).toEqual([used(java), used(playwright)]);
      const task = service.get(id)?.task;
      expect(task?.imageSource).toBe("project");
      expect(task?.image).toBe("playwright");
      expect(task?.imageChange).toMatchObject({ from: "java", to: "playwright" });
      activity.close();
    });

    it("images に無い名前・同じ名前・工程が決まる前・中止したタスクは、理由を示して断る（日本語・英語）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      let config = withImages();
      const { service } = makeService(activity, [out("# 要求要件")], {
        config: () => config(),
        planner: plan("java"),
      });
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      const reject = (input: unknown) => {
        try {
          service.changeTaskImage(id, input);
        } catch (error) {
          if (!(error instanceof InvalidOperationError)) throw error;
          return error.messages.map((m) => [ja(m), renderMessage(m, "en")]);
        }
        throw new Error("not rejected");
      };
      // 工程を決める前は、変えても工程の選択で上書きされるので断る
      expect(reject({ image: "playwright" })).toEqual([
        [
          "工程がまだ決まっていないため、タスクのイメージを変えられません。工程が決まってから変えてください。",
          "The task image can't be changed because the steps are not decided yet. Change it after the steps are decided.",
        ],
      ]);
      await service.runNext(id);
      expect(reject({ image: "python" })).toEqual([
        [
          "イメージ「python」は config.yaml の images にありません。images の名前か default を選んでください。",
          'The image "python" is not in images in config.yaml. Choose a name in images, or default.',
        ],
      ]);
      expect(reject({ image: "java" })).toEqual([
        ["タスクのイメージは、すでに「java」です。", 'The task already uses the image "java".'],
      ]);
      // config.yaml の images から消した名前も断る（既定のイメージには戻せる）
      config = configOf(agent());
      expect(reject({ image: "playwright" })[0]?.[0]).toContain(
        "イメージ「playwright」は config.yaml の images にありません",
      );
      expect(service.changeTaskImage(id, { image: "default" }).image).toBe("default");
      // config.yaml を読めない・解析できないときは、名前の誤りではなく、設定の問題として断る（PR #116 レビュー指摘）
      config = () => ({
        ok: false,
        problem: message("config.missing", { path: "/x/config.yaml" }),
      });
      for (const name of ["playwright", "default"]) {
        const [[jaText, enText] = []] = reject({ image: name });
        expect(jaText).toMatch(
          /^config\.yaml を読めないため、タスクのイメージを指定・変更できません/,
        );
        expect(jaText).toContain("/x/config.yaml");
        expect(jaText).not.toContain("images にありません");
        expect(enText).toMatch(
          /^The task image can't be set or changed because config\.yaml can't be read/,
        );
      }
      config = withImages();
      // 入力の形が違えば、入力の誤り
      expect(() => service.changeTaskImage(id, { image: " " })).toThrow();
      expect(() => service.changeTaskImage(id, {})).toThrow();
      await service.cancel(id);
      expect(reject({ image: "playwright" })[0]?.[0]).toBe(ja(message("task.cancelled")));
      expect(changes(service, id)).toEqual([{ actor: "person", from: "java", to: "default" }]);
      activity.close();
    });

    it("API で変えられ、images に無い名前は 409 で理由を返す。工程ごとの古い API は無い", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out("# 要求要件")], {
        config: withImages(),
        planner: plan(),
      });
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      const app = createApp(service, "tok");
      const post = (body: unknown, path = "image") =>
        app.request(`/api/tasks/${id}/${path}`, {
          method: "POST",
          headers: { authorization: "Bearer tok", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const ok = await post({ image: "playwright" });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { task: Task }).task.image).toBe("playwright");
      const ng = await post({ image: "python" });
      expect(ng.status).toBe(409);
      expect(await ng.json()).toEqual({
        error: "invalid_operation",
        messages: [message("image.notInImages", { name: "python" })],
      });
      expect((await post({ image: "" })).status).toBe(400);
      expect((await post({ step: "design", image: "java" }, "images")).status).toBe(404);
      activity.close();
    });

    it("古い版の作業履歴（工程ごとのイメージ）を読み込んでも止まらず、工程ごとのイメージで続け、タスクのイメージに変えられる", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service: before } = makeService(activity, [], { config: withImages() });
      const { id } = before.createTask({ projectId: "default", title: "決済API" });
      // 古い版が書いた工程の選択（工程ごとのイメージ）と、人が工程のイメージを変えた記録
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "orchestrator",
            event: {
              type: "StepsChosen",
              payload: {
                steps: [...MVP_STEPS],
                fallback: false,
                testCommand: "npm test",
                costUsd: 0,
                estimated: false,
                images: { requirements: "java", design: "default" },
                imageSource: "orchestrator",
                defaultImageReasons: { design: "文書だけ" },
                imagesUnexplained: ["implement"],
              },
            },
          },
          {
            actor: "person",
            event: {
              type: "StepImageChanged",
              payload: { step: "design", from: "default", to: "playwright" },
            },
          },
        ],
      });
      // 再起動して読み込む
      const { service, executor } = makeService(activity, [out("# 要求要件"), design], {
        config: withImages(),
      });
      const loaded = service.get(id)?.task;
      expect(loaded?.images).toEqual({ requirements: "java", design: "playwright" });
      expect(loaded?.image).toBeUndefined();
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      // どの工程がどのイメージで動いたか：要求要件は java、設計は人が変えた playwright。実行の記録にも残す
      expect(executor.images).toEqual([used(java), used(playwright)]);
      expect(
        service
          .get(id)
          ?.activity.flatMap((e) => (e.type === "AgentRunStarted" ? [e.payload.image] : [])),
      ).toEqual(["java", "playwright"]);
      // タスクのイメージに変えると、変える前の名前は持たず（工程ごとに違うため）、工程ごとの記録は残る
      const changed = service.changeTaskImage(id, { image: "default" });
      expect(changed.image).toBe("default");
      expect(changed.images).toEqual({ requirements: "java", design: "playwright" });
      expect(changes(service, id)).toEqual([{ actor: "person", to: "default" }]);
      activity.close();
    });
  });

  describe("タスクの題を人が変える（PBI-323）", () => {
    const renames = (service: TaskService, id: string) =>
      service
        .get(id)
        ?.activity.filter((e) => e.type === "TaskRenamed")
        .map((e) => ({ actor: e.actor, ...(e.type === "TaskRenamed" ? e.payload : {}) }));
    /** 最後の実行に渡した指示（標準入力か、コマンドの引数）。 */
    const lastPrompt = (executor: FakeExecutor) =>
      `${executor.stdins.at(-1) ?? ""}\n${executor.calls.at(-1)?.command.join(" ") ?? ""}`;

    it("承認待ちで変え、作業履歴に人が・何から何に変えたかを残し、差し戻しのやり直しの指示から新しい題を使う", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [
        out("# 要求要件 v1"),
        out("# 要求要件 v2"),
      ]);
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(lastPrompt(executor)).toContain("# 決済API");
      // 前後の空白は除く。状態は変えない
      const renamed = service.renameTask(id, { title: "  決済APIの返金  " });
      expect(renamed.title).toBe("決済APIの返金");
      expect(renamed.status).toBe("awaiting_approval");
      expect(renamed.titleChange).toMatchObject({ from: "決済API", to: "決済APIの返金" });
      expect(renames(service, id)).toEqual([
        { actor: "person", from: "決済API", to: "決済APIの返金" },
      ]);
      service.requestChanges(id, { step: "requirements", submission: 1, comments: ["足りない"] });
      await service.runNext(id);
      expect(lastPrompt(executor)).toContain("# 決済APIの返金");
      // 作業履歴を読み直しても（デーモンの再起動）、新しい題のまま
      const { service: restarted } = makeService(activity, []);
      expect(restarted.get(id)?.task.title).toBe("決済APIの返金");
      activity.close();
    });

    it("実行中・一時停止中でも変えられ、今の実行は止めない。中止したタスクは断る", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const repos = new FakeRepos();
      const { service } = makeService(
        activity,
        [{ kind: "failed", reason: "error", message: "落ちた" }, out("# 要求要件")],
        { repos },
      );
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(service.renameTask(id, { title: "一時停止中に変えた題" }).status).toBe("paused");
      service.resume(id, {});
      // 作業領域を消して、実行を始めた後の準備（用意し直し）で待たせる
      rmSync(join(dir, "workspaces", id), { recursive: true, force: true });
      const gate = Promise.withResolvers<void>();
      repos.prepareGate = gate.promise;
      repos.prepareStarted = Promise.withResolvers<void>();
      const running = service.runNext(id);
      await repos.prepareStarted.promise;
      expect(service.get(id)?.task.status).toBe("running");
      expect(service.renameTask(id, { title: "実行中に変えた題" }).status).toBe("running");
      gate.resolve();
      await running;
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(service.get(id)?.task.title).toBe("実行中に変えた題");
      await service.cancel(id);
      expect(() => service.renameTask(id, { title: "中止した後の題" })).toThrow(
        new InvalidOperationError(message("task.cancelled")),
      );
      expect(renames(service, id)?.map((r) => r.to)).toEqual([
        "一時停止中に変えた題",
        "実行中に変えた題",
      ]);
      activity.close();
    });

    it("空・空白だけ・長すぎる題は入力の誤り、今と同じ題・無いタスクは理由を示して断り、何も記録しない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out("# 要求要件")]);
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      expect(() => service.renameTask(id, { title: "" })).toThrow(ZodError);
      expect(() => service.renameTask(id, { title: "   " })).toThrow(ZodError);
      expect(() => service.renameTask(id, { title: "あ".repeat(TASK_TITLE_MAX + 1) })).toThrow(
        ZodError,
      );
      expect(() => service.renameTask(id, {})).toThrow(ZodError);
      expect(() => service.renameTask(id, { title: "x", extra: 1 })).toThrow(ZodError);
      expect(() => service.renameTask(id, { title: " 決済API " })).toThrow(
        new InvalidOperationError(message("title.unchanged")),
      );
      expect(() => service.renameTask("missing", { title: "x" })).toThrow(
        new InvalidOperationError(message("task.notFound")),
      );
      expect(renames(service, id)).toEqual([]);
      // 上限ちょうどの題は変えられる
      const longest = "あ".repeat(TASK_TITLE_MAX);
      expect(service.renameTask(id, { title: longest }).title).toBe(longest);
      activity.close();
    });

    it("題にある PR のリンク（レビュー・引き継ぎの対象）が変わる・無くなる変更は断る。リンクを残せば変えられる", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out("# 要求要件")]);
      service.saveProject("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
      });
      const { id } = service.createTask({
        projectId: "default",
        title: "https://github.com/acme/app/pull/12 の指摘に返信して",
        plan: "direct",
      });
      await service.runNext(id);
      expect(service.get(id)?.task.repository).toBeDefined();
      for (const title of [
        "指摘に返信して",
        "https://github.com/acme/app/pull/13 の指摘に返信して",
      ]) {
        expect(() => service.renameTask(id, { title })).toThrow(
          new InvalidOperationError(message("title.pullRequestChanged", { number: 12 })),
        );
      }
      expect(
        service.renameTask(id, { title: "https://github.com/acme/app/pull/12 の指摘に返信する" })
          .title,
      ).toBe("https://github.com/acme/app/pull/12 の指摘に返信する");
      activity.close();
    });

    it("作業するリポジトリを用意する前（作成の直後）も、題の PR のリンクの変更・削除・追加を断る（PR #330 レビュー指摘）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, []);
      service.saveProject("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
      });
      const linked = service.createTask({
        projectId: "default",
        title: "https://github.com/acme/app/pull/12 をレビューする",
      });
      expect(service.get(linked.id)?.task.repository).toBeUndefined();
      for (const title of ["https://github.com/acme/app/pull/13 をレビューする", "レビューする"]) {
        expect(() => service.renameTask(linked.id, { title })).toThrow(
          new InvalidOperationError(message("title.pullRequestChanged", { number: 12 })),
        );
      }
      const plain = service.createTask({ projectId: "default", title: "決済API" });
      expect(() =>
        service.renameTask(plain.id, { title: "https://github.com/acme/app/pull/13 を直す" }),
      ).toThrow(new InvalidOperationError(message("title.pullRequestChanged", { number: 13 })));
      // 別のリポジトリの PR のリンクは、対象を決めないので変えられる
      expect(
        service.renameTask(plain.id, { title: "https://github.com/acme/other/pull/1 を参考に直す" })
          .title,
      ).toBe("https://github.com/acme/other/pull/1 を参考に直す");
      activity.close();
    });

    it("API で変えられ、空の題は 400、同じ題は 409 で理由を返す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [out("# 要求要件")]);
      const { id } = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(id);
      const app = createApp(service, "tok");
      const post = (body: unknown) =>
        app.request(`/api/tasks/${id}/title`, {
          method: "POST",
          headers: { authorization: "Bearer tok", "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      const ok = await post({ title: "返金API" });
      expect(ok.status).toBe(200);
      expect(((await ok.json()) as { task: Task }).task.title).toBe("返金API");
      const empty = await post({ title: " " });
      expect(empty.status).toBe(400);
      expect(await empty.json()).toMatchObject({
        error: "invalid_input",
        issues: [{ path: ["title"], message: { code: "input.titleRequired" } }],
      });
      const same = await post({ title: "返金API" });
      expect(same.status).toBe(409);
      expect(await same.json()).toEqual({
        error: "invalid_operation",
        messages: [message("title.unchanged")],
      });
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

    it("サービスを使う工程の前に起動してネットワークにつなぎ、終わったら消す。ほかの工程では起動しない", async () => {
      const services = new FakeServices(undefined, [
        { name: "db", ports: [5432], hostPorts: [{ port: 15432, target: 5432 }] },
      ]);
      const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
        services,
        planner: servicesPlan(),
      });
      // 要求要件・設計では起動しない
      expect(services.started).toHaveLength(0);
      await drain(service);
      // 実装の実行で起動して消す（最終レビューのテストのためには起動しない）
      expect(services.started.map((s) => s.spec)).toEqual([
        { file: "compose.yaml", names: ["db"] },
      ]);
      const [agentRun] = services.started;
      expect(agentRun?.workspaceDir).toBe(join(dir, "workspaces", id, "repo"));
      expect(services.stopped).toEqual([agentRun?.runId]);
      // 実装のエージェントを、サービスのネットワークにつなぐ
      expect(executor.networks[3]).toBe(`sacty-svc-${agentRun?.runId}_sacty`);
      expect(executor.networks.filter(Boolean)).toHaveLength(1);
      // 接続先をエージェントに伝える
      expect(promptOf(executor, 3)).toContain(
        "リポジトリのスキル・手順より先にスキル docker-services",
      );
      expect(executor.seeds[3]?.["skills/docker-services/SKILL.md"]).toContain(
        "db:5432 または localhost:5432・localhost:15432",
      );
      expect(executor.seeds[2]?.["skills/docker-services/SKILL.md"]).toContain(
        "サービスは起動していません",
      );
      expect(promptOf(executor, 3)).toContain(
        "- db：db:5432 または localhost:5432・localhost:15432",
      );
      expect(promptOf(executor, 2)).not.toContain("- db：");
      // 起動したことを作業履歴に残す
      const started = service.get(id)?.activity.filter((e) => e.type === "ServicesStarted") ?? [];
      expect(started.map((e) => e.type === "ServicesStarted" && e.payload.forTests)).toEqual([
        undefined,
      ]);
      // サービスのポートを localhost に転送する（PBI-60）。サービスを使わない工程では渡さない
      expect(executor.forwards[3]).toEqual([
        { port: 5432, host: "db" },
        { port: 15432, host: "db", target: 5432 },
      ]);
      expect(executor.forwards.filter(Boolean)).toHaveLength(1);
      expect(started.every((e) => e.type === "ServicesStarted" && !e.payload.sharedPorts)).toBe(
        true,
      );
      activity.close();
    });

    it("サービス起動後のスキル書き込みに失敗すると理由を記録して一時停止し、サービスを片付ける", async () => {
      const services = new FakeServices();
      const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
        services,
        planner: servicesPlan(),
      });
      skillWriteFailure.enabled = true;
      try {
        await drain(service);
        expect(service.get(id)?.task.status).toBe("paused");
        expect(JSON.stringify(activity.forTask(id))).toContain("skill write failed");
        expect(services.stopped).toEqual(services.started.map((entry) => entry.runId));
        expect(
          executor.seeds.some((seed) =>
            seed?.["skills/docker-services/SKILL.md"]?.includes("db:5432"),
          ),
        ).toBe(false);
      } finally {
        skillWriteFailure.enabled = false;
        activity.close();
      }
    });

    it("エージェントのイメージを、サービスを起動する前にイメージ ID に確定させ、その ID で実行する（PBI-130）", async () => {
      const services = new FakeServices();
      const id = `sha256:${"b".repeat(64)}`;
      services.imageIds = { "sacty-agent:test": id };
      const { activity, service, executor } = await toImplement([implement("# 実装")], {
        services,
        planner: servicesPlan(),
      });
      await drain(service);
      // サービスを起動する前に確定させる（起動の後にタグが変わっても、確定したイメージで動く）
      expect(services.order.indexOf("imageId:sacty-agent:test")).toBeLessThan(
        services.order.indexOf("start"),
      );
      // サービスを使わない工程（要求要件・設計）では確かめない（PBI-130 レビュー指摘）
      expect(services.order).toEqual(["imageId:sacty-agent:test", "start"]);
      expect(executor.images[3]?.image).toBe(id);
      activity.close();
    });

    for (const mode of ["pause", "cancel"] as const) {
      it(`イメージ ID の確定を待つ間に${mode === "pause" ? "一時停止" : "中止"}されたら、確定を打ち切り、サービスもエージェントも始めない（PBI-130 レビュー指摘）`, async () => {
        const services = new FakeServices();
        services.imageHold = true;
        const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
          services,
          planner: servicesPlan(),
        });
        const before = executor.calls.length;
        const running = service.runNext(id);
        await services.imageEntered.promise;
        await (mode === "pause" ? service.pause(id) : service.cancel(id));
        await running;
        expect(services.aborted).toEqual([services.imageRuns[0]]);
        expect(services.started).toHaveLength(0);
        expect(executor.calls).toHaveLength(before);
        expect(service.get(id)?.task.status).toBe(mode === "pause" ? "paused" : "cancelled");
        activity.close();
      });
    }

    it("イメージ ID を確かめられなければ、名前のまま実行する（PBI-130）", async () => {
      const services = new FakeServices();
      const { activity, service, executor } = await toImplement([implement("# 実装")], {
        services,
        planner: servicesPlan(),
      });
      await drain(service);
      expect(executor.images[3]?.image).toBe("sacty-agent:test");
      activity.close();
    });

    it("複数のサービスが使うポートは localhost に転送せず、作業履歴と指示に残す。ポートが無ければ転送を渡さない（PBI-60）", async () => {
      const services = new FakeServices(undefined, [
        { name: "api", ports: [8080, 9000], otherPorts: [{ port: 8125, protocol: "udp" }] },
        { name: "mock", ports: [8080] },
        { name: "worker", ports: [] },
      ]);
      const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
        services,
        planner: servicesPlan(),
      });
      await drain(service);
      expect(executor.forwards[3]).toEqual([{ port: 9000, host: "api" }]);
      const skill = executor.seeds[3]?.["skills/docker-services/SKILL.md"] ?? "";
      expect(skill).toContain(
        "localhost:8080 は、複数のサービスが使う番号のため、転送していません",
      );
      expect(skill).toContain("api:8125/udp（localhost には転送していません）");
      const started = service.get(id)?.activity.filter((e) => e.type === "ServicesStarted") ?? [];
      expect(started.map((e) => e.type === "ServicesStarted" && e.payload.sharedPorts)).toEqual([
        [8080],
      ]);
      expect(promptOf(executor, 3)).toContain(
        "- mock：mock:8080（localhost:8080 は、複数のサービスが使う番号のため、転送していません）",
      );
      activity.close();

      // 転送するポートが無ければ、転送を渡さない（コマンドはこれまでどおり）
      const portless = new FakeServices(undefined, [{ name: "worker", ports: [] }]);
      const second = await toImplement([implement("# 実装")], {
        services: portless,
        planner: servicesPlan(),
      });
      await drain(second.service);
      expect(second.executor.networks[3]).toBeDefined();
      expect(second.executor.forwards.filter(Boolean)).toHaveLength(0);
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
      const { activity, service, id } = await toImplement([implement("# 実装")], {
        services,
        sharedComposes: shared,
        projects: projectsWithShared(),
        planner: plan({ servicesReason: "単体テストだけで、外部のサービスを使わない" }),
      });
      await drain(service);
      expect(shared.calls).toHaveLength(0);
      expect(services.started).toHaveLength(0);
      expect(services.stopped).toHaveLength(0);
      expect(types(service, id)).toContain("FinalReviewSkipped");
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

    it("共用の compose を選ぶと、工程の実行ごとに、実行専用のディレクトリに取得して起動し、終わったら消す", async () => {
      const services = new FakeServices(undefined, [{ name: "redis", ports: [6379] }]);
      const shared = new FakeSharedComposes();
      const { activity, service, executor, id } = await toImplement([implement("# 実装")], {
        services,
        sharedComposes: shared,
        projects: projectsWithShared(),
        planner: plan({
          services: { compose: "infra", names: ["redis"], steps: ["implement"] },
          servicesReason: "結合テストが Redis を使う（README）",
        }),
      });
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
      // 実装の実行で取得する（実行ごとに別のディレクトリ）
      expect(shared.calls).toHaveLength(1);
      const [agentRun] = services.started;
      expect(shared.calls.map((c) => c.dest)).toEqual([
        join(dir, "workspaces", "_shared-compose", agentRun?.runId ?? ""),
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
      ]);
      expect(agentRun?.workspaceDir).toBe(shared.calls[0]?.dest);
      expect(agentRun?.secrets).toContain("ghp_secret");
      expect(services.stopped).toEqual([agentRun?.runId]);
      // 終わったら、取得したディレクトリも消す
      for (const call of shared.calls) expect(existsSync(call.dest)).toBe(false);
      // サービス名でも localhost でも接続できる（PBI-60 と同じ）
      expect(executor.forwards[3]).toEqual([{ port: 6379, host: "redis" }]);
      expect(promptOf(executor, 3)).toContain("- redis：redis:6379 または localhost:6379");
      const started = service.get(id)?.activity.filter((e) => e.type === "ServicesStarted") ?? [];
      expect(started.map((e) => e.type === "ServicesStarted" && e.payload.compose)).toEqual([
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
      const { activity, service, id } = await toImplement([implement("# 実装")], {
        services,
        sharedComposes: shared,
        planner: plan({ services: { file: "compose.yaml", names: ["db"], steps: ["implement"] } }),
      });
      await drain(service);
      expect(shared.calls).toHaveLength(0);
      expect(services.started.map((s) => s.spec)).toEqual([
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
        expect(prompt).toContain("servicesReason");
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

    it("工程のエージェントに GitHub の読み取りの中継を渡し、承認した成果で頼まれたコメントを、承認の後に1回だけ投稿する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const registered: unknown[][] = [];
      const output = [
        "# 指摘への対応の案",
        "",
        "```json",
        JSON.stringify({
          "sacty-github-comments": {
            comments: [
              { url: "https://github.com/acme/app/pull/12", body: "ご指摘の件は、こう直します。" },
              { url: "https://github.com/other/app/pull/1", body: "対象の外" },
              { url: "https://github.com/acme/app/commit/abc", body: "PR・Issue ではない" },
            ],
          },
        }),
        "```",
      ].join("\n");
      const { service, executor } = makeService(activity, [out(output)], {
        pulls,
        planner: investigatePlanner,
        gateway: {
          ...fakeGateway(),
          register: (...args: unknown[]) => {
            registered.push(args);
            return fakeGateway().register();
          },
        },
      });
      service.saveProject("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
      });
      const { id } = service.createTask({
        projectId: "default",
        title: "https://github.com/acme/app/pull/12 の指摘に返信して",
      });
      await service.runNext(id);
      // 設定に関わらず、プロジェクトで選んだアカウントのホストを中継に結びつけ、トークンはコンテナに渡さない
      expect(registered[0]?.[4]).toEqual({ "github.com": "me" });
      const env = executor.calls[0]?.env ?? {};
      expect(env.SACTY_GITHUB_URL).toBe("http://host.docker.internal:5001/r/sacty-gw-run/github");
      expect(env.SACTY_GITHUB_HOSTS).toBe("github.com");
      expect(env.GH_HOST).toBe("github.com");
      expect(JSON.stringify(env)).not.toContain("ghp_secret");
      expect(executor.calls[0]?.hostGateway).toBe(true);
      // 承認の前には投稿しない
      expect(pulls.issueComments).toHaveLength(0);
      service.approve(id, { step: "investigate", submission: 1 });
      expect(service.queuedTaskIds()).toEqual([id]);
      await service.runNext(id);
      await service.runNext(id); // 二度は投稿しない
      expect(pulls.issueComments).toHaveLength(1);
      expect(pulls.issueComments[0]).toMatchObject({
        repo: "https://github.com/acme/app",
        number: 12,
        token: "ghp_secret",
      });
      expect(pulls.issueComments[0]?.body).toContain("ご指摘の件は、こう直します。");
      expect(pulls.issueComments[0]?.body).toContain(`sacty-comment:${id}:investigate:`);
      const posted = service.get(id)?.task.githubComments?.investigate;
      expect(posted?.results).toEqual([
        {
          target: "https://github.com/acme/app/pull/12",
          url: "https://github.com/acme/app/issues/12#issuecomment-1",
        },
        { target: "https://github.com/other/app/pull/1", failed: expect.anything() },
        { target: "https://github.com/acme/app/commit/abc", failed: expect.anything() },
      ]);
      expect(service.queuedTaskIds()).toEqual([]);
      activity.close();
    });

    it("投稿の後・記録の前に止まっても、目印で投稿済みのコメントを見つけて使い、二度投稿しない（複数のコメント）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const output = JSON.stringify({
        "sacty-github-comments": {
          comments: [
            { url: "https://github.com/acme/app/pull/12", body: "一つめ" },
            { url: "https://github.com/acme/app/issues/3", body: "二つめ" },
          ],
        },
      });
      const { service } = makeService(activity, [out(output)], {
        pulls,
        planner: investigatePlanner,
      });
      const { id } = service.createTask({ projectId: "default", title: "返信して" });
      await service.runNext(id);
      service.approve(id, { step: "investigate", submission: 1 });
      // GitHubCommentsPosted の記録だけを一度失敗させる（外部のコメントだけが残る）
      const append = activity.append.bind(activity);
      let failOnce = true;
      activity.append = (entry) => {
        if (failOnce && entry.events.some((e) => e.event.type === "GitHubCommentsPosted")) {
          failOnce = false;
          throw new Error("disk full");
        }
        return append(entry);
      };
      await expect(service.runNext(id)).rejects.toThrow("disk full");
      expect(pulls.issueComments).toHaveLength(2);
      expect(service.get(id)?.task.githubComments).toBeUndefined();
      await service.runNext(id);
      expect(pulls.issueComments).toHaveLength(2);
      expect(service.get(id)?.task.githubComments?.investigate?.results).toEqual([
        {
          target: "https://github.com/acme/app/pull/12",
          url: "https://github.com/acme/app/issues/12#issuecomment-1",
        },
        {
          target: "https://github.com/acme/app/issues/3",
          url: "https://github.com/acme/app/issues/3#issuecomment-2",
        },
      ]);
      activity.close();
    });

    it("既存のコメントを探す間に一時停止されたら、新しく投稿せず、記録もしない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const hold = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      class HoldingPulls extends FakePulls {
        holding = true;
        override async findIssueComment(input: { repo: string; number: number; marker: string }) {
          if (this.holding) {
            entered.resolve();
            await hold.promise;
          }
          return super.findIssueComment(input);
        }
      }
      const pulls = new HoldingPulls();
      const output = JSON.stringify({
        "sacty-github-comments": {
          comments: [{ url: "https://github.com/acme/app/pull/12", body: "返信" }],
        },
      });
      const { service } = makeService(activity, [out(output)], {
        pulls,
        planner: investigatePlanner,
      });
      const { id } = service.createTask({ projectId: "default", title: "返信して" });
      await service.runNext(id);
      service.approve(id, { step: "investigate", submission: 1 });
      const running = service.runNext(id);
      await entered.promise;
      const pausing = service.pause(id);
      hold.resolve();
      await running;
      await pausing;
      expect(pulls.issueComments).toHaveLength(0);
      expect(service.get(id)?.task.githubComments).toBeUndefined();
      activity.close();
    });

    it("頼みの JSON を読めなければ、どれも投稿せずに理由を記録する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const output = [
        '{"sacty-github-comments": {"comments": [{"url": "https://github.com/acme/app/pull/1", "body": "a"}]}}',
        '{"sacty-github-comments": {"comments": [{"url": "https://github.com/acme/app/pull/2", "body": "b"}]}}',
      ].join("\n");
      const { service } = makeService(activity, [out(output)], {
        pulls,
        planner: investigatePlanner,
      });
      service.saveProject("default", {
        name: "デフォルト",
        targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
        githubAccounts: { "github.com": "me" },
      });
      const { id } = service.createTask({ projectId: "default", title: "返信して" });
      await service.runNext(id);
      service.approve(id, { step: "investigate", submission: 1 });
      await service.runNext(id);
      expect(pulls.issueComments).toHaveLength(0);
      expect(service.get(id)?.task.githubComments?.investigate).toMatchObject({
        results: [],
        failed: expect.anything(),
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
      // 判定の塊を含む最後の result を本文にする（最終の答えの後の通知への返答を投稿しない。PBI-154）
      expect(executor.calls[0]?.preferResult).toBe('"sacty-review-verdict"');
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

    it("JSON のエスケープで書いた秘密値は、デコードした後のコメント（行・差分の外・パス）にも残さず、PR に投稿しない（PBI-131）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      // 実行に渡した秘密値（oauth-secret）を、1 文字だけ Unicode エスケープ・改行や引用符のエスケープを混ぜて書く
      const raw = [
        "# 評価",
        "",
        '前置きの "引用符" の後に続けても見落とさない：{"sacty-review-comments": [',
        '{"path": "src/retry.ts", "line": 2, "body": "鍵は oauth-s\\u0065cret です"},',
        '{"path": "src/retry.ts", "line": 40, "body": "差分の外：\\"oauth\\u002dsecret\\"\\n次の行"},',
        '{"path": "src/oauth-secre\\u0074.ts", "line": 1, "body": "パスにも"}',
        "]}",
      ].join("\n");
      const { service } = makeService(activity, [out(raw)], {
        pulls,
        planner: reviewPlanner,
        secrets: { "claude-oauth-token": "oauth-secret" },
      });
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.reviewComments).toEqual([
        { path: "src/retry.ts", line: 2, body: "鍵は [REDACTED] です" },
      ]);
      expect(task?.outputs.review).toContain('差分の外："[REDACTED]"');
      expect(task?.outputs.review).toContain("`src/[REDACTED].ts:1` パスにも");

      await service.runNext(id);
      expect(pulls.reviews).toHaveLength(1);
      const posted = JSON.stringify(pulls.reviews[0]);
      expect(posted).not.toContain("oauth-secret");
      expect(pulls.reviews[0]?.comments[0]?.body).toContain("鍵は [REDACTED] です");
      expect(JSON.stringify(activity.forTask(id))).not.toContain("oauth-secret");
      // 作業履歴に残す出力からも、エスケープした形を消す（後でデコードされても戻らない）
      expect(JSON.stringify(activity.forTask(id))).not.toMatch(
        /u0065cret|u002dsecret|secre\\+u0074/,
      );
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
      // 投稿の直前に PR の先頭が変わっていた（PBI-111。フォークからの PR は、打ち切らずに投稿する。PBI-465）
      pulls.states[12] = { state: "open", headSha: "n".repeat(40), fork: true };
      await expect(service.runNext(id)).rejects.toThrow("disk full");
      expect(pulls.reviews).toHaveLength(2);
      // やり直しの前に、さらに push されても、投稿したときの先頭を記録する
      pulls.states[12] = { state: "open", headSha: "m".repeat(40), fork: true };
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
        "## Sacty のレビュー",
        "",
        "@alice 判定：提案あり（マージは可）",
        "",
        "# 総評",
      ]);
      activity.close();
    });

    it("sacty の設定で選んでいれば、PR の作者ではなく自分（投稿するアカウント）にメンションする", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service } = makeService(
        activity,
        [out(`# 総評\n\n${block({ "sacty-review-verdict": { verdict: "suggestions" } })}`)],
        {
          pulls,
          planner: reviewPlanner,
          settings: new MemorySettingsStore({
            intakeLabel: "sacty",
            reviewLabel: "sacty-review",
            reviewMentionSelf: true,
          }),
        },
      );
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      await service.runNext(id);
      const body = pulls.reviews[0]?.body ?? "";
      expect(body.split("\n")[3]).toBe("@me 判定：提案あり（マージは可）");
      expect(body).not.toContain("@alice");
      activity.close();
    });

    it("トークンを取り出している間にプロジェクトのアカウントが変わっても、投稿に使ったアカウントにメンションする（PR #197 レビュー指摘）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const github = new FakeGitHub({ me: "ghp_secret", alice: "ghp_alice" });
      const { service } = makeService(
        activity,
        [out(`# 総評\n\n${block({ "sacty-review-verdict": { verdict: "suggestions" } })}`)],
        {
          pulls,
          github,
          planner: reviewPlanner,
          settings: new MemorySettingsStore({
            intakeLabel: "sacty",
            reviewLabel: "sacty-review",
            reviewMentionSelf: true,
          }),
        },
      );
      const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
      await service.runNext(id);
      // 投稿のためにトークンを取り出している間に、プロジェクトのアカウントを PR の作者（alice）に変える
      const token = github.token.bind(github);
      github.token = async (host, account) => {
        const value = await token(host, account);
        service.saveProject("default", {
          name: "デフォルト",
          targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
          githubAccounts: { "github.com": "alice" },
        });
        return value;
      };
      await service.runNext(id);
      expect(pulls.reviews[0]?.token).toBe("ghp_secret");
      const body = pulls.reviews[0]?.body ?? "";
      expect(body.split("\n")[3]).toBe("@me 判定：提案あり（マージは可）");
      expect(body).not.toContain("@alice");
      activity.close();
    });

    it("フォークからの PR は、投稿の直前に PR の先頭が変わっていたら、レビューしたコミットに投稿し、その旨を本文と作業履歴に残す（PBI-111）", async () => {
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
        pulls.states[12] = {
          state: "open",
          fork: true,
          ...(headSha === undefined ? {} : { headSha }),
        };
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
      pulls.states[12] = { state: "open", headSha: "n".repeat(40), fork: true };
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

    describe("GitHub の一時的な失敗は、間を置いて自動でやり直す（PBI-301）", () => {
      const github = (status: number, detail = "Service Unavailable") =>
        new MessageError(
          message("github.failed", { action: "getPr", status, detail, hint: "none" }),
        );
      /** 最初の N 回だけ、PR の状態・PR の情報の読み取りを失敗させる。 */
      class FlakyPulls extends FakePulls {
        statusFailures = 0;
        prInfoFailures = 0;
        failWith: Error = github(503);
        override async status(input: { repo: string; token: string; number: number }) {
          if (this.statusFailures > 0) {
            this.statusFailures--;
            this.checked.push(input);
            throw this.failWith;
          }
          return super.status(input);
        }
        override async pullRequest(input: { repo: string; token: string; number: number }) {
          if (this.prInfoFailures > 0) {
            this.prInfoFailures--;
            this.prInfoRequests.push(input);
            throw this.failWith;
          }
          return super.pullRequest(input);
        }
      }
      const retried = (service: TaskService, id: string) =>
        service
          .get(id)
          ?.activity.filter((e) => e.type === "ReviewGitHubRetried")
          .map((e) => e.payload) ?? [];

      it("レビューの投稿の直前の PR の確認が 503 で失敗しても、待ってやり直して投稿し、止まらず、PR に知らせも出さない", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FlakyPulls();
        const { service, executor } = makeService(activity, [out("# 評価")], {
          pulls,
          planner: reviewPlanner,
          reviewRetryDelaysMs: [1, 1, 1],
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        pulls.statusFailures = 2;
        await service.runNext(id);
        await noticesSettled(service);
        const task = service.get(id)?.task;
        expect(task && isCompleted(task)).toBe(true);
        expect(pulls.reviews).toHaveLength(1);
        expect(executor.calls).toHaveLength(1);
        // 止まっていないので、PR に「止まりました」の知らせは出ない
        expect(pulls.issueComments).toEqual([]);
        // やり直したことは作業履歴に残る
        expect(retried(service, id)).toMatchObject([
          { where: "reviewPost", attempt: 1, maxAttempts: 3 },
          { where: "reviewPost", attempt: 2, maxAttempts: 3 },
        ]);
        expect(ja(retried(service, id)[0]?.message)).toContain("503");
        activity.close();
      });

      it("回数の上限まで失敗したら、今までどおり理由を記録して止まり、PR に知らせる。再開すると投稿する", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FlakyPulls();
        const { service } = makeService(activity, [out("# 評価")], {
          pulls,
          planner: reviewPlanner,
          reviewRetryDelaysMs: [1, 1],
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        pulls.statusFailures = 100;
        await service.runNext(id);
        await noticesSettled(service);
        const paused = service.get(id)?.task;
        expect(paused?.status).toBe("paused");
        expect(paused?.pausedReason).toBe("error");
        expect(ja(paused?.pausedMessage)).toContain("503");
        // 最初の1回 + やり直し 2 回
        expect(pulls.checked.filter((c) => c.number === 12)).toHaveLength(3);
        expect(retried(service, id)).toHaveLength(2);
        expect(pulls.reviews).toHaveLength(0);
        expect(pulls.issueComments).toHaveLength(1);
        expect(pulls.issueComments[0]?.body).toContain("503");
        // 再開して成功すれば、知らせは解消済みになる
        pulls.statusFailures = 0;
        service.resume(id, {});
        await service.runNext(id);
        const done = service.get(id)?.task;
        expect(done && isCompleted(done)).toBe(true);
        expect(isOpenStopNotice(pulls.issueComments[0]?.body ?? "")).toBe(false);
        activity.close();
      });

      it.each([
        ["429", () => github(429, "rate limit")],
        ["403 のレート制限", () => github(403, "You have exceeded a secondary rate limit")],
        [
          "接続の失敗",
          () => Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } }),
        ],
      ])("一時的な失敗（%s）もやり直す", async (_name, failure) => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FlakyPulls();
        pulls.failWith = failure();
        const { service } = makeService(activity, [out("# 評価")], {
          pulls,
          planner: reviewPlanner,
          reviewRetryDelaysMs: [1],
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        pulls.statusFailures = 1;
        await service.runNext(id);
        const task = service.get(id)?.task;
        expect(task && isCompleted(task)).toBe(true);
        expect(retried(service, id)).toHaveLength(1);
        activity.close();
      });

      it.each([
        ["403 の権限", () => github(403, "Resource not accessible by personal access token")],
        ["404", () => github(404, "Not Found")],
        ["401", () => github(401, "Bad credentials")],
        ["422", () => github(422, "Validation Failed")],
        ["GitHub の失敗でないエラー", () => new Error("GitHub API 502")],
      ])("待っても変わらない失敗（%s）は、やり直さずにすぐ止まる", async (_name, failure) => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FlakyPulls();
        pulls.failWith = failure();
        const { service } = makeService(activity, [out("# 評価")], {
          pulls,
          planner: reviewPlanner,
          reviewRetryDelaysMs: [1, 1],
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        pulls.statusFailures = 1;
        await service.runNext(id);
        expect(service.get(id)?.task.status).toBe("paused");
        expect(retried(service, id)).toEqual([]);
        expect(pulls.checked.filter((c) => c.number === 12)).toHaveLength(1);
        activity.close();
      });

      it("レビューの対象の PR の確認が 503 で失敗しても、やり直して進める。上限まで失敗したら止まる", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FlakyPulls();
        pulls.prInfoFailures = 1;
        const { service } = makeService(activity, [out("# 評価")], {
          pulls,
          planner: reviewPlanner,
          reviewRetryDelaysMs: [1, 1],
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        expect(service.get(id)?.task.reviewTarget?.number).toBe(12);
        expect(retried(service, id)).toMatchObject([{ where: "reviewTarget", attempt: 1 }]);
        activity.close();

        const second = new SqliteActivityStore(join(dir, "second.db"));
        const stuck = new FlakyPulls();
        stuck.prInfoFailures = 100;
        const again = makeService(second, [], {
          pulls: stuck,
          planner: reviewPlanner,
          reviewRetryDelaysMs: [1, 1],
        });
        const otherId = importReviewIssue(again.service, "https://github.com/acme/app/pull/12");
        await again.service.runNext(otherId);
        expect(again.service.get(otherId)?.task.status).toBe("paused");
        expect(stuck.prInfoRequests).toHaveLength(3);
        second.close();
      });

      it("待っている間に一時停止を求められたら、やり直しをやめ、止まった理由を上書きしない", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FlakyPulls();
        const { service } = makeService(activity, [out("# 評価")], {
          pulls,
          planner: reviewPlanner,
          reviewRetryDelaysMs: [60_000],
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        pulls.statusFailures = 100;
        const running = service.runNext(id);
        // やり直しの前の待ち（60 秒）に入ってから、一時停止する
        await waitFor(() => retried(service, id).length === 1, {
          what: "やり直しの前の待ちに入ること",
        });
        await service.pause(id);
        await running;
        expect(pulls.reviews).toHaveLength(0);
        expect(pulls.checked.filter((c) => c.number === 12)).toHaveLength(1);
        expect(service.get(id)?.task.pausedReason).toBe("manual");
        activity.close();
      });
    });

    describe("レビューが止まったことを、レビューを頼んだ PR で知らせる（PBI-292）", () => {
      const capacity: AgentOutcome = {
        kind: "failed",
        reason: "error",
        message: "Selected model is at capacity. Please try a different model.",
      };
      const review = (text = "# 評価"): AgentOutcome => ({
        kind: "completed",
        output: text,
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
      });

      it.each([
        "http://127.0.0.1:4700",
        "http://localhost:4700",
        "http://[::1]:4700",
        "https://sacty.example.com",
        "画面の URL ではない文字列",
      ])(
        "止まった知らせは、サービスに渡した画面の URL（%s）に関わらず、画面の URL・注釈を出さず「Sacty の画面で」の案内を書く（PBI-471）",
        async (webUrl) => {
          const activity = new SqliteActivityStore(dbPath);
          const pulls = new FakePulls();
          const { service } = makeService(activity, [capacity], {
            pulls,
            planner: reviewPlanner,
            webUrl,
          });
          const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
          await service.runNext(id);
          await noticesSettled(service);
          const body = pulls.issueComments[0]?.body ?? "";
          expect(body).not.toContain("/tasks/");
          expect(body).not.toContain("http://");
          expect(body).not.toContain("タスクの画面は、依頼した人のマシンでだけ開けます。");
          expect(body).toContain("Sacty の画面で、このタスクを再開してください。");
          activity.close();
        },
      );

      it("モデルの混雑で止まったら、PR に止まったこと・理由・画面での再開の案内を1回書く", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        const { service } = makeService(activity, [capacity], { pulls, planner: reviewPlanner });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await noticesSettled(service);
        expect(service.get(id)?.task).toMatchObject({ status: "paused", pausedReason: "error" });
        expect(pulls.issueComments).toHaveLength(1);
        const comment = pulls.issueComments[0];
        expect(comment).toMatchObject({
          repo: "https://github.com/acme/app",
          number: 12,
          token: "ghp_secret",
        });
        expect(comment?.body).toContain("Sacty のレビューが止まりました");
        expect(comment?.body).toContain("Selected model is at capacity");
        expect(comment?.body).toContain("Sacty の画面で、このタスクを再開してください。");
        // 自分のアカウントの投稿だけを、同じ止まり方の投稿として探す
        expect(pulls.listedAccounts).toEqual(["me"]);
        activity.close();
      });

      it("同じ止まり方で何度止まっても、同じ PR に何度も書かない。違う止まり方なら別に書く", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        const { service } = makeService(
          activity,
          [
            capacity,
            capacity,
            { kind: "failed", reason: "error", message: "disk full" },
            review("# 評価\n\n- src/retry.ts:1 上限が無い"),
          ],
          { pulls, planner: reviewPlanner },
        );
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await noticesSettled(service);
        service.resume(id, {});
        await service.runNext(id);
        await noticesSettled(service);
        expect(service.get(id)?.task.status).toBe("paused");
        expect(pulls.issueComments).toHaveLength(1);
        // 違う止まり方
        service.resume(id, {});
        await service.runNext(id);
        await noticesSettled(service);
        expect(pulls.issueComments).toHaveLength(2);
        expect(pulls.issueComments[1]?.body).toContain("disk full");
        // 再開してレビューを投稿すると、止まったことの投稿はどちらも解消済みになる
        service.resume(id, {});
        await service.runNext(id);
        await service.runNext(id);
        await noticesSettled(service);
        const done = service.get(id)?.task;
        expect(done && isCompleted(done)).toBe(true);
        expect(pulls.reviews).toHaveLength(1);
        for (const comment of pulls.issueComments) {
          expect(isOpenStopNotice(comment.body)).toBe(false);
          expect(comment.body).toContain("解消済み");
          expect(comment.body).toContain(done?.reviewPost?.url ?? "(none)");
        }
        activity.close();
      });

      it("解消済みにした後で、同じ止まり方で止まったら、また書く（再レビューの回）", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        const { service } = makeService(activity, [capacity, review(), capacity, review()], {
          pulls,
          planner: reviewPlanner,
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await noticesSettled(service);
        service.resume(id, {});
        await service.runNext(id);
        await service.runNext(id);
        await noticesSettled(service);
        expect(pulls.issueComments).toHaveLength(1);
        expect(isOpenStopNotice(pulls.issueComments[0]?.body ?? "")).toBe(false);
        service.rereview(id);
        await service.runNext(id);
        await noticesSettled(service);
        expect(pulls.issueComments).toHaveLength(2);
        expect(isOpenStopNotice(pulls.issueComments[1]?.body ?? "")).toBe(true);
        activity.close();
      });

      it("レビューを投稿できずに止まったときも知らせる。投稿のトークンは載せない", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        pulls.reviewFail = "403 Resource not accessible ghp_secret";
        const { service } = makeService(activity, [review()], { pulls, planner: reviewPlanner });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await service.runNext(id);
        await noticesSettled(service);
        expect(pulls.issueComments).toHaveLength(1);
        expect(pulls.issueComments[0]?.body).toContain("403");
        expect(pulls.issueComments[0]?.body).not.toContain("ghp_secret");
        activity.close();
      });

      it("レビュー用のラベルで取り込んだ PR は、レビューの対象を決める前に止まっても知らせる", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        pulls.prInfoFail = "502 Bad Gateway";
        const { service } = makeService(activity, [], { pulls });
        const [task] = service.importIssues([
          {
            repo: "https://github.com/acme/app",
            number: 30,
            title: "PR 30",
            body: "本文",
            url: "https://github.com/acme/app/pull/30",
            labels: ["sacty-review"],
            pullRequest: true,
            review: "label",
          },
        ]);
        await service.runNext(task?.id ?? "");
        await noticesSettled(service);
        expect(service.get(task?.id ?? "")?.task.reviewTarget).toBeUndefined();
        expect(pulls.issueComments).toHaveLength(1);
        expect(pulls.issueComments[0]).toMatchObject({ number: 30 });
        expect(pulls.issueComments[0]?.body).toContain("502 Bad Gateway");
        activity.close();
      });

      it("人が止めたときと、レビューの対象の PR が無いタスクが止まったときは、PR に書かない", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        const { service } = makeService(activity, [review()], { pulls, planner: reviewPlanner });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await service.pause(id);
        await noticesSettled(service);
        expect(service.get(id)?.task.status).toBe("paused");
        // 対象の PR が無く、レビューを頼まれた PR が分からないタスク
        const other = service.createTask({ projectId: "default", title: "ほかの作業" });
        await service.runNext(other.id);
        await noticesSettled(service);
        expect(service.get(other.id)?.task.status).toBe("paused");
        expect(pulls.issueComments).toEqual([]);
        activity.close();
      });

      it("PR に書けなくても、タスクは止まったままで、ほかの操作は止めない", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        pulls.commentFail = "500 boom";
        const { service } = makeService(activity, [capacity, review()], {
          pulls,
          planner: reviewPlanner,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await noticesSettled(service);
        expect(service.get(id)?.task.status).toBe("paused");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("PR に知らせられませんでした"));
        // 知らせが無くても、再開してレビューを投稿すれば完了する（解消する対象は無い）
        pulls.commentFail = undefined;
        service.resume(id, {});
        await service.runNext(id);
        await service.runNext(id);
        await noticesSettled(service);
        const done = service.get(id)?.task;
        expect(done && isCompleted(done)).toBe(true);
        expect(pulls.editAttempts).toBe(0);
        warn.mockRestore();
        activity.close();
      });

      it("解消済みへの書き換えに失敗しても、レビューの投稿と完了は変わらず、警告を出す", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        const { service } = makeService(activity, [capacity, review()], {
          pulls,
          planner: reviewPlanner,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await noticesSettled(service);
        // 解消していない知らせが正常にできている
        expect(pulls.issueComments).toHaveLength(1);
        pulls.editFail = "500 boom";
        service.resume(id, {});
        await service.runNext(id);
        await service.runNext(id);
        await noticesSettled(service);
        expect(pulls.editAttempts).toBe(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("解消済みにできませんでした"));
        const done = service.get(id)?.task;
        expect(done && isCompleted(done)).toBe(true);
        expect(pulls.reviews).toHaveLength(1);
        // 書き換えられなかった知らせは、解消していないまま残る
        expect(isOpenStopNotice(pulls.issueComments[0]?.body ?? "")).toBe(true);
        warn.mockRestore();
        activity.close();
      });

      it("知らせを投稿している最中に、再開してレビューの投稿が終わっても、できた知らせを解消済みにする", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const gate = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        class SlowPulls extends FakePulls {
          override async commentIssue(input: {
            repo: string;
            token: string;
            number: number;
            body: string;
          }) {
            entered.resolve();
            await gate.promise;
            return super.commentIssue(input);
          }
        }
        const pulls = new SlowPulls();
        const { service } = makeService(activity, [capacity, review()], {
          pulls,
          planner: reviewPlanner,
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await entered.promise;
        // 知らせの投稿が終わらないうちに、再開してレビューを書き、投稿に進む
        service.resume(id, {});
        await service.runNext(id);
        const posting = service.runNext(id);
        await waitFor(() => service.get(id)?.task.reviewPost !== undefined, {
          what: "レビューの投稿の記録",
        });
        gate.resolve();
        await posting;
        await noticesSettled(service);
        const done = service.get(id)?.task;
        expect(done && isCompleted(done)).toBe(true);
        expect(pulls.issueComments).toHaveLength(1);
        expect(isOpenStopNotice(pulls.issueComments[0]?.body ?? "")).toBe(false);
        expect(pulls.issueComments[0]?.body).toContain("解消済み");
        activity.close();
      });

      /** 最初の知らせの投稿だけ、gate が開くまで終わらせない偽物。 */
      const slowFirstNotice = () => {
        const gate = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<void>();
        class SlowFirst extends FakePulls {
          slow = true;
          override async commentIssue(input: {
            repo: string;
            token: string;
            number: number;
            body: string;
          }) {
            if (this.slow) {
              this.slow = false;
              entered.resolve();
              await gate.promise;
            }
            return super.commentIssue(input);
          }
        }
        return { pulls: new SlowFirst(), gate, entered };
      };

      it("知らせの投稿を待っている間に「再レビュー」が始まっても、できた知らせを解消済みにする", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const { pulls, gate, entered } = slowFirstNotice();
        const { service } = makeService(activity, [capacity, review()], {
          pulls,
          planner: reviewPlanner,
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await entered.promise;
        service.resume(id, {});
        await service.runNext(id);
        const posting = service.runNext(id);
        await waitFor(() => service.get(id)?.task.reviewPost !== undefined, {
          what: "レビューの投稿の記録",
        });
        // レビューを投稿した記録の後、解消の処理が知らせを待っている間に、再レビューが始まる（対象の PR が消える）
        expect(service.get(id)?.task.reviewPost).toBeDefined();
        service.rereview(id);
        expect(service.get(id)?.task.reviewTarget).toBeUndefined();
        gate.resolve();
        await posting;
        await noticesSettled(service);
        expect(pulls.issueComments).toHaveLength(1);
        expect(isOpenStopNotice(pulls.issueComments[0]?.body ?? "")).toBe(false);
        expect(pulls.issueComments[0]?.body).toContain("解消済み");
        activity.close();
      });

      it("先の知らせの投稿を待っている間に、違う理由で続けて止まっても、それぞれの理由を知らせる", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const { pulls, gate, entered } = slowFirstNotice();
        const fail = (text: string): AgentOutcome => ({
          kind: "failed",
          reason: "error",
          message: text,
        });
        const { service } = makeService(
          activity,
          [capacity, fail("disk full"), fail("network down")],
          { pulls, planner: reviewPlanner },
        );
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await entered.promise;
        for (const _ of [1, 2]) {
          service.resume(id, {});
          await service.runNext(id);
        }
        expect(service.get(id)?.task.status).toBe("paused");
        gate.resolve();
        await noticesSettled(service);
        expect(pulls.issueComments).toHaveLength(3);
        const bodies = pulls.issueComments.map((c) => c.body);
        expect(bodies[0]).toContain("Selected model is at capacity");
        expect(bodies[1]).toContain("disk full");
        expect(bodies[2]).toContain("network down");
        activity.close();
      });

      it("知らせの投稿の通信が終わらなくても、期限で通信を止めて警告にし、レビューの投稿の処理を終える", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const release = Promise.withResolvers<void>();
        const entered = Promise.withResolvers<AbortSignal | undefined>();
        class HangingPost extends FakePulls {
          override async commentIssue(input: {
            repo: string;
            token: string;
            number: number;
            body: string;
            signal?: AbortSignal;
          }) {
            entered.resolve(input.signal);
            await release.promise;
            return super.commentIssue(input);
          }
        }
        const pulls = new HangingPost();
        const { service } = makeService(activity, [capacity, review()], {
          pulls,
          planner: reviewPlanner,
          stopNoticeTimeoutMs: 50,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        const signal = await entered.promise;
        service.resume(id, {});
        await service.runNext(id);
        // 知らせの通信が終わらないまま、レビューの投稿の処理は期限で終わる
        await service.runNext(id);
        const done = service.get(id)?.task;
        expect(done && isCompleted(done)).toBe(true);
        expect(pulls.reviews).toHaveLength(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("PR に知らせられませんでした"));
        // 待ちだけでなく通信も止める。遅れて終わっても、投稿されない
        expect(signal?.aborted).toBe(true);
        release.resolve();
        // 放した通信の続き（マイクロタスクだけで進む）が済むまで
        await loopTurn();
        expect(pulls.issueComments).toEqual([]);
        warn.mockRestore();
        activity.close();
      });

      it("解消済みへの書き換えの通信が終わらなくても、期限で通信を止めて警告にし、完了のまま終える", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const entered = Promise.withResolvers<AbortSignal | undefined>();
        class HangingEdit extends FakePulls {
          override async editIssueComment(input: {
            id: number;
            body: string;
            signal?: AbortSignal;
          }) {
            entered.resolve(input.signal);
            await new Promise(() => {});
          }
        }
        const pulls = new HangingEdit();
        const { service } = makeService(activity, [capacity, review()], {
          pulls,
          planner: reviewPlanner,
          stopNoticeTimeoutMs: 50,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        await noticesSettled(service);
        expect(pulls.issueComments).toHaveLength(1);
        service.resume(id, {});
        await service.runNext(id);
        await service.runNext(id);
        const done = service.get(id)?.task;
        expect(done && isCompleted(done)).toBe(true);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("解消済みにできませんでした"));
        expect((await entered.promise)?.aborted).toBe(true);
        warn.mockRestore();
        activity.close();
      });

      it("解消が期限を超えて知らせを待てなかったとき、投稿の最中の知らせの通信も止め、その後に止まったときの知らせは書ける", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const release = Promise.withResolvers<void>();
        const posts: { signal?: AbortSignal; body: string }[] = [];
        class HangingFirstTwo extends FakePulls {
          override async commentIssue(input: {
            repo: string;
            token: string;
            number: number;
            body: string;
            signal?: AbortSignal;
          }) {
            posts.push({
              ...(input.signal ? { signal: input.signal } : {}),
              body: input.body,
            });
            // 最初の2件の通信は終わらない（解放されるまで）。3件目からは普通に投稿できる
            if (posts.length <= 2) await release.promise;
            return super.commentIssue(input);
          }
        }
        const pulls = new HangingFirstTwo();
        const timeoutMs = 800;
        const fail = (text: string): AgentOutcome => ({
          kind: "failed",
          reason: "error",
          message: text,
        });
        const { service } = makeService(
          activity,
          [capacity, fail("disk full"), review(), fail("network down")],
          { pulls, planner: reviewPlanner, stopNoticeTimeoutMs: timeoutMs },
        );
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        // 期限の合図は、テストが持つ。実時間では切れず、テストが手で切る（機械の速さに左右されない）
        const deadlines: AbortController[] = [];
        const timer = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
          const controller = new AbortController();
          if (ms === timeoutMs) deadlines.push(controller);
          return controller.signal;
        });
        try {
          const expire = (controller: AbortController | undefined) =>
            controller?.abort(new DOMException("The operation timed out.", "TimeoutError"));
          const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
          // 知らせ1（終わらない）の後ろに、知らせ2を順番待ちにする
          await service.runNext(id);
          await waitFor(() => posts.length === 1, { what: "知らせ1の投稿の開始" });
          expect(posts).toHaveLength(1);
          service.resume(id, {});
          await service.runNext(id);
          // 知らせ2は、止まったときに同期で順番待ちに入る（待つ処理は無い）
          await loopTurn();
          // 再開してレビューを投稿する。解消は、順番待ちの最後（知らせ2）を待つ
          service.resume(id, {});
          await service.runNext(id);
          const posting = service.runNext(id);
          await waitFor(() => service.get(id)?.task.reviewPost !== undefined, {
            what: "レビューの投稿の記録",
          });
          expect(service.get(id)?.task.reviewPost).toBeDefined();
          // 解消を待っている間に再レビューを始め、もう一度止める（知らせ3）
          service.rereview(id);
          await service.runNext(id);
          expect(service.get(id)?.task.status).toBe("paused");
          // 知らせ1が自分の期限で終わると、知らせ2が（止まっているので）投稿に進み、終わらない。
          // 知らせ2自身の期限より先に、解消の期限が切れて、解消の処理は戻る
          // 期限の合図は、知らせ1・解消の順にできている
          expect(deadlines).toHaveLength(2);
          expire(deadlines[0]);
          await waitFor(() => posts.length === 2, { what: "知らせ2の投稿の開始" });
          // 知らせ2の期限が3つ目にできる。切るのは解消の期限（2つ目）だけで、知らせ2の期限は切らない
          expect(deadlines).toHaveLength(3);
          expire(deadlines[1]);
          await posting;
          const second = posts[1];
          expect(second?.body).toContain("disk full");
          expect(second?.signal?.aborted).toBe(true);
          // 止めた合図の理由で見分ける（時間の差には頼らない）。知らせ自身の期限なら TimeoutError、
          // 解消が期限を超えて止めたときは、理由の無い abort() の AbortError になる
          expect((second?.signal?.reason as DOMException | undefined)?.name).toBe("AbortError");
          expect((posts[0]?.signal?.reason as DOMException | undefined)?.name).toBe("TimeoutError");
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("解消済みにできませんでした"));
          // 通信を後から放しても、止めた知らせは投稿されない。その後に止まった知らせ3は書かれる
          release.resolve();
          // 放した通信の続き（マイクロタスクだけで進む）が済み、知らせ3の投稿が終わるまで
          await loopTurn();
          await noticesSettled(service);
          expect(posts).toHaveLength(3);
          expect(pulls.issueComments).toHaveLength(1);
          expect(pulls.issueComments[0]?.body).toContain("network down");
        } finally {
          // 途中の検査が落ちても、差し替えを戻す（後続のテストの期限が実時間で切れるように）
          warn.mockRestore();
          timer.mockRestore();
        }
        activity.close();
      });

      it("知らせの一覧の取得が終わらなくても、期限で警告にして終わり、次の知らせの処理を塞がない", async () => {
        const activity = new SqliteActivityStore(dbPath);
        class HangingList extends FakePulls {
          hang = true;
          override async listIssueComments(input: {
            repo: string;
            number: number;
            prefix: string;
            account?: string;
            signal?: AbortSignal;
          }) {
            if (this.hang) await new Promise(() => {});
            return super.listIssueComments(input);
          }
        }
        const pulls = new HangingList();
        const { service } = makeService(activity, [capacity, capacity], {
          pulls,
          planner: reviewPlanner,
          stopNoticeTimeoutMs: 50,
        });
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        // 知らせの処理が、期限（50 ミリ秒）で終わるまで
        await noticesSettled(service);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("PR に知らせられませんでした"));
        // 期限で終わったので、次に止まったときの知らせは、前の待ちに塞がれずに書ける
        pulls.hang = false;
        service.resume(id, {});
        await service.runNext(id);
        await noticesSettled(service);
        expect(pulls.issueComments).toHaveLength(1);
        warn.mockRestore();
        activity.close();
      });

      it("レビューの工程に渡す既存のコメントでは、ほかのプロジェクトで選んだ同じホストのアカウントの知らせも除く", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        const { service } = makeService(activity, [review()], { pulls, planner: reviewPlanner });
        service.saveProject(undefined, {
          name: "別",
          targets: [{ scope: "repo", target: "https://github.com/acme/other" }],
          githubAccounts: { "github.com": "alice" },
        });
        const id = importReviewIssue(service, "https://github.com/acme/app/pull/12");
        await service.runNext(id);
        expect(pulls.feedbackAccounts).toContain("me");
        expect(pulls.feedbackNoticeAccounts.at(-1)).toEqual(
          expect.arrayContaining(["me", "alice"]),
        );
        activity.close();
      });
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
        [plan("skip-design"), out("# 要求要件")],
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
        steps: ["requirements", "implement", "deployment"],
        plan: "skip-design",
        reason: "小さな変更",
        fallback: false,
        testCommand: "npm test",
        // 起点のコミットにデプロイの確認のスキルが無いので、マージの後の監視の工程は飛ばす（PBI-116）
        deployment: {
          skipped: { code: "deploy.stepSkipped", params: { detail: { code: "deploy.noSkill" } } },
        },
      });
      // 実装する組み合わせの先頭に調査は置かない。最初の工程（要求要件）を同じ実行で続けて行う
      expect(promptOf(executor, 1)).toContain("あなたはソフトウェア開発の工程エージェントです");
      expect(executor.calls).toHaveLength(2);
      const task = service.get(id)?.task;
      expect(task?.steps.map((st) => [st.key, st.state])).toEqual([
        ["requirements", "active"],
        ["implement", "todo"],
        ["deployment", "skip"],
      ]);
      // 終わった工程が無いので、工程の見直しは待たない
      expect(task?.stepReview).toBeUndefined();
      expect(task?.stepsChoice).toEqual({
        plan: "skip-design",
        reason: "小さな変更",
        fallback: false,
      });
      // 判断の費用も予算に入る
      expect(task?.budget.usedUsd).toBeGreaterThan(0.0015);
      expect(task?.gate).toEqual({ step: "requirements", submission: 1 });
      activity.close();
    });

    it("工程の見直し：承認済みの要求要件で既存の仕組みに沿うと分かれば、設計を飛ばして実装し、要求要件の受け入れ条件を観点にする", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          plan("standard", "権限の扱いを確かめたい"),
          out("# 要求要件\n\n- 管理者の判定は既存の isAdmin()（src/auth.ts:3）を使う"),
          stepReview(["design"], "isAdmin で表示を切り替えるだけ"),
          out(
            `# 実装の説明\n\n- isAdmin() のときだけリンクを出す\n\n${block({
              "sacty-test-map": [{ viewpointId: "REQ", tests: ["menu.test.ts › 管理者だけ"] }],
            })}`,
          ),
        ],
        { realPlanner: true },
      );
      const { id } = service.createTask({
        projectId: "default",
        title: "管理者リンク",
        body: "/restricted へのリンクをサイドメニューに足す。管理者だけに出す",
      });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      // 見直しと実装、PR の作成まで進める
      for (let i = 0; i < 6 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      const reviewed = service.get(id)?.activity.find((e) => e.type === "StepsSkipped");
      expect(reviewed?.actor).toBe("orchestrator");
      expect(reviewed?.payload).toMatchObject({
        after: "requirements",
        steps: ["design"],
        reason: "isAdmin で表示を切り替えるだけ",
      });
      // 見直しには、終わった工程（要求要件）の成果を渡す
      expect(promptOf(executor, 2)).toContain("このタスクの工程「要求要件」が終わりました");
      expect(promptOf(executor, 2)).toContain("isAdmin()（src/auth.ts:3）");
      // 飛ばした工程は実行せず、実装は承認済みの要求要件に従う
      const implement = promptOf(executor, 3);
      expect(implement).toContain("人間が承認した要求要件に従って実装し");
      expect(implement).toContain("isAdmin()（src/auth.ts:3）");
      expect(implement).toContain("[REQ] 承認済みの要求要件の受け入れ条件");
      expect(executor.calls).toHaveLength(4);
      const task = service.get(id)?.task;
      expect(task?.steps.map((st) => [st.key, st.state])).toEqual([
        ["requirements", "done"],
        ["design", "skip"],
        ["implement", "active"],
        ["deployment", "skip"],
      ]);
      expect(task?.gate).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });

    it("工程の見直しの実行が、コンテナが止まったことを確かめられずに失敗したら、次の工程を始めずに止める", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          plan("standard"),
          out("# 要求要件"),
          {
            kind: "failed",
            reason: "error",
            message: { code: "run.containerNotConfirmed", params: { name: "sacty-run" } },
          },
          out("# 設計"),
        ],
        { realPlanner: true },
      );
      const { id } = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(id);
      service.approve(id, { step: "requirements", submission: 1 });
      await service.runNext(id);
      // 元のコンテナが動いたままかもしれないので、設計を実行しない
      expect(executor.calls).toHaveLength(3);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.pausedReason).toBe("error");
      expect(activeStep(task as Task)).toBe("design");
      const types = service.get(id)?.activity.map((e) => e.type) ?? [];
      expect(types.slice(-2)).toEqual(["StepsSkipped", "TaskPaused"]);
      activity.close();
    });

    it("工程の見直しの答えを読めなければ、止めずに工程を飛ばさないで進める。組み合わせ direct は見直さずに実装する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          plan("standard"),
          out("# 要求要件"),
          out("見直しの答えなし"),
          out("# 設計"),
          plan("direct", "isAdmin で切り替えるだけ"),
          out("# 実装の説明"),
        ],
        { realPlanner: true },
      );
      const a = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(a.id);
      service.approve(a.id, { step: "requirements", submission: 1 });
      await service.runNext(a.id);
      const failed = service.get(a.id)?.activity.find((e) => e.type === "StepsSkipped");
      expect(failed?.actor).toBe("sacty");
      expect(failed?.payload).toMatchObject({ after: "requirements", steps: [] });
      expect(failed?.type === "StepsSkipped" && ja(failed.payload.reason)).toContain(
        "工程を飛ばさずに進めます",
      );
      expect(service.get(a.id)?.task.gate).toEqual({ step: "design", submission: 1 });

      const b = service.createTask({ projectId: "default", title: "B" });
      await service.runNext(b.id);
      expect(service.get(b.id)?.task.steps.map((st) => st.key)).toEqual([
        "implement",
        "deployment",
      ]);
      expect(service.get(b.id)?.activity.some((e) => e.type === "StepsSkipped")).toBe(false);
      expect(promptOf(executor, 5)).toContain("要求要件・設計の工程を省いています");
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

    it("設計を省いたタスクは、要求要件の受け入れ条件を実装の観点にして、実装の承認待ちに進む", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const { service, executor } = makeService(
        activity,
        [
          out("# 要求要件"),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["a.test.ts › 受け入れ条件"] }]),
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
      expect(executor.calls).toHaveLength(2);
      const task = service.get(id)?.task;
      expect(task?.gate).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });

    it("テストの対応にテストがあれば、差分で確かめる申告は使わず、理由の無い空の対応は対応させていないものとする", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          out("# 要求要件"),
          implement("# 実装の説明", [
            { viewpointId: "REQ", tests: ["a.test.ts › 動く"], untested: "使わない理由" },
            { viewpointId: "REQ2", tests: [], untested: "" },
          ]),
        ],
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
      await service.runNext(id);
      expect(executor.calls).toHaveLength(2);
      expect(service.get(id)?.task.testMap).toEqual([
        { viewpointId: "REQ", tests: ["a.test.ts › 動く"] },
      ]);
      activity.close();
    });
  });

  describe("既存の PR を引き継いで直す", () => {
    const head = "f".repeat(40);
    const steps = (extra: Record<string, unknown> = {}) =>
      out(
        block({
          "sacty-steps": {
            plan: "direct",
            reason: "指摘への対応",
            testCommand: "npm test",
            continuePullRequest: true,
            ...extra,
          },
        }),
        200,
      );
    /** 人が作った PR #12（同じリポジトリの feature/retry から main へ）。 */
    const humanPullRequest = (pulls: FakePulls, patch: Partial<PullRequestInfo> = {}) => {
      pulls.prInfo = {
        ...pulls.prInfo,
        state: "open",
        headRef: "feature/retry",
        headRepo: "https://github.com/acme/app",
        baseRef: "main",
        ...patch,
      };
    };
    const old: PullRequestFeedback = {
      key: "review_comment:1",
      kind: "review_comment",
      author: "bob",
      at: "2026-01-01T00:00:00Z",
      path: "src/retry.ts",
      line: 3,
      body: "回数は定数にしてください",
    };
    const body = "https://github.com/acme/app/pull/12 のレビューの指摘に対応する";

    describe("引き継いだ PR の指摘への対応を、PR に返信する（PBI-352）", () => {
      const map = [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }];
      const answered = (responses: unknown[], title = "# 実装の説明") =>
        out(
          [title, block({ "sacty-responses": responses }), block({ "sacty-test-map": map })].join(
            "\n\n",
          ),
        );
      const summary: PullRequestFeedback = {
        key: "review:21",
        kind: "review",
        author: "bob",
        at: "2026-01-01T00:01:00Z",
        body: "全体に、ログが足りません",
      };
      const chat: PullRequestFeedback = {
        key: "comment:31",
        kind: "comment",
        author: "carol",
        at: "2026-01-01T00:02:00Z",
        body: "ありがとうございます",
      };
      const replies = (pulls: FakePulls) =>
        pulls.issueComments.filter((c) => c.body.startsWith("<!-- sacty-reply:"));
      const posted = (service: TaskService, id: string) =>
        (service.get(id)?.activity ?? []).flatMap((e) =>
          e.type === "RemarkRepliesPosted" ? [e.payload] : [],
        );
      /** 時計を進める量（記録できなかった後の、やり直しまでの待ちを越えるため）。 */
      let skew = 0;
      const setup = (outcomes: AgentOutcome[], pulls = new FakePulls()) => {
        const activity = new SqliteActivityStore(dbPath);
        const repos = new FakeRepos();
        repos.branchHeads["feature/retry"] = head;
        humanPullRequest(pulls);
        pulls.feedbackBy[12] = [old, summary, chat];
        const made = makeService(activity, [steps(), ...outcomes], {
          realPlanner: true,
          pulls,
          repos,
          now: () => Date.now() + 10 * 60_000 + skew,
        });
        const { id } = made.service.createTask({
          projectId: "default",
          title: "PR #12 の指摘",
          body,
        });
        return { ...made, activity, pulls, id };
      };
      const run = async (service: TaskService, id: string) => {
        for (let i = 0; i < 12 && service.queuedTaskIds().includes(id); i++) {
          await service.runNext(id);
        }
      };

      it("実装の指示に、指摘ごとの ID（キー）と対応の形を渡し、対応を書いた指摘ごとに、行へのコメントには返信、それ以外には元へのリンクを付けた PR のコメントを1回ずつ投稿する。対応を書かなかった指摘には返信しない", async () => {
        const { activity, service, executor, pulls, id } = setup([
          answered([
            { remarkId: "review_comment:1", status: "addressed", text: "回数を定数にしました" },
            {
              remarkId: "review:21",
              status: "declined",
              text: "ログの追加は、この PR の目的の外です",
            },
            // 渡していない ID への対応は読まない
            { remarkId: "comment:999", status: "addressed", text: "知らない指摘" },
          ]),
        ]);
        await run(service, id);
        const task = service.get(id)?.task;
        expect(task?.gate).toEqual({ step: "implement", submission: 1 });
        const prompt = promptOf(executor, 1);
        expect(prompt).toContain('"id":"review_comment:1"');
        expect(prompt).toContain('"id":"review:21"');
        expect(prompt).toContain('"remarkId" には、下のデータの "id" をそのまま書く');
        expect(prompt).toContain('"status": "addressed か declined"');
        // 実装に渡した記録に、指摘ごとの対応が残る
        const passed = service.get(id)?.activity.find((e) => e.type === "ContinuedFeedbackPassed");
        expect(passed?.type === "ContinuedFeedbackPassed" && passed.payload).toMatchObject({
          keys: ["review_comment:1", "review:21", "comment:31"],
          responses: [
            { key: "review_comment:1", status: "addressed", text: "回数を定数にしました" },
            { key: "review:21", status: "declined", text: "ログの追加は、この PR の目的の外です" },
          ],
        });
        // 行へのコメントの指摘：そのコメントへの返信
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(pulls.reviewReplies[0]).toMatchObject({
          repo: "https://github.com/acme/app",
          number: 12,
          commentId: 1,
        });
        const threaded = pulls.reviewReplies[0]?.body ?? "";
        expect(threaded.startsWith(`<!-- sacty-reply:${id}:review_comment:1:1 -->\n`)).toBe(true);
        expect(threaded).toContain("**対応しました。**\n\n回数を定数にしました");
        // 指摘の ID（キー）は、sacty の中のものなので、人には見せない
        expect(threaded).toContain("Sacty の AI が書きました。");
        expect(threaded).not.toContain("への対応）");
        // レビューの本文の指摘：元へのリンクを付けた PR のコメント
        expect(replies(pulls)).toHaveLength(1);
        expect(replies(pulls)[0]).toMatchObject({
          repo: "https://github.com/acme/app",
          number: 12,
        });
        // 出どころの記録が無いので、出どころを言わない（断定しない）。書き出しの行を、そのまま比べる
        expect((replies(pulls)[0]?.body ?? "").split("\n").slice(1, 4)).toEqual([
          "[この指摘](https://github.com/acme/app/pull/12#pullrequestreview-21)への返信です。",
          "",
          "**対応していません。** 理由：",
        ]);
        expect(replies(pulls)[0]?.body).toContain(
          "**対応していません。** 理由：\n\nログの追加は、この PR の目的の外です",
        );
        expect(posted(service, id)).toEqual([
          {
            step: "implement",
            submission: 1,
            number: 12,
            results: [
              {
                remarkId: "review_comment:1",
                key: "review_comment:1",
                inline: true,
                url: "https://github.com/acme/app/pull/12#discussion_r9001",
              },
              {
                remarkId: "review:21",
                key: "review:21",
                url: "https://github.com/acme/app/issues/12#issuecomment-1",
              },
            ],
          },
        ]);
        expect(task?.continuedResponses).toBeDefined();
        expect(service.get(id)?.task.continuedResponses).toEqual({
          "review_comment:1": {
            text: "回数を定数にしました",
            status: "addressed",
            respondedIn: 1,
            repliedIn: 1,
          },
          "review:21": {
            text: "ログの追加は、この PR の目的の外です",
            status: "declined",
            respondedIn: 1,
            repliedIn: 1,
          },
        });
        // 続けて確認・実行しても、重ねて返信しない。返信は、PR の指摘として取り込まない
        expect(service.queuedTaskIds()).toEqual([]);
        await service.checkPullRequests();
        await run(service, id);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(replies(pulls)).toHaveLength(1);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
        activity.close();
      });

      it("一度返信した指摘には、後の提出でもう一度対応が書かれても、繰り返し返信しない。前の提出で対応の無かった指摘には、対応が付いた提出で返信する", async () => {
        const { activity, service, executor, pulls, id } = setup([
          answered([
            { remarkId: "review_comment:1", status: "addressed", text: "回数を定数にしました" },
          ]),
          answered(
            [
              { remarkId: "review_comment:1", status: "addressed", text: "定数のままです" },
              { remarkId: "review:21", status: "addressed", text: "ログを足しました" },
              { remarkId: "implement-1-1", status: "addressed", text: "名前を直しました" },
            ],
            "# 実装の説明 v2",
          ),
        ]);
        await run(service, id);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(replies(pulls)).toHaveLength(0);
        // 画面から差し戻す（引き継いだ PR の指摘は、実装のたびに渡し直す）
        service.requestChanges(id, {
          step: "implement",
          submission: 1,
          comments: ["名前を直して"],
        });
        await run(service, id);
        const task = service.get(id)?.task;
        expect(task?.gate).toEqual({ step: "implement", submission: 2 });
        // 作り直しの指示では、返信した指摘に印を付ける（対応を書き直させない）
        const reworkPrompt = promptOf(executor, executor.calls.length - 1);
        expect(reworkPrompt).toContain('"id":"review_comment:1","answered":true');
        expect(reworkPrompt).toContain('"id":"review:21","kind":"review"');
        // 画面の指摘への対応は、指摘の対応として残る（引き継いだ PR の指摘の対応と混ざらない）
        const completed = service
          .get(id)
          ?.activity.findLast(
            (e) => e.type === "AgentRunCompleted" && e.payload.step === "implement",
          );
        expect(
          completed?.type === "AgentRunCompleted" &&
            completed.payload.responses.map((r) => r.remarkId),
        ).toEqual(["implement-1-1"]);
        expect(task?.remarks.at(-1)).toMatchObject({
          id: "implement-1-1",
          response: "名前を直しました",
        });
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(replies(pulls).map((c) => c.body.split("\n")[0])).toEqual([
          `<!-- sacty-reply:${id}:review:21:2 -->`,
        ]);
        expect(
          posted(service, id).map((p) => [p.submission, p.results.map((r) => r.remarkId)]),
        ).toEqual([
          [1, ["review_comment:1"]],
          [2, ["review:21"]],
        ]);
        expect(task?.continuedResponses?.["review_comment:1"]).toEqual({
          text: "回数を定数にしました",
          status: "addressed",
          respondedIn: 1,
          repliedIn: 1,
        });
        activity.close();
      });

      it("投稿の後・記録の前に止まっても二重に投稿せず、投稿に失敗してもタスクは止めずに作業履歴に残す", async () => {
        const first = setup([
          answered([
            { remarkId: "review_comment:1", status: "addressed", text: "回数を定数にしました" },
          ]),
        ]);
        const append = first.activity.append.bind(first.activity);
        let failOnce = true;
        first.activity.append = (entry) => {
          if (failOnce && entry.events.some((e) => e.event.type === "RemarkRepliesPosted")) {
            failOnce = false;
            throw new Error("disk full");
          }
          return append(entry);
        };
        await expect(run(first.service, first.id)).rejects.toThrow("disk full");
        skew += 61_000;
        expect(first.pulls.reviewReplies).toHaveLength(1);
        await run(first.service, first.id);
        expect(first.pulls.reviewReplies).toHaveLength(1);
        expect(posted(first.service, first.id)).toHaveLength(1);
        first.activity.close();
        rmSync(dbPath, { force: true });

        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pulls = new FakePulls();
        pulls.replyFail = "403 forbidden";
        pulls.commentFail = "403 forbidden";
        const failed = setup(
          [
            answered([
              { remarkId: "review_comment:1", status: "addressed", text: "回数を定数にしました" },
            ]),
          ],
          pulls,
        );
        await run(failed.service, failed.id);
        expect(failed.service.get(failed.id)?.task.status).toBe("awaiting_approval");
        expect(posted(failed.service, failed.id)[0]?.results[0]).toMatchObject({
          remarkId: "review_comment:1",
          failed: expect.anything(),
        });
        expect(failed.service.queuedTaskIds()).toEqual([]);
        warn.mockRestore();
        failed.activity.close();
      });

      it("対応を1件も書かなかった（前の形の出力）なら、返信も記録もしない", async () => {
        const { activity, service, pulls, id } = setup([implement("# 実装の説明", map)]);
        await run(service, id);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
        const passed = service.get(id)?.activity.find((e) => e.type === "ContinuedFeedbackPassed");
        expect(
          passed?.type === "ContinuedFeedbackPassed" && passed.payload.responses,
        ).toBeUndefined();
        expect(service.get(id)?.task.continuedResponses).toBeUndefined();
        expect(pulls.reviewReplies).toHaveLength(0);
        expect(replies(pulls)).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(0);
        activity.close();
      });
    });

    it("引き継いだ PR の本文を変えずに申告と残った整形の件数を記録する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.diffFileList = [{ status: "M", path: "a.ts" }];
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      pulls.feedbackBy[12] = [old];
      const base = repos.tree;
      const submitted = "a".repeat(40);
      const change = (path: string) => ({
        status: "M",
        path,
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      });
      repos.treeDiffs.set(`${base}:${submitted}`, [change("a.ts"), change("c.ts")]);
      repos.treeBlobs.set("old", "const x={a:1};");
      repos.treeBlobs.set("new", "const x = { a: 1, };");
      const map = [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }];
      const declaration = block({
        "sacty-formatting": { files: [{ path: "a.ts", reason: "依頼された整形" }] },
      });
      const { service, executor } = makeService(
        activity,
        [
          steps(),
          implement(`# 実装\n\n${declaration}`, map),
          implement("# 続き", map),
          implement("# 続き 2", map),
        ],
        { realPlanner: true, pulls, repos, now: () => Date.now() + 10 * 60_000 },
      );
      executor.respond = (invocation) => {
        if (invocation.command.join(" ").includes("引き継いで直す PR")) repos.tree = submitted;
        return undefined;
      };
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 15 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      expect(pulls.calls).toEqual([]);
      expect(service.get(id)?.task.formattingCheck).toEqual({
        remained: 1,
        declared: [{ path: "a.ts", reason: "依頼された整形" }],
      });
      expect(
        service.get(id)?.activity.filter((event) => event.type === "FormattingOnlyRejected"),
      ).toHaveLength(2);
      activity.close();
    });

    it("引き継いだ PR にはレビューの子タスクを作らないので、子タスクを作るデーモンでも、実装のセルフレビューをさせる（PBI-346 受け入れ条件 3）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      pulls.feedbackBy[12] = [old];
      const { service, executor } = makeService(
        activity,
        [
          steps(),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }]),
        ],
        { realPlanner: true, pulls, repos, now: () => Date.now() + 10 * 60_000, reviewTasks: true },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 6 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.continuedPullRequest?.number).toBe(12);
      expect(existsSync(join(repos.prepared[0]?.dir ?? "", "docs/sacty"))).toBe(false);
      const prompt = promptOf(executor, executor.calls.length - 1);
      expect(prompt).not.toContain("sacty-document-fixes");
      expect(prompt).toContain("既定のスキル review-dispatch（流れは self-review");
      expect(prompt).not.toContain("--- 提出の前のセルフレビュー（行わない） ---");
      // させたので、報告が無ければ記録なしにする
      expect(task?.selfReviews?.implement).toBeNull();
      expect(task?.reviewTasks).toBeUndefined();
      activity.close();
    });

    it("オーケストレーターが引き継ぐと判断したら、PR のブランチで実装し、同じブランチに積んで、新しい PR を作らない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      pulls.feedbackBy[12] = [old];
      const { service, executor } = makeService(
        activity,
        [
          steps(),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }]),
        ],
        { realPlanner: true, pulls, repos, now: () => Date.now() + 10 * 60_000 },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 6 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      // オーケストレーターに、タスクにある PR を引き継ぐかを決めさせる
      expect(promptOf(executor, 0)).toContain(
        "continuePullRequest：タスクが、タスクにある PR（https://github.com/acme/app/pull/12）そのものを直すよう求めている",
      );
      const task = service.get(id)?.task;
      expect(task?.continuedPullRequest).toEqual({
        repo: "https://github.com/acme/app",
        number: 12,
        url: "https://github.com/acme/app/pull/12",
        branch: "feature/retry",
        baseBranch: "main",
      });
      // 作業領域は PR のブランチの先頭で用意し直す
      expect(repos.prepared.at(-1)?.baseBranch).toBe("feature/retry");
      expect(task?.repository).toMatchObject({ baseBranch: "feature/retry", baseCommit: head });
      // 工程の指示に、引き継ぐ PR と、その PR の指摘を渡す（本文のある承認も含めて読む）
      const implementPrompt = promptOf(executor, 1);
      expect(implementPrompt).toContain("--- 引き継いで直す PR ---");
      expect(implementPrompt).toContain("回数は定数にしてください");
      expect(pulls.feedbackIncludeApprovals).toContain(true);
      // PR のブランチの先頭に積んでプッシュし、新しい PR は作らない（題・本文を変えない・ラベルを付けない）
      expect(repos.published).toEqual([
        expect.objectContaining({ parent: head, branch: "feature/retry" }),
      ]);
      expect(pulls.calls).toEqual([]);
      expect(pulls.labels).toEqual([]);
      expect(task?.pullRequest).toMatchObject({ number: 12, branch: "feature/retry" });
      expect(task?.gate).toEqual({ step: "implement", submission: 1 });

      // 実装の前からある指摘は、実装に渡して対応させたので、PR の指摘として取り込み直さない
      await service.checkPullRequests();
      const imported = () =>
        service.get(id)?.activity.filter((e) => e.type === "PullRequestReviewImported") ?? [];
      expect(imported()).toEqual([]);
      // 実装を始めた後の指摘は、取り込む
      pulls.feedbackBy[12] = [
        old,
        {
          ...old,
          key: "comment:2",
          kind: "comment",
          at: new Date(Date.now() + 60_000).toISOString(),
          body: "テストも足して",
        },
      ];
      await service.checkPullRequests().catch(() => undefined);
      const after = imported();
      expect(after).toHaveLength(1);
      expect(after[0]?.type === "PullRequestReviewImported" && after[0].payload.items).toEqual([
        expect.objectContaining({ key: "comment:2" }),
      ]);
      activity.close();
    });

    it("引き継ぐタスクの要求要件は、PR にせず画面で承認する（引き継いだ PR に成果のファイルを混ぜない）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      humanPullRequest(pulls);
      const { service } = makeService(
        activity,
        [steps({ plan: "skip-design" }), out("# 要求要件")],
        { realPlanner: true, pulls, repos, stepPullRequests: true },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 4 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.gate).toEqual({ step: "requirements", submission: 1 });
      expect(task?.taskBranch).toBeUndefined();
      expect(task?.stepPullRequests).toEqual([]);
      expect(repos.committedFiles).toEqual([]);
      expect(pulls.calls).toEqual([]);
      activity.close();
    });

    it("実装に渡した指摘のキーを記録し、それだけを取り込み直さない（件数を超えて渡さなかった指摘は取り込む）。sacty のレビューも渡す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      // 31 件のうち、いちばん古いものは指示に渡さない（新しい 30 件まで）
      pulls.feedbackBy[12] = Array.from({ length: 31 }, (_, i) => ({
        ...old,
        key: `comment:${i + 1}`,
        kind: "comment" as const,
        body: `指摘 ${i + 1}`,
      }));
      const { service } = makeService(
        activity,
        [
          steps(),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }]),
        ],
        { realPlanner: true, pulls, repos, now: () => Date.now() + 10 * 60_000 },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 6 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      const passed = service.get(id)?.activity.find((e) => e.type === "ContinuedFeedbackPassed");
      expect(passed?.type === "ContinuedFeedbackPassed" && passed.payload.keys).toHaveLength(30);
      expect(service.get(id)?.task.handedOverFeedback).not.toContain("comment:1");
      // 引き継ぎの読み取りでは、sacty のタスクのレビューを、指摘の有無にかかわらず含める
      const rounds = pulls.feedbackSactyRounds.filter((r) => r !== undefined).flat();
      expect(rounds.length).toBeGreaterThan(0);
      expect(rounds.every((r) => r?.allowed)).toBe(true);
      await service.checkPullRequests().catch(() => undefined);
      const imported = service
        .get(id)
        ?.activity.find((e) => e.type === "PullRequestReviewImported");
      expect(imported?.type === "PullRequestReviewImported" && imported.payload.items).toEqual([
        expect.objectContaining({ key: "comment:1" }),
      ]);
      activity.close();
    });

    it("プッシュの応答だけを受け取れなかったときは、もう一度プッシュして続ける", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      // 1回目はリモートに届いたが、応答が切れた
      const publish = repos.publish.bind(repos);
      let calls = 0;
      repos.publish = async (input) => {
        calls++;
        const pushed = await publish(input);
        if (calls === 1) throw new Error("the remote end hung up unexpectedly");
        return pushed;
      };
      const { service } = makeService(
        activity,
        [
          steps(),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }]),
        ],
        { realPlanner: true, pulls, repos },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 6 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      expect(calls).toBe(2);
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
      expect(service.get(id)?.task.pullRequest).toMatchObject({ number: 12 });
      activity.close();
    });

    it("sacty のほかのタスクの要求要件・設計の PR も引き継がない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      humanPullRequest(pulls);
      pulls.nextNumber = 12;
      const { service } = makeService(activity, [out("# 要求要件")], {
        pulls,
        stepPullRequests: true,
        planner: async (task) => ({
          steps: task.title === "先のタスク" ? ["requirements", "implement"] : ["implement"],
          plan: task.title === "先のタスク" ? "skip-design" : "direct",
          reason: "理由",
          fallback: false,
          testCommand: "npm test",
          ...(task.title === "先のタスク" ? {} : { continuePullRequest: true as const }),
          costUsd: 0,
          estimated: false,
        }),
      });
      const first = service.createTask({ projectId: "default", title: "先のタスク" });
      for (let i = 0; i < 3 && !service.get(first.id)?.task.gate; i++)
        await service.runNext(first.id);
      expect(service.get(first.id)?.task.stepPullRequests[0]?.number).toBe(12);
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      await service.runNext(id);
      expect(service.get(id)?.task.steps).toEqual([]);
      expect(ja(service.get(id)?.task.pausedMessage)).toContain(
        `sacty のタスク ${first.id.slice(0, 8)} が、この PR を扱っています`,
      );
      activity.close();
    });

    it("2つのタスクが同じ PR を並行して確かめても、引き継ぐのは1つだけ", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      humanPullRequest(pulls);
      const { service } = makeService(activity, [], {
        pulls,
        planner: async () => ({
          steps: ["investigate", "implement"],
          plan: "direct",
          reason: "指摘への対応",
          fallback: false,
          testCommand: "npm test",
          continuePullRequest: true,
          costUsd: 0,
          estimated: false,
        }),
      });
      // 最初の工程は実行させない（工程の選択だけを並行させる）
      const a = service.createTask({ projectId: "default", title: "PR #12 の指摘 A", body });
      const b = service.createTask({ projectId: "default", title: "PR #12 の指摘 B", body });
      await Promise.all(
        [service.runNext(a.id), service.runNext(b.id)].map((p) => p.catch(() => undefined)),
      );
      const tasks = [a.id, b.id].map((id) => service.get(id)?.task);
      expect(tasks.filter((t) => t?.continuedPullRequest)).toHaveLength(1);
      const stopped = tasks.find((t) => !t?.continuedPullRequest);
      expect(stopped?.steps).toEqual([]);
      expect(ja(stopped?.pausedMessage)).toContain("が、この PR を扱っています");
      activity.close();
    });

    it("実装の実行が失敗したら、指摘を渡したと記録しない（やり直しで渡し直し、渡せなかったものは取り込む）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      pulls.feedbackBy[12] = [old];
      const { service } = makeService(
        activity,
        [steps(), { kind: "failed", reason: "error", message: "boom" }],
        { realPlanner: true, pulls, repos },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 4 && service.get(id)?.task.status !== "paused"; i++) {
        await service.runNext(id);
      }
      expect(service.get(id)?.task.status).toBe("paused");
      expect(service.get(id)?.activity.some((e) => e.type === "AgentRunFailed")).toBe(true);
      expect(service.get(id)?.activity.some((e) => e.type === "ContinuedFeedbackPassed")).toBe(
        false,
      );
      expect(service.get(id)?.task.handedOverFeedback).toBeUndefined();
      activity.close();
    });

    it("引き継いだ PR では、依頼で取り込んだ sacty のレビューの指摘のある回も、PR の指摘として取り込む", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      const settings = new MemorySettingsStore({
        reviewRequested: true,
        reviewLabel: "sacty-review",
      });
      const { service } = makeService(
        activity,
        [
          out(`# 総評\n\n${block({ "sacty-review-verdict": { verdict: "changes_required" } })}`),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }]),
        ],
        {
          pulls,
          repos,
          settings,
          now: () => Date.now() + 10 * 60_000,
          planner: async () => ({
            steps: ["implement"],
            plan: "direct",
            reason: "指摘への対応",
            fallback: false,
            testCommand: "npm test",
            continuePullRequest: true,
            costUsd: 0,
            estimated: false,
          }),
        },
      );
      // 人の PR #12 に、依頼で取り込んだ sacty のレビューのタスクが「修正が必要」を投稿した
      const [reviewTask] = service.importIssues([
        {
          repo: "https://github.com/acme/app",
          number: 12,
          title: "PR 12",
          body: "本文",
          url: "https://github.com/acme/app/pull/12",
          labels: [],
          pullRequest: true,
          review: "requested",
          requestedFor: "me",
        },
      ]);
      const reviewId = reviewTask?.id ?? "";
      await service.runNext(reviewId);
      await service.runNext(reviewId);
      expect(pulls.reviews).toHaveLength(1);
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 6 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
      pulls.feedbackSactyRounds = [];
      await service.checkPullRequests().catch(() => undefined);
      // 指摘の取り込みの読み取り（レビューのタスクの見守りの読み取りは、どの回も指摘に含めない。PBI-411）
      expect(pulls.feedbackSactyRounds.flat()).toContainEqual(
        expect.objectContaining({ key: reviewId, allowed: true }),
      );
      activity.close();
    });

    it("引き継いだ PR のマージの後の監視は、PR の向き先のブランチを、マージ先として記録する", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      // 起点（PR の元のブランチの先頭）に、デプロイの確認のスキルがある
      repos.files[head] = {
        ".agents/skills/deployment-observer/SKILL.md": "# deployment-observer",
      };
      humanPullRequest(pulls);
      const ci: CiStatusReader = {
        snapshot: async () => ({
          checks: [{ kind: "workflow", name: "CI", status: "pending" }],
          failedRuns: [],
        }),
        failures: async () => [],
        rerunFailedJobs: async () => {},
        repositoryHasNoCi: async () => false,
      };
      const { service } = makeService(
        activity,
        [implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }])],
        {
          pulls,
          repos,
          ci,
          planner: async () => ({
            steps: ["implement", "deployment"],
            plan: "direct",
            reason: "指摘への対応",
            fallback: false,
            testCommand: "npm test",
            continuePullRequest: true,
            costUsd: 0,
            estimated: false,
          }),
        },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 5 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.repository?.baseBranch).toBe("feature/retry");
      expect(task?.steps.find((st) => st.key === "deployment")?.state).toBe("todo");
      pulls.states[12] = {
        state: "merged",
        mergedBy: "reviewer",
        ...(task?.pullRequest?.commit ? { headSha: task.pullRequest.commit } : {}),
        mergeCommit: "a".repeat(40),
      };
      await service.checkPullRequests();
      const started = service.get(id)?.activity.find((e) => e.type === "DeploymentWatchStarted");
      expect(started?.payload).toMatchObject({ number: 12, branch: "main" });
      activity.close();
    });

    it("プッシュの認証を待つ間に一時停止を求めたら、引き継いだ PR のブランチにプッシュしない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      const github = new FakeGitHub();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      const { service } = makeService(
        activity,
        [implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }])],
        {
          pulls,
          repos,
          github,
          planner: async () => ({
            steps: ["implement"],
            plan: "direct",
            reason: "指摘への対応",
            fallback: false,
            testCommand: "npm test",
            continuePullRequest: true,
            costUsd: 0,
            estimated: false,
          }),
        },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 4 && !service.get(id)?.task.publishPending; i++)
        await service.runNext(id);
      expect(service.get(id)?.task.publishPending).toBe(true);
      // プッシュの認証（gh のトークン）を、一時停止を求めるまで返さない
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const token = github.token.bind(github);
      vi.spyOn(github, "token").mockImplementation(async (host, account) => {
        entered.resolve();
        await release.promise;
        return token(host, account);
      });
      const publishing = service.runNext(id);
      await entered.promise;
      const pausing = service.pause(id).catch((e: unknown) => e);
      release.resolve();
      await publishing;
      await pausing;
      expect(repos.published).toEqual([]);
      expect(service.get(id)?.activity.some((e) => e.type === "BranchPushed")).toBe(false);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.publishPending).toBe(true);
      activity.close();
    });

    it("中止しても、引き継いだ PR は閉じず、PR のブランチも消さない", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      const { service } = makeService(
        activity,
        [
          steps(),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }]),
        ],
        { realPlanner: true, pulls, repos },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 6 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
      await service.cancel(id);
      expect(pulls.closed).toEqual([]);
      expect(repos.deleted).toEqual([]);
      expect(service.get(id)?.task.status).toBe("cancelled");
      activity.close();
    });

    it("引き継いだ PR のブランチが作業の間に進んでいたら、強制プッシュせずに理由を示して止める", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      const { service } = makeService(
        activity,
        [
          steps(),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }]),
        ],
        { realPlanner: true, pulls, repos },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      // 人が PR のブランチに積んだので、プッシュが拒まれる
      repos.publishFail = "! [rejected] feature/retry (fetch first)";
      repos.remote["feature/retry"] = "9".repeat(40);
      for (let i = 0; i < 6 && service.get(id)?.task.status !== "paused"; i++) {
        await service.runNext(id);
      }
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(ja(task?.pausedMessage)).toContain(
        "引き継いだ PR #12 のブランチ（feature/retry）が、sacty が作業を始めた後に進んだため",
      );
      expect(pulls.calls).toEqual([]);
      activity.close();
    });

    describe("引き継いだ PR の push が一時的に失敗したら、やり直す（PBI-467）", () => {
      const REJECT =
        "! [remote rejected] c1 -> feature/retry (failed)\nerror: failed to push some refs";
      const setup = (pushRetryDelaysMs: readonly number[]) => {
        const activity = new SqliteActivityStore(dbPath);
        const pulls = new FakePulls();
        const repos = new FakeRepos();
        repos.branchHeads["feature/retry"] = head;
        humanPullRequest(pulls);
        const made = makeService(
          activity,
          [
            steps(),
            implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }]),
          ],
          { realPlanner: true, pulls, repos, pushRetryDelaysMs },
        );
        const { id } = made.service.createTask({
          projectId: "default",
          title: "PR #12 の指摘",
          body,
        });
        return { activity, pulls, repos, id, ...made };
      };
      const toPublish = async (ctx: ReturnType<typeof setup>) => {
        for (let i = 0; i < 6 && !ctx.service.get(ctx.id)?.task.publishPending; i++) {
          await ctx.service.runNext(ctx.id);
        }
        expect(ctx.service.get(ctx.id)?.task.publishPending).toBe(true);
      };
      const kinds = (ctx: ReturnType<typeof setup>) =>
        types(ctx.service, ctx.id).filter((t) =>
          ["PushRetried", "PushRetryEnded", "PullRequestPublished", "TaskPaused"].includes(t),
        );

      it("一時的な失敗が上限まで続いたら、ブランチが進んだとせず、push の失敗（pr.failed）で止まる。再開すると、エージェントを実行せず push からやり直す", async () => {
        const ctx = setup([0, 0, 0]);
        await toPublish(ctx);
        // 先頭は、起点とも前にプッシュしたコミットとも違う
        ctx.repos.remote["feature/retry"] = "9".repeat(40);
        ctx.repos.branchHeads["feature/retry"] = "9".repeat(40);
        ctx.repos.pushScript = [REJECT, REJECT, REJECT, REJECT];
        await ctx.service.runNext(ctx.id);
        expect(ctx.repos.pushAttempts).toHaveLength(4);
        expect(kinds(ctx)).toEqual([
          "PushRetried",
          "PushRetried",
          "PushRetried",
          "PushRetryEnded",
          "TaskPaused",
        ]);
        const events = ctx.service.get(ctx.id)?.activity ?? [];
        expect(events.findLast((e) => e.type === "PushRetryEnded")?.payload).toMatchObject({
          outcome: "failed",
          retries: 3,
        });
        expect(ctx.service.get(ctx.id)?.task.pausedMessage).toMatchObject({ code: "pr.failed" });
        const runs = ctx.executor.calls.length;
        ctx.service.resume(ctx.id, {});
        await ctx.service.runNext(ctx.id);
        expect(ctx.executor.calls).toHaveLength(runs);
        expect(ctx.repos.pushAttempts).toHaveLength(5);
        expect(kinds(ctx).at(-1)).toBe("PullRequestPublished");
        ctx.activity.close();
      });

      it("止まった後の再開でも、1 回目の push が一時的に失敗したら、エージェントを実行せず、やり直して PR を更新する", async () => {
        const ctx = setup([0, 0, 0]);
        await toPublish(ctx);
        ctx.repos.remote["feature/retry"] = "9".repeat(40);
        ctx.repos.branchHeads["feature/retry"] = "9".repeat(40);
        ctx.repos.pushScript = [REJECT, REJECT, REJECT, REJECT];
        await ctx.service.runNext(ctx.id);
        expect(ctx.service.get(ctx.id)?.task.status).toBe("paused");
        const runs = ctx.executor.calls.length;
        const before = types(ctx.service, ctx.id).length;
        ctx.repos.pushScript = [REJECT];
        ctx.service.resume(ctx.id, {});
        await ctx.service.runNext(ctx.id);
        expect(ctx.executor.calls).toHaveLength(runs);
        expect(
          types(ctx.service, ctx.id)
            .slice(before)
            .filter((t) =>
              ["PushRetried", "PushRetryEnded", "PullRequestPublished", "TaskPaused"].includes(t),
            ),
        ).toEqual(["PushRetried", "PushRetryEnded", "PullRequestPublished"]);
        ctx.activity.close();
      });

      it("1 回失敗しても止まらず、同じコミット・ブランチ・認証の環境で push し直して PR を更新する", async () => {
        const ctx = setup([0, 0, 0]);
        await toPublish(ctx);
        ctx.repos.pushScript = [REJECT];
        await ctx.service.runNext(ctx.id);
        expect(ctx.repos.pushAttempts).toHaveLength(2);
        expect(ctx.repos.pushAttempts[1]).toEqual(ctx.repos.pushAttempts[0]);
        expect(kinds(ctx)).toEqual(["PushRetried", "PushRetryEnded", "PullRequestPublished"]);
        expect(
          ctx.service.get(ctx.id)?.activity.findLast((e) => e.type === "PushRetryEnded")?.payload,
        ).toMatchObject({ outcome: "pushed", retries: 1 });
        ctx.activity.close();
      });

      it("やり直しの途中で一時的でない失敗（保護での拒否）に変わったら、そこでやめ、回数を記録する。先頭が進んでいれば今までどおり 1 回だけ push し直し、通らなければ pr.continuedBranchMoved で止まる", async () => {
        const ctx = setup([0, 0, 0]);
        await toPublish(ctx);
        // 先頭は、起点とも前にプッシュしたコミットとも違い、一時的でない失敗なので、今までどおり先頭を読み直して 1 回だけ push し直す
        // （それも通らなければ、人が PR のブランチを進めたとして止まる）
        ctx.repos.remote["feature/retry"] = "9".repeat(40);
        ctx.repos.branchHeads["feature/retry"] = "9".repeat(40);
        ctx.repos.pushScript = [
          REJECT,
          "remote: error: GH006: Protected branch update failed\n! [remote rejected] c1 -> feature/retry (protected branch hook declined)",
          "! [rejected] c1 -> feature/retry (non-fast-forward)",
        ];
        await ctx.service.runNext(ctx.id);
        expect(ctx.repos.pushAttempts).toHaveLength(3);
        expect(kinds(ctx)).toEqual(["PushRetried", "PushRetryEnded", "TaskPaused"]);
        expect(
          ctx.service.get(ctx.id)?.activity.findLast((e) => e.type === "PushRetryEnded")?.payload,
        ).toMatchObject({ outcome: "failed", retries: 1 });
        expect(ctx.service.get(ctx.id)?.task.pausedMessage).toMatchObject({
          code: "pr.continuedBranchMoved",
        });
        ctx.activity.close();
      });

      it("やり直しを待つ間に一時停止したら、push も記録もせずにやめ、pr.failed にせず一時停止の理由を上書きしない", async () => {
        const ctx = setup([60_000]);
        await toPublish(ctx);
        ctx.repos.pushScript = [REJECT];
        const running = ctx.service.runNext(ctx.id);
        await waitFor(() => ctx.repos.pushAttempts.length === 1, { what: "最初の push" });
        const pausing = ctx.service.pause(ctx.id).catch((e: unknown) => e);
        await running;
        await pausing;
        expect(ctx.repos.pushAttempts).toHaveLength(1);
        expect(kinds(ctx)).toEqual(["TaskPaused"]);
        expect(
          ctx.service.get(ctx.id)?.activity.findLast((e) => e.type === "TaskPaused")?.payload,
        ).toMatchObject({ reason: "manual" });
        ctx.activity.close();
      });
    });

    /** 引き継いだ PR で実装の承認待ちまで進め、PR の指摘で実装に差し戻す。 */
    async function continuedThenSentBack() {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      const tests = [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }];
      const { service, executor } = makeService(
        activity,
        [steps(), implement("# 実装の説明", tests), implement("# 実装の説明 v2", tests)],
        { realPlanner: true, pulls, repos },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      for (let i = 0; i < 6 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
      const pushes = repos.published.length;
      service.requestChanges(id, {
        step: "implement",
        submission: 1,
        comments: ["回数の上限も書いてください"],
      });
      return { activity, service, executor, pulls, repos, id, pushes };
    }

    it("引き継いだ PR を差し戻して作り直している間に PR がマージされたら、元のブランチにプッシュせず、マージを承認として完了する（PBI-276）", async () => {
      const { activity, service, pulls, repos, id, pushes } = await continuedThenSentBack();
      pulls.state = {
        state: "merged",
        mergedBy: "reviewer",
        headSha: service.get(id)?.task.pullRequest?.commit,
      };
      for (let i = 0; i < 6 && service.queuedTaskIds().length > 0; i++) await service.runNext(id);
      expect(repos.published).toHaveLength(pushes);
      const events = service.get(id)?.activity ?? [];
      expect(events.slice(-3).map((e) => e.type)).toEqual([
        "ReworkStoppedByMerge",
        "PullRequestMerged",
        "StepApproved",
      ]);
      expect(events.some((e) => e.type === "TaskPaused")).toBe(false);
      expect(service.get(id)?.task.pullRequestState).toBe("merged");
      expect(service.get(id)?.task.approved.implement).toBeDefined();
      expect(pulls.calls).toEqual([]);
      activity.close();
    });

    it("引き継いだ PR で、確認では開いていたが、プッシュの間にマージされたら、一時停止にせず、マージを承認として完了する（PBI-276）", async () => {
      const { activity, service, pulls, id } = await continuedThenSentBack();
      const commit = service.get(id)?.task.pullRequest?.commit;
      let reads = 0;
      pulls.status = async () => ({
        headSha: commit,
        ...(++reads === 1
          ? { state: "open" as const }
          : { state: "merged" as const, mergedBy: "reviewer" }),
      });
      for (let i = 0; i < 6 && service.queuedTaskIds().length > 0; i++) await service.runNext(id);
      expect(reads).toBe(2);
      const events = service.get(id)?.activity ?? [];
      expect(events.slice(-3).map((e) => e.type)).toEqual([
        "ReworkStoppedByMerge",
        "PullRequestMerged",
        "StepApproved",
      ]);
      expect(events.some((e) => e.type === "TaskPaused")).toBe(false);
      activity.close();
    });

    /** 引き継いだ PR で、実装が終わり、まだ一度も提出していない状態まで進める。 */
    async function continuedBeforeFirstSubmission() {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      humanPullRequest(pulls);
      const tests = [{ viewpointId: "REQ", tests: ["retry.test.ts › 定数"] }];
      const { service, executor } = makeService(
        activity,
        [steps(), implement("# 実装の説明", tests)],
        { realPlanner: true, pulls, repos },
      );
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      // 実装が終わり、PR の更新の前の確かめを待つところまで進める
      for (let i = 0; i < 6 && !service.get(id)?.task.verification; i++) {
        await service.runNext(id);
      }
      const task = service.get(id)?.task;
      expect(task?.verification).toBeDefined();
      expect(task?.status).toBe("idle");
      expect(task?.pullRequest).toBeUndefined();
      expect(task?.continuedPullRequest?.number).toBe(12);
      return { activity, service, executor, pulls, repos, id };
    }

    it("引き継いだ PR の実装が終わり、初回の提出の前に PR がマージされたら、プッシュせず、一時停止にもせず、マージを承認として完了する（PBI-276）", async () => {
      const { activity, service, executor, pulls, repos, id } =
        await continuedBeforeFirstSubmission();
      const calls = executor.calls.length;
      pulls.state = { state: "merged", mergedBy: "reviewer", headSha: head };
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      expect(events.slice(-3).map((e) => e.type)).toEqual([
        "ReworkStoppedByMerge",
        "PullRequestMerged",
        "StepApproved",
      ]);
      expect(events.at(-3)?.payload).toMatchObject({ number: 12, was: "verifying" });
      const task = service.get(id)?.task;
      expect(task?.pullRequest).toMatchObject({ number: 12, branch: "feature/retry" });
      expect(task?.pullRequestState).toBe("merged");
      expect(task?.approved.implement).toBeDefined();
      expect(repos.published).toHaveLength(0);
      expect(executor.calls).toHaveLength(calls);
      expect(events.some((e) => e.type === "TaskPaused")).toBe(false);
      activity.close();
    });

    it("引き継いだ PR の初回の提出の前に、確認より先に PR の更新が始まっても、プッシュせず、マージを承認として完了する（PBI-276）", async () => {
      const { activity, service, pulls, repos, id } = await continuedBeforeFirstSubmission();
      pulls.state = { state: "merged", mergedBy: "reviewer", headSha: head };
      for (let i = 0; i < 6 && service.queuedTaskIds().length > 0; i++) await service.runNext(id);
      const events = service.get(id)?.activity ?? [];
      expect(events.slice(-3).map((e) => e.type)).toEqual([
        "ReworkStoppedByMerge",
        "PullRequestMerged",
        "StepApproved",
      ]);
      expect(events.some((e) => e.type === "TaskPaused")).toBe(false);
      expect(repos.published).toHaveLength(0);
      expect(service.get(id)?.task.pullRequestState).toBe("merged");
      activity.close();
    });

    it("引き継げない PR（フォークの PR・マージ済み・ほかのタスクの PR）なら、新しい PR を作らないように、工程を決めずに止める", async () => {
      const cases: [Partial<PullRequestInfo>, string][] = [
        [
          { headRepo: "https://github.com/someone/app" },
          "PR の元のブランチが、対象リポジトリにありません",
        ],
        [{ state: "merged" }, "PR はマージ済みです"],
      ];
      for (const [patch, expected] of cases) {
        const activity = new SqliteActivityStore(join(dir, `${randomUUID()}.db`));
        const pulls = new FakePulls();
        humanPullRequest(pulls, patch);
        const { service } = makeService(activity, [steps()], { realPlanner: true, pulls });
        const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
        await service.runNext(id);
        const task = service.get(id)?.task;
        expect(task?.steps).toEqual([]);
        expect(task?.status).toBe("paused");
        expect(ja(task?.pausedMessage)).toContain(
          "タスクにある PR #12 を引き継いで直すと判断しましたが、引き継げません",
        );
        expect(ja(task?.pausedMessage)).toContain(expected);
        // 判断の費用は記録する
        expect(service.get(id)?.activity.map((e) => e.type)).toContain("OrchestratorFailed");
        expect(task?.budget.usedUsd).toBeGreaterThan(0);
        activity.close();
      }
    });

    it("sacty のほかのタスクが作った PR は引き継がない（その PR の指摘は、作ったタスクが取り込む）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      const repos = new FakeRepos();
      humanPullRequest(pulls);
      pulls.nextNumber = 12;
      const { service } = makeService(
        activity,
        [implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["a.test.ts › 動く"] }]), steps()],
        {
          pulls,
          repos,
          planner: async (task) =>
            task.title === "先のタスク"
              ? {
                  steps: ["implement"],
                  plan: "direct",
                  reason: "小さい",
                  fallback: false,
                  testCommand: "npm test",
                  costUsd: 0,
                  estimated: false,
                }
              : {
                  steps: ["investigate", "implement"],
                  plan: "direct",
                  reason: "指摘への対応",
                  fallback: false,
                  testCommand: "npm test",
                  continuePullRequest: true,
                  costUsd: 0,
                  estimated: false,
                },
        },
      );
      const first = service.createTask({ projectId: "default", title: "先のタスク" });
      for (let i = 0; i < 4 && !service.get(first.id)?.task.gate; i++)
        await service.runNext(first.id);
      expect(service.get(first.id)?.task.pullRequest?.number).toBe(12);
      const { id } = service.createTask({ projectId: "default", title: "PR #12 の指摘", body });
      await service.runNext(id);
      expect(service.get(id)?.task.steps).toEqual([]);
      expect(ja(service.get(id)?.task.pausedMessage)).toContain(
        `sacty のタスク ${first.id.slice(0, 8)} が、この PR を扱っています`,
      );
      activity.close();
    });

    it("PR を参照するだけのタスク（引き継がないと判断した）は、今までどおり新しい PR を作る", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const pulls = new FakePulls();
      humanPullRequest(pulls);
      const { service } = makeService(
        activity,
        [
          steps({ continuePullRequest: false }),
          implement("# 実装の説明", [{ viewpointId: "REQ", tests: ["a.test.ts › 動く"] }]),
        ],
        { realPlanner: true, pulls },
      );
      const { id } = service.createTask({
        projectId: "default",
        title: "同じ直し方をほかの所にも",
        body: "https://github.com/acme/app/pull/12 と同じ直し方を、ほかのモジュールにもする",
      });
      for (let i = 0; i < 6 && !service.get(id)?.task.gate; i++) await service.runNext(id);
      const task = service.get(id)?.task;
      expect(task?.continuedPullRequest).toBeUndefined();
      expect(pulls.prInfoRequests).toEqual([]);
      expect(pulls.calls).toHaveLength(1);
      expect(task?.pullRequest?.branch).toBe(`sacty/task-${id.slice(0, 8)}`);
      activity.close();
    });
  });

  it("実装の説明の先頭の行の字下げは保存する（字下げしたコードを普通の文と見分けられるように。PBI-264）", async () => {
    const indented = '    console.log("内部用コード");\n\nAPI を足しました。';
    const { activity, service, id } = await toImplement([implement(indented)]);
    await service.runNext(id);
    const task = service.get(id)?.task;
    expect(task?.outputs.implement).toBe(indented);
    // 保存した説明から作る PR の本文は、字下げしたコードを要約にせず、後の文を使う
    expect(task && buildPullRequestBody(task)).toContain("- 変更：API を足しました。");
    activity.close();
  });

  it("実装は対象リポジトリの clone で、承認済みの成果物と人間の指摘を受け取って実行する", async () => {
    const { activity, service, executor, repos, id } = await toImplement([
      implement("# 実装の説明"),
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

  it("sacty はテストを実行せず、最終レビューもせずに、実装の工程の中で PR を作って実装の承認待ちで止まる（PBI-336）", async () => {
    const { activity, service, executor, id } = await toImplement([implement("# 実装の説明")]);
    await drain(service);

    // 要求要件（2回）・設計・実装だけで、最終レビューもテストのコンテナも走らない
    expect(executor.calls).toHaveLength(4);
    const task = service.get(id)?.task;
    // 実装の工程の中で、sacty が PR を作り、実装の承認待ちで止まる（PBI-110）
    expect(task?.steps.map((st) => st.state)).toEqual(["done", "done", "active"]);
    expect(task?.gate?.step).toBe("implement");
    expect(task?.lastReview).toBeUndefined();
    expect(task?.lastTests).toBeUndefined();
    // sacty の PR にラベルは付けない（レビューは子タスク。PBI-330）
    expect(types(service, id).slice(-5)).toEqual([
      "FinalReviewSkipped",
      "BranchPushed",
      "PullRequestBodyWritten",
      "PullRequestPublished",
      "StepSubmitted",
    ]);
    expect(types(service, id)).not.toContain("TestsRun");
    expect(types(service, id)).not.toContain("FinalReviewed");
    activity.close();
  });

  describe("不安定なテストの台帳を読む（PBI-312。以前の版の記録）", () => {
    const UI = { name: "ui.spec.ts > 保存", file: "tests/ui.spec.ts" };
    /** 過去のタスク（台帳の元。以前の版の最終レビューが記録したもの）を足す。 */
    const seed = (service: TaskService, id: string, count: number, projectId = "default") => {
      const tasks = (service as unknown as { tasks: Map<string, Task> }).tasks;
      const current = tasks.get(id) as Task;
      for (let i = 0; i < count; i += 1) {
        tasks.set(`past-${i}`, {
          ...current,
          id: `past-${i}`,
          projectId,
          status: "cancelled",
          flakySightings: [{ ...UI, reason: "別の画面", at: `2026-01-0${i + 1}T00:00:00.000Z` }],
        });
      }
    };
    it("台帳を読んでも何も記録せず、タスクを作らない。提案から人が作ると、直すタスクが付く", async () => {
      const { activity, service, id } = await toImplement([implement("# v1")]);
      seed(service, id, 3);
      const before = service.list().length;
      const events = service.get(id)?.activity.length;
      const ledger = await service.projectFlakyTests("default");
      expect(ledger?.tests[0]).toMatchObject({ known: true, name: UI.name });
      expect(ledger?.tests[0]?.fixTask).toBeUndefined();
      expect(service.list()).toHaveLength(before);
      expect(service.get(id)?.activity).toHaveLength(events ?? 0);
      const fix = service.createTask({
        projectId: "default",
        title: "不安定なテストを直す",
        body: "本文",
        flakyFixTest: ledger?.tests[0]?.id,
      });
      expect(fix.flakyFix).toEqual(UI);
      const after = await service.projectFlakyTests("default");
      expect(after?.tests[0]?.fixTask).toEqual({ taskId: fix.id, title: "不安定なテストを直す" });
      // 中止して同じリポジトリでやり直すと、直すテストを引き継ぐ
      await service.cancel(fix.id);
      const rerun = service.rerunTask(fix.id, {
        title: "もう一度直す",
        body: "本文",
        repo: fix.repo ?? null,
      });
      expect(rerun.flakyFix).toEqual(UI);
      expect((await service.projectFlakyTests("default"))?.tests[0]?.fixTask?.taskId).toBe(
        rerun.id,
      );
      // リポジトリを指定せずにやり直すと引き継がない
      await service.cancel(rerun.id);
      const elsewhere = service.rerunTask(rerun.id, {
        title: "別の所で",
        body: "本文",
        repo: null,
      });
      expect(elsewhere.flakyFix).toBeUndefined();
      activity.close();
    });

    it("台帳に無い識別子では、直すタスクを作らない", async () => {
      const { activity, service, id } = await toImplement([implement("# v1")]);
      seed(service, id, 3);
      const before = service.list().length;
      expect(() =>
        service.createTask({
          projectId: "default",
          title: "直す",
          body: "本文",
          flakyFixTest: "nope",
        }),
      ).toThrow(/台帳に見つかりません/);
      // テストのあるリポジトリと違う所（リポジトリを指定しない）では作らない
      const ledger = await service.projectFlakyTests("default");
      expect(() =>
        service.createTask({
          projectId: "default",
          title: "直す",
          body: "本文",
          repo: null,
          flakyFixTest: ledger?.tests[0]?.id,
        }),
      ).toThrow(/台帳に見つかりません/);
      expect(service.list()).toHaveLength(before);
      activity.close();
    });

    it("プロジェクトが無ければ null", async () => {
      const { activity, service } = await toImplement([]);
      expect(await service.projectFlakyTests("nope")).toBeNull();
      expect((await service.projectFlakyTests("default"))?.tests).toEqual([]);
      activity.close();
    });
  });

  describe("ツールが無くて止まったタスクの再開で、人がテストの扱いを決め直す（PBI-158）", () => {
    /** 以前の版の最終レビューで、テストのツールがイメージに無くて止まったタスク（台帳にその記録がある）。 */
    const stoppedByMissingTool = async () => {
      const made = await toImplement([implement("# v1")]);
      await made.service.runNext(made.id); // 実装
      appendLegacy(made.service, made.id, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "error",
              message: message("verify.commandMissing", {
                commands: ["npm"],
                image: "default",
                step: "implement",
                testsDecidable: true,
              }),
            },
          },
        },
      ]);
      expect(made.service.get(made.id)?.task.pausedMessage).toMatchObject({
        code: "verify.commandMissing",
      });
      return made;
    };

    it("テストなしで進めると決めて再開すると、テストを実行せずに実装の PR を作って承認待ちへ進む", async () => {
      const { activity, service, executor, id } = await stoppedByMissingTool();
      const runs = executor.calls.length;
      service.resume(id, { tests: { noTestsReason: "変更は文書だけで、検証のツールが無い" } });
      const decided = service.get(id)?.activity.find((e) => e.type === "TestsDecided");
      expect(decided?.actor).toBe("person");
      expect(decided?.type === "TestsDecided" && decided.payload).toEqual({
        noTestsReason: "変更は文書だけで、検証のツールが無い",
      });
      expect(service.get(id)?.task.testCommand).toBeUndefined();
      await drain(service);
      const task = service.get(id)?.task;
      // 実装はやり直さず、エージェントも実行しない
      expect(executor.calls.length).toBe(runs);
      expect(types(service, id)).toContain("FinalReviewSkipped");
      expect(task?.gate?.step).toBe("implement");
      expect(task?.pausedMessage).toBeUndefined();
      activity.close();
    });

    it("テストのコマンドを指定し直して再開すると、そのコマンドを記録し、テストを実行せずに承認待ちへ進む", async () => {
      const { activity, service, executor, id } = await stoppedByMissingTool();
      const runs = executor.calls.length;
      service.resume(id, { tests: { testCommand: "true" } });
      expect(service.get(id)?.task.testCommand).toBe("true");
      await drain(service);
      expect(executor.calls.length).toBe(runs);
      expect(service.get(id)?.task.gate?.step).toBe("implement");
      activity.close();
    });

    it("ツールが無くて止まったのではないタスクでは、テストの扱いを指定できない", async () => {
      const { activity, service, id } = await toImplement([implement("# v1")]);
      await service.pause(id);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(() => service.resume(id, { tests: { noTestsReason: "x" } })).toThrow(
        expect.objectContaining({ messages: [{ code: "resume.testsNotUndecided" }] }),
      );
      activity.close();
    });
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

  /** 実装・検証を終え、実装の PR を作って実装の承認待ちまで進める（PBI-110）。 */
  async function toImplementGate(
    outcomes: AgentOutcome[] = [],
    options: {
      pulls?: FakePulls;
      repos?: FakeRepos;
      config?: () => ConfigResult;
      now?: () => number;
      memory?: boolean;
      stopNoticeTimeoutMs?: number;
      remarkReplyIntervalMs?: number;
      remarkRepliesPerRecord?: number;
      rateLimits?: ServiceDeps["rateLimits"];
      remarkReplyRateLimit?: ServiceDeps["remarkReplyRateLimit"];
      github?: FakeGitHub;
      ci?: CiStatusReader;
      draftPullRequests?: boolean;
      mergeBase?: boolean;
      reviewCiTimeoutMs?: number;
      webUrl?: string;
    } = {},
  ) {
    const made = await toImplement([implement("# 実装の説明"), ...outcomes], options);
    await drain(made.service);
    return made;
  }

  it("画面に返すタスクには、承認待ちの PR の今の head の AI のレビューの状況を足す（PR の本文には書かない）。承認待ちでなければ足さない（PBI-302 D1）", async () => {
    const { activity, service, pulls, id } = await toImplementGate();
    const task = service.get(id)?.task;
    const commit = task?.pullRequest?.commit;
    expect(task?.status).toBe("awaiting_approval");
    // 作業履歴から復元したタスクには持たず、画面に返すときだけ足す
    expect(task?.aiReview).toBeUndefined();
    // PR の確認で最新の head を読む前は、提出したコミットで計算せず「分からない」
    expect(service.view(id)?.task.aiReview).toEqual({ head: commit, status: "unknown" });
    pulls.state = { state: "open", headSha: commit };
    await service.checkPullRequests();
    expect(service.view(id)?.task.aiReview).toEqual({ head: commit, status: "none" });
    // 人が PR にコミットを足した：最新の head で計算する（PR #304 のレビュー）
    pulls.state = { state: "open", headSha: "fedcba9876543210" };
    await service.checkPullRequests();
    expect(service.view(id)?.task.aiReview).toEqual({ head: "fedcba9876543210", status: "none" });
    // 読めなくなったら、また「分からない」
    pulls.state = { state: "open" };
    pulls.prInfo = { ...pulls.prInfo, headSha: undefined } as typeof pulls.prInfo;
    await service.checkPullRequests();
    expect(service.view(id)?.task.aiReview?.status).toBe("unknown");
    // 画面には出すが、PR の本文には書かない（書いた時点で古くなる。PBI-471）
    expect(pulls.calls.at(-1)?.body).not.toContain("AI のレビュー：");
    expect(service.view("no-such-task")).toBeUndefined();
    activity.close();
  });

  it("タスクの一覧の応答（listView）の aiReview は、承認待ちで PR が開いているタスクだけにあり、詳細（view）と同じ値（PBI-442）", async () => {
    const { activity, service, pulls, id } = await toImplementGate();
    const other = service.createTask({ projectId: "default", title: "止める" });
    await service.pause(other.id);
    const entry = (taskId: string) => service.listView().find((t) => t.id === taskId);
    // PR の確認で最新の head を読む前は「分からない」
    expect(entry(id)?.aiReview).toEqual(service.view(id)?.task.aiReview);
    expect(entry(id)?.aiReview?.status).toBe("unknown");
    const commit = service.get(id)?.task.pullRequest?.commit;
    pulls.state = { state: "open", headSha: commit };
    await service.checkPullRequests();
    expect(entry(id)?.aiReview).toEqual(service.view(id)?.task.aiReview);
    expect(entry(id)?.aiReview).toEqual({ head: commit, status: "none" });
    // 承認待ちでないタスクには付かない
    expect(entry(other.id)?.aiReview).toBeUndefined();
    // PR が閉じたら付かない
    pulls.state = { state: "closed" };
    await service.checkPullRequests();
    expect(entry(id)?.aiReview).toBeUndefined();
    expect(entry(id)?.aiReview).toEqual(service.view(id)?.task.aiReview);
    activity.close();
  });

  it("要求要件の全文で本文が上限を超えるときは、全文を目印つきのコメントに分けて載せ、作り直しでは同じコメントを書き換える（PBI-450）", async () => {
    const lines = Array.from({ length: 7_000 }, (_, i) => `- R-${i}：${"あ".repeat(5)}`);
    const requirements = ["# 要求要件", "", "最初の段落。", "", ...lines].join("\n");
    expect(requirements.length).toBeGreaterThan(65_000);
    const made = await toImplement([implement("# 実装の説明"), implement("# 実装の説明 2")], {
      requirements,
    });
    await drain(made.service);
    const { pulls, id } = made;
    const commentsOf = () =>
      pulls.issueComments.filter((c) => c.body.startsWith("<!-- sacty-basis:"));
    // PR を作った時点では、コメントを投稿してから本文にリンクを書く（作った直後の更新）
    expect(pulls.calls[0]?.body).toContain("この PR を作った後に、Sacty がコメントに載せます。");
    const body = pulls.calls[1]?.body ?? "";
    // 本文には全文の代わりにコメントへのリンクがあり、画面に頼らない
    expect(body).toContain("[全文のコメント](");
    expect(body).not.toContain("<summary>全文</summary>");
    expect(body).not.toContain("タスクの画面");
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    // 目印のコメントとその続きをつなぐと全文になる
    const comments = commentsOf();
    expect(comments.length).toBeGreaterThanOrEqual(2);
    expect(comments[0]?.body.startsWith(`<!-- sacty-basis:${id} -->`)).toBe(true);
    expect(comments[1]?.body.startsWith(`<!-- sacty-basis:${id}:2 -->`)).toBe(true);
    const joined = comments
      .map((c) => c.body.split("\n").slice(1).join("\n"))
      .join("\n")
      .replaceAll(/^## 承認済みの要求要件・不具合の再現.*$/gm, "");
    for (const line of [lines[0], lines[3_500], lines[6_999]]) expect(joined).toContain(line);
    // 作り直しでは、同じコメントを書き換える（新しいコメントを増やさない）
    const before = comments.length;
    made.service.requestChanges(id, {
      step: "implement",
      submission: 1,
      comments: ["説明を直す"],
    });
    await drain(made.service);
    expect(pulls.calls.length).toBeGreaterThan(2);
    expect(pulls.calls.at(-1)?.body).toContain("[全文のコメント](");
    expect(commentsOf()).toHaveLength(before);
    made.activity.close();
  });

  it("全文のコメントは、折りたたみの記号（大文字・空白入りも）と @ を無効にして載せる（PBI-450）", async () => {
    const lines = Array.from({ length: 7_000 }, (_, i) => `- R-${i}：${"あ".repeat(5)}`);
    const requirements = [
      "# 要求要件",
      "",
      "<DETAILS>開いたまま</DETAILS >と</details >と<details open>",
      "",
      "@octocat に確認する。",
      "",
      ...lines,
    ].join("\n");
    const made = await toImplement([implement("# 実装の説明")], { requirements });
    await drain(made.service);
    const comments = made.pulls.issueComments.filter((c) => c.body.startsWith("<!-- sacty-basis:"));
    expect(comments.length).toBeGreaterThanOrEqual(2);
    const text = comments.map((c) => c.body).join("\n");
    expect(text).not.toMatch(/<\/?details/i);
    expect(text).toContain("&lt;DETAILS>");
    expect(text).toContain("&lt;/details >");
    expect(text).not.toContain("@octocat");
    expect(text).toContain("@\u200boctocat");
    made.activity.close();
  });

  it("全文のコメントを投稿できなくても、PR の作成は止まらず、リンクなしの本文を記録する（PBI-450）", async () => {
    const lines = Array.from({ length: 7_000 }, (_, i) => `- R-${i}：${"あ".repeat(5)}`);
    const requirements = ["# 要求要件", "", ...lines].join("\n");
    class FailingBasis extends FakePulls {
      override async commentIssue(input: Parameters<FakePulls["commentIssue"]>[0]) {
        if (input.body.startsWith("<!-- sacty-basis:")) throw new Error("GitHub が落ちています");
        return super.commentIssue(input);
      }
    }
    const pulls = new FailingBasis();
    const made = await toImplement([implement("# 実装の説明")], { requirements, pulls });
    await drain(made.service);
    const last = pulls.calls.at(-1)?.body ?? "";
    expect(pulls.calls.length).toBeGreaterThan(0);
    expect(last).not.toContain("この PR を作った後に、Sacty がコメントに載せます。");
    expect(last).not.toContain("[全文のコメント](");
    expect(last).not.toContain("タスクの画面");
    expect(last.length).toBeLessThanOrEqual(PR_BODY_MAX);
    const written = made.service
      .get(made.id)
      ?.activity.findLast((e) => e.type === "PullRequestBodyWritten");
    expect(written).toBeDefined();
    made.activity.close();
  });

  it("実装の説明にあるコンテナの作業領域へのリンクは、PR の本文ではリンクにしない（PBI-366）", async () => {
    const made = await toImplement([
      implement(
        [
          "[README.md](/workspace/README.md) と [決済の処理](/workspace/src/pay.ts#L12) を直しました。",
          "[設計](https://example.com/design) と [docs/a.md](docs/a.md) は変えていません。",
          "`[b.md](/workspace/b.md)` は例です。",
        ].join("\n"),
      ),
    ]);
    await drain(made.service);
    const body = made.pulls.calls[0]?.body ?? "";
    expect(body).toContain("README.md と 決済の処理（`src/pay.ts#L12`） を直しました。");
    expect(body).toContain("[設計](https://example.com/design) と [docs/a.md](docs/a.md)");
    expect(body).toContain("`[b.md](/workspace/b.md)` は例です。");
    expect(body).not.toContain("](/workspace/README.md)");
    expect(body).not.toContain("](/workspace/src/pay.ts");
    // 台帳に残す本文（次の更新で、人の直しと突き合わせる土台）も同じ
    const written = made.service
      .get(made.id)
      ?.activity.findLast((e) => e.type === "PullRequestBodyWritten");
    expect(JSON.stringify(written?.payload)).not.toContain("](/workspace/README.md)");
    made.activity.close();
  });

  it("リンクを外した後の本文に秘密の値が現れても、PR の本文と台帳に残さない（PBI-366）", async () => {
    // 文字参照が元の文字に戻る・外したリンクの前後の文字がつながると、伏せた後の本文に秘密の値（ここでは GitHub の
    // トークン ghp_secret）が現れる
    const made = await toImplement([
      implement(
        [
          "[手順](/workspace/docs/ghp&#95;secret.md) を直しました。",
          "値は ghp_[s](/workspace)ecret です。",
          "![ghp&#95;secret](/workspace/a.png)",
        ].join("\n\n"),
      ),
    ]);
    await drain(made.service);
    const body = made.pulls.calls[0]?.body ?? "";
    expect(body).toContain("手順（`docs/[REDACTED].md`） を直しました。");
    expect(body).toContain("値は [REDACTED] です。");
    expect(body).not.toContain("ghp_secret");
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    expect(JSON.stringify(made.service.get(made.id)?.activity)).not.toContain("ghp_secret");
    made.activity.close();
  });

  it("リンクを外した後に秘密の値を伏せると長さの上限を超えるときは、置き換えをやめて、上限の中の本文を使う（PBI-366）", async () => {
    // 短い秘密の値（伏せ字より短い）が、リンク先の文字参照から何度も現れる。伏せると、外して縮んだ分より長くなる
    const secret = "ghx";
    const target = "gh&#120;".repeat(1_000);
    const made = await toImplement(
      [
        implement(
          [
            "決済の処理を直しました。",
            `[手順](/workspace/${target})`,
            // 本文が長さの上限まで埋まるように、長い説明を続ける
            "説明。".repeat(30_000),
          ].join("\n\n"),
        ),
      ],
      { github: new FakeGitHub({ me: secret }) },
    );
    await drain(made.service);
    const body = made.pulls.calls[0]?.body ?? "";
    // 置き換える前の本文（リンクは残る）。秘密の値は現れず、上限の中に収まる
    expect(body).toContain(`[手順](/workspace/${target})`);
    expect(body).not.toContain(secret);
    expect(body.length).toBeLessThanOrEqual(PR_BODY_MAX);
    // 置き換えていれば、伏せた後に上限を超えていた（この分岐を通ったことの確認）
    const unlinked = withoutWorkspaceLinks(body).replaceAll(secret, "[REDACTED]");
    expect(unlinked).not.toBe(body);
    expect(unlinked.length).toBeGreaterThan(PR_BODY_MAX);
    expect(JSON.stringify(made.service.get(made.id)?.activity)).not.toContain(`"${secret}`);
    made.activity.close();
  });

  it("本文の解析に失敗したら、リンクを外さずに PR を作り、外せなかったことと原因をログに残す（PBI-372）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 別スレッドがメモリの上限でエラーになった。sacty が組み立てた本文なので、秘密の値は伏せ直して返る
      vi.mocked(unlinkedGeneratedBody).mockImplementationOnce(async (body) => ({
        body,
        skipped: "error",
        cause: "別スレッドのエラー（ERR_WORKER_OUT_OF_MEMORY）",
      }));
      const made = await toImplement([
        implement("[手順](/workspace/docs/setup.md) を直しました。"),
      ]);
      await drain(made.service);
      // PR は作る。リンクは残る
      expect(made.pulls.calls).toHaveLength(1);
      expect(made.pulls.calls[0]?.body).toContain(
        "[手順](/workspace/docs/setup.md) を直しました。",
      );
      // 本文の中身は、ログに出さない
      expect(linksKeptLogs(warn)).toEqual([
        `[daemon] タスク ${made.id} の PR（https://github.com/acme/app）の本文から、作業領域へのリンクを外せませんでした（解析に失敗しました：別スレッドのエラー（ERR_WORKER_OUT_OF_MEMORY））。本文は、リンクを外さずに使います`,
      ]);
      made.activity.close();
    } finally {
      warn.mockRestore();
    }
  });

  it("本文の解析が時間の上限までに終わらなければ、リンクを外さずに PR を作り、打ち切ったことをログに残す（PBI-372）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      vi.mocked(unlinkedGeneratedBody).mockImplementationOnce(async (body) => ({
        body,
        skipped: "timeout",
      }));
      const made = await toImplement([
        implement("[手順](/workspace/docs/setup.md) を直しました。"),
      ]);
      await drain(made.service);
      expect(made.pulls.calls).toHaveLength(1);
      expect(made.pulls.calls[0]?.body).toContain(
        "[手順](/workspace/docs/setup.md) を直しました。",
      );
      expect(linksKeptLogs(warn)).toEqual([
        `[daemon] タスク ${made.id} の PR（https://github.com/acme/app）の本文から、作業領域へのリンクを外せませんでした（解析が 5 秒で終わりませんでした）。本文は、リンクを外さずに使います`,
      ]);
      made.activity.close();
    } finally {
      warn.mockRestore();
    }
  });

  it("本文の解析ができたときは、外せなかったことのログを出さない（PBI-372）", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const made = await toImplement([
        implement("[手順](/workspace/docs/setup.md) を直しました。"),
      ]);
      await drain(made.service);
      expect(made.pulls.calls[0]?.body).toContain("手順（`docs/setup.md`） を直しました。");
      expect(linksKeptLogs(warn)).toEqual([]);
      made.activity.close();
    } finally {
      warn.mockRestore();
    }
  });

  it("実装の工程が終わったら、ブランチにプッシュしてPRを作り、実装の承認待ちで止まる（PBI-10b・PBI-110）", async () => {
    const { activity, service, repos, pulls, id } = await toImplementGate();
    // コミットの日時は、実装の工程の実行が終わった日時（PBI-331）
    const implemented = service
      .get(id)
      ?.activity.findLast((e) => e.type === "AgentRunCompleted" && e.payload.step === "implement");
    expect(repos.published).toEqual([
      {
        parent: "base123",
        branch: `sacty/task-${id.slice(0, 8)}`,
        message: `決済API\n\nsacty task ${id}`,
        date: implemented?.at,
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
    // 最終レビューをしないので、最終レビューの列は出さない
    expect(call?.body).toContain("| TV-1 同じキーの再送 | 1 件（`pay.test.ts`） |\n");
    expect(call?.body).not.toContain("pay.test.ts › 同じキーの再送");
    // 入力・期待結果の全文は、表の外の折りたたみに出す
    expect(call?.body).toContain("  - 入力：同じキーで2回送る");
    expect(call?.body).not.toContain("最終レビューの所見：");

    const task = service.get(id)?.task;
    expect(task?.status).toBe("awaiting_approval");
    expect(task?.gate).toEqual({ step: "implement", submission: 1 });
    expect(task?.pullRequest).toMatchObject({
      url: "https://github.com/acme/app/pull/7",
      number: 7,
    });
    expect(types(service, id).slice(-4)).toEqual([
      "BranchPushed",
      "PullRequestBodyWritten",
      "PullRequestPublished",
      "StepSubmitted",
    ]);
    // 実装の PR に、レビュー用のラベルは付けない（レビューは子タスク。PBI-330）
    expect(pulls.labels).toEqual([]);
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

  describe("sacty が作るコミットのメッセージを、リポジトリが定める形にする（PBI-301 A8）", () => {
    const commitMessage = (repos: FakeRepos, id: string) =>
      repos.published[0]?.message ?? `(${id})`;

    it("Commitizen の設定があるリポジトリでは、1行目に種類を付ける。本文の sacty task の行は変えない", async () => {
      const repos = new FakeRepos();
      repos.files.base123 = { ".czrc": '{ "path": "cz-conventional-changelog" }' };
      const { id } = await toImplementGate([], { repos });
      expect(repos.published[0]?.message).toBe(`feat: 決済API\n\nsacty task ${id}`);
    });

    it("費用の記録（B5）と同じ実行で起きても、互いに影響しない：コミットのメッセージは種類付きで、費用は報告額になる", async () => {
      const repos = new FakeRepos();
      repos.files.base123 = { ".czrc": '{ "path": "cz-conventional-changelog" }' };
      const reported = { ...implement("# 実装の説明"), reportedCostUsd: 0.5 };
      const made = await toImplement([reported], { repos });
      await drain(made.service);
      expect(repos.published[0]?.message).toBe(`feat: 決済API\n\nsacty task ${made.id}`);
      const events = made.service.get(made.id)?.activity ?? [];
      const run = events.find(
        (e) => e.type === "AgentRunCompleted" && e.payload.step === "implement",
      );
      expect(run?.type === "AgentRunCompleted" && run.payload.costUsd).toBe(0.5);
      // 報告を使った実行は 1 件。報告の無い実行は、換算として記録する（PBI-302 D2）
      expect(
        events.filter((e) => e.type === "RunCostRecorded" && e.payload.source === "reported"),
      ).toHaveLength(1);
      made.activity.close();
    });

    it("AGENTS.md が Conventional Commits を定めているときも付ける（起点のコミットの内容で決める）", async () => {
      const repos = new FakeRepos();
      repos.files.base123 = { "AGENTS.md": "コミットは Conventional Commits に従う" };
      const { id } = await toImplementGate([], { repos });
      expect(commitMessage(repos, id)).toBe(`feat: 決済API\n\nsacty task ${id}`);
    });

    it("定めが無いリポジトリ、定めを読めないリポジトリでは、今までどおり題のまま", async () => {
      const none = new FakeRepos();
      const a = await toImplementGate([], { repos: none });
      expect(commitMessage(none, a.id)).toBe(`決済API\n\nsacty task ${a.id}`);
      const unreadable = new FakeRepos();
      unreadable.readError = "git を実行できません";
      const b = await toImplementGate([], { repos: unreadable });
      expect(commitMessage(unreadable, b.id)).toBe(`決済API\n\nsacty task ${b.id}`);
    });
  });

  describe("PR のマージで承認する工程が頼んだコメントは、承認を待たずに PR に投稿する（PBI-301）", () => {
    const reply = (body = "ご指摘の件は、この位置に置いています。") =>
      [
        "# 実装の説明",
        block({
          "sacty-github-comments": {
            comments: [{ url: "https://github.com/acme/app/pull/7", body }],
          },
        }),
      ].join("\n\n");
    const commentsOf = (service: TaskService, id: string) =>
      service.get(id)?.activity.filter((e) => e.type === "GitHubCommentsPosted") ?? [];

    it("実装の PR が承認待ちになったら、頼まれたコメントを PR に1回だけ投稿し、マージの後にも重ねて投稿しない", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplement([implement(reply())], {
        pulls,
      });
      await drain(service);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("awaiting_approval");
      expect(task?.gate).toEqual({ step: "implement", submission: 1 });
      // 承認（マージ）を待たずに、PR のコメントとして投稿されている
      expect(pulls.issueComments).toHaveLength(1);
      expect(pulls.issueComments[0]).toMatchObject({
        repo: "https://github.com/acme/app",
        number: 7,
        token: "ghp_secret",
      });
      const body = pulls.issueComments[0]?.body ?? "";
      expect(body).toContain("ご指摘の件は、この位置に置いています。");
      expect(body).toContain(`sacty-comment:${id}:implement:submission-1:0`);
      expect(body).toContain("PR のマージで承認されます");
      expect(body).not.toContain("人間が承認しました");
      expect(commentsOf(service, id)).toHaveLength(1);
      expect(commentsOf(service, id)[0]?.payload).toMatchObject({
        step: "implement",
        submission: 1,
        results: [{ url: expect.stringContaining("issuecomment") }],
      });
      // 投稿後は、また実行しなくてよい
      expect(service.queuedTaskIds()).toEqual([]);
      await service.runNext(id);
      expect(pulls.issueComments).toHaveLength(1);
      // マージして承認しても、同じ提出の頼みを重ねて投稿しない
      pulls.state = { state: "merged", mergedBy: "reviewer", headSha: task?.pullRequest?.commit };
      await service.checkPullRequests();
      await drain(service);
      expect(isCompleted(service.get(id)?.task as Task)).toBe(true);
      expect(pulls.issueComments).toHaveLength(1);
      expect(commentsOf(service, id)).toHaveLength(1);
      activity.close();
    });

    it("承認待ちで一時停止している間は投稿せず（C3）、再開すると1回だけ投稿する。投稿の途中で止められても二重にならない", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplement([implement(reply())], {
        pulls,
      });
      // 承認待ちになった直後（返信を投稿する前）に、一時停止する
      while (service.get(id)?.task.status !== "awaiting_approval") await service.runNext(id);
      expect(pulls.issueComments).toHaveLength(0);
      await service.pause(id);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(service.queuedTaskIds()).toEqual([]);
      await service.runNext(id);
      expect(pulls.issueComments).toHaveLength(0);
      expect(commentsOf(service, id)).toHaveLength(0);
      service.resume(id, {});
      await drain(service);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(pulls.issueComments).toHaveLength(1);
      expect(commentsOf(service, id)).toHaveLength(1);
      activity.close();
    });

    it("同じ提出の返信の投稿処理が重なって始まっても（先の処理が既存のコメントを探している最中）、二重に投稿しない", async () => {
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      let hold = true;
      class SlowFindFirst extends FakePulls {
        override async findIssueComment(input: { repo: string; number: number; marker: string }) {
          const found = await super.findIssueComment(input);
          if (hold && input.marker.includes("sacty-comment")) {
            hold = false;
            entered.resolve();
            await gate.promise;
          }
          return found;
        }
      }
      const pulls = new SlowFindFirst();
      const { activity, service, id } = await toImplement([implement(reply())], {
        pulls,
      });
      while (service.get(id)?.task.status !== "awaiting_approval") await service.runNext(id);
      const first = service.runNext(id);
      await entered.promise;
      // 先の処理が検索の最中のまま、同じ提出の処理がもう1本始まる
      const second = service.runNext(id);
      // 先の処理が検索の最中の間に、後の処理が投稿していないこと（何も起きないこと）を見るための猶予
      await idleFor(5);
      expect(pulls.issueComments).toHaveLength(0);
      gate.resolve();
      await Promise.all([first, second]);
      expect(pulls.issueComments).toHaveLength(1);
      expect(commentsOf(service, id)).toHaveLength(1);
      activity.close();
    });

    it("投稿している途中で一時停止されたら、記録せずに止まり、再開すると目印で見つけて記録する（二重に投稿しない）", async () => {
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      class SlowPost extends FakePulls {
        override async commentIssue(input: Parameters<FakePulls["commentIssue"]>[0]) {
          entered.resolve();
          await gate.promise;
          return super.commentIssue(input);
        }
        override async findIssueComment(input: { repo: string; number: number; marker: string }) {
          const found = this.issueComments.findIndex(
            (c) => c.number === input.number && c.body.includes(input.marker),
          );
          return found < 0
            ? undefined
            : {
                id: found + 1,
                url: `${input.repo}/issues/${input.number}#issuecomment-${found + 1}`,
              };
        }
      }
      const pulls = new SlowPost();
      const { activity, service, id } = await toImplement([implement(reply())], {
        pulls,
      });
      while (service.get(id)?.task.status !== "awaiting_approval") await service.runNext(id);
      const posting = service.runNext(id);
      await entered.promise;
      await service.pause(id);
      gate.resolve();
      await posting;
      expect(service.get(id)?.task.status).toBe("paused");
      // 投稿はされたが、一時停止の間なので記録されない
      expect(pulls.issueComments).toHaveLength(1);
      expect(commentsOf(service, id)).toHaveLength(0);
      service.resume(id, {});
      await drain(service);
      expect(pulls.issueComments).toHaveLength(1);
      expect(commentsOf(service, id)).toHaveLength(1);
      activity.close();
    });

    it("承認待ちの返信を投稿している間にマージされても、承認の後に二重に投稿せず、投稿済みのものを記録する", async () => {
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      class SlowPost extends FakePulls {
        override async commentIssue(input: Parameters<FakePulls["commentIssue"]>[0]) {
          entered.resolve();
          await gate.promise;
          return super.commentIssue(input);
        }
      }
      const pulls = new SlowPost();
      const { activity, service, id } = await toImplement([implement(reply())], {
        pulls,
      });
      while (service.get(id)?.task.status !== "awaiting_approval") await service.runNext(id);
      const posting = service.runNext(id);
      await entered.promise;
      // 投稿の最中に、PR がマージされて承認された
      pulls.state = {
        state: "merged",
        mergedBy: "reviewer",
        headSha: service.get(id)?.task.pullRequest?.commit,
      };
      await service.checkPullRequests();
      expect(service.get(id)?.task.approved.implement).toBeDefined();
      gate.resolve();
      await posting;
      // 承認の後の投稿が、承認を待つ間の投稿の目印を見つけて使う
      await drain(service);
      expect(pulls.issueComments).toHaveLength(1);
      expect(commentsOf(service, id)).toHaveLength(1);
      expect(service.get(id)?.task.githubComments?.implement?.results[0]?.url).toContain(
        "issuecomment",
      );
      expect(service.queuedTaskIds()).toEqual([]);
      activity.close();
    });

    it("返信の中の作業領域の内部のパスは、人が辿れる呼び方に置き換えて投稿する", async () => {
      const pulls = new FakePulls();
      const { activity, service } = await toImplement(
        [
          implement(
            reply("/sacty-input/task.md:77 のとおりに直しました。src/pay.ts:12 を見てください。"),
          ),
        ],
        { pulls },
      );
      await drain(service);
      const body = pulls.issueComments[0]?.body ?? "";
      expect(body).not.toContain("/sacty-input");
      expect(body).toContain("タスクの依頼");
      expect(body).toContain("src/pay.ts:12");
      activity.close();
    });

    it("投稿できなかったら、理由を作業履歴に残し、タスクは承認待ちのまま進める（そのあとは投稿し直さない）", async () => {
      const pulls = new FakePulls();
      pulls.commentFail = "403 Resource not accessible ghp_secret";
      const { activity, service, id } = await toImplement([implement(reply())], {
        pulls,
      });
      await drain(service);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(pulls.issueComments).toHaveLength(0);
      const posted = commentsOf(service, id);
      expect(posted).toHaveLength(1);
      const payload = posted[0]?.payload as { results: { failed?: DaemonText }[] } | undefined;
      expect(ja(payload?.results[0]?.failed)).toContain("403");
      expect(JSON.stringify(posted)).not.toContain("ghp_secret");
      expect(service.queuedTaskIds()).toEqual([]);
      activity.close();
    });

    it("頼みを読めなければ、どれも投稿せず、読めなかったことを作業履歴に残す", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplement(
        [implement('# 実装の説明\n\n```json\n{"sacty-github-comments": {"comments": "x"}}\n```')],
        { pulls },
      );
      await drain(service);
      expect(pulls.issueComments).toHaveLength(0);
      const posted = commentsOf(service, id);
      expect(posted).toHaveLength(1);
      expect(posted[0]?.payload).toMatchObject({ submission: 1, results: [] });
      const payload = posted[0]?.payload as { failed?: DaemonText } | undefined;
      expect(ja(payload?.failed)).toContain("読めません");
      activity.close();
    });

    it("実装の作り直しで次の提出になったら、その提出の頼みを、また1回だけ投稿する", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplement(
        [implement(reply("1回目の返信")), implement(reply("2回目の返信"))],
        { pulls },
      );
      await drain(service);
      expect(pulls.issueComments).toHaveLength(1);
      service.requestChanges(id, {
        step: "implement",
        submission: 1,
        target: "implement",
        comments: ["もう1点直してください"],
      });
      await drain(service);
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
      expect(pulls.issueComments.map((c) => c.body.split("\n")[1])).toEqual([
        "1回目の返信",
        "2回目の返信",
      ]);
      expect(commentsOf(service, id)).toHaveLength(2);
      activity.close();
    });
  });

  describe("実装の作り直しの間に実装の PR がマージされたら、作り直しを止めて承認として進める（PBI-276）", () => {
    const remark = "失敗時のログを足してください";
    /** 実装の承認待ちから、PR の指摘で実装に差し戻す（作り直しの始まり）。 */
    const sendBack = (
      service: TaskService,
      id: string,
      target: "implement" | "design" = "implement",
    ) =>
      service.requestChanges(id, {
        step: "implement",
        submission: 1,
        target,
        comments: [remark],
      });
    /** 人が GitHub で実装の PR をマージした。 */
    const mergePr = (pulls: FakePulls, service: TaskService, id: string, headSha?: string) => {
      pulls.state = {
        state: "merged",
        mergedBy: "reviewer",
        headSha: headSha ?? service.get(id)?.task.pullRequest?.commit,
        mergeCommit: "m".repeat(40),
      };
    };
    const tail = (service: TaskService, id: string, n: number) =>
      (service.get(id)?.activity ?? []).slice(-n).map((e) => [e.type, e.actor]);
    const stopped = (service: TaskService, id: string) =>
      service.get(id)?.activity.filter((e) => e.type === "ReworkStoppedByMerge") ?? [];
    /** 完了（承認して次へ進んだ）か。新しい PR を作っていないか。 */
    const expectDone = (service: TaskService, id: string, pulls: FakePulls) => {
      const task = service.get(id)?.task;
      expect(task?.steps.every((st) => st.state === "done")).toBe(true);
      expect(task?.status).toBe("idle");
      expect(task?.pullRequestState).toBe("merged");
      expect(task?.gate).toBeUndefined();
      expect(service.queuedTaskIds()).toEqual([]);
      // 新しい PR を作らず、マージした PR を更新もしていない
      expect(pulls.calls).toHaveLength(1);
      expect(
        service.get(id)?.activity.filter((e) => e.type === "PullRequestPublished"),
      ).toHaveLength(1);
    };

    it("実行を待っている作り直しは、実行せずに止め、捨てた指摘を理由とともに残して、マージを承認として完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate([], { pulls });
      const calls = executor.calls.length;
      sendBack(service, id);
      expect(service.get(id)?.task.status).toBe("queued");
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      expect(tail(service, id, 3)).toEqual([
        ["ReworkStoppedByMerge", "sacty"],
        ["PullRequestMerged", "person"],
        ["StepApproved", "person"],
      ]);
      expect(stopped(service, id)[0]?.payload).toEqual({
        number: 7,
        was: "queued",
        stoppedRuns: [],
        discardedRemarks: [{ id: "implement-1-1", text: remark }],
      });
      const task = service.get(id)?.task;
      // 捨てた指摘は無効になる（エージェントに渡さない）
      expect(task?.remarks.find((r) => r.id === "implement-1-1")?.voided).toBe(true);
      expect(task?.pullRequestMerge).toMatchObject({ by: "reviewer", edited: false });
      expect(executor.calls).toHaveLength(calls);
      expectDone(service, id, pulls);
      // 続きの確認で、記録を重ねない
      await service.checkPullRequests();
      expect(stopped(service, id)).toHaveLength(1);
      expect(service.get(id)?.activity.filter((e) => e.type === "PullRequestMerged")).toHaveLength(
        1,
      );
      activity.close();
    });

    it("作り直しを止めたら、実装の PR にも、マージを承認として扱ったことと、捨てた指摘の件数を、目印付きの知らせで1件だけ書く（PBI-462）", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([], { pulls });
      sendBack(service, id);
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      await service.checkPullRequests();
      await noticesSettled(service);
      const notices = pulls.issueComments.filter((c) =>
        c.body.includes(`<!-- sacty-merge-approval:${id}:7 -->`),
      );
      expect(notices).toHaveLength(1);
      expect(notices[0]?.number).toBe(7);
      expect(notices[0]?.body).toContain("承認として扱い");
      expect(notices[0]?.body).toContain("1件");
      activity.close();
    });

    it("PR の中で人が直してからマージしたなら、直した最終のコミットも残す", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([], { pulls });
      const submitted = service.get(id)?.task.pullRequest?.commit;
      sendBack(service, id);
      mergePr(pulls, service, id, "f".repeat(40));
      await service.checkPullRequests();
      const merged = service.get(id)?.activity.find((e) => e.type === "PullRequestMerged");
      expect(merged?.payload).toMatchObject({
        commit: "f".repeat(40),
        submitted,
        edited: true,
      });
      expectDone(service, id, pulls);
      activity.close();
    });

    it("実装のエージェントの実行中なら、コンテナを止め、止めた実行を残して、マージを承認として完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate([HOLD, implement("# v2")], {
        pulls,
      });
      const calls = executor.calls.length;
      sendBack(service, id);
      const running = service.runNext(id);
      const runId = await executor.started.promise;
      expect(service.get(id)?.task.status).toBe("running");
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      await running;
      expect(executor.killed).toEqual([runId]);
      expect(types(service, id).slice(-5)).toEqual([
        "AgentRunFailed",
        "TaskPaused",
        "ReworkStoppedByMerge",
        "PullRequestMerged",
        "StepApproved",
      ]);
      expect(stopped(service, id)[0]?.payload).toMatchObject({
        was: "running",
        stoppedRuns: [runId],
        discardedRemarks: [{ id: "implement-1-1" }],
      });
      // 一時停止の記録は残るが、いまは一時停止ではない
      expect(service.get(id)?.task.pausedReason).toBeUndefined();
      expect(executor.calls).toHaveLength(calls + 1);
      expectDone(service, id, pulls);
      activity.close();
    });

    it("止める前に実行が正常に終わっていても、一時停止を記録せず、マージを承認として完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate([HOLD, implement("# v2")], {
        pulls,
      });
      // コンテナを止める合図の時点で、実行はちょうど正常に終わった
      executor.kill = (runId: string) => {
        executor.killed.push(runId);
        executor.finishHeld(runId, implement("# v2"));
      };
      sendBack(service, id);
      const running = service.runNext(id);
      const runId = await executor.started.promise;
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      await running;
      expect(executor.killed).toEqual([runId]);
      const names = types(service, id);
      expect(names.slice(names.lastIndexOf("ChangesRequested"))).not.toContain("TaskPaused");
      expect(stopped(service, id)[0]?.payload).toMatchObject({ stoppedRuns: [runId] });
      expectDone(service, id, pulls);
      activity.close();
    });

    it("PR の更新の直前にマージされていたら（確認の前）、プッシュも PR の作成もせず、マージを承認として完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, repos, id } = await toImplementGate([implement("# v2")], {
        pulls,
      });
      const pushes = repos.published.length;
      sendBack(service, id);
      // マージの確認（60 秒ごと）より前に、作り直しが PR の更新まで進む
      mergePr(pulls, service, id);
      await drain(service);
      expect(stopped(service, id)[0]?.payload).toMatchObject({
        was: "publishing",
        stoppedRuns: [],
      });
      expect(repos.published).toHaveLength(pushes);
      expectDone(service, id, pulls);
      activity.close();
    });

    it("一時停止中の作り直しも、マージされたら止めて承認として完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([], { pulls });
      sendBack(service, id);
      await service.pause(id);
      expect(service.get(id)?.task.status).toBe("paused");
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      expect(stopped(service, id)[0]?.payload).toMatchObject({ was: "paused" });
      const task = service.get(id)?.task;
      expect(task?.pausedReason).toBeUndefined();
      expect(task?.resumeTo).toBeUndefined();
      expectDone(service, id, pulls);
      activity.close();
    });

    it("マージされていない PR（開いたまま・閉じられた）では、作り直しを止めない", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([implement("# v2")], {
        pulls,
      });
      sendBack(service, id);
      await service.checkPullRequests();
      pulls.state = { state: "closed" };
      await service.checkPullRequests();
      expect(stopped(service, id)).toHaveLength(0);
      expect(service.get(id)?.task.status).toBe("queued");
      // 作り直しはそのまま進み、新しい実装の承認待ちになる
      pulls.state = { state: "open" };
      await drain(service);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("awaiting_approval");
      expect(task?.gate).toEqual({ step: "implement", submission: 2 });
      expect(stopped(service, id)).toHaveLength(0);
      activity.close();
    });

    it("要求要件・設計をやり直している間は、実装の PR のマージで作り直しを止めない", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([], { pulls });
      sendBack(service, id, "design");
      expect(service.get(id)?.task.steps.find((st) => st.state === "active")?.key).toBe("design");
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      expect(stopped(service, id)).toHaveLength(0);
      expect(service.get(id)?.task.status).toBe("queued");
      activity.close();
    });

    it("PR の状態を読めなければ何も記録せず、次の確認で止める", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate([], { pulls });
        sendBack(service, id);
        mergePr(pulls, service, id);
        pulls.statusFail = "GitHub に接続できません";
        await service.checkPullRequests();
        expect(stopped(service, id)).toHaveLength(0);
        expect(service.get(id)?.task.status).toBe("queued");
        pulls.statusFail = undefined;
        await service.checkPullRequests();
        expect(stopped(service, id)).toHaveLength(1);
        expectDone(service, id, pulls);
        activity.close();
      } finally {
        warn.mockRestore();
      }
    });

    it("止めたコンテナが無くなったと確かめられない間は進めず、確かめられたら完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate([HOLD, implement("# v2")], {
        pulls,
      });
      sendBack(service, id);
      const running = service.runNext(id);
      const runId = await executor.started.promise;
      executor.stops = false;
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      await running;
      let task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.unstoppedRuns).toEqual([runId]);
      expect(stopped(service, id)).toHaveLength(0);
      executor.stops = true;
      await service.checkPullRequests();
      expect(stopped(service, id)).toHaveLength(1);
      // 前の確認で止めたコンテナを確かめられなかった実行も、止めた実行に残す
      expect(stopped(service, id)[0]?.payload).toMatchObject({ stoppedRuns: [runId] });
      task = service.get(id)?.task;
      expect(task?.unstoppedRuns).toBeUndefined();
      expectDone(service, id, pulls);
      activity.close();
    });

    it("止めた実行が正常に終わっても、停止の確認を待つ間は、ワーカーが続きの検証を始めない", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate([HOLD, implement("# v2")], {
        pulls,
      });
      executor.kill = (runId: string) => {
        executor.killed.push(runId);
        executor.finishHeld(runId, implement("# v2"));
      };
      // 停止の確認（1回目は実行の後始末、2回目は PR のマージによる停止）の2回目を、止めておく
      const gate = Promise.withResolvers<void>();
      let confirms = 0;
      executor.ensureStopped = async () => {
        confirms += 1;
        if (confirms === 2) await gate.promise;
        return true;
      };
      sendBack(service, id);
      const running = service.runNext(id);
      await executor.started.promise;
      mergePr(pulls, service, id);
      const checking = service.checkPullRequests();
      await waitForAssertion(() => expect(confirms).toBe(2));
      // 実行は idle・検証待ちで終わっているが、承認か一時停止を記録するまで、実行を始めさせない
      expect(service.get(id)?.task.verification).toBe("pending");
      const calls = executor.calls.length;
      expect(service.queuedTaskIds()).toEqual([]);
      await service.runNext(id);
      expect(executor.calls).toHaveLength(calls);
      gate.resolve();
      await checking;
      await running;
      expect(executor.calls).toHaveLength(calls);
      expectDone(service, id, pulls);
      activity.close();
    });

    it("止めた実行が正常に終わった費用で予算を超えて一時停止しても、止めたコンテナを確かめるまで承認へ進めない", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate([HOLD], { pulls });
      // 実装の実行は、15 ドルかかって正常に終わる（予算の上限を超える）
      const costly = out(
        [
          "# v2",
          block({
            "sacty-test-map": [
              { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] },
              { viewpointId: "TV-2", tests: ["pay.test.ts › キーなし"] },
            ],
          }),
        ].join("\n\n"),
        1_000_000,
      );
      executor.kill = (runId: string) => {
        executor.killed.push(runId);
        executor.finishHeld(runId, costly);
      };
      sendBack(service, id);
      const running = service.runNext(id);
      const runId = await executor.started.promise;
      executor.stops = false;
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      await running;
      let task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.pausedReason).toBe("budget");
      // 一時停止の理由は予算のまま、確かめられなかった実行を残す
      expect(task?.unstoppedRuns).toEqual([runId]);
      expect(stopped(service, id)).toHaveLength(0);
      // 次の確認でも、確かめられない間は進めない
      await service.checkPullRequests();
      expect(stopped(service, id)).toHaveLength(0);
      executor.stops = true;
      await service.checkPullRequests();
      expect(stopped(service, id)[0]?.payload).toMatchObject({ stoppedRuns: [runId] });
      task = service.get(id)?.task;
      expect(task?.unstoppedRuns).toBeUndefined();
      expectDone(service, id, pulls);
      activity.close();
    });

    it("承認待ちで閉じられた PR を差し戻し、GitHub で開き直してマージしたら、新しい PR は作らず、マージを承認として完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([], { pulls });
      pulls.state = { state: "closed" };
      await service.checkPullRequests();
      expect(service.get(id)?.task.pullRequestState).toBe("closed");
      sendBack(service, id);
      expect(service.get(id)?.task.status).toBe("queued");
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      expect(stopped(service, id)[0]?.payload).toMatchObject({ number: 7, was: "queued" });
      expectDone(service, id, pulls);
      activity.close();
    });

    it("閉じたままの PR を差し戻し、PR の更新の直前に開き直されてマージされていたら、新しい PR は作らず、承認として完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([implement("# v2")], {
        pulls,
      });
      pulls.state = { state: "closed" };
      await service.checkPullRequests();
      sendBack(service, id);
      // マージの確認より前に、作り直しが PR の更新まで進む
      mergePr(pulls, service, id);
      await drain(service);
      expect(stopped(service, id)[0]?.payload).toMatchObject({ was: "publishing" });
      expectDone(service, id, pulls);
      activity.close();
    });

    it("デーモンが実装の実行中に止まって再起動した後も、止めたコンテナを確かめるまで承認へ進めず、確かめたら止めた実行に残す", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate([HOLD], { pulls });
      sendBack(service, id);
      void service.runNext(id);
      const runId = await executor.started.promise;
      // ここでデーモンが止まった（実行はそのまま。コンテナが残っている）。再起動して復旧する
      const restarted = makeService(activity, [], { pulls });
      restarted.service.recoverInterrupted();
      const paused = restarted.service.get(id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.unstoppedRuns).toEqual([runId]);
      mergePr(pulls, restarted.service, id);
      restarted.executor.stops = false;
      await restarted.service.checkPullRequests();
      expect(stopped(restarted.service, id)).toHaveLength(0);
      expect(restarted.service.get(id)?.task.status).toBe("paused");
      restarted.executor.stops = true;
      await restarted.service.checkPullRequests();
      expect(stopped(restarted.service, id)[0]?.payload).toMatchObject({
        was: "paused",
        stoppedRuns: [runId],
      });
      expectDone(restarted.service, id, pulls);
      activity.close();
    });

    it("PR の更新で、確認では開いていたが、プッシュの間にマージされたら、新しい PR は作らず、マージを承認として完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([implement("# v2")], {
        pulls,
      });
      const commit = service.get(id)?.task.pullRequest?.commit;
      sendBack(service, id);
      // PR の更新の直前の確認では開いていて、プッシュの後の確認ではマージされている
      let reads = 0;
      pulls.status = async () => ({
        headSha: commit,
        ...(++reads === 1
          ? { state: "open" as const }
          : { state: "merged" as const, mergedBy: "reviewer" }),
      });
      await drain(service);
      expect(reads).toBe(2);
      expect(stopped(service, id)[0]?.payload).toMatchObject({ was: "publishing" });
      expect(
        service
          .get(id)
          ?.activity.filter((e) => e.type === "StepSubmitted" && e.payload.step === "implement"),
      ).toHaveLength(1);
      expectDone(service, id, pulls);
      activity.close();
    });

    it("実装の承認待ちの間のマージは、これまでどおり承認として完了する（作り直しの記録は残さない）", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([], { pulls });
      mergePr(pulls, service, id);
      await service.checkPullRequests();
      expect(stopped(service, id)).toHaveLength(0);
      expect(tail(service, id, 2)).toEqual([
        ["PullRequestMerged", "person"],
        ["StepApproved", "person"],
      ]);
      activity.close();
    });
  });

  describe("PR の push が一時的に失敗したら、push だけをやり直す（PBI-467）", () => {
    const remoteRejected = (reason = "failed", extra = "") =>
      [
        extra,
        "To https://x-access-token:ghp_secret@github.com/acme/app.git",
        `! [remote rejected] ${"c1".padEnd(40, "0")} -> sacty/x (${reason})`,
        "error: failed to push some refs to 'https://x-access-token:ghp_secret@github.com/acme/app.git'",
      ]
        .filter((line) => line !== "")
        .join("\n");
    const FAILED = remoteRejected();
    const TYPES = ["PushRetried", "PushRetryEnded", "PullRequestPublished", "TaskPaused"];
    const seen = (svc: TaskService, id: string) =>
      svc.get(id)?.activity.filter((e) => TYPES.includes(e.type)) ?? [];
    const kinds = (svc: TaskService, id: string) => seen(svc, id).map((e) => e.type);

    /** 実装を終えて、PR の作成だけが残るところまで進める。 */
    async function toPublish(options: Parameters<typeof toImplement>[1] = {}) {
      const repos = options.repos ?? new FakeRepos();
      const pulls = options.pulls ?? new FakePulls();
      const made = await toImplement([implement("# 実装の説明")], {
        pushRetryDelaysMs: [0, 0, 0],
        ...options,
        repos,
        pulls,
      });
      await made.service.runNext(made.id); // 実装
      await made.service.runNext(made.id); // 検証
      expect(made.service.get(made.id)?.task.publishPending).toBe(true);
      return { ...made, repos, pulls };
    }

    it("[remote rejected] ... (failed) で 1 回失敗しても止まらず、同じコミット・ブランチ・認証の環境で push し直して PR を作る。記録する失敗の文の秘密の値は伏せる", async () => {
      const { activity, service, repos, id } = await toPublish();
      repos.pushScript = [FAILED];
      await service.runNext(id);
      expect(repos.pushAttempts).toHaveLength(2);
      expect(repos.pushAttempts[1]).toEqual(repos.pushAttempts[0]);
      expect(repos.pushAttempts[0]?.authEnv).toBeDefined();
      expect(kinds(service, id)).toEqual(["PushRetried", "PushRetryEnded", "PullRequestPublished"]);
      const [retried, ended] = seen(service, id);
      expect(retried?.payload).toMatchObject({ attempt: 1, maxAttempts: 3, waitMs: 0 });
      const text = ja(retried?.payload.message as DaemonText);
      expect(text).toContain("[remote rejected]");
      expect(text).not.toContain("ghp_secret");
      expect(ended?.payload).toMatchObject({ outcome: "pushed", retries: 1 });
      activity.close();
    });

    it.each([
      ["HTTP 5xx", "error: RPC failed; HTTP 500 curl 22 The requested URL returned error: 500"],
      ["429", "fatal: unable to access 'https://x/': The requested URL returned error: 429"],
      [
        "レート制限の 403",
        "remote: You have exceeded a secondary rate limit.\nfatal: unable to access 'https://x/': The requested URL returned error: 403",
      ],
      ["接続の失敗", "fatal: unable to access 'https://x/': Could not resolve host: github.com"],
    ])("%s は一時的とみなして、やり直す", async (_name, stderr) => {
      const { activity, service, repos, id } = await toPublish();
      repos.pushScript = [stderr];
      await service.runNext(id);
      expect(kinds(service, id)).toEqual(["PushRetried", "PushRetryEnded", "PullRequestPublished"]);
      expect(seen(service, id)[1]?.payload).toMatchObject({ outcome: "pushed", retries: 1 });
      expect(repos.pushAttempts).toHaveLength(2);
      activity.close();
    });

    it.each([
      ["保護での拒否", "remote: error: GH006: Protected branch update failed for refs/heads/x."],
      [
        "ルールでの拒否",
        "remote: error: GH013: Repository rule violations found for refs/heads/x.",
      ],
      ["フックでの拒否", remoteRejected("pre-receive hook declined")],
      [
        "workflow の権限が無い",
        remoteRejected(
          "refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope",
        ),
      ],
      ["fast-forward でない", " ! [rejected]        x -> x (non-fast-forward)"],
      ["認証の失敗", "fatal: Authentication failed for 'https://github.com/acme/app.git/'"],
      [
        "レート制限でない HTTP 401",
        "fatal: unable to access 'https://x/': The requested URL returned error: 401",
      ],
      [
        "レート制限でない HTTP 403",
        "fatal: unable to access 'https://x/': The requested URL returned error: 403",
      ],
      ["分類に当たらない文", "something unexpected happened"],
    ])("一時的でない失敗（%s）は、やり直さずにすぐ止める", async (_name, stderr) => {
      const { activity, service, repos, id } = await toPublish();
      repos.pushScript = [stderr];
      await service.runNext(id);
      expect(repos.pushAttempts).toHaveLength(1);
      expect(kinds(service, id)).toEqual(["TaskPaused"]);
      const paused = service.get(id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.pausedMessage).toMatchObject({ code: "pr.failed" });
      expect(
        service.get(id)?.activity.findLast((e) => e.type === "TaskPaused")?.payload,
      ).toMatchObject({
        reason: "error",
      });
      activity.close();
    });

    it("上限の回数までやり直しても通らなければ、回数を記録して、今までと同じ pr.failed で止まる", async () => {
      const { activity, service, repos, id } = await toPublish();
      repos.pushScript = [FAILED, FAILED, FAILED, FAILED];
      await service.runNext(id);
      expect(repos.pushAttempts).toHaveLength(4);
      expect(kinds(service, id)).toEqual([
        "PushRetried",
        "PushRetried",
        "PushRetried",
        "PushRetryEnded",
        "TaskPaused",
      ]);
      const events = seen(service, id);
      expect(events.slice(0, 3).map((e) => e.payload.attempt)).toEqual([1, 2, 3]);
      expect(events[3]?.payload).toMatchObject({ outcome: "failed", retries: 3 });
      expect(events[4]?.payload).toMatchObject({ reason: "error", message: { code: "pr.failed" } });
      activity.close();
    });

    it("やり直しの途中で一時的でない失敗（保護での拒否）に変わったら、そこでやり直しをやめ、回数を記録して pr.failed で止まる", async () => {
      const { activity, service, repos, id } = await toPublish();
      repos.pushScript = [
        FAILED,
        remoteRejected("protected branch hook declined", "remote: error: GH006: Protected branch"),
      ];
      await service.runNext(id);
      expect(repos.pushAttempts).toHaveLength(2);
      expect(kinds(service, id)).toEqual(["PushRetried", "PushRetryEnded", "TaskPaused"]);
      expect(seen(service, id)[1]?.payload).toMatchObject({ outcome: "failed", retries: 1 });
      expect(seen(service, id)[2]?.payload).toMatchObject({ message: { code: "pr.failed" } });
      activity.close();
    });

    it("停止の理由の文は、案内の remote: の行を除き、失敗の行を先頭に置き、拒否の理由の行は残し、秘密の値を伏せる", async () => {
      const { activity, service, repos, id } = await toPublish();
      repos.pushScript = [
        [
          "remote:",
          "remote: Create a pull request for 'x' on GitHub by visiting:",
          "remote:      https://github.com/o/r/pull/new/x",
          "remote: error: GH006: Protected branch update failed",
          "To https://x-access-token:ghp_secret@github.com/o/r.git",
          " ! [remote rejected] c1 -> x (protected branch hook declined)",
          "error: failed to push some refs to 'https://x-access-token:ghp_secret@github.com/o/r.git'",
        ].join("\n"),
      ];
      await service.runNext(id);
      const text = ja(service.get(id)?.task.pausedMessage);
      const detail = text.slice(
        text.indexOf("git push に失敗しました：") + "git push に失敗しました：".length,
      );
      expect(detail.startsWith("! [remote rejected]")).toBe(true);
      expect(detail).not.toContain("Create a pull request");
      expect(detail).not.toContain("pull/new");
      expect(detail).not.toMatch(/^remote:$/m);
      expect(detail).toContain("remote: error: GH006: Protected branch update failed");
      expect(detail).not.toContain("ghp_secret");
      activity.close();
    });

    it("前の回で push が通って応答だけが失われたときは、やり直しの push を通ったとして扱い、回数に数える", async () => {
      const { activity, service, repos, id } = await toPublish();
      repos.rejectExistingBranch = true;
      repos.pushScript = [{ stderr: FAILED, applied: true }];
      await service.runNext(id);
      expect(kinds(service, id)).toEqual(["PushRetried", "PushRetryEnded", "PullRequestPublished"]);
      expect(seen(service, id)[1]?.payload).toMatchObject({ outcome: "pushed", retries: 1 });
      activity.close();
    });

    it("やり直しを待つ間に一時停止したら、push も記録もせずにやめ、一時停止の理由を上書きしない", async () => {
      const { activity, service, repos, id } = await toPublish({ pushRetryDelaysMs: [60_000] });
      repos.pushScript = [FAILED];
      const running = service.runNext(id);
      await waitFor(() => repos.pushAttempts.length === 1, { what: "最初の push" });
      const pausing = service.pause(id).catch((e: unknown) => e);
      await running;
      await pausing;
      expect(repos.pushAttempts).toHaveLength(1);
      expect(kinds(service, id)).toEqual(["TaskPaused"]);
      expect(seen(service, id)[0]?.payload).toMatchObject({ reason: "manual" });
      activity.close();
    });

    it("push の失敗（上限まで）で止まった実装のタスクを、新しい指摘なしで再開すると、エージェントを実行せず push からやり直す", async () => {
      const { activity, service, repos, executor, id } = await toPublish();
      repos.pushScript = [FAILED, FAILED, FAILED, FAILED];
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("paused");
      const runs = executor.calls.length;
      service.resume(id, {});
      await service.runNext(id);
      expect(executor.calls).toHaveLength(runs);
      expect(repos.pushAttempts).toHaveLength(5);
      expect(kinds(service, id).at(-1)).toBe("PullRequestPublished");
      activity.close();
    });

    it("前の版の形（案内の remote: の行が残る pr.failed）で止まったタスクと、やり直しを待つ間に一時停止したタスクを再開しても、push からやり直す", async () => {
      // (a) 案内の行が残る pr.failed で止まった
      const a = await toPublish();
      a.repos.pushScript = [
        "remote: Create a pull request for 'x' on GitHub by visiting:\nremote:      https://github.com/o/r/pull/new/x\n! [remote rejected] c1 -> x (pre-receive hook declined)",
      ];
      await a.service.runNext(a.id);
      expect(a.service.get(a.id)?.task.status).toBe("paused");
      const runsA = a.executor.calls.length;
      a.service.resume(a.id, {});
      a.repos.pushScript = [FAILED];
      await a.service.runNext(a.id);
      expect(a.executor.calls).toHaveLength(runsA);
      expect(kinds(a.service, a.id).slice(-3)).toEqual([
        "PushRetried",
        "PushRetryEnded",
        "PullRequestPublished",
      ]);
      expect(seen(a.service, a.id).at(-2)?.payload).toMatchObject({
        outcome: "pushed",
        retries: 1,
      });
      a.activity.close();
      // (b) やり直しを待つ間に一時停止した
      const b = await toPublish({ pushRetryDelaysMs: [60_000] });
      b.repos.pushScript = [FAILED];
      const running = b.service.runNext(b.id);
      await waitFor(() => b.repos.pushAttempts.length === 1, { what: "最初の push" });
      const pausing = b.service.pause(b.id).catch((e: unknown) => e);
      await running;
      await pausing;
      expect(b.service.get(b.id)?.task.status).toBe("paused");
      const runsB = b.executor.calls.length;
      b.service.resume(b.id, {});
      b.repos.pushScript = [FAILED];
      // 再開後は、待ち時間を実際には待たない（上限の 60 秒の待ちを短くするため、待ち時間は 1 回分だけ）
      vi.useFakeTimers();
      try {
        const resumed = b.service.runNext(b.id);
        await vi.advanceTimersByTimeAsync(61_000);
        await resumed;
      } finally {
        vi.useRealTimers();
      }
      expect(b.executor.calls).toHaveLength(runsB);
      expect(kinds(b.service, b.id).slice(-3)).toEqual([
        "PushRetried",
        "PushRetryEnded",
        "PullRequestPublished",
      ]);
      b.activity.close();
    });
  });

  describe("実装の工程の中で PR を作って承認を待つ（PBI-110）", () => {
    it("工程に「PR作成」は無く、実装の工程のまま PR を作って実装の承認待ちになり、マージで完了する", async () => {
      const { activity, service, id } = await toImplement([implement("# 実装の説明")]);
      expect(service.get(id)?.task.steps.map((s) => s.key)).toEqual([
        "requirements",
        "design",
        "implement",
      ]);
      await service.runNext(id); // 実装
      await service.runNext(id); // 最終レビューをせず、PR の作成へ進める
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
        "FinalReviewSkipped",
        "BranchPushed",
        "PullRequestBodyWritten",
        "PullRequestPublished",
        "StepSubmitted",
      ]);
      const submitted = service.get(id)?.activity.findLast((e) => e.type === "StepSubmitted");
      expect(submitted?.payload).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });

    it("PR を作っている途中に一時停止を求めたら、作り終えて承認待ちにし、一時停止しなかったとはっきり返す（レビュー指摘）", async () => {
      const pulls = new FakePulls();
      const gate = Promise.withResolvers<void>();
      pulls.upsertGate = gate.promise;
      const { activity, service, id } = await toImplement([implement("# 実装の説明")], {
        pulls,
      });
      await service.runNext(id); // 実装
      await service.runNext(id); // 最終レビューをせず、PR の作成へ進める
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
      const { activity, service, pulls, id } = await toImplement([implement("# 実装の説明")], {
        repos,
      });
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

    it("プッシュの途中に人が題を変えたら、作る PR の題と本文は新しい題にする（PBI-323・PR #330 レビュー指摘）", async () => {
      const repos = new FakeRepos();
      const gate = Promise.withResolvers<void>();
      repos.publishGate = gate.promise;
      const { activity, service, pulls, id } = await toImplement([implement("# 実装の説明")], {
        repos,
      });
      await service.runNext(id);
      await service.runNext(id);
      const before = service.get(id)?.task.title ?? "";
      const publishing = service.runNext(id);
      await repos.publishStarted.promise;
      service.renameTask(id, { title: "途中で変えた題" });
      gate.resolve();
      await publishing;
      expect(pulls.calls).toHaveLength(1);
      expect(pulls.calls[0]?.title).toBe("途中で変えた題");
      // 本文は題を繰り返さない（PBI-471）
      expect(pulls.calls[0]?.body).not.toContain(`「${before}」`);
      activity.close();
    });

    it("PR を作れずに止まったら、再開すると実装をやり直さずに PR を作り直す", async () => {
      const pulls = new FakePulls();
      pulls.fail = "boom";
      const { activity, service, executor, id } = await toImplement([implement("# 実装の説明")], {
        pulls,
      });
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

    it("PR テンプレートを読む間に人が題を変えても、PR の本文は新しい題で書く（PBI-323・PR #330 レビュー指摘）", async () => {
      let rename = () => {};
      const { activity, service, pulls, id } = await toImplement([implement("# 実装の説明")], {
        templates: {
          find: async () => {
            rename();
            return { kind: "none" };
          },
        },
      });
      rename = () => {
        rename = () => {};
        service.renameTask(id, { title: "テンプレートの間に変えた題" });
      };
      await drain(service);
      expect(pulls.calls.at(-1)?.title).toBe("テンプレートの間に変えた題");
      expect(pulls.calls.at(-1)?.body).not.toContain("成果物です");
      activity.close();
    });

    it("PR を作れずに止まった後に題を変えて再開しても、同じ提出のコミットは同じメッセージにし、PR は新しい題で作る（PBI-323・PR #330 レビュー指摘）", async () => {
      const repos = new FakeRepos();
      const pulls = new FakePulls();
      pulls.fail = "boom";
      const { activity, service, id } = await toImplement([implement("# 実装の説明")], {
        pulls,
        repos,
      });
      await drain(service);
      expect(service.get(id)?.task.publishPending).toBe(true);
      const before = service.get(id)?.task.title ?? "";
      const first = repos.published.at(-1)?.message;
      expect(first).toContain(before);
      service.renameTask(id, { title: "止まった後に変えた題" });
      pulls.fail = undefined;
      service.resume(id, {});
      await drain(service);
      // 同じ日時・同じ題で作り直すので、プッシュ済みのコミットと同じになる（別のコミットはプッシュを断られる）
      expect(repos.published.at(-1)?.message).toBe(first);
      expect(pulls.calls.at(-1)?.title).toBe("止まった後に変えた題");
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
      activity.close();
    });

    it("時計が戻った後に題を変えても、同じ提出のコミットは同じメッセージにする（PBI-323・PR #330 レビュー指摘）", async () => {
      const repos = new FakeRepos();
      const pulls = new FakePulls();
      pulls.fail = "boom";
      const { activity, service, id } = await toImplement([implement("# 実装の説明")], {
        pulls,
        repos,
      });
      await drain(service);
      const first = repos.published.at(-1)?.message;
      // 題の変更の記録の日時が、コミットの日時より前になる（時計が戻った）
      const clock = activity as unknown as { now: () => Date };
      const now = clock.now;
      clock.now = () => new Date(0);
      service.renameTask(id, { title: "時計が戻った後の題" });
      clock.now = now;
      pulls.fail = undefined;
      service.resume(id, {});
      await drain(service);
      expect(repos.published.at(-1)?.message).toBe(first);
      expect(pulls.calls.at(-1)?.title).toBe("時計が戻った後の題");
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

  describe("「指摘なし」の後に実装の PR の CI が失敗していたら、タスクに記録して出す（何も始めない。PBI-364）", () => {
    const ciTypes = (service: TaskService, id: string) =>
      types(service, id).filter((t) => t === "PullRequestCiFailed");
    /** 読むたびに、そのときの checks・jobs を返す偽の CI。読んだコミットを覚える。 */
    const fakeCi = () => {
      const state: {
        checks: CiCheck[];
        jobs: CiCheck[];
        read: string[];
        fail?: Error;
        truncated?: true;
        /** 読んでいる間に起こすこと（読み取りの途中で、タスクの状態を変える）。 */
        during?: () => Promise<void>;
      } = { checks: [], jobs: [], read: [] };
      const ci: CiStatusReader = {
        snapshot: async (input) => {
          state.read.push(input.commit);
          if (state.fail) throw state.fail;
          await state.during?.();
          return {
            checks: state.checks,
            jobs: state.jobs,
            failedRuns: [],
            ...(state.truncated ? { truncated: true as const } : {}),
          };
        },
        failures: async () => [],
        rerunFailedJobs: async () => {},
        repositoryHasNoCi: async () => false,
      };
      return { ci, state };
    };
    const workflow = (conclusion?: string): CiCheck => ({
      kind: "workflow",
      name: "CI",
      status: conclusion ? "completed" : "pending",
      ...(conclusion ? { conclusion } : {}),
      url: "https://github.com/acme/app/actions/runs/1",
    });
    const job = (name: string, conclusion: string, url?: string): CiCheck => ({
      kind: "check",
      name,
      status: "completed",
      conclusion,
      ...(url ? { url } : {}),
    });

    it("レビューの時点で実行中だった CI が落ちたら、先頭のコミットごとに1度だけ記録する。実行も PR の更新も始めない", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      let now = Date.parse("2026-11-17T00:00:00Z");
      const { activity, service, executor, repos, id } = await toImplementGate([], {
        pulls,
        ci,
        now: () => now,
      });
      const runs = executor.calls.length;
      const before = types(service, id);
      const commit = service.get(id)?.task.pullRequest?.commit ?? "";
      // 実行中の間は、記録しない。読み直すのは、間隔の後（確認のたびには読まない）
      state.checks = [workflow()];
      pulls.state = { state: "open", headSha: commit };
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(state.read).toEqual([commit]);
      expect(ciTypes(service, id)).toEqual([]);

      // 落ちた：失敗したワークフローとジョブを記録する（同じ名前とリンクは1件。通ったジョブ・飛ばしたジョブは入れない）
      now += PR_CI_READ_INTERVAL_MS;
      state.checks = [workflow("failure")];
      state.jobs = [
        job("test", "failure", "https://github.com/acme/app/actions/runs/1/job/2"),
        job("test", "failure", "https://github.com/acme/app/actions/runs/1/job/2"),
        job("lint", "success"),
        job("deploy", "skipped"),
        job("x".repeat(300), "timed_out", "javascript:alert(1)"),
        job("😀".repeat(150), "failure"),
      ];
      await service.checkPullRequests();
      expect(ciTypes(service, id)).toEqual(["PullRequestCiFailed"]);
      const failed = service.get(id)?.task;
      expect(failed && pullRequestCiFailure(failed)).toMatchObject({
        number: 7,
        commit,
        head: commit,
        checks: [
          { name: "CI", url: "https://github.com/acme/app/actions/runs/1" },
          { name: "test", url: "https://github.com/acme/app/actions/runs/1/job/2" },
          // 長い名前は切り詰め（絵文字の途中では切らない）、http(s) でないリンクは残さない
          { name: `${"x".repeat(199)}…` },
          { name: `${"😀".repeat(99)}…` },
        ],
      });
      expect(failed?.status).toBe("awaiting_approval");
      // 何も始めない（実行も、PR の更新も無い）
      expect(executor.calls).toHaveLength(runs);
      expect(types(service, id).slice(before.length)).toEqual(["PullRequestCiFailed"]);
      expect(repos.published).toHaveLength(1);
      expect(pulls.calls).toHaveLength(1);

      // 記録した後も、間隔ごとに読む（PBI-375）。落ちたままなら、同じ先頭の失敗は記録し直さない
      const reads = state.read.length;
      await service.checkPullRequests();
      expect(state.read).toHaveLength(reads);
      now += PR_CI_READ_INTERVAL_MS;
      await service.checkPullRequests();
      expect(state.read).toHaveLength(reads + 1);
      expect(ciTypes(service, id)).toEqual(["PullRequestCiFailed"]);
      // 再起動しても、記録は残る。読み直しても、同じ先頭の失敗は記録し直さない
      const { service: restarted } = makeService(activity, [], { pulls, ci, now: () => now });
      await restarted.checkPullRequests();
      expect(state.read).toHaveLength(reads + 2);
      expect(ciTypes(restarted, id)).toEqual(["PullRequestCiFailed"]);
      const replayed = restarted.get(id)?.task;
      expect(replayed && pullRequestCiFailure(replayed)).toMatchObject({ number: 7 });
      activity.close();
    });

    describe("失敗を出した後、読んでいる間に CI が通ったら、表示を消す（PBI-375）", () => {
      const recoveryTypes = (service: TaskService, id: string) =>
        types(service, id).filter((t) => t.startsWith("PullRequestCi"));
      /** 人の承認を待つ実装の PR の CI を、最初の読み取りで失敗にして、失敗を記録させる。 */
      const failedGate = async () => {
        const pulls = new FakePulls();
        const { ci, state } = fakeCi();
        const clock = { now: Date.parse("2026-11-17T00:00:00Z") };
        const made = await toImplementGate([], { pulls, ci, now: () => clock.now });
        const commit = made.service.get(made.id)?.task.pullRequest?.commit ?? "";
        pulls.state = { state: "open", headSha: commit };
        state.checks = [workflow("failure")];
        state.jobs = [job("test", "failure")];
        await made.service.checkPullRequests();
        expect(recoveryTypes(made.service, made.id)).toEqual(["PullRequestCiFailed"]);
        return { ...made, pulls, ci, state, clock, commit };
      };

      it("同じ先頭の CI がすべて通ったら、表示を消して記録し、その先頭は読むのをやめる。実行も PR の更新も始めない", async () => {
        const { activity, service, executor, repos, id, pulls, ci, state, clock, commit } =
          await failedGate();
        const runs = executor.calls.length;
        const before = types(service, id);
        // 再実行の途中（実行中）は、消さない
        clock.now += PR_CI_READ_INTERVAL_MS;
        state.checks = [workflow()];
        state.jobs = [];
        await service.checkPullRequests();
        expect(recoveryTypes(service, id)).toEqual(["PullRequestCiFailed"]);
        // 通った（実行されなかったジョブ・中立のチェックは、妨げにしない）：表示を消して、記録する
        clock.now += PR_CI_READ_INTERVAL_MS;
        state.checks = [workflow("success"), job("codecov", "neutral")];
        state.jobs = [job("test", "success"), job("deploy", "skipped")];
        await service.checkPullRequests();
        expect(recoveryTypes(service, id)).toEqual([
          "PullRequestCiFailed",
          "PullRequestCiRecovered",
        ]);
        const recovered = service
          .get(id)
          ?.activity.find((event) => event.type === "PullRequestCiRecovered");
        expect(recovered).toMatchObject({ actor: "sacty", payload: { number: 7, commit } });
        const task = service.get(id)?.task;
        expect(task && pullRequestCiFailure(task)).toBeUndefined();
        expect(task?.pullRequestCiFailure).toBeUndefined();
        expect(task?.status).toBe("awaiting_approval");
        // 何も始めない（実行も、PR の更新も無い）
        expect(executor.calls).toHaveLength(runs);
        expect(types(service, id).slice(before.length)).toEqual(["PullRequestCiRecovered"]);
        expect(repos.published).toHaveLength(1);
        expect(pulls.calls).toHaveLength(1);
        // 消した先頭は、もう読まない（その後に落ちても、出し直さない）
        const reads = state.read.length;
        clock.now += 24 * 60 * 60_000;
        state.checks = [workflow("failure")];
        await service.checkPullRequests();
        await service.checkPullRequests();
        expect(state.read).toHaveLength(reads);
        expect(recoveryTypes(service, id)).toHaveLength(2);
        // 再起動しても、消えたまま
        state.checks = [workflow("success")];
        const { service: restarted } = makeService(activity, [], {
          pulls,
          ci,
          now: () => clock.now,
        });
        await restarted.checkPullRequests();
        expect(restarted.get(id)?.task.pullRequestCiFailure).toBeUndefined();
        expect(recoveryTypes(restarted, id)).toHaveLength(2);
        activity.close();
      });

      it.each<[string, { checks: CiCheck[]; jobs?: CiCheck[]; truncated?: true }]>([
        ["取り消された CI だけ", { checks: [workflow("cancelled")] }],
        [
          "通ったものと取り消されたもの",
          { checks: [workflow("success")], jobs: [job("e2e", "cancelled")] },
        ],
        ["CI の一覧が空", { checks: [] }],
        [
          "読み切れなかった一覧（読めた分は、すべて成功）",
          { checks: [workflow("success")], truncated: true },
        ],
        ["実行中のものが残る", { checks: [workflow("success"), workflow()] }],
        ["実行されなかったものだけ（成功が1件も無い）", { checks: [workflow("skipped")] }],
        [
          "古い結果（stale）がある",
          { checks: [workflow("success")], jobs: [job("test", "stale")] },
        ],
        [
          "コミットの状態が成功でない",
          {
            checks: [
              workflow("success"),
              { kind: "status", name: "ci/legacy", status: "completed", conclusion: "neutral" },
            ],
          },
        ],
        [
          "結論の無い、終わったチェックがある",
          { checks: [workflow("success"), { kind: "check", name: "x", status: "completed" }] },
        ],
      ])(
        "%sでは、表示を消さず、回数の上限まで間隔ごとに読み直す。上限の後に通っても、消さない",
        async (_name, read) => {
          const { activity, service, id, state, clock } = await failedGate();
          state.checks = read.checks;
          state.jobs = read.jobs ?? [];
          state.truncated = read.truncated;
          for (let i = 0; i < PR_CI_READS_MAX + 5; i++) {
            clock.now += PR_CI_READ_INTERVAL_MS;
            await service.checkPullRequests();
          }
          // 読む回数は、失敗を見つけた回も含めて、先頭のコミットごとの上限のまま
          expect(state.read).toHaveLength(PR_CI_READS_MAX);
          expect(recoveryTypes(service, id)).toEqual(["PullRequestCiFailed"]);
          // 読むのをやめた後に通った CI は、拾わない（表示は残る）
          state.checks = [workflow("success")];
          state.jobs = [];
          state.truncated = undefined;
          clock.now += 24 * 60 * 60_000;
          await service.checkPullRequests();
          expect(state.read).toHaveLength(PR_CI_READS_MAX);
          const task = service.get(id)?.task;
          expect(task && pullRequestCiFailure(task)).toMatchObject({ number: 7 });
          activity.close();
        },
      );

      it("取り消し・空の一覧・読み切れなかった一覧の後でも、回数の上限の前にすべて通れば、表示を消す", async () => {
        const { activity, service, id, state, clock } = await failedGate();
        const steps: { checks: CiCheck[]; truncated?: true }[] = [
          { checks: [workflow("cancelled")] },
          { checks: [] },
          { checks: [workflow("success")], truncated: true },
        ];
        state.jobs = [];
        for (const step of steps) {
          clock.now += PR_CI_READ_INTERVAL_MS;
          state.checks = step.checks;
          state.truncated = step.truncated;
          await service.checkPullRequests();
          expect(recoveryTypes(service, id)).toEqual(["PullRequestCiFailed"]);
        }
        clock.now += PR_CI_READ_INTERVAL_MS;
        state.checks = [workflow("success")];
        state.truncated = undefined;
        await service.checkPullRequests();
        expect(recoveryTypes(service, id)).toEqual([
          "PullRequestCiFailed",
          "PullRequestCiRecovered",
        ]);
        activity.close();
      });

      it("回数の上限の最後の読み取りで失敗を見つけたら、その後は読まない（通っても、表示は残る）", async () => {
        const pulls = new FakePulls();
        const { ci, state } = fakeCi();
        let now = Date.parse("2026-11-17T00:00:00Z");
        const { activity, service, id } = await toImplementGate([], { pulls, ci, now: () => now });
        pulls.state = { state: "open" };
        state.checks = [workflow()];
        for (let i = 0; i < PR_CI_READS_MAX - 1; i++) {
          await service.checkPullRequests();
          now += PR_CI_READ_INTERVAL_MS;
        }
        state.checks = [workflow("failure")];
        await service.checkPullRequests();
        expect(state.read).toHaveLength(PR_CI_READS_MAX);
        expect(recoveryTypes(service, id)).toEqual(["PullRequestCiFailed"]);
        now += PR_CI_READ_INTERVAL_MS;
        state.checks = [workflow("success")];
        await service.checkPullRequests();
        expect(state.read).toHaveLength(PR_CI_READS_MAX);
        expect(recoveryTypes(service, id)).toEqual(["PullRequestCiFailed"]);
        activity.close();
      });

      it("人がコミットを足した新しい先頭の CI がすべて通ったら、前の先頭の失敗の表示を消す（通った先頭を記録する）", async () => {
        const { activity, service, id, pulls, state, clock, commit } = await failedGate();
        // 新しい先頭の CI が実行中の間は、前の先頭の失敗の表示を残す
        pulls.state = { state: "open", headSha: "newhead123" };
        state.checks = [workflow()];
        state.jobs = [];
        await service.checkPullRequests();
        expect(state.read).toEqual([commit, "newhead123"]);
        const waiting = service.get(id)?.task;
        expect(waiting && pullRequestCiFailure(waiting)).toMatchObject({ head: commit });
        // 新しい先頭の CI が通った：表示を消す
        clock.now += PR_CI_READ_INTERVAL_MS;
        state.checks = [workflow("success")];
        await service.checkPullRequests();
        expect(recoveryTypes(service, id)).toEqual([
          "PullRequestCiFailed",
          "PullRequestCiRecovered",
        ]);
        const recovered = service
          .get(id)
          ?.activity.find((event) => event.type === "PullRequestCiRecovered");
        expect(recovered).toMatchObject({ payload: { number: 7, commit: "newhead123" } });
        expect(service.get(id)?.task.pullRequestCiFailure).toBeUndefined();
        activity.close();
      });

      it("読んでいる間に PR がマージされたら、通っていても、消したことを記録しない", async () => {
        const { activity, service, id, pulls, state, clock, commit } = await failedGate();
        clock.now += PR_CI_READ_INTERVAL_MS;
        state.checks = [workflow("success")];
        state.jobs = [];
        // CI を読んでいる間に、人のマージを検出する
        state.during = async () => {
          state.during = undefined;
          pulls.state = { state: "merged", mergedBy: "reviewer", headSha: commit };
          await service.checkPullRequests();
        };
        await service.checkPullRequests();
        expect(service.get(id)?.task.pullRequestState).toBe("merged");
        expect(recoveryTypes(service, id)).toEqual(["PullRequestCiFailed"]);
        activity.close();
      });
    });

    it("失敗したチェックが多いときは、上限までと、残りの件数を持つ", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      const { activity, service, id } = await toImplementGate([], { pulls, ci });
      pulls.state = { state: "open" };
      state.checks = [workflow("failure")];
      state.jobs = Array.from({ length: PR_CI_FAILED_CHECKS_MAX + 2 }, (_, i) =>
        job(`job-${i}`, "failure"),
      );
      await service.checkPullRequests();
      const task = service.get(id)?.task;
      const failure = task && pullRequestCiFailure(task);
      expect(failure?.checks).toHaveLength(PR_CI_FAILED_CHECKS_MAX);
      // ワークフロー1件 + ジョブ12件 = 13件のうち、10件を持ち、残りは件数
      expect(failure?.more).toBe(3);
      activity.close();
    });

    it("すべて終わって失敗が無い先頭は、最初に読んでから間隔がたった後の読み取りで、読むのをやめる（最初の読み取りでは、やめない。PBI-381）", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      let now = Date.parse("2026-11-17T00:00:00Z");
      const { activity, service, id } = await toImplementGate([], { pulls, ci, now: () => now });
      pulls.state = { state: "open" };
      state.checks = [workflow("success")];
      // 最初の読み取りでは、読み終わりにしない（間隔の前は、読まない）
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(state.read).toHaveLength(1);
      // 間隔の後に読んで、失敗が無ければ、読み終わりにする
      now += PR_CI_READ_INTERVAL_MS;
      await service.checkPullRequests();
      expect(state.read).toHaveLength(2);
      state.checks = [workflow("failure")];
      now += 24 * 60 * 60_000;
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(state.read).toHaveLength(2);
      expect(ciTypes(service, id)).toEqual([]);
      // 再起動の後も、最初の読み取りでは読み終わりにせず、間隔の後に読んで、落ちていたら記録する
      state.checks = [workflow("success")];
      const { service: restarted } = makeService(activity, [], { pulls, ci, now: () => now });
      await restarted.checkPullRequests();
      expect(state.read).toHaveLength(3);
      state.checks = [workflow("failure")];
      now += PR_CI_READ_INTERVAL_MS;
      await restarted.checkPullRequests();
      expect(state.read).toHaveLength(4);
      expect(ciTypes(restarted, id)).toEqual(["PullRequestCiFailed"]);
      activity.close();
    });

    it("最初の読み取りで失敗が無くても、間隔の後に読んで落ちていたら、記録する（PBI-381）", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      let now = Date.parse("2026-11-17T00:00:00Z");
      const { activity, service, id } = await toImplementGate([], { pulls, ci, now: () => now });
      pulls.state = { state: "open" };
      // 前からある実行（実行されなかったもの・成功）だけが、一覧に載っている
      state.checks = [workflow("skipped"), workflow("success")];
      await service.checkPullRequests();
      expect(ciTypes(service, id)).toEqual([]);
      // 後から一覧に載った実行が、落ちた
      now += PR_CI_READ_INTERVAL_MS;
      state.checks = [workflow("success"), workflow("failure")];
      await service.checkPullRequests();
      expect(ciTypes(service, id)).toEqual(["PullRequestCiFailed"]);
      activity.close();
    });

    it("最初の読み取りで失敗の表示を消しても、読み終わりにせず、間隔の後に読んで落ちていたら、出し直す（PBI-381）", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      let now = Date.parse("2026-11-17T00:00:00Z");
      const { activity, service, id } = await toImplementGate([], { pulls, ci, now: () => now });
      const commit = service.get(id)?.task.pullRequest?.commit ?? "";
      pulls.state = { state: "open", headSha: commit };
      state.checks = [workflow("failure")];
      await service.checkPullRequests();
      // 人がコミットを足した新しい先頭の、最初の読み取りで通っていた：前の先頭の失敗の表示は消す
      now += PR_CI_READ_INTERVAL_MS;
      pulls.state = { state: "open", headSha: "newhead123" };
      state.checks = [workflow("success")];
      await service.checkPullRequests();
      expect(service.get(id)?.task.pullRequestCiFailure).toBeUndefined();
      // 読み終わりにはしていないので、間隔の後に読んで、落ちていたら、新しい先頭で出す
      now += PR_CI_READ_INTERVAL_MS;
      state.checks = [workflow("success"), workflow("failure")];
      await service.checkPullRequests();
      expect(state.read).toEqual([commit, "newhead123", "newhead123"]);
      const task = service.get(id)?.task;
      expect(task && pullRequestCiFailure(task)).toMatchObject({ head: "newhead123" });
      activity.close();
    });

    it("閉じて開き直した PR では、同じ先頭の CI を読み直し、落ちていたら、出し直す", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      const { activity, service, id } = await toImplementGate([], { pulls, ci });
      const commit = service.get(id)?.task.pullRequest?.commit ?? "";
      state.checks = [workflow("failure")];
      pulls.state = { state: "open", headSha: commit };
      await service.checkPullRequests();
      expect(ciTypes(service, id)).toHaveLength(1);
      // 閉じたら、表示を消し、読んだ回数を忘れる
      pulls.state = { state: "closed" };
      await service.checkPullRequests();
      let task = service.get(id)?.task;
      expect(task && pullRequestCiFailure(task)).toBeUndefined();
      // 開き直したら、間隔を待たずに読み直し、同じ先頭の失敗を出し直す
      pulls.state = { state: "open", headSha: commit };
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(state.read).toEqual([commit, commit]);
      expect(ciTypes(service, id)).toHaveLength(2);
      task = service.get(id)?.task;
      expect(task && pullRequestCiFailure(task)).toMatchObject({ head: commit, commit });
      activity.close();
    });

    it.each([
      ["実行中のまま", true],
      ["CI が1つも無いまま", false],
    ])("%sなら、間隔ごとに読み、決まった回数で読むのをやめる", async (_name, pending) => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      let now = Date.parse("2026-11-17T00:00:00Z");
      const { activity, service, id } = await toImplementGate([], { pulls, ci, now: () => now });
      pulls.state = { state: "open" };
      state.checks = pending ? [workflow()] : [];
      for (let i = 0; i < PR_CI_READS_MAX + 5; i++) {
        await service.checkPullRequests();
        now += PR_CI_READ_INTERVAL_MS;
      }
      expect(state.read).toHaveLength(PR_CI_READS_MAX);
      expect(ciTypes(service, id)).toEqual([]);
      activity.close();
    });

    it("PR の状態を一時的に読めない確認があっても、読んだ回数と間隔を数え直さない", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      let now = Date.parse("2026-11-17T00:00:00Z");
      const { activity, service, id } = await toImplementGate([], { pulls, ci, now: () => now });
      pulls.state = { state: "open" };
      state.checks = [workflow()];
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // 間隔ごとに読む途中で、PR の状態を読めない確認（このタスクが、その確認の候補に入らない）をはさむ
      for (let i = 0; i < PR_CI_READS_MAX + 5; i++) {
        await service.checkPullRequests();
        pulls.statusFail = "network";
        await service.checkPullRequests();
        pulls.statusFail = undefined;
        // 読めなかった確認の直後も、間隔の前なので読まない
        await service.checkPullRequests();
        now += PR_CI_READ_INTERVAL_MS;
      }
      // 回数の上限は、先頭のコミットごとのまま
      expect(state.read).toHaveLength(PR_CI_READS_MAX);
      expect(ciTypes(service, id)).toEqual([]);
      warn.mockRestore();
      activity.close();
    });

    it("CI を読めないときも1回と数え、記録せず、マージの検出を止めない", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      const { activity, service, id } = await toImplementGate([], { pulls, ci });
      pulls.state = { state: "open" };
      state.fail = new Error("GitHub に接続できません ghp_secret");
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await service.checkPullRequests();
      expect(ciTypes(service, id)).toEqual([]);
      // 理由はログに出し、トークンは伏せる
      expect(warn.mock.calls.flat().join("\n")).toContain("CI を読めませんでした");
      expect(warn.mock.calls.flat().join("\n")).not.toContain("ghp_secret");
      // 間隔の前は、読み直さない
      await service.checkPullRequests();
      expect(state.read).toHaveLength(1);
      // 読めないままでも、人のマージは承認として完了する
      const commit = service.get(id)?.task.pullRequest?.commit;
      pulls.state = { state: "merged", mergedBy: "reviewer", headSha: commit };
      await service.checkPullRequests();
      const task = service.get(id)?.task;
      expect(task?.pullRequestState).toBe("merged");
      expect(task && isCompleted(task)).toBe(true);
      warn.mockRestore();
      activity.close();
    });

    it("1回の PR の確認で読むのは1件だけで、前の読み取りが終わるまでは、次を読まない。読む番は、タスクの間で回す", async () => {
      const pulls = new FakePulls();
      let gates: PromiseWithResolvers<void>[] = [];
      let started = 0;
      let hang = true;
      const ci: CiStatusReader = {
        snapshot: async () => {
          started++;
          if (hang) {
            const gate = Promise.withResolvers<void>();
            gates.push(gate);
            await gate.promise;
          }
          return { checks: [workflow()], failedRuns: [] };
        },
        failures: async () => [],
        rerunFailedJobs: async () => {},
        repositoryHasNoCi: async () => false,
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      // 同じ台帳に、人の承認を待つ実装の PR のタスクを3件作る（最後のサービスが、3件すべてを見守る）
      const made = [];
      for (let i = 0; i < 3; i++) {
        made.push(await toImplementGate([], { pulls, ci, reviewCiTimeoutMs: 20 }));
      }
      const service = made.at(-1)?.service as TaskService;
      pulls.state = { state: "open" };
      // 答えが返らない：1件だけ読み始め、時間切れで確認を終える。通信が終わるまでは、次を読まない
      await service.checkPullRequests();
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(started).toBe(1);
      // 終わったら、次の確認から、1回の確認に1件ずつ、まだ読んでいないタスクを読む
      hang = false;
      for (const gate of gates) gate.resolve();
      await Promise.all(gates.map((gate) => gate.promise));
      await new Promise((resolve) => setImmediate(resolve));
      gates = [];
      await service.checkPullRequests();
      expect(started).toBe(2);
      await service.checkPullRequests();
      expect(started).toBe(3);
      // 3件とも読んだ後は、間隔の前なので読まない
      await service.checkPullRequests();
      expect(started).toBe(3);
      warn.mockRestore();
      for (const m of made) m.activity.close();
    });

    it("レビューの子タスクの指摘なしを待つ PR は、読まない", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      state.checks = [workflow("failure")];
      const { activity, service, id } = await toImplementGate([], {
        pulls,
        ci,
        draftPullRequests: true,
      });
      expect(service.get(id)?.task.pullRequest?.awaitingReview).toBe(true);
      pulls.state = { state: "open", draft: true };
      await service.checkPullRequests();
      expect(state.read).toEqual([]);
      expect(ciTypes(service, id)).toEqual([]);
      activity.close();
    });

    it("GitHub の先頭を読めなかった（空）ときは、提出のコミットの CI を読む", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      const { activity, service, id } = await toImplementGate([], { pulls, ci });
      const commit = service.get(id)?.task.pullRequest?.commit ?? "";
      state.checks = [workflow("failure")];
      pulls.state = { state: "open", headSha: "" };
      await service.checkPullRequests();
      expect(state.read).toEqual([commit]);
      const task = service.get(id)?.task;
      expect(task && pullRequestCiFailure(task)).toMatchObject({ head: commit, commit });
      activity.close();
    });

    it("人がコミットを足して先頭が変わったら、新しい先頭の CI を読む。PR が閉じられたら、表示を消す", async () => {
      const pulls = new FakePulls();
      const { ci, state } = fakeCi();
      const { activity, service, id } = await toImplementGate([], { pulls, ci });
      const commit = service.get(id)?.task.pullRequest?.commit ?? "";
      state.checks = [workflow("failure")];
      pulls.state = { state: "open", headSha: commit };
      await service.checkPullRequests();
      // 新しい先頭でも落ちていたら、その先頭で記録し直す
      pulls.state = { state: "open", headSha: "newhead123" };
      await service.checkPullRequests();
      expect(state.read).toEqual([commit, "newhead123"]);
      expect(ciTypes(service, id)).toHaveLength(2);
      let task = service.get(id)?.task;
      expect(task && pullRequestCiFailure(task)).toMatchObject({ head: "newhead123", commit });
      pulls.state = { state: "closed" };
      await service.checkPullRequests();
      task = service.get(id)?.task;
      expect(task && pullRequestCiFailure(task)).toBeUndefined();
      activity.close();
    });
  });

  describe("実装の承認待ちの間に PR がベースブランチと競合したら、画面に出す（取り込まない）", () => {
    const conflictTypes = (service: TaskService, id: string) =>
      types(service, id).filter(
        (t) => t.startsWith("PullRequestConflict") || t === "PullRequestConflicted",
      );

    it("GitHub の mergeable が競合を示したら一度だけ記録し、解消されたら記録して消す。実行も取り込みも始めない", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, repos, id } = await toImplementGate([], { pulls });
      const runs = executor.calls.length;
      const before = types(service, id);
      // 競合していなければ、何も記録しない
      pulls.state = { state: "open", mergeable: true };
      await service.checkPullRequests();
      expect(conflictTypes(service, id)).toEqual([]);

      pulls.state = { state: "open", mergeable: false };
      await service.checkPullRequests();
      await service.checkPullRequests(); // 同じ状態は二重に記録しない
      expect(conflictTypes(service, id)).toEqual(["PullRequestConflicted"]);
      const conflicted = service.get(id)?.task;
      expect(conflicted && pullRequestConflict(conflicted)).toMatchObject({ number: 7 });
      expect(conflicted?.status).toBe("awaiting_approval");
      // 自動で取り込まない・費用のかかる処理を走らせない（実行も、ベースブランチの取り込みも、PR の更新も無い）
      expect(executor.calls).toHaveLength(runs);
      expect(types(service, id).slice(before.length)).toEqual(["PullRequestConflicted"]);
      expect(conflicted?.baseMerge).toBeUndefined();
      expect(repos.published).toHaveLength(1);

      // 解消された（人が GitHub で直した・ベースブランチが戻った）ら、記録して消す
      pulls.state = { state: "open", mergeable: true };
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(conflictTypes(service, id)).toEqual([
        "PullRequestConflicted",
        "PullRequestConflictResolved",
      ]);
      const resolved = service.get(id)?.task;
      expect(resolved && pullRequestConflict(resolved)).toBeUndefined();

      // また競合したら、また出す
      pulls.state = { state: "open", mergeable: false };
      await service.checkPullRequests();
      expect(conflictTypes(service, id)).toHaveLength(3);
      activity.close();
    });

    it("GitHub が mergeable を計算中（分からない）の間と、状態を読めない間は、前の記録のままにする", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([], { pulls });
      // 計算中（mergeable が無い）なら、競合していない PR に何も記録しない
      pulls.state = { state: "open" };
      await service.checkPullRequests();
      expect(conflictTypes(service, id)).toEqual([]);

      pulls.state = { state: "open", mergeable: false };
      await service.checkPullRequests();
      // 計算中に戻っても、競合の表示を消さない（ちらつかせない）
      pulls.state = { state: "open" };
      await service.checkPullRequests();
      expect(conflictTypes(service, id)).toEqual(["PullRequestConflicted"]);
      // 読めなくても同じ
      pulls.statusFail = "network";
      await service.checkPullRequests();
      pulls.statusFail = undefined;
      expect(conflictTypes(service, id)).toEqual(["PullRequestConflicted"]);
      const task = service.get(id)?.task;
      expect(task && pullRequestConflict(task)).toBeDefined();
      activity.close();
    });

    it("競合のまま PR が閉じられたら競合の表示を消し、開き直されて競合のままなら、また出す。マージされたら完了する", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate([], { pulls });
      pulls.state = { state: "open", mergeable: false };
      await service.checkPullRequests();
      pulls.state = { state: "closed" };
      await service.checkPullRequests();
      let task = service.get(id)?.task;
      expect(task?.pullRequestState).toBe("closed");
      expect(task && pullRequestConflict(task)).toBeUndefined();
      // 開き直した次の確認で、競合のままなら出し直す
      pulls.state = { state: "open", mergeable: false };
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(conflictTypes(service, id)).toEqual([
        "PullRequestConflicted",
        "PullRequestConflicted",
      ]);
      task = service.get(id)?.task;
      expect(task && pullRequestConflict(task)).toBeDefined();
      // 競合のまま人がマージしたら（GitHub が許す設定なら）、通常どおり承認として完了する
      const commit = task?.pullRequest?.commit;
      pulls.state = { state: "merged", mergedBy: "reviewer", headSha: commit };
      await service.checkPullRequests();
      task = service.get(id)?.task;
      expect(task?.pullRequestState).toBe("merged");
      expect(task && pullRequestConflict(task)).toBeUndefined();
      activity.close();
    });

    it("差し戻して実装をやり直し、PR を更新すると、古い競合の記録は消える（次の確認で確かめ直す）", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate(
        [
          out(
            [
              "# 実装の説明 v2",
              block({
                "sacty-test-map": [
                  { viewpointId: "TV-1", tests: ["a"] },
                  { viewpointId: "TV-2", tests: ["b"] },
                ],
              }),
              block({
                "sacty-responses": [
                  { remarkId: "implement-1-1", text: "ベースブランチを取り込んだ" },
                ],
              }),
            ].join("\n\n"),
          ),
        ],
        { pulls },
      );
      pulls.state = { state: "open", mergeable: false };
      await service.checkPullRequests();
      expect(service.get(id)?.task.pullRequestConflict).toBeDefined();
      service.requestChanges(id, {
        step: "implement",
        submission: 1,
        target: "implement",
        comments: ["ベースブランチを取り込んで直して"],
      });
      await drain(service);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("awaiting_approval");
      expect(task?.gate).toEqual({ step: "implement", submission: 2 });
      expect(task?.pullRequestConflict).toBeUndefined();
      // 取り込んで直した PR は、GitHub が競合なしと答える
      pulls.state = { state: "open", mergeable: true };
      await service.checkPullRequests();
      expect(conflictTypes(service, id)).toEqual(["PullRequestConflicted"]);
      activity.close();
    });
  });

  it("実装の承認待ちで差し戻すと、実装をやり直して同じPRを更新する。最終レビューをしないので見逃しは記録しない（PBI-10b・PBI-336）", async () => {
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
      cause: "guardian_missed",
      comments: ["失敗時のログが無い"],
    });
    expect(sent.status).toBe("queued");
    expect(sent.steps.map((st) => st.state)).toEqual(["done", "done", "active"]);
    expect(sent.remarks.at(-1)).toMatchObject({ id: "implement-1-1", step: "implement" });
    expect(sent.misses).toEqual([]);
    expect(types(service, id).slice(-2)).toEqual(["StepSubmitted", "ChangesRequested"]);

    await drain(service);
    const prompt = promptOf(executor, 4);
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

  describe("人が sacty の PR に手を入れた後の更新（PBI-334）", () => {
    /** 差し戻した実装のやり直し（PBI-10b のテストと同じ）。 */
    const rework = (): AgentOutcome[] => [
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
    ];
    const sendBack = (service: TaskService, id: string) =>
      service.requestChanges(id, {
        step: "implement",
        submission: 1,
        comments: ["失敗時のログが無い"],
      });
    const eventsOf = (service: TaskService, id: string, type: string) =>
      (service.get(id)?.activity ?? []).filter((e) => e.type === type);

    it("実装前と提出前の PR の取り込みを整形の出し直しに含めない", async () => {
      const { activity, service, repos, pulls, id } = await toImplementGate(rework());
      const pushed = service.get(id)?.task.pushedBranch;
      if (!pushed) throw new Error("no pushed branch");
      const firstHead = "d".repeat(40);
      const secondHead = "e".repeat(40);
      const firstTree = "a".repeat(40);
      const secondTree = "b".repeat(40);
      const change = (path: string) => ({
        status: "M",
        path,
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      });
      repos.treeDiffs.set(`${repos.tree}:${firstTree}`, [change("p.ts")]);
      repos.treeDiffs.set(`${firstTree}:${secondTree}`, [change("q.ts")]);
      repos.treeBlobs.set("old", "const x={a:1};");
      repos.treeBlobs.set("new", "const x = { a: 1, };");
      const merge = repos.mergeBase.bind(repos);
      vi.spyOn(repos, "mergeBase").mockImplementation(async (input) => {
        const result = await merge(input);
        if (input.target === firstHead) repos.tree = firstTree;
        if (input.target === secondHead) repos.tree = secondTree;
        return result;
      });
      repos.remote[pushed.branch] = firstHead;
      sendBack(service, id);
      await service.runNext(id);
      const started = (service.get(id)?.activity ?? []).findLast(
        (event) => event.type === "AgentRunStarted" && event.payload.step === "implement",
      );
      expect(started?.payload).toMatchObject({ formattingBaseline: { tree: firstTree } });
      repos.remote[pushed.branch] = secondHead;
      await drain(service);
      expect(eventsOf(service, id, "FormattingOnlyRejected")).toEqual([]);
      expect(repos.tree).toBe(secondTree);
      expect(repos.published.at(-1)).toMatchObject({ parent: secondHead });
      expect(pulls.calls.at(-1)?.number).toBe(7);
      activity.close();
    });

    it("出し直しの間の PR とベースの取り込みを別々に記録し、両方で変わったファイルを除外する", async () => {
      const repos = new FakeRepos();
      repos.branchHead = repos.head;
      const base = repos.tree;
      const before = "a".repeat(40);
      const middle = "b".repeat(40);
      const after = "c".repeat(40);
      const human = "d".repeat(40);
      const tip = "e".repeat(40);
      const change = (path: string) => ({
        status: "M",
        path,
        oldMode: "100644",
        newMode: "100644",
        oldObject: "old",
        newObject: "new",
      });
      repos.treeDiffs.set(`${base}:${after}`, [change("a.ts"), change("r.ts"), change("s.ts")]);
      repos.treeDiffs.set(`${before}:${middle}`, [change("r.ts")]);
      repos.treeDiffs.set(`${middle}:${after}`, [change("s.ts")]);
      repos.treeBlobs.set("old", "const x={a:1};");
      repos.treeBlobs.set("new", "const x = { a: 1, };");
      const unfinished = out(
        [
          implement("# 未完了").output,
          `\`\`\`sacty-completion\n${JSON.stringify({ status: "incomplete", remaining: ["続き"] })}\n\`\`\``,
        ].join("\n\n"),
      );
      const { activity, service, executor, id } = await toImplementGate(
        [unfinished, implement("# 完了"), implement("# 整形の修正")],
        { repos, mergeBase: true },
      );
      const pushed = service.get(id)?.task.pushedBranch;
      if (!pushed) throw new Error("no pushed branch");
      sendBack(service, id);
      await service.runNext(id);
      repos.tree = before;
      await service.runNext(id);
      repos.remote[pushed.branch] = human;
      repos.branchHead = tip;
      const original = repos.mergeBase.bind(repos);
      vi.spyOn(repos, "mergeBase").mockImplementation(async (input) => {
        const result = await original(input);
        if (input.target === human) {
          repos.tree = middle;
          writeFileSync(join(input.dir, "r.ts"), "human merge content\n");
        }
        if (input.target === tip) {
          repos.tree = after;
          writeFileSync(join(input.dir, "s.ts"), "base merge content\n");
        }
        return result;
      });
      let publishedFiles: string[] = [];
      const publish = repos.publish.bind(repos);
      vi.spyOn(repos, "publish").mockImplementation(async (input) => {
        const work = repos.prepared.at(-1)?.dir;
        if (!work) throw new Error("workspace missing");
        publishedFiles = ["r.ts", "s.ts"].map((path) => readFileSync(join(work, path), "utf8"));
        return publish(input);
      });
      await service.runNext(id);
      const starts = (service.get(id)?.activity ?? []).filter(
        (event) => event.type === "AgentRunStarted" && event.payload.step === "implement",
      );
      expect(starts.at(-1)?.payload).toMatchObject({
        formattingBaseline: {
          tree: base,
          merged: [
            { before, after: middle },
            { before: middle, after },
          ],
        },
      });
      await service.runNext(id);
      expect(eventsOf(service, id, "FormattingOnlyRejected").at(-1)?.payload).toEqual({ count: 1 });
      await service.runNext(id);
      const prompt = promptOf(executor, executor.calls.length - 1);
      expect(prompt).toContain("- a.ts");
      expect(prompt).not.toContain("- r.ts");
      expect(prompt).not.toContain("- s.ts");
      const finalTree = "f".repeat(40);
      repos.treeDiffs.set(`${base}:${finalTree}`, [change("r.ts"), change("s.ts")]);
      repos.tree = finalTree;
      await drain(service);
      expect(repos.published.at(-1)).toBeDefined();
      expect(publishedFiles).toEqual(["human merge content\n", "base merge content\n"]);
      activity.close();
    });

    it("人が PR のブランチに足したコミットを、実装のやり直しの前に作業領域に取り込み、その先頭に積んで同じ PR を更新する（強制プッシュしない）", async () => {
      const { activity, service, executor, repos, pulls, id } = await toImplementGate(rework());
      const pushed = service.get(id)?.task.pushedBranch;
      expect(pushed).toBeDefined();
      if (!pushed) return;
      // 人がレビューの提案を適用して、PR のブランチにコミットを足した
      const human = "d".repeat(40);
      repos.remote[pushed.branch] = human;
      sendBack(service, id);
      await drain(service);
      // sacty が最後にプッシュしたコミットを共通の祖先にして、人の先頭を取り込む
      expect(repos.merges).toContainEqual(
        expect.objectContaining({ base: pushed.commit, target: human }),
      );
      expect(eventsOf(service, id, "PullRequestHeadMerged").map((e) => e.payload)).toEqual([
        { branch: pushed.branch, from: pushed.commit, commit: human, conflicts: [] },
      ]);
      // 実装のやり直しに、人の変更を消さないことを伝える
      expect(promptOf(executor, 4)).toContain("--- 人が PR に足したコミット ---");
      expect(promptOf(executor, 4)).toContain(human.slice(0, 7));
      // 人の先頭を親にして積み、同じ PR を更新する
      expect(repos.published[1]).toMatchObject({ parent: human, branch: pushed.branch });
      expect(pulls.calls[1]?.number).toBe(7);
      const task = service.get(id)?.task;
      expect(task?.gate).toEqual({ step: "implement", submission: 2 });
      // 提出した後は、取り込みは済んでいる（次の指示に出さない）
      expect(task && pendingHeadMerge(task)).toBeUndefined();
      activity.close();
    });

    it("取り込んだ先頭に積んで出した後のやり直しでも、人の変更を消さない指示を実装に渡す", async () => {
      const { activity, service, executor, repos, id } = await toImplementGate([
        ...rework(),
        ...rework(),
      ]);
      const pushed = service.get(id)?.task.pushedBranch;
      if (!pushed) throw new Error("no pushed branch");
      repos.remote[pushed.branch] = "d".repeat(40);
      sendBack(service, id);
      await drain(service);
      // 人の先頭に積んで出したので、まだ提出していない取り込みは無い
      const task = service.get(id)?.task;
      expect(task && pendingHeadMerge(task)).toBeUndefined();
      service.requestChanges(id, {
        step: "implement",
        submission: 2,
        comments: ["もう一度直して"],
      });
      await drain(service);
      const prompt = promptOf(executor, 5);
      expect(prompt).toContain("あなたはソフトウェア開発の工程エージェントです。");
      expect(prompt).toContain("--- 人が PR に足したコミット ---");
      expect(prompt).toContain("人が足した変更は、人の判断で入れたものです");
      activity.close();
    });

    it("PR を出す直前に PR のブランチを読む間に一時停止を求められたら、プッシュも PR の更新もしない", async () => {
      const repos = new FakeRepos();
      let service: TaskService | undefined;
      let taskId = "";
      let armed = false;
      let paused = false;
      // 実装の実行の後の、PR のブランチの読み取りの回数（1回目は PR を出す前の取り込み、2回目は PR を出す直前の取り込み）
      let reads = 0;
      const fetch = repos.fetchBranch.bind(repos);
      repos.fetchBranch = async (gitDir, branch, authEnv) => {
        if (armed && branch !== "main") reads += 1;
        if (reads === 2 && !paused && service) {
          paused = true;
          void service.pause(taskId);
        }
        return fetch(gitDir, branch, authEnv);
      };
      const made = await toImplementGate(rework(), { repos });
      service = made.service;
      taskId = made.id;
      sendBack(made.service, made.id);
      // PR を出す直前の取り込みで、PR のブランチを読む間に一時停止を求める
      const runs = made.executor.calls.length;
      const run = made.executor.run.bind(made.executor);
      made.executor.run = async (input) => {
        const result = await run(input);
        if (made.executor.calls.length > runs) armed = true;
        return result;
      };
      await drain(made.service);
      expect(paused).toBe(true);
      expect(repos.published).toHaveLength(1);
      expect(made.pulls.calls).toHaveLength(1);
      expect(made.service.get(made.id)?.task.status).toBe("paused");
      made.activity.close();
    });

    it("人の先頭に積んでプッシュした後、PR の更新に失敗して再開したら、プッシュ済みのコミットに積む（前の PR のコミットに戻さない）", async () => {
      const { activity, service, repos, pulls, id } = await toImplementGate(rework());
      const pushed = service.get(id)?.task.pushedBranch;
      if (!pushed) throw new Error("no pushed branch");
      const human = "d".repeat(40);
      repos.remote[pushed.branch] = human;
      pulls.fail = "network";
      sendBack(service, id);
      await drain(service);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(repos.published[1]).toMatchObject({ parent: human });
      const repushed = service.get(id)?.task.pushedBranch?.commit;
      pulls.fail = undefined;
      service.resume(id, {});
      await drain(service);
      // 早送りでプッシュできるよう、プッシュ済みのコミット（人の先頭を親にしたもの）に積む
      expect(repos.published.at(-1)?.parent).toBe(repushed);
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
      activity.close();
    });

    it("人のコミットと競合したら、競合したファイルを、人の側を残して解消するよう実装に渡す", async () => {
      const { activity, service, executor, repos, id } = await toImplementGate(rework());
      const pushed = service.get(id)?.task.pushedBranch;
      if (!pushed) throw new Error("no pushed branch");
      repos.remote[pushed.branch] = "d".repeat(40);
      repos.mergeResult = { status: "conflicted", conflicts: ["src/retry.ts"] };
      sendBack(service, id);
      await drain(service);
      const prompt = promptOf(executor, 4);
      expect(prompt).toContain("- src/retry.ts");
      expect(prompt).toContain("下側（======= と >>>>>>> の間）が人の足した側です");
      // ベースブランチとの競合としては伝えない
      expect(prompt).not.toContain("--- ベースブランチとの競合（解消してください） ---");
      activity.close();
    });

    it("人のコミットが無ければ、取り込まずに前回プッシュしたコミットに積む", async () => {
      const { activity, service, repos, id } = await toImplementGate(rework());
      const pushed = service.get(id)?.task.pushedBranch;
      sendBack(service, id);
      await drain(service);
      expect(eventsOf(service, id, "PullRequestHeadMerged")).toEqual([]);
      expect(repos.merges.filter((m) => m.base === pushed?.commit)).toEqual([]);
      expect(repos.published[1]).toMatchObject({ parent: pushed?.commit });
      activity.close();
    });

    it("人が PR の本文に足した補足は、更新しても残し、sacty の新しい内容も入れる（重ならなければエージェントは使わない）", async () => {
      const { activity, service, executor, pulls, id } = await toImplementGate(rework());
      const first = pulls.calls[0]?.body ?? "";
      // 人が、GitHub の画面で本文の先頭に補足を足した（画面で直した本文は CRLF になる）
      pulls.bodies[7] = `> 人のメモ：リリースノートに載せる\r\n\r\n${first.replace(/\n/g, "\r\n")}`;
      const before = executor.calls.length;
      sendBack(service, id);
      await drain(service);
      // 実行は、実装のやり直しの1回だけ（本文をまとめるエージェントは実行しない）
      expect(executor.calls.length).toBe(before + 1);
      expect(executor.calls.some((_, i) => promptOf(executor, i).includes("githubNow"))).toBe(
        false,
      );
      const updated = pulls.calls[1]?.body ?? "";
      expect(updated.startsWith("> 人のメモ：リリースノートに載せる\n\n")).toBe(true);
      // sacty の更新（新しい head・最後の直し）も入る
      expect(updated).toContain("実装の説明 v2");
      expect(updated).not.toContain("\r");
      expect(eventsOf(service, id, "PullRequestBodyResolved")).toEqual([]);
      // 前回の版としては、sacty が組み立てた本文（人の補足を含まない）を記録する
      const recorded = service.get(id)?.task.pullRequestBodies?.["https://github.com/acme/app#7"];
      expect(recorded).toBeDefined();
      expect(recorded).not.toContain("人のメモ");
      activity.close();
    });

    it.each([
      ["消した", (body: string, id: string) => body.replace(`<!-- sacty task ${id} -->`, "")],
      [
        "別のタスクの ID に書き換えた",
        (body: string, id: string) => body.replace(id, "00000000-0000-4000-8000-000000000000"),
      ],
    ])(
      "人が説明の目印を%s後の更新でも、同じ PR の説明に入り、更新後の説明にタスクの ID の目印が1つだけある（PBI-471）",
      async (_name, edit) => {
        const { activity, service, pulls, id } = await toImplementGate(rework());
        const first = pulls.calls[0]?.body ?? "";
        expect(first.split(`<!-- sacty task ${id} -->`)).toHaveLength(2);
        pulls.bodies[7] = `${edit(first, id)}\n\n> 人のメモ`;
        sendBack(service, id);
        await drain(service);
        // 同じ PR（#7）の説明の更新で、新しい PR を作らない
        expect(pulls.calls[1]).toMatchObject({ number: 7 });
        const updated = pulls.calls[1]?.body ?? "";
        expect(updated.match(/<!-- sacty task [^>]*-->/g)).toEqual([`<!-- sacty task ${id} -->`]);
        expect(updated).toContain("> 人のメモ");
        expect(updated).toContain("実装の説明 v2");
        // Sacty が作った PR として扱われ続ける
        expect(service.get(id)?.task.pullRequest?.number).toBe(7);
        activity.close();
      },
    );

    it("人の直しとマージした本文からも、作業領域へのリンクを外し、外した後に現れる秘密の値を伏せる。人が書いたほかのリンクは変えない（PBI-385）", async () => {
      const { activity, service, executor, pulls, id } = await toImplementGate(rework());
      const first = pulls.calls[0]?.body ?? "";
      // 人が、本文の先頭に補足を足した。作業領域へのリンクと、外すと秘密の値（GitHub のトークン ghp_secret）になる文字がある
      const kept =
        "> 人のメモ：[設計](https://example.com/design) と [相対](docs/a.md) を見ること。";
      pulls.bodies[7] = [
        kept,
        "> [手順](/workspace/docs/setup.md) に沿う。値は ghp_[s](/workspace)ecret です。",
        "",
        first,
      ].join("\n");
      const before = executor.calls.length;
      sendBack(service, id);
      await drain(service);
      // 重ならないので、本文をまとめるエージェントは実行しない
      expect(executor.calls.length).toBe(before + 1);
      const updated = pulls.calls[1]?.body ?? "";
      expect(
        updated.startsWith(
          `${kept}\n> 手順（\`docs/setup.md\`） に沿う。値は [REDACTED] です。\n\n`,
        ),
      ).toBe(true);
      // sacty の更新も入る
      expect(updated).toContain("実装の説明 v2");
      expect(updated).not.toContain("ghp_secret");
      expect(updated).not.toContain("](/workspace");
      expect(updated.length).toBeLessThanOrEqual(PR_BODY_MAX);
      expect(JSON.stringify(service.get(id)?.activity)).not.toContain("ghp_secret");
      activity.close();
    });

    it("マージした本文のリンクを外した後に秘密の値を伏せると長さの上限を超えるときは、外すのをやめて、マージした本文を使う（PBI-385）", async () => {
      // 短い秘密の値（伏せ字より短い）が、人が足したリンク先の文字参照から何度も現れる。伏せると、外して縮んだ分より長くなる
      const secret = "ghx";
      const { activity, service, executor, pulls, id } = await toImplementGate(rework(), {
        github: new FakeGitHub({ me: secret }),
      });
      const first = pulls.calls[0]?.body ?? "";
      const link = `[手順](/workspace/${"gh&#120;".repeat(2_000)})`;
      // マージした本文が、長さの上限の少し手前になるように、人が長い補足を足した
      const filler = "補足。".repeat(
        Math.floor((PR_BODY_MAX - first.length - link.length - 1_000) / 3),
      );
      pulls.bodies[7] = `${link}\n\n${filler}\n\n${first}`;
      const before = executor.calls.length;
      sendBack(service, id);
      await drain(service);
      expect(executor.calls.length).toBe(before + 1);
      const updated = pulls.calls[1]?.body ?? "";
      // マージした本文のまま（リンクは残る）。秘密の値は現れず、上限の中に収まる
      expect(updated.startsWith(`${link}\n\n補足。`)).toBe(true);
      expect(updated).toContain("実装の説明 v2");
      expect(updated).not.toContain(secret);
      expect(updated.length).toBeLessThanOrEqual(PR_BODY_MAX);
      // 外していれば、伏せた後に上限を超えていた（この分岐を通ったことの確認）
      const unlinked = withoutWorkspaceLinks(updated).replaceAll(secret, "[REDACTED]");
      expect(unlinked).not.toBe(updated);
      expect(unlinked.length).toBeGreaterThan(PR_BODY_MAX);
      activity.close();
    });

    it("エージェントがまとめた本文からも、作業領域へのリンクを外し、外した後に現れる秘密の値を伏せる（PBI-385）", async () => {
      const merged = [
        "## まとめた本文",
        "",
        "[手順](/workspace/docs/setup.md) と [設計](https://example.com/design) のとおり。値は ghp_[s](/workspace)ecret です。",
      ].join("\n");
      const { activity, service, pulls, id } = await toImplementGate([
        ...rework(),
        out(`まとめました\n${BODY_BEGIN}\n${merged}\n${BODY_END}`),
      ]);
      pulls.bodies[7] = "人が全部書き直した本文";
      sendBack(service, id);
      await drain(service);
      expect(pulls.calls[1]?.body).toBe(
        [
          "## まとめた本文",
          "",
          "手順（`docs/setup.md`） と [設計](https://example.com/design) のとおり。値は [REDACTED] です。",
          "",
          `<!-- sacty task ${id} -->`,
        ].join("\n"),
      );
      expect(eventsOf(service, id, "PullRequestBodyResolved")).toMatchObject([
        { actor: "orchestrator", payload: { number: 7, outcome: "resolved" } },
      ]);
      expect(JSON.stringify(service.get(id)?.activity)).not.toContain("ghp_secret");
      activity.close();
    });

    it("人の直しとマージした本文の解析が時間の上限までに終わらなければ、マージした本文のまま更新し、ログに残す（PBI-372）", async () => {
      const { activity, service, pulls, id } = await toImplementGate(rework());
      const first = pulls.calls[0]?.body ?? "";
      const note = "> 人のメモ：[手順](/workspace/docs/setup.md) に沿う。";
      pulls.bodies[7] = `${note}\n\n${first}`;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        vi.mocked(unlinkedMergedBody).mockImplementationOnce(async (body) => ({
          body,
          skipped: "timeout",
        }));
        sendBack(service, id);
        await drain(service);
        // PR は更新する。人が書いたリンクは残り、sacty の更新も入る
        const updated = pulls.calls[1]?.body ?? "";
        expect(updated.startsWith(`${note}\n\n`)).toBe(true);
        expect(updated).toContain("実装の説明 v2");
        expect(linksKeptLogs(warn)).toEqual([
          `[daemon] タスク ${id} の PR（https://github.com/acme/app）の本文から、作業領域へのリンクを外せませんでした（解析が 5 秒で終わりませんでした）。本文は、リンクを外さずに使います`,
        ]);
      } finally {
        warn.mockRestore();
      }
      activity.close();
    });

    it("エージェントがまとめた本文の解析に失敗したら、まとめた本文のまま更新し、原因をログに残す（PBI-372）", async () => {
      const merged = "## まとめた本文\n\n[手順](/workspace/docs/setup.md) のとおり。";
      const { activity, service, pulls, id } = await toImplementGate([
        ...rework(),
        out(`まとめました\n${BODY_BEGIN}\n${merged}\n${BODY_END}`),
      ]);
      pulls.bodies[7] = "人が全部書き直した本文";
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        vi.mocked(unlinkedMergedBody).mockImplementationOnce(async (body) => ({
          body,
          skipped: "error",
          cause: "別スレッドが答えずに終了（終了コード 1）",
        }));
        sendBack(service, id);
        await drain(service);
        // まとめた本文の末尾に、タスクの ID の目印を1つ置く（PBI-471）
        expect(pulls.calls[1]?.body).toBe(`${merged}\n\n<!-- sacty task ${id} -->`);
        expect(linksKeptLogs(warn)).toEqual([
          `[daemon] タスク ${id} の PR（https://github.com/acme/app）の本文から、作業領域へのリンクを外せませんでした（解析に失敗しました：別スレッドが答えずに終了（終了コード 1））。本文は、リンクを外さずに使います`,
        ]);
      } finally {
        warn.mockRestore();
      }
      activity.close();
    });

    it("人が直した本文と、sacty の新しい本文が同じ箇所で重なったら、エージェントにまとめさせて、その本文で更新する", async () => {
      const merged = "## まとめた本文\n\n人の書き方で、新しい結果を書いた";
      const { activity, service, executor, pulls, id } = await toImplementGate([
        ...rework(),
        out(`まとめました\n${BODY_BEGIN}\n${merged}\n${BODY_END}`),
      ]);
      // 人が本文を丸ごと書き直した
      pulls.bodies[7] = "人が全部書き直した本文";
      sendBack(service, id);
      await drain(service);
      expect(pulls.calls[1]?.body).toBe(`${merged}\n\n<!-- sacty task ${id} -->`);
      const prompt = promptOf(executor, executor.calls.length - 1);
      expect(prompt).toContain("人が全部書き直した本文");
      expect(prompt).toContain("<<<<<<< github-now");
      expect(eventsOf(service, id, "PullRequestBodyResolved")).toMatchObject([
        { actor: "orchestrator", payload: { number: 7, outcome: "resolved" } },
      ]);
      activity.close();
    });

    it("まとめた本文を読めなければ、人の本文のまま変えず、sacty の前回の版も記録し直さない", async () => {
      const { activity, service, pulls, id } = await toImplementGate([
        ...rework(),
        out("答えの形になっていない"),
      ]);
      const before = service.get(id)?.task.pullRequestBodies?.["https://github.com/acme/app#7"];
      pulls.bodies[7] = "人が全部書き直した本文";
      sendBack(service, id);
      await drain(service);
      // 本文は渡さずに更新する（読んだ時点の本文を書き戻さない）
      expect(pulls.calls[1]).toBeDefined();
      expect(pulls.calls[1]?.body).toBeUndefined();
      expect(pulls.bodies[7]).toBe("人が全部書き直した本文");
      expect(eventsOf(service, id, "PullRequestBodyResolved")).toMatchObject([
        { payload: { number: 7, outcome: "kept" } },
      ]);
      expect(service.get(id)?.task.pullRequestBodies?.["https://github.com/acme/app#7"]).toBe(
        before,
      );
      // PR の更新は止めない（承認待ちに進む）
      expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
      activity.close();
    });

    it("エージェントがまとめる間に人が本文をまた直したら、まとめた本文で上書きせず、本文に触れない", async () => {
      const merged = "## まとめた本文";
      const { activity, service, pulls, id } = await toImplementGate([
        ...rework(),
        out(`${BODY_BEGIN}\n${merged}\n${BODY_END}`),
      ]);
      pulls.bodies[7] = "人が全部書き直した本文";
      // 1回目の読み取り（マージの前）の後に、人がもう一度直した
      pulls.onBodyRead = (reads) => {
        if (reads === 1) pulls.bodies[7] = "人がもう一度直した本文";
      };
      sendBack(service, id);
      await drain(service);
      expect(pulls.calls[1]?.body).toBeUndefined();
      expect(pulls.bodies[7]).toBe("人がもう一度直した本文");
      expect(eventsOf(service, id, "PullRequestBodyResolved")).toMatchObject([
        { payload: { number: 7, outcome: "kept" } },
      ]);
      const resolved = eventsOf(service, id, "PullRequestBodyResolved")[0];
      expect(ja((resolved?.payload as { reason?: unknown } | undefined)?.reason)).toContain(
        "人が PR の本文をまた直した",
      );
      activity.close();
    });

    it("本文をまとめたコンテナが止まったことを確かめられなければ、PR を更新せずに一時停止する", async () => {
      const { activity, service, executor, pulls, id } = await toImplementGate(rework());
      pulls.bodies[7] = "人が全部書き直した本文";
      const run = executor.run.bind(executor);
      executor.run = async (input) => {
        const prompt = input.invocation.stdin ?? input.invocation.command.join(" ");
        if (!prompt.includes("githubNow")) return run(input);
        const error = new AgentTimeoutError(message("run.timeout", { minutes: 3 }));
        error.unconfirmedContainer = "sacty-run-body";
        throw error;
      };
      sendBack(service, id);
      await drain(service);
      const task = service.get(id)?.task;
      expect(task?.status).toBe("paused");
      expect(task?.pausedMessage).toMatchObject({
        code: "orchestrator.failed",
        params: { detail: { code: "run.containerNotConfirmed" } },
      });
      // 止まったことを確かめられなかった実行を記録する（再開・中止の前に、確かめ直す）
      expect(task?.unstoppedRuns).toHaveLength(1);
      expect(pulls.calls).toHaveLength(1);
      activity.close();
    });

    it("今の本文を読めず、PR の更新にも失敗したら、上書きしたとは記録しない", async () => {
      const { activity, service, pulls, id } = await toImplementGate(rework());
      pulls.bodies[7] = "人が全部書き直した本文";
      pulls.bodyFail = "network";
      pulls.fail = "GitHub API 502";
      sendBack(service, id);
      await drain(service);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(pulls.bodies[7]).toBe("人が全部書き直した本文");
      expect(eventsOf(service, id, "PullRequestBodyResolved")).toEqual([]);
      activity.close();
    });

    it("今の本文を読めなければ、これまでどおり sacty の本文で更新する", async () => {
      const { activity, service, pulls, id } = await toImplementGate(rework());
      pulls.bodies[7] = "人が全部書き直した本文";
      pulls.bodyFail = "network";
      sendBack(service, id);
      await drain(service);
      expect(pulls.calls[1]?.body).toContain("実装の説明 v2");
      expect(pulls.calls[1]?.body).not.toContain("人が全部書き直した本文");
      // 人の直しを確かめずに上書きしたことを、作業履歴に残す
      expect(eventsOf(service, id, "PullRequestBodyResolved")).toMatchObject([
        {
          payload: {
            number: 7,
            outcome: "overwritten",
            reason: { code: "pr.bodyReadFailed" },
          },
        },
      ]);
      activity.close();
    });
  });

  it("差し戻しの間に前の PR がマージされたら、新しい PR は作らず、マージを承認として完了する（PBI-14a レビュー指摘・PBI-276）", async () => {
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
    // マージ済みの PR は更新せず、新しい PR も作らない（作り直した内容は捨て、マージを承認とする。PBI-276）
    expect(pulls.calls).toHaveLength(1);
    const task = service.get(id)?.task;
    expect(task?.pullRequest?.number).toBe(7);
    expect(task?.pullRequestState).toBe("merged");
    expect(task?.steps.at(-1)?.state).toBe("done");
    expect(types(service, id).slice(-3)).toEqual([
      "ReworkStoppedByMerge",
      "PullRequestMerged",
      "StepApproved",
    ]);
    activity.close();
  });

  describe("以前の版の最終レビューで止まったタスク（PBI-336）", () => {
    it("検証が続けて通らずに止まったタスクは、人がレビューへ進められ、最終レビューをせずに実装の PR を作って承認待ちにする", async () => {
      const { activity, service, pulls, executor, id } = await toImplement([implement("# 実装 1")]);
      await service.runNext(id); // 実装
      appendLegacy(service, id, [
        {
          actor: "sacty",
          event: {
            type: "TaskPaused",
            payload: {
              reason: "verification",
              message: message("verify.tooManyAttempts", { count: MAX_VERIFY_ATTEMPTS }),
            },
          },
        },
      ]);
      const paused = service.get(id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.pausedReason).toBe("verification");
      const runs = executor.calls.length;
      const moved = service.submitForReview(id);
      expect(moved.status).toBe("queued");
      expect(moved.publishPending).toBe(true);
      await drain(service);
      const gated = service.get(id)?.task;
      expect(gated?.gate).toEqual({ step: "implement", submission: 1 });
      expect(executor.calls.length).toBe(runs);
      expect(pulls.calls).toHaveLength(1);
      const log = service.get(id)?.activity ?? [];
      expect(log.find((e) => e.type === "VerificationOverridden")?.actor).toBe("person");
      expect(types(service, id).slice(-4)).toEqual([
        "BranchPushed",
        "PullRequestBodyWritten",
        "PullRequestPublished",
        "StepSubmitted",
      ]);
      activity.close();
    });

    it("検証が続けて通らずに止まったのではないタスクは、レビューへ進められない", async () => {
      const { activity, service, id } = await toImplement([implement("# 実装の説明")]);
      expect(() => service.submitForReview(id)).toThrow(
        "実装の検証が続けて通らずに止まったタスクではないため",
      );
      await service.runNext(id);
      await service.runNext(id);
      await service.pause(id);
      expect(() => service.submitForReview(id)).toThrow(
        "実装の検証が続けて通らずに止まったタスクではないため",
      );
      activity.close();
    });
  });

  describe("PR へのフィードバックの取り込み（PBI-14b）", () => {
    const rework = (target: string, reason = "理由", cause?: string) =>
      out(
        `\`\`\`json\n${JSON.stringify({ "sacty-rework": { target, ...(cause ? { cause } : {}), reason } })}\n\`\`\``,
      );
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

    it("PR の指摘の差し戻し先の判定（ゴールガーディアン）には、メモリーを渡さない（PR #136 レビュー指摘）", async () => {
      // 前のタスクの監査が登録したメモリーがある
      const layer = join(dir, "memory", "projects", "default");
      mkdirSync(join(layer, "references"), { recursive: true });
      writeFileSync(join(layer, "SKILL.md"), "- [題](references/m1.md)：概要");
      const pulls = new FakePulls();
      const { service, executor } = await toImplementGate([rework("implement", "実装で直せる")], {
        pulls,
        now: later,
        memory: true,
      });
      // 工程（実装）の実行には渡している
      const implementCall = executor.calls.find((c) =>
        c.command.join(" ").includes("--- メモリー ---"),
      );
      expect(implementCall?.mounts?.some((m) => m.containerPath === "/sacty-memory/project")).toBe(
        true,
      );
      pulls.feedbackList = [item("comment:1")];
      const before = executor.calls.length;
      await service.checkPullRequests();
      const judge = executor.calls[before];
      expect(judge?.command.join(" ")).toContain("sacty-rework");
      expect((judge?.mounts ?? []).some((m) => m.containerPath.startsWith("/sacty-memory"))).toBe(
        false,
      );
      expect(judge?.command.join(" ")).not.toContain("--- メモリー ---");
      expect(judge?.command).not.toContain("/sacty-memory/project");
    });

    it("レビュー・行のコメント・通常のコメントを指摘として取り込み、ゴールガーディアンが実装と判断したら差し戻す", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate(
        [rework("implement", "実装で直せる", "guardian_missed")],
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
      // sacty が投稿したレビューを除けるよう、プロジェクトのアカウントを渡して読む（PBI-19）。承認は指摘ではないので含めない
      expect(pulls.feedbackAccounts.at(-1)).toBe("me");
      expect(pulls.feedbackIncludeApprovals.at(-1)).toBeUndefined();
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
      // 最終レビューをしないので、見逃しは記録しない（PBI-336）
      expect(events.slice(-2).map((e) => [e.type, e.actor])).toEqual([
        ["ReworkJudged", "agent"],
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

    it.each([
      ["base_changed", "main と競合しています。解消してください"],
      ["new_request", "文書に1文足してください"],
    ] as const)(
      "指摘の原因が %s なら、見逃しにせず、原因を作業履歴と PR の欄に残す（PBI-268）",
      async (cause, body) => {
        const pulls = new FakePulls();
        const { activity, service, executor, id } = await toImplementGate(
          [rework("implement", "実装で直せる", cause)],
          { pulls, now: later },
        );
        pulls.feedbackList = [item("comment:268", { body })];
        const before = executor.calls.length;
        await service.checkPullRequests();
        const events = service.get(id)?.activity ?? [];
        expect(events.slice(-3).map((e) => [e.type, e.actor])).toEqual([
          ["PullRequestReviewImported", "person"],
          ["ReworkJudged", "agent"],
          ["ChangesRequested", "person"],
        ]);
        expect(events.at(-2)?.payload).toMatchObject({ target: "implement", cause });
        expect(events.at(-1)?.payload).toMatchObject({ step: "implement", cause });
        expect(events.some((e) => e.type === "GuardianMissed")).toBe(false);
        const task = service.get(id)?.task;
        expect(task?.misses).toEqual([]);
        expect(task?.status).toBe("queued");
        expect(task?.prRework).toMatchObject({ target: "implement", decided: true, cause });
        // ゴールガーディアンには、原因も判断させる
        const prompt = promptOf(executor, before);
        expect(prompt).toContain("この指摘が起きた原因を判断");
        expect(prompt).toContain("guardian_missed");
        expect(prompt).toContain("new_request");
        expect(prompt).toContain("base_changed");
        activity.close();
      },
    );

    it.each([
      ["原因を答えない", undefined],
      ["原因を判断できない（undecidable）", "undecidable"],
      ["知らない原因", "other"],
    ] as const)(
      "ゴールガーディアンが%s指摘は、見逃しにせず、原因を決めない（PBI-268）",
      async (_name, cause) => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [rework("implement", "実装で直せる", cause)],
          { pulls, now: later },
        );
        pulls.feedbackList = [item("comment:269")];
        await service.checkPullRequests();
        const events = service.get(id)?.activity ?? [];
        expect(events.slice(-2).map((e) => e.type)).toEqual(["ReworkJudged", "ChangesRequested"]);
        expect(events.at(-2)?.payload).not.toHaveProperty("cause");
        expect(events.at(-1)?.payload).not.toHaveProperty("cause");
        expect(service.get(id)?.task.misses).toEqual([]);
        expect(service.get(id)?.task.prRework?.cause).toBeUndefined();
        activity.close();
      },
    );

    it("確認して決めたことを文書に書いてほしい指摘は、決定を変えないので実装に戻る。判断の基準と、決定を変えない旨の理由を残す（PBI-266。S9）", async () => {
      const pulls = new FakePulls();
      const reason =
        "決定を変えない：『過去の削除は戻せない』は承認済みの要求要件で決まっていて、文書に書くだけ";
      const { activity, service, executor, id } = await toImplementGate(
        [rework("implement", reason)],
        { pulls, now: later },
      );
      pulls.feedbackList = [
        item("comment:266", {
          body: "要求要件で確認した『過去の削除は戻せない』を、README と設計メモに書いてください",
        }),
      ];
      const before = executor.calls.length;
      await service.checkPullRequests();
      // 判断の指示に、決定を変えるかで決める基準と、理由の書き方がある
      const prompt = promptOf(executor, before);
      expect(prompt).toContain("過去の削除は戻せない");
      expect(prompt).toContain("決定を変えない指摘は、この PR の実装で直します");
      // 実装の PR は、決定を変えるときに、局所の変更か方針の変更かも書かせる（PBI-446）
      expect(prompt).toContain(
        "理由の先頭に、指摘が決定を変えないか、変えるか（変えるときは、局所の変更か方針の変更か）",
      );
      // 設計には戻らず、実装への差し戻しになる（承認済みの設計は残る）
      const task = service.get(id)?.task;
      expect(task?.status).toBe("queued");
      expect(task?.remarks.at(-1)?.step).toBe("implement");
      expect(task?.approved.design).toBeDefined();
      expect(task?.prRework).toMatchObject({ target: "implement", decided: true, reason });
      activity.close();
    });

    it("決定を変える指摘（画面の姿を変える）は、これまでどおり、その決定を持つ設計に戻る（PBI-266。S8）", async () => {
      const pulls = new FakePulls();
      const reason = "決定を変える：設計が決めた、月を選んでいない間の画面の姿を変える";
      const { activity, service, id } = await toImplementGate([rework("design", reason), design], {
        pulls,
        now: later,
      });
      pulls.feedbackList = [
        item("comment:267", {
          body: "月を選んでいないとき、いま見ている範囲が『これからの予約』だと画面で分かるようにしてください",
        }),
      ];
      await service.checkPullRequests();
      const task = service.get(id)?.task;
      expect(task?.remarks.at(-1)?.step).toBe("design");
      expect(task?.approved.design).toBeUndefined();
      expect(task?.prRework).toMatchObject({ target: "design", decided: true, reason });
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

    it("GitHub の時刻がこの機械の時計より先に進んでいても、初めて見た時刻から数えて待ち、その時刻の1時間後まで待ち続けない（PBI-270）", async () => {
      const pulls = new FakePulls();
      let now = Date.parse(at); // この機械の時計
      const { activity, service, id } = await toImplementGate(
        [rework("design", "観点が足りない")],
        { pulls, now: () => now },
      );
      // GitHub の時刻は1時間先なので、コメントの時刻は未来になっている
      pulls.feedbackList = [
        item("comment:20", { at: new Date(Date.parse(at) + 3_600_000).toISOString() }),
      ];
      const imported = () =>
        service.get(id)?.activity.filter((e) => e.type === "PullRequestReviewImported") ?? [];
      await service.checkPullRequests();
      expect(imported()).toHaveLength(0);
      // 初めて見てから2分たつまでは待つ
      now = Date.parse(at) + 119_000;
      await service.checkPullRequests();
      expect(imported()).toHaveLength(0);
      // 2分たったら、GitHub の時刻がまだ先でも取り込む
      now = Date.parse(at) + 121_000;
      await service.checkPullRequests();
      expect(imported()).toHaveLength(1);
      activity.close();
    });

    it("書き終わるのを待つ時間は、新しいコメントが見つかるたびに、そのコメントを見た時刻から数え直す（GitHub の時刻が先に進んでいるとき）", async () => {
      const pulls = new FakePulls();
      let now = Date.parse(at);
      const { activity, service, id } = await toImplementGate(
        [rework("design", "観点が足りない")],
        { pulls, now: () => now },
      );
      const ahead = (ms: number) => new Date(Date.parse(at) + 3_600_000 + ms).toISOString();
      pulls.feedbackList = [item("comment:21", { at: ahead(0) })];
      await service.checkPullRequests();
      // 1分半後に2件目のコメントが付いたので、1件目から2分たっても取り込まない
      now = Date.parse(at) + 90_000;
      pulls.feedbackList = [
        item("comment:21", { at: ahead(0) }),
        item("comment:22", { at: ahead(90_000) }),
      ];
      await service.checkPullRequests();
      now = Date.parse(at) + 130_000;
      await service.checkPullRequests();
      const imported = () =>
        service.get(id)?.activity.filter((e) => e.type === "PullRequestReviewImported") ?? [];
      expect(imported()).toHaveLength(0);
      // 2件目を見てから2分たったら、2件まとめて取り込む
      now = Date.parse(at) + 91_000 + 120_000;
      await service.checkPullRequests();
      expect(imported()).toHaveLength(1);
      expect(service.get(id)?.task.importedFeedback).toEqual(["comment:21", "comment:22"]);
      activity.close();
    });

    it("初めて見た時刻は、指摘を取り込む対象から外れたタスク（中止など）の分を忘れる（常駐中に増え続けない。PBI-270）", async () => {
      const pulls = new FakePulls();
      const now = Date.parse(at);
      const { activity, service, id } = await toImplementGate(
        [rework("design", "観点が足りない")],
        { pulls, now: () => now },
      );
      const seen = (service as unknown as { feedbackSeenAt: Map<string, unknown> }).feedbackSeenAt;
      // 待っている間（取り込む前）は、見た時刻を持つ
      pulls.feedbackList = [item("comment:24")];
      await service.checkPullRequests();
      expect(seen.has(id)).toBe(true);
      // 中止されたら、次の確認で忘れる
      await service.cancel(id);
      await service.checkPullRequests();
      expect(seen.size).toBe(0);
      activity.close();
    });

    it("GitHub の時刻がこの機械の時計より遅れていても、取り込みを遅らせない（PBI-270）", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await toImplementGate(
        [rework("design", "観点が足りない")],
        { pulls, now: () => Date.parse(at) + 3_600_000 },
      );
      pulls.feedbackList = [item("comment:23")];
      await service.checkPullRequests();
      expect(
        service.get(id)?.activity.filter((e) => e.type === "PullRequestReviewImported"),
      ).toHaveLength(1);
      activity.close();
    });

    it("設計まで戻す判断なら、人間の確認を待たずに設計に差し戻し、作り直した設計を人間の承認に回す（PBI-58）", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate(
        [rework("design", "観点が足りない", "guardian_missed"), design],
        { pulls, now: later },
      );
      pulls.feedbackList = [
        item("review:201", { kind: "review", body: "観点が足りない", requestChanges: true }),
        item("comment:202"),
      ];
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      expect(events.some((e) => e.type === "TaskEscalated")).toBe(false);
      // 最終レビューをしないので、見逃しは記録しない（PBI-336）
      expect(events.slice(-2).map((e) => [e.type, e.actor])).toEqual([
        ["ReworkJudged", "agent"],
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

    describe("対応を求めていないコメント（「承知しました」など）", () => {
      const judgedNoAction = (noAction: number[], target = "undecidable") =>
        out(
          `\`\`\`json\n${JSON.stringify({ "sacty-rework": { target, no_action: noAction, reason: "先の返信を受け入れただけの応答" } })}\n\`\`\``,
        );

      it("取り込んだコメントがすべて対応を求めていなければ、差し戻さず、承認待ちのままにする（作り直しも返信もしない）", async () => {
        const pulls = new FakePulls();
        const { activity, service, id, executor } = await toImplementGate([judgedNoAction([1])], {
          pulls,
          now: later,
        });
        const gate = service.get(id)?.task.gate;
        pulls.feedbackList = [item("comment:231", { body: "承知しました。" })];
        await service.checkPullRequests();
        const events = service.get(id)?.activity ?? [];
        expect(events.at(-1)).toMatchObject({
          type: "ReworkJudged",
          payload: { noAction: [0], noRework: true, reason: "先の返信を受け入れただけの応答" },
        });
        // 差し戻していない（最後の記録が判断のまま。承認待ちの提出も同じ）
        const task = service.get(id)?.task;
        expect(task?.status).toBe("awaiting_approval");
        expect(task?.gate).toEqual(gate);
        expect(task?.pendingReview).toBeUndefined();
        expect(task?.importedFeedback).toContain("comment:231");
        expect(task?.prRework).toBeUndefined();
        // 判断の指示に、対応を求めていない指摘の選び方と、指摘の番号がある
        const prompt = promptOf(executor, executor.calls.length - 1);
        expect(prompt).toContain("- [1] 承知しました。");
        expect(prompt).toContain('"no_action"');
        // 次の確認で、同じコメントを取り込み直さない・判断し直さない
        const runs = executor.calls.length;
        const count = events.length;
        await service.checkPullRequests();
        await service.runNext(id);
        expect(executor.calls.length).toBe(runs);
        expect(service.get(id)?.activity.length).toBe(count);
        activity.close();
      });

      it("対応を求めていないコメントと、対応を求める指摘が一緒に届いたら、求める指摘だけを差し戻す", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [judgedNoAction([1], "implement")],
          {
            pulls,
            now: later,
          },
        );
        pulls.feedbackList = [
          item("comment:241", { body: "承知しました。" }),
          item("comment:242", { body: "失敗時のログを足してください" }),
        ];
        await service.checkPullRequests();
        const events = service.get(id)?.activity ?? [];
        const sentBack = events.at(-1);
        expect(sentBack).toMatchObject({
          type: "ChangesRequested",
          payload: { step: "implement", target: "implement" },
        });
        const remarks = sentBack?.type === "ChangesRequested" ? sentBack.payload.remarks : [];
        expect(remarks.map((r) => r.text)).toEqual(["失敗時のログを足してください"]);
        // 返信の宛先（元のコメント）も、残した指摘のもの
        expect(remarks[0]?.origin).toMatchObject({ key: "comment:242" });
        const task = service.get(id)?.task;
        expect(task?.status).toBe("queued");
        expect(task?.importedFeedback).toEqual(
          expect.arrayContaining(["comment:241", "comment:242"]),
        );
        expect(task?.prRework).toMatchObject({ target: "implement", decided: true });
        activity.close();
      });

      it("AI のレビューの指摘・範囲の外の番号は、対応を求めていない指摘にしない（差し戻す）", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate([judgedNoAction([0, 2, 9])], {
          pulls,
          now: later,
        });
        pulls.feedbackList = [item("comment:251", { body: "承知しました。" })];
        await service.checkPullRequests();
        const events = service.get(id)?.activity ?? [];
        const judged = events.find((e) => e.type === "ReworkJudged");
        expect(judged?.type === "ReworkJudged" && judged.payload.noAction).toBeUndefined();
        expect(events.at(-1)).toMatchObject({ type: "ChangesRequested" });
        activity.close();
      });
    });

    describe("人に確かめてほしいことを PR に知らせる（PBI-301）", () => {
      const reason = "「前と言ってること」が何を指すか読み取れない";
      const redone = (responses: unknown[]) =>
        out(
          [
            "# 直した",
            block({ "sacty-responses": responses }),
            block({
              "sacty-test-map": [
                { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] },
                { viewpointId: "TV-2", tests: ["pay.test.ts › キーなし"] },
              ],
            }),
          ].join("\n\n"),
        );
      const asks = (pulls: FakePulls) =>
        pulls.issueComments.filter((c) => c.body.includes("<!-- sacty-human-ask:"));

      it.each(["http://127.0.0.1:4700", "https://sacty.example.com"])(
        "人に確かめてほしいことの投稿は、サービスに渡した画面の URL（%s）に関わらず、画面の URL・タスクの ID・注釈を出さず「Sacty の画面で」の案内を書く（PBI-471）",
        async (webUrl) => {
          const pulls = new FakePulls();
          const { activity, service, id } = await toImplementGate(
            [
              rework("undecidable", reason),
              redone([{ remarkId: "implement-1-1", text: "直しました", confirm: "推測しました" }]),
            ],
            { pulls, now: later, webUrl },
          );
          pulls.feedbackList = [item("comment:401", { body: "ここ前と言ってること違わない？" })];
          await service.checkPullRequests();
          await drain(service);
          await noticesSettled(service);
          // 目印（先頭の行）の外
          const body = (asks(pulls)[0]?.body ?? "").split("\n").slice(1).join("\n");
          expect(body).not.toContain("/tasks/");
          expect(body).not.toContain("http://127.0.0.1");
          expect(body).not.toContain(id);
          expect(body).not.toContain("タスクの画面は、依頼した人のマシンでだけ開けます。");
          expect(body).toContain("Sacty の画面で差し戻してください。");
          activity.close();
        },
      );

      it("判断できなかった理由と、実行の聞き返し（推測で決めたこと）を、作り直した実装が承認待ちに戻ったときに、実装の PR へ1回コメントする。承認の画面の元になる記録にも残る", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            rework("undecidable", reason),
            redone([
              {
                remarkId: "implement-1-1",
                text: "上限の値を作り直しました",
                confirm: "消えていた上限は 31 日と推測しました。元の値と違えば教えてください",
              },
            ]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [item("comment:401", { body: "ここ前と言ってること違わない？" })];
        await service.checkPullRequests();
        // 作り直している間は、まだ書かない（作り直した成果物が承認待ちに戻ったときに書く）
        await noticesSettled(service);
        expect(asks(pulls)).toHaveLength(0);
        await drain(service);
        await noticesSettled(service);
        const task = service.get(id)?.task;
        expect(task?.status).toBe("awaiting_approval");
        expect(task?.gate).toEqual({ step: "implement", submission: 2 });
        expect(task?.remarks.at(-1)).toMatchObject({
          id: "implement-1-1",
          confirm: "消えていた上限は 31 日と推測しました。元の値と違えば教えてください",
        });
        const posted = asks(pulls);
        expect(posted).toHaveLength(1);
        expect(posted[0]).toMatchObject({ repo: "https://github.com/acme/app", number: 7 });
        const body = posted[0]?.body ?? "";
        expect(body).toContain("<!-- sacty-human-ask:");
        expect(body).toContain(`> ${reason}`);
        expect(body).toContain("消えていた上限は 31 日と推測しました");
        expect(body).toContain(
          "**[この指摘](https://github.com/acme/app/pull/7#issuecomment-401)の意図を読み取れませんでした。**",
        );
        expect(body).not.toContain("implement-1-1");
        // 自分の投稿は、次の PR の確認で人間の指摘として取り込まない（取り込み済みの目印の対象外にして、差し戻しの連鎖を作らない）
        pulls.feedbackList = [];
        await service.checkPullRequests();
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        expect(asks(pulls)).toHaveLength(1);
        activity.close();
      });

      it("同じ文の確認が複数の指摘の対応に付いていたら、PR のコメントには1回だけ書き、付いていた指摘を並べる。文の違う確認は別に書く（PBI-354）", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            rework("implement", "実装の指摘"),
            redone([
              {
                remarkId: "implement-1-1",
                text: "直しました",
                confirm: "CI を再実行し、結果を確認してください。",
              },
              {
                remarkId: "implement-1-2",
                text: "直しました",
                confirm: " CI を再実行し、\n結果を確認してください。 ",
              },
              {
                remarkId: "implement-1-3",
                text: "直しました",
                confirm:
                  "CI を再実行し、結果を確認してください。確認しない場合、失敗を見落とします。",
              },
            ]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [
          item("comment:401", { body: "一つ目の指摘" }),
          item("comment:402", { body: "二つ目の指摘" }),
          item("comment:403", { body: "三つ目の指摘" }),
        ];
        await service.checkPullRequests();
        await drain(service);
        await noticesSettled(service);
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        const posted = asks(pulls);
        expect(posted).toHaveLength(1);
        const body = posted[0]?.body ?? "";
        const pr = "https://github.com/acme/app/pull/7";
        expect(body).toContain(
          `確かめたいこと（[この指摘](${pr}#issuecomment-401)・[この指摘](${pr}#issuecomment-402)）`,
        );
        expect(body).toContain(`確かめたいこと（[この指摘](${pr}#issuecomment-403)）`);
        expect(body.split("確かめたいこと（").length).toBe(3);
        expect(body).not.toContain("implement-1-");
        expect(body.split("> CI を再実行し、結果を確認してください。\n").length).toBe(2);
        activity.close();
      });

      it("返信の投稿（B2）と、人に確かめてほしいこと（C1）が同じ承認待ちで両方出るとき、別々のコメントを1回ずつ書き、どちらも人の指摘として取り込まない", async () => {
        const pulls = new FakePulls();
        const withReply = out(
          [
            "# 直した",
            block({
              "sacty-responses": [
                {
                  remarkId: "implement-1-1",
                  text: "上限の値を作り直しました",
                  confirm: "消えていた上限は 31 日と推測しました",
                },
              ],
            }),
            block({
              "sacty-github-comments": {
                comments: [
                  {
                    url: "https://github.com/acme/app/pull/7",
                    body: "ご指摘の件は、こう直しました。",
                  },
                ],
              },
            }),
            block({
              "sacty-test-map": [
                { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] },
                { viewpointId: "TV-2", tests: ["pay.test.ts › キーなし"] },
              ],
            }),
          ].join("\n\n"),
        );
        const { activity, service, id } = await toImplementGate(
          [rework("undecidable", reason), withReply],
          { pulls, now: later },
        );
        pulls.feedbackList = [item("comment:405", { body: "ここ前と言ってること違わない？" })];
        await service.checkPullRequests();
        await drain(service);
        await noticesSettled(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        const replies = () =>
          pulls.issueComments.filter((c) => c.body.includes("<!-- sacty-comment:"));
        expect(asks(pulls)).toHaveLength(1);
        expect(replies()).toHaveLength(1);
        expect(replies()[0]?.body).toContain(`sacty-comment:${id}:implement:submission-2:0`);
        expect(replies()[0]?.body).toContain("ご指摘の件は、こう直しました。");
        expect(asks(pulls)[0]?.body).not.toContain("<!-- sacty-comment:");
        // 続けて確認しても、どちらも増えず、差し戻しの連鎖にならない
        pulls.feedbackList = [];
        await service.checkPullRequests();
        await drain(service);
        await noticesSettled(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        expect(asks(pulls)).toHaveLength(1);
        expect(replies()).toHaveLength(1);
        activity.close();
      });

      it("セキュリティ対応（security-fix）のタスクでは、確かめてほしいことを PR に書かない（承認の画面には出る）", async () => {
        const pulls = new FakePulls();
        const securityPlanner = async () => ({
          steps: [...MVP_STEPS],
          plan: "security-fix" as const,
          reason: "セキュリティ対応",
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
        });
        const map = [
          { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] },
          { viewpointId: "TV-2", tests: ["pay.test.ts › キーなし"] },
          { viewpointId: "SEC-MIN", tests: ["pay.test.ts › 最小権限"] },
        ];
        const made = await toImplement(
          [
            implement("# 実装の説明", map),
            rework("undecidable", reason),
            out(
              [
                "# 直した",
                block({
                  "sacty-responses": [
                    {
                      remarkId: "implement-1-1",
                      text: "直した",
                      confirm: "脆弱性の範囲を推測しました",
                    },
                  ],
                }),
                block({ "sacty-test-map": map }),
              ].join("\n\n"),
            ),
          ],
          { pulls, now: later, planner: securityPlanner },
        );
        const { activity, service, id } = made;
        await drain(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 1 });
        pulls.feedbackList = [item("comment:410", { body: "ここ前と言ってること違わない？" })];
        await service.checkPullRequests();
        await drain(service);
        await noticesSettled(service);
        const task = service.get(id)?.task;
        expect(task?.gate).toEqual({ step: "implement", submission: 2 });
        // 確かめたいことは、承認の画面の元になる記録には残るが、PR には書かない
        expect(task?.remarks.at(-1)?.confirm).toBe("脆弱性の範囲を推測しました");
        expect(asks(pulls)).toHaveLength(0);
        activity.close();
      });

      it("確かめてほしいことの通知を書く前に一時停止したら、書かずに止まり、再開した後に1回だけ書く（目印で重複を防ぐ）", async () => {
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        let hold = true;
        class SlowFind extends FakePulls {
          override async findIssueComment(input: { repo: string; number: number; marker: string }) {
            if (hold && input.marker.includes("sacty-human-ask")) {
              hold = false;
              entered.resolve();
              await gate.promise;
            }
            return super.findIssueComment(input);
          }
        }
        const pulls = new SlowFind();
        const { activity, service, id } = await toImplementGate(
          [
            rework("undecidable", reason),
            redone([{ remarkId: "implement-1-1", text: "直した", confirm: "確かめたい" }]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [item("comment:411")];
        await service.checkPullRequests();
        await drain(service);
        // 既存のコメントを探している最中に、一時停止する
        await entered.promise;
        await service.pause(id);
        gate.resolve();
        await noticesSettled(service);
        expect(service.get(id)?.task.status).toBe("paused");
        expect(asks(pulls)).toHaveLength(0);
        // 再開すると、同じ提出の承認待ちに戻り、通知を書く。もう一度再開しても増えない
        service.resume(id, {});
        await noticesSettled(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        expect(asks(pulls)).toHaveLength(1);
        await service.pause(id);
        service.resume(id, {});
        await noticesSettled(service);
        expect(asks(pulls)).toHaveLength(1);
        activity.close();
      });

      it("先の通知がコメントを探している最中に、一時停止して再開しても、同じ提出の通知が二重に投稿されない（通知は提出ごとに順に処理する）", async () => {
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        let hold = true;
        class SlowFindFirst extends FakePulls {
          override async findIssueComment(input: { repo: string; number: number; marker: string }) {
            // 最初の検索の結果だけ、保留する（その時点では「まだ無い」）
            const found = await super.findIssueComment(input);
            if (hold && input.marker.includes("sacty-human-ask")) {
              hold = false;
              entered.resolve();
              await gate.promise;
            }
            return found;
          }
        }
        const pulls = new SlowFindFirst();
        const { activity, service, id } = await toImplementGate(
          [
            rework("undecidable", reason),
            redone([{ remarkId: "implement-1-1", text: "直した", confirm: "確かめたい" }]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [item("comment:412")];
        await service.checkPullRequests();
        await drain(service);
        await entered.promise;
        // 先の検索が終わる前に、一時停止して再開する（同じ提出の通知処理がもう1本始まる）
        await service.pause(id);
        service.resume(id, {});
        // 先の検索が終わっていない間に、通知を書いていないこと（何も起きないこと）を見るための猶予
        await idleFor(5);
        expect(asks(pulls)).toHaveLength(0);
        gate.resolve();
        await noticesSettled(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        expect(asks(pulls)).toHaveLength(1);
        activity.close();
      });

      it("判断できて、聞き返しも無ければ、PR には何も書かない（空）。判断できなかった理由だけのときは、その1件だけ書く", async () => {
        const pulls = new FakePulls();
        const decided = await toImplementGate(
          [
            rework("implement", "実装で直せる"),
            redone([{ remarkId: "implement-1-1", text: "直した" }]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [item("comment:402")];
        await decided.service.checkPullRequests();
        await drain(decided.service);
        await noticesSettled(decided.service);
        expect(decided.service.get(decided.id)?.task.gate).toEqual({
          step: "implement",
          submission: 2,
        });
        expect(asks(pulls)).toHaveLength(0);
        decided.activity.close();
      });

      it("判断できなかった理由だけ（実行の聞き返しが無い）でも、PR に書く", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [rework("undecidable", reason), redone([{ remarkId: "implement-1-1", text: "直した" }])],
          { pulls, now: later },
        );
        pulls.feedbackList = [item("comment:403")];
        await service.checkPullRequests();
        await drain(service);
        await noticesSettled(service);
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        expect(asks(pulls)).toHaveLength(1);
        expect(asks(pulls)[0]?.body).not.toContain("確かめたいこと（");
        activity.close();
      });

      it("PR に書けなくても（GitHub の失敗）、タスクは承認待ちのまま進み、例外にしない。書き直しもしない", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            rework("undecidable", reason),
            redone([{ remarkId: "implement-1-1", text: "直した", confirm: "確かめたい" }]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [item("comment:404")];
        await service.checkPullRequests();
        pulls.commentFail = "403 forbidden";
        await drain(service);
        await noticesSettled(service);
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("PR に知らせられませんでした"));
        expect(asks(pulls)).toHaveLength(0);
        warn.mockRestore();
        activity.close();
      });
    });

    describe("取り込んだ PR の指摘への対応を、PR に返信する（PBI-352）", () => {
      const map = [
        { viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] },
        { viewpointId: "TV-2", tests: ["pay.test.ts › キーなし"] },
      ];
      const redone = (responses: unknown[], title = "# 直した") =>
        out(
          [
            title,
            ...(responses.length > 0 ? [block({ "sacty-responses": responses })] : []),
            block({ "sacty-test-map": map }),
          ].join("\n\n"),
        );
      const decided = () => rework("implement", "実装で直せる");
      const inline = (id = 501, patch: Partial<PullRequestFeedback> = {}) =>
        item(`review_comment:${id}`, {
          kind: "review_comment",
          path: "src/pay.ts",
          line: 3,
          body: "ここは null を返すべき",
          ...patch,
        });
      const review = (id = 601) =>
        item(`review:${id}`, { kind: "review", body: "全体に、ログが足りない" });
      const comment = (id = 401) => item(`comment:${id}`, { body: "再開のフォームの候補も直して" });
      const prComments = (pulls: FakePulls) =>
        pulls.issueComments.filter((c) => c.body.startsWith("<!-- sacty-reply:"));
      const posted = (service: TaskService, id: string) =>
        (service.get(id)?.activity ?? []).flatMap((e) =>
          e.type === "RemarkRepliesPosted" ? [e.payload] : [],
        );
      const pr = "https://github.com/acme/app/pull/7";

      it("行へのコメントの指摘には、そのコメントへの返信として、レビューの本文・通常のコメントの指摘には、元へのリンクを付けた PR のコメントとして、1回ずつ投稿する。対応したか・しなかったかが先頭で分かり、申告が無ければ対応の文だけ", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", status: "addressed", text: "null を返すようにしました" },
              {
                remarkId: "implement-1-2",
                status: "declined",
                text: "ログの追加は、このタスクの範囲の外です",
              },
              { remarkId: "implement-1-3", status: "たぶん", text: "候補を直しました @alice" },
            ]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [inline(), review(), comment()];
        await service.checkPullRequests();
        // 指摘ごとに、元のコメントを持つ
        expect(
          service
            .get(id)
            ?.task.remarks.slice(-3)
            .map((r) => r.origin),
        ).toEqual([
          { key: "review_comment:501", number: 7 },
          { key: "review:601", number: 7 },
          { key: "comment:401", number: 7 },
        ]);
        // 作り直している間は、まだ返信しない
        expect(pulls.reviewReplies).toHaveLength(0);
        expect(prComments(pulls)).toHaveLength(0);
        await drain(service);
        const task = service.get(id)?.task;
        expect(task?.gate).toEqual({ step: "implement", submission: 2 });
        // 行へのコメントの指摘：そのコメントへの返信
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(pulls.reviewReplies[0]).toMatchObject({
          repo: "https://github.com/acme/app",
          number: 7,
          commentId: 501,
        });
        const threaded = pulls.reviewReplies[0]?.body ?? "";
        expect(threaded.startsWith(`<!-- sacty-reply:${id}:implement-1-1:2 -->\n`)).toBe(true);
        expect(threaded).toContain("**対応しました。**\n\nnull を返すようにしました");
        expect(threaded).not.toContain("への返信です");
        expect(threaded).toContain("Sacty の AI が書きました。");
        // レビューの本文・通常のコメントの指摘：元へのリンクを付けた PR のコメント
        const [onReview, onComment] = prComments(pulls).map((c) => c.body);
        expect(prComments(pulls)).toHaveLength(2);
        expect(prComments(pulls)[0]).toMatchObject({
          repo: "https://github.com/acme/app",
          number: 7,
        });
        expect(onReview).toContain(`<!-- sacty-reply:${id}:implement-1-2:2 -->`);
        expect(onReview).toContain(`[この指摘](${pr}#pullrequestreview-601)への返信です。`);
        expect(onReview).toContain(
          "**対応していません。** 理由：\n\nログの追加は、このタスクの範囲の外です",
        );
        // 申告が読めない（知らない値）なら、対応の文だけ。@名前では通知を飛ばさない
        expect(onComment).toContain(
          `[この指摘](${pr}#issuecomment-401)への返信です。\n> 「\`再開のフォームの候補も直して\`」\n`,
        );
        expect(onComment).not.toContain("**対応");
        expect(onComment).toContain("候補を直しました @​alice");
        expect(task?.remarks.slice(-3).map((r) => [r.status, r.repliedIn])).toEqual([
          ["addressed", 2],
          ["declined", 2],
          [undefined, 2],
        ]);
        // 作業履歴に、返信したことが残る
        expect(posted(service, id)).toEqual([
          {
            step: "implement",
            submission: 2,
            number: 7,
            results: [
              {
                remarkId: "implement-1-1",
                key: "review_comment:501",
                inline: true,
                url: `${pr}#discussion_r9001`,
              },
              {
                remarkId: "implement-1-2",
                key: "review:601",
                url: "https://github.com/acme/app/issues/7#issuecomment-1",
              },
              {
                remarkId: "implement-1-3",
                key: "comment:401",
                url: "https://github.com/acme/app/issues/7#issuecomment-2",
              },
            ],
          },
        ]);
        // 続けて確認・実行しても、同じ指摘に重ねて返信しない。実行待ちにも残らない
        expect(service.queuedTaskIds()).toEqual([]);
        await service.checkPullRequests();
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(2);
        expect(posted(service, id)).toHaveLength(1);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        activity.close();
      });

      it("行へのコメントへの返信を GitHub が断ったとき（元のコメントが消えた・返信への返信）は、元へのリンクを付けた PR のコメントとして投稿する", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pulls = new FakePulls();
        pulls.replyRejected = 404;
        const { activity, service, id } = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", status: "addressed", text: "直した" }])],
          { pulls, now: later },
        );
        pulls.feedbackList = [inline(777)];
        await service.checkPullRequests();
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(0);
        expect(prComments(pulls)).toHaveLength(1);
        expect(prComments(pulls)[0]?.body).toContain(
          `[この指摘](${pr}#discussion_r777)への返信です。`,
        );
        expect(posted(service, id)[0]?.results).toEqual([
          {
            remarkId: "implement-1-1",
            key: "review_comment:777",
            url: "https://github.com/acme/app/issues/7#issuecomment-1",
          },
        ]);
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("行へのコメントへの返信として投稿できませんでした"),
        );
        warn.mockRestore();
        activity.close();
      });

      const first2 = (body: string) =>
        body
          .split("\n")
          .slice(1)
          .filter((l) => l.trim() !== "")
          .slice(0, 2);
      const aiReview = (pulls: FakePulls, id = 602) =>
        item(`review:${id}`, {
          commit: pulls.prInfo.headSha,
          kind: "review",
          author: "me",
          source: "sacty_review",
          body: "## sacty のレビュー\n@me 判定：要修正\n戻り値の確認が無い",
        });

      it("指摘が1件（レビューの本文だけ）：PR のコメントを1通だけ、元へのリンクだけを書き出しに書いて投稿する。レビューの本文は引用しない", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", status: "addressed", text: "直した" }])],
          { pulls, now: later },
        );
        pulls.feedbackList = [review()];
        await service.checkPullRequests();
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(0);
        expect(prComments(pulls)).toHaveLength(1);
        const lines = (prComments(pulls)[0]?.body ?? "").split("\n");
        expect(lines[0]).toBe(`<!-- sacty-reply:${id}:implement-1-1:2 -->`);
        expect(lines[1]).toBe(`[この指摘](${pr}#pullrequestreview-601)への返信です。`);
        expect(lines[2]).toBe("");
        expect(lines[3]).toBe("**対応しました。**");
        activity.close();
      });

      it("sacty のレビューの指摘と、人の通常のコメントが混ざる：2通の書き出しは、種類と出どころを言わず、リンク先と引用だけが違う。投稿の数と宛先は変わらない", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", status: "addressed", text: "確認を足しました" },
              { remarkId: "implement-1-2", status: "addressed", text: "候補も直しました" },
            ]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [aiReview(pulls), comment()];
        await service.checkPullRequests();
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(0);
        const [onAi, onHuman] = prComments(pulls).map((c) => c.body);
        expect(prComments(pulls)).toHaveLength(2);
        expect(first2(onAi ?? "")[0]).toBe(`[この指摘](${pr}#pullrequestreview-602)への返信です。`);
        expect(first2(onHuman ?? "")).toEqual([
          `[この指摘](${pr}#issuecomment-401)への返信です。`,
          "> 「`再開のフォームの候補も直して`」",
        ]);
        expect(first2(onAi ?? "")).not.toEqual(first2(onHuman ?? ""));
        // 引用のあるなしにかかわらず、先頭は目印、末尾は署名のまま
        for (const [n, body] of [onAi, onHuman].entries()) {
          expect(body?.startsWith(`<!-- sacty-reply:${id}:implement-1-${n + 1}:2 -->\n`)).toBe(
            true,
          );
          expect(body).toContain("Sacty の AI が書きました。");
          expect(body).not.toContain(`implement-1-${n + 1} への対応`);
        }
        expect(posted(service, id)[0]?.results.map((r) => r.remarkId)).toEqual([
          "implement-1-1",
          "implement-1-2",
        ]);
        activity.close();
      });

      it("行へのコメントと通常のコメントが混ざる：行へのコメントにはスレッドへの返信（書き出しなし）、通常のコメントには引用つきの PR のコメント。行への返信を断られたときは、行へのコメントへの返信として書き出しを付けた PR のコメントに回る", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const run = async (rejected: boolean) => {
          const pulls = new FakePulls();
          if (rejected) pulls.replyRejected = 404;
          const made = await toImplementGate(
            [
              decided(),
              redone([
                { remarkId: "implement-1-1", status: "addressed", text: "直した" },
                { remarkId: "implement-1-2", status: "addressed", text: "候補も直した" },
              ]),
            ],
            { pulls, now: later },
          );
          pulls.feedbackList = [inline(), comment()];
          await made.service.checkPullRequests();
          await drain(made.service);
          made.activity.close();
          return pulls;
        };
        const threaded = await run(false);
        expect(threaded.reviewReplies).toHaveLength(1);
        expect(threaded.reviewReplies[0]?.body).not.toContain("への返信です");
        expect(prComments(threaded)).toHaveLength(1);
        expect(first2(prComments(threaded)[0]?.body ?? "")[0]).toBe(
          `[この指摘](${pr}#issuecomment-401)への返信です。`,
        );
        const rejected = await run(true);
        expect(rejected.reviewReplies).toHaveLength(0);
        const [onLine, onComment] = prComments(rejected).map((c) => c.body);
        expect(prComments(rejected)).toHaveLength(2);
        expect(first2(onLine ?? "")).toEqual([
          `[この指摘](${pr}#discussion_r501)への返信です。`,
          "**対応しました。**",
        ]);
        expect(first2(onComment ?? "")[1]).toBe("> 「`再開のフォームの候補も直して`」");
        warn.mockRestore();
      });

      it("行への返信の答えを受け取れなかっただけなら、投稿済みの返信を見つけて使い、PR のコメントを重ねない", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pulls = new FakePulls();
        pulls.replyAnswerLost = "socket hang up";
        const { activity, service, id } = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", text: "直した" }])],
          { pulls, now: later },
        );
        pulls.feedbackList = [inline()];
        await service.checkPullRequests();
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)[0]?.results).toEqual([
          {
            remarkId: "implement-1-1",
            key: "review_comment:501",
            inline: true,
            url: `${pr}#discussion_r9001`,
          },
        ]);
        warn.mockRestore();
        activity.close();
      });

      it("返信の投稿に失敗しても、タスクは止めない。失敗は作業履歴に残し、やり直さない（秘密の値は伏せる）", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", status: "addressed", text: "直した" },
              { remarkId: "implement-1-2", status: "addressed", text: "足した" },
            ]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [inline(), comment()];
        await service.checkPullRequests();
        pulls.replyFail = "403 forbidden";
        pulls.commentFail = "403 forbidden for ghp_secret";
        await drain(service);
        const task = service.get(id)?.task;
        expect(task?.status).toBe("awaiting_approval");
        expect(task?.gate).toEqual({ step: "implement", submission: 2 });
        const results = posted(service, id)[0]?.results ?? [];
        expect(results.map((r) => [r.remarkId, r.key, r.url, r.inline])).toEqual([
          ["implement-1-1", "review_comment:501", undefined, undefined],
          ["implement-1-2", "comment:401", undefined, undefined],
        ]);
        for (const r of results) {
          expect(JSON.stringify(r.failed)).toContain("403 forbidden");
          expect(JSON.stringify(r.failed)).not.toContain("ghp_secret");
        }
        // 投稿できるようになっても、やり直さない（実行待ちにも残らない）
        pulls.replyFail = undefined;
        pulls.commentFail = undefined;
        expect(service.queuedTaskIds()).toEqual([]);
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(0);
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(1);
        warn.mockRestore();
        activity.close();
      });

      it("投稿の後・記録の前にデーモンが止まっても、目印で投稿済みの返信を見つけて、二重に投稿しない", async () => {
        const pulls = new FakePulls();
        let clock = later();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", status: "addressed", text: "直した" },
              { remarkId: "implement-1-2", status: "declined", text: "範囲の外です" },
            ]),
          ],
          { pulls, now: () => clock },
        );
        pulls.feedbackList = [inline(), review()];
        await service.checkPullRequests();
        // RemarkRepliesPosted の記録だけを一度失敗させる（PR の返信だけが残る）
        const append = activity.append.bind(activity);
        let failOnce = true;
        activity.append = (entry) => {
          if (failOnce && entry.events.some((e) => e.event.type === "RemarkRepliesPosted")) {
            failOnce = false;
            throw new Error("disk full");
          }
          return append(entry);
        };
        await expect(drain(service)).rejects.toThrow("disk full");
        // 記録できなかった後は、間を置くまで、実行待ちに出さない（失敗が続いても、実行の枠を取り続けない）
        expect(service.queuedTaskIds()).toEqual([]);
        clock += 61_000;
        expect(service.queuedTaskIds()).toEqual([id]);
        expect(failOnce).toBe(false);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(1);
        expect(posted(service, id)).toHaveLength(0);
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(1);
        expect(posted(service, id)[0]?.results).toEqual([
          {
            remarkId: "implement-1-1",
            key: "review_comment:501",
            inline: true,
            url: `${pr}#discussion_r9001`,
          },
          {
            remarkId: "implement-1-2",
            key: "review:601",
            url: "https://github.com/acme/app/issues/7#issuecomment-1",
          },
        ]);
        activity.close();
      });

      it("対応の付いていない指摘と、画面から書いた指摘には、返信しない（返信するものが無ければ、作業履歴にも残さない）", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            // PR の指摘への対応を書かない
            decided(),
            redone([]),
            // 画面からの指摘には対応を書く
            redone([
              { remarkId: "implement-2-1", status: "addressed", text: "画面の指摘を直した" },
            ]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [comment()];
        await service.checkPullRequests();
        await drain(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        expect(service.get(id)?.task.remarks.at(-1)).toMatchObject({
          id: "implement-1-1",
          origin: { key: "comment:401", number: 7 },
        });
        expect(service.get(id)?.task.remarks.at(-1)?.response).toBeUndefined();
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(0);
        // 画面から書いた指摘（元の PR のコメントが無い。以前の作業履歴の指摘も同じ形）
        service.requestChanges(id, {
          step: "implement",
          submission: 2,
          comments: ["画面からの指摘"],
        });
        await drain(service);
        const task = service.get(id)?.task;
        expect(task?.gate).toEqual({ step: "implement", submission: 3 });
        expect(task?.remarks.at(-1)).toMatchObject({
          id: "implement-2-1",
          response: "画面の指摘を直した",
          status: "addressed",
        });
        expect(task?.remarks.at(-1)?.origin).toBeUndefined();
        expect(pulls.reviewReplies).toHaveLength(0);
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(0);
        expect(service.queuedTaskIds()).toEqual([]);
        activity.close();
      });

      it("1件の指摘には1回だけ返信する：次の差し戻しでは、新しい指摘にだけ返信する。前の提出で対応が無かった指摘には、対応が付いた提出で返信する", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            // 1回目：1件目にだけ対応を書く
            redone([{ remarkId: "implement-1-1", status: "addressed", text: "一つめを直した" }]),
            decided(),
            // 2回目：前の指摘にも、もう一度対応を書く
            redone([
              { remarkId: "implement-1-1", status: "addressed", text: "一つめは直したまま" },
              { remarkId: "implement-1-2", status: "declined", text: "二つめは範囲の外" },
              { remarkId: "implement-2-1", status: "addressed", text: "三つめを直した" },
            ]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [comment(401), comment(402)];
        await service.checkPullRequests();
        await drain(service);
        expect(prComments(pulls).map((c) => c.body.split("\n")[0])).toEqual([
          `<!-- sacty-reply:${id}:implement-1-1:2 -->`,
        ]);
        pulls.feedbackList = [comment(401), comment(402), comment(403)];
        await service.checkPullRequests();
        await drain(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 3 });
        expect(prComments(pulls).map((c) => c.body.split("\n")[0])).toEqual([
          `<!-- sacty-reply:${id}:implement-1-1:2 -->`,
          `<!-- sacty-reply:${id}:implement-1-2:3 -->`,
          `<!-- sacty-reply:${id}:implement-2-1:3 -->`,
        ]);
        expect(
          posted(service, id).map((p) => [p.submission, p.results.map((r) => r.remarkId)]),
        ).toEqual([
          [2, ["implement-1-1"]],
          [3, ["implement-1-2", "implement-2-1"]],
        ]);
        activity.close();
      });

      it("セキュリティ対応のタスクでは、返信しない（対応は、承認の画面には出る）", async () => {
        const pulls = new FakePulls();
        const securityPlanner = async () => ({
          steps: [...MVP_STEPS],
          plan: "security-fix" as const,
          reason: "セキュリティ対応",
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
        });
        const secure = [...map, { viewpointId: "SEC-MIN", tests: ["pay.test.ts › 最小権限"] }];
        const made = await toImplement(
          [
            implement("# 実装の説明", secure),
            decided(),
            out(
              [
                "# 直した",
                block({
                  "sacty-responses": [
                    { remarkId: "implement-1-1", status: "addressed", text: "脆弱な箇所を直した" },
                  ],
                }),
                block({ "sacty-test-map": secure }),
              ].join("\n\n"),
            ),
          ],
          { pulls, now: later, planner: securityPlanner },
        );
        const { activity, service, id } = made;
        await drain(service);
        pulls.feedbackList = [inline()];
        await service.checkPullRequests();
        await drain(service);
        const task = service.get(id)?.task;
        expect(task?.gate).toEqual({ step: "implement", submission: 2 });
        expect(task?.remarks.at(-1)).toMatchObject({ response: "脆弱な箇所を直した" });
        expect(pulls.reviewReplies).toHaveLength(0);
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(0);
        expect(service.queuedTaskIds()).toEqual([]);
        activity.close();
      });

      it("GitHub のアカウントを選んでいないプロジェクトでは、返信しない（実行待ちにも残らない）", async () => {
        const pulls = new FakePulls();
        const projects = projectsWithAccount();
        const made = await toImplement(
          [
            implement("# 実装の説明"),
            decided(),
            redone([{ remarkId: "implement-1-1", status: "addressed", text: "直した" }]),
          ],
          { pulls, now: later, projects },
        );
        const { activity, service, id } = made;
        await drain(service);
        pulls.feedbackList = [comment()];
        await service.checkPullRequests();
        // 作り直した実装が承認待ちに戻るところまで進める（返信は、その次の処理）
        for (let i = 0; i < 10 && service.get(id)?.task.gate?.submission !== 2; i++) {
          await service.runNext(id);
        }
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        expect(service.queuedTaskIds()).toEqual([id]);
        const current = projects.get("default");
        projects.put("default", { name: current?.name ?? "", targets: current?.targets ?? [] });
        expect(service.queuedTaskIds()).toEqual([]);
        await drain(service);
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(0);
        activity.close();
      });

      it("既存の返信を探している間に一時停止されたら、投稿も記録もせず、再開した後に1回だけ返信する", async () => {
        const entered = Promise.withResolvers<void>();
        const gate = Promise.withResolvers<void>();
        let hold = true;
        class SlowFind extends FakePulls {
          override async listReviewComments(input: Parameters<FakePulls["listReviewComments"]>[0]) {
            if (hold && input.prefix.includes("sacty-reply")) {
              hold = false;
              entered.resolve();
              await gate.promise;
            }
            return super.listReviewComments(input);
          }
        }
        const pulls = new SlowFind();
        const { activity, service, id } = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", status: "addressed", text: "直した" }])],
          { pulls, now: later },
        );
        pulls.feedbackList = [comment()];
        await service.checkPullRequests();
        const running = drain(service);
        await entered.promise;
        const pausing = service.pause(id);
        gate.resolve();
        await pausing;
        await running;
        expect(service.get(id)?.task.status).toBe("paused");
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(0);
        service.resume(id, {});
        await drain(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        expect(prComments(pulls)).toHaveLength(1);
        expect(posted(service, id)).toHaveLength(1);
        activity.close();
      });

      it("3 回差し戻した後に取り込んだ PR の指摘も、4 回目の差し戻しとして、元のコメントを失わず、対応を返信する", async () => {
        const pulls = new FakePulls();
        const round = (n: number) => [implement(`# 実装の説明 v${n + 1}`)];
        const { activity, service, id } = await toImplementGate(
          [
            ...round(1),
            ...round(2),
            ...round(3),
            decided(),
            redone([{ remarkId: "implement-4-1", status: "addressed", text: "ログを足した" }]),
          ],
          { pulls, now: later },
        );
        for (let n = 1; n <= 3; n++) {
          service.requestChanges(id, {
            step: "implement",
            submission: service.get(id)?.task.gate?.submission ?? 0,
            comments: [`指摘${n}`],
          });
          await drain(service);
        }
        pulls.feedbackList = [inline()];
        await service.checkPullRequests();
        expect(service.get(id)?.task.escalation).toBeUndefined();
        expect(service.get(id)?.task.remarks.at(-1)).toMatchObject({
          id: "implement-4-1",
          text: expect.stringContaining("ここは null を返すべき"),
          origin: { key: "review_comment:501", number: 7 },
        });
        await drain(service);
        expect(pulls.reviewReplies.map((r) => r.commentId)).toEqual([501]);
        activity.close();
      });

      it("以前の版で上限のために止まったタスクの残った指摘も、元の形のまま補足と一緒に差し戻すと、元のコメントへの返信が PR に付く（PBI-414）", async () => {
        const pulls = new FakePulls();
        const { activity, id } = await toImplementGate([], { pulls, now: later });
        activity.append({
          taskId: id,
          projectId: "default",
          events: [
            {
              actor: "sacty",
              event: {
                type: "TaskEscalated",
                payload: {
                  step: "implement",
                  target: "implement",
                  reason: "too_many_changes",
                  pendingRemarks: [
                    {
                      id: "implement-4-1",
                      text: "ここは null を返すべき",
                      origin: { key: "review_comment:501", number: 7 },
                    },
                    {
                      id: "implement-4-2",
                      text: "2 行目\nここも直す",
                      origin: { key: "review_comment:502", number: 7 },
                    },
                    {
                      id: "implement-4-3",
                      text: "3 件目",
                      origin: { key: "review_comment:503", number: 7 },
                    },
                  ],
                },
              },
            },
          ],
        });
        const { service } = makeService(
          activity,
          [
            redone([
              { remarkId: "implement-1-1", status: "addressed", text: "ログを足した" },
              { remarkId: "implement-1-2", status: "addressed", text: "二つ目も直した" },
              { remarkId: "implement-1-3", status: "addressed", text: "三つ目も直した" },
              { remarkId: "implement-1-4", status: "addressed", text: "テストも足した" },
            ]),
          ],
          { pulls, now: later },
        );
        expect(service.get(id)?.task.status).toBe("escalated");
        service.requestChanges(id, {
          step: "implement",
          submission: 1,
          comments: ["補足も直す"],
        });
        const implementRemarks = service
          .get(id)
          ?.task.remarks.filter((r) => r.step === "implement");
        expect(implementRemarks?.map((r) => [r.id, r.text, r.origin?.key])).toEqual([
          ["implement-1-1", "ここは null を返すべき", "review_comment:501"],
          ["implement-1-2", "2 行目\nここも直す", "review_comment:502"],
          ["implement-1-3", "3 件目", "review_comment:503"],
          ["implement-1-4", "補足も直す", undefined],
        ]);
        await drain(service);
        // 元のコメントを持つ指摘の全部が、それぞれのコメントに返信する（補足は返信しない）
        expect(pulls.reviewReplies.map((r) => r.commentId).sort()).toEqual([501, 502, 503]);
        activity.close();
      });

      it("一時停止の間に届いた指摘も、元のコメントを持ち、作り直した実装が承認待ちになったら返信する", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            // 差し戻した実装が、エラーで止まる
            { kind: "failed", reason: "error", message: "EACCES: permission denied" },
            decided(),
            redone([
              { remarkId: "implement-1-1", status: "addressed", text: "最初の指摘を直した" },
              {
                remarkId: "implement-2-1",
                status: "addressed",
                text: "環境に依存しないようにした",
              },
            ]),
          ],
          { pulls, now: later },
        );
        service.requestChanges(id, { step: "implement", submission: 1, comments: ["最初の指摘"] });
        await service.runNext(id);
        expect(service.get(id)?.task.status).toBe("paused");
        pulls.feedbackList = [inline(502, { body: "npm test が環境に依存している" })];
        await service.checkPullRequests();
        service.resume(id, {});
        await drain(service);
        const task = service.get(id)?.task;
        expect(task?.gate).toEqual({ step: "implement", submission: 2 });
        expect(task?.remarks.at(-1)).toMatchObject({
          id: "implement-2-1",
          origin: { key: "review_comment:502", number: 7 },
          repliedIn: 2,
        });
        // 画面から書いた最初の指摘には返信しない
        expect(pulls.reviewReplies.map((r) => r.commentId)).toEqual([502]);
        expect(prComments(pulls)).toHaveLength(0);
        activity.close();
      });

      it("実装の PR の指摘を設計に戻したときは、設計の対応を、実装の PR を更新した提出で返信する", async () => {
        const pulls = new FakePulls();
        const designRedone = out(
          [
            "# 設計 v2",
            block({
              "sacty-test-viewpoints": [
                { title: "同じキーの再送", input: "同じキーで2回送る", expected: "決済は1回" },
                { title: "キーなし", input: "キーを付けない", expected: "400" },
              ],
            }),
            block({
              "sacty-responses": [
                { remarkId: "design-1-1", status: "addressed", text: "画面の姿の決定を変えました" },
              ],
            }),
          ].join("\n\n"),
        );
        const { activity, service, id } = await toImplementGate(
          [rework("design", "決定を変える"), designRedone, implement("# 実装の説明 v2")],
          { pulls, now: later },
        );
        pulls.feedbackList = [comment()];
        await service.checkPullRequests();
        await drain(service);
        const gate = service.get(id)?.task.gate;
        expect(gate?.step).toBe("design");
        // 設計の承認待ちでは、まだ返信しない（実装の PR は、まだ更新していない）
        expect(prComments(pulls)).toHaveLength(0);
        service.approve(id, { step: "design", submission: gate?.submission ?? 0 });
        await drain(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        expect(prComments(pulls)).toHaveLength(1);
        expect(prComments(pulls)[0]?.body).toContain(
          "**対応しました。**\n\n画面の姿の決定を変えました",
        );
        expect(prComments(pulls)[0]?.body).toContain("Sacty の AI が書きました。");
        expect(posted(service, id)[0]).toMatchObject({
          step: "implement",
          submission: 2,
          results: [{ remarkId: "design-1-1", key: "comment:401" }],
        });
        activity.close();
      });

      it("返信を待つのは、開いている PR の承認待ちの提出だけ：閉じられた PR・一時停止中・無効にした指摘・ほかの PR の指摘では待たない", async () => {
        const pulls = new FakePulls();
        pulls.commentFail = "止めておく";
        pulls.replyFail = "止めておく";
        const { activity, service, id } = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", status: "addressed", text: "直した" }])],
          { pulls, now: later },
        );
        pulls.feedbackList = [inline()];
        await service.checkPullRequests();
        // 作り直した実装が承認待ちに戻るところまで進める（返信は、その次の処理）
        for (let i = 0; i < 10 && service.get(id)?.task.gate?.submission !== 2; i++) {
          await service.runNext(id);
        }
        const task = service.get(id)?.task as Task;
        expect(awaitingRemarkReplies(task)).toMatchObject({
          step: "implement",
          submission: 2,
          number: 7,
          repo: "https://github.com/acme/app",
          url: "https://github.com/acme/app/pull/7",
          replies: [
            {
              id: "implement-1-1",
              key: "review_comment:501",
              step: "implement",
              response: "直した",
              status: "addressed",
              respondedIn: 2,
            },
          ],
        });
        // AI のレビューから出た案を、人が「この PR で直す」と決めた指摘（fixOf 付き）は、元の指摘の出どころ（sacty のレビュー）を引き継ぐ
        const first = task.remarks.find((r) => r.id === "implement-1-1") as Remark;
        const withFix = {
          ...task,
          remarks: [
            { ...first, id: "orig-ai", source: "sacty_review" as const, repliedIn: 2 },
            { ...first, id: "fix-of-ai", fixOf: "orig-ai" },
          ],
        } as Task;
        expect(awaitingRemarkReplies(withFix)?.replies).toMatchObject([
          { id: "fix-of-ai", source: "sacty_review" },
        ]);
        const humanFix = {
          ...withFix,
          remarks: [
            { ...first, id: "orig-human", repliedIn: 2 },
            { ...first, id: "fix-of-human", fixOf: "orig-human" },
          ],
        } as Task;
        expect(awaitingRemarkReplies(humanFix)?.replies[0]?.source).toBeUndefined();
        expect(awaitingRemarkReplies({ ...task, pullRequestState: "closed" })).toBeUndefined();
        expect(awaitingRemarkReplies({ ...task, status: "paused" })).toBeUndefined();
        expect(
          awaitingRemarkReplies({
            ...task,
            remarks: task.remarks.map((r) => ({ ...r, voided: true })),
          }),
        ).toBeUndefined();
        // ほかの PR のコメントから取り込んだ指摘（PR を作り直した後など）にも返信しない
        expect(
          awaitingRemarkReplies({
            ...task,
            remarks: task.remarks.map((r) =>
              r.origin ? { ...r, origin: { ...r.origin, number: 8 } } : r,
            ),
          }),
        ).toBeUndefined();
        activity.close();
      });

      it("行への返信が投稿されたかが分からないとき（答えを受け取れず、探し直しても見つからない・探せない）は、PR のコメントを重ねずに、失敗を残す", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        // 答えを受け取れず、探し直しも失敗する（返信は GitHub にある）
        const lost = new FakePulls();
        lost.replyAnswerLost = "socket hang up";
        lost.reviewListFailAfter = 1;
        const a = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", text: "直した" }])],
          { pulls: lost, now: later },
        );
        lost.feedbackList = [inline()];
        await a.service.checkPullRequests();
        await drain(a.service);
        expect(lost.reviewReplies).toHaveLength(1);
        expect(prComments(lost)).toHaveLength(0);
        expect(posted(a.service, a.id)[0]?.results).toEqual([
          { remarkId: "implement-1-1", key: "review_comment:501", failed: "socket hang up" },
        ]);
        expect(a.service.queuedTaskIds()).toEqual([]);
        a.activity.close();
        rmSync(dbPath, { force: true });
        // 通信の失敗で、探し直しても見つからない（断られたのではないので、投稿されたかが分からない）
        const unknown = new FakePulls();
        unknown.replyFail = "ECONNRESET";
        const b = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", text: "直した" }])],
          { pulls: unknown, now: later },
        );
        unknown.feedbackList = [inline()];
        await b.service.checkPullRequests();
        await drain(b.service);
        expect(prComments(unknown)).toHaveLength(0);
        expect(posted(b.service, b.id)[0]?.results).toEqual([
          { remarkId: "implement-1-1", key: "review_comment:501", failed: "ECONNRESET" },
        ]);
        warn.mockRestore();
        b.activity.close();
      });

      it("投稿済みの返信を探せない（一覧を読めない）ときは、どの指摘にも投稿せず、失敗を残す", async () => {
        const pulls = new FakePulls();
        pulls.listFail = "502 Bad Gateway";
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", text: "直した" },
              { remarkId: "implement-1-2", text: "足した" },
            ]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [inline(), comment()];
        await service.checkPullRequests();
        await drain(service);
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        expect(pulls.reviewReplies).toHaveLength(0);
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)[0]?.results).toEqual([
          { remarkId: "implement-1-1", key: "review_comment:501", failed: "502 Bad Gateway" },
          { remarkId: "implement-1-2", key: "comment:401", failed: "502 Bad Gateway" },
        ]);
        activity.close();
      });

      it("ほかの人が目印をまねた・引用した投稿は、投稿済みと見なさない（返信に使ったと記録したアカウントの、目印で始まる投稿だけ。一覧は最後まで読む）", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", text: "直した" },
              { remarkId: "implement-1-2", text: "足した" },
            ]),
          ],
          { pulls, now: later },
        );
        const fake = (remark: string) => `<!-- sacty-reply:${id}:${remark}:2 -->\nまねた投稿`;
        pulls.foreignReviewComments = [
          { number: 7, author: "mallory", body: fake("implement-1-1") },
        ];
        pulls.foreignIssueComments = [
          { number: 7, author: "mallory", body: fake("implement-1-2") },
        ];
        pulls.feedbackList = [inline(), comment()];
        await service.checkPullRequests();
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(1);
        expect(posted(service, id)[0]?.results.map((r) => r.url)).toEqual([
          `${pr}#discussion_r9001`,
          "https://github.com/acme/app/issues/7#issuecomment-1",
        ]);
        // 一覧は、最後まで読む指定で読み、投稿者は、返信に使ったと記録したアカウントと照合する
        expect(pulls.reviewListInputs).toEqual([
          { prefix: `<!-- sacty-reply:${id}:`, complete: true },
        ]);
        expect(service.get(id)?.task.remarkReplyAccounts).toEqual(["me"]);
        activity.close();
      });

      it("GitHub が答えを返さないときは、期限で打ち切って失敗を残し、残りの指摘は投稿を試みない（実行の枠を占めたままにしない）", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pulls = new FakePulls();
        pulls.replyGate = new Promise<void>(() => {});
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", text: "直した" },
              { remarkId: "implement-1-2", text: "足した" },
              { remarkId: "implement-1-3", text: "変えた" },
            ]),
          ],
          { pulls, now: later, stopNoticeTimeoutMs: 30 },
        );
        pulls.feedbackList = [inline(), comment(401), comment(402)];
        await service.checkPullRequests();
        await drain(service);
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        expect(prComments(pulls)).toHaveLength(0);
        const results = posted(service, id)[0]?.results ?? [];
        expect(results.map((r) => [r.remarkId, r.url])).toEqual([
          ["implement-1-1", undefined],
          ["implement-1-2", undefined],
          ["implement-1-3", undefined],
        ]);
        expect(results[0]?.failed).toBeDefined();
        // 残りは、投稿を試みずに、その理由を残す
        expect(results.slice(1).map((r) => r.failed)).toEqual([
          { code: "github.replySkippedAfterTimeout" },
          { code: "github.replySkippedAfterTimeout" },
        ]);
        expect(service.queuedTaskIds()).toEqual([]);
        warn.mockRestore();
        activity.close();
      });

      it("行への返信を待っている間に一時停止されたら、断られても PR のコメントに回さず、記録もしない", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const gate = Promise.withResolvers<void>();
        class SlowReject extends FakePulls {
          override async replyToReviewComment(
            input: Parameters<FakePulls["replyToReviewComment"]>[0],
          ) {
            this.replyStarted.resolve();
            await gate.promise;
            this.replyRejected = 404;
            return super.replyToReviewComment(input);
          }
        }
        const pulls = new SlowReject();
        const { activity, service, id } = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", text: "直した" }])],
          { pulls, now: later },
        );
        pulls.feedbackList = [inline()];
        await service.checkPullRequests();
        const running = drain(service);
        await pulls.replyStarted.promise;
        const pausing = service.pause(id);
        gate.resolve();
        await pausing;
        await running;
        expect(service.get(id)?.task.status).toBe("paused");
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(0);
        warn.mockRestore();
        activity.close();
      });

      it("返信を待っている間に無効にされた指摘には、投稿しない（ほかの指摘の返信は続ける）", async () => {
        const made: { service?: TaskService; id?: string } = {};
        class VoidingPulls extends FakePulls {
          override async replyToReviewComment(
            input: Parameters<FakePulls["replyToReviewComment"]>[0],
          ) {
            // 1件目の返信の間に、人が2件目の指摘を無効にする
            if (made.service && made.id) made.service.voidRemark(made.id, "implement-1-2");
            return super.replyToReviewComment(input);
          }
        }
        const pulls = new VoidingPulls();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", status: "addressed", text: "直した" },
              { remarkId: "implement-1-2", status: "addressed", text: "足した" },
            ]),
          ],
          { pulls, now: later },
        );
        made.service = service;
        made.id = id;
        pulls.feedbackList = [inline(), comment()];
        await service.checkPullRequests();
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id).map((p) => p.results.map((r) => r.remarkId))).toEqual([
          ["implement-1-1"],
        ]);
        expect(service.queuedTaskIds()).toEqual([]);
        activity.close();
      });

      it("トークンの取り出しが終わらないときも、期限で打ち切って、失敗を残す", async () => {
        class HangingGitHub extends FakeGitHub {
          hang = false;
          override async token(host: string, account: string) {
            if (this.hang) await new Promise<void>(() => {});
            return super.token(host, account);
          }
        }
        const github = new HangingGitHub();
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", text: "直した" }])],
          { pulls, now: later, stopNoticeTimeoutMs: 30, github },
        );
        pulls.feedbackList = [inline()];
        await service.checkPullRequests();
        // 作り直した実装が承認待ちに戻るところまで進める（返信は、その次の処理）
        for (let i = 0; i < 10 && service.get(id)?.task.gate?.submission !== 2; i++) {
          await service.runNext(id);
        }
        github.hang = true;
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(0);
        const result = posted(service, id)[0]?.results[0];
        expect(result).toMatchObject({ remarkId: "implement-1-1", key: "review_comment:501" });
        expect(result?.failed).toBeDefined();
        expect(service.queuedTaskIds()).toEqual([]);
        activity.close();
      });

      it("投稿の後・記録の前に止まり、その間にプロジェクトの GitHub のアカウントが変わっても、前のアカウントの返信を見つけて重ねず、PR の指摘の取り込みからも除く", async () => {
        const pulls = new FakePulls();
        const projects = projectsWithAccount();
        const github = new FakeGitHub({ me: "ghp_secret", other: "ghp_other" });
        let clock = later();
        const made = await toImplement(
          [
            implement("# 実装の説明"),
            decided(),
            redone([
              { remarkId: "implement-1-1", status: "addressed", text: "直した" },
              { remarkId: "implement-1-2", status: "addressed", text: "足した" },
            ]),
          ],
          { pulls, now: () => clock, projects, github },
        );
        const { activity, service, id } = made;
        await drain(service);
        pulls.feedbackList = [inline(), comment()];
        await service.checkPullRequests();
        const append = activity.append.bind(activity);
        let failOnce = true;
        activity.append = (entry) => {
          if (failOnce && entry.events.some((e) => e.event.type === "RemarkRepliesPosted")) {
            failOnce = false;
            throw new Error("disk full");
          }
          return append(entry);
        };
        await expect(drain(service)).rejects.toThrow("disk full");
        clock += 61_000;
        // 投稿の前に、返信に使うアカウントを記録している
        const started = (service.get(id)?.activity ?? []).flatMap((e) =>
          e.type === "RemarkRepliesStarted" ? [e.payload] : [],
        );
        expect(started).toEqual([{ step: "implement", submission: 2, number: 7, account: "me" }]);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(1);
        // 止まっている間に、プロジェクトの GitHub のアカウントを変える
        const current = projects.get("default");
        projects.put("default", {
          name: current?.name ?? "",
          targets: current?.targets ?? [],
          githubAccounts: { "github.com": "other" },
        });
        await drain(service);
        // 前のアカウント（me）の返信を、投稿済みとして使う（other で重ねて投稿しない）
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(1);
        expect(posted(service, id)[0]?.results.map((r) => [r.remarkId, r.url])).toEqual([
          ["implement-1-1", `${pr}#discussion_r9001`],
          ["implement-1-2", "https://github.com/acme/app/issues/7#issuecomment-1"],
        ]);
        expect(service.get(id)?.task.remarkReplyAccounts).toEqual(["me", "other"]);
        // PR の指摘を読むときに、返信に使ったアカウントを渡す（前のアカウントの返信を、指摘として取り込まない）
        await service.checkPullRequests();
        expect(pulls.feedbackAccounts.at(-1)).toBe("other");
        expect(pulls.feedbackNoticeAccounts.at(-1)).toEqual(["me", "other"]);
        activity.close();
      });

      it("期限を超えた後の残りの指摘でも、読んである一覧に投稿済みの返信があれば、失敗にせずに、その返信を記録する", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pulls = new FakePulls();
        pulls.replyGate = new Promise<void>(() => {});
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", text: "直した" },
              { remarkId: "implement-1-2", text: "足した" },
              { remarkId: "implement-1-3", text: "変えた" },
            ]),
          ],
          { pulls, now: later, stopNoticeTimeoutMs: 30 },
        );
        pulls.feedbackList = [inline(), comment(401), comment(402)];
        await service.checkPullRequests();
        // 前に、投稿の後・記録の前に止まった分（2件目の返信は、GitHub にある）
        pulls.issueComments.push({
          repo: "https://github.com/acme/app",
          token: "ghp_secret",
          number: 7,
          body: `<!-- sacty-reply:${id}:implement-1-2:2 -->\n足した`,
        });
        await drain(service);
        const results = posted(service, id)[0]?.results ?? [];
        expect(results.map((r) => [r.remarkId, r.url, r.failed !== undefined])).toEqual([
          ["implement-1-1", undefined, true],
          ["implement-1-2", "https://github.com/acme/app/issues/7#issuecomment-1", false],
          ["implement-1-3", undefined, true],
        ]);
        expect(prComments(pulls)).toHaveLength(1);
        warn.mockRestore();
        activity.close();
      });

      const deferredOf = (service: TaskService, id: string) =>
        (service.get(id)?.activity ?? []).flatMap((e) =>
          e.type === "RemarkRepliesDeferred" ? [e.payload] : [],
        );
      const three = () =>
        redone([
          { remarkId: "implement-1-1", status: "addressed", text: "直した" },
          { remarkId: "implement-1-2", status: "addressed", text: "足した" },
          { remarkId: "implement-1-3", status: "addressed", text: "変えた" },
        ]);
      /** 作り直した実装が承認待ちに戻るところまで進める（返信は、その次の処理）。 */
      const toSecondGate = async (service: TaskService, id: string) => {
        for (let i = 0; i < 10 && service.get(id)?.task.gate?.submission !== 2; i++) {
          await service.runNext(id);
        }
      };

      it("GitHub のレート制限に当たったら、そこで投稿を止めて（行への返信を PR のコメントに回さない）、失敗として記録せずに残し、GitHub が示した期限が明けてからやり直す。待ちの間、タスクは止めず、実行待ちにも出さない（PBI-356）", async () => {
        const pulls = new FakePulls();
        let now = later();
        const file = join(dir, "github-rate-limits.json");
        const { activity, service, id } = await toImplementGate([decided(), three()], {
          pulls,
          now: () => now,
          rateLimits: new GitHubRateLimitStore(file),
        });
        pulls.feedbackList = [inline(), comment(401), comment(402)];
        await service.checkPullRequests();
        await toSecondGate(service, id);
        pulls.rateLimited = true;
        pulls.rateLimitRetryAfterMs = 5 * 60_000;
        await drain(service);
        // 1件目で制限に当たる：PR のコメントに回さず、残りは投稿を試みない。失敗としても記録しない
        expect(pulls.reviewReplies).toHaveLength(0);
        expect(prComments(pulls)).toHaveLength(0);
        expect(pulls.replyPostTimes).toHaveLength(1);
        expect(posted(service, id)).toHaveLength(0);
        // 待っていることが、作業履歴に残る（まだ返信していない件数・次に試せる時刻・連続して制限に当たった回数）
        expect(deferredOf(service, id)).toEqual([
          {
            step: "implement",
            submission: 2,
            number: 7,
            waiting: 3,
            until: new Date(now + 5 * 60_000).toISOString(),
            attempt: 1,
          },
        ]);
        // 待ちは、ホストとアカウントごとに保存する（デーモンを起動し直しても、読み直せる）
        expect(new GitHubRateLimitStore(file).get("github.com:me")).toEqual({
          until: now + 5 * 60_000,
          streak: 1,
        });
        // タスクは止めない。待ちの間は、実行待ちに出さず（実行の枠を取らない）、始めさせても投稿しない
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        expect(service.queuedTaskIds()).toEqual([]);
        pulls.rateLimited = false;
        now += 4 * 60_000;
        expect(service.queuedTaskIds()).toEqual([]);
        await service.runNext(id);
        expect(pulls.replyPostTimes).toHaveLength(1);
        // 期限が明けたら、実行待ちに戻り、残していた返信を、すべて投稿する
        now += 61_000;
        expect(service.queuedTaskIds()).toEqual([id]);
        await drain(service);
        expect(pulls.reviewReplies).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(2);
        const records = posted(service, id);
        expect(records).toHaveLength(1);
        // やり直した結果であることが、記録に残る
        expect(records[0]?.retried).toBe(true);
        expect(records[0]?.results.map((r) => [r.remarkId, r.failed])).toEqual([
          ["implement-1-1", undefined],
          ["implement-1-2", undefined],
          ["implement-1-3", undefined],
        ]);
        expect(service.get(id)?.task.remarkRepliesDeferred).toBeUndefined();
        // 投稿できたら、待ちを消す。その後は、重ねて投稿しない
        expect(new GitHubRateLimitStore(file).get("github.com:me")).toBeUndefined();
        expect(service.queuedTaskIds()).toEqual([]);
        activity.close();
      });

      it("保存してあった待ち（デーモンを起動し直した後）の期限の前には、投稿も一覧の読み取りもしない。期限が明けたら投稿する（PBI-356）", async () => {
        const pulls = new FakePulls();
        let now = later();
        const rateLimits = new GitHubRateLimitStore();
        rateLimits.set("github.com:me", { until: now + 10 * 60_000, streak: 2 });
        const { activity, service, id } = await toImplementGate([decided(), three()], {
          pulls,
          now: () => now,
          rateLimits,
        });
        pulls.feedbackList = [inline(), comment(401), comment(402)];
        await service.checkPullRequests();
        await toSecondGate(service, id);
        const listed = pulls.reviewListCalls;
        await drain(service);
        await service.runNext(id);
        expect(pulls.replyPostTimes).toHaveLength(0);
        expect(pulls.reviewListCalls).toBe(listed);
        expect(posted(service, id)).toHaveLength(0);
        expect(service.queuedTaskIds()).toEqual([]);
        now += 10 * 60_000 + 1;
        expect(service.queuedTaskIds()).toEqual([id]);
        await drain(service);
        expect(pulls.replyPostTimes).toHaveLength(3);
        expect(posted(service, id)[0]?.results.every((r) => r.failed === undefined)).toBe(true);
        // 自分は制限に当たっていない（待っていただけ）ので、やり直しの印は付かない
        expect(posted(service, id)[0]?.retried).toBeUndefined();
        activity.close();
      });

      it("GitHub が待ちを示さないときは 1 分待ち、制限が続くたびに待ちを倍にする。やり直しの回数の上限を超えたら、あきらめて、残りを失敗として記録する（記録は、件数の上限ごとに分かれる）（PBI-356）", async () => {
        const pulls = new FakePulls();
        let now = later();
        const { activity, service, id } = await toImplementGate([decided(), three()], {
          pulls,
          now: () => now,
          remarkRepliesPerRecord: 2,
          remarkReplyRateLimit: { maxRetries: 2 },
        });
        pulls.feedbackList = [inline(), comment(401), comment(402)];
        await service.checkPullRequests();
        await toSecondGate(service, id);
        pulls.rateLimited = true;
        const start = now;
        await drain(service);
        // 1回目の制限：1分待つ
        now += 59_000;
        expect(service.queuedTaskIds()).toEqual([]);
        now += 2_000;
        expect(service.queuedTaskIds()).toEqual([id]);
        // やり直し 1 回目も制限：2分待つ
        const second = now;
        await drain(service);
        now += 119_000;
        expect(service.queuedTaskIds()).toEqual([]);
        now += 2_000;
        expect(service.queuedTaskIds()).toEqual([id]);
        expect(
          deferredOf(service, id).map((d) => [d.attempt, d.waiting, Date.parse(d.until)]),
        ).toEqual([
          [1, 3, start + 60_000],
          [2, 3, second + 120_000],
        ]);
        expect(posted(service, id)).toHaveLength(0);
        // やり直し 2 回目も制限：上限（2回）を超えたので、あきらめて、失敗として記録する
        await drain(service);
        expect(pulls.replyPostTimes).toHaveLength(3);
        expect(deferredOf(service, id)).toHaveLength(2);
        const records = posted(service, id);
        expect(records.map((p) => p.results.map((r) => r.remarkId))).toEqual([
          ["implement-1-1", "implement-1-2"],
          ["implement-1-3"],
        ]);
        expect(records.every((p) => p.retried === true)).toBe(true);
        expect(records.flatMap((p) => p.results).map((r) => r.failed)).toEqual(
          Array.from({ length: 3 }, () => ({
            code: "github.replyGaveUpAfterRateLimit",
            params: { attempts: 3 },
          })),
        );
        // あきらめた後は、時間がたっても、やり直さない。タスクは止まっていない
        now += 24 * 3_600_000;
        expect(service.queuedTaskIds()).toEqual([]);
        await drain(service);
        expect(pulls.replyPostTimes).toHaveLength(3);
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        activity.close();
      });

      it("倍にしていく待ちは 1 時間で頭打ちにする。GitHub が示した待ちは、それより長くても守る（1 日まで）（PBI-356）", async () => {
        const { activity, service } = await toImplementGate([], { now: later });
        const internals = service as unknown as {
          noteRemarkReplyLimited(key: string, error: unknown): void;
          rateLimits: GitHubRateLimitStore;
        };
        const key = "github.com:me";
        internals.rateLimits.set(key, { until: later() - 1, streak: 9 });
        internals.noteRemarkReplyLimited(key, rateLimitError());
        expect(internals.rateLimits.get(key)).toEqual({ until: later() + 3_600_000, streak: 10 });
        // すでに待ちの間に、同じ制限をもう一度見ても（一覧の読み取りなど）、回数は増やさず、期限は遅い方にする
        internals.noteRemarkReplyLimited(key, rateLimitError(60_000));
        expect(internals.rateLimits.get(key)).toEqual({ until: later() + 3_600_000, streak: 10 });
        internals.noteRemarkReplyLimited(key, rateLimitError(2 * 3_600_000));
        expect(internals.rateLimits.get(key)).toEqual({
          until: later() + 2 * 3_600_000,
          streak: 10,
        });
        // GitHub が示した待ちは、1 日で頭打ちにする（読み違えた・壊れた値で、返信をいつまでも止めない）
        internals.noteRemarkReplyLimited(key, rateLimitError(1e30));
        expect(internals.rateLimits.get(key)).toEqual({
          until: later() + 24 * 3_600_000,
          streak: 10,
        });
        activity.close();
      });

      it("途中の指摘で制限に当たったら、投稿できた分だけを記録し、残りを後でやり直す（投稿できた指摘に、重ねて投稿しない）（PBI-356）", async () => {
        class LimitedAfterOne extends FakePulls {
          limitFrom = 1;
          override async commentIssue(input: Parameters<FakePulls["commentIssue"]>[0]) {
            if (input.body.startsWith("<!-- sacty-reply:")) {
              this.rateLimited = prComments(this).length >= this.limitFrom;
            }
            try {
              return await super.commentIssue(input);
            } finally {
              this.rateLimited = false;
            }
          }
        }
        const pulls = new LimitedAfterOne();
        let now = later();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", text: "直した" },
              { remarkId: "implement-1-2", text: "足した" },
              { remarkId: "implement-1-3", text: "変えた" },
            ]),
          ],
          { pulls, now: () => now },
        );
        pulls.feedbackList = [comment(401), comment(402), comment(403)];
        await service.checkPullRequests();
        await drain(service);
        expect(prComments(pulls)).toHaveLength(1);
        expect(
          posted(service, id).map((p) => [p.retried, p.results.map((r) => r.remarkId)]),
        ).toEqual([[undefined, ["implement-1-1"]]]);
        expect(deferredOf(service, id).map((d) => [d.waiting, d.attempt])).toEqual([[2, 1]]);
        pulls.limitFrom = 99;
        now += 61_000;
        await drain(service);
        expect(prComments(pulls)).toHaveLength(3);
        expect(
          posted(service, id).map((p) => [p.retried, p.results.map((r) => r.remarkId)]),
        ).toEqual([
          [undefined, ["implement-1-1"]],
          [true, ["implement-1-2", "implement-1-3"]],
        ]);
        activity.close();
      });

      it("本文を読めず、ヘッダーだけが制限を示す答えも、レート制限として扱う。投稿されたかが分からない返信の探し直しが制限に当たったら、その指摘は失敗を残し（重ねて投稿しない）、残りは後でやり直す", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        // 行への返信が、ヘッダーだけの制限で断られる：宛先の拒否ではないので、PR のコメントに回さない
        const pulls = new FakePulls();
        pulls.rateLimited = true;
        pulls.rateLimitRetryAfterMs = 5 * 60_000;
        pulls.rateLimitDetail = "";
        const a = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", text: "直した" },
              { remarkId: "implement-1-2", text: "足した" },
            ]),
          ],
          { pulls, now: later },
        );
        pulls.feedbackList = [inline(), comment()];
        await a.service.checkPullRequests();
        await drain(a.service);
        expect(prComments(pulls)).toHaveLength(0);
        expect(pulls.replyPostTimes).toHaveLength(1);
        expect(posted(a.service, a.id)).toHaveLength(0);
        expect(deferredOf(a.service, a.id).map((d) => [d.waiting, d.until])).toEqual([
          [2, new Date(later() + 5 * 60_000).toISOString()],
        ]);
        a.activity.close();
        rmSync(dbPath, { force: true });

        // 返信の答えを受け取れず、探し直しがレート制限に当たる（返信は GitHub にある）
        const lost = new FakePulls();
        lost.replyAnswerLost = "socket hang up";
        lost.reviewListRateLimitedAfter = 1;
        const b = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", text: "直した" },
              { remarkId: "implement-1-2", text: "足した" },
            ]),
          ],
          { pulls: lost, now: later },
        );
        lost.feedbackList = [inline(), comment()];
        await b.service.checkPullRequests();
        await drain(b.service);
        // PR のコメントを重ねず、残りの指摘にも投稿しない。投稿されたかが分からない指摘は、やり直さずに失敗を残す
        expect(lost.reviewReplies).toHaveLength(1);
        expect(prComments(lost)).toHaveLength(0);
        expect(posted(b.service, b.id).map((p) => p.results)).toEqual([
          [{ remarkId: "implement-1-1", key: "review_comment:501", failed: "socket hang up" }],
        ]);
        expect(deferredOf(b.service, b.id).map((d) => [d.waiting, d.attempt])).toEqual([[1, 1]]);
        expect(b.service.queuedTaskIds()).toEqual([]);
        warn.mockRestore();
        b.activity.close();
      });

      it("初めの一覧の読み取りがレート制限に当たったら、どの指摘も投稿せず、記録もせずに残して、後でやり直す（PBI-356）", async () => {
        const listing = new FakePulls();
        listing.reviewListRateLimitedAfter = 0;
        let now = later();
        const { activity, service, id } = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", text: "直した" }])],
          { pulls: listing, now: () => now },
        );
        listing.feedbackList = [inline()];
        await service.checkPullRequests();
        await drain(service);
        expect(listing.replyPostTimes).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(0);
        expect(deferredOf(service, id).map((d) => [d.waiting, d.attempt])).toEqual([[1, 1]]);
        expect(service.queuedTaskIds()).toEqual([]);
        delete listing.reviewListRateLimitedAfter;
        now += 61_000;
        await drain(service);
        expect(listing.reviewReplies).toHaveLength(1);
        expect(posted(service, id).map((p) => [p.retried, p.results[0]?.failed])).toEqual([
          [true, undefined],
        ]);
        activity.close();
      });

      it("行への返信が時間切れになり、その探し直しがレート制限に当たったら、時間切れの扱いを優先する：残りは、やり直さずに、失敗として記録する（PBI-356）", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pulls = new FakePulls();
        pulls.replyGate = new Promise<void>(() => {});
        pulls.reviewListRateLimitedAfter = 1;
        let now = later();
        const { activity, service, id } = await toImplementGate([decided(), three()], {
          pulls,
          now: () => now,
          stopNoticeTimeoutMs: 30,
        });
        pulls.feedbackList = [inline(), comment(401), comment(402)];
        await service.checkPullRequests();
        await drain(service);
        expect(pulls.replyPostTimes).toHaveLength(1);
        expect(deferredOf(service, id)).toHaveLength(0);
        const results = posted(service, id).flatMap((p) => p.results);
        expect(results.map((r) => r.remarkId)).toEqual([
          "implement-1-1",
          "implement-1-2",
          "implement-1-3",
        ]);
        expect(results.slice(1).map((r) => r.failed)).toEqual([
          { code: "github.replySkippedAfterTimeout" },
          { code: "github.replySkippedAfterTimeout" },
        ]);
        expect(results[0]?.failed).toBeDefined();
        // 制限の期限が明けても、やり直さない
        pulls.replyGate = undefined;
        delete pulls.reviewListRateLimitedAfter;
        now += 2 * 3_600_000;
        expect(service.queuedTaskIds()).toEqual([]);
        await drain(service);
        expect(pulls.replyPostTimes).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(0);
        warn.mockRestore();
        activity.close();
      });

      it("時間切れで投稿を止めた後に、結果を記録できなくても、やり直しで残りを投稿しない（分けた記録は、まとめて書く。止めたことを覚えておく）", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const pulls = new FakePulls();
        pulls.replyGate = new Promise<void>(() => {});
        let now = later();
        const { activity, service, id } = await toImplementGate([decided(), three()], {
          pulls,
          now: () => now,
          remarkRepliesPerRecord: 2,
          stopNoticeTimeoutMs: 30,
        });
        pulls.feedbackList = [inline(), comment(401), comment(402)];
        await service.checkPullRequests();
        await toSecondGate(service, id);
        // 結果の記録を、一度だけ失敗させる
        const append = activity.append.bind(activity);
        let failOnce = true;
        activity.append = (entry) => {
          if (failOnce && entry.events.some((e) => e.event.type === "RemarkRepliesPosted")) {
            failOnce = false;
            throw new Error("disk full");
          }
          return append(entry);
        };
        await expect(drain(service)).rejects.toThrow("disk full");
        // 分けた記録の、どれも書かれていない（途中まで書けて、残りを失うことが無い）
        expect(posted(service, id)).toHaveLength(0);
        expect(pulls.replyPostTimes).toHaveLength(1);
        // GitHub が答えるようになった後にやり直しても、残りを投稿せずに、失敗として記録する。
        // やり直しの一覧の読み取りが、レート制限に当たっても同じ（止めたことを失って、後で投稿し直さない。PBI-356）
        pulls.replyGate = undefined;
        pulls.reviewListRateLimitedAfter = pulls.reviewListCalls;
        now += 61_000;
        await drain(service);
        delete pulls.reviewListRateLimitedAfter;
        expect(deferredOf(service, id)).toHaveLength(0);
        now += 2 * 3_600_000;
        await drain(service);
        expect(pulls.replyPostTimes).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id).map((p) => p.results.map((r) => r.remarkId))).toEqual([
          ["implement-1-1", "implement-1-2"],
          ["implement-1-3"],
        ]);
        expect(
          posted(service, id)
            .flatMap((p) => p.results)
            .every((r) => r.failed !== undefined),
        ).toBe(true);
        expect(service.queuedTaskIds()).toEqual([]);
        warn.mockRestore();
        activity.close();
      });

      it("時間切れで投稿を止めた直後に一時停止されて、結果を記録せずに抜けても、再開した後に、残りを投稿せずに失敗として記録する", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const gate = Promise.withResolvers<void>();
        class StoppingPulls extends FakePulls {
          override async replyToReviewComment(
            input: Parameters<FakePulls["replyToReviewComment"]>[0],
          ) {
            // 1件目の返信の通信の間に、一時停止を求められる。その後、答えが返らない
            this.replyPostTimes.push(Date.now());
            this.replyStarted.resolve();
            await gate.promise;
            await new Promise<void>(() => {});
            return super.replyToReviewComment(input);
          }
        }
        const pulls = new StoppingPulls();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", text: "直した" },
              { remarkId: "implement-1-2", text: "足した" },
            ]),
          ],
          { pulls, now: later, stopNoticeTimeoutMs: 40 },
        );
        pulls.feedbackList = [inline(), comment()];
        await service.checkPullRequests();
        const running = drain(service);
        await pulls.replyStarted.promise;
        const pausing = service.pause(id);
        gate.resolve();
        await pausing;
        await running;
        // 止めたことを見つけたが、一時停止されたので、結果は記録していない
        expect(service.get(id)?.task.status).toBe("paused");
        expect(posted(service, id)).toHaveLength(0);
        // 再開した後も、残りを投稿せずに、失敗として記録する
        service.resume(id, {});
        await drain(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        expect(pulls.replyPostTimes).toHaveLength(1);
        expect(prComments(pulls)).toHaveLength(0);
        expect(posted(service, id)).toHaveLength(1);
        expect(posted(service, id)[0]?.results.map((r) => [r.remarkId, r.failed])).toEqual([
          ["implement-1-1", { code: "github.replySkippedAfterTimeout" }],
          ["implement-1-2", { code: "github.replySkippedAfterTimeout" }],
        ]);
        expect(service.queuedTaskIds()).toEqual([]);
        warn.mockRestore();
        activity.close();
      });

      it("投稿を止めたことは、その工程・その PR・その提出だけのもの：工程だけ・PR だけ・提出回だけが違う記憶は、持ち越さない", async () => {
        // 前に、別の工程・別の PR・別の提出で、投稿を止めたまま、結果を記録できなかった（どれか1つだけが違う）
        for (const other of [{ step: "requirements" }, { number: 99 }, { submission: 1 }]) {
          const pulls = new FakePulls();
          const { activity, service, id } = await toImplementGate(
            [decided(), redone([{ remarkId: "implement-1-1", text: "直した" }])],
            { pulls, now: later },
          );
          pulls.feedbackList = [comment()];
          await service.checkPullRequests();
          const stopped = (
            service as unknown as { remarkReplyStopped: Map<string, Record<string, unknown>> }
          ).remarkReplyStopped;
          const same = { step: "implement", number: 7, submission: 2 };
          stopped.set(id, { ...same, ...other });
          await drain(service);
          // 実装の PR #7 の提出 2 の返信は、止めずに投稿する。合わない記憶は消す
          expect(prComments(pulls)).toHaveLength(1);
          expect(posted(service, id)[0]?.results[0]?.failed).toBeUndefined();
          expect(stopped.has(id)).toBe(false);
          activity.close();
          rmSync(dbPath, { force: true });
        }
      });

      it("同じアカウントの先の投稿がレート制限に当たったら、順番を待っていた投稿も、その後に頼まれた投稿も（ほかのタスクのものも）、期限が明けるまで投稿しない（PBI-356）", async () => {
        let now = later();
        const { activity, service } = await toImplementGate([], { now: () => now });
        type Sent<T> = { value: T } | "limited" | "skipped";
        const internals = service as unknown as {
          remarkReplyPost<T>(
            key: string,
            still: () => boolean,
            work: () => Promise<T>,
          ): Promise<Sent<T>>;
          noteRemarkReplyLimited(key: string, error: unknown): void;
          rateLimits: GitHubRateLimitStore;
        };
        const post = <T>(work: () => Promise<T>, key = "github.com:me") =>
          internals.remarkReplyPost(key, () => true, work);
        const gate = Promise.withResolvers<void>();
        const ran: string[] = [];
        // 先の投稿が通信している間に、同じアカウントの投稿が2件、順番を待つ
        const first = post(async () => {
          await gate.promise;
          throw rateLimitError();
        });
        const second = post(async () => {
          ran.push("second");
          return 2;
        });
        const third = post(async () => {
          ran.push("third");
          return 3;
        });
        gate.resolve();
        await expect(first).rejects.toThrow();
        expect(await second).toBe("limited");
        expect(await third).toBe("limited");
        // 制限の後に頼まれた投稿も、期限までは投稿しない
        expect(await post(async () => ran.push("fourth"))).toBe("limited");
        expect(ran).toEqual([]);
        // ほかのアカウントの投稿は、止めない
        expect(await post(async () => 9, "github.com:other")).toEqual({ value: 9 });
        // 期限が明けたら、投稿する。投稿できたら、待ちを消す
        now += 60_001;
        expect(await post(async () => 4)).toEqual({ value: 4 });
        expect(internals.rateLimits.get("github.com:me")).toBeUndefined();
        // 投稿の通信の間に、同じアカウントのほかの問い合わせ（ほかのタスクの一覧の読み取りなど）が制限に当たったら、
        // 投稿ができても、その新しい待ちは消さない
        const sending = Promise.withResolvers<void>();
        const sendingStarted = Promise.withResolvers<void>();
        const racing = post(async () => {
          sendingStarted.resolve();
          await sending.promise;
          return 6;
        });
        await sendingStarted.promise;
        internals.noteRemarkReplyLimited("github.com:me", rateLimitError(5 * 60_000));
        sending.resolve();
        expect(await racing).toEqual({ value: 6 });
        expect(internals.rateLimits.get("github.com:me")).toEqual({
          until: now + 5 * 60_000,
          streak: 1,
        });
        expect(await post(async () => 7)).toBe("limited");
        now += 5 * 60_000 + 1;
        // 投稿の間隔を待っている間に、ほかの問い合わせ（一覧の読み取りなど）が制限に当たったら、待った後にも投稿しない
        const spaced = await toImplementGate([], { now: later, remarkReplyIntervalMs: 60 });
        const spacedInternals = spaced.service as unknown as typeof internals;
        const postSpaced = <T>(work: () => Promise<T>) =>
          spacedInternals.remarkReplyPost("github.com:me", () => true, work);
        // 投稿の間隔（60 ミリ秒）の待ちは、時計を差し替えて進める（本物の時計では、負荷が高いと、制限を記録する前に待ちが明ける）
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
        try {
          expect(await postSpaced(async () => 1)).toEqual({ value: 1 });
          const waiting = postSpaced(async () => {
            ran.push("waiting");
            return 2;
          });
          await vi.advanceTimersByTimeAsync(10);
          // 間隔を待っている最中（待ちのタイマーが 1 つある）
          expect(vi.getTimerCount()).toBe(1);
          spacedInternals.noteRemarkReplyLimited("github.com:me", rateLimitError());
          await vi.advanceTimersByTimeAsync(60);
          expect(await waiting).toBe("limited");
          expect(ran).toEqual([]);
        } finally {
          vi.useRealTimers();
        }
        spaced.activity.close();
        // 制限でない失敗は、順番を待っている投稿を止めない
        const failing = post(async () => {
          throw new Error("500");
        });
        const next = post(async () => 5);
        await expect(failing).rejects.toThrow("500");
        expect(await next).toEqual({ value: 5 });
        activity.close();
      });

      it("続けて投稿するときは、投稿と投稿の間をあける", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            decided(),
            redone([
              { remarkId: "implement-1-1", text: "直した" },
              { remarkId: "implement-1-2", text: "足した" },
              { remarkId: "implement-1-3", text: "変えた" },
            ]),
          ],
          { pulls, now: later, remarkReplyIntervalMs: 80 },
        );
        pulls.feedbackList = [inline(), comment(401), comment(402)];
        await service.checkPullRequests();
        await drain(service);
        expect(posted(service, id)[0]?.results).toHaveLength(3);
        const [first = 0, second = 0, third = 0] = pulls.replyPostTimes;
        expect(pulls.replyPostTimes).toHaveLength(3);
        // タイマーの誤差を見込んで、間隔の 9 割以上あいていることを確かめる
        expect(second - first).toBeGreaterThanOrEqual(72);
        expect(third - second).toBeGreaterThanOrEqual(72);
        activity.close();
        rmSync(dbPath, { force: true });
        // 行への返信を断られた後の、PR のコメントにも、同じ間隔をあける
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        const rejecting = new FakePulls();
        rejecting.replyRejected = 404;
        const b = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", text: "直した" }])],
          { pulls: rejecting, now: later, remarkReplyIntervalMs: 80 },
        );
        rejecting.feedbackList = [inline()];
        await b.service.checkPullRequests();
        await drain(b.service);
        expect(prComments(rejecting)).toHaveLength(1);
        const [tried = 0, fallback = 0] = rejecting.replyPostTimes;
        expect(rejecting.replyPostTimes).toHaveLength(2);
        expect(fallback - tried).toBeGreaterThanOrEqual(72);
        warn.mockRestore();
        b.activity.close();
      });

      it("sacty の返信は、PR の指摘として取り込み直さない（取り込みには、返信を含める指定を渡さない）", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [decided(), redone([{ remarkId: "implement-1-1", status: "addressed", text: "直した" }])],
          { pulls, now: later },
        );
        pulls.feedbackList = [comment()];
        await service.checkPullRequests();
        await drain(service);
        const body = prComments(pulls)[0]?.body ?? "";
        expect(body).toContain("<!-- sacty-reply:");
        // GitHub が返す一覧に、sacty の返信が入っている
        pulls.feedbackList = [
          comment(),
          item("comment:9001", { author: "me", at: new Date(later()).toISOString(), body }),
        ];
        await service.checkPullRequests();
        await drain(service);
        const task = service.get(id)?.task;
        expect(task?.status).toBe("awaiting_approval");
        expect(task?.gate).toEqual({ step: "implement", submission: 2 });
        expect(task?.importedFeedback).toEqual(["comment:401"]);
        expect(task?.pendingReview).toBeUndefined();
        expect(pulls.feedbackIncludeSactyReplies.every((v) => v === undefined)).toBe(true);
        activity.close();
      });
    });

    it("戻し先の判断文（戻し先と指摘の読み方）を、その判断で始まった作り直しの実行の指示に渡す。人の指摘の原文も渡す（PBI-300。S14）", async () => {
      const pulls = new FakePulls();
      const reason =
        "決定を変える：前の指摘で簡単にするため削った R-2・R-3 を元に戻せという意味に読める";
      const { activity, service, executor, id } = await toImplementGate(
        [rework("requirements", reason), out("# 要求要件 v3")],
        { pulls, now: later },
      );
      pulls.feedbackList = [item("comment:300", { body: "さっきの指摘は無しにしてください" })];
      await service.checkPullRequests();
      const before = executor.calls.length;
      await service.runNext(id);
      const prompt = promptOf(executor, before);
      expect(prompt).toContain("[requirements-2-1] さっきの指摘は無しにしてください");
      expect(prompt).toContain("--- 戻し先の判断（今回の指摘 requirements-2-1 の読み方");
      expect(prompt).toContain(
        `{"guardianJudgment":{"target":"requirements","decided":true,"reason":"${reason}"}}`,
      );
      expect(prompt).toContain("判断した側の解釈で、人間が書いたものではありません");
      expect(prompt).toContain("指摘の原文（人間の指摘を最優先）に従う");
      // 判断を渡した実行が提出されたあとの再実行には、判断を渡さない
      expect(service.get(id)?.task.remarks.at(-1)?.submittedIn).toBeDefined();
      activity.close();
    });

    it("実装の PR には sacty の質問が無いので、質問への答えとして判断されても、軽い直しにせず、答えの扱いを記録しない（PBI-302 B1）", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate(
        [
          out(
            `\`\`\`json\n${JSON.stringify({ "sacty-rework": { target: "implement", cause: "question_answer", answer: "as_recommended", reason: "実装で直せる" } })}\n\`\`\``,
          ),
          implement("# 直した"),
        ],
        { pulls, now: later },
      );
      pulls.feedbackList = [item("comment:500", { body: "推奨どおりで" })];
      await service.checkPullRequests();
      const change = service.get(id)?.activity.findLast((e) => e.type === "ChangesRequested");
      expect(change?.payload).toMatchObject({ step: "implement", cause: "question_answer" });
      expect(change?.payload).not.toHaveProperty("answer");
      const before = executor.calls.length;
      await service.runNext(id);
      expect(promptOf(executor, before)).not.toContain("答えの反映だけ");
      activity.close();
    });

    it("戻し先を判断できなかったときも、判断できなかった理由を実装の実行の指示に渡す。判断できたときの文は出さない（PBI-300。S14 の台本3）", async () => {
      const pulls = new FakePulls();
      const reason = "付け先の候補が2つあり、どちらを指すのか読み取れない";
      const { activity, service, executor, id } = await toImplementGate(
        [rework("undecidable", reason), implement("# 直した")],
        { pulls, now: later },
      );
      pulls.feedbackList = [item("comment:301", { body: "ここに部品を置いてください" })];
      await service.checkPullRequests();
      const before = executor.calls.length;
      await service.runNext(id);
      const prompt = promptOf(executor, before);
      expect(prompt).toContain("[implement-1-1] ここに部品を置いてください");
      expect(prompt).toContain(`{"guardianJudgment":{"decided":false,"reason":"${reason}"}}`);
      expect(prompt).toContain("読み取れなかった点を、推測で大きく変えない");
      expect(prompt).toContain("読み取れなかったことは、変更が要らない理由にならない");
      expect(prompt).not.toContain("この判断で、この工程");
      activity.close();
    });

    it("ゴールガーディアンの実行が失敗したときは、判断文を渡さない。実装の実行の指示は今までと同じ（PBI-300）", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate(
        [
          { kind: "failed", reason: "usage_limit", message: "session limit" },
          implement("# 直した"),
        ],
        { pulls, now: later },
      );
      pulls.feedbackList = [item("comment:302")];
      await service.checkPullRequests();
      const before = executor.calls.length;
      await service.runNext(id);
      const prompt = promptOf(executor, before);
      expect(prompt).toContain("[implement-1-1] 全体として、失敗時のログが足りない");
      expect(prompt).not.toContain("guardianJudgment");
      expect(prompt).not.toContain("--- 戻し先の判断（今回の指摘");
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

    it("差し戻しが 4 回目でも、PR の指摘を取り込んで差し戻す。エスカレーションにしない（PBI-414）", async () => {
      const pulls = new FakePulls();
      const round = (n: number) => [implement(`# 実装の説明 v${n + 1}`)];
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
      expect(task?.status).toBe("queued");
      expect(task?.escalation).toBeUndefined();
      expect(task?.remarks.at(-1)).toMatchObject({
        id: "implement-4-1",
        text: "全体として、失敗時のログが足りない",
        // 元の PR のコメント（対応を、その場所に返信する。PBI-352）
        origin: { key: "comment:401", number: 7 },
      });
      const last = service.get(id)?.activity.findLast((e) => e.type === "ChangesRequested");
      expect(last?.type === "ChangesRequested" && last.payload.overLimit).toBe(false);
      expect(types(service, id)).not.toContain("TaskEscalated");
      activity.close();
    });

    describe("静かな時間は、人の指摘のいちばん新しいものから数える。sacty のレビューの投稿は待たない（PBI-425）", () => {
      const aiAt = (clock: { now: number }, key: string, agoMs: number, pulls: FakePulls) =>
        item(key, {
          kind: "review",
          author: "me",
          body: "AI: 戻り値の確認が無い",
          at: new Date(clock.now - agoMs).toISOString(),
          source: "sacty_review",
          commit: pulls.prInfo.headSha,
        });
      const humanAt = (clock: { now: number }, key: string, agoMs: number) =>
        item(key, { at: new Date(clock.now - agoMs).toISOString() });
      const imported = (service: TaskService, id: string) =>
        (service.get(id)?.activity ?? []).flatMap((e) =>
          e.type === "PullRequestReviewImported" ? [e] : [],
        );
      async function gate() {
        const clock = { now: Date.parse(at) };
        const pulls = new FakePulls();
        const made = await toImplementGate([rework("implement", "実装で直せる"), implement()], {
          pulls,
          now: () => clock.now,
        });
        return { ...made, pulls, clock };
      }

      it("まだ取り込んでいないものが sacty のレビューの投稿だけなら、10 秒前の投稿でも、その確認で取り込む（actor は sacty）", async () => {
        const { activity, service, pulls, clock, id } = await gate();
        pulls.feedbackList = [aiAt(clock, "review:1", 10_000, pulls)];
        await service.checkPullRequests();
        const events = imported(service, id);
        expect(events).toHaveLength(1);
        expect(events[0]?.actor).toBe("sacty");
        expect(events[0]?.payload.items.map((i) => i.key)).toEqual(["review:1"]);
        activity.close();
      });

      it("人の指摘が混ざっていて、そのいちばん新しいものから 2 分たっていなければ、sacty のレビューも一緒に待ち、2 分を過ぎた確認で 1 件にまとめて取り込む", async () => {
        const { activity, service, pulls, clock, id } = await gate();
        const start = clock.now;
        pulls.feedbackList = [
          humanAt(clock, "comment:1", 30_000),
          aiAt(clock, "review:1", 10_000, pulls),
        ];
        await service.checkPullRequests();
        expect(imported(service, id)).toHaveLength(0);
        // 人のコメントから 2 分たつ手前
        clock.now = start + FEEDBACK_QUIET_MS - 30_000 - 1;
        await service.checkPullRequests();
        expect(imported(service, id)).toHaveLength(0);
        // 2 分を過ぎた
        clock.now = start + FEEDBACK_QUIET_MS - 30_000 + 1;
        await service.checkPullRequests();
        const events = imported(service, id);
        expect(events).toHaveLength(1);
        expect(events[0]?.actor).toBe("person");
        expect(events[0]?.payload.items.map((i) => i.key)).toEqual(["comment:1", "review:1"]);
        activity.close();
      });

      it("人の指摘が 2 分より古く、sacty のレビューだけが新しいときは、待たずに両方を 1 件で取り込む（actor は person）", async () => {
        const { activity, service, pulls, clock, id } = await gate();
        pulls.feedbackList = [
          humanAt(clock, "comment:1", 3 * 60_000),
          aiAt(clock, "review:1", 10_000, pulls),
        ];
        await service.checkPullRequests();
        const events = imported(service, id);
        expect(events).toHaveLength(1);
        expect(events[0]?.actor).toBe("person");
        expect(events[0]?.payload.items.map((i) => i.key)).toEqual(["comment:1", "review:1"]);
        activity.close();
      });
    });

    describe("sacty 自身の AI のレビューの指摘と、人の指摘の区別（PBI-275）", () => {
      /** sacty のレビューのタスクが投稿した、AI のレビュー（印は FakePulls が付ける代わりに、直接付ける）。 */
      const aiItem = (
        pulls: FakePulls,
        key: string,
        patch: Partial<PullRequestFeedback> = {},
      ): PullRequestFeedback =>
        item(key, {
          kind: "review",
          author: "me",
          body: "AI: 戻り値の確認が無い",
          source: "sacty_review",
          commit: pulls.prInfo.headSha,
          ...patch,
        });

      it("AI のレビューの指摘は、人の指摘と分けて取り込み・差し戻し、人の差し戻しの回数に数えない。人の指摘は、何回目でも差し戻す", async () => {
        const pulls = new FakePulls();
        const ids: string[] = [];
        const cycle = () => {
          ids.push(`implement-${ids.length + 1}-1`);
          return [rework("implement", "実装で直せる"), implement("# 実装")];
        };
        const humanCycle = () => {
          ids.push(`implement-${ids.length + 1}-1`);
          return [implement("# 実装")];
        };
        const { activity, service, executor, id } = await toImplementGate(
          [
            // AI のレビューの指摘だけの差し戻し 4 回（上限は 3 回）
            ...cycle(),
            ...cycle(),
            ...cycle(),
            ...cycle(),
            // 人の差し戻し 3 回
            ...humanCycle(),
            ...humanCycle(),
            ...humanCycle(),
            // 4 回目の人の指摘は、判断して差し戻す（エスカレーションにならない）
            rework("implement", "実装で直せる"),
          ],
          { pulls, now: later },
        );
        for (let n = 1; n <= 4; n++) {
          pulls.feedbackList = [...pulls.feedbackList, aiItem(pulls, `review:${n}`)];
          await service.checkPullRequests();
          expect(service.get(id)?.task.status, `AI ${n}`).toBe("queued");
          await drain(service);
          expect(service.get(id)?.task.gate?.step, `AI ${n}`).toBe("implement");
        }
        let task = service.get(id)?.task;
        if (!task) throw new Error("no task");
        // 4 回続けても、エスカレーションにならず、人の差し戻しの回数は 0
        expect(types(service, id)).not.toContain("TaskEscalated");
        expect(changeRounds(task, "implement")).toBe(0);
        expect(lastChangeRound(task, "implement")).toBe(4);
        expect(
          task.remarks.filter((r) => r.step === "implement").map((r) => [r.id, r.source]),
        ).toEqual([1, 2, 3, 4].map((n) => [`implement-${n}-1`, "sacty_review"]));
        const events = service.get(id)?.activity ?? [];
        const importedEvents = events.filter((e) => e.type === "PullRequestReviewImported");
        expect(importedEvents.map((e) => e.actor)).toEqual(["sacty", "sacty", "sacty", "sacty"]);
        expect(
          importedEvents.every(
            (e) =>
              e.type === "PullRequestReviewImported" &&
              e.payload.items.every((i) => i.source === "sacty_review"),
          ),
        ).toBe(true);
        // 差し戻しは人の操作にしない
        const changes = events.filter(
          (e) => e.type === "ChangesRequested" && e.payload.step === "implement",
        );
        expect(changes.map((e) => e.actor)).toEqual(["sacty", "sacty", "sacty", "sacty"]);
        // AI のレビューの指摘だけの回は、ゴールガーディアンの見逃しの数え方には影響しない（原因を決めなければ数えない）
        // 人の差し戻しは、これまでどおり数える。AI のレビューの回が間に入っても、人の回数は人の指摘の回だけを数える
        for (let n = 1; n <= 3; n++) {
          service.requestChanges(id, {
            step: "implement",
            submission: service.get(id)?.task.gate?.submission ?? 0,
            comments: [`人の指摘${n}`],
          });
          await drain(service);
          expect(service.get(id)?.task.gate?.step, `人 ${n}`).toBe("implement");
        }
        task = service.get(id)?.task;
        if (!task) throw new Error("no task");
        expect(changeRounds(task, "implement")).toBe(3);
        expect(lastChangeRound(task, "implement")).toBe(7);
        expect(
          task.remarks.filter((r) => !r.source && r.step === "implement").map((r) => r.id),
        ).toEqual(["implement-5-1", "implement-6-1", "implement-7-1"]);
        // 4 回目の人の指摘も、エスカレーションにならず差し戻す（回の番号は AI のレビューの回の続き。PBI-414）
        pulls.feedbackList = [...pulls.feedbackList, item("comment:900")];
        await service.checkPullRequests();
        task = service.get(id)?.task;
        expect(task?.status).toBe("queued");
        expect(task?.escalation).toBeUndefined();
        expect(task?.remarks.at(-1)).toMatchObject({
          id: "implement-8-1",
          text: "全体として、失敗時のログが足りない",
          // 元の PR のコメント（対応を、その場所に返信する。PBI-352）
          origin: { key: "comment:900", number: 7 },
        });
        expect(types(service, id)).not.toContain("TaskEscalated");
        expect(changeRounds(task as Task, "implement")).toBe(4);
        expect(executor.calls.length).toBeGreaterThan(0);
        activity.close();
      });

      it("人の差し戻しが 3 回に達した後も、AI のレビューの指摘だけなら取り込み、人の回数は増えない。続く人の指摘も差し戻す", async () => {
        const pulls = new FakePulls();
        const ids: string[] = [];
        const humanCycle = () => {
          ids.push(`implement-${ids.length + 1}-1`);
          return [implement("# 実装")];
        };
        const { activity, service, id } = await toImplementGate(
          [
            // 人の差し戻し 3 回（上限）
            ...humanCycle(),
            ...humanCycle(),
            ...humanCycle(),
            // AI のレビューの指摘だけの差し戻し 1 回
            rework("implement", "実装で直せる"),
            ...humanCycle(),
            // そのあとの人の指摘も、判断して差し戻す
            rework("implement", "実装で直せる"),
          ],
          { pulls, now: later },
        );
        for (let n = 1; n <= 3; n++) {
          service.requestChanges(id, {
            step: "implement",
            submission: service.get(id)?.task.gate?.submission ?? 0,
            comments: [`人の指摘${n}`],
          });
          await drain(service);
          expect(service.get(id)?.task.gate?.step, `人 ${n}`).toBe("implement");
        }
        let task = service.get(id)?.task;
        if (!task) throw new Error("no task");
        expect(changeRounds(task, "implement")).toBe(3);
        // 3 回に達していても、AI のレビューの指摘だけなら、取り込んで作り直す
        pulls.feedbackList = [aiItem(pulls, "review:1")];
        await service.checkPullRequests();
        expect(service.get(id)?.task.status).toBe("queued");
        await drain(service);
        task = service.get(id)?.task;
        if (!task) throw new Error("no task");
        expect(task.gate?.step).toBe("implement");
        expect(types(service, id)).not.toContain("TaskEscalated");
        // 人の回数は 3 のまま（AI のレビューの回は数えない）
        expect(changeRounds(task, "implement")).toBe(3);
        expect(lastChangeRound(task, "implement")).toBe(4);
        expect(task.remarks.find((r) => r.id === "implement-4-1")?.source).toBe("sacty_review");
        // 続く人の指摘も、エスカレーションにならず差し戻す
        pulls.feedbackList = [...pulls.feedbackList, item("comment:901")];
        await service.checkPullRequests();
        task = service.get(id)?.task;
        expect(task?.status).toBe("queued");
        expect(task?.escalation).toBeUndefined();
        expect(task?.remarks.at(-1)).toMatchObject({
          id: "implement-5-1",
          text: "全体として、失敗時のログが足りない",
          // 元の PR のコメント（対応を、その場所に返信する。PBI-352）
          origin: { key: "comment:901", number: 7 },
        });
        activity.close();
      });

      it("人の指摘と AI のレビューの指摘が混ざった取り込みは、指摘の出どころを残し、判断とやり直しに分けて渡し、人の差し戻しに数える", async () => {
        const pulls = new FakePulls();
        const { activity, service, executor, id } = await toImplementGate(
          [rework("implement", "実装で直せる"), implement("# 実装 v2")],
          { pulls, now: later },
        );
        pulls.feedbackList = [
          item("comment:1", { body: "さっきの指摘は無しで。ただし過去の時間は困る" }),
          aiItem(pulls, "review:2"),
        ];
        const before = executor.calls.length;
        await service.checkPullRequests();
        const events = service.get(id)?.activity ?? [];
        const imported = events.find((e) => e.type === "PullRequestReviewImported");
        // 人の指摘が混ざっていれば、人の操作として記録する。出どころは指摘ごとに残る
        expect(imported?.actor).toBe("person");
        expect(
          imported?.type === "PullRequestReviewImported" && imported.payload.items,
        ).toMatchObject([{ key: "comment:1" }, { key: "review:2", source: "sacty_review" }]);
        const sources =
          imported?.type === "PullRequestReviewImported"
            ? imported.payload.items.map((i) => i.source)
            : [];
        expect(sources).toEqual([undefined, "sacty_review"]);
        expect(service.get(id)?.task.remarks.map((r) => [r.id, r.source])).toContainEqual([
          "implement-1-2",
          "sacty_review",
        ]);
        const change = events.findLast((e) => e.type === "ChangesRequested");
        expect(change?.actor).toBe("person");
        // 戻し先の判断（ゴールガーディアン）に、人の指摘と AI のレビューの指摘を分けて渡す
        const judge = promptOf(executor, before);
        const humanAt = judge.indexOf("--- PR への人間の指摘 ---");
        const aiAt = judge.indexOf("--- PR への AI のレビューの指摘 ---");
        expect(judge.slice(humanAt, aiAt)).toContain("さっきの指摘は無しで");
        expect(judge.slice(humanAt, aiAt)).not.toContain("AI: 戻り値の確認が無い");
        expect(judge.slice(aiAt)).toContain("AI: 戻り値の確認が無い");
        await drain(service);
        // やり直す実装にも分けて渡す
        const rerun = promptOf(executor, before + 1);
        const humanRerun = rerun.indexOf("--- 人間の指摘（すべてに対応してください");
        const aiRerun = rerun.indexOf("--- AI のレビューの指摘（すべてに対応してください");
        expect(humanRerun).toBeGreaterThan(0);
        expect(aiRerun).toBeGreaterThan(humanRerun);
        expect(rerun.slice(humanRerun, aiRerun)).toContain("さっきの指摘は無しで");
        expect(rerun.slice(humanRerun, aiRerun)).toContain("人間の指摘（この節）を指します");
        expect(rerun.slice(aiRerun)).toContain("AI: 戻り値の確認が無い");
        // 人の指摘が混ざった回は、人の差し戻しの回数に数える
        const task = service.get(id)?.task;
        if (!task) throw new Error("no task");
        expect(changeRounds(task, "implement")).toBe(1);
        activity.close();
      });

      it("対象にした head が PR の今の head と違う AI のレビューは、取り込まずに捨てて理由を残し、二度と取り込まない。人の指摘は取り込む", async () => {
        const pulls = new FakePulls();
        const current = pulls.prInfo.headSha;
        const old = "o".repeat(40);
        const { activity, service, executor, id } = await toImplementGate(
          [rework("implement", "実装で直せる"), implement("# 実装 v2")],
          { pulls, now: later },
        );
        // 古い head へのレビューだけ：捨てて、ゴールガーディアンも動かさず、承認待ちのまま
        pulls.feedbackList = [
          aiItem(pulls, "review:1", { commit: old }),
          aiItem(pulls, "review_comment:2", {
            kind: "review_comment",
            path: "src/a.ts",
            line: 3,
            commit: old,
          }),
        ];
        const before = executor.calls.length;
        await service.checkPullRequests();
        let events = service.get(id)?.activity ?? [];
        const discarded = events.filter((e) => e.type === "PullRequestReviewDiscarded");
        expect(discarded).toHaveLength(1);
        expect(discarded[0]?.actor).toBe("sacty");
        expect(discarded[0]?.payload).toMatchObject({
          number: 7,
          reason: "stale_head",
          head: current,
          items: [
            { key: "review:1", author: "me", commit: old },
            { key: "review_comment:2", commit: old },
          ],
        });
        let task = service.get(id)?.task;
        expect(task?.importedFeedback).toEqual(["review:1", "review_comment:2"]);
        expect(task?.status).toBe("awaiting_approval");
        expect(task?.remarks.filter((r) => r.step === "implement")).toEqual([]);
        expect(executor.calls.length).toBe(before);
        expect(types(service, id)).not.toContain("PullRequestReviewImported");
        // 次の確認でも、捨てたものを数え直さない
        await service.checkPullRequests();
        expect(types(service, id).filter((t) => t === "PullRequestReviewDiscarded")).toHaveLength(
          1,
        );
        // 古い head へのレビューと、人の指摘が一緒に届けば、人の指摘だけ取り込む
        pulls.feedbackList = [
          ...pulls.feedbackList,
          aiItem(pulls, "review:3", { commit: old }),
          item("comment:4"),
        ];
        await service.checkPullRequests();
        events = service.get(id)?.activity ?? [];
        const imported = events.filter((e) => e.type === "PullRequestReviewImported");
        expect(imported.map((e) => e.payload)).toMatchObject([{ items: [{ key: "comment:4" }] }]);
        expect(imported[0]?.actor).toBe("person");
        expect(service.get(id)?.task.importedFeedback).toEqual([
          "review:1",
          "review_comment:2",
          "review:3",
          "comment:4",
        ]);
        await drain(service);
        // 今の head へのレビュー（短い SHA でも、大文字小文字が違っても同じ）は取り込む
        task = service.get(id)?.task;
        expect(task?.status).toBe("awaiting_approval");
        pulls.feedbackList = [
          ...pulls.feedbackList,
          aiItem(pulls, "review:5", { commit: current.slice(0, 7).toUpperCase() }),
        ];
        await service.checkPullRequests();
        expect(
          service
            .get(id)
            ?.activity.filter((e) => e.type === "PullRequestReviewImported")
            .map((e) => e.type === "PullRequestReviewImported" && e.payload.items[0]?.key),
        ).toEqual(["comment:4", "review:5"]);
        activity.close();
      });

      it("捨てた AI のレビューの指摘は、要点とリンクを残して人に届ける（0・1・複数件）。作り直しには取り込まず、人が今の head に当てはまると判断して差し戻せば、人の指摘として届く（PBI-291）", async () => {
        const pulls = new FakePulls();
        const old = "o".repeat(40);
        const { activity, service, executor, id } = await toImplementGate(
          [implement("# 実装 v2")],
          { pulls, now: later },
        );
        const shown = () => {
          const task = service.get(id)?.task;
          if (!task) throw new Error("no task");
          return discardedAiReviews(task);
        };
        const before = executor.calls.length;
        // 0件：古い head のレビューが無ければ、届けるものは無い（今の head のレビューは取り込むので、捨てない）
        expect(shown()).toBeUndefined();
        // 1件：理由（古い head と今の head）と、指摘の要点・リンクが届く。目印と見出しは要点に入れない
        pulls.feedbackList = [
          aiItem(pulls, "review:1", {
            commit: old,
            url: "https://github.com/acme/app/pull/7#pullrequestreview-1",
            body: "<!-- note -->\n## sacty のレビュー\n\n@me 判定：提案あり\n\nREADME の API の表に新しい API を足す",
          }),
        ];
        await service.checkPullRequests();
        expect(shown()).toMatchObject({
          number: 7,
          head: pulls.prInfo.headSha,
          items: [
            {
              key: "review:1",
              commit: old,
              url: "https://github.com/acme/app/pull/7#pullrequestreview-1",
              summary: "@me 判定：提案あり README の API の表に新しい API を足す",
            },
          ],
        });
        // 複数件：行へのコメントにはファイルと行が付き、長い本文は切る。次の確認で重ねて数えない
        pulls.feedbackList = [
          ...pulls.feedbackList,
          aiItem(pulls, "review_comment:2", {
            kind: "review_comment",
            path: "src/a.ts",
            line: 3,
            commit: old,
            body: "長い指摘 ".repeat(200),
          }),
        ];
        await service.checkPullRequests();
        await service.checkPullRequests();
        const items = shown()?.items ?? [];
        expect(items.map((i) => i.key)).toEqual(["review:1", "review_comment:2"]);
        expect(items[1]?.summary?.startsWith("src/a.ts:3：長い指摘")).toBe(true);
        expect(items[1]?.summary?.length).toBeLessThanOrEqual(400);
        expect(items[1]?.summary?.endsWith("…")).toBe(true);
        // 捨てた指摘を、自動で作り直しに取り込まない（最初の確認の前に数えた実行の回数から、増えていない）
        expect(executor.calls.length).toBe(before);
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        expect(service.get(id)?.task.remarks.filter((r) => r.step === "implement")).toEqual([]);
        // 人が今の head に当てはまると判断して、差し戻す：人の指摘として届き、差し戻しの回数に数える
        service.requestChanges(id, {
          step: "implement",
          submission: service.get(id)?.task.gate?.submission ?? 0,
          comments: ["README の API の表に新しい API を足してください"],
        });
        await drain(service);
        const task = service.get(id)?.task;
        if (!task) throw new Error("no task");
        const remark = task.remarks.findLast((r) => r.step === "implement");
        expect(remark?.text).toBe("README の API の表に新しい API を足してください");
        expect(remark?.source).toBeUndefined();
        expect(changeRounds(task, "implement")).toBe(1);
        const change = service.get(id)?.activity.findLast((e) => e.type === "ChangesRequested");
        expect(change?.actor).toBe("person");
        const rerun = promptOf(executor, before);
        expect(rerun).toContain("README の API の表に新しい API を足してください");
        expect(rerun).not.toContain("--- AI のレビューの指摘");
        activity.close();
      });

      it("対象にしたコミットを読めない AI のレビューは取り込む。PR の head を読めなければ、AI のレビューだけ取り込まずに次の確認へ回し、人の指摘は取り込む", async () => {
        const pulls = new FakePulls();
        const { activity, service, id } = await toImplementGate(
          [
            rework("implement", "実装で直せる"),
            implement("# 実装 v2"),
            rework("implement", "実装で直せる"),
            implement("# 実装 v3"),
          ],
          { pulls, now: later },
        );
        // PR の状態の確認（見守り）は読めるが、指摘の取り込みの中で head を読み直すときだけ読めない
        const status = pulls.status.bind(pulls);
        let flaky = true;
        let reads = 0;
        pulls.status = async (input) => {
          reads++;
          if (flaky && reads % 2 === 0) throw new Error("boom");
          return status(input);
        };
        pulls.feedbackList = [aiItem(pulls, "review:1", { commit: "o".repeat(40) })];
        await service.checkPullRequests();
        expect(service.get(id)?.task.importedFeedback).toEqual([]);
        expect(types(service, id)).not.toContain("PullRequestReviewDiscarded");
        expect(types(service, id)).not.toContain("PullRequestReviewImported");
        // 人の指摘と一緒なら、人の指摘だけ取り込む。AI のレビューは残る
        pulls.feedbackList = [...pulls.feedbackList, item("comment:2")];
        await service.checkPullRequests();
        expect(service.get(id)?.task.importedFeedback).toEqual(["comment:2"]);
        flaky = false;
        await drain(service);
        // 読めるようになれば、AI のレビューを確かめ直す（古い head なので捨てる）
        await service.checkPullRequests();
        expect(types(service, id).filter((t) => t === "PullRequestReviewDiscarded")).toHaveLength(
          1,
        );
        expect(service.get(id)?.task.importedFeedback).toEqual(["comment:2", "review:1"]);
        // コミットが分からない AI のレビューは、古いかどうか分からないので取り込む
        pulls.feedbackList = [
          ...pulls.feedbackList,
          aiItem(pulls, "review:3", { commit: undefined }),
        ];
        await service.checkPullRequests();
        expect(service.get(id)?.task.remarks.at(-1)?.source).toBe("sacty_review");
        activity.close();
      });
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

    /** ゴールガーディアンの戻し先の判断（sacty-rework）を実行しているときに、PR の状態を変える（人が GitHub で操作した）。 */
    function changeDuringJudgement(
      executor: FakeExecutor,
      change: () => void,
    ): { judged: () => number } {
      let judged = 0;
      executor.respond = (invocation) => {
        if (invocation.command.join(" ").includes("sacty-rework")) {
          judged += 1;
          change();
        }
        return undefined;
      };
      return { judged: () => judged };
    }

    const changeCount = (service: TaskService, id: string) =>
      service.get(id)?.activity.filter((e) => e.type === "ChangesRequested").length ?? 0;

    it("戻し先を判断している間に人が PR をマージしたら、差し戻さずにマージ（人の承認）として記録する", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate(
        [rework("design", "観点が足りない")],
        { pulls, now: later },
      );
      const commit = service.get(id)?.task.pullRequest?.commit;
      const changes = changeCount(service, id);
      const spy = changeDuringJudgement(executor, () => {
        pulls.state = { state: "merged", mergedBy: "reviewer", headSha: commit };
      });
      pulls.feedbackList = [item("comment:701")];
      await service.checkPullRequests();
      expect(spy.judged()).toBe(1);
      const events = service.get(id)?.activity ?? [];
      // 取り込んだ指摘と判断は残し、差し戻し（と見逃し）は記録しない。同じ確認の中で、マージを承認として記録する
      expect(events.slice(-4).map((e) => [e.type, e.actor])).toEqual([
        ["PullRequestReviewImported", "person"],
        ["ReworkJudged", "agent"],
        ["PullRequestMerged", "person"],
        ["StepApproved", "person"],
      ]);
      expect(changeCount(service, id)).toBe(changes);
      expect(events.slice(-4).some((e) => e.type === "GuardianMissed")).toBe(false);
      const task = service.get(id)?.task;
      expect(task?.steps.every((st) => st.state === "done")).toBe(true);
      expect(task?.status).toBe("idle");
      expect(task?.pendingReview).toBeUndefined();
      expect(task?.importedFeedback).toEqual(["comment:701"]);
      // 完了したタスクは、もう確かめない・判断し直さない
      await service.checkPullRequests();
      expect(spy.judged()).toBe(1);
      expect(service.get(id)?.activity.filter((e) => e.type === "PullRequestMerged")).toHaveLength(
        1,
      );
      activity.close();
    });

    it("戻し先を判断している間に PR がマージされず開いたままなら、今までどおり差し戻す", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate(
        [rework("design", "観点が足りない", "guardian_missed"), design],
        { pulls, now: later },
      );
      const spy = changeDuringJudgement(executor, () => {});
      pulls.feedbackList = [item("comment:702")];
      const checked = pulls.checked.length;
      await service.checkPullRequests();
      expect(spy.judged()).toBe(1);
      // 差し戻す前に、PR の状態を読み直す（確認の 1 回と合わせて 2 回）
      expect(pulls.checked.length - checked).toBe(2);
      const events = service.get(id)?.activity ?? [];
      expect(events.slice(-2).map((e) => e.type)).toEqual(["ReworkJudged", "ChangesRequested"]);
      expect(events.some((e) => e.type === "PullRequestMerged")).toBe(false);
      expect(service.get(id)?.task.status).toBe("queued");
      activity.close();
    });

    it("戻し先を判断している間に PR がマージされずに閉じられたら、差し戻さずに閉じられたことを記録して人の判断を待つ。開き直されたら、判断し直さずに差し戻す", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await toImplementGate(
        [rework("design", "観点が足りない"), design],
        { pulls, now: later },
      );
      const changes = changeCount(service, id);
      const spy = changeDuringJudgement(executor, () => {
        pulls.state = { state: "closed" };
      });
      pulls.feedbackList = [item("comment:703")];
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      expect(events.slice(-3).map((e) => [e.type, e.actor])).toEqual([
        ["PullRequestReviewImported", "person"],
        ["ReworkJudged", "agent"],
        ["PullRequestClosed", "sacty"],
      ]);
      expect(changeCount(service, id)).toBe(changes);
      expect(service.get(id)?.task).toMatchObject({
        status: "awaiting_approval",
        pullRequestState: "closed",
      });
      // 閉じられている間は、判断した指摘を差し戻しに反映しない
      await service.checkPullRequests();
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      // 開き直されたら、記録した判断のまま差し戻す（判断し直さない）
      pulls.state = { state: "open" };
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(spy.judged()).toBe(1);
      expect(changeCount(service, id)).toBe(changes + 1);
      expect(service.get(id)?.task.status).toBe("queued");
      expect(service.get(id)?.task.prRework).toMatchObject({ target: "design", decided: true });
      activity.close();
    });

    it("判断を記録した後、差し戻す直前の読み直しでマージされていたら、差し戻さずにマージとして記録する", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await judgedThenStopped(pulls);
      const changes = changeCount(service, id);
      // 確認の読みは開いたまま、差し戻す直前の読み直しでマージされている
      const status = pulls.status.bind(pulls);
      let reads = 0;
      pulls.status = async (input) => {
        reads += 1;
        if (reads === 2) pulls.state = { state: "merged", mergedBy: "reviewer" };
        return status(input);
      };
      await service.checkPullRequests();
      expect(executor.calls).toHaveLength(0);
      const events = service.get(id)?.activity ?? [];
      expect(events.slice(-2).map((e) => e.type)).toEqual(["PullRequestMerged", "StepApproved"]);
      expect(changeCount(service, id)).toBe(changes);
      expect(reads).toBe(3);
      activity.close();
    });

    it("同じ確認の中の読み直しは1回だけ。開き・閉じ・開き・閉じと変わり続けても、読みは4回で終わり、判断を残して、次の確認で続ける", async () => {
      const pulls = new FakePulls();
      const { activity, service, executor, id } = await judgedThenStopped(pulls);
      const changes = changeCount(service, id);
      // 読むたびに、PR の状態が開き・閉じ・開き・閉じと変わる（5回目からは開いたまま）
      const order: PullRequestStatus["state"][] = ["open", "closed", "open", "closed"];
      const status = pulls.status.bind(pulls);
      let reads = 0;
      pulls.status = async (input) => {
        pulls.state = { state: order[reads] ?? "open" };
        reads += 1;
        return status(input);
      };
      await service.checkPullRequests();
      // 確認の1回と、読み直しの1回（それぞれが、差し戻す前の読み直しを含む）で、4回。それ以上は読まない
      expect(reads).toBe(4);
      expect(executor.calls).toHaveLength(0);
      expect(changeCount(service, id)).toBe(changes);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      // 記録した判断は、差し戻しに反映されないまま残っている
      expect(
        service
          .get(id)
          ?.activity.slice(-1)
          .map((e) => e.type),
      ).toEqual(["ReworkJudged"]);
      // 次の確認で続ける：開いたままなら、記録した判断のまま差し戻す（判断し直さない）
      await service.checkPullRequests();
      expect(executor.calls).toHaveLength(0);
      expect(changeCount(service, id)).toBe(changes + 1);
      expect(service.get(id)?.task.status).toBe("queued");
      expect(service.get(id)?.task.prRework).toMatchObject({ target: "design", decided: true });
      activity.close();
    });

    it("取り込んだ指摘の判断を記録した後、再起動の前にマージされていたら、差し戻さずにマージとして記録する", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await judgedThenStopped(pulls);
      const changes = changeCount(service, id);
      pulls.state = { state: "merged", mergedBy: "reviewer" };
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      expect(events.slice(-2).map((e) => e.type)).toEqual(["PullRequestMerged", "StepApproved"]);
      expect(changeCount(service, id)).toBe(changes);
      activity.close();
    });

    it("差し戻す直前の読み直しの間に人が差し戻したら、重ねて差し戻さない", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await judgedThenStopped(pulls);
      const changes = changeCount(service, id);
      const status = pulls.status.bind(pulls);
      let reads = 0;
      pulls.status = async (input) => {
        reads += 1;
        if (reads === 2) {
          service.requestChanges(id, {
            step: "implement",
            submission: service.get(id)?.task.gate?.submission ?? 1,
            target: "implement",
            comments: ["人の指摘"],
          });
        }
        return status(input);
      };
      await service.checkPullRequests();
      expect(changeCount(service, id)).toBe(changes + 1);
      activity.close();
    });

    it("差し戻す直前の PR の状態を読めなければ、差し戻さずに、次の確認でやり直す", async () => {
      const pulls = new FakePulls();
      const { activity, service, id } = await judgedThenStopped(pulls);
      const changes = changeCount(service, id);
      const status = pulls.status.bind(pulls);
      let reads = 0;
      pulls.status = async (input) => {
        reads += 1;
        if (reads === 2) throw new Error("502 Bad Gateway");
        return status(input);
      };
      await service.checkPullRequests();
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(changeCount(service, id)).toBe(changes);
      await service.checkPullRequests();
      expect(service.get(id)?.task.status).toBe("queued");
      expect(changeCount(service, id)).toBe(changes + 1);
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

    describe("承認待ち（PR のマージ待ち）での一時停止（PBI-301）", () => {
      /** 実装の承認待ちで止める。 */
      const pausedAtGate = async (outcomes: AgentOutcome[] = []) => {
        const pulls = new FakePulls();
        const made = await toImplementGate(outcomes, { pulls, now: later });
        const calls = made.executor.calls.length;
        const paused = await made.service.pause(made.id);
        return { ...made, pulls, paused, calls };
      };

      it("実装の PR のマージ待ちで一時停止できる。承認ゲートと PR はそのままで、エージェントは動かさず、二重には止められない", async () => {
        const { activity, service, executor, paused, calls, id } = await pausedAtGate();
        expect(paused.status).toBe("paused");
        expect(paused.pausedReason).toBe("manual");
        expect(paused.gate).toEqual({ step: "implement", submission: 1 });
        expect(paused.pullRequestState).toBe("open");
        expect(types(service, id).at(-1)).toBe("TaskPaused");
        expect(executor.calls).toHaveLength(calls);
        await expect(service.pause(id)).rejects.toMatchObject({
          messages: [{ code: "pause.alreadyPaused" }],
        });
        activity.close();
      });

      it("止めている間に届いた指摘は未反映として残し、再開すると承認待ちに戻って、通常の取り込みで戻し先を判断して差し戻す", async () => {
        const { activity, service, executor, pulls, id } = await pausedAtGate([
          rework("implement", "実装で直せる"),
        ]);
        pulls.feedbackList = [item("comment:p1")];
        await service.checkPullRequests();
        const held = service.get(id)?.task;
        expect(held?.status).toBe("paused");
        expect(held && heldReview(held)?.keys).toEqual(["comment:p1"]);
        // 止めている間は、判断も差し戻しもしない
        expect(types(service, id)).not.toContain("ReworkJudged");
        const resumed = service.resume(id, {});
        expect(resumed.status).toBe("awaiting_approval");
        expect(resumed.gate).toEqual({ step: "implement", submission: 1 });
        const calls = executor.calls.length;
        // 再開したあとの確認が、残した指摘を反映する（止めていた間に起きたことを取り込む）
        await service.checkPullRequests();
        expect(executor.calls.length).toBe(calls + 1);
        expect(types(service, id).slice(-2)).toEqual(["ReworkJudged", "ChangesRequested"]);
        const task = service.get(id)?.task;
        expect(task?.status).toBe("queued");
        expect(task?.remarks.at(-1)).toMatchObject({
          step: "implement",
          text: "全体として、失敗時のログが足りない",
        });
        activity.close();
      });

      it("止めている間に PR がマージされたら、作り直しの間と同じ記録でマージを承認として進める。再開は要らない", async () => {
        const { activity, service, executor, pulls, calls, id } = await pausedAtGate();
        pulls.state = {
          state: "merged",
          mergedBy: "reviewer",
          headSha: service.get(id)?.task.pullRequest?.commit,
        };
        await service.checkPullRequests();
        const stopped = (service.get(id)?.activity ?? []).find(
          (e) => e.type === "ReworkStoppedByMerge",
        );
        expect(stopped?.payload).toMatchObject({ was: "paused" });
        const task = service.get(id)?.task as Task;
        expect(task.pullRequestState).toBe("merged");
        expect(task.approved.implement?.submission).toBe(1);
        expect(task.pausedReason).toBeUndefined();
        expect(executor.calls).toHaveLength(calls);
        activity.close();
      });

      it("止めている間は、承認も差し戻しもできない。再開してから行う", async () => {
        const { activity, service, id } = await pausedAtGate();
        expect(() => service.approve(id, { step: "implement", submission: 1 })).toThrow();
        expect(() =>
          service.requestChanges(id, { step: "implement", submission: 1, comments: ["直して"] }),
        ).toThrow();
        service.resume(id, {});
        expect(
          service.requestChanges(id, { step: "implement", submission: 1, comments: ["直して"] })
            .status,
        ).toBe("queued");
        activity.close();
      });

      it("止めている間の PR を、60 秒ごとの確認が承認待ちの PR として二重に扱わない（マージも指摘も1回だけ）", async () => {
        const { activity, service, pulls, id } = await pausedAtGate();
        pulls.feedbackList = [item("comment:q1")];
        await service.checkPullRequests();
        await service.checkPullRequests();
        const imported = (service.get(id)?.activity ?? []).filter(
          (e) => e.type === "PullRequestReviewImported",
        );
        expect(imported).toHaveLength(1);
        activity.close();
      });
    });

    describe("一時停止の間に届いた PR の指摘を、再開のときに取り込む（PBI-279）", () => {
      const aiItem = (
        pulls: FakePulls,
        key: string,
        patch: Partial<PullRequestFeedback> = {},
      ): PullRequestFeedback =>
        item(key, {
          kind: "review",
          author: "me",
          body: "AI: 戻り値の確認が無い",
          source: "sacty_review",
          commit: pulls.prInfo.headSha,
          ...patch,
        });
      /** 実装の承認待ちから、指摘（implement-1-1）で実装に差し戻す。 */
      const sendBack = (service: TaskService, id: string) =>
        service.requestChanges(id, {
          step: "implement",
          submission: 1,
          comments: ["最初の指摘"],
        });
      /** 実装の作り直しを一時停止するところまで進める（PR は開いたまま）。 */
      const pausedRework = async (
        outcomes: AgentOutcome[],
        options: { pulls?: FakePulls } = {},
      ) => {
        const pulls = options.pulls ?? new FakePulls();
        const made = await toImplementGate(outcomes, { pulls, now: later });
        sendBack(made.service, made.id);
        await made.service.pause(made.id);
        expect(made.service.get(made.id)?.task.status).toBe("paused");
        return { ...made, pulls };
      };
      const heldEvents = (service: TaskService, id: string) =>
        (service.get(id)?.activity ?? []).filter(
          (e) => e.type === "PullRequestReviewImported" && e.payload.held,
        );

      it("一時停止の間に届いた人の指摘を、未反映として残す。差し戻さず、エージェントも動かさず、同じ指摘を読み直さない", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([]);
        const calls = executor.calls.length;
        pulls.feedbackList = [item("comment:1")];
        await service.checkPullRequests();
        const task = service.get(id)?.task;
        expect(task?.status).toBe("paused");
        expect(task && heldReview(task)).toEqual({
          keys: ["comment:1"],
          remarks: ["全体として、失敗時のログが足りない"],
          // 作者でも組織の関係者でもない投稿は、出どころを確かめられない人（PBI-452）
          unverified: [0],
        });
        expect(task?.importedFeedback).toEqual(["comment:1"]);
        // 差し戻しにも判断にもなっていない（指摘は最初の差し戻しの 1 件のまま）
        expect(task?.remarks.map((r) => r.id)).toEqual(["requirements-1-1", "implement-1-1"]);
        expect(types(service, id)).not.toContain("ReworkJudged");
        expect(executor.calls).toHaveLength(calls);
        const events = heldEvents(service, id);
        expect(events.map((e) => e.actor)).toEqual(["person"]);
        expect(events[0]?.payload).toMatchObject({
          number: 7,
          held: true,
          items: [{ key: "comment:1", author: "reviewer" }],
        });
        // 続く確認は、同じ指摘を読み直さない。続けて届いた指摘は足す
        await service.checkPullRequests();
        expect(heldEvents(service, id)).toHaveLength(1);
        pulls.feedbackList = [item("comment:1"), item("comment:2", { body: "テストも足して" })];
        await service.checkPullRequests();
        const held = service.get(id)?.task && heldReview(service.get(id)?.task as Task);
        expect(held?.keys).toEqual(["comment:1", "comment:2"]);
        expect(held?.remarks).toEqual(["全体として、失敗時のログが足りない", "テストも足して"]);
        expect(heldEvents(service, id)).toHaveLength(2);
        activity.close();
      });

      it("一時停止の間に届いた 2000 文字を超える指摘も、再開後のやり直しの指示に、末尾まで入る（PBI-413）", async () => {
        const pulls = new FakePulls();
        const { activity, service, executor, id } = await toImplementGate(
          [
            { kind: "failed", reason: "error", message: "EACCES: permission denied" },
            rework("implement", "実装で直せる"),
            implement("# v3"),
          ],
          { pulls, now: later },
        );
        sendBack(service, id);
        await service.runNext(id);
        const tail = "【末尾 TAIL-HELD】";
        const body = `${"い".repeat(4_000)}${tail}`;
        pulls.feedbackList = [item("comment:long", { body })];
        await service.checkPullRequests();
        const calls = executor.calls.length;
        service.resume(id, {});
        await service.runNext(id);
        const requested = service.get(id)?.activity.findLast((e) => e.type === "ChangesRequested");
        expect(JSON.stringify(requested?.payload)).toContain(tail);
        await drain(service);
        expect(promptOf(executor, calls + 1)).toContain(tail);
        activity.close();
      });

      it("再開すると、止まった工程を走り直す前に、ゴールガーディアンが戻し先を判断し、指摘で実装を作り直す（S16。エラーで止まったタスク）", async () => {
        const pulls = new FakePulls();
        const { activity, service, executor, id } = await toImplementGate(
          [
            // 差し戻した実装が、エラーで止まる
            { kind: "failed", reason: "error", message: "EACCES: permission denied" },
            // 再開のあと：戻し先の判断 → 指摘を渡した実装
            rework("implement", "実装で直せる"),
            implement("# v3"),
          ],
          { pulls, now: later },
        );
        sendBack(service, id);
        await service.runNext(id); // 実装がエラー
        const stopped = service.get(id)?.task;
        expect(stopped?.status).toBe("paused");
        expect(stopped?.pausedReason).toBe("error");
        // 止まっている間に、人が PR に指摘を書いた
        pulls.feedbackList = [item("comment:s16", { body: "npm test が環境に依存している" })];
        await service.checkPullRequests();
        expect(service.get(id)?.task && heldReview(service.get(id)?.task as Task)).toBeDefined();
        const calls = executor.calls.length;

        service.resume(id, {});
        expect(service.queuedTaskIds()).toEqual([id]);
        await service.runNext(id);
        // 止まった工程（実装）を走り直さず、先に戻し先を判断して、実装に差し戻した
        expect(executor.calls.length).toBe(calls + 1);
        expect(promptOf(executor, calls)).toContain("npm test が環境に依存している");
        expect(promptOf(executor, calls)).toContain("sacty-rework");
        const events = service.get(id)?.activity ?? [];
        expect(events.slice(-2).map((e) => [e.type, e.actor])).toEqual([
          ["ReworkJudged", "agent"],
          ["ChangesRequested", "person"],
        ]);
        expect(events.at(-1)?.payload).toMatchObject({
          step: "implement",
          target: "implement",
          round: 2,
          remarks: [{ id: "implement-2-1", text: "npm test が環境に依存している" }],
          overLimit: false,
        });
        let task = service.get(id)?.task;
        expect(task?.status).toBe("queued");
        expect(task?.pendingReview).toBeUndefined();
        expect(task?.verification).toBeUndefined();
        expect(task?.prRework).toMatchObject({ target: "implement", decided: true });
        // 続きは、指摘を渡した実装 → 実装の承認待ち
        await drain(service);
        expect(promptOf(executor, calls + 1)).toContain("npm test が環境に依存している");
        task = service.get(id)?.task;
        expect(task?.status).toBe("awaiting_approval");
        expect(task?.gate).toEqual({ step: "implement", submission: 2 });
        activity.close();
      });

      it("指摘が無ければ、今までどおり止まった工程だけを走り直す。ゴールガーディアンに戻し先を判断させない", async () => {
        const pulls = new FakePulls();
        const { activity, service, executor, id } = await toImplementGate(
          [
            { kind: "failed", reason: "error", message: "EACCES: permission denied" },
            implement("# v2"),
          ],
          { pulls, now: later },
        );
        sendBack(service, id);
        await service.runNext(id);
        expect(service.get(id)?.task.status).toBe("paused");
        // 指摘は届いていない。確認しても、残るものは無い
        await service.checkPullRequests();
        expect(heldEvents(service, id)).toHaveLength(0);
        service.resume(id, {});
        const calls = executor.calls.length;
        await drain(service);
        expect(types(service, id)).not.toContain("ReworkJudged");
        // 止まった実装だけが再実行された
        expect(executor.calls.length).toBe(calls + 1);
        expect(promptOf(executor, calls)).toContain("最初の指摘");
        expect(promptOf(executor, calls)).not.toContain("sacty-rework");
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        activity.close();
      });

      describe("対応を求めていないコメント（「承知しました」など）", () => {
        const noAction = (positions: number[], target = "undecidable") =>
          out(
            `\`\`\`json\n${JSON.stringify({ "sacty-rework": { target, no_action: positions, reason: "先の返信を受け入れただけの応答" } })}\n\`\`\``,
          );

        it("残した指摘がすべて対応を求めていなければ、再開しても差し戻さず、止まった工程を走り直す", async () => {
          const { activity, service, executor, pulls, id } = await pausedRework([
            noAction([1]),
            implement("# v2"),
          ]);
          pulls.feedbackList = [item("comment:ack", { body: "承知しました。" })];
          await service.checkPullRequests();
          const requested = types(service, id).filter((t) => t === "ChangesRequested").length;
          service.resume(id, {});
          const calls = executor.calls.length;
          await drain(service);
          // 判断の実行と、止まった実装の走り直しだけ（差し戻しは増えない）
          expect(executor.calls.length).toBe(calls + 2);
          expect(promptOf(executor, calls)).toContain("- [1] 承知しました。");
          expect(promptOf(executor, calls + 1)).toContain("最初の指摘");
          expect(promptOf(executor, calls + 1)).not.toContain("承知しました。");
          expect(types(service, id).filter((t) => t === "ChangesRequested")).toHaveLength(
            requested,
          );
          const judged = (service.get(id)?.activity ?? []).findLast(
            (e) => e.type === "ReworkJudged",
          );
          expect(judged?.payload).toMatchObject({ noAction: [0], noRework: true });
          const task = service.get(id)?.task;
          expect(task?.pendingReview).toBeUndefined();
          expect(task?.importedFeedback).toContain("comment:ack");
          expect(task?.remarks.map((r) => r.id)).toEqual(["requirements-1-1", "implement-1-1"]);
          expect(task?.status).toBe("awaiting_approval");
          expect(task?.gate).toEqual({ step: "implement", submission: 2 });
          activity.close();
        });

        it("対応を求める指摘と一緒に残していたら、再開のあと、求める指摘だけで差し戻す", async () => {
          const { activity, service, pulls, id } = await pausedRework([
            noAction([1], "implement"),
            implement("# v2"),
          ]);
          pulls.feedbackList = [
            item("comment:ack", { body: "承知しました。" }),
            item("comment:ask", { body: "テストも足して" }),
          ];
          await service.checkPullRequests();
          service.resume(id, {});
          await service.runNext(id);
          const sentBack = (service.get(id)?.activity ?? []).at(-1);
          expect(sentBack).toMatchObject({
            type: "ChangesRequested",
            payload: { step: "implement", target: "implement", round: 2 },
          });
          const remarks = sentBack?.type === "ChangesRequested" ? sentBack.payload.remarks : [];
          expect(remarks.map((r) => r.text)).toEqual(["テストも足して"]);
          expect(remarks[0]?.origin).toMatchObject({ key: "comment:ask" });
          expect(service.get(id)?.task.pendingReview).toBeUndefined();
          activity.close();
        });
      });

      it("再開の直前に書かれた指摘（まだ確認が読んでいない）も、再開のあとに読んで反映する", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([
          rework("implement", "実装で直せる"),
          implement("# v2"),
        ]);
        // 確認（60 秒ごと）を待たずに、指摘が書かれて、人が再開した
        pulls.feedbackList = [item("comment:late")];
        expect(heldEvents(service, id)).toHaveLength(0);
        service.resume(id, {});
        const calls = executor.calls.length;
        await service.runNext(id);
        expect(heldEvents(service, id)).toHaveLength(1);
        expect(promptOf(executor, calls)).toContain("全体として、失敗時のログが足りない");
        expect(service.get(id)?.task.remarks.at(-1)).toMatchObject({
          id: "implement-2-1",
          step: "implement",
        });
        await drain(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        activity.close();
      });

      it("ゴールガーディアンが設計まで戻すと判断した指摘は、設計に差し戻す", async () => {
        const { activity, service, pulls, id } = await pausedRework([
          rework("design", "方針の変更なので設計から", "new_request"),
        ]);
        pulls.feedbackList = [
          item("comment:d", { body: "再試行はやめて、キューに積む方針にしてください" }),
        ];
        await service.checkPullRequests();
        service.resume(id, {});
        await service.runNext(id);
        const task = service.get(id)?.task;
        expect(task?.steps.find((s) => s.state === "active")?.key).toBe("design");
        expect(task?.status).toBe("queued");
        expect(task?.remarks.at(-1)).toMatchObject({ id: "design-1-1", step: "design" });
        expect(task?.prRework).toMatchObject({
          target: "design",
          decided: true,
          cause: "new_request",
        });
        // 設計から先の承認は取り消される
        expect(task?.approved.design).toBeUndefined();
        activity.close();
      });

      it("ゴールガーディアンが判断できなければ、実装をやり直す", async () => {
        const { activity, service, pulls, id } = await pausedRework([
          { kind: "failed", reason: "error", message: "判断できません" },
        ]);
        pulls.feedbackList = [item("comment:u")];
        await service.checkPullRequests();
        service.resume(id, {});
        await service.runNext(id);
        const events = service.get(id)?.activity ?? [];
        expect(events.slice(-2).map((e) => e.type)).toEqual(["ReworkJudged", "ChangesRequested"]);
        expect(events.at(-2)?.payload).not.toHaveProperty("target");
        expect(events.at(-1)?.payload).toMatchObject({ step: "implement", target: "implement" });
        expect(service.get(id)?.task.prRework).toMatchObject({
          target: "implement",
          decided: false,
        });
        activity.close();
      });

      it("予算の上限で止まったタスクも同じに扱う。上限を上げて再開すると、止まった工程の前に指摘を反映する", async () => {
        const pulls = new FakePulls();
        const { activity, service, executor, id } = await toImplementGate(
          [
            {
              kind: "failed",
              reason: "usage_limit",
              message: "You've hit your session limit",
              usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }, // $15
            },
            rework("implement", "実装で直せる"),
            implement("# v3"),
          ],
          { pulls, now: later },
        );
        sendBack(service, id);
        await service.runNext(id);
        const stopped = service.get(id)?.task;
        expect(stopped?.status).toBe("paused");
        expect(stopped?.budget.usedUsd).toBeGreaterThan(stopped?.budget.capUsd ?? Infinity);
        pulls.feedbackList = [item("comment:b")];
        await service.checkPullRequests();
        expect(heldEvents(service, id)).toHaveLength(1);
        const calls = executor.calls.length;
        service.resume(id, { capUsd: 100 });
        await service.runNext(id);
        expect(promptOf(executor, calls)).toContain("sacty-rework");
        expect(types(service, id).slice(-2)).toEqual(["ReworkJudged", "ChangesRequested"]);
        await drain(service);
        expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
        activity.close();
      });

      it("AI のレビューの指摘だけなら、人の差し戻しの回数に数えず、差し戻しは人の操作にしない。人の指摘と混ざれば、出どころを分けて渡す", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([
          rework("implement", "実装で直せる"),
          rework("implement", "実装で直せる"),
        ]);
        pulls.feedbackList = [aiItem(pulls, "review:ai1")];
        await service.checkPullRequests();
        const held = heldEvents(service, id);
        expect(held.map((e) => e.actor)).toEqual(["sacty"]);
        expect(held[0]?.payload).toMatchObject({
          items: [{ key: "review:ai1", source: "sacty_review" }],
        });
        service.resume(id, {});
        await service.runNext(id);
        let events = service.get(id)?.activity ?? [];
        expect(events.at(-1)).toMatchObject({ type: "ChangesRequested", actor: "sacty" });
        let task = service.get(id)?.task as Task;
        expect(task.remarks.at(-1)).toMatchObject({ id: "implement-2-1", source: "sacty_review" });
        // 人の差し戻しは、最初の 1 回のまま
        expect(changeRounds(task, "implement")).toBe(1);
        expect(lastChangeRound(task, "implement")).toBe(2);

        // 人の指摘と AI のレビューの指摘が混ざる回は、人の差し戻しとして数える
        await service.pause(id);
        pulls.feedbackList = [
          ...pulls.feedbackList,
          item("comment:h1", { body: "人の指摘" }),
          aiItem(pulls, "review:ai2", { body: "AI の指摘" }),
        ];
        await service.checkPullRequests();
        const before = executor.calls.length;
        service.resume(id, {});
        await service.runNext(id);
        const prompt = promptOf(executor, before);
        expect(prompt).toContain("人の指摘");
        expect(prompt).toContain("AI の指摘");
        events = service.get(id)?.activity ?? [];
        expect(events.at(-1)).toMatchObject({ type: "ChangesRequested", actor: "person" });
        task = service.get(id)?.task as Task;
        expect(task.remarks.slice(-2).map((r) => [r.id, r.source])).toEqual([
          ["implement-3-1", undefined],
          ["implement-3-2", "sacty_review"],
        ]);
        expect(changeRounds(task, "implement")).toBe(2);
        activity.close();
      });

      it("古い head へのレビューは、残さずに捨てて作業履歴に残す。作り直しの PR の head と同じなら残す", async () => {
        const { activity, service, pulls, id } = await pausedRework([]);
        pulls.feedbackList = [
          aiItem(pulls, "review:old", { commit: "0".repeat(40) }),
          aiItem(pulls, "review:new"),
        ];
        await service.checkPullRequests();
        const events = service.get(id)?.activity ?? [];
        const discarded = events.filter((e) => e.type === "PullRequestReviewDiscarded");
        expect(discarded).toHaveLength(1);
        expect(discarded[0]?.payload).toMatchObject({
          reason: "stale_head",
          items: [{ key: "review:old" }],
        });
        const task = service.get(id)?.task as Task;
        expect(heldReview(task)?.keys).toEqual(["review:new"]);
        expect(task.importedFeedback).toEqual(["review:old", "review:new"]);
        activity.close();
      });

      it("一時停止の間に PR がマージされたら、残した指摘は捨てて、マージを承認として進める", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([]);
        pulls.feedbackList = [item("comment:m")];
        await service.checkPullRequests();
        expect(heldEvents(service, id)).toHaveLength(1);
        const calls = executor.calls.length;
        pulls.state = {
          state: "merged",
          mergedBy: "reviewer",
          headSha: service.get(id)?.task.pullRequest?.commit,
        };
        await service.checkPullRequests();
        const stopped = (service.get(id)?.activity ?? []).find(
          (e) => e.type === "ReworkStoppedByMerge",
        );
        expect(stopped?.payload).toMatchObject({ was: "paused", discardedReview: 1 });
        const task = service.get(id)?.task as Task;
        expect(task.pendingReview).toBeUndefined();
        expect(task.pullRequestState).toBe("merged");
        expect(task.steps.every((st) => st.state === "done")).toBe(true);
        // ゴールガーディアンは動かさない
        expect(executor.calls).toHaveLength(calls);
        expect(types(service, id)).not.toContain("ReworkJudged");
        activity.close();
      });

      it("再開のあと、判断の前に PR がマージされていたら、反映せず（判断も差し戻しもしない）、止まった工程も走らせずに、その場でマージを承認として進める", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([implement("# v2")]);
        pulls.feedbackList = [item("comment:m2")];
        await service.checkPullRequests();
        service.resume(id, {});
        pulls.state = {
          state: "merged",
          mergedBy: "reviewer",
          headSha: service.get(id)?.task.pullRequest?.commit,
        };
        const calls = executor.calls.length;
        await service.runNext(id); // 定期の確認より前に、再開の後の実行が始まった
        expect(types(service, id)).not.toContain("ReworkJudged");
        // 止まった工程（実装）は走らず、マージの承認まで進む
        expect(executor.calls).toHaveLength(calls);
        const stopped = (service.get(id)?.activity ?? []).find(
          (e) => e.type === "ReworkStoppedByMerge",
        );
        expect(stopped?.payload).toMatchObject({ discardedReview: 1 });
        const task = service.get(id)?.task as Task;
        expect(task.pendingReview).toBeUndefined();
        expect(task.pullRequestState).toBe("merged");
        activity.close();
      });

      it("戻し先の判断の実行を一時停止で止めたら、判断は採用せず（実行の記録だけ残す）、再開すると判断し直して反映する", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([
          HOLD,
          rework("implement", "実装で直せる"),
        ]);
        pulls.feedbackList = [item("comment:p")];
        await service.checkPullRequests();
        service.resume(id, {});
        const judging = service.runNext(id);
        const runId = await executor.started.promise;
        const before = service.get(id)?.task.budget as Task["budget"];
        // 中断した実行は、使用量を読めた分（$0.30）と、全体は読めなかった印を持って終わる
        const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 20_000 };
        executor.finishHeld(runId, {
          kind: "failed",
          reason: "error",
          message: "container stopped",
          usage,
          costUnknown: true,
        });
        const pausing = service.pause(id);
        await judging;
        await pausing;
        expect(executor.killed).toEqual([runId]);
        let task = service.get(id)?.task as Task;
        expect(task.status).toBe("paused");
        // 判断は採用せず、使った実行の記録だけを残す（費用・使用量・費用不明の印が履歴から消えない）。指摘は未判断のまま
        const interrupted = (service.get(id)?.activity ?? []).filter(
          (e) => e.type === "ReworkJudged",
        );
        expect(interrupted.map((e) => e.payload)).toMatchObject([
          { runResult: "interrupted", usage, costUnknown: true },
        ]);
        const charged =
          interrupted[0]?.type === "ReworkJudged" ? interrupted[0].payload.costUsd : 0;
        expect(charged).toBeGreaterThan(0);
        // 投影後の集計：費用が予算に入り、全体を読めなかった実行として数える
        expect(task.budget.usedUsd).toBeCloseTo(before.usedUsd + charged, 6);
        expect(task.budget.unknownRuns).toBe((before.unknownRuns ?? 0) + 1);
        expect(heldReview(task)?.keys).toEqual(["comment:p"]);
        expect(heldReview(task)?.judgement).toBeUndefined();
        // 再開すると判断し直して、実装に差し戻す
        service.resume(id, {});
        await service.runNext(id);
        expect(types(service, id).slice(-2)).toEqual(["ReworkJudged", "ChangesRequested"]);
        task = service.get(id)?.task as Task;
        expect(task.prRework).toMatchObject({ target: "implement", decided: true });
        activity.close();
      });

      it("戻し先の判断の間にデーモンを停止したら、停止による中断を判断の失敗として採用せず（実装へ差し戻さない）、費用だけを記録する。再起動の後に判断し直す", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([HOLD]);
        pulls.feedbackList = [item("comment:stop")];
        await service.checkPullRequests();
        service.resume(id, {});
        const judging = service.runNext(id);
        const runId = await executor.started.promise;
        const requested = types(service, id).filter((t) => t === "ChangesRequested").length;
        // デーモンを止め始め、実行中のコンテナを止めた
        service.beginShutdown();
        executor.finishHeld(runId, {
          kind: "failed",
          reason: "error",
          message: "container stopped",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 20_000 },
          costUnknown: true,
        });
        await judging;
        const judged = (service.get(id)?.activity ?? []).filter((e) => e.type === "ReworkJudged");
        expect(judged.map((e) => e.payload)).toMatchObject([
          { runResult: "interrupted", costUnknown: true },
        ]);
        expect(types(service, id).filter((t) => t === "ChangesRequested")).toHaveLength(requested);
        const task = service.get(id)?.task as Task;
        expect(heldReview(task)?.keys).toEqual(["comment:stop"]);
        expect(heldReview(task)?.judgement).toBeUndefined();
        // 再起動の後、作業履歴から復元して、判断し直して反映する
        const { service: again, executor: next } = makeService(
          activity,
          [rework("implement", "実装で直せる")],
          { pulls, now: later },
        );
        await again.runNext(id);
        expect(next.calls).toHaveLength(1);
        expect(
          again
            .get(id)
            ?.activity.slice(-2)
            .map((e) => e.type),
        ).toEqual(["ReworkJudged", "ChangesRequested"]);
        activity.close();
      });

      it("承認待ちの PR の指摘の判断の間にデーモンを停止したときも、停止による中断を判断の失敗として採用せず、実装へ差し戻さない", async () => {
        const pulls = new FakePulls();
        const { activity, service, executor, id } = await toImplementGate([HOLD], {
          pulls,
          now: later,
        });
        pulls.feedbackList = [item("comment:gate-stop")];
        const checking = service.checkPullRequests();
        const runId = await executor.started.promise;
        service.beginShutdown();
        executor.finishHeld(runId, {
          kind: "failed",
          reason: "error",
          message: "container stopped",
        });
        await checking;
        const events = service.get(id)?.activity ?? [];
        expect(events.filter((e) => e.type === "ReworkJudged").map((e) => e.payload)).toMatchObject(
          [{ runResult: "interrupted" }],
        );
        // 実装へ差し戻さず、指摘は未判断のまま、承認待ちに残る
        expect(
          events.filter((e) => e.type === "ChangesRequested" && e.payload.step === "implement"),
        ).toHaveLength(0);
        const task = service.get(id)?.task as Task;
        expect(task.status).toBe("awaiting_approval");
        expect(task.pendingReview?.keys).toEqual(["comment:gate-stop"]);
        expect(task.pendingReview?.judgement).toBeUndefined();
        activity.close();
      });

      it("戻し先の判断の間に PR がマージされたら、判断を記録しても差し戻さない（設計への戻しでも前の工程を実行しない）。作り直しの停止が残した指摘を捨てる", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([
          HOLD,
          rework("design", "方針の変更なので設計から"),
          implement("# v2"),
        ]);
        pulls.feedbackList = [item("comment:j")];
        await service.checkPullRequests();
        service.resume(id, {});
        const running = service.runNext(id);
        const runId = await executor.started.promise;
        // 判断している間に、人が PR をマージした
        pulls.state = {
          state: "merged",
          mergedBy: "reviewer",
          headSha: service.get(id)?.task.pullRequest?.commit,
        };
        const requested = types(service, id).filter((t) => t === "ChangesRequested").length;
        executor.finishHeld(runId, rework("design", "方針の変更なので設計から"));
        await running;
        expect(types(service, id)).toContain("ReworkJudged");
        expect(types(service, id).filter((t) => t === "ChangesRequested")).toHaveLength(requested);
        expect(service.get(id)?.task.steps.find((st) => st.state === "active")?.key).not.toBe(
          "design",
        );
        // その場で作り直しを止めて、マージを承認として進める（止まった工程や次の確認を待たない）
        const stopped = (service.get(id)?.activity ?? []).find(
          (e) => e.type === "ReworkStoppedByMerge",
        );
        expect(stopped?.payload).toMatchObject({ discardedReview: 1 });
        expect(service.get(id)?.task.pendingReview).toBeUndefined();
        expect(service.get(id)?.task.pullRequestState).toBe("merged");
        activity.close();
      });

      /** 最初の feedback の呼び出しを、放すまで待たせる（定期の確認が、再開の後に終わる順序を作る）。 */
      const gateFirstFeedback = (pulls: FakePulls, firstList: PullRequestFeedback[]) => {
        const original = pulls.feedback.bind(pulls);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entered = Promise.withResolvers<void>();
        let calls = 0;
        pulls.feedback = async (input) => {
          const result = await original(input);
          if (++calls === 1) {
            entered.resolve();
            await gate;
            return firstList;
          }
          return result;
        };
        return { release, entered: entered.promise };
      };

      /** 2 回目の status の呼び出し（1 回目はマージの確認。2 回目が古い head の確認）を、放すまで待たせる（確認が、記録の直前で止まる順序を作る）。 */
      const gateSecondStatus = (pulls: FakePulls) => {
        const original = pulls.status.bind(pulls);
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const entered = Promise.withResolvers<void>();
        let calls = 0;
        pulls.status = async (input) => {
          const result = await original(input);
          if (++calls === 2) {
            entered.resolve();
            await gate;
          }
          return result;
        };
        return { release, entered: entered.promise };
      };

      it("一時停止中に始まった確認が、再開の後の判断の間に終わっても、指摘を足さない。判断は、判断した指摘のまま記録して反映する", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([
          HOLD,
          rework("implement", "実装で直せる"),
        ]);
        pulls.feedbackList = [item("comment:x")];
        await service.checkPullRequests();
        // 一時停止中の確認が、新しい指摘を読んだところで止まっている
        // 最初の呼び出しだけが、新しい指摘（comment:y）を読む。再開の後の確認が読むときは、まだ届いていない
        const gate = gateFirstFeedback(pulls, [
          item("comment:x"),
          item("comment:y", { body: "あとから届いた" }),
        ]);
        const periodic = service.checkPullRequests();
        await gate.entered;
        service.resume(id, {});
        const running = service.runNext(id);
        const runId = await executor.started.promise;
        // 判断の間に、止まっていた確認が続きを進める
        gate.release();
        await periodic;
        expect(heldReview(service.get(id)?.task as Task)?.keys).toEqual(["comment:x"]);
        executor.finishHeld(runId, rework("implement", "実装で直せる"));
        await running;
        // 判断（費用つき）を記録し、判断した指摘だけで差し戻した
        expect(types(service, id).slice(-2)).toEqual(["ReworkJudged", "ChangesRequested"]);
        const task = service.get(id)?.task as Task;
        expect(task.remarks.at(-1)?.text).toBe("全体として、失敗時のログが足りない");
        // あとから届いた指摘は、取り込み済みにせず、反映の後の通常の取り込みに残る
        expect(task.importedFeedback).toEqual(["comment:x"]);
        activity.close();
      });

      it("同時に走った 2 つの確認が同じ古い head への AI のレビューを捨てようとしても、重ねて記録せず、残りの指摘は残す", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const { activity, service, executor, pulls, id } = await pausedRework([
            HOLD,
            rework("implement", "実装で直せる"),
          ]);
          const listed = [
            aiItem(pulls, "review:old", { commit: "0".repeat(40) }),
            item("comment:h", { body: "人の指摘" }),
          ];
          pulls.feedbackList = listed;
          const gate = gateSecondStatus(pulls);
          const periodic = service.checkPullRequests();
          await gate.entered;
          service.resume(id, {});
          const running = service.runNext(id);
          const runId = await executor.started.promise;
          // 再開の側が先に捨てて、人の指摘を残した。ここで止まっていた確認が続く
          gate.release();
          await periodic;
          const discarded = (service.get(id)?.activity ?? []).filter(
            (e) => e.type === "PullRequestReviewDiscarded",
          );
          expect(discarded).toHaveLength(1);
          expect(warn).not.toHaveBeenCalled();
          expect(heldReview(service.get(id)?.task as Task)?.keys).toEqual(["comment:h"]);
          executor.finishHeld(runId, rework("implement", "実装で直せる"));
          await running;
          expect(types(service, id).slice(-2)).toEqual(["ReworkJudged", "ChangesRequested"]);
          activity.close();
        } finally {
          warn.mockRestore();
        }
      });

      it("再開の直後に PR の指摘を読めなければ、止まった工程を走り直さずに待ち、読めたら判断して反映する", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const { activity, service, executor, pulls, id } = await pausedRework([
            rework("implement", "実装で直せる"),
            implement("# v2"),
          ]);
          pulls.feedbackList = [item("comment:w")];
          const original = pulls.feedback.bind(pulls);
          pulls.feedback = async () => {
            throw new Error("GitHub に接続できません");
          };
          service.resume(id, {});
          const calls = executor.calls.length;
          await service.runNext(id);
          await service.runNext(id);
          // 読めない間は、実装も判断も走らない（直前に書かれた指摘を落として走り直さない）。次の周期でも対象のまま
          expect(executor.calls).toHaveLength(calls);
          expect(service.queuedTaskIds()).toEqual([id]);
          expect(types(service, id)).not.toContain("ReworkJudged");
          // 読めるようになったら、指摘を読んで、判断し、反映する
          pulls.feedback = original;
          await service.runNext(id);
          expect(types(service, id).slice(-4)).toEqual([
            "PullRequestReviewImported",
            "RunCostRecorded",
            "ReworkJudged",
            "ChangesRequested",
          ]);
          await drain(service);
          expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
          activity.close();
        } finally {
          warn.mockRestore();
        }
      });

      it("判断の後の状態の読み取りの間に、定期の確認が作り直しの停止（PR のマージ）を始めたら、古い応答（開いたまま）で差し戻さず、マージを承認として進める", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([
          HOLD,
          rework("design", "方針の変更なので設計から"),
        ]);
        pulls.feedbackList = [item("comment:race")];
        await service.checkPullRequests();
        service.resume(id, {});
        const running = service.runNext(id);
        const runId = await executor.started.promise;
        // 判断の後の状態の読み取りを、開いたままと答えた後で止める
        const original = pulls.status.bind(pulls);
        let armed = true;
        const entered = Promise.withResolvers<void>();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        pulls.status = async (input) => {
          const result = await original(input);
          if (!armed) return result;
          armed = false;
          entered.resolve();
          await gate;
          return result;
        };
        const requested = types(service, id).filter((t) => t === "ChangesRequested").length;
        executor.finishHeld(runId, rework("design", "方針の変更なので設計から"));
        await entered.promise;
        // 読み取りの間に、人がマージし、定期の確認が作り直しの停止を始めた
        pulls.state = {
          state: "merged",
          mergedBy: "reviewer",
          headSha: service.get(id)?.task.pullRequest?.commit,
        };
        const periodic = service.checkPullRequests();
        await waitForAssertion(() =>
          expect((service as unknown as { mergeStopping: Set<string> }).mergeStopping.has(id)).toBe(
            true,
          ),
        );
        release();
        await running;
        await periodic;
        expect(types(service, id).filter((t) => t === "ChangesRequested")).toHaveLength(requested);
        const stopped = (service.get(id)?.activity ?? []).find(
          (e) => e.type === "ReworkStoppedByMerge",
        );
        expect(stopped?.payload).toMatchObject({ discardedReview: 1 });
        const task = service.get(id)?.task as Task;
        expect(task.pullRequestState).toBe("merged");
        expect(task.steps.every((st) => st.state === "done")).toBe(true);
        activity.close();
      });

      it("再開直後に指摘は読めたが、AI のレビューの head を確かめられなければ、印を残して止まった工程を走り直さずに待ち、確かめられたら AI のレビューも残して反映する", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const { activity, service, executor, pulls, id } = await pausedRework([
            rework("implement", "実装で直せる"),
            implement("# v2"),
          ]);
          pulls.feedbackList = [aiItem(pulls, "review:ai-head")];
          const original = pulls.status.bind(pulls);
          pulls.status = async () => {
            throw new Error("GitHub に接続できません ghp_secret");
          };
          service.resume(id, {});
          const calls = executor.calls.length;
          await service.runNext(id);
          await service.runNext(id);
          // 確かめられない原因は、タスクと PR を添えて警告に残す（トークンは伏せる）
          const warned = warn.mock.calls.map((c) => String(c[0])).join("\n");
          expect(warned).toContain("PR #7");
          expect(warned).toContain("head を確認できませんでした");
          expect(warned).toContain("GitHub に接続できません");
          expect(warned).not.toContain("ghp_secret");
          // 指摘は読めたが、head を確かめられない間は、実装も判断も走らない。対象のまま
          expect(executor.calls).toHaveLength(calls);
          expect(service.queuedTaskIds()).toEqual([id]);
          expect(types(service, id)).not.toContain("ReworkJudged");
          expect(heldReview(service.get(id)?.task as Task)).toBeUndefined();
          // 確かめられたら、AI のレビューを残して、判断し、反映する
          pulls.status = original;
          await service.runNext(id);
          expect(types(service, id).slice(-4)).toEqual([
            "PullRequestReviewImported",
            "RunCostRecorded",
            "ReworkJudged",
            "ChangesRequested",
          ]);
          expect(service.get(id)?.task.remarks.at(-1)).toMatchObject({
            id: "implement-2-1",
            source: "sacty_review",
          });
          await drain(service);
          expect(service.get(id)?.task.gate).toEqual({ step: "implement", submission: 2 });
          activity.close();
        } finally {
          warn.mockRestore();
        }
      });

      it("予算の上限を超えたまま上限を変えずに再開したら、戻し先の判断を実行せず、予算による一時停止にする。上限を上げて再開すると判断する", async () => {
        const pulls = new FakePulls();
        const { activity, service, executor, id } = await toImplementGate(
          [
            {
              kind: "failed",
              reason: "usage_limit",
              message: "You've hit your session limit",
              usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 }, // $15
            },
            rework("implement", "実装で直せる"),
          ],
          { pulls, now: later },
        );
        sendBack(service, id);
        await service.runNext(id);
        const stopped = service.get(id)?.task as Task;
        expect(stopped.pausedReason).toBe("usage_limit");
        expect(budgetState(stopped.budget)).toBe("exceeded");
        pulls.feedbackList = [item("comment:budget")];
        await service.checkPullRequests();
        // 利用上限で止めたタスクを、上限を変えずに再開した
        service.resume(id, {});
        const calls = executor.calls.length;
        await service.runNext(id);
        expect(executor.calls).toHaveLength(calls);
        expect(types(service, id)).not.toContain("ReworkJudged");
        expect(service.get(id)?.task.pausedReason).toBe("budget");
        expect(heldReview(service.get(id)?.task as Task)?.keys).toEqual(["comment:budget"]);
        // 上限を上げて再開すると、判断して反映する
        service.resume(id, { capUsd: 100 });
        await service.runNext(id);
        expect(executor.calls).toHaveLength(calls + 1);
        expect(types(service, id).slice(-2)).toEqual(["ReworkJudged", "ChangesRequested"]);
        activity.close();
      });

      it("判断を保存して再開した後の状態の読み取りの間に、定期の確認が作り直しの停止を始めたら、古い応答で差し戻さない", async () => {
        const { activity, service, executor, pulls, id } = await pausedRework([
          HOLD,
          rework("design", "方針の変更なので設計から"),
        ]);
        pulls.feedbackList = [item("comment:saved")];
        await service.checkPullRequests();
        service.resume(id, {});
        const judging = service.runNext(id);
        const runId = await executor.started.promise;
        // 判断が終わった直後に一時停止を求める。判断は記録するが、差し戻さずに止まる
        executor.finishHeld(runId, rework("design", "方針の変更なので設計から"));
        const pausing = service.pause(id);
        await judging;
        await pausing;
        let task = service.get(id)?.task as Task;
        expect(task.status).toBe("paused");
        expect(heldReview(task)?.judgement).toMatchObject({ target: "design" });
        const requested = types(service, id).filter((t) => t === "ChangesRequested").length;
        // 再開した後の、判断済みの経路。状態の読み取りを、開いたままと答えた後で止める
        service.resume(id, {});
        const original = pulls.status.bind(pulls);
        let armed = true;
        const entered = Promise.withResolvers<void>();
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        pulls.status = async (input) => {
          const result = await original(input);
          if (!armed) return result;
          armed = false;
          entered.resolve();
          await gate;
          return result;
        };
        const running = service.runNext(id);
        await entered.promise;
        pulls.state = {
          state: "merged",
          mergedBy: "reviewer",
          headSha: service.get(id)?.task.pullRequest?.commit,
        };
        const periodic = service.checkPullRequests();
        await waitForAssertion(() =>
          expect((service as unknown as { mergeStopping: Set<string> }).mergeStopping.has(id)).toBe(
            true,
          ),
        );
        release();
        await running;
        await periodic;
        task = service.get(id)?.task as Task;
        expect(types(service, id).filter((t) => t === "ChangesRequested")).toHaveLength(requested);
        expect(types(service, id)).toContain("ReworkStoppedByMerge");
        expect(task.pullRequestState).toBe("merged");
        expect(task.steps.every((st) => st.state === "done")).toBe(true);
        activity.close();
      });

      it("承認待ちで一時停止したタスクは、3 回の差し戻しの後でも、再開のあと、届いた指摘を 4 回目の差し戻しとして取り込む（エスカレーションにしない）", async () => {
        const pulls = new FakePulls();
        const cycle = () => [implement("# 実装")];
        const { activity, service, id } = await toImplementGate(
          [...cycle(), ...cycle(), ...cycle(), rework("implement", "実装で直せる")],
          { pulls, now: later },
        );
        for (const text of ["指摘 a", "指摘 b", "指摘 c"]) {
          service.requestChanges(id, {
            step: "implement",
            submission: service.get(id)?.task.gate?.submission ?? 0,
            comments: [text],
          });
          await drain(service);
        }
        expect(service.get(id)?.task.status).toBe("awaiting_approval");
        expect(changeRounds(service.get(id)?.task as Task, "implement")).toBe(3);
        await service.pause(id);
        pulls.feedbackList = [item("comment:held")];
        await service.checkPullRequests();
        service.resume(id, {});
        await drain(service);
        // 承認待ちに戻ると、通常の取り込みが、残した指摘を差し戻しにする
        await service.checkPullRequests();
        await drain(service);
        const events = service.get(id)?.activity ?? [];
        const last = events.findLast((e) => e.type === "ChangesRequested");
        expect(last?.payload).toMatchObject({ round: 4, overLimit: false });
        expect(types(service, id)).not.toContain("TaskEscalated");
        expect(service.get(id)?.task.escalation).toBeUndefined();
        activity.close();
      });

      it("人の差し戻しが 3 回に達していても、再開のあと、届いた指摘を 4 回目の差し戻しとして反映し、エスカレーションにしない", async () => {
        const pulls = new FakePulls();
        const ids: string[] = [];
        const cycle = () => {
          ids.push(`implement-${ids.length + 1}-1`);
          return [implement("# 実装")];
        };
        const { activity, service, id } = await toImplementGate(
          [
            // 人の差し戻し 2 回（最初の 1 回と合わせて 3 回）
            ...cycle(),
            ...cycle(),
            // 3 回目の差し戻しで止めたあと、再開で届いた指摘
            rework("implement", "実装で直せる"),
          ],
          { pulls, now: later },
        );
        for (const text of ["指摘 a", "指摘 b"]) {
          service.requestChanges(id, {
            step: "implement",
            submission: service.get(id)?.task.gate?.submission ?? 0,
            comments: [text],
          });
          await drain(service);
        }
        service.requestChanges(id, {
          step: "implement",
          submission: service.get(id)?.task.gate?.submission ?? 0,
          comments: ["指摘 c"],
        });
        await service.pause(id);
        expect(changeRounds(service.get(id)?.task as Task, "implement")).toBe(3);
        pulls.feedbackList = [item("comment:over")];
        await service.checkPullRequests();
        service.resume(id, {});
        await service.runNext(id);
        const events = service.get(id)?.activity ?? [];
        expect(events.at(-1)).toMatchObject({ type: "ChangesRequested", actor: "person" });
        expect(events.at(-1)?.payload).toMatchObject({ round: 4, overLimit: false });
        expect(types(service, id)).not.toContain("TaskEscalated");
        expect(service.get(id)?.task.status).toBe("queued");
        activity.close();
      });

      it("デーモンを再起動しても、残した指摘は作業履歴から復元し、再開すると判断して反映する", async () => {
        const { activity, service, pulls, id } = await pausedRework([]);
        pulls.feedbackList = [item("comment:r")];
        await service.checkPullRequests();
        // 再起動
        const { service: again, executor } = makeService(
          activity,
          [rework("implement", "実装で直せる")],
          { pulls, now: later },
        );
        const restored = again.get(id)?.task as Task;
        expect(restored.status).toBe("paused");
        expect(heldReview(restored)?.keys).toEqual(["comment:r"]);
        again.resume(id, {});
        await again.runNext(id);
        expect(executor.calls).toHaveLength(1);
        expect(again.get(id)?.activity.at(-1)?.type).toBe("ChangesRequested");
        activity.close();
      });

      it("PR の指摘を読めなければ、何も記録せず、次の確認で読み直す", async () => {
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          const { activity, service, pulls, id } = await pausedRework([]);
          pulls.feedbackList = [item("comment:f")];
          const original = pulls.feedback.bind(pulls);
          pulls.feedback = async () => {
            throw new Error("GitHub に接続できません");
          };
          await service.checkPullRequests();
          expect(heldEvents(service, id)).toHaveLength(0);
          pulls.feedback = original;
          await service.checkPullRequests();
          expect(heldEvents(service, id)).toHaveLength(1);
          activity.close();
        } finally {
          warn.mockRestore();
        }
      });
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

  it("実装の承認待ちから設計へ差し戻すと、設計の承認を取り消す。最終レビューをしないので見逃しは記録しない", async () => {
    const { activity, service, id } = await toImplementGate();
    const sent = service.requestChanges(id, {
      step: "implement",
      submission: 1,
      target: "design",
      cause: "guardian_missed",
      comments: ["観点が足りない"],
    });
    expect(sent.steps.map((st) => st.state)).toEqual(["done", "active", "todo"]);
    expect(sent.approved.design).toBeUndefined();
    expect(sent.approved.requirements).toBeDefined();
    expect(sent.misses).toEqual([]);
    activity.close();
  });

  it("原因を決めない差し戻しは、見逃しにせず、原因を記録しない（PBI-268）", async () => {
    const { activity, service, id } = await toImplementGate();
    const sent = service.requestChanges(id, {
      step: "implement",
      submission: 1,
      comments: ["直して"],
    });
    expect(sent.misses).toEqual([]);
    expect(types(service, id)).not.toContain("GuardianMissed");
    const requested = service.get(id)?.activity.find((e) => e.type === "ChangesRequested");
    expect(requested?.payload).not.toHaveProperty("cause");
    activity.close();
  });

  it.each(["base_changed", "new_request"] as const)(
    "原因が %s の差し戻しは、見逃しにせず、原因を記録する（PBI-268）",
    async (cause) => {
      const { activity, service, id } = await toImplementGate();
      const sent = service.requestChanges(id, {
        step: "implement",
        submission: 1,
        cause,
        comments: ["main と競合しています"],
      });
      expect(sent.status).toBe("queued");
      expect(sent.misses).toEqual([]);
      expect(types(service, id)).not.toContain("GuardianMissed");
      const requested = service.get(id)?.activity.filter((e) => e.type === "ChangesRequested");
      expect(requested?.at(-1)?.payload).toMatchObject({ cause });
      activity.close();
    },
  );

  it("読めないファイルが無ければ、作業履歴にも指示にも足さない（PBI-278）", async () => {
    const { activity, service, executor, id } = await toImplement([implement("# v1")]);
    await drain(service);
    expect((service.get(id)?.activity ?? []).some((e) => e.type === "WorkspaceFilesSkipped")).toBe(
      false,
    );
    expect(promptOf(executor, executor.calls.length - 1)).not.toContain(
      "--- 作業領域の写しに入れなかったファイル ---",
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
    const pulls = new FakePulls();
    const { service, executor } = makeService(
      activity,
      [implement("# v1", [{ viewpointId: "REQ", tests: ["a.test.ts › 受け入れ条件"] }])],
      { pulls },
    );
    for (let i = 0; i < 4 && service.queuedTaskIds().includes("t-old"); i++) {
      await service.runNext("t-old");
    }
    const task = service.get("t-old")?.task;
    // 実装の後、記録した URL のリポジトリ（acme/app）に PR を作る
    expect(executor.calls).toHaveLength(1);
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
    const { activity, service, id } = await toImplement([implement("# v1")]);
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
    const { activity, service, executor, id } = await toImplement([HOLD, implement("# v1")]);
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

  it("中止済みのタスクは一時停止しない（PBI-3）。承認待ちは一時停止できる（PBI-301）", async () => {
    const { activity, service, id } = await toImplementGate();
    expect((await service.pause(id)).status).toBe("paused");
    await service.cancel(id);
    await expect(service.pause(id)).rejects.toMatchObject({
      messages: [{ code: "task.cancelled" }],
    });
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
    const { activity, service, executor, id } = await toImplement([HOLD, implement("# v1")]);
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
    const { activity, service, executor, id } = await toImplement([HOLD]);
    // 停止の確認に時間がかかる
    const gate = Promise.withResolvers<boolean>();
    executor.ensureStopped = () => gate.promise;
    const running = service.runNext(id); // 実装
    await executor.started.promise;
    let returned = false;
    const pausing = service.pause(id).then((t) => {
      returned = true;
      return t;
    });
    // 停止の確認が終わる前に、一時停止が返っていないこと（何も起きないこと）を見るための猶予
    await idleFor(10);
    expect(returned).toBe(false); // 確認が終わるまで返らない
    gate.resolve(true);
    const paused = await pausing;
    await running;
    expect(paused.status).toBe("paused");
    activity.close();
  });

  it("デーモンを再起動しても、実装の後の PR の作成を続ける", async () => {
    const { activity, service, id } = await toImplement([implement("# v1")]);
    await service.runNext(id);
    const { service: restarted } = makeService(activity, []);
    restarted.recoverInterrupted();
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    // 最終レビューをせず、実装の工程のまま PR の作成を待つ。もう一度再起動しても、実装をやり直さずに PR を作る（PBI-110）
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
        [chooseApp, out("# 要求要件"), design, implement("# 実装の説明")],
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

  describe("時間切れで止めた実装の再開（PBI-280）", () => {
    const timeout: AgentOutcome = {
      kind: "failed",
      reason: "error",
      message: message("run.timeout", { minutes: 3 }),
    };
    const argAfter = (inv: Invocation | undefined, name: string) => {
      const i = inv?.command.indexOf(name) ?? -1;
      return i >= 0 ? inv?.command[i + 1] : undefined;
    };

    it("時間切れ後にコンテキストの準備が失敗しても起点とセッションを引き継ぐ", async () => {
      const sessionLogs = new SessionLogStore(join(dir, "runs"));
      const repos = new FakeRepos();
      const baseline = repos.tree;
      const { activity, service, executor, id } = await toImplement(
        [timeout, implement("# 実装")],
        { sessionLogs, repos },
      );
      executor.appendSessionFiles = true;
      executor.sessionIdOf = (inv, runId) => argAfter(inv, "--resume") ?? `session-${runId}`;
      executor.sessionFiles = (inv, runId) => ({
        [`projects/-workspace/${argAfter(inv, "--resume") ?? `session-${runId}`}.jsonl`]: "{}\n",
      });
      await service.runNext(id);
      const stopped = service.get(id)?.activity.find((e) => e.type === "AgentRunTimedOut");
      if (stopped?.type !== "AgentRunTimedOut") throw new Error("timeout missing");
      const context = vi
        .spyOn(service as never, "runContext")
        .mockRejectedValueOnce(new Error("context failed"));
      service.resume(id, {});
      await service.runNext(id);
      expect(
        service.get(id)?.activity.findLast((e) => e.type === "AgentRunFailed")?.payload,
      ).toMatchObject({ preparationFailed: true });
      context.mockRestore();
      repos.tree = "a".repeat(40);
      service.resume(id, {});
      await service.runNext(id);
      const start = service
        .get(id)
        ?.activity.findLast((e) => e.type === "AgentRunStarted" && e.payload.step === "implement");
      expect(start?.type === "AgentRunStarted" && start.payload.formattingBaseline?.tree).toBe(
        baseline,
      );
      expect(argAfter(executor.calls.at(-1), "--resume")).toBe(`session-${stopped.payload.runId}`);
      activity.close();
    });

    it("実装が時間切れで止まっても作業領域の変更は残り、再開した実装は同じ作業領域で、同じセッションの続きから進む", async () => {
      const sessionLogs = new SessionLogStore(join(dir, "runs"));
      const { activity, service, executor, repos, id } = await toImplement(
        [timeout, implement("# 実装")],
        { sessionLogs },
      );
      const claudeId = (inv: Invocation, runId: string) =>
        argAfter(inv, "--resume") ?? `session-${runId}`;
      executor.appendSessionFiles = true;
      executor.sessionIdOf = claudeId;
      executor.sessionFiles = (inv, runId) => ({
        [`projects/-workspace/${claudeId(inv, runId)}.jsonl`]: `${JSON.stringify({ run: runId })}\n`,
      });
      // 1 回目の実装がクローンの作業領域に書いたまま、時間切れで止まる（未コミットの変更）
      const workDir = repos.prepared[0]?.dir ?? "";
      const run = executor.run.bind(executor);
      let wrote = false;
      executor.run = async (input) => {
        if (!wrote && input.workspaceDir === workDir) {
          writeFileSync(join(workDir, "partial.ts"), "export const wip = 1;\n");
          wrote = true;
        }
        return run(input);
      };
      const before = executor.calls.length;
      await service.runNext(id);
      expect(service.get(id)?.task.status).toBe("paused");
      // 止めた後も、作業領域の変更はそのまま残っている（退避しなくてもよい）
      expect(readFileSync(join(workDir, "partial.ts"), "utf8")).toBe("export const wip = 1;\n");
      service.resume(id, {});
      await drain(service);
      const resumed = before + 1;
      // 同じ作業領域で、止める前の変更を見て続け、同じセッションを再開する
      expect(executor.dirs[resumed]).toBe(workDir);
      expect(executor.dirs[before]).toBe(workDir);
      expect(executor.workspaceFiles[resumed]).toContain("partial.ts");
      const stopped = (service.get(id)?.activity ?? []).find((e) => e.type === "AgentRunTimedOut");
      expect(stopped?.payload).toMatchObject({ role: "implement", minutes: 3 });
      const stoppedRun = stopped && "runId" in stopped.payload ? stopped.payload.runId : "";
      expect(argAfter(executor.calls[resumed], "--resume")).toBe(`session-${stoppedRun}`);
      expect(executor.stdins[resumed]).toContain("【時間切れからの再開】");
      expect(executor.stdins[resumed]).toContain("未コミットの変更も含む");
      expect(
        (service.get(id)?.activity ?? []).flatMap((e) =>
          e.type === "AgentRunContinued" ? [e.payload] : [],
        ),
      ).toMatchObject([{ role: "implement", mode: "resumed", stoppedRunId: stoppedRun }]);
      // 再開した実装が最後の実行で、そのまま実装の承認待ちになる
      expect(executor.calls).toHaveLength(resumed + 1);
      expect(service.get(id)?.task.gate?.step).toBe("implement");
      activity.close();
    });
  });
});
