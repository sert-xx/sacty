import type { ActivityEvent } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/audit", () => ({ TaskAuditCard: () => null }));
const { EventText } = await import("./task-detail");

const long = "あ".repeat(1500);
const base = {
  seq: 1,
  id: "e1",
  taskId: "t1",
  projectId: "default",
  at: "2026-11-20T00:00:00.000Z",
};
const stepsChosen = (reason: string) =>
  ({
    ...base,
    type: "StepsChosen",
    actor: "orchestrator",
    payload: {
      steps: ["design", "implement"],
      fallback: false,
      costUsd: 0,
      estimated: false,
      reason,
      image: "node26-playwright",
      imageSource: "orchestrator",
      imageReason: reason,
    },
  }) as ActivityEvent;
const changesRequested = {
  ...base,
  type: "ChangesRequested",
  actor: "person",
  payload: { remarks: [{ id: "R1", text: "直してください", source: "person" }] },
} as unknown as ActivityEvent;

const render = (event: ActivityEvent, clamp?: boolean) =>
  renderToStaticMarkup(createElement(EventText, { event, clamp }));

describe("作業履歴の行（EventText。PBI-431）", () => {
  for (const language of ["ja", "en"] as const) {
    it(`${language}：作業履歴のタブでは、行は名前だけで、千字を超える理由は <details> の中に見出し付きで入る`, () => {
      locale = language;
      const more = messagesFor(language).labels.event.more;
      const html = render(stepsChosen(long));
      const summary = html.match(/<summary[^>]*>(.*?)<\/summary>/)?.[1] ?? "";
      expect(summary).toContain("node26-playwright");
      expect(summary).toContain(more);
      expect(summary).not.toContain(long);
      expect(summary.length).toBeLessThan(400);
      // キーボードで止まる summary（tabindex を外していない）。開閉は <details> の標準の動き
      expect(html).toMatch(/<details/);
      expect(html).not.toContain("tabindex");
      const detail = html.split("</summary>")[1] ?? "";
      expect(detail).toContain(long);
      expect(detail).toContain("whitespace-pre-line");
    });

    it(`${language}：理由が無い記録は、詳細（<details>）を出さない`, () => {
      locale = language;
      const html = render(stepsChosen(""));
      expect(html).not.toContain("<details");
      expect(html).not.toContain(messagesFor(language).labels.event.more);
      expect(html).toContain("node26-playwright");
    });

    it(`${language}：右の列（clamp）は、どの種類の行も 2 行までで省略し、詳細を出さない`, () => {
      locale = language;
      for (const event of [stepsChosen(long), changesRequested]) {
        const html = render(event, true);
        expect(html).toContain("line-clamp-2");
        expect(html).not.toContain("<details");
        expect(html).not.toContain(messagesFor(language).labels.event.more);
        expect(html).not.toContain(long);
      }
    });
  }
});
