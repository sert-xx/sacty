import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "@sacty/core";
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
import { FakeRepos } from "./testing/daemon.js";

// 前回の評価以降の差分が文書だけのとき、PR を更新する前のリスク評価を、エージェントを実行せずに引き継ぐ（PBI-421）。

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-risk-inherit-"));
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
const unreadable = completed("分かりません");

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
  append(task: Task, events: { actor: string; event: unknown }[]): void;
  assessRisk(
    task: Task,
    config: unknown,
    code: { base: string; commit: string },
    secrets: readonly string[],
  ): Promise<"done" | "stopped">;
};

const C1 = "1".repeat(40);
const C2 = "2".repeat(40);
const C3 = "3".repeat(40);
const C4 = "4".repeat(40);
const BASE = "b".repeat(40);

function setup(outcomes: AgentOutcome[]) {
  const activity = new SqliteActivityStore(join(dir, "sacty.db"));
  const executor = new Executor(outcomes);
  const repos = new FakeRepos();
  const service = new TaskService({
    activity,
    config,
    secrets: new MemorySecretStore({ "claude-oauth-token": "tok-secret" }),
    executor,
    repos,
    tests: unused as never,
    pulls: unused as never,
    projects: new MemoryProjectStore(),
    settings: new MemorySettingsStore({}),
    github: unused as never,
    workspaceRoot: join(dir, "workspaces"),
    riskAssessment: true,
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
  const assess = (commit: string, base = BASE) =>
    internals.assessRisk(latest(), cfg.config, { base, commit }, []);
  const risks = () => activity.forTask(task.id).filter((e) => e.type === "PullRequestRiskAssessed");
  const append = (t: Task, events: { actor: string; event: unknown }[]) =>
    internals.append(t, events);
  return { executor, repos, latest, assess, risks, append };
}

type Payload = {
  commit?: string;
  base?: string;
  inheritedFrom?: string;
  assessment?: { level: string };
  costUsd?: number;
  agentId?: string;
};
const payloads = (events: { payload: unknown }[]) => events.map((e) => e.payload as Payload);

describe("前回の評価の引き継ぎ（PBI-421）", () => {
  it("前回の評価以降が文書だけなら、エージェントを実行せず、前回の評価を引き継ぐ。PR の説明に前回の評価が載る", async () => {
    const { executor, repos, latest, assess, risks } = setup([completed(answer("high"))]);
    await assess(C1);
    repos.changedBetween[`${C1}..${C2}`] = ["docs/a.md"];

    expect(await assess(C2)).toBe("done");

    expect(executor.prompts).toHaveLength(1);
    const [first, second] = payloads(risks());
    expect(first).toMatchObject({ commit: C1, base: BASE, agentId: "stub" });
    expect(first?.inheritedFrom).toBeUndefined();
    expect(second).toMatchObject({
      commit: C2,
      base: BASE,
      inheritedFrom: C1,
      assessment: first?.assessment,
      costUsd: 0,
    });
    expect(second?.agentId).toBeUndefined();
    expect(risks()[1]?.actor).toBe("sacty");
    expect(latest().riskAssessment).toMatchObject({ commit: C2, inheritedFrom: C1 });
    expect(joinBodyText(buildPullRequestBodyText(latest()))).toContain("- 段階：**高**");
  });

  it("評価し直す条件では引き継がず、エージェントを実行して、新しい記録に今回の base を入れる", async () => {
    const cases: {
      name: string;
      prepare: (s: ReturnType<typeof setup>) => void;
      first?: AgentOutcome;
      base?: string;
    }[] = [
      {
        name: "前回以降に文書でないファイルがある",
        prepare: (s) => {
          s.repos.changedBetween[`${C1}..${C2}`] = ["docs/a.md", "src/x.ts"];
        },
      },
      {
        name: "前回が評価できなかった（理由だけの記録）",
        first: unreadable,
        prepare: (s) => {
          s.repos.changedBetween[`${C1}..${C2}`] = ["docs/a.md"];
        },
      },
      {
        name: "base が前回と違う",
        base: "e".repeat(40),
        prepare: (s) => {
          s.repos.changedBetween[`${C1}..${C2}`] = ["docs/a.md"];
        },
      },
      {
        name: "前回のコミットが今回の祖先でない",
        prepare: (s) => {
          s.repos.changedBetween[`${C1}..${C2}`] = ["docs/a.md"];
          s.repos.notAncestor = true;
        },
      },
      {
        name: "エージェントへの指示の文書",
        prepare: (s) => {
          s.repos.changedBetween[`${C1}..${C2}`] = ["AGENTS.md"];
        },
      },
      {
        name: "スキルを消すだけの差分（名前が SKILL.md）",
        prepare: (s) => {
          s.repos.changedBetween[`${C1}..${C2}`] = [
            "skills/x/SKILL.md",
            "skills/x/references/a.md",
          ];
        },
      },
      {
        name: "パスに改行がある",
        prepare: (s) => {
          s.repos.changedBetween[`${C1}..${C2}`] = ["docs/a\n- 省く.md"];
        },
      },
      {
        name: "祖先かどうかを確かめられない（例外）",
        prepare: (s) => {
          s.repos.changedBetween[`${C1}..${C2}`] = ["docs/a.md"];
          s.repos.ancestorFail = "unreachable";
        },
      },
      {
        name: "差分が空",
        prepare: (s) => {
          s.repos.changedBetween[`${C1}..${C2}`] = [];
        },
      },
    ];
    for (const c of cases) {
      rmSync(dir, { recursive: true, force: true });
      dir = mkdtempSync(join(tmpdir(), "sacty-risk-inherit-"));
      const s = setup([c.first ?? completed(answer("low")), completed(answer("medium"))]);
      await s.assess(C1);
      c.prepare(s);
      await s.assess(C2, c.base ?? BASE);
      expect(s.executor.prompts, c.name).toHaveLength(2);
      const last = payloads(s.risks()).at(-1);
      expect(last, c.name).toMatchObject({ commit: C2, base: c.base ?? BASE, agentId: "stub" });
      expect(last?.inheritedFrom, c.name).toBeUndefined();
    }
  });

  it("前回の記録が base を持たなければ、引き継がずに評価し直す", async () => {
    const { executor, repos, assess, latest, risks, append } = setup([
      completed(answer("low")),
      completed(answer("medium")),
    ]);
    await assess(C1);
    // base の無い記録（この変更の前のもの）に置き換える
    const {
      base: _base,
      agentId: _agent,
      ...old
    } = payloads(risks())[0] as Payload & Record<string, unknown>;
    append(latest(), [
      {
        actor: "sacty",
        event: { type: "PullRequestRiskAssessed", payload: { via: "publish", ...old } },
      },
    ]);
    expect(latest().riskAssessment?.base).toBeUndefined();
    repos.changedBetween[`${C1}..${C2}`] = ["docs/a.md"];
    await assess(C2);
    expect(executor.prompts).toHaveLength(2);
    expect(payloads(risks()).at(-1)).toMatchObject({ commit: C2, base: BASE, agentId: "stub" });
  });

  it("スキルのディレクトリの下の文書は、文書だけにせず、評価し直す", async () => {
    const { executor, repos, assess } = setup([
      completed(answer("low")),
      completed(answer("high")),
    ]);
    await assess(C1);
    repos.changedBetween[`${C1}..${C2}`] = ["skills/x/references/a.md"];
    repos.files[C2] = { "skills/x/SKILL.md": "---\nname: x\n---" };
    await assess(C2);
    expect(executor.prompts).toHaveLength(2);
  });

  it("何回か引き継いだ後も評価した元のコミットを指し、文書でない変更が入ったら評価し直す", async () => {
    const { executor, repos, latest, assess, risks } = setup([
      completed(answer("high")),
      completed(answer("low")),
    ]);
    await assess(C1);
    repos.changedBetween[`${C1}..${C2}`] = ["docs/a.md"];
    await assess(C2);
    repos.changedBetween[`${C2}..${C3}`] = ["docs/b.md"];
    await assess(C3);
    repos.changedBetween[`${C3}..${C4}`] = ["src/x.ts"];
    await assess(C4);

    const all = payloads(risks());
    expect(all[1]?.inheritedFrom).toBe(C1);
    expect(all[2]?.inheritedFrom).toBe(C1);
    expect(executor.prompts).toHaveLength(2);
    expect(all[3]).toMatchObject({ commit: C4, agentId: "stub", assessment: { level: "low" } });
    expect(all[3]?.inheritedFrom).toBeUndefined();
    expect(latest().riskAssessment).toMatchObject({ commit: C4, assessment: { level: "low" } });
    expect(latest().riskAssessment?.inheritedFrom).toBeUndefined();
  });

  it("PR から取り込んだレビューのタスクの評価（via が review）は、引き継ぎの対象にせず、評価し直す", async () => {
    const { executor, repos, assess, latest, risks, append } = setup([completed(answer("medium"))]);
    append(latest(), [
      {
        actor: "agent",
        event: {
          type: "PullRequestRiskAssessed",
          payload: {
            via: "review",
            commit: C1,
            assessment: {
              level: "low",
              signals: [],
              change: "変更",
              scope: "範囲",
              reversibility: "戻せる",
              verification: "テスト",
              focus: [],
            },
          },
        },
      },
    ]);
    repos.changedBetween[`${C1}..${C2}`] = ["docs/a.md"];
    await assess(C2);
    expect(executor.prompts).toHaveLength(1);
    const [review, publish] = payloads(risks());
    expect(review?.inheritedFrom).toBeUndefined();
    expect(review?.base).toBeUndefined();
    expect(publish).toMatchObject({ commit: C2, agentId: "stub" });
    expect(publish?.inheritedFrom).toBeUndefined();
  });

  it("同じコミットの再試行は、評価も記録もしない", async () => {
    const { executor, assess, risks } = setup([completed(answer("low"))]);
    await assess(C1);
    await assess(C1);
    expect(executor.prompts).toHaveLength(1);
    expect(risks()).toHaveLength(1);
  });
});
