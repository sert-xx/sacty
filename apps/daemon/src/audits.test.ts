import {
  type ActivityEvent,
  AUDIT_CAUSE_STATUSES,
  AUDIT_STATUSES,
  type AuditTarget,
  EventInput,
  type Project,
  project as projectTasks,
  type Task,
} from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  type AuditDeps,
  auditTargetCandidates,
  causeStatus,
  isAuditTarget,
  MockAuditService,
  NoAuditService,
  sortCauses,
  weekStart,
} from "./audits.js";
import { createApp } from "./server.js";
import type { TaskService } from "./service.js";

/*
 * 完了したタスクの監査（PBI-124）。PBI-124 ではデーモンがモックのデータを返し、画面で挙動を確かめる。モックは
 * SACTY_AUDIT_MOCK=1 のときだけで、既定は監査の無い実装（NoAuditService）。
 */

let seq = 0;

/** 作業履歴の1件。 */
function event(
  taskId: string,
  projectId: string,
  at: string,
  type: string,
  payload: Record<string, unknown>,
): ActivityEvent {
  seq += 1;
  return {
    ...EventInput.parse({ type, payload }),
    seq,
    id: `e${seq}`,
    taskId,
    projectId,
    at,
    actor: "sacty",
  } as ActivityEvent;
}

/** 文書作成の工程を終えた（cancel なら中止した）タスクの作業履歴。 */
function taskEvents(
  taskId: string,
  projectId: string,
  at: string,
  options: { cancel?: boolean; unfinished?: boolean } = {},
): ActivityEvent[] {
  const runId = `run-${taskId}`;
  const list = [
    event(taskId, projectId, at, "TaskCreated", {
      title: `タスク ${taskId}`,
      body: "",
      start: "sacty",
    }),
    event(taskId, projectId, at, "StepsChosen", { steps: ["document"], fallback: false }),
    event(taskId, projectId, at, "RepositoryPrepared", {
      url: "https://github.com/example/app",
      baseBranch: "main",
      baseCommit: "abc",
    }),
    event(taskId, projectId, at, "ContextResolved", {
      runId,
      layers: [
        { repo: "sacty-default", commit: "d" },
        { repo: "https://github.com/example/ctx-org", commit: "a" },
        { repo: "https://github.com/example/ctx-team", commit: "b" },
      ],
      warnings: [],
    }),
  ];
  if (options.cancel) {
    list.push(event(taskId, projectId, at, "TaskCancelled", { cleanup: [] }));
    return list;
  }
  if (options.unfinished) return list;
  list.push(
    event(taskId, projectId, at, "AgentRunStarted", {
      runId,
      step: "document",
      agentId: "stub",
      authMode: "stub",
    }),
    event(taskId, projectId, at, "AgentRunCompleted", {
      runId,
      step: "document",
      agentId: "stub",
      authMode: "stub",
      usage: { input: 1, cacheRead: 0, cacheWrite: 0, output: 1 },
      costUsd: 0,
      estimated: false,
      output: "文書",
    }),
    event(taskId, projectId, at, "StepCompleted", { step: "document", next: "idle" }),
  );
  return list;
}

const projectOf = (id: string, name: string): Project => ({
  id,
  name,
  targets: [],
  context: { repo: "https://github.com/example/ctx-team" },
  createdAt: "",
  updatedAt: "",
});

/** プロジェクト p1 に、完了したタスクを n 件（既定は1日ずつずらして）作る。 */
function setup(
  n: number,
  extra: ActivityEvent[] = [],
  options: { intervalMs?: number; capUsd?: number } = {},
) {
  seq = 0;
  const events: ActivityEvent[] = [];
  const interval = options.intervalMs ?? 86_400_000;
  for (let i = 0; i < n; i++) {
    const at = new Date(Date.parse("2026-09-01T00:00:00Z") + i * interval).toISOString();
    events.push(...taskEvents(`t${String(i + 1).padStart(2, "0")}`, "p1", at));
  }
  events.push(...extra);
  events.forEach((e, i) => {
    (e as { seq: number }).seq = i + 1;
  });
  const tasks = [...projectTasks(events).values()];
  // 投影の updatedAt は作業履歴の時刻になる
  const deps: AuditDeps = {
    tasks: () => tasks,
    activity: (id) => events.filter((e) => e.taskId === id),
    projects: () => [projectOf("p1", "決済"), projectOf("p2", "Web")],
    defaultCapUsd: () => options.capUsd ?? 1,
  };
  return { tasks, deps, mock: new MockAuditService(deps), events };
}

