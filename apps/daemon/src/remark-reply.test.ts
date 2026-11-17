import { describe, expect, it } from "vitest";
import { isSactyRemarkReply } from "./github.js";
import {
  buildRemarkReply,
  REPLY_TEXT_MAX,
  remarkOriginRef,
  remarkOriginUrl,
  remarkReplyMarker,
  remarkReplyMarkerOf,
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
        "sacty のタスク t1 の実装の工程で、AI が書きました（指摘 implement-1-1 への対応）。",
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

  it("PR のコメントとして投稿するときは、元のレビュー・コメントへのリンクを付ける", () => {
    const pr = "https://github.com/acme/app/pull/7";
    const link = (kind: "review" | "review_comment" | "comment", id: number) => {
      const ref = { kind, id };
      return buildRemarkReply({
        ...base,
        status: "addressed",
        origin: { ref, url: remarkOriginUrl(pr, ref) },
      }).split("\n")[1];
    };
    expect(link("review", 601)).toBe(`[このレビュー](${pr}#pullrequestreview-601)への返信です。`);
    expect(link("comment", 401)).toBe(`[このコメント](${pr}#issuecomment-401)への返信です。`);
    expect(link("review_comment", 501)).toBe(
      `[この行へのコメント](${pr}#discussion_r501)への返信です。`,
    );
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
        "sacty のタスク t1 の実装の工程で、AI が書きました（指摘 implement-1-1 への対応）。",
      ].join("\n"),
    );
    // 決まったことのようには書かない
    expect(body).not.toContain("対応しました");
    expect(body).not.toContain("対応していません");
    expect(isSactyRemarkReply(body)).toBe(true);
  });
});
