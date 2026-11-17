import { describe, expect, it } from "vitest";
import { buildDeferralNotice, deferralNoticeMarker } from "./deferral-notice.js";
import { isDeferralNotice } from "./github.js";
import { ASK_TEXT_MAX } from "./human-ask-notice.js";

describe("後続に回したい案への、人の決定を PR に残すコメント（PBI-370）", () => {
  const base = {
    taskId: "t1",
    decision: 2,
    taskUrl: "http://127.0.0.1:4700/tasks/t1",
    secrets: [] as string[],
  };
  const defer = {
    remarkId: "implement-1-1",
    decision: "defer" as const,
    quoted: {
      text: "稀な条件で、通知が二重に出る",
      reason: "直すには、新しい保存の仕組みが要る",
      url: "https://github.com/acme/app/pull/7#pullrequestreview-601",
    },
  };
  /** sacty の画面から書いた指摘（元のコメントが無い）。 */
  const fix = { remarkId: "implement-1-2", decision: "fix" as const };

  it("先頭に目印を置き、決定ごとに、指摘と理由を引用で並べ、元のコメントへのリンクを付ける。sacty の画面から書いた指摘は、ID と決定だけを載せる（画面で書いた文を、PR に載せない）", () => {
    const body = buildDeferralNotice({ ...base, items: [defer, fix] }) ?? "";
    expect(body.split("\n")).toEqual([
      "<!-- sacty-deferral:t1:2 -->",
      "## Sacty：後続に回したい案を、人が決めました",
      "",
      "実装が「この PR では直さず、後続に回したい」とした指摘について、このタスクを承認する人が、次のとおり決めました。",
      "",
      "### 後続に回す（1 件）",
      "",
      "**指摘 implement-1-1**（[元のコメント](https://github.com/acme/app/pull/7#pullrequestreview-601)）",
      "",
      "> 稀な条件で、通知が二重に出る",
      "",
      "実装が、後続に回したいとした理由：",
      "",
      "> 直すには、新しい保存の仕組みが要る",
      "",
      "### この PR で直す（1 件）",
      "",
      "**指摘 implement-1-2**（Sacty の画面から書かれた指摘。内容は、タスクの画面で読めます）",
      "",
      "---",
      "この PR で直すと決めた指摘は、実装をやり直して直します。後続に回すと決めた指摘は、この PR では直しません。決定は、[タスクの画面](http://127.0.0.1:4700/tasks/t1)で行われました。",
    ]);
    expect(isDeferralNotice(body)).toBe(true);
    expect(body.startsWith(deferralNoticeMarker("t1", 2))).toBe(true);
  });

  it("後続に回す決定だけなら、この PR で直す節と、やり直しの案内は出さない。決定が無ければ、本文を作らない", () => {
    const body = buildDeferralNotice({ ...base, items: [defer] }) ?? "";
    expect(body).toContain("### 後続に回す（1 件）");
    expect(body).not.toContain("### この PR で直す");
    expect(body).not.toContain("実装をやり直して直します");
    expect(buildDeferralNotice({ ...base, items: [] })).toBeUndefined();
  });

  it("「この PR で直す」の差し戻しが、上限でエスカレーションになったときは、まだ差し戻していないことを書く", () => {
    const body = buildDeferralNotice({ ...base, escalated: true, items: [fix] }) ?? "";
    expect(body).toContain(
      "差し戻しが上限に達しているため、まだ差し戻していません（タスクの画面で、上限を超えて差し戻すかを決めます）。",
    );
    expect(body).not.toContain("実装をやり直して直します");
    // 後続に回す決定だけなら、エスカレーションでも、差し戻しの案内は出さない
    expect(buildDeferralNotice({ ...base, escalated: true, items: [defer] })).not.toContain(
      "差し戻しが上限",
    );
  });

  it("指摘の文と理由は、秘密情報を伏せてから切り詰める（切り口をまたぐ秘密の値の前半を残さない）。@名前で通知を飛ばさず、複数行も引用のままにする", () => {
    const secret = "sk-secret-0123456789abcdef";
    // 秘密の値が、切り詰めの境界をまたぐ位置にある
    const text = `${"あ".repeat(ASK_TEXT_MAX - 5)}${secret} 続き`;
    const body =
      buildDeferralNotice({
        ...base,
        secrets: [secret],
        items: [
          {
            ...defer,
            quoted: {
              ...defer.quoted,
              text,
              reason: `@alice に確認\n2 行目 ${secret}\n# 見出しのような行`,
            },
          },
        ],
      }) ?? "";
    expect(body).not.toContain(secret);
    expect(body).not.toContain(secret.slice(0, 5));
    expect(body).not.toContain("@alice");
    expect(body).toContain("> @​alice に確認");
    expect(body).toContain("> # 見出しのような行");
    // 切り詰めた印
    expect(body).toContain("…");
  });

  it("目印で始まらない本文・引用の中の目印は、決定のコメントと見なさない", () => {
    expect(isDeferralNotice("> <!-- sacty-deferral:t1:1 -->")).toBe(false);
    expect(isDeferralNotice("前置き <!-- sacty-deferral:t1:1 -->")).toBe(false);
    expect(isDeferralNotice(undefined)).toBe(false);
    expect(isDeferralNotice("  <!-- sacty-deferral:t1:1 -->\n本文")).toBe(true);
  });
});
