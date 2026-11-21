import type { Task } from "@sacty/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

let tasks: Task[] = [];
let waitingSince: Record<string, string> = {};
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));
vi.mock("@/lib/daemon", () => ({
  listTasks: async () => tasks,
  listProjects: async () => [{ id: "default", name: "既定" }],
  getDashboardSummary: async () => ({ waitingSince }),
}));
const { loadTaskList } = await import("./task-list-data");

const at = (n: number) => `2026-11-0${n}T00:00:00.000Z`;
const task = (patch: Partial<Task> & { id: string }): Task =>
  ({
    projectId: "default",
    title: patch.id,
    body: "",
    start: "sacty",
    status: "paused",
    steps: [],
    proposals: [],
    createdAt: at(1),
    updatedAt: at(1),
    ...patch,
  }) as Task;
const gate = { step: "implement", submission: 1 } as Task["gate"];
const escalation = { step: "design", target: "design", pendingRemarks: [] } as Task["escalation"];

beforeEach(() => {
  tasks = [];
  waitingSince = {};
});

describe("タスクの一覧の上のカード：ダッシュボードの「あなたの出番」と同じ対象・同じ並び（PBI-442）", () => {
  it("AI が判断中の承認待ちを除き、上の組 → 下の組、組の中は待ち始めの古い順。デーモンの返す順は関係しない", async () => {
    // デーモンは作った順（新しい順）に返す。待ち始めの順・組とは違う
    tasks = [
      task({ id: "p-new", status: "paused", createdAt: at(9) }),
      task({
        id: "judging",
        status: "awaiting_approval",
        gate,
        pendingReview: { keys: ["k"], remarks: ["r"] } as Task["pendingReview"],
        createdAt: at(8),
      }),
      task({ id: "d-late", status: "awaiting_approval", gate, createdAt: at(7) }),
      task({ id: "p-old", status: "paused", createdAt: at(6) }),
      task({ id: "d-early", status: "escalated", escalation, createdAt: at(5) }),
      task({ id: "running", status: "running", createdAt: at(4) }),
    ];
    waitingSince = {
      "p-new": at(2),
      "d-late": at(5),
      "p-old": at(1),
      "d-early": at(3),
    };
    const data = await loadTaskList("default");
    expect(data?.needsYou.map((c) => c.id)).toEqual(["d-early", "d-late", "p-old", "p-new"]);
    // 組の見出しは持たない
    expect(Object.keys(data?.needsYou[0] ?? {}).sort()).toEqual([
      "action",
      "id",
      "status",
      "title",
    ]);
    expect(data && "groups" in data).toBe(false);
  });

  it("待ち始めが同じなら ID の順。記録が無ければ updatedAt。0 件は空", async () => {
    expect((await loadTaskList("default"))?.needsYou).toEqual([]);
    tasks = [
      task({ id: "b", status: "paused", updatedAt: at(3) }),
      task({ id: "a", status: "paused", updatedAt: at(3) }),
      task({ id: "c", status: "paused", updatedAt: at(2) }),
    ];
    const data = await loadTaskList("default");
    expect(data?.needsYou.map((c) => c.id)).toEqual(["c", "a", "b"]);
  });

  it("「レビュー中」は reviewing のときだけ状態の文に添え、並びは変えない。一覧の表の状態の列には添えない", async () => {
    const prTask = (id: string, status: "none" | "reviewing" | "unknown" | "attached", n: number) =>
      task({
        id,
        status: "awaiting_approval",
        gate,
        pullRequestState: "open",
        aiReview: { head: "abc", status },
        updatedAt: at(n),
      });
    tasks = [
      prTask("r-none", "none", 1),
      prTask("r-attached", "attached", 2),
      prTask("r-reviewing", "reviewing", 3),
      prTask("r-unknown", "unknown", 4),
    ];
    const data = await loadTaskList("default");
    // reviewing は途中。updatedAt の古い順のまま動かない
    expect(data?.needsYou.map((c) => c.id)).toEqual([
      "r-none",
      "r-attached",
      "r-reviewing",
      "r-unknown",
    ]);
    expect(
      data?.needsYou.filter((c) => c.status.endsWith("・AI のレビュー中")).map((c) => c.id),
    ).toEqual(["r-reviewing"]);
    const row = data?.rows.find((r) => r.id === "r-reviewing");
    expect(row?.status.text).not.toContain("AI のレビュー中");
    expect(row?.status.text).toBe(data?.rows.find((r) => r.id === "r-none")?.status.text);
  });
});
