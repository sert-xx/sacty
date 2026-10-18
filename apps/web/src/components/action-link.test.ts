// @vitest-environment jsdom
import { type FC, createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n/client";
import { ActionLink } from "./action-link";

/*
 * 人が判断する場所への導線（PBI-136）。GitHub の PR は新しいタブで開き、sacty の画面は残す。
 */

const render = (props: { href: string; external?: boolean }, locale: "ja" | "en" = "ja") =>
  renderToStaticMarkup(
    h(
      I18nProvider as unknown as FC<{ locale: "ja" | "en" }>,
      { locale },
      h(ActionLink, props, "チェックする"),
    ),
  );

describe("ActionLink", () => {
  it("外部（PR）なら、新しいタブで開き、外部へ移ることを見た目と読み上げで示す", () => {
    const html = render({ href: "https://github.com/acme/app/pull/12", external: true });
    expect(html).toContain('href="https://github.com/acme/app/pull/12"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain("↗");
    expect(html).toContain("（新しいタブで開く）");
    expect(render({ href: "https://github.com/x", external: true }, "en")).toContain(
      "(opens in a new tab)",
    );
  });

  it("sacty の画面なら、同じタブで移る（新しいタブの指定も印も無い）", () => {
    const html = render({ href: "/tasks/t1/review" });
    expect(html).toContain('href="/tasks/t1/review"');
    expect(html).not.toContain("target=");
    expect(html).not.toContain("↗");
  });
});

describe("文言を省略するとき（PR #148 レビュー提案）", () => {
  it("外部なら、省略は文言だけに付け、印はその外（省略されない）に置く", () => {
    const html = renderToStaticMarkup(
      h(
        I18nProvider as unknown as FC<{ locale: "ja" }>,
        { locale: "ja" },
        h(
          ActionLink,
          { href: "https://github.com/x", external: true, labelClassName: "truncate" },
          "長い題",
        ),
      ),
    );
    const doc = new DOMParser().parseFromString(html, "text/html");
    const label = doc.querySelector(".truncate");
    expect(label?.textContent).toBe("長い題");
    expect(label?.textContent).not.toContain("↗");
    expect(doc.querySelector("a")?.textContent).toContain("↗");
  });

  it("sacty の画面へのリンクは、今までどおり文言ごとリンクを省略する", () => {
    const html = renderToStaticMarkup(
      h(
        I18nProvider as unknown as FC<{ locale: "ja" }>,
        { locale: "ja" },
        h(
          ActionLink,
          { href: "/tasks/t1", labelClassName: "truncate", className: "font-medium" },
          "長い題",
        ),
      ),
    );
    expect(html).toContain('class="font-medium truncate"');
  });
});
