import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTestFiles, isDocumentsOnly, looksLikeTestFile, noTestsStop } from "./test-files.js";

describe("テストのファイルらしいものを探す（PBI-94）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sacty-test-files-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (files: string[]) => {
    for (const file of files) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      writeFileSync(join(dir, file), "");
    }
  };

  it("言語に依らないテストのファイルの名付けの慣習に当たる", () => {
    for (const name of [
      "pay.test.ts",
      "pay.spec.js",
      "pay_test.go",
      "test_pay.py",
      "pay_spec.rb",
      "PayTest.java",
      "PayTests.cs",
      "TestPay.cs",
      "test.sh",
      "tests",
      "e2e-test.yml",
    ]) {
      expect(looksLikeTestFile(name), name).toBe(true);
    }
  });

  it("単語の一部に含むだけ・テストについての文書は当たらない", () => {
    for (const name of [
      "README.md",
      "latest.json",
      "contest.md",
      "Attest.kt",
      "inspect.py",
      "TESTING.md",
      "testing.md",
      "spec.md",
      "Testament.txt",
      "manifest.json",
    ]) {
      expect(looksLikeTestFile(name), name).toBe(false);
    }
  });

  it("README だけのリポジトリでは見つからず、すべてを見たとする", () => {
    put(["README.md", "docs/guide.md", ".git/hooks/pre-commit.test"]);
    expect(findTestFiles(dir)).toEqual({ files: [], complete: true });
  });

  it("テストのディレクトリの中のファイル・テストの名前のファイルを、浅いものから返す", () => {
    put(["src/pay.ts", "src/deep/pay.test.ts", "tests/helpers.py", "__tests__/a.js"]);
    expect(findTestFiles(dir)).toEqual({
      files: ["__tests__/a.js", "tests/helpers.py", "src/deep/pay.test.ts"],
      complete: true,
    });
    expect(findTestFiles(dir, { max: 1 }).files).toEqual(["__tests__/a.js"]);
  });

  it("上限まで見ても見つからない・作業領域を読めないなら、確かめきれなかったとする", () => {
    put(["a.md", "b.md", "c.md"]);
    expect(findTestFiles(dir, { limit: 2 })).toEqual({
      files: [],
      complete: false,
      incomplete: { reason: "limit", limit: 2 },
    });
    expect(findTestFiles(join(dir, "missing"))).toEqual({
      files: [],
      complete: false,
      incomplete: { reason: "unreadable", path: ".", detail: "ENOENT" },
    });
  });
});

describe("テストのファイル探しの抜け（PR #105 レビュー指摘）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sacty-test-files-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("中のディレクトリを読めなければ、どこが・なぜ読めなかったかを返し、確かめきれなかったとする", () => {
    mkdirSync(join(dir, "src", "locked"), { recursive: true });
    writeFileSync(join(dir, "src", "locked", "pay_test.go"), "");
    writeFileSync(join(dir, "README.md"), "");
    // 実行するユーザーの権限に左右されないよう、列挙の失敗を差し替えて作る（PR #105 再レビュー指摘）
    const readDir = (path: string) => {
      if (path === join(dir, "src", "locked")) {
        throw Object.assign(new Error("permission denied"), { code: "EACCES" });
      }
      return readdirSync(path, { withFileTypes: true });
    };
    expect(findTestFiles(dir, { readDir })).toEqual({
      files: [],
      complete: false,
      incomplete: { reason: "unreadable", path: "src/locked", detail: "EACCES" },
    });
    // コードの無いエラーは、エラーの文を理由にする
    const noCode = (path: string) => {
      if (path === join(dir, "src")) throw new Error("I/O error");
      return readdirSync(path, { withFileTypes: true });
    };
    expect(findTestFiles(dir, { readDir: noCode }).incomplete).toEqual({
      reason: "unreadable",
      path: "src",
      detail: "I/O error",
    });
  });

  it("文書のファイルは、テストのディレクトリの中でも・テストの名前でも当てない", () => {
    for (const name of ["test-plan.md", "pay.test.txt", "Test.rst", "tests.adoc"]) {
      expect(looksLikeTestFile(name), name).toBe(false);
    }
    mkdirSync(join(dir, "tests"));
    writeFileSync(join(dir, "tests", "README.md"), "");
    writeFileSync(join(dir, "tests", "NOTES.TXT"), "");
    expect(findTestFiles(dir)).toEqual({ files: [], complete: true });
    writeFileSync(join(dir, "tests", "run.sh"), "");
    expect(findTestFiles(dir).files).toEqual(["tests/run.sh"]);
  });
});

