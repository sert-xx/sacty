import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_DIR } from "./context.js";

/** 既定のスキルの、ディレクトリの下の Markdown をすべて読む。 */
function markdownUnder(dir: string): { path: string; text: string }[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return markdownUnder(path);
    return name.endsWith(".md")
      ? [{ path: relative(DEFAULT_CONTEXT_DIR, path), text: readFileSync(path, "utf8") }]
      : [];
  });
}

const read = (path: string) => readFileSync(join(DEFAULT_CONTEXT_DIR, path), "utf8");

describe("既定のスキル（git・review）の、PR のレビューの投稿（PBI-111）", () => {
  it("依頼した側が出力の形と投稿のしかたを決めているときは、それに従い、自分では投稿しない", () => {
    for (const path of [
      "skills/git/SKILL.md",
      "skills/git/references/pr-review-posting.md",
      "skills/review/review-dispatch/references/pr-review.md",
    ]) {
      const text = read(path);
      expect(text, path).toContain("出力の形と投稿のしかたを決めているときは、それに従");
      expect(text, path).toMatch(/自分では( PR に)?投稿/);
    }
  });

  it("位置を付けられない指摘で人に確かめるのは、確かめる相手がいるときだけにする", () => {
    for (const path of [
      "skills/git/references/pr-review-posting.md",
      "skills/review/review-dispatch/references/pr-review.md",
    ]) {
      const text = read(path);
      expect(text, path).toContain(
        "確かめる相手がいない（自動で実行していて、人が途中で答えない）ときは、止まらずに",
      );
    }
  });

  it("pr-review は、本文がそのまま投稿される前提と、自分で投稿する手順を食い違わせない", () => {
    const text = read("skills/review/review-dispatch/references/pr-review.md");
    expect(text).not.toContain("書いた本文がそのまま PR にレビューとして投稿される");
    expect(text).toContain(
      "依頼した側が投稿のしかたを決めていない（自分で投稿するように頼まれた）ときだけ、自分で投稿する",
    );
  });

  it("あらゆるリポジトリと sacty の外の使い方に渡るので、sacty に限った書き方をしない", () => {
    const files = [
      ...markdownUnder(join(DEFAULT_CONTEXT_DIR, "skills/git")),
      ...markdownUnder(join(DEFAULT_CONTEXT_DIR, "skills/review")),
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const { path, text } of files) expect(text.toLowerCase(), path).not.toContain("sacty");
  });
});
