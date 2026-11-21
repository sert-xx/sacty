import { describe, expect, it } from "vitest";
import type { ActivityEvent, EventInput } from "./events.js";
import { EventInput as EventSchema } from "./events.js";
import { applyEvent, project, type Task } from "./projection.js";

/*
 * DesignEdited（実装の PR の指摘で、実装が出した設計の局所の直しを、sacty が承認済みの設計に反映した記録。PBI-446）の投影。
 */

let seq = 0;
const ev = (input: EventInput, taskId = "t1") =>
  ({
    ...EventSchema.parse(input),
    seq: ++seq,
    id: `e${seq}`,
    taskId,
    projectId: "default",
    actor: "sacty",
    at: `2026-11-21T00:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  }) as ActivityEvent;

const VIEWPOINTS = [
  { id: "TV-1", title: "再送", input: "2回送る", expected: "1回" },
  { id: "TV-2", title: "失敗", input: "失敗させる", expected: "エラー文言" },
];
const edited = (runId: string, output: string, viewpoints = VIEWPOINTS, applied = 1) =>
  ev({
    type: "DesignEdited",
    payload: {
      runId,
      round: 2,
      output,
      testViewpoints: viewpoints,
      applied: Array.from({ length: applied }, () => ({
        remarks: ["implement-1-1"],
        before: "古い",
        after: "新しい",
        reason: "r",
      })),
      rejected: [],
    },
  });

/** 設計が承認済みで、前の実装の説明・設計のセルフレビュー・出典の分類がある状態のタスク。 */
function approvedTask(): Map<string, Task> {
  const tasks = project([
    ev({
      type: "TaskCreated",
      payload: { title: "決済", body: "本文", start: "sacty" },
    }),
  ]);
  const task = tasks.get("t1") as Task;
  task.approved = {
    design: {
      output: "# 設計\n\n古い文言",
      testViewpoints: VIEWPOINTS,
      at: "2026-11-20T00:00:00.000Z",
    },
  } as Task["approved"];
  task.outputs = { design: "# 設計\n\n古い文言" };
  task.testViewpoints = VIEWPOINTS;
  task.implementHistory = ["前の実装の説明"];
  task.implementBase = "土台";
  task.selfReviews = {
    design: { passed: true },
  } as unknown as Task["selfReviews"];
  task.provenances = { design: [] } as unknown as Task["provenances"];
  return tasks;
}

describe("DesignEdited の投影（PBI-446）", () => {
  it("反映後の全文とテスト観点で承認済みの設計を置き換え、承認の時刻・実装の説明は変えず、セルフレビューと出典の分類を記録なしにする", () => {
    const after = applyEvent(
      approvedTask(),
      edited("r1", "# 設計\n\n新しい文言", [
        VIEWPOINTS[0] as (typeof VIEWPOINTS)[number],
        {
          ...(VIEWPOINTS[1] as (typeof VIEWPOINTS)[number]),
          expected: "決済エラーの文言",
        },
      ]),
    ).get("t1") as Task;
    expect(after.approved.design?.output).toBe("# 設計\n\n新しい文言");
    expect(after.outputs.design).toBe("# 設計\n\n新しい文言");
    expect(after.approved.design?.testViewpoints?.map((v) => v.id)).toEqual(["TV-1", "TV-2"]);
    expect(after.approved.design?.testViewpoints?.[1]?.expected).toBe("決済エラーの文言");
    expect(after.testViewpoints[1]?.expected).toBe("決済エラーの文言");
    expect(after.approved.design?.at).toBe("2026-11-20T00:00:00.000Z");
    expect(after.implementHistory).toEqual(["前の実装の説明"]);
    expect(after.implementBase).toBe("土台");
    expect(after.selfReviews?.design).toBeNull();
    expect(after.provenances?.design).toBeNull();
    expect(after.designEdits).toHaveLength(1);
    expect(after.designEdits?.[0]).toMatchObject({
      runId: "r1",
      round: 2,
      committed: false,
    });
  });

  it("反映した直しが無い記録（反映しなかった直しだけ）は、設計を変えない", () => {
    const before = approvedTask();
    const after = applyEvent(before, edited("r1", "# 設計\n\n古い文言", VIEWPOINTS, 0)).get(
      "t1",
    ) as Task;
    expect(after.approved.design?.output).toBe("# 設計\n\n古い文言");
    expect(after.selfReviews?.design).toEqual({ passed: true });
    expect(after.designEdits).toHaveLength(1);
  });

  it("同じ実行の2つ目は読み捨てる", () => {
    let tasks = applyEvent(approvedTask(), edited("r1", "# 設計\n\n新しい文言"));
    tasks = applyEvent(tasks, edited("r1", "# 設計\n\n別の文言"));
    const task = tasks.get("t1") as Task;
    expect(task.approved.design?.output).toBe("# 設計\n\n新しい文言");
    expect(task.designEdits).toHaveLength(1);
  });

  it("設計が承認済みでなければ、作業履歴の矛盾として拒む", () => {
    const tasks = project([
      ev({
        type: "TaskCreated",
        payload: { title: "決済", body: "本文", start: "sacty" },
      }),
    ]);
    expect(() => applyEvent(tasks, edited("r1", "# 設計"))).toThrow(/not approved/);
  });
});
