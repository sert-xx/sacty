import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { FINAL_REVIEW_CRITERIA, FUTURE_TIMESTAMP } from "./final-review-criteria.js";
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

describe("実装・直しの指示に、指示を作った時刻を入れる（PBI-469）", () => {
  const now = Date.UTC(2026, 10, 21, 10, 30, 0);
  const STAMP = "2026-11-21T10:30:00Z";
  const RULE = "日時を推測で決めず、書く直前にコンテナで今の時刻を確かめる";

  it("通常の実装の指示に、渡した時刻と、推測せず今の時刻を確かめる決まりが入る", () => {
    const prompt = buildPrompt(designed(), "implement", { now });
    expect(prompt).toContain(STAMP);
    expect(prompt).toContain(RULE);
    // 時刻が変われば、指示の時刻も変わる
    expect(buildPrompt(designed(), "implement", { now: now + 61_000 })).toContain(
      "2026-11-21T10:31:01Z",
    );
  });

  it("時刻を渡さなくても、実装の指示に時刻の行が入る", () => {
    expect(buildPrompt(designed(), "implement")).toMatch(
      /この指示を作った時刻は \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z（UTC）/,
    );
  });

  it("設計だけ承認・テストの仕組みが無い・不具合の修正の枝にも、時刻の行が入る", () => {
    const bug = task({
      plan: "bug-fix",
      steps: [
        { key: "reproduce", status: "approved" },
        { key: "implement", status: "running" },
      ] as unknown as Task["steps"],
      reproductionTests: ["repro.test.ts › 再現"],
    } as Partial<Task>);
    const designOnly = task({
      plan: "skip-requirements",
      steps: [
        { key: "design", status: "approved" },
        { key: "implement", status: "running" },
      ] as unknown as Task["steps"],
      approved: {
        design: { output: "# 設計", submission: 1, testViewpoints: [{ id: "TV-1", text: "x" }] },
      } as unknown as Task["approved"],
    });
    for (const t of [
      designOnly,
      direct(),
      direct({ noTestsReason: "無い", testCommand: undefined }),
      designed({ noTestsReason: "無い", testCommand: undefined }),
      bug,
    ]) {
      const prompt = buildPrompt(t, "implement", { now });
      expect(prompt).toContain(STAMP);
      expect(prompt).toContain(RULE);
    }
  });

  it("直し（人・AI の指摘を受けたやり直し）の指示にも、指摘と並んで時刻の行が入る", () => {
    const remarks = [
      { id: "r1", step: "implement", text: "人の指摘です", source: "human", submission: 1 },
      { id: "r2", step: "implement", text: "AI の指摘です", source: "sacty_review", submission: 1 },
    ] as unknown as Task["remarks"];
    const prompt = buildPrompt(designed({ remarks }), "implement", { now });
    expect(prompt).toContain("人の指摘です");
    expect(prompt).toContain("AI の指摘です");
    expect(prompt).toContain(STAMP);
    expect(prompt).toContain(RULE);
  });

  it("要求要件・設計の工程の指示には、時刻の行を入れない", () => {
    expect(buildPrompt(designed(), "design", { now })).not.toContain(STAMP);
  });

  it.each([
    ["設計あり", designed(), {}],
    ["テストの仕組みが無い", direct({ noTestsReason: "無い", testCommand: undefined }), {}],
    ["PR のレビューの子タスクが見る提出", designed(), { pullRequestReview: true }],
  ])(
    "%sの実装の指示の基準に、未来の記録の日時を直させる行が、比べ方と対象とともに入る",
    (_name, t, options) => {
      const prompt = buildPrompt(t, "implement", { now, ...options });
      const line = prompt.split("\n").find((l) => l.includes(FUTURE_TIMESTAMP)) ?? "";
      expect(line).toContain("リポジトリの決まりのタイムゾーンに直して比べ、決まりが無ければ UTC");
      expect(line).toContain("期限・予定日など、記録の日時ではない日時は、未来でも直さない");
      expect(prompt.indexOf("--- 提出の前に確かめる、レビューの基準 ---")).toBeLessThan(
        prompt.indexOf(line),
      );
    },
  );
});
