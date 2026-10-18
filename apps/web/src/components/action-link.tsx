"use client";

import { cn } from "cn";
import Link from "next/link";
import type { ComponentProps } from "react";
import { useMessages } from "@/i18n/client";

/**
 * 外部（新しいタブ）へ開くことの印。見た目は「↗」、読み上げは「新しいタブで開く」（PBI-136）。縮まないので、隣の文言を
 * 省略しても印は残る（PR #148 レビュー提案）。
 */
export function ExternalMark({ className }: { className?: string }) {
  const t = useMessages().labels.action;
  return (
    <span className={cn("ml-1 shrink-0", className)}>
      <span aria-hidden="true">↗</span>
      <span className="sr-only">{t.newTab}</span>
    </span>
  );
}

/**
 * 人が判断する場所への導線（PBI-136）。external なら GitHub の PR を新しいタブで開き（sacty の画面は残す）、そうでなければ
 * sacty の画面へ移る。labelClassName は文言だけに付ける（省略するとき。外部の印は省略の外に置き、長い文言でも残す）。
 */
export function ActionLink({
  href,
  external,
  className,
  labelClassName,
  children,
  ...rest
}: Omit<ComponentProps<"a">, "href"> & {
  href: string;
  external?: boolean;
  labelClassName?: string;
}) {
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className={cn(className, labelClassName && "flex min-w-0 items-baseline")}
        {...rest}
      >
        {labelClassName ? (
          <span className={cn("min-w-0", labelClassName)}>{children}</span>
        ) : (
          children
        )}
        <ExternalMark />
      </a>
    );
  }
  return (
    <Link href={href} className={cn(className, labelClassName)} {...rest}>
      {children}
    </Link>
  );
}
