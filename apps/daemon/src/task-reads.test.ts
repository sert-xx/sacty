import type { ActivityEvent, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { SqliteActivityStore } from "./activity.js";
import {
  isDeliverableKind,
  isDeliverableStep,
  listDeliverables,
  readDeliverable,
  runEntries,
} from "./task-reads.js";
import { dbPath, makeService, useTempDir } from "./testing/daemon.js";

useTempDir();

function base(): Task {
  const activity = new SqliteActivityStore(dbPath);
  const { service } = makeService(activity, []);
  const task = service.createTask({ projectId: "default", title: "題" });
  activity.close();
  return { ...task, steps: [], outputs: {}, approved: {}, submissions: {}, reviewComments: [] };
}

let seq = 0;
const ev = (type: string, payload: Record<string, unknown>, at?: string): ActivityEvent =>
  ({
    id: `e${++seq}`,
    taskId: "t",
    projectId: "default",
    at: at ?? `2026-11-19T00:00:${String(seq % 60).padStart(2, "0")}Z`,
    actor: "sacty",
    type,
    payload,
  }) as unknown as ActivityEvent;

const view = { id: "v1", title: "t", input: "i", expected: "e" };

describe("成果物の状態と本文（PBI-395）", () => {
  it("成果物が無いタスクは、空の一覧", () => {
    expect(listDeliverables(base(), [])).toEqual([]);
  });

  it("承認待ち・差し戻しの後・レビューの投稿前後の状態と、提出の回", () => {
    const t = base();
    const awaiting = {
      ...t,
      outputs: { requirements: "要件" },
      gate: { step: "requirements" as const, submission: 1 },
      submissions: { requirements: 1 },
    };
    expect(listDeliverables(awaiting, [])).toEqual([
      {
        step: "requirements",
        kind: "output",
        submission: 1,
        previousSubmission: null,
        status: "awaiting_approval",
        bytes: Buffer.byteLength("要件"),
      },
    ]);
    // 差し戻した後、作り直しの実行がまだ完了していない
    const changes = { ...awaiting, gate: undefined };
    const submitted = [
      ev("AgentRunCompleted", { step: "requirements", runId: "r1" }),
      ev("StepSubmitted", { step: "requirements", submission: 1 }),
      ev("ChangesRequested", { step: "requirements" }),
    ];
    expect(listDeliverables(changes, submitted)[0]).toMatchObject({
      status: "changes_requested",
      submission: 1,
    });
    // レビュー：投稿済み
    const posted = {
      ...t,
      outputs: { review: "レビュー本文" },
      reviewRound: 2,
      reviewPost: { url: "u", at: "a" },
      reviewComments: [{ path: "a.ts", line: 3, body: "ここ" }],
    };
    expect(
      listDeliverables(posted, []).map((d) => [d.step, d.kind, d.status, d.submission]),
    ).toEqual([
      ["review", "output", "posted", 2],
      ["review", "review_comments", "posted", 2],
    ]);
    // レビュー：本文があり、まだ投稿していない（前の回は 1）
    const unposted = { ...posted, reviewPost: undefined };
    expect(listDeliverables(unposted, [])[0]).toMatchObject({
      status: "not_submitted",
      submission: null,
      previousSubmission: 1,
    });
  });

  it("やり直した工程は、承認済みの最新の版と回を返す", () => {
    const t = {
      ...base(),
      outputs: { design: "2回目" },
      approved: {
        design: { submission: 2, output: "2回目の設計", testViewpoints: [], at: "a" },
      },
      submissions: { design: 2 },
    };
    expect(readDeliverable(t, [], "design", "output")).toEqual({
      status: "approved",
      submission: 2,
      previousSubmission: null,
      text: "2回目の設計",
    });
  });

  it("まだ提出していない出力は、前の回の番号で示さない", () => {
    const t = {
      ...base(),
      outputs: { design: "新しい本文" },
      submissions: { design: 1 },
    };
    const activity = [
      ev("AgentRunCompleted", { step: "design", runId: "r1" }),
      ev("StepSubmitted", { step: "design", submission: 1 }),
      ev("ChangesRequested", { step: "design" }),
      ev("AgentRunCompleted", { step: "design", runId: "r2" }),
    ];
    expect(readDeliverable(t, activity, "design", "output")).toEqual({
      status: "not_submitted",
      submission: null,
      previousSubmission: 1,
      text: "新しい本文",
    });
  });

  it("人が直した版・設計のテスト観点・レビューの行へのコメントを、一覧に載せて読める", () => {
    const t = {
      ...base(),
      outputs: { review: "本文", requirements: "要件" },
      reviewPost: { url: "u", at: "a" },
      reviewComments: [
        { path: "a.ts", line: 3, body: "ここを直す" },
        { path: "b.ts", line: 9, body: "ここも" },
      ],
      approved: {
        requirements: {
          submission: 1,
          output: "人が直した版",
          testViewpoints: [],
          at: "a",
          edited: { sacty: "sacty の版" },
        },
      },
      testViewpoints: [view, { ...view, id: "v2" }],
    };
    const kinds = listDeliverables(t, []).map((d) => `${d.step}:${d.kind}`);
    expect(kinds).toContain("review:output");
    expect(kinds).toContain("review:review_comments");
    expect(kinds).toContain("requirements:sacty_version");
    expect(kinds).toContain("design:test_viewpoints");
    expect(readDeliverable(t, [], "review", "review_comments").text).toBe(
      "a.ts:3\nここを直す\n\nb.ts:9\nここも",
    );
    expect(readDeliverable(t, [], "requirements", "sacty_version").text).toBe("sacty の版");
    expect(JSON.parse(readDeliverable(t, [], "design", "test_viewpoints").text)).toHaveLength(2);
  });

  it("候補にあって本文が無い組は、none で空。候補に無い工程・種類は断る（継承されたプロパティを引かない）", () => {
    const t = {
      ...base(),
      approved: { requirements: { submission: 1, output: "x", testViewpoints: [], at: "a" } },
    };
    for (const [step, kind] of [
      ["design", "output"],
      ["requirements", "sacty_version"],
      ["implement", "review_comments"],
    ] as const) {
      expect(readDeliverable(t, [], step, kind)).toEqual({
        status: "none",
        submission: null,
        previousSubmission: null,
        text: "",
      });
    }
    expect(isDeliverableStep("constructor")).toBe(false);
    expect(isDeliverableStep("__proto__")).toBe(false);
    expect(isDeliverableKind("__proto__")).toBe(false);
    expect(isDeliverableStep("design")).toBe(true);
  });
});

describe("実行の一覧の元（PBI-395）", () => {
  it("画面と同じ規則で runId のある実行だけを新しい順に拾い、役割・エージェント・時刻は作業履歴から決める", () => {
    const activity = [
      ev(
        "AgentRunStarted",
        { runId: "r-step", step: "design", agentId: "claude" },
        "2026-01-01T00:00:01Z",
      ),
      ev("AgentRunCompleted", { runId: "r-step", step: "design", agentId: "claude" }),
      ev("AgentRunStarted", { step: "design", agentId: "claude" }), // runId が無い
      ev("StepsChosen", { runId: "r-orch" }, "2026-01-01T00:00:02Z"),
      ev("FinalReviewed", { runId: "r-guard", agentId: "codex" }),
      ev("ExportStarted", { runId: "r-export", step: "design" }),
      ev("AuditSurveyed", { runId: "r-audit" }),
      ev("AgentRunFailed", { runId: "r-bad", step: "implement", agentId: "claude" }),
      ev("TaskPaused", { runId: "ignored" }),
    ];
    const runs = runEntries(activity);
    expect(runs.map((r) => r.runId)).toEqual([
      "r-bad",
      "r-audit",
      "r-export",
      "r-guard",
      "r-orch",
      "r-step",
    ]);
    const by = Object.fromEntries(runs.map((r) => [r.runId, r]));
    expect(by["r-step"]).toMatchObject({
      role: "design",
      agentId: "claude",
      startedAt: "2026-01-01T00:00:01Z",
      historyState: "succeeded",
    });
    expect(by["r-bad"]?.historyState).toBe("failed");
    expect(by["r-orch"]).toMatchObject({
      role: "orchestrator",
      agentId: null,
      historyState: "unknown",
    });
    expect(by["r-guard"]?.role).toBe("guardian");
    expect(by["r-export"]?.role).toBe("export");
    expect(by["r-audit"]?.role).toBe("audit");
  });

  it("別のエージェントへの切り替えは、失敗した実行と代わりに動いた実行の両方に付く（工程・オーケストレーター）", () => {
    const activity = [
      ev("AgentRunStarted", { runId: "a1", step: "review", agentId: "claude" }),
      ev("AgentRunFailed", { runId: "a1", step: "review", agentId: "claude" }),
      ev("AgentFellBack", {
        runId: "a1",
        role: "review",
        agentId: "claude",
        fallbackAgentId: "codex",
        until: "u",
      }),
      ev("AgentRunStarted", { runId: "mid", step: "design", agentId: "codex" }),
      ev("AgentRunStarted", { runId: "a2", step: "review", agentId: "codex" }),
      ev("OrchestratorFailed", { runId: "o1", agentId: "claude" }),
      ev("AgentFellBack", {
        runId: "o1",
        role: "orchestrator",
        agentId: "claude",
        fallbackAgentId: "codex",
        until: "u",
      }),
      ev("StepsChosen", { runId: "o2", agentId: "codex" }),
      ev("StepsChosen", { runId: "o3", agentId: "codex" }),
    ];
    const pair = { from: "claude", to: "codex" };
    const by = Object.fromEntries(runEntries(activity).map((r) => [r.runId, r.fallback]));
    expect(by).toEqual({ a1: pair, a2: pair, mid: null, o1: pair, o2: pair, o3: null });
  });
});
