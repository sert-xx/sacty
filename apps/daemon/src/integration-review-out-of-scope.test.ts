import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildIntegrationReviewPrompt } from "./prompts.js";

/*
 * 統合レビューは、範囲外の変更（AI のレビューの指摘に応えた変更の扱いを含む。PBI-289）を判定しない。範囲外の変更の判定は
 * 最終レビューだけのもので、最終レビューは PBI-331 でやめた。
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

describe("統合レビューと範囲外の変更の判定（PBI-289）", () => {
  it("統合レビューは範囲外の変更を判定しない", () => {
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
