import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { subtaskSummary, withSubtasks } from "./subtasks";

const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, steps: [], budget: { usedUsd: 0 }, ...extra }) as unknown as Task;
const split = (...ids: string[]) =>
  ({
    children: ids.map((taskId) => ({ taskId, title: taskId, body: "", dependsOn: [], round: 1 })),
    rounds: 1,
    reason: "",
    at: "",
    acceptedCancellations: [],
  }) as Task["split"];
const child = (id: string, parent: string, extra: Partial<Task> = {}) =>
  task(id, { parent: { taskId: parent, dependsOn: [] }, ...extra });

describe("子タスクの表示（PBI-27）", () => {
  it("子タスクは親のすぐ下に、分割の順に並べる。親が一覧に無い子はそのままの位置", () => {
    const rows = withSubtasks([
      child("b", "p"),
      task("x"),
      task("p", { split: split("a", "b") }),
      child("a", "p"),
      child("orphan", "gone"),
    ]);
    expect(rows.map((r) => [r.task.id, r.child])).toEqual([
      ["x", false],
      ["p", false],
      ["a", true],
      ["b", true],
      ["orphan", false],
    ]);
  });

  it("完了した子の数と、子の費用の合計を出す（作成前の子は数えない）", () => {
    const done = { steps: [{ key: "investigate", state: "done" }] } as Partial<Task>;
    const tasks = new Map([
      ["a", child("a", "p", { ...done, budget: { usedUsd: 0.1 } as Task["budget"] })],
      ["b", child("b", "p", { budget: { usedUsd: 0.2 } as Task["budget"] })],
    ]);
    const summary = subtaskSummary(task("p", { split: split("a", "b", "c") }), tasks);
    expect(summary.done).toBe(1);
    expect(summary.costUsd).toBe(0.3);
    expect(summary.children.map((c) => c.task?.id)).toEqual(["a", "b", undefined]);
  });
});
