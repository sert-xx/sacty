import type { FinalReview, Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildPrompt } from "./prompts.js";

// 依頼にも承認済みの要求要件・設計にも無い変更（範囲外の変更）を、最終レビューで不合格にする（PBI-273）

const OUT = "styles.css の狭い画面のカード表示：どの要求要件・設計にも無い";

const task = (extra: Partial<Task> = {}) =>
  ({
    id: "t-1",
    title: "会議室を廃止する",
    body: "会議室を廃止できるようにする",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    remarks: [],
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

describe("範囲外の変更の指示と、やり直しの伝え方（PBI-273）", () => {
  const failed = (reason: string): FinalReview => ({
    passed: false,
    viewpoints: [
      { viewpointId: "REQ", verified: true, reason: "ok" },
      { viewpointId: "SCOPE", verified: false, reason },
    ],
    remarks: [],
    summary: "範囲外の変更がある",
    agentId: "claude",
    runId: "r1",
    costUsd: 0,
    estimated: false,
    at: "2026-10-24T10:00:00.000Z",
  });

  it("実装のやり直しに、挙げられた変更だけを起点の状態に戻して外し、ほかは残すこと、外した後に差分で確かめることを伝える", () => {
    const prompt = buildPrompt(
      task({ verifyFeedback: { kind: "review", review: failed(OUT) } } as Partial<Task>),
      "implement",
    );
    expect(prompt).toContain(`[SCOPE] 観点を検証できていない：${OUT}`);
    expect(prompt).toContain("起点のコードの状態に戻して外してください");
    expect(prompt).toContain("外すのは、挙げられた変更だけにする");
    expect(prompt).toContain("起点のコードにあった指定やテストの期待は、そのまま残す");
    expect(prompt).toContain("変更の無い再提出はしないでください");
  });

  it("ベースブランチを取り込んだ後は、戻し先を取り込んだ先頭の状態にし、ベースブランチ側の変更を残すと伝える（起点のコードに戻させない）", () => {
    const prompt = buildPrompt(
      task({
        verifyFeedback: { kind: "review", review: failed(OUT) },
        baseMerge: { commit: "fedcba9876543210", conflicts: [] },
      } as unknown as Partial<Task>),
      "implement",
    );
    expect(prompt).toContain(
      "ベースブランチを取り込んだ先頭（fedcba9）のコードの状態に戻して外してください",
    );
    expect(prompt).toContain("ベースブランチ側の変更（取り込んだ先頭に含まれるもの）");
    expect(prompt).toContain("ベースブランチを取り込んだ先頭（fedcba9）のコードの状態の期待に戻す");
    expect(prompt).not.toContain("起点のコードの状態に戻して外してください");
    expect(prompt).not.toContain("起点のコードにあった指定");
  });

  it("既存のテストの期待を変えてよい根拠は、要求要件・設計を省いたタスクでは依頼や再現のテストにする（やり直しの指示）", () => {
    const prompt = buildPrompt(
      task({ verifyFeedback: { kind: "review", review: failed(OUT) } } as Partial<Task>),
      "implement",
    );
    expect(prompt).toContain("これらを省いたタスクは、依頼や再現のテストのどの部分によるか");
  });

  it("SCOPE が不合格でない差し戻しには、この伝え方を足さない", () => {
    const other: FinalReview = {
      ...failed("x"),
      viewpoints: [{ viewpointId: "REQ", verified: false, reason: "形だけ" }],
    };
    const prompt = buildPrompt(
      task({ verifyFeedback: { kind: "review", review: other } } as Partial<Task>),
      "implement",
    );
    expect(prompt).not.toContain("[SCOPE]");
    expect(prompt).not.toContain("起点のコードの状態に戻して外してください");
  });
});
