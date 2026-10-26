import { describe, expect, it } from "vitest";
import {
  advanceFeed,
  claimDesktopItem,
  DESKTOP_FEED_URL,
  feedUrl,
  readDesktopPref,
  withDesktopLock,
  writeDesktopPref,
} from "./desktop-notifications";

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
};
const item = (seq: number) => ({ seq, title: `t${seq}`, body: "b", href: `/tasks/t${seq}` });

describe("デスクトップ通知", () => {
  it("On/Off はブラウザごとに持つ。既定は Off", () => {
    const store = memory();
    expect(readDesktopPref(store)).toBe(false);
    writeDesktopPref(true, store);
    expect(readDesktopPref(store)).toBe(true);
    writeDesktopPref(false, store);
    expect(readDesktopPref(store)).toBe(false);
    expect(readDesktopPref(undefined)).toBe(false);
  });

  it("最初の問い合わせでは出さず、その後の通知を出す。デーモンを起動し直したら、起動し直した後の通知を取る", () => {
    expect(feedUrl({})).toBe(DESKTOP_FEED_URL);
    let step = advanceFeed({}, { boot: "a", latest: 3, items: [] });
    expect(step).toEqual({ cursor: { boot: "a", after: 3 }, show: [] });
    expect(feedUrl(step.cursor)).toBe(`${DESKTOP_FEED_URL}?after=3`);
    step = advanceFeed(step.cursor, { boot: "a", latest: 5, items: [item(4), item(5)] });
    expect(step.show.map((i) => i.seq)).toEqual([4, 5]);
    expect(step.cursor).toEqual({ boot: "a", after: 5 });
    // 起動し直した：番号は 1 から数え直すので、0 より後を取り直す
    step = advanceFeed(step.cursor, { boot: "b", latest: 1, items: [] });
    expect(step).toEqual({ cursor: { boot: "b", after: 0 }, show: [] });
    step = advanceFeed(step.cursor, { boot: "b", latest: 1, items: [item(1)] });
    expect(step.show.map((i) => i.seq)).toEqual([1]);
  });

  it("同じブラウザの複数のタブでは、同じ通知を1回だけ出す", () => {
    const store = memory();
    expect(claimDesktopItem("a", 1, store)).toBe(true);
    expect(claimDesktopItem("a", 1, store)).toBe(false);
    expect(claimDesktopItem("a", 2, store)).toBe(true);
    // 起動し直した後の番号は、前の起動の番号と比べない
    expect(claimDesktopItem("b", 1, store)).toBe(true);
  });

  it("Web Locks があれば、同じ名前の排他の中で実行する。無ければそのまま実行する", async () => {
    const names: string[] = [];
    const locks = {
      request: async <T>(name: string, fn: () => Promise<T> | T) => {
        names.push(name);
        return fn();
      },
    };
    expect(await withDesktopLock(() => 1, locks)).toBe(1);
    expect(await withDesktopLock(() => 2, locks)).toBe(2);
    expect(names).toEqual(["sacty-desktop-notifications", "sacty-desktop-notifications"]);
    expect(await withDesktopLock(() => 3, undefined)).toBe(3);
  });
});
