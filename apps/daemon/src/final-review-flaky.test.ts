import {
  type DaemonText,
  FAILED_TESTS_MAX,
  guardianTestsPassed,
  renderMessage,
  type Task,
} from "@sacty/core";
import { describe, expect, it } from "vitest";
import { carriedHumanChecks, extractFinalReview } from "./prompts.js";

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

const reasons = (items: readonly DaemonText[] | undefined) =>
  (items ?? []).map((f) => renderMessage(f, "ja"));

const noCommandReport = (flakyFailures: unknown) =>
  extractFinalReview(
    `\`\`\`json\n${JSON.stringify({
      "sacty-final-review": {
        viewpoints: [{ id: "REQ", verified: true, reason: "満たす" }],
        remarks: [],
        tests: { flakyFailures },
        humanChecks: [],
        summary: "要約",
      },
    })}\n\`\`\``,
    ["REQ"],
    [],
    { changedFiles: ["src/a.ts"] },
  );

const noCommand = (item: Record<string, unknown>) => noCommandReport([item]);

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
    expect(reasons(review.tests?.rejectedFlakyFailures)[0]).toContain("差分に含まれる");
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
    expect(reasons(review.tests?.rejectedFlakyFailures)[0]).toContain(why);
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
    expect(reasons(review.tests?.rejectedFlakyFailures)[0]).toContain("読めず");
  });

  it("説明できない失敗が1件でもあれば、全部を認めない", () => {
    const review = read({ failedTests: ["ui.spec.ts > 保存", "b"], flakyFailures: [flaky()] });
    expect(review.passed).toBe(false);
    expect(review.tests?.flakyFailures).toBeUndefined();
    expect(reasons(review.tests?.rejectedFlakyFailures)).toEqual([
      "b：環境による失敗にも不安定な失敗にも挙げられていない",
    ]);
  });

  it.each([
    ["名前の無いオブジェクト", { reason: "別の失敗" }],
    ["数", 3],
    ["null", null],
  ])("failedTests に読めない項目（%s）があれば、残りを説明できても認めない", (_, item) => {
    const review = read({ failedTests: ["ui.spec.ts > 保存", item], flakyFailures: [flaky()] });
    expect(review.passed).toBe(false);
    expect(review.tests?.flakyFailures).toBeUndefined();
    expect(reasons(review.tests?.rejectedFlakyFailures)).toEqual([
      "失敗したテストの名前（failedTests）のうち 1 件を読めず、全件を説明できるか確かめられない",
    ]);
  });

  it("failedTests の「なし」は、読めない項目に数えない", () => {
    const review = read({ failedTests: ["ui.spec.ts > 保存", "なし"], flakyFailures: [flaky()] });
    expect(review.passed).toBe(true);
  });

  it.each([
    ["オブジェクト", { name: "設定：保存", reason: "起点でも失敗" }],
    ["文字列", "設定：保存：起点でも失敗"],
  ])("環境の申告（%s）の名前に「：」があっても、名前全体で照合する", (_, item) => {
    const review = read({
      failedTests: ["ui.spec.ts > 保存", "設定：保存"],
      flakyFailures: [flaky()],
      environmentFailures: [item],
    });
    expect(review.passed).toBe(true);
    expect(review.tests?.rejectedFlakyFailures).toBeUndefined();
  });

  it("環境の申告の名前が途中までしか合わなければ、説明できたものとしない", () => {
    const review = read({
      failedTests: ["ui.spec.ts > 保存", "設定：保存"],
      flakyFailures: [flaky()],
      environmentFailures: [{ name: "設定", reason: "保存：起点でも失敗" }, "設定：保存する"],
    });
    expect(review.passed).toBe(false);
    expect(reasons(review.tests?.rejectedFlakyFailures)).toEqual([
      "設定：保存：環境による失敗にも不安定な失敗にも挙げられていない",
    ]);
  });

  it("認めなかった理由は文言のコードで持ち、画面の言語で読める", () => {
    const review = read({ flakyFailures: [flaky({ runs: 1, passes: 1 })] });
    const reason = review.tests?.rejectedFlakyFailures?.[0];
    expect(reason && renderMessage(reason, "en")).toBe(
      "ui.spec.ts > 保存: rerun fewer than 2 times (1)",
    );
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
    expect(reasons(review.tests?.rejectedFlakyFailures).at(-1)).toContain("failedTests");
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
    expect(reasons(review.tests?.rejectedFlakyFailures)[0]).toContain("差分に含まれる");
  });

  it.each(["/tests/ui.spec.ts", "../other/ui.spec.ts", "."])(
    "作業領域のパスとして比べられないものは認めない（%s）",
    (file) => {
      const review = read({ failedTests: ["ui.spec.ts > 保存"], flakyFailures: [flaky({ file })] });
      expect(review.passed).toBe(false);
      expect(reasons(review.tests?.rejectedFlakyFailures)[0]).toContain("比べられない");
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
    expect(reasons(review.tests?.rejectedFlakyFailures)[0]).toContain("実行し直しが");
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

  it("テストのコマンドが無くても、CI の失敗の申告を種別を保って残し、次の回へ引き継がない", () => {
    const ok = noCommand(flaky());
    expect(ok.passed).toBe(true);
    expect(ok.ciFlakyFailures).toHaveLength(1);
    expect(ok.humanChecks).toBeUndefined();
    const lastReview = { ...ok, at: "2026-11-07T00:00:00.000Z" } as Task["lastReview"];
    expect(carriedHumanChecks({ lastReview })).toEqual([]);
    const ng = noCommand(flaky({ runs: 1 }));
    expect(ng.passed).toBe(false);
    expect(ng.ciFlakyFailures).toBeUndefined();
    expect(reasons(ng.rejectedCiFlakyFailures)[0]).toContain("実行し直しが");
  });

  it.each([
    ["オブジェクト", flaky({ runs: 1, passes: 0 })],
    ["文", "ui.spec.ts > 保存"],
    ["数", 3],
    ["真偽", true],
  ])("一覧でない申告（%s）は、申告なしとして捨てず、認めない", (_, item) => {
    const withCommand = read({ exitCode: 0, flakyFailures: item });
    expect(withCommand.passed).toBe(false);
    expect(reasons(withCommand.tests?.rejectedFlakyFailures)[0]).toContain("読めない");
    const without = noCommandReport(item);
    expect(without.passed).toBe(false);
    expect(reasons(without.rejectedCiFlakyFailures)[0]).toContain("読めない");
  });

  it.each([
    ["未指定", undefined],
    ["null", null],
    ["空の一覧", []],
    ["空の文", ""],
    ["なし", "なし"],
    ["なしの一覧", ["なし"]],
  ])("申告が無い（%s）なら、確かめずに通す", (_, item) => {
    const review = read({ exitCode: 0, flakyFailures: item });
    expect(review.passed).toBe(true);
    expect(review.tests?.rejectedFlakyFailures).toBeUndefined();
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
