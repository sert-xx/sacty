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
});
