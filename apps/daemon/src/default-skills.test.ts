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

describe("既定の review スキルの、段階のサブエージェント（PBI-119）", () => {
  it("観点カタログに観点ごとの段階の表があり、5 つの段階をすべて使う", () => {
    const text = read("skills/review/review-dispatch/references/viewpoints.md");
    expect(text).toContain("## 観点ごとの段階");
    for (const tier of ["lite", "entry", "standard", "advanced", "ultimate"]) {
      expect(text, tier).toMatch(new RegExp(`^\\| \`${tier}\` \\|`, "m"));
    }
    // 横断の欠陥探索は最上位
    expect(text).toMatch(/^\| `ultimate` \| X-1 \|/m);
  });

  it("親は段階の名前で担当を起動し、定義が無ければ段階を指定せずに起動して起動表に「親と同じ」と書く", () => {
    const skill = read("skills/review/review-dispatch/SKILL.md");
    // 起動の規則
    expect(skill).toContain("その段階の名前のサブエージェント");
    expect(skill).toContain(
      "段階を指定せずに（親と同じモデルで）起動し、起動表の「段階」に「親と同じ」と書く",
    );
    // 担当への依頼
    expect(skill).toContain("段階の定義が無ければ、指定せずに起動する");
    // 起動表に段階の列
    expect(skill).toContain("| 観点 | 起動 | 段階 | 理由（起動しないとき） | 結果 |");
    expect(skill).toContain("| X-2 検証結果の分析 | 常時 | 親と同じ | | must 1 |");
    // 集約の記録にも段階
    expect(read("skills/review/review-dispatch/references/aggregation.md")).toContain('"tier":');
  });
});

describe("既定のスキル ears-requirements（PBI-122）", () => {
  it("EARS の文型（日英）・ID・見直しを持ち、優先する指示を書き、sacty に限った書き方をしない", () => {
    const skill = read("skills/ears-requirements/SKILL.md");
    expect(skill).toMatch(/^---\nname: ears-requirements\ndescription: .+\n---\n/);
    for (const text of [
      "`<システム>は、<応答>しなければならない。`",
      "`When <trigger>, the <system> shall <response>.`",
      "`While <precondition>, the <system> shall <response>.`",
      "`If <trigger>, then the <system> shall <response>.`",
      "`Where <feature is included>, the <system> shall <response>.`",
      "依頼した人の指示",
      "対象のリポジトリの要求要件の決まり",
      "要求に ID を付ける",
      "## 見直し",
      "references/patterns.md",
    ]) {
      expect(skill).toContain(text);
    }
    const files = markdownUnder(join(DEFAULT_CONTEXT_DIR, "skills/ears-requirements"));
    expect(files.map((f) => f.path).sort()).toEqual([
      "skills/ears-requirements/SKILL.md",
      "skills/ears-requirements/references/patterns.md",
    ]);
    for (const { path, text } of files) expect(text.toLowerCase(), path).not.toContain("sacty");
  });
});
