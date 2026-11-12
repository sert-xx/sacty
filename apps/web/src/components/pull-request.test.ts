// @vitest-environment jsdom
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

/*
 * PR の欄：PR の指摘で差し戻したときの戻し先に、戻し先の判断で決まった原因を添える。見逃しの記録は、見逃しのときだけ出る（PBI-268）。
 */
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));

const { PullRequestCard } = await import("./pull-request");

type CardTask = Parameters<typeof PullRequestCard>[0]["task"];

const task = (patch: Record<string, unknown>): CardTask =>
  ({
    pullRequest: {
      number: 7,
      url: "https://github.com/acme/app/pull/7",
      branch: "sacty/t1",
      commit: "0123456789abcdef",
      repo: "acme/app",
    },
    stepPullRequests: [],
    misses: [],
    ...patch,
  }) as unknown as CardTask;

const rework = (cause?: string) => ({
  target: "implement",
  decided: true,
  reason: "実装で直せる",
  at: "2026-10-30T00:00:00.000Z",
  ...(cause ? { cause } : {}),
});

describe("PR の欄の差し戻しの原因（PBI-268）", () => {
  it.each([
    ["base_changed", "原因：ベースの変化による競合"],
    ["new_request", "原因：新しい要望・方針の変更"],
    ["question_answer", "原因：質問への答え"],
    ["guardian_missed", "原因：見逃し"],
  ])("原因が %s なら、戻し先の下に出す。見逃しの記録は、記録が無ければ出ない", (cause, text) => {
    const html = renderToStaticMarkup(
      h(PullRequestCard, { task: task({ prRework: rework(cause) }) }),
    );
    expect(html).toContain(text);
    expect(html).toContain("実装からやり直し");
    expect(html).not.toContain("最終レビューの見逃し 1件");
  });

  it("原因を決めていない差し戻しには、原因を出さない", () => {
    const html = renderToStaticMarkup(h(PullRequestCard, { task: task({ prRework: rework() }) }));
    expect(html).toContain("実装からやり直し");
    expect(html).not.toContain("原因：");
  });

  it("見逃しの記録があれば、見逃しとして出す", () => {
    const html = renderToStaticMarkup(
      h(PullRequestCard, {
        task: task({ misses: [{ reviewAt: "r", remarkIds: ["implement-1-1"], at: "t" }] }),
      }),
    );
    expect(html).toContain("最終レビューの見逃し 1件");
  });
});

describe("PR の欄の戻し先の判断の文（PBI-301）", () => {
  const long = `決定を変えない指摘なので、実装に戻す。指摘の行は R-8 と合っている。${"詳しい理由が続く。".repeat(80)}`;

  it("長い判断の文は、要点（先頭の 2 文）を先に出し、全文は開いて読める（折りたたみの中）", () => {
    const html = renderToStaticMarkup(
      h(PullRequestCard, { task: task({ prRework: { ...rework(), reason: long } }) }),
    );
    // 要点は折りたたみの外、全文は折りたたみの中
    const outside = html.slice(0, html.indexOf("<details"));
    expect(outside).toContain(
      "実装からやり直し：決定を変えない指摘なので、実装に戻す。指摘の行は R-8 と合っている。",
    );
    expect(outside).not.toContain("詳しい理由が続く");
    expect(html).toContain('data-testid="rework-reason-full"');
    expect(html.slice(html.indexOf("<details"))).toContain("詳しい理由が続く");
  });

  it("短い判断の文は、折りたたまない", () => {
    const html = renderToStaticMarkup(h(PullRequestCard, { task: task({ prRework: rework() }) }));
    expect(html).toContain("実装からやり直し：実装で直せる");
    expect(html).not.toContain("<details");
  });

  it("戻し先を判断できなかったときも、長い理由は要点だけを先に出す", () => {
    const html = renderToStaticMarkup(
      h(PullRequestCard, {
        task: task({ prRework: { ...rework(), decided: false, reason: long } }),
      }),
    );
    expect(html).toContain("戻し先を判断できず：決定を変えない指摘なので");
    expect(html.slice(0, html.indexOf("<details"))).not.toContain("詳しい理由が続く");
  });
});
