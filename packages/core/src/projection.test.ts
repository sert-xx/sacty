import { describe, expect, it } from "vitest";
import { budgetState, computeCostUsd } from "./cost.js";
import type { ActivityEvent, EventInput } from "./events.js";
import {
  bodyWithResumeNote,
  DERIVE_RECORD_HEADING,
  EventInput as EventSchema,
  exportSteps,
  MVP_STEPS,
  RERUN_NOTE_HEADING,
  RERUN_RECORD_HEADING,
  RESUME_NOTE_HEADING,
  RESUME_NOTE_MAX,
  rerunEditableBody,
  STEP_PLANS,
  TASK_BODY_MAX,
} from "./events.js";
import {
  applyEvent,
  awaitingGathering,
  awaitingRepository,
  awaitingTicketTriage,
  canDecideTests,
  canDerive,
  canOverrideVerification,
  canRechooseSteps,
  canRerun,
  canRetryExport,
  deliveredWithoutChanges,
  documentOutput,
  errorAnalysisBlocked,
  exportDue,
  gatePullRequest,
  isCompleted,
  isFinished,
  isRepoless,
  pendingErrorAnalysis,
  pendingQuestion,
  project,
  questionBlocked,
  resumeNoteRoom,
  reworkTargets,
  skippableSteps,
  stepRunning,
  type Task,
} from "./projection.js";

let seq = 0;
const ev = (taskId: string, input: EventInput, actor: ActivityEvent["actor"] = "sacty") =>
  ({
    ...EventSchema.parse(input),
    seq: ++seq,
    id: `e${seq}`,
    taskId,
    projectId: "default",
    actor,
    at: "2026-10-10T00:00:00.000Z",
  }) as ActivityEvent;

const created = (taskId: string, budgetCapUsd?: number) =>
  ev(
    taskId,
    {
      type: "TaskCreated",
      payload: { title: `title ${taskId}`, body: "body", start: "sacty", budgetCapUsd },
    },
    "person",
  );
const steps = (taskId: string) =>
  ev(taskId, { type: "StepsChosen", payload: { steps: [...MVP_STEPS] } });
const started = (taskId: string, runId: string) =>
  ev(taskId, {
    type: "AgentRunStarted",
    payload: { runId, step: "requirements", agentId: "a", authMode: "subscription" },
  });
const usage = { input: 1000, cacheRead: 0, cacheWrite: 0, output: 500 };

/** 実装を実行し、テストと最終レビューに通るまで（PBI-110。この後、実装の工程の中で PR を作る）。 */
const verifiedImplementation = (taskId: string, runId = "impl-1") => [
  ev(taskId, {
    type: "AgentRunStarted",
    payload: { runId, step: "implement", agentId: "a", authMode: "subscription" },
  }),
  ev(taskId, {
    type: "AgentRunCompleted",
    payload: {
      runId,
      step: "implement",
      agentId: "a",
      authMode: "subscription",
      usage,
      costUsd: 0,
      estimated: true,
      output: "# 実装",
    },
  }),
  ev(taskId, {
    type: "TestsRun",
    payload: {
      command: "npm test",
      exitCode: 0,
      unmappedViewpoints: [],
      passed: true,
      output: "",
      durationMs: 1,
    },
  }),
  ev(
    taskId,
    {
      type: "FinalReviewed",
      payload: { passed: true, viewpoints: [], remarks: [], summary: "ok", agentId: "g" },
    },
    "guardian",
  ),
];
const completed = (taskId: string, runId: string, costUsd: number) =>
  ev(taskId, {
    type: "AgentRunCompleted",
    payload: {
      runId,
      step: "requirements",
      agentId: "a",
      authMode: "subscription",
      usage,
      costUsd,
      estimated: true,
      output: "# 要求要件",
    },
  });

describe("project", () => {
  it("作業履歴からタスクの状態を復元する（最初の工程が実行対象になる）", () => {
    seq = 0;
    const task = project([created("t1"), steps("t1")]).get("t1");
    expect(task?.status).toBe("queued");
    expect(task?.steps.map((s) => [s.key, s.state])).toEqual([
      ["requirements", "active"],
      ["design", "todo"],
      ["implement", "todo"],
    ]);
    expect(task?.budget).toEqual({ usedUsd: 0, capUsd: 1, warned: false, estimated: false });
  });

  it("PBI-1の作業履歴（予算の項目なし）も既定の予算で読める", () => {
    seq = 0;
    expect(project([created("t1")]).get("t1")?.budget.capUsd).toBe(1);
  });

  it("実行の完了で費用を加算し、出力を記録して待機に戻る", () => {
    seq = 0;
    const task = project([
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      completed("t1", "r1", 0.3),
    ]).get("t1");
    expect(task?.status).toBe("idle");
    expect(task?.budget.usedUsd).toBe(0.3);
    expect(task?.budget.estimated).toBe(true);
    expect(task?.outputs.requirements).toBe("# 要求要件");
    expect(task?.currentRunId).toBeUndefined();
  });

  it("予算で止まり、新しい上限で再開すると待機に戻る", () => {
    seq = 0;
    const task = project([
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      completed("t1", "r1", 1.02),
      ev("t1", { type: "TaskPaused", payload: { reason: "budget" } }),
      ev("t1", { type: "BudgetCapRaised", payload: { capUsd: 3 } }, "person"),
      ev("t1", { type: "TaskResumed", payload: { retry: false } }, "person"),
    ]).get("t1");
    expect(task?.status).toBe("idle");
    expect(task?.budget.capUsd).toBe(3);
    expect(task?.pausedReason).toBeUndefined();
  });

  it("工程の組み合わせの予算（StepsChosen の budgetCapUsd）で上限を変え、80% の通知をし直す", () => {
    seq = 0;
    const tasks = project([
      created("t1"),
      ev("t1", { type: "BudgetWarned", payload: { usedUsd: 0.9, capUsd: 1 } }),
      ev("t1", {
        type: "StepsChosen",
        payload: { steps: [...MVP_STEPS], plan: "standard", budgetCapUsd: 5 },
      }),
    ]);
    expect(tasks.get("t1")?.budget).toMatchObject({ capUsd: 5, warned: false });
    // 持っていなければ、作ったときの上限のまま
    expect(project([created("t2", 2), steps("t2")]).get("t2")?.budget.capUsd).toBe(2);
  });

  it("人が上限を上げたら、上げたことを持つ", () => {
    seq = 0;
    const task = project([
      created("t1"),
      ev("t1", { type: "BudgetCapRaised", payload: { capUsd: 3 } }, "person"),
    ]).get("t1");
    expect(task?.budget).toMatchObject({ capUsd: 3, raised: true });
  });

  it("利用上限で失敗して止まり、再開するとやり直しのため実行待ちに戻る", () => {
    seq = 0;
    const untilPaused = [
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      ev("t1", {
        type: "AgentRunFailed",
        payload: {
          runId: "r1",
          step: "requirements",
          agentId: "a",
          reason: "usage_limit",
          message: "429",
        },
      }),
      ev("t1", { type: "TaskPaused", payload: { reason: "usage_limit" } }),
    ];
    const paused = project(untilPaused).get("t1");
    expect(paused?.status).toBe("paused");
    expect(paused?.pausedReason).toBe("usage_limit");

    const resumed = project([
      ...untilPaused,
      ev("t1", { type: "TaskResumed", payload: { retry: true } }, "person"),
    ]).get("t1");
    expect(resumed?.status).toBe("queued");
  });

  it("使用済み以下の上限への変更は受け付けない", () => {
    seq = 0;
    expect(() =>
      project([
        created("t1"),
        steps("t1"),
        started("t1", "r1"),
        completed("t1", "r1", 1.5),
        ev("t1", { type: "TaskPaused", payload: { reason: "budget" } }),
        ev("t1", { type: "BudgetCapRaised", payload: { capUsd: 1.5 } }),
      ]),
    ).toThrow(/must exceed/);
  });

  it("実行中でないタスクの実行完了や、一時停止中でないタスクの再開は受け付けない", () => {
    seq = 0;
    expect(() => project([created("t1"), steps("t1"), completed("t1", "r1", 0.1)])).toThrow(
      /run id/,
    );
    seq = 0;
    expect(() =>
      project([created("t1"), ev("t1", { type: "TaskResumed", payload: { retry: true } })]),
    ).toThrow(/status queued/);
  });

  it("承認済みの工程の実行完了は、凍結されているため受け付けない（PBI-8）", () => {
    seq = 0;
    const base = [
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      completed("t1", "r1", 0.1),
      ev("t1", { type: "StepSubmitted", payload: { step: "requirements", submission: 1 } }),
      ev(
        "t1",
        { type: "StepApproved", payload: { step: "requirements", next: "queued" } },
        "person",
      ),
    ];
    const task = project(base).get("t1");
    expect(task?.approved.requirements).toMatchObject({ submission: 1, output: "# 要求要件" });
    expect(() => project([...base, started("t1", "r2"), completed("t1", "r2", 0.1)])).toThrow(
      /frozen/,
    );
  });

  it("出典の分類は工程ごとに最新の提出のものを持ち、分類の無い再提出ではその工程の分類だけを消す", () => {
    seq = 0;
    const classified = (id: string) => ({
      sequential: false,
      items: [{ id, kind: "input" as const, refs: [], excerpt: "原文の抜き出し", found: true }],
      unclassified: [],
    });
    const run = (runId: string, step: "requirements" | "design", provenance?: unknown) => [
      ev("t1", {
        type: "AgentRunStarted",
        payload: { runId, step, agentId: "a", authMode: "subscription" },
      }),
      ev("t1", {
        type: "AgentRunCompleted",
        payload: {
          runId,
          step,
          agentId: "a",
          authMode: "subscription",
          usage,
          costUsd: 0,
          estimated: true,
          output: `# ${step}`,
          ...(provenance === undefined ? {} : { provenance }),
        },
      } as EventInput),
    ];
    const base = [
      created("t1"),
      steps("t1"),
      ...run("r1", "requirements", classified("R-1")),
      ev("t1", { type: "StepSubmitted", payload: { step: "requirements", submission: 1 } }),
      ev(
        "t1",
        { type: "StepApproved", payload: { step: "requirements", next: "queued" } },
        "person",
      ),
      ...run("r2", "design", classified("TV-1")),
      ev("t1", { type: "StepSubmitted", payload: { step: "design", submission: 1 } }),
      ev(
        "t1",
        {
          type: "ChangesRequested",
          payload: {
            step: "design",
            target: "design",
            round: 1,
            remarks: [{ id: "design-1-1", text: "x" }],
          },
        },
        "person",
      ),
    ];
    const task = project(base).get("t1");
    expect(task?.provenances).toEqual({
      requirements: classified("R-1"),
      design: classified("TV-1"),
    });
    // 分類の無い記録（分類より前の形）で出し直したら、設計の古い分類は残さず、要求要件の分類は残す
    const rerun = project([...base, ...run("r3", "design")]).get("t1");
    expect(rerun?.provenances).toEqual({ requirements: classified("R-1") });
    // 記録なし（null）で出し直したら、記録なしにする
    const missing = project([...base, ...run("r3", "design", null)]).get("t1");
    expect(missing?.provenances?.design).toBeNull();
  });

  it("PBI-7の作業履歴（差し戻し先なし）は、承認ゲートの工程への差し戻しとして読む", () => {
    seq = 0;
    const task = project([
      created("t1"),
      steps("t1"),
      started("t1", "r1"),
      completed("t1", "r1", 0.1),
      ev("t1", { type: "StepSubmitted", payload: { step: "requirements", submission: 1 } }),
      ev(
        "t1",
        {
          type: "ChangesRequested",
          payload: {
            step: "requirements",
            round: 1,
            remarks: [{ id: "requirements-1-1", text: "x" }],
          },
        },
        "person",
      ),
    ]).get("t1");
    expect(task?.remarks[0]?.step).toBe("requirements");
    expect(task?.steps[0]?.state).toBe("active");
    expect(task?.testViewpoints).toEqual([]);
  });

  it("認められた設計の変更は、承認済みの設計とテスト観点を置き換える（PBI-9）", () => {
    seq = 0;
    const run = (runId: string, step: "requirements" | "design", output: string) => [
      ev("t1", {
        type: "AgentRunStarted",
        payload: { runId, step, agentId: "a", authMode: "subscription" },
      }),
      ev("t1", {
        type: "AgentRunCompleted",
        payload: {
          runId,
          step,
          agentId: "a",
          authMode: "subscription",
          usage,
          costUsd: 0,
          estimated: true,
          output,
          testViewpoints:
            step === "design" ? [{ id: "TV-1", title: "旧", input: "i", expected: "e" }] : [],
        },
      }),
      ev("t1", { type: "StepSubmitted", payload: { step, submission: 1 } }),
      ev("t1", { type: "StepApproved", payload: { step, next: "queued" } }, "person"),
    ];
    const base = [
      created("t1"),
      steps("t1"),
      ...run("r1", "requirements", "# 要求要件"),
      ...run("r2", "design", "# 設計"),
      ...run("r3", "implement" as "design", "# 実装").slice(0, 2),
      ev("t1", {
        type: "ChangeProposed",
        payload: {
          proposalId: "CP-1",
          fromStep: "implement",
          target: "design",
          reason: "r",
          facts: ["f"],
          proposed: "# 設計 v2",
          testViewpoints: [{ id: "TV-1", title: "新", input: "i", expected: "e" }],
        },
      }),
    ];
    const judged = ev("t1", {
      type: "ChangeJudged",
      payload: { proposalId: "CP-1", verdict: "approved", reason: "ok", agentId: "g" },
    });
    const applied = ev("t1", { type: "ChangeApplied", payload: { proposalId: "CP-1" } });
    const task = project([...base, judged, applied]).get("t1");
    expect(task?.approved.design).toMatchObject({
      submission: 1,
      output: "# 設計 v2",
      testViewpoints: [{ title: "新" }],
    });
    expect(task?.approved.requirements?.output).toBe("# 要求要件");
    expect(task?.steps.map((s) => s.state)).toEqual(["done", "done", "active"]);
    // 判定の前や、却下された申し出は反映できない
    expect(() => project([...base, applied])).toThrow(/not accepted/);
  });

  it("中止したタスクには、以降のイベントを受け付けない（PBI-3）", () => {
    const cancel = () => ev("t1", { type: "TaskCancelled", payload: { cleanup: [] } }, "person");
    seq = 0;
    const task = project([created("t1"), steps("t1"), cancel()]).get("t1");
    expect(task?.status).toBe("cancelled");
    seq = 0;
    expect(() => project([created("t1"), steps("t1"), cancel(), started("t1", "r1")])).toThrow(
      /cancelled/,
    );
    // 実行中のまま中止は記録できない（先にコンテナを止める）
    seq = 0;
    expect(() => project([created("t1"), steps("t1"), started("t1", "r1"), cancel()])).toThrow(
      /stop the run/,
    );
  });

  it("写したエージェントのファイルの記録は、中止の後にも受け付け、状態は変えない（PBI-66）", () => {
    const cancel = () => ev("t1", { type: "TaskCancelled", payload: { cleanup: [] } }, "person");
    const archived = () =>
      ev("t1", {
        type: "AgentSessionArchived",
        payload: {
          runId: "r1",
          role: "requirements",
          agentId: "a",
          runtime: "claude-code",
          sessionId: "s1",
          files: [
            {
              path: "projects/-workspace/s1.jsonl",
              bytes: 3,
              sha256: "a".repeat(64),
              sourceBytes: 3,
            },
          ],
          limitBytes: 1024,
        },
      });
    seq = 0;
    const before = project([created("t1"), steps("t1"), cancel()]).get("t1");
    seq = 0;
    const after = project([created("t1"), steps("t1"), cancel(), archived()]).get("t1");
    expect(after).toEqual(before);
    expect(after?.status).toBe("cancelled");
    // 中止の後は、ほかのイベントはこれまでどおり受け付けない
    seq = 0;
    expect(() =>
      project([created("t1"), steps("t1"), cancel(), archived(), started("t1", "r2")]),
    ).toThrow(/cancelled/);
    // 中止していないタスクでも、記録だけ（工程の状態は変えない）
    seq = 0;
    const running = project([created("t1"), steps("t1"), archived()]).get("t1");
    expect(running?.steps.map((s) => s.state)).toEqual(["active", "todo", "todo"]);
    // ハッシュの形でない値は受け付けない
    expect(() =>
      EventSchema.parse({
        type: "AgentSessionArchived",
        payload: {
          ...archived().payload,
          files: [{ path: "x", bytes: 1, sha256: "zz", sourceBytes: 1 }],
        },
      }),
    ).toThrow();
  });

  it("オーケストレーターのセッションの記録から、使った回数・新しく始めた理由を作る（PBI-67）", () => {
    const used = (payload: Record<string, unknown>) =>
      ev("t1", {
        type: "OrchestratorSessionUsed",
        payload: {
          runId: `r${seq}`,
          role: "orchestrator",
          agentId: "a",
          runtime: "claude-code",
          ...payload,
        } as never,
      });
    seq = 0;
    const tasks = project([
      created("t1"),
      used({ mode: "new", reason: "first", sessionId: "s1", saved: true }),
      used({ mode: "resumed", resumedFrom: "s1", sessionId: "s1", saved: true }),
      // 質問への答え（複製）は、元のセッションを変えない
      used({ role: "chat", mode: "forked", resumedFrom: "s1", sessionId: "f1" }),
      used({
        mode: "resumed",
        resumedFrom: "s1",
        sessionId: "s1",
        saved: false,
        notSaved: "not_archived",
      }),
    ]);
    expect(tasks.get("t1")?.orchestratorSession).toMatchObject({
      agentId: "a",
      runtime: "claude-code",
      sessionId: "s1",
      uses: 3,
      reason: "first",
      saved: false,
    });
    // 新しく始めたら、回数と理由を改める
    seq = 0;
    const changed = project([
      created("t1"),
      used({ mode: "new", reason: "first", sessionId: "s1", saved: true }),
      used({
        agentId: "b",
        runtime: "codex",
        mode: "new",
        reason: "agent_changed",
        sessionId: "s2",
        saved: true,
      }),
    ]).get("t1")?.orchestratorSession;
    expect(changed).toMatchObject({
      agentId: "b",
      runtime: "codex",
      sessionId: "s2",
      uses: 1,
      reason: "agent_changed",
    });
    // 中止の後にも受け付け、状態は変えない
    const cancel = () => ev("t1", { type: "TaskCancelled", payload: { cleanup: [] } }, "person");
    seq = 0;
    const before = project([created("t1"), cancel()]).get("t1");
    seq = 0;
    const after = project([created("t1"), cancel(), used({ mode: "new", reason: "first" })]).get(
      "t1",
    );
    expect(after).toEqual(before);
    // 知らない理由・形は受け付けない
    expect(() =>
      EventSchema.parse({
        type: "OrchestratorSessionUsed",
        payload: {
          runId: "r",
          role: "orchestrator",
          agentId: "a",
          runtime: "claude-code",
          mode: "new",
          reason: "x",
        },
      }),
    ).toThrow();
    expect(() =>
      EventSchema.parse({
        type: "OrchestratorSessionUsed",
        payload: {
          runId: "r",
          role: "guardian",
          agentId: "a",
          runtime: "claude-code",
          mode: "new",
        },
      }),
    ).toThrow();
  });

  it("同じ作業履歴から何度復元しても同じ状態になる", () => {
    seq = 0;
    const events = [created("t1"), steps("t1"), started("t1", "r1"), completed("t1", "r1", 0.2)];
    expect(project(events)).toEqual(project(events));
  });

  it("順序が崩れた作業履歴・二重作成・存在しないタスクは受け付けない", () => {
    seq = 0;
    const first = created("t1");
    const second = created("t2");
    expect(() => project([second, first])).toThrow(/out of order/);
    seq = 0;
    expect(() => project([created("t1"), created("t1")])).toThrow(/created twice/);
    seq = 0;
    expect(() => project([steps("nope")])).toThrow(/unknown task/);
  });
});

