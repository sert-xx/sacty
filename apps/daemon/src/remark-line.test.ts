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

describe("remarkLine と withoutRemarkIds の取りこぼし（PBI-471 の指摘への対応）", () => {
  it("要点が無く、全文の最初の行に ID・内部のパス・長文がある指摘も、整えて伏せる", () => {
    const line = remarkLine(
      {
        text: `<!-- sacty-review:x -->\n（implement-1-1 への対応）/sacty-input/a.md を見て @bob ${"長".repeat(200)}`,
      },
      [],
    );
    expect(line).not.toContain("implement-1-1");
    expect(line).not.toContain("/sacty-input/");
    expect(line).not.toContain("@bob");
    expect(line).not.toMatch(/[（(]\s*[）)]/);
    expect(line.length).toBeLessThanOrEqual(GIST_MAX);
  });

  it.each([
    "www.example.com/x を見て",
    "//example.com/x を見て",
    "HTTPS://EXAMPLE.COM/x を見て",
    "Https://example.com/x を見て",
  ])("リンクになりうる文字列を除く：%s", (gist) => {
    const line = remarkLine({ gist, text: "" }, []);
    expect(line.toLowerCase()).not.toContain("example.com");
  });

  it("記法になる文字を、行のどこにあっても文字として出す", () => {
    expect(markdownText("<!-- 後ろを隠す owner/repo#12 [x](y)")).toBe(
      "\\<!-- 後ろを隠す owner/repo\\#12 \\[x\\](y)",
    );
  });

  it("閉じ括弧の無い長い空白の並びでも、時間がかからない", () => {
    const start = performance.now();
    withoutRemarkIds(`(implement-1-1${" ".repeat(60_000)}`);
    withoutRemarkIds(`${" ".repeat(60_000)}(implement-1-1`);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