describe("止める理由の文言（PR #105 再レビュー指摘）", () => {
  it("見つかった・上限に達した・読めないディレクトリがあった、で文言を分け、問題が無ければ止めない", () => {
    expect(noTestsStop("無い", { files: [], complete: true })).toBeUndefined();
    expect(noTestsStop("無い", { files: ["tests/a.py"], complete: false })).toEqual({
      code: "orchestrator.noTestsContradicted",
      params: { reason: "無い", files: "tests/a.py" },
    });
    expect(
      noTestsStop("無い", {
        files: [],
        complete: false,
        incomplete: { reason: "limit", limit: 20000 },
      }),
    ).toEqual({ code: "orchestrator.noTestsUncertain", params: { reason: "無い" } });
    expect(
      noTestsStop("無い", {
        files: [],
        complete: false,
        incomplete: { reason: "unreadable", path: "src/locked", detail: "EACCES" },
      }),
    ).toEqual({
      code: "orchestrator.noTestsUnreadable",
      params: { reason: "無い", path: "src/locked", detail: "EACCES" },
    });
  });
});

describe("差分が文書のファイルだけか（PBI-158）", () => {
  it("文書の拡張子のファイルだけなら true（大文字・小文字、深いパス、複数の拡張子）", () => {
    expect(isDocumentsOnly(["README.md"])).toBe(true);
    expect(isDocumentsOnly(["docs/a.md", "docs/deep/b.MARKDOWN", "x/y.rst"])).toBe(true);
    expect(isDocumentsOnly(["guide.adoc", "guide.asciidoc", "plan.org"])).toBe(true);
    // テストのディレクトリの中の文書やテストについての文書も、文書
    expect(isDocumentsOnly(["tests/README.md", "docs/TESTING.md"])).toBe(true);
  });

  it("コードなど文書でないファイルが1つでもあれば false（コードだけ・文書とコードの混在）", () => {
    expect(isDocumentsOnly(["main.go"])).toBe(false);
    expect(isDocumentsOnly(["docs/a.md", "main.go"])).toBe(false);
    expect(isDocumentsOnly(["main.go", "docs/a.md"])).toBe(false);
    // `.txt` は、依存やビルドの定義にも使われるので、文書とは見なさない（テストのファイルを探すときは文書のまま）
    for (const name of [
      "notes.txt",
      "requirements.txt",
      "constraints.txt",
      "CMakeLists.txt",
      "docs/CMakeLists.txt",
    ]) {
      expect(isDocumentsOnly(["README.md", name]), name).toBe(false);
      expect(isDocumentsOnly([name]), name).toBe(false);
    }
    expect(looksLikeTestFile("test_cases.txt")).toBe(false);
    // 設定・画像・拡張子の無いファイルは文書とは見なさない
    expect(isDocumentsOnly(["README.md", "docs/diagram.png"])).toBe(false);
    expect(isDocumentsOnly(["README.md", "Makefile"])).toBe(false);
    expect(isDocumentsOnly(["README.md", ".github/workflows/ci.yml"])).toBe(false);
    // 拡張子が文書でも、文書の拡張子が名前の一部に入っているだけのものは当たらない
    expect(isDocumentsOnly(["docs.md/script.sh"])).toBe(false);
    expect(isDocumentsOnly(["notes.md.bak"])).toBe(false);
    // 名前が拡張子だけのファイル（.md）は、拡張子の無い隠しファイルなので文書とは見なさない
    expect(isDocumentsOnly(["docs/.md"])).toBe(false);
  });

  it("差分が空なら false（確かめられないものは文書だけとは見なさない）", () => {
    expect(isDocumentsOnly([])).toBe(false);
  });
});
