import { describe, expect, it } from "vitest";
import { NotificationFeed } from "./notification-feed.js";

const task = (id: string) => ({ id, projectId: "p1", title: `題名 ${id}` });

describe("デスクトップ通知のための、最近の通知の一覧", () => {
  it("番号を付けて持ち、after より後のものを返す。after が無ければ最後の番号だけを返す", () => {
    const feed = new NotificationFeed(() => new Date("2026-10-26T00:00:00Z"));
    expect(feed.since(undefined)).toEqual({ boot: feed.boot, latest: 0, items: [] });
    feed.add(task("t1"), "approval");
    feed.add(task("t2"), "completed");
    expect(feed.since(undefined)).toEqual({ boot: feed.boot, latest: 2, items: [] });
    expect(feed.since(1)).toEqual({
      boot: feed.boot,
      latest: 2,
      items: [
        {
          seq: 2,
          at: "2026-10-26T00:00:00.000Z",
          taskId: "t2",
          projectId: "p1",
          title: "題名 t2",
          kind: "completed",
        },
      ],
    });
    expect(feed.since(0).items.map((i) => i.taskId)).toEqual(["t1", "t2"]);
  });

  it("持つのは最近の 100 件まで。起動ごとに boot が変わる", () => {
    const feed = new NotificationFeed();
    for (let i = 1; i <= 105; i += 1) feed.add(task(`t${i}`), "paused");
    const all = feed.since(0);
    expect(all.items).toHaveLength(100);
    expect(all.items[0]?.seq).toBe(6);
    expect(all.latest).toBe(105);
    expect(new NotificationFeed().boot).not.toBe(feed.boot);
  });
});
