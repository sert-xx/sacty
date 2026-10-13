import { type ActivityEvent, EventInput, project, type Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { stepCosts } from "./step-costs";

let seq = 0;
const ev = (input: EventInput, actor: ActivityEvent["actor"] = "sacty", taskId = "t1") =>
  ({
    ...EventInput.parse(input),
    seq: ++seq,
    id: `e${seq}`,
    taskId,
    projectId: "default",
    actor,
    at: `2026-10-10T00:00:${String(seq).padStart(2, "0")}.000Z`,
  }) as ActivityEvent;

const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite,
});
const created = () =>
  ev({ type: "TaskCreated", payload: { title: "t", body: "", start: "sacty" } }, "person");

/** 作業履歴をタスクの状態に適用する（projection が受け付ける並びであることも確かめる）。 */
function taskOf(events: ActivityEvent[]): Task {
  const task = project(events).get("t1");
  if (!task) throw new Error("no task");
  return task;
}

/**
 * オーケストレーターの失敗と選択、要求要件の3回の実行（完了・失敗・古い形の完了）、設計、
 * ゴールガーディアンの判定を含む作業履歴。
 */
function history(): ActivityEvent[] {
  seq = 0;
  return [
    created(),
    ev(
      {
        type: "OrchestratorFailed",
        payload: {
          reason: "error",
          message: "失敗",
          agentId: "orc",
          authMode: "api-key",
          usage: usage(100, 10),
          costUsd: 0.01,
        },
      },
      "orchestrator",
    ),
    ev(
      {
        type: "StepsChosen",
        payload: {
          steps: ["requirements", "design", "implement", "pr"],
          plan: "skip-design",
          reason: "理由",
          agentId: "orc",
          authMode: "api-key",
          model: "gpt-x",
          reasoningEffort: "low",
          usage: usage(200, 20),
          costUsd: 0.02,
        },
      },
      "orchestrator",
    ),
    ev({
      type: "AgentRunStarted",
      payload: {
        runId: "r1",
        step: "requirements",
        agentId: "a",
        authMode: "subscription",
        model: "m1",
        reasoningEffort: "high",
      },
    }),
    ev({
      type: "AgentRunCompleted",
      payload: {
        runId: "r1",
        step: "requirements",
        agentId: "a",
        authMode: "subscription",
        usage: usage(1000, 500, 300, 40),
        costUsd: 0.1,
        estimated: true,
        output: "# 要求要件",
      },
    }),
    ev({ type: "StepSubmitted", payload: { step: "requirements", submission: 1 } }),
    ev(
      {
        type: "ChangesRequested",
        payload: {
          step: "requirements",
          round: 1,
          remarks: [{ id: "requirements-1-1", text: "直して" }],
        },
      },
      "person",
    ),
    ev({
      type: "AgentRunStarted",
      payload: {
        runId: "r2",
        step: "requirements",
        agentId: "b",
        authMode: "api-key",
        model: "m2",
      },
    }),
    // 使用量の記録が無い失敗
    ev({
      type: "AgentRunFailed",
      payload: { runId: "r2", step: "requirements", agentId: "b", reason: "error", message: "x" },
    }),
    // PBI-46 より前の形（モデル・エフォートが無い）
    ev({
      type: "AgentRunStarted",
      payload: { runId: "r3", step: "requirements", agentId: "a", authMode: "subscription" },
    }),
    ev({
      type: "AgentRunCompleted",
      payload: {
        runId: "r3",
        step: "requirements",
        agentId: "a",
        authMode: "subscription",
        usage: usage(2000, 700, 0, 0),
        costUsd: 0.0105,
        estimated: true,
        output: "# 要求要件2",
      },
    }),
    ev({ type: "StepSubmitted", payload: { step: "requirements", submission: 2 } }),
    ev({ type: "StepApproved", payload: { step: "requirements", next: "queued" } }, "person"),
    ev({
      type: "AgentRunStarted",
      payload: { runId: "r4", step: "design", agentId: "a", authMode: "subscription" },
    }),
    ev({
      type: "AgentRunCompleted",
      payload: {
        runId: "r4",
        step: "design",
        agentId: "a",
        authMode: "subscription",
        usage: usage(10, 5),
        costUsd: 0.000001,
        estimated: false,
        output: "# 設計",
      },
    }),
    ev(
      {
        type: "ChangeProposed",
        payload: {
          proposalId: "CP-1",
          fromStep: "design",
          target: "requirements",
          reason: "r",
          facts: ["f"],
          proposed: "p",
        },
      },
      "agent",
    ),
    ev(
      {
        type: "ChangeJudged",
        payload: {
          proposalId: "CP-1",
          verdict: "rejected",
          reason: "理由",
          agentId: "g",
          authMode: "bedrock",
          model: "claude-x",
          usage: usage(50, 5),
          costUsd: 0.005,
        },
      },
      "guardian",
    ),
  ];
}

