import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildIntegrationReviewPrompt, integrationViewpointIds } from "./prompts.js";

/*
 * 統合レビューの出力の形式の例は、判定する実際の観点の ID を使う（PBI-137）。固定の例（TV-1）だと、設計を省いた
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
