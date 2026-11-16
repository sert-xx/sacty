import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { DaemonText, StepKey, Task } from "@sacty/core";
import {
  exportDue,
  isCompleted,
  MAX_CHANGE_REQUESTS,
  MAX_INCOMPLETE_CONTINUATIONS,
  MVP_STEPS,
  message,
  renderMessage,
  reviewedPullRequest,
  STEP_PLANS,
} from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import { COMPLETION_FENCE } from "./completion.js";
import type { ConfigResult } from "./config.js";
import type { PullRequestFeedback } from "./github.js";
import { PlatformFile, toPlatform } from "./platforms.js";
import { MemoryProjectStore } from "./projects.js";
import {
  DRAFT_SETTLE_FACTOR,
  reviewTaskTitle,
  type ServiceDeps,
  type TaskService,
} from "./service.js";
import { MemorySettingsStore } from "./settings.js";
import {
  agent,
  appendLegacy,
  configOf,
  dbPath,
  dir,
  type FakeExecutor,
  FakeGitHub,
  FakePulls,
  FakeRepos,
  fakeGateway,
  ja,
  makeService,
  projectsWithAccount,
  useTempDir,
} from "./testing/daemon.js";

useTempDir();

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
      /** 工程の選び方（無ければ、どのタスクも steps の工程にする）。 */
      planner?: ServiceDeps["planner"];
      /** PR の CI の読み取り（PR のレビューの子タスクに渡す）。渡すと、実装の PR をドラフトで作る。 */
      ci?: ServiceDeps["ci"];
      /** sacty が作った PR をレビューする子タスクを作る（PBI-330）。 */
      reviewTasks?: boolean;
      /** 情報収集を差し替える（無ければ、集めずに進める）。 */
      gatherer?: ServiceDeps["gatherer"];
      /** レビューの子タスクが CI を読むのを待つ上限（ミリ秒。PBI-331）。 */
      reviewCiTimeoutMs?: number;
      /** ドラフトを外す・戻す・先頭を読む答えを待つ上限（ミリ秒。PBI-331）。 */
      draftTimeoutMs?: number;
      /** 実装を始める前に、ベースブランチの最新を作業領域に取り込む（既定は取り込まない）。 */
      mergeBase?: boolean;
      /** 今の時刻（無ければ、PR の指摘を書き終わるのを待つ時間がたった時刻）。 */
      now?: () => number;
    } = {},
  ) {
    const activity = new SqliteActivityStore(options.db ?? dbPath);
    const pulls = options.pulls ?? new FakePulls();
    const repos = options.repos ?? new FakeRepos();
    const made = makeService(activity, outcomes, {
      ...(options.settings ? { settings: options.settings } : {}),
      ...(options.github ? { github: options.github } : {}),
      stepPullRequests: true,
      ...(options.ci ? { ci: options.ci, draftPullRequests: true } : {}),
      ...(options.reviewTasks ? { reviewTasks: true } : {}),
      ...(options.mergeBase ? { mergeBase: true } : {}),
      ...(options.gatherer ? { gatherer: options.gatherer } : {}),
      ...(options.reviewCiTimeoutMs ? { reviewCiTimeoutMs: options.reviewCiTimeoutMs } : {}),
      ...(options.draftTimeoutMs ? { draftTimeoutMs: options.draftTimeoutMs } : {}),
      now: options.now ?? later,
      pulls,
      repos,
      ...(options.projects ? { projects: options.projects } : {}),
      ...(options.config ? { config: options.config } : {}),
      ...(options.gateway ? { gateway: options.gateway } : {}),
      planner:
        options.planner ??
        (async () => ({
          steps: [...(options.steps ?? MVP_STEPS)],
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
          ...(options.documentsDir ? { documentsDir: options.documentsDir } : {}),
          ...(options.exports ? { exports: options.exports } : {}),
        })),
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

  it("要求要件の PR のマージ待ちで一時停止すると、止めている間のマージは見守らず、再開したあとの確認で承認として進む（PBI-301）", async () => {
    const made = await start([out("# 要求要件"), design()]);
    const { service, id } = made;
    expect(taskOf(service, id).gate).toEqual({ step: "requirements", submission: 1 });
    await service.pause(id);
    expect(taskOf(service, id).status).toBe("paused");
    expect(taskOf(service, id).gate).toEqual({ step: "requirements", submission: 1 });
    // 止めている間にマージされても、承認として進めない（実装の PR と違い、作り直しの間の見守りの対象ではない）
    await merge(made, "requirements");
    expect(taskOf(service, id).status).toBe("paused");
    expect(taskOf(service, id).approved.requirements).toBeUndefined();
    // 再開すると承認待ちに戻り、次の確認が、止めていた間のマージを承認として取り込む
    expect(service.resume(id, {}).status).toBe("awaiting_approval");
    await service.checkPullRequests();
    expect(taskOf(service, id).approved.requirements?.submission).toBe(1);
    expect(taskOf(service, id).stepPullRequests[0]?.state).toBe("merged");
    made.activity.close();
  });

  it("タスクブランチに sacty が積んでいない変更があれば、実装で消さないよう、実装の PR を出さずに止める（レビュー指摘）", async () => {
    const made = await start([
      out("# 要求要件"),
      design(),
      implement(),
      rework("implement"),
      implement("# 直した実装"),
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
      `タスクブランチ ${taskBranchOf(id)} に、Sacty が積んでいない変更があります（human-fix.ts, src/b.ts）`,
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
    // 実装の PR の指摘で実装をやり直して出し直すときは、sacty が積んだ実装のコミットの後に人が足したコミットを、作業領域に
    // 取り込んでから、その先頭に積む（PBI-334。要求要件・設計のファイルは、タスクブランチのものを引き継ぐので取り込みから外す）
    const pushed = taskOf(service, id).pushedBranch?.commit ?? "";
    expect(pushed).not.toBe("");
    // タスクブランチは、sacty の実装のコミットの後に進んでいる（GitHub の画面で PR のブランチを更新したなど）
    repos.remote[taskBranchOf(id)] = "d".repeat(40);
    repos.changed = [];
    const checked = repos.changedCalls.length;
    const number = taskOf(service, id).pullRequest?.number ?? 0;
    pulls.feedbackBy[number] = [item("comment:50", { body: "エラー時の処理が無い" })];
    await service.checkPullRequests();
    await drain(service);
    expect(repos.merges.at(-1)).toMatchObject({
      base: pushed,
      target: "d".repeat(40),
      exclude: [docOf(id, "requirements"), docOf(id, "design")],
    });
    // 取り込んだ先頭は、人の変更として確かめ直さない
    expect(repos.changedCalls).toHaveLength(checked);
    expect(repos.published).toHaveLength(2);
    expect(repos.published[1]?.parent).toBe("d".repeat(40));
    made.activity.close();
  });

  it("要求要件・設計の PR（タスクブランチへの PR）は、競合を示されても記録しない（ベースブランチの取り込みは実装の工程だけ）", async () => {
    const made = await start([out("# 要求要件 v1"), design(), implement()]);
    const { activity, service, pulls, id } = made;
    const before = types(service, id);
    pulls.states[7] = { state: "open", mergeable: false };
    await service.checkPullRequests();
    expect(types(service, id)).toEqual(before);
    expect(taskOf(service, id).pullRequestConflict).toBeUndefined();
    activity.close();
  });

  it("タスクブランチを作り、要求要件・設計の PR を成果のファイル入りでタスクブランチに向けて順に作り、マージで承認して進み、実装の PR はベースブランチに向ける（受け入れ条件 1・2・4）", async () => {
    const made = await start([out("# 要求要件 v1"), design(), implement()]);
    const { activity, service, repos, pulls, id } = made;
    const taskBranch = taskBranchOf(id);
    // 1. タスクブランチ（起点のコミットから）と、要求要件のブランチ・PR
    expect(repos.pushedCommits).toEqual([{ commit: "base123", branch: taskBranch }]);
    expect(types(service, id).slice(-6)).toEqual([
      "AgentRunCompleted",
      "TaskBranchCreated",
      "StepBranchPushed",
      "PullRequestBodyWritten",
      "StepPullRequestPublished",
      "StepSubmitted",
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
    expect(types(service, id).at(-1)).toBe("StepSubmitted");

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
        // コミットの日時は、実装の工程の実行が終わった日時（PBI-331）
        date: service
          .get(id)
          ?.activity.findLast(
            (e) => e.type === "AgentRunCompleted" && e.payload.step === "implement",
          )?.at,
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
    // 全文は載せず、マージで承認した PR へのリンクにする（PBI-264）
    expect(pulls.calls[2]?.body).toContain("## 要求要件（人間が承認済み）");
    expect(pulls.calls[2]?.body).toContain("全文は、マージで承認した次の PR にあります。");
    // 成果物は PR に出したコミットのファイルへ、PR は番号のリンクにする（PBI-322）
    expect(pulls.calls[2]?.body).toMatch(
      /- 要求要件：\[`docs\/sacty\/[^`]+\/requirements\.md`\]\(https:\/\/github\.com\/acme\/app\/blob\/[0-9a-z]+\/docs\/sacty\/[^)]+\/requirements\.md\)（PR：\[#7\]\(https:\/\/github\.com\/acme\/app\/pull\/7\)）/,
    );
    expect(pulls.calls[2]?.body).toMatch(
      /- 設計：\[`docs\/sacty\/[^`]+\/design\.md`\]\(https:\/\/github\.com\/acme\/app\/blob\/[0-9a-z]+\/docs\/sacty\/[^)]+\/design\.md\)（PR：\[#8\]\(https:\/\/github\.com\/acme\/app\/pull\/8\)）/,
    );
    task = taskOf(service, id);
    expect(task.gate).toEqual({ step: "implement", submission: 1 });
    expect(task.pullRequest).toMatchObject({ number: 9, branch: taskBranch });
    // sacty の PR にラベルは付けない（レビューは子タスク。PBI-330）
    expect(pulls.labels).toEqual([]);
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
      ["ReworkJudged", "agent"],
      ["ChangesRequested", "person"],
    ]);
    expect(events.at(-2)?.payload).toMatchObject({
      target: "requirements",
      reason: "要求要件で直せる",
    });
    // ゴールガーディアンには、PR の要求要件と指摘を、起点のコードの写しとあわせて渡す
    const prompt = promptOf(executor, before);
    expect(prompt).toContain("要求要件の PR に付いた指摘");
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

  describe("質問への答えだけのコメント（PBI-302 B1）", () => {
    const v1 = [
      "# 要求要件 v1",
      "",
      "## 確認したいこと",
      "",
      "- should：国名の表示は要るか（推奨：要らない）",
    ].join("\n");
    const answerJudged = (answer?: string, cause = "question_answer", target = "requirements") =>
      out(
        block({
          "sacty-rework": {
            target,
            cause,
            ...(answer ? { answer } : {}),
            reason: "決定を変えない：確認したいことの should に答えただけ",
          },
        }),
      );
    const answered = (outcomes: AgentOutcome[]) => start([out(v1), ...outcomes]);

    it("推奨どおりの答えだけなら、原因を質問への答えとして記録し、成果物の作り直しとセルフレビューを走らせない答えの反映だけの直しにする", async () => {
      const made = await answered([answerJudged("as_recommended"), out("# 要求要件 v2")]);
      const { activity, service, executor, pulls, id } = made;
      pulls.feedbackBy[7] = [item("comment:1", { body: "推奨どおりでお願いします" })];
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      expect(events.find((e) => e.type === "ReworkJudged")?.payload).toMatchObject({
        target: "requirements",
        cause: "question_answer",
        answer: "as_recommended",
      });
      expect(events.find((e) => e.type === "ChangesRequested")?.payload).toMatchObject({
        step: "requirements",
        target: "requirements",
        cause: "question_answer",
        answer: "as_recommended",
      });
      // 新しい要望・見逃しの記録にはしない
      expect(events.some((e) => e.type === "GuardianMissed")).toBe(false);
      expect(taskOf(service, id).prRework).toMatchObject({
        target: "requirements",
        cause: "question_answer",
        answer: "as_recommended",
      });
      // 直しの実行：答えの反映だけを求め、セルフレビューは求めない
      const before = executor.calls.length;
      await service.runNext(id);
      const prompt = promptOf(executor, before);
      expect(prompt).toContain("「確認したいこと」への答えの反映だけ");
      expect(prompt).toContain("[requirements-1-1] 推奨どおりでお願いします");
      expect(prompt).toContain("--- 提出の前の確認（セルフレビューは行わない） ---");
      expect(prompt).not.toContain("--- 提出の前のセルフレビュー ---");
      expect(taskOf(service, id).gate).toEqual({ step: "requirements", submission: 2 });
      // スコープの節の無い前回の下書き（PBI-340 より前）には、スコープを足して並べ直すことを例外として許す（PR #363 のレビュー）
      expect(prompt).toContain(
        "例外：前回の下書きには、冒頭に、対象と対象外を書いた「スコープ」の節がありません",
      );
      expect(prompt).toContain(
        "冒頭に「スコープ」の節があり、「スコープ」「確認したいこと」「既定で決めたこと」の順になっている",
      );
      activity.close();
    });

    it("前回の下書きにスコープの節があれば、答えの反映だけの直しにスコープの例外を足さない（PBI-340）", async () => {
      const scoped = [
        "# 要求要件 v1",
        "",
        "## スコープ",
        "",
        "- 対象：一覧",
        "- 対象外：なし",
        "",
        v1.split("\n").slice(2).join("\n"),
      ].join("\n");
      const made = await start([out(scoped), answerJudged("as_recommended"), out("# 要求要件 v2")]);
      const { activity, service, executor, pulls, id } = made;
      pulls.feedbackBy[7] = [item("comment:1", { body: "推奨どおりでお願いします" })];
      await service.checkPullRequests();
      const before = executor.calls.length;
      await service.runNext(id);
      const prompt = promptOf(executor, before);
      expect(prompt).toContain("「確認したいこと」への答えの反映だけ");
      expect(prompt).not.toContain(
        "例外：前回の下書きには、冒頭に、対象と対象外を書いた「スコープ」の節がありません",
      );
      expect(prompt).toContain("答えを反映した所以外が、前回の下書きと一字一句同じである");
      activity.close();
    });

    it("スコープの節が後ろにある前回の下書きには、冒頭に移して並べ直す例外を足す（PR #363 の再レビュー）", async () => {
      const late = [v1, "", "## スコープ", "", "- 対象：一覧", "- 対象外：なし"].join("\n");
      const made = await start([out(late), answerJudged("as_recommended"), out("# 要求要件 v2")]);
      const { activity, service, executor, pulls, id } = made;
      pulls.feedbackBy[7] = [item("comment:1", { body: "推奨どおりでお願いします" })];
      await service.checkPullRequests();
      const before = executor.calls.length;
      await service.runNext(id);
      const prompt = promptOf(executor, before);
      expect(prompt).toContain(
        "例外：前回の下書きには、冒頭に、対象と対象外を書いた「スコープ」の節がありません",
      );
      expect(prompt).toContain("後ろにあれば冒頭に移し");
      expect(prompt).toContain(
        "冒頭に「スコープ」の節があり、「スコープ」「確認したいこと」「既定で決めたこと」の順になっている",
      );
      activity.close();
    });

    it("スコープの節に対象外の行が無い前回の下書きには、答えの反映だけの直しでも補う例外を足す（PR #363 の再レビュー）", async () => {
      const noOut = [
        "# 要求要件 v1",
        "",
        "## スコープ",
        "",
        "- 対象：一覧",
        "",
        v1.split("\n").slice(2).join("\n"),
      ].join("\n");
      const made = await start([out(noOut), answerJudged("as_recommended"), out("# 要求要件 v2")]);
      const { activity, service, executor, pulls, id } = made;
      pulls.feedbackBy[7] = [item("comment:1", { body: "推奨どおりでお願いします" })];
      await service.checkPullRequests();
      const before = executor.calls.length;
      await service.runNext(id);
      const prompt = promptOf(executor, before);
      expect(prompt).toContain("「確認したいこと」への答えの反映だけ");
      expect(prompt).toContain(
        "例外：前回の下書きには、冒頭に、対象と対象外を書いた「スコープ」の節がありません",
      );
      expect(prompt).toContain("スコープの節に対象と対象外の行がある");
      activity.close();
    });

    it("推奨と違う答えは、原因は質問への答えのまま、今までどおりの直しの実行（作り直しとセルフレビュー）にする", async () => {
      const made = await answered([answerJudged("changes_decision"), out("# 要求要件 v2")]);
      const { activity, service, executor, pulls, id } = made;
      pulls.feedbackBy[7] = [item("comment:1", { body: "国名は表示してください" })];
      await service.checkPullRequests();
      const events = service.get(id)?.activity ?? [];
      expect(events.find((e) => e.type === "ChangesRequested")?.payload).toMatchObject({
        cause: "question_answer",
        answer: "changes_decision",
      });
      const before = executor.calls.length;
      await service.runNext(id);
      const prompt = promptOf(executor, before);
      expect(prompt).not.toContain("答えの反映だけ");
      expect(prompt).toContain("--- 提出の前のセルフレビュー ---");
      activity.close();
    });

    it("答えの扱いを読めなかった・原因が別なら、今までどおり。答えの扱いを記録しない", async () => {
      for (const judged of [
        answerJudged(undefined),
        answerJudged("as_recommended", "new_request"),
      ]) {
        const made = await answered([judged, out("# 要求要件 v2")]);
        const { activity, service, executor, pulls, id } = made;
        pulls.feedbackBy[7] = [item("comment:1", { body: "推奨どおりでお願いします" })];
        await service.checkPullRequests();
        const change = service.get(id)?.activity.find((e) => e.type === "ChangesRequested");
        expect(change?.payload).not.toHaveProperty("answer");
        const before = executor.calls.length;
        await service.runNext(id);
        expect(promptOf(executor, before)).toContain("--- 提出の前のセルフレビュー ---");
        activity.close();
      }
    });

    it("設計の PR で、推奨どおりと判断しても前の工程（要求要件）へ戻すなら、軽い直しにしない（答えの扱いを記録しない）", async () => {
      const made = await start([
        out("# 要求要件 v1"),
        design("# 設計 v1"),
        answerJudged("as_recommended", "question_answer", "requirements"),
        out("# 要求要件 v2"),
      ]);
      const { activity, service, executor, pulls, id } = made;
      await merge(made, "requirements");
      await service.runNext(id);
      pulls.feedbackBy[8] = [item("comment:20", { body: "推奨どおり" })];
      await service.checkPullRequests();
      const change = service.get(id)?.activity.find((e) => e.type === "ChangesRequested");
      expect(change?.payload).toMatchObject({ step: "design", target: "requirements" });
      expect(change?.payload).not.toHaveProperty("answer");
      const before = executor.calls.length;
      await service.runNext(id);
      expect(promptOf(executor, before)).not.toContain("答えの反映だけ");
      activity.close();
    });
  });

  describe("行へのコメントの指摘に、その行の内容を添える（PBI-302 B3）", () => {
    it("コメントが付いた行の内容と直前の行を指摘の文に添え、戻し先の判断と直しの実行に、行番号でなく内容で箇所を確かめさせる", async () => {
      const made = await start([
        out("# 要求要件 v1"),
        out(block({ "sacty-rework": { target: "requirements", reason: "要求要件で直せる" } })),
        out("# 要求要件 v2"),
      ]);
      const { activity, service, executor, pulls, id } = made;
      pulls.feedbackBy[7] = [
        item("review_comment:2", {
          kind: "review_comment",
          path: docOf(id, "requirements"),
          line: 89,
          body: "ここは空の入力も拒否してください",
          lineContext: { line: "| R-9 | 空を拒否する |", before: ["| R-8 | 上限は 50 |"] },
        }),
        item("review_comment:3", {
          kind: "review_comment",
          path: docOf(id, "requirements"),
          line: 10,
          body: "抜粋の無いコメント",
        }),
      ];
      const before = executor.calls.length;
      await service.checkPullRequests();
      const remarks = taskOf(service, id).remarks.map((r) => r.text);
      expect(remarks[0]).toBe(
        `${docOf(id, "requirements")}:89：ここは空の入力も拒否してください\n（コメントが付いた行の内容：「| R-9 | 空を拒否する |」。直前の行：「| R-8 | 上限は 50 |」）`,
      );
      // 抜粋の無いコメントは、今までどおり
      expect(remarks[1]).toBe(`${docOf(id, "requirements")}:10：抜粋の無いコメント`);
      const guardian = promptOf(executor, before);
      expect(guardian).toContain("（コメントが付いた行の内容：「| R-9 | 空を拒否する |」");
      expect(guardian).toContain("添えた行の内容で確かめてください");
      await service.runNext(id);
      const rerun = promptOf(executor, executor.calls.length - 1);
      expect(rerun).toContain("（コメントが付いた行の内容：「| R-9 | 空を拒否する |」");
      expect(rerun).toContain("添えた行の内容で確かめてください");
      activity.close();
    });

    it("長い指摘でも、添える行の内容は切らない（指摘の文を短くして、上限に収める）", async () => {
      const made = await start([
        out("# 要求要件 v1"),
        out(block({ "sacty-rework": { target: "requirements", reason: "要求要件で直せる" } })),
      ]);
      const { activity, service, pulls, id } = made;
      pulls.feedbackBy[7] = [
        item("review_comment:2", {
          kind: "review_comment",
          path: docOf(id, "requirements"),
          line: 3,
          body: "あ".repeat(5_000),
          lineContext: { line: "| R-9 | 空を拒否する |", before: [] },
        }),
      ];
      await service.checkPullRequests();
      const text = taskOf(service, id).remarks[0]?.text ?? "";
      expect(text.length).toBeLessThanOrEqual(2_000);
      expect(text.endsWith("（コメントが付いた行の内容：「| R-9 | 空を拒否する |」）")).toBe(true);
      activity.close();
    });
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
    // sacty の PR にラベルは付けない（PBI-330）
    expect(pulls.labels).toEqual([]);
    activity.close();
  });

  it("実装の PR の指摘で設計に戻したら、設計の直しの PR を作り、マージされたら実装をやり直して実装の PR を更新する（受け入れ条件 5）", async () => {
    const made = await start([
      out("# 要求要件 v1"),
      design("# 設計 v1"),
      implement(),
      rework("design", "観点が足りない"),
      design("# 設計 v2"),
      implement("# 実装の説明 v2"),
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
      [out("# 要求要件"), implement("# 実装", [{ viewpointId: "REQ", tests: ["a"] }])],
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
      const made = await start([out("# 要求要件 v1"), design(), implement()]);
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

    it("人が直した版を承認済みにしたら、前のセルフレビューの「パス」と出典の分類を残さず記録なしにする。直していなければ残す（PR #130 レビュー指摘）", async () => {
      const report = [
        '```json\n{"sacty-self-review": {"rounds": 2, "passed": true}}\n```',
        '```json\n{"sacty-provenance": {"mode": "subagent", "items": []}}\n```',
      ].join("\n\n");
      for (const edited of [true, false]) {
        const made = await start([out(`# 要求要件 v1\n\n${report}`)]);
        const { activity, service, id } = made;
        expect(taskOf(service, id).selfReviews?.requirements?.passed).toBe(true);
        mergeEdited(
          made,
          "requirements",
          edited ? `${header(id, "要求要件")}# 要求要件（人が直した）\n` : undefined,
        );
        await service.checkPullRequests();
        const task = taskOf(service, id);
        expect(task.approved.requirements?.output).toBe(
          edited ? "# 要求要件（人が直した）" : "# 要求要件 v1",
        );
        if (edited) expect(task.selfReviews?.requirements).toBeNull();
        else expect(task.selfReviews?.requirements?.passed).toBe(true);
        // 人が直した本文の項目は分類していない
        if (edited) expect(task.provenances?.requirements).toBeNull();
        else expect(task.provenances?.requirements?.sequential).toBe(false);
        activity.close();
        rmSync(dbPath, { force: true });
      }
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

  describe("sacty が作る PR を、その工程の子タスクでレビューする（PBI-330）", () => {
    const labeledPr = (number: number, labels = ["sacty-review"]) => ({
      repo: "https://github.com/acme/app",
      number,
      title: `PR ${number}`,
      body: "本文",
      url: `https://github.com/acme/app/pull/${number}`,
      labels,
      pullRequest: true,
    });
    const verdictOut = (verdict: string, text = "# 評価\n\n受け入れ条件が足りない") =>
      out(`${text}\n\n${block({ "sacty-review-verdict": { verdict } })}`);
    /** 親のタスクの、その番号の PR のレビューの子タスクの ID。 */
    const childOf = (svc: TaskService, id: string, number = 7) =>
      taskOf(svc, id).reviewTasks?.find((r) => r.number === number)?.taskId ?? "";
    /** 親のタスクが、その番号の PR に最後に積んだコミット。 */
    const commitOf = (svc: TaskService, id: string, number = 7) => {
      const t = taskOf(svc, id);
      return (
        t.stepPullRequests.findLast((p) => p.number === number)?.commit ??
        (t.pullRequest?.number === number ? t.pullRequest.commit : undefined) ??
        ""
      );
    };
    /** レビューの子タスクを、レビューを投稿して終わるまで進める。 */
    const runReview = async (svc: TaskService, childId: string) => {
      for (let i = 0; i < 4 && !isCompleted(taskOf(svc, childId)); i++) await svc.runNext(childId);
    };
    const posted = (pulls: FakePulls, n: number, author = "me") =>
      item(`review:${50 + n}`, { kind: "review", author, body: pulls.reviews[n]?.body ?? "" });

    describe("PR の指摘の戻し先を、ゴールガーディアンではなくレビューの子タスクが示す（PBI-332）", () => {
      const reworkOut = (verdict: string, rework?: unknown) =>
        out(
          `# 評価\n\n指摘あり\n\n${block({ "sacty-review-verdict": { verdict, ...(rework ? { rework } : {}) } })}`,
        );
      /** 要求要件の PR をマージして、設計の PR を作って承認待ちにする。 */
      async function designed(outcomes: AgentOutcome[], config?: () => ConfigResult) {
        const pulls = new FakePulls();
        const made = await start([out("# 要求要件 v1"), out("# 設計 v1"), ...outcomes], {
          pulls,
          steps: ["requirements", "design"],
          reviewTasks: true,
          ...(config ? { config } : {}),
        });
        await merge({ ...made, pulls }, "requirements");
        const { service, id } = made;
        for (let i = 0; i < 4 && taskOf(service, id).gate?.step !== "design"; i++) {
          await service.runNext(id);
        }
        const pr = taskOf(service, id).stepPullRequests.findLast((x) => x.step === "design");
        const number = pr?.number ?? 0;
        pulls.prInfo = { ...pulls.prInfo, number, headSha: pr?.commit ?? "" };
        return { ...made, pulls, number, childId: childOf(service, id, number) };
      }
      const judged = (svc: TaskService, id: string) =>
        svc.get(id)?.activity.filter((e) => e.type === "ReworkJudged") ?? [];

      it("子タスクが指摘ごとに戻し先を示し、前の工程の決定を変える指摘があれば、判断の実行をせずにその工程へ戻す（受け入れ条件 1・4）", async () => {
        const made = await designed([
          reworkOut("changes_required", {
            findings: [
              { finding: "見出しの誤字", target: "design", reason: "決定を変えない：表記だけ" },
              {
                finding: "受け入れ条件 2 の上限を変える",
                target: "requirements",
                reason: "決定を変える：承認済みの要求要件の上限を変える",
              },
            ],
            cause: "guardian_missed",
          }),
        ]);
        const { activity, service, pulls, executor, id, number, childId } = made;
        expect(childId).not.toBe("");
        const before = executor.calls.length;
        await runReview(service, childId);
        // 子タスクに、戻し先の候補と承認済みの前の工程の成果物を渡す
        const prompt = executor.calls[before]?.command.join(" ") ?? "";
        expect(prompt).toContain("--- 指摘の戻し先 ---");
        expect(prompt).toContain("- design（設計）：この PR の設計を直せば解消できる");
        expect(prompt).toContain(
          "- requirements（要求要件）：解消するには、承認済みの要求要件の決定を変える",
        );
        expect(prompt).toContain("# 要求要件 v1");
        expect(taskOf(service, childId).reviewVerdicts?.at(-1)?.rework?.findings).toHaveLength(2);
        const calls = executor.calls.length;
        pulls.feedbackBy[number] = [posted(pulls, 0)];
        await service.checkPullRequests();
        for (let i = 0; i < 2 && judged(service, id).length === 0; i++) await service.runNext(id);
        // 判断の実行（ゴールガーディアン・工程のエージェント）をしない
        expect(executor.calls.slice(calls).map((c) => c.command.join(" "))).not.toContainEqual(
          expect.stringContaining("どの工程からやり直せば解消できるか"),
        );
        const [event] = judged(service, id);
        expect(event).toMatchObject({
          actor: "sacty",
          payload: {
            target: "requirements",
            cause: "guardian_missed",
            reviewTaskId: childId,
            runResult: "completed",
            costUsd: 0,
          },
        });
        expect(String(event?.type === "ReworkJudged" && event.payload.reason)).toContain(
          "決定を変える：承認済みの要求要件の上限を変える",
        );
        expect(types(service, id)).not.toContain("ChangeJudged");
        activity.close();
      });

      it("戻し先が読めない・知らない値・無いなら、その PR の工程で直す（受け入れ条件 1）", async () => {
        const made = await designed([
          reworkOut("changes_required", {
            findings: [{ finding: "誤字", target: "deploy-later", reason: "不明" }],
            cause: "base_changed",
          }),
        ]);
        const { activity, service, pulls, id, number, childId } = made;
        await runReview(service, childId);
        pulls.feedbackBy[number] = [posted(pulls, 0)];
        await service.checkPullRequests();
        for (let i = 0; i < 2 && judged(service, id).length === 0; i++) await service.runNext(id);
        expect(judged(service, id)[0]).toMatchObject({
          actor: "sacty",
          payload: { target: "design", cause: "base_changed", reviewTaskId: childId },
        });
        activity.close();
      });

      it("子タスクの答えに戻し先が無ければ、その PR の工程で直し、読めなかったことを理由に残す（受け入れ条件 1）", async () => {
        const made = await designed([reworkOut("changes_required")]);
        const { activity, service, pulls, id, number, childId } = made;
        await runReview(service, childId);
        pulls.feedbackBy[number] = [posted(pulls, 0)];
        await service.checkPullRequests();
        for (let i = 0; i < 2 && judged(service, id).length === 0; i++) await service.runNext(id);
        expect(judged(service, id)[0]).toMatchObject({
          actor: "sacty",
          payload: {
            target: "design",
            reason: { code: "rework.reviewTaskUnreadable" },
            reviewTaskId: childId,
          },
        });
        activity.close();
      });

      it("人の指摘を含むときは、ゴールガーディアンではなく PR の工程のエージェントが戻し先を判断する（受け入れ条件 2・3）", async () => {
        // ゴールガーディアンの設定を、工程のエージェントと別にする（どちらが判断したかを見分ける）
        const base = configOf(agent())();
        const config = (): ConfigResult =>
          base.ok
            ? { ok: true, config: { ...base.config, guardianAgent: agent({ id: "guardian" }) } }
            : base;
        const made = await designed(
          [
            reworkOut("changes_required", {
              findings: [{ finding: "誤字", target: "design", reason: "決定を変えない" }],
            }),
            rework("design", "決定を変えない：人の指摘は表記だけ"),
          ],
          config,
        );
        const { activity, service, pulls, executor, id, number, childId } = made;
        await runReview(service, childId);
        const calls = executor.calls.length;
        pulls.feedbackBy[number] = [
          posted(pulls, 0),
          item("comment:900", { kind: "comment", author: "reviewer", body: "ここも直して" }),
        ];
        await service.checkPullRequests();
        for (let i = 0; i < 2 && judged(service, id).length === 0; i++) await service.runNext(id);
        const prompt = executor.calls[calls]?.command.join(" ") ?? "";
        expect(prompt).toContain("どの工程からやり直せば解消できるかを判断してください");
        expect(prompt).not.toContain("ゴールガーディアン");
        expect(judged(service, id)[0]).toMatchObject({
          actor: "agent",
          payload: { target: "design", agentId: "claude-subscription", runResult: "completed" },
        });
        expect(judged(service, id)[0]?.payload).not.toHaveProperty("reviewTaskId");
        activity.close();
      });
      it("AI のレビューの指摘が子タスクの最後の回の投稿でなければ、その回の戻し先を当てずに、工程のエージェントが判断する（PR #350 レビュー指摘）", async () => {
        const made = await designed([
          reworkOut("changes_required", {
            findings: [{ finding: "誤字", target: "design", reason: "決定を変えない" }],
          }),
          reworkOut("changes_required", {
            findings: [{ finding: "上限を変える", target: "requirements", reason: "決定を変える" }],
          }),
          rework("design", "決定を変えない：前の回の指摘は表記だけ"),
        ]);
        const { activity, service, pulls, executor, id, number, childId } = made;
        await runReview(service, childId);
        // 前の回の投稿を取り込む前に、子タスクが同じ先頭を再レビューした（2回目は別の戻し先を示した）
        service.rereview(childId);
        await runReview(service, childId);
        expect(taskOf(service, childId).reviewRound).toBe(2);
        const calls = executor.calls.length;
        pulls.feedbackBy[number] = [posted(pulls, 0)];
        await service.checkPullRequests();
        for (let i = 0; i < 2 && judged(service, id).length === 0; i++) await service.runNext(id);
        expect(executor.calls[calls]?.command.join(" ") ?? "").toContain(
          "どの工程からやり直せば解消できるかを判断してください",
        );
        expect(judged(service, id)[0]).toMatchObject({
          actor: "agent",
          payload: { target: "design" },
        });
        expect(judged(service, id)[0]?.payload).not.toHaveProperty("reviewTaskId");
        activity.close();
      });

      it("人が選んだ工程のエージェントが設定から消えていたら、既定のエージェントで判断せずに、理由を示して止める（PR #350 レビュー指摘）", async () => {
        const base = configOf(agent())();
        let agents: Record<string, ReturnType<typeof agent>> = { strong: agent({ id: "strong" }) };
        const config = (): ConfigResult =>
          base.ok
            ? { ok: true, config: { ...base.config, agents: { ...base.config.agents, ...agents } } }
            : base;
        const made = await designed(
          [
            reworkOut("changes_required", {
              findings: [{ finding: "誤字", target: "design", reason: "決定を変えない" }],
            }),
          ],
          config,
        );
        const { activity, service, pulls, executor, id, number, childId } = made;
        await runReview(service, childId);
        service.changeStepAgent(id, { step: "design", agent: "strong" });
        agents = {};
        const calls = executor.calls.length;
        pulls.feedbackBy[number] = [
          posted(pulls, 0),
          item("comment:901", { kind: "comment", author: "reviewer", body: "ここも直して" }),
        ];
        await service.checkPullRequests();
        const task = taskOf(service, id);
        expect(task.status).toBe("paused");
        expect(task.pausedMessage).toEqual(
          message("agent.chosenMissing", { step: "design", name: "strong" }),
        );
        // 判断を実行せず、指摘は未判断のまま残す
        expect(executor.calls.length).toBe(calls);
        expect(judged(service, id)).toHaveLength(0);
        expect(task.pendingReview?.judgement).toBeUndefined();
        expect(task.pendingReview?.remarks).toHaveLength(2);
        activity.close();
      });
    });

    describe("最終レビューと CI の待ちをせず、レビューの子タスクの指摘なしで承認待ちにする（PBI-331）", () => {
      const failingCi = (calls: string[] = []) =>
        ({
          snapshot: async (input: { commit: string }) => {
            calls.push(input.commit);
            return {
              checks: [
                {
                  kind: "workflow" as const,
                  name: "CI",
                  status: "completed" as const,
                  conclusion: "failure",
                  url: "https://example.com/runs/1",
                },
                { kind: "check" as const, name: "lint", status: "pending" as const },
              ],
              // ワークフローの中のジョブ（実行されなかったもの）
              jobs: [
                {
                  kind: "check" as const,
                  name: "e2e",
                  status: "completed" as const,
                  conclusion: "skipped",
                },
              ],
              failedRuns: [],
            };
          },
          failures: async () => [],
          rerunFailedJobs: async () => {
            throw new Error("再実行しない");
          },
        }) as unknown as ServiceDeps["ci"];
      /** 実装だけのタスクを、実装の PR を作って承認待ちになるまで進める。 */
      /**
       * 呼び出し元（スタックの名前 caller）からの PR の状態を読む答えを返さないようにする（PR #348 15回目のレビュー指摘）。
       * 読み始めたときに、待つのをやめていない（中断されていない）先の通信が何本あったかの最大を返す。
       */
      function hangStatus(pulls: FakePulls, caller: string) {
        const original = pulls.status.bind(pulls);
        const spy = vi.spyOn(pulls, "status");
        const signals: (AbortSignal | undefined)[] = [];
        let max = 0;
        spy.mockImplementation(
          (input: Parameters<FakePulls["status"]>[0] & { signal?: AbortSignal }) => {
            if (!new Error().stack?.includes(caller)) return original(input);
            signals.push(input.signal);
            max = Math.max(max, signals.filter((signal) => !signal?.aborted).length);
            return new Promise(() => {});
          },
        );
        return { signals, maxActive: () => max, restore: () => spy.mockRestore() };
      }

      async function implemented(
        outcomes: AgentOutcome[],
        ciCalls: string[] = [],
        extra: { draftTimeoutMs?: number } = {},
      ) {
        const pulls = new FakePulls();
        const made = await start([implement(), ...outcomes], {
          pulls,
          steps: ["implement"],
          reviewTasks: true,
          ci: failingCi(ciCalls),
          ...extra,
        });
        const { service, id } = made;
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        return { ...made, pulls };
      }

      it("実装の工程の後、最終レビューもテストもせずに実装の PR をドラフトで作り、レビューの子タスクを作る。CI は待たない（受け入れ条件 1・3）", async () => {
        const ciCalls: string[] = [];
        const { activity, service, pulls, executor, id } = await implemented([], ciCalls);
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(task.gate).toEqual({ step: "implement", submission: 1 });
        expect(types(service, id)).toContain("FinalReviewSkipped");
        for (const t of ["FinalReviewed", "TestsRun", "PullRequestCiFinished"]) {
          expect(types(service, id)).not.toContain(t);
        }
        // エージェントの実行は実装の工程だけ（ゴールガーディアンを動かさない）
        expect(executor.calls).toHaveLength(1);
        expect(task.pullRequest).toMatchObject({ number: 7, draft: true, awaitingReview: true });
        expect(pulls.drafts[7]).toBe(true);
        expect(pulls.draftChanges).toEqual([]);
        expect(task.pullRequestCi).toBeUndefined();
        expect(pulls.calls[0]?.body).toContain("sacty のレビュー：（sacty のレビューの子タスクが");
        expect(pulls.calls[0]?.body).not.toContain("最終レビュー：");
        // ドラフトのまま、レビューの子タスクを作る
        expect(taskOf(service, id).reviewTasks?.map((r) => [r.number, r.step])).toEqual([
          [7, "implement"],
        ]);
        // PR の確認でも、CI を読まない・再実行しない（子タスクのレビューの準備でだけ読む）
        await service.checkPullRequests();
        await service.checkPullRequests();
        expect(ciCalls).toEqual([]);
        expect(types(service, id)).not.toContain("PullRequestCiRerunRequested");
        expect(taskOf(service, id).status).toBe("awaiting_approval");
        activity.close();
      });

      it("子タスクが CI の結果を読んでレビューし、指摘を親が直したら再レビューし、指摘なしでドラフトを外して人の承認を待つ（受け入れ条件 2・3）", async () => {
        const ciCalls: string[] = [];
        const made = await implemented(
          [
            verdictOut("changes_required"),
            implement("# 実装の説明 v2"),
            verdictOut("no_findings", "# 評価\n\nマージしてよい"),
          ],
          ciCalls,
        );
        const { activity, service, pulls, executor, id } = made;
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        const before = executor.calls.length;
        await runReview(service, childId);
        // 子タスクに、レビューする先頭のコミットの CI の結果を渡し、失敗を指摘にさせる
        expect(ciCalls).toEqual([first]);
        const prompt = executor.calls[before]?.command.join(" ") ?? "";
        expect(prompt).toContain(`先頭のコミット（${first.slice(0, 7)}）の CI`);
        expect(prompt).toContain("CI：failure（https://example.com/runs/1）");
        expect(prompt).toContain("lint：実行中");
        // ワークフローの中のジョブも渡す（実行されなかった skipped を見落とさない。PR #348 6回目のレビュー指摘）
        expect(prompt).toContain("e2e：skipped");
        expect(prompt).toContain("変更による失敗なら、直すべき指摘（要修正）にする");
        // 指摘ありの回では、ドラフトを外さない
        await service.checkPullRequests();
        expect(taskOf(service, id).pullRequest?.draft).toBe(true);
        // 指摘を取り込んで直し、PR を更新する（ドラフトのまま、最終レビューもしない）
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        const second = commitOf(service, id);
        expect(second).not.toBe(first);
        expect(taskOf(service, id).pullRequest).toMatchObject({
          draft: true,
          awaitingReview: true,
        });
        expect(types(service, id).filter((t) => t === "FinalReviewSkipped")).toHaveLength(2);
        expect(types(service, id)).not.toContain("FinalReviewed");
        // 最新のコミットを再レビューし、指摘なしになったらドラフトを外す
        pulls.prInfo = { ...pulls.prInfo, headSha: second };
        await service.checkPullRequests();
        await runReview(service, childId);
        expect(taskOf(service, childId).reviewVerdicts?.at(-1)).toEqual({
          round: 2,
          verdict: "no_findings",
        });
        await service.checkPullRequests();
        const parent = taskOf(service, id);
        expect(parent.status).toBe("awaiting_approval");
        expect(parent.pullRequest?.draft).toBeUndefined();
        expect(parent.pullRequest?.awaitingReview).toBeUndefined();
        expect(pulls.draftChanges).toEqual([{ number: 7, draft: false }]);
        const ready = service.get(id)?.activity.find((e) => e.type === "PullRequestMarkedReady");
        expect(ready).toMatchObject({
          actor: "sacty",
          payload: { number: 7, commit: second, reviewTaskId: childId },
        });
        // もう一度確かめても、繰り返さない
        await service.checkPullRequests();
        expect(pulls.draftChanges).toHaveLength(1);
        expect(types(service, id).filter((t) => t === "PullRequestMarkedReady")).toHaveLength(1);
        // 再起動しても同じ状態を復元する
        const done = taskOf(service, id);
        activity.close();
        const again = new SqliteActivityStore(dbPath);
        expect(makeService(again, [], { stepPullRequests: true }).service.get(id)?.task).toEqual(
          done,
        );
        again.close();
      });

      it("ドラフトを外せなければ記録せず、次の確認でやり直す。外す間に親が変わったら記録しない（受け入れ条件 2）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        const setDraft = vi.spyOn(pulls, "setDraft").mockRejectedValueOnce(new Error("502"));
        await service.checkPullRequests();
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBe(true);
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        setDraft.mockRestore();
        await service.checkPullRequests();
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBeUndefined();
        activity.close();
      });

      it("レビューの間に人が PR にコミットを足したら、レビューしていない先頭のドラフトを外さず、その先頭を再レビューする（PR #348 レビュー指摘）", async () => {
        const made = await implemented([
          verdictOut("no_findings", "# 評価\n\n問題なし"),
          verdictOut("no_findings", "# 評価\n\n問題なし"),
        ]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        // 人が先頭にコミットを足した
        const human = "h".repeat(40);
        pulls.prInfo = { ...pulls.prInfo, headSha: human };
        await service.checkPullRequests();
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBe(true);
        expect(pulls.drafts[7]).toBe(true);
        const restarts = service.get(childId)?.activity.filter((e) => e.type === "ReviewRestarted");
        expect(restarts?.map((e) => e.payload)).toEqual([{ reason: "updated", commit: human }]);
        await runReview(service, childId);
        expect(taskOf(service, childId).reviewTarget?.headCommit).toBe(human);
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        const ready = service.get(id)?.activity.find((e) => e.type === "PullRequestMarkedReady");
        expect(ready?.payload).toMatchObject({ number: 7, commit: human });
        // 依存のある子タスクは、指摘なしにした先頭（人が足したコミット）から重ねる（PR #348 2回目のレビュー指摘）
        expect(reviewedPullRequest(taskOf(service, id))?.commit).toBe(human);
        // 外した後の確認では、指摘なしにした先頭を再レビューしない（PR #348 5回目のレビュー提案）
        await service.checkPullRequests();
        expect(
          service.get(childId)?.activity.filter((e) => e.type === "ReviewRestarted"),
        ).toHaveLength(1);
        activity.close();
      });

      it("先頭を読めなければ、ドラフトを外さずに次の確認でやり直す（PR #348 レビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        pulls.statusFail = "502";
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        pulls.statusFail = undefined;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        activity.close();
      });

      it("PR の更新でドラフトに戻した答えを受け取れず台帳に残らなくても、指摘なしで GitHub のドラフトを外す（PR #348 レビュー指摘）", async () => {
        const made = await implemented([
          verdictOut("changes_required"),
          implement("# 実装の説明 v2"),
          verdictOut("no_findings", "# 評価\n\nマージしてよい"),
        ]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        // 人がドラフトを外していた PR を、直した PR の更新でドラフトに戻す。GitHub では戻ったが、答えを受け取れない
        pulls.drafts[7] = false;
        pulls.setDraftAnswerLost = "答えを受け取れなかった";
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        pulls.setDraftAnswerLost = undefined;
        expect(taskOf(service, id).pullRequest?.draft).toBeUndefined();
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBe(true);
        expect(pulls.drafts[7]).toBe(true);
        pulls.prInfo = { ...pulls.prInfo, headSha: commitOf(service, id) };
        await service.checkPullRequests();
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        activity.close();
      });

      it("ドラフトを外す間に差し戻されたら、記録せずにドラフトに戻す（PR #348 レビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        const gate = Promise.withResolvers<void>();
        pulls.setDraftGate = gate.promise;
        const checking = service.checkPullRequests();
        await pulls.setDraftStarted.promise;
        // 外す要求の答えを待つ間に、人が画面から差し戻した
        service.requestChanges(id, {
          step: "implement",
          submission: 1,
          comments: ["ここを直して"],
        });
        pulls.setDraftGate = undefined;
        gate.resolve();
        await checking;
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        expect(pulls.drafts[7]).toBe(true);
        expect(pulls.draftChanges).toEqual([
          { number: 7, draft: false },
          { number: 7, draft: true },
        ]);
        activity.close();
      });

      it("ドラフトを外す間に人が先頭にコミットを足したら、記録せずにドラフトに戻し、その先頭を再レビューする（PR #348 2回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        const gate = Promise.withResolvers<void>();
        pulls.setDraftGate = gate.promise;
        const checking = service.checkPullRequests();
        await pulls.setDraftStarted.promise;
        // 外す要求の答えを待つ間に、人がコミットを足した
        const human = "h".repeat(40);
        pulls.prInfo = { ...pulls.prInfo, headSha: human };
        pulls.setDraftGate = undefined;
        gate.resolve();
        await checking;
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        expect(pulls.drafts[7]).toBe(true);
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBe(true);
        await service.checkPullRequests();
        const restarts = service.get(childId)?.activity.filter((e) => e.type === "ReviewRestarted");
        expect(restarts?.map((e) => e.payload)).toEqual([{ reason: "updated", commit: human }]);
        activity.close();
      });

      it("ドラフトを外す要求の答えを受け取れなければ、ドラフトに戻して記録せず、次の確認でやり直す（PR #348 2回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        // GitHub では外れたが、答えを受け取れない
        pulls.setDraftAnswerLost = "socket hang up";
        await service.checkPullRequests();
        expect(pulls.draftChanges).toEqual([
          { number: 7, draft: false },
          { number: 7, draft: true },
        ]);
        expect(pulls.drafts[7]).toBe(true);
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        pulls.setDraftAnswerLost = undefined;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        activity.close();
      });

      it("PR の更新でドラフトに戻せなかったら、指摘なしになるまで確認のたびにドラフトに戻す。戻せたら繰り返さない（PR #348 2回目のレビュー指摘）", async () => {
        const made = await implemented([
          verdictOut("changes_required"),
          implement("# 実装の説明 v2"),
          verdictOut("no_findings", "# 評価\n\nマージしてよい"),
        ]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        // 人がドラフトを外していた PR を、直した PR の更新でドラフトに戻せない
        pulls.drafts[7] = false;
        pulls.setDraftFail = "502";
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBe(true);
        expect(pulls.drafts[7]).toBe(false);
        // 確認でも戻せなければ、次の確認でやり直す
        pulls.prInfo = { ...pulls.prInfo, headSha: commitOf(service, id) };
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        pulls.setDraftFail = undefined;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        const setDraft = vi.spyOn(pulls, "setDraft");
        await service.checkPullRequests();
        expect(setDraft).not.toHaveBeenCalled();
        setDraft.mockRestore();
        // 指摘なしになったら外す
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        activity.close();
      });

      it("CI を読む答えが返らなくても、時間切れで読めなかったものとしてレビューを続ける（PR #348 3回目のレビュー指摘）", async () => {
        const pulls = new FakePulls();
        const hanging = {
          snapshot: () => new Promise(() => {}),
          failures: async () => [],
          rerunFailedJobs: async () => {
            throw new Error("再実行しない");
          },
        } as unknown as ServiceDeps["ci"];
        const made = await start([implement(), verdictOut("no_findings", "# 評価\n\n問題なし")], {
          pulls,
          steps: ["implement"],
          reviewTasks: true,
          ci: hanging,
          reviewCiTimeoutMs: 20,
        });
        const { activity, service, executor, id } = made;
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        const before = executor.calls.length;
        await runReview(service, childId);
        const prompt = executor.calls[before]?.command.join(" ") ?? "";
        expect(prompt).toContain("sacty が読めませんでした。CI の結果は本文で触れず");
        expect(taskOf(service, childId).reviewVerdicts?.at(-1)?.verdict).toBe("no_findings");
        activity.close();
      });

      it("外した後に戻せなかったドラフトは、台帳に draft が残っていても、戻せるまで確認のたびに戻す（PR #348 3回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        // 外す間に人がコミットを足し、ドラフトに戻す要求も失敗した
        const human = "h".repeat(40);
        const setDraft = vi.spyOn(pulls, "setDraft");
        setDraft.mockImplementation(async (input) => {
          if (input.draft) throw new Error("502");
          pulls.drafts[input.number] = false;
          pulls.prInfo = { ...pulls.prInfo, headSha: human };
          return { draft: false };
        });
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(taskOf(service, id).pullRequest?.draft).toBe(true);
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        // 次の確認でも戻せない
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        setDraft.mockRestore();
        // 戻せるようになったら戻し、戻せたら繰り返さない
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        const again = vi.spyOn(pulls, "setDraft");
        await service.checkPullRequests();
        expect(again).not.toHaveBeenCalled();
        again.mockRestore();
        activity.close();
      });

      it("外した後に戻せなかったドラフトは、再起動して戻せなかったことを忘れても、台帳の draft にかかわらず戻す（PR #348 4回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        // 外す間に人がコミットを足し、ドラフトに戻す要求も失敗した
        const setDraft = vi.spyOn(pulls, "setDraft");
        setDraft.mockImplementation(async (input) => {
          if (input.draft) throw new Error("502");
          pulls.drafts[input.number] = false;
          pulls.prInfo = { ...pulls.prInfo, headSha: "h".repeat(40) };
          return { draft: false };
        });
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(taskOf(service, id).pullRequest?.draft).toBe(true);
        setDraft.mockRestore();
        made.activity.close();
        // 再起動すると、戻せなかったことの記憶は消えるが、台帳の draft にかかわらず戻す
        const activity = new SqliteActivityStore(dbPath);
        const restarted = makeService(activity, [], {
          stepPullRequests: true,
          pulls,
          reviewTasks: true,
          now: later,
          ci: failingCi(),
          draftPullRequests: true,
        }).service;
        expect(taskOf(restarted, id).pullRequest?.draft).toBe(true);
        await restarted.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        expect(types(restarted, id)).not.toContain("PullRequestMarkedReady");
        activity.close();
      });

      it("ドラフトを外す答えが返らなくても待ち続けず、ドラフトに戻す。外す要求が後から届いても、指摘なしで外すまで確認のたびに戻す（PR #348 4回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")], [], {
          draftTimeoutMs: 20,
        });
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        // レビューの前の確認で、一度ドラフトに戻してある（同じ提出では、もう戻さない状態）
        await service.checkPullRequests();
        await runReview(service, childId);
        // GitHub は外したが、答えを返さない
        const original = pulls.setDraft.bind(pulls);
        const setDraft = vi.spyOn(pulls, "setDraft");
        setDraft.mockImplementation(async (input) => {
          if (input.draft) return original(input);
          pulls.drafts[input.number] = false;
          return new Promise(() => {});
        });
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        // 外す要求が後から届いて外れた後に、人がコミットを足しても（指摘なしでない先頭）、次の確認で戻す
        pulls.drafts[7] = false;
        pulls.prInfo = { ...pulls.prInfo, headSha: "h".repeat(40) };
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        setDraft.mockRestore();
        activity.close();
      });

      it("外した後にドラフトに戻す答えが返らなくても待ち続けず、次の確認で戻す（PR #348 4回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")], [], {
          draftTimeoutMs: 20,
        });
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        // 外す間に人がコミットを足し、ドラフトに戻す要求は答えを返さない（GitHub でも戻っていない）
        const setDraft = vi.spyOn(pulls, "setDraft");
        setDraft.mockImplementation(async (input) => {
          if (input.draft) return new Promise(() => {});
          pulls.drafts[input.number] = false;
          pulls.prInfo = { ...pulls.prInfo, headSha: "h".repeat(40) };
          return { draft: false };
        });
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        setDraft.mockRestore();
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        activity.close();
      });

      it("ドラフトに戻す要求が終わっていなければ、指摘なしでも外さず、終わってから外す（PR #348 5回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")], [], {
          draftTimeoutMs: 20,
        });
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        // ドラフトに戻す要求が、答えを待つのをやめた後も終わらない（後から GitHub に届く）
        const late = Promise.withResolvers<void>();
        const original = pulls.setDraft.bind(pulls);
        const setDraft = vi.spyOn(pulls, "setDraft");
        setDraft.mockImplementation(async (input) => {
          if (!input.draft) return original(input);
          await late.promise;
          return original(input);
        });
        await service.checkPullRequests();
        await runReview(service, childId);
        // 指摘なしでも、戻す要求が終わるまでは外さない
        await service.checkPullRequests();
        expect(setDraft.mock.calls.some(([input]) => !input.draft)).toBe(false);
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        // 戻す要求が届いて終わったら、外して記録する（外した後に戻らない）
        late.resolve();
        await late.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(pulls.drafts[7]).toBe(true);
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        setDraft.mockRestore();
        activity.close();
      });

      it("外す要求の答えを受け取れなかったことは、PR を更新した次の提出にも引き継ぎ、後から外れても戻す（PR #348 5回目のレビュー指摘）", async () => {
        const made = await implemented(
          [
            verdictOut("no_findings", "# 評価\n\n問題なし"),
            rework("implement", "実装で直せる"),
            implement("# 実装の説明 v2"),
          ],
          [],
          { draftTimeoutMs: 20 },
        );
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        // 外す要求は答えを返さず、GitHub にも届いていない（後から届く）
        const late = Promise.withResolvers<void>();
        const original = pulls.setDraft.bind(pulls);
        const setDraft = vi.spyOn(pulls, "setDraft");
        setDraft.mockImplementation(async (input) => {
          if (input.draft) return original(input);
          await late.promise;
          return original(input);
        });
        await service.checkPullRequests();
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        // 人の指摘で直して、PR を更新する
        pulls.feedbackBy[7] = [
          item("comment:1", { kind: "comment", author: "alice", body: "直して" }),
        ];
        await service.checkPullRequests();
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBe(true);
        pulls.prInfo = { ...pulls.prInfo, headSha: commitOf(service, id) };
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        // 前の提出の外す要求が後から届いて外れても、次の確認で戻す
        late.resolve();
        await late.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(pulls.drafts[7]).toBe(false);
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        expect(types(service, id).filter((t) => t === "PullRequestMarkedReady")).toHaveLength(0);
        setDraft.mockRestore();
        activity.close();
      });

      it("PR の更新でドラフトに戻す答えが返らなくても待ち続けず、承認待ちにして、次の確認で戻す（PR #348 5回目のレビュー指摘）", async () => {
        const made = await implemented(
          [verdictOut("changes_required"), implement("# 実装の説明 v2")],
          [],
          { draftTimeoutMs: 20 },
        );
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        // 人がドラフトを外していた PR を、直した PR の更新でドラフトに戻す答えが返らない（GitHub でも戻っていない）
        pulls.drafts[7] = false;
        const original = pulls.setDraft.bind(pulls);
        const setDraft = vi.spyOn(pulls, "setDraft");
        setDraft.mockImplementationOnce(() => new Promise(() => {}));
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBe(true);
        expect(pulls.drafts[7]).toBe(false);
        setDraft.mockImplementation(original);
        pulls.prInfo = { ...pulls.prInfo, headSha: commitOf(service, id) };
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        setDraft.mockRestore();
        activity.close();
      });

      it("答えの返らないドラフトの切り替えは通信を中断し、中断しても終わらなくても上限を過ぎたら、ドラフトを外せる（PR #348 6回目のレビュー指摘）", async () => {
        for (const ignoresAbort of [false, true]) {
          rmSync(dbPath, { force: true });
          const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")], [], {
            draftTimeoutMs: 20,
          });
          const { activity, service, pulls, id } = made;
          const childId = childOf(service, id);
          pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
          // ドラフトに戻す要求が答えを返さない（中断に応じる・応じない）
          const original = pulls.setDraft.bind(pulls);
          const setDraft = vi.spyOn(pulls, "setDraft");
          const signals: (AbortSignal | undefined)[] = [];
          setDraft.mockImplementationOnce(
            (input) =>
              new Promise((_, reject) => {
                signals.push(input.signal);
                if (!ignoresAbort) {
                  input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
                }
              }),
          );
          setDraft.mockImplementation(original);
          await service.checkPullRequests();
          expect(signals[0]?.aborted).toBe(true);
          await runReview(service, childId);
          if (ignoresAbort) {
            // 中断に応じない要求は、上限（DRAFT_TIMEOUT_MS の DRAFT_SETTLE_FACTOR 倍）までは終わっていないものとして外さない
            await service.checkPullRequests();
            expect(types(service, id), String(ignoresAbort)).not.toContain(
              "PullRequestMarkedReady",
            );
            await new Promise((resolve) => setTimeout(resolve, 20 * DRAFT_SETTLE_FACTOR + 50));
          }
          // 中断で終わった・上限を過ぎた要求は数えず、指摘なしでドラフトを外す
          await service.checkPullRequests();
          expect(pulls.drafts[7], String(ignoresAbort)).toBe(false);
          expect(types(service, id), String(ignoresAbort)).toContain("PullRequestMarkedReady");
          setDraft.mockRestore();
          activity.close();
        }
      });

      it("ドラフトを外す間に子タスクの再レビューが始まったら、古い指摘なしで記録せず、ドラフトに戻す（PR #348 7回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        const gate = Promise.withResolvers<void>();
        pulls.setDraftGate = gate.promise;
        const checking = service.checkPullRequests();
        await pulls.setDraftStarted.promise;
        // 外す要求の答えを待つ間に、人が子タスクの再レビューを始めた
        service.rereview(childId);
        pulls.setDraftGate = undefined;
        gate.resolve();
        await checking;
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        expect(pulls.drafts[7]).toBe(true);
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBe(true);
        activity.close();
      });

      it("数えるのをやめた後にドラフトに戻す要求が届いたら、指摘なしで外した PR のドラフトを外し直す（PR #348 7回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")], [], {
          draftTimeoutMs: 20,
        });
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        // ドラフトに戻す要求が、中断に応じず、上限を過ぎてから GitHub に届く
        const original = pulls.setDraft.bind(pulls);
        const setDraft = vi.spyOn(pulls, "setDraft");
        const late = Promise.withResolvers<void>();
        setDraft.mockImplementationOnce(async (input) => {
          await late.promise;
          pulls.drafts[input.number] = input.draft;
          return { draft: input.draft };
        });
        setDraft.mockImplementation(original);
        await service.checkPullRequests();
        await runReview(service, childId);
        await new Promise((resolve) => setTimeout(resolve, 20 * DRAFT_SETTLE_FACTOR + 50));
        await service.checkPullRequests();
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        expect(pulls.drafts[7]).toBe(false);
        // 遅れて届いた戻す要求で、GitHub ではドラフトに戻った
        late.resolve();
        await vi.waitFor(() => expect(pulls.drafts[7]).toBe(true));
        // 次の PR の確認で、GitHub の状態を読んで外し直す
        await service.checkPullRequests();
        expect(setDraft.mock.calls.at(-1)?.[0]).toMatchObject({ number: 7, draft: false });
        expect(pulls.drafts[7]).toBe(false);
        setDraft.mockRestore();
        activity.close();
      });

      /** 起動の後に最初にドラフトに戻す要求を、中断に応じず、late が解決してから GitHub に届くようにする。 */
      const lateFirstRedraft = (pulls: FakePulls) => {
        const original = pulls.setDraft.bind(pulls);
        const setDraft = vi.spyOn(pulls, "setDraft");
        const late = Promise.withResolvers<void>();
        const landed = Promise.withResolvers<void>();
        setDraft.mockImplementationOnce(async (input) => {
          await late.promise;
          pulls.drafts[input.number] = input.draft;
          landed.resolve();
          return { draft: input.draft };
        });
        setDraft.mockImplementation(original);
        return { setDraft, late, landed };
      };

      it("数えるのをやめた戻す要求が、ドラフトを外して記録する前に届いても、記録の後に外し直す（PR #348 8回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")], [], {
          draftTimeoutMs: 20,
        });
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        const { setDraft, late, landed } = lateFirstRedraft(pulls);
        await service.checkPullRequests();
        await runReview(service, childId);
        await new Promise((resolve) => setTimeout(resolve, 20 * DRAFT_SETTLE_FACTOR + 50));
        // 外す要求の答えを待つ間に、遅れた戻す要求が GitHub に届く
        const gate = Promise.withResolvers<void>();
        pulls.setDraftGate = gate.promise;
        const checking = service.checkPullRequests();
        await pulls.setDraftStarted.promise;
        late.resolve();
        await landed.promise;
        expect(pulls.drafts[7]).toBe(true);
        pulls.setDraftGate = undefined;
        gate.resolve();
        await checking;
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        setDraft.mockRestore();
        activity.close();
      });

      it("遅れた戻す要求の後に外し直せなければ、次の確認でやり直す（PR #348 8回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")], [], {
          draftTimeoutMs: 20,
        });
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        const { setDraft, late, landed } = lateFirstRedraft(pulls);
        await service.checkPullRequests();
        await runReview(service, childId);
        await new Promise((resolve) => setTimeout(resolve, 20 * DRAFT_SETTLE_FACTOR + 50));
        await service.checkPullRequests();
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        // 外し直しが失敗する
        pulls.setDraftFail = "GitHub が落ちている";
        late.resolve();
        await landed.promise;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        pulls.setDraftFail = undefined;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        // 外し直せたら、繰り返さない
        const calls = setDraft.mock.calls.length;
        await service.checkPullRequests();
        expect(setDraft.mock.calls.slice(calls).filter(([input]) => !input.draft)).toEqual([]);
        setDraft.mockRestore();
        activity.close();
      });

      it("中断した戻す要求が GitHub にだけ届いても、再起動などで覚えていなくても、指摘なしで外した PR のドラフトを外し直す（PR #348 9回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")], [], {
          draftTimeoutMs: 20,
        });
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        // 起動の後のドラフトに戻す要求は、中断で失敗するが、GitHub には後から届く
        const original = pulls.setDraft.bind(pulls);
        const setDraft = vi.spyOn(pulls, "setDraft");
        const late = Promise.withResolvers<void>();
        const landed = Promise.withResolvers<void>();
        setDraft.mockImplementationOnce(
          (input) =>
            new Promise((_, reject) => {
              input.signal?.addEventListener("abort", () => reject(new Error("aborted")));
              void late.promise.then(() => {
                pulls.drafts[input.number] = true;
                landed.resolve();
              });
            }),
        );
        setDraft.mockImplementation(original);
        await service.checkPullRequests();
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        expect(pulls.drafts[7]).toBe(false);
        late.resolve();
        await landed.promise;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        // 何も覚えていない（再起動の後と同じ）ときも、GitHub でドラフトなら外し直す
        pulls.drafts[7] = true;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        // ドラフトでなければ、何もしない
        const calls = setDraft.mock.calls.length;
        await service.checkPullRequests();
        expect(setDraft.mock.calls.length).toBe(calls);
        setDraft.mockRestore();
        activity.close();
      });

      it("ドラフトを外し直す間に差し戻されたら、ドラフトに戻す（PR #348 9回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        // 遅れた戻す要求で、GitHub ではドラフトに戻った
        pulls.drafts[7] = true;
        const gate = Promise.withResolvers<void>();
        pulls.setDraftGate = gate.promise;
        pulls.setDraftStarted = Promise.withResolvers<void>();
        const checking = service.checkPullRequests();
        await pulls.setDraftStarted.promise;
        // 外し直す要求の答えを待つ間に、人が差し戻した
        service.requestChanges(id, {
          step: "implement",
          submission: 1,
          comments: ["ここを直して"],
        });
        pulls.setDraftGate = undefined;
        gate.resolve();
        await checking;
        expect(pulls.drafts[7]).toBe(true);
        activity.close();
      });

      it("指摘なしで外した後に人がコミットを足してドラフトにしたら、外し直さずにその先頭を再レビューし、指摘なしで外して記録し直す（PR #348 10回目のレビュー指摘）", async () => {
        const made = await implemented([
          verdictOut("no_findings", "# 評価\n\n問題なし"),
          verdictOut("no_findings", "# 評価\n\n足したコミットも問題なし"),
        ]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        // 人がコミットを足して、ドラフトにした
        const human = "h".repeat(40);
        pulls.prInfo = { ...pulls.prInfo, headSha: human };
        pulls.drafts[7] = true;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        const restarts = service.get(childId)?.activity.filter((e) => e.type === "ReviewRestarted");
        expect(restarts?.map((e) => e.payload)).toEqual([{ reason: "updated", commit: human }]);
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        const marks = service.get(id)?.activity.filter((e) => e.type === "PullRequestMarkedReady");
        expect(marks?.map((e) => e.type === "PullRequestMarkedReady" && e.payload.commit)).toEqual([
          commitOf(service, id),
          human,
        ]);
        expect(taskOf(service, id).pullRequest?.reviewedCommit).toBe(human);
        activity.close();
      });

      it("ドラフトを外し直す間に子タスクの再レビューが始まったら、ドラフトに戻す（PR #348 10回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        await service.checkPullRequests();
        pulls.drafts[7] = true;
        const gate = Promise.withResolvers<void>();
        pulls.setDraftGate = gate.promise;
        pulls.setDraftStarted = Promise.withResolvers<void>();
        const checking = service.checkPullRequests();
        await pulls.setDraftStarted.promise;
        service.rereview(childId);
        pulls.setDraftGate = undefined;
        gate.resolve();
        await checking;
        expect(pulls.drafts[7]).toBe(true);
        activity.close();
      });

      it("指摘なしを待つ PR のドラフトが GitHub で外れていたら、覚えていなくても確認のたびにドラフトに戻す（PR #348 10回目のレビュー指摘）", async () => {
        const made = await implemented([]);
        const { activity, service, pulls, id } = made;
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        // 再起動の後に一度戻した後で、古い外す要求が GitHub に届いた
        for (let i = 0; i < 2; i++) {
          pulls.drafts[7] = false;
          await service.checkPullRequests();
          expect(pulls.drafts[7], String(i)).toBe(true);
        }
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        activity.close();
      });

      it("実装の PR のコミットの日時と題は、実装の工程が終わったときにする（PR #348 10回目のレビュー指摘）", async () => {
        const repos = new FakeRepos();
        const made = await start([implement()], {
          repos,
          steps: ["implement"],
          reviewTasks: true,
        });
        const { activity, service, id } = made;
        // 実装の工程は start の中で終わっている
        service.renameTask(id, { title: "作成の後に変えた題" });
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        const done = service
          .get(id)
          ?.activity.findLast(
            (e) => e.type === "AgentRunCompleted" && e.payload.step === "implement",
          );
        expect(repos.published.at(-1)?.date).toBe(done?.at);
        // 実装の工程が終わった後に変えた題は、このコミットには使わない（題は、コミットの日時のときの題。PBI-323）
        expect(repos.published.at(-1)?.message).not.toContain("作成の後に変えた題");
        expect(repos.published.at(-1)?.date).not.toBe(taskOf(service, id).createdAt);
        activity.close();
      });

      it("指摘なしで外した後に人がドラフトにせずにコミットを足しても、その先頭を再レビューし、指摘なしになるまでドラフトにする（PR #348 11回目のレビュー指摘）", async () => {
        const made = await implemented([
          verdictOut("no_findings", "# 評価\n\n問題なし"),
          verdictOut("no_findings", "# 評価\n\n足したコミットも問題なし"),
        ]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        const human = "h".repeat(40);
        pulls.prInfo = { ...pulls.prInfo, headSha: human };
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        const restarts = service.get(childId)?.activity.filter((e) => e.type === "ReviewRestarted");
        expect(restarts?.map((e) => e.payload)).toEqual([{ reason: "updated", commit: human }]);
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(taskOf(service, id).pullRequest?.reviewedCommit).toBe(human);
        activity.close();
      });

      it("GitHub の先頭を読めなければ、指摘なしで外した PR のドラフトを外し直さない（PR #348 11回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        await service.checkPullRequests();
        pulls.drafts[7] = true;
        pulls.prInfo = { ...pulls.prInfo, headSha: "" };
        const changes = pulls.draftChanges.length;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        // 一瞬でも外さない（外している間に、レビューしていないコミットをマージできてしまう）
        expect(pulls.draftChanges.slice(changes)).toEqual([]);
        activity.close();
      });

      it("外し直す間に再レビューが始まって一時停止したら、ドラフトに戻す。戻せなければ、一時停止の間も確認のたびに戻す（PR #348 11回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        await service.checkPullRequests();
        pulls.drafts[7] = true;
        const gate = Promise.withResolvers<void>();
        pulls.setDraftGate = gate.promise;
        pulls.setDraftStarted = Promise.withResolvers<void>();
        const checking = service.checkPullRequests();
        await pulls.setDraftStarted.promise;
        // 外し直す間に、子タスクの再レビューが始まり、親を一時停止した
        service.rereview(childId);
        service.pause(id);
        // 戻す要求は失敗する
        pulls.setDraftGate = undefined;
        gate.resolve();
        pulls.setDraftFail = "GitHub が落ちている";
        await checking;
        expect(taskOf(service, id).status).toBe("paused");
        expect(pulls.drafts[7]).toBe(false);
        pulls.setDraftFail = undefined;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        activity.close();
      });

      it("外し直す間に親だけを一時停止し、戻せなかったら、一時停止の間も確認のたびに戻し、再開したら外し直す（PR #348 12回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        await service.checkPullRequests();
        pulls.drafts[7] = true;
        const gate = Promise.withResolvers<void>();
        pulls.setDraftGate = gate.promise;
        pulls.setDraftStarted = Promise.withResolvers<void>();
        const checking = service.checkPullRequests();
        await pulls.setDraftStarted.promise;
        // 外し直す間に、親だけを一時停止した（子タスクは同じ先頭を指摘なしにしたまま）
        service.pause(id);
        pulls.setDraftGate = undefined;
        gate.resolve();
        pulls.setDraftFail = "GitHub が落ちている";
        await checking;
        expect(taskOf(service, id).status).toBe("paused");
        expect(pulls.drafts[7]).toBe(false);
        // 戻せないうちは、一時停止の間も確認のたびに戻そうとする
        const tries = pulls.draftChanges.length;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        pulls.setDraftFail = undefined;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        expect(pulls.draftChanges.length).toBeGreaterThan(tries);
        // 再開したら、指摘なしにした先頭のまま外し直す
        service.resume(id, {});
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        activity.close();
      });

      it("開いている PR の答えにドラフトかが無ければ、確認中も一時停止中もデーモンのログに残す（PR #348 14回目のレビュー指摘）", async () => {
        const made = await implemented([]);
        const { activity, service, pulls, id } = made;
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        delete pulls.drafts[7];
        const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
        try {
          await service.checkPullRequests();
          const unknown = () =>
            warn.mock.calls.filter((c) =>
              String(c[0]).includes("ドラフトかを GitHub の答えから読めなかった"),
            );
          expect(unknown()).toHaveLength(1);
          service.pause(id);
          delete pulls.drafts[7];
          await service.checkPullRequests();
          expect(unknown()).toHaveLength(2);
        } finally {
          warn.mockRestore();
        }
        activity.close();
      });

      it("一時停止したタスクの PR は並べて確かめ、答えが返らない PR が続いても、1つずつ待たない（PR #348 13回目のレビュー指摘）", async () => {
        const ok = verdictOut("no_findings", "# 評価\n\n問題なし");
        const made = await implemented([ok, implement(), ok], [], { draftTimeoutMs: 300 });
        const { activity, service, pulls, id } = made;
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childOf(service, id));
        await service.checkPullRequests();
        const second = service.createTask({
          projectId: "default",
          title: "2つめ",
          body: "本文",
        }).id;
        for (let i = 0; i < 5 && taskOf(service, second).status !== "awaiting_approval"; i++) {
          await service.runNext(second);
        }
        expect(taskOf(service, second).pullRequest?.number).toBeDefined();
        service.pause(id);
        service.pause(second);
        const hung = hangStatus(pulls, "settlePausedDraft");
        await service.checkPullRequests();
        hung.restore();
        // 2つとも、先の答えを待つのをやめる前に読み始めた（並べて読んだ）。待つのをやめた通信は中断した
        expect(hung.signals).toHaveLength(2);
        expect(hung.maxActive()).toBe(2);
        expect(hung.signals.every((signal) => signal?.aborted)).toBe(true);
        activity.close();
      });

      it("指摘なしを待つ実装の PR の先頭は並べて読み、答えが返らなければ中断する（PR #348 15回目のレビュー指摘）", async () => {
        const made = await implemented([implement()], [], { draftTimeoutMs: 100 });
        const { activity, service, pulls, id } = made;
        const second = service.createTask({
          projectId: "default",
          title: "2つめ",
          body: "本文",
        }).id;
        for (let i = 0; i < 5 && taskOf(service, second).status !== "awaiting_approval"; i++) {
          await service.runNext(second);
        }
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBe(true);
        expect(taskOf(service, second).pullRequest?.awaitingReview).toBe(true);
        const hung = hangStatus(pulls, "pullRequestHead");
        await service.checkPullRequests();
        hung.restore();
        expect(hung.signals.length).toBeGreaterThanOrEqual(2);
        expect(hung.maxActive()).toBeGreaterThanOrEqual(2);
        expect(hung.signals.every((signal) => signal?.aborted)).toBe(true);
        activity.close();
      });

      it("一時停止したタスクの PR の状態の答えが返らなくても、PR の確認を止めない（PR #348 12回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")], [], {
          draftTimeoutMs: 50,
        });
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        await service.checkPullRequests();
        service.pause(id);
        const original = pulls.status.bind(pulls);
        const status = vi.spyOn(pulls, "status");
        // 一時停止したタスクの PR を確かめる答えだけが返らない
        status.mockImplementation((input) =>
          new Error().stack?.includes("settlePausedDrafts")
            ? new Promise(() => {})
            : original(input),
        );
        await service.checkPullRequests();
        status.mockRestore();
        // 次の確認でやり直し、ドラフトに戻す
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        activity.close();
      });

      it("外し直す答えを受け取れなければ、ドラフトに戻し、次の確認で外し直す（PR #348 11回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        await service.checkPullRequests();
        pulls.drafts[7] = true;
        // 外す要求は GitHub で済むが、答えを受け取れない（戻す要求も同じ）
        pulls.setDraftAnswerLost = "接続が切れた";
        const changes = pulls.draftChanges.length;
        await service.checkPullRequests();
        expect(pulls.draftChanges.slice(changes)).toEqual([
          { number: 7, draft: false },
          { number: 7, draft: true },
        ]);
        pulls.setDraftAnswerLost = undefined;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        activity.close();
      });

      it("ドラフトを外す答えがドラフトのままなら、記録せずに次の確認でやり直す（PR #348 8回目のレビュー指摘）", async () => {
        const made = await implemented([verdictOut("no_findings", "# 評価\n\n問題なし")]);
        const { activity, service, pulls, id } = made;
        const childId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, childId);
        const original = pulls.setDraft.bind(pulls);
        const setDraft = vi.spyOn(pulls, "setDraft");
        setDraft.mockImplementation(async (input) =>
          input.draft ? original(input) : { draft: true },
        );
        await service.checkPullRequests();
        expect(types(service, id)).not.toContain("PullRequestMarkedReady");
        setDraft.mockRestore();
        await service.checkPullRequests();
        expect(types(service, id)).toContain("PullRequestMarkedReady");
        expect(pulls.drafts[7]).toBe(false);
        activity.close();
      });

      it("テストのコマンドが決まらないまま最初の工程の前に止まっても、再開で工程を選び直さず、イメージを変えて再開できる（PR #348 6回目のレビュー指摘）", async () => {
        const pulls = new FakePulls();
        const made = await start([implement()], {
          pulls,
          steps: ["implement"],
          reviewTasks: true,
          ci: failingCi(),
          // 工程を選ぶ費用で予算を超え、最初の工程の前に止まる
          planner: async () => ({
            steps: ["implement"],
            fallback: false,
            costUsd: 1000,
            estimated: false,
          }),
        });
        const { activity, service, id } = made;
        await service.runNext(id);
        const paused = taskOf(service, id);
        expect(paused).toMatchObject({ status: "paused", pausedReason: "budget" });
        expect(paused.testCommand).toBeUndefined();
        expect(paused.steps.map((s) => s.key)).toEqual(["implement"]);
        service.resume(id, { capUsd: 2000, image: "default" });
        const resumed = service.get(id)?.activity.findLast((e) => e.type === "TaskResumed");
        expect(resumed?.type === "TaskResumed" && resumed.payload.rechooseSteps).toBeUndefined();
        expect(taskOf(service, id).steps.map((s) => s.key)).toEqual(["implement"]);
        activity.close();
      });

      it("テストのコマンドが決まらなくても止めずに、実装して PR のレビューに進む（受け入れ条件 4）", async () => {
        const pulls = new FakePulls();
        const made = await start([implement()], {
          pulls,
          steps: ["implement"],
          reviewTasks: true,
          ci: failingCi(),
          planner: async () => ({
            steps: ["implement"],
            fallback: false,
            costUsd: 0,
            estimated: false,
          }),
        });
        const { activity, service, id } = made;
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        const task = taskOf(service, id);
        expect(task.testCommand).toBeUndefined();
        expect(task.status).toBe("awaiting_approval");
        expect(task.pullRequest).toMatchObject({ number: 7, awaitingReview: true });
        expect(types(service, id)).not.toContain("TaskPaused");
        activity.close();
      });

      it("テストの仕組みが無いタスクの実装には、用意したテストを自分で実行させる（PR #348 8回目のレビュー指摘）", async () => {
        const made = await start([implement()], {
          steps: ["implement"],
          reviewTasks: true,
          planner: async () => ({
            steps: ["implement"],
            fallback: false,
            noTestsReason: "テストの仕組みが無い",
            costUsd: 0,
            estimated: false,
          }),
        });
        const { activity, service, executor, id } = made;
        await service.runNext(id);
        await service.runNext(id);
        expect(taskOf(service, id).noTestsReason).toBe("テストの仕組みが無い");
        const prompt = executor.calls[0]?.command.join(" ") ?? "";
        expect(prompt).toContain("提出の前にそのテストを自分で実行し");
        expect(prompt).not.toContain("ゴールガーディアンが最終レビューの中で");
        activity.close();
      });

      it("最終レビュー・CI の待ちの途中だった古いタスクは、新しい流れで PR のレビューに進む（受け入れ条件 4）", async () => {
        // 以前の版：最終レビューの前のドラフトの PR を作り、CI を待っていた（台帳にその記録がある）
        const pulls = new FakePulls();
        const made = await start([implement()], {
          pulls,
          steps: ["implement"],
          ci: failingCi(),
        });
        const { id } = made;
        // 実装の工程が終わったところ（start が実装まで進める）
        expect(taskOf(made.service, id).verification).toBeDefined();
        pulls.states[7] = { state: "open" };
        appendLegacy(made.service, id, [
          {
            actor: "sacty",
            event: {
              type: "PullRequestPublished",
              payload: {
                branch: `sacty/task-${id.slice(0, 8)}`,
                commit: "c1".padEnd(40, "0"),
                url: "https://github.com/acme/app/pull/7",
                number: 7,
                repo: "https://github.com/acme/app",
                verifying: true,
                draft: true,
              },
            },
          },
        ]);
        expect(taskOf(made.service, id).pullRequestCi).toBeDefined();
        expect(taskOf(made.service, id).verification).toBeDefined();
        made.activity.close();
        const activity = new SqliteActivityStore(dbPath);
        const { service, executor } = makeService(activity, [], {
          stepPullRequests: true,
          pulls,
          reviewTasks: true,
          now: later,
          ci: failingCi(),
          draftPullRequests: true,
        });
        expect(service.queuedTaskIds()).toContain(id);
        for (let i = 0; i < 4 && taskOf(service, id).status !== "awaiting_approval"; i++) {
          await service.runNext(id);
        }
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(task.pullRequestCi).toBeUndefined();
        expect(task.pullRequest).toMatchObject({ number: 7, draft: true, awaitingReview: true });
        expect(types(service, id)).toContain("FinalReviewSkipped");
        expect(executor.calls).toHaveLength(0);
        expect(task.reviewTasks?.map((r) => r.number)).toEqual([7]);
        activity.close();
      });
    });

    it("要求要件の PR を作ったら、その PR をレビューする子タスクを作って親に記録する。ラベルは付けず、PR を更新しても作り直さない（受け入れ条件 1・5）", async () => {
      // レビュー用のラベルの設定・そのトリアージに関わらず作る
      for (const settings of [
        undefined,
        new MemorySettingsStore({}),
        new MemorySettingsStore({ reviewLabel: "sacty-review", triageOff: ["reviewLabel"] }),
      ]) {
        rmSync(dbPath, { force: true });
        const pulls = new FakePulls();
        const made = await start(
          [out("# 要求要件 v1"), rework("requirements", "要求要件で直せる"), out("# 要求要件 v2")],
          { pulls, reviewTasks: true, ...(settings ? { settings } : {}) },
        );
        const { activity, service, id } = made;
        expect(pulls.labels).toEqual([]);
        const childId = childOf(service, id);
        expect(taskOf(service, id).reviewTasks).toEqual([
          { taskId: childId, step: "requirements", repo: "https://github.com/acme/app", number: 7 },
        ]);
        expect(service.get(id)?.activity.at(-1)).toMatchObject({
          type: "ReviewTaskCreated",
          actor: "sacty",
        });
        const child = taskOf(service, childId);
        expect(child.reviewOf).toEqual({ taskId: id, step: "requirements" });
        expect(child.source).toEqual({
          kind: "github_pull_request",
          repo: "https://github.com/acme/app",
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          review: "sacty",
        });
        expect(child.title).toBe("[PR #7] 決済API");
        expect(child.projectId).toBe("default");
        // 分割の子タスクではない（分割の待ち・統合レビューに混ざらない）
        expect(child.parent).toBeUndefined();
        expect(service.queuedTaskIds()).toContain(childId);
        // 人の指摘で同じ PR を更新しても、もう作らない
        pulls.feedbackBy[7] = [item("comment:1")];
        await service.checkPullRequests();
        await service.runNext(id);
        expect(pulls.calls.map((c) => c.number)).toEqual([undefined, 7]);
        expect(taskOf(service, id).reviewTasks).toHaveLength(1);
        expect(service.list().filter((t) => t.reviewOf)).toHaveLength(1);
        // 再起動しても、作った記録を復元する
        const done = taskOf(service, id);
        activity.close();
        const again = new SqliteActivityStore(dbPath);
        const restarted = makeService(again, [], { stepPullRequests: true }).service;
        expect(restarted.get(id)?.task.reviewTasks).toEqual(done.reviewTasks);
        expect(restarted.get(childId)?.task.reviewOf).toEqual({ taskId: id, step: "requirements" });
        again.close();
      }
    });

    describe("PR のレビューの子タスクがレビューする工程は、提出の前のセルフレビューを省く（PBI-346）", () => {
      const SKIPPED = "--- 提出の前のセルフレビュー（行わない） ---";
      const DISPATCH = "既定のスキル review-dispatch（流れは self-review";
      const completed = (svc: TaskService, id: string, step: StepKey) =>
        svc
          .get(id)
          ?.activity.findLast((e) => e.type === "AgentRunCompleted" && e.payload.step === step)
          ?.payload as Record<string, unknown> | undefined;

      it("要求要件の PR を子タスクがレビューするタスクは、セルフレビューを指示せず、成果物の検証は指示し、セルフレビューの記録を残さない（受け入れ条件 1・2・4）", async () => {
        const made = await start([out("# 要求要件 v1")], { reviewTasks: true });
        const { activity, service, executor, id } = made;
        const prompt = promptOf(executor, 0);
        expect(prompt).toContain(SKIPPED);
        expect(prompt).not.toContain(DISPATCH);
        expect(prompt).not.toContain('{"sacty-self-review": {"rounds"');
        expect(prompt).toContain("--- 提出の前の検証（成果物のファイル） ---");
        // させていないので、記録なし（null）にもしない（画面に警告を出さない）
        expect(completed(service, id, "requirements")).toBeDefined();
        expect(completed(service, id, "requirements")).not.toHaveProperty("selfReview");
        expect(taskOf(service, id).selfReviews?.requirements).toBeUndefined();
        expect(childOf(service, id)).not.toBe("");
        activity.close();
      });

      it("実装の PR を子タスクがレビューするタスクは、セルフレビューを指示せず、検証と検証の記録・テストの全件は指示する（受け入れ条件 1・2・4）", async () => {
        const made = await start([implement()], { steps: ["implement"], reviewTasks: true });
        const { activity, service, executor, id } = made;
        const prompt = promptOf(executor, 0);
        expect(prompt).toContain(SKIPPED);
        expect(prompt).not.toContain(DISPATCH);
        expect(prompt).toContain("--- 提出の前の検証 ---");
        expect(prompt).toContain("--- 実行した検証の記録 ---");
        expect(prompt).toContain("テストの全件を1回実行し、通してから提出する");
        expect(prompt).toContain("--- 提出の前に確かめる、レビューの基準 ---");
        expect(completed(service, id, "implement")).not.toHaveProperty("selfReview");
        expect(taskOf(service, id).selfReviews?.implement).toBeUndefined();
        activity.close();
      });

      it("子タスクを作らないデーモンでは、今までどおりセルフレビューをさせ、報告が無ければ記録なしにする（受け入れ条件 3）", async () => {
        for (const steps of [undefined, ["implement"] as StepKey[]]) {
          rmSync(dbPath, { force: true });
          const made = await start([steps ? implement() : out("# 要求要件 v1")], {
            ...(steps ? { steps } : {}),
          });
          const { activity, service, executor, id } = made;
          const step = steps ? "implement" : "requirements";
          expect(promptOf(executor, 0), step).toContain(DISPATCH);
          expect(promptOf(executor, 0), step).not.toContain(SKIPPED);
          expect(completed(service, id, step), step).toMatchObject({ selfReview: null });
          activity.close();
        }
      });

      it("要求要件を画面で承認するタスク（PR を作らない）は、子タスクを作るデーモンでも、セルフレビューをさせる（受け入れ条件 3）", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const { service, executor } = makeService(activity, [out("# 要求要件 v1")], {
          reviewTasks: true,
        });
        const { id } = service.createTask({
          projectId: "default",
          title: "決済API",
          body: "タスクの本文",
        });
        await service.runNext(id);
        expect(taskOf(service, id).gate).toEqual({ step: "requirements", submission: 1 });
        expect(taskOf(service, id).stepPullRequests).toEqual([]);
        expect(promptOf(executor, 0)).toContain(DISPATCH);
        expect(promptOf(executor, 0)).not.toContain(SKIPPED);
        expect(completed(service, id, "requirements")).toMatchObject({ selfReview: null });
        activity.close();
      });

      it("指摘を受けた直しの実行でも、セルフレビューを省く（受け入れ条件 5）", async () => {
        const pulls = new FakePulls();
        const made = await start(
          [out("# 要求要件 v1"), rework("requirements", "要求要件で直せる"), out("# 要求要件 v2")],
          { pulls, reviewTasks: true },
        );
        const { activity, service, executor, id } = made;
        pulls.feedbackBy[7] = [item("comment:1")];
        await service.checkPullRequests();
        await service.runNext(id);
        const prompt = promptOf(executor, executor.calls.length - 1);
        expect(prompt).toContain("受け入れ条件が曖昧");
        expect(prompt).toContain(SKIPPED);
        expect(prompt).not.toContain(DISPATCH);
        expect(taskOf(service, id).selfReviews?.requirements).toBeUndefined();
        activity.close();
      });
    });

    describe("終わっていない実装を提出にせず、変更の無いやり直しで行き止まりにしない（PBI-347）", () => {
      const declare = (value: unknown) =>
        `\`\`\`${COMPLETION_FENCE}\n${JSON.stringify(value)}\n\`\`\``;
      const MAP = block({
        "sacty-test-map": [{ viewpointId: "TV-1", tests: ["pay.test.ts › 同じキーの再送"] }],
      });
      /** 未完了が続いて止まるまでの実行の数（最初の実行と、続きの実行の上限。PBI-350）。 */
      const RUNS_UNTIL_PAUSE = MAX_INCOMPLETE_CONTINUATIONS + 1;
      /** 範囲の一部だけを実装して、未完了と申告する実行。 */
      const unfinished = (remaining: string[], text = "**実装は未完了です。**") =>
        out([text, MAP, declare({ status: "incomplete", remaining })].join("\n\n"));
      const completedRun = (svc: TaskService, id: string, n = -1) =>
        svc
          .get(id)
          ?.activity.filter((e) => e.type === "AgentRunCompleted" && e.payload.step === "implement")
          .at(n)?.payload as Record<string, unknown> | undefined;
      const count = (svc: TaskService, id: string, type: string) =>
        types(svc, id).filter((t) => t === type).length;
      /** PR のレビューの子タスクに渡す、PR の CI の読み取り（渡すと、実装の PR をドラフトで作って、指摘なしを待つ）。 */
      const CI = {
        snapshot: async () => ({ checks: [], jobs: [], failedRuns: [] }),
      } as unknown as ServiceDeps["ci"];
      /**
       * 実装だけのタスクを作り、PR のレビューの子タスクを作るデーモンで、最初の実行の前まで進める。mergeBase なら、実装を
       * 始める前に、ベースブランチの最新を作業領域に取り込む。
       */
      async function begin(
        outcomes: AgentOutcome[],
        options: { repos?: FakeRepos; mergeBase?: boolean } = {},
      ) {
        const pulls = new FakePulls();
        const repos = options.repos ?? new FakeRepos();
        const made = await start(outcomes, {
          pulls,
          repos,
          steps: ["implement"],
          reviewTasks: true,
          ci: CI,
          ...(options.mergeBase ? { mergeBase: true } : {}),
        });
        return { ...made, pulls, repos };
      }
      /** 止まる（承認待ち・一時停止）まで進める。 */
      async function settle(service: TaskService, id: string, max = 12) {
        for (let i = 0; i < max; i++) {
          const status = taskOf(service, id).status;
          if (status === "awaiting_approval" || status === "paused") return;
          await service.runNext(id);
        }
      }
      /** 実行のたびに、作業領域の内容の目印を変える（実装が進んだことにする）。 */
      const progress = (executor: FakeExecutor, repos: FakeRepos) => {
        let n = 0;
        executor.logLines = () => {
          n += 1;
          repos.tree = `${n}`.padStart(40, "0");
          return undefined;
        };
      };

      it("実装の指示は、完了の申告を必ず付けるよう求める（受け入れ条件 1）", async () => {
        const { activity, service, executor, id } = await begin([implement()]);
        await settle(service, id);
        const prompt = promptOf(executor, 0);
        expect(prompt).toContain("--- 完了の申告 ---");
        expect(prompt).toContain(
          "申告は、言語の名前を sacty-completion にしたコードブロックの中にだけ、下の形の JSON で書く",
        );
        expect(prompt).toContain('```sacty-completion\n{"status":"complete"}\n```');
        activity.close();
      });

      it("完了と申告した実行は、今までどおり PR を作って承認待ちにし、申告を本文に残さない（受け入れ条件 5）", async () => {
        const { activity, service, pulls, id } = await begin([
          out(["# 実装の説明", MAP, declare({ status: "complete" })].join("\n\n")),
        ]);
        await settle(service, id);
        expect(taskOf(service, id).status).toBe("awaiting_approval");
        expect(completedRun(service, id)?.completion).toEqual({ status: "complete" });
        expect(types(service, id)).not.toContain("ImplementationIncomplete");
        expect(pulls.calls).toHaveLength(1);
        expect(pulls.calls[0]?.body).not.toContain("sacty-completion");
        expect(taskOf(service, id).outputs.implement).toBe("# 実装の説明");
        activity.close();
      });

      it("未完了と申告した実行は提出せず、PR を作らずに、残っていることを渡して実装をやり直す（受け入れ条件 2・3）", async () => {
        const { activity, service, executor, pulls, repos, id } = await begin([
          unfinished(["作成 API の repos の入力", "docs の更新"]),
          implement("# 実装の説明 v2"),
        ]);
        progress(executor, repos);
        // 1回目の実行の後：提出しない（コミットもプッシュも PR もしない）
        for (let i = 0; i < 4 && executor.calls.length < 2; i++) await service.runNext(id);
        expect(completedRun(service, id, 0)?.completion).toEqual({
          status: "incomplete",
          remaining: ["作成 API の repos の入力", "docs の更新"],
        });
        const incomplete = service
          .get(id)
          ?.activity.find((e) => e.type === "ImplementationIncomplete");
        expect(incomplete).toMatchObject({
          actor: "sacty",
          payload: { remaining: ["作成 API の repos の入力", "docs の更新"] },
        });
        expect(incomplete?.payload).not.toHaveProperty("undeclared");
        // やり直しの指示に、前回が未完了だったことと、残っていることを渡す
        const prompt = promptOf(executor, 1);
        expect(prompt).toContain("--- 前回の実行：実装が終わっていませんでした ---");
        expect(prompt).toContain("PR は、作っていません・更新していません");
        expect(prompt).toContain("- 作成 API の repos の入力");
        expect(prompt).toContain("- docs の更新");
        await settle(service, id);
        // 2回目が完了と申告したので、ここで初めて PR を作る（1回目の提出にする）
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(task.gate).toEqual({ step: "implement", submission: 1 });
        expect(repos.published).toHaveLength(1);
        expect(pulls.calls).toHaveLength(1);
        expect(count(service, id, "PullRequestPublished")).toBe(1);
        expect(count(service, id, "FinalReviewSkipped")).toBe(1);
        expect(task.incompleteRuns).toBeUndefined();
        expect(task.verifyFeedback).toBeUndefined();
        activity.close();
      });

      it("PR の指摘を受けたやり直しが未完了なら、PR を更新せず、残っていることと元の指摘を渡して実装をやり直す（受け入れ条件 2・3）", async () => {
        const { activity, service, executor, pulls, repos, id } = await begin([
          implement(),
          verdictOut("changes_required"),
          // 指摘を受けたやり直しが、途中で終わる
          unfinished(["失敗時の受け入れ条件のテスト"]),
          implement("# 実装の説明 v2"),
        ]);
        progress(executor, repos);
        await settle(service, id);
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        const updates = pulls.calls.length;
        const published = repos.published.length;
        const before = executor.calls.length;
        // やり直しの実行（未完了）の後：PR を更新しない（コミットもプッシュもしない）
        for (let i = 0; i < 6 && count(service, id, "ImplementationIncomplete") < 1; i++) {
          await service.runNext(id);
        }
        expect(executor.calls).toHaveLength(before + 1);
        expect(completedRun(service, id)?.completion).toEqual({
          status: "incomplete",
          remaining: ["失敗時の受け入れ条件のテスト"],
        });
        expect(count(service, id, "ImplementationIncomplete")).toBe(1);
        expect(pulls.calls).toHaveLength(updates);
        expect(repos.published).toHaveLength(published);
        expect(count(service, id, "StepSubmitted")).toBe(1);
        expect(taskOf(service, id).pullRequest?.commit).toBe(first);
        // 完了と申告したら、PR を更新して、2回目の提出にする
        await settle(service, id);
        // やり直しの次の実行の指示に、残っていることと、元の指摘の両方を渡している
        const prompt = promptOf(executor, before + 1);
        expect(prompt).toContain("--- 前回の実行：実装が終わっていませんでした ---");
        expect(prompt).toContain("- 失敗時の受け入れ条件のテスト");
        expect(prompt).toContain("受け入れ条件が足りない");
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(count(service, id, "StepSubmitted")).toBe(2);
        expect(pulls.calls).toHaveLength(updates + 1);
        expect(commitOf(service, id)).not.toBe(first);
        activity.close();
      });

      it("未完了と申告した実行の間に、人が競合するコミットを PR に足しても、競合より先に未完了を記録し、残っていることを渡して実装をやり直す。完了と申告した実行で目印が残っていれば、提出しない（受け入れ条件 2・3）", async () => {
        const { activity, service, executor, pulls, repos, id } = await begin([
          implement(),
          verdictOut("changes_required"),
          // 指摘を受けたやり直しが、途中で終わる
          unfinished(["失敗時の受け入れ条件のテスト"]),
          // 完了と申告するが、競合の目印を残している
          implement("# 実装の説明 v2"),
          implement("# 実装の説明 v3"),
        ]);
        await settle(service, id);
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        const pushed = taskOf(service, id).pushedBranch;
        if (!pushed) throw new Error("no pushed branch");
        const updates = pulls.calls.length;
        const published = repos.published.length;
        const before = executor.calls.length;
        // やり直しの最初の実行（未完了）の間に、人が、実装と競合するコミットを PR のブランチに足す
        const human = "d".repeat(40);
        const conflicted = "src/conflicted.ts";
        let n = 0;
        executor.logLines = () => {
          n += 1;
          repos.tree = `${n}`.padStart(40, "0");
          if (executor.calls.length === before + 1) {
            repos.remote[pushed.branch] = human;
            repos.mergeResult = { status: "conflicted", conflicts: [conflicted] };
            repos.markers = [conflicted];
          }
          return undefined;
        };
        for (let i = 0; i < 6 && executor.calls.length < before + 2; i++) await service.runNext(id);
        expect(executor.calls).toHaveLength(before + 2);
        // 未完了の実行の後：競合の確認より先に、未完了を記録する（競合で戻ると、残っていることが次の指示に渡らない）
        expect(
          service.get(id)?.activity.find((e) => e.type === "ImplementationIncomplete")?.payload,
        ).toMatchObject({ remaining: ["失敗時の受け入れ条件のテスト"] });
        expect(count(service, id, "ImplementationIncomplete")).toBe(1);
        expect(count(service, id, "BaseConflictsRemained")).toBe(0);
        // 人のコミットは、次の実行を始める前に取り込む
        const recorded = types(service, id);
        expect(recorded.indexOf("ImplementationIncomplete")).toBeLessThan(
          recorded.indexOf("PullRequestHeadMerged"),
        );
        expect(taskOf(service, id).headMerge).toMatchObject({
          commit: human,
          conflicts: [conflicted],
        });
        // 次の実行の指示に、残っていること・元の指摘・競合したファイルを渡している
        const prompt = promptOf(executor, before + 1);
        expect(prompt).toContain("--- 前回の実行：実装が終わっていませんでした ---");
        expect(prompt).toContain("- 失敗時の受け入れ条件のテスト");
        expect(prompt).toContain("受け入れ条件が足りない");
        expect(prompt).toContain("--- 人が PR に足したコミット ---");
        expect(prompt).toContain(conflicted);
        expect(promptOf(executor, before)).not.toContain(conflicted);
        // PR は更新していない（コミットもプッシュもしない）
        expect(pulls.calls).toHaveLength(updates);
        expect(repos.published).toHaveLength(published);
        expect(taskOf(service, id).pullRequest?.commit).toBe(first);

        // 完了と申告した実行では、競合の確認を飛ばさない：目印が残っていれば、提出せずに実装をやり直す
        await service.runNext(id);
        expect(completedRun(service, id)?.completion).toEqual({ status: "complete" });
        expect(types(service, id).at(-1)).toBe("BaseConflictsRemained");
        expect(taskOf(service, id).verifyFeedback).toEqual({ kind: "merge", files: [conflicted] });
        expect(pulls.calls).toHaveLength(updates);
        expect(repos.published).toHaveLength(published);

        // 目印を消して完了と申告したら、人のコミットに積んで、PR を更新する
        repos.markers = [];
        await settle(service, id);
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(count(service, id, "ImplementationIncomplete")).toBe(1);
        expect(count(service, id, "BaseConflictsRemained")).toBe(1);
        expect(repos.published.at(-1)?.parent).toBe(human);
        expect(pulls.calls).toHaveLength(updates + 1);
        expect(count(service, id, "StepSubmitted")).toBe(2);
        activity.close();
      });

      it("未完了と申告した実行が、ベースブランチとの競合の目印を残していても、競合より先に未完了を記録し、残っていることを渡して実装をやり直す。完了と申告した実行で目印が残っていれば、提出しない（受け入れ条件 2・3）", async () => {
        const repos = new FakeRepos();
        // 作業領域を用意した後にベースブランチ（main）が進み、実装を始める前の取り込みで競合する
        const tip = "e".repeat(40);
        const conflicted = "src/conflicted.ts";
        repos.remote.main = tip;
        repos.mergeResult = { status: "conflicted", conflicts: [conflicted] };
        repos.markers = [conflicted];
        const { activity, service, executor, pulls, id } = await begin(
          [
            // 競合の目印を残したまま、途中で終わる
            unfinished(["docs の更新"]),
            // 完了と申告するが、競合の目印を残している
            implement("# 実装の説明 v2"),
            implement("# 実装の説明 v3"),
          ],
          { repos, mergeBase: true },
        );
        for (let i = 0; i < 6 && executor.calls.length < 2; i++) await service.runNext(id);
        expect(executor.calls).toHaveLength(2);
        // 最初の実行の指示に、取り込みで競合したファイルを渡している
        expect(taskOf(service, id).baseMerge).toMatchObject({
          commit: tip,
          conflicts: [conflicted],
        });
        expect(promptOf(executor, 0)).toContain("ベースブランチとの競合");
        expect(promptOf(executor, 0)).toContain(conflicted);
        // 未完了の実行の後：競合の確認より先に、未完了を記録する（検証に通らなかった回数には数えない）
        expect(completedRun(service, id, 0)?.completion).toEqual({
          status: "incomplete",
          remaining: ["docs の更新"],
        });
        expect(count(service, id, "ImplementationIncomplete")).toBe(1);
        expect(count(service, id, "BaseConflictsRemained")).toBe(0);
        expect(taskOf(service, id).verifyFailures).toBe(0);
        // 次の実行の指示に、残っていることと、目印の残るファイルの両方を渡している（目印が残っているうちは、取り込み直さない）
        const prompt = promptOf(executor, 1);
        expect(prompt).toContain("--- 前回の実行：実装が終わっていませんでした ---");
        expect(prompt).toContain("- docs の更新");
        expect(prompt).not.toContain("前回の検証：ベースブランチとの競合の目印が残っていました");
        expect(prompt).toContain("ベースブランチとの競合");
        expect(prompt).toContain(conflicted);
        expect(repos.merges).toHaveLength(1);
        // PR は作っていない
        expect(repos.published).toHaveLength(0);
        expect(pulls.calls).toHaveLength(0);

        // 完了と申告した実行では、競合の確認を飛ばさない：目印が残っていれば、PR を作らずに実装をやり直す
        await service.runNext(id);
        expect(completedRun(service, id)?.completion).toEqual({ status: "complete" });
        expect(types(service, id).at(-1)).toBe("BaseConflictsRemained");
        expect(taskOf(service, id).verifyFeedback).toEqual({ kind: "merge", files: [conflicted] });
        expect(taskOf(service, id).verifyFailures).toBe(1);
        expect(repos.published).toHaveLength(0);
        expect(pulls.calls).toHaveLength(0);

        // 目印を消して完了と申告したら、取り込んだ先頭を第2の親にしたコミットで、PR を作る
        repos.markers = [];
        await settle(service, id);
        expect(promptOf(executor, 2)).toContain(
          "--- 前回の検証：ベースブランチとの競合の目印が残っていました ---",
        );
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(count(service, id, "ImplementationIncomplete")).toBe(1);
        expect(count(service, id, "BaseConflictsRemained")).toBe(1);
        expect(repos.publishInputs).toEqual([{ baseCommit: tip, merge: tip }]);
        expect(pulls.calls).toHaveLength(1);
        activity.close();
      });

      it("実装が続けて終わらなければ、続きの実行の上限まで続け、PR を作らずに一時停止して、残っていることを出す。再開すると実装をやり直す（受け入れ条件 3・9、PBI-350 受け入れ条件 4）", async () => {
        const { activity, service, executor, pulls, repos, id } = await begin([
          unfinished(["API の入力", "候補の絞り込み", "docs"]),
          ...Array.from({ length: RUNS_UNTIL_PAUSE - 2 }, () =>
            unfinished(["候補の絞り込み", "docs"]),
          ),
          unfinished(["docs の更新"]),
          implement("# 実装の説明 完了"),
        ]);
        progress(executor, repos);
        await settle(service, id, RUNS_UNTIL_PAUSE * 3);
        let task = taskOf(service, id);
        // 最初の実行と、続きの実行の上限（10 回）まで実行して、止まる
        expect(MAX_INCOMPLETE_CONTINUATIONS).toBe(10);
        expect(executor.calls).toHaveLength(RUNS_UNTIL_PAUSE);
        expect(count(service, id, "ImplementationIncomplete")).toBe(RUNS_UNTIL_PAUSE);
        expect(task.status).toBe("paused");
        expect(task.pausedReason).toBe("incomplete");
        expect(task.pausedMessage).toEqual({
          code: "implement.incomplete",
          params: {
            count: RUNS_UNTIL_PAUSE,
            stalled: false,
            declared: true,
            remaining: "docs の更新",
            total: 1,
          },
        });
        const ja = renderMessage(task.pausedMessage as DaemonText, "ja");
        expect(ja).toContain(`範囲を実装し終える前に終わりました（${RUNS_UNTIL_PAUSE}回続けて）`);
        expect(ja).toContain("残っていること：docs の更新");
        expect(renderMessage(task.pausedMessage as DaemonText, "en")).toContain(
          `${RUNS_UNTIL_PAUSE} times in a row`,
        );
        expect(repos.published).toHaveLength(0);
        expect(pulls.calls).toHaveLength(0);
        expect(types(service, id)).not.toContain("PullRequestPublished");
        expect(types(service, id)).not.toContain("StepSubmitted");
        // 不合格のまま進める操作（以前の版の検証の一時停止だけ）は、できない
        expect(() => service.submitForReview(id)).toThrow();
        // 再開すると、回数を数え直して、実装をやり直す
        service.resume(id, {});
        expect(taskOf(service, id).incompleteRuns?.runs).toBe(0);
        await settle(service, id);
        task = taskOf(service, id);
        expect(executor.calls).toHaveLength(RUNS_UNTIL_PAUSE + 1);
        expect(promptOf(executor, RUNS_UNTIL_PAUSE)).toContain(
          "--- 前回の実行：実装が終わっていませんでした ---",
        );
        expect(task.status).toBe("awaiting_approval");
        expect(pulls.calls).toHaveLength(1);
        activity.close();
      });

      it("やり直しても作業領域が何も変わらなければ、回数を待たずに止める（受け入れ条件 3）", async () => {
        const { activity, service, executor, pulls, id } = await begin([
          unfinished(["API の入力", "docs"]),
          unfinished(["API の入力", "docs"]),
          unfinished(["API の入力", "docs"]),
        ]);
        // 作業領域の内容の目印は変えない（やり直しが何も変えなかった）
        await settle(service, id);
        const task = taskOf(service, id);
        expect(executor.calls).toHaveLength(2);
        expect(task.status).toBe("paused");
        expect(task.pausedReason).toBe("incomplete");
        expect(task.pausedMessage).toMatchObject({
          code: "implement.incomplete",
          params: { count: 2, stalled: true, declared: true, total: 2 },
        });
        expect(renderMessage(task.pausedMessage as DaemonText, "ja")).toContain(
          "やり直しても、作業領域が何も変わりませんでした",
        );
        expect(pulls.calls).toHaveLength(0);
        activity.close();
      });

      it("作業領域を読めなければ、目印なしで回数まで数える", async () => {
        const { activity, service, executor, repos, id } = await begin(
          Array.from({ length: RUNS_UNTIL_PAUSE }, () => unfinished(["API の入力"])),
        );
        repos.treeFail = "作業領域を読めない";
        await settle(service, id, RUNS_UNTIL_PAUSE * 3);
        const task = taskOf(service, id);
        expect(executor.calls).toHaveLength(RUNS_UNTIL_PAUSE);
        expect(task.pausedReason).toBe("incomplete");
        expect(task.pausedMessage).toMatchObject({
          params: { count: RUNS_UNTIL_PAUSE, stalled: false },
        });
        expect(
          service.get(id)?.activity.find((e) => e.type === "ImplementationIncomplete")?.payload,
        ).not.toHaveProperty("fingerprint");
        activity.close();
      });

      it("完了の申告が読めない実行も、未完了と同じに扱って提出しない（受け入れ条件 4）", async () => {
        const broken = '```sacty-completion\n{"status": "complete",}\n```';
        const { activity, service, executor, pulls, repos, id } = await begin([
          out(["# 実装の説明", MAP, broken].join("\n\n")),
          implement("# 実装の説明 v2"),
        ]);
        progress(executor, repos);
        for (let i = 0; i < 4 && executor.calls.length < 2; i++) await service.runNext(id);
        expect(completedRun(service, id, 0)?.completion).toBeNull();
        expect(
          service.get(id)?.activity.find((e) => e.type === "ImplementationIncomplete")?.payload,
        ).toMatchObject({ remaining: [], undeclared: true });
        expect(pulls.calls).toHaveLength(0);
        const prompt = promptOf(executor, 1);
        expect(prompt).toContain("--- 前回の実行：実装し終えたかの申告を読めませんでした ---");
        expect(prompt).not.toContain("前回の申告にあった、残っていること");
        await settle(service, id);
        expect(taskOf(service, id).status).toBe("awaiting_approval");
        expect(pulls.calls).toHaveLength(1);
        activity.close();
      });

      it("完了の申告が無い実行が続けば、申告が無いことを理由に一時停止する（受け入れ条件 4・9）", async () => {
        const { activity, service, executor, pulls, repos, id } = await begin([
          unfinished(["API の入力"]),
          ...Array.from({ length: RUNS_UNTIL_PAUSE - 1 }, (_, i) =>
            implement(`# 実装の説明 v${i + 2}`),
          ),
        ]);
        progress(executor, repos);
        for (let i = 0; i < 4 && executor.calls.length < 1; i++) await service.runNext(id);
        // 2回目からは、申告を付けない
        executor.undeclaredCompletion = true;
        await settle(service, id, RUNS_UNTIL_PAUSE * 3);
        const task = taskOf(service, id);
        expect(executor.calls).toHaveLength(RUNS_UNTIL_PAUSE);
        expect(task.pausedReason).toBe("incomplete");
        expect(task.pausedMessage).toEqual({
          code: "implement.incomplete",
          params: {
            count: RUNS_UNTIL_PAUSE,
            stalled: false,
            declared: false,
            remaining: "",
            total: 0,
          },
        });
        expect(renderMessage(task.pausedMessage as DaemonText, "ja")).toContain(
          "実装し終えたかの申告が無いか読めないまま終わりました",
        );
        expect(pulls.calls).toHaveLength(0);
        activity.close();
      });

      it("申告の項目が無い実装の完了（申告させる前の版の作業履歴）は、再起動の後も、実装をやり直さずに提出に進める（受け入れ条件 6）", async () => {
        const pulls = new FakePulls();
        const repos = new FakeRepos();
        // 最初の実行を失敗させて止め、再開して、作業領域と工程があって実装の完了がまだ無い作業履歴にする
        const failed: AgentOutcome = { kind: "failed", reason: "error", message: "exit code 1" };
        const made = await start([failed], {
          pulls,
          repos,
          steps: ["implement"],
          reviewTasks: true,
          ci: CI,
        });
        const { activity, id } = made;
        await settle(made.service, id);
        expect(taskOf(made.service, id).status).toBe("paused");
        made.service.resume(id, {});
        // 申告させる前の版の作業履歴：実装の実行の完了に、申告の項目（completion）が無い
        activity.append({
          taskId: id,
          projectId: "default",
          events: [
            {
              actor: "sacty",
              event: {
                type: "AgentRunStarted",
                payload: {
                  runId: "old-run",
                  step: "implement",
                  agentId: "a",
                  authMode: "subscription",
                },
              },
            },
            {
              actor: "agent",
              event: {
                type: "AgentRunCompleted",
                payload: {
                  runId: "old-run",
                  step: "implement",
                  agentId: "a",
                  authMode: "subscription",
                  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
                  costUsd: 0,
                  estimated: false,
                  output: "# 実装の説明（以前の版）",
                  responses: [],
                  testMap: [],
                },
              },
            },
          ],
        });
        // 再起動（作業履歴を読み直す）
        const restored = new SqliteActivityStore(dbPath);
        const { service, executor } = makeService(restored, [], {
          stepPullRequests: true,
          ci: CI,
          draftPullRequests: true,
          reviewTasks: true,
          now: later,
          pulls,
          repos,
          planner: async () => ({
            steps: ["implement"],
            fallback: false,
            testCommand: "npm test",
            costUsd: 0,
            estimated: false,
          }),
        });
        expect(taskOf(service, id).verification).toBe("pending");
        expect(taskOf(service, id).implementCompletion).toBeUndefined();
        await settle(service, id);
        // 未完了として扱わない：実装をやり直さず（エージェントを起動しない）、そのまま PR を作って承認待ちにする
        expect(executor.calls).toHaveLength(0);
        expect(types(service, id)).not.toContain("ImplementationIncomplete");
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(task.gate).toEqual({ step: "implement", submission: 1 });
        expect(task.outputs.implement).toBe("# 実装の説明（以前の版）");
        expect(repos.published).toHaveLength(1);
        expect(pulls.calls).toHaveLength(1);
        restored.close();
        activity.close();
      });

      it("AI のレビューが修正が必要とした PR の先頭を、やり直しが変えなければ、提出せずに一時停止する。再開すると実装をやり直す（受け入れ条件 7・9）", async () => {
        const { activity, service, executor, pulls, repos, id } = await begin([
          implement(),
          verdictOut("changes_required"),
          implement("# 実装の説明（変更なし）"),
          implement("# 実装の説明 v3"),
          verdictOut("no_findings", "# 評価\n\nマージしてよい"),
        ]);
        await settle(service, id);
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        // 指摘を取り込んで直すが、やり直しは作業領域を何も変えない（前に出したコミットと同じ内容）
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        repos.sameAsParent = true;
        const updates = pulls.calls.length;
        await settle(service, id);
        let task = taskOf(service, id);
        expect(task.status).toBe("paused");
        expect(task.pausedReason).toBe("unchanged");
        expect(task.pausedMessage).toEqual({ code: "implement.unchanged", params: { number: 7 } });
        expect(renderMessage(task.pausedMessage as DaemonText, "ja")).toContain(
          "PR #7 を、やり直しの実装が何も変えませんでした",
        );
        expect(renderMessage(task.pausedMessage as DaemonText, "en")).toContain("PR #7");
        expect(
          service.get(id)?.activity.find((e) => e.type === "ImplementationUnchanged"),
        ).toMatchObject({
          actor: "sacty",
          payload: {
            repo: taskOf(service, id).pullRequest?.repo,
            number: 7,
            commit: first,
            reviewTaskId: childId,
          },
        });
        // 提出にしていない：PR を更新せず、提出の回も進めない
        expect(pulls.calls).toHaveLength(updates);
        expect(count(service, id, "PullRequestPublished")).toBe(1);
        expect(count(service, id, "StepSubmitted")).toBe(1);
        expect(task.pullRequest?.commit).toBe(first);
        // PR の確認を繰り返しても、止まったまま（子タスクも再レビューしない）
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("paused");
        expect(taskOf(service, childId).reviewRound ?? 1).toBe(1);
        // 再開すると、指摘と、前回が何も変えなかったことを渡して、実装をやり直す
        repos.sameAsParent = false;
        const before = executor.calls.length;
        service.resume(id, {});
        await settle(service, id);
        const prompt = promptOf(executor, before);
        expect(prompt).toContain("--- 前回の実行：PR の内容を何も変えませんでした ---");
        expect(prompt).toContain("PR #7");
        expect(prompt).toContain("受け入れ条件が足りない");
        task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        const second = commitOf(service, id);
        expect(second).not.toBe(first);
        expect(count(service, id, "StepSubmitted")).toBe(2);
        expect(task.verifyFeedback).toBeUndefined();
        // 新しい先頭は再レビューされ、指摘なしでドラフトが外れる
        pulls.prInfo = { ...pulls.prInfo, headSha: second };
        await service.checkPullRequests();
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(taskOf(service, id).pullRequest?.draft).toBeUndefined();
        activity.close();
      });

      it("人が PR に足したコミットの先頭に指摘が残り、やり直しがその先頭を変えなければ、同じく提出せずに一時停止する（受け入れ条件 7）", async () => {
        const { activity, service, pulls, repos, id } = await begin([
          implement(),
          verdictOut("changes_required"),
          implement("# 実装の説明（変更なし）"),
        ]);
        await settle(service, id);
        const childId = childOf(service, id);
        const pushed = taskOf(service, id).pushedBranch;
        if (!pushed) throw new Error("no pushed branch");
        // 人が PR のブランチにコミットを足し、子タスクはその先頭をレビューして指摘を残す
        const human = "d".repeat(40);
        repos.remote[pushed.branch] = human;
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: human };
        await runReview(service, childId);
        expect(taskOf(service, childId).reviewTarget?.headCommit).toBe(human);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        // やり直しは、取り込んだ人の先頭から何も変えない
        repos.sameAsParent = true;
        const updates = pulls.calls.length;
        await settle(service, id);
        const task = taskOf(service, id);
        expect(task.status).toBe("paused");
        expect(task.pausedReason).toBe("unchanged");
        expect(
          service.get(id)?.activity.find((e) => e.type === "ImplementationUnchanged")?.payload,
        ).toMatchObject({ number: 7, commit: human, reviewTaskId: childId });
        expect(pulls.calls).toHaveLength(updates);
        expect(count(service, id, "StepSubmitted")).toBe(1);
        activity.close();
      });

      it("止めるときは、未完了の記録と一時停止を同じ追記で記録する（間で止まっても、止めるはずの実装をやり直さない）", async () => {
        const { activity, service, id } = await begin([
          unfinished(["API の入力"]),
          unfinished(["API の入力"]),
        ]);
        const appends: string[][] = [];
        const original = activity.append.bind(activity);
        vi.spyOn(activity, "append").mockImplementation((input) => {
          appends.push(input.events.map((e) => e.event.type));
          return original(input);
        });
        await settle(service, id);
        expect(taskOf(service, id).pausedReason).toBe("incomplete");
        // 1回目は未完了の記録だけ、止める2回目（やり直しても何も変わらなかった）は一時停止と一緒に記録する
        const recorded = appends.filter((types) => types.includes("ImplementationIncomplete"));
        expect(recorded).toEqual([
          ["ImplementationIncomplete"],
          ["ImplementationIncomplete", "TaskPaused"],
        ]);
        activity.close();
      });

      it("変更の無いやり直しで止めるときは、その記録と一時停止を同じ追記で記録する（間で止まっても、人の再開を待たずに実装をやり直さない）", async () => {
        const { activity, service, pulls, repos, id } = await begin([
          implement(),
          verdictOut("changes_required"),
          implement("# 実装の説明（変更なし）"),
        ]);
        await settle(service, id);
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        const appends: string[][] = [];
        const original = activity.append.bind(activity);
        vi.spyOn(activity, "append").mockImplementation((input) => {
          appends.push(input.events.map((e) => e.event.type));
          return original(input);
        });
        repos.sameAsParent = true;
        await settle(service, id);
        expect(taskOf(service, id).pausedReason).toBe("unchanged");
        // 変更の無いやり直しの記録だけでは、実行待ちのまま（一時停止と分けて記録すると、間で止まったときに実装をやり直す）
        const recorded = appends.filter((types) => types.includes("ImplementationUnchanged"));
        expect(recorded).toEqual([["ImplementationUnchanged", "TaskPaused"]]);
        activity.close();
      });

      it("変更の無いやり直しで止まった PR は、人がドラフトを外しても戻さず、マージすると実装を承認して進む（受け入れ条件 7）", async () => {
        const made = await begin([
          implement(),
          verdictOut("changes_required"),
          implement("# 実装の説明（変更なし）"),
        ]);
        const { activity, service, pulls, repos, id } = made;
        await settle(service, id);
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        repos.sameAsParent = true;
        await settle(service, id);
        expect(taskOf(service, id).pausedReason).toBe("unchanged");
        // 人が、AI のレビューの指摘を採らないと判断して、GitHub でドラフトを外す
        pulls.drafts[7] = false;
        const changes = pulls.draftChanges.length;
        await service.checkPullRequests();
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(false);
        expect(pulls.draftChanges).toHaveLength(changes);
        expect(taskOf(service, id).status).toBe("paused");
        // マージすると、実装を承認したことになる（やり直しに渡すはずだった内容は捨てる）
        await merge(made, "implement");
        const task = taskOf(service, id);
        expect(task.status).not.toBe("paused");
        expect(task.pullRequestState).toBe("merged");
        expect(task.steps.find((s) => s.key === "implement")?.state).toBe("done");
        expect(
          service.get(id)?.activity.find((e) => e.type === "ReworkStoppedByMerge")?.payload,
        ).toMatchObject({ was: "paused", discardedFeedback: "unchanged" });
        activity.close();
      });

      it("未完了のやり直しの間に PR がマージされたら、マージを実装の承認として進め、やり直しに渡すはずだった残りと、続いた回数を捨てる", async () => {
        const made = await begin([
          implement(),
          verdictOut("changes_required"),
          // 指摘を受けたやり直しが、途中で終わる
          unfinished(["失敗時の受け入れ条件のテスト"]),
        ]);
        const { activity, service, executor, pulls, repos, id } = made;
        progress(executor, repos);
        await settle(service, id);
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        for (let i = 0; i < 6 && count(service, id, "ImplementationIncomplete") < 1; i++) {
          await service.runNext(id);
        }
        // 未完了のやり直しを待っている（PR は、前の提出のまま）
        const waiting = taskOf(service, id);
        expect(waiting.status).toBe("queued");
        expect(waiting.verifyFeedback).toEqual({
          kind: "incomplete",
          remaining: ["失敗時の受け入れ条件のテスト"],
        });
        expect(waiting.incompleteRuns?.runs).toBe(1);
        const runs = executor.calls.length;
        // 人が、前の提出のまま PR をマージする
        await merge(made, "implement");
        const task = taskOf(service, id);
        expect(
          service.get(id)?.activity.find((e) => e.type === "ReworkStoppedByMerge")?.payload,
        ).toMatchObject({ number: 7, was: "queued", discardedFeedback: "incomplete" });
        expect(task.pullRequestState).toBe("merged");
        expect(task.steps.find((s) => s.key === "implement")?.state).toBe("done");
        expect(task.approved.implement?.submission).toBe(1);
        expect(task.verifyFeedback).toBeUndefined();
        expect(task.incompleteRuns).toBeUndefined();
        // 実装はやり直さない
        await settle(service, id, 3);
        expect(executor.calls).toHaveLength(runs);
        activity.close();
      });

      it("ほかの理由で一時停止した、指摘なしを待つ PR は、人がドラフトを外しても、今までどおりドラフトに戻す", async () => {
        const { activity, service, pulls, id } = await begin([implement()]);
        await settle(service, id);
        await service.pause(id);
        expect(taskOf(service, id).pausedReason).toBe("manual");
        pulls.drafts[7] = false;
        await service.checkPullRequests();
        expect(pulls.drafts[7]).toBe(true);
        activity.close();
      });

      it("子タスクが指摘なしにした先頭を、人の指摘のやり直しが変えなくても、今までどおり提出する（受け入れ条件 8）", async () => {
        const { activity, service, pulls, repos, id } = await begin([
          implement(),
          verdictOut("no_findings", "# 評価\n\nマージしてよい"),
          // 人の指摘の戻し先は、工程のエージェントが判断する
          rework("implement"),
          implement("# 実装の説明（人の質問に答えた。変更なし）"),
        ]);
        await settle(service, id);
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        await service.checkPullRequests();
        expect(taskOf(service, id).pullRequest?.draft).toBeUndefined();
        // 人が PR にコメントし、やり直しは何も変えない
        pulls.feedbackBy[7] = [item("c1", { body: "ここはなぜこうしたのですか" })];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        repos.sameAsParent = true;
        await settle(service, id);
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(types(service, id)).not.toContain("ImplementationUnchanged");
        expect(count(service, id, "StepSubmitted")).toBe(2);
        expect(task.pullRequest?.commit).toBe(first);
        activity.close();
      });

      it("子タスクがまだレビューしていない先頭を、人の指摘のやり直しが変えなくても、今までどおり提出する（受け入れ条件 8）", async () => {
        const { activity, service, pulls, repos, id } = await begin([
          implement(),
          rework("implement"),
          implement("# 実装の説明（変更なし）"),
        ]);
        await settle(service, id);
        const first = commitOf(service, id);
        // 子タスクがレビューする前に、人が PR にコメントする
        pulls.feedbackBy[7] = [item("c1", { body: "ここはなぜこうしたのですか" })];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        repos.sameAsParent = true;
        await settle(service, id);
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(types(service, id)).not.toContain("ImplementationUnchanged");
        expect(count(service, id, "StepSubmitted")).toBe(2);
        expect(task.pullRequest?.commit).toBe(first);
        activity.close();
      });

      it("子タスクがその先頭を対象に決めた後、レビューを終えていなければ（途中で止まっている）、やり直しが変えなくても、今までどおり提出する（受け入れ条件 8）", async () => {
        const { activity, service, pulls, repos, id } = await begin([
          implement(),
          // 子タスクのレビューの実行が失敗して、子タスクが止まる
          { kind: "failed", reason: "error", message: "exit code 1" },
          rework("implement"),
          implement("# 実装の説明（変更なし）"),
        ]);
        await settle(service, id);
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        // 子タスクは、その先頭をレビューの対象に決めたが、レビューを終えていない（判定も無い）
        const child = taskOf(service, childId);
        expect(child.reviewTarget?.headCommit).toBe(first);
        expect(child.status).toBe("paused");
        expect(isCompleted(child)).toBe(false);
        expect(child.reviewVerdicts ?? []).toEqual([]);
        // 人が PR にコメントし、やり直しは何も変えない
        pulls.feedbackBy[7] = [item("c1", { body: "ここはなぜこうしたのですか" })];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        repos.sameAsParent = true;
        await settle(service, id);
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(types(service, id)).not.toContain("ImplementationUnchanged");
        expect(count(service, id, "StepSubmitted")).toBe(2);
        expect(task.pullRequest?.commit).toBe(first);
        activity.close();
      });

      it("レビューの子タスクを待たない PR は、やり直しが何も変えなくても、今までどおり提出する（受け入れ条件 8）", async () => {
        const pulls = new FakePulls();
        const repos = new FakeRepos();
        // 子タスクを作らず、ドラフトにもしないデーモン
        const made = await start(
          [implement(), rework("implement"), implement("# 実装の説明（変更なし）")],
          {
            pulls,
            repos,
            steps: ["implement"],
          },
        );
        const { activity, service, id } = made;
        await settle(service, id);
        const first = commitOf(service, id);
        pulls.feedbackBy[7] = [item("c1", { body: "ここはなぜこうしたのですか" })];
        await service.checkPullRequests();
        repos.sameAsParent = true;
        await settle(service, id);
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(types(service, id)).not.toContain("ImplementationUnchanged");
        expect(count(service, id, "StepSubmitted")).toBe(2);
        expect(task.pullRequest?.commit).toBe(first);
        activity.close();
      });

      it("子タスクの指摘なしを待たない PR は、子タスクが指摘を残した先頭を、やり直しが変えなくても、今までどおり提出する（受け入れ条件 8）", async () => {
        const pulls = new FakePulls();
        const repos = new FakeRepos();
        // 子タスクは作るが、PR をドラフトにせず、子タスクの指摘なしを待たないデーモン
        const made = await start(
          [implement(), verdictOut("changes_required"), implement("# 実装の説明（変更なし）")],
          {
            pulls,
            repos,
            steps: ["implement"],
            reviewTasks: true,
          },
        );
        const { activity, service, id } = made;
        await settle(service, id);
        expect(taskOf(service, id).pullRequest?.awaitingReview).toBeUndefined();
        const childId = childOf(service, id);
        const first = commitOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: first };
        await runReview(service, childId);
        // 子タスクは、その先頭に指摘を残して終わっている
        const child = taskOf(service, childId);
        expect(isCompleted(child)).toBe(true);
        expect(child.reviewTarget?.headCommit).toBe(first);
        expect(child.reviewVerdicts?.at(-1)?.verdict).toBe("changes_required");
        // 指摘を取り込んで直すが、やり直しは何も変えない
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        await service.checkPullRequests();
        expect(taskOf(service, id).status).toBe("queued");
        repos.sameAsParent = true;
        await settle(service, id);
        // 指摘なしを待たないので、行き止まりにならない：止めずに、今までどおり提出する
        const task = taskOf(service, id);
        expect(task.status).toBe("awaiting_approval");
        expect(types(service, id)).not.toContain("ImplementationUnchanged");
        expect(count(service, id, "StepSubmitted")).toBe(2);
        expect(task.pullRequest?.commit).toBe(first);
        activity.close();
      });
    });

    it("レビューの子タスクは、親タスクが集めた情報を引き継ぎ、情報収集を実行せずにレビューの工程へ進む（PBI-345）", async () => {
      const gatheredFor: string[] = [];
      const made = await start([out("# 要求要件 v1")], {
        reviewTasks: true,
        gatherer: async (task) => {
          gatheredFor.push(task.id);
          return { brief: "PAY-100：二重請求をなくす", sources: [{ title: "PAY-100" }] };
        },
      });
      const { activity, service, id } = made;
      // start は親を1回だけ実行する（情報収集まで）。要求要件の PR を作るまで進める
      for (let i = 0; i < 4 && !childOf(service, id); i++) await service.runNext(id);
      const childId = childOf(service, id);
      expect(childId).not.toBe("");
      expect(gatheredFor).toEqual([id]);
      await service.runNext(childId);
      // 子タスクでは集めない。親のまとめと情報源を、親の ID と一緒に持つ
      expect(gatheredFor).toEqual([id]);
      const parent = taskOf(service, id);
      expect(parent.gathered?.brief).toBe("PAY-100：二重請求をなくす");
      expect(taskOf(service, childId).gathered).toMatchObject({
        brief: parent.gathered?.brief,
        sources: parent.gathered?.sources,
        inheritedFrom: id,
      });
      expect(types(service, childId)).toContain("GatheredInherited");
      expect(types(service, childId)).not.toContain("InformationGathered");
      expect(
        service.get(childId)?.activity.find((e) => e.type === "GatheredInherited"),
      ).toMatchObject({ actor: "sacty", payload: { from: id } });
      expect(taskOf(service, childId).budget.usedUsd).toBe(0);
      // 次の実行で、レビューの工程に決まる（引き継ぎで止まらない）
      for (let i = 0; i < 3 && taskOf(service, childId).steps.length === 0; i++) {
        await service.runNext(childId);
      }
      expect(taskOf(service, childId).steps.map((s) => s.key)).toEqual(["review"]);
      expect(gatheredFor).toEqual([id]);
      // 再起動しても、引き継いだまとめを復元する
      const done = taskOf(service, childId).gathered;
      activity.close();
      const again = new SqliteActivityStore(dbPath);
      const restarted = makeService(again, [], { stepPullRequests: true }).service;
      expect(restarted.get(childId)?.task.gathered).toEqual(done);
      again.close();
    });

    it("親タスクにまとめが無いレビューの子タスクは、今までどおり自分で集める（PBI-345）", async () => {
      const gatheredFor: string[] = [];
      let parentId = "";
      const made = await start([out("# 要求要件 v1")], {
        reviewTasks: true,
        // 親（最初に集めるタスク）は集めずに進め、ほかのタスクは集める
        gatherer: async (task) => {
          parentId ||= task.id;
          gatheredFor.push(task.id);
          return task.id === parentId ? undefined : { brief: "子で集めた", sources: [] };
        },
      });
      const { activity, service, id } = made;
      for (let i = 0; i < 4 && !childOf(service, id); i++) await service.runNext(id);
      const childId = childOf(service, id);
      expect(childId).not.toBe("");
      expect(taskOf(service, id).gathered).toBeUndefined();
      await service.runNext(childId);
      expect(gatheredFor).toContain(childId);
      expect(taskOf(service, childId).gathered).toMatchObject({ brief: "子で集めた" });
      expect(taskOf(service, childId).gathered?.inheritedFrom).toBeUndefined();
      expect(types(service, childId)).toContain("InformationGathered");
      expect(types(service, childId)).not.toContain("GatheredInherited");
      activity.close();
    });

    it("再レビューは、親の指摘への返信（PBI-352）を先に投稿してから、PR の作者の返答を読む（親の次の実行を待たない）", async () => {
      /** レビューの工程が PR の既存のレビュー・返答を読んだ時点で、投稿済みだった返信の数。 */
      const repliesWhenRead: number[] = [];
      class Watching extends FakePulls {
        override async feedback(input: Parameters<FakePulls["feedback"]>[0]) {
          if (input.includeSactyReplies) {
            repliesWhenRead.push(
              this.issueComments.filter((c) => c.body.startsWith("<!-- sacty-reply:")).length,
            );
          }
          return super.feedback(input);
        }
      }
      const pulls = new Watching();
      const projects = projectsWithAccount();
      let clock = later();
      const redone = [
        "# 要求要件 v2",
        `\`\`\`json\n${JSON.stringify({
          "sacty-responses": [
            {
              remarkId: "requirements-1-1",
              status: "declined",
              text: "この要求は、このタスクの範囲の外です（後続で対応します）",
            },
          ],
        })}\n\`\`\``,
      ].join("\n\n");
      const made = await start(
        [
          out("# 要求要件 v1"),
          verdictOut("changes_required"),
          out(redone),
          verdictOut("no_findings"),
          verdictOut("no_findings"),
        ],
        {
          pulls,
          reviewTasks: true,
          projects,
          github: new FakeGitHub({ me: "ghp_secret", other: "ghp_other" }),
          now: () => clock,
        },
      );
      const { activity, service, id } = made;
      const childId = childOf(service, id);
      const first = commitOf(service, id);
      pulls.prInfo = {
        ...pulls.prInfo,
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        headSha: first,
      };
      await runReview(service, childId);
      pulls.feedbackBy[7] = [posted(pulls, 0)];
      await service.checkPullRequests();
      // 親が直して、PR を更新し、承認待ちに戻る（返信は、親の次の実行でする処理）
      await service.runNext(id);
      const second = commitOf(service, id);
      expect(taskOf(service, id).status).toBe("awaiting_approval");
      expect(taskOf(service, id).remarks.at(-1)).toMatchObject({
        id: "requirements-1-1",
        status: "declined",
        origin: { number: 7 },
      });
      const replies = () =>
        pulls.issueComments.filter((c) => c.body.startsWith("<!-- sacty-reply:"));
      expect(replies()).toHaveLength(0);
      // 子タスクが、親の次の実行より先に、再レビューを始める
      await service.checkPullRequests();
      pulls.prInfo = { ...pulls.prInfo, headSha: second };
      repliesWhenRead.length = 0;
      // 返信の結果を記録できない間は、レビューを始めない（成功・失敗の記録の前に、作者の返答を読まない）
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const append = activity.append.bind(activity);
      let failOnce = true;
      activity.append = (entry) => {
        if (failOnce && entry.events.some((e) => e.event.type === "RemarkRepliesPosted")) {
          failOnce = false;
          throw new Error("disk full");
        }
        return append(entry);
      };
      await service.runNext(childId);
      expect(failOnce).toBe(false);
      expect(repliesWhenRead).toEqual([]);
      expect(pulls.reviews).toHaveLength(1);
      expect(taskOf(service, childId).status).toBe("queued");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("レビューを始めずに"));
      warn.mockRestore();
      // 待っている間、子タスクは実行待ちに出ない（始めても進めないレビューが、実行の枠を取り続けない）。始めさせても進まない
      expect(service.queuedTaskIds()).not.toContain(childId);
      await service.runNext(childId);
      expect(pulls.reviews).toHaveLength(1);
      // 間を置いたら、実行待ちに戻り、投稿済みの返信を見つけて記録してから、レビューする
      clock += 61_000;
      expect(service.queuedTaskIds()).toContain(childId);
      await runReview(service, childId);
      expect(pulls.reviews).toHaveLength(2);
      // レビューが PR を読む前に、親の返信が投稿され、記録されている
      expect(repliesWhenRead).toEqual([1]);
      expect(replies()).toHaveLength(1);
      expect(replies()[0]?.body).toContain("**対応していません。** 理由：");
      expect(types(service, id).filter((t) => t === "RemarkRepliesPosted")).toHaveLength(1);
      // 親の次の実行で、重ねて投稿しない
      await service.runNext(id);
      expect(replies()).toHaveLength(1);
      // レビューの読み取りには、親が返信に使ったと記録したアカウントを渡す（そのアカウントが、どのプロジェクトからも
      // 外れた後でも、返信を作者の返答として読めるように）
      const current = projects.get("default");
      projects.put("default", {
        name: current?.name ?? "",
        targets: current?.targets ?? [],
        githubAccounts: { "github.com": "other" },
      });
      service.rereview(childId);
      await runReview(service, childId);
      expect(pulls.feedbackAccounts.at(-1)).toBe("other");
      expect(pulls.feedbackNoticeAccounts.at(-1)).toEqual(["other", "me"]);
      activity.close();
    });

    it("子タスクの指摘を親が直して PR を更新したら、子タスクが最新のコミットを再レビューし、指摘なしになったら繰り返さずに人の承認を待つ（受け入れ条件 2・3）", async () => {
      const pulls = new FakePulls();
      const made = await start(
        [
          out("# 要求要件 v1"),
          verdictOut("changes_required"),
          out("# 要求要件 v2"),
          verdictOut("no_findings", "# 評価\n\nマージしてよい"),
        ],
        { pulls, reviewTasks: true },
      );
      const { activity, service, executor, id } = made;
      const childId = childOf(service, id);
      const first = commitOf(service, id);
      pulls.prInfo = {
        ...pulls.prInfo,
        number: 7,
        url: "https://github.com/acme/app/pull/7",
        headSha: first,
      };
      const before = executor.calls.length;
      await runReview(service, childId);
      expect(executor.calls[before]?.command.join(" ")).toContain("レビューエージェント");
      expect(pulls.reviews.map((r) => r.number)).toEqual([7]);
      expect(pulls.reviews[0]?.body).toContain(`<!-- sacty-review:${childId} -->`);
      expect(taskOf(service, childId).reviewVerdicts).toEqual([
        { round: 1, verdict: "changes_required" },
      ]);
      // 親が PR を更新するまでは、再レビューしない
      await service.checkPullRequests();
      expect(types(service, childId)).not.toContain("ReviewRestarted");
      // 子タスクの指摘が、親の PR の指摘（AI のレビューの指摘）として届き、親が直す
      pulls.feedbackBy[7] = [posted(pulls, 0)];
      await service.checkPullRequests();
      expect(pulls.feedbackSactyReviews.at(-1)).toEqual([childId]);
      const imported = service
        .get(id)
        ?.activity.find((e) => e.type === "PullRequestReviewImported");
      expect(imported?.actor).toBe("sacty");
      expect(taskOf(service, id).remarks.at(-1)?.source).toBe("sacty_review");
      expect(taskOf(service, id).status).toBe("queued");
      // 直している間（承認待ちでない）は、再レビューしない
      expect(types(service, childId)).not.toContain("ReviewRestarted");
      await service.runNext(id);
      const second = commitOf(service, id);
      expect(second).not.toBe(first);
      expect(taskOf(service, id).status).toBe("awaiting_approval");
      // PR を更新して承認待ちに戻ったので、最新のコミットを再レビューする（1回だけ）
      await service.checkPullRequests();
      await service.checkPullRequests();
      const restarts = service.get(childId)?.activity.filter((e) => e.type === "ReviewRestarted");
      expect(restarts).toHaveLength(1);
      expect(restarts?.[0]).toMatchObject({
        actor: "sacty",
        payload: { reason: "updated", commit: second },
      });
      pulls.prInfo = { ...pulls.prInfo, headSha: second };
      await runReview(service, childId);
      expect(pulls.reviews).toHaveLength(2);
      expect(taskOf(service, childId).reviewVerdicts).toEqual([
        { round: 1, verdict: "changes_required" },
        { round: 2, verdict: "no_findings" },
      ]);
      // 前回の指摘を渡して再レビューする
      expect(taskOf(service, childId).previousReview?.headCommit).toBe(first);
      // 指摘なしの回は親に届けず、再レビューも繰り返さず、人の承認（マージ）を待つ
      pulls.feedbackBy[7] = [posted(pulls, 0), posted(pulls, 1)];
      const after = executor.calls.length;
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(taskOf(service, id).status).toBe("awaiting_approval");
      expect(types(service, id).filter((t) => t === "PullRequestReviewImported")).toHaveLength(1);
      expect(
        service.get(childId)?.activity.filter((e) => e.type === "ReviewRestarted"),
      ).toHaveLength(1);
      expect(executor.calls.length).toBe(after);
      activity.close();
    });

    it("レビューした先頭が親の積んだコミットと違っても（ほかで push された）、同じ更新で再レビューを繰り返さない", async () => {
      const pulls = new FakePulls();
      const made = await start(
        [out("# 要求要件 v1"), verdictOut("no_findings"), verdictOut("no_findings")],
        { pulls, reviewTasks: true },
      );
      const { activity, service, id } = made;
      const childId = childOf(service, id);
      pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: "e".repeat(40) };
      await runReview(service, childId);
      await service.checkPullRequests();
      await runReview(service, childId);
      for (let i = 0; i < 3; i++) await service.checkPullRequests();
      const restarts = service.get(childId)?.activity.filter((e) => e.type === "ReviewRestarted");
      expect(restarts?.map((e) => e.payload)).toEqual([
        { reason: "updated", commit: commitOf(service, id) },
      ]);
      expect(taskOf(service, childId).reviewRound).toBe(2);
      activity.close();
    });

    it("指摘の無いレビューは、親に取り込まず差し戻さない。提案だけの回と、評価を読めない回は取り込む（PO の指摘・PBI-145）", async () => {
      const cases: { name: string; review: string; imported: boolean; verdict?: string }[] = [
        {
          name: "指摘なし",
          review: [
            "# 評価\n\nマージしてよい",
            block({ "sacty-review-verdict": { verdict: "no_findings" } }),
          ].join("\n\n"),
          imported: false,
          verdict: "no_findings",
        },
        {
          // 提案だけの回も、親に対応させるために取り込む（PBI-145。繰り返しの費用は予算で止める）
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
          imported: true,
          verdict: "suggestions",
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
          verdict: "changes_required",
        },
        { name: "評価なし", review: "# 評価\n\n直す点がある", imported: true },
      ];
      for (const c of cases) {
        rmSync(dbPath, { force: true });
        const pulls = new FakePulls();
        const made = await start(
          [
            out("# 要求要件 v1"),
            out(c.review),
            rework("requirements", "要求要件で直せる"),
            out("# 要求要件 v2"),
          ],
          { pulls, reviewTasks: true },
        );
        const { activity, service, executor, id } = made;
        const reviewId = childOf(service, id);
        pulls.prInfo = { ...pulls.prInfo, number: 7, headSha: commitOf(service, id) };
        await runReview(service, reviewId);
        expect(
          pulls.reviews.map((r) => r.number),
          c.name,
        ).toEqual([7]);
        pulls.feedbackBy[7] = [posted(pulls, 0)];
        const before = executor.calls.length;
        await service.checkPullRequests();
        const task = taskOf(service, id);
        if (c.imported) {
          expect(pulls.feedbackSactyReviews.at(-1), c.name).toEqual([reviewId]);
          expect(task.importedFeedback, c.name).toEqual(["review:50"]);
          expect(taskOf(service, reviewId).reviewVerdicts, c.name).toEqual([
            { round: 1, ...(c.verdict ? { verdict: c.verdict } : {}) },
          ]);
          expect(task.status, c.name).toBe("queued");
        } else {
          // 取り込まず、ゴールガーディアンも動かさず（費用がかからない）、承認待ちのまま
          expect(taskOf(service, reviewId).reviewVerdicts, c.name).toEqual([
            { round: 1, verdict: c.verdict },
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

    it("要求要件・設計・実装の PR それぞれに子タスクを作る。実装の PR は、ドラフトでない PR を作ったときに作る。マージされたら、終わっていない子タスクを終える", async () => {
      const pulls = new FakePulls();
      const made = await start([out("# 要求要件 v1"), design(), implement()], {
        pulls,
        reviewTasks: true,
      });
      const { activity, service, id } = made;
      await merge(made, "requirements");
      // 要求要件の PR のマージで、終わっていない子タスクは中止する（もうレビューしない）
      expect(taskOf(service, childOf(service, id, 7)).status).toBe("cancelled");
      await service.runNext(id);
      await merge(made, "design");
      for (let i = 0; i < 4 && taskOf(service, id).gate?.step !== "implement"; i++) {
        await service.runNext(id);
      }
      expect(taskOf(service, id).gate?.step).toBe("implement");
      expect(taskOf(service, id).reviewTasks?.map((r) => [r.number, r.step])).toEqual([
        [7, "requirements"],
        [8, "design"],
        [9, "implement"],
      ]);
      expect(taskOf(service, childOf(service, id, 9)).reviewOf).toEqual({
        taskId: id,
        step: "implement",
      });
      expect(pulls.labels).toEqual([]);
      activity.close();
    });

    it("親を中止したら、PR が開いたままでも、終わっていない子タスクを中止する（受け入れ条件 6）", async () => {
      const pulls = new FakePulls();
      const made = await start([out("# 要求要件 v1")], { pulls, reviewTasks: true });
      const { activity, service, id } = made;
      const childId = childOf(service, id);
      // 中止の片付けで PR を閉じられなかった（PR は開いたまま）
      pulls.closeFail = "403";
      await service.cancel(id);
      expect(taskOf(service, id).status).toBe("cancelled");
      // PR の確認は、子タスクの中止を待ってから終わる（デーモンの終了で、中止の記録が途中で切れない）
      await service.checkPullRequests();
      expect(taskOf(service, childId).status).toBe("cancelled");
      const cancelled = service.get(childId)?.activity.findLast((e) => e.type === "TaskCancelled");
      expect(cancelled?.actor).toBe("sacty");
      expect(cancelled?.payload).toMatchObject({ reason: "parent_cancelled" });
      activity.close();
    });

    it("PR のクローズで中止した子タスクは、PR を開き直したら新しい子タスクで作り直す。人が中止した子タスクは作り直さない（受け入れ条件 6）", async () => {
      const pulls = new FakePulls();
      const made = await start([out("# 要求要件 v1")], { pulls, reviewTasks: true });
      const { activity, service, id } = made;
      const first = childOf(service, id);
      pulls.states[7] = { state: "closed" };
      await service.checkPullRequests();
      expect(taskOf(service, first).cancelled?.reason).toBe("pull_request_closed");
      // 閉じている間は作り直さない
      await service.checkPullRequests();
      expect(taskOf(service, id).reviewTasks).toHaveLength(1);
      // 開き直したら、新しい子タスクを作って親に記録する（中止した子タスクは再レビューできないため）
      pulls.states[7] = { state: "open" };
      await service.checkPullRequests();
      const records = taskOf(service, id).reviewTasks ?? [];
      expect(records.map((r) => r.number)).toEqual([7, 7]);
      const second = records[1]?.taskId ?? "";
      expect(second).not.toBe(first);
      expect(taskOf(service, second).reviewOf).toEqual({ taskId: id, step: "requirements" });
      expect(service.queuedTaskIds()).toContain(second);
      // もう一度確かめても、増やさない。人が中止した子タスクも作り直さない
      await service.checkPullRequests();
      await service.cancel(second);
      await service.checkPullRequests();
      expect(taskOf(service, id).reviewTasks).toHaveLength(2);
      expect(service.list().filter((t) => t.reviewOf)).toHaveLength(2);
      // 記録は再起動しても読める
      activity.close();
      const again = new SqliteActivityStore(dbPath);
      const restarted = makeService(again, [], { stepPullRequests: true }).service;
      expect(restarted.get(id)?.task.reviewTasks).toHaveLength(2);
      again.close();
    });

    it("子タスクの題は、長い親の題を文字の途中で切らずに 200 文字に収める（受け入れ条件 1）", () => {
      const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      for (const pad of [189, 190, 191, 192]) {
        const title = reviewTaskTitle(`${"a".repeat(pad)}😀${"b".repeat(20)}`, 7);
        expect(title.length, String(pad)).toBeLessThanOrEqual(200);
        expect(lone.test(title), String(pad)).toBe(false);
        expect(title.startsWith("[PR #7] a"), String(pad)).toBe(true);
        expect(title.endsWith("…"), String(pad)).toBe(true);
      }
      expect(reviewTaskTitle("決済API", 7)).toBe("[PR #7] 決済API");
    });

    it("PR を公開した後、子タスクを作る前に止まっても、再起動後の PR の確認で作る（受け入れ条件 1）", async () => {
      // 子タスクを作らない版で、要求要件の PR を承認待ちまで進める（作る前に止まった代わり）
      const pulls = new FakePulls();
      const made = await start([out("# 要求要件 v1")], { pulls });
      const { id } = made;
      expect(taskOf(made.service, id).reviewTasks).toBeUndefined();
      made.activity.close();
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [], {
        stepPullRequests: true,
        pulls: new FakePulls(),
        now: later,
        reviewTasks: true,
      });
      await service.checkPullRequests();
      await service.checkPullRequests();
      expect(taskOf(service, id).reviewTasks?.map((r) => r.number)).toEqual([7]);
      expect(service.list().filter((t) => t.reviewOf?.taskId === id)).toHaveLength(1);
      activity.close();
    });

    it("子タスクを作った後、親に記録する前に止まっていたら、作り直さずに記録だけ足す", async () => {
      const pulls = new FakePulls();
      const made = await start([out("# 要求要件 v1")], { pulls });
      const { id } = made;
      // 子タスクの作成だけが台帳にある（親の ReviewTaskCreated は無い）
      const childId = randomUUID();
      made.activity.append({
        taskId: childId,
        projectId: "default",
        events: [
          {
            actor: "sacty",
            event: {
              type: "TaskCreated",
              payload: {
                title: "[PR #7] 決済API",
                body: "",
                start: "github_pull_request",
                budgetCapUsd: 1,
                source: {
                  kind: "github_pull_request",
                  repo: "https://github.com/acme/app",
                  number: 7,
                  url: "https://github.com/acme/app/pull/7",
                  review: "sacty",
                },
                reviewOf: { taskId: id, step: "requirements" },
              },
            },
          },
        ],
      });
      made.activity.close();
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [], {
        stepPullRequests: true,
        now: later,
        reviewTasks: true,
      });
      await service.checkPullRequests();
      expect(taskOf(service, id).reviewTasks?.map((r) => r.taskId)).toEqual([childId]);
      expect(service.list().filter((t) => t.reviewOf)).toHaveLength(1);
      activity.close();
    });

    it("以前の版の記録（ラベルの予定・付けた記録・ラベルから取り込んだレビューのタスク）は読め、終わっていないレビューのタスクがあれば二重に作らない（受け入れ条件 5）", async () => {
      const pulls = new FakePulls();
      const made = await start([out("# 要求要件 v1")], { pulls });
      const { id } = made;
      // 以前の版が書いた、ラベルを付けた記録と、ラベルから取り込んだレビューのタスク
      made.activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "sacty",
            event: {
              type: "PullRequestLabeled",
              payload: { repo: "https://github.com/acme/app", number: 7, label: "sacty-review" },
            },
          },
        ],
      });
      const oldId = randomUUID();
      made.activity.append({
        taskId: oldId,
        projectId: "default",
        events: [
          {
            actor: "sacty",
            event: {
              type: "TaskCreated",
              payload: {
                title: "PR 7",
                body: "本文",
                start: "github_pull_request",
                budgetCapUsd: 1,
                source: {
                  kind: "github_pull_request",
                  repo: "https://github.com/acme/app",
                  number: 7,
                  url: "https://github.com/acme/app/pull/7",
                  review: "sacty",
                },
              },
            },
          },
        ],
      });
      made.activity.close();
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [], {
        stepPullRequests: true,
        pulls: new FakePulls(),
        now: later,
        reviewTasks: true,
      });
      expect(taskOf(service, id).pullRequestLabels?.map((l) => l.number)).toEqual([7]);
      await service.checkPullRequests();
      expect(taskOf(service, id).reviewTasks).toBeUndefined();
      expect(service.list().filter((t) => t.reviewOf)).toEqual([]);
      // ラベルが付いたままの sacty の PR も、取り込まない
      expect(service.importIssues([labeledPr(7)])).toEqual([]);
      activity.close();
    });

    it("sacty が作った PR は、レビュー用のラベル・取り込むラベル・レビューの依頼のどれでも取り込まない。sacty が作っていない PR のレビュー用のラベルは、今までどおりレビューのタスク（受け入れ条件 5）", async () => {
      const { activity, service } = await start([out("# 要求要件 v1")], {
        settings: new MemorySettingsStore({ intakeLabel: "sacty", reviewLabel: "sacty" }),
      });
      expect(
        service.importIssues([
          labeledPr(7),
          labeledPr(7, ["sacty"]),
          { ...labeledPr(7, []), review: "requested" as const, requestedFor: "me" },
        ]),
      ).toEqual([]);
      const [other] = service.importIssues([labeledPr(41, ["sacty"])]);
      expect(other?.source).toMatchObject({ number: 41, review: "label" });
      expect(other?.reviewOf).toBeUndefined();
      activity.close();
    });

    describe("手動で作ったレビューのタスク（本文に PR の URL。source 無し）", () => {
      const MANUAL = "PR 7 のレビュー";
      const INVESTIGATE = "PR 7 の調査";
      /** 手動のタスクにはレビューの工程だけを選び、元のタスクには MVP の工程を選ぶ。 */
      const planner: ServiceDeps["planner"] = async (task) => ({
        ...(task.title === MANUAL
          ? { steps: ["review"], plan: "review" as const }
          : task.title === INVESTIGATE
            ? { steps: ["investigate"], plan: "investigate" as const }
            : { steps: [...MVP_STEPS] }),
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      });
      const verdictOf = (verdict: string) =>
        `# 評価\n\n受け入れ条件が足りない\n\n${block({ "sacty-review-verdict": { verdict } })}`;

      it("判定に指摘のある回（修正が必要・提案あり・読めない）は元のタスクの PR の指摘として取り込み、指摘なしの回は取り込まない", async () => {
        const cases: { name: string; review: string; imported: boolean }[] = [
          { name: "修正が必要", review: verdictOf("changes_required"), imported: true },
          { name: "提案あり", review: verdictOf("suggestions"), imported: true },
          { name: "評価なし", review: "# 評価\n\n直す点がある", imported: true },
          { name: "指摘なし", review: verdictOf("no_findings"), imported: false },
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
            { pulls, planner },
          );
          const { activity, service, executor, id } = made;
          const manual = service.createTask({
            projectId: "default",
            title: MANUAL,
            body: "https://github.com/acme/app/pull/7 をレビューする",
          });
          expect(taskOf(service, manual.id).source, c.name).toBeUndefined();
          await service.runNext(manual.id);
          await service.runNext(manual.id);
          expect(
            pulls.reviews.map((r) => r.number),
            c.name,
          ).toEqual([7]);
          expect(pulls.reviews[0]?.body, c.name).toContain(`<!-- sacty-review:${manual.id} -->`);
          pulls.feedbackBy[7] = [
            item("review:50", { kind: "review", author: "me", body: pulls.reviews[0]?.body ?? "" }),
          ];
          const before = executor.calls.length;
          await service.checkPullRequests();
          const task = taskOf(service, id);
          if (c.imported) {
            expect(pulls.feedbackSactyReviews.at(-1), c.name).toEqual([manual.id]);
            expect(task.importedFeedback, c.name).toEqual(["review:50"]);
            expect(task.remarks.at(-1)?.text, c.name).toContain(
              c.name === "評価なし" ? "直す点がある" : "受け入れ条件が足りない",
            );
            // ゴールガーディアンが戻し先を判断し、差し戻す
            expect(types(service, id), c.name).toContain("ReworkJudged");
            expect(task.status, c.name).toBe("queued");
            // 二重に取り込まない
            await service.checkPullRequests();
            expect(
              types(service, id).filter((t) => t === "PullRequestReviewImported"),
              c.name,
            ).toHaveLength(1);
          } else {
            expect(pulls.feedbackSactyReviews.at(-1), c.name).toBeUndefined();
            expect(task.importedFeedback, c.name).toEqual([]);
            expect(executor.calls.length, c.name).toBe(before);
            expect(task.status, c.name).toBe("awaiting_approval");
          }
          activity.close();
        }
      });

      it("判定の記録が無い回（PR を参照するだけで、レビューの工程を持たないタスク）は取り込まない", async () => {
        const pulls = new FakePulls();
        pulls.prInfo = { ...pulls.prInfo, number: 7, url: "https://github.com/acme/app/pull/7" };
        const made = await start([out("# 要求要件 v1"), out("# 調査")], { pulls, planner });
        const { activity, service, id } = made;
        // レビューの工程を持たないタスクが、PR を参照する（工程を実行した）
        const other = service.createTask({
          projectId: "default",
          title: INVESTIGATE,
          body: "https://github.com/acme/app/pull/7 と同じ直し方をする",
        });
        await service.runNext(other.id);
        expect(taskOf(service, other.id).steps.map((s) => s.key)).toEqual(["investigate"]);
        pulls.feedbackBy[7] = [
          item("review:50", {
            kind: "review",
            author: "me",
            body: `<!-- sacty-review:${other.id} -->\n## sacty のレビュー\n\n直す点がある`,
          }),
        ];
        await service.checkPullRequests();
        expect(pulls.feedbackSactyRounds.at(-1)).toEqual([
          { key: other.id, account: "me", allowed: false },
        ]);
        expect(taskOf(service, id).importedFeedback).toEqual([]);
        expect(taskOf(service, id).status).toBe("awaiting_approval");
        activity.close();
      });

      it("再レビューも回ごとに判定する（指摘なしの1回目は取り込まず、修正が必要の2回目は取り込む）", async () => {
        const pulls = new FakePulls();
        pulls.prInfo = { ...pulls.prInfo, number: 7, url: "https://github.com/acme/app/pull/7" };
        const made = await start(
          [
            out("# 要求要件 v1"),
            out(verdictOf("no_findings")),
            out(verdictOf("changes_required")),
            rework("requirements", "要求要件で直せる"),
          ],
          { pulls, planner },
        );
        const { activity, service, id } = made;
        const manual = service.createTask({
          projectId: "default",
          title: MANUAL,
          body: "https://github.com/acme/app/pull/7 をレビューする",
        });
        await service.runNext(manual.id);
        await service.runNext(manual.id);
        const posted = (n: number) =>
          item(`review:${50 + n}`, {
            kind: "review",
            author: "me",
            body: pulls.reviews[n]?.body ?? "",
          });
        pulls.feedbackBy[7] = [posted(0)];
        await service.checkPullRequests();
        expect(taskOf(service, id).importedFeedback).toEqual([]);
        service.rereview(manual.id);
        await service.runNext(manual.id);
        await service.runNext(manual.id);
        expect(pulls.reviews).toHaveLength(2);
        pulls.feedbackBy[7] = [posted(0), posted(1)];
        await service.checkPullRequests();
        expect(pulls.feedbackSactyRounds.at(-1)).toEqual([
          { key: manual.id, account: "me", allowed: false },
          { key: `${manual.id}:2`, account: "me", allowed: true },
        ]);
        expect(taskOf(service, id).importedFeedback).toEqual(["review:51"]);
        activity.close();
      });

      it("投稿したアカウントが、そのタスクのアカウントと違えば、目印があっても取り込まない", async () => {
        // 元のタスクのプロジェクト（parent）。PR を作った後に Org の担当に変え、リポジトリを担当するプロジェクト（reviewer）を足す
        const projects = new MemoryProjectStore();
        projects.put("default", {
          name: "元",
          targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
          githubAccounts: { "github.com": "parent" },
        });
        const pulls = new FakePulls();
        pulls.prInfo = { ...pulls.prInfo, number: 7, url: "https://github.com/acme/app/pull/7" };
        const made = await start([out("# 要求要件 v1"), out(verdictOf("changes_required"))], {
          pulls,
          projects,
          planner,
          github: new FakeGitHub({ parent: "ghp_parent", reviewer: "ghp_reviewer" }),
        });
        const { activity, service, id } = made;
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
        const manual = service.createTask({
          projectId: "app",
          title: MANUAL,
          body: "https://github.com/acme/app/pull/7 をレビューする",
        });
        await service.runNext(manual.id);
        await service.runNext(manual.id);
        expect(pulls.reviews[0]?.token).toBe("ghp_reviewer");
        // 同じ目印の本文を、そのタスクのアカウント（reviewer）ではなく、元のタスクのアカウント（parent）が投稿した
        pulls.feedbackBy[7] = [
          item("review:50", {
            kind: "review",
            author: "parent",
            body: pulls.reviews[0]?.body ?? "",
          }),
        ];
        await service.checkPullRequests();
        expect(pulls.feedbackSactyRounds.at(-1)).toEqual([
          { key: manual.id, account: "reviewer", allowed: true },
        ]);
        expect(taskOf(service, id).importedFeedback).toEqual([]);
        expect(types(service, id)).not.toContain("PullRequestReviewImported");
        // そのタスクのアカウントが投稿したものは取り込む
        pulls.feedbackBy[7] = [
          ...(pulls.feedbackBy[7] ?? []),
          item("review:51", {
            kind: "review",
            author: "reviewer",
            body: pulls.reviews[0]?.body ?? "",
          }),
        ];
        await service.checkPullRequests();
        expect(taskOf(service, id).importedFeedback).toEqual(["review:51"]);
        activity.close();
      });
    });
  });
});
