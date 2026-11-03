import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildFinalReviewPrompt, buildIntegrationReviewPrompt } from "./prompts.js";

/*
 * 最終レビューの範囲外の変更の判定で、AI のレビューの指摘に応えた変更を扱う（PBI-289。S16 r2 の振る舞いの回帰を防ぐ）。
 * AI のレビューの指摘は人間が承認したものではないので、人間の指摘と同じには扱わない。要求要件・設計（省いたタスクは依頼）に対する
 * 欠陥の修正は範囲内。それを超えて振る舞いを変える変更は、不合格にせず、どの指摘に応えたかを添えて humanChecks に回す。
 */

const remark = (id: string, source?: "sacty_review", voided = false) => ({
  id,
  step: "design",
  round: Number(id.split("-")[1]),
  text: source ? `AI: ${id}` : `人: ${id}`,
  voided,
  ...(source ? { source } : {}),
});

const task = (
  remarks: ReturnType<typeof remark>[] = [],
  extra: Record<string, unknown> = {},
): Task =>
  ({
    id: "t-1",
    title: "会議室を廃止する",
    body: "会議室を廃止できるようにする",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks,
    outputs: { implement: "# 実装の説明" },
    approved: { requirements: { output: "# 要求要件", submission: 1 } },
    reproductionTests: [],
    testMap: [{ viewpointId: "REQ", tests: ["rooms.test.ts"] }],
    exports: {},
    stepPullRequests: [],
    proposals: [],
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    ...extra,
  }) as unknown as Task;

