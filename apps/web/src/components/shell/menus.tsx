"use client";

import { Menu } from "@base-ui/react/menu";
import { PERSON_TURN_GROUPS, type PersonTurnGroup } from "@sacty/core";
import { cn } from "cn";
import { BellIcon, ChevronDownIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useState, useTransition } from "react";
import { setLanguageAction } from "@/app/actions";
import { useMessages } from "@/i18n/client";
import type { LanguagePreference } from "@/i18n/locale";
import { durationText } from "@/lib/duration-text";
import { DASHBOARD_PATH, projectTasksPath, switchPath } from "@/lib/paths";
import { applyTheme, readTheme, type ThemePreference, writeTheme } from "@/lib/theme";
import { useClock } from "@/lib/use-clock";
import { ExternalMark } from "../action-link";

// 重なりの順は Positioner に付ける。Positioner は位置を transform で決めるので、それ自体が重なりの文脈を作り、
// 中の Popup に付けた z-index はその外に効かない（タスク詳細の sticky な見出しの下に隠れていた。PBI-321）
const POSITIONER = "z-50";
const POPUP =
  "max-h-[min(70dvh,32rem)] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none";
const ITEM =
  "flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none data-highlighted:bg-accent data-highlighted:text-accent-foreground";
const TRIGGER =
  "relative inline-flex h-11 items-center justify-center rounded-lg border border-border bg-chrome outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-muted";

function Count({ n, className }: { n: number; className?: string }) {
  if (n === 0) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-5 items-center justify-center rounded-full bg-warn px-1.5 text-[11px] leading-5 font-bold text-white dark:text-background",
        className,
      )}
    >
      {n}
    </span>
  );
}

export type ProjectOption = { id: string; name: string; needsYou: number };

/**
 * プロジェクトの切り替え。プロジェクトごとに、人間の対応待ちの件数を出す。先頭の「すべてのプロジェクト」はダッシュボード
 * へ、個別のプロジェクトはそのタスクの一覧へ移る（PBI-114）。current は開いている画面のプロジェクト（null なら
 * 「すべてのプロジェクト」。件数はすべてのプロジェクトの合計）。
 */
export function ProjectMenu({
  projects,
  current,
}: {
  projects: ProjectOption[];
  current: ProjectOption | null;
}) {
  const t = useMessages().shell.project;
  const name = current ? current.name : t.all;
  const count = current ? current.needsYou : projects.reduce((n, p) => n + p.needsYou, 0);
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(TRIGGER, "min-w-0 gap-2.5 px-3")}
        aria-label={t.trigger(name)}
        data-testid="project-menu"
      >
        <span className="flex min-w-0 flex-col text-left leading-tight">
          <span className="text-[11px] text-muted-foreground">{t.label}</span>
          <span className="truncate text-sm font-semibold">{name}</span>
        </span>
        <Count n={count} />
        <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="start" className={POSITIONER}>
          <Menu.Popup className={cn(POPUP, "w-72 p-1.5")}>
            <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">{t.switch}</p>
            <Menu.LinkItem
              href={DASHBOARD_PATH}
              className={cn(ITEM, "min-h-11", current === null && "font-semibold")}
              aria-current={current === null ? "true" : undefined}
            >
              {t.all}
            </Menu.LinkItem>
            <Menu.Separator className="my-1 h-px bg-border" />
            {projects.map((p) => (
              <Menu.LinkItem
                key={p.id}
                href={switchPath(p.id, projectTasksPath(p.id))}
                className={cn(
                  ITEM,
                  "min-h-11 justify-between",
                  p.id === current?.id && "font-semibold",
                )}
                aria-current={p.id === current?.id ? "true" : undefined}
              >
                <span className="truncate">{p.name}</span>
                {p.needsYou > 0 ? (
                  <span className="text-xs whitespace-nowrap text-warn">
                    {t.needsYou(p.needsYou)}
                  </span>
                ) : null}
              </Menu.LinkItem>
            ))}
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.LinkItem href="/projects" className={ITEM}>
              {t.manage}
            </Menu.LinkItem>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

export type Notice = {
  taskId: string;
  title: string;
  projectId: string;
  projectName: string;
  status: string;
  /** どちらの組か（上の組：decision、下の組：paused。PBI-442）。 */
  group: PersonTurnGroup;
  /** 待ち始めた時刻（ISO 8601）。待っている時間は画面の時計で計算する。 */
  waitingSince: string;
  href: string;
  /** href が GitHub の PR（プロジェクトを切り替えず、新しいタブで開く。PBI-136）。 */
  external?: true;
};

/**
 * お知らせ：全プロジェクトの、人間の対応待ち。ダッシュボードの「あなたの出番」と同じ対象・同じ並び（上の組：判断すれば
 * 進むもの → 下の組：一時停止。組の中は待ち始めの古い順）で、組の見出しを付けて出す（PBI-442）。表示中のプロジェクトで
 * 分けない。開くと、そのタスクのプロジェクトに切り替える。
 */
