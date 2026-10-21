// @vitest-environment jsdom

import { message } from "@sacty/core";
import { act, type FC, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockerData } from "@/lib/docker-data";

const { I18nProvider } = await import("@/i18n/client");
const { DockerNoticeLive, DOCKER_LIVE_INTERVAL_MS, DOCKER_LIVE_URL } = await import(
  "./docker-notice-live"
);
const { liveVersion } = await import("@/lib/live-server");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/*
 * 開いている画面で、Docker の注意が現れる・消えるのを、リロードせずに反映する（PBI-148）。
 */

const down: DockerData = { docker: [message("image.dockerUnreachable")] };
const none: DockerData = { docker: [] };

// 画面のサーバーの代わり。取り直しの問い合わせに、server の今のデータを返す（版が同じなら中身を送らない）
let server: DockerData | "down" = none;
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

describe("Docker の注意の取り直し", () => {
  it("注意なし → Docker が止まった → 起動した、を画面のリロードなしで反映する", async () => {
    render(h(DockerNoticeLive, { initial: none }));
    expect(text()).toBe("");
    server = down;
    await wait(DOCKER_LIVE_INTERVAL_MS);
    expect(text()).toContain("Docker に接続できません。");
    expect(requests.every((url) => url === DOCKER_LIVE_URL)).toBe(true);
    server = none;
    await wait(DOCKER_LIVE_INTERVAL_MS);
    expect(text()).toBe("");
  });

  it("取り直しは決まった間隔だけ（境界：間隔の1ミリ秒前には問い合わせない）", async () => {
    render(h(DockerNoticeLive, { initial: down }));
    const first = requests.length;
    await wait(DOCKER_LIVE_INTERVAL_MS - 1);
    expect(requests.length).toBe(first);
    await wait(1);
    expect(requests.length).toBe(first + 1);
  });

  it("画面のサーバーがデーモンに届かないときは、最後に取れた表示のまま", async () => {
    render(h(DockerNoticeLive, { initial: down }));
    server = "down";
    await wait(DOCKER_LIVE_INTERVAL_MS);
    expect(text()).toContain("Docker に接続できません。");
  });
});
