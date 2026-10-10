import { cookies, headers } from "next/headers";
import { messagesFor } from "./index";
import { isLocale, LANG_COOKIE, type LanguagePreference, type Locale, pickLocale } from "./locale";

/** 選んだ言語（cookie）。サーバー側でだけ使う。 */
export async function languagePreference(): Promise<LanguagePreference> {
  const value = (await cookies()).get(LANG_COOKIE)?.value;
  return isLocale(value) ? value : "system";
}

/** 画面の言語。サーバー側でだけ使う（cookie とリクエストの言語を読むので、Suspense の中で呼ぶ）。 */
export async function getLocale(): Promise<Locale> {
  const [preference, list] = await Promise.all([languagePreference(), headers()]);
  return pickLocale(preference === "system" ? undefined : preference, list.get("accept-language"));
}

/** 画面の言語の文言。 */
export async function getMessages() {
  return messagesFor(await getLocale());
}
