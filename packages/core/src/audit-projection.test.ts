import { describe, expect, it } from "vitest";
import { type ActivityEvent, EventInput } from "./events.js";
import {
  ActivityIntegrityError,
  auditOpen,
  isAuditTarget,
  nextAuditDive,
  project,
} from "./projection.js";

/*
 * 監査のイベントの畳み込み（PBI-125）。タスクの状態・工程・予算は変えず、監査の状態だけを変える。並びの合わない記録は
 * 受け付けない。
 */

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, at = "2026-10-01T00:00:00Z") =>
  ({
    ...EventInput.parse({ type, payload }),
    seq: ++seq,
    id: `e${seq}`,
    taskId: "t1",
    projectId: "p1",
    at,
    actor: "sacty",
  }) as ActivityEvent;

const run = { agentId: "a", auditCostUsd: 0.25, estimated: true };
const completed = () => {
  seq = 0;
  return [
    ev("TaskCreated", { title: "A", body: "", start: "sacty" }),
    ev("StepsChosen", { steps: ["document"] }),
    ev("AgentRunStarted", { runId: "r", step: "document", agentId: "a", authMode: "stub" }),
    ev("AgentRunCompleted", {
      runId: "r",
      step: "document",
      agentId: "a",
      authMode: "stub",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
      costUsd: 0.5,
      estimated: false,
      output: "x",
    }),
    ev("StepCompleted", { step: "document", next: "idle" }),
  ];
};
const counts = {
  changesRequested: 0,
  pullRequestRemark: 0,
  pause: 0,
  retry: 0,
  toolFailure: 0,
  escalation: 0,
};
const surveyed = (concerns: { step: string; reason: string }[]) =>
  ev("AuditSurveyed", { auditId: "a1", summary: "s", counts, concerns, ...run });

describe("監査のイベントの畳み込み（PBI-125）", () => {
  it("監査の費用は監査の状態に足し、タスクの予算・状態は変えない", () => {
    const events = [
      ...completed(),
      ev("AuditQueued", { auditId: "a1", capUsd: 1 }),
      surveyed([{ step: "document", reason: "r" }]),
    ];
    const task = project(events).get("t1");
    expect(task?.budget.usedUsd).toBe(0.5);
    expect(task?.status).toBe("idle");
    expect(isAuditTarget(task as never)).toBe(true);
    expect(task?.audit).toMatchObject({ usedUsd: 0.25, estimated: true, capUsd: 1 });
    expect(nextAuditDive(task?.audit as never)).toBe("document");
    expect(auditOpen(task as never)).toBe(true);
  });

  it("並びの合わない記録は受け付けない", () => {
    const base = [...completed(), ev("AuditQueued", { auditId: "a1", capUsd: 1 })];
    const cases: ActivityEvent[][] = [
      // 2回目の監査
      [...base, ev("AuditQueued", { auditId: "a2", capUsd: 1 })],
      // 大まかな監査の前の深掘り
      [
        ...base,
        ev("AuditDeepDived", {
          auditId: "a1",
          step: "document",
          summary: "",
          findings: [],
          ...run,
        }),
      ],
      // 挙げていない工程の深掘り
      [
        ...base,
        surveyed([]),
        ev("AuditDeepDived", {
          auditId: "a1",
          step: "document",
          summary: "",
          findings: [],
          ...run,
        }),
      ],
      // 深掘りが残っているのに完了
      [
        ...base,
        surveyed([{ step: "document", reason: "r" }]),
        ev("AuditCompleted", { auditId: "a1" }),
      ],
      // 別の監査の ID
      [...base, ev("AuditCompleted", { auditId: "other" })],
      // 止まっていないのに上限を上げる
      [...base, ev("AuditCapRaised", { auditId: "a1", capUsd: 5 })],
      // 使った額以下の上限
      [
        ...base,
        surveyed([]),
        ev("AuditBudgetPaused", { auditId: "a1", usedUsd: 0.25, capUsd: 0.2 }),
        ev("AuditCapRaised", { auditId: "a1", capUsd: 0.25 }),
      ],
      // 無い提案の判断
      [...base, ev("AuditProposalRejected", { proposalId: "x", reason: "r" })],
      // 失敗した後の記録
      [...base, ev("AuditFailed", { auditId: "a1", reason: "x" }), surveyed([])],
    ];
    for (const events of cases) {
      expect(() => project(events), events.at(-1)?.type).toThrow(ActivityIntegrityError);
    }
  });

  it("中止したタスクには、監査の記録を足せない", () => {
    const events = [
      ...completed(),
      ev("TaskCancelled", { cleanup: [] }),
      ev("AuditQueued", { auditId: "a1", capUsd: 1 }),
    ];
    expect(() => project(events)).toThrow(ActivityIntegrityError);
  });

  it("提案の判断は1回だけ。予算で止めて上限を上げると、止まりが外れる", () => {
    const finding = {
      causeKey: "k",
      title: "原因",
      detail: "",
      evidence: [],
      proposals: [
        {
          id: "p1",
          title: "提案",
          body: "",
          target: { kind: "sacty" },
          candidates: [{ kind: "sacty" }],
        },
      ],
    };
    const events = [
      ...completed(),
      ev("AuditQueued", { auditId: "a1", capUsd: 1 }),
      surveyed([{ step: "document", reason: "r" }]),
      ev("AuditBudgetPaused", { auditId: "a1", usedUsd: 0.25, capUsd: 1 }),
      ev("AuditCapRaised", { auditId: "a1", capUsd: 2 }),
      ev("AuditDeepDived", {
        auditId: "a1",
        step: "document",
        summary: "",
        findings: [finding],
        ...run,
      }),
      ev("AuditCompleted", { auditId: "a1" }),
      ev("AuditProposalAdopted", { proposalId: "p1", target: { kind: "sacty" } }),
    ];
    const task = project(events).get("t1");
    expect(task?.audit?.paused).toBeUndefined();
    expect(task?.audit?.capUsd).toBe(2);
    expect(task?.audit?.findings[0]?.proposals[0]?.decision).toMatchObject({ kind: "adopted" });
    expect(auditOpen(task as never)).toBe(false);
    expect(() =>
      project([...events, ev("AuditProposalRejected", { proposalId: "p1", reason: "r" })]),
    ).toThrow(ActivityIntegrityError);
  });
});
