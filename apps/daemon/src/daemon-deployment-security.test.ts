import { rmSync } from "node:fs";
import { join } from "node:path";
import type { CiFailure, EventInput, ProjectDefinition, StepKey, Task } from "@sacty/core";
import {
  activeStep,
  DEPLOYMENT_CI_GRACE_MS,
  DEPLOYMENT_CI_TIMEOUT_MS,
  isCompleted,
  isFinished,
  MAX_FIX_CHAIN,
  message,
  renderMessage,
  TASK_BODY_MAX,
} from "@sacty/core";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SqliteActivityStore } from "./activity.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { CiSnapshot, CiStatusReader } from "./ci.js";
import type { ConfigResult, SactyConfig } from "./config.js";
import { MemoryProjectStore } from "./projects.js";
import type { FileChange } from "./repository.js";
import { InvalidOperationError, type ServiceDeps, type TaskService } from "./service.js";
import {
  agent,
  configOf,
  dbPath,
  dir,
  type FakeExecutor,
  FakePulls,
  FakeRepos,
  HOLD,
  ja,
  makeService,
  useTempDir,
} from "./testing/daemon.js";

useTempDir();

describe("マージの後の CI/CD とデプロイの監視（PBI-89）", () => {
  const MERGE = "a".repeat(40);
  const SKILL = ".agents/skills/deployment-observer/SKILL.md";

  /** CI/CD の状態の偽物。snap が Error なら読めない。 */
  class FakeCi implements CiStatusReader {
    snap: CiSnapshot | Error = { checks: [], failedRuns: [] };
    failuresList: CiFailure[] = [];
    calls: { repo: string; token: string; commit: string }[] = [];
    failureCalls: { secrets: readonly string[] }[] = [];
    noCiCalls = 0;
    async repositoryHasNoCi() {
      this.noCiCalls++;
      return true;
    }
    async snapshot(input: { repo: string; token: string; commit: string }) {
      this.calls.push(input);
      if (this.snap instanceof Error) throw this.snap;
      return this.snap;
    }
    async failures(input: { secrets: readonly string[] }) {
      this.failureCalls.push({ secrets: [...input.secrets] });
      return this.failuresList;
    }
    reruns = 0;
    async rerunFailedJobs() {
      this.reruns++;
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
      /** コンテキストのイメージ（PBI-325）。 */
      contextImages?: ServiceDeps["contextImages"];
      /** sacty が作った PR をレビューする子タスクを作る（PBI-330）。 */
      reviewTasks?: boolean;
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
      ...(options.contextImages ? { contextImages: options.contextImages } : {}),
      ...(options.reviewTasks ? { reviewTasks: true } : {}),
      planner: async () => ({
        steps: options.steps ?? ["implement", "deployment"],
        fallback: false,
        testCommand: "npm test",
        costUsd: options.plannerCost ?? 0,
        estimated: false,
      }),
    });
    // 実装の工程（PBI-110。PR は実装の工程の中で作る）は、どのタスクでも、同じ実装を答える
    // （outcomes は、マージの後のデプロイの確認の答えに使う）
    made.executor.respond = (invocation) => {
      const prompt = invocation.command.join(" ");
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
    // 実行したのは、マージの前の実装だけ
    expect(t.executor.calls).toHaveLength(1);
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
    const ci = new FakeCi();
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    t.clock.offset = DEPLOYMENT_CI_GRACE_MS - 10_000;
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment?.state).toBe("waiting");
    t.clock.offset = DEPLOYMENT_CI_GRACE_MS + 1_000;
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment).toMatchObject({ state: "skipped", reason: "no_ci" });
    expect(t.service.get(id)?.activity.at(-1)?.payload).toMatchObject({ result: "none" });
    // リポジトリに CI が無いと確かめて短くするのは、実装の PR の CI だけ（PBI-309）
    expect(ci.noCiCalls).toBe(0);
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
    // マージの後の監視では、失敗したジョブを再実行しない（PBI-311）
    expect(ci.reruns).toBe(0);
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
    expect(prompt).toContain("スキルに別の答えの形が書いてあっても、この形式を優先する");
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
    // 予算の上限（1 米ドル）は、マージの後のオーケストレーターへの質問の費用で超える
    const t = setup({ ci, repos, plannerCost: 0.99 });
    const respond = t.executor.respond;
    let asking = false;
    t.executor.respond = (invocation) =>
      asking
        ? {
            kind: "completed",
            output: "答え",
            usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10_000 },
          }
        : respond?.(invocation);
    const id = t.create();
    await t.merge(id);
    asking = true;
    await t.service.askQuestion(id, { text: "デプロイはいつ？" }).answered;
    asking = false;
    expect(t.service.get(id)?.task.budget.usedUsd).toBeGreaterThanOrEqual(1);
    await t.service.runNext(id);
    const task = t.service.get(id)?.task;
    expect(task?.deployment).toMatchObject({
      state: "skipped",
      reason: "budget",
      detail: { code: "deploy.budgetExceeded" },
    });
    expect(task?.status).toBe("idle");
    // デプロイの確認のエージェントは実行しない（実行したのは、実装と質問の答えだけ）
    expect(t.executor.calls).toHaveLength(2);
    t.activity.close();
  });

  it("確認は、人がタスクの詳細で選んだエージェントで行い、選んだ名前が消えていれば動かさずに止める（PBI-121。PR #131 レビュー指摘）", async () => {
    for (const removed of [false, true]) {
      const repos = new FakeRepos();
      repos.files[MERGE] = { [SKILL]: "# skill" };
      const ci = new FakeCi();
      ci.snap = success();
      const strong = agent({ id: "strong", model: "claude-opus-5-5" });
      let agents = [agent(), strong];
      const base = configOf(agent());
      const config = (): ConfigResult => {
        const loaded = base() as { ok: true; config: SactyConfig };
        return {
          ok: true,
          config: { ...loaded.config, agents: Object.fromEntries(agents.map((a) => [a.id, a])) },
        };
      };
      const t = setup({ ci, repos, config, outcomes: [checkOut(answer("healthy"))] });
      const id = t.create();
      await t.service.runNext(id);
      t.service.changeStepAgent(id, { step: "deployment", agent: "strong" });
      await t.merge(id);
      const before = t.executor.calls.length;
      if (removed) agents = [agent()];
      await t.service.runNext(id);
      const checked = t.service.get(id)?.activity.find((e) => e.type === "DeploymentChecked");
      if (removed) {
        expect(t.service.get(id)?.task.pausedMessage).toEqual(
          message("agent.chosenMissing", { step: "deployment", name: "strong" }),
        );
        expect(t.executor.calls).toHaveLength(before);
        expect(checked).toBeUndefined();
      } else {
        expect(checked?.type === "DeploymentChecked" && checked.payload).toMatchObject({
          agentId: "strong",
          model: "claude-opus-5-5",
        });
        expect(t.executor.calls.at(-1)?.command.join(" ")).toContain("claude-opus-5-5");
      }
      t.activity.close();
      rmSync(dbPath, { force: true });
    }
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

  it("修正のタスクの PR にも、レビューの子タスクを作る。そのマージでも監視する（PBI-330 と両立）", async () => {
    const ci = new FakeCi();
    ci.snap = failing();
    ci.failuresList = [testFailure];
    const t = setup({ ci, reviewTasks: true });
    const id = t.create();
    await t.merge(id);
    // 元のタスクの実装の PR にも、レビューの子タスクがある（ラベルは付けない）
    expect(t.service.get(id)?.task.reviewTasks?.map((r) => r.number)).toEqual([7]);
    const fixId = t.service.get(id)?.task.deployment?.fix?.taskId ?? "";
    for (let i = 0; i < 5 && t.service.get(fixId)?.task.gate?.step !== "implement"; i++) {
      await t.service.runNext(fixId);
    }
    expect(t.service.get(fixId)?.task.pullRequest).toMatchObject({ number: 8 });
    expect(t.pulls.labels).toEqual([]);
    const [record] = t.service.get(fixId)?.task.reviewTasks ?? [];
    expect(record).toMatchObject({ step: "implement", number: 8 });
    const review = t.service.get(record?.taskId ?? "")?.task;
    expect(review?.source).toMatchObject({
      kind: "github_pull_request",
      number: 8,
      review: "sacty",
    });
    expect(review?.reviewOf).toEqual({ taskId: fixId, step: "implement" });
    // 修正のタスクの PR のマージでも監視を始める（レビューのタスクは監視しない）
    await t.merge(fixId);
    expect(t.service.get(fixId)?.task.deployment?.state).toBe("failed");
    expect(review?.deployment).toBeUndefined();
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

  it("CI/CD を読んでいる間に一時停止したら、結果を記録せず（修正のタスクも作らず）、再開した後に取り直す（PBI-116 レビュー指摘）", async () => {
    const ci = new FakeCi();
    ci.snap = { checks: [{ kind: "workflow", name: "CI", status: "pending" }], failedRuns: [] };
    ci.failuresList = [testFailure];
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    // 失敗が出そろった（1回目の確認で並びを覚え、2回目で決める）
    ci.snap = failing();
    await t.service.checkPullRequests();
    // 2回目の確認で CI/CD を読んでいる間に、一時停止する
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const snapshot = ci.snapshot.bind(ci);
    ci.snapshot = async (input) => {
      reading.resolve();
      await release.promise;
      return snapshot(input);
    };
    const check = t.service.checkPullRequests();
    await reading.promise;
    await t.service.pause(id);
    release.resolve();
    await check;
    expect(t.service.get(id)?.task).toMatchObject({ status: "paused" });
    expect(deploymentTypes(t.service, id)).toEqual(["DeploymentWatchStarted"]);
    expect(t.service.list()).toHaveLength(1);
    // 再開すると取り直し、結果を記録して修正のタスクを登録する
    ci.snapshot = snapshot;
    t.service.resume(id, {});
    await t.service.checkPullRequests();
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment?.state).toBe("failed");
    expect(t.service.get(id)?.task.deployment?.fix).toBeDefined();
    expect(isFinished(t.service.get(id)?.task as Task)).toBe(true);
    t.activity.close();
  });

  it("CI/CD を読んでいる間に一時停止してすぐに再開し、その後に古い応答が届いても、記録しない（PBI-116 再レビュー指摘）", async () => {
    const ci = new FakeCi();
    ci.snap = { checks: [{ kind: "workflow", name: "CI", status: "pending" }], failedRuns: [] };
    ci.failuresList = [testFailure];
    const t = setup({ ci });
    const id = t.create();
    await t.merge(id);
    ci.snap = failing();
    await t.service.checkPullRequests();
    // 次の確認で CI/CD を読んでいる間に、一時停止してすぐに再開する。その後に、止める前に読み始めた応答が届く
    const reading = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const snapshot = ci.snapshot.bind(ci);
    ci.snapshot = async (input) => {
      reading.resolve();
      await release.promise;
      return snapshot(input);
    };
    const check = t.service.checkPullRequests();
    await reading.promise;
    await t.service.pause(id);
    t.service.resume(id, {});
    expect(t.service.get(id)?.task.status).toBe("idle");
    release.resolve();
    await check;
    expect(deploymentTypes(t.service, id)).toEqual(["DeploymentWatchStarted"]);
    expect(t.service.list()).toHaveLength(1);
    expect(isFinished(t.service.get(id)?.task as Task)).toBe(false);
    // 再開した後の確認では、読み直して記録する
    ci.snapshot = snapshot;
    await t.service.checkPullRequests();
    await t.service.checkPullRequests();
    expect(t.service.get(id)?.task.deployment?.state).toBe("failed");
    expect(t.service.get(id)?.task.deployment?.fix).toBeDefined();
    t.activity.close();
  });

  it("確認の準備・実行の間は、一時停止を求めても、止め終わるまで再開できない（古い準備の結果が再開の後に届くことは無い）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    const t = setup({ ci, repos, outcomes: [checkOut(answer("healthy"))] });
    const id = t.create();
    await t.merge(id);
    const fetching = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetchCommits = repos.fetchCommits.bind(repos);
    repos.fetchCommits = async (...args) => {
      fetching.resolve();
      await release.promise;
      return fetchCommits(...args);
    };
    const run = t.service.runNext(id);
    await fetching.promise;
    const paused = t.service.pause(id);
    // 止め終わる（準備が終わり、一時停止を記録する）までは、再開できない
    expect(() => t.service.resume(id, {})).toThrow();
    release.resolve();
    await paused;
    await run;
    expect(t.service.get(id)?.task).toMatchObject({ status: "paused" });
    expect(t.service.get(id)?.task.deployment?.check).toBeUndefined();
    repos.fetchCommits = fetchCommits;
    t.service.resume(id, {});
    await t.service.runNext(id);
    expect(t.service.get(id)?.task.deployment).toMatchObject({ state: "passed" });
    t.activity.close();
  });

  it("確認の準備の途中で一時停止し、準備が失敗しても、結果にせずに止め、再開すると確かめ直す（PBI-116 レビュー指摘）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    const t = setup({ ci, repos, outcomes: [checkOut(answer("healthy"))] });
    const id = t.create();
    await t.merge(id);
    expect(t.service.get(id)?.task.deployment).toMatchObject({ phase: "check" });
    // マージのコミットを取得している間に一時停止し、その取得が失敗する
    const fetching = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const fetchCommits = repos.fetchCommits.bind(repos);
    repos.fetchCommits = async () => {
      fetching.resolve();
      await release.promise;
      throw new Error("止めたので取得できなかった");
    };
    const run = t.service.runNext(id);
    await fetching.promise;
    const paused = t.service.pause(id);
    release.resolve();
    await paused;
    await run;
    const task = t.service.get(id)?.task as Task;
    expect(task).toMatchObject({ status: "paused", pausedReason: "manual" });
    expect(task.deployment).toMatchObject({ state: "waiting", phase: "check" });
    expect(task.deployment?.check).toBeUndefined();
    expect(
      t.service.get(id)?.activity.find((e) => e.type === "DeploymentChecked")?.payload,
    ).toMatchObject({ retry: true, runResult: "interrupted", failed: { code: "deploy.stopped" } });
    // 再開すると確かめ直す
    repos.fetchCommits = fetchCommits;
    t.service.resume(id, {});
    await t.service.runNext(id);
    expect(t.service.get(id)?.task.deployment).toMatchObject({
      state: "passed",
      check: { result: "healthy" },
    });
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

  it("マージの後の監視の工程は、ほかの工程と同じく、タスクのイメージで確かめる（PBI-116・PBI-318）", async () => {
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
    t.service.changeTaskImage(id, { image: "web" });
    await t.merge(id);
    await t.service.runNext(id);
    expect(t.executor.images.at(-1)?.image).toBe("sacty-agent-web:test");
    // 確認の記録にも使った名前を残す（画面が deployment の実行として出す。PBI-318 レビュー指摘）
    const checks = t.service.get(id)?.activity.filter((e) => e.type === "DeploymentCheckStarted");
    expect(checks?.map((e) => e.type === "DeploymentCheckStarted" && e.payload.image)).toEqual([
      "web",
    ]);
    t.activity.close();
  });

  it("作成に失敗したコンテキストのイメージなら、既定のイメージに倒さず、理由を示して確認を止める（PBI-325 レビュー指摘）", async () => {
    const repos = new FakeRepos();
    repos.files[MERGE] = { [SKILL]: "# skill" };
    const ci = new FakeCi();
    ci.snap = success();
    let failed = false;
    const entry = () => ({
      name: "web",
      description: "ブラウザ",
      from: "acme",
      image: "sacty-ctx-x-default-web:0123456789abcdef",
      language: {
        name: "web",
        image: "sacty-ctx-x-default-web:0123456789abcdef",
        description: "ブラウザ",
        baseImage: "node:26",
        env: {},
      },
      state: failed ? ("failed" as const) : ("ready" as const),
      ...(failed ? { error: "イメージを作成できませんでした。" } : {}),
      log: "",
    });
    const contextImages: NonNullable<ServiceDeps["contextImages"]> = {
      images: () => [entry()],
      pending: () => false,
      view: () => [],
      rebuild: () => ({ ok: true }),
      refresh: async () => {},
    };
    const t = setup({ ci, repos, contextImages, outcomes: [checkOut(answer("healthy"))] });
    const id = t.create();
    await t.service.runNext(id);
    t.service.changeTaskImage(id, { image: "web" });
    await t.merge(id);
    failed = true;
    const runs = t.executor.images.length;
    await t.service.runNext(id);
    // 確認のエージェントは動かさない（既定のイメージでも動かさない）
    expect(t.executor.images.length).toBe(runs);
    const started = t.service.get(id)?.activity.filter((e) => e.type === "DeploymentCheckStarted");
    expect(started?.map((e) => e.type === "DeploymentCheckStarted" && e.payload.image)).toEqual([
      "web",
    ]);
    const checked = t.service.get(id)?.activity.findLast((e) => e.type === "DeploymentChecked");
    expect(JSON.stringify(checked)).toContain("contextImage.failed");
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

describe("セキュリティチェックとセキュリティ対応", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const report = out(
    [
      "# セキュリティチェックの結果",
      block({
        "sacty-security-findings": {
          findings: [
            {
              id: "SF-1",
              category: "dependency",
              severity: "high",
              title: "example-lib の既知の脆弱性",
              refs: ["GHSA-0000-0000-0000"],
              location: "package-lock.json の example-lib@1.2.3",
              fix: "example-lib を 1.2.4 に上げる",
            },
            {
              id: "SF-2",
              category: "supply-chain",
              severity: "medium",
              title: "外部の Actions をタグで参照している",
              refs: [],
              location: ".github/workflows/ci.yml:12",
              fix: "コミットの SHA で固定する",
            },
          ],
        },
      }),
    ].join("\n\n"),
  );
  const checkPlanner = async () => ({
    steps: ["investigate" as const],
    plan: "security-check" as const,
    reason: "点検",
    fallback: false,
    costUsd: 0,
    estimated: false,
  });
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";

  it("テンプレートで作ると進め方をセキュリティチェックに決め、点検の区分と指摘の一覧の形を指示する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [report], { planner: checkPlanner });
    const task = service.createTask({ template: "security-check", projectId: "default" });
    expect(task).toMatchObject({ template: "security-check", requestedPlan: "security-check" });
    expect(task.title).toContain("セキュリティチェック");
    await service.runNext(task.id);
    const prompt = promptOf(executor, 0);
    expect(prompt).toContain("--- セキュリティチェック ---");
    expect(prompt).toContain("sacty-security-findings");
    expect(prompt).toContain("osv-scanner");
    expect(prompt).toContain("値を書かない");
    activity.close();
  });

  it("Issue から取り込んだセキュリティチェックは、承認しても結果を Issue に返さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const { service } = makeService(activity, [report], { pulls, planner: checkPlanner });
    service.saveProject("default", {
      name: "デフォルト",
      targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
      githubAccounts: { "github.com": "me" },
    });
    const [task] = service.importIssues([
      {
        repo: "https://github.com/acme/app",
        number: 7,
        title: "脆弱性を点検して",
        body: "",
        url: "https://github.com/acme/app/issues/7",
        labels: ["sacty"],
      },
    ]);
    const id = task?.id ?? "";
    await service.runNext(id);
    const done = service.approve(id, { step: "investigate", submission: 1 });
    expect(isCompleted(done)).toBe(true);
    expect(service.queuedTaskIds()).toEqual([]);
    expect(pulls.issueComments).toEqual([]);
    activity.close();
  });

  it("承認したレポートの区分ごとに、その区分の指摘だけで対応のタスクを1回だけ作る（再起動しても重ねない）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [report], { planner: checkPlanner });
    const { id } = service.createTask({ template: "security-check", projectId: "default" });
    await service.runNext(id);
    // 承認する前は作れない
    expect(() => service.requestSecurityFix(id, { category: "dependency" })).toThrow(
      InvalidOperationError,
    );
    service.approve(id, { step: "investigate", submission: 1 });
    expect(service.securityFindings(id).map((f) => f.id)).toEqual(["SF-1", "SF-2"]);

    const updated = service.requestSecurityFix(id, { category: "dependency" });
    const requested = updated.securityFixes?.dependency;
    expect(requested).toBeDefined();
    const fix = service.get(requested?.taskId ?? "")?.task;
    expect(fix).toMatchObject({
      start: "security",
      requestedPlan: "security-fix",
      securityFix: { taskId: id, category: "dependency" },
      status: "queued",
    });
    expect(fix?.body).toContain("SF-1");
    expect(fix?.body).toContain("GHSA-0000-0000-0000");
    expect(fix?.body).not.toContain("SF-2");
    expect(fix?.body).toContain("最小限の変更");
    // 同じ区分は二度作らない。指摘の無い区分は作らない
    expect(() => service.requestSecurityFix(id, { category: "dependency" })).toThrow(
      InvalidOperationError,
    );
    expect(() => service.requestSecurityFix(id, { category: "secret" })).toThrow(
      InvalidOperationError,
    );
    const count = () => service.list().filter((t) => t.start === "security").length;
    expect(count()).toBe(1);
    const { service: restarted } = makeService(activity, [], { planner: checkPlanner });
    restarted.resumeSecurityFixTasks();
    expect(restarted.list().filter((t) => t.start === "security")).toHaveLength(1);
    activity.close();
  });

  it("説明に入りきらない指摘も、件数を書き、全件を対応のタスクに持たせて工程に渡す", async () => {
    const many = Array.from({ length: 80 }, (_, i) => ({
      id: `SF-${i + 1}`,
      category: "dependency",
      severity: "high",
      title: `example-lib-${i + 1} の既知の脆弱性`,
      refs: [`GHSA-0000-0000-${String(i + 1).padStart(4, "0")}`],
      location: `package-lock.json の example-lib-${i + 1}@1.0.0（${"とても長い場所の説明".repeat(5)}）`,
      fix: `example-lib-${i + 1} を 1.0.1 に上げる`,
    }));
    const bigReport = out(
      ["# レポート", block({ "sacty-security-findings": { findings: many } })].join("\n\n"),
    );
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [bigReport, out("# 調査")], {
      planner: async (task) =>
        task.requestedPlan === "security-fix"
          ? {
              steps: ["investigate", "implement"],
              plan: "security-fix",
              reason: "対応",
              fallback: false,
              testCommand: "npm test",
              costUsd: 0,
              estimated: false,
            }
          : checkPlanner(),
    });
    const { id } = service.createTask({ template: "security-check", projectId: "default" });
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    const requested = service.requestSecurityFix(id, { category: "dependency" }).securityFixes
      ?.dependency;
    const fix = service.get(requested?.taskId ?? "")?.task;
    expect(fix?.body.length).toBeLessThanOrEqual(TASK_BODY_MAX);
    expect(fix?.body).toMatch(/ほか \d+ 件/);
    expect(fix?.body).not.toContain("SF-80");
    expect(fix?.securityFix?.findings).toHaveLength(80);
    // 前段の調査の指示に、全件を省かずに渡す
    await service.runNext(fix?.id ?? "");
    const prompt = promptOf(executor, 1);
    expect(prompt).toContain("対応する指摘の全件（80件");
    expect(prompt).toContain("GHSA-0000-0000-0080");
    // 範囲を広げるために中止して再実行しても、元のレポート・区分・指摘の全件を引き継ぐ
    await service.cancel(fix?.id ?? "");
    const rerun = service.rerunTask(fix?.id ?? "", {
      title: fix?.title ?? "",
      body: fix?.body ?? "",
      note: "範囲に package.json を含める",
      repo: "https://github.com/acme/app",
    });
    expect(rerun.securityFix).toEqual(fix?.securityFix);
    const before = executor.calls.length;
    await service.runNext(rerun.id);
    expect(executor.calls.length).toBe(before + 1);
    expect(promptOf(executor, before)).toContain("GHSA-0000-0000-0080");
    activity.close();
  });

  it("頼んだ記録だけがあり対応のタスクが無ければ、起動のときに記録した ID で1件だけ作る", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [report], { planner: checkPlanner });
    const { id } = service.createTask({ template: "security-check", projectId: "default" });
    await service.runNext(id);
    service.approve(id, { step: "investigate", submission: 1 });
    // 頼んだことを記録した後、作る前にデーモンが止まった
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "person",
          event: {
            type: "SecurityFixRequested",
            payload: { category: "supply-chain", taskId: "fix-1", title: "対応", body: "SF-2" },
          },
        },
      ],
    });
    const { service: restarted } = makeService(activity, [], { planner: checkPlanner });
    expect(restarted.get("fix-1")).toBeUndefined();
    restarted.resumeSecurityFixTasks();
    restarted.resumeSecurityFixTasks();
    expect(restarted.get("fix-1")?.task).toMatchObject({
      start: "security",
      requestedPlan: "security-fix",
      securityFix: { taskId: id, category: "supply-chain" },
    });
    expect(restarted.list().filter((t) => t.start === "security")).toHaveLength(1);
    activity.close();
  });

  it("中止したセキュリティ対応を再実行すると、進め方を引き継ぐ（範囲を補足してやり直す）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { planner: checkPlanner });
    const task = service.createTask({
      projectId: "default",
      title: "GHSA を直す",
      plan: "security-fix",
    });
    await service.cancel(task.id);
    const rerun = service.rerunTask(task.id, {
      title: "GHSA を直す",
      note: "範囲に src/http.ts を含める",
      repo: null,
    });
    expect(rerun.requestedPlan).toBe("security-fix");
    expect(rerun.body).toContain("範囲に src/http.ts を含める");
    // ほかの組み合わせは引き継がない
    const other = service.createTask({ projectId: "default", title: "A", plan: "direct" });
    await service.cancel(other.id);
    expect(service.rerunTask(other.id, { title: "A", repo: null }).requestedPlan).toBeUndefined();
    activity.close();
  });

  describe("セキュリティ対応の修正の範囲", () => {
    const fixPlanner = async () => ({
      steps: ["investigate" as const, "implement" as const],
      plan: "security-fix" as const,
      reason: "脆弱性の修正",
      fallback: false,
      testCommand: "npm test",
      costUsd: 0,
      estimated: false,
    });
    const scoped = out(
      [
        "# 調査",
        block({
          "sacty-security-scope": {
            paths: ["package.json", "package-lock.json"],
            packages: [{ name: "example-lib", from: "1.2.3", to: "1.2.4" }],
            verification: "osv-scanner scan source -r .",
            reason: "依存を上げるだけで足りる",
          },
        }),
      ].join("\n\n"),
    );
    const implemented = out(
      [
        "# 実装",
        block({
          "sacty-test-map": [
            {
              viewpointId: "REQ",
              tests: [],
              untested: "修正の範囲の verification のコマンドで確かめる",
            },
          ],
        }),
      ].join("\n\n"),
    );
    const run = async (changes: FileChange[]) => {
      const activity = new SqliteActivityStore(dbPath);
      const repos = new FakeRepos();
      repos.changes = changes;
      const made = makeService(activity, [scoped, implemented], {
        planner: fixPlanner,
        repos,
      });
      const { id } = made.service.createTask({
        projectId: "default",
        title: "GHSA-0000-0000-0000 を直す",
        plan: "security-fix",
      });
      for (let i = 0; i < 4; i++) await made.service.runNext(id);
      return { ...made, activity, id };
    };

    it("実装に修正の範囲を渡し、最終レビューをせずに実装の PR を作る", async () => {
      const { activity, executor, service, id } = await run([
        { path: "package.json", added: 1, removed: 1 },
        { path: "package-lock.json", added: 40, removed: 40 },
      ]);
      const prompts = executor.calls.map((c) => c.command.join(" "));
      expect(prompts).toHaveLength(2);
      expect(prompts[0]).toContain("sacty-security-scope");
      expect(prompts[1]).toContain("--- セキュリティ対応（最小限の変更） ---");
      expect(prompts[1]).toContain('"paths":["package.json","package-lock.json"]');
      expect(service.get(id)?.activity.map((e) => e.type)).toContain("FinalReviewSkipped");
      expect(service.get(id)?.task.gate?.step).toBe("implement");
      activity.close();
    });

    describe("PR のレビューの子タスクに照合の結果を渡す（PBI-331。PR #348 7回目のレビュー指摘）", () => {
      const taskOf = (svc: TaskService, id: string) => svc.get(id)?.task as Task;
      const verdict = out(
        `# 評価\n\n問題なし\n\n${block({ "sacty-review-verdict": { verdict: "no_findings" } })}`,
      );
      const runNew = async (changes: FileChange[], diffFail?: string) => {
        const activity = new SqliteActivityStore(dbPath);
        const repos = new FakeRepos();
        repos.changes = changes;
        if (diffFail) repos.diffFail = diffFail;
        const pulls = new FakePulls();
        const made = makeService(activity, [scoped, implemented, verdict], {
          planner: fixPlanner,
          repos,
          pulls,
          stepPullRequests: true,
          reviewTasks: true,
        });
        const { id } = made.service.createTask({
          projectId: "default",
          title: "GHSA-0000-0000-0000 を直す",
          plan: "security-fix",
        });
        for (let i = 0; i < 5 && taskOf(made.service, id).status !== "awaiting_approval"; i++) {
          if (taskOf(made.service, id).status === "paused") break;
          await made.service.runNext(id);
        }
        const skipped = made.service.get(id)?.activity.find((e) => e.type === "FinalReviewSkipped");
        const childId = taskOf(made.service, id).reviewTasks?.[0]?.taskId;
        if (childId) {
          for (let i = 0; i < 4 && !isCompleted(taskOf(made.service, childId)); i++) {
            await made.service.runNext(childId);
          }
        }
        return { ...made, activity, pulls, id, skipped, childId };
      };

      it("範囲の外のファイルを変えたら、照合の結果を記録し、PR の本文とレビューの子タスクに違反を要修正として渡す", async () => {
        const { activity, service, executor, pulls, id, skipped, childId } = await runNew([
          { path: "package.json", added: 1, removed: 0 },
          { path: "src/util.ts", added: 1, removed: 0 },
        ]);
        expect(skipped?.type === "FinalReviewSkipped" && skipped.payload).toEqual({
          securityScope: {
            violation: expect.objectContaining({ outside: ["src/util.ts"] }),
          },
        });
        expect(taskOf(service, id).securityScopeCheck?.violation?.outside).toEqual(["src/util.ts"]);
        const body = pulls.calls.at(-1)?.body ?? "";
        expect(body).toContain("違反を見つけました");
        expect(body).toContain("src/util.ts");
        expect(body).not.toContain("ゴールガーディアンが最小限か");
        expect(childId).toBeTruthy();
        const reviewPrompt = executor.calls.at(-1)?.command.join(" ") ?? "";
        expect(reviewPrompt).toContain("この PR はセキュリティ対応です");
        expect(reviewPrompt).toContain("`package.json`・`package-lock.json`");
        expect(reviewPrompt).toContain("example-lib 1.2.3 → 1.2.4");
        expect(reviewPrompt).toContain("違反を見つけました。直すべき指摘（要修正）にする");
        expect(reviewPrompt).toContain("src/util.ts");
        activity.close();
      });

      it("範囲の中の差分なら、違反なしを記録し、PR の本文とレビューの子タスクに最小限かの確認を任せる", async () => {
        const { activity, executor, pulls, skipped } = await runNew([
          { path: "package.json", added: 1, removed: 1 },
          { path: "package-lock.json", added: 40, removed: 40 },
        ]);
        expect(skipped?.type === "FinalReviewSkipped" && skipped.payload).toEqual({
          securityScope: {},
        });
        const body = pulls.calls.at(-1)?.body ?? "";
        expect(body).toContain("範囲の外の変更は見つかりませんでした");
        expect(body).toContain("PR のレビューの子タスクが確かめます");
        expect(body).not.toContain("ゴールガーディアンが最小限か");
        const reviewPrompt = executor.calls.at(-1)?.command.join(" ") ?? "";
        expect(reviewPrompt).toContain("この PR はセキュリティ対応です");
        expect(reviewPrompt).toContain("範囲の外の変更は見つかりませんでした");
        expect(reviewPrompt).not.toContain("違反を見つけました");
        activity.close();
      });

      it("テスト・文書を含めて 600 行を超える差分でも、範囲の外のファイルが無ければ違反にしない（行の数の上限は無い。PBI-452）", async () => {
        const { activity, service, id, executor, pulls, skipped } = await runNew([
          { path: "package.json", added: 200, removed: 100 },
          { path: "src/fix.test.ts", added: 300, removed: 0 },
        ]);
        // 違反が記録されない。行の数は、指示・PR の本文のどこにも出ない
        expect(skipped?.type === "FinalReviewSkipped" && skipped.payload).toEqual({
          securityScope: {},
        });
        expect(taskOf(service, id).securityScopeCheck?.violation).toBeUndefined();
        const body = pulls.calls.at(-1)?.body ?? "";
        const reviewPrompt = executor.calls.at(-1)?.command.join(" ") ?? "";
        for (const text of [body, reviewPrompt]) {
          expect(text).not.toContain("違反を見つけました");
          expect(text).not.toContain("行の数");
          expect(text).not.toContain("300 行");
        }
        activity.close();
      });

      it("範囲の外のファイルの違反は、行の数を持たず、前の版が読める形（max を持つ）で記録する（PBI-452）", async () => {
        const { activity, skipped } = await runNew([
          { path: "package.json", added: 1, removed: 0 },
          { path: "src/util.ts", added: 1, removed: 0 },
        ]);
        const violation =
          skipped?.type === "FinalReviewSkipped" ? skipped.payload.securityScope?.violation : {};
        expect(violation).toEqual({ outside: ["src/util.ts"], max: 300 });
        // 変更前の版の schema（lines は任意、max は必須の整数）でも読める
        const before = z.object({
          outside: z.array(z.string()),
          lines: z.number().int().nonnegative().optional(),
          max: z.number().int().positive(),
        });
        expect(before.safeParse(violation).success).toBe(true);
        activity.close();
      });

      it("実装の指示・レビューの指示・PR の本文・画面の文言に、変えた行の数の上限が出ない。「最小限の変更」「範囲の外を変えない」は残る（PBI-452）", async () => {
        const { activity, executor, pulls, service, id } = await runNew([
          { path: "package.json", added: 1, removed: 0 },
          { path: "src/util.ts", added: 1, removed: 0 },
        ]);
        const prompts = executor.calls.map((c) => c.command.join(" "));
        const implementPrompt =
          prompts.find((p) => p.includes("--- セキュリティ対応（最小限の変更） ---")) ?? "";
        const reviewPrompt = prompts.at(-1) ?? "";
        const body = pulls.calls.at(-1)?.body ?? "";
        const task = taskOf(service, id);
        const section = (text: string) => text.split("## 修正の範囲（セキュリティ対応）")[1] ?? "";
        const scopeBody = section(body).split("\n## ")[0] ?? "";
        const reviewSection = reviewPrompt.split("この PR はセキュリティ対応です")[1] ?? "";
        const implementSection =
          implementPrompt.split("--- セキュリティ対応（最小限の変更） ---")[1] ?? "";
        for (const text of [
          implementSection.split("--- 修正の範囲")[0] ?? "",
          reviewSection.split("--- ")[0] ?? "",
          scopeBody,
        ]) {
          expect(text).not.toContain("300");
          expect(text).not.toContain("行の数");
          expect(text).not.toContain("上限");
        }
        // 範囲の外を変えない・最小限の変更は、残る
        expect(implementSection).toContain("最小限の変更だけ");
        expect(implementSection).toContain("範囲の外を変えない");
        expect(reviewSection).toContain("範囲の外の変更");
        expect(reviewSection).toContain("直すべき指摘（要修正）にする");
        expect(scopeBody).toContain("最小限の変更に絞る");
        expect(task.securityScopeCheck?.violation?.outside).toEqual(["src/util.ts"]);
        // 画面の文言（ja・en）
        const violation = { outside: ["src/util.ts"], lines: 571, max: 300 };
        for (const language of ["ja", "en"] as const) {
          const text = renderMessage(message("review.scopeViolated", violation), language);
          expect(text).toContain("src/util.ts");
          expect(text).not.toMatch(/300|571|行の数|lines/);
        }
        activity.close();
      });

      it("範囲の宣言が無いときは、行の数で違反にしない。実装とレビューの指示に、範囲を照らしていない旨があり、PR の本文には新しい文を足さない（PBI-452）", async () => {
        const activity = new SqliteActivityStore(dbPath);
        const repos = new FakeRepos();
        repos.changes = [{ path: "src/anything.ts", added: 400, removed: 200 }];
        const pulls = new FakePulls();
        const made = makeService(
          activity,
          [out("# 調査（範囲の宣言なし）"), implemented, verdict],
          { planner: fixPlanner, repos, pulls, stepPullRequests: true, reviewTasks: true },
        );
        const { id } = made.service.createTask({
          projectId: "default",
          title: "GHSA-0000-0000-0000 を直す",
          plan: "security-fix",
        });
        for (let i = 0; i < 5 && taskOf(made.service, id).status !== "awaiting_approval"; i++) {
          await made.service.runNext(id);
        }
        const childId = taskOf(made.service, id).reviewTasks?.[0]?.taskId;
        for (let i = 0; i < 4 && childId && !isCompleted(taskOf(made.service, childId)); i++) {
          await made.service.runNext(childId);
        }
        const skipped = made.service.get(id)?.activity.find((e) => e.type === "FinalReviewSkipped");
        expect(skipped?.type === "FinalReviewSkipped" && skipped.payload).toEqual({
          securityScope: {},
        });
        const prompts = made.executor.calls.map((c) => c.command.join(" "));
        const implementPrompt =
          prompts.find((p) => p.includes("--- セキュリティ対応（最小限の変更） ---")) ?? "";
        const reviewPrompt = prompts.at(-1) ?? "";
        expect(implementPrompt).toContain("宣言が無いので、sacty は範囲を照らしていません");
        expect(reviewPrompt).toContain("宣言が無いので、sacty は範囲を照らしていません");
        const body = pulls.calls.at(-1)?.body ?? "";
        const scopeBody =
          (body.split("## 修正の範囲（セキュリティ対応）")[1] ?? "").split("\n## ")[0] ?? "";
        expect(scopeBody).not.toContain("宣言");
        // 宣言が無ければ照らしていないので、「照らし、範囲の外の変更は見つかりませんでした」と書かない
        for (const text of [reviewPrompt, scopeBody]) {
          expect(text).not.toContain("範囲の外の変更は見つかりませんでした");
        }
        for (const text of [
          implementPrompt
            .split("--- セキュリティ対応（最小限の変更） ---")[1]
            ?.split("--- 修正の範囲")[0] ?? "",
          scopeBody,
        ]) {
          expect(text).not.toContain("行の数");
          expect(text).not.toContain("上限");
        }
        activity.close();
      });

      it("差分を取れなければ、照合せずに PR を作らず一時停止する", async () => {
        const { activity, service, pulls, id, skipped } = await runNew([], "git が壊れている");
        expect(skipped).toBeUndefined();
        expect(taskOf(service, id)).toMatchObject({ status: "paused", pausedReason: "error" });
        expect(ja(taskOf(service, id).pausedMessage)).toContain("git が壊れている");
        expect(pulls.calls).toHaveLength(0);
        activity.close();
      });
    });
  });
});
