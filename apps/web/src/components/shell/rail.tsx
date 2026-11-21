"use client";

import { cn } from "cn";
import {
  CalendarClockIcon,
  ListChecksIcon,
  ScanSearchIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMessages } from "@/i18n/client";
import { pageScope } from "@/lib/page-scope";
import {
  CURRENT_PROJECT_AUDIT_PATH,
  CURRENT_PROJECT_SCHEDULES_PATH,
  CURRENT_PROJECT_SETTINGS_PATH,
  CURRENT_PROJECT_TASKS_PATH,
  PROJECTS_PATH,
} from "@/lib/paths";

/** プロジェクトのタスクの一覧の画面か（`/projects/<ID>/tasks`。PBI-114）。 */
const PROJECT_TASKS = /^\/projects\/[^/]+\/tasks(\/|$)/;
/** プロジェクトの監査の画面か（`/projects/<ID>/audit`。PBI-124）。 */
const PROJECT_AUDIT = /^\/projects\/[^/]+\/audit(\/|$)/;
/** プロジェクトのスケジュールタスクの画面か（`/projects/<ID>/schedules`）。 */
const PROJECT_SCHEDULES = /^\/projects\/[^/]+\/schedules(\/|$)/;

const TASKS = {
  href: CURRENT_PROJECT_TASKS_PATH,
  key: "tasks" as const,
  icon: ListChecksIcon,
  active: (p: string) =>
    PROJECT_TASKS.test(p) || p === CURRENT_PROJECT_TASKS_PATH || p.startsWith("/tasks"),
};
const SCHEDULES = {
  href: CURRENT_PROJECT_SCHEDULES_PATH,
  key: "schedules" as const,
  icon: CalendarClockIcon,
  active: (p: string) => PROJECT_SCHEDULES.test(p) || p === CURRENT_PROJECT_SCHEDULES_PATH,
};
const AUDIT = {
  href: CURRENT_PROJECT_AUDIT_PATH,
  key: "audit" as const,
  icon: ScanSearchIcon,
  active: (p: string) => PROJECT_AUDIT.test(p) || p === CURRENT_PROJECT_AUDIT_PATH,
};
const SETTINGS = {
  href: CURRENT_PROJECT_SETTINGS_PATH,
  key: "settings" as const,
  icon: SlidersHorizontalIcon,
  active: (p: string) =>
    (p === "/projects" || p.startsWith("/projects/")) &&
    !PROJECT_TASKS.test(p) &&
    !PROJECT_AUDIT.test(p) &&
    !PROJECT_SCHEDULES.test(p) &&
    p !== CURRENT_PROJECT_TASKS_PATH &&
    p !== CURRENT_PROJECT_SCHEDULES_PATH &&
    p !== CURRENT_PROJECT_AUDIT_PATH,
};

/**
 * サイドメニューの項目（PBI-114）。プロジェクトの画面では、タスク・スケジュールタスク・監査・設定は表示しているプロジェクト（cookie。画面が
 * 合わせる）の画面へ移る。「すべてのプロジェクト」の画面（ダッシュボードなど）では、プロジェクトを決められないので、タスク・
 * スケジュールタスク・監査を出さず、設定はプロジェクトの一覧へ移る（どのプロジェクトにも飛ばない）。ダッシュボードは出さない（使わないため。画面は
 * ロゴ・プロジェクトの切り替えから開ける。PBI-141）。
 */
export function railItems(pathname: string | undefined) {
  if (pathname !== undefined && pageScope(pathname).kind === "all") {
    return [{ ...SETTINGS, href: PROJECTS_PATH }];
  }
  return [TASKS, SCHEDULES, AUDIT, SETTINGS];
}

/** サイドメニュー。表示中の画面を強調する。 */
export function AppRail() {
  return <RailNav pathname={usePathname()} />;
}

/**
 * サイドメニュー。アイコンの下に小さく名称を出す（pathname が無ければ強調しない）。幅 640px 未満では、左の列にせず、
 * 画面の下に固定した横並びにする（ホームバーの分は safe-area で空ける）。nav は 1 つだけで、配置は CSS で変える。
 */
export function RailNav({ pathname }: { pathname?: string }) {
  const t = useMessages().shell.nav;
  return (
    <nav
      aria-label={t.main}
      className="fixed inset-x-0 bottom-0 z-30 flex h-[calc(3.5rem+env(safe-area-inset-bottom))] shrink-0 flex-row gap-1 border-t border-border bg-chrome pt-1 pr-[max(0.25rem,env(safe-area-inset-right))] pb-[env(safe-area-inset-bottom)] pl-[max(0.25rem,env(safe-area-inset-left))] sm:sticky sm:inset-x-auto sm:top-16 sm:bottom-auto sm:z-auto sm:h-[calc(100dvh-4rem)] sm:w-[calc(88px+env(safe-area-inset-left))] sm:flex-col sm:overflow-y-auto sm:border-t-0 sm:border-r sm:py-3 sm:pr-1.5 sm:pl-[calc(0.375rem+env(safe-area-inset-left))]"
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
              "flex min-h-11 min-w-11 flex-1 flex-col items-center justify-center gap-0.5 rounded-[10px] px-0.5 text-muted-foreground outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring sm:flex-none sm:justify-start sm:gap-1 sm:pt-2.5 sm:pb-2",
              on && "bg-accent text-accent-foreground hover:bg-accent",
            )}
          >
            <Icon aria-hidden="true" className="size-5" strokeWidth={1.8} />
            <span
              className={cn(
                // 名称の中で折り返すのは、幅の無い空白（\u200b）の所だけにする
                "text-center text-[10px] leading-tight [word-break:keep-all] sm:text-[11px]",
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
