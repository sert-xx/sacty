import { describe, expect, it } from "vitest";
import { addUsd, CHARGED_EVENT_TYPES, chargeBudget } from "./cost.js";
import { type ActivityEvent, EventInput } from "./events.js";

describe("タスクの予算に入れる費用を持つイベント（PBI-86）", () => {
  it("費用（costUsd）を持つイベントの種類が、すべて CHARGED_EVENT_TYPES にあり、それ以外は無い", () => {
    const withCost = EventInput.options
      .filter((option) => "costUsd" in option.shape.payload.shape)
      .map((option) => option.shape.type.value);
    expect([...CHARGED_EVENT_TYPES].sort()).toEqual(withCost.sort());
  });

  it("費用を持つイベントは、費用を足し、換算値かを引き継ぐ。持たないイベントは、そのまま返す", () => {
    const budget = { usedUsd: 0.1, capUsd: 5, warned: false, estimated: false };
    const charged = {
      type: "QuestionAnswered",
      payload: { costUsd: 0.0000006, estimated: true },
    } as unknown as ActivityEvent;
    expect(chargeBudget(budget, charged)).toEqual({
      ...budget,
      usedUsd: 0.100001,
      estimated: true,
    });
    const other = { type: "StepSubmitted", payload: { step: "design" } } as ActivityEvent;
    expect(chargeBudget(budget, other)).toBe(budget);
    expect(addUsd(0.1, 0.2)).toBe(0.3);
  });

  it("使った分の全体を読めなかった実行（PBI-281）は、読めた分を足し、回数を数える。読めた実行は数えない", () => {
    const budget = { usedUsd: 0.1, capUsd: 5, warned: false, estimated: false };
    const event = (payload: Record<string, unknown>) =>
      ({
        type: "AgentRunFailed",
        payload: { costUsd: 0.2, estimated: false, ...payload },
      }) as unknown as ActivityEvent;
    // 回数を持たない予算（空）は、1 回目で 1 になり、2 回目で 2 になる
    const once = chargeBudget(budget, event({ costUnknown: true }));
    expect(once).toEqual({ ...budget, usedUsd: 0.3, unknownRuns: 1 });
    const twice = chargeBudget(once, event({ costUnknown: true, costUsd: 0 }));
    expect(twice).toEqual({ ...budget, usedUsd: 0.3, unknownRuns: 2 });
    // 読めた実行・印が false の実行は、回数に入れず、持たないままにする
    expect(chargeBudget(budget, event({}))).not.toHaveProperty("unknownRuns");
    expect(chargeBudget(budget, event({ costUnknown: false }))).not.toHaveProperty("unknownRuns");
    expect(chargeBudget(twice, event({}))).toHaveProperty("unknownRuns", 2);
  });
});
