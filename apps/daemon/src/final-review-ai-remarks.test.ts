import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildFinalReviewPrompt,
  buildIntegrationReviewPrompt,
  extractFinalReview,
  extractIntegrationReview,
} from "./prompts.js";

/*
 * 最終レビュー・統合レビューは、AI のレビューの過去の指摘にも再発の判定を求める（PBI-287。S18 r2 の回帰）。
 * 判定を読む側（readVerdicts）は、AI のレビューの指摘も含めたすべての指摘に判定を求める。指示が人の指摘だけに判定を求めると、
 * ゴールガーディアンが観点・テスト・人の指摘をすべて合格にしても、AI の指摘の判定が無くて不合格になる。
 */

const remark = (id: string, source?: "sacty_review") => ({
  id,
  step: "requirements",
  round: Number(id.split("-")[1]),
  text: source ? `AI: ${id}` : `人: ${id}`,
  voided: false,
  ...(source ? { source } : {}),
});

const task = (remarks: ReturnType<typeof remark>[], extra: Record<string, unknown> = {}) =>
  ({
    id: "t-1",
    title: "ログイン",
    body: "ログインできる",
    steps: ["requirements", "implement"].map((key) => ({ key, state: "todo" })),
    remarks,
    outputs: {},
    approved: { requirements: { output: "# 要求要件\n\n- REQ-1 ログインできる", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["login.test.ts"] }],
    testCommand: "npm test",
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    ...extra,
  }) as unknown as Task;

// S18 r2 の形：人の指摘が1件（2-1）と、Sacty の AI のレビューの指摘が4件（1-1〜1-4）
const S18_REMARKS = [
  remark("requirements-1-1", "sacty_review"),
  remark("requirements-1-2", "sacty_review"),
  remark("requirements-1-3", "sacty_review"),
  remark("requirements-1-4", "sacty_review"),
  remark("requirements-2-1"),
];
const ALL_IDS = S18_REMARKS.map((r) => r.id);

/** 指示の「過去の指摘ごとに再発を判定する」の行。 */
function judgeLine(prompt: string): string {
  const line = prompt.split("\n").find((l) => l.includes("再発していないかを判定する"));
  if (!line) throw new Error("再発を判定する指示の行がありません");
  return line;
}

/** 指示の節（`--- 見出し ---`）の指摘の ID。 */
function sectionIds(prompt: string, heading: RegExp): string[] {
  const lines = prompt.split("\n");
  const at = lines.findIndex((l) => l.startsWith("--- ") && heading.test(l));
  if (at < 0) return [];
  const ids: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("--- ")) break;
    const m = /^- \[([^\]]+)\]/.exec(l);
    if (m?.[1]) ids.push(m[1]);
  }
  return ids;
}

/**
 * 指示を字義どおりに読むゴールガーディアン。再発を判定する行が名指しした種類の指摘（人間の過去の指摘・AI のレビューの過去の指摘）
 * だけに、再発なしの判定を返す。S18 r2 のゴールガーディアンは、行が「人間の過去の指摘」だけを名指ししていたので、人の指摘にだけ答えた。
 */
function literalVerdicts(prompt: string): { id: string; notRecurred: boolean; reason: string }[] {
  const line = judgeLine(prompt);
  const ids = [
    ...(line.includes("人間の過去の指摘") ? sectionIds(prompt, /人間の過去の指摘/) : []),
    ...(line.includes("AI のレビューの過去の指摘")
      ? sectionIds(prompt, /AI のレビューの過去の指摘/)
      : []),
  ];
  return ids.map((id) => ({ id, notRecurred: true, reason: "再発していない" }));
}

const answer = (heading: string, remarks: unknown[], extra: Record<string, unknown> = {}) =>
  `判定です。\n\`\`\`json\n${JSON.stringify({
    [heading]: {
      viewpoints: [{ id: "REQ", verified: true, reason: "検証している" }],
      remarks,
      summary: "合格です",
      ...extra,
    },
  })}\n\`\`\``;

const finalReview = (t: Task) => {
  const output = answer("sacty-final-review", literalVerdicts(buildFinalReviewPrompt(t, "diff")), {
    tests: {
      command: "npm test",
      exitCode: 0,
      output: "ok",
      missingCommands: [],
      environmentFailures: [],
      otherFailures: [],
    },
    humanChecks: [],
  });
  return extractFinalReview(
    output,
    ["REQ"],
    t.remarks.filter((r) => !r.voided).map((r) => r.id),
    { testCommand: "npm test" },
  );
};

