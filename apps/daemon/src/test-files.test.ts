import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findTestFiles, looksLikeTestFile } from "./test-files.js";

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
    expect(findTestFiles(dir, { limit: 2 })).toEqual({ files: [], complete: false });
    expect(findTestFiles(join(dir, "missing"))).toEqual({ files: [], complete: false });
  });
});

describe("テストのファイル探しの抜け（PR #105 レビュー指摘）", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sacty-test-files-"));
  });
  afterEach(() => {
    try {
      chmodSync(join(dir, "locked"), 0o755);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  });

  it("中のディレクトリを読めなければ、確かめきれなかったとする", () => {
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked", "pay_test.go"), "");
    writeFileSync(join(dir, "README.md"), "");
    chmodSync(join(dir, "locked"), 0o000);
    expect(findTestFiles(dir)).toEqual({ files: [], complete: false });
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
