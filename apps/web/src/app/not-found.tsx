import type { Metadata } from "next";
import Link from "next/link";
import { getMessages } from "@/i18n/server";
import { notFoundMetadata } from "@/lib/not-found-metadata";
import { DASHBOARD_PATH } from "@/lib/paths";

/** ブラウザーのタイトルも、画面の言語に従う。 */
export async function generateMetadata(): Promise<Metadata> {
  return notFoundMetadata();
}

/**
 * 無いページ（無い URL、`notFound()` を呼ぶ無いタスク・無いプロジェクト）。ヘッダーつきの Sacty の画面で、
 * ダッシュボードへのリンクを出す。
 */
export default async function NotFound() {
  const t = (await getMessages()).common.notFound;
  return (
    <div className="flex flex-col items-start gap-3">
      <h1 className="text-2xl font-bold">{t.title}</h1>
      <p className="text-sm leading-6 text-muted-foreground">{t.note}</p>
      <Link
        href={DASHBOARD_PATH}
        className="text-sm font-medium text-foreground underline underline-offset-4"
      >
        {t.toDashboard}
      </Link>
    </div>
  );
}
