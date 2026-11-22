import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EventInput, StepKey, Task } from "@sacty/core";
import { MVP_STEPS, message, renderMessage, reworkTargets, STEP_PLANS } from "@sacty/core";
import { describe, expect, it, vi } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentExecutor } from "./agents/docker.js";
import type { Invocation } from "./agents/invocation.js";
import type { AgentOutcome } from "./agents/parse.js";
import { type ConfigResult, loadConfig, type SactyConfig } from "./config.js";
import { ContextMcpServers } from "./context-mcp.js";
import { AgentTimeoutError } from "./errors.js";
import { type HostMcpConnection, HostMcpFile, toHostMcp } from "./host-mcp.js";
import { notificationText } from "./notifier.js";
import { PlatformFile, toPlatform } from "./platforms.js";
import { buildOrchestratorPrompt, changeableSteps } from "./prompts.js";
import { MemorySecretStore, OnePasswordSecretStore, ResolvingSecretStore } from "./secrets.js";
import { awaitingIssueComment, type ServiceDeps, TaskService } from "./service.js";
import { SessionLogStore } from "./session-logs.js";
import { MemorySettingsStore } from "./settings.js";
import {
  agent,
  completed,
  configOf,
  current,
  dbPath,
  dir,
  FakeContexts,
  type FakeExecutor,
  FakeGitHub,
  FakePulls,
  FakeRepos,
  fakeGateway,
  ja,
  makeService,
  projectsWithAccount,
  stepReview,
  useTempDir,
} from "./testing/daemon.js";
import { idleFor, waitFor, waitForAssertion } from "./testing/wait.js";

