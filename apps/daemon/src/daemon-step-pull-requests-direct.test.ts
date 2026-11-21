import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { StepKey, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { TaskService } from "./service.js";
import { dbPath, dir, FakePulls, FakeRepos, makeService, useTempDir } from "./testing/daemon.js";
import { waitFor } from "./testing/wait.js";

useTempDir();

/** 実装の無い進め方では、要求要件・設計の PR をタスクブランチを作らずにベースブランチへ直接出す（PBI-464）。 */
describe("実装の無い進め方の工程の PR（ベースブランチへの直接のフロー。PBI-464）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const design = (title = "# 設計") =>
    out(
      [
        title,
        block({
          "sacty-test-viewpoints": [{ title: "再送", input: "同じキーで2回", expected: "1回" }],
        }),
      ].join("\n\n"),
    );
  const rework = (target: string) =>
    out(block({ "sacty-rework": { target, reason: "前提が違う" } }));
  /** 人の PR へのコメント（取り込むと、ゴールガーディアンが戻し先を判断する）。 */
  const comment = (key: string) => ({
    key,
    kind: "comment" as const,
    author: "reviewer",
    at,
    body: "そもそも前提が違う",
  });
  const at = "2026-10-11T00:00:00Z";
  const later = () => Date.parse(at) + 3 * 60_000;
  const taskOf = (svc: TaskService, id: string) => svc.get(id)?.task as Task;
  const types = (svc: TaskService, id: string) => svc.get(id)?.activity.map((e) => e.type) ?? [];
  const payloads = (svc: TaskService, id: string, type: string) =>
    (svc.get(id)?.activity ?? []).filter((e) => e.type === type).map((e) => e.payload);
  const prefixOf = (id: string) => `sacty/task-${id.slice(0, 8)}`;
  const docOf = (id: string, step: string) => `docs/sacty/${id.slice(0, 8)}/${step}.md`;
  const HUMAN = "9".repeat(40);

  async function start(
    outcomes: AgentOutcome[],
    options: { steps?: StepKey[]; repos?: FakeRepos; pulls?: FakePulls } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = options.pulls ?? new FakePulls();
    const repos = options.repos ?? new FakeRepos();
    const made = makeService(activity, outcomes, {
      stepPullRequests: true,
      now: later,
      pulls,
      repos,
      planner: async () => ({
        steps: [...(options.steps ?? (["requirements", "design"] as StepKey[]))],
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
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
  type Made = Awaited<ReturnType<typeof start>>;

  const prOf = (made: Made, step: string) =>
    taskOf(made.service, made.id).stepPullRequests.findLast((p) => p.step === step);

  /** 工程の PR を GitHub でマージしたことにする（ベースブランチは、マージのコミットに進む）。 */
  async function merge(made: Made, step: string, edited?: string) {
    const pr = prOf(made, step);
    if (!pr) throw new Error(`no pull request for ${step}`);
    const mergeCommit = `m${pr.number}`.padEnd(40, "0");
    made.pulls.states[pr.number] = {
      state: "merged",
      mergedBy: "reviewer",
      headSha: edited ? `e${pr.number}`.padEnd(40, "0") : pr.commit,
      mergeCommit,
    };
    if (edited) made.repos.files[mergeCommit] = { [pr.path]: edited };
    made.repos.remote.main = mergeCommit;
    await made.service.checkPullRequests();
    return mergeCommit;
  }
  async function close(made: Made, step: string) {
    const pr = prOf(made, step);
    if (!pr) throw new Error(`no pull request for ${step}`);
    made.pulls.states[pr.number] = { state: "closed" };
    await made.service.checkPullRequests();
  }
  const sendBack = (made: Made, step: "requirements" | "design") => {
    const task = taskOf(made.service, made.id);
    made.service.requestChanges(made.id, {
      step,
      submission: task.submissions[step] ?? 1,
      comments: ["直す"],
    });
  };
  /** 設計の PR（#8）の承認待ちまで進める。 */
  async function toDesign(outcomes: AgentOutcome[] = []) {
    const made = await start([out("# 要求要件"), design(), ...outcomes]);
    await merge(made, "requirements");
    await made.service.runNext(made.id);
    expect(taskOf(made.service, made.id).gate?.step).toBe("design");
    return made;
  }
  /** fetchBranch を、ブランチごとに失敗させる。 */
  function failFetch(repos: FakeRepos, fail: (branch: string) => string | undefined) {
    const original = FakeRepos.prototype.fetchBranch.bind(repos);
    repos.fetchBranch = async (gitDir, branch, authEnv, signal) => {
      const reason = fail(branch);
      if (reason) throw new Error(reason);
      return original(gitDir, branch, authEnv, signal);
    };
  }
  const MISSING = "fatal: couldn't find remote ref refs/heads/x";
  const withoutExpected = (repos: FakeRepos, branch: string) =>
    repos.deleteCalls.filter((c) => c.branch === branch && c.expectedHead === undefined);
  const calls = (repos: FakeRepos, branch: string) =>
    repos.deleteCalls.filter((c) => c.branch === branch);

  it("TV-1: 実装の無い進め方の要求要件の PR は、タスクブランチを作らず、ベースブランチの先頭から作った工程のブランチで、ベースブランチへ向ける", async () => {
    const made = await start([out("# 要求要件")]);
    const { service, repos, pulls, id } = made;
    expect(types(service, id)).not.toContain("TaskBranchCreated");
    expect(taskOf(service, id).taskBranch).toBeUndefined();
    expect(repos.committedFiles[0]).toMatchObject({
      parent: repos.branchHead,
      branch: `${prefixOf(id)}-requirements-1`,
    });
    // タスクブランチへの push は無い（工程のブランチだけ）
    expect(repos.pushedCommits.map((p) => p.branch)).toEqual([`${prefixOf(id)}-requirements-1`]);
    expect(repos.fetchedBranches.map((f) => f.branch)).toContain("main");
    expect(pulls.calls[0]).toMatchObject({
      branch: `${prefixOf(id)}-requirements-1`,
      baseBranch: "main",
    });
    expect(taskOf(service, id).gate).toEqual({ step: "requirements", submission: 1 });
    made.activity.close();
  });

  it("TV-2: 要求要件の PR のマージが承認になり、設計の PR はマージを取り込んだベースブランチの最新から作り、ベースブランチへ向ける", async () => {
    const made = await start([out("# 要求要件"), design()]);
    const { service, repos, pulls, id } = made;
    const mergeCommit = await merge(made, "requirements");
    expect(payloads(service, id, "StepApproved")).toEqual([
      { step: "requirements", next: "queued" },
    ]);
    await service.runNext(id);
    expect(repos.committedFiles[1]).toMatchObject({
      parent: mergeCommit,
      branch: `${prefixOf(id)}-design-1`,
    });
    expect(pulls.calls[1]).toMatchObject({ baseBranch: "main" });
    expect(types(service, id)).not.toContain("TaskBranchCreated");
    made.activity.close();
  });

  it("TV-3: 最後の工程の PR を人が直してマージすると、承認して完了し、承認済みの成果はベースブランチを取得して読んだ人の版になる", async () => {
    const made = await toDesign();
    const { service, repos, id } = made;
    const workspace = join(dir, "workspaces", id);
    const mergeCommit = await merge(made, "design", "# 設計（人が直した）\n");
    const task = taskOf(service, id);
    expect(task.approved.design?.output).toBe("# 設計（人が直した）");
    expect(task.approved.design?.edited).toMatchObject({ sacty: "# 設計" });
    expect(repos.readCalls.at(-1)).toMatchObject({
      commit: mergeCommit,
      path: docOf(id, "design"),
    });
    // タスクブランチではなく、ベースブランチを取得して読む
    expect(repos.fetchedBranches.at(-1)?.branch).toBe("main");
    expect(task.status).toBe("idle");
    expect(task.steps.map((s) => s.state)).toEqual(["done", "done"]);
    await waitFor(() => !existsSync(workspace), { what: "作業領域の片付け" });
    made.activity.close();
  });

  it("TV-4: ほかの人のマージでベースブランチが進んでも、開いている工程の PR は作り直さず、同じ PR のブランチに積む", async () => {
    const made = await toDesign([design("# 設計 v2")]);
    const { service, repos, pulls, id } = made;
    const before = prOf(made, "design");
    repos.remote.main = "f".repeat(40);
    sendBack(made, "design");
    await service.runNext(id);
    const after = taskOf(service, id).stepPullRequests.filter((p) => p.step === "design");
    expect(after).toHaveLength(1);
    expect(after[0]?.number).toBe(before?.number);
    expect(after[0]?.branch).toBe(before?.branch);
    expect(after[0]?.commit).not.toBe(before?.commit);
    expect(pulls.closed).toEqual([]);
    expect(pulls.calls.at(-1)?.number).toBe(before?.number);
    expect(repos.committedFiles.at(-1)).toMatchObject({ branch: before?.branch });
    made.activity.close();
  });

  /** 設計の PR（#8）が開いている間に要求要件へ戻り、要求要件の新しい PR（#9）がマージされるまで進める。 */
  async function backToRequirements() {
    const made = await start([
      out("# 要求要件"),
      design(),
      rework("requirements"),
      out("# 要求要件 v2"),
      design("# 設計 v2"),
    ]);
    await merge(made, "requirements");
    await made.service.runNext(made.id);
    const first = prOf(made, "design");
    made.pulls.feedbackBy[first?.number ?? 0] = [comment("comment:20")];
    await made.service.checkPullRequests();
    await made.service.runNext(made.id);
    expect(taskOf(made.service, made.id).gate?.step).toBe("requirements");
    const mergeCommit = await merge(made, "requirements");
    return { made, first, mergeCommit };
  }

  it("TV-5: 前の工程の PR が後からマージされたら、前の設計の PR を閉じ、そのマージを含むベースブランチの最新から、回を進めたブランチで作り直す", async () => {
    const { made, first, mergeCommit } = await backToRequirements();
    const { service, repos, pulls, id } = made;
    await service.runNext(id);
    expect(pulls.closed.map((c) => c.number)).toContain(first?.number);
    const designs = taskOf(service, id).stepPullRequests.filter((p) => p.step === "design");
    expect(designs.map((p) => p.branch)).toEqual([
      `${prefixOf(id)}-design-1`,
      `${prefixOf(id)}-design-2`,
    ]);
    expect(repos.committedFiles.at(-1)).toMatchObject({
      parent: mergeCommit,
      branch: `${prefixOf(id)}-design-2`,
    });
    expect(pulls.calls.at(-1)).toMatchObject({ baseBranch: "main" });
    made.activity.close();
  });

  it("TV-6: 閉じられた工程の PR は、ベースブランチの最新を親にした新しいブランチから、ベースブランチへ作り直す", async () => {
    const made = await toDesign([design("# 設計 v2")]);
    const { service, repos, pulls, id } = made;
    await close(made, "design");
    repos.remote.main = "a".repeat(40);
    sendBack(made, "design");
    await service.runNext(id);
    expect(repos.committedFiles.at(-1)).toMatchObject({
      parent: "a".repeat(40),
      branch: `${prefixOf(id)}-design-2`,
    });
    expect(pulls.calls.at(-1)).toMatchObject({
      branch: `${prefixOf(id)}-design-2`,
      baseBranch: "main",
    });
    made.activity.close();
  });

  describe("工程のブランチの削除", () => {
    it("TV-7: PR の確認がマージを見つけたら、人がコミットを足していても、その PR のブランチを先頭を比べずに消す", async () => {
      const made = await start([out("# 要求要件"), design()]);
      const branch = prOf(made, "requirements")?.branch ?? "";
      made.repos.remote[branch] = HUMAN;
      await merge(made, "requirements", "# 人の要求要件");
      expect(withoutExpected(made.repos, branch)).toHaveLength(1);
      expect(made.repos.deleted).toContain(branch);
      expect(types(made.service, made.id)).not.toContain("StepBranchKept");
      made.activity.close();
    });

    it("TV-7: 直しの間に工程の PR がマージされたら、人がコミットを足していても、その PR のブランチを先頭を比べずに消す", async () => {
      const rework2 = await toDesign([design("# 設計 v2")]);
      const designBranch = prOf(rework2, "design")?.branch ?? "";
      rework2.repos.remote[designBranch] = HUMAN;
      sendBack(rework2, "design");
      const pr = prOf(rework2, "design");
      rework2.pulls.states[pr?.number ?? 0] = {
        state: "merged",
        mergedBy: "reviewer",
        headSha: HUMAN,
        mergeCommit: "b".repeat(40),
      };
      rework2.repos.files["b".repeat(40)] = { [pr?.path ?? ""]: "# 人の設計" };
      await rework2.service.checkPullRequests();
      await rework2.service.runNext(rework2.id);
      expect(types(rework2.service, rework2.id)).toContain("ReworkStoppedByMerge");
      expect(withoutExpected(rework2.repos, designBranch).length).toBeGreaterThan(0);
      rework2.activity.close();
    });

    it("TV-8: 人がクローズした PR のブランチは、先頭が sacty の最後の push と同じときだけ、その先頭を期待して消し、StepBranchKept は記録しない", async () => {
      const made = await start([out("# 要求要件")]);
      const pr = prOf(made, "requirements");
      await close(made, "requirements");
      expect(calls(made.repos, pr?.branch ?? "")).toEqual([
        { branch: pr?.branch, expectedHead: pr?.commit },
      ]);
      expect(types(made.service, made.id)).not.toContain("StepBranchKept");
      made.activity.close();
    });

    it("TV-9: 人がコミットを足してクローズした PR のブランチは、消さずに残して StepBranchKept に記録する", async () => {
      const made = await start([out("# 要求要件")]);
      const pr = prOf(made, "requirements");
      made.repos.remote[pr?.branch ?? ""] = HUMAN;
      await close(made, "requirements");
      expect(made.repos.deleteCalls).toEqual([]);
      expect(payloads(made.service, made.id, "StepBranchKept")).toEqual([
        { branch: pr?.branch, head: HUMAN, pushed: pr?.commit },
      ]);
      made.activity.close();
    });

    it("TV-10: クローズのときに先頭を取得できなければ消さず記録もせず、完了のときに比べ直して消す", async () => {
      const made = await start([out("# 要求要件"), out("# 要求要件 v2"), design()]);
      const { service, repos, id } = made;
      const pr = prOf(made, "requirements");
      let down = true;
      failFetch(repos, (b) => (down && b === pr?.branch ? "network down" : undefined));
      await close(made, "requirements");
      expect(repos.deleteCalls).toEqual([]);
      expect(types(service, id)).not.toContain("StepBranchKept");
      down = false;
      sendBack(made, "requirements");
      await service.runNext(id);
      await merge(made, "requirements");
      await service.runNext(id);
      await merge(made, "design");
      await waitFor(() => calls(repos, pr?.branch ?? "").length > 0, { what: "完了のときの削除" });
      expect(calls(repos, pr?.branch ?? "")).toEqual([
        { branch: pr?.branch, expectedHead: pr?.commit },
      ]);
      expect(types(service, id)).not.toContain("StepBranchKept");
      made.activity.close();
    });

    it("TV-11: 作り直しで sacty が閉じた前の PR のブランチは、人がコミットを足していても、先頭を比べずに消す", async () => {
      const { made, first } = await backToRequirements();
      const { service, repos, pulls, id } = made;
      repos.remote[first?.branch ?? ""] = HUMAN;
      await service.runNext(id);
      expect(pulls.closed.map((c) => c.number)).toContain(first?.number);
      expect(withoutExpected(repos, first?.branch ?? "")).toHaveLength(1);
      expect(types(service, id)).not.toContain("StepBranchKept");
      made.activity.close();
    });

    it("TV-12: 作り直しで見つけた、人がすでに閉じていた PR のブランチは、先頭を比べ、違えば消さずに StepBranchKept に記録する", async () => {
      const made = await toDesign([design("# 設計 v2")]);
      const { service, repos, pulls, id } = made;
      const first = prOf(made, "design");
      sendBack(made, "design");
      // 直しが走る間に、人がブランチにコミットを足して PR を閉じた
      repos.remote[first?.branch ?? ""] = HUMAN;
      pulls.states[first?.number ?? 0] = { state: "closed" };
      await service.runNext(id);
      expect(calls(repos, first?.branch ?? "")).toEqual([]);
      expect(payloads(service, id, "StepBranchKept")).toEqual([
        { branch: first?.branch, head: HUMAN, pushed: first?.commit },
      ]);
      made.activity.close();
    });

    it("TV-13: 人のコミットに sacty が積んだブランチは、先頭が同じでも消さない（クローズでも完了でも）", async () => {
      const made = await toDesign([design("# 設計 v2"), design("# 設計 v3")]);
      const { service, repos, id } = made;
      const first = prOf(made, "design");
      repos.remote[first?.branch ?? ""] = HUMAN;
      sendBack(made, "design");
      await service.runNext(id);
      expect(payloads(service, id, "StepBranchKept")).toEqual([
        { branch: first?.branch, head: HUMAN, pushed: first?.commit },
      ]);
      // 積んだ後に、人が何も足さずに閉じる
      await close(made, "design");
      expect(calls(repos, first?.branch ?? "")).toEqual([]);
      sendBack(made, "design");
      await service.runNext(id);
      await merge(made, "design");
      await waitFor(() => !existsSync(join(dir, "workspaces", id)), { what: "完了の片付け" });
      expect(calls(repos, first?.branch ?? "")).toEqual([]);
      made.activity.close();
    });

    it("TV-14: StepBranchKept を記録したブランチも、その PR がマージされたら、先頭を比べずに消す", async () => {
      const made = await toDesign([design("# 設計 v2")]);
      const { service, repos, id } = made;
      const first = prOf(made, "design");
      repos.remote[first?.branch ?? ""] = HUMAN;
      sendBack(made, "design");
      await service.runNext(id);
      expect(payloads(service, id, "StepBranchKept")).toHaveLength(1);
      expect(withoutExpected(repos, first?.branch ?? "")).toHaveLength(0);
      await merge(made, "design");
      expect(withoutExpected(repos, first?.branch ?? "").length).toBeGreaterThan(0);
      expect(taskOf(service, id).stepBranchesKept?.[first?.branch ?? ""]).toBeDefined();
      made.activity.close();
    });

    it("TV-15: 比べた後に人が push したら、取得した先頭を期待して消そうとして断られ、ブランチはリモートに残る", async () => {
      const made = await start([out("# 要求要件")]);
      const { repos } = made;
      const pr = prOf(made, "requirements");
      repos.deleteLeaseCheck = true;
      const original = repos.deleteBranch.bind(repos);
      repos.deleteBranch = async (gitDir, branch, authEnv, expectedHead) => {
        // 取得の後、削除の前に、人が push する
        repos.remote[branch] = HUMAN;
        return original(gitDir, branch, authEnv, expectedHead);
      };
      await close(made, "requirements");
      expect(repos.deleteCalls).toEqual([{ branch: pr?.branch, expectedHead: pr?.commit }]);
      expect(repos.deleted).toEqual([]);
      expect(repos.remote[pr?.branch ?? ""]).toBe(HUMAN);
      made.activity.close();
    });

    it("TV-16: 完了したとき、削除に失敗して残ったマージ済みのブランチを作業領域を消す前に比べずに消し、残したブランチは消さない", async () => {
      const made = await start([out("# 要求要件 v1"), out("# 要求要件 v2"), design()]);
      const { service, repos, id } = made;
      const first = prOf(made, "requirements");
      // 人がコミットを足して閉じた PR は、残す
      repos.remote[first?.branch ?? ""] = HUMAN;
      await close(made, "requirements");
      sendBack(made, "requirements");
      await service.runNext(id);
      const second = prOf(made, "requirements");
      // マージ後の削除に失敗する
      repos.deleteFail = "remote rejected";
      await merge(made, "requirements");
      expect(repos.deleted).toEqual([]);
      repos.deleteFail = undefined;
      await service.runNext(id);
      await merge(made, "design");
      await waitFor(() => !existsSync(join(dir, "workspaces", id)), { what: "完了の片付け" });
      expect(withoutExpected(repos, second?.branch ?? "")).not.toHaveLength(0);
      expect(repos.deleted).toContain(second?.branch);
      expect(calls(repos, first?.branch ?? "")).toEqual([]);
      expect(payloads(service, id, "StepBranchKept")).toHaveLength(1);
      made.activity.close();
    });

    it("TV-17: ブランチを消せなくても、完了は止まらず、作業領域は消され、一時停止は記録されない", async () => {
      const made = await toDesign();
      const { service, repos, id } = made;
      repos.deleteFail = "remote rejected";
      await merge(made, "design");
      await waitFor(() => !existsSync(join(dir, "workspaces", id)), { what: "完了の片付け" });
      expect(repos.deleteCalls.length).toBeGreaterThan(0);
      expect(taskOf(service, id).status).toBe("idle");
      expect(types(service, id)).not.toContain("TaskPaused");
      made.activity.close();
    });

    it("TV-18: 直接の流れのタスクを中止すると、開いていた PR の工程のブランチとリモートに無いブランチを消し、残したブランチ・タスクブランチ・ベースブランチは消さない", async () => {
      const made = await start([out("# 要求要件 v1"), out("# 要求要件 v2"), out("# 要求要件 v3")]);
      const { service, repos, id } = made;
      const first = prOf(made, "requirements");
      // 1つめ：人がコミットを足して閉じた（残す）
      repos.remote[first?.branch ?? ""] = HUMAN;
      await close(made, "requirements");
      // 2つめ：人が閉じたが、そのときは取得できず、あとで GitHub がブランチを消した
      sendBack(made, "requirements");
      await service.runNext(id);
      const second = prOf(made, "requirements");
      failFetch(repos, (b) => (b === second?.branch ? "network down" : undefined));
      await close(made, "requirements");
      expect(repos.deleteCalls).toEqual([]);
      // 3つめ：開いている
      sendBack(made, "requirements");
      failFetch(repos, () => undefined);
      await service.runNext(id);
      const third = prOf(made, "requirements");
      failFetch(repos, (b) => (b === second?.branch ? MISSING : undefined));
      const cancelled = await service.cancel(id);
      const branches = (cancelled.cancelled?.cleanup ?? []).filter((c) => c.target === "branch");
      expect(branches).toEqual([
        { target: "branch", result: "done", detail: second?.branch },
        { target: "branch", result: "done", detail: third?.branch },
      ]);
      expect(repos.deleted).toEqual([third?.branch]);
      expect(repos.deleteCalls.map((c) => c.branch)).not.toContain(first?.branch);
      expect(repos.deleteCalls.map((c) => c.branch)).not.toContain(prefixOf(id));
      expect(repos.deleteCalls.map((c) => c.branch)).not.toContain("main");
      made.activity.close();
    });

    for (const change of [true, false]) {
      it(`TV-19: クローズのときに先頭を取得できなかったブランチは、中止のときに比べ、${change ? "違えば StepBranchKept に記録して消さない" : "また取得できなければ failed で記録して消さない"}`, async () => {
        const made = await start([out("# 要求要件")]);
        const { service, repos, id } = made;
        const pr = prOf(made, "requirements");
        repos.remote[pr?.branch ?? ""] = HUMAN;
        failFetch(repos, (b) => (b === pr?.branch ? "network down" : undefined));
        await close(made, "requirements");
        expect(types(service, id)).not.toContain("StepBranchKept");
        if (change) failFetch(repos, () => undefined);
        const cancelled = await service.cancel(id);
        expect(repos.deleteCalls).toEqual([]);
        const cleanup = (cancelled.cancelled?.cleanup ?? []).filter((c) => c.target === "branch");
        if (change) {
          expect(payloads(service, id, "StepBranchKept")).toEqual([
            { branch: pr?.branch, head: HUMAN, pushed: pr?.commit },
          ]);
          expect(cleanup.some((c) => c.result === "failed")).toBe(false);
        } else {
          expect(cleanup).toMatchObject([{ target: "branch", result: "failed" }]);
        }
        made.activity.close();
      });
    }
  });

  it("TV-21: 派生の記録に、マージした工程の PR の行ごとに、文書のパスが入る", async () => {
    const made = await toDesign();
    const { service, id } = made;
    await merge(made, "design");
    const derived = service.deriveTask(id, {
      title: "続き",
      body: "続きをする",
      repo: "https://github.com/acme/app",
    });
    const record = taskOf(service, derived.id).derivedFrom?.record ?? "";
    expect(record).toContain(`（文書：${docOf(id, "requirements")}）`);
    expect(record).toContain(`（文書：${docOf(id, "design")}）`);
    made.activity.close();
  });

  it("TV-22: 続きのタスクの作業領域は、設計のマージを含むベースブランチの先頭から用意され、前のタスクの文書がある", async () => {
    const made = await toDesign();
    const { service, repos, id } = made;
    const mergeCommit = await merge(made, "design");
    // 工程の PR は、ベースブランチへ向けて作ってマージした（文書はベースブランチに入る）
    expect(made.pulls.calls.every((c) => c.baseBranch === "main")).toBe(true);
    repos.branchHeads.main = mergeCommit;
    repos.head = mergeCommit;
    repos.files[mergeCommit] = { [docOf(id, "design")]: "# 設計" };
    const derived = service.deriveTask(id, {
      title: "続き",
      body: "続きをする",
      repo: "https://github.com/acme/app",
    });
    await service.runNext(derived.id);
    const next = taskOf(service, derived.id);
    expect(next.repository?.baseCommit).toBe(mergeCommit);
    expect(await repos.readFile("", next.repository?.baseCommit ?? "", docOf(id, "design"))).toBe(
      "# 設計",
    );
    made.activity.close();
  });

  it("TV-26: タスクブランチがすでにある実装の無いタスクは、今の流れのまま、タスクブランチへ向け、タスクブランチの先頭と比べ、完了のときにブランチを消さない", async () => {
    // 前の版が作ったタスクを、作業履歴から作る：タスクブランチと要求要件の PR があり、進め方に実装が無い
    const first = await start([out("# 要求要件")], {
      steps: ["requirements", "design", "implement"],
    });
    const { pulls, repos, id } = first;
    expect(taskOf(first.service, id).taskBranch?.branch).toBe(prefixOf(id));
    first.activity.close();
    const raw = new DatabaseSync(dbPath);
    // 前の版の作業履歴を作るために、追記専用の保護を外して進め方を書き換える（開き直すと、保護は作り直される）
    raw.exec("DROP TRIGGER activity_no_update");
    const chosen = raw
      .prepare("SELECT id, payload FROM activity WHERE type = 'StepsChosen'")
      .get() as {
      id: string;
      payload: string;
    };
    const payload = JSON.parse(chosen.payload) as { steps: string[] };
    payload.steps = payload.steps.filter((step) => step !== "implement");
    raw
      .prepare("UPDATE activity SET payload = ? WHERE id = ?")
      .run(JSON.stringify(payload), chosen.id);
    raw.close();
    const activity = new SqliteActivityStore(dbPath);
    const restarted = makeService(activity, [design()], {
      stepPullRequests: true,
      now: later,
      pulls,
      repos,
    });
    const made = { activity, ...restarted, id };
    const { service } = made;
    expect(taskOf(service, id).steps.some((s) => s.key === "implement")).toBe(false);
    expect(taskOf(service, id).taskBranch?.branch).toBe(prefixOf(id));
    const req = prOf(made, "requirements");
    pulls.states[req?.number ?? 0] = {
      state: "merged",
      mergedBy: "reviewer",
      headSha: req?.commit,
      mergeCommit: "c1".padEnd(40, "0"),
    };
    repos.remote[prefixOf(id)] = "c1".padEnd(40, "0");
    await service.checkPullRequests();
    await service.runNext(id);
    expect(repos.committedFiles.at(-1)).toMatchObject({
      parent: "c1".padEnd(40, "0"),
      branch: `${prefixOf(id)}-design-1`,
    });
    expect(pulls.calls.at(-1)).toMatchObject({ baseBranch: prefixOf(id) });
    const designPr = prOf(made, "design");
    expect(designPr?.base).toBe("c1".padEnd(40, "0"));
    pulls.states[designPr?.number ?? 0] = {
      state: "merged",
      mergedBy: "reviewer",
      headSha: designPr?.commit,
      mergeCommit: "c2".padEnd(40, "0"),
    };
    await service.checkPullRequests();
    expect(taskOf(service, id).status).toBe("idle");
    await waitFor(() => !existsSync(join(dir, "workspaces", id)), { what: "作業領域の片付け" });
    expect(repos.deleteCalls).toEqual([]);
    made.activity.close();
  });

  it("TV-25: 分割の親タスクは、タスクブランチを作らず、要求要件の PR をベースブランチへ向ける", async () => {
    const made = await start([out("# 親の要求要件")], {
      steps: ["requirements", "design", "split", "integrate"],
    });
    expect(types(made.service, made.id)).not.toContain("TaskBranchCreated");
    expect(made.pulls.calls[0]).toMatchObject({ baseBranch: "main" });
    made.activity.close();
  });
});
