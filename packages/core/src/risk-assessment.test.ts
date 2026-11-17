import { describe, expect, it } from "vitest";
import {
  type ActivityEvent,
  type EventInput,
  EventInput as EventSchema,
  RISK_SIGNAL_WEIGHT,
  RiskSignal,
} from "./events.js";
import { message } from "./message-code.js";
import { renderMessage } from "./messages.js";
import { project } from "./projection.js";

// PR のリスク評価の記録（PBI-362）

let seq = 0;
const ev = (taskId: string, input: EventInput, actor: ActivityEvent["actor"] = "sacty") =>
  ({
    ...EventSchema.parse(input),
    seq: ++seq,
    id: `e${seq}`,
    taskId,
    projectId: "default",
    actor,
    at: `2026-11-17T00:00:${String(seq).padStart(2, "0")}.000Z`,
  }) as ActivityEvent;

const created = (taskId: string) =>
  ev(
    taskId,
    { type: "TaskCreated", payload: { title: "title", body: "body", start: "sacty" } },
    "person",
  );

const assessment = {
  level: "medium" as const,
  signals: [],
  change: "予約のキャンセルの API を足す",
  scope: "予約の一覧と詳細",
  reversibility: "元に戻せば戻る",
  verification: "API のテストで確かめた",
  focus: [{ where: "src/cancel.ts:10-40", why: "キャンセルの条件" }],
};

describe("PR のリスク評価の記録（PBI-362）", () => {
  it("最後の評価だけを持ち、費用を予算に足す", () => {
    seq = 0;
    const task = project([
      created("t1"),
      ev("t1", {
        type: "PullRequestRiskAssessed",
        payload: { via: "publish", commit: "c1", assessment, agentId: "a", costUsd: 0.25 },
      }),
      ev("t1", {
        type: "PullRequestRiskAssessed",
        payload: {
          via: "publish",
          commit: "c2",
          assessment: { ...assessment, level: "high", signals: ["security"] },
          agentId: "a",
          costUsd: 0.5,
        },
      }),
    ]).get("t1");
    expect(task?.riskAssessment).toEqual({
      via: "publish",
      commit: "c2",
      assessment: { ...assessment, level: "high", signals: ["security"] },
      at: "2026-11-17T00:00:03.000Z",
    });
    expect(task?.budget.usedUsd).toBe(0.75);
  });

  it("評価できなかった記録は、前の評価を残さず、理由を持つ", () => {
    seq = 0;
    const reason = message("pr.riskUnreadable");
    const task = project([
      created("t1"),
      ev("t1", {
        type: "PullRequestRiskAssessed",
        payload: { via: "review", commit: "c1", assessment },
      }),
      ev("t1", {
        type: "PullRequestRiskAssessed",
        payload: { via: "review", commit: "c2", reason },
      }),
    ]).get("t1");
    expect(task?.riskAssessment).toEqual({
      via: "review",
      commit: "c2",
      reason,
      at: "2026-11-17T00:00:03.000Z",
    });
    // 費用を持たない記録（レビューの工程の答えから読んだ評価）は、予算を変えない
    expect(task?.budget.usedUsd).toBe(0);
  });

  it("決めた段階・合図でない評価は、記録として受け付けない", () => {
    const parse = (extra: Record<string, unknown>) =>
      EventSchema.safeParse({
        type: "PullRequestRiskAssessed",
        payload: { via: "publish", assessment: { ...assessment, ...extra } },
      }).success;
    expect(parse({})).toBe(true);
    expect(parse({ level: "critical" })).toBe(false);
    expect(parse({ signals: ["unknown"] })).toBe(false);
    expect(parse({ change: "" })).toBe(false);
    // 依存の版の更新の上げ幅（PBI-377）。更新が無い評価は、項目を持たない
    for (const dependencyUpdate of ["patch", "minor", "major", "unknown"]) {
      expect(parse({ dependencyUpdate })).toBe(true);
    }
    expect(parse({ dependencyUpdate: "none" })).toBe(false);
    expect(parse({ dependencyUpdate: "huge" })).toBe(false);
    // 外した合図（defect）のある以前の記録は、読める
    expect(parse({ signals: ["defect", "security"] })).toBe(true);
  });

  it("合図の重さ：重い合図は3つ、軽い合図は4つ、外した合図は不具合の疑いだけ（PBI-377）", () => {
    const of = (weight: string) =>
      RiskSignal.options.filter((signal) => RISK_SIGNAL_WEIGHT[signal] === weight);
    expect(of("heavy")).toEqual(["security", "irreversible", "compatibility"]);
    expect(of("light")).toEqual(["structural", "performance", "large", "unverified"]);
    expect(of("retired")).toEqual(["defect"]);
  });

  it("評価できなかった理由は、日本語と英語の両方で読める", () => {
    for (const reason of [
      message("pr.riskBudget"),
      message("pr.riskUnreadable"),
      message("pr.riskFailed", { detail: "timeout" }),
    ]) {
      expect(renderMessage(reason, "ja")).toMatch(/リスク/);
      expect(renderMessage(reason, "en")).toMatch(/risk/);
    }
  });
});
