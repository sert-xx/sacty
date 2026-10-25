// @vitest-environment jsdom
import type { FinalReview, Task } from "@sacty/core";
import { type FC, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/client";
import { Implementation } from "./implementation";

/*
 * 最終レビューで、人が最終承認で確かめること（PBI-155）。作業領域では確かめられなかったことと、環境によると判断した
 * テストの失敗を出し、環境による失敗だけならテストは通ったものとして出す。
 */

const FAILURE = "processes.test.ts：起点のコミットでも同じく失敗する";

const review = (extra: Partial<FinalReview> = {}): FinalReview => ({
  passed: true,
  viewpoints: [{ viewpointId: "REQ", verified: true, reason: "検証している" }],
  remarks: [],
  summary: "所見",
  tests: { command: "npm test", exitCode: 1, output: "16 failed", environmentFailures: [FAILURE] },
  humanChecks: ["macOS の日本語入力で確かめる"],
  agentId: "g",
  runId: "r",
  costUsd: 0,
  estimated: false,
  at: "2026-10-24T10:00:00.000Z",
  ...extra,
});

const task = (lastReview: FinalReview) =>
  ({
    id: "t1",
    title: "ショートカット",
    status: "queued",
    steps: [
      { key: "requirements", state: "done" },
      { key: "implement", state: "active" },
    ],
    outputs: { implement: "# 実装の説明" },
    approved: {},
    testMap: [{ viewpointId: "REQ", tests: ["form.test.ts"] }],
    remarks: [],
    lastReview,
  }) as unknown as Task;

const render = (t: Task, locale: "ja" | "en" = "ja") =>
  renderToStaticMarkup(
    h(
      I18nProvider as unknown as FC<{ locale: "ja" | "en" }>,
      { locale },
      h(Implementation, { task: t }),
    ),
  );

describe("Implementation の人が確かめること（PBI-155）", () => {
  it("人が確かめることと環境による失敗を出し、テストは合格として出す", () => {
    const html = render(task(review()));
    expect(html).toContain("人が確かめること");
    expect(html).toContain('<li class="break-words">macOS の日本語入力で確かめる</li>');
    expect(html).toContain(`環境によると判断したテストの失敗：${FAILURE}`);
    expect(html).toContain("環境による失敗だけ");
    expect(html).not.toContain("不合格");
    expect(render(task(review()), "en")).toContain("For a person to check");
  });

  it("どちらも無ければ出さない", () => {
    const html = render(
      task(
        review({
          humanChecks: undefined,
          tests: { command: "npm test", exitCode: 0, output: "" },
        }),
      ),
    );
    expect(html).not.toContain("人が確かめること");
    expect(html).not.toContain("環境による失敗だけ");
  });
});

describe("Implementation のテストを書かずに差分で確かめる観点", () => {
  const designed = (lastReview?: FinalReview) =>
    ({
      ...task(lastReview ?? review()),
      verification: undefined,
      approved: {
        design: {
          output: "# 設計",
          testViewpoints: [
            {
              id: "TV-1",
              title: "手順の文言",
              input: "README",
              expected: "新しい手順が書かれている",
            },
          ],
        },
      },
      testMap: [{ viewpointId: "TV-1", tests: [], untested: "README の文言だけを直したため" }],
    }) as unknown as Task;

  it("テストが無いことを警告にせず、申告の理由と、ゴールガーディアンが差分で判定したことを出す", () => {
    const html = render(
      designed(
        review({
          viewpoints: [{ viewpointId: "TV-1", verified: true, reason: "差分で確かめた" }],
          tests: { command: "npm test", exitCode: 0, output: "" },
          humanChecks: undefined,
        }),
      ),
    );
    expect(html).toContain("テストなし・差分で確認（README の文言だけを直したため）");
    expect(html).toContain("差分で判定");
    expect(html).not.toContain("対応するテストがありません");
    expect(html).not.toContain("テスト合格");
    expect(render(designed(), "en")).toContain("No test; checked in the diff");
  });
});

describe("Implementation の設計の無いタスクの観点 REQ", () => {
  it("設計が無くても、実装が REQ を差分で確かめると申告したら、REQ と理由を出す", () => {
    const t = {
      ...task(
        review({
          viewpoints: [{ viewpointId: "REQ", verified: true, reason: "差分で確かめた" }],
          tests: { command: "npm test", exitCode: 0, output: "" },
          humanChecks: undefined,
        }),
      ),
      testMap: [{ viewpointId: "REQ", tests: [], untested: "README の文言だけを直したため" }],
    } as unknown as Task;
    const html = render(t);
    expect(html).toContain("受け入れ条件・タスクの目的");
    expect(html).toContain("テストなし・差分で確認（README の文言だけを直したため）");
    expect(html).toContain("差分で判定");
  });
});