export function NotificationsMenu({ notices }: { notices: Notice[] }) {
  const t = useMessages().shell.notices;
  const duration = useMessages().dashboard.duration;
  const now = useClock();
  const total = notices.length;
  const item = (n: Notice) => (
    <Menu.LinkItem
      key={n.taskId}
      {...(n.external
        ? { href: n.href, target: "_blank", rel: "noreferrer" }
        : { href: switchPath(n.projectId, n.href) })}
      className={cn(ITEM, "flex-col items-start gap-0.5 border-t border-border first:border-t-0")}
    >
      <span className="text-xs font-semibold text-warn">{n.status}</span>
      {/* 題だけを省略し、外部の印は省略の外に置く（長い題でも残す。PR #148 レビュー提案） */}
      <span className="flex w-full min-w-0 items-start font-medium">
        <span className="line-clamp-2 min-w-0">{n.title}</span>
        {n.external && <ExternalMark />}
      </span>
      <span className="flex w-full items-center justify-between gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{n.projectName}</span>
        {/* 待っている時間は画面の時計で計算するので、サーバーと数秒ずれても描き直さない */}
        <span
          data-testid={`notice-waiting-${n.taskId}`}
          className="shrink-0 tabular-nums"
          suppressHydrationWarning
        >
          <span className="sr-only">{t.waiting}</span>
          {durationText(now - Date.parse(n.waitingSince), duration)}
        </span>
      </span>
    </Menu.LinkItem>
  );
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(TRIGGER, "w-11")}
        aria-label={total > 0 ? t.labelWithCount(total) : t.label}
      >
        <BellIcon aria-hidden="true" className="size-5" />
        <Count n={total} className="absolute -top-1.5 -right-1.5 border-2 border-chrome" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className={POSITIONER}>
          <Menu.Popup className={cn(POPUP, "w-80 p-1.5")}>
            <p className="flex items-center justify-between px-3 pt-2 pb-1 text-sm font-semibold">
              {t.title}
              <span className="text-xs font-normal text-muted-foreground">{t.total(total)}</span>
            </p>
            {total === 0 && <p className="px-3 py-4 text-sm text-muted-foreground">{t.none}</p>}
            {PERSON_TURN_GROUPS.map((group) => {
              const inGroup = notices.filter((n) => n.group === group);
              if (inGroup.length === 0) return null;
              return (
                <Menu.Group key={group} data-testid={`notices-${group}`}>
                  <Menu.GroupLabel className="mt-1 rounded-md bg-muted px-3 py-1 text-[11px] text-muted-foreground">
                    {t.groups[group]}
                  </Menu.GroupLabel>
                  {inGroup.map(item)}
                </Menu.Group>
              );
            })}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const THEMES: ThemePreference[] = ["system", "light", "dark"];
const LANGUAGES: LanguagePreference[] = ["system", "ja", "en"];

/**
 * ユーザーメニュー：テーマ（システムに従う・ライト・ダーク）と言語（システムに従う・日本語・英語）。
 * 言語はサーバーで描画する文言にも効くので cookie に保存し、画面を描き直す。
 */
export function UserMenu({ language }: { language: LanguagePreference }) {
  const t = useMessages().shell.user;
  const [theme, setTheme] = useState<ThemePreference>("system");
  const [, startTransition] = useTransition();
  useEffect(() => setTheme(readTheme()), []);
  // システムに従うときは、OS の設定の変更にもついていく
  useEffect(() => {
    if (theme !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [theme]);

  return (
    <Menu.Root>
      <Menu.Trigger className={cn(TRIGGER, "w-11 rounded-full")} aria-label={t.label}>
        <UserRoundIcon aria-hidden="true" className="size-5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end" className={POSITIONER}>
          <Menu.Popup className={cn(POPUP, "w-60 p-1.5")}>
            {/* sacty 全体の設定（プロジェクトとは別。PBI-26） */}
            <Menu.LinkItem href="/settings" className={ITEM}>
              {t.settings}
            </Menu.LinkItem>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Group>
              <Menu.GroupLabel className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
                {t.theme}
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={theme}
                onValueChange={(value: ThemePreference) => {
                  setTheme(value);
                  writeTheme(value);
                }}
              >
                {THEMES.map((value) => (
                  <Menu.RadioItem key={value} value={value} className={cn(ITEM, "min-h-10")}>
                    <Radio />
                    {t.themes[value]}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.Group>
              <Menu.GroupLabel className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
                {t.language}
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={language}
                onValueChange={(value: LanguagePreference) => {
                  startTransition(() => setLanguageAction(value));
                }}
              >
                {LANGUAGES.map((value) => (
                  <Menu.RadioItem
                    key={value}
                    value={value}
                    className={cn(ITEM, "min-h-10")}
                    lang={value === "system" ? undefined : value}
                  >
                    <Radio />
                    {t.languages[value]}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
              <p className="px-3 pt-1 pb-2 text-xs leading-5 text-muted-foreground">
                {t.languageNote}
              </p>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

function Radio() {
  return (
    <span className="flex size-4 items-center justify-center rounded-full border border-input">
      <Menu.RadioItemIndicator className="size-2 rounded-full bg-primary" />
    </span>
  );
}
