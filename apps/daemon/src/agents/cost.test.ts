import type { PricePerMTok } from "@sacty/core";
import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../config.js";
import { priceOfModel, runCost } from "./cost.js";
import { ClaudeOutcomeReader } from "./parse.js";

// 実行の費用は、CLI が報告した額を使う。報告が無ければ、モデルごとの使用量をそのモデルの単価で換算する（PBI-301）

const price = (input: number, output: number, cachedInput = 0, cacheWrite = 0): PricePerMTok => ({
  input,
  output,
  cachedInput,
  cacheWrite,
});
const OPUS = price(5, 25, 0.25, 6.25);
const SONNET = price(2, 10, 0.1, 2.5);

/** 工程のエージェント（Opus）。同じ接続先のモデルの単価を持つ。 */
const agent = (modelPrices: AgentConfig["modelPrices"] = { sonnet: SONNET }): AgentConfig =>
  ({
    id: "claude_advanced",
    runtime: "claude-code",
    model: "claude-opus-5-5",
    auth: { mode: "subscription", secret: "t" },
    via_gateway: false,
    price: OPUS,
    ...(modelPrices ? { modelPrices } : {}),
  }) as AgentConfig;

/** 実行のログ（~/.sacty/runs の最後の result）にあった、Opus と Sonnet のサブエージェントを使った実行の値。 */
const OPUS_USAGE = { input: 104, output: 42590, cacheRead: 1500292, cacheWrite: 292045 };
const SONNET_USAGE = { input: 6, output: 866, cacheRead: 42459, cacheWrite: 19603 };
const REPORTED = 2.8945018;
const modelUsage = {
  "claude-opus-5-5": {
    inputTokens: 104,
    outputTokens: 42590,
    cacheReadInputTokens: 1500292,
    cacheCreationInputTokens: 292045,
    costUSD: 2.8325764,
  },
  "claude-sonnet-5-5": {
    inputTokens: 6,
    outputTokens: 866,
    cacheReadInputTokens: 42459,
    cacheCreationInputTokens: 19603,
    costUSD: 0.0619254,
  },
};
const resultLine = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "result",
    is_error: false,
    result: "ok",
    usage: { output_tokens: 1 },
    modelUsage,
    total_cost_usd: REPORTED,
    ...extra,
  });
const read = (line: string, options: { resumed?: boolean } = {}) => {
  const reader = new ClaudeOutcomeReader(undefined, options);
  reader.push(line);
  return reader.finish(0);
};

describe("CLI が報告した費用の読み取り", () => {
  it("result の total_cost_usd とモデルごとの使用量を持つ", () => {
    const outcome = read(resultLine());
    expect(outcome).toMatchObject({
      kind: "completed",
      reportedCostUsd: REPORTED,
      modelUsages: [
        { model: "claude-opus-5-5", usage: OPUS_USAGE },
        { model: "claude-sonnet-5-5", usage: SONNET_USAGE },
      ],
    });
  });

  it("費用の報告が無い・読めない値のときは持たない。モデルごとの使用量が無ければ、それも持たない", () => {
    for (const bad of [undefined, "1.5", Number.NaN, -1, null]) {
      const outcome = read(resultLine({ total_cost_usd: bad }));
      expect(outcome, String(bad)).not.toHaveProperty("reportedCostUsd");
    }
    const none = read(resultLine({ modelUsage: undefined, total_cost_usd: undefined }));
    expect(none).not.toHaveProperty("modelUsages");
    expect(none).not.toHaveProperty("reportedCostUsd");
  });

  it("セッションを再開・複製した実行は、前の実行の分も入るので、報告もモデルごとの使用量も使わない", () => {
    const outcome = read(resultLine(), { resumed: true });
    expect(outcome).not.toHaveProperty("reportedCostUsd");
    expect(outcome).not.toHaveProperty("modelUsages");
  });

  it("失敗の result の報告も持つ。最後の result の後に始まった番の使用量は、報告に入っていない分として持つ", () => {
    const failed = read(resultLine({ is_error: true, result: "API Error: 500" }));
    expect(failed).toMatchObject({ kind: "failed", reportedCostUsd: REPORTED });
    expect(failed).not.toHaveProperty("unreportedUsage");
    const assistant = JSON.stringify({
      type: "assistant",
      message: { id: "m2", usage: { input_tokens: 10, output_tokens: 20 } },
    });
    const reader = new ClaudeOutcomeReader();
    reader.push(`${resultLine({ is_error: true, result: "API Error: 500" })}\n${assistant}`);
    expect(reader.finish(1)).toMatchObject({
      kind: "failed",
      reportedCostUsd: REPORTED,
      unreportedUsage: { input: 10, cacheRead: 0, cacheWrite: 0, output: 20 },
      costUnknown: true,
    });
  });
});

