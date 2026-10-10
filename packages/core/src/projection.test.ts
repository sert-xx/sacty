import { describe, expect, it } from "vitest";
import type { LedgerEvent } from "./events.js";
import { MVP_STEPS } from "./events.js";
import { project } from "./projection.js";

const base = { projectId: "default", actor: "person" as const, at: "2026-10-10T00:00:00.000Z" };

const created = (seq: number, taskId: string): LedgerEvent => ({
  ...base,
  seq,
  id: `e${seq}`,
  taskId,
  type: "TaskCreated",
  payload: { title: `title ${taskId}`, body: "body", start: "ticket" },
});

const stepsChosen = (seq: number, taskId: string): LedgerEvent => ({
  ...base,
  seq,
  id: `e${seq}`,
  taskId,
  actor: "sacty",
  type: "StepsChosen",
  payload: { steps: [...MVP_STEPS] },
});

describe("project", () => {
  it("台帳からタスクの状態を復元する", () => {
    const tasks = project([created(1, "t1"), stepsChosen(2, "t1")]);
    const task = tasks.get("t1");
    expect(task?.title).toBe("title t1");
    expect(task?.status).toBe("queued");
    expect(task?.steps.map((s) => s.key)).toEqual(["requirements", "design", "implement", "pr"]);
    expect(task?.steps.every((s) => s.state === "todo")).toBe(true);
  });

  it("同じ台帳から何度復元しても同じ状態になる", () => {
    const events = [created(1, "t1"), stepsChosen(2, "t1"), created(3, "t2")];
    expect(project(events)).toEqual(project(events));
  });

  it("順序が崩れた台帳は受け付けない", () => {
    expect(() => project([created(2, "t1"), stepsChosen(1, "t1")])).toThrow(/out of order/);
  });

  it("同じタスクを2回作るイベントは受け付けない", () => {
    expect(() => project([created(1, "t1"), created(2, "t1")])).toThrow(/created twice/);
  });

  it("存在しないタスクへの工程の決定は受け付けない", () => {
    expect(() => project([stepsChosen(1, "nope")])).toThrow(/unknown task/);
  });
});
