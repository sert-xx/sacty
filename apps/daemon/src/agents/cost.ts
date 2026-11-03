import { computeCostUsd, type PricePerMTok, type TokenUsage } from "@sacty/core";
import type { AgentConfig } from "../config.js";
import type { AgentOutcome, ModelUsage } from "./parse.js";

/**
 * 実行の費用と、その出どころ（PBI-301）。
 * - reported：エージェントの CLI が報告した実行の費用（Claude Code の total_cost_usd など）をそのまま使った。
 * - converted：使用量を単価で換算した。モデルごとの使用量があれば、そのモデルの単価で換算する（単価が設定に無いモデルは、
 *   工程のエージェントの単価）。
 */
export type RunCost = {
  costUsd: number;
  /** 使用量が無く、費用を持たない実行は undefined。 */
  source: "reported" | "converted" | undefined;
  /** 換算した費用（報告があったときも、設定の単価で換算したらいくらかを、比べるために持つ）。 */
  convertedUsd: number;
  /** モデルごとに換算したときの、設定に単価が無かったモデル（工程のエージェントの単価で換算した）。 */
  unpricedModels: string[];
};

const total = (u: TokenUsage) => u.input + u.cacheRead + u.cacheWrite + u.output;

/** モデルの名前の単価。完全一致、無ければ `[1m]` のような接尾辞を除いた名前。無ければ undefined。 */
export function priceOfModel(agent: AgentConfig, model: string): PricePerMTok | undefined {
  const prices = agent.modelPrices;
  if (!prices) return undefined;
  if (Object.hasOwn(prices, model)) return prices[model];
  const bare = model.replace(/\[[^\]]*\]$/, "");
  return Object.hasOwn(prices, bare) ? prices[bare] : undefined;
}

function plus(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
  };
}

/**
 * 使用量を単価で換算した費用。モデルごとの使用量があれば、モデルごとの単価で換算する。モデルごとの使用量が全体の使用量に
 * 足りない分と、単価が設定に無いモデルは、工程のエージェントの単価で換算する。
 */
function convert(
  agent: AgentConfig,
  usage: TokenUsage,
  models: readonly ModelUsage[] | undefined,
): { usd: number; unpriced: string[] } {
  if (!models || models.length === 0) {
    return { usd: computeCostUsd(usage, agent.price), unpriced: [] };
  }
  let usd = 0;
  let covered: TokenUsage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
  const unpriced: string[] = [];
  for (const { model, usage: used } of models) {
    const price = priceOfModel(agent, model);
    if (!price) unpriced.push(model);
    usd += computeCostUsd(used, price ?? agent.price);
    covered = plus(covered, used);
  }
  // モデルごとの使用量に入っていない分（全体の使用量のほうが大きいとき）は、工程のエージェントの単価で換算する
  const rest: TokenUsage = {
    input: Math.max(0, usage.input - covered.input),
    cacheRead: Math.max(0, usage.cacheRead - covered.cacheRead),
    cacheWrite: Math.max(0, usage.cacheWrite - covered.cacheWrite),
    output: Math.max(0, usage.output - covered.output),
  };
  if (total(rest) > 0) usd += computeCostUsd(rest, agent.price);
  return { usd: Math.round(usd * 1e6) / 1e6, unpriced };
}

/**
 * 実行の結果から、その実行の費用を決める（PBI-301）。CLI が実行の費用を報告していれば、それを実行の費用にする（最後の result
 * の後に始まった番など、報告に入っていない使用量があれば、その分は換算して足す）。報告が無い（またはモデルを使ったのに
 * 0 の報告）ときは、使用量を換算する。
 */
export function runCost(agent: AgentConfig, outcome: AgentOutcome): RunCost {
  const usage = outcome.usage;
  if (!usage) return { costUsd: 0, source: undefined, convertedUsd: 0, unpricedModels: [] };
  const converted = convert(agent, usage, outcome.modelUsages);
  const reported = outcome.reportedCostUsd;
  // 使用量があるのに 0 の報告は、CLI がモデルの単価を知らないなどで、費用を出せなかったもの。換算に任せる
  if (reported === undefined || (reported === 0 && total(usage) > 0)) {
    return {
      costUsd: converted.usd,
      source: "converted",
      convertedUsd: converted.usd,
      unpricedModels: converted.unpriced,
    };
  }
  const extra = outcome.unreportedUsage ? computeCostUsd(outcome.unreportedUsage, agent.price) : 0;
  return {
    costUsd: Math.round((reported + extra) * 1e6) / 1e6,
    source: "reported",
    convertedUsd: converted.usd,
    unpricedModels: converted.unpriced,
  };
}