describe("費用と予算", () => {
  const price = { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 };

  it("区分ごとの単価で費用を計算する", () => {
    expect(
      computeCostUsd(
        { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 100_000 },
        price,
      ),
    ).toBeCloseTo(3 + 0.3 + 1.5, 6);
    expect(
      computeCostUsd({ input: 0, cacheRead: 0, cacheWrite: 2_000_000, output: 0 }, price),
    ).toBe(7.5);
  });

  it("80%で通知、上限で超過と判定する（通知済みなら再通知しない）", () => {
    expect(budgetState({ usedUsd: 0.79, capUsd: 1, warned: false, estimated: false })).toBe("ok");
    expect(budgetState({ usedUsd: 0.8, capUsd: 1, warned: false, estimated: false })).toBe("warn");
    expect(budgetState({ usedUsd: 0.9, capUsd: 1, warned: true, estimated: false })).toBe("ok");
    expect(budgetState({ usedUsd: 1, capUsd: 1, warned: true, estimated: false })).toBe("exceeded");
  });
});

describe("金額の表示", () => {
  it("$1未満は小数第4位まで、$1以上は小数第2位まで出す", async () => {
    const { formatUsd } = await import("./cost.js");
    expect(formatUsd(0.0105)).toBe("$0.0105");
    expect(formatUsd(0)).toBe("$0.0000");
    expect(formatUsd(1)).toBe("$1.00");
    expect(formatUsd(12.345)).toBe("$12.35");
  });
});

describe("作業履歴の文（PBI-11b）", () => {
  it("古い作業履歴の日本語の文も、コードと引数の文言も読める", () => {
    const old = project([
      created("t1"),
      steps("t1"),
      ev("t1", { type: "TaskPaused", payload: { reason: "error", message: "古い文です。" } }),
    ]).get("t1");
    expect(old?.pausedMessage).toBe("古い文です。");
    const coded = project([
      created("t2"),
      steps("t2"),
      ev("t2", {
        type: "TaskPaused",
        payload: { reason: "error", message: { code: "verify.workspaceMissing" } },
      }),
    ]).get("t2");
    expect(coded?.pausedMessage).toEqual({ code: "verify.workspaceMissing" });
    // コードと引数の文言は、決めた形（code と params）だけを受け付ける
    expect(() =>
      EventSchema.parse({
        type: "TaskPaused",
        payload: { reason: "error", message: { text: "x" } },
      }),
    ).toThrow();
  });
});

describe("実装の承認待ちの間の PR の状態（PBI-14a）", () => {
  it("承認待ちで見守っている、そのタスクの PR の状態だけを記録する", () => {
    expect(() =>
      project([
        created("t9"),
        steps("t9"),
        ev("t9", { type: "PullRequestMerged", payload: { number: 7 } }),
      ]),
    ).toThrow(/deliverable review is not open/);
  });
});

describe("人が PR の中で直してからマージした（PBI-63）", () => {
  it("前の版の作業履歴（outdated・edited の無い PullRequestMerged）も読める", () => {
    const parsed = EventSchema.parse({
      type: "PullRequestMerged",
      payload: { number: 7, commit: "f".repeat(40), outdated: true },
    });
    expect(parsed.payload).toEqual({
      number: 7,
      commit: "f".repeat(40),
      outdated: true,
      edited: false,
    });
  });

  it("成果のファイルから、sacty の目印の行だけを除いて承認済みの成果にする", () => {
    expect(
      documentOutput("<!-- sacty task t1 の要求要件。sacty が作成しました。 -->\n\n# 要求\n"),
    ).toBe("# 要求");
    expect(documentOutput("<!-- sacty task t1 の設計。 -->\r\n\r\n# 設計\r\n")).toBe("# 設計");
    // 人が目印の行を消した・途中にあるなら、そのまま
    expect(documentOutput("# 要求\n<!-- sacty task t1 -->\n")).toBe(
      "# 要求\n<!-- sacty task t1 -->",
    );
    expect(documentOutput("<!-- 人のコメント -->\n# 要求")).toBe("<!-- 人のコメント -->\n# 要求");
  });
});

describe("PR のレビューの取り込み（PBI-14b）", () => {
  it("承認待ちの PR が無ければ取り込まない", () => {
    expect(() =>
      project([
        created("t8"),
        steps("t8"),
        ev("t8", {
          type: "PullRequestReviewImported",
          payload: {
            number: 7,
            items: [{ key: "comment:1", author: "a", at: "2026-10-11T00:00:00Z" }],
            remarks: ["x"],
          },
        }),
      ]),
    ).toThrow(/deliverable review is not open/);
  });
});

