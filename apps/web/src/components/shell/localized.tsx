import { I18nProvider } from "@/i18n/client";
import { getLocale } from "@/i18n/server";

/**
 * 画面の言語を決めて、クライアントのコンポーネントに渡す。言語は cookie とリクエストから決まるので、
 * Suspense の中に置く。
 */
export async function Localized({ children }: { children: React.ReactNode }) {
  return <I18nProvider locale={await getLocale()}>{children}</I18nProvider>;
}
