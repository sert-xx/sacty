"use client";

import { createContext, useContext, useEffect, useMemo } from "react";
import { messagesFor } from "./index";
import type { Locale } from "./locale";

const LocaleContext = createContext<Locale>("ja");

/** クライアントのコンポーネントに、画面の言語を渡す（サーバーで決めた言語）。 */
export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  // <html lang> は最初の描画ではサーバーで決められないので、ここで合わせる
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export function useLocale(): Locale {
  return useContext(LocaleContext);
}

/** 画面の言語の文言（クライアントのコンポーネント用）。 */
export function useMessages() {
  const locale = useLocale();
  return useMemo(() => messagesFor(locale), [locale]);
}
