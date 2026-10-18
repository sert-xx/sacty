"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import { useMessages } from "@/i18n/client";

/** 外部（新しいタブ）へ開くことの印。見た目は「↗」、読み上げは「新しいタブで開く」（PBI-136）。 */
export function ExternalMark() {
  const t = useMessages().labels.action;
  return (
    <>
      <span aria-hidden="true"> ↗</span>
      <span className="sr-only">{t.newTab}</span>
    </>
  );
}

/**
 * 人が判断する場所への導線（PBI-136）。external なら GitHub の PR を新しいタブで開き（sacty の画面は残す）、そうでなければ
 * sacty の画面へ移る。
 */
export function ActionLink({
  href,
  external,
  children,
  ...rest
}: Omit<ComponentProps<"a">, "href"> & { href: string; external?: boolean }) {
  if (external) {
    return (
      <a href={href} target="_blank" rel="noreferrer" {...rest}>
        {children}
        <ExternalMark />
      </a>
    );
  }
  return (
    <Link href={href} {...rest}>
      {children}
    </Link>
  );
}
