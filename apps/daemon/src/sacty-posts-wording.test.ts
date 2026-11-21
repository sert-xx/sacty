import { describe, expect, it } from "vitest";
import { buildDeferralNotice } from "./deferral-notice.js";
import {
  isBasisComment,
  isDeferralNotice,
  isHumanAskNotice,
  isReviewStopNotice,
  isReworkNotice,
  isSactyRemarkReply,
  remarkReplyTaskOf,
} from "./github.js";
import { buildHumanAskNotice } from "./human-ask-notice.js";
import { buildRemarkReply, readRemarkReply } from "./remark-reply.js";
import { buildStopNotice } from "./review-stop-notice.js";
import { buildReworkNotice } from "./rework-notice.js";

// 文の変更（PBI-450）で、取り込みの側が Sacty 自身の投稿を見分けられなくならないことを確かめる。
// 見分けは、本文の先頭の HTML のコメントの目印で行う。文言で読むのは、返信の状態（readRemarkReply）だけ。

const base = {
  taskId: "t1",
  stepName: "実装",
  remarkId: "implement-1-1",
  submission: 2,
  text: "null を返すようにしました",
  secrets: [] as string[],
};

const withOrigin = (status: "addressed" | "declined" | "deferred") =>
  buildRemarkReply({
    ...base,
    status,
    origin: {
      ref: { kind: "review", id: 601 },
      url: "https://github.com/acme/app/pull/7#pullrequestreview-601",
      author: "sacty_review",
    },
  });

describe("新しい文の投稿を、取り込みが Sacty のものと見分ける（TV-14）", () => {
  it("返信：目印で見分け、状態を書いたとおりに読む。書き出しが「Sacty の AI が書いた…への返信です。」でも飛ばす", () => {
    for (const status of ["addressed", "declined", "deferred"] as const) {
      const body = buildRemarkReply({ ...base, status });
      expect(isSactyRemarkReply(body)).toBe(true);
      expect(remarkReplyTaskOf(body)).toBe("t1");
      expect(readRemarkReply(body).status).toBe(status);
      expect(readRemarkReply(withOrigin(status)).status).toBe(status);
    }
    expect(withOrigin("addressed").split("\n")[1]).toMatch(
      /^Sacty の AI が書いた.*への返信です。$/,
    );
  });

  it("知らせ 4 種と要求要件の全文のコメントも、目印で見分ける", () => {
    const common = { taskUrl: "http://127.0.0.1:4700/tasks/t1", localOnly: true, secrets: [] };
    expect(
      isHumanAskNotice(
        buildHumanAskNotice({
          taskId: "t1",
          step: "implement",
          stepName: "実装",
          submission: 1,
          confirms: [{ remarkIds: ["r"], text: "確認" }],
          ...common,
        }),
      ),
    ).toBe(true);
    expect(
      isReworkNotice(
        buildReworkNotice({ taskId: "t1", round: 1, reason: "理由", stepName: "設計", ...common }),
      ),
    ).toBe(true);
    expect(
      isReviewStopNotice(
        buildStopNotice({
          taskId: "t1",
          reason: "error",
          summary: "",
          taskUrl: common.taskUrl,
          localOnly: true,
        }),
      ),
    ).toBe(true);
    expect(
      isDeferralNotice(
        buildDeferralNotice({
          taskId: "t1",
          decision: 1,
          items: [{ remarkId: "r", decision: "fix" }],
          ...common,
        }) ?? "",
      ),
    ).toBe(true);
    expect(isBasisComment("<!-- sacty-basis:t1 -->\n## 全文")).toBe(true);
    expect(isBasisComment("<!-- sacty-basis:t1:2 -->\n続き")).toBe(true);
    // 目印で始まらないもの・他人の引用は、見分けない
    expect(isBasisComment("> <!-- sacty-basis:t1 -->")).toBe(false);
    expect(isBasisComment("前置き <!-- sacty-basis:t1 -->")).toBe(false);
  });
});

describe("古い文言の投稿も見分ける（TV-15）", () => {
  const sig = "sacty のタスク t1 の実装の工程で、AI が書きました（指摘 implement-1-1 への対応）。";
  const old = (head: string) =>
    [
      "<!-- sacty-reply:t1:implement-1-1:2 -->",
      "sacty の AI が書いたレビューの本文（[このレビュー](https://x/y)）への返信です。",
      "> 引用",
      "",
      head,
      "",
      "理由の文",
      "",
      "---",
      sig,
    ].join("\n");

  it("書き出しが「sacty の AI が書いた…への返信です。」の返信は、Sacty の投稿と見分け、状態を読む", () => {
    expect(isSactyRemarkReply(old("**対応しました。**"))).toBe(true);
    expect(remarkReplyTaskOf(old("**対応しました。**"))).toBe("t1");
    expect(readRemarkReply(old("**対応しました。**")).status).toBe("addressed");
    expect(readRemarkReply(old("**対応していません。** 理由：")).status).toBe("declined");
    expect(
      readRemarkReply(
        old(
          "**この PR では直さず、後続に回したいという案です（人に確認中で、まだ決まっていません）。** 理由：",
        ),
      ).status,
    ).toBe("deferred");
  });

  it("見出しが今までの知らせも、目印で見分ける", () => {
    expect(
      isHumanAskNotice(
        "<!-- sacty-human-ask:t1:implement:1 -->\n## Sacty：人に確かめてほしいことがあります",
      ),
    ).toBe(true);
    expect(
      isReworkNotice("<!-- sacty-rework-notice:t1:1 -->\n## Sacty：指摘を設計に戻しました"),
    ).toBe(true);
    expect(
      isReviewStopNotice("<!-- sacty-review-stopped:t1:k -->\n## Sacty のレビューが止まりました"),
    ).toBe(true);
    expect(
      isDeferralNotice(
        "<!-- sacty-deferral:t1:1 -->\n## Sacty：後続に回したい案を、人が決めました",
      ),
    ).toBe(true);
  });
});
