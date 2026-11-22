import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { message, renderMessage, type StepKey, type Task } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import { MessageError } from "./errors.js";
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
    options: {
      steps?: StepKey[];
      repos?: FakeRepos;
      pulls?: FakePulls;
      containerMounts?: () => Promise<string[]>;
    } = {},
  ) {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = options.pulls ?? new FakePulls();
    const repos = options.repos ?? new FakeRepos();
    const made = makeService(activity, outcomes, {
      stepPullRequests: true,
      now: later,
      pulls,
      repos,
      ...(options.containerMounts ? { containerMounts: options.containerMounts } : {}),
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

    it("TV-15: 比べた後に人が push したら、取得した先頭を期待して消そうとして断られ、取得し直して先頭が違うので StepBranchKept を記録し、ブランチはリモートに残る（PBI-480 TV-11）", async () => {
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
      // 断られた後に、取得し直した
      expect(repos.fetchedBranches.filter((f) => f.branch === pr?.branch)).toHaveLength(2);
      expect(payloads(made.service, made.id, "StepBranchKept")).toEqual([
        { branch: pr?.branch, head: HUMAN, pushed: pr?.commit },
      ]);
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
      // 完了の片付けで全部消せたときは、消せなかったブランチの記録を足さない（PBI-480 TV-4）
      expect(types(service, id)).not.toContain("StepBranchesLeft");
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

    it("TV-17: 完了の片付けの中で、退避した git のメタデータが無くても、作業領域を用意し直さず、自分の完了を待たずに完了の片付けが終わる", async () => {
      const repos = new FakeRepos();
      let gitDirOf: string | undefined;
      let armed = false;
      const made = await start([out("# 要求要件"), design()], {
        repos,
        // 完了の片付けが作業領域を消す前に、マージを見つけたときの削除（失敗する）を待ってから、メタデータを消す
        containerMounts: async () => {
          if (armed && gitDirOf) {
            await waitFor(() => repos.deleteCalls.some((c) => c.branch.includes("-design-")), {
              what: "マージを見つけたときの削除",
            });
            rmSync(gitDirOf, { recursive: true, force: true });
          }
          return [];
        },
      });
      const { service, id } = made;
      await merge(made, "requirements");
      await service.runNext(id);
      gitDirOf = join(dir, "workspaces", "_git", `${id}.git`);
      expect(existsSync(gitDirOf)).toBe(true);
      const prepared = repos.prepared.length;
      repos.deleteFail = "remote rejected";
      armed = true;
      await merge(made, "design");
      await waitFor(() => !existsSync(join(dir, "workspaces", id)), { what: "完了の片付け" });
      await Promise.race([
        service.workspaceCleanupsSettled(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("片付けが止まった")), 5000)),
      ]);
      expect(repos.prepared).toHaveLength(prepared);
      expect(existsSync(gitDirOf)).toBe(false);
      // 判定できなかった結果（git のメタデータが無い）は、消せなかったブランチの記録に使わない
      expect(types(service, id)).not.toContain("StepBranchesLeft");
      expect(taskOf(service, id).status).toBe("idle");
      expect(types(service, id)).not.toContain("TaskPaused");
      made.activity.close();
    });

    it("TV-17: ブランチの先頭の取得が止まっても、時間切れで打ち切られ、PR の確認は戻り、消さず記録もしない", async () => {
      const made = await start([out("# 要求要件")]);
      const { service, repos, id } = made;
      const pr = prOf(made, "requirements");
      const timeout = AbortSignal.timeout.bind(AbortSignal);
      const timer = vi
        .spyOn(AbortSignal, "timeout")
        .mockImplementation((ms) => (ms === 120_000 ? AbortSignal.abort() : timeout(ms)));
      repos.onFetchBranch = (signal) =>
        new Promise<void>((_, reject) => {
          if (!signal) return; // 時間切れの信号が渡されなければ、ずっと止まる
          const stop = () => reject(new Error("時間切れのため中断"));
          if (signal.aborted) stop();
          else signal.addEventListener("abort", stop);
        });
      try {
        await Promise.race([
          close(made, "requirements"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("確認が止まった")), 5000)),
        ]);
        expect(timer).toHaveBeenCalledWith(120_000);
      } finally {
        timer.mockRestore();
      }
      expect(calls(repos, pr?.branch ?? "")).toEqual([]);
      expect(types(service, id)).not.toContain("StepBranchKept");
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

    /** 完了の片付けの再実行：消した作業領域の git のメタデータ（か、作業領域だけ）を置き直し、起動時の片付けを走らせる。 */
    async function rerunCleanup(made: Made, only: "gitDir" | "workspace" = "gitDir") {
      const root = join(dir, "workspaces");
      mkdirSync(only === "gitDir" ? join(root, "_git", `${made.id}.git`) : join(root, made.id), {
        recursive: true,
      });
      await made.service.cleanupWorkspacesAtStartup();
      await made.service.workspaceCleanupsSettled();
    }
    /**
     * 人がクローズした要求要件の PR（count 本）のブランチを、先頭を取得できないまま、最後の PR のマージで完了する。
     * 取得の失敗の理由は reason で変えられる。完了の片付けで、count 本のブランチが消せずに残る。
     */
    async function completeWithLeft(count: 1 | 2) {
      const made = await start([
        out("# 要求要件 v1"),
        out("# 要求要件 v2"),
        out("# 要求要件 v3"),
        design(),
      ]);
      const { service, repos, id } = made;
      const state = {
        reason: (b: string): string | undefined =>
          b.includes("-requirements-") ? "network down" : undefined,
      };
      failFetch(repos, (b) => state.reason(b));
      const left: string[] = [];
      for (let i = 0; i < count; i++) {
        left.push(prOf(made, "requirements")?.branch ?? "");
        await close(made, "requirements");
        sendBack(made, "requirements");
        await service.runNext(id);
      }
      await merge(made, "requirements");
      await service.runNext(id);
      const workspaceAtAppend: boolean[] = [];
      const append = made.activity.append.bind(made.activity);
      vi.spyOn(made.activity, "append").mockImplementation((entry) => {
        if (entry.events.some((event) => event.event.type === "StepBranchesLeft")) {
          workspaceAtAppend.push(existsSync(join(dir, "workspaces", id)));
        }
        return append(entry);
      });
      await merge(made, "design");
      await waitFor(() => !existsSync(join(dir, "workspaces", id)), {
        what: "完了の片付けの終わり",
      });
      await service.workspaceCleanupsSettled();
      return { made, left, state, workspaceAtAppend };
    }
    const leftEvents = (made: Made) => payloads(made.service, made.id, "StepBranchesLeft");
    const settleFinal = (made: Made) =>
      (
        made.service as unknown as {
          settleStepBranches(
            id: string,
            mode: "final",
          ): Promise<{ branch: string; result: string; detail?: unknown }[]>;
        }
      ).settleStepBranches(made.id, "final");

    it("PBI-480 TV-1: 中止で、記録の無いブランチの知らせが、画面の言語の文になる", async () => {
      const made = await start([out("# 要求要件")]);
      const { service, id } = made;
      const pr = prOf(made, "requirements");
      // 最後の push の記録が無い状態にする
      const live = (service as unknown as { tasks: Map<string, Task> }).tasks.get(id);
      if (!live) throw new Error("no task");
      live.stepBranchCommits = undefined;
      await close(made, "requirements");
      const cancelled = await service.cancel(id);
      const failed = (cancelled.cancelled?.cleanup ?? []).filter(
        (c) => c.target === "branch" && c.result === "failed",
      );
      expect(failed).toHaveLength(1);
      const detail = failed[0]?.detail ?? "";
      const en = renderMessage(detail, "en");
      expect(en).toContain(
        `Not deleting branch ${pr?.branch} because the commit sacty last pushed is not recorded.`,
      );
      expect(en).not.toContain("[object Object]");
      const ja = renderMessage(detail, "ja");
      expect(ja).toContain(`ブランチ ${pr?.branch} を消しません`);
      expect(ja).not.toContain("[object Object]");
      made.activity.close();
    });

    it("PBI-480 TV-2: 作業領域を用意できなかった知らせに、英語の画面で日本語が混ざらない", async () => {
      const made = await start([out("# 要求要件")]);
      const { service, repos, id } = made;
      // 作業領域はあるが、退避した git のメタデータが無く、用意し直しも失敗する
      rmSync(join(dir, "workspaces", "_git", `${id}.git`), { recursive: true, force: true });
      repos.recordedMissing = true;
      const commit = taskOf(service, id).repository?.baseCommit;
      if (!commit) throw new Error("no base commit");
      const reason = message("git.baseCommitMissing", { commit });
      const cancelled = await service.cancel(id);
      const failed = (cancelled.cancelled?.cleanup ?? []).filter(
        (c) => c.target === "branch" && c.result === "failed",
      );
      expect(failed).toHaveLength(1);
      const detail = failed[0]?.detail ?? "";
      const en = renderMessage(detail, "en");
      expect(en).toContain("Could not delete branch");
      expect(en).toContain("Could not prepare a workspace");
      expect(en).toContain(renderMessage(reason, "en"));
      expect(en).not.toMatch(/[぀-ヿ一-鿿]/);
      expect(en).not.toContain("[object Object]");
      const ja = renderMessage(detail, "ja");
      expect(ja).toContain("作業領域を用意できませんでした");
      expect(ja).toContain(renderMessage(reason, "ja"));
      expect(renderMessage(reason, "en")).not.toBe(renderMessage(reason, "ja"));
      made.activity.close();
    });

    it("PBI-480 TV-3: 完了で消せなかったブランチを、理由とともに StepBranchesLeft に 1 件記録し、作業領域は消え、タスクは完了のままにする", async () => {
      const { made, left, workspaceAtAppend } = await completeWithLeft(1);
      expect(workspaceAtAppend).toEqual([true]);
      const { service, id } = made;
      expect(leftEvents(made)).toEqual([
        { branches: [{ branch: left[0], detail: "network down" }] },
      ]);
      expect(taskOf(service, id).stepBranchesLeft).toEqual([
        { branch: left[0], detail: "network down" },
      ]);
      expect(existsSync(join(dir, "workspaces", id))).toBe(false);
      expect(taskOf(service, id).status).toBe("idle");
      expect(types(service, id)).not.toContain("TaskPaused");
      made.activity.close();
    });

    it("PBI-480 TV-5: 同じ結果の再実行では、重ねて記録しない", async () => {
      const { made } = await completeWithLeft(1);
      expect(leftEvents(made)).toHaveLength(1);
      const fetch = vi.spyOn(made.repos, "fetchBranch");
      await rerunCleanup(made);
      expect(fetch).toHaveBeenCalled();
      expect(leftEvents(made)).toHaveLength(1);
      made.activity.close();
    });

    it("PBI-480 TV-6: 再実行で結果が変われば、残りのブランチと新しい理由だけの記録で置き換える", async () => {
      const { made, left, state } = await completeWithLeft(2);
      expect(leftEvents(made)).toEqual([
        {
          branches: [
            { branch: left[0], detail: "network down" },
            { branch: left[1], detail: "network down" },
          ],
        },
      ]);
      state.reason = (b) => (b === left[0] ? MISSING : b === left[1] ? "disk full" : undefined);
      await rerunCleanup(made);
      expect(leftEvents(made)).toHaveLength(2);
      expect(leftEvents(made)[1]).toEqual({ branches: [{ branch: left[1], detail: "disk full" }] });
      expect(taskOf(made.service, made.id).stepBranchesLeft).toEqual([
        { branch: left[1], detail: "disk full" },
      ]);
      made.activity.close();
    });

    it("PBI-480 TV-7: 再実行で全部消せたら、空の記録で表示を消す", async () => {
      const { made, left, state } = await completeWithLeft(2);
      state.reason = () => undefined;
      await rerunCleanup(made);
      expect(leftEvents(made)).toHaveLength(2);
      expect(leftEvents(made)[1]).toEqual({ branches: [] });
      expect(taskOf(made.service, made.id).stepBranchesLeft).toBeUndefined();
      expect(made.repos.deleted).toEqual(expect.arrayContaining(left));
      made.activity.close();
    });

    it("PBI-480 TV-8: git のメタデータが無い再実行の結果は、記録に使わず、前の記録のままにする", async () => {
      const { made, left } = await completeWithLeft(1);
      const internal = made.service as unknown as {
        settleStepBranches: (...args: never[]) => Promise<{ detail?: unknown }[]>;
      };
      const settle = vi.spyOn(internal, "settleStepBranches");
      await rerunCleanup(made, "workspace");
      expect(settle).toHaveBeenCalled();
      const results = await settle.mock.results.at(-1)?.value;
      expect(results).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ detail: { code: "cleanup.stepBranchNoGitDir" } }),
        ]),
      );
      expect(leftEvents(made)).toHaveLength(1);
      expect(taskOf(made.service, made.id).stepBranchesLeft).toEqual([
        { branch: left[0], detail: "network down" },
      ]);
      made.activity.close();
    });

    it("PBI-480 TV-12: 断られた後に取得し直してリモートに無ければ、消せたものとし、記録は足さない", async () => {
      const made = await start([out("# 要求要件")]);
      const { repos } = made;
      const pr = prOf(made, "requirements");
      // 取得の後、削除の前に、リモートのブランチが消えた（取得し直すと無い）
      repos.deleteLeaseCheck = true;
      const seen: string[] = [];
      failFetch(repos, (b) => {
        seen.push(b);
        return seen.length >= 2 ? MISSING : undefined;
      });
      const original = repos.deleteBranch.bind(repos);
      repos.deleteBranch = async (gitDir, branch, authEnv, expectedHead) => {
        delete repos.remote[branch];
        return original(gitDir, branch, authEnv, expectedHead);
      };
      const results = await settleFinal(made);
      expect(results).toEqual([{ branch: pr?.branch, result: "deleted" }]);
      expect(calls(repos, pr?.branch ?? "")).toHaveLength(1);
      expect(types(made.service, made.id)).not.toContain("StepBranchKept");
      expect(types(made.service, made.id)).not.toContain("StepBranchesLeft");
      made.activity.close();
    });

    it("PBI-480 TV-13: 断られた後に取得し直した先頭が最後の push と同じなら、消し直さず、リースの断りの理由で unresolved にする", async () => {
      const made = await start([out("# 要求要件")]);
      const { repos } = made;
      const pr = prOf(made, "requirements");
      // 取得は、どちらも最後の push と同じ先頭を返す。削除は断られる（誤検知・人が戻した場合）
      repos.deleteBranch = async (_gitDir, branch, _authEnv, expectedHead) => {
        repos.deleteCalls.push({ branch, ...(expectedHead ? { expectedHead } : {}) });
        throw new MessageError(message("git.branchLeaseRejected", { branch }));
      };
      const results = await settleFinal(made);
      expect(results).toEqual([
        {
          branch: pr?.branch,
          result: "unresolved",
          detail: { code: "git.branchLeaseRejected", params: { branch: pr?.branch } },
        },
      ]);
      expect(renderMessage(results[0]?.detail ?? "", "en")).toContain("lease did not match");
      expect(renderMessage(results[0]?.detail ?? "", "ja")).toContain("リースの不一致");
      expect(calls(repos, pr?.branch ?? "")).toHaveLength(1);
      expect(repos.fetchedBranches.filter((f) => f.branch === pr?.branch)).toHaveLength(2);
      expect(types(made.service, made.id)).not.toContain("StepBranchKept");
      made.activity.close();
    });
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
