import { describe, expect, it } from "vitest";
import { budgetState, computeCostUsd } from "./cost.js";
import type { EventInput, LedgerEvent } from "./events.js";
import { EventInput as EventSchema, MVP_STEPS } from "./events.js";
import { project } from "./projection.js";

let seq = 0;
const ev = (taskId: string, input: EventInput, actor: LedgerEvent["actor"] = "sacty") =>
  ({
    ...EventSchema.parse(input),
    seq: ++seq,
    id: `e${seq}`,
    taskId,
    projectId: "default",
    actor,
    at: "2026-10-10T00:00:00.000Z",
  }) as LedgerEvent;

const created = (taskId: string, budgetCapUsd?: number) =>
  ev(
    taskId,
    {
      type: "TaskCreated",
      payload: { title: `title ${taskId}`, body: "body", start: "ticket", budgetCapUsd },
    },
    "person",
  );
const steps = (taskId: string) =>
  ev(taskId, { type: "StepsChosen", payload: { steps: [...MVP_STEPS] } });
const started = (taskId: string, runId: string) =>
  ev(taskId, {
    type: "AgentRunStarted",
    payload: { runId, step: "requirements", agentId: "a", authMode: "subscription" },
  });
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0, output: 500 };
const completed = (taskId: string, runId: string, costUsd: number) =>
  ev(taskId, {
    type: "AgentRunCompleted",
    payload: {
      runId,
      step: "requirements",
      agentId: "a",
      authMode: "subscription",
      usage,
      costUsd,
      estimated: true,
      output: "# 要求要件",
    },
  });

