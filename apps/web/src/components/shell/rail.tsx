"use client";

import { cn } from "cn";
import { LayoutDashboardIcon, ListChecksIcon, SlidersHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMessages } from "@/i18n/client";
import { pageScope } from "@/lib/page-scope";
import {
  CURRENT_PROJECT_SETTINGS_PATH,
  CURRENT_PROJECT_TASKS_PATH,
  DASHBOARD_PATH,
  PROJECTS_PATH,
} from "@/lib/paths";

/** プロジェクトのタスクの一覧の画面か（`/projects/<ID>/tasks`。PBI-114）。 */
const PROJECT_TASKS = /^\/projects\/[^/]+\/tasks(\/|$)/;

const DASHBOARD = {
  href: DASHBOARD_PATH,
  key: "dashboard" as const,
  icon: LayoutDashboardIcon,
  active: (p: string) => p === DASHBOARD_PATH || p === "/",
};
const TASKS = {
  href: CURRENT_PROJECT_TASKS_PATH,
  key: "tasks" as const,
  icon: ListChecksIcon,
  active: (p: string) =>
    PROJECT_TASKS.test(p) || p === CURRENT_PROJECT_TASKS_PATH || p.startsWith("/tasks"),
};
const SETTINGS = {
  href: CURRENT_PROJECT_SETTINGS_PATH,
  key: "settings" as const,
  icon: SlidersHorizontalIcon,
  active: (p: string) =>
    (p === "/projects" || p.startsWith("/projects/")) &&
    !PROJECT_TASKS.test(p) &&
    p !== CURRENT_PROJECT_TASKS_PATH,
};

/**
 * サイドメニューの項目（PBI-114）。プロジェクトの画面では、タスク・設定は表示しているプロジェクト（cookie。画面が合わせる）
 * の画面へ移る。「すべてのプロジェクト」の画面（ダッシュボードなど）では、プロジェクトを決められないので、タスクを出さず、
 * 設定はプロジェクトの一覧へ移る（どのプロジェクトにも飛ばない）。
 */
export function railItems(pathname: string | undefined) {
  if (pathname !== undefined && pageScope(pathname).kind === "all") {
    return [DASHBOARD, { ...SETTINGS, href: PROJECTS_PATH }];
  }
  return [DASHBOARD, TASKS, SETTINGS];
}

/** サイドメニュー。表示中の画面を強調する。 */
export function AppRail() {
  return <RailNav pathname={usePathname()} />;
}

/** サイドメニュー。アイコンの下に小さく名称を出す（pathname が無ければ強調しない）。 */
export function RailNav({ pathname }: { pathname?: string }) {
  const t = useMessages().shell.nav;
  return (
    <nav
      aria-label={t.main}
      className="sticky top-16 flex h-[calc(100dvh-4rem)] w-[68px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-border bg-chrome px-1 py-2 sm:w-[88px] sm:px-1.5 sm:py-3"
    >
      {railItems(pathname).map((item) => {
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
              {t[item.key]}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
