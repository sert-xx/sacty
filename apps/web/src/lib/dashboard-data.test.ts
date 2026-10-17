import type { DashboardSummary, Task, TaskStatus } from "@sacty/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const listProjects = vi.fn();
const listTasks = vi.fn();
const getStatus = vi.fn(async () => ({ agent: null, problems: [], warnings: [], intake: null }));
const getDashboardSummary = vi.fn();
// 監査の指標（PBI-124）。既定は取れない（ほかの欄の確かめに混ぜない）
const getAuditDashboard = vi.fn(async (): Promise<unknown> => {
  throw new Error("no audit");
});
vi.mock("@/lib/daemon", () => ({
  listProjects,
  listTasks,
  getStatus,
  getDashboardSummary,
  getAuditDashboard,
}));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));

const { attentionRows, isOpenTask, loadDashboard, nearBudgetRows, pausedGroups } = await import(
  "./dashboard-data"
);
const { PAUSE_REASON_ORDER } = await import("./dashboard-rules");

const project = (id: string, name: string) => ({
  id,
  name,
  targets: [],
  createdAt: "",
  updatedAt: "",
});
const projects = [project("p1", "決済"), project("p2", "Webサイト")];
const { labels } = messagesFor("ja");

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

const gate = (step: "requirements" | "implement" = "requirements") =>
  ({ step, submission: 1 }) as Task["gate"];

const summary = (patch: Partial<DashboardSummary> = {}): DashboardSummary => ({
  timeZone: "Asia/Tokyo",
  waitingSince: {},
  costs: {
    today: { actualUsd: 0.5, estimatedUsd: 0 },
    days7: { actualUsd: 2, estimatedUsd: 1 },
    since: { today: "2026-10-15T15:00:00.000Z", days7: "2026-10-09T15:00:00.000Z" },
  },
  flow: {
    days7: { completed: 1, cancelled: 0, medianLeadMs: 3_600_000 },
    days30: { completed: 4, cancelled: 1, medianLeadMs: 7_200_000 },
    since: { days7: "2026-10-09T15:00:00.000Z", days30: "2026-09-16T15:00:00.000Z" },
  },
  quality: {
    since: "2026-09-16T15:00:00.000Z",
    counts: {
      changesRequested: 2,
      pullRequestRework: 1,
      guardianMissed: 0,
      integrationFailed: 0,
      fixTask: 1,
    },
    reworkBySteps: { design: 2, implement: 1 },
  },
  queue: { running: 1, queued: 2, max: 3 },
  ...patch,
});

beforeEach(() => {
  n = 0;
  listProjects.mockReset();
  listTasks.mockReset();
  getDashboardSummary.mockReset();
  listProjects.mockResolvedValue(projects);
  getDashboardSummary.mockResolvedValue(summary());
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
        gate: gate("implement"),
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
    const data = await loadDashboard();
    expect(data.projects).toBe(0);
    expect(data.openTasks).toEqual([]);
    expect(data.attention).toEqual([]);
    expect(data.paused).toEqual([]);
    expect(data.costs.nearBudget).toEqual([]);
  });

  it("デーモンに届かなければ例外（画面は届かないことを出す）", async () => {
    listTasks.mockRejectedValue(new Error("unreachable"));
    await expect(loadDashboard()).rejects.toThrow("unreachable");
    listTasks.mockResolvedValue([]);
    getDashboardSummary.mockRejectedValue(new Error("daemon responded 404"));
    await expect(loadDashboard()).rejects.toThrow("404");
  });
});

describe("ダッシュボードのデータの形（PBI-118）", () => {
  it("デーモンの集計（費用・流量・品質・待ち行列・タイムゾーン）と取り込みの状況を、そのまま欄のデータにする", async () => {
    listTasks.mockResolvedValue([]);
    getStatus.mockResolvedValueOnce({
      agent: null,
      problems: [],
      warnings: [],
      intake: {
        label: "sacty",
        runs: { issues: { lastRunAt: "2026-10-15T00:00:00Z", imported: 2 } },
      },
    } as never);
    const data = await loadDashboard();
    const s = summary();
    expect(getDashboardSummary).toHaveBeenCalledTimes(1);
    expect(data.costs).toEqual({ ...s.costs, timeZone: "Asia/Tokyo", nearBudget: [] });
    expect(data.flow).toEqual(s.flow);
    expect(data.quality).toEqual(s.quality);
    expect(data.queue).toEqual(s.queue);
    expect(data.intake).toEqual({
      label: "sacty",
      runs: { issues: { lastRunAt: "2026-10-15T00:00:00Z", imported: 2 } },
    });
    expect(Object.keys(data).sort()).toEqual(
      [
        "projects",
        "openTasks",
        "notificationProblems",
        "attention",
        "paused",
        "costs",
        "intake",
        "flow",
        "quality",
        "queue",
      ].sort(),
    );
  });
});

