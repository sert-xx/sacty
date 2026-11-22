import type { Task } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

let locale: "ja" | "en" = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: string }) => createElement("div", null, children),
}));
const { Proposals } = await import("./proposals");

describe("補足で受け入れた申し出", () => {
  it.each(["ja", "en"] as const)("%s で再開日時と反映済みと差分を表示する", (lang) => {
    locale = lang;
    const task = {
      id: "t1",
      status: "idle",
      proposals: [
        {
          id: "CP-1",
          fromStep: "implement",
          target: "requirements",
          reason: "理由",
          facts: [],
          proposed: "新しい要求",
          proposedAt: "2026-11-22T12:00:00Z",
          applied: true,
          byNote: {
            resumedAt: "2026-11-22T12:00:00Z",
            at: "2026-11-22T12:01:00Z",
            diff: { design: "-old design\n+new design", testViewpoints: "-old test\n+new test" },
          },
        },
      ],
    } as unknown as Task;
    const html = renderToStaticMarkup(createElement(Proposals, { task }));
    expect(html).toContain(messagesFor(lang).parts.proposals.applied);
    expect(html).toContain(lang === "ja" ? "補足で受け入れた" : "Accepted by note");
    expect(html).toContain("11/22");
    expect(html).toContain("new design");
    expect(html).toContain("new test");
    expect(html).not.toContain(messagesFor(lang).parts.proposals.appliedRequirements);
    expect(html).not.toContain("<form");
  });
});