describe("監査の対象と宛先の候補（PBI-124）", () => {
  it("完了したタスクだけを監査し、中止したタスク・終わっていないタスクは監査しない", () => {
    const { tasks } = setup(1, [
      ...taskEvents("cancelled", "p1", "2026-09-05T00:00:00Z", { cancel: true }),
      ...taskEvents("open", "p1", "2026-09-05T00:00:00Z", { unfinished: true }),
    ]);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    expect(isAuditTarget(byId.get("t01") as Task)).toBe(true);
    expect(isAuditTarget(byId.get("cancelled") as Task)).toBe(false);
    expect(isAuditTarget(byId.get("open") as Task)).toBe(false);
  });

  it("宛先の候補は、対象リポジトリ・使ったコンテキストの層（プロジェクトが depth 0、sacty の既定は除く）・sacty の既定", () => {
    const { tasks } = setup(1);
    expect(auditTargetCandidates(tasks[0] as Task, projectOf("p1", "決済"))).toEqual([
      { kind: "repository", repo: "https://github.com/example/app" },
      { kind: "context", repo: "https://github.com/example/ctx-org", depth: 1 },
      { kind: "context", repo: "https://github.com/example/ctx-team", depth: 0 },
      { kind: "sacty" },
    ]);
  });

  it("コンテキストを使った記録が無ければ、プロジェクトのコンテキストを depth 0 にする。リポジトリが無ければ出さない", () => {
    const { tasks } = setup(1);
    const bare = { ...(tasks[0] as Task), repository: undefined, context: undefined };
    expect(auditTargetCandidates(bare, projectOf("p1", "決済"))).toEqual([
      { kind: "context", repo: "https://github.com/example/ctx-team", depth: 0 },
      { kind: "sacty" },
    ]);
    expect(auditTargetCandidates(bare, undefined)).toEqual([{ kind: "sacty" }]);
  });
});

describe("監査の無い実装（モックを切り替えていないとき。PBI-124）", () => {
  it("タスクの監査は無く、監査の画面は空。無いプロジェクトは null。ダッシュボードも空", () => {
    const { deps } = setup(3);
    const none = new NoAuditService(deps);
    expect(none.taskAudit("t01")).toBeNull();
    expect(none.projectAudits("p1")).toEqual({
      projectId: "p1",
      mock: false,
      defaultCapUsd: 1,
      audits: [],
      causes: [],
      proposals: [],
    });
    expect(none.projectAudits("nope")).toBeNull();
    expect(none.dashboard()).toEqual({ mock: false, projects: [], trend: [] });
  });

  it("採用・却下・再開は、入力を確かめてから「無い」で断る", () => {
    const { deps } = setup(1);
    const none = new NoAuditService(deps);
    expect(() => none.adopt("x", { target: { kind: "sacty" } })).toThrow("その提案はありません。");
    expect(() => none.reject("x", { reason: " " })).toThrow();
    expect(() => none.reject("x", { reason: "理由" })).toThrow("その提案はありません。");
    expect(() => none.resume("t01", { capUsd: 2 })).toThrow("このタスクの監査はありません。");
  });
});

