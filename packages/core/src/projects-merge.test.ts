import { describe, expect, it } from "vitest";
import { mergeProjectDefinitions, type ProjectDefinition } from "./projects.js";

// 同じ版から別々に変えて保存した2つの定義の併合（PBI-301）

const repo = (name: string, image?: string) => ({
  scope: "repo" as const,
  target: `https://github.com/acme/${name}`,
  ...(image ? { image } : {}),
});
const def = (names: string[], extra: Partial<ProjectDefinition> = {}): ProjectDefinition =>
  ({ name: "決済", targets: names.map((n) => repo(n)), ...extra }) as ProjectDefinition;
const names = (d: ProjectDefinition | undefined) =>
  d?.targets.map((t) => t.target.split("/").pop());

describe("mergeProjectDefinitions", () => {
  const base = def(["a"]);

  it("別々に足した対象は、どちらも残る。順序は今の定義のまま、足した対象は後ろ", () => {
    expect(names(mergeProjectDefinitions(base, def(["a", "b"]), def(["a", "c"])))).toEqual([
      "a",
      "b",
      "c",
    ]);
    // 状態の境界：どちらも変えていない・片方だけ変えた
    expect(names(mergeProjectDefinitions(base, base, base))).toEqual(["a"]);
    expect(names(mergeProjectDefinitions(base, def(["a", "b"]), base))).toEqual(["a", "b"]);
    expect(names(mergeProjectDefinitions(base, base, def(["a", "c"])))).toEqual(["a", "c"]);
    // 空の定義からも
    expect(names(mergeProjectDefinitions(def([]), def(["x"]), def(["y"])))).toEqual(["x", "y"]);
  });

  it("同じ対象を両方が足したら1件にする。同じ対象で内容が違うなら併合できない", () => {
    expect(names(mergeProjectDefinitions(base, def(["a", "b"]), def(["a", "b"])))).toEqual([
      "a",
      "b",
    ]);
    // 大文字小文字だけ違う URL は同じ対象だが、内容が違うので併合できない（どちらを採るか決められない）
    const upper = { ...def(["a"]), targets: [repo("a"), repo("B")] } as ProjectDefinition;
    expect(mergeProjectDefinitions(base, def(["a", "b"]), upper)).toBeUndefined();
  });

  it("消した対象は消え、ほかが足した対象は残る。ほかが変えた対象を消す・変えた対象を別々に変えるのは併合できない", () => {
    const three = def(["a", "b", "c"]);
    expect(
      names(mergeProjectDefinitions(three, def(["a", "b", "c", "d"]), def(["a", "c"]))),
    ).toEqual(["a", "c", "d"]);
    // ほかが同じ対象をもう消していても、消す
    expect(names(mergeProjectDefinitions(three, def(["a", "c"]), def(["a", "c"])))).toEqual([
      "a",
      "c",
    ]);
    const changed = { ...three, targets: [repo("a"), repo("b", "node"), repo("c")] };
    expect(mergeProjectDefinitions(three, changed, def(["a", "c"]))).toBeUndefined();
    const other = { ...three, targets: [repo("a"), repo("b", "python"), repo("c")] };
    expect(mergeProjectDefinitions(three, changed, other)).toBeUndefined();
    // 片方だけが変えた対象は、その変更を採る
    expect(mergeProjectDefinitions(three, changed, three)?.targets[1]).toMatchObject({
      image: "node",
    });
    expect(mergeProjectDefinitions(three, three, changed)?.targets[1]).toMatchObject({
      image: "node",
    });
  });

  it("ほかの項目は、片方だけが変えたならその変更を採り、両方が違うように変えたら併合できない", () => {
    const named = { ...def(["a"]), name: "改名" };
    expect(mergeProjectDefinitions(base, named, def(["a", "b"]))).toMatchObject({
      name: "改名",
      targets: [repo("a"), repo("b")],
    });
    expect(mergeProjectDefinitions(base, def(["a", "b"]), named)).toMatchObject({
      name: "改名",
      targets: [repo("a"), repo("b")],
    });
    expect(
      mergeProjectDefinitions(base, named, { ...def(["a"]), name: "別の名前" }),
    ).toBeUndefined();
    // 同じに変えたなら併合できる
    expect(mergeProjectDefinitions(base, named, { ...named })).toMatchObject({ name: "改名" });
    // 任意の項目
    const withContext = { ...def(["a"]), context: { repo: "https://github.com/acme/ctx" } };
    expect(mergeProjectDefinitions(base, base, withContext)?.context).toEqual(withContext.context);
    expect(mergeProjectDefinitions(base, withContext, base)?.context).toEqual(withContext.context);
    const accounts = { ...def(["a"]), githubAccounts: { "github.com": "me" } };
    expect(mergeProjectDefinitions(base, accounts, base)?.githubAccounts).toEqual({
      "github.com": "me",
    });
    expect(
      mergeProjectDefinitions(base, accounts, {
        ...def(["a"]),
        githubAccounts: { "github.com": "you" },
      }),
    ).toBeUndefined();
    // 変えていない任意の項目は、結果にも付けない
    expect(mergeProjectDefinitions(base, base, base)).not.toHaveProperty("context");
  });
});
