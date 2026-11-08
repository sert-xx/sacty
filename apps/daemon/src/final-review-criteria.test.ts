import { createHash } from "node:crypto";
import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { FINAL_REVIEW_CRITERIA, SCOPE_SOURCES } from "./final-review-criteria.js";
import { buildFinalReviewPrompt, buildPrompt } from "./prompts.js";

/** 指示を作るのに要る項目だけを持つタスク。 */
function task(o: Partial<Task> = {}): Task {
  return {
    id: "t",
    projectId: "p",
    title: "題",
    body: "本文",
    status: "queued",
    approved: {},
    outputs: {},
    testMap: [],
    remarks: [],
    proposals: [],
    steps: [],
    testCommand: "npm test",
    ...o,
  } as unknown as Task;
}

const designed = (o: Partial<Task> = {}) =>
  task({
    plan: "standard",
    steps: [
      { key: "requirements", status: "approved" },
      { key: "design", status: "approved" },
      { key: "implement", status: "running" },
    ] as unknown as Task["steps"],
    approved: {
      requirements: { output: "# 要求要件", submission: 1 },
      design: { output: "# 設計", submission: 1, testViewpoints: [{ id: "TV-1", text: "x" }] },
    } as unknown as Task["approved"],
    ...o,
  });
const direct = (o: Partial<Task> = {}) =>
  task({
    plan: "direct",
    steps: [{ key: "implement", status: "running" }] as unknown as Task["steps"],
    ...o,
  });

describe("最終レビューの基準を、実装の工程に先に渡す（PBI-315）", () => {
  const cases: [string, Task, { scope: boolean; tests: boolean }][] = [
    ["設計あり", designed(), { scope: true, tests: true }],
    ["要求要件・設計を省いた", direct(), { scope: true, tests: true }],
    [
      "テストの仕組みが無い",
      direct({ noTestsReason: "無い", testCommand: undefined }),
      { scope: true, tests: false },
    ],
    ["文書だけ", direct({ documentsOnly: true }), { scope: true, tests: false }],
    [
      "不具合の修正",
      task({
        plan: "bug-fix",
        steps: [
          { key: "reproduce", status: "approved" },
          { key: "implement", status: "running" },
        ] as unknown as Task["steps"],
        reproductionTests: ["repro.test.ts › 再現"],
      } as Partial<Task>),
      { scope: true, tests: true },
    ],
    [
      "セキュリティ対応（範囲は観点 SEC-MIN が見る）",
      direct({ stepsChoice: { plan: "security-fix" } } as unknown as Partial<Task>),
      { scope: false, tests: true },
    ],
  ];

  it.each(cases)(
    "%sの実装の指示と最終レビューの指示に、同じ言葉の基準がそろって入る",
    (_, t, applies) => {
      const implement = buildPrompt(t, "implement");
      const review = buildFinalReviewPrompt(
        t,
        "diff",
        t.testCommand ? { testCommand: t.testCommand } : {},
      );
      expect(implement).toContain("--- 提出の前に確かめる、最終レビューの基準 ---");
      for (const c of FINAL_REVIEW_CRITERIA) {
        const expected = !(
          ("scope" in c && c.scope && !applies.scope) ||
          ("tests" in c && c.tests && !applies.tests)
        );
        expect(implement.includes(c.term), `${c.id}（実装）`).toBe(expected);
        if (expected) expect(review.includes(c.term), `${c.id}（最終レビュー）`).toBe(true);
      }
    },
  );

  it("要求要件を省いたタスクの実装の指示には、承認済みの要求要件と書かない", () => {
    const implement = buildPrompt(direct(), "implement");
    expect(implement).not.toContain("承認済みの要求要件");
    expect(implement).not.toContain(SCOPE_SOURCES);
    expect(buildPrompt(designed(), "implement")).toContain(
      "承認済みの要求要件・設計と人間の過去の指摘のどれかが求めている変更か",
    );
    expect(implement).toContain("タスクの内容（依頼）と人間の過去の指摘のどれかが求めている変更か");
  });

  it("AI のレビューの過去の指摘があるときだけ、応え方の基準を入れる", () => {
    const remark = {
      id: "r1",
      step: "implement",
      text: "直して",
      source: "sacty_review",
      submission: 1,
    };
    const without = buildPrompt(designed(), "implement");
    const withAi = buildPrompt(
      designed({ remarks: [remark] as unknown as Task["remarks"] }),
      "implement",
    );
    const line =
      "AI のレビューの過去の指摘（人間の指摘ではなく、人間が承認したものでもない）に応えるときは";
    expect(without).not.toContain(line);
    expect(withAi).toContain(line);
    // 最終レビューは、AI の指摘に応えた要求を超える変更を不合格にせず人の確認に回すので、不合格の基準とは分けて伝える
    expect(withAi).toContain(`不合格の基準ではありませんが、${line}`);
    expect(withAi).not.toContain(`- ${line}`);
  });

  it("基準は、セルフレビューと提出の前の検証より前に置く（提出の前に確かめる）", () => {
    const implement = buildPrompt(designed(), "implement");
    const at = implement.indexOf("--- 提出の前に確かめる、最終レビューの基準 ---");
    expect(at).toBeGreaterThan(0);
    expect(implement.indexOf("sacty-verification")).toBeGreaterThan(at);
  });
});

