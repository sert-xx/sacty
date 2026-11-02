import { type ActivityEvent, EventInput, project } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { StepCosts } from "./step-costs";

let seq = 0;
const ev = (input: EventInput, actor: ActivityEvent["actor"] = "sacty") =>
  ({
    ...EventInput.parse(input),
    seq: ++seq,
    id: `e${seq}`,
    taskId: "t1",
    projectId: "default",
    actor,
    at: `2026-10-10T00:00:${String(seq).padStart(2, "0")}.000Z`,
  }) as ActivityEvent;

/** 時間切れで止まった実装を含む作業履歴。読めた分のある回、読めなかった回、読めた回。 */
function timedOut(): ActivityEvent[] {
  seq = 0;
  const run = (id: string, patch: Record<string, unknown>) => [
    ev({
      type: "AgentRunStarted",
      payload: { runId: id, step: "requirements", agentId: "a", authMode: "subscription" },
    }),
    ev({
      type: "AgentRunFailed",
      payload: {
        runId: id,
        step: "requirements",
        agentId: "a",
        reason: "error",
        message: { code: "run.timeout", params: { minutes: 3 } },
        costUsd: 0,
        ...patch,
      },
    }),
  ];
  return [
    ev({ type: "TaskCreated", payload: { title: "t", body: "", start: "sacty" } }, "person"),
    ev({ type: "StepsChosen", payload: { steps: ["requirements"] } }),
    ...run("r1", {
      costUsd: 0.31,
      costUnknown: true,
      usage: { input: 4, cacheRead: 9, cacheWrite: 0, output: 24 },
    }),
    ...run("r2", { costUnknown: true }),
  ];
}

const render = (events: ActivityEvent[]) => {
  const task = project(events).get("t1");
  if (!task) throw new Error("no task");
  return renderToStaticMarkup(createElement(StepCosts, { task, activity: events, subtasks: [] }));
};

describe("工程ごとの費用の表の、費用が不明な実行（PBI-281）", () => {
  it("読めた分は「以上」、読めなければ $0.0000 ではなく不明と出し、注記を付ける", () => {
    const html = render(timedOut());
    // 工程の行・合計は、読めた分（$0.3100）の下限
    expect(html).toContain("$0.3100以上");
    // 各回の内訳：読めなかった回は不明
    expect(html).toContain("不明");
    expect(html).not.toContain("$0.0000");
    expect(html).toContain("2回の実行は、時間切れなどで使った分を全部は読めませんでした");
  });

  it("不明な実行が無ければ、これまでどおり金額だけで、注記を出さない", () => {
    seq = 0;
    const events = [
      ev({ type: "TaskCreated", payload: { title: "t", body: "", start: "sacty" } }, "person"),
      ev({ type: "StepsChosen", payload: { steps: ["requirements"] } }),
    ];
    const html = render(events);
    expect(html).toContain("$0.0000");
    expect(html).not.toContain("以上");
    expect(html).not.toContain("全部は読めませんでした");
  });
});
