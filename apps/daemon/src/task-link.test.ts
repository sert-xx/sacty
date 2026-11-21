import { describe, expect, it } from "vitest";
import { buildDeferralNotice } from "./deferral-notice.js";
import { buildHumanAskNotice } from "./human-ask-notice.js";
import { buildStopNotice } from "./review-stop-notice.js";
import { buildReworkNotice } from "./rework-notice.js";
import { TASK_LINK_NOTE, taskLink } from "./task-link.js";

// PR に投稿する知らせの、タスクの画面へのリンクの注釈（PBI-450）

const ID = "t-1";

/** 知らせ 4 種を、画面の URL から組み立てる。 */
function notices(webUrl: string): Record<string, string> {
  const link = taskLink(webUrl, ID);
  const common = { taskUrl: link.url, localOnly: link.localOnly, secrets: [] as string[] };
  return {
    humanAsk:
      buildHumanAskNotice({
        taskId: ID,
        step: "implement",
        stepName: "実装",
        submission: 1,
        confirms: [{ remarkIds: ["r1"], text: "確かめたいこと" }],
        ...common,
      }) ?? "",
    rework: buildReworkNotice({
      taskId: ID,
      round: 1,
      reason: "理由",
      stepName: "設計",
      ...common,
    }),
    reviewStop: buildStopNotice({
      taskId: ID,
      reason: "error",
      summary: "",
      taskUrl: link.url,
      localOnly: link.localOnly,
    }),
    deferral:
      buildDeferralNotice({
        taskId: ID,
        decision: 1,
        items: [{ remarkId: "r1", decision: "fix" }],
        ...common,
      }) ?? "",
  };
}

/** `[タスクの画面](…)` を含む文（行）。 */
function linkSentence(body: string): string {
  return body.split("\n").find((line) => line.includes("[タスクの画面](")) ?? "";
}

describe("タスクの画面へのリンクの注釈（PBI-450）", () => {
  it.each(["http://127.0.0.1:4700", "http://localhost:4700", "http://[::1]:4700"])(
    "ループバックのホスト（%s）では、知らせ 4 種のリンクの文の直後に注釈が付く（TV-1）",
    (url) => {
      expect(taskLink(url, ID)).toEqual({ url: `${url}/tasks/${ID}`, localOnly: true });
      for (const [name, body] of Object.entries(notices(url))) {
        const sentence = linkSentence(body);
        expect(sentence, name).toContain(`${url}/tasks/${ID}`);
        expect(sentence.endsWith(TASK_LINK_NOTE), name).toBe(true);
        expect(TASK_LINK_NOTE).toBe("タスクの画面は、依頼した人のマシンでだけ開けます。");
        // リンクの文の終わり（。）の直後に注釈が続く
        expect(sentence, name).toMatch(/。タスクの画面は、依頼した人のマシンでだけ開けます。$/);
      }
    },
  );

  it("ループバックでないホストでは注釈を付けず、URL として読めない文字列では付ける（TV-2）", () => {
    expect(taskLink("https://sacty.example.com", ID).localOnly).toBe(false);
    for (const [name, body] of Object.entries(notices("https://sacty.example.com"))) {
      expect(linkSentence(body), name).toContain("https://sacty.example.com/tasks/t-1");
      expect(body, name).not.toContain(TASK_LINK_NOTE);
    }
    expect(taskLink("not a url", ID).localOnly).toBe(true);
    for (const [name, body] of Object.entries(notices("not a url"))) {
      expect(body, name).toContain(TASK_LINK_NOTE);
    }
  });

  it("設計に戻した知らせの製品名は「Sacty」に揃う（TV-13）", () => {
    expect(notices("http://127.0.0.1:4700").rework).toContain("- Sacty が作る設計の PR");
    expect(notices("http://127.0.0.1:4700").rework).not.toMatch(/sacty が/);
  });
});
