import type { ActivityEvent, Task } from "@sacty/core";
// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import { formatStamp } from "@/lib/labels";

let locale: "ja" | "en" = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/app/actions", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh() {} }) }));
vi.mock("@/components/audit", () => ({ TaskAuditCard: () => null }));
vi.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: string }) => createElement("div", null, children),
}));
const { EventText } = await import("./task-detail");
const { Proposals } = await import("./proposals");
const at = "2026-11-22T12:00:00Z";
const old = { id: "TV-2", title: "Old title", input: "Old input", expected: "Old expected" };
const updated = { id: "TV-2", title: "New title", input: "New input", expected: "New expected" };
const added = {
  id: "TV-3",
  title: "Third title",
  input: "Third input",
  expected: "Third expected",
};
const diff = {
  design: "-- 旧い項目\n+- 新しい項目",
  testViewpoints: `-${JSON.stringify(old)}\n+${JSON.stringify(updated)}\n+${JSON.stringify(added)}`,
};
function renderBoth(value = diff) {
  const event = {
    id: "e1",
    seq: 1,
    taskId: "t1",
    projectId: "default",
    actor: "sacty",
    at,
    type: "ChangeAcceptedByNote",
    payload: { proposalId: "CP-1", resumedAt: at, diff: value },
  } as ActivityEvent;
  const task = {
    id: "t1",
    status: "idle",
    proposals: [
      {
        id: "CP-1",
        fromStep: "implement",
        target: "requirements",
        reason: "reason",
        facts: [],
        proposed: "proposal",
        proposedAt: at,
        applied: true,
        byNote: { resumedAt: at, at, diff: value },
      },
    ],
  } as unknown as Task;
  return [
    renderToStaticMarkup(createElement(EventText, { event })),
    renderToStaticMarkup(createElement(Proposals, { task })),
  ];
}
describe("補足の差分表示", () => {
  it.each(["ja", "en"] as const)(
    "%s の履歴と申し出に地域の日時と観点のカードを表示する",
    (lang) => {
      locale = lang;
      const [history, proposals] = renderBoth();
      const historyDoc = new DOMParser().parseFromString(history, "text/html");
      const proposalsDoc = new DOMParser().parseFromString(proposals, "text/html");
      const stamp = formatStamp(at, lang);
      expect(historyDoc.querySelector("summary")?.textContent).toContain(stamp);
      const accepted = [...proposalsDoc.querySelectorAll("p")].find((p) =>
        p.textContent?.includes(lang === "ja" ? "補足で受け入れた" : "Accepted by note"),
      );
      expect(accepted?.textContent).toContain(stamp);
      for (const html of [history, proposals]) {
        expect(html).toContain(formatStamp(at, lang));
        const doc = new DOMParser().parseFromString(html, "text/html");
        expect(doc.body.textContent).not.toContain(at);
        const cards = [...doc.querySelectorAll('[data-testid="viewpoint-diff-card"]')];
        expect(cards).toHaveLength(3);
        for (const [index, item] of [old, updated, added].entries()) {
          for (const text of Object.values(item)) expect(cards[index].textContent).toContain(text);
          expect(cards[index].textContent).toContain(
            index === 0
              ? messagesFor(lang).parts.proposals.removed
              : messagesFor(lang).parts.proposals.added,
          );
        }
        expect(doc.body.textContent).not.toContain('{"id"');
        const lines = [...doc.querySelectorAll('[data-testid="design-diff-line"]')];
        expect(
          lines.map((line) => [line.children[0].textContent?.[0], line.children[1].textContent]),
        ).toEqual([
          ["-", "- 旧い項目"],
          ["+", "- 新しい項目"],
        ]);
        expect(lines[0].className).toContain("bg-red-100");
        expect(lines[1].className).toContain("bg-green-100");
      }
    },
  );
  it.each(["ja", "en"] as const)("%s の空の差分と解析できない行を表示する", (lang) => {
    locale = lang;
    for (const html of renderBoth({
      design: "",
      testViewpoints: `+not json\n+${JSON.stringify(added)}`,
    })) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      expect(doc.body.textContent).toContain(messagesFor(lang).parts.proposals.noChanges);
      expect(doc.body.textContent).toContain("+not json");
      expect(doc.querySelector('[data-testid="viewpoint-diff-card"]')?.textContent).toContain(
        "Third expected",
      );
    }
  });
});
