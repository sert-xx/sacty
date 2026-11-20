// @vitest-environment jsdom
import { type ActivityEvent, EventInput, project } from "@sacty/core";
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: unknown }) =>
    h("a", { href }, children as never),
}));
const { RunStatusLine } = await import("./run-status");

const T0 = Date.parse("2026-11-20T00:00:00.000Z");
const ev = (at: number, input: Record<string, unknown>, seq: number) =>
  ({
    ...EventInput.parse(input),
    id: `e${seq}`,
    seq,
    taskId: "t1",
    projectId: "default",
    actor: "sacty",
    at: new Date(at).toISOString(),
  }) as ActivityEvent;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

describe("RunStatusLine の時計", () => {
  it("実行の開始の時刻から数えた分の境目で経過が進み、アンマウントで時計が止まる", async () => {
    const activity = [
      ev(
        T0 - 5 * 60_000,
        {
          type: "TaskCreated",
          actor: "person",
          payload: { title: "T", body: "B", start: "sacty", budgetCapUsd: 10 },
        },
        1,
      ),
      // 開いた時点で、開始から 1 分 30 秒たっている
      ev(
        T0 - 90_000,
        {
          type: "AgentRunStarted",
          payload: { runId: "r1", step: "design", agentId: "a", authMode: "subscription" },
        },
        2,
      ),
    ];
    const task = project(activity).get("t1");
    if (!task) throw new Error("task missing");
    const container = document.createElement("div");
    const r = createRoot(container);
    await act(async () =>
      r.render(
        h(RunStatusLine, { data: { task, activity, projectName: "P", children: [] } as never }),
      ),
    );
    expect(container.textContent).toContain("1分");
    expect(container.textContent).not.toContain("2分");
    // 起点から数えた次の境目（30 秒後）で 2 分になる
    await act(async () => vi.advanceTimersByTime(29_999));
    expect(container.textContent).not.toContain("2分");
    await act(async () => vi.advanceTimersByTime(1));
    expect(container.textContent).toContain("2分");
    await act(async () => r.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
