"use client";

import { usePathname } from "next/navigation";
import { useMessages } from "@/i18n/client";
import type { LanguagePreference } from "@/i18n/locale";
import type { HeaderData } from "@/lib/header-data";
import { pageScope } from "@/lib/page-scope";
import { useLiveData } from "@/lib/use-live-data";
import { NotificationsMenu, ProjectMenu, UserMenu } from "./menus";

/** ヘッダーのデータを取り直す先。表示しているプロジェクトは、描いたときのままにする。 */
export function headerLiveUrl(currentId: string | undefined): string {
  return currentId ? `/live/header?current=${encodeURIComponent(currentId)}` : "/live/header";
}

/**
 * ヘッダーで選んだ表示にするプロジェクト（PBI-114）。開いている画面で決める。プロジェクトの画面は URL のプロジェクト
 * （タスクの詳細などは、表示しているプロジェクト＝画面が合わせた cookie）。プロジェクトをまたぐ画面（ダッシュボードなど）
 * や、無いプロジェクトの画面は null（「すべてのプロジェクト」）。
 */
export function selectedProject(
  data: Pick<HeaderData, "projects" | "current">,
  pathname: string,
): HeaderData["current"] | null {
  const scope = pageScope(pathname);
  if (scope.kind === "all") return null;
  const id = scope.id ?? data.current.id;
  return data.projects.find((p) => p.id === id) ?? null;
}

/**
 * ヘッダーのプロジェクトの切り替え・お知らせ・ユーザーメニュー（PBI-108）。お知らせと対応待ちの件数は、画面をリロード
 * せずに一定の間隔で取り直す（タブが隠れている間は止め、見えたらすぐに取り直す）。開いているメニューは閉じない。
 * initial が null（描いたときにデーモンに届かなかった）なら、届いてから切り替えとお知らせを出す。
 */
export function LiveHeaderMenus({
  initial,
  initialVersion,
  language,
}: {
  initial: HeaderData | null;
  initialVersion?: string;
  language: LanguagePreference;
}) {
  const url = headerLiveUrl(initial?.current.id);
  const { data, stale } = useLiveData(() => url, initial, initialVersion);
  const m = useMessages().common.live;
  const pathname = usePathname() ?? "";
  const selected = data ? selectedProject(data, pathname) : null;
  return (
    <>
      {data && <ProjectMenu projects={data.projects} current={selected} />}
      <span className="flex-1" />
      {/* 更新できない間は、件数が今の値でないかもしれないことを出す（PR #119 レビュー指摘） */}
      {stale && (
        <span
          role="status"
          data-testid="live-stale-header"
          className="text-xs font-semibold text-warn"
        >
          {m.staleShort}
        </span>
      )}
      {data && (
        <NotificationsMenu
          others={data.notices.filter((n) => n.projectId !== selected?.id)}
          here={data.notices.filter((n) => n.projectId === selected?.id)}
          currentName={selected?.name}
        />
      )}
      <UserMenu language={language} />
    </>
  );
}
