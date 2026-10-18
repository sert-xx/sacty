// @vitest-environment jsdom
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateData } from "@/lib/update-data";

const { I18nProvider } = await import("@/i18n/client");
const { UpdateNoticeLive, UPDATE_LIVE_INTERVAL_MS, UPDATE_LIVE_URL } = await import(
  "./update-notice-live"
);
const { liveVersion } = await import("@/lib/live-server");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 開いている画面で、新しい版の知らせが現れる・消えるのを、リロードせずに反映する（PR #147 レビュー指摘）。
 */

const COMPARE = "https://github.com/sert-xx/sacty/compare/0123abc...main";
const behind = (n: number): UpdateData => ({ update: { behindBy: n, compareUrl: COMPARE } });
const none: UpdateData = { update: null };

// 画面のサーバーの代わり。取り直しの問い合わせに、server の今のデータを返す（版が同じなら中身を送らない）
let server: UpdateData | "down" = none;
const requests: string[] = [];
let container: HTMLDivElement;
let root: Root;

function render(node: ReactNode) {
  act(() => {
    root.render(h(I18nProvider as unknown as FC<{ locale: "ja" }>, { locale: "ja" }, node));
  });
}

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const text = () => container.textContent ?? "";

beforeEach(() => {
  vi.useFakeTimers();
  requests.length = 0;
  server = none;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (server === "down") return Response.json({ unavailable: true });
      const version = liveVersion(server);
      const headers = (init?.headers ?? {}) as Record<string, string>;
      return Response.json(
        headers["x-sacty-live-version"] === version
          ? { unchanged: true }
          : { data: server, version },
      );
    }),
  );
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("新しい版の知らせの取り直し", () => {
  it("知らせなし → あり → OFF・確かめられないで なし、を画面のリロードなしで反映する", async () => {
    render(h(UpdateNoticeLive, { initial: none }));
    expect(text()).toBe("");
    server = behind(3);
    await wait(UPDATE_LIVE_INTERVAL_MS);
    expect(text()).toContain("変更が 3 件あります");
    expect(requests.every((url) => url === UPDATE_LIVE_URL)).toBe(true);
    server = none;
    await wait(UPDATE_LIVE_INTERVAL_MS);
    expect(text()).toBe("");
  });

  it("取り直しは決まった間隔だけ（境界：間隔の1ミリ秒前には問い合わせない）", async () => {
    render(h(UpdateNoticeLive, { initial: behind(1) }));
    expect(text()).toContain("変更が 1 件あります");
    const first = requests.length;
    await wait(UPDATE_LIVE_INTERVAL_MS - 1);
    expect(requests.length).toBe(first);
    await wait(1);
    expect(requests.length).toBe(first + 1);
  });

  it("デーモンに届かないときは、最後に取れた表示のまま", async () => {
    render(h(UpdateNoticeLive, { initial: behind(2) }));
    server = "down";
    await wait(UPDATE_LIVE_INTERVAL_MS);
    expect(text()).toContain("変更が 2 件あります");
  });
});
