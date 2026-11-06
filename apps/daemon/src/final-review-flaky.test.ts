import { guardianTestsPassed } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { extractFinalReview } from "./prompts.js";

// 差分と無関係で実行し直すと結果が変わる失敗は、実装に戻さない（PBI-310）。申告は sacty が機械で確かめる

const COMMAND = "npm test";
const flaky = (o: Record<string, unknown> = {}) => ({
  name: "ui.spec.ts > 保存",
  file: "tests/ui.spec.ts",
  runs: 3,
  passes: 2,
  reason: "差分と別の画面のテストで、順序で結果が変わる",
  ...o,
});

const read = (tests: Record<string, unknown>, changedFiles: string[] | undefined = ["src/a.ts"]) =>
  extractFinalReview(
    `\`\`\`json\n${JSON.stringify({
      "sacty-final-review": {
        viewpoints: [{ id: "REQ", verified: true, reason: "満たす" }],
        remarks: [],
        tests: { command: COMMAND, output: "結果", exitCode: 1, ...tests },
        humanChecks: [],
        summary: "要約",
      },
    })}\n\`\`\``,
    ["REQ"],
    [],
    { testCommand: COMMAND, ...(changedFiles ? { changedFiles } : {}) },
  );

describe("不安定な失敗の申告（PBI-310）", () => {
  it("確かめられた不安定な失敗だけなら、不合格にしない", () => {
    const review = read({ failedTests: ["ui.spec.ts > 保存"], flakyFailures: [flaky()] });
    expect(review.passed).toBe(true);
    expect(review.tests?.flakyFailures).toHaveLength(1);
    expect(review.tests && guardianTestsPassed(review.tests)).toBe(true);
  });

  it("テストのファイルが差分に含まれたら認めない（./ が付いていても）", () => {
    const review = read({ flakyFailures: [flaky({ file: "./src/a.ts" })] });
    expect(review.passed).toBe(false);
    expect(review.tests?.flakyFailures).toBeUndefined();
    expect(review.tests?.rejectedFlakyFailures?.[0]).toContain("差分に含まれる");
  });

  it.each([
    ["実行し直しが足りない", { runs: 1, passes: 1 }, "満たない"],
    ["1回も通らない", { runs: 3, passes: 0 }, "通った回数"],
    ["通った回数が実行の回数より多い", { runs: 2, passes: 3 }, "通った回数"],
    ["ファイルが無い", { file: "" }, "どれかが無い"],
    ["根拠が無い", { reason: "" }, "どれかが無い"],
  ])("%s申告は認めない", (_, o, why) => {
    const review = read({ flakyFailures: [flaky(o)] });
    expect(review.passed).toBe(false);
    expect(review.tests?.rejectedFlakyFailures?.[0]).toContain(why);
  });

  it("差分のファイルを読めなければ認めない", () => {
    const review = extractFinalReview(
      `\`\`\`json\n${JSON.stringify({
        "sacty-final-review": {
          viewpoints: [{ id: "REQ", verified: true, reason: "満たす" }],
          remarks: [],
          tests: { command: COMMAND, output: "", exitCode: 1, flakyFailures: [flaky()] },
          humanChecks: [],
          summary: "要約",
        },
      })}\n\`\`\``,
      ["REQ"],
      [],
      { testCommand: COMMAND },
    );
    expect(review.passed).toBe(false);
    expect(review.tests?.rejectedFlakyFailures?.[0]).toContain("読めず");
  });

  it("説明できない失敗が1件でもあれば、全部を認めない", () => {
    const review = read({ failedTests: ["ui.spec.ts > 保存", "b"], flakyFailures: [flaky()] });
    expect(review.passed).toBe(false);
    expect(review.tests?.flakyFailures).toBeUndefined();
    expect(review.tests?.rejectedFlakyFailures).toEqual([
      "b：環境による失敗にも不安定な失敗にも挙げられていない",
    ]);
  });

  it("環境と不安定の混在は、全件を説明できれば不合格にしない", () => {
    const review = read({
      failedTests: ["ui.spec.ts > 保存", "make setup"],
      environmentFailures: ["make setup：起点でも同じ失敗"],
      flakyFailures: [flaky()],
    });
    expect(review.passed).toBe(true);
    expect(review.tests?.environmentFailures).toHaveLength(1);
  });

  it("認めなかったら、環境による失敗の申告でも通さない", () => {
    const review = read({
      environmentFailures: ["make setup：起点でも同じ失敗"],
      flakyFailures: [flaky({ runs: 1 })],
    });
    expect(review.passed).toBe(false);
    expect(review.tests?.environmentFailures).toBeUndefined();
  });

  it("成功したのに書いてあっても読まない。一覧でない・崩れた項目でも落ちない", () => {
    expect(read({ exitCode: 0, flakyFailures: [flaky()] }).tests?.flakyFailures).toBeUndefined();
    expect(read({ flakyFailures: "なし" }).tests?.rejectedFlakyFailures).toBeUndefined();
    expect(read({ flakyFailures: [3] }).passed).toBe(false);
  });

  it("申告が無ければ、環境による失敗はこれまでどおり", () => {
    expect(read({ environmentFailures: ["make setup：起点でも同じ失敗"] }).passed).toBe(true);
    expect(read({}).passed).toBe(false);
  });
});
