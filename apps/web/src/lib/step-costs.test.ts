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

  it("ゴールガーディアンの実行の失敗・中断は、判定の記録でも「完了」にしない（以前の記録は理由の文言で判別する）", () => {
    seq = 0;
    const failed = { code: "run.guardianFailed", params: { detail: "401 Unauthorized" } } as const;
    const interrupted = { code: "run.guardianInterrupted" } as const;
    const judged = (payload: Record<string, unknown>, type = "ChangeJudged") =>
      ev(
        (type === "ChangeJudged"
          ? {
              type,
              payload: { proposalId: "CP-1", verdict: "undecidable", agentId: "g", ...payload },
            }
          : { type, payload: { agentId: "g", ...payload } }) as EventInput,
        "guardian",
      );
    const events = [
      // 記録した実行の結果
      judged({ reason: failed, runResult: "failed" }),
      judged({ reason: interrupted, runResult: "interrupted" }),
      judged({ reason: "判断できない", runResult: "completed" }),
      judged({ reason: failed, runResult: "failed" }, "ReworkJudged"),
      // 以前の記録（実行の結果が無い）
      judged({ reason: failed }),
      judged({ reason: interrupted }),
      judged({ reason: failed }, "ReworkJudged"),
      judged({ reason: "PR の指摘は実装で直せる" }, "ReworkJudged"),
      // 実行の結果の記録は、理由の文言より優先する
      judged({ reason: "途中で止まった", runResult: "interrupted" }),
    ];
    const task = { id: "t1", steps: [] as Task["steps"] } as Task;
    const { rows } = stepCosts(task, events);
    expect(rows[0]?.runs.map((r) => r.result)).toEqual([
      "failed",
      "interrupted",
      "completed",
      "failed",
      "failed",
      "interrupted",
      "failed",
      "completed",
      "interrupted",
    ]);
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

describe("質問への答えの費用（PBI-54）", () => {
  const asked = (questionId: string) =>
    ev({ type: "QuestionAsked", payload: { questionId, text: "いまどこ？" } }, "person");

  it("質問が無ければ行を出さず、答えた・答えられなかった・中断した回をすべて「質問への答え」の行に出す。合計はタスクの費用と一致する", () => {
    const none = history();
    expect(stepCosts(taskOf(none), none).rows.map((r) => r.role)).not.toContain("chat");

    const events = [
      ...history(),
      asked("Q-1"),
      ev(
        {
          type: "QuestionAnswered",
          payload: {
            questionId: "Q-1",
            answer: "設計です",
            runResult: "completed",
            agentId: "orc",
            authMode: "api-key",
            model: "gpt-x",
            usage: usage(300, 30),
            costUsd: 0.03,
          },
        },
        "orchestrator",
      ),
      asked("Q-2"),
      ev(
        {
          type: "QuestionAnswered",
          payload: {
            questionId: "Q-2",
            failed: "失敗",
            runResult: "failed",
            agentId: "orc",
            usage: usage(10, 1),
            costUsd: 0.001,
            estimated: true,
          },
        },
        "orchestrator",
      ),
      asked("Q-3"),
      ev({
        type: "QuestionAnswered",
        payload: {
          questionId: "Q-3",
          failed: "止まった",
          runResult: "interrupted",
          agentId: "unknown",
        },
      }),
    ];
    const task = taskOf(events);
    const { rows, total } = stepCosts(task, events);
    // 工程の行の後、ゴールガーディアンの前
    expect(rows.map((r) => r.role)).toEqual([
      "orchestrator",
      "requirements",
      "design",
      "implement",
      "pr",
      "chat",
      "guardian",
    ]);
    const chat = rows.find((r) => r.role === "chat");
    expect(chat?.runs.map((r) => [r.result, r.costUsd, r.model])).toEqual([
      ["completed", 0.03, "gpt-x"],
      ["failed", 0.001, undefined],
      ["interrupted", 0, undefined],
    ]);
    expect(chat).toMatchObject({ costUsd: 0.031, estimated: true, usage: usage(310, 31) });
    expect(total.costUsd).toBe(task.budget.usedUsd);
  });
});

describe("成果の書き出しの費用（PBI-56）", () => {
  const exported = (payload: Record<string, unknown>) =>
    ev(
      {
        type: "OutputExported",
        payload: {
          step: "requirements",
          runId: `x${seq}`,
          approvedAt: "2026-10-10T00:00:00.000Z",
          submission: 1,
          via: "platform",
          name: "confluence",
          agentId: "claude",
          costUsd: 0,
          ...payload,
        },
      } as EventInput,
      "agent",
    );

  it("書き出しが無ければ行を出さず、書き出した・書き出せなかった・中断した回を「書き出し」の行に出す。合計はタスクの費用と一致する", () => {
    const none = history();
    expect(stepCosts(taskOf(none), none).rows.map((r) => r.role)).not.toContain("export");
    const events = [
      ...history(),
      exported({
        url: "https://wiki/1",
        runResult: "completed",
        usage: usage(100, 10),
        costUsd: 0.02,
      }),
      exported({ failed: "権限", runResult: "completed", costUsd: 0.005, estimated: true }),
      exported({ failed: "止めた", runResult: "interrupted", costUsd: 0.001 }),
    ];
    const task = taskOf(events);
    const { rows, total } = stepCosts(task, events);
    expect(rows.map((r) => r.role)).toEqual([
      "orchestrator",
      "requirements",
      "design",
      "implement",
      "pr",
      "export",
      "guardian",
    ]);
    const row = rows.find((r) => r.role === "export");
    expect(row?.runs.map((r) => [r.result, r.costUsd])).toEqual([
      ["completed", 0.02],
      ["completed", 0.005],
      ["interrupted", 0.001],
    ]);
    expect(row).toMatchObject({ costUsd: 0.026, estimated: true });
    expect(total.costUsd).toBe(task.budget.usedUsd);
  });
});