describe("project", () => {
  it("台帳からタスクの状態を復元する（最初の工程が実行対象になる）", () => {
    seq = 0;
    const task = project([created("t1"), steps("t1")]).get("t1");
    expect(task?.status).toBe("queued");
    expect(task?.steps.map((s) => [s.key, s.state])).toEqual([
      ["requirements", "active"],
      ["design", "todo"],
      ["implement", "todo"],
      ["pr", "todo"],
    ]);
    expect(task?.budget).toEqual({ usedUsd: 0, capUsd: 1, warned: false, estimated: false });
  });

  it("PBI-1の台帳（予算の項目なし）も既定の予算で読める", () => {
    seq = 0;
    expect(project([created("t1")]).get("t1")?.budget.capUsd).toBe(1);
  });

  it("実行の完了で費用を加算し、出力を記録して待機に戻る", () => {
    seq = 0;
    const task = project([
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      completed("t1", "r1", 0.3),
    ]).get("t1");
    expect(task?.status).toBe("idle");
    expect(task?.budget.usedUsd).toBe(0.3);
    expect(task?.budget.estimated).toBe(true);
    expect(task?.outputs.requirements).toBe("# 要求要件");
    expect(task?.currentRunId).toBeUndefined();
  });

  it("予算で止まり、新しい上限で再開すると待機に戻る", () => {
    seq = 0;
    const task = project([
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      completed("t1", "r1", 1.02),
      ev("t1", { type: "TaskPaused", payload: { reason: "budget" } }),
      ev("t1", { type: "BudgetCapRaised", payload: { capUsd: 3 } }, "person"),
      ev("t1", { type: "TaskResumed", payload: { retry: false } }, "person"),
    ]).get("t1");
    expect(task?.status).toBe("idle");
    expect(task?.budget.capUsd).toBe(3);
    expect(task?.pausedReason).toBeUndefined();
  });

  it("利用上限で失敗して止まり、再開するとやり直しのため実行待ちに戻る", () => {
    seq = 0;
    const untilPaused = [
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      ev("t1", {
        type: "AgentRunFailed",
        payload: {
          runId: "r1",
          step: "requirements",
          agentId: "a",
          reason: "usage_limit",
          message: "429",
        },
      }),
      ev("t1", { type: "TaskPaused", payload: { reason: "usage_limit" } }),
    ];
    const paused = project(untilPaused).get("t1");
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("usage_limit");

    const resumed = project([
      ...untilPaused,
      ev("t1", { type: "TaskResumed", payload: { retry: true } }, "person"),
    ]).get("t1");
    expect(resumed?.status).toBe("queued");
  });

  it("使用済み以下の上限への変更は受け付けない", () => {
    seq = 0;
    expect(() =>
      project([
        created("t1"),
        steps("t1"),
        started("t1", "r1"),
        completed("t1", "r1", 1.5),
        ev("t1", { type: "TaskPaused", payload: { reason: "budget" } }),
        ev("t1", { type: "BudgetCapRaised", payload: { capUsd: 1.5 } }),
      ]),
    ).toThrow(/must exceed/);
  });

  it("実行中でないタスクの実行完了や、一時停止中でないタスクの再開は受け付けない", () => {
    seq = 0;
    expect(() => project([created("t1"), steps("t1"), completed("t1", "r1", 0.1)])).toThrow(
      /run id/,
    );
    seq = 0;
    expect(() =>
      project([created("t1"), ev("t1", { type: "TaskResumed", payload: { retry: true } })]),
    ).toThrow(/status queued/);
  });

  it("承認済みの工程の実行完了は、凍結されているため受け付けない（PBI-8）", () => {
    seq = 0;
    const base = [
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      completed("t1", "r1", 0.1),
      ev("t1", { type: "StepSubmitted", payload: { step: "requirements", submission: 1 } }),
      ev(
        "t1",
        { type: "StepApproved", payload: { step: "requirements", next: "queued" } },
        "person",
      ),
    ];
    const task = project(base).get("t1");
    expect(task?.approved.requirements).toMatchObject({ submission: 1, output: "# 要求要件" });
    expect(() => project([...base, started("t1", "r2"), completed("t1", "r2", 0.1)])).toThrow(
      /frozen/,
    );
  });

  it("PBI-7の台帳（差し戻し先なし）は、承認ゲートの工程への差し戻しとして読む", () => {
    seq = 0;
    const task = project([
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      completed("t1", "r1", 0.1),
      ev("t1", { type: "StepSubmitted", payload: { step: "requirements", submission: 1 } }),
      ev(
        "t1",
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
    ]).get("t1");
    expect(task?.remarks[0]?.step).toBe("requirements");
    expect(task?.steps[0]?.state).toBe("active");
    expect(task?.testViewpoints).toEqual([]);
  });

  it("認められた設計の変更は、承認済みの設計とテスト観点を置き換える（PBI-9）", () => {
    seq = 0;
    const run = (runId: string, step: "requirements" | "design", output: string) => [
      ev("t1", {
        type: "AgentRunStarted",
        payload: { runId, step, agentId: "a", authMode: "subscription" },
      }),
      ev("t1", {
        type: "AgentRunCompleted",
        payload: {
          runId,
          step,
          agentId: "a",
          authMode: "subscription",
          usage,
          costUsd: 0,
          estimated: true,
          output,
          testViewpoints:
            step === "design" ? [{ id: "TV-1", title: "旧", input: "i", expected: "e" }] : [],
        },
      }),
      ev("t1", { type: "StepSubmitted", payload: { step, submission: 1 } }),
      ev("t1", { type: "StepApproved", payload: { step, next: "queued" } }, "person"),
    ];
    const base = [
      created("t1"),
      steps("t1"),
      ...run("r1", "requirements", "# 要求要件"),
      ...run("r2", "design", "# 設計"),
      ...run("r3", "implement" as "design", "# 実装").slice(0, 2),
      ev("t1", {
        type: "ChangeProposed",
        payload: {
          proposalId: "CP-1",
          fromStep: "implement",
          target: "design",
          reason: "r",
          facts: ["f"],
          proposed: "# 設計 v2",
          testViewpoints: [{ id: "TV-1", title: "新", input: "i", expected: "e" }],
        },
      }),
    ];
    const judged = ev("t1", {
      type: "ChangeJudged",
      payload: { proposalId: "CP-1", verdict: "approved", reason: "ok", agentId: "g" },
    });
    const applied = ev("t1", { type: "ChangeApplied", payload: { proposalId: "CP-1" } });
    const task = project([...base, judged, applied]).get("t1");
    expect(task?.approved.design).toMatchObject({
      submission: 1,
      output: "# 設計 v2",
      testViewpoints: [{ title: "新" }],
    });
    expect(task?.approved.requirements?.output).toBe("# 要求要件");
    expect(task?.steps.map((s) => s.state)).toEqual(["done", "done", "active", "todo"]);
    // 判定の前や、却下された申し出は反映できない
    expect(() => project([...base, applied])).toThrow(/not accepted/);
  });

  it("中止したタスクには、以降のイベントを受け付けない（PBI-3）", () => {
    const cancel = () => ev("t1", { type: "TaskCancelled", payload: { cleanup: [] } }, "person");
    seq = 0;
    const task = project([created("t1"), steps("t1"), cancel()]).get("t1");
    expect(task?.status).toBe("cancelled");
    seq = 0;
    expect(() => project([created("t1"), steps("t1"), cancel(), started("t1", "r1")])).toThrow(
      /cancelled/,
    );
    // 実行中のまま中止は記録できない（先にコンテナを止める）
    seq = 0;
    expect(() => project([created("t1"), steps("t1"), started("t1", "r1"), cancel()])).toThrow(
      /stop the run/,
    );
  });

  it("同じ台帳から何度復元しても同じ状態になる", () => {
    seq = 0;
    const events = [created("t1"), steps("t1"), started("t1", "r1"), completed("t1", "r1", 0.2)];
    expect(project(events)).toEqual(project(events));
  });

  it("順序が崩れた台帳・二重作成・存在しないタスクは受け付けない", () => {
    seq = 0;
    const first = created("t1");
    const second = created("t2");
    expect(() => project([second, first])).toThrow(/out of order/);
    seq = 0;
    expect(() => project([created("t1"), created("t1")])).toThrow(/created twice/);
    seq = 0;
    expect(() => project([steps("nope")])).toThrow(/unknown task/);
  });
});

describe("費用と予算", () => {
  const price = { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 };

  it("区分ごとの単価で費用を計算する", () => {
    expect(
      computeCostUsd(
        { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 100_000 },
        price,
      ),
    ).toBeCloseTo(3 + 0.3 + 1.5, 6);
    expect(
      computeCostUsd({ input: 0, cacheRead: 0, cacheWrite: 2_000_000, output: 0 }, price),
    ).toBe(7.5);
  });

  it("80%で通知、上限で超過と判定する（通知済みなら再通知しない）", () => {
    expect(budgetState({ usedUsd: 0.79, capUsd: 1, warned: false, estimated: false })).toBe("ok");
    expect(budgetState({ usedUsd: 0.8, capUsd: 1, warned: false, estimated: false })).toBe("warn");
    expect(budgetState({ usedUsd: 0.9, capUsd: 1, warned: true, estimated: false })).toBe("ok");
    expect(budgetState({ usedUsd: 1, capUsd: 1, warned: true, estimated: false })).toBe("exceeded");
  });
});

describe("金額の表示", () => {
  it("$1未満は小数第4位まで、$1以上は小数第2位まで出す", async () => {
    const { formatUsd } = await import("./cost.js");
    expect(formatUsd(0.0105)).toBe("$0.0105");
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(12.345)).toBe("$12.35");
  });
});

