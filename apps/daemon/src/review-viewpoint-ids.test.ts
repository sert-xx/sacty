import { renderMessage, type Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import {
  buildFinalReviewPrompt,
  buildIntegrationReviewPrompt,
  extractFinalReview,
  finalReviewViewpointIds,
  integrationViewpointIds,
} from "./prompts.js";

/*
 * 最終レビュー・統合レビューの出力の形式の例は、判定する実際の観点の ID を使う（PBI-137）。固定の例（TV-1）だと、設計を省いた
 * タスク（REQ）で、ゴールガーディアンが例の ID で答え、判定が無いとして不合格になっていた。
 */

const TV = (id: string) => ({ id, title: `観点${id}`, input: "入力", expected: "期待" });

const task = (steps: Task["steps"][number]["key"][], extra: Record<string, unknown> = {}) =>
  ({
    id: "t-1",
    title: "ログイン",
    body: "ログインできる",
    steps: steps.map((key) => ({ key, state: "todo" })),
    remarks: [],
    outputs: {},
    approved: { requirements: { output: "# 要求要件\n\n- REQ-1 ログインできる", submission: 1 } },
    reproductionTests: [],
    testMap: [],
    testCommand: "npm test",
    repository: {
      url: "https://github.com/acme/app",
      baseBranch: "main",
      baseCommit: "abcdef1234",
    },
    ...extra,
  }) as unknown as Task;

/** 指示文の最後の、出力の形式の例（JSON）の観点の ID。 */
function exampleIds(prompt: string): string[] {
  const blocks = [...prompt.matchAll(/```json\n(.*)\n```/g)];
  const json = JSON.parse(blocks.at(-1)?.[1] ?? "{}") as Record<
    string,
    { viewpoints: { id: string }[] }
  >;
  return Object.values(json)[0]?.viewpoints.map((v) => v.id) ?? [];
}

const noDesign = task(["investigate", "requirements", "implement"]);
const designed = task(["requirements", "design", "implement"], {
  approved: {
    requirements: { output: "# 要求要件", submission: 1 },
    design: { output: "# 設計", submission: 1, testViewpoints: [TV("TV-1"), TV("TV-2")] },
  },
});
const bugfix = task(["investigate", "reproduce", "implement"]);

describe("最終レビューの出力の形式の例の観点の ID", () => {
  it("設計を省いたタスクは REQ・不具合の修正は REPRO・設計のあるタスクはテスト観点の ID（すべて）", () => {
    expect(finalReviewViewpointIds(noDesign)).toEqual(["REQ"]);
    expect(exampleIds(buildFinalReviewPrompt(noDesign, "diff"))).toEqual(["REQ"]);
    expect(finalReviewViewpointIds(bugfix)).toEqual(["REPRO"]);
    expect(exampleIds(buildFinalReviewPrompt(bugfix, "diff"))).toEqual(["REPRO"]);
    expect(finalReviewViewpointIds(designed)).toEqual(["TV-1", "TV-2"]);
    expect(exampleIds(buildFinalReviewPrompt(designed, "diff"))).toEqual(["TV-1", "TV-2"]);
    // テストの仕組みが無いタスク（PBI-94）でも同じ
    const noTests = task(["requirements", "implement"], {
      testCommand: undefined,
      noTestsReason: { summary: "無い", evidence: [] },
    });
    expect(exampleIds(buildFinalReviewPrompt(noTests, "diff"))).toEqual(["REQ"]);
  });

  it("例の ID は、上に並べた観点と同じで、その ID のまま使うよう明示する。固定の TV-1 は出さない", () => {
    const prompt = buildFinalReviewPrompt(noDesign, "diff");
    expect(prompt).toContain("- [REQ] 承認済みの要求要件の受け入れ条件");
    expect(prompt).toContain("観点の id は、上のテスト観点の ID（REQ）を、そのまま使ってください");
    expect(prompt).not.toContain("TV-1");
  });
});

describe("統合レビューの出力の形式の例の観点の ID", () => {
  const target = { baseBranch: "main", commit: "abc" };
  it("設計にテスト観点が無ければ REQ、あればテスト観点の ID", () => {
    expect(exampleIds(buildIntegrationReviewPrompt(noDesign, [], target))).toEqual(
      integrationViewpointIds(noDesign),
    );
    expect(integrationViewpointIds(noDesign)).toEqual(["REQ"]);
    expect(exampleIds(buildIntegrationReviewPrompt(designed, [], target))).toEqual([
      "TV-1",
      "TV-2",
    ]);
    // 統合レビューの例には、直す必要があること（findings）も残す
    expect(buildIntegrationReviewPrompt(noDesign, [], target)).toContain(
      '"findings":["直す必要があること"]',
    );
  });
});

describe("判定する観点に無い ID で答えたとき", () => {
  const answer = (viewpoints: unknown[]) =>
    `\`\`\`json\n${JSON.stringify({ "sacty-final-review": { viewpoints, remarks: [], summary: "合格" } })}\n\`\`\``;

  it("読み替えずに不合格にし、理由に、判定する観点と答えた ID が違うことを出す", () => {
    const review = extractFinalReview(
      answer([{ id: "TV-1", verified: true, reason: "受け入れ条件を満たす" }]),
      ["REQ"],
      [],
    );
    expect(review.passed).toBe(false);
    expect(renderMessage(review.viewpoints[0]?.reason ?? "", "ja")).toBe(
      "観点 REQ の判定がありません（ゴールガーディアンは、判定する観点に無い ID TV-1 で答えました）。",
    );
    expect(renderMessage(review.viewpoints[0]?.reason ?? "", "en")).toContain("answered with TV-1");
  });

  it("判定する観点で答えていれば合格。観点が無いだけ（ほかの ID も無い）なら、今までどおり判定が無い", () => {
    expect(
      extractFinalReview(answer([{ id: "REQ", verified: true, reason: "ok" }]), ["REQ"], []).passed,
    ).toBe(true);
    const none = extractFinalReview(answer([]), ["REQ"], []);
    expect(none.passed).toBe(false);
    expect(renderMessage(none.viewpoints[0]?.reason ?? "", "ja")).toBe("判定がありません。");
    // 一部の観点だけ答えた（ほかの ID は無い）ときも、答えていない観点は「判定がありません」
    const partial = extractFinalReview(
      answer([{ id: "TV-1", verified: true, reason: "ok" }]),
      ["TV-1", "TV-2"],
      [],
    );
    expect(renderMessage(partial.viewpoints[1]?.reason ?? "", "ja")).toBe("判定がありません。");
  });
});
