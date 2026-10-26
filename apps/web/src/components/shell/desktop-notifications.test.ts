// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopFeed } from "@/lib/desktop-notifications";

const push = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const { DesktopNotifications } = await import("./desktop-notifications");
const { DESKTOP_INTERVAL_MS, DESKTOP_TIMEOUT_MS, writeDesktopPref } = await import(
  "@/lib/desktop-notifications"
);

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
/** 応答を止めておく問い合わせ（hold が true の間に来たもの）。release で返す。中断されたら、中断の誤りにする。 */
let hold = false;
let held: { resolve: () => void }[] = [];
const release = () => {
  for (const h of held.splice(0)) h.resolve();
};
let root: Root;
let extraRoots: Root[] = [];

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
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push(url);
      if (hold) {
        await new Promise<void>((resolve, reject) => {
          held.push({ resolve });
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return Response.json(server);
    }),
  );
  hold = false;
  held = [];
  extraRoots = [];
  root = createRoot(document.createElement("div"));
});

afterEach(() => {
  act(() => root.unmount());
  for (const r of extraRoots) act(() => r.unmount());
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

  it("2つのタブが同じ通知を同時に受け取っても、タブの間の排他の中で確かめて、1回だけ出す", async () => {
    // Web Locks の代わり。同じ名前の処理を1つずつ実行し、出した通知が排他の中だったかを記録する
    let holding = false;
    const insideLock: boolean[] = [];
    const Original = FakeNotification;
    vi.stubGlobal(
      "Notification",
      class extends Original {
        constructor(title: string, options: NotificationOptions) {
          super(title, options);
          insideLock.push(holding);
        }
      },
    );
    let queue: Promise<unknown> = Promise.resolve();
    vi.stubGlobal("navigator", {
      ...navigator,
      locks: {
        request: <T>(_name: string, fn: () => Promise<T> | T) => {
          const run = queue.then(async () => {
            holding = true;
            try {
              // 確認と記録の間に、ほかのタブの処理が入りうる（待ち）を挟む
              await Promise.resolve();
              return await fn();
            } finally {
              holding = false;
            }
          });
          queue = run.catch(() => {});
          return run;
        },
      },
    });
    writeDesktopPref(true);
    const second = createRoot(document.createElement("div"));
    extraRoots.push(second);
    act(() => {
      root.render(h(DesktopNotifications));
      second.render(h(DesktopNotifications));
    });
    await wait(0);
    server = {
      boot: "a",
      latest: 3,
      items: [{ seq: 3, title: "決済API", body: "b", href: "/tasks/t3" }],
    };
    await wait(DESKTOP_INTERVAL_MS);
    expect(requests.filter((r) => r.endsWith("after=2"))).toHaveLength(2);
    expect(insideLock).toEqual([true]);
  });

  it("取り直しの途中で Off にしたら、その応答は捨て、On に戻したら Off の間の通知は出さない", async () => {
    writeDesktopPref(true);
    act(() => root.render(h(DesktopNotifications)));
    await wait(0);
    expect(requests).toEqual(["/live/notifications"]);
    // after=2 で取っている途中に Off にする
    hold = true;
    await wait(DESKTOP_INTERVAL_MS);
    expect(requests.at(-1)).toBe("/live/notifications?after=2");
    act(() => writeDesktopPref(false));
    server = {
      boot: "a",
      latest: 3,
      items: [{ seq: 3, title: "Off の間", body: "b", href: "/tasks/t3" }],
    };
    hold = false;
    release();
    await wait(0);
    // 次の間隔の前に On に戻す：最初の問い合わせからやり直し、Off の間の通知は出さない
    act(() => writeDesktopPref(true));
    await wait(0);
    expect(requests.at(-1)).toBe("/live/notifications");
    await wait(DESKTOP_INTERVAL_MS);
    expect(requests.at(-1)).toBe("/live/notifications?after=3");
    expect(FakeNotification.shown).toEqual([]);
  });

  it("応答が来なければ期限で打ち切り、次の間隔でまた取り直す", async () => {
    writeDesktopPref(true);
    hold = true;
    act(() => root.render(h(DesktopNotifications)));
    await wait(0);
    expect(requests).toHaveLength(1);
    await wait(DESKTOP_TIMEOUT_MS);
    hold = false;
    await wait(DESKTOP_INTERVAL_MS);
    expect(requests).toEqual(["/live/notifications", "/live/notifications"]);
    // 取り直せるようになったら、続きを取る
    await wait(DESKTOP_INTERVAL_MS);
    expect(requests.at(-1)).toBe("/live/notifications?after=2");
  });
});
