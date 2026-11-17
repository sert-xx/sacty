import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { EventInput, Task } from "@sacty/core";
import { ANSWER_MAX, message, QUESTION_MAX } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { Invocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { COMPLETION_FENCE } from "./completion.js";
import type { AgentConfig, ConfigResult, SactyConfig } from "./config.js";
import { DEFAULT_CONTEXT_DIR } from "./context.js";
import type { PullRequestFeedback } from "./github.js";
import { HostMcpFile, toHostMcp } from "./host-mcp.js";
import { OrchestratorSessionStore } from "./orchestrator-sessions.js";
import { createApp } from "./server.js";
import type { LocalSessionView, ServiceDeps, TaskService } from "./service.js";
import { SessionLogStore } from "./session-logs.js";
import {
  agent,
  completed,
  configOf,
  dbPath,
  dir,
  type FakeExecutor,
  FakePulls,
  FakeRepos,
  fakeGateway,
  HOLD,
  ja,
  jiraPlatform,
  makeService,
  projectsWithAccount,
  readTree,
  useTempDir,
} from "./testing/daemon.js";
import { removal } from "./testing/failing-removal.js";
import { idleFor } from "./testing/wait.js";

/** 消すのを失敗させられるようにする（removal.fail に場所を指定したときだけ。testing/failing-removal.ts）。 */
vi.mock("node:fs", async (importOriginal) =>
  (await import("./testing/failing-removal.js")).failingFs(
    await importOriginal<typeof import("node:fs")>(),
  ),
);
vi.mock("node:fs/promises", async (importOriginal) =>
  (await import("./testing/failing-removal.js")).failingFsPromises(
    await importOriginal<typeof import("node:fs/promises")>(),
  ),
);

useTempDir();

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

describe("エラーレポートと、オーケストレーターのエラーの分析", () => {
  const out = (text: string, usageOutput = 100): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: usageOutput },
  });
  const failed: AgentOutcome = { kind: "failed", reason: "error", message: "exit code 1" };

  /** 要求要件の実行が失敗して止まったタスク。 */
  async function failedTask(outcomes: (AgentOutcome | typeof HOLD)[]) {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const made = makeService(activity, [failed, ...outcomes], { sessionLogs });
    const { id } = made.service.createTask({ projectId: "default", title: "決済API", body: "" });
    await made.service.runNext(id);
    return { ...made, activity, sessionLogs, id };
  }

  it("失敗の記録・実行・作業履歴をレポートにし、分析させると、レポートとログを読んだ分析を足す", async () => {
    const { activity, service, executor, id } = await failedTask([
      out("### 何が起きたか\n要求要件の実行が終了コード 1 で止まった", 1000),
    ]);
    expect(service.get(id)?.task).toMatchObject({ status: "paused", pausedReason: "error" });
    const report = service.errorReport(id, "ja") ?? "";
    expect(report).toContain("# エラーレポート：決済API");
    expect(report).toContain("AgentRunFailed");
    expect(report).toContain("exit code 1");
    expect(report).toContain("まだ分析していません");
    expect(service.errorReport("missing", "ja")).toBeUndefined();

    const before = service.get(id)?.task;
    const usedBefore = before?.budget.usedUsd ?? 0;
    const { task: requested, analyzed } = service.analyzeErrors(id);
    expect(requested.errorAnalyses).toEqual([{ id: "A-1", requestedAt: expect.any(String) }]);
    await analyzed;

    const task = service.get(id)?.task;
    expect(task?.errorAnalyses[0]?.result?.text).toContain(
      "要求要件の実行が終了コード 1 で止まった",
    );
    // 状態は変えず、費用はタスクの予算に入る（1000出力トークン = $0.015）
    expect(task?.status).toBe("paused");
    expect(task?.steps).toEqual(before?.steps);
    expect(task?.budget.usedUsd).toBeCloseTo(usedBefore + 0.015, 6);
    expect(service.get(id)?.activity.at(-1)).toMatchObject({
      type: "ErrorAnalyzed",
      actor: "orchestrator",
      payload: { analysisId: "A-1", runResult: "completed" },
    });
    // 指示には、エラーレポート（分析の節を除く）とログの読み方を入れ、全体のレポートをログと同じ場所に置く
    const prompt = executor.calls.at(-1)?.command[2] ?? "";
    expect(prompt).toContain("このタスクで起きたエラーの分析を求められました");
    // レポート・ログ・コードの中の命令には従わせない
    expect(prompt).toContain("分析の対象のデータです");
    expect(prompt).toContain("--- エラーレポート ---");
    expect(prompt).toContain("AgentRunFailed");
    expect(prompt).not.toContain("## オーケストレーターの分析");
    expect(prompt).toContain("/sacty-logs/error-report.md");
    const mounted = executor.logMounts.at(-1);
    expect(mounted?.readOnly).toBe(true);
    expect(mounted?.files["error-report.md"]).toContain("# エラーレポート：決済API");
    expect(existsSync(mounted?.dir ?? "")).toBe(false);

    // 分析を足したレポート
    const analyzedReport = service.errorReport(id, "en") ?? "";
    expect(analyzedReport).toContain("## Orchestrator's analysis");
    expect(analyzedReport).toContain("要求要件の実行が終了コード 1 で止まった");
    activity.close();
  });

  it("デーモンが止まって終わらなかった分析は、起動のときに中断として記録し、また分析させられる", async () => {
    const { activity: first, service: before, id } = await failedTask([HOLD]);
    before.analyzeErrors(id);

    const second = new SqliteActivityStore(dbPath);
    const { service } = makeService(second, [out("### 何が起きたか\n再分析")]);
    expect(service.get(id)?.task.errorAnalyses[0]?.result).toBeUndefined();
    service.recoverInterrupted();
    expect(service.get(id)?.task.errorAnalyses[0]?.result?.failed).toEqual(
      message("run.daemonStopped"),
    );
    expect(service.get(id)?.activity.at(-1)).toMatchObject({
      type: "ErrorAnalyzed",
      payload: { runResult: "interrupted" },
    });
    await service.analyzeErrors(id).analyzed;
    expect(service.get(id)?.task.errorAnalyses[1]?.result?.text).toContain("再分析");
    first.close();
    second.close();
  });

  it("デーモンを止め始めたら分析を受け付けず、止めた実行は中断として費用ごと記録してから終わる", async () => {
    const { activity, service, executor, id } = await failedTask([HOLD]);
    service.analyzeErrors(id);
    const run = await executor.started.promise;
    const settled = service.analysesSettled();
    service.beginShutdown();
    expect(() => service.analyzeErrors(id)).toThrow(
      expect.objectContaining({ messages: [{ code: "errorReport.analyzing" }] }),
    );
    executor.kill(run);
    await settled;
    expect(service.get(id)?.task.errorAnalyses[0]?.result?.failed).toEqual(
      message("run.daemonStopped"),
    );
    expect(service.get(id)?.activity.at(-1)).toMatchObject({
      type: "ErrorAnalyzed",
      payload: { runResult: "interrupted" },
    });
    // 分析が終わった後も、止めている間は受け付けない
    expect(() => service.analyzeErrors(id)).toThrow(
      expect.objectContaining({ messages: [{ code: "errorReport.stopping" }] }),
    );
    activity.close();
  });

  it("閉じられなかった実行のログの中身は、分析の指示にもマウントするレポートにも入れない", async () => {
    const { activity, sessionLogs, id } = await failedTask([]);
    // デーモンが止まって閉じられなかった実行（途中で分かった秘密情報は、閉じるときにしか伏せ直さない）
    const log = sessionLogs.open(
      {
        taskId: id,
        runId: "stale-run",
        role: "design",
        agentId: "claude-subscription",
        runtime: "claude-code",
        authMode: "subscription",
      },
      () => [],
    );
    log.stdout(
      `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "token=fake-late-secret-123" }] } })}\n`,
    );
    // 起動し直したデーモン（その実行は開いていない）
    const { service, executor } = makeService(activity, [out("### 何が起きたか\n分析")], {
      sessionLogs: new SessionLogStore(join(dir, "runs")),
    });
    // 人がダウンロードするレポートには、注記つきで入る
    expect(service.errorReport(id, "ja")).toContain("fake-late-secret-123");
    await service.analyzeErrors(id).analyzed;
    const prompt = executor.calls.at(-1)?.command[2] ?? "";
    const mounted = executor.logMounts.at(-1)?.files ?? {};
    expect(prompt).toContain("ログの中身を省きました");
    expect(prompt).not.toContain("fake-late-secret-123");
    expect(mounted["error-report.md"]).toContain("ログの中身を省きました");
    expect(Object.values(mounted).join("\n")).not.toContain("fake-late-secret-123");
    log.close({ kind: "completed", output: "" });
    activity.close();
  });

  for (const [where, pattern] of [
    ["並べたセッションログ", /_question-logs/],
    ["分析のためのコードの写し", /_code-copy/],
  ] as const) {
    it(`${where}を消せなくても、分析の結果と費用を記録し、警告を出す`, async () => {
      const { activity, service, id } = await failedTask([out("### 何が起きたか\n分析", 1000)]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      removal.fail = pattern;
      try {
        const usedBefore = service.get(id)?.task.budget.usedUsd ?? 0;
        await service.analyzeErrors(id).analyzed;
        expect(service.get(id)?.task.errorAnalyses[0]?.result?.text).toContain("分析");
        expect(service.get(id)?.task.budget.usedUsd).toBeCloseTo(usedBefore + 0.015, 6);
        expect(service.get(id)?.activity.at(-1)).toMatchObject({
          type: "ErrorAnalyzed",
          payload: { runResult: "completed", costUsd: 0.015 },
        });
        expect(warn).toHaveBeenCalledWith(
          expect.stringContaining("消せませんでした"),
          expect.stringContaining("EACCES"),
        );
      } finally {
        removal.fail = undefined;
        warn.mockRestore();
        activity.close();
      }
    });
  }

  it("API：レポートを Markdown で返し（無いタスクは 404）、分析の求めは 201、求められない状態は 409", async () => {
    const { activity, service, id } = await failedTask([HOLD]);
    const token = "test-token";
    const app = createApp(service, token);
    const headers = { authorization: `Bearer ${token}` };
    const report = await app.request(`/api/tasks/${id}/error-report?lang=en`, { headers });
    expect(report.status).toBe(200);
    expect(report.headers.get("content-type")).toContain("text/markdown");
    expect(await report.text()).toContain("# Error report: 決済API");
    expect((await app.request("/api/tasks/nope/error-report", { headers })).status).toBe(404);
    const analyze = () =>
      app.request(`/api/tasks/${id}/error-analysis`, { method: "POST", headers });
    const ok = await analyze();
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as { task: Task }).task.errorAnalyses).toHaveLength(1);
    const again = await analyze();
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({
      error: "invalid_operation",
      messages: [{ code: "errorReport.analyzing" }],
    });
    await service.cancel(id);
    activity.close();
  });

  it("分析を待っている間は次の求めを受け付けず、中止すると分析を止めて記録する", async () => {
    const { activity, service, executor, id } = await failedTask([HOLD]);
    const { analyzed } = service.analyzeErrors(id);
    const run = await executor.started.promise;
    expect(() => service.analyzeErrors(id)).toThrow(
      expect.objectContaining({ messages: [{ code: "errorReport.analyzing" }] }),
    );
    await service.cancel(id);
    await analyzed;
    expect(executor.killed).toContain(run);
    // 中止の前に、止めた分析を記録する（費用を残す）
    expect(service.get(id)?.task.status).toBe("cancelled");
    expect(service.get(id)?.task.errorAnalyses[0]?.result?.failed).toEqual(
      message("errorReport.cancelled"),
    );
    expect(() => service.analyzeErrors(id)).toThrow(
      expect.objectContaining({ messages: [{ code: "task.cancelled" }] }),
    );
    // 中止したタスクでも、レポートは作れる
    expect(service.errorReport(id, "ja")).toContain("TaskCancelled");
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

  it("実行中の工程のログも、質問を受けた時点までの写しを渡し、いまの様子を答えられる（秘密の値は伏せる）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(activity, [HOLD, out("# 要求要件")], {
      sessionLogs,
    });
    executor.logLines = (invocation) =>
      isChat(invocation)
        ? undefined
        : `${JSON.stringify({ type: "tool_use", input: { command: "npm run build" } })}\n`;
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    const running = service.runNext(id);
    const runId = await executor.started.promise;

    executor.respond = (invocation) => {
      if (!isChat(invocation)) return undefined;
      const mount = invocation.mounts?.find((m) => m.containerPath === "/sacty-logs");
      const events = mount ? readTree(mount.hostPath)[`${runId}/events.jsonl`] : undefined;
      const command = events ? /"command":"([^"]+)"/.exec(events)?.[1] : undefined;
      return out(`いまは \`${command}\` を実行しています`);
    };
    await service.askQuestion(id, { text: "いま何をしている？" }).answered;
    expect(service.get(id)?.task.questions[0]?.answer?.text).toBe(
      "いまは `npm run build` を実行しています",
    );
    const mounted = executor.logMounts.at(-1);
    expect(mounted?.readOnly).toBe(true);
    expect(Object.keys(mounted?.files ?? {}).sort()).toEqual(
      ["index.json", `${runId}/events.jsonl`, `${runId}/meta.json`, `${runId}/stderr.log`].sort(),
    );
    const all = Object.values(mounted?.files ?? {}).join("\n");
    expect(all).not.toContain("oauth-secret");
    expect(all).toContain("[REDACTED]");
    const prompt = executor.calls.at(-1)?.command[2] ?? "";
    expect(prompt).toMatch(
      new RegExp(
        `- \\[要求要件・1回目\\] 実行 ${runId} .*：実行中（.+ 時点までのログの写し。この後も続く）：`,
      ),
    );
    expect(prompt).toContain("events.jsonl の末尾から読んでください");
    // 質問しても、実行中の工程は止めない
    expect(executor.killed).toEqual([]);
    expect(service.get(id)?.task.status).toBe("running");

    executor.finishHeld(runId, out("# 要求要件"));
    await running;
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
        out("# 要求要件"),
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
    const reqRun = runIdOf(service, id, "requirements")?.runId;
    await service.askQuestion(id, { text: "1つ目" }).answered;
    const chatRun = (
      service.get(id)?.activity.findLast((e) => e.type === "QuestionAnswered")?.payload as
        | { runId?: string }
        | undefined
    )?.runId;
    await service.askQuestion(id, { text: "2つ目" }).answered;
    const prompt = executor.calls.at(-1)?.command[2] ?? "";
    expect(prompt).toContain(`- [オーケストレーター・1回目] 実行 ${orchestratorRun} `);
    expect(prompt).toContain(`- [要求要件・1回目] 実行 ${reqRun} `);
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

  it("API：プロジェクトを消したら、実在する実行の記録（ログ・生のファイル・元のファイルの一覧と中身）とタスクを 404 にする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const { service, executor } = makeService(activity, [completed(1_000)], { sessionLogs });
    executor.sessionFiles = claudeFiles("oauth-secret");
    const app = createApp(service, token);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const runId = runIdOf(service.get(task.id)?.activity, "AgentRunCompleted") ?? "";
    const mainPath = "projects/-workspace/main-session.jsonl";
    const paths = [
      `/api/tasks/${task.id}`,
      `/api/tasks/${task.id}/runs/${runId}/log`,
      `/api/tasks/${task.id}/runs/${runId}/files/events`,
      `/api/tasks/${task.id}/runs/${runId}/files/stderr`,
      `/api/tasks/${task.id}/runs/${runId}/agent-files`,
      `/api/tasks/${task.id}/runs/${runId}/agent-files/raw?path=${encodeURIComponent(mainPath)}`,
    ];
    const statuses = async () =>
      Promise.all(paths.map(async (path) => (await app.request(path, { headers: auth })).status));
    // 消す前は、どれも読める
    expect(await statuses()).toEqual(paths.map(() => 200));
    await service.cancel(task.id);
    service.deleteProject("default");
    expect(await statuses()).toEqual(paths.map(() => 404));
    // 記録そのものは残す
    expect(sessionLogs.read(task.id, runId)).toBeTruthy();
    activity.close();
  });
});

