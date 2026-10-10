"use client";

import { cn } from "cn";
import { ListChecksIcon, SlidersHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  {
    href: "/",
    label: "タスク",
    icon: ListChecksIcon,
    active: (p: string) => p === "/" || p.startsWith("/tasks"),
  },
  {
    href: "/projects/current",
    label: "設定",
    icon: SlidersHorizontalIcon,
    active: (p: string) => p.startsWith("/projects"),
  },
];

/** サイドメニュー。表示中の画面を強調する。 */
export function AppRail() {
  return <RailNav pathname={usePathname()} />;
}

/** サイドメニュー。アイコンの下に小さく名称を出す（pathname が無ければ強調しない）。 */
export function RailNav({ pathname }: { pathname?: string }) {
  return (
    <nav
      aria-label="メイン"
      className="sticky top-16 flex h-[calc(100dvh-4rem)] w-[68px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-chrome px-1 py-2 sm:w-[88px] sm:px-1.5 sm:py-3"
    >
      {ITEMS.map((item) => {
        const on = pathname !== undefined && item.active(pathname);
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={on ? "page" : undefined}
            className={cn(
              "flex flex-col items-center gap-1 rounded-[10px] px-0.5 pt-2.5 pb-2 text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
              on && "bg-accent text-accent-foreground hover:bg-accent",
            )}
          >
            <Icon aria-hidden="true" className="size-5" strokeWidth={1.8} />
            <span
              className={cn(
                "text-center text-[10px] leading-tight sm:text-[11px]",
                on && "font-semibold",
              )}
            >
              {item.label}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
