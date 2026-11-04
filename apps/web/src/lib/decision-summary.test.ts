import { describe, expect, it } from "vitest";
import { SUMMARY_CHARS_MAX, summarizeDecision } from "./decision-summary";

describe("差し戻しの判断の文の要点（PBI-301）", () => {
  it("短い文（1〜2 文で上限以内）は、そのまま要点にして、全文は別に持たない", () => {
    expect(summarizeDecision("決定を変えない：表の整形だけ。実装に戻す。")).toEqual({
      summary: "決定を変えない：表の整形だけ。実装に戻す。",
    });
    expect(summarizeDecision("  実装に戻す  ")).toEqual({ summary: "実装に戻す" });
    expect(summarizeDecision("")).toEqual({ summary: "" });
  });

  it("長い判断の文は、先頭の 2 文を要点にして、全文は開いて読めるように持つ", () => {
    const text = `決定を変えない指摘なので、実装に戻す。指摘の行は R-8 と合っている。${"詳しい理由。".repeat(100)}`;
    const { summary, full } = summarizeDecision(text);
    expect(summary).toBe("決定を変えない指摘なので、実装に戻す。指摘の行は R-8 と合っている。");
    expect(full).toBe(text);
    expect(text.length).toBeGreaterThan(600);
  });

  it("1 文目が長すぎるときは、上限で切って「…」を付ける。全文は持つ", () => {
    const text = `${"あ".repeat(400)}。次の文。`;
    const { summary, full } = summarizeDecision(text);
    expect(summary).toBe(`${"あ".repeat(SUMMARY_CHARS_MAX)}…`);
    expect(full).toBe(text);
    // 句点が無い長い文も同じ
    expect(summarizeDecision("い".repeat(500)).summary).toBe(`${"い".repeat(SUMMARY_CHARS_MAX)}…`);
  });

  it("改行・英語の文・閉じ括弧で区切る（文の途中で切らない）", () => {
    expect(summarizeDecision("一行目\n二行目\n三行目").summary).toBe("一行目 二行目");
    expect(
      summarizeDecision("Keep the decision. Redo from implementation. Third sentence."),
    ).toEqual({
      summary: "Keep the decision. Redo from implementation.",
      full: "Keep the decision. Redo from implementation. Third sentence.",
    });
    expect(summarizeDecision("「戻す。」と読める。次の文。最後。").summary).toBe(
      "「戻す。」と読める。次の文。",
    );
    // 括弧の閉じ忘れがあっても、改行で区切り直す
    expect(summarizeDecision("「閉じ忘れ。\n次。\n三つ目。").summary).toBe("「閉じ忘れ。 次。");
    // 小数や版の「.」は文の終わりにしない
    expect(summarizeDecision("v1.2 を直す。もう一つ。三つ目。").summary).toBe(
      "v1.2 を直す。もう一つ。",
    );
  });

  it("要点はちょうど 2 文でも、続きがあれば全文を持つ（1 文だけなら、続きが無ければ持たない）", () => {
    expect(summarizeDecision("A。B。C。").full).toBe("A。B。C。");
    expect(summarizeDecision("A。B。").full).toBeUndefined();
    expect(summarizeDecision("A。").full).toBeUndefined();
  });
});
