import type { Task } from "@sacty/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const listTasks = vi.fn(async (_options?: { open?: boolean }): Promise<Task[]> => []);
const getDashboardSummary = vi.fn(async () => ({ waitingSince: {} as Record<string, string> }));
vi.mock("@/lib/daemon", () => ({
  listProjects: async () => [
    { id: "p1", name: "決済", targets: [], createdAt: "", updatedAt: "" },
    { id: "p2", name: "会員", targets: [], createdAt: "", updatedAt: "" },
  ],
  listTasks,
  getDashboardSummary,
}));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "p1",
  resolveProject: (projects: { id: string }[], id: string) =>
    projects.find((p) => p.id === id) ?? projects[0],
}));

const { loadHeaderData } = await import("./header-data");

const task = (patch: Partial<Task> & { id: string }): Task =>
  ({
    projectId: "p1",
    title: patch.id,
    status: "paused",
    steps: [],
    proposals: [],
    updatedAt: "2026-11-01T00:00:00.000Z",
    createdAt: "2026-11-01T00:00:00.000Z",
    ...patch,
  }) as Task;
const pending = { keys: ["k"], remarks: ["r"] } as Task["pendingReview"];

beforeEach(() => {
  listTasks.mockReset();
  listTasks.mockResolvedValue([]);
  getDashboardSummary.mockReset();
  getDashboardSummary.mockResolvedValue({ waitingSince: {} });
});

describe("ヘッダーのデータ（PBI-114）", () => {
  it("対応待ちは終わっていないタスクなので、終わっていないタスクだけをデーモンから取る（3秒ごとに完了したタスクを運ばない）", async () => {
    const data = await loadHeaderData();
    expect(listTasks).toHaveBeenCalledWith({ open: true });
    expect(data?.current.id).toBe("p1");
  });

  it("0 件なら、お知らせは空で、プロジェクトの対応待ちも 0", async () => {
    const data = await loadHeaderData();
    expect(data?.notices).toEqual([]);
    expect(data?.projects.map((p) => p.needsYou)).toEqual([0, 0]);
  });
});

describe("ヘッダーのお知らせ：ダッシュボードの「あなたの出番」と同じ判定・並び（PBI-442）", () => {
  it("AI が判断中の承認待ちと、消したプロジェクトのタスクは数えない。件数とプロジェクトごとの対応待ちが同じ判定", async () => {
    listTasks.mockResolvedValue([
      task({ id: "a", status: "awaiting_approval" }),
      task({ id: "judging", status: "awaiting_approval", pendingReview: pending }),
      task({ id: "paused", status: "paused" }),
      task({ id: "gone", status: "awaiting_approval", projectId: "gone" }),
    ]);
    const data = await loadHeaderData();
    expect(data?.notices.map((n) => n.taskId)).toEqual(["a", "paused"]);
    expect(data?.projects.map((p) => [p.id, p.needsYou])).toEqual([
      ["p1", 2],
      ["p2", 0],
    ]);
  });

  it("上の組 → 下の組、組の中は待ち始め（記録が無ければ updatedAt）の古い順、同じなら ID の順。プロジェクトをまたいで同じ並び", async () => {
    listTasks.mockResolvedValue([
      task({ id: "p-old", status: "paused", updatedAt: "2026-11-09T00:00:00.000Z" }),
      task({ id: "d-b", status: "awaiting_approval", projectId: "p2" }),
      task({
        id: "d-a",
        status: "escalated",
        escalation: { step: "design", target: "design", pendingRemarks: [] },
        updatedAt: "2026-11-05T00:00:00.000Z",
      }),
      task({ id: "d-none", status: "awaiting_approval", updatedAt: "2026-11-03T00:00:00.000Z" }),
    ]);
    getDashboardSummary.mockResolvedValue({
      waitingSince: {
        "p-old": "2026-11-01T00:00:00.000Z",
        "d-b": "2026-11-05T00:00:00.000Z",
        "d-a": "2026-11-05T00:00:00.000Z",
      },
    });
    const data = await loadHeaderData();
    expect(data?.notices.map((n) => [n.taskId, n.group, n.waitingSince])).toEqual([
      ["d-none", "decision", "2026-11-03T00:00:00.000Z"],
      ["d-a", "decision", "2026-11-05T00:00:00.000Z"],
      ["d-b", "decision", "2026-11-05T00:00:00.000Z"],
      ["p-old", "paused", "2026-11-01T00:00:00.000Z"],
    ]);
  });

  it("AI のレビューが今の head をレビュー中（reviewing）の承認待ちにだけ、状態の文に「AI のレビュー中」を添え、並びは変えない", async () => {
    const gate = { step: "implement", submission: 1 } as Task["gate"];
    const review = (status: "none" | "reviewing" | "attached" | "unknown", id: string) =>
      task({
        id,
        status: "awaiting_approval",
        gate,
        pullRequestState: "open",
        aiReview: { head: "abc", status },
        updatedAt: `2026-11-0${id.length}T00:00:00.000Z`,
      });
    listTasks.mockResolvedValue([
      review("reviewing", "r1"),
      review("none", "r2"),
      review("unknown", "r3"),
      review("attached", "r4"),
    ]);
    const data = await loadHeaderData();
    const marked = data?.notices.filter((n) => n.status.endsWith("・AI のレビュー中"));
    expect(marked?.map((n) => n.taskId)).toEqual(["r1"]);
    // 添えなかった場合と同じ並び（updatedAt の順＝ID の長さの順）
    expect(data?.notices.map((n) => n.taskId)).toEqual(["r1", "r2", "r3", "r4"]);
  });
});
