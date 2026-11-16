import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMessage, type Task } from "@sacty/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import type { AgentExecutor } from "./agents/docker.js";
import type { AgentOutcome } from "./agents/parse.js";
import type { ConfigResult } from "./config.js";
import { MemoryProjectStore } from "./projects.js";
import { buildPullRequestBodyText, joinBodyText } from "./prompts.js";
import { RISK_ASSESSMENT_HEADING } from "./risk-assessment.js";
import { MemorySecretStore } from "./secrets.js";
import { TaskService } from "./service.js";
import { MemorySettingsStore } from "./settings.js";

// PR を作る前のリスク評価を、サービスがオーケストレーターのエージェントで実行して記録する（PBI-362）。
// PR の作成の流れ（プッシュ・PR の作成）は通さず、評価の実行と記録（assessRisk）を、偽の実行器で確かめる。

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-risk-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const unused = new Proxy({}, { get: () => () => Promise.reject(new Error("unused")) });

const agent = {
  id: "stub",
  runtime: "claude-code",
  auth: { mode: "subscription", secret: "claude-oauth-token" },
  price: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 },
};

const config = (): ConfigResult =>
  ({
    ok: true,
    config: {
      image: "sacty-agent:test",
      defaultAgent: agent,
      guardianAgent: agent,
      auditAgent: agent,
      budgetPerTaskUsd: 1,
      budgetPerAuditUsd: 1,
      gatewayRetry: { maxAttempts: 8, maxWaitMs: 600_000 },
      hostAddress: "host-gateway",
      imageBuild: {},
      platforms: [],
      hostMcp: [],
    },
  }) as unknown as ConfigResult;

const usage = { input: 10, cacheRead: 0, cacheWrite: 0, output: 5 };
const completed = (output: string): AgentOutcome =>
  ({ kind: "completed", output, usage }) as AgentOutcome;
const answer = (level: string) =>
  `\`\`\`json\n${JSON.stringify({
    [RISK_ASSESSMENT_HEADING]: {
      level,
      signals: [],
      change: "変更",
      scope: "範囲",
      reversibility: "戻せる",
      verification: "テストで確かめた",
      focus: [],
    },
  })}\n\`\`\``;

class Executor implements AgentExecutor {
  prompts: string[] = [];
  constructor(private readonly outcomes: AgentOutcome[]) {}
  async run(input: Parameters<AgentExecutor["run"]>[0]): Promise<AgentOutcome> {
    this.prompts.push(JSON.stringify(input.invocation));
    const next = this.outcomes.shift();
    if (!next) throw new Error("no outcome");
    return next;
  }
  kill(): void {}
  async ensureStopped(): Promise<boolean> {
    return true;
  }
}

type Internals = {
  mustGet(id: string): Task;
  assessRisk(
    task: Task,
    config: unknown,
    code: { base: string; commit: string },
    secrets: readonly string[],
  ): Promise<"done" | "stopped">;
};

function setup(outcomes: AgentOutcome[], deps: { riskAssessment?: boolean } = {}) {
  const activity = new SqliteActivityStore(join(dir, "sacty.db"));
  const executor = new Executor(outcomes);
  const service = new TaskService({
    activity,
    config,
    secrets: new MemorySecretStore({ "claude-oauth-token": "tok-secret" }),
    executor,
    repos: unused as never,
    tests: unused as never,
    pulls: unused as never,
    projects: new MemoryProjectStore(),
    settings: new MemorySettingsStore({}),
    github: unused as never,
    workspaceRoot: join(dir, "workspaces"),
    ...(deps.riskAssessment === false ? {} : { riskAssessment: true }),
  });
  const project = service.saveProject(undefined, {
    name: "決済",
    githubAccounts: { "github.com": "me" },
    targets: [{ scope: "repo", target: "https://github.com/acme/payments" }],
  });
  const task = service.createTask({
    projectId: project.id,
    title: "予約のキャンセル",
    body: "内容",
  });
  const cfg = config();
  if (!cfg.ok) throw new Error("config");
  const internals = service as unknown as Internals;
  const latest = () => internals.mustGet(task.id);
  const assess = (commit = "c".repeat(40)) =>
    internals.assessRisk(latest(), cfg.config, { base: "b".repeat(40), commit }, []);
  const risks = () => activity.forTask(task.id).filter((e) => e.type === "PullRequestRiskAssessed");
  return { executor, latest, assess, risks };
}