describe("時間切れで止めた実行の再開（PBI-280）", () => {
  const timeout = (minutes = 3): AgentOutcome => ({
    kind: "failed",
    reason: "error",
    message: message("run.timeout", { minutes }),
  });
  const argAfter = (inv: Invocation | undefined, name: string) => {
    const i = inv?.command.indexOf(name) ?? -1;
    return i >= 0 ? inv?.command[i + 1] : undefined;
  };
  /** Claude Code の振る舞いをまねる：--resume なら同じ ID のセッションに書き足し、なければ新しいセッション。 */
  const claudeId = (inv: Invocation, runId: string) =>
    argAfter(inv, "--resume") ?? `session-${runId}`;
  const emulateClaude = (executor: FakeExecutor) => {
    executor.appendSessionFiles = true;
    executor.sessionIdOf = claudeId;
    executor.sessionFiles = (inv, runId) => ({
      [`projects/-workspace/${claudeId(inv, runId)}.jsonl`]: `${JSON.stringify({ type: "user", run: runId })}\n`,
    });
  };
  const codexAgent = agent({
    id: "codex-key",
    runtime: "codex",
    auth: { mode: "api-key", secret: "openai-key" },
  });
  const emulateCodex = (executor: FakeExecutor) => {
    const codexId = (inv: Invocation, runId: string) =>
      argAfter(inv, "resume") ?? `thread-${runId}`;
    executor.appendSessionFiles = true;
    executor.sessionIdOf = codexId;
    executor.sessionFiles = (inv, runId) => ({
      [`sessions/2026/11/02/rollout-2026-11-02T10-00-00-${codexId(inv, runId)}.jsonl`]: `${JSON.stringify({ run: runId })}\n`,
    });
  };
  const setup = (outcomes: AgentOutcome[], options: Parameters<typeof makeService>[2] = {}) => {
    const activity = new SqliteActivityStore(dbPath);
    const sessionLogs = new SessionLogStore(join(dir, "runs"));
    const made = makeService(activity, outcomes, { sessionLogs, ...options });
    return { activity, sessionLogs, ...made };
  };
  type Continued = Extract<EventInput, { type: "AgentRunContinued" }>["payload"];
  const continuedOf = (service: TaskService, id: string): Continued[] =>
    (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AgentRunContinued" ? [e.payload] : [],
    );
  const timedOutOf = (service: TaskService, id: string) =>
    (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AgentRunTimedOut" ? [e.payload] : [],
    );
  const runIds = (service: TaskService, id: string) =>
    (service.get(id)?.activity ?? []).flatMap((e) =>
      e.type === "AgentRunStarted" ? [e.payload.runId] : [],
    );
  const NOTE = "【時間切れからの再開】";
  /** 時間切れで止まった後、再開してもう一度実行する。 */
  const retry = async (service: TaskService, id: string) => {
    expect(service.get(id)?.task.status).toBe("paused");
    service.resume(id, {});
    await service.runNext(id);
  };

  it("Claude Code：時間切れで止めた実行は、再開したときに同じセッションの続きから進め、時間切れで再開したことを伝える", async () => {
    const { activity, service, executor } = setup([timeout(), completed(1_000), completed(1_000)]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const [first] = runIds(service, task.id);
    expect(argAfter(executor.calls[0], "--resume")).toBeUndefined();
    expect(executor.stdins[0]).not.toContain(NOTE);
    expect(timedOutOf(service, task.id)).toEqual([
      {
        runId: first,
        role: "requirements",
        agentId: "claude-subscription",
        runtime: "claude-code",
        minutes: 3,
      },
    ]);
    expect(continuedOf(service, task.id)).toEqual([]);

    await retry(service, task.id);
    // 止めた実行のセッションを、元のファイルごと戻して再開する
    expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${first}`);
    expect(executor.calls[1]?.command).not.toContain("--fork-session");
    expect(Object.keys(executor.restored[1] ?? {})).toEqual([
      `projects/-workspace/session-${first}.jsonl`,
    ]);
    // 時間切れで止めて再開したことと、元の指示を渡す
    expect(executor.stdins[1]).toContain(NOTE);
    expect(executor.stdins[1]).toContain("上限の 3 分");
    expect(executor.stdins[1]).toContain(executor.stdins[0] ?? "unreachable");
    const [second] = runIds(service, task.id).slice(-1);
    expect(continuedOf(service, task.id)).toEqual([
      {
        runId: second,
        role: "requirements",
        agentId: "claude-subscription",
        runtime: "claude-code",
        mode: "resumed",
        stoppedRunId: first,
        sessionId: `session-${first}`,
      },
    ]);
    // 完了した後の次の工程は、前の続きではない（新しいセッション）
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    service.approve(task.id, { step: "requirements", submission: 1 });
    await service.runNext(task.id);
    expect(executor.calls).toHaveLength(3);
    expect(argAfter(executor.calls[2], "--resume")).toBeUndefined();
    expect(executor.stdins[2]).not.toContain(NOTE);
    expect(continuedOf(service, task.id)).toHaveLength(1);
    activity.close();
  });

  it.each(["projectImagesConfig", "runContext", "executeLogged"])(
    "複数指定の実行前の %s が例外になっても時間切れのセッションを続ける",
    async (failure) => {
      const projects = projectsWithAccount();
      const urls = ["https://github.com/acme/api", "https://github.com/acme/web"];
      projects.put("default", {
        name: "デフォルト",
        targets: urls.map((target) => ({ scope: "repo" as const, target })),
        githubAccounts: { "github.com": "me" },
      });
      const activity = new SqliteActivityStore(dbPath);
      const id = "resume-multiple";
      activity.append({
        taskId: id,
        projectId: "default",
        events: [
          {
            actor: "person",
            event: {
              type: "TaskCreated",
              payload: {
                title: "A",
                body: "",
                start: "sacty",
                noRepo: true,
                repos: urls,
                budgetCapUsd: 1,
              },
            },
          },
          {
            actor: "orchestrator",
            event: {
              type: "StepsChosen",
              payload: {
                steps: ["requirements", "design", "implement"],
                plan: "standard",
                reason: "理由",
                costUsd: 0,
              },
            },
          },
        ],
      });
      const sessionLogs = new SessionLogStore(join(dir, "runs"));
      const { service, executor } = makeService(activity, [timeout(), completed(1_000)], {
        projects,
        sessionLogs,
      });
      emulateClaude(executor);
      const task = { id };
      await service.runNext(task.id);
      const [first] = runIds(service, task.id);
      const internal = service as unknown as Record<string, (...args: never[]) => never>;
      const spy = vi.spyOn(internal, failure).mockImplementationOnce(() => {
        throw new Error("image settings failed");
      });
      if (failure === "executeLogged") {
        const failures = service
          .get(task.id)
          ?.activity.filter((e) => e.type === "AgentRunFailed").length;
        await expect(retry(service, task.id)).rejects.toThrow("image settings failed");
        expect(
          service.get(task.id)?.activity.filter((e) => e.type === "AgentRunFailed"),
        ).toHaveLength(failures ?? 0);
        spy.mockRestore();
        activity.close();
        return;
      }
      await retry(service, task.id);
      expect(executor.calls).toHaveLength(1);
      expect(
        service
          .get(task.id)
          ?.activity.filter((e) => e.type === "AgentRunFailed")
          .at(-1)?.payload,
      ).toMatchObject({ preparationFailed: true });
      spy.mockRestore();
      await retry(service, task.id);
      expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${first}`);
      activity.close();
    },
  );

  it("何度か時間切れで止めても、そのたびに同じセッションの続きから進み、最後は完了まで進む", async () => {
    const { activity, service, executor } = setup([
      timeout(),
      timeout(),
      timeout(),
      completed(1_000),
    ]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const [first] = runIds(service, task.id);
    await retry(service, task.id);
    await retry(service, task.id);
    await retry(service, task.id);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    expect(executor.calls).toHaveLength(4);
    // 3 回とも最初のセッションを再開し、戻したファイルには、それまでの会話が積み重なっている
    for (const i of [1, 2, 3])
      expect(argAfter(executor.calls[i], "--resume")).toBe(`session-${first}`);
    const path = `projects/-workspace/session-${first}.jsonl`;
    expect(executor.restored[1]?.[path]?.split("\n").filter(Boolean)).toHaveLength(1);
    expect(executor.restored[2]?.[path]?.split("\n").filter(Boolean)).toHaveLength(2);
    expect(executor.restored[3]?.[path]?.split("\n").filter(Boolean)).toHaveLength(3);
    expect(timedOutOf(service, task.id)).toHaveLength(3);
    const continued = continuedOf(service, task.id);
    expect(continued.map((c) => c.mode)).toEqual(["resumed", "resumed", "resumed"]);
    // 続けた先は、直前の実行（時間切れで止めた実行）
    const ids = runIds(service, task.id);
    expect(continued.map((c) => c.stoppedRunId)).toEqual(ids.slice(0, 3));
    activity.close();
  });

  it("Codex：resume で同じスレッドの続きから進める", async () => {
    const { activity, service, executor } = setup([timeout(), completed(1_000)], {
      config: configOf(codexAgent),
      secrets: { "openai-key": "sk-secret" },
    });
    emulateCodex(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const [first] = runIds(service, task.id);
    expect(executor.calls[0]?.command).not.toContain("resume");
    await retry(service, task.id);
    expect(argAfter(executor.calls[1], "resume")).toBe(`thread-${first}`);
    expect(Object.keys(executor.restored[1] ?? {})[0]).toMatch(/^sessions\/.*thread-/);
    expect(executor.stdins[1]).toContain(NOTE);
    expect(continuedOf(service, task.id)[0]).toMatchObject({
      mode: "resumed",
      runtime: "codex",
      sessionId: `thread-${first}`,
      stoppedRunId: first,
    });
    activity.close();
  });

  it("時間切れ以外で止まった実行は、再開しても前のセッションを続けない（今までどおり）", async () => {
    const { activity, service, executor } = setup([
      { kind: "failed", reason: "error", message: "exit code 1" },
      completed(1_000),
    ]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    await retry(service, task.id);
    expect(argAfter(executor.calls[1], "--resume")).toBeUndefined();
    expect(executor.stdins[1]).not.toContain(NOTE);
    expect(timedOutOf(service, task.id)).toEqual([]);
    expect(continuedOf(service, task.id)).toEqual([]);
    activity.close();
  });

  it("セッションの記録が無いとき（元のファイルを写せなかった）は、最初から実行し直し、その理由を作業履歴に残す", async () => {
    const { activity, service, executor } = setup([timeout(), completed(1_000)]);
    // エージェントが元のファイルを残さない
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const [first] = runIds(service, task.id);
    expect(timedOutOf(service, task.id)).toHaveLength(1);
    await retry(service, task.id);
    expect(argAfter(executor.calls[1], "--resume")).toBeUndefined();
    expect(executor.stdins[1]).not.toContain(NOTE);
    expect(continuedOf(service, task.id)).toMatchObject([
      { mode: "restarted", reason: "no_session", stoppedRunId: first },
    ]);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    activity.close();
  });

  it("コンテナの停止を確かめられず元のファイルを写さなかったときは、続けずに最初から実行し直す", async () => {
    const { activity, service, executor } = setup([timeout(), completed(1_000)]);
    emulateClaude(executor);
    executor.containerUnconfirmed = true;
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    executor.containerUnconfirmed = false;
    // 動いたままのコンテナがあるかもしれないので、確認してから再開する
    service.resume(task.id, {}, { containersConfirmed: true });
    await service.runNext(task.id);
    expect(argAfter(executor.calls[1], "--resume")).toBeUndefined();
    expect(continuedOf(service, task.id)).toMatchObject([
      { mode: "restarted", reason: "no_session" },
    ]);
    activity.close();
  });

  it("エージェントを変えて再開したときは、続けずに最初から実行し直す", async () => {
    const strong = agent({ id: "strong", model: "claude-opus-5-5" });
    const base = (configOf(agent())() as { ok: true; config: SactyConfig }).config;
    const { activity, service, executor } = setup([timeout(), completed(1_000)], {
      config: () => ({
        ok: true,
        config: { ...base, agents: { [agent().id]: agent(), strong: strong } },
      }),
    });
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    service.changeStepAgent(task.id, { step: "requirements", agent: "strong" });
    await retry(service, task.id);
    expect(argAfter(executor.calls[1], "--resume")).toBeUndefined();
    expect(executor.stdins[1]).not.toContain(NOTE);
    expect(continuedOf(service, task.id)).toMatchObject([
      { mode: "restarted", reason: "agent_changed", agentId: "strong" },
    ]);
    activity.close();
  });

  it("写したファイルが壊れていたら（記録したハッシュと違う）、続けずに最初から実行し直す", async () => {
    const { activity, service, executor, sessionLogs } = setup([timeout(), completed(1_000)]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const [first] = runIds(service, task.id);
    const files = join(
      sessionLogs.agentFilesDir(task.id, first ?? "") ?? "",
      "projects",
      "-workspace",
    );
    writeFileSync(join(files, `session-${first}.jsonl`), "tampered\n");
    await retry(service, task.id);
    expect(argAfter(executor.calls[1], "--resume")).toBeUndefined();
    expect(continuedOf(service, task.id)).toMatchObject([
      { mode: "restarted", reason: "files_broken" },
    ]);
    activity.close();
  });

  it("続けた実行の途中でデーモンが止まったら、進捗を含まない古い会話を続けず、最初から実行し直す", async () => {
    const { activity, service, executor } = setup([timeout(), HOLD]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const [first] = runIds(service, task.id);
    service.resume(task.id, {});
    // 続けた実行（2 回目）が動いている間に、デーモンが止まる（写した記録も続けた記録も残らない）
    void service.runNext(task.id);
    await executor.started.promise;
    expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${first}`);
    const second = runIds(service, task.id)[1];
    const { service: restarted, executor: restartedExecutor } = makeService(
      activity,
      [completed(1_000)],
      { sessionLogs: new SessionLogStore(join(dir, "runs")) },
    );
    emulateClaude(restartedExecutor);
    restarted.recoverInterrupted();
    expect(restarted.get(task.id)?.task.status).toBe("paused");
    expect(
      restarted
        .get(task.id)
        ?.activity.some((e) => e.type === "AgentRunFailed" && e.payload.runId === second),
    ).toBe(true);
    restarted.resume(task.id, {});
    await restarted.runNext(task.id);
    // 1 回目の古い会話は続けない
    expect(restartedExecutor.calls).toHaveLength(1);
    expect(argAfter(restartedExecutor.calls[0], "--resume")).toBeUndefined();
    expect(restartedExecutor.stdins[0]).not.toContain(NOTE);
    expect(restarted.get(task.id)?.task.status).toBe("awaiting_approval");
    activity.close();
  });

  it("再開を指定したのに別のセッションで始めたときは、続けたとは記録せず、理由を残す", async () => {
    const { activity, service, executor } = setup([timeout(), completed(1_000)]);
    emulateClaude(executor);
    // いつも新しいセッションで始めるエージェント
    executor.sessionIdOf = (_inv, runId) => `session-${runId}`;
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    await retry(service, task.id);
    // 実行の前に続ける判断を記録し、続きではなかったと分かった後に記録し直す（新しい記録が優先される）
    expect(continuedOf(service, task.id)).toMatchObject([
      { mode: "resumed" },
      { mode: "restarted", reason: "resume_failed" },
    ]);
    activity.close();
  });

  it("AI が再開を拒んで失敗したときも、次の再開は同じ拒否を繰り返さず最初から実行し直す", async () => {
    const { activity, service, executor } = setup([
      timeout(),
      { kind: "failed", reason: "error", message: "No conversation found with session ID: x" },
      completed(1_000),
    ]);
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    await retry(service, task.id);
    // 実行の前に続ける判断を記録し、続きではなかったと分かった後に記録し直す（新しい記録が優先される）
    expect(continuedOf(service, task.id)).toMatchObject([
      { mode: "resumed" },
      { mode: "restarted", reason: "resume_failed" },
    ]);
    await retry(service, task.id);
    expect(executor.calls).toHaveLength(3);
    expect(argAfter(executor.calls[2], "--resume")).toBeUndefined();
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    activity.close();
  });

  describe("未完了で終わった実装の実行を、同じセッションの続きから進める（PBI-350）", () => {
    const out = (text: string): AgentOutcome => ({
      kind: "completed",
      output: text,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
    });
    const declare = (value: unknown) =>
      `\`\`\`${COMPLETION_FENCE}\n${JSON.stringify(value)}\n\`\`\``;
    /** 範囲の一部だけを実装して、未完了と申告する実行。 */
    const unfinished = (remaining: string[]) =>
      out(["**実装は未完了です。**", declare({ status: "incomplete", remaining })].join("\n\n"));
    const finished = (text = "# 実装の説明") =>
      out([text, declare({ status: "complete" })].join("\n\n"));
    const NOTE = "【未完了からの続き】";
    const FULL = "--- タスク ---";
    /** 実装だけのタスクを作る（要求要件・設計を省いた実装）。 */
    const begin = (outcomes: AgentOutcome[], options: Parameters<typeof makeService>[2] = {}) => {
      const pulls = new FakePulls();
      const repos = options?.repos ?? new FakeRepos();
      const made = setup(outcomes, {
        stepPullRequests: true,
        pulls,
        repos,
        planner: async () => ({
          steps: ["implement"],
          plan: "direct",
          reason: "依頼が明確",
          fallback: false,
          testCommand: "npm test",
          costUsd: 0,
          estimated: false,
        }),
        ...options,
      });
      const { id } = made.service.createTask({
        projectId: "default",
        title: "決済API",
        body: "タスクの本文",
      });
      return { ...made, pulls, repos, id };
    };
    /** 止まる（承認待ち・一時停止）まで進める。 */
    const settle = async (service: TaskService, id: string, max = 16) => {
      for (let i = 0; i < max; i++) {
        const status = service.get(id)?.task.status;
        if (status === "awaiting_approval" || status === "paused") return;
        await service.runNext(id);
      }
    };
    /** 実行のたびに、作業領域の内容の目印を変える（実装が進んだことにする）。 */
    const progress = (executor: FakeExecutor, repos: FakeRepos) => {
      let n = 0;
      executor.logLines = () => {
        n += 1;
        repos.tree = `${n}`.padStart(40, "0");
        return undefined;
      };
    };
    const count = (service: TaskService, id: string, type: string) =>
      (service.get(id)?.activity ?? []).filter((e) => e.type === type).length;

    it("Claude Code：未完了で終わった実装の次の実行は、同じセッションの続きから進め、続きの知らせの後に指示の全文を渡す（受け入れ条件 1・2）", async () => {
      const { activity, service, executor, pulls, repos, id } = begin([
        unfinished(["API の入力", "docs の更新"]),
        unfinished(["docs の更新"]),
        finished(),
      ]);
      emulateClaude(executor);
      progress(executor, repos);
      await settle(service, id);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(executor.calls).toHaveLength(3);
      const [first, second, third] = runIds(service, id);
      // 最初の実行は、新しいセッションで、指示の全文を渡す
      expect(argAfter(executor.calls[0], "--resume")).toBeUndefined();
      expect(executor.stdins[0]).toContain(FULL);
      expect(executor.stdins[0]).not.toContain(NOTE);
      // 2回目は、最初の実行のセッションを、元のファイルごと戻して続ける
      expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${first}`);
      expect(executor.calls[1]?.command).not.toContain("--fork-session");
      expect(Object.keys(executor.restored[1] ?? {})).toEqual([
        `projects/-workspace/session-${first}.jsonl`,
      ]);
      // 続きの知らせ：続きであること・提出していないこと・最後まで実装すること・出し直すこと
      const next = executor.stdins[1] ?? "";
      expect(next.startsWith(NOTE)).toBe(true);
      expect(next).toContain("sacty は提出していません");
      expect(next).toContain("この実行の中で、範囲のすべて");
      expect(next).toContain("省かずに出し直す");
      // その後に、指示の全文を続ける（タスクの範囲・前回の実行の状況・完了の申告の形）
      expect(next.indexOf(FULL)).toBeGreaterThan(next.indexOf(NOTE));
      expect(next).toContain("タスクの本文");
      expect(next).toContain("--- 前回の実行：実装が終わっていませんでした ---");
      expect(next).toContain("前回の申告にあった、残っていること：\n- API の入力\n- docs の更新");
      expect(next).toContain("--- 完了の申告 ---");
      // 3回目も同じセッションを続け、戻したファイルには、それまでの会話が積み重なっている
      expect(argAfter(executor.calls[2], "--resume")).toBe(`session-${first}`);
      const path = `projects/-workspace/session-${first}.jsonl`;
      expect(executor.restored[2]?.[path]?.split("\n").filter(Boolean)).toHaveLength(2);
      expect(executor.stdins[2]).toContain("残っていること：\n- docs の更新");
      expect(executor.stdins[2]).not.toContain("- API の入力");
      // 続けたことを、作業履歴に残す（未完了で終わった実行の続き）
      expect(continuedOf(service, id)).toEqual([
        {
          runId: second,
          role: "implement",
          agentId: "claude-subscription",
          runtime: "claude-code",
          mode: "resumed",
          stoppedRunId: first,
          sessionId: `session-${first}`,
          cause: "incomplete",
        },
        {
          runId: third,
          role: "implement",
          agentId: "claude-subscription",
          runtime: "claude-code",
          mode: "resumed",
          stoppedRunId: second,
          sessionId: `session-${first}`,
          cause: "incomplete",
        },
      ]);
      // 未完了の2回は提出せず、完了と申告した実行で、初めて PR を作る
      expect(count(service, id, "ImplementationIncomplete")).toBe(2);
      expect(pulls.calls).toHaveLength(1);
      activity.close();
    });

    it("続きの実行にも、その実行の時点の案内（始める前の取り込みで競合したファイル）を渡す", async () => {
      const repos = new FakeRepos();
      // 作業領域を用意した後にベースブランチ（main）が進み、実装を始める前の取り込みで競合する
      const conflicted = "src/conflicted.ts";
      repos.remote.main = "e".repeat(40);
      repos.mergeResult = { status: "conflicted", conflicts: [conflicted] };
      repos.markers = [conflicted];
      const { activity, service, executor, id } = begin([unfinished(["docs の更新"]), finished()], {
        repos,
        mergeBase: true,
      });
      emulateClaude(executor);
      progress(executor, repos);
      for (let i = 0; i < 8 && executor.calls.length < 2; i++) await service.runNext(id);
      expect(executor.calls).toHaveLength(2);
      const [first] = runIds(service, id);
      expect(executor.stdins[0]).toContain(conflicted);
      // 続きの実行は、同じセッションを続け、目印の残るファイルを伝える
      expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${first}`);
      const next = executor.stdins[1] ?? "";
      expect(next.startsWith(NOTE)).toBe(true);
      expect(next).toContain("ベースブランチとの競合");
      expect(next).toContain(`- ${conflicted}`);
      activity.close();
    });

    it("引き継いだ PR で、未完了の実行の後に足された指摘も、続きの指示に入れて、渡した指摘として記録する", async () => {
      const head = "f".repeat(40);
      const repos = new FakeRepos();
      repos.branchHeads["feature/retry"] = head;
      const feedback = (n: number, text: string): PullRequestFeedback => ({
        key: `review_comment:${n}`,
        kind: "review_comment",
        author: "bob",
        at: `2026-01-0${n}T00:00:00Z`,
        path: "src/retry.ts",
        line: n,
        body: text,
      });
      const made = setup([unfinished(["docs の更新"]), finished()], {
        repos,
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
      });
      const { activity, service, executor } = made;
      const pulls = made.pulls as FakePulls;
      pulls.prInfo = {
        ...pulls.prInfo,
        state: "open",
        headRef: "feature/retry",
        headRepo: "https://github.com/acme/app",
        baseRef: "main",
      };
      pulls.feedbackBy[12] = [feedback(1, "回数は定数にしてください")];
      emulateClaude(executor);
      // 最初の実行（未完了）の間に、PR に新しい指摘が足される
      let n = 0;
      executor.logLines = () => {
        n += 1;
        repos.tree = `${n}`.padStart(40, "0");
        if (n === 1) {
          pulls.feedbackBy[12] = [
            feedback(1, "回数は定数にしてください"),
            feedback(2, "待ち時間の上限も足してください"),
          ];
        }
        return undefined;
      };
      const { id } = service.createTask({
        projectId: "default",
        title: "PR #12 の指摘",
        body: "https://github.com/acme/app/pull/12 のレビューの指摘に対応する",
      });
      await settle(service, id);
      expect(service.get(id)?.task.continuedPullRequest?.number).toBe(12);
      expect(executor.calls).toHaveLength(2);
      const [first] = runIds(service, id);
      expect(executor.stdins[0]).toContain("回数は定数にしてください");
      expect(executor.stdins[0]).not.toContain("待ち時間の上限も足してください");
      // 続きの実行は、同じセッションを続け、新しい指摘を含む指示の全文を受け取る
      expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${first}`);
      const next = executor.stdins[1] ?? "";
      expect(next.startsWith(NOTE)).toBe(true);
      expect(next).toContain("回数は定数にしてください");
      expect(next).toContain("待ち時間の上限も足してください");
      // 渡した指摘だけを、渡したと記録する（実行ごと）
      const passed = (service.get(id)?.activity ?? []).flatMap((e) =>
        e.type === "ContinuedFeedbackPassed" ? [e.payload.keys] : [],
      );
      expect(passed).toEqual([["review_comment:1"], ["review_comment:1", "review_comment:2"]]);
      activity.close();
    });

    it("Codex：resume で同じスレッドの続きから進める", async () => {
      const { activity, service, executor, repos, id } = begin(
        [unfinished(["docs の更新"]), finished()],
        { config: configOf(codexAgent), secrets: { "openai-key": "sk-secret" } },
      );
      emulateCodex(executor);
      progress(executor, repos);
      await settle(service, id);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      const [first] = runIds(service, id);
      expect(executor.calls[0]?.command).not.toContain("resume");
      expect(argAfter(executor.calls[1], "resume")).toBe(`thread-${first}`);
      expect(executor.stdins[1]?.startsWith(NOTE)).toBe(true);
      expect(executor.stdins[1]).toContain(FULL);
      expect(continuedOf(service, id)).toMatchObject([
        { mode: "resumed", stoppedRunId: first, sessionId: `thread-${first}`, cause: "incomplete" },
      ]);
      activity.close();
    });

    it("一時停止を挟んだ続き（人が再開した）も、同じセッションを続け、補足を含む指示の全文を渡す。回数は数え直す（受け入れ条件 5）", async () => {
      const { activity, service, executor, pulls, id } = begin([
        unfinished(["docs の更新"]),
        unfinished(["docs の更新"]),
        finished(),
      ]);
      emulateClaude(executor);
      // 作業領域の内容の目印は変えない：続けても何も変わらなかったので、2回目で止まる
      await settle(service, id);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(service.get(id)?.task.pausedReason).toBe("incomplete");
      expect(service.get(id)?.task.pausedMessage).toMatchObject({
        params: { count: 2, stalled: true },
      });
      expect(executor.calls).toHaveLength(2);
      const [first] = runIds(service, id);
      service.resume(id, { note: "docs は docs/user に書く" });
      expect(service.get(id)?.task.incompleteRuns?.runs).toBe(0);
      await settle(service, id);
      expect(executor.calls).toHaveLength(3);
      // 人が再開した続きも、同じセッションを続ける
      expect(argAfter(executor.calls[2], "--resume")).toBe(`session-${first}`);
      const resumed = executor.stdins[2] ?? "";
      expect(resumed.startsWith(NOTE)).toBe(true);
      // 指示の全文（人の補足と、前回の実行の状況を含む）を続ける
      expect(resumed).toContain(FULL);
      expect(resumed).toContain("docs は docs/user に書く");
      expect(resumed).toContain("--- 前回の実行：実装が終わっていませんでした ---");
      expect(continuedOf(service, id).map((c) => [c.mode, c.cause])).toEqual([
        ["resumed", "incomplete"],
        ["resumed", "incomplete"],
      ]);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(pulls.calls).toHaveLength(1);
      activity.close();
    });

    it("再開を指定したのに別のセッションで始まっても、指示の全文が渡っている。続けたとは記録せず、理由を残す", async () => {
      const { activity, service, executor, pulls, repos, id } = begin([
        unfinished(["docs の更新"]),
        finished(),
      ]);
      emulateClaude(executor);
      // いつも新しいセッションで始めるエージェント
      executor.sessionIdOf = (_inv, runId) => `session-${runId}`;
      progress(executor, repos);
      await settle(service, id);
      const [first, second] = runIds(service, id);
      expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${first}`);
      // 前の会話を持たない実行にも、タスクの範囲と、前回の実行の状況が渡っている
      const next = executor.stdins[1] ?? "";
      expect(next).toContain(FULL);
      expect(next).toContain("タスクの本文");
      expect(next).toContain("--- 前回の実行：実装が終わっていませんでした ---");
      // 実行の前に続ける判断を記録し、続きではなかったと分かった後に記録し直す（新しい記録が優先される）
      expect(continuedOf(service, id)).toMatchObject([
        { runId: second, mode: "resumed", cause: "incomplete" },
        { runId: second, mode: "restarted", reason: "resume_failed", cause: "incomplete" },
      ]);
      // 範囲を知ったうえでの完了の申告なので、提出に進む
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(pulls.calls).toHaveLength(1);
      activity.close();
    });

    it("AI が再開を拒んで失敗したら、その結果は使わず、タスクを止めずに、新しいセッションで指示の全文から実行し直す", async () => {
      const { activity, service, executor, pulls, repos, id } = begin([
        unfinished(["docs の更新"]),
        { kind: "failed", reason: "error", message: "No conversation found with session ID: x" },
        unfinished(["docs の更新"]),
        finished(),
      ]);
      emulateClaude(executor);
      progress(executor, repos);
      await settle(service, id);
      expect(executor.calls).toHaveLength(4);
      const [first, second, third, fourth] = runIds(service, id);
      // 2回目は、最初の実行のセッションを続けようとして、拒まれた
      expect(argAfter(executor.calls[1], "--resume")).toBe(`session-${first}`);
      // 3回目は、人の再開を待たずに、新しいセッションで、指示の全文から実行し直す（続きの知らせは付けない）
      expect(argAfter(executor.calls[2], "--resume")).toBeUndefined();
      expect(executor.stdins[2]).not.toContain(NOTE);
      expect(executor.stdins[2]).toContain(FULL);
      expect(executor.stdins[2]).toContain("--- 前回の実行：実装が終わっていませんでした ---");
      // 4回目は、3回目（新しいセッション）の続き
      expect(argAfter(executor.calls[3], "--resume")).toBe(`session-${third}`);
      expect(continuedOf(service, id)).toMatchObject([
        { runId: second, mode: "resumed", stoppedRunId: first },
        { runId: second, mode: "restarted", reason: "resume_failed", cause: "incomplete" },
        { runId: fourth, mode: "resumed", stoppedRunId: third },
      ]);
      // 拒まれた実行は失敗として残すが、タスクは止めず、エージェントも変えない
      const events = service.get(id)?.activity ?? [];
      expect(events.filter((e) => e.type === "AgentRunFailed").map((e) => e.payload.runId)).toEqual(
        [second],
      );
      expect(count(service, id, "TaskPaused")).toBe(0);
      expect(count(service, id, "AgentFellBack")).toBe(0);
      // 未完了の回数には、拒まれた実行を数えない
      expect(count(service, id, "ImplementationIncomplete")).toBe(2);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      expect(pulls.calls).toHaveLength(1);
      activity.close();
    });

    it("AI が再開を拒んだ実行の間に、人が一時停止を求めていたら、今までどおり一時停止する。再開すると最初から実行し直す", async () => {
      const { activity, service, executor, repos, id } = begin([
        unfinished(["docs の更新"]),
        { kind: "failed", reason: "error", message: "No conversation found with session ID: x" },
        finished(),
      ]);
      emulateClaude(executor);
      let n = 0;
      let pausing: Promise<unknown> | undefined;
      executor.logLines = () => {
        n += 1;
        repos.tree = `${n}`.padStart(40, "0");
        // 続きの実行（2回目）の間に、人が一時停止を求める
        if (n === 2) pausing = service.pause(id).catch(() => undefined);
        return undefined;
      };
      await settle(service, id);
      await pausing;
      expect(executor.calls).toHaveLength(2);
      expect(service.get(id)?.task.status).toBe("paused");
      expect(service.get(id)?.task.pausedReason).toBe("manual");
      service.resume(id, {});
      await settle(service, id);
      expect(executor.calls).toHaveLength(3);
      expect(argAfter(executor.calls[2], "--resume")).toBeUndefined();
      expect(executor.stdins[2]).not.toContain(NOTE);
      expect(executor.stdins[2]).toContain(FULL);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      activity.close();
    });

    it("セッションを続けられないとき（写したファイルが無い）は、最初から実行し直して、理由を作業履歴に残す（受け入れ条件 3）", async () => {
      const { activity, service, executor, repos, id } = begin([
        unfinished(["docs の更新"]),
        finished(),
      ]);
      // セッションのファイルを書かない（写すものが無い）
      progress(executor, repos);
      await settle(service, id);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      const [first, second] = runIds(service, id);
      expect(argAfter(executor.calls[1], "--resume")).toBeUndefined();
      // 最初から実行し直すので、指示の全文と、前回の実行の状況を渡す
      expect(executor.stdins[1]).not.toContain(NOTE);
      expect(executor.stdins[1]).toContain(FULL);
      expect(executor.stdins[1]).toContain("--- 前回の実行：実装が終わっていませんでした ---");
      expect(continuedOf(service, id)).toEqual([
        {
          runId: second,
          role: "implement",
          agentId: "claude-subscription",
          runtime: "claude-code",
          mode: "restarted",
          stoppedRunId: first,
          reason: "no_session",
          cause: "incomplete",
        },
      ]);
      activity.close();
    });

    it("完了して提出に進んだ実装の次の実行（差し戻しのやり直し）は、続きにしない", async () => {
      const { activity, service, executor, repos, id } = begin([finished(), finished("# v2")]);
      emulateClaude(executor);
      progress(executor, repos);
      await settle(service, id);
      expect(service.get(id)?.task.status).toBe("awaiting_approval");
      service.requestChanges(id, {
        step: "implement",
        submission: 1,
        target: "implement",
        comments: ["境界のテストを足す"],
      });
      await settle(service, id);
      expect(executor.calls).toHaveLength(2);
      expect(argAfter(executor.calls[1], "--resume")).toBeUndefined();
      expect(executor.stdins[1]).not.toContain(NOTE);
      expect(continuedOf(service, id)).toEqual([]);
      activity.close();
    });
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

  it("エラーの分析で引き継ぎのために書いたファイルを消せなくても、分析の結果と費用を記録し、警告を出す", async () => {
    const codex = agent({
      id: "codex-key",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    const claude = agent();
    // 工程を選ぶのは Claude Code、分析は Codex（保存したセッションと別のエージェントなので、引き継ぎを書く）
    let orchestrator = claude;
    const config = (): ConfigResult => {
      const base = configOf(claude)();
      return base.ok
        ? {
            ok: true,
            config: {
              ...base.config,
              agents: { [claude.id]: claude, [codex.id]: codex },
              stepAgents: { orchestrator },
            },
          }
        : base;
    };
    const analysis: AgentOutcome = {
      kind: "completed",
      output: "### 何が起きたか\n分析",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1000 },
    };
    const { service, executor, activity } = setup([plan, completed(1_000), analysis], {
      config,
      secrets: { "claude-oauth-token": "oauth-secret", "openai-key": "sk-secret" },
    });
    executor.sessionIdOf = (inv, runId) =>
      inv.parser === "codex-jsonl" ? `thread-${runId}` : `session-${runId}`;
    executor.sessionFiles = (inv, runId) =>
      inv.parser === "codex-jsonl"
        ? { [`sessions/2026/10/20/rollout-2026-10-20T10-00-00-thread-${runId}.jsonl`]: "{}\n" }
        : {
            [`projects/-workspace/session-${runId}.jsonl`]: [
              JSON.stringify({ type: "user", message: { content: "工程を選んで" } }),
              JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "設計は要らないと考えた" }] },
              }),
            ].join("\n"),
          };
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    expect(stored(task.id).agentId).toBe(claude.id);
    orchestrator = codex;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    removal.fail = /_handoff/;
    try {
      await service.analyzeErrors(task.id).analyzed;
      expect(usedOf(service, task.id).at(-1)).toMatchObject({
        agentId: "codex-key",
        reason: "agent_changed",
        handoffFrom: { agentId: claude.id },
      });
      expect(service.get(task.id)?.task.errorAnalyses[0]?.result?.text).toContain("分析");
      expect(service.get(task.id)?.activity.at(-1)).toMatchObject({
        type: "ErrorAnalyzed",
        payload: { runResult: "completed", costUsd: 0.015 },
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("引き継ぎのために書いたファイルを消せませんでした"),
        expect.stringContaining("EACCES"),
      );
    } finally {
      removal.fail = undefined;
      warn.mockRestore();
      activity.close();
    }
  });

  it("失敗して代わりのエージェント（別の AI）に切り替えたら、前のセッションのやり取りを読み取り専用で引き継ぐ", async () => {
    const codex = agent({
      id: "codex-key",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    const claude = agent({ fallback: ["codex-key"] });
    const config = (): ConfigResult => {
      const base = configOf(claude)();
      return base.ok
        ? {
            ok: true,
            config: { ...base.config, agents: { [claude.id]: claude, [codex.id]: codex } },
          }
        : base;
    };
    const { service, executor, activity } = setup([unreadable, plan, completed(1_000)], {
      config,
      secrets: { "claude-oauth-token": "oauth-secret", "openai-key": "sk-secret" },
    });
    executor.sessionIdOf = (inv, runId) =>
      inv.parser === "codex-jsonl" ? `thread-${runId}` : `session-${runId}`;
    executor.sessionFiles = (inv, runId) =>
      inv.parser === "codex-jsonl"
        ? { [`sessions/2026/10/20/rollout-2026-10-20T10-00-00-thread-${runId}.jsonl`]: "{}\n" }
        : {
            [`projects/-workspace/session-${runId}.jsonl`]: [
              JSON.stringify({ type: "user", message: { content: "工程を選んで" } }),
              JSON.stringify({
                type: "assistant",
                message: { content: [{ type: "text", text: "設計は要らないと考えた" }] },
              }),
            ].join("\n"),
          };
    // 実行の間に、引き継ぐやり取りを読んでおく（実行の後に消される）
    const handoffs: (string | undefined)[] = [];
    executor.respond = (inv) => {
      const mount = inv.mounts?.find((m) => m.containerPath === "/sacty-handoff");
      handoffs.push(
        mount?.readOnly
          ? readFileSync(join(mount.hostPath, "previous-session.md"), "utf8")
          : undefined,
      );
      return undefined;
    };
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id); // Claude Code：工程を読み取れない（止めずに、代わりのエージェントへ）
    expect(service.get(task.id)?.task.status).toBe("queued");
    await service.runNext(task.id); // Codex：引き継いで工程を選ぶ
    expect(executor.calls[1]?.command.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(handoffs[0]).toBeUndefined();
    expect(handoffs[1]).toContain("設計は要らないと考えた");
    expect(executor.stdins[1]).toContain("/sacty-handoff/previous-session.md");
    expect(executor.stdins[1]).toContain("claude-subscription");
    const used = usedOf(service, task.id)[1];
    expect(used).toMatchObject({
      agentId: "codex-key",
      runtime: "codex",
      mode: "new",
      reason: "agent_changed",
      handoffFrom: { agentId: "claude-subscription", truncated: false },
    });
    expect(used?.handoffFrom?.sessionId).toMatch(/^session-/);
    expect(service.get(task.id)?.task.steps.length).toBeGreaterThan(0);
    // 引き継ぎのために書いたファイルは、実行の後に消す
    expect(readdirSync(join(dir, "workspaces", "_handoff"))).toEqual([]);
    activity.close();
  });

  it("代わりのエージェントが正常に終わって答えを読み取れなくても、期限が過ぎた元のエージェントには戻らずに止める", async () => {
    const codex = agent({
      id: "codex-key",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    const claude = agent({ fallback: ["codex-key"] });
    const config = (): ConfigResult => {
      const base = configOf(claude)();
      return base.ok
        ? {
            ok: true,
            config: {
              ...base.config,
              agents: { [claude.id]: claude, [codex.id]: codex },
              fallbackCooldownMs: 60_000,
            },
          }
        : base;
    };
    let now = Date.parse("2026-10-20T00:00:00Z");
    const { service, executor, activity } = setup([unreadable, unreadable, plan], {
      config,
      secrets: { "claude-oauth-token": "oauth-secret", "openai-key": "sk-secret" },
      now: () => now,
    });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id); // Claude Code：工程を読み取れない（代わりへ）
    expect(service.get(task.id)?.task.status).toBe("queued");
    now += 61_000;
    await service.runNext(task.id); // Codex：正常に終わったが、工程を読み取れない
    expect(executor.calls).toHaveLength(2);
    expect(executor.calls[1]?.command.slice(0, 2)).toEqual(["codex", "exec"]);
    expect(service.get(task.id)?.task.status).toBe("paused");
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
    // 指示（最後の引数）と `--` の直前に resume と ID
    expect(command.slice(-4, -2)).toEqual(["resume", `thread-${firstRun}`]);
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

  it("再開を断った実行の使用量が不明なら、始め直した実行が成功しても不明の印を残し、費用に数える（PBI-281）", async () => {
    const rejected: AgentOutcome = {
      kind: "failed",
      reason: "error",
      message: "No conversation found with session ID: x",
      costUnknown: true,
    };
    const { activity, service, executor } = setup([unreadable, rejected, plan, completed(1_000)], {
      defaultContext: DEFAULT_CONTEXT_DIR,
    });
    emulateClaude(executor);
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    const before = service.get(task.id)?.task.budget.unknownRuns ?? 0;
    await rerunOrchestrator(service, task.id);
    const chosen = service.get(task.id)?.activity.findLast((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.costUnknown).toBe(true);
    expect(service.get(task.id)?.task.budget.unknownRuns).toBe(before + 1);
    activity.close();
  });

  it("AI が再開を受け付けなかったら、新しいセッションで始め直し、理由と受け付けなかった実行を残す", async () => {
    const rejected: AgentOutcome = {
      kind: "failed",
      reason: "error",
      message: "No conversation found with session ID: x",
    };
    const { activity, service, executor } = setup([unreadable, rejected, plan, completed(1_000)], {
      defaultContext: DEFAULT_CONTEXT_DIR,
    });
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
    // 用意したコンテキストの記録は、受け付けなかった実行と、始め直した実行の両方に残る（PR #162 レビュー指摘）
    const resolvedRuns = (service.get(task.id)?.activity ?? []).flatMap((e) =>
      e.type === "ContextResolved" ? [e.payload.runId] : [],
    );
    // （4 つ目は、その後の工程の実行）
    expect(resolvedRuns.slice(0, 3)).toEqual([firstRun, retried?.failedRunId, retried?.runId]);
    expect(executor.seeds[2] ?? {}).toHaveProperty(["skills/plan-steps/SKILL.md"]);
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
    expect(executor.calls[1]?.command.slice(-4, -2)).toEqual(["resume", `thread-${firstRun}`]);
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
    // 1つ目が終わる前に、2つ目が始まっていないこと（何も起きないこと）を見るための猶予。1つ目が始まった後に置く
    await idleFor(50);
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

describe("エージェントの段階のサブエージェント（PBI-119）", () => {
  const tiered = (a: AgentConfig): (() => ConfigResult) => {
    const base = (configOf(a)() as { ok: true; config: SactyConfig }).config;
    return () => ({
      ok: true,
      config: {
        ...base,
        tierAgents: {
          "claude-code": {
            lite: agent({
              id: "claude_lite",
              model: "claude-haiku-5-5",
              // 別のトークンで動く段階は、親では使えない
              auth: { mode: "subscription", secret: "another-token" },
            }),
            standard: agent({ id: "claude_standard", model: "claude-sonnet-5-5" }),
            ultimate: agent({
              id: "claude_ultimate",
              model: "claude-opus-5-5",
              reasoning_effort: "high",
            }),
          },
          codex: {
            standard: agent({
              id: "codex_standard",
              runtime: "codex",
              model: "gpt-6-sol",
              auth: { mode: "api-key", secret: "openai-key" },
            }),
          },
        },
      },
    });
  };

  it("工程の実行で、親と同じ接続先の段階を接頭辞を外した名前で置き、置いた段階と置かなかった段階を作業履歴に残す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: tiered(agent()),
      defaultContext: DEFAULT_CONTEXT_DIR,
    });
    const task = service.createTask({ projectId: "default", title: "段階を置く" });
    await service.runNext(task.id);
    const placed = executor.seeds[0] ?? {};
    expect(placed["agents/standard.md"]).toContain('model: "claude-sonnet-5-5"');
    expect(placed["agents/ultimate.md"]).toContain('effort: "high"');
    // 接続先が違う段階と、別の runtime の段階は置かない
    expect(placed["agents/lite.md"]).toBeUndefined();
    expect(Object.keys(placed).some((p) => p.endsWith(".toml"))).toBe(false);
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.tiers).toEqual([
      { tier: "standard", agentId: "claude_standard", model: "claude-sonnet-5-5" },
      {
        tier: "ultimate",
        agentId: "claude_ultimate",
        model: "claude-opus-5-5",
        reasoningEffort: "high",
      },
    ]);
    expect(resolved?.type === "ContextResolved" && resolved.payload.warnings).toContainEqual(
      message("agents.tierConnectionDiffers", {
        tier: "lite",
        id: "claude_lite",
        parent: "claude-subscription",
      }),
    );
    activity.close();
  });

  it("Codex の工程には、Codex の段階を agents/<段階>.toml で置く", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const codex = agent({
      id: "codex-key",
      runtime: "codex",
      auth: { mode: "api-key", secret: "openai-key" },
    });
    const { service, executor } = makeService(activity, [completed(20_000)], {
      config: tiered(codex),
      secrets: { "openai-key": "sk-test", "github-token": "ghp_secret" },
      defaultContext: DEFAULT_CONTEXT_DIR,
    });
    const task = service.createTask({ projectId: "default", title: "Codex の段階" });
    await service.runNext(task.id);
    const placed = executor.seeds[0] ?? {};
    expect(placed["agents/standard.toml"]).toContain('model = "gpt-6-sol"');
    expect(Object.keys(placed).some((p) => p.endsWith(".md") && p.startsWith("agents/"))).toBe(
      false,
    );
    const resolved = service.get(task.id)?.activity.find((e) => e.type === "ContextResolved");
    expect(resolved?.type === "ContextResolved" && resolved.payload.tiers).toEqual([
      { tier: "standard", agentId: "codex_standard", model: "gpt-6-sol" },
    ]);
    activity.close();
  });

  it("コンテキストのプレビューにも、実行と同じ段階の定義と警告を出す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], {
      config: tiered(agent()),
      defaultContext: DEFAULT_CONTEXT_DIR,
    });
    const result = await service.projectContextPreview("default", "claude-code");
    expect(result && "preview" in result).toBe(true);
    if (!result || !("preview" in result)) return;
    const paths = result.preview.files.map((f) => f.path);
    expect(paths).toContain("agents/standard.md");
    expect(paths).toContain("agents/ultimate.md");
    expect(paths).not.toContain("agents/lite.md");
    expect(result.preview.files.find((f) => f.path === "agents/standard.md")?.generated).toBe(true);
    expect(result.preview.warnings).toContainEqual(
      message("agents.tierConnectionDiffers", {
        tier: "lite",
        id: "claude_lite",
        parent: "claude-subscription",
      }),
    );
    // Codex のプレビューは、Codex の段階。その runtime のエージェントが無ければ置かない
    const codex = await service.projectContextPreview("default", "codex");
    expect(codex && "preview" in codex && codex.preview.files.map((f) => f.path)).not.toContain(
      "agents/standard.toml",
    );
    activity.close();
  });

  /** ホストから見た起点を持つゲートウェイの偽物（登録と閉じたことを記録する）。 */
  const localGateway = () => {
    const registered: { mcp: unknown; platforms: unknown }[] = [];
    let closed = 0;
    const gateway: NonNullable<ServiceDeps["gateway"]> = {
      ...fakeGateway(),
      hostOrigin: () => "http://127.0.0.1:5001",
      platformsUrl: (token, origin = "http://host.docker.internal:5001") =>
        `${origin}/r/${token}/pf`,
      register: (_route, mcp, platforms) => {
        registered.push({ mcp, platforms });
        return {
          token: "sacty-gw-local",
          stats: () => ({ retries: 0, waitedMs: 0, statuses: [], gaveUp: false }),
          close: () => {
            closed += 1;
          },
        };
      },
    };
    return { gateway, registered, closed: () => closed };
  };
  const text = (session: LocalSessionView, path: string) => {
    const file = session.files.find((f) => f.path === path);
    return file ? Buffer.from(file.content, "base64").toString("utf8") : undefined;
  };

  it("ローカルのセッション：実行と同じ組み立てでコンテキストと段階を用意し、作業履歴には何も記録しない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], {
      config: tiered(agent()),
      defaultContext: DEFAULT_CONTEXT_DIR,
    });
    const before = activity.all().length;
    const result = await service.createLocalSession(
      "default",
      "claude-code",
      "/tmp/sacty-launch-a",
    );
    expect(result && "session" in result).toBe(true);
    if (!result || !("session" in result)) return;
    const { session } = result;
    expect(session.runtime).toBe("claude-code");
    const paths = session.files.map((f) => f.path);
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain("agents/standard.md");
    expect(paths).not.toContain("agents/lite.md");
    expect(text(session, "CLAUDE.md")?.length).toBeGreaterThan(0);
    expect(activity.all()).toHaveLength(before);
    expect(service.closeLocalSession(session.id)).toBe(true);
    expect(service.closeLocalSession(session.id)).toBe(false);
    expect(await service.createLocalSession("missing", "claude-code", "/tmp/x")).toBeUndefined();
    activity.close();
  });

  it("ローカルのセッション：Codex の規則のスキルの場所は、CLI の一時ディレクトリの絶対パスで書く", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [], { defaultContext: DEFAULT_CONTEXT_DIR });
    const result = await service.createLocalSession("default", "codex", "/tmp/sacty-launch-b");
    if (!result || !("session" in result)) throw new Error("no session");
    expect(text(result.session, "AGENTS.md")).toContain("/tmp/sacty-launch-b/skills/");
    activity.close();
  });

  it("ローカルのセッション：外部 PF は、このセッションのトークンの URL と案内で渡し、ゲートウェイを使えなければ注意にする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const local = localGateway();
    const withGateway = makeService(activity, [], {
      config: configOf(agent(), 1, [jiraPlatform()]),
      gateway: local.gateway,
    }).service;
    const ok = await withGateway.createLocalSession(
      "default",
      "claude-code",
      "/tmp/sacty-launch-e",
    );
    if (!ok || !("session" in ok)) throw new Error("no session");
    expect(ok.session.env.SACTY_PF_URL).toBe("http://127.0.0.1:5001/r/sacty-gw-local/pf");
    expect(text(ok.session, "CLAUDE.md")).toContain("$SACTY_PF_URL/jira");
    expect(ok.session.warnings).not.toContainEqual(message("local.platformsUnavailable"));
    const without = makeService(activity, [], {
      config: configOf(agent(), 1, [jiraPlatform()]),
    }).service;
    const none = await without.createLocalSession("default", "claude-code", "/tmp/sacty-launch-f");
    if (!none || !("session" in none)) throw new Error("no session");
    expect(none.session.env.SACTY_PF_URL).toBeUndefined();
    expect(none.session.warnings).toContainEqual(message("local.platformsUnavailable"));
    activity.close();
  });

  it("ローカルのセッション：ホストの MCP サーバーは、ホストから見たゲートウェイの URL と、このセッションのトークンで渡し、終えたら登録を閉じる", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const cloud = toHostMcp("private-cloud", HostMcpFile.parse({ command: "cloud-mcp" }));
    const local = localGateway();
    const { service } = makeService(activity, [], {
      config: configOf(agent(), 1, [], [cloud]),
      gateway: local.gateway,
    });
    const result = await service.createLocalSession(
      "default",
      "claude-code",
      "/tmp/sacty-launch-c",
    );
    if (!result || !("session" in result)) throw new Error("no session");
    const { session } = result;
    expect(JSON.parse(text(session, "mcp.json") ?? "{}").mcpServers["private-cloud"]).toMatchObject(
      {
        type: "http",
        url: "http://127.0.0.1:5001/mcp/private-cloud",
      },
    );
    expect(session.env.SACTY_MCP_SECRET_0).toBe("Bearer sacty-gw-local");
    expect(session.mcpServers).toEqual(["private-cloud"]);
    expect(local.registered).toHaveLength(1);
    expect(local.closed()).toBe(0);
    service.closeLocalSession(session.id);
    expect(local.closed()).toBe(1);
    activity.close();
  });

  it("ローカルのセッション：Bedrock の AI の段階は、手元のログインで使えないことがあるので渡さず、注意にする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const bedrock = agent({
      id: "claude-bedrock",
      auth: { mode: "bedrock", secret: "bedrock-api-key", region: "us-east-2" },
    });
    const { service } = makeService(activity, [], {
      config: tiered(bedrock),
      defaultContext: DEFAULT_CONTEXT_DIR,
    });
    const result = await service.createLocalSession(
      "default",
      "claude-code",
      "/tmp/sacty-launch-d",
    );
    if (!result || !("session" in result)) throw new Error("no session");
    expect(result.session.files.some((f) => f.path.startsWith("agents/"))).toBe(false);
    expect(result.session.warnings).toContainEqual(
      message("local.tiersSkipped", { parent: "claude-bedrock", mode: "bedrock" }),
    );
    activity.close();
  });

  it("API キーの実行でも、段階を置いた実行の費用は推定にし、置かない実行は従来どおり実績にする", async () => {
    const keyed = agent({ id: "claude-key", auth: { mode: "api-key", secret: "claude-key" } });
    const run = async (withTiers: boolean) => {
      const activity = new SqliteActivityStore(dbPath);
      const base = (configOf(keyed)() as { ok: true; config: SactyConfig }).config;
      const { service } = makeService(activity, [completed(20_000)], {
        config: () => ({
          ok: true,
          config: withTiers
            ? {
                ...base,
                tierAgents: {
                  "claude-code": {
                    standard: agent({
                      id: "claude_standard",
                      model: "claude-sonnet-5-5",
                      auth: { mode: "api-key", secret: "claude-key" },
                    }),
                  },
                },
              }
            : base,
        }),
        secrets: { "claude-key": "sk-test", "github-token": "ghp_secret" },
        defaultContext: DEFAULT_CONTEXT_DIR,
      });
      const task = service.createTask({ projectId: "default", title: "概算の印" });
      await service.runNext(task.id);
      const done = service.get(task.id)?.activity.find((e) => e.type === "AgentRunCompleted");
      const estimated = done?.type === "AgentRunCompleted" ? done.payload.estimated : undefined;
      const budget = service.get(task.id)?.task.budget.estimated;
      activity.close();
      rmSync(dbPath, { force: true });
      return { estimated, budget };
    };
    expect(await run(true)).toEqual({ estimated: true, budget: true });
    expect(await run(false)).toEqual({ estimated: false, budget: false });
  });
});
