import type { Task } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { buildReviewBody, buildReviewComments } from "./prompts.js";

/**
 * 投稿するレビューの本文・行へのコメントに、Sacty の過程の情報（作業の経過の文・判定が無い理由の中の観点の語・リスク評価の
 * 省略の案内・タスクの ID）を出さない（PBI-460）。
 */
const MARKER = /^<!-- sacty-review:[^>]*-->\n/;
const visible = (text: string) => text.replace(MARKER, "");

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: "t-460",
    title: "レビュー",
    body: "",
    steps: [{ key: "review", state: "active" }],
    remarks: [],
    outputs: { review: "## 総評\n\n問題はありません。" },
    approved: {},
    reproductionTests: [],
    reviewComments: [],
    reviewRound: 1,
    reviewVerdicts: [{ round: 1, verdict: "suggestions" }],
    reviewTarget: {
      repo: "https://github.com/acme/app",
      number: 12,
      url: "https://github.com/acme/app/pull/12",
      title: "retry",
      body: "",
      headCommit: "h".repeat(40),
      baseCommit: "b".repeat(40),
      author: "alice",
    },
    ...extra,
  }) as unknown as Task;

describe("投稿するレビューの本文の組み立て（PBI-460）", () => {
  it("総評の前に、作業の経過の文を足さない。判定の行と「## 総評」の間は空行だけで、経過の文の文字列も無い", () => {
    const body = buildReviewBody(task(), { risk: false });
    const lines = visible(body).split("\n");
    const verdictAt = lines.findIndex((l) => l.includes("判定："));
    const summaryAt = lines.indexOf("## 総評");
    expect(verdictAt).toBeGreaterThan(-1);
    expect(summaryAt).toBeGreaterThan(verdictAt);
    expect(lines.slice(verdictAt + 1, summaryAt).every((l) => l.trim() === "")).toBe(true);
    expect(body).not.toContain("レビューの本文を書きます");
    expect(body).not.toContain("集約しました");
  });

  it("判定が無い回の行は「判定：付いていません」で始まり、観点の語を含まない", () => {
    const body = buildReviewBody(task({ reviewVerdicts: [{ round: 1, missing: "absent" }] }));
    const line = visible(body)
      .split("\n")
      .find((l) => l.includes("判定："));
    // 先頭の @ メンションの後に、判定の行が続く
    expect(line?.replace(/^@\S+ /, "").startsWith("判定：付いていません")).toBe(true);
    expect(line).not.toContain("観点");
    expect(line).toContain("差分も対象の文書も読めなかった");
  });

  it("リスク評価の省略の案内は「リスク評価は長いため省略しました」だけで、画面・get_task・依頼した人への案内とタスクの ID を書かない", () => {
    const risk = {
      via: "review" as const,
      commit: "h".repeat(40),
      at: "2026-11-21T00:00:00.000Z",
      assessment: {
        level: "medium" as const,
        signals: [],
        change: "変更".repeat(32_000),
        scope: "範囲",
        reversibility: "戻せる",
        verification: "確かめた",
        focus: [],
      },
    };
    const body = buildReviewBody(
      task({
        outputs: { review: "## 総評\n\n指摘はありません。" },
        reviewVerdicts: [{ round: 1, verdict: "no_findings" }],
        riskAssessment: risk,
      }),
      { risk: true },
    );
    const text = visible(body);
    expect(text).toContain("リスク評価は長いため省略しました。");
    for (const word of ["画面", "get_task", "依頼した人", "Sacty のタスク", "t-460"]) {
      expect(text).not.toContain(word);
    }
    // 省略の案内の後ろに、案内の文が続かない
    const after = text.split("リスク評価は長いため省略しました。")[1] ?? "";
    expect(after.trimStart().startsWith("## 総評")).toBe(true);
  });
});

describe("行へのコメントの組み立て（PBI-460）", () => {
  it("各コメントは、目印の行とエージェントが書いた本文だけで、Sacty の文を足さず、タスクの ID は目印の外に無い", () => {
    const comments = [
      { path: "src/a.ts", line: 3, body: "[要修正] 上限が無い" },
      { path: "src/b.ts", line: 9, body: "[提案] 名前を変える" },
    ];
    const built = buildReviewComments(task({ reviewComments: comments }));
    expect(built).toHaveLength(2);
    for (const [i, c] of built.entries()) {
      const lines = c.body.split("\n");
      expect(lines[0]).toMatch(/^<!-- sacty-review:.*-->$/);
      expect(lines.slice(1).join("\n")).toBe(comments[i]?.body);
      expect(lines.slice(1).join("\n")).not.toContain("t-460");
    }
  });
});
