import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PARSE_TIMEOUT_MS, unlinkedGeneratedBody, unlinkedMergedBody } from "./pr-body-links.js";
import {
  type ConvertJob,
  cannotLinkToWorkspace,
  convertWorkspaceLinks,
} from "./pr-body-links-worker.js";
import { PR_BODY_MAX } from "./pr-template.js";

/**
 * 変換の本体を、このスレッドで直接呼ぶ（外した後の本文）。デーモンは、別スレッドで呼ぶ（`unlinkedGeneratedBody` など）。
 * 変換の途中の例外では、本体は渡した本文をそのまま返す。「外さない」ことを確かめるテストが、例外を見逃さないように、
 * 例外が無かったことを、ここで確かめる。
 */
const withoutWorkspaceLinks = (body: string) => {
  const converted = convertWorkspaceLinks(body, "/workspace");
  expect(converted.failed).toBeUndefined();
  return converted.body;
};

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

  it("つながりの確かめは、本文の長さの上限いっぱいの本文でも、終わって本文をそのまま返す", () => {
    // 空白の無い本文に、打ち消し・メンション・参照の形と、リンクが並ぶ
    const unit = "a\\@b#1@c[a.md](/workspace/a.md)、";
    const body = unit.repeat(Math.floor(PR_BODY_MAX / unit.length));
    // 2 乗の版でも時間切れに届かないので、遅い機械にも十分な余裕の上限（2.5 秒。通常は 0.4 秒未満）で時間の検査を残す
    const started = performance.now();
    expect(withoutWorkspaceLinks(body)).toBe(body);
    expect(performance.now() - started).toBeLessThan(2500);
  });

  it("表示の文字の中の打ち消し・文字参照は、すぐ外側に括弧・強調の記号があっても、それだけではつながりと見なさず、リンクを外す", () => {
    expect(withoutWorkspaceLinks("see ([foo\\_bar.md](/workspace/foo_bar.md)) now")).toBe(
      "see (foo\\_bar.md（`foo_bar.md`）) now",
    );
    expect(withoutWorkspaceLinks("see **[a&amp;b.md](/workspace/a.md)** now")).toBe(
      "see **a&amp;b.md（`a.md`）** now",
    );
    expect(
      withoutWorkspaceLinks(
        '([docs/a\\_b.md](/workspace/docs/a_b.md))と、"[c&lt;d](/workspace/c.md)"',
      ),
    ).toBe('(docs/a\\_b.md（`docs/a_b.md`）)と、"c&lt;d（`c.md`）"');
    // 表示の文字の中の打ち消し・文字参照が、読まれる文字では、外の文字と合わせて並びになるなら、変えない
    for (const body of [
      "[ww](/workspace)[w\\.](/workspace)example.com",
      "ping [x\\@](/workspace)octocat",
      "ping ([&commat;](/workspace)octocat)",
      "Closes ([&num;](/workspace)12)",
      // 打ち消し・文字参照が、外した文字の外にあれば、つながる文字の連なりごと、変えない
      "see ([a.md](/workspace/a.md)\\@octocat)",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
  });

  it("リンクの直前の `@`・`#` は、表示の文字と合わせて並びになるときだけ、変えない", () => {
    for (const body of [
      "@[octocat](/workspace/a.md)",
      "#[99](/workspace/a.md)",
      "@[**octo**cat](/workspace/a.md)",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
    expect(
      withoutWorkspaceLinks("@[手順](/workspace/docs/setup.md) と #[節](/workspace/docs/a.md)"),
    ).toBe("@手順（`docs/setup.md`） と #節（`docs/a.md`）");
  });

  it("作業領域そのものへのリンクは、表示の文字だけにする", () => {
    expect(withoutWorkspaceLinks("[作業領域](/workspace) と [ルート](/workspace/)")).toBe(
      "作業領域 と ルート",
    );
  });

  it("表示の文字が空で、作業領域そのものへのリンクは、変えない（外すと何も残らず、前後の文字が、空白を挟んでつながる）", () => {
    for (const body of [
      // `Fixes  #12` になると、マージで別の Issue を閉じうる
      "Fixes [](/workspace) #12",
      "前[](/workspace)後",
      "前 [ ](/workspace/) 後",
      "![](/workspace)",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
    // 同じ本文の、ほかのリンクは外す
    expect(withoutWorkspaceLinks("Fixes [](/workspace) #12 と [a.md](/workspace/a.md)")).toBe(
      "Fixes [](/workspace) #12 と a.md",
    );
  });

  it("空白を置かない日本語の文に、打ち消し・文字参照があっても、リンクは外す（つながりを見るのは、ASCII の文字の連なりの中だけ）", () => {
    expect(
      withoutWorkspaceLinks("変更は[a.ts](/workspace/a.ts)にある。正規表現は`\\d+`を使う。"),
    ).toBe("変更はa.tsにある。正規表現は`\\d+`を使う。");
    expect(withoutWorkspaceLinks("[foo\\_bar](/workspace/foo_bar.md)を参照。")).toBe(
      "foo\\_bar（`foo_bar.md`）を参照。",
    );
    expect(withoutWorkspaceLinks("[設計](/workspace/docs/d.md)とA&amp;Bの比較")).toBe(
      "設計（`docs/d.md`）とA&amp;Bの比較",
    );
    expect(
      withoutWorkspaceLinks(
        "C:\\tmp\\a.txtを消し、[手順](/workspace/docs/setup.md)に\\@や&commat;の説明を足した。",
      ),
    ).toBe("C:\\tmp\\a.txtを消し、手順（`docs/setup.md`）に\\@や&commat;の説明を足した。");
    // 外した文字のすぐ隣の、決め手の記号の無い打ち消しは、どの並びにもならない
    expect(withoutWorkspaceLinks("[設定](/workspace/docs/s.md)\\_x を直した")).toBe(
      "設定（`docs/s.md`）\\_x を直した",
    );
    // 日本語の文でも、外した文字と ASCII の文字でつながる打ち消し・文字参照があれば、変えない
    for (const body of [
      "宛先は[w](/workspace)\\@example.comです。",
      "担当は[x](/workspace)&commat;octocatです。",
      "[手順](/workspace/docs/setup.md)\\@octocatに確認。",
      "見る先は[ww](/workspace)w\\.example.comです。",
    ]) {
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
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

  it("本文の長さの上限いっぱいのふつうの本文も、リンクを外して終わる。対象の無い本文は解析しない", () => {
    const link = "[a.md](/workspace/a.md) ";
    const many = link.repeat(Math.floor(PR_BODY_MAX / link.length));
    // 2 乗の版でも時間切れに届かないので、遅い機械にも十分な余裕の上限（2.5 秒。通常は 0.4 秒未満）で時間の検査を残す
    const started = performance.now();
    expect(withoutWorkspaceLinks(many)).toBe("a.md ".repeat(Math.floor(PR_BODY_MAX / link.length)));
    expect(performance.now() - started).toBeLessThan(2500);
    // パーサーが時間のかかる本文（記号の連続）でも、作業領域へのリンクがありえなければ、解析せずに返す
    const heavy = [
      ">".repeat(PR_BODY_MAX),
      "*a".repeat(PR_BODY_MAX / 2),
      `${"+ ".repeat(PR_BODY_MAX / 2 - 20)}[a](docs/a.md)`,
      `${"1. ".repeat(20_000)}/workspace/a.md`,
    ];
    // 時間は測らない。解析の前に「ありえない」と見分けられること（解析しない）を確かめる
    for (const body of heavy) {
      expect(cannotLinkToWorkspace(body, "/workspace")).toBe(true);
      expect(withoutWorkspaceLinks(body)).toBe(body);
    }
  });
});

describe("すでにある PR の更新で、マージした本文・まとめた本文からも、作業領域へのリンクを外す（unlinkedMergedBody）", () => {
  it("作業領域へのリンクを外す。ほかのリンク・書き方は変えない", async () => {
    const human = [
      "> 人のメモ：[設計](https://example.com/design) と [相対](docs/a.md) を見ること。",
      "",
      "値は `ghp_secret` ではなく、[手順](/workspace/docs/setup.md) のとおりに入れる。  ",
      "<!-- 人のコメント -->",
    ].join("\n");
    expect(await unlinkedMergedBody(human, [])).toEqual({
      body: human.replace("[手順](/workspace/docs/setup.md)", "手順（`docs/setup.md`）"),
    });
  });

  it("外すリンクが無ければ、渡された本文をそのまま返す（秘密の値と同じ文字があっても、人の本文に手を加えない）", async () => {
    const body = "人が書いた本文。[設計](https://example.com/design) の値は abc です。";
    expect(await unlinkedMergedBody(body, ["abc"])).toEqual({ body });
    // sacty が組み立てた本文は、外すリンクが無くても、伏せ直す
    expect(await unlinkedGeneratedBody(body, ["abc"])).toEqual({
      body: "人が書いた本文。[設計](https://example.com/design) の値は [REDACTED] です。",
    });
    // 外せない（変えずに残す）リンクだけのときも、そのまま返す
    const kept = "ping [@](/workspace)octocat の値は abc です。";
    expect(await unlinkedMergedBody(kept, ["abc"])).toEqual({ body: kept });
  });

  it("外した後に現れる秘密の値を、伏せる（文字がつながる・リンク先の文字参照が元の文字に戻る）", async () => {
    const body = [
      "値は ghp_[s](/workspace)ecret です。",
      "[手順](/workspace/docs/ghp&#95;secret.md) を直しました。",
    ].join("\n\n");
    expect(await unlinkedMergedBody(body, ["ghp_secret"])).toEqual({
      body: ["値は [REDACTED] です。", "手順（`docs/[REDACTED].md`） を直しました。"].join("\n\n"),
    });
  });

  it("伏せた結果が長さの上限を超えるときは、外すのをやめて、渡された本文を返す（秘密の値は現れない・上限を超えない）", async () => {
    // 短い秘密の値（伏せ字より短い）が、リンク先の文字参照から何度も現れる。伏せると、外して縮んだ分より長くなる
    const secret = "ghx";
    const link = `[手順](/workspace/${"gh&#120;".repeat(1_000)})`;
    const body = `${link}\n\n${"説明。".repeat(30_000)}`.slice(0, PR_BODY_MAX);
    expect(body.length).toBe(PR_BODY_MAX);
    const { body: out, skipped } = await unlinkedMergedBody(body, [secret]);
    expect(skipped).toBeUndefined();
    expect(out).toBe(body);
    expect(out).not.toContain(secret);
    // 外していれば、伏せた後に上限を超えていた（この分岐を通ったことの確認）
    const unlinked = withoutWorkspaceLinks(body).replaceAll(secret, "[REDACTED]");
    expect(unlinked).not.toBe(body);
    expect(unlinked.length).toBeGreaterThan(PR_BODY_MAX);
    // 上限に余裕があれば、外して伏せる
    const short = `${link}\n\n説明。`;
    expect(await unlinkedMergedBody(short, [secret])).toEqual({
      body: `手順（\`${"[REDACTED]".repeat(1_000)}\`）\n\n説明。`,
    });
  });
});

describe("本文の解析の間も、デーモンがほかの処理に応える（PBI-372）", () => {
  /** 先頭に作業領域へのリンクを置いて（解析に回る）、記号を長さ length まで続けた本文。 */
  const heavy = (unit: string, length: number) => {
    const head = "[a](/workspace/a.md)\n\n";
    return head + unit.repeat(Math.floor((length - head.length) / unit.length));
  };

  /**
   * work を待つ間に、このスレッドのほかの処理（先に予約したコールバック）が動いたか。解析をこのスレッドで同期に行うと、
   * 解析が終わるまでコールバックは動かず、終わった後は、結果を待つ処理のほうが先に進む。時間は測らない。
   */
  const respondsWhile = async <T>(work: () => Promise<T>): Promise<{ result: T; ran: boolean }> => {
    let ran = false;
    const immediate = setImmediate(() => {
      ran = true;
    });
    const result = await work();
    const ranBefore = ran;
    clearImmediate(immediate);
    return { result, ran: ranBefore };
  };

  it("記号が上限近くまで続く本文は、時間の上限で解析を打ち切り、本文を変えずに返す。その間も、ほかの処理が動く", async () => {
    // 同期の解析では、3〜50 秒かかる形（`>`・`*a`・`*_`・`1. `・`+ `）。上限を短くして、打ち切りを確かめる
    for (const unit of [">", "*a", "*_", "1. ", "+ "]) {
      const body = heavy(unit, PR_BODY_MAX);
      expect(body.length).toBeGreaterThan(PR_BODY_MAX - 3);
      const generated = await respondsWhile(() =>
        unlinkedGeneratedBody(body, [], { timeoutMs: 20 }),
      );
      expect(generated).toEqual({ result: { body, skipped: "timeout" }, ran: true });
      const merged = await respondsWhile(() => unlinkedMergedBody(body, [], { timeoutMs: 20 }));
      expect(merged).toEqual({ result: { body, skipped: "timeout" }, ran: true });
    }
  });

  it("打ち切った本文でも、sacty が組み立てた本文は、秘密の値を伏せ直す。人の直しを含む本文は、そのまま返す", async () => {
    const body = `${heavy("*_", PR_BODY_MAX - 20)}\n\n値は abc`;
    expect(await unlinkedGeneratedBody(body, ["abc"], { timeoutMs: 20 })).toEqual({
      body: body.replace("値は abc", "値は [REDACTED]"),
      skipped: "timeout",
    });
    expect(await unlinkedMergedBody(body, ["abc"], { timeoutMs: 20 })).toEqual({
      body,
      skipped: "timeout",
    });
  });

  it("時間の上限の中で終わる解析は、同期の変換と同じ結果を返す。その間も、ほかの処理が動く", async () => {
    // 同期の解析に時間がかかる形（4,000 文字の `*_` で、0.1 秒ほど。遅い実行環境でも、時間の上限に届かない長さ）。
    // 結果は、リンクを外した本文になる
    const slow = heavy("*_", 4_000);
    const converted = await respondsWhile(() => unlinkedGeneratedBody(slow, []));
    expect(converted).toEqual({ result: { body: withoutWorkspaceLinks(slow) }, ran: true });
    expect(converted.result.body).toBe(slow.replace("[a](/workspace/a.md)", "a（`a.md`）"));
    // ふつうの本文（上限いっぱいにリンクが並ぶ）は、これまでと同じ結果になる
    const link = "[a.md](/workspace/a.md) ";
    const many = link.repeat(Math.floor(PR_BODY_MAX / link.length));
    expect(await unlinkedGeneratedBody(many, [])).toEqual({
      body: "a.md ".repeat(Math.floor(PR_BODY_MAX / link.length)),
    });
    expect(await unlinkedMergedBody(many, [])).toEqual({
      body: "a.md ".repeat(Math.floor(PR_BODY_MAX / link.length)),
    });
  });

  it("変換の途中の例外では、本文を変えずに返し、例外の名前を添える", () => {
    // 引用が深く入れ子になり、構文木をたどる途中でスタックがあふれる。このスレッドで直接呼ぶ（スタックの大きさに
    // 依存するが、このスレッドでは 2,000 段であふれるので、その 10 倍の深さにする）。別スレッドでの失敗の扱いは、
    // 別スレッドを差し替えて確かめる
    const deep = heavy(">", 20_000);
    expect(convertWorkspaceLinks(deep, "/workspace")).toEqual({ body: deep, failed: "RangeError" });
  });

  it("空の本文・作業領域へのリンクがありえない本文は、解析せずに、そのまま返す", async () => {
    expect(await unlinkedGeneratedBody("", [])).toEqual({ body: "" });
    expect(await unlinkedMergedBody("", [])).toEqual({ body: "" });
    // 解析すれば時間の上限を超える形でも、解析しないので、打ち切りにならない
    const unlinkable = `${"+ ".repeat(PR_BODY_MAX / 2 - 20)}[a](docs/a.md)`;
    expect(await unlinkedGeneratedBody(unlinkable, [], { timeoutMs: 20 })).toEqual({
      body: unlinkable,
    });
  });

  it("同時に呼んでも、それぞれの結果を返す", async () => {
    const bodies = Array.from({ length: 4 }, (_, i) => `[a${i}.md](/workspace/a${i}.md) を直した`);
    const results = await Promise.all(bodies.map((body) => unlinkedMergedBody(body, [])));
    expect(results).toEqual(bodies.map((_, i) => ({ body: `a${i}.md を直した` })));
  });
});

describe("別スレッドの失敗・順番待ち（PBI-372。別スレッドを差し替えて確かめる）", () => {
  const body = "[手順](/workspace/docs/setup.md) を直した。値は abc";

  /** 差し替える別スレッド。テストから、答え・エラー・終了を起こす。 */
  class FakeWorker extends EventEmitter {
    terminated = 0;
    constructor(readonly job: ConvertJob) {
      super();
    }
    terminate(): Promise<number> {
      this.terminated++;
      return Promise.resolve(0);
    }
  }

  /** 起動した別スレッドを覚えておく、差し替えの起動。 */
  const fakes = () => {
    const started: FakeWorker[] = [];
    const startWorker = (job: ConvertJob) => {
      const worker = new FakeWorker(job);
      started.push(worker);
      return worker;
    };
    return { started, startWorker };
  };

  /** 待っている処理（順番待ちの受け渡し・別スレッドの起動）を進める。 */
  const settle = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  };

  it("別スレッドに、本文と作業領域のパスを渡し、答えの本文を使う。答えを受け取ったら、別スレッドを止める", async () => {
    const { started, startWorker } = fakes();
    const pending = unlinkedGeneratedBody(body, ["abc"], { startWorker });
    await settle();
    expect(started.map((w) => w.job)).toEqual([
      { sactyPrBodyLinks: true, body, workspace: "/workspace" },
    ]);
    started[0]?.emit("message", { body: "手順 を直した。値は abc" });
    // 答えの後の終了は、失敗にしない
    started[0]?.emit("exit", 0);
    expect(await pending).toEqual({ body: "手順 を直した。値は [REDACTED]" });
    expect(started[0]?.terminated).toBe(1);
  });

  it("別スレッドを起動できないときは、本文を変えずに返す（原因は、例外のコードか名前。メッセージは出さない）", async () => {
    const failing = (error: unknown) => () => {
      throw error;
    };
    const missing = Object.assign(new Error(`Cannot find module ${body}`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
    expect(await unlinkedMergedBody(body, ["abc"], { startWorker: failing(missing) })).toEqual({
      body,
      skipped: "error",
      cause: "別スレッドを起動できない（ERR_MODULE_NOT_FOUND）",
    });
    expect(
      await unlinkedMergedBody(body, [], { startWorker: failing(new TypeError(body)) }),
    ).toEqual({ body, skipped: "error", cause: "別スレッドを起動できない（TypeError）" });
    // 例外でないもの・名前が文字として使えないものは、中身を出さない
    expect(await unlinkedMergedBody(body, [], { startWorker: failing(body) })).toEqual({
      body,
      skipped: "error",
      cause: "別スレッドを起動できない（string）",
    });
    const named = Object.assign(new Error("x"), { name: `名前 ${body}` });
    expect(await unlinkedMergedBody(body, [], { startWorker: failing(named) })).toEqual({
      body,
      skipped: "error",
      cause: "別スレッドを起動できない（Error）",
    });
    // sacty が組み立てた本文は、外せなくても、秘密の値を伏せ直す
    expect(await unlinkedGeneratedBody(body, ["abc"], { startWorker: failing(missing) })).toEqual({
      body: body.replace("abc", "[REDACTED]"),
      skipped: "error",
      cause: "別スレッドを起動できない（ERR_MODULE_NOT_FOUND）",
    });
  });

  it("別スレッドが、答える前に終わった・エラーになったときは、本文を変えずに返す", async () => {
    const cases: [(worker: FakeWorker) => void, string][] = [
      [(w) => w.emit("exit", 1), "別スレッドが答えずに終了（終了コード 1）"],
      [(w) => w.emit("exit", 0), "別スレッドが答えずに終了（終了コード 0）"],
      [
        (w) =>
          w.emit("error", Object.assign(new Error(body), { code: "ERR_WORKER_OUT_OF_MEMORY" })),
        "別スレッドのエラー（ERR_WORKER_OUT_OF_MEMORY）",
      ],
      [(w) => w.emit("error", new SyntaxError(body)), "別スレッドのエラー（SyntaxError）"],
    ];
    for (const [fail, cause] of cases) {
      const { started, startWorker } = fakes();
      const pending = unlinkedMergedBody(body, [], { startWorker });
      await settle();
      const worker = started[0];
      if (!worker) throw new Error("別スレッドが起動していない");
      fail(worker);
      // エラーの後の終了・遅れて届いた答えでは、結果は変わらない
      worker.emit("exit", 1);
      worker.emit("message", { body: "手順" });
      expect(await pending).toEqual({ body, skipped: "error", cause });
      expect(worker.terminated).toBe(1);
    }
  });

  it("別スレッドの答えが、変換の例外・長くなった本文・本文でないものなら、使わずに、本文を変えずに返す", async () => {
    const cases: [unknown, string][] = [
      [{ body, failed: "RangeError" }, "変換の例外（RangeError）"],
      // 例外の名前に、文字として使えないものが入っていても、そのままは出さない
      [{ body, failed: `名前 ${body}` }, "変換の例外（Error）"],
      // 置き換えは本文を長くしない。長くなった答えは、長さの上限を超えうるので、使わない
      [{ body: `${body}。` }, "別スレッドの答えが不正"],
      [{ body: 1 }, "別スレッドの答えが不正"],
      [{}, "別スレッドの答えが不正"],
      [null, "別スレッドの答えが不正"],
      ["手順", "別スレッドの答えが不正"],
    ];
    for (const [answer, cause] of cases) {
      const { started, startWorker } = fakes();
      const pending = unlinkedGeneratedBody(body, [], { startWorker });
      await settle();
      started[0]?.emit("message", answer);
      expect(await pending).toEqual({ body, skipped: "error", cause });
    }
    // 同じ長さ・短い答えは、使う
    const { started, startWorker } = fakes();
    const pending = unlinkedGeneratedBody(body, [], { startWorker });
    await settle();
    started[0]?.emit("message", { body: "x".repeat(body.length) });
    expect(await pending).toEqual({ body: "x".repeat(body.length) });
  });

  it("別スレッドは1つずつ動かし、ほかは来た順に待つ。解析しない本文は、待たない", async () => {
    const { started, startWorker } = fakes();
    const bodies = [1, 2, 3].map((i) => `[a${i}](/workspace/a${i}.md)`);
    const results: string[] = [];
    const pending = bodies.map((b, i) =>
      unlinkedMergedBody(b, [], { startWorker }).then((r) => {
        results.push(`${i + 1}:${r.skipped ?? r.body}`);
      }),
    );
    await settle();
    // 動いているのは、最初の1つだけ
    expect(started.map((w) => w.job.body)).toEqual([bodies[0]]);
    // 作業領域へのリンクがありえない本文は、順番を待たずに返る
    expect(await unlinkedMergedBody("リンクの無い本文", [], { startWorker })).toEqual({
      body: "リンクの無い本文",
    });
    expect(started).toHaveLength(1);
    // 1つ目が終わると、2つ目が動く。失敗で終わっても、次に番を渡す
    started[0]?.emit("message", { body: "a1" });
    await settle();
    expect(started.map((w) => w.job.body)).toEqual([bodies[0], bodies[1]]);
    started[1]?.emit("exit", 1);
    await settle();
    expect(started.map((w) => w.job.body)).toEqual(bodies);
    started[2]?.emit("message", { body: "a3" });
    await Promise.all(pending);
    expect(results).toEqual(["1:a1", "2:error", "3:a3"]);
    // 番を返してあるので、次の本文は、すぐに動く
    const next = unlinkedMergedBody(bodies[0] ?? "", [], { startWorker });
    await settle();
    expect(started).toHaveLength(4);
    started[3]?.emit("message", { body: "a1" });
    expect(await next).toEqual({ body: "a1" });
  });

  it("時間の上限は、別スレッドを起動してから数える（順番を待つ時間は入れない）。打ち切ったら、別スレッドを止めて、次に番を渡す", async () => {
    vi.useFakeTimers();
    try {
      const { started, startWorker } = fakes();
      const first = unlinkedMergedBody(body, [], { startWorker });
      const second = unlinkedMergedBody(`${body}。`, [], { startWorker });
      let secondDone = false;
      void second.then(() => {
        secondDone = true;
      });
      await settle();
      expect(started).toHaveLength(1);
      // 既定の上限（5 秒）の直前では、まだ打ち切らない
      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS - 1);
      expect(started[0]?.terminated).toBe(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(await first).toEqual({ body, skipped: "timeout" });
      expect(started[0]?.terminated).toBe(1);
      // 2つ目は、ここで起動する。待っていた 5 秒は数えないので、起動してから 5 秒の直前までは、打ち切らない
      await settle();
      expect(started).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS - 1);
      expect(secondDone).toBe(false);
      started[1]?.emit("message", { body: "手順 を直した。値は abc。" });
      expect(await second).toEqual({ body: "手順 を直した。値は abc。" });
      // 答えた後は、時間の上限が来ても、何も起きない
      await vi.advanceTimersByTimeAsync(PARSE_TIMEOUT_MS);
      expect(started[1]?.terminated).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
