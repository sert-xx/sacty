import type { Project } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

let locale: Locale = "ja";
vi.mock("@/app/actions", () => ({
  saveProjectAction: async () => ({}),
  previewContextAction: async () => ({}),
}));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));

const { ProjectEditor } = await import("./project-editor");

describe("プロジェクトの設定に Slack の通知の項目は無い（PBI-115）", () => {
  // 以前の sacty が保存した通知先が、型の外から紛れ込んでいても出さない
  const project = {
    id: "p1",
    name: "決済",
    targets: [{ scope: "repo", target: "https://github.com/acme/app" }],
    githubAccounts: { "github.com": "me" },
    notification: {
      kind: "slack-webhook",
      webhook: "old-webhook",
      language: "ja",
      mention: { targets: ["U0OLD0000"], kinds: ["approval"] },
    },
    createdAt: "",
    updatedAt: "",
  } as unknown as Project;

  it("通知の区画・テストの通知を出さず、保存する定義にも通知先を入れない（日英）", () => {
    for (const lang of ["ja", "en"] as const) {
      locale = lang;
      const settings = messagesFor(lang).settings;
      const html = renderToStaticMarkup(
        createElement(ProjectEditor, {
          project,
          github: { accounts: [{ host: "github.com", login: "me", active: true }] },
        } as Parameters<typeof ProjectEditor>[0]),
      );
      // 画面は描ける（ほかの項目は出す）
      expect(html, lang).toContain('value="決済"');
      for (const text of [
        settings.notifyTitle,
        settings.notifyTest,
        settings.mentionTargets,
        "Slack",
        "old-webhook",
        "U0OLD0000",
      ]) {
        expect(html, `${lang}:${text}`).not.toContain(text);
      }
      const definition = html.match(/name="definition" value="([^"]*)"/)?.[1] ?? "";
      expect(definition, lang).toContain("&quot;name&quot;");
      expect(definition, lang).not.toContain("notification");
    }
    locale = "ja";
  });
});