describe("モックの監査（PBI-124）", () => {
  it("10 件の完了したタスクで、監査のすべての状態・原因のすべての状態・すべての種類の宛先が出る", () => {
    const { mock, tasks } = setup(10);
    const audits = tasks.map((t) => mock.taskAudit(t.id));
    expect(new Set(audits.map((a) => a?.status))).toEqual(new Set(AUDIT_STATUSES));
    const data = mock.projectAudits("p1");
    expect(data?.mock).toBe(true);
    expect(new Set(data?.causes.map((c) => c.status))).toEqual(new Set(AUDIT_CAUSE_STATUSES));
    expect(new Set(data?.proposals.map((p) => p.target.kind))).toEqual(
      new Set(["repository", "context", "sacty"]),
    );
    // 判断待ち・採用・却下の提案がある
    expect(data?.proposals.some((p) => !p.decision)).toBe(true);
    expect(data?.proposals.some((p) => p.decision?.kind === "adopted")).toBe(true);
    expect(data?.proposals.some((p) => p.decision?.kind === "rejected")).toBe(true);
  });

  it("判断待ちの提案を先に並べ、原因は再発を先に並べる", () => {
    const { mock } = setup(10);
    const data = mock.projectAudits("p1");
    const pending = data?.proposals.map((p) => p.decision === undefined) ?? [];
    expect(pending.indexOf(false)).toBeGreaterThan(pending.lastIndexOf(true));
    expect(data?.causes[0]?.status).toBe("recurred");
  });

  it("同じ原因はタスクをまたいでまとめ、改修のマージの後に見つかれば再発。そのタスクの監査に再発の印を付ける", () => {
    const { mock } = setup(3);
    const lint = mock.projectAudits("p1")?.causes.find((c) => c.id === "lint");
    expect(lint?.occurrences.map((o) => o.taskId)).toEqual(["t03", "t01"]);
    expect(lint?.status).toBe("recurred");
    expect(lint?.fixedAt && lint.recurredAt && lint.fixedAt < lint.recurredAt).toBe(true);
    expect(mock.taskAudit("t03")?.findings.find((f) => f.causeId === "lint")?.recurred).toBe(true);
    // マージの前に見つかった最初のタスクには付けない
    expect(
      mock.taskAudit("t01")?.findings.find((f) => f.causeId === "lint")?.recurred,
    ).toBeUndefined();
  });

  it.each([
    ["1 分", 60_000],
    ["同じ時刻", 0],
  ])(
    "タスクの完了の間隔が短くても（%s）、最初の原因に再発を付けない（PR #134 レビュー指摘）",
    (_label, intervalMs) => {
      const { mock } = setup(3, [], { intervalMs });
      const lint = mock.projectAudits("p1")?.causes.find((c) => c.id === "lint");
      expect(
        mock.taskAudit("t01")?.findings.find((f) => f.causeId === "lint")?.recurred,
      ).toBeUndefined();
      const first = mock.taskAudit("t01")?.finishedAt ?? "";
      expect(lint?.fixedAt && lint.fixedAt > first).toBe(true);
      // 間隔があれば3つ目で再発し、同じ時刻なら再発にしない
      expect(lint?.status).toBe(intervalMs > 0 ? "recurred" : "fixed");
      // 採用した時刻は、改修のマージより前
      const adopted = mock
        .projectAudits("p1")
        ?.proposals.find((p) => p.causeId === "lint" && p.decision?.kind === "adopted");
      expect(adopted?.decision?.at && lint?.fixedAt && adopted.decision.at < lint.fixedAt).toBe(
        true,
      );
    },
  );

  it("完了したタスクが 1 件なら、最初の場面だけ（改修済みにはなるが、再発はしない）", () => {
    const { mock } = setup(1);
    const data = mock.projectAudits("p1");
    expect(data?.audits).toHaveLength(1);
    expect(data?.causes.find((c) => c.id === "lint")?.status).toBe("fixed");
  });

  it("完了したタスクが無ければ、監査は無く、画面は空", () => {
    const { mock } = setup(0);
    expect(mock.projectAudits("p1")).toMatchObject({ audits: [], causes: [], proposals: [] });
    expect(mock.taskAudit("t01")).toBeNull();
  });

  it("中止したタスク・ほかのプロジェクトのタスクには監査を出さない（プロジェクトをまたいで集約しない）", () => {
    const { mock } = setup(3, [
      ...taskEvents("c1", "p1", "2026-09-10T00:00:00Z", { cancel: true }),
      ...taskEvents("o1", "p2", "2026-09-10T00:00:00Z"),
    ]);
    expect(mock.taskAudit("c1")).toBeNull();
    expect(mock.projectAudits("p1")?.audits.map((a) => a.taskId)).not.toContain("o1");
    expect(mock.projectAudits("p2")?.audits.map((a) => a.taskId)).toEqual(["o1"]);
    expect(mock.projectAudits("nope")).toBeNull();
  });

  it("採用すると、選んだ宛先と改修のタスク（モック）を記録し、原因は採用になる。2回目は断る", () => {
    const { mock } = setup(3);
    const proposal = mock
      .projectAudits("p1")
      ?.proposals.find((p) => p.causeId === "boundary" && !p.decision);
    expect(proposal).toBeDefined();
    const id = proposal?.id ?? "";
    const target = proposal?.targetCandidates.find(
      (c) => c.kind === "context" && c.depth === 1,
    ) as AuditTarget;
    const adopted = mock.adopt(id, {
      target,
      note: { kind: "supplement", text: "既にある設定に足す" },
    });
    // 採用に添えた手入れも、モックの判断に残す（PBI-151）
    expect(adopted.decision).toMatchObject({
      kind: "adopted",
      target,
      task: { mock: true },
      note: { kind: "supplement", text: "既にある設定に足す" },
    });
    expect(mock.projectAudits("p1")?.causes.find((c) => c.id === "boundary")?.status).toBe(
      "adopted",
    );
    expect(() => mock.adopt(id, { target })).toThrow("すでに採用か却下をしています");
    expect(() => mock.reject(id, { reason: "理由" })).toThrow("すでに採用か却下をしています");
  });

  it("候補に無い宛先・形の誤った宛先・無い提案では採用できない", () => {
    const { mock } = setup(3);
    const id = mock.projectAudits("p1")?.proposals.find((p) => !p.decision)?.id ?? "";
    expect(() =>
      mock.adopt(id, { target: { kind: "repository", repo: "https://github.com/other/x" } }),
    ).toThrow("宛先の候補にありません");
    expect(() => mock.adopt(id, { target: { kind: "context", repo: "x", depth: -1 } })).toThrow();
    expect(() => mock.adopt(id, { target: { kind: "sacty" }, extra: 1 })).toThrow();
    // 手入れは、種類が決まったものだけ・中身が空白だけは不可（PBI-151）
    expect(() =>
      mock.adopt(id, { target: { kind: "sacty" }, note: { kind: "other", text: "x" } }),
    ).toThrow();
    expect(() =>
      mock.adopt(id, { target: { kind: "sacty" }, note: { kind: "supplement", text: "  " } }),
    ).toThrow();
    expect(() => mock.adopt("missing", { target: { kind: "sacty" } })).toThrow(
      "その提案はありません",
    );
  });

  it("却下には理由が要る（空白だけは不可・上限の長さまで）。却下すると理由を記録し、すべて却下なら原因は却下", () => {
    const { mock } = setup(3);
    const proposal = mock
      .projectAudits("p1")
      ?.proposals.find((p) => p.causeId === "boundary" && !p.decision);
    const id = proposal?.id ?? "";
    expect(() => mock.reject(id, { reason: "   " })).toThrow();
    expect(() => mock.reject(id, { reason: "あ".repeat(2001) })).toThrow();
    const rejected = mock.reject(id, { reason: "  共有のため変えない  " });
    expect(rejected.decision).toMatchObject({ kind: "rejected", reason: "共有のため変えない" });
    expect(mock.projectAudits("p1")?.causes.find((c) => c.id === "boundary")?.status).toBe(
      "rejected",
    );
  });

  it("予算で止まった監査は、使った額より大きい上限でだけ再開でき、再開すると深掘りに戻る", () => {
    const { mock } = setup(5);
    expect(mock.taskAudit("t05")?.status).toBe("budgetPaused");
    expect(() => mock.resume("t05", {})).toThrow("新しい上限が必要です");
    expect(() => mock.resume("t05", { capUsd: 1 })).toThrow("より大きい金額");
    expect(() => mock.resume("t05", { capUsd: -1 })).toThrow();
    expect(() => mock.resume("t01", { capUsd: 5 })).toThrow(
      "予算で一時停止している監査ではありません",
    );
    expect(() => mock.resume("missing", { capUsd: 5 })).toThrow("このタスクの監査はありません");
    const resumed = mock.resume("t05", { capUsd: 2.5 });
    expect(resumed).toMatchObject({ status: "deepDiving", budget: { usedUsd: 1, capUsd: 2.5 } });
  });

  it("既定の予算が大きくても（10,000 ドル）、使った額より大きい上限で再開できる（PR #134 レビュー指摘）", () => {
    const { mock } = setup(5, [], { capUsd: 10_000 });
    expect(mock.taskAudit("t05")?.budget).toEqual({ usedUsd: 10_000, capUsd: 10_000 });
    expect(() => mock.resume("t05", { capUsd: 10_000 })).toThrow("より大きい金額");
    expect(mock.resume("t05", { capUsd: 10_000.01 }).budget.capUsd).toBe(10_000.01);
  });

  it("以前の上限（200 文字）を超える長さの宛先の候補も採用できる（PR #134 レビュー指摘）", () => {
    // GitHub Enterprise のような長いホスト名の、改修のタスクを作れる GitHub のリポジトリ（以前の上限 200 文字を超える）
    const longRepo = `https://${"g".repeat(400)}.example.com/acme/ctx`;
    seq = 0;
    // 3件目に、判断待ちのコンテキスト宛ての提案（境界値）が出る
    const events = ["t01", "t02", "t03"]
      .flatMap((id, i) => taskEvents(id, "p1", `2026-09-0${i + 1}T00:00:00Z`))
      .map((e) =>
        e.type === "ContextResolved"
          ? ({
              ...e,
              payload: { ...e.payload, layers: [{ repo: longRepo, commit: "x" }] },
            } as ActivityEvent)
          : e,
      );
    const tasks = [...projectTasks(events).values()];
    const mock = new MockAuditService({
      tasks: () => tasks,
      activity: () => events,
      projects: () => [projectOf("p1", "決済")],
      defaultCapUsd: () => 1,
    });
    const proposal = mock
      .projectAudits("p1")
      ?.proposals.find((p) => !p.decision && p.causeId === "boundary");
    const target = proposal?.targetCandidates.find((c) => c.kind === "context") as AuditTarget;
    expect(target).toEqual({ kind: "context", repo: longRepo, depth: 0 });
    expect(mock.adopt(proposal?.id ?? "", { target }).decision?.kind).toBe("adopted");
  });

  it("根拠は、作業履歴の行とエージェントの実行に結び付く（ツール呼び出しの失敗は実行のログへ）", () => {
    const { mock } = setup(2);
    const finding = mock.taskAudit("t02")?.findings.find((f) => f.causeId === "testCommand");
    const failure = finding?.evidence.find((e) => e.kind === "toolFailure");
    expect(failure?.eventId).toMatch(/^e\d+$/);
    expect(failure?.runId).toBe("run-t02");
  });

  it("指摘の無い監査は、要約も「見つからなかった」にする", () => {
    const { mock } = setup(10);
    const clean = mock.taskAudit("t10");
    expect(clean?.findings).toEqual([]);
    expect(clean?.survey?.summary).toContain("見つからなかった");
  });

  it("ダッシュボードは、プロジェクトごとの件数と、週ごとのタスクあたりの差し戻し・指摘の件数だけを返す", () => {
    const { mock } = setup(10);
    const dashboard = mock.dashboard();
    expect(dashboard.mock).toBe(true);
    expect(dashboard.projects).toEqual([
      { projectId: "p1", causes: 6, recurred: 1, pending: 3, adopted: 3, rejected: 2 },
    ]);
    expect(dashboard.trend.reduce((n, w) => n + w.tasks, 0)).toBe(5);
    expect(dashboard.trend.every((w) => /^\d{4}-\d{2}-\d{2}$/.test(w.weekStart))).toBe(true);
  });
});

