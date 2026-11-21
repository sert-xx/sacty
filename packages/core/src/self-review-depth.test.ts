import { describe, expect, it } from "vitest";
import type { ActivityEvent, EventInput } from "./events.js";
import { EventInput as EventSchema, MVP_STEPS } from "./events.js";
import {
  ActivityIntegrityError,
  effectiveSelfReviewDepth,
  project as projectAll,
} from "./projection.js";

let seq = 0;
const ev = (input: EventInput, actor: ActivityEvent["actor"] = "sacty") =>
  ({
    ...EventSchema.parse(input),
    seq: ++seq,
    id: `e${seq}`,
    taskId: "t1",
    projectId: "default",
    actor,
    at: "2026-11-17T00:00:00.000Z",
  }) as ActivityEvent;
const created = () =>
  ev(
    {
      type: "TaskCreated",
      payload: { title: "README", body: "節を足す", start: "sacty" },
    },
    "person",
  );
const chosen = (extra: Record<string, unknown> = {}) =>
  ev({
    type: "StepsChosen",
    payload: { steps: [...MVP_STEPS], ...extra },
  } as EventInput);
const changed = (from: "light" | "normal", to: "light" | "normal") =>
  ev({ type: "SelfReviewDepthChanged", payload: { from, to } }, "person");
const LIGHT = {
  selfReviewDepth: "light",
  selfReviewDepthReason: "節を足すだけ",
};
const project = (events: ActivityEvent[]) => {
  const task = projectAll(events).get("t1");
  if (!task) throw new Error("no task");
  return task;
};

describe("依頼の大きさの判定と、セルフレビューの深さ（PBI-369）", () => {
  it("工程の選択の判定と理由を持つ。軽いと判定され、人が上書きしていないときだけ、深さは軽い", () => {
    const light = project([created(), chosen(LIGHT)]);
    expect(light.selfReviewDepth).toEqual({
      judged: "light",
      reason: "節を足すだけ",
    });
    expect(effectiveSelfReviewDepth(light)).toBe("light");
    const normal = project([
      created(),
      chosen({
        selfReviewDepth: "normal",
        selfReviewDepthReason: "振る舞いを変える",
      }),
    ]);
    expect(normal.selfReviewDepth).toEqual({
      judged: "normal",
      reason: "振る舞いを変える",
    });
    expect(effectiveSelfReviewDepth(normal)).toBe("normal");
    // 判定の無い記録（この判定より前の作業履歴）は、通常
    const none = project([created(), chosen()]);
    expect(none.selfReviewDepth).toBeUndefined();
    expect(effectiveSelfReviewDepth(none)).toBe("normal");
  });

  it("人が通常の深さに上書きすると通常になり、戻すと判定のとおりになる", () => {
    const overridden = project([created(), chosen(LIGHT), changed("light", "normal")]);
    expect(overridden.selfReviewDepthOverride).toEqual({
      depth: "normal",
      at: "2026-11-17T00:00:00.000Z",
    });
    // 判定そのものは変えない（画面に、元の判定と理由を出すため）
    expect(overridden.selfReviewDepth?.judged).toBe("light");
    expect(effectiveSelfReviewDepth(overridden)).toBe("normal");
    const back = project([
      created(),
      chosen(LIGHT),
      changed("light", "normal"),
      changed("normal", "light"),
    ]);
    expect(back.selfReviewDepthOverride).toBeUndefined();
    expect(effectiveSelfReviewDepth(back)).toBe("light");
  });

  it("軽いと判定されていないタスクの変更・今の深さと合わない変更は、作業履歴の誤りにする", () => {
    const bad: ActivityEvent[][] = [
      // 判定が無い・通常のタスクを、人が軽くも通常にもできない
      [created(), chosen(), changed("light", "normal")],
      [created(), chosen({ selfReviewDepth: "normal" }), changed("normal", "light")],
      // 工程を選ぶ前
      [created(), changed("light", "normal")],
      // 今の深さと合わない・変わらない
      [created(), chosen(LIGHT), changed("normal", "light")],
      [created(), chosen(LIGHT), changed("light", "light")],
      [created(), chosen(LIGHT), changed("light", "normal"), changed("light", "normal")],
    ];
    for (const events of bad) {
      expect(() => project(events)).toThrow(ActivityIntegrityError);
    }
  });

  it("工程の選択からやり直すと、判定は消える。人の上書きは残り、選び直した判定が軽くても通常のまま", () => {
    const paused = () =>
      ev({ type: "TaskPaused", payload: { reason: "manual" } } as EventInput, "person");
    const resumed = () =>
      ev(
        {
          type: "TaskResumed",
          payload: { retry: true, rechooseSteps: true },
        } as EventInput,
        "person",
      );
    const before = project([
      created(),
      chosen(LIGHT),
      changed("light", "normal"),
      paused(),
      resumed(),
    ]);
    expect(before.selfReviewDepth).toBeUndefined();
    expect(before.selfReviewDepthOverride?.depth).toBe("normal");
    expect(effectiveSelfReviewDepth(before)).toBe("normal");
    const after = project([
      created(),
      chosen(LIGHT),
      changed("light", "normal"),
      paused(),
      resumed(),
      chosen(LIGHT),
    ]);
    expect(after.selfReviewDepth?.judged).toBe("light");
    expect(effectiveSelfReviewDepth(after)).toBe("normal");
  });
});
