import {
  type ActivityEvent,
  addUsd,
  CHARGED_EVENT_TYPES,
  EventInput,
  isChargedEvent,
  project,
  type Task,
} from "@sacty/core";
import { describe, expect, it } from "vitest";
import { stepCosts } from "./step-costs";

/** 決まった種から作る乱数（同じ種なら同じ並びになり、落ちたときに再現できる）。 */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const usage = (input: number, output: number) => ({
  input,
  output,
  cacheRead: 0,
  cacheWrite: 0,
});

/**
 * 無作為に、projection が受け付ける作業履歴を作る。チケットの読み取り・リポジトリの選択・工程の選択の失敗・質問への答え・
 * 工程の実行の失敗と完了・書き出し・変更の申し出の判定・最終レビューの失敗と結果・PR の指摘の戻し先の判定を、
 * 回数と費用（小数第7位まで。丸めの順の違いも確かめる）を変えて混ぜる。
 */
function randomHistory(seed: number, taskId = "t1"): ActivityEvent[] {
  const rand = random(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)] as T;
  const times = (max: number) => Math.floor(rand() * (max + 1));
  const cost = () => (rand() < 0.15 ? 0 : Math.floor(rand() * 5e5) / 1e7);
  const charged = () => ({
    agentId: pick(["orc", "claude", "codex"]),
    usage: usage(times(5000), times(500)),
    costUsd: cost(),
    estimated: rand() < 0.3,
  });
  const events: ActivityEvent[] = [];
  let seq = 0;
  const add = (input: EventInput, actor: ActivityEvent["actor"] = "sacty") => {
    seq += 1;
    events.push({
      ...EventInput.parse(input),
      seq,
      id: `${taskId}-e${seq}`,
      taskId,
      projectId: "default",
      actor,
      at: new Date(Date.UTC(2026, 9, 10, 0, 0, seq)).toISOString(),
    } as ActivityEvent);
  };
  let questions = 0;
  // 質問と答え（工程の状態に関わらず、どこでも挟める）
  const maybeAsk = () => {
    if (rand() < 0.7) return;
    questions += 1;
    const questionId = `Q-${questions}`;
    add({ type: "QuestionAsked", payload: { questionId, text: "いまどこ？" } }, "person");
    const runResult = pick(["completed", "failed", "interrupted"] as const);
    add(
      {
        type: "QuestionAnswered",
        payload: {
          questionId,
          ...(runResult === "completed" ? { answer: "設計です" } : { failed: "失敗" }),
          runResult,
          ...charged(),
        },
      },
      "orchestrator",
    );
  };
  let runs = 0;
  /** 工程を、失敗を何回か挟んでから完了させる。開始の記録が無い完了（古い作業履歴）も混ぜる。 */
  const runStep = (step: "requirements" | "design" | "implement") => {
    for (let i = times(2); i > 0; i -= 1) {
      runs += 1;
      const runId = `r${runs}`;
      add({
        type: "AgentRunStarted",
        payload: { runId, step, agentId: "claude", authMode: "api-key" },
      });
      maybeAsk();
      const { usage: u, ...rest } = charged();
      add({
        type: "AgentRunFailed",
        payload: {
          runId,
          step,
          reason: "error",
          message: "x",
          ...rest,
          ...(rand() < 0.5 ? { usage: u } : {}),
        },
      });
    }
    runs += 1;
    const runId = `r${runs}`;
    add({
      type: "AgentRunStarted",
      payload: { runId, step, agentId: "claude", authMode: "api-key" },
    });
    add({
      type: "AgentRunCompleted",
      payload: { runId, step, authMode: "api-key", output: `# ${step}`, ...charged() },
    });
  };
  const exportOutput = (step: "requirements" | "design") => {
    for (let i = times(2); i > 0; i -= 1) {
      add(
        {
          type: "OutputExported",
          payload: {
            step,
            runId: `x${seq}`,
            approvedAt: "2026-10-10T00:00:00.000Z",
            submission: 1,
            via: "platform",
            name: "wiki",
            runResult: pick(["completed", "failed", "interrupted"] as const),
            ...charged(),
          },
        },
        "agent",
      );
    }
  };

  const kind = pick(["plain", "ticket", "repoless"] as const);
  add(
    {
      type: "TaskCreated",
      payload: {
        title: "t",
        body: "",
        start: kind === "ticket" ? "jira" : "sacty",
        ...(kind === "ticket"
          ? {
              ticket: {
                platform: "jira",
                service: "jira-cloud",
                key: "ACME-1",
                url: "https://jira.example.com/browse/ACME-1",
              },
            }
          : {}),
        ...(kind === "repoless" ? { noRepo: true } : {}),
      },
    },
    "person",
  );
  for (let i = times(2); i > 0; i -= 1) {
    add(
      {
        type: "OrchestratorFailed",
        payload: { reason: "error", message: "失敗", ...charged() },
      },
      "orchestrator",
    );
  }
  maybeAsk();
  // 人が選んだときは費用が無い（actor は person）
  const byPerson = rand() < 0.3;
  if (kind === "ticket") {
    add(
      {
        type: "TicketTriaged",
        payload: {
          repo: "https://github.com/acme/app",
          reason: "理由",
          ...(byPerson ? {} : { title: "題", ...charged() }),
        },
      },
      byPerson ? "person" : "orchestrator",
    );
  }
  if (kind === "repoless") {
    add(
      {
        type: "RepositoryChosen",
        payload: {
          repo: "https://github.com/acme/app",
          reason: "理由",
          ...(byPerson ? {} : charged()),
        },
      },
      byPerson ? "person" : "orchestrator",
    );
  }
  add(
    {
      type: "StepsChosen",
      payload: {
        steps: ["requirements", "design", "implement", "pr"],
        plan: "standard",
        reason: "理由",
        ...charged(),
      },
    },
    "orchestrator",
  );
  // 作業履歴の途中で終わるタスクも作る（どこで切れても、表の合計とタスクの費用は一致する）
  const end = pick([1, 2, 3, 4, 5] as const);

  runStep("requirements");
  maybeAsk();
  add({ type: "StepSubmitted", payload: { step: "requirements", submission: 1 } });
  add({ type: "StepApproved", payload: { step: "requirements", next: "queued" } }, "person");
  exportOutput("requirements");
  if (end === 1) return events;

  runStep("design");
  for (let i = times(2); i > 0; i -= 1) {
    const proposalId = `CP-${i}`;
    add(
      {
        type: "ChangeProposed",
        payload: {
          proposalId,
          fromStep: "design",
          target: "requirements",
          reason: "r",
          facts: ["f"],
          proposed: "p",
        },
      },
      "agent",
    );
    add(
      {
        type: "ChangeJudged",
        payload: {
          proposalId,
          verdict: "rejected",
          reason: "理由",
          runResult: pick(["completed", "failed", "interrupted"] as const),
          ...charged(),
        },
      },
      "guardian",
    );
  }
  add({ type: "StepSubmitted", payload: { step: "design", submission: 1 } });
  add({ type: "StepApproved", payload: { step: "design", next: "queued" } }, "person");
  exportOutput("design");
  if (end === 2) return events;

  runStep("implement");
  add({
    type: "TestsRun",
    payload: {
      command: "npm test",
      exitCode: 0,
      unmappedViewpoints: [],
      passed: true,
      output: "",
      durationMs: 1,
    },
  });
  for (let i = times(2); i > 0; i -= 1) {
    add(
      {
        type: "FinalReviewFailed",
        payload: { reason: "error", message: "失敗", ...charged() },
      },
      "guardian",
    );
  }
  if (end === 3) return events;
  add(
    {
      type: "FinalReviewed",
      payload: { passed: true, viewpoints: [], remarks: [], summary: "よい", ...charged() },
    },
    "guardian",
  );
  maybeAsk();
  if (end === 4) return events;

  add({
    type: "PullRequestPublished",
    payload: {
      branch: "sacty/t1",
      commit: "c1",
      url: "https://github.com/acme/app/pull/7",
      number: 7,
    },
  });
  add({ type: "StepSubmitted", payload: { step: "pr", submission: 1 } });
  // PR がマージされ、マージの後のデプロイの確認を実行した（PBI-89）
  if (rand() < 0.5) {
    add({ type: "PullRequestMerged", payload: { number: 7, commit: "c1" } }, "person");
    add({ type: "StepApproved", payload: { step: "pr", next: "idle" } }, "person");
    add({
      type: "DeploymentWatchStarted",
      payload: { number: 7, repo: "https://github.com/acme/app", branch: "main", commit: "m1" },
    });
    add({
      type: "DeploymentCiFinished",
      payload: { result: "passed", skill: ".agents/skills/deployment-observer/SKILL.md" },
    });
    add({
      type: "DeploymentCheckStarted",
      payload: { runId: "dc1", skill: ".agents/skills/deployment-observer/SKILL.md" },
    });
    const runResult = pick(["completed", "failed", "interrupted"] as const);
    add(
      {
        type: "DeploymentChecked",
        payload: {
          result: runResult === "completed" ? pick(["healthy", "unhealthy"] as const) : "unknown",
          runResult,
          runId: "dc1",
          ...charged(),
        },
      },
      "agent",
    );
    return events;
  }
  add({
    type: "PullRequestReviewImported",
    payload: {
      number: 7,
      items: [{ key: "k1", author: "alice", at: "2026-10-10T00:00:00.000Z" }],
      remarks: ["直して"],
    },
  });
  add(
    {
      type: "ReworkJudged",
      payload: { target: "implement", reason: "理由", runResult: "completed", ...charged() },
    },
    "guardian",
  );
  return events;
}

