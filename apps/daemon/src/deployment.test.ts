import { describe, expect, it } from "vitest";
import { extractDeploymentCheck, overallDeploymentResult } from "./deployment.js";

const fenced = (value: unknown) =>
  `確かめました\n\n\`\`\`json\n${JSON.stringify({ "sacty-deployment": value })}\n\`\`\``;

describe("デプロイの確認の答え（PBI-116。範囲はスキルに任せる形）", () => {
  it("CI/CD・デプロイの確認それぞれの結果と、飛ばした理由を読み、全体の結果を sacty が決める", () => {
    const answer = extractDeploymentCheck(
      fenced({
        ci: { result: "passed", summary: "必要なものは通った" },
        deployment: { result: "skipped", reason: "デプロイしていない" },
        summary: "CI/CD だけ確かめた",
        evidence: ["CI: success", "", 3],
      }),
    );
    expect(answer).toEqual({
      result: "healthy",
      ci: { result: "passed", summary: "必要なものは通った" },
      deployment: { result: "skipped", reason: "デプロイしていない" },
      summary: "CI/CD だけ確かめた",
      evidence: ["CI: success"],
    });
  });

  it("どちらかが無い・知らない結果・以前の形（result だけ）は読まない", () => {
    expect(extractDeploymentCheck(fenced({ ci: { result: "passed" } }))).toBeUndefined();
    expect(
      extractDeploymentCheck(fenced({ ci: { result: "ok" }, deployment: { result: "healthy" } })),
    ).toBeUndefined();
    expect(
      extractDeploymentCheck(
        fenced({ ci: { result: "passed" }, deployment: { result: "passed" } }),
      ),
    ).toBeUndefined();
    expect(
      extractDeploymentCheck(fenced({ result: "healthy", summary: "以前の形", evidence: [] })),
    ).toBeUndefined();
  });

  it("長い要点・理由は切り詰める", () => {
    const long = "あ".repeat(5000);
    const answer = extractDeploymentCheck(
      fenced({
        ci: { result: "unknown", reason: long },
        deployment: { result: "healthy", summary: long },
        summary: long,
      }),
    );
    expect(answer?.ci.reason).toHaveLength(2000);
    expect(answer?.deployment.summary).toHaveLength(2000);
    expect(answer?.summary).toHaveLength(4000);
  });

  it("失敗があれば unhealthy、無くて判断できないものがあれば unknown、ほかは healthy", () => {
    const cases = [
      ["failed", "healthy", "unhealthy"],
      ["passed", "unhealthy", "unhealthy"],
      ["failed", "unknown", "unhealthy"],
      ["unknown", "healthy", "unknown"],
      ["passed", "unknown", "unknown"],
      ["skipped", "skipped", "healthy"],
      ["passed", "healthy", "healthy"],
    ] as const;
    for (const [ci, deployment, expected] of cases) {
      expect(overallDeploymentResult({ result: ci }, { result: deployment })).toBe(expected);
    }
  });
});
