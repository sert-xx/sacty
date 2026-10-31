import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { messages, pickLocale, text } = require("../../apps/desktop/messages.cjs");
describe("desktop wording policy", () => {
  it("uses Japanese or English according to the language selection", () => {
    expect(pickLocale("ja-JP")).toBe("ja");
    expect(pickLocale("en-US")).toBe("en");
    expect(pickLocale("fr")).toBe("en");
    expect(text("en", "start")).toBe("Open Sacty");
    expect(text("ja", "start")).toBe("Sacty を開く");
  });
  it("has matching dictionary keys and placeholders", () => {
    expect(Object.keys(messages.ja).sort()).toEqual(Object.keys(messages.en).sort());
    for (const key of Object.keys(messages.ja))
      expect(messages.ja[key].match(/\{\w+\}/g) || []).toEqual(
        messages.en[key].match(/\{\w+\}/g) || [],
      );
  });
  it("keeps body and hints within the repository limits", () => {
    for (const locale of ["ja", "en"])
      for (const [key, value] of Object.entries(messages[locale]) as [string, string][]) {
        const limit = key.endsWith("Hint")
          ? locale === "ja"
            ? 150
            : 320
          : locale === "ja"
            ? 60
            : 130;
        expect(value.length, `${locale}.${key}`).toBeLessThanOrEqual(limit);
        expect(value, `${locale}.${key}`).not.toContain("\n");
        expect(value, `${locale}.${key}`).not.toMatch(/\bsacty\b/);
      }
  });
  it("binds setup labels and hints to the bilingual dictionary", () => {
    const html = readFileSync("apps/desktop/setup.html", "utf8");
    for (const match of html.matchAll(/data-i18n(?:-aria)?="([^"]+)"/g))
      expect(messages.ja[match[1]]).toBeTypeOf("string");
    expect(html).toContain('role="tooltip"');
    expect(html).not.toContain("起動する");
  });
});
