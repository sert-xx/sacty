import { describe, expect, it } from "vitest";
import { isAwaitingAiJudgement, personTurnGroup, personTurnTasks } from "./person-turn.js";
import type { PauseReason, Task, TaskStatus } from "./projection.js";

type Patch = Partial<Task> & { id: string };
const task = (patch: Patch): Task =>
  ({
    projectId: "p1",
    status: "paused",
    updatedAt: "2026-11-01T00:00:00.000Z",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...patch,
  }) as Task;
const pending = { keys: ["k"], remarks: ["r"] } as Task["pendingReview"];

describe("人の出番の組（PBI-442）", () => {
  it("承認待ち・エスカレーションは decision、一時停止は理由を問わず paused、AI が判断中の承認待ちと残りの状態は無い", () => {
    const group = (status: TaskStatus, extra: Partial<Task> = {}) =>
      personTurnGroup(task({ id: "x", status, ...extra }));
    expect(group("awaiting_approval")).toBe("decision");
    expect(group("escalated")).toBe("decision");
    // 判断中の欄は、承認待ちだけで除く
    expect(group("awaiting_approval", { pendingReview: pending })).toBeUndefined();
    expect(
      isAwaitingAiJudgement(task({ id: "x", status: "awaiting_approval", pendingReview: pending })),
    ).toBe(true);
    expect(group("escalated", { pendingReview: pending })).toBe("decision");
    for (const pausedReason of ["budget", "usage_limit", "manual"] as PauseReason[]) {
      expect(group("paused", { pausedReason })).toBe("paused");
    }
    expect(group("paused", { pendingReview: pending })).toBe("paused");
    for (const status of ["queued", "running", "idle", "blocked", "cancelled"] as TaskStatus[]) {
      expect(group(status)).toBeUndefined();
    }
  });
});

describe("人の出番の並び（PBI-442）", () => {
  const projectIds = new Set(["p1"]);
  const at = (n: number) => `2026-11-0${n}T00:00:00.000Z`;

  it("組（decision → paused）→ 待ち始めの古い順 → ID の順。記録の無いものは updatedAt。消したプロジェクトは入らない", () => {
    const tasks = [
      // 作成の順（配列の順）・updatedAt の順・待ち始めの順は、互いに違う
      task({ id: "p-old", status: "paused", updatedAt: at(9) }),
      task({ id: "d-new", status: "awaiting_approval", updatedAt: at(1) }),
      task({ id: "p-new", status: "paused", updatedAt: at(2) }),
      task({ id: "d-old", status: "escalated", updatedAt: at(8) }),
      // 待ち始めが同じ 2 件（ID の順）
      task({ id: "d-b", status: "awaiting_approval", updatedAt: at(8) }),
      task({ id: "d-a", status: "awaiting_approval", updatedAt: at(8) }),
      // 記録の無い 1 件は updatedAt で並ぶ
      task({ id: "d-none", status: "awaiting_approval", updatedAt: at(3) }),
      task({ id: "gone", status: "paused", projectId: "gone", updatedAt: at(1) }),
      task({ id: "judging", status: "awaiting_approval", pendingReview: pending }),
      task({ id: "running", status: "running" }),
    ];
    const waitingSince = {
      "p-old": at(1),
      "d-new": at(7),
      "p-new": at(6),
      "d-old": at(2),
      "d-b": at(5),
      "d-a": at(5),
      gone: at(1),
    };
    const out = personTurnTasks(tasks, { projectIds, waitingSince });
    expect(out.map((o) => o.task.id)).toEqual([
      "d-old",
      "d-none",
      "d-a",
      "d-b",
      "d-new",
      "p-old",
      "p-new",
    ]);
    expect(out.map((o) => o.group)).toEqual([
      "decision",
      "decision",
      "decision",
      "decision",
      "decision",
      "paused",
      "paused",
    ]);
    const none = out.find((o) => o.task.id === "d-none");
    expect(none).toMatchObject({ waitingSince: at(3), recorded: false });
    expect(out.find((o) => o.task.id === "d-old")).toMatchObject({
      waitingSince: at(2),
      recorded: true,
    });
  });

  it("0 件・片方の組だけ", () => {
    expect(personTurnTasks([], { projectIds, waitingSince: {} })).toEqual([]);
    expect(
      personTurnTasks([task({ id: "r", status: "running" })], { projectIds, waitingSince: {} }),
    ).toEqual([]);
    expect(
      personTurnTasks([task({ id: "only", status: "paused" })], {
        projectIds,
        waitingSince: {},
      }).map((o) => o.group),
    ).toEqual(["paused"]);
    expect(
      personTurnTasks([task({ id: "only", status: "escalated" })], {
        projectIds,
        waitingSince: {},
      }).map((o) => o.group),
    ).toEqual(["decision"]);
  });
});
