import { describe, expect, it } from "vitest";
import { buildDecisionNotice } from "./decision-notice.js";
import { buildStopNotice } from "./review-stop-notice.js";
import { buildReworkNotice } from "./rework-notice.js";
import { TASK_LINK_NOTE, taskLink } from "./task-link.js";

// 画面へのリンクの注釈（PBI-450）と、PR のコメントから画面の URL を外したこと（PBI-471）

const ID = "52359c0c-6e66-4842-a4ae-65e73d30a117";

/** 目印の行を除いた本文。 */
const visible = (body: string) => body.split("\n").slice(1).join("\n");

describe("タスクの画面へのリンク", () => {
  it.each(["http://127.0.0.1:4700", "http://localhost:4700", "http://[::1]:4700"])(
    "ループバックのホスト（%s）では、画面でだけ開けるリンクとして読む",
    (url) => {
      expect(taskLink(url, ID)).toEqual({ url: `${url}/tasks/${ID}`, localOnly: true });
    },
  );

  it("ループバックでないホストは注釈が要らず、URL として読めない文字列は注意を残す側に倒す", () => {
    expect(taskLink("https://sacty.example.com", ID).localOnly).toBe(false);
    expect(taskLink("not a url", ID).localOnly).toBe(true);
    expect(TASK_LINK_NOTE).toBe("タスクの画面は、依頼した人のマシンでだけ開けます。");
  });
});

describe("設計に戻した・レビューが止まった・人の判断を待つコメントは、画面の URL と内部の語を出さず、画面の案内を文で書く（TV-17）", () => {
  const notices: Record<string, { body: string; guide: string }> = {
    rework: {
      body: buildReworkNotice({
        taskId: ID,
        round: 1,
        reason: "理由",
        stepName: "設計",
        secrets: [],
      }),
      guide: "意図と違うときは、Sacty の画面で差し戻してください。",
    },
    reviewStop: {
      body: buildStopNotice({ taskId: ID, reason: "error", summary: "" }),
      guide: "Sacty の画面で、このタスクを再開してください。",
    },
    decision: {
      body: buildDecisionNotice({
        taskId: ID,
        round: 1,
        findings: [{ finding: "指摘", reason: "根拠" }],
        secrets: [],
      }),
      guide: "補足を付けて再開するときは、Sacty の画面で再開してください。",
    },
  };

  for (const [name, { body, guide }] of Object.entries(notices)) {
    it(`${name}：目印の外に URL・タスクの ID・「工程」・注釈が無く、「Sacty の画面で」の文がある`, () => {
      const text = visible(body);
      expect(text).not.toContain("http://");
      expect(text).not.toContain(ID);
      expect(text).not.toContain("工程");
      expect(text).not.toContain(TASK_LINK_NOTE);
      expect(text).toContain(guide);
    });
  }

  it("設計に戻した知らせの製品名は「Sacty」に揃う", () => {
    expect(notices.rework?.body).toContain("- Sacty が作る設計の PR");
    expect(notices.rework?.body).not.toMatch(/sacty が/);
  });
});
