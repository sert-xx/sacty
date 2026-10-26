import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const getTask = vi.fn(async (_id: string) => ({ task: paused as unknown, activity: [] }));
const findings = vi.fn();
vi.mock("@/lib/daemon", () => ({
  getTask: (id: string) => getTask(id),
  getSecurityFindings: (id: string) => findings(id),
  getTaskAudit: async () => null,
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

describe("セキュリティチェックのレポートの指摘と、対応のタスクの元のレポート", () => {
  const report = {
    ...paused,
    id: "r1",
    status: "idle",
    noRepo: undefined,
    steps: [{ key: "investigate", state: "done" }],
    stepsChoice: { plan: "security-check", reason: "点検", fallback: false },
    securityFixes: {
      dependency: { taskId: "f1", category: "dependency", title: "対応", body: "" },
    },
  };
  const fix = {
    ...paused,
    id: "f1",
    securityFix: { taskId: "r1", category: "dependency" },
  };

  // テストごとに、レポートと対応のタスクを返す（ほかのテストの設定に頼らず、単独でも通るように）
  beforeEach(() => {
    getTask.mockImplementation(async (id) => ({ task: id === "r1" ? report : fix, activity: [] }));
    findings.mockReset();
  });
  afterEach(() => {
    getTask.mockImplementation(async () => ({ task: paused, activity: [] }));
  });

  it("指摘を取れなければ null にし、指摘が無いこと（空）と分ける", async () => {
    findings.mockRejectedValueOnce(new Error("daemon 500"));
    expect((await loadTaskDetail("r1", { repositories: false }))?.securityFindings).toBeNull();
    findings.mockResolvedValueOnce([]);
    expect((await loadTaskDetail("r1", { repositories: false }))?.securityFindings).toEqual([]);
  });

  it("対応のタスクには、元のレポートのタスクを添える（レポートでないタスクは指摘を取らない）", async () => {
    const data = await loadTaskDetail("f1", { repositories: false });
    expect(data?.securityReport?.id).toBe("r1");
    expect(data?.securityFindings).toBeUndefined();
    expect(findings).not.toHaveBeenCalled();
  });
});
