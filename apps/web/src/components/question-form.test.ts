// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement as h } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { messagesFor } from "@/i18n";

const askQuestion = vi.fn();
vi.mock("@/lib/daemon", () => ({ askQuestion }));
vi.mock("@/i18n/server", () => ({ getMessages: async () => messagesFor("ja") }));
vi.mock("next/cache", () => ({ refresh: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/i18n/client", () => ({ useMessages: () => messagesFor("ja") }));
const { QuestionForm } = await import("./question-form");
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
let recorded: string[];
beforeEach(() => {
  recorded = [];
  askQuestion.mockReset();
  askQuestion.mockImplementation(async (_taskId, text) => {
    recorded.push(text);
    return { ok: true };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function render(blocked?: string) {
  act(() => root.render(h(QuestionForm, { taskId: "task-1", blocked })));
  return container.querySelector("textarea") as HTMLTextAreaElement;
}
function key(target: Element, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: "Enter",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}
const shortcuts = [{ ctrlKey: true }, { metaKey: true }];

describe("QuestionForm shortcuts (REQ)", () => {
  for (const shortcut of shortcuts) {
    const name = shortcut.ctrlKey ? "Ctrl" : "Meta";
    it.each(["質問です", "a".repeat(2000)])(
      `${name}+Enter sends once and clears on success (R-1/R-13/R-2/R-14): case %#`,
      async (text) => {
        const input = render();
        input.focus();
        input.value = text;
        await act(async () => {
          expect(key(input, shortcut).defaultPrevented).toBe(true);
        });
        expect(askQuestion).toHaveBeenCalledTimes(1);
        expect(askQuestion).toHaveBeenCalledWith("task-1", text);
        expect(recorded).toEqual([text]);
        expect(container.querySelector("textarea")?.value).toBe("");
      },
    );
    it(`${name}+Enter uses button required validation (R-7/R-16)`, async () => {
      const input = render();
      const invalid = vi.fn();
      input.addEventListener("invalid", invalid);
      await act(async () => {
        input.focus();
        key(input, shortcut);
      });
      expect(input.validity.valueMissing).toBe(true);
      expect(invalid).toHaveBeenCalledTimes(1);
      await act(async () => {
        container.querySelector("button")?.click();
      });
      expect(invalid).toHaveBeenCalledTimes(2);
      expect(askQuestion).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    });
    it.each([
      ["空白", " \n ", "質問を入力してください。"],
      ["接続失敗", "質問です", "デーモンに接続できません。"],
      ["拒否", "質問です", "質問は受け付けられません。"],
    ])(
      `${name}+Enter preserves text and button error for %s (R-8/R-11)`,
      async (_cause, text, message) => {
        askQuestion.mockImplementation(async () => {
          if (_cause === "接続失敗") throw new Error("offline");
          return { ok: false, message };
        });
        let input = render();
        input.value = text;
        await act(async () => {
          container.querySelector("button")?.click();
        });
        const buttonError = container.querySelector('[role="alert"]')?.textContent;
        input = container.querySelector("textarea") as HTMLTextAreaElement;
        input.focus();
        await act(async () => {
          key(input, shortcut);
        });
        expect(askQuestion).toHaveBeenCalledTimes(2);
        expect(container.querySelector("textarea")?.value).toBe(text);
        expect(container.querySelector('[role="alert"]')?.textContent).toBe(buttonError);
        expect(buttonError).toBe(
          _cause === "接続失敗" ? messagesFor("ja").common.action.daemonDown : message,
        );
        expect(recorded).toEqual([]);
      },
    );
    it.each([{ isComposing: true }, { keyCode: 229 }])(
      `${name}+Enter ignores IME events (R-6): %j`,
      async (composition) => {
        const input = render();
        input.value = "変換中";
        input.focus();
        await act(async () => {
          key(input, { ...shortcut, ...composition });
        });
        expect(askQuestion).not.toHaveBeenCalled();
        expect(recorded).toEqual([]);
      },
    );
    it(`${name}+Enter prevents repeats before and after pending render (R-10)`, async () => {
      let finish!: (result: { ok: true }) => void;
      askQuestion.mockImplementationOnce(
        (_taskId, text) =>
          new Promise((resolve) => {
            recorded.push(text);
            finish = resolve;
          }),
      );
      const input = render();
      input.value = "一度だけ";
      input.focus();
      await act(async () => {
        key(input, shortcut);
        key(input, shortcut);
        key(input, { ...shortcut, repeat: true });
      });
      expect(input.disabled).toBe(true);
      expect(container.querySelector("button")?.textContent).toBe(
        messagesFor("ja").task.chat.sending,
      );
      await act(async () => {
        key(input, shortcut);
        key(input, { ...shortcut, repeat: true });
      });
      expect(askQuestion).toHaveBeenCalledTimes(1);
      expect(recorded).toEqual(["一度だけ"]);
      await act(async () => {
        finish({ ok: true });
      });
      // useActionState が保留した action も、応答後にすべて実行させてから判定する。
      expect(askQuestion).toHaveBeenCalledTimes(1);
      expect(recorded).toEqual(["一度だけ"]);
      expect(container.querySelector("textarea")?.disabled).toBe(false);
      expect(container.querySelector("textarea")?.value).toBe("");
    });
    it.each(["中止済み", "回答待ち", "予算の上限"])(
      `${name}+Enter cannot submit blocked form: %s (R-9)`,
      async (blocked) => {
        const input = render(blocked);
        input.value = "送らない";
        const close = document.createElement("button");
        const outside = document.createElement("button");
        container.append(close, outside);
        expect(input.disabled).toBe(true);
        expect(container.querySelector("button")?.disabled).toBe(true);
        for (const target of [close, outside]) {
          target.focus();
          await act(async () => {
            key(target, shortcut);
          });
        }
        expect(askQuestion).not.toHaveBeenCalled();
        expect(recorded).toEqual([]);
      },
    );
    it(`${name}+Enter outside question field does not submit (R-12)`, async () => {
      render().value = "送らない";
      for (const tag of ["button", "a", "input"]) {
        const target = document.createElement(tag);
        if (target instanceof HTMLAnchorElement) target.href = "#answer";
        container.append(target);
        target.focus();
        await act(async () => {
          key(target, shortcut);
        });
      }
      expect(askQuestion).not.toHaveBeenCalled();
      expect(recorded).toEqual([]);
    });
  }
  it("other Enter modifier combinations keep browser defaults and never submit (R-3/R-4/R-15)", async () => {
    const input = render();
    input.value = "前後";
    input.focus();
    input.setSelectionRange(1, 1);
    for (let mask = 0; mask < 16; mask++) {
      if (mask === 1 || mask === 2) continue;
      await act(async () => {
        expect(
          key(input, {
            ctrlKey: !!(mask & 1),
            metaKey: !!(mask & 2),
            shiftKey: !!(mask & 4),
            altKey: !!(mask & 8),
          }).defaultPrevented,
        ).toBe(false);
      });
    }
    expect(askQuestion).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    expect(input.maxLength).toBe(2000);
  });
  it("documents both shortcuts in Japanese and English (R-5)", () => {
    for (const file of ["docs/user/tasks.md", "docs/user/tasks.en.md"]) {
      const section = readFileSync(file, "utf8")
        .split(/## (?:オーケストレーターに質問する|Ask the Orchestrator)/)[1]
        .split("\n## ")[0];
      expect(section).toContain("Ctrl + Enter");
      expect(section).toContain("⌘ + Enter");
    }
  });
});
