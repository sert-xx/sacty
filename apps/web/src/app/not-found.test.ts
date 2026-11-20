import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor(locale) }));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) =>
    createElement("a", { href }, children),
}));
const { default: NotFound, generateMetadata } = await import("./not-found");

describe.each([
  ["ja", "ページが見つかりません", "ダッシュボードへ"],
  ["en", "Page not found", "Go to the dashboard"],
] as const)("無いページ（画面の言語 %s）", (lang, title, link) => {
  it("見出しと、ダッシュボードへのリンクを、画面の言語で出す", async () => {
    locale = lang;
    const html = renderToStaticMarkup(await NotFound());
    expect(html).toContain(`>${title}</h1>`);
    expect(html).toContain(`<a href="/dashboard"`);
    expect(html).toContain(`>${link}</a>`);
  });

  it("ブラウザーのタイトルも、画面の言語", async () => {
    locale = lang;
    expect(await generateMetadata()).toEqual({ title: `${title} - Sacty` });
  });
});
