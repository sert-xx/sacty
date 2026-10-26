import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const item = (seq: number, kind: "approval" | "completed", projectId = "p1") => ({
  seq,
  at: "",
  taskId: "t1",
  projectId,
  title: "決済API",
  kind,
});
const getNotificationFeed = vi.fn(async (_after?: number) => ({
  boot: "b1",
  latest: 3,
  items: [item(1, "approval"), item(2, "completed"), item(3, "completed", "gone")],
}));
const listProjects = vi.fn(async () => [
  { id: "p1", name: "決済", targets: [], createdAt: "", updatedAt: "" },
]);
const listTasks = vi.fn();
const getTask = vi.fn();
vi.mock("@/lib/daemon", () => ({ getNotificationFeed, listProjects, listTasks, getTask }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));

const { loadDesktopFeed } = await import("./desktop-notifications-data");

describe("デスクトップ通知に出すもの", () => {
  it("題名はデーモンが通知と一緒に持つものを使い、タスクは取らない。画面の言語の本文と開く画面にする", async () => {
    const data = await loadDesktopFeed(0);
    expect(getNotificationFeed).toHaveBeenCalledWith(0);
    expect(listTasks).not.toHaveBeenCalled();
    expect(getTask).not.toHaveBeenCalled();
    expect(data).toEqual({
      boot: "b1",
      latest: 3,
      items: [
        { seq: 1, title: "決済API", body: "[決済] 承認を待っています", href: "/tasks/t1" },
        { seq: 2, title: "決済API", body: "[決済] 完了しました", href: "/tasks/t1" },
        // プロジェクトが見つからなければ、ID を出す
        { seq: 3, title: "決済API", body: "[gone] 完了しました", href: "/tasks/t1" },
      ],
    });
  });

  it("通知が無ければ、プロジェクトも取らない", async () => {
    getNotificationFeed.mockResolvedValueOnce({ boot: "b1", latest: 3, items: [] });
    listProjects.mockClear();
    expect(await loadDesktopFeed(3)).toEqual({ boot: "b1", latest: 3, items: [] });
    expect(listProjects).not.toHaveBeenCalled();
  });
});
