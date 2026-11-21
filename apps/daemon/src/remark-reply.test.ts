import { describe, expect, it } from "vitest";
import { isSactyRemarkReply } from "./github.js";
import {
  buildRemarkReply,
  REPLY_QUOTE_MAX,
  REPLY_TEXT_MAX,
  remarkOriginRef,
  remarkOriginUrl,
  remarkQuote,
  remarkReplyMarker,
  remarkReplyMarkerOf,
  remarkReplyOrigin,
} from "./remark-reply.js";

describe("指摘への対応の、PR への返信の本文（PBI-352）", () => {
  const base = {
    taskId: "t1",
    remarkId: "implement-1-1",
    submission: 2,
    text: "null を返すようにしました",
    secrets: [],
  };

  it("対応の文に指摘の ID が書かれていても、返信に出さない", () => {
    const body = buildRemarkReply({
      ...base,
      status: "addressed",
      text: "implement-1-2 と同じ理由で直しました（implement-1-3 への対応）。",
    });
    expect(body.split("\n").slice(1).join("\n")).not.toMatch(/implement-1-\d/);
    expect(body).toContain("指摘と同じ理由で直しました。");
  });

  it("末尾は「Sacty の AI が書きました。」だけで、工程の名前・タスクの ID・指摘の ID を出さない（先頭の目印は残る。TV-15）", () => {
    const body = buildRemarkReply({
      ...base,
      remarkId: "design-3-1",
      status: "addressed",
    });
    const marker = remarkReplyMarker("t1", "design-3-1", 2);
    expect(body.split("\n").at(-1)).toBe("Sacty の AI が書きました。");
    expect(body.startsWith(marker)).toBe(true);
    const rest = body.replace(marker, "");
    expect(rest).not.toContain("t1");
    expect(rest).not.toContain("design-3-1");
    // 続きの実行の返信（continued）も、同じ末尾にする
    expect(
      buildRemarkReply({ ...base, remarkId: "design-3-1", continued: true })
        .split("\n")
        .at(-1),
    ).toBe("Sacty の AI が書きました。");
  });

  it("origin の key から、種類と ID を読む。読めない形は undefined", () => {
    expect(remarkOriginRef("review_comment:501")).toEqual({ kind: "review_comment", id: 501 });
    expect(remarkOriginRef("review:601")).toEqual({ kind: "review", id: 601 });
    expect(remarkOriginRef("comment:401")).toEqual({ kind: "comment", id: 401 });
    for (const key of ["", "comment:", "comment:0", "comment:abc", "issue:1", "comment:1:2"]) {
      expect(remarkOriginRef(key)).toBeUndefined();
    }
  });

  it("元のコメントの URL は、PR の URL と、種類ごとの位置から作る", () => {
    const pr = "https://github.com/acme/app/pull/7";
    expect(remarkOriginUrl(`${pr}/`, { kind: "review", id: 601 })).toBe(
      `${pr}#pullrequestreview-601`,
    );
    expect(remarkOriginUrl(pr, { kind: "review_comment", id: 501 })).toBe(`${pr}#discussion_r501`);
    expect(remarkOriginUrl(pr, { kind: "comment", id: 401 })).toBe(`${pr}#issuecomment-401`);
  });

  it("先頭に目印を置き、対応したか・対応していないかを先頭に書く。申告が無ければ対応の文だけ。末尾に AI が書いた旨を書く（工程・タスクの ID・指摘の ID は書かない）", () => {
    const addressed = buildRemarkReply({ ...base, status: "addressed" });
    expect(addressed).toBe(
      [
        "<!-- sacty-reply:t1:implement-1-1:2 -->",
        "**対応しました。**",
        "",
        "null を返すようにしました",
        "",
        "---",
        "Sacty の AI が書きました。",
      ].join("\n"),
    );
    expect(isSactyRemarkReply(addressed)).toBe(true);
    expect(addressed.startsWith(remarkReplyMarker("t1", "implement-1-1", 2))).toBe(true);
    // 探すときの目印は、提出回を問わない。ほかの指摘（implement-1-10 など）の返信とは一致しない
    expect(addressed).toContain(remarkReplyMarkerOf("t1", "implement-1-1"));
    expect(buildRemarkReply({ ...base, remarkId: "implement-1-10" })).not.toContain(
      remarkReplyMarkerOf("t1", "implement-1-1"),
    );
    const declined = buildRemarkReply({ ...base, status: "declined", text: "範囲の外です" });
    expect(declined).toContain("**対応していません。** 理由：\n\n範囲の外です");
    const plain = buildRemarkReply(base);
    expect(plain).not.toContain("**対応");
    expect(plain.split("\n")[1]).toBe("null を返すようにしました");
  });

  describe("PR のコメントとして投稿するときの書き出し", () => {
    const pr = "https://github.com/acme/app/pull/7";
    const open = (
      kind: "review" | "review_comment" | "comment",
      id: number,
      extra: { quote?: string } = {},
    ) => {
      const ref = { kind, id };
      return buildRemarkReply({
        ...base,
        status: "addressed",
        origin: { ref, url: remarkOriginUrl(pr, ref), ...extra },
      }).split("\n");
    };

    it("書き出しは、元のコメントへのリンクだけで、元の投稿の種類・書いた人を言わない（TV-15）", () => {
      for (const [kind, id, anchor] of [
        ["review", 601, "pullrequestreview-601"],
        ["comment", 401, "issuecomment-401"],
        ["review_comment", 501, "discussion_r501"],
      ] as const) {
        const reply = open(kind, id);
        expect(reply[1]).toBe(`[この指摘](${pr}#${anchor})への返信です。`);
        const body = reply.slice(1).join("\n");
        for (const word of [
          "Sacty の AI が書いた",
          "人が書いた",
          "レビューの本文",
          "通常のコメント",
          "工程",
        ]) {
          expect(body).not.toContain(word);
        }
        expect(body).not.toContain("t1");
        expect(body).not.toContain("implement-1-1");
      }
    });

    it("通常のコメントへの返信は、書き出しのすぐ後に、元のコメントの冒頭を1行で引用する。レビューの本文・行へのコメントには付けない", () => {
      const lines = open("comment", 401, {
        quote: "再開の\nフォームの   候補も\n\n直して",
      });
      expect(lines[2]).toBe("> 「`再開の フォームの 候補も 直して`」");
      expect(lines[3]).toBe("");
      expect(lines[4]).toBe("**対応しました。**");
      expect(open("review", 601, { quote: "全体に" })).not.toContain("> 「全体に」");
      expect(open("comment", 402, { quote: " \n " })[2]).toBe("");
      // 長ければ上限で切る
      const long = open("comment", 403, { quote: "あ".repeat(500) })[2] ?? "";
      expect(long).toBe(`> 「\`${"あ".repeat(REPLY_QUOTE_MAX)}…\`」`);
    });

    it("引用は、秘密情報を伏せてから切る（切り口をまたぐ秘密情報の前半を残さない）。サロゲートペアの間で切らない", () => {
      const secret = "zk-live-0123456789abcdef";
      const quote = `${"a".repeat(REPLY_QUOTE_MAX - 8)}${secret} の後ろ`;
      const secretReply = buildRemarkReply({
        ...base,
        origin: {
          ref: { kind: "comment", id: 401 },
          url: remarkOriginUrl(pr, { kind: "comment", id: 401 }),
          quote,
        },
        secrets: [secret],
      });
      expect(secretReply).not.toContain("zk-live");
      expect(secretReply).not.toContain(secret.slice(0, 6));
      expect(secretReply).toContain("…`」");
      const emoji = remarkQuote(`${"a".repeat(REPLY_QUOTE_MAX - 1)}😀の後ろ`, []) ?? "";
      expect(emoji).toBe(`> 「\`${"a".repeat(REPLY_QUOTE_MAX - 1)}…\`」`);
      expect(emoji.isWellFormed()).toBe(true);
    });

    it("引用の @名前は通知を飛ばさず、内部のパスは対応の文と同じに置き換える。Markdown・HTML は返信の形と目印を壊さない", () => {
      const quoted =
        remarkQuote(
          "<!-- sacty-reply:t1:x:1 -->\n# 見出し\n@alice /sacty-input/task.md:77 を見て <script>x</script> ```js\ncode\n``` <!-- 閉じない",
          [],
        ) ?? "";
      expect(quoted).toContain("@\u200balice");
      expect(quoted).not.toContain("/sacty-input");
      expect(quoted).toContain("タスクの依頼");
      // 文字は置き換えず、インラインコードに入れる（バッククォートは、より長い囲みで包む）
      expect(quoted).toContain("<script>x</script>");
      expect(quoted).toMatch(/^> 「``+ .* ``+」$/);
      const refs = remarkQuote("#123 ![](http://x/y.png) [a](http://b) &#64;bob **強**", []) ?? "";
      expect(refs).toBe("> 「`#123 ![](http://x/y.png) [a](http://b) &#64;bob **強**`」");
      expect(quoted).not.toContain("\n");
      expect(quoted.startsWith("> 「")).toBe(true);
      // 返信全体：先頭は目印のまま、目印は1つだけ、見出し・コードの囲み・HTML のコメントが行頭に来ない
      const reply = buildRemarkReply({
        ...base,
        status: "addressed",
        origin: {
          ref: { kind: "comment", id: 401 },
          url: remarkOriginUrl(pr, { kind: "comment", id: 401 }),
          quote: "<!-- sacty-reply:t1:x:1 -->\n# 見出し\n```\n<!-- sacty-review:a:1 -->",
        },
      });
      expect(reply.startsWith(remarkReplyMarker("t1", "implement-1-1", 2))).toBe(true);
      expect(reply.match(/sacty-reply:/g)).toHaveLength(1);
      expect(reply).not.toContain("<!-- sacty-review");
      for (const line of reply.split("\n").slice(1)) {
        expect(line).not.toMatch(/^(#|```|<)/);
      }
    });

    it("引用の組み立て：取り込んだ指摘は元のコメントを引用し、引き継いだ PR の指摘は引用を付けない", () => {
      const ref = { kind: "comment", id: 401 } as const;
      const url = "https://github.com/acme/app/pull/7";
      const openOf = (due: Parameters<typeof remarkReplyOrigin>[0]) =>
        buildRemarkReply({ ...base, origin: remarkReplyOrigin(due, ref, url) }).split("\n");
      expect(openOf({ originText: "直して" }).slice(1, 3)).toEqual([
        `[この指摘](${url}#issuecomment-401)への返信です。`,
        "> 「`直して`」",
      ]);
      expect(openOf({ continued: true, originText: "直して" }).slice(1, 3)).toEqual([
        `[この指摘](${url}#issuecomment-401)への返信です。`,
        "",
      ]);
    });

    it("AI のレビューの本文から取り込んだ指摘と、人の通常のコメントから取り込んだ指摘への返信は、書き出しの形が同じで、リンク先だけが違う（TV-15）", () => {
      const onReview = open("review", 601, {
        quote: "<!-- sacty-review:a:1 -->\n## sacty のレビュー",
      });
      const onComment = open("comment", 401, { quote: "再開のフォームの候補も直して" });
      expect(onReview[1]).toBe(`[この指摘](${pr}#pullrequestreview-601)への返信です。`);
      expect(onComment[1]).toBe(`[この指摘](${pr}#issuecomment-401)への返信です。`);
      expect(onComment[2]).toBe("> 「`再開のフォームの候補も直して`」");
    });
  });

  it("秘密情報は、伏せてから切り詰める（切り口にかかった秘密情報の前半を残さない）。作業領域の内部のパスと @名前も、そのまま載せない", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    // 秘密情報が、上限の位置をまたぐ
    const text = `${"あ".repeat(REPLY_TEXT_MAX - 10)}${secret} の後ろ`;
    const body = buildRemarkReply({ ...base, text, secrets: [secret] });
    expect(body).not.toContain(secret.slice(0, 8));
    expect(body).toContain("…");
    // 上限の位置に絵文字（サロゲートペア）がまたがっても、文字を壊さない
    const emoji = buildRemarkReply({ ...base, text: `${"a".repeat(REPLY_TEXT_MAX - 1)}😀の後ろ` });
    expect(emoji).toContain(`${"a".repeat(REPLY_TEXT_MAX - 1)}…`);
    expect(emoji.isWellFormed()).toBe(true);
    const mention = buildRemarkReply({
      ...base,
      text: "@alice さん、/sacty-input/task.md:77 のとおり src/a.ts を直しました",
    });
    expect(mention).toContain("@​alice");
    expect(mention).not.toContain("/sacty-input");
    expect(mention).toContain("タスクの依頼 のとおり src/a.ts を直しました");
  });
});

describe("後続に回したい案の返信（PBI-370）", () => {
  it("案であり、人に確認中で、まだ決まっていないことを、先頭に明記する。末尾に、人がマージの前に決めることを添える", () => {
    const body = buildRemarkReply({
      taskId: "t1",
      remarkId: "implement-1-1",
      submission: 2,
      status: "deferred",
      text: "直すには新しい保存の仕組みが要り、この PR の範囲を超えます",
      secrets: [],
    });
    expect(body).toBe(
      [
        "<!-- sacty-reply:t1:implement-1-1:2 -->",
        "**この PR では直さず、後続に回したいという案です（人に確認中で、まだ決まっていません）。** 理由：",
        "",
        "直すには新しい保存の仕組みが要り、この PR の範囲を超えます",
        "",
        "後続に回すか、この PR で直すかは、このタスクを承認する人が、マージの前に決めます。決定は、この PR にコメントで残します。",
        "",
        "---",
        "Sacty の AI が書きました。",
      ].join("\n"),
    );
    // 決まったことのようには書かない
    expect(body).not.toContain("対応しました");
    expect(body).not.toContain("対応していません");
    expect(isSactyRemarkReply(body)).toBe(true);
  });
});
