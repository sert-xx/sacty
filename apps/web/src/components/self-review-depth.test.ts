import type { ActivityEvent, Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";
import { describeEvent } from "@/lib/labels";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({ changeSelfReviewDepthAction: async () => ({}) }));

const { SelfReviewDepthNote } = await import("./self-review-depth");

const render = (task: Partial<Task>) =>
  renderToStaticMarkup(
    createElement(SelfReviewDepthNote, {
      task: { id: "t-1", status: "awaiting_approval", ...task } as unknown as Task,
    }),
  );

describe("セルフレビューの深さの表示（PBI-369）", () => {
  it("軽いと判定されたタスクは、判定と理由を出し、「通常の深さで」と上書きできる", () => {
    locale = "ja";
    const html = render({ selfReviewDepth: { judged: "light", reason: "README に節を足すだけ" } });
    expect(html).toContain('data-depth="light"');
    expect(html).toContain("セルフレビューの深さ：軽い。観点を絞ります");
    expect(html).toContain("判定の理由：README に節を足すだけ");
    expect(html).toContain("通常の深さで");
    // 上書きの値は、通常の深さ
    expect(html).toContain('name="depth" value="normal"');
    expect(html).toContain("セルフレビューをする工程の次の実行から使います");
    locale = "en";
    const en = render({ selfReviewDepth: { judged: "light", reason: "adds one section" } });
    expect(en).toContain("Self-review depth: light. Fewer viewpoints are used.");
    expect(en).toContain("Why: adds one section");
    expect(en).toContain("Use the normal depth");
  });

  it("人が上書きしたタスクは、通常の深さと、元の判定と理由を出し、判定に戻せる", () => {
    locale = "ja";
    const html = render({
      selfReviewDepth: { judged: "light", reason: "README に節を足すだけ" },
      selfReviewDepthOverride: { depth: "normal", at: "2026-11-17T00:00:00.000Z" },
    });
    expect(html).toContain('data-depth="normal"');
    expect(html).toContain('data-judged="light"');
    expect(html).toContain("セルフレビューの深さ：通常（人が指定）");
    expect(html).toContain(
      "オーケストレーターの判定は「軽い」です。判定の理由：README に節を足すだけ",
    );
    expect(html).toContain("判定（軽い）に戻す");
    expect(html).toContain('name="depth" value="light"');
  });

  it("通常と判定されたタスクは、判定と理由だけを出す（人が軽くする操作は出さない）。sacty が通常にした理由は、画面の言語で出す", () => {
    locale = "ja";
    const html = render({ selfReviewDepth: { judged: "normal", reason: "振る舞いを変える" } });
    expect(html).toContain("セルフレビューの深さ：通常");
    expect(html).toContain("判定の理由：振る舞いを変える");
    expect(html).not.toContain("<form");
    const forced = {
      selfReviewDepth: {
        judged: "normal" as const,
        reason: { code: "selfReview.depthForcedNormal", params: { reason: "数行" } },
      },
    };
    expect(render(forced)).toContain("依頼が軽いと判定しません");
    locale = "en";
    expect(render(forced)).toContain("is never judged light");
  });

  it("判定の無いタスクには何も出さない。中止したタスクには、操作を出さない", () => {
    locale = "ja";
    expect(render({})).toBe("");
    const cancelled = render({
      status: "cancelled",
      selfReviewDepth: { judged: "light", reason: "節を足すだけ" },
    });
    expect(cancelled).toContain("セルフレビューの深さ：軽い");
    expect(cancelled).not.toContain("<form");
  });

  it("作業履歴に、人が深さを変えたことを出す", () => {
    const event = (to: "light" | "normal") =>
      ({
        type: "SelfReviewDepthChanged",
        payload: { from: to === "normal" ? "light" : "normal", to },
        actor: "person",
      }) as unknown as ActivityEvent;
    const ja = messagesFor("ja").labels;
    const en = messagesFor("en").labels;
    expect(describeEvent(event("normal"), ja)).toContain("セルフレビューを通常の深さに変更");
    expect(describeEvent(event("light"), ja)).toContain("オーケストレーターの判定（軽い）に戻した");
    expect(describeEvent(event("normal"), en)).toContain("Self-review set to the normal depth");
    expect(describeEvent(event("light"), en)).toContain("judgement, light");
  });
});
