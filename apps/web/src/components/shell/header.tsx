import Link from "next/link";
import type { LanguagePreference } from "@/i18n/locale";
import { languagePreference } from "@/i18n/server";
import { type HeaderData, loadHeaderData } from "@/lib/header-data";
import { liveVersion } from "@/lib/live-server";
import { LiveHeaderMenus } from "./live-header";
import { UserMenu } from "./menus";
import { SactyMark } from "./sacty-mark";

function Frame({ children }: { children?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-border bg-chrome px-2.5 sm:gap-3 sm:px-4">
      <Link
        href="/"
        className="flex items-center gap-2 text-xl font-bold tracking-wide text-foreground"
      >
        <SactyMark className="size-7 shrink-0 rounded-[23%] dark:ring-1 dark:ring-white/20" />
        sacty
      </Link>
      <span aria-hidden="true" className="hidden h-7 w-px bg-border sm:block" />
      {children}
    </header>
  );
}

/**
 * 読み込み中や、デーモンにつながらないときのヘッダー（テーマと言語は変えられる）。
 * 読み込み中の仮表示では言語の設定が分からないので「システムに従う」を選んだ表示にし、
 * つながらないときは保存済みの言語の設定を渡す。live なら（デーモンにつながらなかったとき）、届くようになってから
 * プロジェクトの切り替えとお知らせを出す（PBI-108）。
 */
export function HeaderFallback({
  language = "system",
  live = false,
}: {
  language?: LanguagePreference;
  live?: boolean;
}) {
  return (
    <Frame>
      {live ? (
        <LiveHeaderMenus initial={null} language={language} />
      ) : (
        <>
          <span className="flex-1" />
          <UserMenu language={language} />
        </>
      )}
    </Frame>
  );
}

/**
 * ヘッダー：ロゴ、プロジェクトの切り替え（対応待ちの件数つき）、お知らせ、ユーザーメニュー。切り替えとお知らせは、
 * 画面をリロードせずに取り直す（PBI-108）。
 */
export async function AppHeader() {
  let data: HeaderData | null;
  try {
    data = await loadHeaderData();
  } catch {
    return <HeaderFallback language={await languagePreference()} live />;
  }
  // プロジェクトが1つも無いときは、切り替えもお知らせも出さない（作成画面のほかへ移らせない。PBI-22）
  if (data === null) return <HeaderFallback language={await languagePreference()} />;
  return (
    <Frame>
      <LiveHeaderMenus
        initial={data}
        initialVersion={liveVersion(data)}
        language={await languagePreference()}
      />
    </Frame>
  );
}
