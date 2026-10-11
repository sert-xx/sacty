import { describe, expect, it } from "vitest";
import { commentableLines, extractReviewComments } from "./prompts.js";

const diff = [
  "diff --git a/src/retry.ts b/src/retry.ts",
  "index 1111111..2222222 100644",
  "--- a/src/retry.ts",
  "+++ b/src/retry.ts",
  "@@ -1,3 +1,3 @@",
  " import { pay } from './pay';",
  "-export const retry = 1;",
  "+export const retry = 3;",
  " export const once = 1;",
  "@@ -20,2 +20,3 @@ export function run() {",
  "   run();",
  "+  log();",
  "\\ No newline at end of file",
  "diff --git a/src/old.ts b/src/old.ts",
  "deleted file mode 100644",
  "--- a/src/old.ts",
  "+++ /dev/null",
  "@@ -1 +0,0 @@",
  "-old",
  "diff --git a/src/new.ts b/src/new.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/new.ts",
  "@@ -0,0 +1,2 @@",
  "+a",
  "+b",
].join("\n");

describe("PR の差分で行へのコメントを付けられる行（PBI-19）", () => {
  it("追加した行と前後の行の、先頭のファイルの行番号を返し、消した行・消したファイルは含めない", () => {
    const lines = commentableLines(diff);
    expect([...(lines.get("src/retry.ts") ?? [])]).toEqual([1, 2, 3, 20, 21]);
    expect([...(lines.get("src/new.ts") ?? [])]).toEqual([1, 2]);
    expect(lines.has("src/old.ts")).toBe(false);
  });
});

describe("レビューの出力から行へのコメントを取り出す（PBI-19）", () => {
  const block = (value: unknown) => `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;

  it("形式の正しくないものは捨て、ブロックは本文から取り除く", () => {
    const output = `# 評価\n\n${block({
      "sacty-review-comments": [
        { path: "src/new.ts", line: "2", body: "文字列の行番号も読む" },
        { path: "src/new.ts", line: 0, body: "0 行目" },
        { path: "src/new.ts", line: 1.5, body: "小数" },
        { path: "", line: 1, body: "パスが無い" },
        { path: "src/new.ts", line: 1, body: "" },
      ],
    })}`;
    expect(extractReviewComments(output, diff)).toEqual({
      output: "# 評価",
      comments: [{ path: "src/new.ts", line: 2, body: "文字列の行番号も読む" }],
    });
  });

  it("上限を超えた行へのコメントは本文に入れる", () => {
    const many = Array.from({ length: 51 }, (_, i) => ({
      path: "src/new.ts",
      line: 1,
      body: `指摘${i + 1}`,
    }));
    const result = extractReviewComments(block({ "sacty-review-comments": many }), diff);
    expect(result.comments).toHaveLength(50);
    expect(result.output).toContain("`src/new.ts:1` 指摘51");
    expect(result.output).not.toContain("指摘50\n");
  });
});