describe("台帳の文（PBI-11b）", () => {
  it("古い台帳の日本語の文も、コードと引数の文言も読める", () => {
    const old = project([
      created("t1"),
      steps("t1"),
      ev("t1", { type: "TaskPaused", payload: { reason: "error", message: "古い文です。" } }),
    ]).get("t1");
    expect(old?.pausedMessage).toBe("古い文です。");
    const coded = project([
      created("t2"),
      steps("t2"),
      ev("t2", {
        type: "TaskPaused",
        payload: { reason: "error", message: { code: "verify.workspaceMissing" } },
      }),
    ]).get("t2");
    expect(coded?.pausedMessage).toEqual({ code: "verify.workspaceMissing" });
    // コードと引数の文言は、決めた形（code と params）だけを受け付ける
    expect(() =>
      EventSchema.parse({
        type: "TaskPaused",
        payload: { reason: "error", message: { text: "x" } },
      }),
    ).toThrow();
  });
});

describe("成果物チェックの間の PR の状態（PBI-14a）", () => {
  it("成果物チェックで待っている、そのタスクの PR の状態だけを記録する", () => {
    expect(() =>
      project([
        created("t9"),
        steps("t9"),
        ev("t9", { type: "PullRequestMerged", payload: { number: 7 } }),
      ]),
    ).toThrow(/deliverable review is not open/);
  });
});

describe("PR のレビューの取り込み（PBI-14b）", () => {
  it("成果物チェックで待っていなければ取り込まない", () => {
    expect(() =>
      project([
        created("t8"),
        steps("t8"),
        ev("t8", {
          type: "PullRequestReviewImported",
          payload: {
            number: 7,
            reviews: [{ id: 1, author: "a", submittedAt: "2026-10-11T00:00:00Z" }],
            remarks: ["x"],
          },
        }),
      ]),
    ).toThrow(/deliverable review is not open/);
  });
});