describe("実行の費用（runCost）", () => {
  it("CLI が報告した費用を、実行の費用にする。設定の単価で換算した額も持つ（出どころは reported）", () => {
    const cost = runCost(agent(), read(resultLine()));
    expect(cost.source).toBe("reported");
    expect(cost.costUsd).toBeCloseTo(REPORTED, 6);
    // 換算（ここでは全部を工程のエージェント＝Opus の単価で換算）は、報告より大きい
    expect(cost.convertedUsd).toBeGreaterThan(REPORTED);
  });

  it("報告が無いとき、モデルごとの使用量を、そのモデルの単価で換算する（出どころは converted）", () => {
    const outcome = read(resultLine({ total_cost_usd: undefined }));
    const prices = { "claude-opus-5-5": OPUS, "claude-sonnet-5-5": SONNET };
    const cost = runCost(agent(prices), outcome);
    expect(cost.source).toBe("converted");
    expect(cost.unpricedModels).toEqual([]);
    // Opus は 3.2656 ドル、Sonnet は 0.0619 ドル。報告 2.8945 ドルとの差は 14% 以内
    expect(cost.costUsd).toBeCloseTo(3.265624 + 0.0619254, 5);
    expect(cost.costUsd / REPORTED).toBeLessThan(1.2);
    // Sonnet を Opus の単価で換算すると、Sonnet の分が 2.5 倍になる（以前の換算）
    const allAtOpus = runCost(agent({}), outcome);
    expect(allAtOpus.costUsd).toBeGreaterThan(cost.costUsd);
    expect(allAtOpus.costUsd).toBeCloseTo(3.265624 + 0.1548135, 5);
  });

  it("単価が設定に無いモデルは、工程のエージェントの単価で換算し、そのモデルを記録する", () => {
    const outcome = read(resultLine({ total_cost_usd: undefined }));
    const cost = runCost(agent({ "claude-sonnet-5-5": SONNET }), outcome);
    expect(cost.unpricedModels).toEqual(["claude-opus-5-5"]);
    expect(cost.costUsd).toBeCloseTo(3.265624 + 0.0619254, 5);
    // モデルごとの単価が無い設定（modelPrices なし）でも、これまでどおり換算できる
    const bare = runCost(agent(undefined), outcome);
    expect(bare.unpricedModels).toEqual(["claude-opus-5-5", "claude-sonnet-5-5"]);
  });

  it("モデルの名前の接尾辞（[1m]）を除いた名前の単価を使う", () => {
    const a = agent({ "claude-sonnet-5-5": SONNET });
    expect(priceOfModel(a, "claude-sonnet-5-5[1m]")).toBe(SONNET);
    expect(priceOfModel(a, "claude-sonnet-5-5")).toBe(SONNET);
    expect(priceOfModel(a, "claude-unknown")).toBeUndefined();
    // 継承したプロパティの名前はモデルとしない
    expect(priceOfModel(a, "constructor")).toBeUndefined();
    expect(priceOfModel(a, "__proto__")).toBeUndefined();
  });

  it("モデルごとの使用量に入っていない分は、工程のエージェントの単価で換算する", () => {
    const outcome = {
      kind: "completed" as const,
      output: "",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 2_000_000 },
      modelUsages: [
        {
          model: "claude-sonnet-5-5",
          usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
        },
      ],
    };
    // Sonnet の 100万トークン（$10）+ 残りの 100万トークンを Opus の単価（$25）
    expect(runCost(agent({ "claude-sonnet-5-5": SONNET }), outcome).costUsd).toBe(35);
  });

  it("報告に入っていない使用量は、換算して足す。使用量があるのに 0 の報告は、換算に任せる", () => {
    const unreported = { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 };
    const base = {
      kind: "failed" as const,
      reason: "error" as const,
      message: "x",
      usage: { input: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
    };
    expect(
      runCost(agent(), { ...base, reportedCostUsd: 1, unreportedUsage: unreported }),
    ).toMatchObject({ source: "reported", costUsd: 6 });
    expect(runCost(agent(), { ...base, reportedCostUsd: 0 })).toMatchObject({
      source: "converted",
      costUsd: 30,
    });
    // 使用量が無ければ、0 の報告は 0（出どころは報告）
    expect(
      runCost(agent(), {
        kind: "completed",
        output: "",
        usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        reportedCostUsd: 0,
      }),
    ).toMatchObject({ source: "reported", costUsd: 0 });
  });

  it("報告もモデルごとの使用量も無い（Codex など）なら、工程のエージェントの単価で換算する。使用量が無ければ費用も出どころも無い", () => {
    const codex = {
      kind: "completed" as const,
      output: "",
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
    };
    expect(runCost(agent(), codex)).toMatchObject({ source: "converted", costUsd: 25 });
    expect(runCost(agent(), { kind: "failed", reason: "error", message: "x" })).toEqual({
      costUsd: 0,
      source: undefined,
      convertedUsd: 0,
      unpricedModels: [],
    });
  });
});
