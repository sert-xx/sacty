// @vitest-environment jsdom
import { act, createElement as h, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { STICKY_OFFSET_VAR, stickyOffsetPx, useStickyOffset } from "./use-sticky-offset";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let height = 204; // 固定の見出しの高さ（折り返しで変わる）
let callback: (() => void) | undefined;
let disconnected = false;

beforeEach(() => {
  height = 204;
  callback = undefined;
  disconnected = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: () => void) {
        callback = cb;
      }
      observe() {}
      disconnect() {
        disconnected = true;
      }
    },
  );
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => height,
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
});

function Probe() {
  const ref = useRef<HTMLDivElement>(null);
  useStickyOffset(ref);
  return h("div", { ref });
}
const read = () => document.documentElement.style.getPropertyValue(STICKY_OFFSET_VAR);

describe("stickyOffsetPx", () => {
  it("固定の見出しの下端（64px＋高さ）の下に余白を足した大きさ", () => {
    expect(stickyOffsetPx(204)).toBe(64 + 204 + 16);
    expect(stickyOffsetPx(0)).toBe(80);
    expect(stickyOffsetPx(-5)).toBe(80);
  });
});

describe("useStickyOffset", () => {
  it("固定の見出しの高さを CSS の変数に入れ、高さが変わると（題が長いなど）追従し、外すと消す", async () => {
    const root = createRoot(document.createElement("div"));
    await act(async () => root.render(h(Probe)));
    expect(read()).toBe(`${stickyOffsetPx(204)}px`);
    height = 330;
    await act(async () => callback?.());
    expect(read()).toBe(`${stickyOffsetPx(330)}px`);
    await act(async () => root.unmount());
    expect(disconnected).toBe(true);
    expect(read()).toBe("");
  });
});