describe("工程ごとの費用（PBI-46）", () => {
  it("オーケストレーター・工程（タスクの工程の順）・ゴールガーディアンの順に行を出す。実行していない工程も0回で出す", () => {
    const events = history();
    const { rows } = stepCosts(taskOf(events), events);
    expect(rows.map((r) => [r.role, r.runs.length])).toEqual([
      ["orchestrator", 2],
      ["requirements", 3],
      ["design", 1],
      ["implement", 0],
      ["pr", 0],
      ["guardian", 1],
    ]);
    const implement = rows.find((r) => r.role === "implement");
    expect(implement).toMatchObject({ costUsd: 0, estimated: false });
    expect(implement?.usage).toBeUndefined();
  });

  it("行の費用の合計は、タスクの費用（予算の使用済み）と一致し、換算値を含むかも一致する", () => {
    const events = history();
    const task = taskOf(events);
    const { rows, total } = stepCosts(task, events);
    expect(task.budget.usedUsd).toBe(0.145501);
    expect(total.costUsd).toBe(task.budget.usedUsd);
    expect(rows.reduce((sum, r) => Math.round((sum + r.costUsd) * 1e6) / 1e6, 0)).toBe(
      task.budget.usedUsd,
    );
    expect(total.estimated).toBe(task.budget.estimated);
  });

  it("同じ工程を複数回動かすと、回数と合計を出し、各回の設定・使用量・費用・結果を残す", () => {
    const events = history();
    const requirements = stepCosts(taskOf(events), events).rows.find(
      (r) => r.role === "requirements",
    );
    expect(requirements?.costUsd).toBe(0.1105);
    expect(requirements?.estimated).toBe(true);
    // 使用量の記録が無い失敗は、合計に足さない
    expect(requirements?.usage).toEqual(usage(3000, 1200, 300, 40));
    expect(
      requirements?.runs.map((r) => [r.agentId, r.authMode, r.model, r.costUsd, r.result]),
    ).toEqual([
      ["a", "subscription", "m1", 0.1, "completed"],
      ["b", "api-key", "m2", 0, "failed"],
      ["a", "subscription", undefined, 0.0105, "completed"],
    ]);
    expect(requirements?.runs[1]?.usage).toBeUndefined();
    // 設定を変えて動かしたときは、回ごとの設定を持つ（記録の無い回は undefined で、画面では「—」）
    expect(requirements?.runs.map((r) => r.reasoningEffort)).toEqual([
      "high",
      undefined,
      undefined,
    ]);
  });

  it("オーケストレーターの失敗と選択の費用を1行にまとめ、ゴールガーディアンの判定も1行で出す", () => {
    const events = history();
    const { rows } = stepCosts(taskOf(events), events);
    const orchestrator = rows.find((r) => r.role === "orchestrator");
    expect(orchestrator?.costUsd).toBe(0.03);
    expect(orchestrator?.estimated).toBe(false);
    expect(orchestrator?.usage).toEqual(usage(300, 30));
    expect(orchestrator?.runs.map((r) => [r.result, r.model, r.reasoningEffort])).toEqual([
      ["failed", undefined, undefined],
      ["completed", "gpt-x", "low"],
    ]);
    const guardian = rows.find((r) => r.role === "guardian");
    expect(guardian?.runs).toEqual([
      expect.objectContaining({ agentId: "g", authMode: "bedrock", model: "claude-x" }),
    ]);
    expect(guardian?.costUsd).toBe(0.005);
  });

  it("古い作業履歴（固定の工程・モデルとエフォートの無い実行）は、記録の無い項目を持たず、合計は一致する。実行中の回も数える", () => {
    seq = 0;
    const events = [
      created(),
      // PBI-17 より前：オーケストレーターを動かしていない
      ev({
        type: "StepsChosen",
        payload: { steps: ["requirements", "design", "implement", "pr"] },
      }),
      ev({
        type: "AgentRunStarted",
        payload: { runId: "r1", step: "requirements", agentId: "a", authMode: "subscription" },
      }),
      ev({
        type: "AgentRunCompleted",
        payload: {
          runId: "r1",
          step: "requirements",
          agentId: "a",
          authMode: "subscription",
          usage: usage(1, 1),
          costUsd: 0.2,
          estimated: false,
          output: "x",
        },
      }),
      ev({ type: "StepSubmitted", payload: { step: "requirements", submission: 1 } }),
      ev(
        {
          type: "ChangesRequested",
          payload: {
            step: "requirements",
            round: 1,
            remarks: [{ id: "requirements-1-1", text: "x" }],
          },
        },
        "person",
      ),
      ev({
        type: "AgentRunStarted",
        payload: { runId: "r2", step: "requirements", agentId: "a", authMode: "subscription" },
      }),
      // 別のタスクの記録は数えない
      ev(
        {
          type: "AgentRunCompleted",
          payload: {
            runId: "r2",
            step: "requirements",
            agentId: "a",
            authMode: "subscription",
            usage: usage(1, 1),
            costUsd: 9,
            estimated: false,
            output: "x",
          },
        },
        "sacty",
        "other",
      ),
    ];
    const task = taskOf(events.filter((e) => e.taskId === "t1"));
    const { rows, total } = stepCosts(task, events);
    expect(rows.map((r) => r.role)).toEqual(["requirements", "design", "implement", "pr"]);
    const runs = rows[0]?.runs ?? [];
    expect(runs.map((r) => r.result)).toEqual(["completed", "running"]);
    expect(runs[0]).not.toHaveProperty("model");
    expect(runs[0]).not.toHaveProperty("reasoningEffort");
    expect(total.costUsd).toBe(task.budget.usedUsd);
    expect(total.costUsd).toBe(0.2);
  });

  it("費用・接続先の項目が無い古いゴールガーディアンの判定も1回として数え、記録の無い項目は持たない", () => {
    seq = 0;
    const judged = ev(
      {
        type: "ChangeJudged",
        payload: { proposalId: "CP-1", verdict: "undecidable", reason: "中断", agentId: "unknown" },
      },
      "sacty",
    );
    const task = { id: "t1", steps: [] as Task["steps"] } as Task;
    const { rows, total } = stepCosts(task, [judged]);
    expect(rows.map((r) => r.role)).toEqual(["guardian"]);
    expect(rows[0]?.runs[0]).toEqual({
      id: judged.id,
      at: judged.at,
      agentId: "unknown",
      costUsd: 0,
      estimated: false,
      result: "completed",
    });
    expect(total).toEqual({ usage: undefined, costUsd: 0, estimated: false });
  });

  it("開始の記録が無い実行も、費用を落とさない", () => {
    seq = 0;
    const done = ev({
      type: "AgentRunCompleted",
      payload: {
        runId: "lost",
        step: "design",
        agentId: "a",
        authMode: "api-key",
        usage: usage(1, 1),
        costUsd: 0.4,
        estimated: false,
        output: "x",
      },
    });
    const task = { id: "t1", steps: [{ key: "requirements", state: "active" }] } as Task;
    const { rows, total } = stepCosts(task, [done]);
    expect(rows.map((r) => [r.role, r.costUsd])).toEqual([
      ["requirements", 0],
      ["design", 0.4],
    ]);
    expect(rows[1]?.runs[0]).toMatchObject({ authMode: "api-key", result: "completed" });
    expect(total.costUsd).toBe(0.4);
  });
});
