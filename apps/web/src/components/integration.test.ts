// @vitest-environment jsdom
import type { IntegrationReview, Task } from "@sacty/core";
import { type FC, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/client";
import { IntegrationResult } from "./integration";

/* 統合レビューで、人が承認で確かめること（PBI-363）。作業領域では確かめられなかったことを、合格の結果と一緒に出す。 */

const CHECK = "実際の決済サービスで、画面から決済が通ること";

const review = (extra: Partial<IntegrationReview> = {}): IntegrationReview => ({
  passed: true,
  baseBranch: "main",
  commit: "abcdef1234",
  viewpoints: [{ viewpointId: "TV-1", verified: true, reason: "コードとテストで確かめた" }],
  remarks: [],
  findings: [],
  summary: "要求要件を満たす",
  at: "2026-11-17T10:00:00.000Z",
  ...extra,
});

const task = (integration: IntegrationReview) =>
  ({
    id: "t1",
    title: "決済をまるごと作る",
    status: "awaiting_approval",
    steps: [
      { key: "split", state: "done" },
      { key: "integrate", state: "active" },
    ],
    outputs: { integrate: "# 統合できている" },
    approved: {},
    integration,
    integrationFailures: 0,
  }) as unknown as Task;

const render = (t: Task, locale: "ja" | "en" = "ja") =>
  renderToStaticMarkup(
    h(
      I18nProvider as unknown as FC<{ locale: "ja" | "en" }>,
      { locale },
      h(IntegrationResult, { task: t }),
    ),
  );

describe("統合レビューの人が確かめること（PBI-363）", () => {
  it("合格の結果と一緒に、人が確かめることを出す", () => {
    const html = render(task(review({ humanChecks: [CHECK, "実機で読み取れること"] })));
    expect(html).toContain('data-testid="integration-human-checks"');
    expect(html).toContain("人が確かめること");
    expect(html).toContain(`<li class="break-words">${CHECK}</li>`);
    expect(html).toContain('<li class="break-words">実機で読み取れること</li>');
    expect(html).toContain("合格");
    expect(html).not.toContain("不合格");
  });

  it("前の回の項目から外したものがあれば、外した項目として出す。無ければ出さない", () => {
    const html = render(
      task(review({ humanChecks: [CHECK], droppedHumanChecks: ["実機で読み取れること"] })),
    );
    expect(html).toContain('data-testid="integration-dropped-human-checks"');
    expect(html).toContain("外した項目");
    expect(html).toContain('<li class="break-words">実機で読み取れること</li>');
    expect(render(task(review({ humanChecks: [CHECK] })))).not.toContain(
      "integration-dropped-human-checks",
    );
    expect(render(task(review({ droppedHumanChecks: ["実機で読み取れること"] })), "en")).toContain(
      "Items removed from the previous round",
    );
  });

  it("不合格の結果にも、足りないことと一緒に、人が確かめることを出す", () => {
    const html = render(
      task(
        review({
          passed: false,
          findings: ["画面の送信ボタンから決済の API を呼ぶ"],
          humanChecks: [CHECK],
        }),
      ),
    );
    expect(html).toContain("不合格");
    expect(html).toContain("画面の送信ボタンから決済の API を呼ぶ");
    expect(html).toContain('data-testid="integration-human-checks"');
    expect(html).toContain(`<li class="break-words">${CHECK}</li>`);
  });

  it("英語の画面でも出す", () => {
    const html = render(task(review({ humanChecks: [CHECK] })), "en");
    expect(html).toContain("For a person to check");
    expect(html).toContain(CHECK);
  });

  it("無ければ出さない（以前の版の記録・空の一覧）", () => {
    for (const r of [review(), review({ humanChecks: [] })]) {
      const html = render(task(r));
      expect(html).not.toContain("integration-human-checks");
      expect(html).not.toContain("人が確かめること");
    }
  });
});
