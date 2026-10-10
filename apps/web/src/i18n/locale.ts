/** 画面の言語。エージェントの成果物の言語とは関係しない（成果物は書かれた言語のまま表示する）。 */
export type Locale = "ja" | "en";
export const LOCALES: readonly Locale[] = ["ja", "en"];

/** 利用者が選んだ言語（system は、ブラウザの言語に従う）。 */
export type LanguagePreference = Locale | "system";

/** 選んだ言語を覚えておく cookie（無ければシステムに従う）。 */
export const LANG_COOKIE = "sacty-lang";

export function isLocale(value: unknown): value is Locale {
  return value === "ja" || value === "en";
}

/**
 * 画面の言語を決める。選んだ言語があればそれ、無ければブラウザの言語（Accept-Language）で
 * 日本語が英語より優先されていれば日本語、それ以外は英語。
 */
export function pickLocale(preference: string | undefined, acceptLanguage: string | null): Locale {
  if (isLocale(preference)) return preference;
  const ranked = (acceptLanguage ?? "")
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const quality = q ? Number(q.slice(2)) : 1;
      return { tag: tag.toLowerCase(), quality: Number.isFinite(quality) ? quality : 0, index };
    })
    .filter((x) => x.tag && x.quality > 0)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const { tag } of ranked) {
    if (tag === "ja" || tag.startsWith("ja-")) return "ja";
    if (tag === "en" || tag.startsWith("en-")) return "en";
  }
  return ranked.length === 0 ? "ja" : "en";
}