describe("ダッシュボードのあなたの出番（PBI-118）", () => {
  it("承認待ち・一時停止・エスカレーションを、待っている時間が長い順に、判断する場所へのリンクつきで出す", () => {
    const tasks = [
      task({
        id: "a",
        status: "awaiting_approval",
        gate: gate(),
        updatedAt: "2026-10-12T00:00:00Z",
      }),
      task({
        id: "b",
        status: "paused",
        pausedReason: "budget",
        updatedAt: "2026-10-11T00:00:00Z",
      }),
      task({
        id: "c",
        status: "escalated",
        escalation: { step: "design", target: "design", pendingRemarks: [] },
        updatedAt: "2026-10-13T00:00:00Z",
      }),
      // 人の出番ではない
      task({ id: "d", status: "running" }),
      task({ id: "e", status: "queued" }),
      // 承認待ちでも、ゴールガーディアンが PR の指摘を判断している間は出さない
      task({
        id: "f",
        status: "awaiting_approval",
        gate: gate("implement"),
        pendingReview: { keys: ["k"], remarks: ["r"] },
      }),
    ];
    const rows = attentionRows(
      projects,
      tasks,
      // c は作業履歴の記録の時刻（updatedAt より古い）、a は記録が無いので updatedAt
      { c: "2026-10-09T00:00:00Z", b: "2026-10-11T00:00:00Z" },
      labels,
    );
    expect(rows.map((r) => [r.id, r.waitingSince, r.href])).toEqual([
      ["c", "2026-10-09T00:00:00Z", "/tasks/c/review"],
      ["b", "2026-10-11T00:00:00Z", "/tasks/b"],
      ["a", "2026-10-12T00:00:00Z", "/tasks/a/review"],
    ]);
    expect(rows[0]?.projectName).toBe("決済");
    expect(rows[1]?.status).toEqual({ text: "予算上限で一時停止", tone: "person" });
  });

  it("0 件・1 件・消したプロジェクト", () => {
    expect(attentionRows(projects, [], {}, labels)).toEqual([]);
    expect(
      attentionRows(projects, [task({ status: "paused", projectId: "gone" })], {}, labels),
    ).toEqual([]);
    expect(
      attentionRows(projects, [task({ id: "only", status: "paused" })], {}, labels).map(
        (r) => r.id,
      ),
    ).toEqual(["only"]);
  });
});

describe("ダッシュボードの止まっているタスクの理由（PBI-118）", () => {
  it("理由ごとに件数とタスクをまとめ、利用上限・認証を先頭にする。件数 0 の理由は出さない", () => {
    const tasks = [
      task({
        id: "a",
        status: "paused",
        pausedReason: "budget",
        updatedAt: "2026-10-11T00:00:00Z",
      }),
      task({ id: "b", status: "paused", pausedReason: "auth" }),
      task({
        id: "c",
        status: "paused",
        pausedReason: "budget",
        updatedAt: "2026-10-12T00:00:00Z",
      }),
      task({ id: "d", status: "running" }),
      task({ id: "e", status: "paused", pausedReason: "auth", projectId: "gone" }),
      // 理由の無い古い記録は「人が止めた」
      task({ id: "f", status: "paused" }),
    ];
    expect(pausedGroups(projects, tasks).map((g) => [g.reason, g.tasks.map((t) => t.id)])).toEqual([
      ["auth", ["b"]],
      ["budget", ["c", "a"]],
      ["manual", ["f"]],
    ]);
    expect(PAUSE_REASON_ORDER.slice(0, 2)).toEqual(["usage_limit", "auth"]);
    expect(pausedGroups(projects, [])).toEqual([]);
    expect(
      pausedGroups(projects, [task({ id: "t1", status: "paused", pausedReason: "error" })]),
    ).toEqual([{ reason: "error", tasks: [{ id: "t1", title: "タスク", projectName: "決済" }] }]);
  });
});

describe("ダッシュボードの予算に近いタスク（PBI-118）", () => {
  it("終わっていないタスクのうち、80% 以上か上限に達したものを、割合の大きい順に出す", () => {
    const budget = (usedUsd: number, capUsd: number, estimated = false) => ({
      usedUsd,
      capUsd,
      warned: false,
      estimated,
    });
    const tasks = [
      task({ id: "a", budget: budget(0.8, 1) }),
      task({ id: "b", budget: budget(0.79, 1) }),
      task({ id: "c", budget: budget(2, 2, true) }),
      task({ id: "d", budget: budget(1.8, 2) }),
      // 終わったタスクと、消したプロジェクトのタスクは出さない
      task({ id: "e", budget: budget(1, 1), status: "cancelled" }),
      task({ id: "f", budget: budget(1, 1), status: "idle", steps: done }),
      task({ id: "g", budget: budget(1, 1), projectId: "gone" }),
    ];
    const rows = nearBudgetRows(projects, tasks);
    expect(rows.map((r) => [r.id, r.exceeded, r.estimated])).toEqual([
      ["c", true, true],
      ["d", false, false],
      ["a", false, false],
    ]);
    expect(rows[0]).toMatchObject({ usedUsd: 2, capUsd: 2, projectName: "決済" });
    expect(nearBudgetRows(projects, [])).toEqual([]);
  });
});
