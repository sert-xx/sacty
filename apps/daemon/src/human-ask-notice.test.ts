import { describe, expect, it } from "vitest";
import { isHumanAskNotice } from "./github.js";
import { ASK_TEXT_MAX, askQuote, buildHumanAskNotice, humanAskMarker } from "./human-ask-notice.js";

const TASK = "52359c0c-6e66-4842-a4ae-65e73d30a117";
const PR = "https://github.com/acme/app/pull/7";
const base = {
  taskId: TASK,
  step: "implement" as const,
  stepName: "実装",
  submission: 2,
  secrets: [] as string[],
};
const link = { url: `${PR}#issuecomment-401` };
const reviewLink = { url: `${PR}#pullrequestreview-601` };
const screen = { line: "エラーの文言を直す" };

/** 目印の行を除いた本文。 */
const visible = (body: string | undefined) => (body ?? "").split("\n").slice(1).join("\n");

describe("人に確かめてほしいことの PR のコメント（PBI-301・PBI-471）", () => {
  it("指摘を元のコメントへのリンクか要点で示し、画面の案内を文で書く。画面の URL・タスクの ID・指摘の ID・内部の語を出さない（TV-16）", () => {
    const body = buildHumanAskNotice({
      ...base,
      undecided: {
        remarks: [link],
        reason: "「前と言ってること」が何を指すか読み取れない",
      },
      confirms: [{ remarks: [screen], text: "上限の値は 31 日と推測しました" }],
    });
    expect(body?.startsWith(humanAskMarker(TASK, "implement", 2))).toBe(true);
    expect(body).toContain("人に確かめてほしいことがあります");
    expect(body).toContain(`**[この指摘](${link.url})の意図を読み取れませんでした。**`);
    expect(body).toContain("> 「前と言ってること」が何を指すか読み取れない");
    expect(body).toContain("確かめたいこと（「エラーの文言を直す」）");
    expect(body).toContain("> 上限の値は 31 日と推測しました");
    expect(body).toContain("Sacty の画面で差し戻してください。");
    const text = visible(body);
    for (const word of [
      "http://127.0.0.1",
      TASK,
      "implement-1-1",
      "戻し先の判断",
      "作り直しの実行",
      "タスクの画面は",
    ]) {
      expect(text).not.toContain(word);
    }
    expect(isHumanAskNotice(body)).toBe(true);
  });

  it("作業領域の内部のパス（/sacty-input/task.md:77 など）は、人が辿れる呼び方に置き換えて書く", () => {
    const body = buildHumanAskNotice({
      ...base,
      undecided: {
        remarks: [link],
        reason: "/sacty-input/task.md:77 の記述が読めない",
      },
      confirms: [{ remarks: [link], text: "/sacty-input/task.md:12 のとおりに直しました" }],
    });
    expect(body).not.toContain("/sacty-input");
    expect(body).not.toContain("task.md:");
    expect(body).toContain("タスクの依頼");
    // リポジトリのパスは変えない
    expect(askQuote("src/pay.ts:12 を直した", [])).toBe("> src/pay.ts:12 を直した");
  });

  it("確かめることが無ければ書かない（判断できなかった理由も、確かめたいことも無い）", () => {
    expect(buildHumanAskNotice({ ...base, confirms: [] })).toBeUndefined();
  });

  it("確かめたいことが複数あれば、すべて、指摘のリンクか要点ごとに書く。判断できなかった理由が無くても書ける", () => {
    const body = buildHumanAskNotice({
      ...base,
      confirms: [
        { remarks: [link], text: "一つ目" },
        { remarks: [reviewLink], text: "二つ目" },
      ],
    });
    expect(body).toContain(`確かめたいこと（[この指摘](${link.url})）`);
    expect(body).toContain(`確かめたいこと（[この指摘](${reviewLink.url})）`);
    expect(body).toContain("> 二つ目");
  });

  it("複数の指摘に付いていた同じ確認は、1 回だけ書き、付いていた指摘を並べる（PBI-354）", () => {
    const body = buildHumanAskNotice({
      ...base,
      confirms: [{ remarks: [link, screen], text: "CI を再実行して確認してください" }],
    });
    expect(body).toContain(`確かめたいこと（[この指摘](${link.url})・「エラーの文言を直す」）`);
    expect(body?.split("> CI を再実行して確認してください").length).toBe(2);
    expect(body?.split("確かめたいこと（").length).toBe(2);
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

describe("人への確認のコメントの文に、指摘の ID が書かれていても出さない（PBI-471）", () => {
  it("確かめたいことの文・判断の理由から、ID を除く", () => {
    const body = buildHumanAskNotice({
      ...base,
      undecided: { remarks: [link], reason: "implement-1-2 の意図が読み取れない" },
      confirms: [
        { remarks: [screen], text: "（implement-1-1 への対応）上限は 31 日と推測しました" },
      ],
    });
    expect(body).not.toMatch(/implement-1-\d/);
    expect(body).toContain("上限は 31 日と推測しました");
  });
});
