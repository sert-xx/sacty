import type { ActivityEvent, AuthMode, StepKey, Task, TokenUsage } from "@sacty/core";

/** 費用の表の行。工程と、オーケストレーター（工程の選択）・ゴールガーディアン（判定・最終レビュー）。 */
export type CostRole = StepKey | "orchestrator" | "guardian";

/** 1回の実行。作業履歴に記録が無い項目（PBI-46 より前のモデル・エフォートなど）は持たない。 */
export type CostRun = {
  /** 実行を記録したイベント（開始の記録があれば、その ID）。 */
  id: string;
  at: string;
  agentId?: string;
  authMode?: AuthMode;
  model?: string;
  reasoningEffort?: string;
  usage?: TokenUsage;
  costUsd: number;
  /** 換算した値（サブスクリプションなど）で、実際の請求ではない。 */
  estimated: boolean;
  /** running：開始の記録だけがある（実行中）。 */
  result: "completed" | "failed" | "running";
};

export type CostRow = {
  role: CostRole;
  runs: CostRun[];
  /** 使用量の合計。使用量の記録がある実行が無ければ持たない。 */
  usage?: TokenUsage;
  costUsd: number;
  estimated: boolean;
};

/** 浮動小数の誤差を、タスクの予算（projection の addUsd）と同じ桁で丸める。 */
function addUsd(a: number, b: number): number {
  return Math.round((a + b) * 1e6) / 1e6;
}

function addUsage(a: TokenUsage | undefined, b: TokenUsage | undefined): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

function summarize<T extends { runs: CostRun[] }>(row: T) {
  return {
    ...row,
    usage: row.runs.reduce<TokenUsage | undefined>((sum, r) => addUsage(sum, r.usage), undefined),
    costUsd: row.runs.reduce((sum, r) => addUsd(sum, r.costUsd), 0),
    estimated: row.runs.some((r) => r.estimated),
  };
}

/** 記録された費用の項目（費用を記録するイベントに共通）から、1回の実行を作る。 */
function runOf(
  event: ActivityEvent,
  payload: {
    agentId?: string;
    authMode?: AuthMode;
    model?: string;
    reasoningEffort?: string;
    usage?: TokenUsage;
    costUsd: number;
    estimated: boolean;
  },
  result: CostRun["result"],
): CostRun {
  return {
    id: event.id,
    at: event.at,
    ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
    ...(payload.authMode ? { authMode: payload.authMode } : {}),
    ...(payload.model ? { model: payload.model } : {}),
    ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
    ...(payload.usage ? { usage: payload.usage } : {}),
    costUsd: payload.costUsd,
    estimated: payload.estimated,
    result,
  };
}

/**
 * 工程ごとの、エージェント・設定・使用量・費用（PBI-46）。作業履歴から、タスクの予算に入れた費用の記録
 * （projection で usedUsd に足すイベント）をすべて行に振り分けるので、行の費用の合計はタスクの費用と一致する。
 * 工程の行はタスクの工程の順にすべて出し（まだ動かしていない工程は実行0回）、オーケストレーター・
 * ゴールガーディアンの行は記録があるときだけ出す。
 */
export function stepCosts(task: Task, activity: readonly ActivityEvent[]) {
  const runs = new Map<CostRole, CostRun[]>();
  const push = (role: CostRole, run: CostRun) => {
    const list = runs.get(role);
    if (list) list.push(run);
    else runs.set(role, [run]);
  };
  // 開始した実行（終わりの記録で、使用量と費用を埋める）
  const started = new Map<string, CostRun>();

  for (const event of activity) {
    if (event.taskId !== task.id) continue;
    switch (event.type) {
      case "StepsChosen": {
        const p = event.payload;
        // 固定の工程だった作業履歴（PBI-17 より前）は、オーケストレーターを動かしていない
        if (p.agentId === undefined && p.costUsd === 0 && !p.usage) break;
        push("orchestrator", runOf(event, p, "completed"));
        break;
      }
      case "OrchestratorFailed":
        push("orchestrator", runOf(event, event.payload, "failed"));
        break;
      case "AgentRunStarted": {
        const run = runOf(event, { ...event.payload, costUsd: 0, estimated: false }, "running");
        started.set(event.payload.runId, run);
        push(event.payload.step, run);
        break;
      }
      case "AgentRunCompleted":
      case "AgentRunFailed": {
        const p = event.payload;
        const run = started.get(p.runId);
        const result = event.type === "AgentRunCompleted" ? "completed" : "failed";
        if (!run) {
          // 開始の記録が無い実行も、費用を落とさない
          push(
            p.step,
            runOf(event, { ...p, authMode: "authMode" in p ? p.authMode : undefined }, result),
          );
          break;
        }
        started.delete(p.runId);
        Object.assign(run, {
          ...(p.usage ? { usage: p.usage } : {}),
          ...(!run.authMode && "authMode" in p ? { authMode: p.authMode } : {}),
          costUsd: p.costUsd,
          estimated: p.estimated,
          result,
        });
        break;
      }
      case "ChangeJudged":
      case "FinalReviewed":
      case "ReworkJudged":
        push("guardian", runOf(event, event.payload, "completed"));
        break;
      case "FinalReviewFailed":
        push("guardian", runOf(event, event.payload, "failed"));
        break;
    }
  }

  const stepKeys = task.steps.map((s) => s.key);
  const roles: CostRole[] = [
    ...(runs.has("orchestrator") ? ["orchestrator" as const] : []),
    ...stepKeys,
    // 工程の一覧に無い工程の記録（作業履歴の不整合）も、費用を落とさない
    ...[...runs.keys()].filter(
      (role): role is StepKey =>
        role !== "orchestrator" && role !== "guardian" && !stepKeys.includes(role),
    ),
    ...(runs.has("guardian") ? ["guardian" as const] : []),
  ];
  const rows: CostRow[] = roles.map((role) => summarize({ role, runs: runs.get(role) ?? [] }));
  const total = summarize({ runs: rows.flatMap((r) => r.runs) });
  return {
    rows,
    total: { usage: total.usage, costUsd: total.costUsd, estimated: total.estimated },
  };
}
