import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const listTasks = vi.fn(async (_options?: { open?: boolean }) => []);
vi.mock("@/lib/daemon", () => ({
  listProjects: async () => [{ id: "p1", name: "決済", targets: [], createdAt: "", updatedAt: "" }],
  listTasks,
}));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "p1",
  resolveProject: (projects: { id: string }[], id: string) =>
    projects.find((p) => p.id === id) ?? projects[0],
}));

const { loadHeaderData } = await import("./header-data");

describe("ヘッダーのデータ（PBI-114）", () => {
  it("対応待ちは終わっていないタスクなので、終わっていないタスクだけをデーモンから取る（3秒ごとに完了したタスクを運ばない）", async () => {
    const data = await loadHeaderData();
    expect(listTasks).toHaveBeenCalledWith({ open: true });
    expect(data?.current.id).toBe("p1");
  });
});
