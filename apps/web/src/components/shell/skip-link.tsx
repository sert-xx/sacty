"use client";

import { useMessages } from "@/i18n/client";

/** 本文（`<main>`）の id。 */
export const MAIN_ID = "main-content";

/**
 * 本文へ移動するリンク。ページを開いて最初の Tab で見え、Enter で本文の先頭にフォーカスが移る
 * （次の Tab は本文の最初の操作に止まる）。フォーカスが無い間は見えない（sr-only）。
 */
export function SkipLink() {
  const m = useMessages().common;
  return (
    <a
      href={`#${MAIN_ID}`}
      onClick={(e) => {
        // フォーカスを本文の先頭に移す（ハッシュの移動だけでは、移動先にフォーカスが移らない版がある）
        const main = document.getElementById(MAIN_ID);
        if (!main) return;
        e.preventDefault();
        main.focus();
      }}
      className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:ring-2 focus:ring-ring"
    >
      {m.skipToMain}
    </a>
  );
}