useTempDir();

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
      price: { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 1 },
    });
    const strong = agent({
      id: "sol-high",
      price: { input: 1, cachedInput: 0.1, cacheWrite: 0, output: 10 },
    });
    const orchestrator = agent({
      id: "orchestrator",
      price: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0 },
    });
    const plan = {
      kind: "completed" as const,
      output:
        '```json\n{"sacty-steps": {"plan": "standard", "reason": "広い", "testCommand": "npm test"}}\n```',
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
    };
    // 要求要件の承認の後に、オーケストレーターが残りの工程を見直す（工程の見直し）
    const { service } = makeService(
      activity,
      [plan, completed(20_000), stepReview(), completed(20_000)],
      {
        realPlanner: true,
        config: () => ({
          ok: true,
          config: {
            ...(configOf(cheap)() as { ok: true; config: SactyConfig }).config,
            stepAgents: { orchestrator, requirements: strong },
          },
        }),
      },
    );
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    service.approve(task.id, { step: "requirements", submission: 1 });
    await service.runNext(task.id);
    const events = service.get(task.id)?.activity ?? [];
    const chosen = events.find((e) => e.type === "StepsChosen");
    expect(chosen?.type === "StepsChosen" && chosen.payload.agentId).toBe("orchestrator");
    // 工程の見直しも、オーケストレーターのエージェントで行う
    const reviewed = events.find((e) => e.type === "StepsSkipped");
    expect(reviewed?.type === "StepsSkipped" && reviewed.payload.agentId).toBe("orchestrator");
    // 要求要件は step_agents の sol-high、設計は default_agent
    const started = events
      .filter((e) => e.type === "AgentRunStarted")
      .map((e) => (e.type === "AgentRunStarted" ? `${e.payload.step}:${e.payload.agentId}` : ""));
    expect(started).toEqual(["requirements:sol-high", "design:luna-low"]);
    // 要求要件の費用は sol-high の単価（出力 20,000 × $10/100万 = $0.2）
    const done = events.find(
      (e) => e.type === "AgentRunCompleted" && e.payload.step === "requirements",
    );
    expect(done?.type === "AgentRunCompleted" && done.payload.costUsd).toBe(0.2);
    activity.close();
  });

  describe("実行の費用は、CLI の報告額を使い、報告が無ければモデルごとの単価で換算する（PBI-301）", () => {
    const opus = { input: 5, cachedInput: 0.25, cacheWrite: 6.25, output: 25 };
    const sonnet = { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 };
    /** 実行のログにあった値（Opus と Sonnet のサブエージェントを使った実行）。 */
    const modelUsages = [
      {
        model: "claude-opus-5-5",
        usage: { input: 104, output: 42590, cacheRead: 1500292, cacheWrite: 292045 },
      },
      {
        model: "claude-sonnet-5-5",
        usage: { input: 6, output: 866, cacheRead: 42459, cacheWrite: 19603 },
      },
    ];
    const usage = { input: 110, output: 43456, cacheRead: 1542751, cacheWrite: 311648 };
    const strong = agent({
      id: "claude_advanced",
      model: "claude-opus-5-5",
      price: opus,
      modelPrices: { "claude-opus-5-5": opus, "claude-sonnet-5-5": sonnet },
    });
    const run = async (outcome: AgentOutcome) => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [outcome], { config: configOf(strong, 100) });
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const got = service.get(task.id);
      const done = got?.activity.find((e) => e.type === "AgentRunCompleted");
      const recorded = got?.activity.filter((e) => e.type === "RunCostRecorded") ?? [];
      const result = { task: got?.task, done, recorded };
      activity.close();
      return result;
    };

    it("報告があれば、それを実行の費用にし、予算に入れる。出どころ（報告）と換算した額を作業履歴に残す", async () => {
      const { task, done, recorded } = await run({
        kind: "completed",
        output: "# 要求要件",
        usage,
        modelUsages,
        reportedCostUsd: 2.8945018,
      });
      expect(done?.type === "AgentRunCompleted" && done.payload.costUsd).toBeCloseTo(2.894502, 6);
      expect(task?.budget.usedUsd).toBeCloseTo(2.894502, 6);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.payload).toMatchObject({
        agentId: "claude_advanced",
        source: "reported",
        amountUsd: 2.894502,
      });
      // 設定の単価で換算した額は、報告と近い（設定の単価が実勢に近い）
      const converted =
        (recorded[0]?.payload as { convertedUsd: number } | undefined)?.convertedUsd ?? 0;
      expect(converted / 2.8945018).toBeGreaterThan(0.9);
      expect(converted / 2.8945018).toBeLessThan(1.3);
    });

    it("報告が無ければ、モデルごとの使用量を、そのモデルの単価で換算する（以前は全部を工程のエージェントの単価で換算した）", async () => {
      const { done, recorded } = await run({
        kind: "completed",
        output: "# 要求要件",
        usage,
        modelUsages,
      });
      // Opus は 3.265624、Sonnet は 0.0619254（Sonnet を Opus の単価で換算すると 0.1548135）
      expect(done?.type === "AgentRunCompleted" && done.payload.costUsd).toBeCloseTo(3.327549, 5);
      expect(recorded[0]?.payload).toMatchObject({ source: "converted" });
      expect(recorded[0]?.payload).not.toHaveProperty("unpricedModels");
    });

    it("単価が設定に無いモデルは工程のエージェントの単価で換算し、そのモデルを作業履歴に残す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const noSonnet = { ...strong, modelPrices: { "claude-opus-5-5": opus } };
      const { service } = makeService(
        activity,
        [{ kind: "completed", output: "# 要求要件", usage, modelUsages }],
        { config: configOf(noSonnet, 100) },
      );
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const recorded = service.get(task.id)?.activity.find((e) => e.type === "RunCostRecorded");
      expect(recorded?.payload).toMatchObject({
        source: "converted",
        unpricedModels: ["claude-sonnet-5-5"],
      });
      activity.close();
    });

    it("報告もモデルごとの使用量も無ければ（Codex など）、エージェントの単価で換算し、出どころ（換算）を記録する（PBI-302 D2）", async () => {
      const { done, recorded } = await run({
        kind: "completed",
        output: "# 要求要件",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
      });
      expect(done?.type === "AgentRunCompleted" && done.payload.costUsd).toBe(25);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]?.payload).toMatchObject({
        agentId: "claude_advanced",
        source: "converted",
        amountUsd: 25,
        convertedUsd: 25,
      });
      expect(recorded[0]?.payload).not.toHaveProperty("unpricedModels");
    });

    it("失敗した実行も、CLI の報告があればそれを費用にする", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [
          {
            kind: "failed",
            reason: "error",
            message: "API Error: 500",
            usage,
            modelUsages,
            reportedCostUsd: 2.5,
          },
        ],
        { config: configOf(strong, 100) },
      );
      const task = service.createTask({ projectId: "default", title: "決済API" });
      await service.runNext(task.id);
      const got = service.get(task.id);
      const failed = got?.activity.find((e) => e.type === "AgentRunFailed");
      expect(failed?.type === "AgentRunFailed" && failed.payload.costUsd).toBe(2.5);
      expect(got?.task.budget.usedUsd).toBe(2.5);
      expect(got?.activity.find((e) => e.type === "RunCostRecorded")?.payload).toMatchObject({
        source: "reported",
        amountUsd: 2.5,
      });
      activity.close();
    });
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
      {
        step: "requirements",
        agentId: "sol-high",
        authMode: plain.auth.mode,
        model: "gpt-sol",
        reasoningEffort: "high",
        // 使ったイメージの名前（PBI-318）
        image: "default",
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
      githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
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
    await waitForAssertion(() => expect(waits).toHaveLength(1));
    // 準備を待たずにエージェントを動かしていないこと（何も起きないこと）を見るための猶予。準備を待ち始めた後に置く
    await idleFor(20);
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
    await waitForAssertion(() => expect(waiting).toBe(true));
    // 準備は終わらないので、人の停止だけが待ちを抜ける（上限を待たない）。固まればテストの時間切れで落ちる
    await service.pause(task.id);
    await running;
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
      githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
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
      githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
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
      // 本文にする result の目印は、決まった塊を含める役割だけ（PBI-154）。このテストの工程には無い
      expect(call.preferResult).toBeUndefined();
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
        githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
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
      githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
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
        "「sacty-no-such-command-84」が、Sacty を動かすホストに見つかりません",
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
      githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
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
      githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
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
      githubUrl: (token) => `http://host.docker.internal:5001/r/${token}/github`,
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
      // 費用の出どころ（CLI が費用を報告しない実行は、換算した額。PBI-302 D2）
      "RunCostRecorded",
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

  describe("工程の組み合わせごとの予算（budget.per_plan_usd）", () => {
    const withPlanBudget = (): ConfigResult => {
      const base = configOf(agent())();
      return base.ok
        ? { ok: true, config: { ...base.config, budgetPerPlanUsd: { standard: 5 } } }
        : base;
    };
    const planner =
      (plan: "standard" | "skip-design"): ServiceDeps["planner"] =>
      async () => ({
        steps: [...STEP_PLANS[plan]],
        plan,
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      });

    it("選んだ組み合わせに予算があれば、タスクの予算の上限をそれにする", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [completed(1_000)], {
        config: withPlanBudget,
        planner: planner("standard"),
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      expect(task.budget.capUsd).toBe(1);
      await service.runNext(task.id);
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.payload).toMatchObject({ plan: "standard", budgetCapUsd: 5 });
      expect(service.get(task.id)?.task.budget.capUsd).toBe(5);
      activity.close();
    });

    it("予算を設定していない組み合わせは、タスクの予算（default_per_task_usd）のまま", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [completed(1_000)], {
        config: withPlanBudget,
        planner: planner("skip-design"),
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.payload).not.toHaveProperty("budgetCapUsd");
      expect(service.get(task.id)?.task.budget.capUsd).toBe(1);
      activity.close();
    });

    it("工程を選ぶ前に人が上限を上げていたら、その上限を残す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [completed(1_000)], {
        config: withPlanBudget,
        planner: planner("standard"),
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.pause(task.id);
      service.resume(task.id, { capUsd: 3 });
      await service.runNext(task.id);
      const chosen = service.get(task.id)?.activity.find((e) => e.type === "StepsChosen");
      expect(chosen?.payload).not.toHaveProperty("budgetCapUsd");
      expect(service.get(task.id)?.task.budget.capUsd).toBe(3);
      activity.close();
    });
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

  describe("失敗したときの代わりのエージェント（agents の fallback）", () => {
    const backup = agent({ id: "claude-api", auth: { mode: "api-key", secret: "anthropic-key" } });
    const main = agent({ fallback: ["claude-api"] });
    const withFallback =
      (cooldownMs?: number): (() => ConfigResult) =>
      () => {
        const base = configOf(main)();
        return base.ok
          ? {
              ok: true,
              config: {
                ...base.config,
                agents: { [main.id]: main, [backup.id]: backup },
                ...(cooldownMs ? { fallbackCooldownMs: cooldownMs } : {}),
              },
            }
          : base;
      };
    const secrets = { "claude-oauth-token": "oauth-secret", "anthropic-key": "sk-ant-secret" };
    const limited: AgentOutcome = {
      kind: "failed",
      reason: "usage_limit",
      message: "You've hit your session limit",
    };
    const fellBack = (service: TaskService, id: string) =>
      (service.get(id)?.activity ?? []).flatMap((e) =>
        e.type === "AgentFellBack" ? [e.payload] : [],
      );

    it("利用制限で失敗したら、止めずに代わりのエージェントでやり直し、期限までは代わりを使う", async () => {
      const activity = new SqliteActivityStore(dbPath);
      let now = Date.parse("2026-10-20T00:00:00Z");
      const { service, executor } = makeService(
        activity,
        [limited, completed(1_000), completed(1_000), completed(1_000)],
        { config: withFallback(30 * 60_000), secrets, now: () => now },
      );
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      // 止めずに、実行待ちのまま（次の処理で代わりのエージェントが実行する）
      expect(service.get(task.id)?.task.status).toBe("queued");
      expect(fellBack(service, task.id)).toEqual([
        {
          runId: expect.any(String),
          role: "requirements",
          agentId: "claude-subscription",
          fallbackAgentId: "claude-api",
          reason: "usage_limit",
          until: "2026-10-20T00:30:00.000Z",
        },
      ]);
      await service.runNext(task.id);
      expect(executor.calls).toHaveLength(2);
      expect(executor.calls[0]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
      expect(executor.calls[1]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      expect(executor.calls[1]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      const started = (service.get(task.id)?.activity ?? []).flatMap((e) =>
        e.type === "AgentRunStarted" ? [e.payload.agentId] : [],
      );
      expect(started).toEqual(["claude-subscription", "claude-api"]);
      expect(service.get(task.id)?.task.status).toBe("awaiting_approval");

      // 期限までは、ほかのタスクも代わりのエージェントで実行する
      const other = service.createTask({ projectId: "default", title: "B" });
      await service.runNext(other.id);
      expect(executor.calls[2]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      // 期限を過ぎたら、元のエージェントに戻す
      now += 30 * 60_000;
      const third = service.createTask({ projectId: "default", title: "C" });
      await service.runNext(third.id);
      expect(executor.calls[3]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
      activity.close();
    });

    it("明ける時刻を読めたら、cooldown_minutes より長くても短くても、その時刻まで代わりを使い、AgentFellBack の until も合う", async () => {
      for (const [cooldownMin, resetIso, wall] of [
        [30, "2026-10-20T05:00:00.000Z", "2:00pm"],
        [120, "2026-10-20T01:00:00.000Z", "10:00am"],
      ] as const) {
        const activity = new SqliteActivityStore(`${dbPath}-${cooldownMin}`);
        let now = Date.parse("2026-10-20T00:00:00Z");
        const resetAt = Date.parse(resetIso);
        const readable: AgentOutcome = {
          kind: "failed",
          reason: "usage_limit",
          message: `You've hit your weekly limit · resets ${wall} (Asia/Tokyo)`,
          cliText: true,
        };
        const { service, executor } = makeService(
          activity,
          [readable, completed(1_000), completed(1_000), completed(1_000)],
          { config: withFallback(cooldownMin * 60_000), secrets, now: () => now },
        );
        const task = service.createTask({ projectId: "default", title: "A" });
        await service.runNext(task.id);
        expect(fellBack(service, task.id).map((p) => p.until)).toEqual([resetIso]);
        await service.runNext(task.id);
        now = resetAt - 1;
        const during = service.createTask({ projectId: "default", title: "B" });
        await service.runNext(during.id);
        expect(executor.calls[2]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
        now = resetAt;
        const after = service.createTask({ projectId: "default", title: "C" });
        await service.runNext(after.id);
        expect(executor.calls[3]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
        activity.close();
        rmSync(`${dbPath}-${cooldownMin}`, { force: true });
      }
    });

    it("エージェント自身の発言（cliText の無い文）の時刻は読まず、cooldown_minutes で戻る", async () => {
      const activity = new SqliteActivityStore(`${dbPath}-speech`);
      const now = Date.parse("2026-10-20T00:00:00Z");
      const { service } = makeService(
        activity,
        [
          {
            kind: "failed",
            reason: "usage_limit",
            message: "weekly limit · resets Fri 12:00am (UTC)",
          },
          completed(1_000),
        ],
        { config: withFallback(30 * 60_000), secrets, now: () => now },
      );
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      expect(fellBack(service, task.id).map((p) => p.until)).toEqual(["2026-10-20T00:30:00.000Z"]);
      activity.close();
      rmSync(`${dbPath}-speech`, { force: true });
    });

    it("読めた長い期限を、後から来た読めない失敗で短くしない", async () => {
      const activity = new SqliteActivityStore(`${dbPath}-max`);
      const now = Date.parse("2026-10-20T00:00:00Z");
      const { service } = makeService(activity, [completed(1_000)], {
        config: withFallback(30 * 60_000),
        secrets,
        now: () => now,
      });
      const internals = service as unknown as {
        markLimited(agent: { id: string }, outcome: AgentOutcome): void;
        limitedAgents: Map<string, number>;
      };
      const agent = { id: "a" };
      internals.markLimited(agent, {
        kind: "failed",
        reason: "usage_limit",
        message: "weekly limit · resets 2:00pm (Asia/Tokyo)",
        cliText: true,
      });
      internals.markLimited(agent, {
        kind: "failed",
        reason: "usage_limit",
        message: "429",
        cliText: true,
      });
      expect(internals.limitedAgents.get("a")).toBe(Date.parse("2026-10-20T05:00:00Z"));
      // 先が読めない（短い）ときは、後の読めた期限になる
      internals.markLimited(
        { id: "b" },
        { kind: "failed", reason: "usage_limit", message: "429", cliText: true },
      );
      internals.markLimited(
        { id: "b" },
        {
          kind: "failed",
          reason: "usage_limit",
          message: "weekly limit · resets 2:00pm (Asia/Tokyo)",
          cliText: true,
        },
      );
      expect(internals.limitedAgents.get("b")).toBe(Date.parse("2026-10-20T05:00:00Z"));
      activity.close();
      rmSync(`${dbPath}-max`, { force: true });
    });

    it("明ける時刻を読めないとき・一時的な混雑のときは、cooldown_minutes で戻る", async () => {
      for (const message of [
        "You've hit your session limit · resets 3:45pm",
        "429 Too Many Requests, retry at 3:45pm (Asia/Tokyo)",
        "session limit · resets 13:00pm (Asia/Tokyo)",
      ]) {
        const activity = new SqliteActivityStore(`${dbPath}-u`);
        let now = Date.parse("2026-10-20T00:00:00Z");
        const { service, executor } = makeService(
          activity,
          [
            { kind: "failed", reason: "usage_limit", message, cliText: true },
            completed(1_000),
            completed(1_000),
            completed(1_000),
          ],
          { config: withFallback(30 * 60_000), secrets, now: () => now },
        );
        const task = service.createTask({ projectId: "default", title: "A" });
        await service.runNext(task.id);
        expect(fellBack(service, task.id).map((p) => p.until)).toEqual([
          "2026-10-20T00:30:00.000Z",
        ]);
        await service.runNext(task.id);
        now += 30 * 60_000 - 1;
        const during = service.createTask({ projectId: "default", title: "B" });
        await service.runNext(during.id);
        expect(executor.calls[2]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
        now += 1;
        const after = service.createTask({ projectId: "default", title: "C" });
        await service.runNext(after.id);
        expect(executor.calls[3]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
        activity.close();
        rmSync(`${dbPath}-u`, { force: true });
      }
    });

    it("代わりのエージェントも利用制限なら、これまでどおり止める", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [limited, limited], {
        config: withFallback(),
        secrets,
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      expect(service.get(task.id)?.task.status).toBe("queued");
      await service.runNext(task.id);
      const paused = service.get(task.id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.pausedReason).toBe("usage_limit");
      expect(executor.calls).toHaveLength(2);
      expect(fellBack(service, task.id)).toHaveLength(1);
      activity.close();
    });

    it("利用制限でない失敗（認証など）も代わりでやり直し、期限まではこのタスクでだけ代わりを使う", async () => {
      const activity = new SqliteActivityStore(dbPath);
      let now = Date.parse("2026-10-20T00:00:00Z");
      const { service, executor } = makeService(
        activity,
        [
          { kind: "failed", reason: "auth", message: "401" },
          completed(1_000),
          completed(1_000),
          completed(1_000),
          completed(1_000),
        ],
        { config: withFallback(30 * 60_000), secrets, now: () => now },
      );
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      expect(service.get(task.id)?.task.status).toBe("queued");
      expect(fellBack(service, task.id)).toEqual([
        {
          runId: expect.any(String),
          role: "requirements",
          agentId: "claude-subscription",
          fallbackAgentId: "claude-api",
          reason: "auth",
          until: "2026-10-20T00:30:00.000Z",
        },
      ]);
      await service.runNext(task.id);
      expect(executor.calls[1]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
      // ほかのタスクは、元のエージェントで実行する
      const other = service.createTask({ projectId: "default", title: "B" });
      await service.runNext(other.id);
      expect(executor.calls[2]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
      // このタスクの次の実行も、期限までは代わりのエージェントで実行し、過ぎたら元に戻す
      service.requestChanges(task.id, {
        step: "requirements",
        submission: 1,
        comments: ["直して"],
      });
      await service.runNext(task.id);
      expect(executor.calls[3]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      now += 30 * 60_000;
      service.requestChanges(task.id, {
        step: "requirements",
        submission: 2,
        comments: ["直して"],
      });
      await service.runNext(task.id);
      expect(executor.calls[4]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
      activity.close();
    });

    it("どんな失敗でも代わりでやり直し、代わりも失敗したら止める", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const error: AgentOutcome = { kind: "failed", reason: "error", message: "exit code 1" };
      const { service, executor } = makeService(activity, [error, error], {
        config: withFallback(),
        secrets,
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      expect(service.get(task.id)?.task.status).toBe("queued");
      expect(fellBack(service, task.id)).toMatchObject([{ reason: "error" }]);
      await service.runNext(task.id);
      const paused = service.get(task.id)?.task;
      expect(paused?.status).toBe("paused");
      expect(paused?.pausedReason).toBe("error");
      expect(executor.calls).toHaveLength(2);
      expect(fellBack(service, task.id)).toHaveLength(1);
      activity.close();
    });

    it("期限が過ぎても、試し終えたエージェントには戻らずに止め、再開したら選んだエージェントから試す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      let now = Date.parse("2026-10-20T00:00:00Z");
      const error: AgentOutcome = { kind: "failed", reason: "error", message: "timed out" };
      const { service, executor } = makeService(activity, [error, error, error], {
        config: withFallback(60_000),
        secrets,
        now: () => now,
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id); // 元のエージェント：失敗（代わりへ）
      now += 61_000;
      await service.runNext(task.id); // 代わり：失敗（元の期限は過ぎたが、試し終えたので止める）
      expect(service.get(task.id)?.task.status).toBe("paused");
      expect(executor.calls).toHaveLength(2);
      expect(fellBack(service, task.id)).toHaveLength(1);
      now += 61_000;
      service.resume(task.id, {});
      await service.runNext(task.id);
      expect(executor.calls).toHaveLength(3);
      expect(executor.calls[2]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
      activity.close();
    });

    it("代わりが利用制限でない失敗で止まったタスクを期限の内に再開したら、利用制限の元を飛ばして代わりをもう一度試す", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const now = Date.parse("2026-10-20T00:00:00Z");
      const error: AgentOutcome = { kind: "failed", reason: "error", message: "boom" };
      const { service, executor } = makeService(activity, [limited, error, completed(1_000)], {
        config: withFallback(60 * 60_000),
        secrets,
        now: () => now,
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id); // 元：利用制限（代わりへ）
      await service.runNext(task.id); // 代わり：error（止まる）
      expect(service.get(task.id)?.task.status).toBe("paused");
      service.resume(task.id, {}); // 期限の内
      await service.runNext(task.id);
      // 元（利用制限の覚えが残る）を飛ばして、代わりが実行される
      expect(executor.calls).toHaveLength(3);
      expect(executor.calls[2]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      activity.close();
    });

    it("再開の後、利用制限の覚えが無ければ、元が利用制限で失敗してから代わりへ切り替わる", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const now = Date.parse("2026-10-20T00:00:00Z");
      const error: AgentOutcome = { kind: "failed", reason: "error", message: "boom" };
      const { service, executor } = makeService(
        activity,
        [error, error, limited, completed(1_000)],
        { config: withFallback(60 * 60_000), secrets, now: () => now },
      );
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id); // 元：error（代わりへ）
      await service.runNext(task.id); // 代わり：error（止まる）
      service.resume(task.id, {});
      await service.runNext(task.id); // 元：利用制限
      await service.runNext(task.id); // 代わり
      expect(executor.calls).toHaveLength(4);
      expect(executor.calls[2]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
      expect(executor.calls[3]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      expect(fellBack(service, task.id)).toHaveLength(2);
      activity.close();
    });

    it("再開の後に元も代わりも利用制限で失敗したら、止めて理由は usage_limit", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const now = Date.parse("2026-10-20T00:00:00Z");
      const error: AgentOutcome = { kind: "failed", reason: "error", message: "boom" };
      const { service, executor } = makeService(activity, [limited, error, limited], {
        config: withFallback(60 * 60_000),
        secrets,
        now: () => now,
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      await service.runNext(task.id);
      service.resume(task.id, {});
      await service.runNext(task.id); // 代わり（元は利用制限の覚え）：利用制限
      expect(executor.calls).toHaveLength(3);
      expect(executor.calls[2]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      expect(service.get(task.id)?.task.status).toBe("paused");
      expect(service.get(task.id)?.task.pausedReason).toBe("usage_limit");
      activity.close();
    });

    it("再開で忘れるのは再開したタスクの分だけで、ほかのタスクの使わない覚えは残る", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const now = Date.parse("2026-10-20T00:00:00Z");
      const error: AgentOutcome = { kind: "failed", reason: "error", message: "boom" };
      const { service, executor } = makeService(
        activity,
        [error, completed(1_000), error, error, completed(1_000), completed(1_000)],
        { config: withFallback(60 * 60_000), secrets, now: () => now },
      );
      const t2 = service.createTask({ projectId: "default", title: "B" });
      await service.runNext(t2.id); // t2：元が error（代わりへ）
      await service.runNext(t2.id); // t2：代わりが成功（試した記録は忘れ、承認待ち）
      expect(service.get(t2.id)?.task.status).toBe("awaiting_approval");
      const t1 = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(t1.id); // t1：元が error（代わりへ）
      await service.runNext(t1.id); // t1：代わりが error（止まる）
      expect(service.get(t1.id)?.task.status).toBe("paused");
      service.resume(t1.id, {});
      await service.runNext(t1.id); // t1：元に戻る
      expect(executor.calls[4]?.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-secret");
      // t2 は試した記録が無く、使わない覚えだけが元を飛ばさせる
      service.requestChanges(t2.id, { step: "requirements", submission: 1, comments: ["直して"] });
      await service.runNext(t2.id);
      expect(executor.calls[5]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      activity.close();
    });

    it("切り替えの間に同じタスクの質問に答えても、期限が過ぎても、試し終えたら止める", async () => {
      const activity = new SqliteActivityStore(dbPath);
      let now = Date.parse("2026-10-20T00:00:00Z");
      const error: AgentOutcome = { kind: "failed", reason: "error", message: "timed out" };
      const answer: AgentOutcome = {
        kind: "completed",
        output: "答えです",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 10 },
      };
      const { service, executor } = makeService(activity, [error, answer, error], {
        config: withFallback(60_000),
        secrets,
        now: () => now,
      });
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id); // 元のエージェント：工程が失敗（代わりへ）
      expect(service.get(task.id)?.task.status).toBe("queued");
      // 質問（chat）が成功しても、工程の切り替えの記録は消さない
      await service.askQuestion(task.id, { text: "いまどこ？" }).answered;
      now += 61_000;
      await service.runNext(task.id); // 代わり：工程が失敗（元は期限が過ぎたが、試し終えたので止める）
      expect(executor.calls).toHaveLength(3);
      expect(executor.calls[2]?.env.ANTHROPIC_API_KEY).toBe("sk-ant-secret");
      expect(service.get(task.id)?.task.status).toBe("paused");
      expect(fellBack(service, task.id)).toHaveLength(1);
      activity.close();
    });

    it("コンテナが止まったことを確かめられなかった実行は、代わりに切り替えずに止める", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(
        activity,
        [
          {
            kind: "failed",
            reason: "error",
            message: { code: "run.containerNotConfirmed", params: { name: "sacty-run" } },
          },
          completed(1_000),
        ],
        { config: withFallback(), secrets },
      );
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      expect(service.get(task.id)?.task.status).toBe("paused");
      expect(fellBack(service, task.id)).toEqual([]);
      expect(executor.calls).toHaveLength(1);
      activity.close();
    });

    it("時間切れで止めた後にコンテナが止まったことを確かめられなかった実行も、代わりに切り替えずに止める（使用量は残す）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [completed(1_000)], {
        config: withFallback(),
        secrets,
      });
      let runs = 0;
      executor.run = async () => {
        runs++;
        const error = new AgentTimeoutError(message("run.timeout", { minutes: 3 }));
        error.usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 20_000 };
        error.costUnknown = true;
        error.unconfirmedContainer = "sacty-run-x";
        throw error;
      };
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      expect(service.get(task.id)?.task.status).toBe("paused");
      expect(fellBack(service, task.id)).toEqual([]);
      // 代わりの実行は始まらず（呼んだのは 1 回）、止めた理由は確認の失敗になり、読めた使用量は費用に残る
      await service.runNext(task.id);
      expect(runs).toBe(1);
      const failed = service.get(task.id)?.activity.find((e) => e.type === "AgentRunFailed");
      expect(failed?.payload).toMatchObject({
        message: { code: "run.containerNotConfirmed", params: { name: "sacty-run-x" } },
        costUsd: 0.3,
        costUnknown: true,
      });
      activity.close();
    });

    it("代わりのエージェントが無ければ、これまでどおり止める", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(
        activity,
        [{ kind: "failed", reason: "auth", message: "401" }],
        { secrets },
      );
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      expect(service.get(task.id)?.task.pausedReason).toBe("auth");
      expect(fellBack(service, task.id)).toEqual([]);
      activity.close();
    });
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

  it("エージェントの発言に通知の形の文面があった実行は、どの実行かと件数を記録し、工程はそのまま承認待ちに進む（PBI-368）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [{ ...completed(100), imitatedNotices: 3 }]);
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    const events = service.get(task.id)?.activity ?? [];
    const started = events.find((e) => e.type === "AgentRunStarted");
    const imitated = events.filter((e) => e.type === "SubagentNoticeImitated");
    expect(imitated.map((e) => ({ actor: e.actor, payload: e.payload }))).toEqual([
      {
        actor: "sacty",
        payload: {
          runId: started?.type === "AgentRunStarted" ? started.payload.runId : "",
          agentId: started?.type === "AgentRunStarted" ? started.payload.agentId : "",
          count: 3,
        },
      },
    ]);
    // 記録だけで、実行の結果・状態は変えない
    expect(events.some((e) => e.type === "AgentRunCompleted")).toBe(true);
    expect(service.get(task.id)?.task.status).toBe("awaiting_approval");
    activity.close();
    // 開き直しても（作業履歴から状態を作り直しても）、同じ状態になる
    const reopened = new SqliteActivityStore(dbPath);
    const again = makeService(reopened, []);
    expect(again.service.get(task.id)?.task.status).toBe("awaiting_approval");
    reopened.close();
  });

  it("通知の形の文面の件数が無い実行は、記録しない（PBI-368）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [completed(100)]);
    const task = service.createTask({ projectId: "default", title: "決済API" });
    await service.runNext(task.id);
    const events = service.get(task.id)?.activity ?? [];
    expect(events.some((e) => e.type === "SubagentNoticeImitated")).toBe(false);
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

  describe("時間切れで止めた実行の費用（PBI-281）", () => {
    /** 時間切れで止められた実行（本物の実行器が投げるエラー）。usage は止めるまでに読めた分。 */
    const timeoutAfter = (usage?: AgentOutcome extends { usage?: infer U } ? U : never) => {
      const error = new AgentTimeoutError(message("run.timeout", { minutes: 3 }));
      error.usage = usage;
      error.costUnknown = true;
      return error;
    };
    const timedOutRun = async (error: Error) => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [completed(1)]);
      executor.run = async () => {
        throw error;
      };
      const task = service.createTask({ projectId: "default", title: "A" });
      await service.runNext(task.id);
      const after = service.get(task.id);
      const failed = after?.activity.find((e) => e.type === "AgentRunFailed");
      return { activity, after, failed: failed?.type === "AgentRunFailed" ? failed : undefined };
    };

    it("止めるまでに読めた使用量を費用に記録し、予算に入れる（0 にしない）", async () => {
      // 57,000 出力トークン = $0.855（予算の 80% を超える）
      const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 57_000 };
      const { activity, after, failed } = await timedOutRun(timeoutAfter(usage));
      expect(failed?.payload).toMatchObject({ usage, costUsd: 0.855, costUnknown: true });
      expect(after?.task.budget).toMatchObject({ usedUsd: 0.855, unknownRuns: 1, warned: true });
      expect(after?.task.pausedReason).toBe("error");
      activity.close();
    });

    it("読めなければ、0 の費用として記録せず、不明の印を付ける", async () => {
      const { activity, after, failed } = await timedOutRun(timeoutAfter());
      expect(failed?.payload.costUsd).toBe(0);
      expect(failed?.payload.costUnknown).toBe(true);
      expect(after?.task.budget.unknownRuns).toBe(1);
      activity.close();
    });

    it("起動できなかったなど、何も使っていない失敗には、不明の印を付けない", async () => {
      const { activity, after, failed } = await timedOutRun(new Error("docker failed"));
      expect(failed?.payload.costUsd).toBe(0);
      expect(failed?.payload).not.toHaveProperty("costUnknown");
      expect(after?.task.budget).not.toHaveProperty("unknownRuns");
      activity.close();
    });

    it("再開して時間切れが続けば、回ごとに記録して合計する（空・1件・複数件）", async () => {
      const activity = new SqliteActivityStore(dbPath);
      const { service, executor } = makeService(activity, [completed(1)]);
      const outputs = [100_000, undefined, 20_000];
      executor.run = async () => {
        const output = outputs.shift();
        throw timeoutAfter(
          output === undefined ? undefined : { input: 0, cacheRead: 0, cacheWrite: 0, output },
        );
      };
      const task = service.createTask({ projectId: "default", title: "A" });
      expect(service.get(task.id)?.task.budget).not.toHaveProperty("unknownRuns");
      await service.runNext(task.id);
      expect(service.get(task.id)?.task.budget.unknownRuns).toBe(1);
      // 1 回目で上限（$1）を超えて止まったので、上限を上げて再開する
      service.resume(task.id, { capUsd: 50 });
      await service.runNext(task.id);
      service.resume(task.id, {});
      await service.runNext(task.id);
      const budget = service.get(task.id)?.task.budget;
      expect(budget?.unknownRuns).toBe(3);
      expect(budget?.usedUsd).toBeCloseTo(1.8, 6); // 1.5 + 0 + 0.3
      const failures = service.get(task.id)?.activity.filter((e) => e.type === "AgentRunFailed");
      expect(failures).toHaveLength(3);
      activity.close();
    });
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
    let finish: ((o: AgentOutcome) => void) | undefined;
    const service = new TaskService({
      activity,
      config: configOf(agent()),
      secrets: new MemorySecretStore({ "claude-oauth-token": "oauth-secret" }),
      executor: { run: () => new Promise<AgentOutcome>((resolve) => (finish = resolve)) },
      repos: new FakeRepos(),
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
    await waitFor(() => finish !== undefined, { what: "エージェントの実行の開始" });
    let drained = false;
    const draining = worker.drain().then(() => {
      drained = true;
    });
    // 実行中なのに停止が終わってしまわないこと（何も起きないこと）を見るための猶予。実行が始まった後に置く
    await idleFor(20);
    expect(drained).toBe(false); // まだ実行中
    finish?.({ kind: "failed", reason: "error", message: "中断" });
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

  it("同じ工程への差し戻しに回数の上限は無い。4 回目も 5 回目も、エスカレーションにせず差し戻し、overLimit は偽で記録する（PBI-414）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      Array.from({ length: 6 }, (_, i) => draft(`# v${i + 1}`)),
    );
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    for (let i = 1; i <= 5; i++) {
      const after = service.requestChanges(task.id, {
        step: "requirements",
        submission: current(service, task.id),
        comments: [`指摘${i}`],
      });
      expect(after.status).toBe("queued");
      expect(after.remarks.at(-1)).toMatchObject({ id: `requirements-${i}-1`, text: `指摘${i}` });
      await service.runNext(task.id);
    }
    const events = service.get(task.id)?.activity ?? [];
    expect(events.map((e) => e.type)).not.toContain("TaskEscalated");
    const changes = events.filter((e) => e.type === "ChangesRequested");
    expect(changes).toHaveLength(5);
    expect(changes.every((e) => e.type === "ChangesRequested" && !e.payload.overLimit)).toBe(true);
    activity.close();
  });

  it("差し戻しの入力に、以前の版の「上限を超えて差し戻す」の指定があっても、断らずに無視し、指定が無いときと同じ記録にする（PBI-414）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      Array.from({ length: 3 }, (_, i) => draft(`# v${i + 1}`)),
    );
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: 1,
      comments: ["指摘1"],
      continueOverLimit: true,
    });
    await service.runNext(task.id);
    service.requestChanges(task.id, {
      step: "requirements",
      submission: 2,
      comments: ["指摘2"],
    });
    const [first, second] = (service.get(task.id)?.activity ?? []).filter(
      (e) => e.type === "ChangesRequested",
    );
    expect(first?.payload).toMatchObject({ overLimit: false, remarks: [{ text: "指摘1" }] });
    expect({ ...first?.payload, round: 0, remarks: [] }).toEqual({
      ...second?.payload,
      round: 0,
      remarks: [],
    });
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
    // テスト観点の ID は sacty が配列の順に振り直す。消す観点は出さず、削除の行も作らせない
    expect(prompt).toContain("消す観点は出さず、削除の行も作らないでください");
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

  it("設計から要求要件への差し戻しも、4 回目を差し戻す（エスカレーションにしない。PBI-414）", async () => {
    const outcomes: AgentOutcome[] = [draft("# 設計 v1", [viewpoints("A")])];
    for (let i = 2; i <= 5; i++) {
      outcomes.push(draft(`# 要求要件 v${i}`), draft(`# 設計 v${i}`, [viewpoints("A")]));
    }
    const { activity, service, id } = await toDesignGate(outcomes);
    const back = (comments: string[]) =>
      service.requestChanges(id, {
        step: "design",
        submission: current(service, id),
        target: "requirements",
        comments,
      });
    for (let i = 1; i <= 3; i++) {
      back([`指摘${i}`]);
      await service.runNext(id);
      gate(service, id, "requirements");
      await service.runNext(id);
    }
    const fourth = back(["指摘4"]);
    expect(fourth.status).toBe("queued");
    expect(fourth.escalation).toBeUndefined();
    expect(fourth.remarks.at(-1)).toMatchObject({ id: "requirements-4-1", text: "指摘4" });
    expect(fourth.steps[0]?.state).toBe("active");
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

describe("作業領域の写し・削除の間も、デーモンのイベントループを止めない（PBI-156）", () => {
  /** 多数のファイルを書き出す写し（数万ファイルの作業ツリーの代わり）。 */
  class ManyFilesRepos extends FakeRepos {
    override async snapshot(gitDir: string, baseCommit: string, outDir: string) {
      await super.snapshot(gitDir, baseCommit, outDir);
      if (!outDir.includes("_code-copy")) return;
      for (let d = 0; d < 20; d++) {
        mkdirSync(join(outDir, "node_modules", `pkg${d}`), { recursive: true });
        for (let f = 0; f < 100; f++) {
          writeFileSync(join(outDir, "node_modules", `pkg${d}`, `f${f}.js`), "x");
        }
      }
    }
  }

  it("コードの写しを消す間も、ほかのタイマーが進み、消し終わってから分析を終える（PBI-333 から、写しは _code-copy）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        { kind: "failed", reason: "error", message: "exit code 1" },
        {
          kind: "completed",
          output: "### 何が起きたか\n分析",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 100 },
        },
      ],
      { repos: new ManyFilesRepos(), sessionLogs: new SessionLogStore(join(dir, "runs")) },
    );
    // 分析の実行が終わってから、写しが消えるまでに進んだタイマーの数
    let ticks = 0;
    const run = executor.run.bind(executor);
    executor.run = async (input) => {
      const outcome = await run(input);
      if (input.workspaceDir.includes("_code-copy")) {
        expect(existsSync(join(input.workspaceDir, "node_modules", "pkg19", "f99.js"))).toBe(true);
        const tick = () => {
          if (!existsSync(input.workspaceDir)) return;
          ticks++;
          setImmediate(tick);
        };
        setImmediate(tick);
      }
      return outcome;
    };
    const { id } = service.createTask({ projectId: "default", title: "決済API", body: "" });
    await service.runNext(id);
    await service.analyzeErrors(id).analyzed;
    const copy = executor.dirs.at(-1) ?? "";
    expect(copy).toContain("_code-copy");
    expect(copy).not.toContain("_guardian");
    // 同期で消すと、消し終わるまでタイマーが1つも進まない
    expect(ticks).toBeGreaterThan(0);
    expect(existsSync(copy)).toBe(false);
    activity.close();
  });
});

describe("変更の申し出（PBI-9。PBI-333 から人が判断する）", () => {
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
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";

  /** 要求要件を承認し、設計の実行（申し出つき）まで進める。 */
  async function propose(outcomes: AgentOutcome[]) {
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

  it("設計の工程は要求要件の変更を申し出られ、AI の判定を挟まずに人の判断待ちになる（PBI-333）", async () => {
    const { activity, service, executor, id } = await propose([designWithProposal()]);
    expect(promptOf(executor, 1)).toContain("sacty-change-proposal");
    // 判定の実行はしない
    expect(executor.calls).toHaveLength(2);
    const task = service.get(id)?.task;
    expect(task?.status).toBe("escalated");
    expect(task?.proposals).toMatchObject([
      { id: "CP-1", fromStep: "design", target: "requirements", applied: false },
    ]);
    expect(task?.proposals[0]?.judgement).toBeUndefined();
    // 通知は、判断の欄のあるタスクの詳細の申し出の欄へリンクする（PR #351 レビュー指摘）
    expect(task && notificationText(task, "escalation", "ja", "http://x")).toContain(
      `http://x/tasks/${id}#proposals`,
    );
    expect(task?.outputs.design).toBe("# 設計 v1"); // 申し出のJSONは本文から除く
    expect(task?.approved.requirements?.output).toBe("# 要求要件 v1");
    const events = service.get(id)?.activity ?? [];
    expect(events.map((e) => e.type)).not.toContain("ChangeJudged");
    expect(events.at(-1)).toMatchObject({
      actor: "sacty",
      type: "TaskEscalated",
      payload: {
        step: "design",
        target: "requirements",
        reason: "change_proposed",
        proposalId: "CP-1",
      },
    });
    activity.close();
  });

  it("人が認めなければ、設計をそのまま提出する。要求要件は承認済みのまま", async () => {
    const { activity, service, id } = await propose([designWithProposal()]);
    expect(() => service.approve(id, { step: "design", submission: 1 })).toThrow();
    expect(() => service.decideChange(id, "CP-9", { accept: true })).toThrow(
      /判断待ちではありません/,
    );
    const rejected = service.decideChange(id, "CP-1", { accept: false });
    expect(rejected.gate).toEqual({ step: "design", submission: 1 });
    expect(rejected.approved.requirements?.output).toBe("# 要求要件 v1");
    expect(rejected.proposals[0]).toMatchObject({ decision: { accept: false }, applied: false });
    expect(() => service.decideChange(id, "CP-1", { accept: true })).toThrow(
      /判断待ちではありません/,
    );
    activity.close();
  });

  it("人が認めた要求要件の変更は反映し、人の再承認に回す", async () => {
    const { activity, service, executor, id } = await propose([
      designWithProposal(),
      out("# 設計 v2"),
    ]);
    const accepted = service.decideChange(id, "CP-1", { accept: true });
    expect(accepted.status).toBe("awaiting_approval");
    expect(accepted.gate).toEqual({ step: "requirements", submission: 2 });
    expect(accepted.outputs.requirements).toBe("# 要求要件 v2（sacty側で重複を防ぐ）");
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
    service.approve(id, { step: "requirements", submission: 2 });
    await service.runNext(id);
    expect(promptOf(executor, 2)).toContain(
      "--- 承認済みの要求要件 ---\n# 要求要件 v2（sacty側で重複を防ぐ）",
    );
    expect(service.get(id)?.task.gate).toEqual({ step: "design", submission: 1 });
    activity.close();
  });

  it("申し出と人の判断待ちは、同じトランザクションで作業履歴に記録する", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const appended: string[][] = [];
    const original = activity.append.bind(activity);
    activity.append = (entry) => {
      appended.push(entry.events.map((e) => e.event.type));
      return original(entry);
    };
    const { service } = makeService(activity, [out("# 要求要件 v1"), designWithProposal()]);
    const { id } = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(id);
    service.approve(id, { step: "requirements", submission: 1 });
    await service.runNext(id);
    expect(appended).toContainEqual(["AgentRunCompleted", "ChangeProposed", "TaskEscalated"]);
    activity.close();
  });

  it("承認されていない工程への申し出は無視し、そのまま提出する", async () => {
    const { activity, service, executor, id } = await propose([designWithProposal("design")]);
    expect(executor.calls).toHaveLength(2);
    const task = service.get(id)?.task;
    expect(task?.proposals).toEqual([]);
    expect(task?.gate).toEqual({ step: "design", submission: 1 });
    activity.close();
  });

  it("以前の版で判定の途中に止まった申し出は、再起動時に人の判断待ちにする（PBI-333）", async () => {
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
    expect(task?.proposals[0]?.judgement).toBeUndefined();
    expect(restarted.get(id)?.activity.at(-1)).toMatchObject({
      type: "TaskEscalated",
      payload: { reason: "change_proposed", proposalId: "CP-1" },
    });
    // 人の判断を受け付ける
    expect(restarted.decideChange(id, "CP-1", { accept: false }).gate).toEqual({
      step: "design",
      submission: 1,
    });
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

describe("再現の工程（PBI-29）", () => {
  const out = (text: string): AgentOutcome => ({
    kind: "completed",
    output: text,
    usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1 },
  });
  const block = (b: Record<string, unknown>) => `\`\`\`json\n${JSON.stringify(b)}\n\`\`\``;
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  /** 再現の工程の出力。テストを書いたら、既定では、自分で実行して失敗した（再現できた）と申告する。 */
  const reproduce = (
    text: string,
    tests: string[],
    check: Record<string, unknown> = tests.length > 0
      ? {
          reproduced: true,
          command: "npm test",
          exitCode: 1,
          output: `FAIL ${tests[0]}`,
        }
      : {},
  ) => out([text, block({ "sacty-reproduction": { tests, ...check } })].join("\n\n"));
  const implement = (tests: string[] = ["pay.test.ts › 二重送信"]) =>
    out(
      ["# 修正の説明", block({ "sacty-test-map": [{ viewpointId: "REPRO", tests }] })].join("\n\n"),
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

  it("再現・実装は、どちらもタスクのイメージで動く（PBI-318）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const image = (name: string) => ({
      name,
      image: `sacty-agent-${name}:test`,
      description: name,
      baseImage: name,
      env: { TOOL: name },
    });
    const { service, executor } = makeService(
      activity,
      [reproduce("# 再現", ["pay.test.ts › 二重送信"]), implement()],
      {
        config: () => ({
          ok: true,
          config: {
            ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
            images: { go: image("go"), node: image("node") },
          },
        }),
        planner: async () => ({ ...(await planner()), image: "go" }),
      },
    );
    const { id } = service.createTask({ projectId: "default", title: "二重に決済される" });
    await drain(service);
    // 再現・実装（最終レビューもテストのコンテナも走らない）
    expect(executor.images).toEqual([
      { image: "sacty-agent-go:test", env: { TOOL: "go" } },
      { image: "sacty-agent-go:test", env: { TOOL: "go" } },
    ]);
    expect(service.get(id)?.task.reproduction).toMatchObject({ reproduced: true });
    // 再現・実装は、タスクごとの依存のキャッシュを使い回す（PBI-319）
    expect(executor.calls.map((c) => c.taskCache)).toEqual(
      executor.calls.map(() => join(dir, "workspaces", "_task-cache", id)),
    );
    // どの実行にも、キャッシュの使い方の案内を届ける（PBI-319 レビュー指摘）
    expect(executor.calls.map((c) => c.command.join(" ").includes("## 依存のキャッシュ"))).toEqual(
      executor.calls.map(() => true),
    );
    // どの実行の記録にも、使ったイメージの名前を残す（記録し忘れた所があれば落ちる。PBI-318 レビュー指摘）
    const runs = service.get(id)?.activity.filter((e) => e.type === "AgentRunStarted") ?? [];
    expect(runs.length).toBeGreaterThan(0);
    expect(runs.map((e) => e.type === "AgentRunStarted" && e.payload.image)).toEqual(
      runs.map(() => "go"),
    );
    activity.close();
  });

  it("古い版の作業履歴（工程ごとのイメージ）なら、再現は再現の工程のイメージ、実装は実装の工程のイメージで動く（PBI-41）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const image = (name: string) => ({
      name,
      image: `sacty-agent-${name}:test`,
      description: name,
      baseImage: name,
      env: { TOOL: name },
    });
    const config = (): ConfigResult => ({
      ok: true,
      config: {
        ...(configOf(agent())() as { ok: true; config: SactyConfig }).config,
        images: { go: image("go"), node: image("node") },
      },
    });
    const { service: before } = makeService(activity, [], { config });
    const { id } = before.createTask({ projectId: "default", title: "二重に決済される" });
    // 古い版が書いた工程の選択（工程ごとのイメージ）
    const chosen = await planner();
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "orchestrator",
          event: {
            type: "StepsChosen",
            payload: { ...chosen, images: { reproduce: "go", implement: "node" } },
          },
        },
      ],
    });
    const { service, executor } = makeService(
      activity,
      [reproduce("# 再現", ["pay.test.ts › 二重送信"]), implement()],
      { config, planner },
    );
    await drain(service);
    expect(executor.images).toEqual([
      { image: "sacty-agent-go:test", env: { TOOL: "go" } },
      { image: "sacty-agent-node:test", env: { TOOL: "node" } },
    ]);
    expect(service.get(id)?.task.reproduction).toMatchObject({ reproduced: true });
    activity.close();
  });

  it("不具合の修正のやり直しでも、人が PR に足したコミットを取り込んだことと、競合したファイルを実装に渡す（PBI-334）", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor, repos } = makeService(
      activity,
      [
        reproduce("# 再現の説明", ["pay.test.ts › 二重送信"]),
        implement(),
        implement("# 直した修正"),
      ],
      { planner },
    );
    const { id } = service.createTask({ projectId: "default", title: "二重に決済される" });
    await drain(service);
    const pushed = service.get(id)?.task.pushedBranch;
    if (!pushed) throw new Error("no pushed branch");
    repos.remote[pushed.branch] = "d".repeat(40);
    repos.mergeResult = { status: "conflicted", conflicts: ["src/pay.ts"] };
    repos.markers = ["src/pay.ts"];
    service.requestChanges(id, { step: "implement", submission: 1, comments: ["直して"] });
    await service.runNext(id);
    const fix = promptOf(executor, executor.calls.length - 1);
    expect(fix).toContain("そのテストが通るように不具合を直してください");
    expect(fix).toContain("--- 人が PR に足したコミット ---");
    expect(fix).toContain("- src/pay.ts");
    activity.close();
  });

  it("再現のテストが失敗したら、人間の承認なしに実装へ進み、再現のテストを観点にする", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const pulls = new FakePulls();
    const { service, executor } = makeService(
      activity,
      [reproduce("# 再現の説明", ["pay.test.ts › 二重送信"]), implement()],
      { planner, pulls },
    );
    const { id } = service.createTask({ projectId: "default", title: "二重に決済される" });
    // 不具合の修正は、再現から始める（前段の調査は置かない）
    await service.runNext(id);
    // 再現は clone（書き込める作業領域）で、不具合を直さずにテストを書かせる
    expect(executor.scratch[0]).toBe(false);
    expect(promptOf(executor, 0)).toContain("再現エージェント");
    expect(promptOf(executor, 0)).toContain("npm test");
    // テストは sacty が実行せず、再現のエージェントが自分で実行して、失敗したことを申告する
    expect(promptOf(executor, 0)).toContain("そのテストのコマンドを自分で実行し");
    expect(executor.calls).toHaveLength(1);
    const task = service.get(id)?.task;
    expect(task?.reproduction).toMatchObject({
      reproduced: true,
      command: "npm test",
      exitCode: 1,
      output: "FAIL pay.test.ts › 二重送信",
      tests: ["pay.test.ts › 二重送信"],
    });
    expect(task?.reproduction?.note).toBeUndefined();
    // 申告の形式のブロックは、再現の説明から取り除く
    expect(task?.outputs.reproduce).toBe("# 再現の説明");
    // マージの後の監視は、スキルが無いので飛ばす（PBI-116）
    expect(task?.steps.map((s) => s.state)).toEqual(["done", "active", "skip"]);
    expect(task?.status).toBe("queued");
    expect(service.get(id)?.activity.some((e) => e.type === "StepSubmitted")).toBe(false);

    await drain(service);
    const fix = promptOf(executor, 1);
    expect(fix).toContain("そのテストが通るように不具合を直してください");
    expect(fix).toContain("# 再現の説明");
    expect(fix).toContain("- pay.test.ts › 二重送信");
    expect(fix).toContain("FAIL pay.test.ts › 二重送信");
    expect(executor.calls).toHaveLength(2);
    const done = service.get(id)?.task;
    expect(done?.lastReview).toBeUndefined();
    expect(done?.gate).toEqual({ step: "implement", submission: 1 });
    // PR の本文には、再現の説明と、再現のテストの観点（REPRO）を載せる
    const body = pulls.calls[0]?.body ?? "";
    expect(body).toContain("## 不具合の再現");
    // 再現の説明は見出しだけなので、要点は無い。マージで承認した PR が無いので、全文は本文の折りたたみに載せる
    expect(body).toContain("<summary>全文</summary>");
    expect(body).not.toContain("タスクの画面");
    expect(body).toMatch(/\| REPRO 再現のテストが通る \| 1 件（`pay\.test\.ts`） \|\n/);
    expect(body).not.toContain("## 要求要件");
    // 実装の承認待ちから差し戻すときに、再現には戻せない（実装した後のコードでは再現できない）
    expect(reworkTargets(done as Task, "implement")).toEqual(["implement"]);
    // 実装の工程は、再現の変更を申し出られない（要求要件・設計だけ）
    expect(changeableSteps(done as Task, "implement")).toEqual([]);
    // 実装するタスクの結果は、取り込み元の Issue に返さない（調査だけのタスクだけが返す）
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
    const { service, executor } = makeService(
      activity,
      [
        reproduce("# 再現できた？", ["pay.test.ts › 二重送信"], {
          reproduced: false,
          command: "npm test",
          exitCode: 0,
          output: "all passed",
        }),
        reproduce("# テストでは再現できない", []),
        reproduce("# 再現した", ["pay.test.ts › 連打"]),
      ],
      { planner },
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
    expect(promptOf(executor, 1)).toContain("[reproduce-1-1] 連打で起きる");
    expect(promptOf(executor, 1)).toContain("終了コード 0");
    expect(promptOf(executor, 1)).toContain("all passed");
    task = service.get(id)?.task;
    // 再現のテストが申告されなければ、再現できなかったとする
    expect(renderMessage(task?.reproduction?.note, "ja")).toMatch(/テストを申告しませんでした/);
    expect(task?.gate).toEqual({ step: "reproduce", submission: 2 });

    service.requestChanges(id, { step: "reproduce", submission: 2, comments: ["決済ボタン"] });
    await service.runNext(id);
    task = service.get(id)?.task;
    expect(task?.reproduction?.reproduced).toBe(true);
    expect(task?.approved.reproduce?.output).toContain("# 再現した");
    expect(task?.status).toBe("queued");
    activity.close();
  });

  it("テストを実行して失敗したことを申告しなければ、再現できたとしない（終了コード 0 で再現できたと申告しても）", async () => {
    for (const check of [
      {},
      { reproduced: true, command: "npm test", exitCode: 0, output: "1 passed" },
      { reproduced: false, command: "npm test", exitCode: 1, output: "SyntaxError" },
      // 終了コードの申告が無い・整数でないなら、確かめていない（PR #188 レビュー指摘）
      { reproduced: true, command: "npm test", output: "FAIL" },
      { reproduced: true, command: "npm test", exitCode: "1", output: "FAIL" },
    ]) {
      const activity = new SqliteActivityStore(dbPath);
      const { service } = makeService(activity, [reproduce("# 再現", ["a.test.ts › x"], check)], {
        planner,
      });
      const { id } = service.createTask({ projectId: "default", title: "不具合" });
      await drain(service);
      const task = service.get(id)?.task;
      expect(task?.reproduction?.reproduced).toBe(false);
      expect(task?.reproduction?.note).toEqual({ code: "reproduce.notChecked" });
      expect(task?.gate).toEqual({ step: "reproduce", submission: 1 });
      activity.close();
      rmSync(dbPath, { force: true });
    }
  });

  it("それより前の版で、sacty の再現の確かめを待っていたタスクは、再起動の後に再現できなかったと記録して人間の判断を待つ", async () => {
    const activity = new SqliteActivityStore(dbPath);
    // それより前の版の工程（先頭に前段の調査を置いていた）
    const legacy = async () => ({
      ...(await planner()),
      steps: ["investigate", ...STEP_PLANS.bugfix] as StepKey[],
    });
    const { service } = makeService(activity, [out("# 前段の調査")], { planner: legacy });
    const { id } = service.createTask({ projectId: "default", title: "不具合" });
    await service.runNext(id); // 前段の調査（承認なしに再現へ進む）
    const investigated = service.get(id)?.activity.find((e) => e.type === "AgentRunCompleted");
    if (investigated?.type !== "AgentRunCompleted") throw new Error("no run");
    const { agentId, authMode, usage } = investigated.payload;
    // それより前の版の作業履歴：再現の工程の完了だけがあり、sacty がテストで確かめる前に止まった
    activity.append({
      taskId: id,
      projectId: "default",
      events: [
        {
          actor: "sacty",
          event: {
            type: "AgentRunStarted",
            payload: { runId: "old-run", step: "reproduce", agentId, authMode },
          },
        },
        {
          actor: "agent",
          event: {
            type: "AgentRunCompleted",
            payload: {
              runId: "old-run",
              step: "reproduce",
              agentId,
              authMode,
              usage,
              costUsd: 0,
              estimated: false,
              output: "# 再現",
              responses: [],
              reproductionTests: ["a.test.ts › x"],
            },
          },
        },
      ],
    });
    const restored = new SqliteActivityStore(dbPath);
    const { service: restarted, executor } = makeService(restored, [], { planner: legacy });
    expect(restarted.get(id)?.task.reproductionPending).toBe(true);
    expect(restarted.queuedTaskIds()).toEqual([id]);
    await restarted.runNext(id);
    // テストは実行せず（エージェントも起動しない）、申告が無いものとして再現できなかったと記録する
    expect(executor.calls).toHaveLength(0);
    const task = restarted.get(id)?.task;
    expect(task?.reproduction).toMatchObject({
      reproduced: false,
      tests: ["a.test.ts › x"],
      note: { code: "reproduce.notChecked" },
    });
    expect(task?.gate).toEqual({ step: "reproduce", submission: 1 });
    restored.close();
    activity.close();
  });

  it("オーケストレーターは、不具合の修正に bugfix を選べる", () => {
    expect(buildOrchestratorPrompt({ title: "x", body: "" } as Task)).toContain(
      "- bugfix：再現 → 実装",
    );
  });
});