describe("レビューの工程（PBI-19）", () => {
  const target = {
    repo: "https://github.com/acme/app",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    title: "再試行",
    headCommit: "h".repeat(40),
    baseCommit: "b".repeat(40),
  };
  const run = (taskId: string) => [
    created(taskId),
    ev(taskId, { type: "StepsChosen", payload: { steps: ["review"] } }),
    ev(taskId, { type: "ReviewTargetResolved", payload: target }),
    ev(taskId, {
      type: "AgentRunStarted",
      payload: { runId: "r1", step: "review", agentId: "a", authMode: "subscription" },
    }),
    ev(taskId, {
      type: "AgentRunCompleted",
      payload: {
        runId: "r1",
        step: "review",
        agentId: "a",
        authMode: "subscription",
        usage,
        costUsd: 0,
        estimated: false,
        output: "# 評価",
      },
    }),
  ];

  it("レビューを投稿すると、承認ゲートを通らずに完了する", () => {
    const task = project([
      ...run("t1"),
      ev("t1", { type: "PullRequestReviewPosted", payload: { url: "https://x/pull/12#r" } }),
    ]).get("t1");
    // 作者を読めなかった前の記録は空（PBI-111）
    expect(task?.reviewTarget).toMatchObject({ number: 12, body: "", author: "" });
    expect(task?.steps).toEqual([{ key: "review", state: "done" }]);
    expect(task?.reviewPost).toEqual({ url: "https://x/pull/12#r", at: task?.updatedAt });
    expect(task?.gate).toBeUndefined();
    expect(task?.approved.review).toBeUndefined();
  });

  it("判定を回ごとに残し、再レビューでは前回の指摘と投稿を前回のレビューとして残す（PBI-111）", () => {
    const events = run("t7");
    const completed = events[4] as Extract<ActivityEvent, { type: "AgentRunCompleted" }>;
    completed.payload = {
      ...completed.payload,
      reviewComments: [{ path: "src/retry.ts", line: 2, body: "[要修正] 上限が無い" }],
      reviewVerdict: "changes_required",
    };
    const posted = ev("t7", {
      type: "PullRequestReviewPosted",
      payload: { url: "https://x/pull/12#r1", latestCommit: "n".repeat(40) },
    });
    const first = project([...events, posted]).get("t7");
    expect(first?.reviewVerdicts).toEqual([{ round: 1, verdict: "changes_required" }]);
    expect(first?.reviewPost).toMatchObject({ latestCommit: "n".repeat(40) });
    const restarted = project([
      ...events,
      posted,
      ev("t7", { type: "ReviewRestarted", payload: {} }, "person"),
    ]).get("t7");
    expect(restarted?.previousReview).toEqual({
      round: 1,
      url: "https://x/pull/12#r1",
      at: first?.reviewPost?.at,
      headCommit: "h".repeat(40),
      body: "# 評価",
      comments: [{ path: "src/retry.ts", line: 2, body: "[要修正] 上限が無い" }],
    });
    expect(restarted?.reviewRound).toBe(2);
    expect(restarted?.reviewPost).toBeUndefined();
    expect(restarted?.reviewComments).toEqual([]);
    expect(restarted?.reviewVerdicts).toEqual([{ round: 1, verdict: "changes_required" }]);
  });

  it("本文が空のレビュー（行へのコメントだけ）も、投稿すると完了する（レビュー指摘）", () => {
    const events = run("t6");
    const completed = events[4] as Extract<ActivityEvent, { type: "AgentRunCompleted" }>;
    completed.payload = {
      ...completed.payload,
      output: "",
      reviewComments: [{ path: "src/retry.ts", line: 2, body: "上限が無い" }],
    };
    const task = project([
      ...events,
      ev("t6", { type: "PullRequestReviewPosted", payload: { url: "u" } }),
    ]).get("t6");
    expect(task?.steps).toEqual([{ key: "review", state: "done" }]);
    expect(task?.reviewComments).toHaveLength(1);
  });

  it("レビューを書く前・二度目の投稿・二度目の対象の記録は、作業履歴の不整合にする", () => {
    const before = run("t2").slice(0, 3);
    const posted = ev("t2", { type: "PullRequestReviewPosted", payload: { url: "u" } });
    expect(() => project([...before, posted])).toThrow(/no review is waiting/);
    expect(() =>
      project([
        ...run("t3"),
        ev("t3", { type: "PullRequestReviewPosted", payload: { url: "u" } }),
        ev("t3", { type: "PullRequestReviewPosted", payload: { url: "u" } }),
      ]),
    ).toThrow();
    expect(() =>
      project([
        ...run("t4").slice(0, 3),
        ev("t4", { type: "ReviewTargetResolved", payload: target }),
      ]),
    ).toThrow(/already resolved/);
    // レビューの工程が無いタスクには、対象を記録できない
    expect(() =>
      project([
        created("t5"),
        steps("t5"),
        ev("t5", { type: "ReviewTargetResolved", payload: target }),
      ]),
    ).toThrow(/not active/);
  });
});

describe("オーケストレーターへの質問（PBI-54）", () => {
  const asked = (taskId: string, questionId: string) =>
    ev(taskId, { type: "QuestionAsked", payload: { questionId, text: "いまどこ？" } }, "person");
  const answered = (taskId: string, questionId: string, costUsd: number) =>
    ev(
      taskId,
      {
        type: "QuestionAnswered",
        payload: { questionId, answer: "設計です", runResult: "completed", agentId: "o", costUsd },
      },
      "orchestrator",
    );

  it("質問と答えを残し、費用を予算に入れる。状態・工程は変えない（実行中でも受け付ける）", () => {
    seq = 0;
    const base = [created("t1"), steps("t1"), started("t1", "r1")];
    const before = project(base).get("t1");
    const task = project([
      ...base,
      asked("t1", "Q-1"),
      answered("t1", "Q-1", 0.25),
      asked("t1", "Q-2"),
    ]).get("t1");
    expect(task?.questions.map((q) => [q.id, q.answer?.text])).toEqual([
      ["Q-1", "設計です"],
      ["Q-2", undefined],
    ]);
    expect(task && pendingQuestion(task)?.id).toBe("Q-2");
    expect(task?.status).toBe("running");
    expect(task?.currentRunId).toBe("r1");
    expect(task?.steps).toEqual(before?.steps);
    expect(task?.budget.usedUsd).toBe(0.25);
  });

  it("答えを待つ質問は1件まで。答えの無い質問への答え・同じ ID の質問は受け付けない", () => {
    seq = 0;
    expect(() => project([created("t1"), asked("t1", "Q-1"), asked("t1", "Q-2")])).toThrow(
      /a question is pending/,
    );
    seq = 0;
    expect(() => project([created("t1"), answered("t1", "Q-1", 0)])).toThrow(
      /not waiting for an answer/,
    );
    seq = 0;
    expect(() =>
      project([
        created("t1"),
        asked("t1", "Q-1"),
        answered("t1", "Q-1", 0),
        answered("t1", "Q-1", 0),
      ]),
    ).toThrow(/not waiting for an answer/);
    seq = 0;
    expect(() =>
      project([created("t1"), asked("t1", "Q-1"), answered("t1", "Q-1", 0), asked("t1", "Q-1")]),
    ).toThrow(/used twice/);
  });

  it("質問できない理由：中止・答えを待っている・予算の上限（ちょうどを含む）", () => {
    seq = 0;
    const capped = (used: number) =>
      project([
        created("t1", 0.5),
        steps("t1"),
        started("t1", "r1"),
        completed("t1", "r1", used),
      ]).get("t1");
    const exactly = capped(0.5);
    expect(exactly && questionBlocked(exactly)).toEqual({
      code: "chat.budgetExceeded",
      params: { usedUsd: 0.5, capUsd: 0.5 },
    });
    seq = 0;
    const below = capped(0.499999);
    expect(below && questionBlocked(below)).toBeUndefined();
    seq = 0;
    const pending = project([created("t1"), asked("t1", "Q-1")]).get("t1");
    expect(pending && questionBlocked(pending)).toEqual({ code: "chat.answering" });
    seq = 0;
    const cancelled = project([
      created("t1"),
      ev("t1", { type: "TaskCancelled", payload: { cleanup: [] } }, "person"),
    ]).get("t1");
    expect(cancelled && questionBlocked(cancelled)).toEqual({ code: "task.cancelled" });
  });
});

describe("エラーレポートのためのエラーの分析", () => {
  const requested = (taskId: string, analysisId: string) =>
    ev(taskId, { type: "ErrorAnalysisRequested", payload: { analysisId } }, "person");
  const analyzed = (taskId: string, analysisId: string, costUsd: number) =>
    ev(
      taskId,
      {
        type: "ErrorAnalyzed",
        payload: {
          analysisId,
          analysis: "認証の期限切れ",
          runResult: "completed",
          agentId: "o",
          runId: "a1",
          costUsd,
        },
      },
      "orchestrator",
    );

  it("分析を残し、費用を予算に入れる。状態・工程は変えない（実行中でも受け付ける）", () => {
    seq = 0;
    const base = [created("t1"), steps("t1"), started("t1", "r1")];
    const before = project(base).get("t1");
    const task = project([
      ...base,
      requested("t1", "A-1"),
      analyzed("t1", "A-1", 0.25),
      requested("t1", "A-2"),
    ]).get("t1");
    expect(task?.errorAnalyses.map((a) => [a.id, a.result?.text, a.result?.runId])).toEqual([
      ["A-1", "認証の期限切れ", "a1"],
      ["A-2", undefined, undefined],
    ]);
    expect(task && pendingErrorAnalysis(task)?.id).toBe("A-2");
    expect(task?.status).toBe("running");
    expect(task?.steps).toEqual(before?.steps);
    expect(task?.budget.usedUsd).toBe(0.25);
  });

  it("待っている求めは1件まで。求めの無い分析・同じ ID の求めは受け付けない", () => {
    seq = 0;
    expect(() => project([created("t1"), requested("t1", "A-1"), requested("t1", "A-2")])).toThrow(
      /an error analysis is pending/,
    );
    seq = 0;
    expect(() => project([created("t1"), analyzed("t1", "A-1", 0)])).toThrow(/not pending/);
    seq = 0;
    expect(() =>
      project([
        created("t1"),
        requested("t1", "A-1"),
        analyzed("t1", "A-1", 0),
        requested("t1", "A-1"),
      ]),
    ).toThrow(/used twice/);
  });

  it("分析させられない理由：中止・分析を待っている・予算の上限", () => {
    seq = 0;
    const capped = project([
      created("t1", 0.5),
      steps("t1"),
      started("t1", "r1"),
      completed("t1", "r1", 0.5),
    ]).get("t1");
    expect(capped && errorAnalysisBlocked(capped)).toEqual({
      code: "errorReport.budgetExceeded",
      params: { usedUsd: 0.5, capUsd: 0.5 },
    });
    seq = 0;
    const pending = project([created("t1"), requested("t1", "A-1")]).get("t1");
    expect(pending && errorAnalysisBlocked(pending)).toEqual({ code: "errorReport.analyzing" });
    seq = 0;
    const cancelled = project([
      created("t1"),
      ev("t1", { type: "TaskCancelled", payload: { cleanup: [] } }, "person"),
    ]).get("t1");
    expect(cancelled && errorAnalysisBlocked(cancelled)).toEqual({ code: "task.cancelled" });
    seq = 0;
    const fresh = project([created("t1")]).get("t1");
    expect(fresh && errorAnalysisBlocked(fresh)).toBeUndefined();
  });
});

