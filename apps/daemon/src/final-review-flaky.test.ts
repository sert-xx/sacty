import { FAILED_TESTS_MAX, guardianTestsPassed } from "@sacty/core";
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

  it("失敗が上限を超えて一覧を記録しなくても、説明できない失敗があれば認めない", () => {
    const names = Array.from({ length: FAILED_TESTS_MAX }, (_, i) => `t${i}`);
    const review = read({
      failedTests: ["ui.spec.ts > 保存", ...names],
      flakyFailures: [flaky()],
    });
    expect(review.tests?.failedTests).toBeUndefined();
    expect(review.passed).toBe(false);
    expect(review.tests?.flakyFailures).toBeUndefined();
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

  it("環境の申告は名前の完全一致で照合する（別の名前の一部・根拠の中の語で説明済みにしない）", () => {
    const named = (environment: string) =>
      read({
        failedTests: ["ui.spec.ts > 保存", "保存"],
        environmentFailures: [environment],
        flakyFailures: [flaky()],
      }).passed;
    expect(named("保存できる：起点でも同じ失敗")).toBe(false);
    expect(named("make setup：保存で失敗する")).toBe(false);
    expect(named("保存：起点でも同じ失敗")).toBe(true);
  });

  it("失敗の一覧が無いと全件を確かめられないので認めない", () => {
    const review = read({ flakyFailures: [flaky()] });
    expect(review.passed).toBe(false);
    expect(review.tests?.rejectedFlakyFailures?.at(-1)).toContain("failedTests");
  });

  it.each([
    "tests/./ui.spec.ts",
    "tests/../tests/ui.spec.ts",
    "./tests//ui.spec.ts",
    "tests\\ui.spec.ts",
  ])("同じファイルを指すパスでも、差分のテストは認めない（%s）", (file) => {
    const review = read({ failedTests: ["ui.spec.ts > 保存"], flakyFailures: [flaky({ file })] }, [
      "tests/ui.spec.ts",
    ]);
    expect(review.passed).toBe(false);
    expect(review.tests?.rejectedFlakyFailures?.[0]).toContain("差分に含まれる");
  });

  it.each(["/tests/ui.spec.ts", "../other/ui.spec.ts", "."])(
    "作業領域のパスとして比べられないものは認めない（%s）",
    (file) => {
      const review = read({ failedTests: ["ui.spec.ts > 保存"], flakyFailures: [flaky({ file })] });
      expect(review.passed).toBe(false);
      expect(review.tests?.rejectedFlakyFailures?.[0]).toContain("比べられない");
    },
  );

  it("認めなかった申告は、差分が文書だけのツール不足の合格より優先する", () => {
    const review = extractFinalReview(
      `\`\`\`json\n${JSON.stringify({
        "sacty-final-review": {
          viewpoints: [{ id: "REQ", verified: true, reason: "満たす" }],
          remarks: [],
          tests: {
            command: "go test",
            output: "結果",
            exitCode: 127,
            missingCommands: ["go"],
            failedTests: ["ui.spec.ts > 保存"],
            flakyFailures: [flaky({ runs: 1 })],
          },
          humanChecks: [],
          summary: "要約",
        },
      })}\n\`\`\``,
      ["REQ"],
      [],
      { testCommand: "go test", documentsOnly: true, changedFiles: ["README.md"] },
    );
    expect(review.tests?.missingCommands).toEqual(["go"]);
    expect(review.tests?.rejectedFlakyFailures?.[0]).toContain("実行し直しが");
    expect(review.passed).toBe(false);
  });

  it("作業領域のテストが通っても、CI の失敗の申告は確かめて残す", () => {
    const ok = read({ exitCode: 0, flakyFailures: [flaky()] });
    expect(ok.passed).toBe(true);
    expect(ok.tests?.flakyFailures).toHaveLength(1);
    const ng = read({ exitCode: 0, flakyFailures: [flaky({ runs: 1 })] });
    expect(ng.passed).toBe(false);
    expect(ng.tests?.rejectedFlakyFailures).toHaveLength(1);
  });

  it("テストのコマンドが無くても、CI の失敗の申告を人が確かめることに残す", () => {
    const noCommand = (item: Record<string, unknown>) =>
      extractFinalReview(
        `\`\`\`json\n${JSON.stringify({
          "sacty-final-review": {
            viewpoints: [{ id: "REQ", verified: true, reason: "満たす" }],
            remarks: [],
            tests: { flakyFailures: [item] },
            humanChecks: [],
            summary: "要約",
          },
        })}\n\`\`\``,
        ["REQ"],
        [],
        { changedFiles: ["src/a.ts"] },
      );
    const ok = noCommand(flaky());
    expect(ok.passed).toBe(true);
    expect(ok.humanChecks?.[0]).toContain("不安定と判断したテストの失敗：ui.spec.ts > 保存");
    const ng = noCommand(flaky({ runs: 1 }));
    expect(ng.passed).toBe(false);
    expect(ng.summary).toContain("認めなかった申告");
  });

  it("一覧でない・崩れた項目でも落ちない", () => {
    expect(read({ flakyFailures: "なし" }).tests?.rejectedFlakyFailures).toBeUndefined();
    expect(read({ flakyFailures: [3] }).passed).toBe(false);
  });

  it("申告が無ければ、環境による失敗はこれまでどおり", () => {
    expect(read({ environmentFailures: ["make setup：起点でも同じ失敗"] }).passed).toBe(true);
    expect(read({}).passed).toBe(false);
  });
});
