// @vitest-environment jsdom
import { createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";
import type { Locale } from "@/i18n/locale";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let locale: Locale = "ja";
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor(locale) }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor(locale) }));

const { WithHint, Hint } = await import("./hint");
const { CardSection } = await import("@/components/card-section");
const { Dialog, DialogContent, DialogFooter } = await import("./dialog");
const { SkipLink, MAIN_ID } = await import("@/components/shell/skip-link");

// children を後ろの引数で渡す（部品の props の型は children を必須にしている）
const loose = h as unknown as (
  type: unknown,
  props: unknown,
  ...children: unknown[]
) => ReactElement;

let root: Root | undefined;
let box: HTMLElement | undefined;
function render(node: React.ReactNode) {
  box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
  act(() => root?.render(node));
}
afterEach(() => {
  act(() => root?.unmount());
  box?.remove();
  document.body.innerHTML = "";
});

const cases: [Locale, string, string, string][] = [
  ["ja", "あなたの出番", "あなたの出番の補足", "閉じる"],
  ["en", "Your turn", "Details about Your turn", "Close"],
];

describe.each(cases)("画面の言語 %s", (lang, label, hintName, closeName) => {
  it("WithHint の印の名前が、ラベルが文字列のとき何の補足か分かり、補足の文と結び付く", () => {
    locale = lang;
    render(loose(WithHint, { hint: "説明の文" }, label));
    const b = document.querySelector<HTMLElement>('[data-slot="hint"]');
    expect(b?.getAttribute("aria-label")).toBe(hintName);
    const described = document.getElementById(b?.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toBe("説明の文");
  });

  it("WithHint のラベルが文字列でないとき・じかに置いた印は「補足」のまま", () => {
    locale = lang;
    render(
      h("div", null, loose(WithHint, { hint: "a" }, h("b", null, label)), h(Hint, { text: "b" })),
    );
    const names = [...document.querySelectorAll('[data-slot="hint"]')].map((e) =>
      e.getAttribute("aria-label"),
    );
    expect(names).toEqual([messagesFor(lang).common.hint, messagesFor(lang).common.hint]);
  });

  it("CardSection の見出しの印の名前が、題が文字列のとき何の補足か分かり、aria-describedby を保つ", () => {
    locale = lang;
    render(loose(CardSection, { id: "c", title: label, hint: "説明の文" }, "中身"));
    const b = document.querySelector<HTMLElement>('[data-slot="hint"]');
    expect(b?.getAttribute("aria-label")).toBe(hintName);
    expect(document.getElementById(b?.getAttribute("aria-describedby") ?? "")?.textContent).toBe(
      "説明の文",
    );
  });

  it("ダイアログの × と DialogFooter の閉じるボタンの名前が、画面の言語に従う", () => {
    locale = lang;
    render(
      h(
        Dialog,
        { open: true },
        h(DialogContent, null, h("p", null, "本文"), h(DialogFooter, { showCloseButton: true })),
      ),
    );
    const buttons = [...document.querySelectorAll('[role="dialog"] button')];
    expect(buttons.map((e) => e.textContent)).toEqual([closeName, closeName]);
  });

  it("「本文へ移動」が言語に従い、Enter（クリック）で本文の先頭にフォーカスが移る", () => {
    locale = lang;
    render(
      h(
        "div",
        null,
        h(SkipLink),
        h("main", { id: MAIN_ID, tabIndex: -1 }, h("button", { type: "button" }, "最初の操作")),
      ),
    );
    const link = document.querySelector("a");
    expect(link?.textContent).toBe(messagesFor(lang).common.skipToMain);
    act(() => link?.click());
    expect(document.activeElement?.id).toBe(MAIN_ID);
  });
});
