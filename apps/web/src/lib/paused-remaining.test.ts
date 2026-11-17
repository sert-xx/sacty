import { type ActivityEvent, message, renderMessage, type Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { PAUSED_REMAINING_SHOWN, pausedRemaining } from "./paused-remaining";

const event = (type: string, payload: Record<string, unknown>) =>
  ({ type, payload, actor: "sacty" }) as unknown as ActivityEvent;

/** デーモンが止めるときと同じ形の、理由の文（残っていることを 5 件まで「 / 」でつなぐ）。 */
const stopped = (remaining: string[], declared = true) =>
  message("implement.incomplete", {
    count: 11,
    stalled: false,
    declared,
    remaining: remaining.slice(0, 5).join(" / "),
    total: remaining.length,
  });

const paused = (pausedMessage: Task["pausedMessage"]) =>
  ({ status: "paused", pausedReason: "incomplete", pausedMessage }) as Task;

describe("実装が終わらないための一時停止の、残っていること（PBI-355）", () => {
  it("止めたときの未完了の記録から、1 件ずつに分ける。理由の文からは、残っていることを除く", () => {
    const remaining = ["API の入力 / 出力を直す", "docs を直す"];
    const found = pausedRemaining(paused(stopped(remaining)), [
      event("ImplementationIncomplete", { remaining: ["古い記録"] }),
      event("ImplementationIncomplete", { remaining }),
      event("TaskPaused", { reason: "incomplete" }),
    ]);
    // 項目の中の「 / 」では分けない
    expect(found?.items).toEqual(remaining);
    expect(found?.total).toBe(2);
    const full = renderMessage(stopped(remaining), "ja");
    expect(full).toContain("残っていること：API の入力 / 出力を直す / docs を直す。");
    expect(renderMessage(found?.message ?? "", "ja")).toBe(
      full.replace("残っていること：API の入力 / 出力を直す / docs を直す。", ""),
    );
    expect(renderMessage(found?.message ?? "", "en")).toBe(
      renderMessage(stopped(remaining), "en").replace(
        "What remains: API の入力 / 出力を直す / docs を直す. ",
        "",
      ),
    );
  });

  it("件数の境目：1 件・5 件はすべて出し、6 件は 5 件までにして、申告の件数を返す", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => `残り${i + 1}`);
    for (const n of [1, PAUSED_REMAINING_SHOWN, PAUSED_REMAINING_SHOWN + 1, 20]) {
      const found = pausedRemaining(paused(stopped(list(n))), [
        event("ImplementationIncomplete", { remaining: list(n) }),
      ]);
      expect(found?.items).toEqual(list(Math.min(n, PAUSED_REMAINING_SHOWN)));
      expect(found?.total).toBe(n);
    }
  });

  it("残っていることが無い（申告が無い・読めない）ときは、分けない", () => {
    expect(
      pausedRemaining(paused(stopped([], false)), [
        event("ImplementationIncomplete", { remaining: [], undeclared: true }),
      ]),
    ).toBeUndefined();
  });

  it("未完了の記録が無い・理由の文字列と合わないときは、分けない（理由の文をそのまま出す）", () => {
    const task = paused(stopped(["A", "B"]));
    expect(pausedRemaining(task, [])).toBeUndefined();
    expect(
      pausedRemaining(task, [event("ImplementationIncomplete", { remaining: ["A", "C"] })]),
    ).toBeUndefined();
    // 新しいほうの記録だけを見る（古い記録が合っていても、使わない）
    expect(
      pausedRemaining(task, [
        event("ImplementationIncomplete", { remaining: ["A", "B"] }),
        event("ImplementationIncomplete", { remaining: [], undeclared: true }),
      ]),
    ).toBeUndefined();
  });

  it("ほかの一時停止・ほかの理由の文・コードでない文は、分けない", () => {
    const activity = [event("ImplementationIncomplete", { remaining: ["A"] })];
    const text = stopped(["A"]);
    expect(
      pausedRemaining({ ...paused(text), status: "running" } as Task, activity),
    ).toBeUndefined();
    expect(
      pausedRemaining({ ...paused(text), pausedReason: "error" } as Task, activity),
    ).toBeUndefined();
    expect(pausedRemaining(paused("A"), activity)).toBeUndefined();
    expect(pausedRemaining(paused(undefined), activity)).toBeUndefined();
    expect(
      pausedRemaining(
        paused(
          message("implement.unmappedViewpoints", { count: 2, stalled: false, ids: "A", total: 1 }),
        ),
        activity,
      ),
    ).toBeUndefined();
    // 引数の形が違う記録
    expect(
      pausedRemaining(
        paused({ code: "implement.incomplete", params: { remaining: "A" } }),
        activity,
      ),
    ).toBeUndefined();
    expect(pausedRemaining(paused({ code: "implement.incomplete" }), activity)).toBeUndefined();
  });
});
