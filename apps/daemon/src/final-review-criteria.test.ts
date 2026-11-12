import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { FINAL_REVIEW_CRITERIA } from "./final-review-criteria.js";
import { buildPrompt } from "./prompts.js";

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

  it.each(cases)("%sの実装の指示に、当てはまる基準がそろって入る", (_, t, applies) => {
    const implement = buildPrompt(t, "implement");
    expect(implement).toContain("--- 提出の前に確かめる、レビューの基準 ---");
    for (const c of FINAL_REVIEW_CRITERIA) {
      const expected = !(
        ("scope" in c && c.scope && !applies.scope) ||
        ("tests" in c && c.tests && !applies.tests)
      );
      expect(implement.includes(c.term), `${c.id}（実装）`).toBe(expected);
    }
  });

  it("要求要件を省いたタスクの実装の指示には、承認済みの要求要件と書かない", () => {
    const implement = buildPrompt(direct(), "implement");
    expect(implement).not.toContain("承認済みの要求要件");
    // 最終レビュー（PBI-331 でやめた）が使っていた、どの進め方でも同じ拠り所の言葉
    expect(implement).not.toContain(
      "承認済みの要求要件・設計（これらを省いたタスクは、タスクの内容（依頼）や再現のテスト）",
    );
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
    // AI の指摘への応え方は、基準の箇条とは分けて伝える
    expect(withAi).toContain(`\n${line}`);
    expect(withAi).not.toContain(`- ${line}`);
  });

  it("基準は、セルフレビューと提出の前の検証より前に置く（提出の前に確かめる）", () => {
    const implement = buildPrompt(designed(), "implement");
    const at = implement.indexOf("--- 提出の前に確かめる、レビューの基準 ---");
    expect(at).toBeGreaterThan(0);
    expect(implement.indexOf("sacty-verification")).toBeGreaterThan(at);
  });
});
