import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const { messagesFor } = require("../../apps/desktop/messages.cjs");

async function setup(locale: string) {
  const dom = new JSDOM(readFileSync("apps/desktop/setup.html", "utf8"), {
    runScripts: "outside-only",
  });
  const bridge = {
    settings: async () => ({ locale, messages: messagesFor(locale) }),
    language: vi.fn(async (value: string) => ({ locale: value, messages: messagesFor(value) })),
    onProgress: vi.fn(),
    start: vi.fn(async () => ({
      ok: false,
      message: "Startup test error",
      diagnostics: "Error: EADDRINUSE 4700",
    })),
    saveKey: vi.fn(async () => ({ ok: true })),
    help: vi.fn(),
  };
  Object.assign(dom.window, { desktop: bridge });
  dom.window.eval(readFileSync("apps/desktop/setup.js", "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { dom, bridge, document: dom.window.document };
}

describe("localized desktop setup", () => {
  it.each(["ja", "en"])("renders localized labels in %s", async (locale) => {
    const f = await setup(locale);
    try {
      expect(f.document.documentElement.lang).toBe(locale);
      expect(f.document.querySelector("#start")?.textContent).toBe(messagesFor(locale).start);
      expect(f.document.querySelector("main")?.hidden).toBe(false);
      expect(f.document.title).toBe(messagesFor(locale).title);
    } finally {
      f.dom.window.close();
    }
  });
  it("switches language and restores controls after an error", async () => {
    const f = await setup("ja");
    try {
      const select = f.document.querySelector("#language") as HTMLSelectElement;
      select.value = "en";
      select.dispatchEvent(new f.dom.window.Event("change"));
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.bridge.language).toHaveBeenCalledWith("en");
      expect(f.document.documentElement.lang).toBe("en");
      const start = f.document.querySelector("#start") as HTMLButtonElement;
      start.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.document.querySelector("#status")?.textContent).toBe("Startup test error");
      expect(f.document.querySelector("#diagnostics")?.hidden).toBe(false);
      expect(f.document.querySelector("#diagnostic-output")?.textContent).toContain("EADDRINUSE");
      expect(start.disabled).toBe(false);
      expect(select.disabled).toBe(false);
    } finally {
      f.dom.window.close();
    }
  });
  it("renders diagnostic output as text and clears it before retry", async () => {
    const f = await setup("ja");
    try {
      const diagnostics = '<img src=x onerror="alert(1)"> EADDRINUSE';
      f.bridge.start.mockResolvedValueOnce({ ok: false, message: "Failed", diagnostics });
      const start = f.document.querySelector("#start") as HTMLButtonElement;
      start.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(f.document.querySelector("#diagnostic-output")?.textContent).toBe(diagnostics);
      expect(f.document.querySelector("#diagnostic-output img")).toBeNull();
      start.click();
      expect(f.document.querySelector("#diagnostics")?.hidden).toBe(true);
      expect(f.document.querySelector("#diagnostic-output")?.textContent).toBe("");
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      f.dom.window.close();
    }
  });
  it("opens a hint with keyboard focus and closes it with Escape", async () => {
    const f = await setup("en");
    try {
      const button = f.document.querySelector(".hint") as HTMLButtonElement;
      const hint = f.document.getElementById(button.getAttribute("aria-describedby") ?? "");
      button.focus();
      expect(hint?.hidden).toBe(false);
      button.dispatchEvent(new f.dom.window.KeyboardEvent("keydown", { key: "Escape" }));
      expect(hint?.hidden).toBe(true);
    } finally {
      f.dom.window.close();
    }
  });
});
