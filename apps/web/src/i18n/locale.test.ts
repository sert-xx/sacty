import { describe, expect, it } from "vitest";
import { pickLocale } from "./locale";

describe("画面の言語（PBI-4b）", () => {
  it("選んだ言語があれば、それに従う", () => {
    expect(pickLocale("en", "ja,en;q=0.8")).toBe("en");
    expect(pickLocale("ja", "en-US")).toBe("ja");
  });

  it("選んでいなければ、ブラウザの言語の優先順に従う", () => {
    expect(pickLocale(undefined, "ja-JP,ja;q=0.9,en;q=0.8")).toBe("ja");
    expect(pickLocale(undefined, "en-US,en;q=0.9,ja;q=0.8")).toBe("en");
    expect(pickLocale(undefined, "en;q=0.5,ja;q=0.9")).toBe("ja");
    expect(pickLocale(undefined, "fr-FR,fr;q=0.9")).toBe("en");
    expect(pickLocale(undefined, "fr-FR,ja;q=0.5")).toBe("ja");
    expect(pickLocale("system", null)).toBe("ja");
    expect(pickLocale(undefined, "")).toBe("ja");
  });
});
