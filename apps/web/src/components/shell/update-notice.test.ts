import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shell } from "@/i18n/messages/shell";
import type { DaemonStatus } from "@/lib/daemon";

let status: () => Promise<Partial<DaemonStatus>> = async () => ({});
vi.mock("@/lib/daemon", () => ({ getStatus: () => status() }));

const { UpdateNotice } = await import("./update-notice");
const { UpdateNoticeLive } = await import("./update-notice-live");
const { UpdateNoticeView, UPDATE_COMMANDS, safeGitHubUrl } = await import("./update-notice-view");
const { loadUpdateData } = await import("@/lib/update-data");

const RELEASE = "https://github.com/sert-xx/sacty/releases/tag/v1.1.0";
const newer = (latest = "1.1.0", releaseUrl = RELEASE) => ({
  latest,
  current: "1.0.0",
  releaseUrl,
});
const view = (update: DaemonStatus["update"], t = shell.ja.update) => {
  const element = UpdateNoticeView({ update, t });
  return element ? renderToStaticMarkup(createElement(() => element)) : "";
};

afterEach(() => {
  status = async () => ({});
});

describe("sacty の新しい版の知らせ（PBI-135・PBI-147）", () => {
  it("新しい版があれば、最新の版と動いている版・リリースのリンク・止めてから実行する更新の手順（イメージの作り直しを含む）を出す", () => {
    const text = view(newer());
    expect(text).toContain("Sacty の新しい版があります");
    expect(text).toContain("Sacty 1.1.0 がリリースされました（動いているのは 1.0.0）");
    expect(text).toContain(`href="${RELEASE}"`);
    expect(text).toContain("リリースの内容を見る");
    // 動いている sacty up を止めてから、更新・ビルド・イメージの作り直しをして起動する（PR #147 レビュー提案・PBI-147）
    expect(text).toContain("Ctrl+C で止めてから");
    expect(UPDATE_COMMANDS.split("\n")).toEqual([
      "git pull origin main",
      "npm install",
      "npm run build",
      "npx sacty image build",
      "npx sacty up",
    ]);
  });

  it("新しい版が無いときは何も出さない", () => {
    expect(view(undefined)).toBe("");
    expect(view(newer())).not.toBe("");
  });

  it("リリースのリンクは GitHub の https の URL だけ（ほかは文だけ出す）", () => {
    expect(safeGitHubUrl(RELEASE)).toBe(RELEASE);
    for (const bad of [
      "javascript:alert(1)",
      "http://github.com/sert-xx/sacty/releases/tag/v1.1.0",
      "https://evil.example/releases",
      'https://github.com/x" onmouseover="y',
    ]) {
      expect(safeGitHubUrl(bad), bad).toBeUndefined();
    }
    const text = view(newer("1.2.0", "javascript:alert(1)"));
    expect(text).toContain("Sacty 1.2.0 がリリースされました");
    expect(text).not.toContain("href=");
  });

  it("英語の文言もある", () => {
    const text = view(newer(), shell.en.update);
    expect(text).toContain("A new version of Sacty is available");
    expect(text).toContain("Sacty 1.1.0 has been released (you are running 1.0.0)");
    expect(text).toContain("See the release notes");
    expect(text).toContain("Stop the running sacty up with Ctrl+C");
  });
});

describe("描いたときの状態と取り直しのデータ（PR #147 レビュー指摘）", () => {
  it("描いたときの状態から、取り直す部品を始める。知らせが無くても始める（後から現れるように）", async () => {
    const update = newer();
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
    status = async () => ({ update: newer(), problems: [] });
    expect(await loadUpdateData()).toEqual({ update: newer() });
    status = async () => ({ problems: [] });
    expect(await loadUpdateData()).toEqual({ update: null });
    status = () => Promise.reject(new Error("unreachable"));
    await expect(loadUpdateData()).rejects.toThrow();
  });
});
