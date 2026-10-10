"use client";

import { Menu } from "@base-ui/react/menu";
import { cn } from "cn";
import { BellIcon, ChevronDownIcon, UserRoundIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { applyTheme, readTheme, type ThemePreference, writeTheme } from "@/lib/theme";

const POPUP =
  "z-50 max-h-[min(70dvh,32rem)] max-w-[calc(100vw-1.5rem)] overflow-y-auto rounded-xl border border-border bg-popover text-popover-foreground shadow-lg outline-none";
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

/** プロジェクトの切り替え。プロジェクトごとに、人間の対応待ちの件数を出す。 */
export function ProjectMenu({
  projects,
  current,
}: {
  projects: ProjectOption[];
  current: ProjectOption;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(TRIGGER, "min-w-0 gap-2.5 px-3")}
        aria-label={`プロジェクト：${current.name}（切り替える）`}
      >
        <span className="flex min-w-0 flex-col text-left leading-tight">
          <span className="text-[11px] text-muted-foreground">プロジェクト</span>
          <span className="truncate text-sm font-semibold">{current.name}</span>
        </span>
        <Count n={current.needsYou} />
        <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="start">
          <Menu.Popup className={cn(POPUP, "w-72 p-1.5")}>
            <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">プロジェクトを切り替える</p>
            {projects.map((p) => (
              <Menu.LinkItem
                key={p.id}
                href={`/switch?project=${encodeURIComponent(p.id)}&to=/`}
                className={cn(
                  ITEM,
                  "min-h-11 justify-between",
                  p.id === current.id && "font-semibold",
                )}
                aria-current={p.id === current.id ? "true" : undefined}
              >
                <span className="truncate">{p.name}</span>
                {p.needsYou > 0 ? (
                  <span className="text-xs whitespace-nowrap text-warn">対応待ち {p.needsYou}</span>
                ) : null}
              </Menu.LinkItem>
            ))}
            <Menu.Separator className="my-1 h-px bg-border" />
            <Menu.LinkItem href="/projects" className={ITEM}>
              プロジェクトを管理する
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
  href: string;
};

/**
 * お知らせ：全プロジェクトの、人間の対応待ち。ほかのプロジェクトを先に並べる
 * （表示中のプロジェクトのものは一覧で見えているため）。開くと、そのプロジェクトに切り替える。
 */
export function NotificationsMenu({
  others,
  here,
  currentName,
}: {
  others: Notice[];
  here: Notice[];
  currentName: string;
}) {
  const total = others.length + here.length;
  const item = (n: Notice) => (
    <Menu.LinkItem
      key={n.taskId}
      href={`/switch?project=${encodeURIComponent(n.projectId)}&to=${encodeURIComponent(n.href)}`}
      className={cn(ITEM, "flex-col items-start gap-0.5 border-t border-border first:border-t-0")}
    >
      <span className="text-xs font-semibold text-warn">{n.status}</span>
      <span className="line-clamp-2 font-medium">{n.title}</span>
      <span className="text-xs text-muted-foreground">{n.projectName}</span>
    </Menu.LinkItem>
  );
  return (
    <Menu.Root>
      <Menu.Trigger
        className={cn(TRIGGER, "w-11")}
        aria-label={total > 0 ? `お知らせ（人間の対応待ち ${total}件）` : "お知らせ"}
      >
        <BellIcon aria-hidden="true" className="size-5" />
        <Count n={total} className="absolute -top-1.5 -right-1.5 border-2 border-chrome" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end">
          <Menu.Popup className={cn(POPUP, "w-80 p-1.5")}>
            <p className="flex items-center justify-between px-3 pt-2 pb-1 text-sm font-semibold">
              人間の対応待ち
              <span className="text-xs font-normal text-muted-foreground">全{total}件</span>
            </p>
            {total === 0 && (
              <p className="px-3 py-4 text-sm text-muted-foreground">対応待ちはありません。</p>
            )}
            {others.length > 0 && (
              <Menu.Group>
                <Menu.GroupLabel className="mt-1 rounded-md bg-muted px-3 py-1 text-[11px] text-muted-foreground">
                  ほかのプロジェクト
                </Menu.GroupLabel>
                {others.map(item)}
              </Menu.Group>
            )}
            {here.length > 0 && (
              <Menu.Group>
                <Menu.GroupLabel className="mt-1 rounded-md bg-muted px-3 py-1 text-[11px] text-muted-foreground">
                  このプロジェクト（{currentName}）
                </Menu.GroupLabel>
                {here.map(item)}
              </Menu.Group>
            )}
            {total > 0 && (
              <p className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
                開くと、そのプロジェクトに切り替えてタスクを表示します。
              </p>
            )}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

const THEMES: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "システムに従う" },
  { value: "light", label: "ライト" },
  { value: "dark", label: "ダーク" },
];

/** ユーザーメニュー：テーマ（システムに従う・ライト・ダーク）。 */
export function UserMenu() {
  const [theme, setTheme] = useState<ThemePreference>("system");
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
      <Menu.Trigger className={cn(TRIGGER, "w-11 rounded-full")} aria-label="ユーザー設定">
        <UserRoundIcon aria-hidden="true" className="size-5" />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner sideOffset={8} align="end">
          <Menu.Popup className={cn(POPUP, "w-60 p-1.5")}>
            <Menu.Group>
              <Menu.GroupLabel className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
                テーマ
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={theme}
                onValueChange={(value: ThemePreference) => {
                  setTheme(value);
                  writeTheme(value);
                }}
              >
                {THEMES.map((t) => (
                  <Menu.RadioItem key={t.value} value={t.value} className={cn(ITEM, "min-h-10")}>
                    <span className="flex size-4 items-center justify-center rounded-full border border-input">
                      <Menu.RadioItemIndicator className="size-2 rounded-full bg-primary" />
                    </span>
                    {t.label}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Group>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
