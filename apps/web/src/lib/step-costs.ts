import {
  type ActivityEvent,
  type AuthMode,
  addUsd,
  type ChargedEvent,
  chargeBudget,
  type DaemonText,
  type GuardianRunResult,
  isChargedEvent,
  type StepKey,
  type Task,
  type TokenUsage,
} from "@sacty/core";

/**
 * 費用の表の行。工程と、工程の外の費用：チケットの読み取り（オーケストレーター。PBI-52）・作業するリポジトリの選択
 * （オーケストレーター。PBI-73）・オーケストレーター（工程の選択）・質問への答え（オーケストレーター。PBI-54）・
 * 承認した成果の書き出し（PBI-56）・ゴールガーディアン（判定・最終レビュー）。マージの後のデプロイの確認は、マージの後の
 * 監視の工程（deployment）の行（PBI-116）。
 */
export type CostRole =
  | StepKey
  | "triage"
  | "repository"
  | "orchestrator"
  | "chat"
  | "export"
  | "guardian";

/** 工程の外の行（表に出す順）。 */
const OUTSIDE_BEFORE = ["triage", "repository", "orchestrator"] as const;
const OUTSIDE_AFTER = ["export", "chat", "guardian"] as const;
const OUTSIDE: readonly CostRole[] = [...OUTSIDE_BEFORE, ...OUTSIDE_AFTER];

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
  result: "completed" | "failed" | "interrupted" | "running";
};

export type CostRow = {
  role: CostRole;
  runs: CostRun[];
  /** 使用量の合計。使用量の記録がある実行が無ければ持たない。 */
  usage?: TokenUsage;
  costUsd: number;
  estimated: boolean;
};

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

/** オーケストレーターなどを動かさず、人や sacty が決めた記録（費用・使用量・エージェントが無い）。実行に数えない。 */
function notRun(payload: { agentId?: string; costUsd: number; usage?: TokenUsage }): boolean {
  return payload.agentId === undefined && payload.costUsd === 0 && !payload.usage;
}