function taskOf(events: ActivityEvent[], taskId = "t1"): Task {
  const task = project(events).get(taskId);
  if (!task) throw new Error("no task");
  return task;
}

describe("工程ごとの費用の表の合計とタスクの費用（PBI-86）", () => {
  it("無作為に作った作業履歴で、表の合計がタスクの費用（projection）と一致し、行の合計とも一致する。費用を持つ種類をすべて通る", () => {
    const seen = new Set<string>();
    for (let seed = 1; seed <= 300; seed += 1) {
      const events = randomHistory(seed);
      // 別のタスクの記録は数えない
      const other = randomHistory(seed + 10_000, "t2");
      const task = taskOf(events);
      const { rows, total } = stepCosts(task, [...other, ...events]);
      for (const e of events) if (isChargedEvent(e)) seen.add(e.type);
      expect({ seed, usedUsd: total.costUsd }).toEqual({ seed, usedUsd: task.budget.usedUsd });
      expect({ seed, estimated: total.estimated }).toEqual({
        seed,
        estimated: task.budget.estimated,
      });
      // 行の費用の合計（丸めの順が違うので、100万分の1ドルの桁まで）
      const rowSum = rows.reduce((sum, r) => addUsd(sum, r.costUsd), 0);
      expect(Math.abs(rowSum - task.budget.usedUsd)).toBeLessThan(1e-5);
      // 費用のある記録は、どれかの行に入っている
      const counted = rows.flatMap((r) => r.runs).filter((r) => r.costUsd > 0).length;
      const charged = events.filter((e) => isChargedEvent(e) && e.payload.costUsd > 0).length;
      expect({ seed, counted }).toEqual({ seed, counted: charged });
    }
    expect([...seen].sort()).toEqual([...CHARGED_EVENT_TYPES].sort());
  });

  const ticketEvents = () =>
    randomHistoryWith((e) => e.type === "TaskCreated" && e.payload.ticket !== undefined);
  const repolessEvents = () =>
    randomHistoryWith((e) => e.type === "TaskCreated" && e.payload.noRepo === true);
  /** 条件に合う最初のタスクの作業履歴（オーケストレーターが決め、費用のあるもの）。 */
  function randomHistoryWith(created: (e: ActivityEvent) => boolean) {
    for (let seed = 1; ; seed += 1) {
      const events = randomHistory(seed);
      const decided = events.find(
        (e) => e.type === "TicketTriaged" || e.type === "RepositoryChosen",
      );
      if (
        events[0] &&
        created(events[0]) &&
        decided?.actor === "orchestrator" &&
        isChargedEvent(decided) &&
        decided.payload.costUsd > 0
      ) {
        return events;
      }
    }
  }

  it("チケットの読み取りの費用を「チケットの読み取り」の行に、工程の選択より前に出す", () => {
    const events = ticketEvents();
    const task = taskOf(events);
    const { rows, total } = stepCosts(task, events);
    const triaged = events.find((e) => e.type === "TicketTriaged");
    if (triaged?.type !== "TicketTriaged") throw new Error("no triage");
    expect(rows[0]?.role).toBe("triage");
    expect(rows[0]?.runs).toEqual([
      expect.objectContaining({
        id: triaged.id,
        costUsd: triaged.payload.costUsd,
        result: "completed",
      }),
    ]);
    expect(rows[1]?.role).toBe("orchestrator");
    expect(total.costUsd).toBe(task.budget.usedUsd);
  });

  it("リポジトリの選択の費用を「リポジトリの選択」の行に、工程の選択より前に出す", () => {
    const events = repolessEvents();
    const task = taskOf(events);
    const { rows, total } = stepCosts(task, events);
    const chosen = events.find((e) => e.type === "RepositoryChosen");
    if (chosen?.type !== "RepositoryChosen") throw new Error("no choice");
    expect(rows[0]?.role).toBe("repository");
    expect(rows[0]?.runs.map((r) => [r.id, r.costUsd])).toEqual([
      [chosen.id, chosen.payload.costUsd],
    ]);
    expect(rows[1]?.role).toBe("orchestrator");
    expect(total.costUsd).toBe(task.budget.usedUsd);
  });

  it("人が選んだチケットの読み取り・リポジトリの選択（費用もエージェントも無い）は、実行に数えず行を出さない", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const events = randomHistory(seed);
      const decided = events.find(
        (e) => e.type === "TicketTriaged" || e.type === "RepositoryChosen",
      );
      if (decided?.actor !== "person") continue;
      const task = taskOf(events);
      const { rows, total } = stepCosts(task, events);
      expect(rows.map((r) => r.role)).not.toContain("triage");
      expect(rows.map((r) => r.role)).not.toContain("repository");
      expect(total.costUsd).toBe(task.budget.usedUsd);
    }
  });
});