describe("最終レビューの指示は、基準を共有にする前と一字も変わらない（PBI-315）", () => {
  const aiRemark = {
    id: "r1",
    step: "implement",
    text: "直して",
    source: "sacty_review",
    submission: 1,
  };
  /**
   * 代表的な分岐の最終レビューの指示の SHA-256。基準を final-review-criteria.ts に移す前（main 725c3706）の prompts.ts で
   * 計算した値。最終レビューの指示を意図して変えたときは、変えた後の値に直す。
   */
  const before: Record<string, string> = {
    設計あり: "fc543ad25c00b04edefa2421079d08e601bed528e45f19e9db84e2d0e8a93892",
    "要求要件・設計を省いた": "cd7a2985a85d4ccf0f0df1893f50a379f4e81e0988d2577b5d11474a9a5eb770",
    テストの仕組みが無い: "6d49ce5ee2e652c953b72ea3027bfb3efef8b4028bad023a5a42475c983a6b2c",
    文書だけ: "bad457f6fbd84830454b36ad288c020a90d825c7839bf668cb3a6e4666d8cf7a",
    不具合の修正: "57b6706404d8326d358c61ccb205993486c4eccefb1a5e7196d3d664d7f6e6a0",
    セキュリティ対応: "c57688c2839e69eff85db4831e86623b09786a72aaf6518739fc375b6b721bbd",
    "AI のレビューの過去の指摘と内部の名前がある":
      "65e0fb24c4a2c8c7508451bf29351d110cf32d368a1282ed210b6c164660a7d7",
  };
  const cases: [string, () => string][] = [
    ["設計あり", () => buildFinalReviewPrompt(designed(), "diff", { testCommand: "npm test" })],
    [
      "要求要件・設計を省いた",
      () => buildFinalReviewPrompt(direct(), "diff", { testCommand: "npm test" }),
    ],
    [
      "テストの仕組みが無い",
      () =>
        buildFinalReviewPrompt(direct({ noTestsReason: "無い", testCommand: undefined }), "diff"),
    ],
    [
      "文書だけ",
      () =>
        buildFinalReviewPrompt(
          direct({ documentsOnly: true, noTestsReason: "文書だけ", testCommand: undefined }),
          "diff",
        ),
    ],
    [
      "不具合の修正",
      () =>
        buildFinalReviewPrompt(
          task({
            plan: "bug-fix",
            steps: [
              { key: "reproduce", status: "approved" },
              { key: "implement", status: "running" },
            ] as unknown as Task["steps"],
            reproductionTests: ["repro.test.ts › 再現"],
          } as Partial<Task>),
          "diff",
          { testCommand: "npm test" },
        ),
    ],
    [
      "セキュリティ対応",
      () =>
        buildFinalReviewPrompt(
          direct({ stepsChoice: { plan: "security-fix" } } as unknown as Partial<Task>),
          "diff",
          { testCommand: "npm test" },
        ),
    ],
    [
      "AI のレビューの過去の指摘と内部の名前がある",
      () =>
        buildFinalReviewPrompt(
          designed({ remarks: [aiRemark] as unknown as Task["remarks"] }),
          "diff",
          {
            testCommand: "npm test",
            internalNames: [{ path: "a.ts", line: 1, name: ".sacty-tools" }],
          },
        ),
    ],
  ];
  it.each(cases)("%s", (name, build) => {
    const hash = createHash("sha256").update(build()).digest("hex");
    expect(hash).toBe(before[name]);
  });
});