describe("成果の書き出し（PBI-56）", () => {
  const chosen = (taskId: string) =>
    ev(
      taskId,
      {
        type: "StepsChosen",
        payload: {
          steps: [...MVP_STEPS],
          exports: {
            requirements: {
              to: { via: "platform", name: "confluence", location: "DEV" },
              reason: "規約",
            },
            design: { reason: "書き出さない" },
          },
        },
      },
      "orchestrator",
    );
  const approvedAt = "2026-10-10T00:00:00.000Z";
  const approved = (taskId: string) => [
    started(taskId, "r1"),
    completed(taskId, "r1", 0),
    ev(taskId, { type: "StepSubmitted", payload: { step: "requirements", submission: 1 } }),
    ev(
      taskId,
      { type: "StepApproved", payload: { step: "requirements", next: "queued" } },
      "person",
    ),
  ];
  const exportStarted = (taskId: string, runId: string, at = approvedAt) =>
    ev(taskId, { type: "ExportStarted", payload: { step: "requirements", runId, approvedAt: at } });
  const exported = (
    taskId: string,
    runId: string,
    result: { url?: string; failed?: string; runResult: "completed" | "failed" | "interrupted" },
    costUsd = 0.1,
  ) =>
    ev(
      taskId,
      {
        type: "OutputExported",
        payload: {
          step: "requirements",
          runId,
          approvedAt,
          submission: 1,
          via: "platform",
          name: "confluence",
          agentId: "a",
          costUsd,
          ...result,
        },
      },
      "agent",
    );
  const retried = (taskId: string) =>
    ev(taskId, { type: "ExportRequested", payload: { step: "requirements" } }, "person");

  it("書き出せる工程は、要求要件・設計と、調査だけのときの調査", () => {
    expect(exportSteps(MVP_STEPS)).toEqual(["requirements", "design"]);
    expect(exportSteps(["investigate", "requirements", "design", "implement"])).toEqual([
      "requirements",
      "design",
    ]);
    expect(exportSteps(["investigate"])).toEqual(["investigate"]);
    expect(exportSteps(["review"])).toEqual([]);
  });

  it("決めた書き出し先を持ち、承認した版だけを書き出し待ちにする。状態・工程は変えない", () => {
    seq = 0;
    const before = project([created("t1"), chosen("t1"), ...approved("t1").slice(0, 3)]).get("t1");
    expect(before?.exportPlans?.design).toEqual({ reason: "書き出さない" });
    expect(before && exportDue(before)).toBeUndefined();
    seq = 0;
    const base = [created("t1"), chosen("t1"), ...approved("t1")];
    const due = project(base).get("t1");
    expect(due && exportDue(due)).toBe("requirements");
    const exporting = project([...base, exportStarted("t1", "x1")]).get("t1");
    expect(exporting?.status).toBe(due?.status);
    expect(exporting?.steps).toEqual(due?.steps);
    expect(exporting?.exports.requirements?.started?.runId).toBe("x1");
  });

  it("中断した書き出しは、始めた記録を残して書き出し待ちのまま。費用は予算に入れる", () => {
    seq = 0;
    const task = project([
      created("t1"),
      chosen("t1"),
      ...approved("t1"),
      exportStarted("t1", "x1"),
      exported("t1", "x1", { failed: "止めた", runResult: "interrupted" }, 0.2),
    ]).get("t1");
    expect(task?.exports.requirements?.started?.runId).toBe("x1");
    expect(task?.exports.requirements?.last).toBeUndefined();
    expect(task && exportDue(task)).toBe("requirements");
    expect(task?.budget.usedUsd).toBe(0.2);
  });

  it("書き出せなかったら理由を残し、書き出し直しを求めると書き出し待ちに戻る。書き出せたら URL を残す", () => {
    seq = 0;
    const base = [
      created("t1"),
      chosen("t1"),
      ...approved("t1"),
      exportStarted("t1", "x1"),
      exported("t1", "x1", { failed: "権限が無い", runResult: "completed" }),
    ];
    const failed = project(base).get("t1");
    expect(failed?.exports.requirements?.last?.failed).toBe("権限が無い");
    expect(failed?.exports.requirements?.started).toBeUndefined();
    expect(failed && exportDue(failed)).toBeUndefined();
    expect(failed && canRetryExport(failed, "requirements")).toBe(true);
    expect(failed && canRetryExport(failed, "design")).toBe(false);
    const retry = project([...base, retried("t1")]).get("t1");
    expect(retry && exportDue(retry)).toBe("requirements");
    expect(retry && canRetryExport(retry, "requirements")).toBe(false);
    const done = project([
      ...base,
      retried("t1"),
      exportStarted("t1", "x2"),
      exported("t1", "x2", { url: "https://wiki/1", runResult: "completed" }),
      // 後の書き出しに失敗しても、前に書き出した先は残す（承認し直したら、ここを更新する）
      exported("t1", "x3", { failed: "落ちた", runResult: "failed" }),
    ]).get("t1");
    expect(done?.exports.requirements?.url).toBe("https://wiki/1");
    expect(done?.exports.requirements?.last?.failed).toBe("落ちた");
    expect(done?.exports.requirements?.retry).toBeUndefined();
    expect(done?.budget.usedUsd).toBeCloseTo(0.3, 6);
  });

  it("承認していない版・書き出し先の無い工程の書き出しの開始、書き出せたものの書き出し直しは受け付けない", () => {
    seq = 0;
    expect(() => project([created("t1"), chosen("t1"), exportStarted("t1", "x1")])).toThrow(
      /not waiting to be exported/,
    );
    seq = 0;
    expect(() =>
      project([
        created("t1"),
        chosen("t1"),
        ...approved("t1"),
        exportStarted("t1", "x1", "2026-01-01T00:00:00.000Z"),
      ]),
    ).toThrow(/not waiting to be exported/);
    seq = 0;
    expect(() =>
      project([
        created("t1"),
        chosen("t1"),
        ...approved("t1"),
        exported("t1", "x1", { url: "https://wiki/1", runResult: "completed" }),
        retried("t1"),
      ]),
    ).toThrow(/cannot be retried/);
    seq = 0;
    const cancelled = project([
      created("t1"),
      chosen("t1"),
      ...approved("t1"),
      ev("t1", { type: "TaskCancelled", payload: { cleanup: [] } }, "person"),
    ]).get("t1");
    expect(cancelled && exportDue(cancelled)).toBeUndefined();
  });
});

describe("リポジトリを指定しないタスク（PBI-73）", () => {
  const noRepo = (taskId: string) =>
    ev(
      taskId,
      {
        type: "TaskCreated",
        payload: { title: "t", body: "", start: "sacty", noRepo: true, budgetCapUsd: 1 },
      },
      "person",
    );
  const chosen = (taskId: string, actor: ActivityEvent["actor"] = "orchestrator") =>
    ev(
      taskId,
      {
        type: "RepositoryChosen",
        payload: { repo: "https://github.com/acme/api", reason: "API", costUsd: 0.5 },
      },
      actor,
    );

  it("リポジトリを決めるまではリポジトリの無いタスク。決めたら、費用と理由を残してふつうのタスクになる", () => {
    seq = 0;
    const before = project([noRepo("a")]).get("a");
    expect(before && isRepoless(before)).toBe(true);
    expect(before && awaitingRepository(before)).toBe(true);
    const after = project([noRepo("a"), chosen("a")]).get("a");
    expect(after).toMatchObject({
      repo: "https://github.com/acme/api",
      noRepo: true,
      repoChoice: { reason: "API", by: "orchestrator" },
      budget: { usedUsd: 0.5 },
    });
    expect(after && isRepoless(after)).toBe(false);
    expect(project([noRepo("b"), chosen("b", "person")]).get("b")?.repoChoice?.by).toBe("person");
  });

  it("対象リポジトリを選ぶ前の版のタスク・リポジトリのあるタスク・工程を決めた後は、リポジトリを決められない", () => {
    seq = 0;
    // noRepo の無い、対象リポジトリを選ぶ前の版のタスクは、リポジトリの無いタスクとして扱わない
    const old = project([created("old")]).get("old");
    expect(old && isRepoless(old)).toBe(false);
    expect(() => project([created("old"), chosen("old")])).toThrow(/before planning/);
    // 用意する前なら選び直せる（用意できなかったとき）。用意した後は選べない
    expect(
      project([noRepo("c"), chosen("c"), chosen("c", "person")]).get("c")?.repoChoice?.by,
    ).toBe("person");
    const prepared = () =>
      ev("e", {
        type: "RepositoryPrepared",
        payload: { url: "https://github.com/acme/api.git", baseBranch: "main", baseCommit: "abc" },
      });
    expect(() => project([noRepo("e"), chosen("e"), prepared(), chosen("e")])).toThrow(
      /before planning/,
    );
    expect(() => project([noRepo("d"), steps("d"), chosen("d")])).toThrow(/before planning/);
  });
});

describe("マージの後の監視（PBI-89）", () => {
  const prGate = (id: string) => [
    created(id),
    ev(id, { type: "StepsChosen", payload: { steps: ["implement"], testCommand: "npm test" } }),
    ev(id, {
      type: "RepositoryPrepared",
      payload: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "b1" },
    }),
    ...verifiedImplementation(id),
    ev(id, {
      type: "PullRequestPublished",
      payload: {
        branch: "sacty/t",
        commit: "c1",
        url: "https://github.com/acme/app/pull/7",
        number: 7,
      },
    }),
    ev(id, { type: "StepSubmitted", payload: { step: "implement", submission: 1 } }),
  ];
  const mergedPr = (id: string) => [
    ev(id, { type: "PullRequestMerged", payload: { number: 7, commit: "c1" } }, "person"),
    ev(id, { type: "StepApproved", payload: { step: "implement", next: "idle" } }, "person"),
  ];
  const started = (id: string) =>
    ev(id, {
      type: "DeploymentWatchStarted",
      payload: { number: 7, repo: "https://github.com/acme/app", branch: "main", commit: "m1" },
    });

  it("マージの前・二度目の開始・待っていない段階の記録は受け付けない", () => {
    seq = 0;
    expect(() => project([...prGate("t"), started("t")])).toThrow(/not merged/);
    seq = 0;
    expect(() => project([...prGate("t"), ...mergedPr("t"), started("t"), started("t")])).toThrow(
      /has started/,
    );
    seq = 0;
    expect(() =>
      project([
        ...prGate("t"),
        ...mergedPr("t"),
        started("t"),
        ev("t", { type: "DeploymentCheckStarted", payload: { runId: "r", skill: "s" } }),
      ]),
    ).toThrow(/not waiting for the check/);
    seq = 0;
    expect(() =>
      project([
        ...prGate("t"),
        ...mergedPr("t"),
        started("t"),
        ev("t", {
          type: "DeploymentFixSuppressed",
          payload: { kind: "ci", fingerprint: "f", reason: "duplicate" },
        }),
      ]),
    ).toThrow(/waiting for a fix task/);
  });

  it("CI/CD が通ってスキルがあれば確認を待ち、結果で状態を決める。実行の ID が違う結果は受け付けない", () => {
    seq = 0;
    const base = [
      ...prGate("t"),
      ...mergedPr("t"),
      started("t"),
      ev("t", { type: "DeploymentCiFinished", payload: { result: "passed", skill: "s" } }),
    ];
    const waiting = project(base).get("t");
    expect(waiting?.deployment).toMatchObject({ state: "waiting", phase: "check" });
    expect(waiting?.status).toBe("idle");
    const checking = [
      ...base,
      ev("t", { type: "DeploymentCheckStarted", payload: { runId: "r1", skill: "s" } }),
    ];
    expect(() =>
      project([
        ...checking,
        ev("t", {
          type: "DeploymentChecked",
          payload: { result: "healthy", runResult: "completed", agentId: "a", runId: "other" },
        }),
      ]),
    ).toThrow(/not running/);
    const done = project([
      ...checking,
      ev("t", {
        type: "DeploymentChecked",
        payload: {
          result: "unhealthy",
          runResult: "completed",
          agentId: "a",
          runId: "r1",
          costUsd: 0.5,
        },
      }),
    ]).get("t");
    expect(done?.deployment).toMatchObject({ state: "failed", check: { result: "unhealthy" } });
    expect(done?.budget.usedUsd).toBe(0.5);
  });
});

describe("テストの仕組みが無いタスクの検証（PBI-94）", () => {
  const implemented = (taskId: string, noTestsReason?: string, testCommand?: string) => [
    created(taskId),
    ev(taskId, {
      type: "StepsChosen",
      payload: {
        steps: ["implement"],
        ...(noTestsReason ? { noTestsReason } : {}),
        ...(testCommand ? { testCommand } : {}),
      },
    }),
    ev(taskId, {
      type: "AgentRunStarted",
      payload: { runId: "r1", step: "implement", agentId: "a", authMode: "subscription" },
    }),
    ev(taskId, {
      type: "AgentRunCompleted",
      payload: {
        runId: "r1",
        step: "implement",
        agentId: "a",
        authMode: "subscription",
        usage,
        costUsd: 0,
        estimated: true,
        output: "# 実装",
        testCommand: "make test",
      },
    }),
  ];
  const skipped = (taskId: string) => ev(taskId, { type: "TestsSkipped", payload: {} });

  it("テストの無い根拠を持つタスクだけが、テストを飛ばして最終レビューへ進める", () => {
    seq = 0;
    const task = project([...implemented("t1", "テストが無い"), skipped("t1")]).get("t1");
    expect(task?.noTestsReason).toBe("テストが無い");
    expect(task?.addedTestCommand).toBe("make test");
    expect(task?.verification).toBe("tests_passed");
    expect(task?.testsSkippedAt).toBe("2026-10-10T00:00:00.000Z");
    expect(task?.lastTests).toBeUndefined();
    expect(() => project([...implemented("t2"), skipped("t2")])).toThrow(/cannot be skipped/);
  });

  it("テストのコマンドがあれば、テストの無い根拠は持たない", () => {
    seq = 0;
    const task = project(implemented("t1", "テストが無い", "npm test")).get("t1");
    expect(task?.testCommand).toBe("npm test");
    expect(task?.noTestsReason).toBeUndefined();
  });
});

