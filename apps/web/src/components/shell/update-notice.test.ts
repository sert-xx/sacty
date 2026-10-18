import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shell } from "@/i18n/messages/shell";
import type { DaemonStatus } from "@/lib/daemon";

let status: () => Promise<Partial<DaemonStatus>> = async () => ({});
vi.mock("@/lib/daemon", () => ({ getStatus: () => status() }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => ({ shell: shell.ja }) }));

const { UpdateNotice, UpdateNoticeView, UPDATE_COMMANDS, safeCompareUrl } = await import(
  "./update-notice"
);

const html = async () => {
  const element = await UpdateNotice();
  return element ? renderToStaticMarkup(element) : "";
};
const COMPARE = "https://github.com/sert-xx/sacty/compare/0123abc...main";

afterEach(() => {
  status = async () => ({});
});

describe("sacty の新しい版の知らせ（PBI-135）", () => {
  it("新しい版があれば、遅れている数・変更を見るリンク・更新の手順を出す", async () => {
    status = async () => ({ update: { behindBy: 3, compareUrl: COMPARE } });
    const text = await html();
    expect(text).toContain("sacty の新しい版があります");
    expect(text).toContain("変更が 3 件あります");
    expect(text).toContain(`href="${COMPARE}"`);
    expect(text).toContain("npm run build");
    expect(UPDATE_COMMANDS.split("\n")).toEqual([
      "git pull origin main",
      "npm install",
      "npm run build",
    ]);
  });

  it("最新・確かめられない・古いデーモン・つながらないときは何も出さない", async () => {
    expect(await html()).toBe("");
    status = async () => ({ update: undefined });
    expect(await html()).toBe("");
    status = () => Promise.reject(new Error("unreachable"));
    expect(await html()).toBe("");
    // 0 件は知らせない（境界）
    expect(
      UpdateNoticeView({ update: { behindBy: 0, compareUrl: COMPARE }, t: shell.ja.update }),
    ).toBeNull();
    expect(
      UpdateNoticeView({ update: { behindBy: 1, compareUrl: COMPARE }, t: shell.ja.update }),
    ).not.toBeNull();
  });

  it("差分のリンクは GitHub の https の URL だけ（ほかは文だけ出す）", async () => {
    expect(safeCompareUrl(COMPARE)).toBe(COMPARE);
    for (const bad of [
      "javascript:alert(1)",
      "http://github.com/sert-xx/sacty/compare/a...main",
      "https://evil.example/compare",
      'https://github.com/x" onmouseover="y',
    ]) {
      expect(safeCompareUrl(bad), bad).toBeUndefined();
    }
    status = async () => ({ update: { behindBy: 2, compareUrl: "javascript:alert(1)" } });
    const text = await html();
    expect(text).toContain("変更が 2 件あります");
    expect(text).not.toContain("href=");
  });

  it("英語の文言もある", () => {
    const element = UpdateNoticeView({
      update: { behindBy: 1, compareUrl: COMPARE },
      t: shell.en.update,
    });
    const text = renderToStaticMarkup(createElement(() => element));
    expect(text).toContain("A new version of sacty is available");
    expect(text).toContain("1 change not in the running version");
  });
});