describe("タスクの並行実行（PBI-30）", () => {
  /** 止めるか終えるまで返さない偽物（実行中のタスクを数える）。 */
  class HeldExecutor implements AgentExecutor {
    held = new Map<string, { title: string; resolve: (o: AgentOutcome) => void }>();
    killed: string[] = [];
    async run(input: { runId: string; invocation: Invocation }): Promise<AgentOutcome> {
      // 指示は標準入力で渡る（PBI-149）
      const prompt = input.invocation.stdin ?? input.invocation.command.join(" ");
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
  /** 止めてある実行が、その題のタスクのものになるまで待つ（実行に入るまでの時間は、環境と負荷で変わる）。 */
  const held = (executor: HeldExecutor, titles: string[]) =>
    waitFor(() => JSON.stringify(executor.titles()) === JSON.stringify(titles), {
      what: `止めてある実行が ${titles.join("・")} になること`,
    });
  /** Worker が始めた実行（runNext）を記録する。Worker は、tick の中で、同期で runNext を呼ぶ。 */
  const startsOf = (service: TaskService) => vi.spyOn(service, "runNext");
  /** そのタスクの実行が終わり、Worker が実行の枠を空けるまで待つ。 */
  const freed = async (starts: ReturnType<typeof startsOf>, id: string) => {
    const index = starts.mock.calls.findIndex(([taskId]) => taskId === id);
    if (index < 0) throw new Error(`Worker は、タスク ${id} の実行を始めていない`);
    await starts.mock.results[index]?.value;
    // Worker は、実行の終わりに続く処理（マイクロタスク）で枠を空ける。イベントループを一巡させれば、済んでいる
    await new Promise((resolve) => setImmediate(resolve));
  };

  function setup(settings: MemorySettingsStore, planner?: ServiceDeps["planner"]) {
    const activity = new SqliteActivityStore(dbPath);
    const executor = new HeldExecutor();
    const service = new TaskService({
      activity,
      config: configOf(agent()),
      secrets: new MemorySecretStore({ "claude-oauth-token": "oauth-secret" }),
      executor,
      repos: new FakeRepos(),
      pulls: new FakePulls(),
      projects: projectsWithAccount(),
      contexts: new FakeContexts(),
      settings,
      github: new FakeGitHub(),
      // 情報収集はせずに進める（工程の並行実行だけを確かめる）
      gatherer: async () => undefined,
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
    const [first] = ["タスク1", "タスク2", "タスク3"].map((title) =>
      service.createTask({ projectId: "default", title }),
    );
    const worker = new Worker(service, 60_000);
    const starts = startsOf(service);
    void worker.tick();
    // 上限を超えて始めていないことは、始めた数で確かめる（3 件目が遅れて実行に入るのを、待ちの長さに頼らずに見つける）
    expect(starts).toHaveBeenCalledTimes(2);
    await held(executor, ["タスク1", "タスク2"]);
    expect(executor.titles()).toEqual(["タスク1", "タスク2"]);
    // 実行中のタスクは、重ねて始めない（上限にも達している）
    void worker.tick();
    expect(starts).toHaveBeenCalledTimes(2);
    expect(executor.titles()).toEqual(["タスク1", "タスク2"]);

    executor.finish("タスク1");
    await freed(starts, first?.id ?? "");
    void worker.tick();
    expect(starts).toHaveBeenCalledTimes(3);
    await held(executor, ["タスク2", "タスク3"]);
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
    await held(executor, ["タスクA", "タスクB"]);
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
    const { activity, executor, service } = setup(new MemorySettingsStore(), async () => {
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
    const starts = startsOf(service);
    void worker.tick();
    await waitFor(() => calls >= 1, { what: "工程を選び始めること" });
    expect(service.get(task.id)?.task.status).toBe("queued");
    void worker.tick();
    // 重ねて始めていないことは、始めた数で確かめる（2 回目が遅れて工程を選び始めるのを、待ちの長さに頼らずに見つける）
    expect(starts).toHaveBeenCalledTimes(1);
    expect(calls).toBe(1);
    choosing.resolve();
    await held(executor, ["タスクA"]);
    expect(calls).toBe(1);
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

describe("組み合わせ skip-requirements（設計 → 実装。PBI-420）", () => {
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
        "sacty-test-viewpoints": [{ title: "A", input: "Aの入力", expected: "Aの期待結果" }],
      }),
    ].join("\n\n"),
  );
  const implement = out(
    [
      "# 実装の説明",
      block({ "sacty-test-map": [{ viewpointId: "TV-1", tests: ["a.test.ts › A"] }] }),
    ].join("\n\n"),
  );
  const promptOf = (executor: FakeExecutor, i: number) =>
    executor.calls[i]?.command.join(" ") ?? "";
  it("組み合わせの工程は、設計 → 実装 → マージの後の監視で、要求要件の工程を持たない", () => {
    expect(STEP_PLANS["skip-requirements"]).toEqual(["design", "implement", "deployment"]);
  });

  it("人が指定したタスクは、オーケストレーターに組み合わせを選び直させず、設計 → 設計の承認 → 実装の順に進む", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(
      activity,
      [
        out(
          block({
            "sacty-steps": { plan: "skip-requirements", reason: "指定", testCommand: "npm test" },
          }),
        ),
        design,
        implement,
      ],
      { realPlanner: true },
    );
    const task = service.createTask({
      projectId: "default",
      title: "国コード",
      body: "国コードを足す",
      plan: "skip-requirements",
    });
    await service.runNext(task.id);
    // オーケストレーターの候補は、人が指定した組み合わせだけ
    expect(promptOf(executor, 0)).toContain('"plan": "skip-requirements"');
    expect(promptOf(executor, 0)).not.toContain('"plan": "standard');
    expect(service.get(task.id)?.task.steps.map((s) => s.key)).toEqual([
      "design",
      "implement",
      "deployment",
    ]);
    // 最初の実行は設計。人が指定したので、「オーケストレーターの判断で」とは書かない
    expect(executor.calls).toHaveLength(2);
    expect(promptOf(executor, 1)).toContain("設計とテスト観点を作ってください");
    expect(promptOf(executor, 1)).not.toContain("オーケストレーターの判断で");
    expect(service.get(task.id)?.task.gate).toEqual({ step: "design", submission: 1 });
    // 設計の承認の後に、実装に進む（要求要件の工程は無い）
    service.approve(task.id, { step: "design", submission: 1 });
    await service.runNext(task.id);
    expect(executor.calls).toHaveLength(3);
    expect(promptOf(executor, 2)).toContain(
      "依頼（下のタスクの内容）と、人間が承認した設計に従って実装し",
    );
    expect(promptOf(executor, 2)).toContain("国コードを足す");
    const steps = (service.get(task.id)?.activity ?? [])
      .filter((e) => e.type === "AgentRunStarted")
      .map((e) => (e.type === "AgentRunStarted" ? e.payload.step : ""));
    expect(steps).toEqual(["design", "implement"]);
    activity.close();
  });

  it("人が指定したタスクは、オーケストレーターが別の組み合わせ（standard）を答えても選び直さない", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(
      activity,
      [
        out(
          block({
            "sacty-steps": { plan: "standard", reason: "標準にする", testCommand: "npm test" },
          }),
        ),
        design,
      ],
      { realPlanner: true },
    );
    const task = service.createTask({
      projectId: "default",
      title: "国コード",
      body: "国コードを足す",
      plan: "skip-requirements",
    });
    await service.runNext(task.id);
    // 答えは採用されず、standard（要求要件を持つ組み合わせ）の工程にはならない
    const got = service.get(task.id)?.task;
    expect(got?.stepsChoice?.plan).not.toBe("standard");
    expect(got?.steps.some((s) => s.key === "requirements")).toBe(false);
    activity.close();
  });

  it("オーケストレーターが選んだタスクの最初の設計の実行に、選んだ理由を渡す", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service, executor } = makeService(activity, [design], {
      planner: async () => ({
        steps: [...STEP_PLANS["skip-requirements"]],
        plan: "skip-requirements",
        reason: "要求要件を省く。確かめたい点：(1) 既存のフラグの意味",
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      }),
    });
    const task = service.createTask({ projectId: "default", title: "国コード", body: "足す" });
    await service.runNext(task.id);
    expect(promptOf(executor, 0)).toContain(
      '{"orchestratorReason":"要求要件を省く。確かめたい点：(1) 既存のフラグの意味"}',
    );
    expect(promptOf(executor, 0)).toContain(
      "オーケストレーターの判断で、要求要件の工程を省きました",
    );
    activity.close();
  });

  it("組み合わせごとの予算（budget.per_plan_usd）のキーに受ける", async () => {
    const activity = new SqliteActivityStore(dbPath);
    const { service } = makeService(activity, [design], {
      planner: async () => ({
        steps: [...STEP_PLANS["skip-requirements"]],
        plan: "skip-requirements",
        reason: "r",
        fallback: false,
        testCommand: "npm test",
        costUsd: 0,
        estimated: false,
      }),
      config: () => {
        const base = configOf(agent())();
        return base.ok
          ? {
              ok: true,
              config: { ...base.config, budgetPerPlanUsd: { "skip-requirements": 7 } },
            }
          : base;
      },
    });
    const task = service.createTask({ projectId: "default", title: "A" });
    await service.runNext(task.id);
    expect(service.get(task.id)?.task.budget.capUsd).toBe(7);
    activity.close();
  });
});
