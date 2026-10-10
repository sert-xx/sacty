import { z } from "zod";
import { BUDGET_WARN_RATIO, type TokenUsage } from "./events.js";
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
