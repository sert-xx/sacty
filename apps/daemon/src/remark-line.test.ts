import { describe, expect, it } from "vitest";
import { GIST_MAX, normalizeGist, withoutRemarkIds } from "./remark-ids.js";
import { markdownText, remarkLine } from "./remark-line.js";

describe("withoutRemarkIds（文の中の指摘の ID。TV-4）", () => {
  it.each([
    ["直しました（implement-1-1・implement-1-2 への対応）。", "直しました。"],
    ["指摘 implement-1-3 を直しました。", "指摘を直しました。"],
    ["implement-1-1 と implement-1-2 を直しました。", "指摘を直しました。"],
    ["implement-1-4〜1-6 は直しました。", "指摘は直しました。"],
    ["design-1-2 の件で、エラーの文言を変えました。", "指摘の件で、エラーの文言を変えました。"],
  ])("%s", (input, expected) => {
    expect(withoutRemarkIds(input)).toBe(expected);
  });
});

describe("remarkLine（指摘を示す1行。TV-14・TV-21・TV-22）", () => {
  it("要点があればそれを使い、ID・URL・改行を除いて 120 文字（… を含む）までにする", () => {
    const line = remarkLine(
      {
        gist: `# 見て https://example.com/x\n（implement-1-1 への対応）${"あ".repeat(200)}`,
        text: "全文",
      },
      [],
    );
    expect(line).not.toContain("implement-1-1");
    expect(line).not.toContain("https://");
    expect(line).not.toContain("\n");
    expect(line).not.toContain("（）");
    expect(line.length).toBeLessThanOrEqual(GIST_MAX);
    expect(line.endsWith("…")).toBe(true);
  });

  it("要点が無ければ、目印・見出し・引用を除いた最初の行を使い、行の内容の写しは使わない", () => {
    const text =
      "<!-- sacty-review:abc -->\n## Sacty のレビュー\n> 引用\n入力が空のとき落ちる\n（コメントが付いた行の内容：「x」）";
    expect(remarkLine({ text }, [])).toBe("入力が空のとき落ちる");
  });

  it("秘密の値を伏せ、@ の通知を無効にする", () => {
    const line = remarkLine({ text: "@someone s3cr3t-value を使う" }, ["s3cr3t-value"]);
    expect(line).not.toContain("s3cr3t-value");
    expect(line).not.toContain("@someone");
  });

  it("題の上限で切る", () => {
    expect(remarkLine({ gist: "あ".repeat(100), text: "" }, [], 80)).toHaveLength(80);
  });
});

describe("normalizeGist・markdownText", () => {
  it("要点の改行・前後の空白を除き、120 文字までにする", () => {
    const gist = normalizeGist(` 1行目\n2行目${"い".repeat(300)} `);
    expect(gist).not.toContain("\n");
    expect(gist.length).toBeLessThanOrEqual(GIST_MAX);
  });

  it("行頭の記法とバッククォートを、文字として出す", () => {
    expect(markdownText("# 見出し `a`")).toBe("\\# 見出し \\`a\\`");
    expect(markdownText("- 項目")).toBe("\\- 項目");
  });
});
