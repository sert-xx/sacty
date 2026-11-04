// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { type FC, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/client";
import { AiReviewNotice } from "./ai-review-notice";

/*
 * 承認の画面に、今の head に sacty の AI のレビューが付いているか（付いていない・レビュー中・付いた）を出す（PBI-302 D1）。
 */

const render = (aiReview: Task["aiReview"], locale: "ja" | "en" = "ja") =>
  renderToStaticMarkup(
    h(
      I18nProvider as unknown as FC<{ locale: "ja" | "en" }>,
      { locale },
      h(AiReviewNotice, {
        task: { id: "t1", ...(aiReview ? { aiReview } : {}) } as unknown as Task,
      }),
    ),
  );

describe("AiReviewNotice", () => {
  it("付いていない・レビュー中・付いたを、head の短い表記つきで出す", () => {
    const head = "7ed51c5aaaaaaaa";
    expect(render({ head, status: "none" })).toContain(
      "今の head（7ed51c5）には、sacty の AI のレビューがまだ付いていません。",
    );
    expect(render({ head, status: "reviewing" })).toContain(
      "今の head（7ed51c5）を、sacty の AI のレビューがレビュー中です。",
    );
    const attached = render({
      head,
      status: "attached",
      url: "https://github.com/acme/app/pull/2#r1",
    });
    expect(attached).toContain("今の head（7ed51c5）に、sacty の AI のレビューが付いています。");
    expect(attached).toContain('href="https://github.com/acme/app/pull/2#r1"');
    expect(render({ head, status: "none" }, "en")).toContain(
      "No Sacty AI review is attached to the current head (7ed51c5) yet.",
    );
  });

  it("承認やマージを止めないことを添える。付いたときは、注意書きを出さない", () => {
    expect(render({ head: "abc1234", status: "none" })).toContain("承認やマージは止めませんが");
    expect(render({ head: "abc1234", status: "attached" })).not.toContain(
      "承認やマージは止めませんが",
    );
    expect(render({ head: "abc1234", status: "attached" })).not.toContain("<a ");
  });

  it("状況が無ければ（承認待ちでない・PR が開いていない）何も出さない。https 以外のリンクは出さない", () => {
    expect(render(undefined)).toBe("");
    expect(
      render({ head: "abc1234", status: "attached", url: "javascript:alert(1)" }),
    ).not.toContain("<a ");
  });
});
