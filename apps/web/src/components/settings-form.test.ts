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

describe("取り込みの種類ごとの間隔（PBI-100）", () => {
  it("Issue・PR のレビュー・チケットの区画に、それぞれの間隔の欄を出す（下限 60・空なら既定の 300）", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const t = messagesFor(lang).settings;
      const html = render({ reviewIntervalSec: 900 });
      const sections = html.split("<section").slice(1, 4);
      expect(
        sections.map((section) => section.match(/name="([a-zA-Z]+IntervalSec)"/)?.[1]),
        lang,
      ).toEqual(["issueIntervalSec", "reviewIntervalSec", "ticketIntervalSec"]);
      for (const section of sections) {
        expect(section, lang).toContain('min="60"');
        expect(section, lang).toContain('placeholder="300"');
        expect(section, lang).toContain(t.intervalLabel);
      }
      // 保存した値と、いまの間隔（設定していなければ既定）
      expect(sections[1], lang).toContain('value="900"');
      expect(sections[1], lang).toContain(t.intervalCurrent(900, false));
      expect(sections[0], lang).toContain('value=""');
      expect(sections[0], lang).toContain(t.intervalCurrent(300, true));
    }
    // 取り込みが止まっている種類（Off・ラベルが無い）は「始めると」の文にする（レビュー指摘）
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const t = messagesFor(lang).settings;
      const off = render({ triageOff: ["issues"], ticketLabel: "", ticketIntervalSec: 120 }).split(
        "<section",
      );
      expect(off[1], lang).toContain(t.intervalWhenOn(300, true));
      expect(off[1], lang).not.toContain(t.intervalCurrent(300, true));
      expect(off[1], lang).toContain(t.intakeOff);
      expect(off[3], lang).toContain(t.intervalWhenOn(120, false));
      expect(off[2], lang).toContain(t.intervalCurrent(300, true));
    }
    locale = "ja";
    expect(messagesFor("ja").settings.intervalWhenOn(300, true)).toBe(
      "取り込みを始めると、300 秒ごとに取り込みます（既定）。",
    );
    // ブラウザの検査（ブラウザの言語）に任せず、デーモンの文言（画面の言語）で誤りを出す
    expect(render()).toMatch(/<form[^>]*novalidate=""/i);
    locale = "ja";
    expect(messagesFor("ja").settings.intervalCurrent(300, true)).toBe(
      "いまは 300 秒ごとに取り込みます（既定）。",
    );
  });
});
