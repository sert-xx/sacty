import { describe, expect, it } from "vitest";
import { isChangeDocumentsOnly } from "./test-files.js";

// 前回の評価・レビュー以降の差分が文書だけかの判定（PBI-421）。

describe("isChangeDocumentsOnly", () => {
  it("文書の拡張子のファイルだけなら、文書だけにする", () => {
    expect(isChangeDocumentsOnly(["docs/a.md", "guide/b.rst"])).toBe(true);
  });

  it("文書でないファイル・判定できないファイル・空の差分は、文書だけにしない", () => {
    expect(isChangeDocumentsOnly(["docs/a.md", "src/x.ts"])).toBe(false);
    expect(isChangeDocumentsOnly(["notes.txt"])).toBe(false);
    expect(isChangeDocumentsOnly([])).toBe(false);
  });

  it("エージェントへの指示のファイルは、拡張子が文書でも、文書だけにしない", () => {
    expect(isChangeDocumentsOnly(["AGENTS.md"])).toBe(false);
    expect(isChangeDocumentsOnly(["sub/claude.md"])).toBe(false);
    expect(isChangeDocumentsOnly(["GEMINI.md"])).toBe(false);
    expect(isChangeDocumentsOnly([".claude/rules/a.md"])).toBe(false);
    // 名前の一部に含むだけのものは、指示ではない
    expect(isChangeDocumentsOnly(["docs/agents-guide.md"])).toBe(true);
  });
});
