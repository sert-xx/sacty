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

  it("文字参照・バックスラッシュで書いたリンク先も、パーサーが作業領域と解釈するなら外す（ほかに通常のリンクが無くても）", () => {
    expect(withoutWorkspaceLinks("[手順](/work&#115;pace/docs/a.md)")).toBe("手順（`docs/a.md`）");
    expect(withoutWorkspaceLinks("[手順](/work&#x73;pace/docs/a.md)")).toBe("手順（`docs/a.md`）");
    expect(withoutWorkspaceLinks("[手順](&sol;workspace&sol;docs&sol;a.md)")).toBe(
      "手順（`docs/a.md`）",
    );
    expect(withoutWorkspaceLinks("[手順](\\/workspace/docs/a.md)")).toBe("手順（`docs/a.md`）");
    expect(withoutWorkspaceLinks("[手順](/works\\pace/docs/a.md)")).toBe(
      "[手順](/works\\pace/docs/a.md)",
    );
    // 符号化（%）は、パーサーが元の文字に戻さないので、作業領域へのリンクではない
    expect(withoutWorkspaceLinks("[手順](/work%73pace/docs/a.md)")).toBe(
      "[手順](/work%73pace/docs/a.md)",
    );
  });

  it("置き換えで本文を長くしない（パスにバッククォートが続くときは、パスを添えない・変えない）", () => {
    // コードの書式の囲みが元のリンクより長くなるときは、表示の文字だけにする
    const ticks = "`".repeat(20);
    expect(withoutWorkspaceLinks(`[手順](/workspace/a${ticks}b.md)`)).toBe("手順");
    // 表示の文字も無ければ、リンクを変えない
    const bare = `[](/workspace/a${ticks}b.md)`;
    expect(withoutWorkspaceLinks(bare)).toBe(bare);
    // 短いバッククォートは、より長いバッククォートで囲んで添える
    expect(withoutWorkspaceLinks("[手順](/workspace/a`b.md)")).toBe("手順（`` a`b.md ``）");
    // 本文の長さの上限いっぱいに並んでも、上限を超えない
    const link = `[手順](/workspace/${"`".repeat(40)}.md) `;
    const body = link.repeat(Math.floor(PR_BODY_MAX / link.length));
    const out = withoutWorkspaceLinks(body);
    expect(out.length).toBeLessThanOrEqual(body.length);
    expect(out).toBe("手順 ".repeat(Math.floor(PR_BODY_MAX / link.length)));
    for (const text of [
      "[a](/workspace/`)",
      "[`a`](/workspace/``)",
      "![](/workspace/```.png)",
      "[a [b] c](</workspace/` `` ```>)",
      "[![a](/workspace/`.png)](/workspace/``.md)",
    ]) {
      expect(withoutWorkspaceLinks(text).length).toBeLessThanOrEqual(text.length);
    }
  });

  it("置き換えで新しいリンクができる・ほかのリンクが変わる本文は、変えない", () => {
    for (const body of [
      // 表示の文字の角括弧が、後ろの括弧とつながってリンクになる
      "[[a]](/workspace/a)(/workspace/b)",
      "[[a]](/workspace/a)(https://example.com)",
      // 画像の代わりの文字の中の、打ち消した角括弧が、リンクになる
      "![\\[x\\](https://example.com)](/workspace/a.png)",
      // 表示の文字の角括弧が、定義とつながって参照形式のリンクになる
      "[[a]](/workspace/x.md)\n\n[a]: https://example.com",
      // 外した後に、前後の文字がつながって別のリンクになる
      "[x][](/workspace)(https://example.com)",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
    // 同じ本文のほかのリンクも、変えない（一部だけを変えて、構文が変わった本文を出さない）
    const mixed = "[a.md](/workspace/a.md) と [[a]](/workspace/a)(/workspace/b)";
    expect(withoutWorkspaceLinks(mixed)).toBe(mixed);
    // 角括弧があっても、リンクにならなければ外す
    expect(withoutWorkspaceLinks("[[a]](/workspace/a.md) (注)")).toBe("[a]（`a.md`） (注)");
  });

  it("表示の文字が、リンクのほかの構文に変わる本文も、変えない（後ろの文章を隠さない・ほかのリンクの行き先を変えない）", () => {
    for (const body of [
      // 画像の代わりの文字が、HTML のコメントの始まりになり、後ろの行（Closes・承認の案内）を隠す
      "![&lt;!--](/workspace/a.png)\n\nCloses #12\n\nこの PR をマージすると、実装を承認したことになります。",
      // 代わりの文字が HTML のタグになる
      "![&lt;details&gt;](/workspace/a.png)\n\n本文",
      // 代わりの文字から参照の定義ができて、ほかの参照形式のリンクの行き先が変わる
      "[手順][a]\n\n![\\[a\\]: https://example.com/evil](/workspace/a.png)\n\n[a]: https://example.com/ok",
      // 代わりの文字が、強調・インラインコードになる
      "![\\*強調\\*](/workspace/a.png)",
      "![&#96;code&#96;](/workspace/a.png)",
      // 行の先頭の、画像の代わりの文字が、箇条書き・見出し・引用・コードブロックの囲みになる
      "![- 項目](/workspace/a.png)",
      "![# 見出し](/workspace/a.png)",
      "![&gt; 引用](/workspace/a.png)",
      "![~~~](/workspace/a.png)\n本文\n",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
  });

  it("リンクの表示の文字は元の書き方のまま残すので、打ち消した記号は、置き換えた後も記号のまま", () => {
    expect(withoutWorkspaceLinks("[\\-](/workspace/a.md) 項目")).toBe("\\-（`a.md`） 項目");
    expect(withoutWorkspaceLinks("[\\# 手順](/workspace/a.md)")).toBe("\\# 手順（`a.md`）");
    expect(withoutWorkspaceLinks("[&lt;!--](/workspace/a.md)\n\nCloses #12")).toBe(
      "&lt;!--（`a.md`）\n\nCloses #12",
    );
  });

  it("置き換えた後の構文が元と同じなら、表・箇条書き・引用・折りたたみの中のリンクも外す", () => {
    const body = [
      "| ファイル | 内容 |",
      "| --- | --- |",
      "| [a.md](/workspace/a.md) | 直した |",
      "",
      "- [b.md](/workspace/docs/b.md) を足した",
      "  - **[c.md](/workspace/c.md)**",
      "",
      "> [d.md](/workspace/d.md)",
      "",
      "<details>",
      "<summary>記録</summary>",
      "",
      "[e.md](/workspace/e.md)",
      "",
      "</details>",
      "",
      "Closes #12",
    ].join("\n");
    expect(withoutWorkspaceLinks(body)).toBe(
      body
        .replace("[a.md](/workspace/a.md)", "a.md")
        .replace("[b.md](/workspace/docs/b.md)", "b.md（`docs/b.md`）")
        .replace("[c.md](/workspace/c.md)", "c.md")
        .replace("[d.md](/workspace/d.md)", "d.md")
        .replace("[e.md](/workspace/e.md)", "e.md"),
    );
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
    // パーサーが時間のかかる本文（記号の連続）でも、作業領域へのリンクがありえなければ、解析せずに返す
    const heavy = [
      ">".repeat(PR_BODY_MAX),
      "*a".repeat(PR_BODY_MAX / 2),
      `${"+ ".repeat(PR_BODY_MAX / 2 - 20)}[a](docs/a.md)`,
      `${"1. ".repeat(20_000)}/workspace/a.md`,
    ];
    const before = Date.now();
    for (const body of heavy) expect(withoutWorkspaceLinks(body)).toBe(body);
    expect(Date.now() - before).toBeLessThan(500);
  });
});
