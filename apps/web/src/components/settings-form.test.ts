import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/app/actions", () => ({ saveSettingsAction: async () => ({}) }));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));

const { SettingsForm } = await import("./settings-form");

const render = (props: Partial<Parameters<typeof SettingsForm>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SettingsForm, {
      intakeLabel: "sacty",
      reviewLabel: "sacty-review",
      reviewRequested: false,
      ...props,
    }),
  );

/** 見出しの文字（h2 の最初の文字列）。 */
const headings = (html: string) => [...html.matchAll(/<h2[^>]*>([^<]*)/g)].map((m) => m[1]?.trim());

describe("sacty の設定の画面の取り込み（PBI-99）", () => {
  it("「Issue の取り込み」と「PR のレビューの取り込み」に分け、Issue の取り込みに PR の項目を出さない", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const t = messagesFor(lang).settings;
      const html = render();
      expect(headings(html).slice(0, 2), lang).toEqual([t.intakeTitle, t.reviewTitle]);
      // Issue の取り込みの区画（最初の section）
      const intake = html.split("<section").at(1) ?? "";
      expect(intake, lang).toContain('name="triage-issues"');
      expect(intake, lang).toContain('name="intakeLabel"');
      expect(intake, lang).not.toContain("PR を取り込む");
      expect(intake, lang).not.toContain("Import PRs");
      // PR の On/Off は、レビュー用のラベルとレビューの依頼だけ
      expect(
        [...html.matchAll(/name="triage-([a-zA-Z]+)"/g)].map((m) => m[1]),
        lang,
      ).toEqual(["issues", "reviewLabel", "tickets"]);
      expect(html, lang).toContain(t.intakeOn("sacty").replaceAll('"', "&quot;"));
    }
    locale = "ja";
    expect(messagesFor("ja").settings.intakeTitle).toBe("Issue の取り込み");
    expect(messagesFor("en").settings.intakeTitle).toBe("Issue intake");
  });

  it("Issue を Off にしているか、ラベルが無ければ、Issue の取り込みは止まっていると出す", () => {
    locale = "ja";
    const t = messagesFor("ja").settings;
    expect(render({ triageOff: ["issues"] })).toContain(t.intakeOff);
    expect(render({ intakeLabel: "" })).toContain(t.intakeOff);
    expect(render({ triageOff: ["issues"] })).not.toContain('name="triage-issues" checked=""');
  });
});