describe("PR を作る前のリスク評価の実行と記録（PBI-362）", () => {
  it("オーケストレーターのエージェントに評価させ、評価と費用を記録する。PR の本文に節が入る", async () => {
    const { executor, latest: get, assess, risks } = setup([completed(answer("medium"))]);
    expect(await assess()).toBe("done");
    expect(executor.prompts).toHaveLength(1);
    expect(executor.prompts[0]).toContain(`git diff ${"b".repeat(40)} ${"c".repeat(40)}`);
    const [event] = risks();
    expect(event?.actor).toBe("orchestrator");
    expect(event?.payload).toMatchObject({
      via: "publish",
      commit: "c".repeat(40),
      assessment: { level: "medium" },
      agentId: "stub",
    });
    const latest = get();
    expect(latest.riskAssessment?.assessment?.level).toBe("medium");
    expect(joinBodyText(buildPullRequestBodyText(latest))).toContain("- 段階：**中**");
  });

  it("答えを読めなくても止めず、評価できなかったと記録する。PR の本文に、評価できなかったことが入る", async () => {
    const { latest: get, assess, risks } = setup([completed("分かりません")]);
    expect(await assess()).toBe("done");
    const [event] = risks();
    expect(event?.actor).toBe("sacty");
    expect(event?.payload).toMatchObject({ via: "publish", agentId: "stub" });
    const latest = get();
    expect(latest.status).not.toBe("paused");
    expect(latest.riskAssessment?.assessment).toBeUndefined();
    expect(joinBodyText(buildPullRequestBodyText(latest))).toContain(
      "- 評価できませんでした（エージェントの出力から、リスク評価を読み取れませんでした）。",
    );
  });

  it("実行に失敗しても止めず、評価できなかった理由を記録する", async () => {
    const {
      latest: get,
      assess,
      risks,
    } = setup([
      { kind: "failed", reason: "error", message: "コンテナを起動できません" } as AgentOutcome,
    ]);
    expect(await assess()).toBe("done");
    const [event] = risks();
    const reason = (event?.payload as { reason?: never } | undefined)?.reason;
    expect(renderMessage(reason ?? "", "ja")).toContain("コンテナを起動できません");
    expect(renderMessage(reason ?? "", "en")).toContain("could not assess the risk");
    expect(get().status).not.toBe("paused");
  });

  it("同じコミットを評価済みなら、評価し直さない。コミットが変われば、評価し直す。評価できなかったコミットは、やり直す", async () => {
    const { executor, assess, risks } = setup([
      completed("読めない"),
      completed(answer("low")),
      completed(answer("high")),
    ]);
    await assess("1".repeat(40));
    await assess("1".repeat(40));
    expect(executor.prompts).toHaveLength(2);
    await assess("1".repeat(40));
    expect(executor.prompts).toHaveLength(2);
    await assess("2".repeat(40));
    expect(executor.prompts).toHaveLength(3);
    expect(
      risks().map((e) => (e.payload as { assessment?: { level: string } }).assessment?.level),
    ).toEqual([undefined, "low", "high"]);
  });

  it("評価を有効にしていないサービス（riskAssessment が無い）は、評価しない", async () => {
    const off = setup([completed(answer("low"))], { riskAssessment: false });
    expect(await off.assess()).toBe("done");
    expect(off.executor.prompts).toHaveLength(0);
    expect(off.risks()).toHaveLength(0);
  });
});
