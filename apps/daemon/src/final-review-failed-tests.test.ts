import { FAILED_TESTS_MAX, testsMadeNoProgress } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { extractFinalReview } from "./prompts.js";

// 失敗したテストの名前は、回をまたいで機械的に比べる（PBI-308）。理由が混ざると、同じ失敗を別のものと数えてしまう

const COMMAND = "npm test";

const read = (tests: Record<string, unknown>) =>
  extractFinalReview(
    `\`\`\`json\n${JSON.stringify({
      "sacty-final-review": {
        viewpoints: [{ id: "REQ", verified: true, reason: "満たす" }],
        remarks: [],
        tests: { command: COMMAND, output: "結果", ...tests },
        humanChecks: [],
        summary: "要約",
      },
    })}\n\`\`\``,
    ["REQ"],
    [],
    { testCommand: COMMAND },
  );

describe("失敗したテストの名前の読み取り（PBI-308）", () => {
  it("テストのコマンドが失敗したときに、名前を読む", () => {
    expect(read({ exitCode: 1, failedTests: ["a.test.ts > x", "b"] }).tests?.failedTests).toEqual([
      "a.test.ts > x",
      "b",
    ]);
  });

  it("成功したのに書いてあっても読まない", () => {
    expect(read({ exitCode: 0, failedTests: ["a"] }).tests?.failedTests).toBeUndefined();
  });

  it("オブジェクトは名前だけを読み、理由をつながない", () => {
    expect(
      read({ exitCode: 1, failedTests: [{ name: "a", reason: "毎回違う言い回し" }] }).tests
        ?.failedTests,
    ).toEqual(["a"]);
  });

  it("重複・空・「なし」・一覧でないものを読まない", () => {
    expect(
      read({ exitCode: 1, failedTests: ["a", "a", "", "なし", 3] }).tests?.failedTests,
    ).toEqual(["a"]);
    expect(read({ exitCode: 1, failedTests: "a" }).tests?.failedTests).toBeUndefined();
    expect(read({ exitCode: 1 }).tests?.failedTests).toBeUndefined();
  });

  it("上限ちょうどまでは記録する", () => {
    const names = Array.from({ length: FAILED_TESTS_MAX }, (_, i) => `t${i}`);
    expect(read({ exitCode: 1, failedTests: names }).tests?.failedTests).toEqual(names);
  });

  it("上限を超えた一覧は記録しない（欠けた一覧では比べられない）", () => {
    const names = Array.from({ length: FAILED_TESTS_MAX + 1 }, (_, i) => `t${i}`);
    expect(read({ exitCode: 1, failedTests: names }).tests?.failedTests).toBeUndefined();
  });

  it("上限を超えた失敗の最後の1件だけが直ったら、進展なしにしない", () => {
    const names = Array.from({ length: FAILED_TESTS_MAX + 1 }, (_, i) => `t${i}`);
    const previous = read({ exitCode: 1, failedTests: names }).tests?.failedTests;
    const current = read({ exitCode: 1, failedTests: names.slice(0, -1) }).tests?.failedTests;
    expect(testsMadeNoProgress(previous, current)).toBe(false);
  });
});