/** 範囲外の変更の節（次の `--- ` の見出しまで）。 */
function scopeSection(prompt: string): string {
  const lines = prompt.split("\n");
  const at = lines.indexOf("--- 範囲外の変更 ---");
  if (at < 0) throw new Error("範囲外の変更の節がありません");
  const end = lines.findIndex((l, i) => i > at && l.startsWith("--- "));
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

const AI_LINE =
  "AI のレビューの過去の指摘（人間の指摘ではなく、人間が承認したものでもない）に応えた変更";
const TEST_LINE = "既存のテストの期待を弱める・逆にする変更は、AI の指摘に応えたものでも";

describe("最終レビューの範囲外の変更の判定と、AI のレビューの指摘（PBI-289）", () => {
  it("AI の指摘があれば、欠陥の修正は範囲内、それを超える変更は不合格にせず、どの指摘かを添えて humanChecks に回すよう指示する", () => {
    const section = scopeSection(
      buildFinalReviewPrompt(task([remark("design-1-1", "sacty_review")]), "diff", {
        testCommand: "npm test",
      }),
    );
    expect(section).toContain(AI_LINE);
    expect(section).toContain("AI の指摘だけを根拠に範囲内としない");
    // 欠陥の修正は範囲内
    expect(section).toContain(
      "に対する欠陥（満たしていない・実現が壊れている・不具合）の修正なら、範囲内とする",
    );
    // 超える変更は不合格にしない。humanChecks に、どの AI の指摘に応えた変更かを添えて書く
    expect(section).toContain(
      "要求要件・設計に無い機能・操作の追加、既存の振る舞いの変更）は、AI の指摘に応えたものでも、outOfScope に書かず、不合格にしない",
    );
    expect(section).toContain(
      "humanChecks に「範囲内か判断できない：<ファイルと変更の内容>（AI のレビューの指摘 <指摘の id> に応えた変更で、要求要件・設計に無い）」を書く",
    );
    // 応えたと確かめられない変更は、AI の指摘が無いときと同じ
    expect(section).toContain(
      "AI の指摘に応えたと確かめられない変更は、AI の指摘が無いときと同じに判定する",
    );
  });

  it("既存のテストの期待を弱める・逆にする変更は、AI の指摘だけでは範囲内にせず、不合格にする（今と同じ）", () => {
    const section = scopeSection(
      buildFinalReviewPrompt(task([remark("design-1-1", "sacty_review")]), "diff"),
    );
    expect(section).toContain(TEST_LINE);
    expect(section).toContain(
      "承認済みの要求要件・設計が求めているときだけ範囲内とする。AI の指摘だけでは範囲内にせず、outOfScope に書いて不合格にする",
    );
    // 元の項目（要求要件・設計が求めるときだけ範囲内）は残る
    expect(section).toContain(
      "が、そのテストの確かめている振る舞いを変えることを求めているときだけ範囲内とする",
    );
  });

  it("人間の過去の指摘の扱いは変えない（求めている変更は範囲内。AI の指摘と並んでも同じ）", () => {
    const human = scopeSection(buildFinalReviewPrompt(task([remark("design-1-1")]), "diff"));
    const both = scopeSection(
      buildFinalReviewPrompt(
        task([remark("design-1-1"), remark("design-2-1", "sacty_review")]),
        "diff",
      ),
    );
    const humanFirst =
      "人間の過去の指摘のどれかが求めている変更か、求めている変更を実現するのに要る変更かを確かめる";
    expect(human).toContain(humanFirst);
    expect(both).toContain(humanFirst);
    // 人間の指摘への扱いを AI の指摘の項目で弱めていない
    expect(both).not.toContain("人間の指摘を根拠に範囲内としない");
  });

  it("AI の指摘が無いタスクの指示は、今と変わらない（無い・人の指摘だけ・取り消した AI の指摘だけ）", () => {
    const baseline = scopeSection(buildFinalReviewPrompt(task(), "diff"));
    for (const t of [
      task([remark("design-1-1")]),
      task([remark("design-1-1", "sacty_review", true)]),
      task([remark("design-1-1"), remark("design-2-1", "sacty_review", true)]),
    ]) {
      const section = scopeSection(buildFinalReviewPrompt(t, "diff"));
      expect(section).toBe(baseline);
      expect(section).not.toContain("AI の指摘");
      expect(section).not.toContain(AI_LINE);
    }
  });

  it("AI の指摘の件数（1件・複数件）によらず、同じ指示を1回だけ足す。足すのは AI の項目だけで、ほかの項目は変えない", () => {
    const baseline = scopeSection(buildFinalReviewPrompt(task(), "diff")).split("\n");
    for (const remarks of [
      [remark("design-1-1", "sacty_review")],
      [
        remark("design-1-1", "sacty_review"),
        remark("design-1-2", "sacty_review"),
        remark("design-2-1"),
      ],
    ]) {
      const section = scopeSection(buildFinalReviewPrompt(task(remarks), "diff")).split("\n");
      expect(section.filter((l) => l.includes(AI_LINE))).toHaveLength(1);
      expect(section.filter((l) => l.includes(TEST_LINE))).toHaveLength(1);
      expect(section.filter((l) => !l.includes("AI の指摘"))).toEqual(baseline);
    }
  });

  it("テストのコマンドが無い・要求要件と設計を省いた・テストの仕組みが無いタスクでも、AI の指摘があれば同じ指示がある", () => {
    const ai = [remark("design-1-1", "sacty_review")];
    for (const prompt of [
      buildFinalReviewPrompt(task(ai), "diff"),
      buildFinalReviewPrompt(task(ai, { steps: [{ key: "implement", state: "active" }] }), "diff"),
      buildFinalReviewPrompt(
        task(ai, { noTestsReason: { summary: "無い", evidence: [] }, testMap: [] }),
        "diff",
        { testCommand: "npm test" },
      ),
    ]) {
      expect(scopeSection(prompt)).toContain(AI_LINE);
    }
  });

  it("セキュリティ対応には入れない（範囲外の判定が無い）", () => {
    const prompt = buildFinalReviewPrompt(
      task([remark("design-1-1", "sacty_review")], { requestedPlan: "security-fix" }),
      "diff",
    );
    expect(prompt).not.toContain("--- 範囲外の変更 ---");
    expect(prompt).not.toContain(AI_LINE);
  });

  it("指示の書き方は、特定の言語・ツールに寄せない", () => {
    const section = scopeSection(
      buildFinalReviewPrompt(task([remark("design-1-1", "sacty_review")]), "diff"),
    );
    const ai = section.split("\n").filter((l) => l.includes("AI の指摘"));
    expect(ai.length).toBeGreaterThan(0);
    for (const line of ai) {
      expect(line).not.toMatch(/Node|npm|TypeScript|\.ts\b|vitest|pytest|Python|Java|Rust/);
    }
  });

  it("統合レビューは範囲外の変更を判定しない（この指示を使う所は最終レビューだけ）", () => {
    const prompt = buildIntegrationReviewPrompt(
      task([remark("design-1-1", "sacty_review")], {
        steps: [{ key: "requirements", state: "done" }],
      }),
      [],
      { baseBranch: "main", commit: "abcdef1234" },
    );
    expect(prompt).not.toContain("--- 範囲外の変更 ---");
  });
});
