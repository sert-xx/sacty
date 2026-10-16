import type { Task, TaskStatus } from "@sacty/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const listProjects = vi.fn();
const listTasks = vi.fn();
const getStatus = vi.fn(async () => ({ agent: null, problems: [], warnings: [], intake: null }));
vi.mock("@/lib/daemon", () => ({ listProjects, listTasks, getStatus }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));

const { isOpenTask, loadDashboard } = await import("./dashboard-data");

const project = (id: string, name: string) => ({
  id,
  name,
  targets: [],
  createdAt: "",
  updatedAt: "",
});

let n = 0;
const task = (patch: Partial<Task> = {}): Task => ({
  id: `t${++n}`,
  projectId: "p1",
  title: "タスク",
  body: "",
  start: "sacty",
  status: "running",
  steps: [{ key: "implement", state: "active" }],
  outputs: {},
  testViewpoints: [],
  approved: {},
  proposals: [],
  testMap: [],
  reviewComments: [],
  reproductionTests: [],
  verifyFailures: 0,
  integrationFailures: 0,
  misses: [],
  importedFeedback: [],
  questions: [],
  exports: {},
  stepPullRequests: [],
  stepBranches: [],
  submissions: {},
  remarks: [],
  budget: { usedUsd: 0, capUsd: 1, warned: false, estimated: false },
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
  ...patch,
});

const done = [
  { key: "implement", state: "done" },
  { key: "pr", state: "skip" },
] as Task["steps"];

beforeEach(() => {
  n = 0;
  listProjects.mockReset();
  listTasks.mockReset();
  listProjects.mockResolvedValue([project("p1", "決済"), project("p2", "Webサイト")]);
});

describe("ダッシュボードの終わっていないタスク（PBI-114）", () => {
  it("完了・中止を除くすべての状態を出す（承認待ち・一時停止・エスカレーションも含む）", () => {
    const open: TaskStatus[] = [
      "blocked",
      "waiting_children",
      "queued",
      "running",
      "idle",
      "paused",
      "awaiting_approval",
      "escalated",
    ];
    for (const status of open) expect(isOpenTask(task({ status })), status).toBe(true);
    // 工程がすべて終わった idle は完了
    expect(isOpenTask(task({ status: "idle", steps: done }))).toBe(false);
    expect(isOpenTask(task({ status: "cancelled" }))).toBe(false);
    // 工程を選ぶ前（工程が無い）の idle は、まだ終わっていない
    expect(isOpenTask(task({ status: "idle", steps: [] }))).toBe(true);
  });

  it("すべてのプロジェクトのタスクを、プロジェクトの名前・状態・ID つきで、新しく動いた順に出す", async () => {
    listTasks.mockResolvedValue([
      task({ id: "a", projectId: "p1", title: "古い", updatedAt: "2026-10-10T00:00:00Z" }),
      task({
        id: "b",
        projectId: "p2",
        title: "承認待ち",
        status: "awaiting_approval",
        gate: { step: "implement", submission: 1 } as Task["gate"],
        updatedAt: "2026-10-12T00:00:00Z",
      }),
      task({ id: "c", projectId: "p1", status: "cancelled", updatedAt: "2026-10-13T00:00:00Z" }),
      task({ id: "d", projectId: "p2", status: "idle", steps: done }),
    ]);
    const data = await loadDashboard();
    // 終わっていないタスクだけをデーモンから取る（完了したタスクの成果物を3秒ごとに運ばない）
    expect(listTasks).toHaveBeenCalledWith({ open: true });
    expect(data.projects).toBe(2);
    expect(data.openTasks.map((t) => [t.id, t.projectId, t.projectName])).toEqual([
      ["b", "p2", "Webサイト"],
      ["a", "p1", "決済"],
    ]);
    expect(data.openTasks[0]?.status.tone).toBe("person");
    expect(data.openTasks[0]?.status.text).toContain("承認待ち");
    expect(data.openTasks[1]?.status).toEqual({ text: "実行中", tone: "working" });
  });

  it("件数の上限は無い", async () => {
    listTasks.mockResolvedValue(Array.from({ length: 120 }, () => task()));
    expect((await loadDashboard()).openTasks).toHaveLength(120);
  });

  it("消したプロジェクトのタスクは出さない。プロジェクトが無いときは 0 件", async () => {
    listTasks.mockResolvedValue([task({ projectId: "gone" })]);
    expect((await loadDashboard()).openTasks).toEqual([]);
    listProjects.mockResolvedValue([]);
    expect(await loadDashboard()).toEqual({ projects: 0, openTasks: [], notificationProblems: [] });
  });

  it("デーモンに届かなければ例外（画面は届かないことを出す）", async () => {
    listTasks.mockRejectedValue(new Error("unreachable"));
    await expect(loadDashboard()).rejects.toThrow("unreachable");
  });
});

describe("ダッシュボードの Slack の通知を送れなかった理由（PBI-115）", () => {
  it("デーモンの警告から、通知を送れなかった理由だけを画面の言語の文にして持つ", async () => {
    listProjects.mockResolvedValue([]);
    listTasks.mockResolvedValue([]);
    getStatus.mockResolvedValueOnce({
      agent: null,
      problems: [],
      warnings: [
        { code: "notify.failed", params: { detail: "HTTP 500: down" } },
        { code: "secret.opMissing" },
        "ほかの警告",
      ],
      intake: null,
    } as never);
    expect((await loadDashboard()).notificationProblems).toEqual([
      "Slack の通知を送れませんでした：HTTP 500: down（タスクは止めていません）",
    ]);
    expect((await loadDashboard()).notificationProblems).toEqual([]);
  });
});
