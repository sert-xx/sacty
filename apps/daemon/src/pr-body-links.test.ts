import { describe, expect, it } from "vitest";
import { withoutWorkspaceLinks } from "./pr-body-links.js";
import { PR_BODY_MAX } from "./pr-template.js";

describe("PR の本文の、コンテナの作業領域へのリンク（PBI-366）", () => {
  it("作業領域のパスへのリンクを外し、表示の文字を残す", () => {
    expect(withoutWorkspaceLinks("- [README.md](/workspace/README.md) を直した")).toBe(
      "- README.md を直した",
    );
    expect(withoutWorkspaceLinks("[`src/pay.ts`](/workspace/src/pay.ts#L12)")).toBe("`src/pay.ts`");
    expect(
      withoutWorkspaceLinks('[docs/a.md](</workspace/docs/a.md>) と [b](/workspace/b.md "題")'),
    ).toBe("docs/a.md と b（`b.md`）");
    // 表示の文字の中の強調などは、元の書き方のまま残す
    expect(withoutWorkspaceLinks("[**docs/a.md** の節](/workspace/docs/a.md)")).toBe(
      "**docs/a.md** の節",
    );
  });

  it("表示の文字からパスが分からなければ、リポジトリのルートからのパスを添える", () => {
    expect(withoutWorkspaceLinks("[手順](/workspace/docs/setup.md#始める)")).toBe(
      "手順（`docs/setup.md#始める`）",
    );
    expect(withoutWorkspaceLinks("![図](/workspace/assets/flow.png)")).toBe(
      "図（`assets/flow.png`）",
    );
    expect(withoutWorkspaceLinks("[](/workspace/a.md)")).toBe("`a.md`");
    // 名前だけの表示は、どのディレクトリのファイルか分からないので、パスを添える
    expect(withoutWorkspaceLinks("[b.ts](/workspace/src/b.ts)")).toBe("b.ts（`src/b.ts`）");
  });

  it("括弧・空白・バッククォートを含むパスも、パスの終わりまでを1つのリンクとして外す", () => {
    expect(withoutWorkspaceLinks("[手順](/workspace/docs/setup(ja).md) を読む")).toBe(
      "手順（`docs/setup(ja).md`） を読む",
    );
    expect(withoutWorkspaceLinks("[docs/a(b)/c.md](/workspace/docs/a(b)/c.md)")).toBe(
      "docs/a(b)/c.md",
    );
    expect(withoutWorkspaceLinks("[手順](</workspace/docs/my file.md>)")).toBe(
      "手順（`docs/my file.md`）",
    );
    expect(withoutWorkspaceLinks("[手順](/workspace/docs/a\\)b.md)")).toBe("手順（`docs/a)b.md`）");
    expect(withoutWorkspaceLinks("[手順](/workspace/a`b.md)")).toBe("手順（`` a`b.md ``）");
    // 表示の文字の中の角括弧
    expect(withoutWorkspaceLinks("[a [b] c](/workspace/x.md)")).toBe("a [b] c（`x.md`）");
    // リンク先が次の行に続く書き方
    expect(withoutWorkspaceLinks("[手順](\n/workspace/docs/a.md)")).toBe("手順（`docs/a.md`）");
  });

  it("作業領域そのものへのリンクは、表示の文字だけにする", () => {
    expect(withoutWorkspaceLinks("[作業領域](/workspace) と [ルート](/workspace/)")).toBe(
      "作業領域 と ルート",
    );
    expect(withoutWorkspaceLinks("前[](/workspace)後")).toBe("前後");
  });

  it("1行に複数あれば、すべて外す。リンクの中の画像は、リンクごと外す", () => {
    expect(withoutWorkspaceLinks("[x](/workspace/a.ts)[y](docs/y.md)[a.ts](/workspace/a.ts)")).toBe(
      "x（`a.ts`）[y](docs/y.md)a.ts",
    );
    expect(withoutWorkspaceLinks("[![図](/workspace/a.png)](/workspace/docs/a.md)")).toBe(
      "図（`a.png`）（`docs/a.md`）",
    );
    // ほかの場所へのリンクの中にある、作業領域の画像
    expect(withoutWorkspaceLinks("[![図](/workspace/a.png)](https://example.com)")).toBe(
      "[図（`a.png`）](https://example.com)",
    );
  });

  it("ほかのリンクは変えない", () => {
    const body = [
      "[PR](https://github.com/acme/app/pull/1)",
      "[相対](docs/a.md)",
      "[別の名前](/workspace-tools/a.md)",
      "[別の場所](/workspaces/a.md)",
      "[外のパス](/tmp/workspace/a.md)",
      "[節](/workspace#a)",
      "/workspace/README.md を読んだ",
      "\\[a](/workspace/a.md) は、角括弧を打ち消しているのでリンクではない",
      '<a href="/workspace/a.md">HTML のリンク</a>',
      "[参照][ref]",
      "",
      "[ref]: /workspace/a.md",
    ].join("\n");
    expect(withoutWorkspaceLinks(body)).toBe(body);
  });

  it("コードブロックとインラインコードの中は変えない（複数行のインラインコード・引用や箇条書きの中のコードブロックも）", () => {
    const body = [
      "`[a](/workspace/a.md)` と書くと [a.md](/workspace/a.md) になる",
      "",
      "複数行のインラインコード `[a](/workspace/a.md)",
      "[b](/workspace/b.md)` は変えない",
      "",
      "```md",
      "[a](/workspace/a.md)",
      "```",
      "",
      "~~~~",
      "```",
      "[b](/workspace/b.md)",
      "~~~~",
      "",
      "> 引用の中の [q.md](/workspace/q.md) は外す",
      ">",
      "> ```md",
      "> [c](/workspace/c.md)",
      "> ```",
      "",
      "- 箇条書き",
      "",
      "  ```md",
      "  [d](/workspace/d.md)",
      "  ```",
      "",
      "字下げのコードブロック：",
      "",
      "    [e](/workspace/e.md)",
      "",
      "[c.md](/workspace/c.md)",
    ].join("\n");
    expect(withoutWorkspaceLinks(body)).toBe(
      body
        .replace("[a.md](/workspace/a.md) になる", "a.md になる")
        .replace("[q.md](/workspace/q.md) は外す", "q.md は外す")
        .replace(/\[c\.md\]\(\/workspace\/c\.md\)$/, "c.md"),
    );
  });

  it("閉じていないコードブロックの後ろは、コードとして変えない", () => {
    const body = "```\n[a.md](/workspace/a.md)";
    expect(withoutWorkspaceLinks(body)).toBe(body);
  });

  it("改行コードが CRLF の本文でも、位置がずれない", () => {
    expect(withoutWorkspaceLinks("1行目\r\n[a.md](/workspace/a.md)\r\n3行目")).toBe(
      "1行目\r\na.md\r\n3行目",
    );
  });

  it("本文の長さの上限いっぱいでも、ふつうの本文は時間がかからない。対象の無い本文は解析しない", () => {
    const link = "[a.md](/workspace/a.md) ";
    const many = link.repeat(Math.floor(PR_BODY_MAX / link.length));
    const started = Date.now();
    expect(withoutWorkspaceLinks(many)).toBe("a.md ".repeat(Math.floor(PR_BODY_MAX / link.length)));
    expect(Date.now() - started).toBeLessThan(2_000);
    // パーサーが時間のかかる本文（記号の連続）でも、作業領域へのリンクの形が無ければ、解析せずに返す
    const heavy = [">".repeat(PR_BODY_MAX), "*a".repeat(PR_BODY_MAX / 2), "/workspace/a.md"];
    const before = Date.now();
    for (const body of heavy) expect(withoutWorkspaceLinks(body)).toBe(body);
    expect(Date.now() - before).toBeLessThan(500);
  });
});
