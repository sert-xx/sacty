"use client";

import { useMessages } from "@/i18n/client";
import type { LanguagePreference } from "@/i18n/locale";
import type { HeaderData } from "@/lib/header-data";
import { useLiveData } from "@/lib/use-live-data";
import { NotificationsMenu, ProjectMenu, UserMenu } from "./menus";

/** ヘッダーのデータを取り直す先。表示しているプロジェクトは、描いたときのままにする。 */
export function headerLiveUrl(currentId: string | undefined): string {
  return currentId ? `/live/header?current=${encodeURIComponent(currentId)}` : "/live/header";
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
  return (
    <>
      {data && <ProjectMenu projects={data.projects} current={data.current} />}
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
          others={data.notices.filter((n) => n.projectId !== data.current.id)}
          here={data.notices.filter((n) => n.projectId === data.current.id)}
          currentName={data.current.name}
        />
      )}
      <UserMenu language={language} />
    </>
  );
}
