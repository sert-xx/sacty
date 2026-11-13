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
    expect(rows.map((r) => [r.task.id, r.child, r.depth])).toEqual([
      ["x", false, 0],
      ["p", false, 0],
      ["a", true, 1],
      ["b", true, 1],
      ["orphan", false, 0],
    ]);
  });

  it("PR のレビューの子タスクは、レビューする PR を作ったタスクのすぐ下に、分割の子の後に並べる。分割の子のレビューはもう一段下（PBI-341）", () => {
    const review = (id: string, of: string, createdAt = "2026-11-13T00:00:00.000Z") =>
      task(id, { reviewOf: { taskId: of, step: "implement" }, createdAt } as Partial<Task>);
    const rows = withSubtasks([
      review("r-p", "p"),
      task("x"),
      review("r-x2", "x", "2026-11-13T02:00:00.000Z"),
      review("r-x", "x", "2026-11-13T01:00:00.000Z"),
      task("p", { split: split("a", "b") }),
      review("r-a", "a"),
      child("a", "p"),
      child("b", "p"),
      review("r-gone", "gone"),
    ]);
    expect(rows.map((r) => [r.task.id, r.child, r.depth])).toEqual([
      ["x", false, 0],
      ["r-x", true, 1],
      ["r-x2", true, 1],
      ["p", false, 0],
      ["a", true, 1],
      ["r-a", true, 2],
      ["b", true, 1],
      ["r-p", true, 1],
      ["r-gone", false, 0],
    ]);
  });

  it("レビューの子タスクは、分割の子の数・費用の合計に入れない（PBI-341）", () => {
    const tasks = new Map([
      ["a", child("a", "p", { budget: { usedUsd: 0.1 } as Task["budget"] })],
      [
        "r",
        task("r", {
          reviewOf: { taskId: "p", step: "implement" },
          budget: { usedUsd: 5 },
        } as Partial<Task>),
      ],
    ]);
    const summary = subtaskSummary(task("p", { split: split("a") }), tasks);
    expect(summary.children.map((c) => c.task?.id)).toEqual(["a"]);
    expect(summary.costUsd).toBe(0.1);
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
