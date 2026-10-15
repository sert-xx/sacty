import { describe, expect, it, vi } from "vitest";

const candidates = vi.fn();
const paused = {
  id: "t1",
  projectId: "p1",
  title: "A",
  status: "paused",
  noRepo: true,
  steps: [],
  budget: { usedUsd: 0, capUsd: 1, warned: false, estimated: false },
};
vi.mock("@/lib/daemon", () => ({
  getTask: async () => ({ task: paused, activity: [] }),
  getProject: async () => ({ project: { name: "Acme" } }),
  getCleanupPlan: async () => [],
  getStatus: async () => ({ problems: [], images: [] }),
  listTasks: async () => [],
  listProjectRepositories: (id: string) => candidates(id),
}));

const { loadTaskDetail } = await import("./task-detail-data");

describe("一時停止でリポジトリを選ぶ候補（PR #119 レビュー指摘）", () => {
  it("取れなかったときは候補を持たせず、取れなかったことを返す（取れた0件と分ける）", async () => {
    candidates.mockRejectedValueOnce(new Error("gh failed"));
    const failed = await loadTaskDetail("t1", { repositories: true });
    expect(failed?.ticketRepositories).toBeUndefined();
    expect(failed?.ticketRepositoriesFailed).toBe(true);

    candidates.mockResolvedValueOnce({ repositories: [], errors: [] });
    const none = await loadTaskDetail("t1", { repositories: true });
    expect(none?.ticketRepositories).toEqual([]);
    expect(none?.ticketRepositoriesFailed).toBeUndefined();
  });

  it("求められていなければ、候補を取らない（取り直しのたびに gh を呼ばない）", async () => {
    candidates.mockClear();
    const data = await loadTaskDetail("t1", { repositories: false });
    expect(candidates).not.toHaveBeenCalled();
    expect(data?.ticketRepositories).toBeUndefined();
    expect(data?.ticketRepositoriesFailed).toBeUndefined();
  });
});
