import { type DaemonText, message, renderMessage } from "@sacty/core";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { shell } from "@/i18n/messages/shell";
import type { DaemonStatus } from "@/lib/daemon";

let status: () => Promise<Partial<DaemonStatus>> = async () => ({});
vi.mock("@/lib/daemon", () => ({ getStatus: () => status() }));

const { DockerNotice } = await import("./docker-notice");
const { DockerNoticeLive } = await import("./docker-notice-live");
const { DockerNoticeView } = await import("./docker-notice-view");
const { loadDockerData } = await import("@/lib/docker-data");

/*
 * Docker を使えない・エージェントのイメージが無いことを、どの画面でも知らせる（PBI-148）。
 */

const missing = message("image.missing", {
  image: "sacty-agent:1.11.1",
  command: "npx sacty image build",
});
const view = (problems: DaemonText[], locale: "ja" | "en" = "ja") => {
  const element = DockerNoticeView({
    problems,
    t: shell[locale].docker,
    text: (p) => renderMessage(p, locale),
  });
  return element ? renderToStaticMarkup(createElement(() => element)) : "";
};

afterEach(() => {
  status = async () => ({});
});

describe("Docker とエージェントのイメージの注意（PBI-148）", () => {
  it("注意があれば、見出し・注意のそれぞれ・確かめ直すことを出す", () => {
    const text = view([message("image.dockerUnreachable"), missing]);
    expect(text).toContain('role="alert"');
    expect(text).toContain("Docker を使える状態ではありません");
    expect(text).toContain("Docker に接続できません。");
    expect(text).toContain("エージェント用のイメージ（sacty-agent:1.11.1）がありません。");
    expect(text).toContain("1分ごとに確かめ直します");
  });

  it("注意が無ければ何も出さない", () => {
    expect(view([])).toBe("");
  });

  it("英語の文言もある", () => {
    const text = view([message("image.dockerNotInstalled")], "en");
    expect(text).toContain("Docker is not ready");
    expect(text).toContain("The docker command was not found.");
    expect(text).toContain("Sacty checks again every minute.");
  });
});

describe("描いたときの状態と取り直しのデータ", () => {
  it("描いたときの状態から、取り直す部品を始める。注意が無くても・デーモンにつながらなくても始める", async () => {
    status = async () => ({ docker: [missing] });
    let element = (await DockerNotice()) as { type: unknown; props: { initial: unknown } };
    expect(element.type).toBe(DockerNoticeLive);
    expect(element.props.initial).toEqual({ docker: [missing] });
    status = async () => ({});
    element = (await DockerNotice()) as typeof element;
    expect(element.props.initial).toEqual({ docker: [] });
    status = () => Promise.reject(new Error("unreachable"));
    element = (await DockerNotice()) as typeof element;
    expect(element.type).toBe(DockerNoticeLive);
    expect(element.props.initial).toEqual({ docker: [] });
  });

  it("取り直しのデータは、デーモンの状態の docker だけ（古いデーモンには無いので空、届かなければ例外）", async () => {
    status = async () => ({ docker: [missing], warnings: [message("image.dockerUnreachable")] });
    expect(await loadDockerData()).toEqual({ docker: [missing] });
    status = async () => ({ problems: [] });
    expect(await loadDockerData()).toEqual({ docker: [] });
    status = () => Promise.reject(new Error("unreachable"));
    await expect(loadDockerData()).rejects.toThrow();
  });
});
