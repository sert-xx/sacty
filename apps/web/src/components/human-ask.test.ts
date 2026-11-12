// @vitest-environment jsdom
import type { Task } from "@sacty/core";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

/*
 * 人に確かめてほしいこと（PBI-301）：戻し先の判断で指摘の意図を読み取れなかった理由と、実行が挙げた聞き返し・推測で
 * 決めたことを、承認の画面とタスクの詳細の目立つ所に出す。
 */
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));

const { HumanAskNotice } = await import("./human-ask");

const remark = (id: string, patch: Record<string, unknown> = {}) => ({
  id,
  step: "implement",
  round: 1,
  text: "ここ前と言ってること違わない？",
  voided: false,
  submittedIn: 2,
  response: "直した",
  respondedIn: 2,
  ...patch,
});

const task = (patch: Record<string, unknown> = {}): Task =>
  ({
    status: "awaiting_approval",
    gate: { step: "implement", submission: 2 },
    remarks: [remark("implement-1-1")],
    ...patch,
  }) as unknown as Task;

const undecided = (reason: unknown = "「前と言ってること」が何を指すか読み取れない。") => ({
  target: "implement",
  decided: false,
  reason,
  at: "2026-11-04T00:00:00.000Z",
  round: 1,
  remarkIds: ["implement-1-1"],
});

const render = (t: Task) => renderToStaticMarkup(h(HumanAskNotice, { task: t }));

describe("人に確かめてほしいことの欄（PBI-301）", () => {
  it("判断できなかった理由を、指摘の ID と、確かめてほしい人への案内つきで出す", () => {
    const html = render(task({ prRework: undecided() }));
    expect(html).toContain('data-testid="human-ask"');
    expect(html).toContain("人に確かめてほしいことが1件あります");
    expect(html).toContain("戻し先の判断で、指摘（implement-1-1）の意図を読み取れませんでした");
    expect(html).toContain("「前と言ってること」が何を指すか読み取れない。");
    expect(html).toContain("意図と合うか、指摘した方が確かめてください");
  });

  it("実行が挙げた確かめたいことを、指摘の ID と一緒に出す（判断できなかった理由と合わせて数える）", () => {
    const html = render(
      task({
        prRework: undecided(),
        remarks: [
          remark("implement-1-1", { confirm: "上限は 31 日と推測して作り直しました" }),
          remark("implement-1-2"),
        ],
      }),
    );
    expect(html).toContain("人に確かめてほしいことが2件あります");
    expect(html).toContain("実行が確かめたいこと（指摘 implement-1-1）");
    expect(html).toContain("上限は 31 日と推測して作り直しました");
    expect(html).not.toContain("指摘 implement-1-2");
  });

  it("長い判断の理由は、要点を先に出し、全文は開いて読む", () => {
    const long = `読み取れない。複数の読み方がある。${"詳しい理由が続く。".repeat(80)}`;
    const html = render(task({ prRework: undecided(long) }));
    const outside = html.slice(0, html.indexOf("<details"));
    expect(outside).toContain("読み取れない。複数の読み方がある。");
    expect(outside).not.toContain("詳しい理由が続く");
    expect(html.slice(html.indexOf("<details"))).toContain("詳しい理由が続く");
  });

  it("確かめることが無ければ、何も出さない（判断できた・実行の失敗・無効にした指摘・承認待ちでない）", () => {
    expect(render(task())).toBe("");
    expect(render(task({ prRework: { ...undecided(), decided: true } }))).toBe("");
    expect(
      render(
        task({ prRework: undecided({ code: "run.guardianFailed", params: { detail: "x" } }) }),
      ),
    ).toBe("");
    expect(
      render(task({ prRework: undecided(), remarks: [remark("implement-1-1", { voided: true })] })),
    ).toBe("");
    expect(render(task({ prRework: undecided(), status: "paused" }))).toBe("");
  });

  it("英語の画面では英語で出す", () => {
    vi.doMock("@/i18n/client", () => ({ useMessages: () => messagesFor("en") }));
    const en = messagesFor("en").task.humanAsk;
    expect(en.title(1)).toBe("1 thing for you to check");
    expect(en.undecided("implement-1-1")).toContain(
      "The meaning of comment implement-1-1 was unclear",
    );
  });
});
