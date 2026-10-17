import {
  type ActivityEvent,
  EventInput,
  type Project,
  project as projectTasks,
  type Task,
} from "@sacty/core";
import { describe, expect, it } from "vitest";
import { type AuditLedger, LedgerAuditService } from "./ledger-audits.js";

/*
 * 作業履歴の監査の記録から、画面の形を組み立てる（PBI-125）。原因は鍵ごとにまとめ、改修のタスクの PR のマージより後に
 * 見つかれば再発。プロジェクトをまたいで集約しない。
 */

let seq = 0;
function ev(
  taskId: string,
  at: string,
  type: string,
  payload: Record<string, unknown>,
  projectId = "p1",
): ActivityEvent {
  seq++;
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

const run = { agentId: "a", auditCostUsd: 0.1, estimated: false };
const repo = { kind: "repository", repo: "https://github.com/a/app" } as const;

/** 完了したタスクと、その監査（原因 causeKey を1つ見つけた）。stop は監査を止める段。 */
function audited(
  taskId: string,
  at: string,
  causeKey: string,
  options: { projectId?: string; stop?: "queued" | "surveyed" | "paused" | "failed" } = {},
): ActivityEvent[] {
  const p = options.projectId ?? "p1";
  const t = (offset: number) => new Date(Date.parse(at) + offset * 60_000).toISOString();
  const list = [
    ev(taskId, t(0), "TaskCreated", { title: `タスク ${taskId}`, body: "", start: "sacty" }, p),
    ev(taskId, t(0), "StepsChosen", { steps: ["document"] }, p),
    ev(
      taskId,
      t(0),
      "AgentRunStarted",
      { runId: `r-${taskId}`, step: "document", agentId: "a", authMode: "stub" },
      p,
    ),
    ev(
      taskId,
      t(0),
      "AgentRunCompleted",
      {
        runId: `r-${taskId}`,
        step: "document",
        agentId: "a",
        authMode: "stub",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        costUsd: 0,
        estimated: false,
        output: "文書",
      },
      p,
    ),
    ev(taskId, t(0), "StepCompleted", { step: "document", next: "idle" }, p),
    ev(taskId, t(1), "AuditQueued", { auditId: `a-${taskId}`, capUsd: 1 }, p),
  ];
  if (options.stop === "queued") return list;
  list.push(
    ev(
      taskId,
      t(2),
      "AuditSurveyed",
      {
        auditId: `a-${taskId}`,
        summary: "要約",
        counts: {
          changesRequested: 1,
          pullRequestRemark: 2,
          pause: 0,
          retry: 0,
          toolFailure: 3,
          escalation: 0,
        },
        concerns: [{ step: "document", reason: "理由" }],
        ...run,
      },
      p,
    ),
  );
  if (options.stop === "surveyed") return list;
  if (options.stop === "paused") {
    list.push(
      ev(taskId, t(3), "AuditBudgetPaused", { auditId: `a-${taskId}`, usedUsd: 1, capUsd: 1 }, p),
    );
    return list;
  }
  if (options.stop === "failed") {
    list.push(
      ev(
        taskId,
        t(3),
        "AuditFailed",
        { auditId: `a-${taskId}`, reason: { code: "audit.unreadable" }, step: "document", ...run },
        p,
      ),
    );
    return list;
  }
  list.push(
    ev(
      taskId,
      t(3),
      "AuditDeepDived",
      {
        auditId: `a-${taskId}`,
        step: "document",
        summary: "深掘り",
        findings: [
          {
            causeKey,
            title: `原因 ${causeKey}`,
            detail: "説明",
            step: "document",
            evidence: [{ kind: "toolFailure", text: "失敗", runId: `r-${taskId}` }],
            proposals: [
              {
                id: `${taskId}:prop`,
                title: "直す",
                body: "本文",
                target: repo,
                candidates: [repo, { kind: "sacty" }],
              },
            ],
          },
        ],
        ...run,
      },
      p,
    ),
    ev(taskId, t(4), "AuditCompleted", { auditId: `a-${taskId}` }, p),
  );
  return list;
}

function ledger(events: ActivityEvent[], extra: Task[] = [], running: string[] = []) {
  events.forEach((e, i) => {
    (e as { seq: number }).seq = i + 1;
  });
  const tasks = [...projectTasks(events).values(), ...extra];
  const projects: Project[] = [
    { id: "p1", name: "決済", targets: [], createdAt: "", updatedAt: "" },
    { id: "p2", name: "Web", targets: [], createdAt: "", updatedAt: "" },
  ];
  const calls: string[] = [];
  const l: AuditLedger = {
    list: () => tasks,
    listProjects: () => projects,
    auditBudgetUsd: () => 2,
    auditRunning: (id) => running.includes(id),
    adoptAuditProposal: (id) => {
      calls.push(`adopt ${id}`);
      return tasks[0] as Task;
    },
    rejectAuditProposal: (id) => {
      calls.push(`reject ${id}`);
      return tasks[0] as Task;
    },
    resumeAudit: (id) => {
      calls.push(`resume ${id}`);
      return tasks[0] as Task;
    },
  };
  return { service: new LedgerAuditService(l), tasks, calls };
}

/** 改修のタスク（PR をマージした時刻だけを持つ）。 */
const fixTask = (id: string, mergedAt?: string) =>
  ({
    id,
    projectId: "p1",
    title: `改修 ${id}`,
    status: "idle",
    steps: [],
    ...(mergedAt ? { pullRequestMerge: { at: mergedAt } } : {}),
  }) as unknown as Task;

describe("作業履歴から作る監査（PBI-125）", () => {
  it("監査の状態：待ち・実行中（大まかな監査）・深掘り・予算で一時停止・失敗・完了", () => {
    seq = 0;
    const { service } = ledger(
      [
        ...audited("w", "2026-10-01T00:00:00Z", "c", { stop: "queued" }),
        ...audited("s", "2026-10-01T01:00:00Z", "c", { stop: "queued" }),
        ...audited("d", "2026-10-01T02:00:00Z", "c", { stop: "surveyed" }),
        ...audited("p", "2026-10-01T03:00:00Z", "c", { stop: "paused" }),
        ...audited("f", "2026-10-01T04:00:00Z", "c", { stop: "failed" }),
        ...audited("c", "2026-10-01T05:00:00Z", "k"),
      ],
      [],
      ["s", "d"],
    );
    const status = (id: string) => service.taskAudit(id)?.status;
    expect(["w", "s", "d", "p", "f", "c"].map(status)).toEqual([
      "waiting",
      "surveying",
      "deepDiving",
      "budgetPaused",
      "failed",
      "completed",
    ]);
    expect(service.taskAudit("d")?.deepDives).toEqual([
      { step: "document", reason: "理由", status: "running" },
    ]);
    expect(service.taskAudit("f")?.deepDives[0]?.status).toBe("failed");
    expect(service.taskAudit("f")?.failure).toEqual({ code: "audit.unreadable" });
    const done = service.taskAudit("c");
    expect(done?.deepDives[0]).toMatchObject({ status: "completed", summary: "深掘り" });
    expect(done?.budget).toEqual({ usedUsd: 0.2, capUsd: 1 });
    expect(done?.survey?.counts.toolFailure).toBe(3);
    expect(done?.findings[0]).toMatchObject({
      causeId: "k",
      proposals: [{ id: "c:prop", taskId: "c", targetCandidates: [repo, { kind: "sacty" }] }],
    });
    expect(service.taskAudit("missing")).toBeNull();
  });

  it("原因を鍵ごとにまとめ、改修の PR のマージより後に見つかれば再発。マージの前に見つかったものには付けない", () => {
    seq = 0;
    const events = [
      ...audited("t1", "2026-10-01T00:00:00Z", "lint"),
      ...audited("t2", "2026-10-03T00:00:00Z", "lint"),
    ];
    events.push(
      ev("t1", "2026-10-01T01:00:00Z", "AuditProposalAdopted", {
        proposalId: "t1:prop",
        target: repo,
        fixTaskId: "fix",
      }),
    );
    const { service } = ledger(events, [fixTask("fix", "2026-10-02T00:00:00Z")]);
    const data = service.projectAudits("p1");
    const cause = data?.causes.find((c) => c.id === "lint");
    expect(cause).toMatchObject({
      status: "recurred",
      fixedAt: "2026-10-02T00:00:00Z",
      recurredAt: "2026-10-03T00:03:00.000Z",
    });
    expect(cause?.occurrences.map((o) => o.taskId)).toEqual(["t2", "t1"]);
    expect(service.taskAudit("t2")?.findings[0]?.recurred).toBe(true);
    expect(service.taskAudit("t1")?.findings[0]?.recurred).toBeUndefined();
    // 採用した提案は、改修のタスクの題で出す
    const adopted = data?.proposals.find((p) => p.id === "t1:prop");
    expect(adopted?.decision).toMatchObject({
      kind: "adopted",
      task: { taskId: "fix", title: "改修 fix" },
    });
  });

  it("改修のタスクがまだマージされていなければ採用、マージ後に見つかっていなければ改修済み、却下・判断待ち", () => {
    seq = 0;
    const events = [
      ...audited("t1", "2026-10-01T00:00:00Z", "a"),
      ...audited("t2", "2026-10-01T01:00:00Z", "b"),
      ...audited("t3", "2026-10-01T02:00:00Z", "c"),
      ...audited("t4", "2026-10-01T03:00:00Z", "d"),
    ];
    events.push(
      ev("t1", "2026-10-02T00:00:00Z", "AuditProposalAdopted", {
        proposalId: "t1:prop",
        target: repo,
        fixTaskId: "f1",
      }),
      ev("t2", "2026-10-02T00:00:00Z", "AuditProposalAdopted", {
        proposalId: "t2:prop",
        target: repo,
        fixTaskId: "f2",
      }),
      ev("t3", "2026-10-02T00:00:00Z", "AuditProposalRejected", {
        proposalId: "t3:prop",
        reason: "要らない",
      }),
    );
    const { service } = ledger(events, [fixTask("f1"), fixTask("f2", "2026-10-05T00:00:00Z")]);
    const status = Object.fromEntries(
      service.projectAudits("p1")?.causes.map((c) => [c.id, c.status]) ?? [],
    );
    expect(status).toEqual({ a: "adopted", b: "fixed", c: "rejected", d: "proposed" });
    // 判断待ちの提案を先に並べる
    expect(service.projectAudits("p1")?.proposals[0]?.id).toBe("t4:prop");
  });

  it("sacty 宛ての採用は、改修のタスクを持たない", () => {
    seq = 0;
    const events = audited("t1", "2026-10-01T00:00:00Z", "a");
    events.push(
      ev("t1", "2026-10-02T00:00:00Z", "AuditProposalAdopted", {
        proposalId: "t1:prop",
        target: { kind: "sacty" },
      }),
    );
    const { service } = ledger(events);
    const decision = service.taskAudit("t1")?.findings[0]?.proposals[0]?.decision;
    expect(decision).toMatchObject({ kind: "adopted", target: { kind: "sacty" } });
    expect(decision && "task" in decision).toBe(false);
  });

  it("プロジェクトをまたいで集約しない。ダッシュボードは件数と週ごとの推移だけ。無いプロジェクトは null", () => {
    seq = 0;
    const { service } = ledger([
      ...audited("t1", "2026-10-05T00:00:00Z", "same"),
      ...audited("o1", "2026-10-06T00:00:00Z", "same", { projectId: "p2" }),
      ...audited("o2", "2026-10-13T00:00:00Z", "other", { projectId: "p2" }),
    ]);
    expect(service.projectAudits("p1")?.causes.map((c) => c.occurrences.length)).toEqual([1]);
    expect(service.projectAudits("p1")?.audits.map((a) => a.taskId)).toEqual(["t1"]);
    expect(service.projectAudits("nope")).toBeNull();
    const dashboard = service.dashboard();
    expect(dashboard.mock).toBe(false);
    expect(dashboard.projects).toEqual([
      { projectId: "p1", causes: 1, recurred: 0, pending: 1, adopted: 0, rejected: 0 },
      { projectId: "p2", causes: 2, recurred: 0, pending: 2, adopted: 0, rejected: 0 },
    ]);
    expect(dashboard.trend).toEqual([
      { weekStart: "2026-10-05", tasks: 2, remarks: 6 },
      { weekStart: "2026-10-12", tasks: 1, remarks: 3 },
    ]);
  });

  it("採用・却下・再開は TaskService に任せ、操作の後の形を返す", () => {
    seq = 0;
    const { service, calls } = ledger(audited("t1", "2026-10-01T00:00:00Z", "a"));
    expect(service.adopt("t1:prop", { target: repo }).id).toBe("t1:prop");
    expect(service.reject("t1:prop", { reason: "r" }).id).toBe("t1:prop");
    expect(service.resume("t1", { capUsd: 2 }).taskId).toBe("t1");
    expect(calls).toEqual(["adopt t1:prop", "reject t1:prop", "resume t1"]);
  });
});
