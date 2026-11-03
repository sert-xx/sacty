import { describe, expect, it } from "vitest";
import { isHumanAskNotice } from "./github.js";
import { ASK_TEXT_MAX, askQuote, buildHumanAskNotice, humanAskMarker } from "./human-ask-notice.js";

const TASK = "52359c0c-6e66-4842-a4ae-65e73d30a117";
const URL = "http://127.0.0.1:4700/tasks/52359c0c-6e66-4842-a4ae-65e73d30a117";
const base = {
  taskId: TASK,
  step: "implement" as const,
  stepName: "実装",
  submission: 2,
  taskUrl: URL,
  secrets: [] as string[],
};

describe("人に確かめてほしいことの PR のコメント（PBI-301）", () => {
  it("ゴールガーディアンが判断できなかった理由と、作り直しの実行が確かめたいことを、目印・タスクの画面へのリンクつきで書く", () => {
    const body = buildHumanAskNotice({
      ...base,
      undecided: {
        remarkIds: ["implement-1-1"],
        reason: "「前と言ってること」が何を指すか読み取れない",
      },
      confirms: [{ remarkId: "implement-1-1", text: "上限の値は 31 日と推測しました" }],
    });
    expect(body?.startsWith(humanAskMarker(TASK, "implement", 2))).toBe(true);
    expect(body).toContain("人に確かめてほしいことがあります");
    expect(body).toContain(
      "指摘（implement-1-1）の意図を、ゴールガーディアンが判断できませんでした",
    );
    expect(body).toContain("> 「前と言ってること」が何を指すか読み取れない");
    expect(body).toContain("作り直しの実行が確かめたいこと（指摘 implement-1-1）");
    expect(body).toContain("> 上限の値は 31 日と推測しました");
    expect(body).toContain(`](${URL})`);
    expect(isHumanAskNotice(body)).toBe(true);
  });

  it("確かめることが無ければ書かない（判断できなかった理由も、確かめたいことも無い）", () => {
    expect(buildHumanAskNotice({ ...base, confirms: [] })).toBeUndefined();
  });

  it("確かめたいことが複数あれば、すべて、指摘の ID ごとに書く。判断できなかった理由が無くても書ける", () => {
    const body = buildHumanAskNotice({
      ...base,
      confirms: [
        { remarkId: "implement-1-1", text: "一つ目" },
        { remarkId: "implement-1-2", text: "二つ目" },
      ],
    });
    expect(body).toContain("指摘 implement-1-1");
    expect(body).toContain("> 二つ目");
    expect(body).not.toContain("ゴールガーディアンが判断できませんでした");
  });

  it("目印は、タスク・工程・提出回ごとに別（同じ提出に二度書かず、別の提出には書ける。前方一致もしない）", () => {
    expect(humanAskMarker(TASK, "implement", 2)).not.toBe(humanAskMarker(TASK, "implement", 3));
    expect(humanAskMarker(TASK, "implement", 2)).not.toBe(humanAskMarker(TASK, "design", 2));
    expect(humanAskMarker(TASK, "implement", 2)).not.toContain(
      humanAskMarker(TASK, "implement", 20).slice(0, -4),
    );
  });

  it("外から来た文は、秘密情報を伏せてから切り詰める（切り口にかかった秘密情報の前半を残さない）", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const text = `${"あ".repeat(ASK_TEXT_MAX - 10)}${secret}`;
    const quoted = askQuote(text, [secret]);
    expect(quoted).not.toContain("ghp_");
    expect(quoted).toContain("[REDACTED]");
    expect(quoted.length).toBeLessThanOrEqual(ASK_TEXT_MAX + 4);
    // 長ければ切って「…」を付ける
    expect(askQuote("い".repeat(ASK_TEXT_MAX + 50), [])).toBe(`> ${"い".repeat(ASK_TEXT_MAX)}…`);
  });

  it("@名前で知らない人に通知が飛ばないようにし、行ごとに引用にする（見出し・リンクとして解釈させない）", () => {
    const quoted = askQuote("@alice に聞く\n# 見出し\n[x](http://evil.example)", []);
    expect(quoted).not.toContain("@alice");
    expect(quoted.split("\n")).toEqual([
      "> @​alice に聞く",
      "> # 見出し",
      "> [x](http://evil.example)",
    ]);
  });
});
