import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { ActivityEvent, DashboardStats, DashboardSummary, Project, Task } from "@sacty/core";
import { startTaskMcp } from "@sacty/daemon/task-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import { SqliteActivityStore } from "../../../apps/daemon/src/activity.js";
import { createApp } from "../../../apps/daemon/src/server.js";
import {
  dbPath,
  makeService,
  projectsWithAccount,
  useTempDir,
} from "../../../apps/daemon/src/testing/daemon.js";
import { type Fetch, writeDaemonFile } from "./context-preview.js";
import { daemonApi } from "./mcp.js";

// 画面のデータの読み込みは、本物のデーモンの API（createApp）につなぐ
const daemon = vi.hoisted(() => ({
  request: undefined as undefined | ((path: string) => Promise<Response>),
}));
const getJson = async <T>(path: string): Promise<T> => {
  const res = await daemon.request?.(path);
  if (!res) throw new Error("no daemon");
  return (await res.json()) as T;
};
vi.mock("@/lib/daemon", () => ({
  listProjects: async () => (await getJson<{ projects: Project[] }>("/api/projects")).projects,
  listTasks: async (options: { open?: boolean } = {}) =>
    (await getJson<{ tasks: Task[] }>(options.open ? "/api/tasks?open=1" : "/api/tasks")).tasks,
  getDashboardSummary: async () => getJson<DashboardSummary>("/api/dashboard"),
}));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));
vi.mock("@/lib/current-project", () => ({
  currentProjectId: async () => "default",
  resolveProject: (projects: { id: string }[], id: string) =>
    projects.find((p) => p.id === id) ?? projects[0],
}));

const { attentionRows } = await import("@/lib/dashboard-data");
const { loadHeaderData } = await import("@/lib/header-data");
const { loadTaskList } = await import("@/lib/task-list-data");

useTempDir();

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "sacty-person-turn-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  daemon.request = undefined;
});

const day = (n: number) => `2026-11-0${n}T00:00:00.000Z`;

/** 本物のサービス・API に、画面のデータ読み込みと MCP をつなぐ。 */
async function setup() {
  const activity = new SqliteActivityStore(dbPath);
  const { service } = makeService(activity, [], { projects: projectsWithAccount() });
  const token = "t".repeat(64);
  const app = createApp(service, token);
  daemon.request = (path) =>
    Promise.resolve(app.request(path, { headers: { authorization: `Bearer ${token}` } }));
  writeDaemonFile(home, { url: "http://127.0.0.1:4710", token });
  const fetcher: Fetch = async (url, init) => {
    const u = new URL(url);
    return app.request(`${u.pathname}${u.search}`, init);
  };
  const [a, b] = InMemoryTransport.createLinkedPair();
  startTaskMcp(daemonApi(home, fetcher), { version: "1", transport: a });
  const client = new Client(
    { name: "t", version: "1" },
    { versionNegotiation: { mode: { pin: "2026-07-28" } } },
  );
  await client.connect(b);
  const make = (title: string, patch: Record<string, unknown>) => {
    const { id } = service.createTask({ projectId: "default", title });
    Object.assign(service.get(id)?.task as Task, patch);
    return id;
  };
  // 待ち始めの記録（集計の waitingSince）を、実際のイベントの畳み込みで作る
  const wait = (id: string, at: string) => {
    const task = service.get(id)?.task as Task;
    const event = { type: "TaskPaused", taskId: id, at, payload: {} } as unknown as ActivityEvent;
    (service as unknown as { dashboardStats: DashboardStats }).dashboardStats.add(
      event,
      task,
      task,
    );
  };
  const mcpIds = async () => {
    const result = await client.callTool({
      name: "list_tasks",
      arguments: { needs_person: true, limit: 100 },
    });
    return (result.structuredContent as { tasks: { id: string }[] }).tasks.map((t) => t.id);
  };
  return { activity, service, make, wait, mcpIds };
}

/**
 * 同じタスクの集まりから、ダッシュボード・ベル・一覧の上のカード・MCP の list_tasks が、同じ ID の列を返す（PBI-442）。
 * 待ち始め・updatedAt・作成の順は、互いに違う。
 */
describe("人の出番：4 か所が同じ対象・同じ並び（PBI-442）", () => {
  it("上の組 → 下の組、組の中は待ち始めの古い順。AI が判断中の承認待ち・消したプロジェクト・終わったタスクは入らない", async () => {
    const t = await setup();
    // 作成の順：止まり古・判断新・止まり中・判断古・判断中。updatedAt の順は 1・6・3・4・5。
    // 待ち始めの記録は一部だけにあり、記録の順は updatedAt の順と食い違う（判断新は記録で最も古く、止まり古は記録で最も新しい）
    const pausedOld = t.make("止まり古", { status: "paused", updatedAt: day(1) });
    const decisionNew = t.make("判断新", { status: "awaiting_approval", updatedAt: day(6) });
    const pausedMid = t.make("止まり中", { status: "paused", updatedAt: day(3) });
    const decisionOld = t.make("判断古", { status: "escalated", updatedAt: day(4) });
    const decisionMid = t.make("判断中", { status: "awaiting_approval", updatedAt: day(5) });
    t.make("AI が判断中", {
      status: "awaiting_approval",
      pendingReview: { judgement: undefined },
      updatedAt: day(2),
    });
    t.make("消したプロジェクト", { status: "paused", projectId: "gone", updatedAt: day(1) });
    t.make("完了", { status: "idle", steps: [{ key: "requirements", state: "done" }] });
    t.make("中止", { status: "cancelled" });
    t.make("実行中", { status: "running" });

    t.wait(decisionNew, day(2));
    t.wait(pausedOld, day(7));
    // 待ち始めの記録が無い判断古（updatedAt の 4）・判断中（5）は updatedAt で並ぶ
    const expected = [decisionNew, decisionOld, decisionMid, pausedMid, pausedOld];

    const projects = (await getJson<{ projects: Project[] }>("/api/projects")).projects;
    const tasks = (await getJson<{ tasks: Task[] }>("/api/tasks?open=1")).tasks;
    const summary = await getJson<DashboardSummary>("/api/dashboard");
    const dashboard = attentionRows(
      projects,
      tasks,
      summary.waitingSince,
      messagesFor("ja").labels,
    );
    const header = await loadHeaderData("default");
    const list = await loadTaskList("default");

    expect(dashboard.map((r) => r.id)).toEqual(expected);
    expect(header?.notices.map((n) => n.taskId)).toEqual(expected);
    expect(list?.needsYou.map((c) => c.id)).toEqual(expected);
    expect(await t.mcpIds()).toEqual(expected);
    // 組と、ベルの件数・プロジェクトの切り替えの件数も、同じ判定で数える
    expect(dashboard.map((r) => r.group)).toEqual([
      "decision",
      "decision",
      "decision",
      "paused",
      "paused",
    ]);
    expect(header?.notices.map((n) => n.group)).toEqual(dashboard.map((r) => r.group));
    expect(header?.projects.find((p) => p.id === "default")?.needsYou).toBe(5);
    t.activity.close();
  });
});
