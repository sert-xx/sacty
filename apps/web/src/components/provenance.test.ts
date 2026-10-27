import type { Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));

const { ProvenanceNote } = await import("./provenance");

const render = (provenances: Task["provenances"]) =>
  renderToStaticMarkup(
    createElement(ProvenanceNote, {
      task: { provenances } as unknown as Task,
      step: "requirements",
    }),
  );

describe("項目ごとの出典の分類の表示", () => {
  it("確かめる項目（推論・原文の見つからない引用・分類なし）を開いたまま挙げ、引用・導出は折りたたむ", () => {
    locale = "ja";
    const html = render({
      requirements: {
        sequential: false,
        items: [
          { id: "R-1", kind: "input", refs: [], excerpt: "支払える", found: true },
          { id: "R-2", kind: "input", refs: [], excerpt: "無い文", found: false },
          { id: "R-3", kind: "inference", refs: ["src/pay.ts:10"], excerpt: "" },
        ],
        unclassified: ["R-4"],
      },
    });
    expect(html).toContain('data-result="check"');
    expect(html).toContain("確かめる項目：3件");
    expect(html).toContain("（引用 2・導出 0・推論 1）");
    expect(html).toContain("引用の原文が入力に見つからない");
    expect(html).toContain("（根拠：src/pay.ts:10）");
    expect(html).toContain("分類なし");
    expect(html).toContain("そのほか（引用・導出）");
    expect(html).toContain(" open=");
  });

  it("確かめる項目が無ければ閉じ、書いた本人が分類したときは、すべてを確かめるよう出す", () => {
    locale = "en";
    const clear = render({
      requirements: {
        sequential: false,
        items: [{ id: "R-1", kind: "derived", refs: ["R-0"], excerpt: "" }],
        unclassified: [],
      },
    });
    expect(clear).toContain('data-result="clear"');
    expect(clear).toContain("Items to check: 0");
    expect(clear).not.toContain(" open=");
    const sequential = render({
      requirements: {
        sequential: true,
        items: [{ id: "R-1", kind: "derived", refs: [], excerpt: "" }],
        unclassified: [],
      },
    });
    expect(sequential).toContain("Items to check: 1");
    expect(sequential).toContain(messagesFor("en").task.provenance.sequential);
  });

  it("記録が無ければ「記録がありません」を目立たせ、分類より前の工程では何も出さない", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const html = render({ requirements: null });
      expect(html, lang).toContain('data-result="missing"');
      expect(html, lang).toContain(messagesFor(lang).task.provenance.missing);
      expect(render({}), lang).toBe("");
      expect(render(undefined), lang).toBe("");
    }
  });
});
