import { describe, expect, it } from "vitest";
import { unlinkedMergedBody, withoutWorkspaceLinks } from "./pr-body-links.js";
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

  it("リンクの外に出すと GitHub で別の働きをする文字（メンション・Issue の参照・自動リンク・表の区切り）を含むリンクは、変えない", () => {
    for (const body of [
      // メンション：リンクの外に出ると、通知が飛ぶ
      "[@octocat に確認](/workspace/docs/a.md)",
      "![@octocat](/workspace/a.png)",
      "@[octocat](/workspace/a.md)",
      // Issue・PR の参照：`Closes #99` の行になると、マージで別の Issue を閉じる
      "Closes [#99](/workspace/docs/a.md)",
      "[Closes #99](/workspace/docs/a.md)",
      "#[99](/workspace/a.md)",
      // 自動リンク
      "[https://example.com/a を見る](/workspace/a.md)",
      "[www.example.com](/workspace/a.md)",
      // 表の列の区切り
      "| ファイル |\n| --- |\n| ![a | b](/workspace/a.png) |",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
    // 番号でない `#`（節の指定）・メールでない `@` の後ろが記号のものは、外す
    expect(withoutWorkspaceLinks("[docs/a.md#始める](/workspace/docs/a.md#始める)")).toBe(
      "docs/a.md#始める",
    );
    // 同じ本文の、ほかのリンクは外す
    expect(withoutWorkspaceLinks("[a.md](/workspace/a.md) と [@octocat](/workspace/b.md)")).toBe(
      "a.md と [@octocat](/workspace/b.md)",
    );
  });

  it("表示の文字は、読まれる文字（文字参照を戻したもの）でも確かめる。打ち消し線の記号・GH-12 の形の参照を含むリンクも、変えない", () => {
    for (const body of [
      "[&commat;octocat](/workspace/a.md)",
      "Closes [&num;99](/workspace/a.md)",
      "Closes [GH-99](/workspace/a.md)",
      "[x@-a.example.com](/workspace/a.md)",
      "~~古い~ [~新しい](/workspace/a.md)",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
  });

  it("外した後の文字が、前後の文字とつながって、メンション・Issue の参照・自動リンクになるリンクは、変えない", () => {
    for (const body of [
      // メンション：`@` が、後ろの名前とつながる
      "ping [@](/workspace)octocat please",
      "ping @octo[cat](/workspace) please",
      "[@](/workspace)[octocat](/workspace)",
      // Issue・PR の参照：`Closes #12` の行になると、マージで別の Issue を閉じる
      "Closes [#](/workspace)12",
      "Closes #1[2](/workspace)",
      "org/repo[#](/workspace)5",
      "Closes [GH](/workspace)-12",
      // 自動リンク
      "see [http](/workspace)://example.com/x",
      "see http[](/workspace)://example.com/x",
      "see [ww](/workspace)w.example.com",
      "[w](/workspace)[w](/workspace)[w](/workspace).example.com",
      "mail [a](/workspace)@example.com",
      "mail [a](/workspace)@-b.example.com",
      // もとからある自動リンクの行き先が伸びる
      "https://example.com/[a](/workspace/a)",
      // 打ち消し・文字参照で書いた並び（書いた文字のままでは読めないので、つながる文字のかたまりごと、変えない）
      "mail [w](/workspace)\\@example.com",
      "ping [x](/workspace)&#64;octocat",
      "see [http](/workspace)\\://example.com/x",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
  });

  it("もとからあるメンション・参照・自動リンク・打ち消し線の記号と隣り合うリンクも、変えない（外すと、働かなくなる・別の並びになる）", () => {
    for (const body of [
      "[a](/workspace/a)www.example.com",
      "www.example.com/[a](/workspace/a)",
      "Closes #12[a.md](/workspace/a.md)",
      "[a.md](/workspace/a.md)@octocat",
      "~~[old.md](/workspace/old.md)~~",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
  });

  it("前後の文字とつながらない、ふつうの形のリンクは外す（近くにメンション・参照・URL があっても）", () => {
    expect(withoutWorkspaceLinks("[README.md](/workspace/README.md) を直した。")).toBe(
      "README.md を直した。",
    );
    expect(
      withoutWorkspaceLinks(
        "[README.md](/workspace/README.md)を直した（https://example.com/x 参照）。",
      ),
    ).toBe("README.mdを直した（https://example.com/x 参照）。");
    expect(
      withoutWorkspaceLinks(
        "See [README.md](/workspace/README.md). Closes #12, cc @octocat ([a.md](/workspace/a.md)): done",
      ),
    ).toBe("See README.md. Closes #12, cc @octocat (a.md): done");
    expect(
      withoutWorkspaceLinks(
        "@octocat、[a.md](/workspace/a.md)と #12 の[b](/workspace/src/b.ts#L12)、www.example.com の [c.md](/workspace/c.md)",
      ),
    ).toBe("@octocat、a.mdと #12 のb（`src/b.ts#L12`）、www.example.com の c.md");
    // 添えるパスの中の `#12`・`@` は、インラインコードの中なので働かない
    expect(
      withoutWorkspaceLinks("[手順](/workspace/a.md#12) と [b](/workspace/@octocat/b.md)"),
    ).toBe("手順（`a.md#12`） と b（`@octocat/b.md`）");
    // 表示の文字の中の打ち消し・文字参照は、周りの文字とつながらなければ、そのまま残して外す
    expect(withoutWorkspaceLinks("[\\# 手順 &amp; 補足](/workspace/a.md) を読む")).toBe(
      "\\# 手順 &amp; 補足（`a.md`） を読む",
    );
  });

  it("つながるリンクだけを残し、同じ本文のほかのリンクは外す。残したリンクの文字とつながるリンクがあれば、本文を変えない", () => {
    expect(
      withoutWorkspaceLinks(
        "[a.md](/workspace/a.md) と ping [@](/workspace)octocat と [b.md](/workspace/b.md)",
      ),
    ).toBe("a.md と ping [@](/workspace)octocat と b.md");
    // 日本語の文で、空白を置かずに URL の後ろに続くリンクは、URL の行き先が伸びるので残す。離れたリンクは外す
    expect(
      withoutWorkspaceLinks(
        "（https://example.com/x）[a.md](/workspace/a.md) と [c.md](/workspace/c.md)",
      ),
    ).toBe("（https://example.com/x）[a.md](/workspace/a.md) と c.md");
    // 1つ目のリンクを残すと、その題の `://` が、2つ目の外した文字とつながる（2回目の確かめで当たる）
    const twice = '[@](/workspace "x://y")octocat）[b](/workspace/b.md)';
    expect(withoutWorkspaceLinks(twice)).toBe(twice);
  });

  it("パスに縦棒があるリンクは、変えない（表の中で、添えたパスの縦棒が列の区切りになり、隣のセルが消える）", () => {
    const head = "| ファイル | 内容 |\n| --- | --- |\n";
    for (const body of [
      `${head}| [設定](/workspace/a\\|b.md) | 直した |`,
      `${head}| [設定](/workspace/a&#124;b.md) | 直した |`,
      `${head}| ![図](/workspace/a\\|b.png) | 直した |`,
      // 表の外でも、変えない
      "[設定](</workspace/a|b.md>)",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
    // 同じ表の、縦棒の無いリンクは外す
    expect(
      withoutWorkspaceLinks(`${head}| [設定](/workspace/a\\|b.md) | [c.md](/workspace/c.md) |`),
    ).toBe(`${head}| [設定](/workspace/a\\|b.md) | c.md |`);
  });

  it("つながりの確かめは、本文の長さの上限いっぱいでも、時間がかからない", () => {
    // 空白の無い本文に、打ち消し・メンション・参照の形と、リンクが並ぶ
    const unit = "a\\@b#1@c[a.md](/workspace/a.md)、";
    const body = unit.repeat(Math.floor(PR_BODY_MAX / unit.length));
    const started = Date.now();
    expect(withoutWorkspaceLinks(body)).toBe(body);
    expect(Date.now() - started).toBeLessThan(2_000);
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

describe("すでにある PR の更新で、マージした本文・まとめた本文からも、作業領域へのリンクを外す（unlinkedMergedBody）", () => {
  it("作業領域へのリンクを外す。ほかのリンク・書き方は変えない", () => {
    const human = [
      "> 人のメモ：[設計](https://example.com/design) と [相対](docs/a.md) を見ること。",
      "",
      "値は `ghp_secret` ではなく、[手順](/workspace/docs/setup.md) のとおりに入れる。  ",
      "<!-- 人のコメント -->",
    ].join("\n");
    expect(unlinkedMergedBody(human, [])).toBe(
      human.replace("[手順](/workspace/docs/setup.md)", "手順（`docs/setup.md`）"),
    );
  });

  it("外すリンクが無ければ、渡された本文をそのまま返す（秘密の値と同じ文字があっても、人の本文に手を加えない）", () => {
    const body = "人が書いた本文。[設計](https://example.com/design) の値は abc です。";
    expect(unlinkedMergedBody(body, ["abc"])).toBe(body);
    // 外せない（変えずに残す）リンクだけのときも、そのまま返す
    const kept = "ping [@](/workspace)octocat の値は abc です。";
    expect(unlinkedMergedBody(kept, ["abc"])).toBe(kept);
  });

  it("外した後に現れる秘密の値を、伏せる（文字がつながる・リンク先の文字参照が元の文字に戻る）", () => {
    const body = [
      "値は ghp_[](/workspace)secret です。",
      "[手順](/workspace/docs/ghp&#95;secret.md) を直しました。",
    ].join("\n\n");
    expect(unlinkedMergedBody(body, ["ghp_secret"])).toBe(
      ["値は [REDACTED] です。", "手順（`docs/[REDACTED].md`） を直しました。"].join("\n\n"),
    );
  });

  it("伏せた結果が長さの上限を超えるときは、外すのをやめて、渡された本文を返す（秘密の値は現れない・上限を超えない）", () => {
    // 短い秘密の値（伏せ字より短い）が、リンク先の文字参照から何度も現れる。伏せると、外して縮んだ分より長くなる
    const secret = "ghx";
    const link = `[手順](/workspace/${"gh&#120;".repeat(1_000)})`;
    const body = `${link}\n\n${"説明。".repeat(30_000)}`.slice(0, PR_BODY_MAX);
    expect(body.length).toBe(PR_BODY_MAX);
    const out = unlinkedMergedBody(body, [secret]);
    expect(out).toBe(body);
    expect(out).not.toContain(secret);
    // 外していれば、伏せた後に上限を超えていた（この分岐を通ったことの確認）
    const unlinked = withoutWorkspaceLinks(body).replaceAll(secret, "[REDACTED]");
    expect(unlinked).not.toBe(body);
    expect(unlinked.length).toBeGreaterThan(PR_BODY_MAX);
    // 上限に余裕があれば、外して伏せる
    const short = `${link}\n\n説明。`;
    expect(unlinkedMergedBody(short, [secret])).toBe(
      `手順（\`${"[REDACTED]".repeat(1_000)}\`）\n\n説明。`,
    );
  });
});
