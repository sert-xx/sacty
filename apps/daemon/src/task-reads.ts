import { type ActivityEvent, ERROR_ANALYSIS_ROLE, runLogId, StepKey, type Task } from "@sacty/core";

/**
 * タスクの成果物と実行の、読み取り用の取り出し（PBI-395。`sacty mcp` が読む）。メモリーにあるタスクと作業履歴から求める
 * だけで、何も記録しない。
 */

export const DELIVERABLE_KINDS = [
  "output",
  "test_viewpoints",
  "sacty_version",
  "review_comments",
] as const;
export type DeliverableKind = (typeof DELIVERABLE_KINDS)[number];

export const DELIVERABLE_STATUSES = [
  "approved",
  "posted",
  "awaiting_approval",
  "not_submitted",
  "changes_requested",
  "none",
] as const;
export type DeliverableStatus = (typeof DELIVERABLE_STATUSES)[number];

/** 工程の候補（画面の工程の名前と同じ）。 */
export const DELIVERABLE_STEPS: readonly string[] = StepKey.options;

export function isDeliverableStep(value: string): value is StepKey {
  return DELIVERABLE_STEPS.includes(value);
}

export function isDeliverableKind(value: string): value is DeliverableKind {
  return (DELIVERABLE_KINDS as readonly string[]).includes(value);
}

export type DeliverableState = {
  status: DeliverableStatus;
  /** 提出の回。まだ提出していない出力は null。 */
  submission: number | null;
  /** まだ提出していない出力のときの、前の提出の回（無ければ null）。 */
  previousSubmission: number | null;
};

const lastIndex = (
  activity: readonly ActivityEvent[],
  match: (event: ActivityEvent) => boolean,
): number => activity.findLastIndex(match);

/** 工程の成果物の状態。上の行から順に当て、最初に合ったものにする。 */
export function stepState(
  task: Task,
  activity: readonly ActivityEvent[],
  step: StepKey,
): DeliverableState {
  const approved = Object.hasOwn(task.approved, step) ? task.approved[step] : undefined;
  if (approved) {
    return { status: "approved", submission: approved.submission, previousSubmission: null };
  }
  if (step === "review") {
    const round = task.reviewRound ?? 1;
    if (task.reviewPost) {
      return { status: "posted", submission: round, previousSubmission: null };
    }
    return {
      status: "not_submitted",
      submission: null,
      previousSubmission: round - 1 >= 1 ? round - 1 : null,
    };
  }
  if (task.gate?.step === step) {
    return {
      status: "awaiting_approval",
      submission: task.gate.submission,
      previousSubmission: null,
    };
  }
  const completed = lastIndex(
    activity,
    (e) => e.type === "AgentRunCompleted" && e.payload.step === step,
  );
  const submitted = lastIndex(
    activity,
    (e) => e.type === "StepSubmitted" && e.payload.step === step,
  );
  if (completed > submitted) {
    return {
      status: "not_submitted",
      submission: null,
      previousSubmission: task.submissions[step] ?? null,
    };
  }
  return {
    status: "changes_requested",
    submission: task.submissions[step] ?? null,
    previousSubmission: null,
  };
}

/** 成果物の本文。無ければ空。 */
function deliverableText(task: Task, step: StepKey, kind: DeliverableKind): string {
  const approved = Object.hasOwn(task.approved, step) ? task.approved[step] : undefined;
  switch (kind) {
    case "output":
      return approved?.output ?? task.outputs[step] ?? "";
    case "test_viewpoints": {
      if (step !== "design") return "";
      const list =
        approved && approved.testViewpoints.length > 0
          ? approved.testViewpoints
          : task.testViewpoints;
      return list.length > 0 ? JSON.stringify(list, null, 2) : "";
    }
    case "sacty_version":
      return approved?.edited?.sacty ?? "";
    case "review_comments":
      return step === "review"
        ? task.reviewComments.map((c) => `${c.path}:${c.line}\n${c.body}`).join("\n\n")
        : "";
  }
}

export type DeliverableRead = DeliverableState & { text: string };

/** 工程・種類を指定した成果物。本文が無ければ status は none。 */
export function readDeliverable(
  task: Task,
  activity: readonly ActivityEvent[],
  step: StepKey,
  kind: DeliverableKind,
): DeliverableRead {
  const text = deliverableText(task, step, kind);
  if (text === "") return { status: "none", submission: null, previousSubmission: null, text };
  return { ...stepState(task, activity, step), text };
}

export type DeliverableListing = DeliverableState & {
  step: StepKey;
  kind: DeliverableKind;
  /** 本文の大きさ（UTF-8 のバイト）。 */
  bytes: number;
};

