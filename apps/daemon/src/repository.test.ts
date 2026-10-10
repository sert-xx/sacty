import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitRepositoryWorkspace } from "./repository.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sacty-repo-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** ローカルに、コミットが1つある main ブランチのリポジトリを作る。 */
function makeOrigin(): string {
  const origin = join(dir, "origin");
  mkdirSync(origin);
  git(origin, "init", "--initial-branch=main");
  git(origin, "config", "user.email", "test@example.com");
  git(origin, "config", "user.name", "test");
  writeFileSync(join(origin, "pay.ts"), "export const pay = () => 0;\n");
  git(origin, "add", "--all");
  git(origin, "commit", "-m", "init");
  return origin;
}

describe("対象リポジトリの作業領域（git）", () => {
  it("clone して起点のコミットを返し、新しいファイルを含む差分を返す", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "task", "repo");
    const { baseCommit } = await workspace.prepare(clone, origin, "main");
    expect(baseCommit).toBe(git(origin, "rev-parse", "HEAD"));

    writeFileSync(join(clone, "pay.ts"), "export const pay = () => 1;\n");
    writeFileSync(join(clone, "pay.test.ts"), "test('同じキーの再送', () => {});\n");
    const diff = await workspace.diff(clone, baseCommit);
    expect(diff).toContain("+export const pay = () => 1;");
    expect(diff).toContain("pay.test.ts");
    expect(diff).toContain("同じキーの再送"); // 日本語のファイル内容もそのまま
    // コミットはしない
    expect(git(clone, "rev-parse", "HEAD")).toBe(baseCommit);
  });

  it("途中で止まった clone は作り直し、無いブランチは理由つきで失敗する", async () => {
    const origin = makeOrigin();
    const workspace = new GitRepositoryWorkspace();
    const clone = join(dir, "repo");
    mkdirSync(clone);
    writeFileSync(join(clone, "leftover"), "x");
    await workspace.prepare(clone, origin, "main");
    expect(existsSync(join(clone, "leftover"))).toBe(false);

    await expect(workspace.prepare(join(dir, "other"), origin, "no-such-branch")).rejects.toThrow(
      /git clone に失敗しました/,
    );
  });
});
