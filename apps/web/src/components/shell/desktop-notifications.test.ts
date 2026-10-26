// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopFeed } from "@/lib/desktop-notifications";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const { DesktopNotifications } = await import("./desktop-notifications");
const { DESKTOP_INTERVAL_MS, writeDesktopPref } = await import("@/lib/desktop-notifications");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** ブラウザの Notification の代わり。出した通知を記録する。 */
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static shown: FakeNotification[] = [];
  onclick: (() => void) | null = null;
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    FakeNotification.shown.push(this);
  }
  close() {}
}

let server: DesktopFeed = { boot: "a", latest: 2, items: [] };
const requests: string[] = [];
let container: HTMLDivElement;
let root: Root;

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  FakeNotification.shown = [];
  FakeNotification.permission = "granted";
  requests.length = 0;
  server = { boot: "a", latest: 2, items: [] };
  vi.stubGlobal("Notification", FakeNotification);
  vi.spyOn(window, "focus").mockImplementation(() => {});
  Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url);
      return Response.json(server);
    }),
  );
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ブラウザのデスクトップ通知", () => {
  it("On のときだけ取り直し、開いた後の通知を出す。押すとタスクを開く", async () => {
    act(() => root.render(h(DesktopNotifications)));
    await wait(DESKTOP_INTERVAL_MS * 2);
    // Off（既定）の間は取り直さない
    expect(requests).toEqual([]);
    act(() => writeDesktopPref(true));
    await wait(0);
    expect(requests).toEqual(["/live/notifications"]);
    server = {
      boot: "a",
      latest: 3,
      items: [{ seq: 3, title: "決済API", body: "[決済] 承認を待っています", href: "/tasks/t3" }],
    };
    await wait(DESKTOP_INTERVAL_MS);
    expect(requests.at(-1)).toBe("/live/notifications?after=2");
    expect(FakeNotification.shown.map((n) => [n.title, n.options.body])).toEqual([
      ["決済API", "[決済] 承認を待っています"],
    ]);
    FakeNotification.shown[0]?.onclick?.();
    expect(push).toHaveBeenCalledWith("/tasks/t3");
    // 同じ通知は、もう出さない
    await wait(DESKTOP_INTERVAL_MS);
    expect(requests.at(-1)).toBe("/live/notifications?after=3");
    expect(FakeNotification.shown).toHaveLength(1);
    // Off にしたら取り直さない
    act(() => writeDesktopPref(false));
    const count = requests.length;
    await wait(DESKTOP_INTERVAL_MS * 3);
    expect(requests).toHaveLength(count);
  });

  it("通知が許可されていなければ、On でも取り直さない", async () => {
    FakeNotification.permission = "denied";
    writeDesktopPref(true);
    act(() => root.render(h(DesktopNotifications)));
    await wait(DESKTOP_INTERVAL_MS * 2);
    expect(requests).toEqual([]);
  });
});
