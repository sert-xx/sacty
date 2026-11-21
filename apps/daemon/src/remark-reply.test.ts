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
    stepName: "実装",
    remarkId: "implement-1-1",
    submission: 2,
    text: "null を返すようにしました",
    secrets: [],
  };

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

  it("先頭に目印を置き、対応したか・対応していないかを先頭に書く。申告が無ければ対応の文だけ。末尾に、どのタスクの AI が書いたかを書く", () => {
    const addressed = buildRemarkReply({ ...base, status: "addressed" });
    expect(addressed).toBe(
      [
        "<!-- sacty-reply:t1:implement-1-1:2 -->",
        "**対応しました。**",
        "",
        "null を返すようにしました",
        "",
        "---",
        "Sacty のタスク t1 の実装の工程で、AI が書きました（指摘 implement-1-1 への対応）。",
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
      extra: { author?: "sacty_review" | "human"; quote?: string } = {},
    ) => {
      const ref = { kind, id };
      return buildRemarkReply({
        ...base,
        status: "addressed",
        origin: { ref, url: remarkOriginUrl(pr, ref), ...extra },
      }).split("\n");
    };

    it("元の投稿の種類・出どころ・リンクを、文で書く。出どころが分からない（引き継いだ PR の指摘）ときは、出どころを言わない", () => {
      expect(open("review", 601, { author: "sacty_review" })[1]).toBe(
        `Sacty の AI が書いたレビューの本文（[このレビュー](${pr}#pullrequestreview-601)）への返信です。`,
      );
      expect(open("review", 602, { author: "human" })[1]).toBe(
        `人が書いたレビューの本文（[このレビュー](${pr}#pullrequestreview-602)）への返信です。`,
      );
      expect(open("comment", 401, { author: "human" })[1]).toBe(
        `人が書いた通常のコメント（[このコメント](${pr}#issuecomment-401)）への返信です。`,
      );
      expect(open("review_comment", 501, { author: "human" })[1]).toBe(
        `人が書いた行へのコメント（[この行へのコメント](${pr}#discussion_r501)）への返信です。`,
      );
      expect(open("review", 601)[1]).toBe(
        `レビューの本文（[このレビュー](${pr}#pullrequestreview-601)）への返信です。`,
      );
    });

    it("通常のコメントへの返信は、書き出しのすぐ後に、元のコメントの冒頭を1行で引用する。レビューの本文・行へのコメントには付けない", () => {
      const lines = open("comment", 401, {
        author: "human",
        quote: "再開の\nフォームの   候補も\n\n直して",
      });
      expect(lines[2]).toBe("> 「`再開の フォームの 候補も 直して`」");
      expect(lines[3]).toBe("");
      expect(lines[4]).toBe("**対応しました。**");
      expect(open("review", 601, { author: "human", quote: "全体に" })).not.toContain(
        "> 「全体に」",
      );
      expect(open("comment", 402, { author: "human", quote: " \n " })[2]).toBe("");
      // 長ければ上限で切る
      const long = open("comment", 403, { author: "human", quote: "あ".repeat(500) })[2] ?? "";
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
          author: "human",
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

    it("書き出しの出どころと引用の組み立て：取り込んだ指摘は source で決まり、引き継いだ PR の指摘は出どころを言わず引用も付けない", () => {
      const ref = { kind: "comment", id: 401 } as const;
      const url = "https://github.com/acme/app/pull/7";
      const openOf = (due: Parameters<typeof remarkReplyOrigin>[0]) =>
        buildRemarkReply({ ...base, origin: remarkReplyOrigin(due, ref, url) }).split("\n");
      expect(openOf({ originText: "直して" }).slice(1, 3)).toEqual([
        `人が書いた通常のコメント（[このコメント](${url}#issuecomment-401)）への返信です。`,
        "> 「`直して`」",
      ]);
      expect(openOf({ source: "sacty_review", originText: "直して" })[1]).toBe(
        `Sacty の AI が書いた通常のコメント（[このコメント](${url}#issuecomment-401)）への返信です。`,
      );
      expect(openOf({ continued: true, originText: "直して" }).slice(1, 3)).toEqual([
        `通常のコメント（[このコメント](${url}#issuecomment-401)）への返信です。`,
        "",
      ]);
    });

    it("同じ回の、sacty のレビューの本文への返信と、人が書いた通常のコメントへの返信は、目印の行を除く最初の2行（空行を数えない）が違い、宛先の種類が読める", () => {
      const first2 = (body: string) =>
        body
          .split("\n")
          .slice(1)
          .filter((l) => l.trim() !== "")
          .slice(0, 2);
      const onReview = first2(
        buildRemarkReply({
          ...base,
          remarkId: "implement-1-2",
          status: "addressed",
          origin: {
            ref: { kind: "review", id: 601 },
            url: remarkOriginUrl(pr, { kind: "review", id: 601 }),
            author: "sacty_review",
            quote: "<!-- sacty-review:a:1 -->\n## sacty のレビュー\n@sert-xx 判定：要修正",
          },
        }),
      );
      const onComment = first2(
        buildRemarkReply({
          ...base,
          remarkId: "implement-1-3",
          status: "addressed",
          origin: {
            ref: { kind: "comment", id: 401 },
            url: remarkOriginUrl(pr, { kind: "comment", id: 401 }),
            author: "human",
            quote: "再開のフォームの候補も直して",
          },
        }),
      );
      expect(onReview).not.toEqual(onComment);
      expect(onReview[0]).not.toBe(onComment[0]);
      expect(onReview[0]).toContain("Sacty の AI が書いたレビューの本文");
      expect(onComment[0]).toContain("人が書いた通常のコメント");
      expect(onComment[1]).toBe("> 「`再開のフォームの候補も直して`」");
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
      stepName: "実装",
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
        "Sacty のタスク t1 の実装の工程で、AI が書きました（指摘 implement-1-1 への対応）。",
      ].join("\n"),
    );
    // 決まったことのようには書かない
    expect(body).not.toContain("対応しました");
    expect(body).not.toContain("対応していません");
    expect(isSactyRemarkReply(body)).toBe(true);
  });
});
