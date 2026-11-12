import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildIntegrationReviewPrompt, extractIntegrationReview } from "./prompts.js";

/*
 * 統合レビューは、AI のレビューの過去の指摘にも再発の判定を求める（PBI-287。S18 r2 の回帰。最終レビューは PBI-331 でやめた）。
 * 判定を読む側（readVerdicts）は、AI のレビューの指摘も含めたすべての指摘に判定を求める。指示が人の指摘だけに判定を求めると、
 * 観点・人の指摘をすべて合格にしても、AI の指摘の判定が無くて不合格になる。
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
