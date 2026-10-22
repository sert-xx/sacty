import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/app/actions", () => ({
  saveSettingsAction: async () => ({}),
  testNotificationAction: async () => ({}),
}));
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
      "始めると 300 秒ごと（既定）。",
    );
    // ブラウザの検査（ブラウザの言語）に任せず、デーモンの文言（画面の言語）で誤りを出す
    expect(render()).toMatch(/<form[^>]*novalidate=""/i);
    locale = "ja";
    expect(messagesFor("ja").settings.intervalCurrent(300, true)).toBe(
      "いまは 300 秒ごと（既定）。",
    );
  });
});

describe("sacty の設定の Slack の通知（PBI-115）", () => {
  const destination = {
    kind: "slack-api" as const,
    url: "https://slack.example.com/api/chat.postMessage",
    channel: "#sacty",
    token: "slack-bot",
    language: "en" as const,
    mention: { targets: ["U0123ABCD", "@here"], kinds: ["approval" as const, "paused" as const] },
  };
  /** 通知の区画（最後の section）。 */
  const notificationSection = (html: string) => html.split("<section").at(-1) ?? "";

  it("通知の区画に、送り方・言語・URL・チャンネル・トークン・メンション・テストの通知を、日英の文言で出す", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const t = messagesFor(lang).settings;
      const section = notificationSection(render({ notification: destination }));
      expect(headings(section)[0], lang).toBe(t.notifyTitle);
      for (const text of [
        t.notifyKind,
        t.notifyLanguage,
        t.notifyUrl,
        t.notifyChannel,
        t.notifyToken,
        t.mentionTargets,
        t.mentionKinds,
        t.notifyTest,
        ...Object.values(t.mentionKind),
      ]) {
        expect(section, `${lang}:${text}`).toContain(text);
      }
      expect(section, lang).toContain('value="https://slack.example.com/api/chat.postMessage"');
      expect(section, lang).toContain('value="U0123ABCD, @here"');
      // 保存する値は、フォームに JSON で渡す（保存したものと同じなので、テストの通知を送れる）
      const hidden = section.match(/name="notification" value="([^"]*)"/)?.[1] ?? "";
      expect(JSON.parse(hidden.replaceAll("&quot;", '"'))).toEqual(destination);
      expect(section, lang).not.toContain(t.notifySaveFirst);
    }
    locale = "ja";
  });

  it("通知先が無ければ「通知しない」で、入力の欄とテストの通知は出さず、何も送らない", () => {
    locale = "ja";
    const t = messagesFor("ja").settings;
    const section = notificationSection(render());
    expect(section).toContain(t.notifyNone);
    expect(section).toContain('name="notification" value=""');
    expect(section).not.toContain(t.notifyUrl);
    expect(section).not.toContain(t.notifyTest);
  });

  it("Webhook の通知先は、Webhook の URL の欄を出す", () => {
    locale = "ja";
    const t = messagesFor("ja").settings;
    const section = notificationSection(
      render({ notification: { kind: "slack-webhook", webhook: "slack-webhook", language: "ja" } }),
    );
    expect(section).toContain(t.notifyWebhookSecret);
    expect(section).toContain('value="slack-webhook"');
    expect(section).not.toContain("-notify-channel");
  });
});

describe("sacty の設定の、通知を送れなかった理由（PBI-115）", () => {
  it("通知の区画に、送れなかった理由を出す。無ければ出さない", () => {
    locale = "ja";
    const problem = "Slack の通知を送れませんでした：HTTP 500（タスクは止めていません）";
    const section = (html: string) => html.split("<section").at(-1) ?? "";
    const shown = section(render({ notificationProblems: [problem] }));
    expect(shown).toContain('data-testid="notification-problems"');
    expect(shown).toContain(problem);
    expect(section(render())).not.toContain("notification-problems");
  });
});

describe("sacty の設定の Slack の通知の区画の見え方（PBI-115 レビュー指摘）", () => {
  const section = (html: string) => html.split("<section").at(-1) ?? "";
  const destination = {
    kind: "slack-api" as const,
    url: "https://slack.example.com/api/chat.postMessage",
    channel: "#sacty",
    token: "slack-bot",
    language: "ja" as const,
  };

  it("送り先を見る人が、すべてのプロジェクトの通知を受け取ってよいかを確かめるよう、日英で示す", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const t = messagesFor(lang).settings;
      // 通知先を設定する前（通知しない）から出す
      for (const html of [render(), render({ notification: destination })]) {
        const shown = section(html);
        expect(shown, lang).toContain('data-testid="notification-audience"');
        expect(shown, lang).toContain(t.notifyAudience.replaceAll("'", "&#x27;"));
      }
    }
    locale = "ja";
    expect(messagesFor("ja").settings.notifyAudience).toContain("すべてのプロジェクトの通知");
    expect(messagesFor("en").settings.notifyAudience).toContain("every project");
  });

  it("狭い画面（320px）で入力欄が収まるよう、最小の幅は広い画面（sm）だけに付ける", () => {
    locale = "ja";
    const shown = section(render({ notification: destination }));
    const classes = [...shown.matchAll(/class="([^"]*)"/g)].map((m) => m[1]?.split(/\s+/) ?? []);
    // sm: の付かない min-w-<数>（min-w-0 を除く）を使わない
    expect(classes.flat().filter((c) => /^min-w-(?!0$)/.test(c))).toEqual([]);
    // URL・チャンネル・トークンの欄は、狭い幅では幅いっぱいで縮められる
    const fields = classes.filter((c) => c.some((x) => x.startsWith("sm:min-w-")));
    expect(fields).toHaveLength(3);
    for (const c of fields) {
      expect(c).toContain("w-full");
      expect(c).toContain("min-w-0");
      // 狭い幅では横に並べて押しつぶさない（伸び縮みは sm 以上だけ）
      expect(c.filter((x) => /^flex-(?:1|\[2\])$/.test(x))).toEqual([]);
    }
  });
});

describe("レビューのメンションの相手", () => {
  it("PR のレビューの取り込みの区画に、自分にメンションする切り替えを出す（既定は Off＝作者にメンションする）", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const t = messagesFor(lang).settings;
      const review = render().split("<section").at(2) ?? "";
      expect(review, lang).toContain('name="reviewMentionSelf"');
      expect(review, lang).toContain(t.reviewMentionSelf);
      expect(review, lang).not.toContain('name="reviewMentionSelf" checked=""');
      expect(render({ reviewMentionSelf: true }), lang).toContain(
        'name="reviewMentionSelf" checked=""',
      );
    }
    locale = "ja";
  });
});
