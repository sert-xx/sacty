import { describe, expect, it } from "vitest";
import { reviewCiLines } from "./prompts.js";

describe("PR のレビューの子タスクに渡す CI の結果（PBI-331）", () => {
  it("項目が上限を超えても、失敗・実行中の項目は省かずに渡し、省くのは通ったものだけにする（PR #348 4回目のレビュー指摘）", () => {
    const passing = Array.from({ length: 40 }, (_, i) => ({
      kind: "check" as const,
      name: `ok-${i}`,
      status: "completed" as const,
      conclusion: i % 2 === 0 ? "success" : "skipped",
    }));
    const lines = reviewCiLines({
      commit: "abcdef1234567",
      checks: [
        ...passing,
        { kind: "check", name: "tests", status: "completed", conclusion: "failure" },
        { kind: "check", name: "e2e", status: "pending" },
        { kind: "check", name: "deploy", status: "completed", conclusion: "cancelled" },
      ],
    });
    const text = lines.join("\n");
    expect(text).toContain("  - tests：failure");
    expect(text).toContain("  - e2e：実行中");
    expect(text).toContain("  - deploy：cancelled");
    // 上限（30件）のうち、残りを通ったもので埋め、それ以外は件数だけ
    expect(lines.filter((l) => l.startsWith("  - ok-"))).toHaveLength(27);
    expect(text).toContain("  - ほか 13 件（すべて通ったもの）");
  });

  it("失敗・実行中の項目が上限より多くても、すべて渡す", () => {
    const failing = Array.from({ length: 35 }, (_, i) => ({
      kind: "check" as const,
      name: `ng-${i}`,
      status: "completed" as const,
      conclusion: "failure",
    }));
    const lines = reviewCiLines({
      commit: "abcdef1234567",
      checks: [
        { kind: "check", name: "ok", status: "completed", conclusion: "success" },
        ...failing,
      ],
    });
    expect(lines.filter((l) => l.startsWith("  - ng-"))).toHaveLength(35);
    expect(lines).not.toContain("  - ok：success");
    expect(lines).toContain("  - ほか 1 件（すべて通ったもの）");
  });
});
