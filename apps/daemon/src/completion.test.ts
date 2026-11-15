import { COMPLETION_REMAINING_ITEM_MAX, COMPLETION_REMAINING_MAX } from "@sacty/core";
import { describe, expect, it } from "vitest";
import { COMPLETION_HEADING, extractCompletion, implementCompletionLines } from "./completion.js";
import { extractBlocks } from "./prompts.js";

const block = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
const declare = (value: unknown) => block({ [COMPLETION_HEADING]: value });

describe("実装の完了の申告（PBI-347）", () => {
  it("指示は、実行の終わりが提出になることと、完了・未完了の申告の形を伝える（受け入れ条件 1）", () => {
    const lines = implementCompletionLines().join("\n");
    expect(lines).toContain("--- 完了の申告 ---");
    expect(lines).toContain("この実行が終わると、sacty は作業領域の内容をそのまま提出する");
    expect(lines).toContain("必ず申告する");
    expect(lines).toContain("申告が無い実行は、未完了として扱い、提出しない");
    expect(lines).toContain('{"sacty-completion":{"status":"complete"}}');
    expect(lines).toContain('"status":"incomplete","remaining":[');
  });

  it("完了の申告を読む", () => {
    expect(extractCompletion(`説明\n\n${declare({ status: "complete" })}`).completion).toEqual({
      status: "complete",
    });
  });

  it("未完了の申告は、残っていることと一緒に読む。空の項目は除く", () => {
    const read = extractCompletion(
      declare({ status: "incomplete", remaining: ["API の入力", "  ", " docs の更新 "] }),
    );
    expect(read.completion).toEqual({
      status: "incomplete",
      remaining: ["API の入力", "docs の更新"],
    });
  });

  it("未完了の申告は、残っていることが無い・読めなくても未完了にする", () => {
    expect(extractCompletion(declare({ status: "incomplete" })).completion).toEqual({
      status: "incomplete",
      remaining: [],
    });
    expect(
      extractCompletion(declare({ status: "incomplete", remaining: "全部" })).completion,
    ).toEqual({ status: "incomplete", remaining: [] });
    expect(
      extractCompletion(declare({ status: "incomplete", remaining: ["API", 3] })).completion,
    ).toEqual({ status: "incomplete", remaining: [] });
  });

  it("完了と申告していても、残っていることが一覧として読めない形なら、申告なしにする（完了として提出に進めない）", () => {
    for (const remaining of ["docs", [3], ["docs", 3], { a: 1 }, null, 0, true]) {
      expect(
        extractCompletion(declare({ status: "complete", remaining })).completion,
        JSON.stringify(remaining),
      ).toBeUndefined();
    }
    // 空の項目だけの一覧は、残っていることが無い
    expect(
      extractCompletion(declare({ status: "complete", remaining: ["", "  "] })).completion,
    ).toEqual({
      status: "complete",
    });
  });

  it("完了と申告していても、残っていることがあれば未完了にする", () => {
    expect(
      extractCompletion(declare({ status: "complete", remaining: ["docs の更新"] })).completion,
    ).toEqual({ status: "incomplete", remaining: ["docs の更新"] });
    // 残っていることが空なら完了
    expect(extractCompletion(declare({ status: "complete", remaining: [] })).completion).toEqual({
      status: "complete",
    });
  });

  it("残っていることは、件数と1件の長さの上限で切る。文字の途中（サロゲートペアの間）では切らない", () => {
    const remaining = Array.from({ length: COMPLETION_REMAINING_MAX + 5 }, (_, i) =>
      i === 0 ? "あ".repeat(COMPLETION_REMAINING_ITEM_MAX + 50) : `残り${i}`,
    );
    const read = extractCompletion(declare({ status: "incomplete", remaining })).completion;
    expect(read?.status).toBe("incomplete");
    if (read?.status !== "incomplete") return;
    expect(read.remaining).toHaveLength(COMPLETION_REMAINING_MAX);
    expect(read.remaining[0]?.length).toBeLessThanOrEqual(COMPLETION_REMAINING_ITEM_MAX);
    expect(read.remaining[0]?.endsWith("…")).toBe(true);
    // 上限の位置が絵文字（サロゲートペア）の途中に当たる
    const emoji = `${"a".repeat(COMPLETION_REMAINING_ITEM_MAX - 2)}😀😀😀`;
    const cutEmoji = extractCompletion(
      declare({ status: "incomplete", remaining: [emoji] }),
    ).completion;
    if (cutEmoji?.status !== "incomplete") throw new Error("not incomplete");
    const [item = ""] = cutEmoji.remaining;
    expect(item.length).toBeLessThanOrEqual(COMPLETION_REMAINING_ITEM_MAX);
    // 壊れたサロゲート（対になっていない上位・下位）が残っていない
    expect(item).toBe(item.toWellFormed());
  });

  it("申告が無い・状態が分からない申告は、申告なしにする", () => {
    expect(extractCompletion("# 実装の説明\n\n実装は未完了です。").completion).toBeUndefined();
    expect(extractCompletion(declare({ status: "done" })).completion).toBeUndefined();
    expect(extractCompletion(declare("complete")).completion).toBeUndefined();
    expect(extractCompletion(declare(["complete"])).completion).toBeUndefined();
  });

  it("申告が複数あれば最後のものを使い、最後が読めなければ前の申告に戻らない", () => {
    const earlier = declare({ status: "incomplete", remaining: ["テスト"] });
    const later = declare({ status: "complete" });
    expect(extractCompletion(`${earlier}\n\n続き\n\n${later}`).completion).toEqual({
      status: "complete",
    });
    expect(extractCompletion(`${later}\n\n続き\n\n${earlier}`).completion).toEqual({
      status: "incomplete",
      remaining: ["テスト"],
    });
    // 最後の申告が JSON として読めない（末尾のカンマ）
    const broken = '```json\n{"sacty-completion": {"status": "complete",}}\n```';
    expect(extractCompletion(`${earlier}\n\n${broken}`).completion).toBeUndefined();
  });

  it("実装の工程の出力からは、申告を読んで本文から取り除く。読めない申告も本文から取り除く", () => {
    const output = ["# 実装の説明", declare({ status: "incomplete", remaining: ["docs"] })].join(
      "\n\n",
    );
    const read = extractBlocks(output, new Set(), [], { completion: true });
    expect(read.completion).toEqual({ status: "incomplete", remaining: ["docs"] });
    expect(read.output).toBe("# 実装の説明");
    const broken = '# 実装の説明\n\n```json\n{"sacty-completion": {"status": "complete",}}\n```';
    const unread = extractBlocks(broken, new Set(), [], { completion: true });
    expect(unread.completion).toBeUndefined();
    expect(unread.output).not.toContain("sacty-completion");
  });

  it("実装でない工程の成果物にある同じ見出しの JSON は、申告として扱わず、本文に残す", () => {
    const output = ["# 設計", declare({ status: "complete" })].join("\n\n");
    const read = extractBlocks(output, new Set(), []);
    expect(read.completion).toBeUndefined();
    expect(read.output).toContain("sacty-completion");
  });
});
