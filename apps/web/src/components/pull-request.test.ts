// @vitest-environment jsdom
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

/*
 * PR の欄：PR の指摘で差し戻したときの戻し先に、ゴールガーディアンが判断した原因を添える。見逃しの記録は、見逃しのときだけ出る（PBI-268）。
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
    ["guardian_missed", "原因：ゴールガーディアンの見逃し"],
  ])("原因が %s なら、戻し先の下に出す。見逃しの記録は、記録が無ければ出ない", (cause, text) => {
    const html = renderToStaticMarkup(
      h(PullRequestCard, { task: task({ prRework: rework(cause) }) }),
    );
    expect(html).toContain(text);
    expect(html).toContain("実装からやり直し");
    expect(html).not.toContain("ゴールガーディアンの見逃し 1件");
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
    expect(html).toContain("ゴールガーディアンの見逃し 1件");
  });
});
