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

describe("既定の review スキルの、本文で示された文書（PBI-142）", () => {
  const linked = "skills/review/review-dispatch/references/linked-docs.md";

  it("親は読む順序と手順で、本文で示された文書を対象か根拠かに分け、主対象の判断に含める", () => {
    const skill = read("skills/review/review-dispatch/SKILL.md");
    expect(skill).toContain(
      "[references/linked-docs.md](references/linked-docs.md)（対象か根拠かを分け",
    );
    expect(skill).toContain("本文で示された文書のうち、レビューの対象にしたものも含めて決める");
    expect(skill).toContain("本文や依頼文で示された文書を、対象か根拠かに分けて取得する");
    // 担当への依頼文の「対象」に写しが入る
    expect(skill).toContain("本文で示された文書のうち対象にしたものの写しのパスと取得元");
  });

  it("分け方は総合して判断し、迷ったら対象にする。対象の文書は差分の外でも範囲から外さない", () => {
    const text = read(linked);
    expect(text).toContain("| 対象（レビューする） |");
    expect(text).toContain("| 根拠（読むだけ） |");
    expect(text).toContain("タイトル・説明・差分を総合して判断し、1 つの手がかりだけで決めない");
    expect(text).toContain("迷ったら対象にする");
    expect(text).toContain("差分の外でも範囲から外さない");
  });

  it("文書の置き場はプロジェクトごとに違うので、特定の PF の名前を書かない", () => {
    const files = markdownUnder(join(DEFAULT_CONTEXT_DIR, "skills/review"));
    for (const { path, text } of files) {
      expect(text, path).not.toMatch(
        /\b(confluence|notion|google docs|sharepoint|wiki|jira|backlog|esa|kibela|qiita|box|dropbox)\b|コンフル/i,
      );
    }
  });

  it("全文は親が取得して作業領域の外に写し、認証情報は求めない", () => {
    const text = read(linked);
    expect(text).toContain("対象と根拠の文書の全文を、親が取得する");
    expect(text).toContain("作業領域の外の一時ディレクトリに保存する");
    expect(text).toContain("認証情報を求めない・探さない");
  });

  it("主対象の文書を取得できなければ完了できず、ほかの対象の文書なら範囲に書いて合格と書かない", () => {
    const text = read(linked);
    expect(text).toContain(
      "その文書を主対象にした（レビューの中心だった）とき：レビューを完了できない",
    );
    expect(text).toContain(
      "見られなかった文書がある `pr-review` は、初回でも再レビューでも合格と書かない",
    );
    const pr = read("skills/review/review-dispatch/references/pr-review.md");
    expect(pr).toContain("本文で示された文書を主対象にしたのに、その文書を取得できない");
    expect(pr).toContain("[linked-docs.md](linked-docs.md)");
    expect(read("skills/review/review-dispatch/references/aggregation.md")).toContain(
      "レビューの対象にした文書（[linked-docs.md](linked-docs.md)）を取得できなかった PR レビューは、初回でも再レビューでも合格と書かない",
    );
  });

  it("主対象のほかの文書を取得できなくても、記録を入力として担当を起動し、見られなかった文書は本文に書く", () => {
    expect(read("skills/review/review-dispatch/SKILL.md")).toContain(
      "主対象にした文書のほかは、取得できなくても揃わないとはみなさない。取得できなかった文書と理由を記録し、それを入力として起動する",
    );
    expect(read("skills/review/review-dispatch/references/pr-review.md")).toContain(
      "ただし、読み手が知るべき見られなかった範囲は、本文の「レビューの範囲」に短く書く。たとえば、取得できなかった文書と理由",
    );
  });

  it("文書への指摘は位置を付けられない指摘として、文書と節を添え、分けた結果を記録に残す", () => {
    const pr = read("skills/review/review-dispatch/references/pr-review.md");
    expect(pr).toContain("差分の外のコード・本文で示された文書についての指摘）は、次のように扱う");
    expect(pr).toContain("文書への指摘には、文書の名前か URL と、節の見出しを添える");
    // 担当の出力の形式と、親が読む形式の説明は同じにする
    for (const path of [
      "skills/review/review-execution/SKILL.md",
      "skills/review/review-dispatch/references/finding-format.md",
    ]) {
      expect(read(path), path).toContain(
        "`path` は写しのパスではなく取得元（文書の名前か URL）、`line` は節の見出し",
      );
    }
    expect(read("skills/review/review-dispatch/references/aggregation.md")).toContain(
      '"linked_docs":',
    );
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