describe("監査の小さな関数（PBI-124）", () => {
  it("原因の状態：再発・改修済み・採用・提案あり・却下", () => {
    const p = (decision?: "adopted" | "rejected") =>
      ({
        id: "x",
        causeId: "c",
        taskId: "t",
        title: "",
        body: "",
        target: { kind: "sacty" },
        targetCandidates: [],
        ...(decision === "adopted"
          ? {
              decision: {
                kind: "adopted",
                at: "",
                target: { kind: "sacty" },
                task: { taskId: "", title: "" },
              },
            }
          : decision === "rejected"
            ? { decision: { kind: "rejected", at: "", reason: "r" } }
            : {}),
      }) as never;
    expect(causeStatus([p("adopted")], "2026-01-01", "2026-01-02")).toBe("recurred");
    expect(causeStatus([p("adopted")], "2026-01-01", undefined)).toBe("fixed");
    expect(causeStatus([p("adopted"), p()], undefined, undefined)).toBe("adopted");
    expect(causeStatus([p("rejected"), p()], undefined, undefined)).toBe("proposed");
    expect(causeStatus([p("rejected")], undefined, undefined)).toBe("rejected");
  });

  it("原因の並び：状態の順、同じ状態なら件数の多い順", () => {
    const c = (id: string, status: never, n: number) => ({
      id,
      projectId: "p",
      title: id,
      status,
      occurrences: Array.from({ length: n }, (_, i) => ({ taskId: `${i}`, taskTitle: "", at: "" })),
    });
    expect(
      sortCauses([
        c("a", "rejected" as never, 5),
        c("b", "proposed" as never, 1),
        c("c", "proposed" as never, 3),
        c("d", "recurred" as never, 1),
      ]).map((x) => x.id),
    ).toEqual(["d", "c", "b", "a"]);
  });

  it("週の始めは月曜（UTC）", () => {
    expect(weekStart("2026-10-12T00:00:00Z")).toBe("2026-10-12"); // 月曜
    expect(weekStart("2026-10-18T23:59:00Z")).toBe("2026-10-12"); // 日曜
    expect(weekStart("2026-10-19T00:00:00Z")).toBe("2026-10-19");
  });
});

