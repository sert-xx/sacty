import { z } from "zod";
import { type ActivityEvent, BUDGET_WARN_RATIO, type TokenUsage } from "./events.js";
import type { Task } from "./projection.js";

/** 100万トークンあたりの単価（米ドル）。キャッシュ書き込みはClaudeのみ。 */
export const PricePerMTok = z.object({
  input: z.number().nonnegative(),
  cachedInput: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative().default(0),
  output: z.number().nonnegative(),
});
export type PricePerMTok = z.infer<typeof PricePerMTok>;

/** 使用量と単価から費用を計算する。 */
export function computeCostUsd(usage: TokenUsage, price: PricePerMTok): number {
  const micro =
    usage.input * price.input +
    usage.cacheRead * price.cachedInput +
    usage.cacheWrite * price.cacheWrite +
    usage.output * price.output;
  return Math.round(micro) / 1e6;
}

/**
 * 金額の表示。$1未満は小数第4位まで出す（$0.0105 を $0.01 と丸めると、
 * 「使用済みより大きい上限」の判断を利用者が誤るため）。
 */
export function formatUsd(value: number): string {
  return `$${value < 1 ? value.toFixed(4) : value.toFixed(2)}`;
}

export type BudgetState = "ok" | "warn" | "exceeded";

/** 予算の状態。上限に達していれば exceeded、80%以上で未通知なら warn。 */
export function budgetState(budget: Task["budget"]): BudgetState {
  if (budget.usedUsd >= budget.capUsd) return "exceeded";
  if (!budget.warned && budget.usedUsd >= budget.capUsd * BUDGET_WARN_RATIO) return "warn";
  return "ok";
}

/**
 * タスクの予算（使用済み）に入れる費用を持つイベントの種類（PBI-86）。projection（タスクの費用）と、画面の工程ごとの
 * 費用の表は、どちらもこの一覧と chargeBudget で費用を足す（同じ規則で集計し、表の合計とタスクの費用をずらさない）。
 */
export const CHARGED_EVENT_TYPES = [
  "StepsChosen",
  "StepsSkipped",
  "OrchestratorFailed",
  "InformationGathered",
  "TicketTriaged",
  "RepositoryChosen",
  "AgentRunCompleted",
  "AgentRunFailed",
  "ChangeJudged",
  "ReworkJudged",
  "FinalReviewed",
  "FinalReviewFailed",
  "QuestionAnswered",
  "OutputExported",
  "DeploymentChecked",
] as const satisfies readonly ActivityEvent["type"][];

export type ChargedEventType = (typeof CHARGED_EVENT_TYPES)[number];
export type ChargedEvent = Extract<ActivityEvent, { type: ChargedEventType }>;

// 費用（costUsd）を持つイベントの種類が、すべて一覧にあることを型で確かめる（足し忘れると typecheck で落ちる）
type CostCarrying = Extract<ActivityEvent, { payload: { costUsd: number } }>["type"];
const _allCharged: Exclude<CostCarrying, ChargedEventType> extends never ? true : never = true;
void _allCharged;

const CHARGED = new Set<string>(CHARGED_EVENT_TYPES);

/** タスクの予算に入れる費用を持つイベントか（PBI-86）。 */
export function isChargedEvent(event: ActivityEvent): event is ChargedEvent {
  return CHARGED.has(event.type);
}

/** 浮動小数の誤差を、費用の表示や比較に影響しない桁（100万分の1ドル）で丸めて足す。 */
export function addUsd(a: number, b: number): number {
  return Math.round((a + b) * 1e6) / 1e6;
}

/**
 * イベントの費用を、予算の使用済みに足す（PBI-86）。費用を持たないイベントなら、そのまま返す。作業履歴の順に
 * 足していけば、projection のタスクの費用（task.budget.usedUsd・estimated）と同じ値になる。
 */
export function chargeBudget<B extends { usedUsd: number; estimated: boolean }>(
  budget: B,
  event: ActivityEvent,
): B {
  if (!isChargedEvent(event)) return budget;
  return {
    ...budget,
    usedUsd: addUsd(budget.usedUsd, event.payload.costUsd),
    estimated: budget.estimated || event.payload.estimated,
  };
}
