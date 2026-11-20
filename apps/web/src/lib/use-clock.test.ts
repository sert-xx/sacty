// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useClock } from "./use-clock";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const T0 = Date.parse("2026-11-20T00:00:00.000Z");
let seen: number[] = [];
function Probe({ anchor }: { anchor?: number }) {
  const now = useClock(anchor);
  seen.push(now);
  return h("span", null, String(now));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  seen = [];
});
afterEach(() => vi.useRealTimers());

describe("useClock", () => {
  it("起点が無ければ、開いた時刻から 60 秒ごとに進む", async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(h(Probe, {})));
    await act(async () => vi.advanceTimersByTime(59_999));
    expect(seen.at(-1)).toBe(T0);
    await act(async () => vi.advanceTimersByTime(1));
    expect(seen.at(-1)).toBe(T0 + 60_000);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(seen.at(-1)).toBe(T0 + 120_000);
    await act(async () => root.unmount());
  });

  it("起点があれば、起点から数えた分の境目で進める（開いた時刻に合わせない）", async () => {
    const anchor = T0 - 30_000; // 開いたとき、起点から 30 秒たっている
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(h(Probe, { anchor })));
    await act(async () => vi.advanceTimersByTime(29_999));
    expect(seen.at(-1)).toBe(T0);
    await act(async () => vi.advanceTimersByTime(1));
    expect(seen.at(-1)).toBe(T0 + 30_000);
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(seen.at(-1)).toBe(T0 + 90_000);
    await act(async () => root.unmount());
  });

  it("起点が変わったら今へ取り直し、アンマウントで止まる", async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(h(Probe, { anchor: T0 })));
    vi.setSystemTime(T0 + 10_000);
    await act(async () => root.render(h(Probe, { anchor: T0 + 5_000 })));
    expect(seen.at(-1)).toBe(T0 + 10_000);
    await act(async () => root.unmount());
    const count = seen.length;
    await act(async () => vi.advanceTimersByTime(300_000));
    expect(seen.length).toBe(count);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("起点なしで 60 秒進めた後にアンマウントすると、時計が残らない", async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(h(Probe, {})));
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });

  it("起点ありで最初の待ちの後（定期の時計が動いた後）にアンマウントしても、時計が残らない", async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(h(Probe, { anchor: T0 - 30_000 })));
    await act(async () => vi.advanceTimersByTime(30_000 + 60_000));
    expect(vi.getTimerCount()).toBe(1);
    await act(async () => root.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});