describe("監査の API（PBI-124）", () => {
  function app(mock = true) {
    const { deps } = setup(5);
    const service = {
      list: deps.tasks,
      get: (id: string) => ({ activity: deps.activity(id) }),
      listProjects: deps.projects,
      auditBudgetUsd: () => 1,
    } as unknown as TaskService;
    return createApp(service, "tok", mock ? { audits: new MockAuditService(deps) } : {});
  }
  const auth = { authorization: "Bearer tok", "content-type": "application/json" };

  it("監査の取得：タスク・プロジェクト（無ければ 404）・ダッシュボード。トークンが無ければ 401", async () => {
    const a = app();
    const task = await a.request("/api/tasks/t01/audit", { headers: auth });
    expect(((await task.json()) as { audit: { status: string } }).audit.status).toBe("completed");
    expect((await a.request("/api/projects/p1/audits", { headers: auth })).status).toBe(200);
    expect((await a.request("/api/projects/nope/audits", { headers: auth })).status).toBe(404);
    expect((await a.request("/api/audits/dashboard", { headers: auth })).status).toBe(200);
    expect((await a.request("/api/audits/dashboard")).status).toBe(401);
  });

  it("モックを渡さなければ、監査の無い実装（タスクの監査は null）", async () => {
    const a = app(false);
    const res = await a.request("/api/tasks/t01/audit", { headers: auth });
    expect(await res.json()).toEqual({ audit: null });
    const project = await a.request("/api/projects/p1/audits", { headers: auth });
    expect(((await project.json()) as { mock: boolean }).mock).toBe(false);
  });

  it("採用・却下・再開：入力の誤りは 400、状態に合わなければ 409、JSON でなければ 400", async () => {
    const a = app();
    const data = (await (await a.request("/api/projects/p1/audits", { headers: auth })).json()) as {
      proposals: { id: string; decision?: unknown; target: AuditTarget }[];
    };
    const pending = data.proposals.find((p) => !p.decision);
    const id = encodeURIComponent(pending?.id ?? "");
    const post = (path: string, body: string) =>
      a.request(path, { method: "POST", headers: auth, body });
    expect((await post(`/api/audits/proposals/${id}/reject`, '{"reason":""}')).status).toBe(400);
    expect((await post(`/api/audits/proposals/${id}/adopt`, "not json")).status).toBe(400);
    const adopted = await post(
      `/api/audits/proposals/${id}/adopt`,
      JSON.stringify({ target: pending?.target }),
    );
    expect(adopted.status).toBe(200);
    expect((await post(`/api/audits/proposals/${id}/reject`, '{"reason":"理由"}')).status).toBe(
      409,
    );
    expect((await post("/api/tasks/t01/audit/resume", '{"capUsd":2}')).status).toBe(409);
    expect((await post("/api/tasks/t05/audit/resume", '{"capUsd":2}')).status).toBe(200);
  });
});