describe("テストが決まらずに止まったタスクの再開（人がテストを決める・工程の選択からやり直す）", () => {
  const undecided = (taskId: string, chosenSteps: EventInput & { type: "StepsChosen" }) => [
    created(taskId),
    ev(taskId, chosenSteps),
    ev(taskId, {
      type: "TaskPaused",
      payload: { reason: "error", message: { code: "orchestrator.testCommandUnknown" } },
    }),
  ];
  const chosen = (stepsOf: (typeof STEP_PLANS)[keyof typeof STEP_PLANS]) =>
    ({
      type: "StepsChosen",
      payload: {
        steps: [...stepsOf],
        plan: "direct",
        reason: "小さい",
        images: { implement: "node" },
        investigation: "content",
      },
    }) as EventInput & { type: "StepsChosen" };
  const decided = (taskId: string, payload: { testCommand?: string; noTestsReason?: string }) =>
    ev(taskId, { type: "TestsDecided", payload }, "person");
  const resumed = (taskId: string, rechooseSteps?: true) =>
    ev(
      taskId,
      {
        type: "TaskResumed",
        payload: { retry: true, ...(rechooseSteps ? { rechooseSteps } : {}) },
      },
      "person",
    );

  it("人がテストのコマンドかテストなしの理由を決めると、タスクに持ち、人が決めたことがわかる", () => {
    seq = 0;
    const events = undecided("t1", chosen(STEP_PLANS.direct));
    const paused = project(events).get("t1") as Task;
    expect(canDecideTests(paused)).toBe(true);
    expect(canRechooseSteps(paused)).toBe(true);
    const withCommand = project([...events, decided("t1", { testCommand: "make check" })]).get(
      "t1",
    );
    expect(withCommand?.testCommand).toBe("make check");
    expect(withCommand?.testsDecidedBy).toBe("person");
    const none = project([
      ...undecided("t2", chosen(STEP_PLANS.direct)),
      decided("t2", { noTestsReason: "テストを書かない" }),
      resumed("t2"),
    ]).get("t2");
    expect(none?.noTestsReason).toBe("テストを書かない");
    expect(none?.status).toBe("queued");
    expect(none?.steps.length).toBe(STEP_PLANS.direct.length);
  });

  it("テストのコマンドと理由は、どちらか1つだけ", () => {
    expect(() => decided("t0", {})).toThrow();
    expect(() => decided("t0", { testCommand: "a", noTestsReason: "b" })).toThrow();
  });

  it("テストが決まっているタスク・止まっていないタスクでは決められず、不具合の修正はテストなしにできない", () => {
    seq = 0;
    const decidedTwice = [
      ...undecided("t1", chosen(STEP_PLANS.direct)),
      decided("t1", { testCommand: "make check" }),
      decided("t1", { testCommand: "make test" }),
    ];
    expect(() => project(decidedTwice)).toThrow(/not undecided/);
    const notPaused = [
      created("t2"),
      ev("t2", chosen(STEP_PLANS.direct)),
      decided("t2", { testCommand: "x" }),
    ];
    expect(() => project(notPaused)).toThrow(/not undecided/);
    const bugfix = [
      ...undecided("t3", chosen(STEP_PLANS.bugfix)),
      decided("t3", { noTestsReason: "テストは無い" }),
    ];
    expect(() => project(bugfix)).toThrow(/needs a test command/);
    expect(
      project([
        ...undecided("t4", chosen(STEP_PLANS.bugfix)),
        decided("t4", { testCommand: "x" }),
      ]).get("t4")?.testCommand,
    ).toBe("x");
  });

  it("工程の選択からやり直すと、選んだ工程と、選択で決めたものを消して実行待ちにする（予算の上限は残す）", () => {
    seq = 0;
    const task = project([
      ...undecided("t1", chosen(STEP_PLANS.direct)),
      ev(
        "t1",
        { type: "StepImageChanged", payload: { step: "implement", from: "node", to: "java" } },
        "person",
      ),
      resumed("t1", true),
    ]).get("t1");
    expect(task?.status).toBe("queued");
    expect(task?.steps).toEqual([]);
    expect(task?.stepsChoice).toBeUndefined();
    expect(task?.images).toBeUndefined();
    expect(task?.imageChanges).toBeUndefined();
    expect(task?.investigation).toBeUndefined();
    expect(task?.budget.capUsd).toBeGreaterThan(0);
    // もう一度選べる
    const again = project([
      ...undecided("t2", chosen(STEP_PLANS.direct)),
      resumed("t2", true),
      ev("t2", {
        type: "StepsChosen",
        payload: { steps: [...STEP_PLANS.direct], testCommand: "npm test" },
      }),
    ]).get("t2");
    expect(again?.testCommand).toBe("npm test");
    expect(again?.steps.map((s) => s.state)[0]).toBe("active");
  });

  it("作成時に工程ごとに指定したイメージ・エージェントは、工程を選び直しても使い、人の後の変更は消す", () => {
    seq = 0;
    const requested = ev(
      "t1",
      {
        type: "TaskCreated",
        payload: {
          title: "t",
          body: "",
          start: "sacty",
          plan: "direct",
          images: { implement: "java", design: "ruby" },
          agents: { implement: "strong" },
        },
      },
      "person",
    );
    const first = project([requested]).get("t1");
    expect(first?.agents).toEqual({ implement: "strong" });
    expect(first?.images).toBeUndefined();
    const events = [
      requested,
      ev("t1", chosen(STEP_PLANS.direct)),
      ev(
        "t1",
        { type: "StepAgentChanged", payload: { step: "implement", from: "strong", to: "weak" } },
        "person",
      ),
    ];
    const chosenTask = project(events).get("t1");
    // 選んだ工程の分だけ、オーケストレーターの選択（node）より優先する（工程に無い design は入れない）
    expect(chosenTask?.images).toEqual({ implement: "java" });
    expect(chosenTask?.agents).toEqual({ implement: "weak" });
    const again = project([
      ...events,
      ev("t1", {
        type: "TaskPaused",
        payload: { reason: "error", message: { code: "orchestrator.testCommandUnknown" } },
      }),
      resumed("t1", true),
    ]).get("t1");
    expect(again?.images).toBeUndefined();
    expect(again?.agents).toEqual({ implement: "strong" });
    expect(again?.agentChanges).toBeUndefined();
    const rechosen = project([
      ...events,
      ev("t1", {
        type: "TaskPaused",
        payload: { reason: "error", message: { code: "orchestrator.testCommandUnknown" } },
      }),
      resumed("t1", true),
      ev("t1", { type: "StepsChosen", payload: { steps: [...STEP_PLANS.direct] } }),
    ]).get("t1");
    expect(rechosen?.images).toEqual({ implement: "java" });
  });

  it("工程を始めて成果ができた後は、工程の選択からやり直せない", () => {
    seq = 0;
    const events = [
      created("t1"),
      ev("t1", chosen(STEP_PLANS.direct)),
      ev("t1", {
        type: "AgentRunStarted",
        payload: { runId: "r1", step: "investigate", agentId: "a", authMode: "subscription" },
      }),
      ev("t1", {
        type: "AgentRunCompleted",
        payload: {
          runId: "r1",
          step: "investigate",
          agentId: "a",
          authMode: "subscription",
          usage,
          costUsd: 0,
          estimated: true,
          output: "# 調査",
        },
      }),
      ev("t1", {
        type: "TaskPaused",
        payload: { reason: "error", message: { code: "orchestrator.testCommandUnknown" } },
      }),
    ];
    const task = project(events).get("t1") as Task;
    expect(canDecideTests(task)).toBe(true);
    expect(canRechooseSteps(task)).toBe(false);
    expect(() => project([...events, resumed("t1", true)])).toThrow(/cannot be chosen again/);
  });
});

describe("工程のイメージを人が変える（PBI-106）", () => {
  const change = (taskId: string, step: "requirements" | "design" | "reproduce", to: string) =>
    ev(taskId, { type: "StepImageChanged", payload: { step, from: "default", to } }, "person");

  it("実行中・終わった工程も変えられ、イメージと変えた記録（いつ・何から何に）を持つ。工程の状態は変えない", () => {
    const events = [
      created("i1"),
      ev("i1", {
        type: "StepsChosen",
        payload: { steps: [...MVP_STEPS], images: { design: "java" }, imageSource: "project" },
      }),
      started("i1", "r1"),
      change("i1", "requirements", "playwright"),
    ];
    const running = project(events).get("i1");
    expect(running?.status).toBe("running");
    expect(running && stepRunning(running, "requirements")).toBe(true);
    expect(running && stepRunning(running, "design")).toBe(false);
    expect(running?.images).toEqual({ design: "java", requirements: "playwright" });
    expect(running?.imageSource).toBe("project");
    expect(running?.imageChanges?.requirements).toEqual({
      from: "default",
      to: "playwright",
      at: "2026-10-10T00:00:00.000Z",
    });
    expect(running?.steps.map((s) => s.state)).toEqual(["active", "todo", "todo"]);
  });

  it("タスクの工程に無い工程は、作業履歴の誤りにする", () => {
    expect(() => project([created("i2"), steps("i2"), change("i2", "reproduce", "java")])).toThrow(
      /not chosen/,
    );
  });
});

describe("実装の工程の中で PR を作り、承認を待つ（PBI-110）", () => {
  const prepared = (id: string) =>
    ev(id, {
      type: "RepositoryPrepared",
      payload: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "b1" },
    });
  const chosen = (id: string) =>
    ev(id, { type: "StepsChosen", payload: { steps: ["implement"], testCommand: "npm test" } });
  const published = (id: string) =>
    ev(id, {
      type: "PullRequestPublished",
      payload: {
        branch: "sacty/t",
        commit: "c1",
        url: "https://github.com/acme/app/pull/7",
        repo: "https://github.com/acme/app",
        number: 7,
      },
    });
  const submitted = (id: string, submission = 1) =>
    ev(id, { type: "StepSubmitted", payload: { step: "implement", submission } });

  it("工程 pr は無い（古い記録の工程の組み合わせは読めない）", () => {
    expect(() =>
      EventSchema.parse({ type: "StepsChosen", payload: { steps: ["implement", "pr"] } }),
    ).toThrow();
    expect(() =>
      EventSchema.parse({ type: "StepSubmitted", payload: { step: "pr", submission: 1 } }),
    ).toThrow();
  });

  it("最終レビューに通っても実装の工程のまま PR の作成を待ち、PR を作ったら実装の承認待ちになり、マージで完了する", () => {
    seq = 0;
    const base = [created("t"), chosen("t"), prepared("t"), ...verifiedImplementation("t")];
    const verified = project(base).get("t");
    expect(verified?.status).toBe("queued");
    expect(verified?.publishPending).toBe(true);
    expect(verified?.steps).toEqual([{ key: "implement", state: "active" }]);
    expect(verified && isCompleted(verified)).toBe(false);

    const waiting = project([...base, published("t"), submitted("t")]).get("t");
    expect(waiting?.status).toBe("awaiting_approval");
    expect(waiting?.publishPending).toBeUndefined();
    expect(waiting?.gate).toEqual({ step: "implement", submission: 1 });
    expect(waiting && gatePullRequest(waiting)).toMatchObject({ step: "implement", number: 7 });

    const done = project([
      ...base,
      published("t"),
      submitted("t"),
      ev("t", { type: "PullRequestMerged", payload: { number: 7, commit: "c1" } }, "person"),
      ev("t", { type: "StepApproved", payload: { step: "implement", next: "idle" } }, "person"),
    ]).get("t");
    expect(done?.pullRequestState).toBe("merged");
    expect(done?.approved.implement?.output).toBe("# 実装");
    expect(done && isCompleted(done)).toBe(true);
  });

  it("PR を作るのは、検証に通った実装だけ（検証の前・承認待ちの後は作業履歴の誤り）", () => {
    seq = 0;
    const ran = [
      created("t"),
      chosen("t"),
      prepared("t"),
      ...verifiedImplementation("t").slice(0, 2),
    ];
    expect(() => project([...ran, published("t")])).toThrow(/not waiting for a pull request/);
    seq = 0;
    const verified = [created("u"), chosen("u"), prepared("u"), ...verifiedImplementation("u")];
    expect(() => project([...verified, published("u"), submitted("u"), published("u")])).toThrow(
      /not waiting for a pull request/,
    );
    expect(() =>
      project([
        ...verified,
        ev("u", { type: "BranchPushed", payload: { branch: "b", commit: "c" } }),
      ]),
    ).not.toThrow();
  });

  it("一時停止して再開しても、PR の作成を待ったまま（実装をやり直さない）", () => {
    seq = 0;
    const task = project([
      created("t"),
      chosen("t"),
      prepared("t"),
      ...verifiedImplementation("t"),
      ev("t", { type: "TaskPaused", payload: { reason: "error" } }),
      ev("t", { type: "TaskResumed", payload: { retry: true } }, "person"),
    ]).get("t");
    expect(task?.status).toBe("queued");
    expect(task?.publishPending).toBe(true);
  });

  it("変更が無くて PR を作らなかった提出回は、実装の提出回で変更なしと判断する", () => {
    seq = 0;
    const task = project([
      created("t"),
      chosen("t"),
      prepared("t"),
      ...verifiedImplementation("t"),
      ev("t", { type: "NoChangesFound", payload: { submission: 1 } }),
      submitted("t"),
    ]).get("t");
    expect(task?.gate).toEqual({ step: "implement", submission: 1 });
    expect(task?.publishPending).toBeUndefined();
    expect(task && deliveredWithoutChanges(task)).toBe(true);
    expect(task && gatePullRequest(task)).toBeUndefined();
  });

  it("実装の承認待ちで差し戻した指摘には、実装の次の提出回で答える", () => {
    seq = 0;
    const task = project([
      created("t"),
      chosen("t"),
      prepared("t"),
      ...verifiedImplementation("t"),
      published("t"),
      submitted("t"),
      ev(
        "t",
        {
          type: "ChangesRequested",
          payload: {
            step: "implement",
            target: "implement",
            round: 1,
            remarks: [{ id: "implement-1-1", text: "直して" }],
          },
        },
        "person",
      ),
      ev("t", {
        type: "AgentRunStarted",
        payload: { runId: "impl-2", step: "implement", agentId: "a", authMode: "subscription" },
      }),
      ev("t", {
        type: "AgentRunCompleted",
        payload: {
          runId: "impl-2",
          step: "implement",
          agentId: "a",
          authMode: "subscription",
          usage,
          costUsd: 0,
          estimated: true,
          output: "# 実装2",
          responses: [{ remarkId: "implement-1-1", text: "直した" }],
        },
      }),
    ]).get("t");
    expect(task?.remarks).toMatchObject([
      { id: "implement-1-1", step: "implement", response: "直した", respondedIn: 2 },
    ]);
    expect(task?.verification).toBe("pending");
    expect(task?.publishPending).toBeUndefined();
  });
});

