import type { Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));

const { SelfReviewNote } = await import("./self-review");

const render = (selfReviews: Task["selfReviews"]) =>
  renderToStaticMarkup(
    createElement(SelfReviewNote, {
      task: { selfReviews } as unknown as Task,
      step: "requirements",
    }),
  );

describe("提出の前のセルフレビューの表示（PBI-120）", () => {
  it("パスしたら回数を出し、総評は折りたたむ", () => {
    locale = "ja";
    const html = render({
      requirements: { rounds: 2, passed: true, remaining: [], notReviewed: [], summary: "直した" },
    });
    expect(html).toContain('data-result="passed"');
    expect(html).toContain("セルフレビュー：パス・2回");
    expect(html).toContain("直した");
    expect(html).not.toContain(" open=");
  });

  it("パスしていなければ、残った指摘と見られなかった観点を開いたまま目立たせる", () => {
    locale = "ja";
    const html = render({
      requirements: {
        rounds: 5,
        passed: false,
        remaining: ["異常系が無い"],
        notReviewed: ["C-7"],
        summary: "",
      },
    });
    expect(html).toContain('data-result="failed"');
    expect(html).toContain("セルフレビュー：パスしていません・5回・残った指摘 1件");
    expect(html).toContain("異常系が無い");
    expect(html).toContain("C-7");
    expect(html).toContain(" open=");
    expect(html).toContain("text-warn");
  });

  it("報告が無ければ「記録がありません」を目立たせ、セルフレビューより前の工程では何も出さない", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const html = render({ requirements: null });
      expect(html, lang).toContain('data-result="missing"');
      expect(html, lang).toContain(messagesFor(lang).task.selfReview.missing);
      expect(render({}), lang).toBe("");
      expect(render(undefined), lang).toBe("");
    }
    locale = "ja";
  });
});