describe("最終レビューの、AI のレビューの過去の指摘の判定（PBI-287）", () => {
  it("S18 r2 の形（人の指摘1件・AI の指摘4件）で、観点・テストが合格なら、合格になる", () => {
    const review = finalReview(task(S18_REMARKS));
    expect(review.remarks.map((r) => [r.remarkId, r.notRecurred])).toEqual(
      ALL_IDS.map((id) => [id, true]),
    );
    expect(review.passed).toBe(true);
  });

  it("指示は、人の指摘と AI の指摘の両方を、1つずつ判定するよう求める。区別した節は保つ", () => {
    const prompt = buildFinalReviewPrompt(task(S18_REMARKS), "diff");
    expect(judgeLine(prompt)).toContain("人間の過去の指摘");
    expect(judgeLine(prompt)).toContain("AI のレビューの過去の指摘");
    expect(sectionIds(prompt, /人間の過去の指摘/)).toEqual(["requirements-2-1"]);
    expect(sectionIds(prompt, /AI のレビューの過去の指摘/)).toEqual(
      ALL_IDS.filter((id) => id !== "requirements-2-1"),
    );
    // 出力の形式の説明に、AI の指摘にも判定を書くこと・書かないと不合格になることを添える
    expect(prompt).toContain("AI のレビューの過去の指摘も、1件ずつ判定");
    expect(prompt).toContain("判定が無いと、再発している扱いで不合格になります");
  });

  it("AI の指摘への判定が無ければ、再発している扱いで不合格にする（判定を必ず求める形）", () => {
    const only = (ids: string[]) =>
      extractFinalReview(
        answer(
          "sacty-final-review",
          ids.map((id) => ({ id, notRecurred: true, reason: "ok" })),
          {
            tests: {
              command: "npm test",
              exitCode: 0,
              output: "ok",
              missingCommands: [],
              environmentFailures: [],
              otherFailures: [],
            },
          },
        ),
        ["REQ"],
        ALL_IDS,
        { testCommand: "npm test" },
      );
    const review = only(["requirements-2-1"]);
    expect(review.passed).toBe(false);
    expect(review.remarks.filter((r) => !r.notRecurred).map((r) => r.remarkId)).toEqual([
      "requirements-1-1",
      "requirements-1-2",
      "requirements-1-3",
      "requirements-1-4",
    ]);
    expect(only(ALL_IDS).passed).toBe(true);
  });

  it("AI の指摘が再発していると答えれば不合格にする", () => {
    const t = task(S18_REMARKS);
    const verdicts = literalVerdicts(buildFinalReviewPrompt(t, "diff")).map((v) =>
      v.id === "requirements-1-3" ? { ...v, notRecurred: false, reason: "再発している" } : v,
    );
    const review = extractFinalReview(
      answer("sacty-final-review", verdicts, { humanChecks: [] }),
      ["REQ"],
      ALL_IDS,
    );
    expect(review.passed).toBe(false);
  });

  it("指摘の数の境界：AI だけ（1件・複数件）・人だけ・無し・取り消した指摘で、判定する指摘と指示が合う", () => {
    const cases: [string, ReturnType<typeof remark>[]][] = [
      ["AI 1件", [remark("requirements-1-1", "sacty_review")]],
      ["AI 複数", S18_REMARKS.slice(0, 4)],
      ["人だけ", [remark("requirements-1-1"), remark("requirements-2-1")]],
      ["無し", []],
      [
        "取り消した AI の指摘",
        [
          { ...remark("requirements-1-1", "sacty_review"), voided: true },
          remark("requirements-1-2", "sacty_review"),
        ],
      ],
    ];
    for (const [name, remarks] of cases) {
      const t = task(remarks);
      const review = finalReview(t);
      expect(review.passed, name).toBe(true);
      expect(review.remarks.length, name).toBe(remarks.filter((r) => !r.voided).length);
    }
  });

  it("AI の指摘が無いときは、判定の念押しを足さない（AI の指摘が無い指示は、これまでと同じ）", () => {
    const prompt = buildFinalReviewPrompt(task([remark("requirements-1-1")]), "diff");
    expect(prompt).not.toContain("判定が無いと、再発している扱いで不合格になります");
  });

  it("テストの仕組みが無いタスクの最終レビューでも、AI の指摘に判定を求める", () => {
    const t = task(S18_REMARKS, {
      testCommand: undefined,
      noTestsReason: { summary: "無い", evidence: [] },
    });
    const prompt = buildFinalReviewPrompt(t, "diff");
    expect(judgeLine(prompt)).toContain("AI のレビューの過去の指摘");
    expect(prompt).toContain("判定が無いと、再発している扱いで不合格になります");
    const output = answer("sacty-final-review", literalVerdicts(prompt), { humanChecks: [] });
    expect(extractFinalReview(output, ["REQ"], ALL_IDS).passed).toBe(true);
  });
});

describe("統合レビューの、AI のレビューの過去の指摘の判定（PBI-287）", () => {
  const target = { baseBranch: "main", commit: "abc1234" };

  it("S18 r2 の形で、観点が合格・足りないことが無ければ、合格になる", () => {
    const t = task(S18_REMARKS);
    const prompt = buildIntegrationReviewPrompt(t, [], target);
    expect(judgeLine(prompt)).toContain("人間の過去の指摘");
    expect(judgeLine(prompt)).toContain("AI のレビューの過去の指摘");
    expect(prompt).toContain("判定が無いと、再発している扱いで不合格になります");
    const output = answer("sacty-integration-review", literalVerdicts(prompt), { findings: [] });
    const review = extractIntegrationReview(output, ["REQ"], ALL_IDS);
    expect(review.remarks.map((r) => [r.remarkId, r.notRecurred])).toEqual(
      ALL_IDS.map((id) => [id, true]),
    );
    expect(review.passed).toBe(true);
  });

  it("AI の指摘への判定が無ければ不合格にする", () => {
    const output = answer(
      "sacty-integration-review",
      [{ id: "requirements-2-1", notRecurred: true, reason: "ok" }],
      { findings: [] },
    );
    expect(extractIntegrationReview(output, ["REQ"], ALL_IDS).passed).toBe(false);
  });
});