describe("単発作業の二重開始をイベント再生でも拒否する", () => {
  it("最初の外部作業が失敗してqueuedに戻っても二度目の開始イベントを拒否する", () => {
    seq = 0;
    const operation = {
      via: "platform" as const,
      name: "calendar",
      target: "event-42",
      change: "開始時刻を11時へ変更する",
      verification: "更新後の開始時刻を取得して確認する",
    };
    const events = [
      created("operation-task"),
      ev("operation-task", {
        type: "StepsChosen",
        payload: { steps: ["operation"], plan: "operation", operation },
      }),
      ev("operation-task", {
        type: "AgentRunStarted",
        payload: { runId: "first", step: "operation", agentId: "a", authMode: "subscription" },
      }),
      ev("operation-task", {
        type: "AgentRunFailed",
        payload: {
          runId: "first",
          step: "operation",
          agentId: "a",
          reason: "error",
          message: "応答を確認できない",
        },
      }),
    ];
    const failed = project(events).get("operation-task");
    // queued・設定あり・実行中runなしを確認し、他の状態ガードによる拒否ではないことを保証する。
    expect(failed?.status).toBe("queued");
    expect(failed?.currentRunId).toBeUndefined();
    expect(failed?.operation).toEqual(operation);
    expect(failed?.operationAttempted).toBe(true);
    const duplicate = ev("operation-task", {
      type: "AgentRunStarted",
      payload: { runId: "second", step: "operation", agentId: "a", authMode: "subscription" },
    });
    expect(() => project([...events, duplicate])).toThrow("operation was already attempted");
  });
});

describe("終わったタスク（PBI-114）", () => {
  const base = { steps: [{ key: "implement", state: "done" }] } as unknown as Task;
  it("中止と、工程をすべて終えて止まったタスクだけが終わり。承認待ち・一時停止・エスカレーション・テストの途中は終わっていない", () => {
    expect(isFinished({ ...base, status: "cancelled" })).toBe(true);
    expect(isFinished({ ...base, status: "idle" })).toBe(true);
    for (const status of [
      "awaiting_approval",
      "paused",
      "escalated",
      "running",
      "queued",
      "blocked",
      "waiting_children",
    ] as const) {
      expect(isFinished({ ...base, status }), status).toBe(false);
    }
    expect(isFinished({ ...base, status: "idle", steps: [] })).toBe(false);
    expect(
      isFinished({
        ...base,
        status: "idle",
        steps: [{ key: "implement", state: "active" }],
      } as Task),
    ).toBe(false);
  });
});

describe("マージの後の監視の工程（PBI-116）", () => {
  const chosen = (id: string, deployment: Record<string, unknown> = { skill: "s/SKILL.md" }) =>
    ev(id, {
      type: "StepsChosen",
      payload: { steps: ["implement", "deployment"], testCommand: "npm test", deployment },
    } as EventInput);
  const toGate = (id: string, deployment?: Record<string, unknown>) => [
    created(id),
    chosen(id, deployment),
    ev(id, {
      type: "RepositoryPrepared",
      payload: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "b1" },
    }),
    ...verifiedImplementation(id),
    ev(id, {
      type: "PullRequestPublished",
      payload: {
        branch: "sacty/t",
        commit: "c1",
        url: "https://github.com/acme/app/pull/7",
        number: 7,
      },
    }),
    ev(id, { type: "StepSubmitted", payload: { step: "implement", submission: 1 } }),
  ];
  const merged = (id: string) => [
    ev(id, { type: "PullRequestMerged", payload: { number: 7, commit: "c1" } }, "person"),
    ev(id, { type: "StepApproved", payload: { step: "implement", next: "idle" } }, "person"),
  ];
  const watch = (id: string, commit: string | undefined = "m1") =>
    ev(id, {
      type: "DeploymentWatchStarted",
      payload: {
        number: 7,
        repo: "https://github.com/acme/app",
        branch: "main",
        ...(commit ? { commit } : {}),
      },
    });
  const ciPassed = (id: string) =>
    ev(id, { type: "DeploymentCiFinished", payload: { result: "passed", skill: "s/SKILL.md" } });
  const checkStarted = (id: string) =>
    ev(id, { type: "DeploymentCheckStarted", payload: { runId: "r1", skill: "s/SKILL.md" } });
  const stateOf = (task: Task | undefined) => task?.steps.map((s) => [s.key, s.state]);

  it("スキルが無ければ工程を飛ばし、実装の承認で完了する。あれば工程に進み、監視の間は完了しない", () => {
    seq = 0;
    const skipped = project([
      ...toGate("a", { skipped: { code: "deploy.stepSkipped", params: { detail: "無い" } } }),
      ...merged("a"),
    ]).get("a");
    expect(stateOf(skipped)).toEqual([
      ["implement", "done"],
      ["deployment", "skip"],
    ]);
    expect(skipped?.deploymentChoice).toMatchObject({ skipped: { code: "deploy.stepSkipped" } });
    expect(skipped && isFinished(skipped)).toBe(true);

    seq = 0;
    const watching = project([...toGate("b"), ...merged("b"), watch("b")]).get("b") as Task;
    expect(stateOf(watching)).toEqual([
      ["implement", "done"],
      ["deployment", "active"],
    ]);
    expect(watching.status).toBe("idle");
    expect(isCompleted(watching)).toBe(false);
    expect(isFinished(watching)).toBe(false);
  });

  it("監視が終わると工程を終えて完了する。失敗は、修正のタスクを決めるまで終えない", () => {
    seq = 0;
    const passed = project([
      ...toGate("t"),
      ...merged("t"),
      watch("t"),
      ev("t", { type: "DeploymentCiFinished", payload: { result: "passed" } }),
    ]).get("t") as Task;
    expect(passed.deployment).toMatchObject({ state: "passed", reason: "no_skill" });
    expect(isFinished(passed)).toBe(true);
    for (const result of ["none", "timed_out"] as const) {
      seq = 0;
      const t = project([
        ...toGate("t"),
        ...merged("t"),
        watch("t"),
        ev("t", { type: "DeploymentCiFinished", payload: { result } }),
      ]).get("t") as Task;
      expect(isFinished(t)).toBe(true);
    }
    seq = 0;
    const noCommit = project([...toGate("t"), ...merged("t"), watch("t", "")]).get("t") as Task;
    expect(noCommit.deployment).toMatchObject({ state: "skipped", reason: "no_commit" });
    expect(isFinished(noCommit)).toBe(true);

    seq = 0;
    const failing = [
      ...toGate("t"),
      ...merged("t"),
      watch("t"),
      ev("t", { type: "DeploymentCiFinished", payload: { result: "failed" } }),
    ];
    const failed = project(failing).get("t") as Task;
    expect(failed.deployment?.state).toBe("failed");
    expect(isFinished(failed)).toBe(false);
    const decided = project([
      ...failing,
      ev("t", {
        type: "DeploymentFixSuppressed",
        payload: { kind: "ci", fingerprint: "f", reason: "chain_limit" },
      }),
    ]).get("t") as Task;
    expect(isFinished(decided)).toBe(true);
    expect(decided.status).toBe("idle");
  });

  it("止めた確認（retry）は結果にせず、確かめ直せる。費用は入れる。実行中は工程が実行中", () => {
    seq = 0;
    const running = [...toGate("t"), ...merged("t"), watch("t"), ciPassed("t"), checkStarted("t")];
    const during = project(running).get("t") as Task;
    expect(stepRunning(during, "deployment")).toBe(true);
    const retried = project([
      ...running,
      ev("t", {
        type: "DeploymentChecked",
        payload: {
          result: "unknown",
          runResult: "interrupted",
          agentId: "a",
          runId: "r1",
          retry: true,
          costUsd: 0.25,
        },
      }),
    ]).get("t") as Task;
    expect(retried.deployment).toMatchObject({ state: "waiting", phase: "check" });
    expect(retried.deployment?.check).toBeUndefined();
    expect(retried.budget.usedUsd).toBe(0.25);
    expect(isFinished(retried)).toBe(false);
    expect(stepRunning(retried, "deployment")).toBe(false);
  });

  it("CI/CD・デプロイの確認それぞれの結果を残す", () => {
    seq = 0;
    const done = project([
      ...toGate("t"),
      ...merged("t"),
      watch("t"),
      ciPassed("t"),
      checkStarted("t"),
      ev("t", {
        type: "DeploymentChecked",
        payload: {
          result: "healthy",
          ci: { result: "passed" },
          deployment: { result: "skipped", reason: "デプロイしていない" },
          runResult: "completed",
          agentId: "a",
          runId: "r1",
        },
      }),
    ]).get("t") as Task;
    expect(done.deployment?.check).toMatchObject({
      ci: { result: "passed" },
      deployment: { result: "skipped", reason: "デプロイしていない" },
    });
    expect(isFinished(done)).toBe(true);
  });

  it("マージの前に監視を始めた記録は受け付けない。変更なしで実装を承認したら、監視の工程を飛ばす", () => {
    seq = 0;
    expect(() => project([...toGate("t"), watch("t")])).toThrow(/not merged/);
    seq = 0;
    const noChanges = project([
      created("n"),
      chosen("n"),
      ev("n", {
        type: "RepositoryPrepared",
        payload: { url: "https://github.com/acme/app", baseBranch: "main", baseCommit: "b1" },
      }),
      ...verifiedImplementation("n"),
      ev("n", { type: "NoChangesFound", payload: { submission: 1 } }),
      ev("n", { type: "StepSubmitted", payload: { step: "implement", submission: 1 } }),
      ev("n", { type: "StepApproved", payload: { step: "implement", next: "idle" } }, "person"),
    ]).get("n") as Task;
    expect(stateOf(noChanges)).toEqual([
      ["implement", "done"],
      ["deployment", "skip"],
    ]);
    expect(isFinished(noChanges)).toBe(true);
  });

  it("前の工程に戻しても、飛ばした工程は飛ばしたまま", () => {
    seq = 0;
    const events = [
      created("r"),
      ev("r", {
        type: "StepsChosen",
        payload: {
          steps: ["requirements", "implement", "deployment"],
          testCommand: "npm test",
          deployment: { skipped: "無い" },
        },
      }),
      ev("r", {
        type: "AgentRunStarted",
        payload: { runId: "q1", step: "requirements", agentId: "a", authMode: "subscription" },
      }),
      ev("r", {
        type: "AgentRunCompleted",
        payload: {
          runId: "q1",
          step: "requirements",
          agentId: "a",
          output: "# 要求",
          authMode: "subscription",
          usage,
          costUsd: 0,
          estimated: false,
        },
      }),
      ev("r", { type: "StepSubmitted", payload: { step: "requirements", submission: 1 } }),
      ev(
        "r",
        { type: "StepApproved", payload: { step: "requirements", next: "queued" } },
        "person",
      ),
    ];
    const approved = project(events).get("r") as Task;
    expect(stateOf(approved)).toEqual([
      ["requirements", "done"],
      ["implement", "active"],
      ["deployment", "skip"],
    ]);
    // 実装の工程が要求要件の変更を申し出て認められ、要求要件に戻した
    const reopened = project([
      ...events,
      ev("r", {
        type: "AgentRunStarted",
        payload: { runId: "i1", step: "implement", agentId: "a", authMode: "subscription" },
      }),
      ev("r", {
        type: "AgentRunCompleted",
        payload: {
          runId: "i1",
          step: "implement",
          agentId: "a",
          output: "# 実装",
          authMode: "subscription",
          usage,
          costUsd: 0,
          estimated: false,
        },
      }),
      ev("r", {
        type: "ChangeProposed",
        payload: {
          proposalId: "CP-1",
          fromStep: "implement",
          target: "requirements",
          reason: "前提が違う",
          facts: ["事実"],
          proposed: "# 要求（直した）",
        },
      }),
      ev("r", {
        type: "ChangeJudged",
        payload: { proposalId: "CP-1", verdict: "approved", reason: "妥当", agentId: "g" },
      }),
      ev("r", { type: "ChangeApplied", payload: { proposalId: "CP-1" } }),
    ]).get("r") as Task;
    expect(stateOf(reopened)).toEqual([
      ["requirements", "active"],
      ["implement", "todo"],
      ["deployment", "skip"],
    ]);
  });
});