/**
 * 工程ごとの、エージェント・設定・使用量・費用（PBI-46）。作業履歴から、タスクの予算に入れる費用を持つイベント
 * （@sacty/core の CHARGED_EVENT_TYPES）をすべて行に振り分ける。工程に属さない費用（チケットの読み取り・
 * リポジトリの選択・工程の選択・質問への答え・書き出し・ゴールガーディアン）は、それぞれの行に出す。
 * 合計の費用は、projection と同じ規則（chargeBudget）で作業履歴の順に足すので、タスクの費用（task.budget）と一致する（PBI-86）。
 * 工程の行はタスクの工程の順にすべて出し（まだ動かしていない工程は実行0回）、工程の外の行は記録があるときだけ出す。
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
  // タスクの費用と同じ規則で足した合計
  let budget = { usedUsd: 0, estimated: false };

  /** 費用を持つイベントを、行に振り分ける。費用を持つ種類を足したら、ここで行を決めないと typecheck で落ちる。 */
  const place = (event: ChargedEvent) => {
    switch (event.type) {
      // チケットから作業するリポジトリ・題・概要を決めた（PBI-52）
      case "TicketTriaged":
        if (!notRun(event.payload)) push("triage", runOf(event, event.payload, "completed"));
        return;
      // リポジトリの無いタスクの、作業するリポジトリを選んだ（PBI-73）
      case "RepositoryChosen":
        if (!notRun(event.payload)) push("repository", runOf(event, event.payload, "completed"));
        return;
      case "StepsChosen":
        // 固定の工程だった作業履歴（PBI-17 より前）は、オーケストレーターを動かしていない
        if (!notRun(event.payload)) push("orchestrator", runOf(event, event.payload, "completed"));
        return;
      case "OrchestratorFailed":
        push("orchestrator", runOf(event, event.payload, "failed"));
        return;
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
          return;
        }
        started.delete(p.runId);
        Object.assign(run, {
          ...(p.usage ? { usage: p.usage } : {}),
          ...(!run.authMode && "authMode" in p ? { authMode: p.authMode } : {}),
          costUsd: p.costUsd,
          estimated: p.estimated,
          result,
        });
        return;
      }
      case "ChangeJudged":
      case "ReworkJudged":
        // 実行に失敗・中断したときも、判定の記録として残る。実行の結果で分ける
        push("guardian", runOf(event, event.payload, guardianRunResult(event.payload)));
        return;
      case "FinalReviewed":
        push("guardian", runOf(event, event.payload, "completed"));
        return;
      case "FinalReviewFailed":
        push("guardian", runOf(event, event.payload, "failed"));
        return;
      // タスクの詳細での質問への答え（PBI-54）
      case "QuestionAnswered":
        push("chat", runOf(event, event.payload, event.payload.runResult));
        return;
      // 承認した成果の書き出し（PBI-56）
      case "OutputExported":
        push("export", runOf(event, event.payload, event.payload.runResult));
        return;
      // マージの後のデプロイの確認（PBI-89）。マージの後の監視の工程の行（PBI-116。工程の無い以前のタスクでも、
      // 工程の一覧に無い工程の行として出す）
      case "DeploymentChecked": {
        const p = event.payload;
        const run = p.runId ? started.get(p.runId) : undefined;
        if (!run || !p.runId) {
          push("deployment", runOf(event, p, p.runResult));
          return;
        }
        started.delete(p.runId);
        Object.assign(run, {
          ...(p.usage ? { usage: p.usage } : {}),
          ...(p.authMode ? { authMode: p.authMode } : {}),
          ...(p.model ? { model: p.model } : {}),
          ...(p.reasoningEffort ? { reasoningEffort: p.reasoningEffort } : {}),
          agentId: p.agentId,
          costUsd: p.costUsd,
          estimated: p.estimated,
          result: p.runResult,
        });
        return;
      }
      default:
        return event satisfies never;
    }
  };

  for (const event of activity) {
    if (event.taskId !== task.id) continue;
    if (event.type === "AgentRunStarted") {
      const run = runOf(event, { ...event.payload, costUsd: 0, estimated: false }, "running");
      started.set(event.payload.runId, run);
      push(event.payload.step, run);
      continue;
    }
    // デプロイの確認を始めた（PBI-116。結果の記録で、使用量と費用を埋める。ほかの工程の実行と同じく、実行中を出す）
    if (event.type === "DeploymentCheckStarted") {
      const run: CostRun = {
        id: event.id,
        at: event.at,
        costUsd: 0,
        estimated: false,
        result: "running",
      };
      started.set(event.payload.runId, run);
      push("deployment", run);
      continue;
    }
    if (!isChargedEvent(event)) continue;
    budget = chargeBudget(budget, event);
    place(event);
  }

  const stepKeys = task.steps.map((s) => s.key);
  const roles: CostRole[] = [
    ...OUTSIDE_BEFORE.filter((role) => runs.has(role)),
    ...stepKeys,
    // 工程の一覧に無い工程の記録（作業履歴の不整合）も、費用を落とさない
    ...[...runs.keys()].filter(
      (role): role is StepKey => !OUTSIDE.includes(role) && !stepKeys.includes(role as StepKey),
    ),
    ...OUTSIDE_AFTER.filter((role) => runs.has(role)),
  ];
  const rows: CostRow[] = roles.map((role) => summarize({ role, runs: runs.get(role) ?? [] }));
  const total = summarize({ runs: rows.flatMap((r) => r.runs) });
  return {
    rows,
    total: { usage: total.usage, costUsd: budget.usedUsd, estimated: budget.estimated },
  };
}

/**
 * ゴールガーディアンの判定の記録から、実行の結果を出す（PBI-46）。以前の作業履歴（runResult が無い）は、
 * sacty が書いた失敗・中断の理由の文言で判別する（それ以外は、ゴールガーディアンが実行して書いた理由）。
 */
function guardianRunResult(payload: {
  runResult?: GuardianRunResult;
  reason: DaemonText;
}): CostRun["result"] {
  if (payload.runResult) return payload.runResult;
  if (typeof payload.reason !== "string") {
    if (payload.reason.code === "run.guardianFailed") return "failed";
    if (payload.reason.code === "run.guardianInterrupted") return "interrupted";
  }
  return "completed";
}
