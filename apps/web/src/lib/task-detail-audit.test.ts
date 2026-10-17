import { describe, expect, it, vi } from "vitest";

/*
 * タスクの詳細の監査の欄のデータ（PBI-124）。完了したタスクだけ監査を取り、取れなくてもタスクの詳細は出す。
 */
const base = {
  projectId: "p1",
  title: "A",
  steps: [{ key: "document", state: "done" }],
  budget: { usedUsd: 0, capUsd: 1, warned: false, estimated: false },
};
const tasks: Record<string, unknown> = {
  done: { ...base, id: "done", status: "idle" },
  cancelled: { ...base, id: "cancelled", status: "cancelled" },
  open: { ...base, id: "open", status: "running", steps: [{ key: "document", state: "active" }] },
};
const getTaskAudit = vi.fn();
vi.mock("@/lib/daemon", () => ({
  getTask: async (id: string) => ({ task: tasks[id], activity: [] }),
  getProject: async () => ({ project: { name: "Acme" } }),
  getCleanupPlan: async () => [],
  getStatus: async () => ({ problems: [], images: [] }),
  listTasks: async () => [],
  listProjectRepositories: async () => ({ repositories: [] }),
  getTaskAudit: (id: string) => getTaskAudit(id),
}));

const { loadTaskDetail } = await import("./task-detail-data");

describe("タスクの詳細の監査（PBI-124）", () => {
  it("完了したタスクは監査を取る（無ければ null）", async () => {
    getTaskAudit.mockResolvedValueOnce({ status: "completed" });
    expect((await loadTaskDetail("done", { repositories: false }))?.audit).toEqual({
      status: "completed",
    });
    getTaskAudit.mockResolvedValueOnce(null);
    expect((await loadTaskDetail("done", { repositories: false }))?.audit).toBeNull();
  });

  it("監査を取れなくても、タスクの詳細は出す（監査は null）", async () => {
    getTaskAudit.mockRejectedValueOnce(new Error("down"));
    const data = await loadTaskDetail("done", { repositories: false });
    expect(data?.task.id).toBe("done");
    expect(data?.audit).toBeNull();
  });

  it("中止したタスク・終わっていないタスクは、監査を取らず、欄も出さない（audit が無い）", async () => {
    getTaskAudit.mockClear();
    for (const id of ["cancelled", "open"]) {
      const data = await loadTaskDetail(id, { repositories: false });
      expect(data && "audit" in data, id).toBe(false);
    }
    expect(getTaskAudit).not.toHaveBeenCalled();
  });
});
