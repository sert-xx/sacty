import type { TaskRemark } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
vi.mock("@/app/actions", () => ({ voidRemarkAction: () => {} }));
vi.mock("next/link", () => ({
  default: ({ children }: { children: unknown }) => children,
}));

const { RemarkItem } = await import("./review");

const render = (remark: Partial<TaskRemark>, lang: "ja" | "en" = "ja", mixedRound = false) =>
  renderToStaticMarkup(
    createElement(RemarkItem, {
      remark: {
        id: "implement-2-1",
        step: "implement",
        round: 2,
        text: "戻り値の確認が無い",
        voided: false,
        ...remark,
      },
      taskId: "t1",
      submission: 3,
      current: true,
      mixedRound,
      t: messagesFor(lang).review.remark,
    }),
  );

describe("承認の画面の指摘（PBI-275）", () => {
  it("sacty 自身の AI のレビューの指摘は、人の指摘と見分けて出し、差し戻しの回数に数えないことを添える", () => {
    const ai = render({ source: "sacty_review" });
    expect(ai).toContain("AI のレビュー");
    expect(ai).toContain("2回目（差し戻しの回数に数えない）");
    expect(ai).not.toContain("2回目の差し戻し");
    const human = render({});
    expect(human).toContain("指摘");
    expect(human).toContain("2回目の差し戻し");
    expect(human).not.toContain("AI のレビュー");
    expect(render({ source: "sacty_review" }, "en")).toContain("AI review");
  });

  it("人の指摘と混ざる回では、AI の指摘にも「数えない」と出さず、通常の回の表示にする（その回は上限に数える）", () => {
    const mixed = render({ source: "sacty_review" }, "ja", true);
    expect(mixed).toContain("AI のレビュー");
    expect(mixed).toContain("2回目の差し戻し");
    expect(mixed).not.toContain("数えない");
    expect(render({ source: "sacty_review" }, "en", true)).not.toContain("not counted");
  });
});
