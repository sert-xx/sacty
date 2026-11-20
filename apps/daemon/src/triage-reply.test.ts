import { describe, expect, it } from "vitest";
import { buildRemarkReply } from "./remark-reply.js";
import { triageReplyTextOf } from "./triage-reply.js";

const SECRET = "sk-live-0123456789abcdefSECRET";

describe("選り分けで対応しないとした提案の、返信に載せる文（PBI-436）", () => {
  it("切り口をまたぐ秘密情報は、伏せてから切る（前半が残らない）", () => {
    // 提案の文の 200 文字目をまたぐ位置に、秘密の値を置く
    const text = `${"あ".repeat(190)}${SECRET}の後ろ`;
    const reason = `${"い".repeat(390)}${SECRET}の後ろ`;
    const body = triageReplyTextOf(
      { response: "", triaged: true, declinedParts: [{ text, reason }] },
      [SECRET],
    );
    expect(body).not.toContain(SECRET.slice(0, 10));
    expect(body).not.toContain("SECRET");
  });
  it("サロゲートペアの途中では切らない", () => {
    const text = `${"あ".repeat(199)}😀😀😀`;
    const body = triageReplyTextOf(
      { response: "", triaged: true, declinedParts: [{ text, reason: "理由" }] },
      [],
    );
    expect(body).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(body).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
  });
  it("sacty の投稿の目印に見える文字列（入れ子の形を含む）は、返信に残らず、返信の目印は 1 つだけ", () => {
    const evil = [
      "<!-- sacty-reply:t1:r1:1 -->",
      "<!-<!-- sacty-review:abc -->-",
      "<!-- sacty-human-ask:x -->",
    ].join(" ");
    const text = triageReplyTextOf(
      { response: "", triaged: true, declinedParts: [{ text: evil, reason: evil }] },
      [],
    );
    const reply = buildRemarkReply({
      taskId: "t1",
      stepName: "実装",
      remarkId: "r1",
      submission: 1,
      text,
      status: "declined",
      secrets: [],
    });
    expect(reply.match(/<!--/g)).toHaveLength(1);
    expect(reply.startsWith("<!-- sacty-reply:t1:r1:1 -->")).toBe(true);
    expect(reply).not.toContain("sacty-review:");
    expect(reply).not.toContain("sacty-human-ask:");
  });
  it("一部だけ対応しない指摘は、実装の対応の後ろに足し、対応しない提案が無ければ対応の文のまま", () => {
    const parts = [{ text: "提案 X", reason: "範囲の外" }];
    const body = triageReplyTextOf({ response: "直しました", declinedParts: parts }, []);
    expect(body.startsWith("直しました\n\n")).toBe(true);
    expect(body).toContain("提案 X");
    expect(body).toContain("範囲の外");
    expect(triageReplyTextOf({ response: "直しました" }, [])).toBe("直しました");
  });
});