describe("中止したタスクの再実行", () => {
  const cancel = (taskId: string) =>
    ev(taskId, { type: "TaskCancelled", payload: { cleanup: [] } }, "person");
  const rerun = (taskId: string, of: string, extra: Record<string, unknown> = {}) =>
    ev(
      taskId,
      {
        type: "TaskCreated",
        payload: {
          title: "again",
          body: "body",
          start: "jira",
          noRepo: true,
          ticket: {
            platform: "jira",
            service: "jira-server",
            key: "PAY-1",
            url: "https://jira.example.com/browse/PAY-1",
          },
          rerun: { taskId: of },
          ...extra,
        },
      },
      "person",
    );

  it("元のタスクに再実行で作ったタスクを記録し、チケットを読み直さず、リポジトリ無しで進められる", () => {
    const tasks = project([created("t1"), cancel("t1"), rerun("t2", "t1")]);
    const original = tasks.get("t1");
    const again = tasks.get("t2");
    expect(original?.rerunBy).toBe("t2");
    expect(original && canRerun(original)).toBe(false);
    expect(again?.rerun).toEqual({ taskId: "t1" });
    expect(again && awaitingTicketTriage(again)).toBe(false);
    expect(again && isRepoless(again)).toBe(true);
    expect(again && awaitingRepository(again)).toBe(true);
  });

  it("中止していない・再実行済みのタスクの再実行は、作業履歴に受け付けない", () => {
    expect(() => project([created("t1"), rerun("t2", "t1")])).toThrow(/not a cancelled task/);
    expect(() =>
      project([created("t1"), cancel("t1"), rerun("t2", "t1"), rerun("t3", "t1")]),
    ).toThrow(/not a cancelled task/);
  });

  it("中止したタスクだけを再実行できる（分割の子タスク・PR のレビューは除く）", () => {
    const tasks = project([created("t1"), cancel("t1")]);
    const cancelled = tasks.get("t1") as Task;
    expect(canRerun(cancelled)).toBe(true);
    expect(canRerun({ ...cancelled, status: "paused" })).toBe(false);
    expect(canRerun({ ...cancelled, parent: { taskId: "p", dependsOn: [] } })).toBe(false);
    expect(canRerun({ ...cancelled, start: "github_pull_request" })).toBe(false);
  });
});

describe("完了したタスクから続きのタスクを作る（派生）", () => {
  const derived = (taskId: string, of: string) =>
    ev(
      taskId,
      {
        type: "TaskCreated",
        payload: { title: "next", body: "body", start: "sacty", derivedFrom: { taskId: of } },
      },
      "person",
    );
  const done = { steps: [{ key: "investigate", state: "done" }] } as unknown as Task;

  it("工程をすべて終えて止まった（中止していない）タスクからだけ作れる", () => {
    expect(canDerive({ ...done, status: "idle" })).toBe(true);
    expect(canDerive({ ...done, status: "cancelled" })).toBe(false);
    expect(canDerive({ ...done, status: "awaiting_approval" })).toBe(false);
    expect(canDerive({ ...done, status: "idle", steps: [] })).toBe(false);
  });

  it("完了していないタスクからの派生は、作業履歴に受け付けない", () => {
    expect(() => project([created("t1"), derived("t2", "t1")])).toThrow(/not from a completed/);
  });

  it("別のプロジェクトのタスクからの派生は、完了していても作業履歴に受け付けない", () => {
    const original = { ...done, id: "t1", projectId: "default", status: "idle" } as Task;
    const tasks = new Map([["t1", original]]);
    expect(applyEvent(tasks, derived("t2", "t1")).get("t1")?.derivedTasks).toEqual(["t2"]);
    const other = { ...derived("t3", "t1"), projectId: "other" } as ActivityEvent;
    expect(() => applyEvent(tasks, other)).toThrow(/not from a completed/);
  });

  it("派生で作ったタスクの再実行は、元のタスクがいま完了していなくても受け付け、つながりを保つ", () => {
    const original = {
      ...done,
      id: "t1",
      projectId: "default",
      status: "awaiting_approval",
    } as Task;
    const tasks = new Map([["t1", original]]);
    const rerun = ev(
      "t3",
      {
        type: "TaskCreated",
        payload: {
          title: "again",
          body: "body",
          start: "sacty",
          derivedFrom: { taskId: "t1", record: "## 元のタスクの記録（完了したタスク）" },
          rerun: { taskId: "t2" },
        },
      },
      "person",
    );
    const next = applyEvent(tasks, rerun);
    expect(next.get("t1")?.derivedTasks).toEqual(["t3"]);
    expect(next.get("t3")?.derivedFrom?.record).toBe("## 元のタスクの記録（完了したタスク）");
    // 再実行でない派生は、元のタスクが完了していなければ受け付けない
    expect(() => applyEvent(tasks, derived("t4", "t1"))).toThrow(/not from a completed/);
  });

  it("元のタスクが作業履歴に無ければ、元のタスクへの記録だけを省く", () => {
    const tasks = project([derived("t2", "missing")]);
    expect(tasks.get("t2")?.derivedFrom).toEqual({ taskId: "missing" });
  });
});

describe("工程の見直し", () => {
  // 工程の見直しは、終わった工程の後に行う。ここでは、実装する組み合わせの先頭に前段の調査を置いていた版の作業履歴
  // （工程は StepsChosen に記録したもの）で確かめる
  const chosen = (id: string, plan: keyof typeof STEP_PLANS) =>
    ev(id, {
      type: "StepsChosen",
      payload: { steps: ["investigate", ...STEP_PLANS[plan]], plan, testCommand: "npm test" },
    });
  const investigated = (id: string) => [
    ev(id, {
      type: "AgentRunStarted",
      payload: { runId: "inv", step: "investigate", agentId: "a", authMode: "subscription" },
    }),
    ev(id, {
      type: "AgentRunCompleted",
      payload: {
        runId: "inv",
        step: "investigate",
        agentId: "a",
        authMode: "subscription",
        usage,
        costUsd: 0,
        estimated: true,
        output: "# 調査\n\n- isAdmin() が src/auth.ts:3 にある",
      },
    }),
    ev(id, { type: "StepCompleted", payload: { step: "investigate", next: "queued" } }),
  ];
  const skipped = (id: string, steps: string[], after = "investigate") =>
    ev(
      id,
      {
        type: "StepsSkipped",
        payload: { after, steps, reason: "既存の isAdmin で足りる", costUsd: 0.01 },
      } as EventInput,
      "orchestrator",
    );
  const stateOf = (task: Task | undefined) => task?.steps.map((s) => [s.key, s.state]);

  it("前段の調査が終わると、飛ばせる工程（要求要件・設計）があるので見直しを待つ", () => {
    seq = 0;
    const task = project([created("a"), chosen("a", "standard"), ...investigated("a")]).get("a");
    expect(task?.stepReview).toBe("investigate");
    expect(task && skippableSteps(task)).toEqual(["requirements", "design"]);
    expect(task?.status).toBe("queued");
  });

  it("要求要件・設計を飛ばすと、実装を実行対象にし、費用を予算に入れる。見直しは待たない", () => {
    seq = 0;
    const task = project([
      created("a"),
      chosen("a", "standard"),
      ...investigated("a"),
      skipped("a", ["requirements", "design"]),
    ]).get("a") as Task;
    expect(stateOf(task)).toEqual([
      ["investigate", "done"],
      ["requirements", "skip"],
      ["design", "skip"],
      ["implement", "active"],
      ["deployment", "todo"],
    ]);
    expect(task.stepReview).toBeUndefined();
    expect(task.budget.usedUsd).toBeCloseTo(0.01);
    // 飛ばした工程には差し戻さない
    expect(reworkTargets(task, "implement")).toEqual(["implement"]);
  });

  it("飛ばさないと決めたら、工程はそのままで見直しを終える。設計だけ飛ばすこともできる", () => {
    seq = 0;
    const kept = project([
      created("a"),
      chosen("a", "standard"),
      ...investigated("a"),
      skipped("a", []),
    ]).get("a");
    expect(stateOf(kept)?.slice(1, 3)).toEqual([
      ["requirements", "active"],
      ["design", "todo"],
    ]);
    expect(kept?.stepReview).toBeUndefined();

    seq = 0;
    const designSkipped = project([
      created("b"),
      chosen("b", "standard"),
      ...investigated("b"),
      skipped("b", ["design"]),
    ]).get("b");
    expect(stateOf(designSkipped)?.slice(1, 4)).toEqual([
      ["requirements", "active"],
      ["design", "skip"],
      ["implement", "todo"],
    ]);
  });

  it("飛ばせない工程（実装）・見直しを待っていない工程の記録は受け付けない", () => {
    seq = 0;
    const base = [created("a"), chosen("a", "standard"), ...investigated("a")];
    expect(() => project([...base, skipped("a", ["implement"])])).toThrow(/cannot be skipped/);
    seq = 0;
    expect(() =>
      project([created("b"), chosen("b", "standard"), skipped("b", ["requirements"])]),
    ).toThrow(/not waiting for a review/);
  });

  it("組み合わせ direct（調査 → 実装）は、飛ばせる工程が無いので見直さない。実装の無い組み合わせも見直さない", () => {
    seq = 0;
    const direct = project([created("a"), chosen("a", "direct"), ...investigated("a")]).get("a");
    expect(stateOf(direct)).toEqual([
      ["investigate", "done"],
      ["implement", "active"],
      ["deployment", "todo"],
    ]);
    expect(direct?.stepReview).toBeUndefined();

    seq = 0;
    const split = project([created("b"), chosen("b", "split"), ...investigated("b")]).get("b");
    expect(split && skippableSteps(split)).toEqual([]);
    expect(split?.stepReview).toBeUndefined();
  });

  it("人がタスクの作成時に組み合わせを指定したタスクは、工程を飛ばさない（見直さない）", () => {
    seq = 0;
    const requested = ev(
      "a",
      {
        type: "TaskCreated",
        payload: { title: "a", body: "", start: "sacty", plan: "standard" },
      },
      "person",
    );
    const task = project([requested, chosen("a", "standard"), ...investigated("a")]).get("a");
    expect(task?.requestedPlan).toBe("standard");
    expect(task && skippableSteps(task)).toEqual([]);
    expect(task?.stepReview).toBeUndefined();
    expect(stateOf(task)?.slice(0, 2)).toEqual([
      ["investigate", "done"],
      ["requirements", "active"],
    ]);
  });

  it("見直す前に工程を始めた作業履歴（見直しより前の版）では、見直しを待たない", () => {
    seq = 0;
    const task = project([
      created("a"),
      chosen("a", "standard"),
      ...investigated("a"),
      ev("a", {
        type: "AgentRunStarted",
        payload: { runId: "req", step: "requirements", agentId: "a", authMode: "subscription" },
      }),
    ]).get("a");
    expect(task?.stepReview).toBeUndefined();
  });
});