/** 成果物がある（本文が空でない）工程・種類の一覧。タスクの工程の順に、続けて残りの工程。 */
export function listDeliverables(
  task: Task,
  activity: readonly ActivityEvent[],
): DeliverableListing[] {
  const own = task.steps.map((s) => s.key);
  const steps = [...own, ...StepKey.options.filter((s) => !own.includes(s))];
  const found: DeliverableListing[] = [];
  for (const step of steps) {
    for (const kind of DELIVERABLE_KINDS) {
      const read = readDeliverable(task, activity, step, kind);
      if (read.status === "none") continue;
      const { text, ...state } = read;
      found.push({ step, kind, ...state, bytes: Buffer.byteLength(text, "utf8") });
    }
  }
  return found;
}

export type RunEntry = {
  runId: string;
  /** 作業履歴から決めた役割（決められなければ null）。 */
  role: string | null;
  agentId: string | null;
  startedAt: string | null;
  /** 作業履歴から決めた状態（記録が無ければ unknown）。 */
  historyState: "succeeded" | "failed" | "unknown";
  fallback: { from: string; to: string } | null;
};

const ORCHESTRATOR_EVENTS = new Set<string>([
  "StepsChosen",
  "StepsSkipped",
  "OrchestratorFailed",
  "TicketTriaged",
  "RepositoryChosen",
  "ChangeJudged",
  "ReworkJudged",
  "OrchestratorSessionUsed",
]);

function roleOf(event: ActivityEvent): string | null {
  const payload = event.payload as { step?: unknown; role?: unknown };
  if (event.type.startsWith("AgentRun")) {
    return typeof payload.step === "string" ? payload.step : null;
  }
  if (event.type === "AgentSessionArchived") {
    return typeof payload.role === "string" ? payload.role : null;
  }
  if (ORCHESTRATOR_EVENTS.has(event.type)) return "orchestrator";
  if (event.type === "InformationGathered") return "gather";
  if (event.type === "FinalReviewed" || event.type === "FinalReviewFailed") return "guardian";
  if (event.type === "QuestionAnswered") return "chat";
  if (event.type === "ErrorAnalyzed") return ERROR_ANALYSIS_ROLE;
  if (event.type === "ExportStarted" || event.type === "OutputExported") return "export";
  if (event.type.startsWith("Audit")) return "audit";
  return null;
}

/**
 * 作業履歴の全件から、ログを見られる実行を拾う（画面と同じ規則。runLogId）。新しい順（最初に現れた順の逆）。
 * 別のエージェントへの切り替え（fallback）も、ページに切る前の全件から決める：失敗した実行は AgentFellBack の runId、
 * 代わりに動いた実行は、その後に最初に現れた、役割が同じで agentId が切り替え先の別の実行。
 */
export function runEntries(activity: readonly ActivityEvent[]): RunEntry[] {
  const order: string[] = [];
  const found = new Map<
    string,
    {
      first: number;
      role: string | null;
      agentId: string | null;
      startedAt: string;
      state: RunEntry["historyState"];
    }
  >();
  activity.forEach((event, index) => {
    const runId = runLogId(event);
    if (runId === undefined) return;
    let entry = found.get(runId);
    if (!entry) {
      const agentId = (event.payload as { agentId?: unknown }).agentId;
      entry = {
        first: index,
        role: roleOf(event),
        agentId: typeof agentId === "string" && agentId ? agentId : null,
        startedAt: event.at,
        state: "unknown",
      };
      found.set(runId, entry);
      order.push(runId);
    }
    if (event.type === "AgentRunCompleted") entry.state = "succeeded";
    if (event.type === "AgentRunFailed") entry.state = "failed";
  });
  const fallbacks = new Map<string, { from: string; to: string }>();
  activity.forEach((event, index) => {
    if (event.type !== "AgentFellBack") return;
    const p = event.payload;
    const pair = { from: p.agentId, to: p.fallbackAgentId };
    fallbacks.set(p.runId, pair);
    const replacement = order.find((id) => {
      const e = found.get(id);
      return (
        e !== undefined &&
        e.first > index &&
        id !== p.runId &&
        e.role === p.role &&
        e.agentId === p.fallbackAgentId
      );
    });
    if (replacement !== undefined) fallbacks.set(replacement, pair);
  });
  return order
    .map((runId): RunEntry => {
      const e = found.get(runId) as NonNullable<ReturnType<typeof found.get>>;
      return {
        runId,
        role: e.role,
        agentId: e.agentId,
        startedAt: e.startedAt,
        historyState: e.state,
        fallback: fallbacks.get(runId) ?? null,
      };
    })
    .reverse();
}
