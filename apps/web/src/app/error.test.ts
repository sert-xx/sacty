// @vitest-environment jsdom
import { createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
const { default: ErrorPage } = await import("./error");
const { default: GlobalError } = await import("./global-error");

describe.each([
  ["ja", "表示できませんでした", "読み直す"],
  ["en", "Could not display this page", "Reload"],
] as const)("描画の例外（画面の言語 %s）", (lang, title, retryName) => {
  it("例外の文を出さず、読み直す操作を出し、押すと retry を呼ぶ", () => {
    locale = lang;
    const retry = vi.fn();
    const box = document.createElement("div");
    document.body.append(box);
    const root = createRoot(box);
    const secret = new Error("SECRET /srv/path stack");
    act(() => root.render(h(ErrorPage, { error: secret, retry })));
    expect(box.textContent).toContain(title);
    expect(box.textContent).not.toContain("SECRET");
    expect(box.textContent).not.toContain("/srv/path");
    act(() => box.querySelector("button")?.click());
    expect(retry).toHaveBeenCalledTimes(1);
    expect(box.querySelector("button")?.textContent).toBe(retryName);
    act(() => root.unmount());
    box.remove();
  });
});

describe("global-error", () => {
  it("日本語に固定で、例外の文を出さず、読み直す操作を出す", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup(
      h(GlobalError, { error: new Error("SECRET"), retry: () => {} }),
    );
    expect(html).toContain("表示できませんでした");
    expect(html).toContain("読み直す");
    expect(html).not.toContain("SECRET");
  });
});