describe("実装の検証（ゴールガーディアンがテストを実行する）", () => {
  const implemented = (id: string, runId: string) => [
    ev(id, {
      type: "AgentRunStarted",
      payload: { runId, step: "implement", agentId: "a", authMode: "subscription" },
    }),
    ev(id, {
      type: "AgentRunCompleted",
      payload: {
        runId,
        step: "implement",
        agentId: "a",
        authMode: "subscription",
        usage,
        costUsd: 0,
        estimated: true,
        output: "# 実装",
      },
    }),
  ];
  const reviewed = (id: string, exitCode: number) =>
    ev(
      id,
      {
        type: "FinalReviewed",
        payload: {
          passed: exitCode === 0,
          viewpoints: [],
          remarks: [],
          summary: "ok",
          agentId: "g",
          tests: { command: "npm test", exitCode, output: exitCode ? "1 failed" : "2 passed" },
        },
      },
      "guardian",
    );

  it("テストの記録なしに、実装の完了から最終レビューへ進み、ゴールガーディアンが実行したテストを最終レビューと一緒に持つ", () => {
    seq = 0;
    const id = "v1";
    const events = [
      created(id),
      ev(id, { type: "StepsChosen", payload: { steps: ["implement"], testCommand: "npm test" } }),
      ...implemented(id, "i1"),
    ];
    expect(project(events).get(id)?.verification).toBe("pending");
    const failed = project([...events, reviewed(id, 1)]).get(id);
    expect(failed?.verification).toBeUndefined();
    expect(failed?.verifyFailures).toBe(1);
    expect(failed?.verifyFeedback).toMatchObject({
      kind: "review",
      review: { tests: { exitCode: 1 } },
    });
    const passed = project([
      ...events,
      reviewed(id, 1),
      ...implemented(id, "i2"),
      reviewed(id, 0),
    ]).get(id);
    expect(passed?.publishPending).toBe(true);
    expect(passed?.lastReview?.tests).toMatchObject({ command: "npm test", exitCode: 0 });
    expect(passed?.lastTests).toBeUndefined();
  });

  it("それより前の版の記録（sacty がテストを実行した TestsRun）も読め、次の実装でその結果を持ち越さない", () => {
    seq = 0;
    const id = "v2";
    const events = [
      created(id),
      ev(id, { type: "StepsChosen", payload: { steps: ["implement"], testCommand: "npm test" } }),
      ...implemented(id, "i1"),
      ev(id, {
        type: "TestsRun",
        payload: {
          command: "npm test",
          exitCode: 1,
          unmappedViewpoints: [],
          passed: false,
          output: "fail",
          durationMs: 1,
        },
      }),
    ];
    const legacy = project(events).get(id);
    expect(legacy?.lastTests).toMatchObject({ passed: false });
    expect(legacy?.verifyFeedback?.kind).toBe("tests");
    const redone = project([...events, ...implemented(id, "i2")]).get(id);
    expect(redone?.verification).toBe("pending");
    expect(redone?.lastTests).toBeUndefined();
  });
});

describe("タスクの開始時の情報収集", () => {
  const gathered = (taskId: string) =>
    ev(
      taskId,
      {
        type: "InformationGathered",
        payload: { brief: "まとめ", sources: [{ title: "PAY-100" }], agentId: "a", costUsd: 0.5 },
      },
      "gatherer",
    );

  it("工程を選ぶ前に1回だけ集める。集めたまとめと費用をタスクに持つ", () => {
    const before = project([created("t1")]).get("t1");
    expect(before && awaitingGathering(before)).toBe(true);
    const task = project([created("t1"), gathered("t1")]).get("t1");
    expect(task?.gathered).toEqual({
      brief: "まとめ",
      sources: [{ title: "PAY-100" }],
      at: "2026-10-10T00:00:00.000Z",
    });
    expect(task?.budget.usedUsd).toBe(0.5);
    expect(task && awaitingGathering(task)).toBe(false);
    // 二度目・工程を選んだ後は記録できない
    expect(() => project([created("t1"), gathered("t1"), gathered("t1")])).toThrow();
    expect(() => project([created("t1"), steps("t1"), gathered("t1")])).toThrow();
    // 集める前の版のタスク（工程を選び終えた）は集めない
    const old = project([created("t1"), steps("t1")]).get("t1");
    expect(old && awaitingGathering(old)).toBe(false);
  });

  it("分割の子タスクは集めない（親のまとめを内容に持つ）", () => {
    const child = project([
      ev(
        "c1",
        {
          type: "TaskCreated",
          payload: {
            title: "子",
            body: "親の集めた情報を含む",
            start: "split",
            parent: { taskId: "t1", dependsOn: [] },
          },
        },
        "agent",
      ),
    ]).get("c1");
    expect(child && awaitingGathering(child)).toBe(false);
  });
});

describe("人がゴールガーディアンの不合格のままレビューへ進められるか", () => {
  const paused = (extra: Partial<Task> = {}) =>
    ({
      status: "paused",
      pausedReason: "verification",
      steps: [{ key: "implement", state: "active" }],
      ...extra,
    }) as Task;

  it("実装の検証が続けて通らずに止まった実装の工程だけ進められる", () => {
    expect(canOverrideVerification(paused())).toBe(true);
    expect(canOverrideVerification(paused({ pausedReason: "error" }))).toBe(false);
    expect(canOverrideVerification(paused({ status: "idle" }))).toBe(false);
    expect(canOverrideVerification(paused({ publishPending: true }))).toBe(false);
  });

  it("既存の PR を引き継ぐタスクは、不合格の実装を人の PR に積むことになるので進められない", () => {
    const continuedPullRequest = {
      repo: "https://github.com/acme/app",
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      branch: "feature",
      baseBranch: "main",
    } as Task["continuedPullRequest"];
    expect(canOverrideVerification(paused({ continuedPullRequest }))).toBe(false);
  });
});

describe("再開の補足を説明に足す", () => {
  const H = RESUME_NOTE_HEADING;
  const paused = (taskId: string, body: string) => [
    ev(taskId, { type: "TaskCreated", payload: { title: "t", body, start: "sacty" } }, "person"),
    ev(taskId, { type: "TaskPaused", payload: { reason: "error" } }),
  ];
  const resumed = (taskId: string, note: string) =>
    ev(taskId, { type: "TaskResumed", payload: { retry: false, note } }, "person");

  it("再開のたびに、見出しを付けて順に足す", () => {
    seq = 0;
    const task = project([
      ...paused("t1", "説明"),
      resumed("t1", "補足1"),
      ev("t1", { type: "TaskPaused", payload: { reason: "error" } }),
      resumed("t1", "補足2"),
    ]).get("t1");
    expect(task?.body).toBe(`説明\n\n${H}\n\n補足1\n\n${H}\n\n補足2`);
    // 説明を書き換える取り込みのために、補足を作業履歴から別に貯める（説明の見出しから読み直さない）
    expect(task?.resumeNotes).toEqual(["補足1", "補足2"]);
  });

  it("説明が空なら、見出しから始める", () => {
    seq = 0;
    const task = project([...paused("t1", ""), resumed("t1", "補足")]).get("t1");
    expect(task?.body).toBe(`${H}\n\n補足`);
  });
});

describe("再開の補足と、再実行・取り込みの説明", () => {
  const record = `${RERUN_RECORD_HEADING}\n\n以下は前の試行の参考の記録です。`;

  it("再実行で作ったタスクは、前の試行の記録の前に入れ、再実行の画面の説明に残す", () => {
    const task = {
      body: `説明\n\n${RERUN_NOTE_HEADING}\n\n再実行の補足\n\n${record}`,
      rerun: "t0",
    };
    const body = bodyWithResumeNote(task, "再開の補足");
    expect(body).toBe(
      `説明\n\n${RERUN_NOTE_HEADING}\n\n再実行の補足\n\n${RESUME_NOTE_HEADING}\n\n再開の補足\n\n${record}`,
    );
    expect(rerunEditableBody({ ...task, body })).toBe(
      `説明\n\n${RERUN_NOTE_HEADING}\n\n再実行の補足\n\n${RESUME_NOTE_HEADING}\n\n再開の補足`,
    );
  });

  it("派生で作ったタスクは、元のタスクの記録の前に入れる（記録に再実行の記録と同じ見出しの行があっても、境目を誤らない）", () => {
    const derivedRecord = `${DERIVE_RECORD_HEADING}\n\n成果\n${RERUN_RECORD_HEADING}\n成果の続き`;
    for (const rerun of [undefined, "t0"]) {
      const rerunPart = rerun ? `\n\n${RERUN_NOTE_HEADING}\n\n再実行の補足\n\n${record}` : "";
      const task = {
        body: `依頼\n\n${derivedRecord}${rerunPart}`,
        rerun,
        derivedFrom: { record: derivedRecord },
      };
      const body = bodyWithResumeNote(task, "再開の補足");
      expect(body).toBe(
        `依頼\n\n${RESUME_NOTE_HEADING}\n\n再開の補足\n\n${derivedRecord}${rerunPart}`,
      );
      // 再実行の画面の説明は、記録を除いて補足を残す
      expect(rerunEditableBody({ ...task, body })).toBe(
        `依頼\n\n${RESUME_NOTE_HEADING}\n\n再開の補足${rerun ? `\n\n${RERUN_NOTE_HEADING}\n\n再実行の補足` : ""}`,
      );
    }
  });

  it("足せる補足の長さは、補足のせいで再実行で直す説明が上限を新たに超えない長さ（ちょうど足すと上限に収まる）", () => {
    const H = RESUME_NOTE_HEADING.length;
    const task = (t: Partial<Task>) => ({ start: "sacty", ...t }) as Task;
    const cases: [Task, number][] = [
      [task({ body: "" }), TASK_BODY_MAX - H - 2],
      [task({ body: "あ".repeat(9_000) }), TASK_BODY_MAX - 9_000 - H - 4],
      [task({ body: `依頼\n\n${record}`, rerun: "t0" }), TASK_BODY_MAX - H - 6],
      // 上限ちょうどの説明は、補足を足すと超えるので足せない
      [task({ body: "あ".repeat(TASK_BODY_MAX) }), -H - 4],
    ];
    for (const [t, room] of cases) {
      expect(resumeNoteRoom(t)).toBe(room);
      if (room > 0) {
        expect(
          rerunEditableBody({ ...t, body: bodyWithResumeNote(t, "い".repeat(room)) }).length,
        ).toBe(TASK_BODY_MAX);
      }
    }
  });

  it("補足を足す前から上限を超える説明・再実行できない種類のタスクは、補足の上限だけで確かめる", () => {
    const long = "あ".repeat(TASK_BODY_MAX + 1);
    // 取り込んだ長い Issue（補足が無くても、再実行では説明を直す必要がある）
    expect(resumeNoteRoom({ start: "github_issue", body: long } as Task)).toBe(RESUME_NOTE_MAX);
    // PR のタスク・子タスクは再実行できない
    const full = "あ".repeat(TASK_BODY_MAX);
    expect(resumeNoteRoom({ start: "github_pull_request", body: full } as Task)).toBe(
      RESUME_NOTE_MAX,
    );
    expect(resumeNoteRoom({ start: "sacty", body: full, parent: "p" } as Task)).toBe(
      RESUME_NOTE_MAX,
    );
  });

  it("ふつうのタスクは説明の後に足し、再実行の画面の説明にも残す", () => {
    const body = bodyWithResumeNote({ body: "説明" }, "補足");
    expect(rerunEditableBody({ body })).toBe(body);
  });
});

describe("チケットのトリアージと再開の補足", () => {
  const H = RESUME_NOTE_HEADING;
  const ticketTask = (body: string) =>
    ev(
      "t1",
      {
        type: "TaskCreated",
        payload: {
          title: "PAY-1",
          body,
          start: "jira",
          ticket: {
            platform: "jira",
            service: "jira-server",
            key: "PAY-1",
            url: "https://jira.example.com/browse/PAY-1",
          },
        },
      },
      "person",
    );

  it("人の補足は作業履歴から取り、説明にある補足の見出し（チケットの文）は補足として残さない", () => {
    seq = 0;
    const task = project([
      // チケットの本文に、補足の見出しの行がある
      ticketTask(`チケットの本文\n\n${H}\n\nチケットの文`),
      ev("t1", { type: "TaskPaused", payload: { reason: "error" } }),
      ev("t1", { type: "TaskResumed", payload: { retry: true, note: "人の補足" } }, "person"),
      ev(
        "t1",
        {
          type: "TicketTriaged",
          payload: {
            repo: "https://github.com/acme/app",
            body: `概要\n${H}\n概要に写された見出し`,
            reason: "理由",
          },
        },
        "orchestrator",
      ),
    ]).get("t1");
    expect(task?.resumeNotes).toEqual(["人の補足"]);
    expect(task?.body).toBe(`概要\n概要に写された見出し\n\n${H}\n\n人の補足`);
  });
});
