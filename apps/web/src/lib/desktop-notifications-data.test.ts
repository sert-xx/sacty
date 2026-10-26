import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const feed = {
  boot: "b1",
  latest: 3,
  items: [
    { seq: 1, at: "", taskId: "t1", kind: "approval" as const },
    { seq: 2, at: "", taskId: "t1", kind: "completed" as const },
    { seq: 3, at: "", taskId: "gone", kind: "paused" as const },
  ],
};
const getNotificationFeed = vi.fn(async (_after?: number) => feed);
const listTasks = vi.fn(async (_options?: { open?: boolean }) => [
  { id: "t1", projectId: "p1", title: "決済API" },
]);
const getTask = vi.fn();
vi.mock("@/lib/daemon", () => ({
  getNotificationFeed,
  listProjects: async () => [{ id: "p1", name: "決済", targets: [], createdAt: "", updatedAt: "" }],
  listTasks,
  getTask,
}));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));

const { loadDesktopFeed } = await import("./desktop-notifications-data");

describe("デスクトップ通知に出すもの", () => {
  it("タスクは作業履歴を含まない一覧から一度に取り、画面の言語の題名・本文・開く画面にする。無くなったタスクは出さない", async () => {
    const data = await loadDesktopFeed(0);
    expect(getNotificationFeed).toHaveBeenCalledWith(0);
    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(getTask).not.toHaveBeenCalled();
    expect(data).toEqual({
      boot: "b1",
      latest: 3,
      items: [
        { seq: 1, title: "決済API", body: "[決済] 承認を待っています", href: "/tasks/t1" },
        { seq: 2, title: "決済API", body: "[決済] 完了しました", href: "/tasks/t1" },
      ],
    });
  });

  it("通知が無ければ、タスクを取らない", async () => {
    getNotificationFeed.mockResolvedValueOnce({ boot: "b1", latest: 3, items: [] });
    listTasks.mockClear();
    expect(await loadDesktopFeed(3)).toEqual({ boot: "b1", latest: 3, items: [] });
    expect(listTasks).not.toHaveBeenCalled();
  });
});
