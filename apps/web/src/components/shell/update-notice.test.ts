import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shell } from "@/i18n/messages/shell";
import type { DaemonStatus } from "@/lib/daemon";

let status: () => Promise<Partial<DaemonStatus>> = async () => ({});
vi.mock("@/lib/daemon", () => ({ getStatus: () => status() }));

const { UpdateNotice } = await import("./update-notice");
const { UpdateNoticeLive } = await import("./update-notice-live");
const { UpdateNoticeView, UPDATE_COMMANDS, safeCompareUrl } = await import("./update-notice-view");
const { loadUpdateData } = await import("@/lib/update-data");

const COMPARE = "https://github.com/sert-xx/sacty/compare/0123abc...main";
const view = (update: DaemonStatus["update"], t = shell.ja.update) => {
  const element = UpdateNoticeView({ update, t });
  return element ? renderToStaticMarkup(createElement(() => element)) : "";
};

afterEach(() => {
  status = async () => ({});
});

describe("sacty の新しい版の知らせ（PBI-135）", () => {
  it("新しい版があれば、遅れている数・変更を見るリンク・止めてから実行する更新の手順を出す", () => {
    const text = view({ behindBy: 3, compareUrl: COMPARE });
    expect(text).toContain("Sacty の新しい版があります");
    expect(text).toContain("変更が 3 件あります");
    expect(text).toContain(`href="${COMPARE}"`);
    // 動いている sacty up を止めてから、更新・ビルドして起動する（PR #147 レビュー提案）
    expect(text).toContain("Ctrl+C で止めてから");
    expect(UPDATE_COMMANDS.split("\n")).toEqual([
      "git pull origin main",
      "npm install",
      "npm run build",
      "npx sacty up",
    ]);
  });

  it("新しい版が無い・0 件のときは何も出さない（境界：1 件なら出す）", () => {
    expect(view(undefined)).toBe("");
    expect(view({ behindBy: 0, compareUrl: COMPARE })).toBe("");
    expect(view({ behindBy: 1, compareUrl: COMPARE })).not.toBe("");
  });

  it("差分のリンクは GitHub の https の URL だけ（ほかは文だけ出す）", () => {
    expect(safeCompareUrl(COMPARE)).toBe(COMPARE);
    for (const bad of [
      "javascript:alert(1)",
      "http://github.com/sert-xx/sacty/compare/a...main",
      "https://evil.example/compare",
      'https://github.com/x" onmouseover="y',
    ]) {
      expect(safeCompareUrl(bad), bad).toBeUndefined();
    }
    const text = view({ behindBy: 2, compareUrl: "javascript:alert(1)" });
    expect(text).toContain("変更が 2 件あります");
    expect(text).not.toContain("href=");
  });

  it("英語の文言もある", () => {
    const text = view({ behindBy: 1, compareUrl: COMPARE }, shell.en.update);
    expect(text).toContain("A new version of Sacty is available");
    expect(text).toContain("1 change not in the running version");
    expect(text).toContain("Stop the running sacty up with Ctrl+C");
  });
});

describe("描いたときの状態と取り直しのデータ（PR #147 レビュー指摘）", () => {
  it("描いたときの状態から、取り直す部品を始める。知らせが無くても始める（後から現れるように）", async () => {
    const update = { behindBy: 3, compareUrl: COMPARE };
    status = async () => ({ update });
    let element = (await UpdateNotice()) as { type: unknown; props: { initial: unknown } };
    expect(element.type).toBe(UpdateNoticeLive);
    expect(element.props.initial).toEqual({ update });
    status = async () => ({});
    element = (await UpdateNotice()) as typeof element;
    expect(element.type).toBe(UpdateNoticeLive);
    expect(element.props.initial).toEqual({ update: null });
    // デーモンにつながらなくても、知らせの無い状態から始める
    status = () => Promise.reject(new Error("unreachable"));
    element = (await UpdateNotice()) as typeof element;
    expect(element.props.initial).toEqual({ update: null });
  });

  it("取り直しのデータは、デーモンの状態の update だけ（無ければ null、届かなければ例外）", async () => {
    status = async () => ({ update: { behindBy: 1, compareUrl: COMPARE }, problems: [] });
    expect(await loadUpdateData()).toEqual({ update: { behindBy: 1, compareUrl: COMPARE } });
    status = async () => ({ problems: [] });
    expect(await loadUpdateData()).toEqual({ update: null });
    status = () => Promise.reject(new Error("unreachable"));
    await expect(loadUpdateData()).rejects.toThrow();
  });
});
