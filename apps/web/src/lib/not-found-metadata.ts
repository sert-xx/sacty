import type { Metadata } from "next";
import { getMessages } from "@/i18n/server";

/**
 * 無いページのブラウザーのタイトル。画面の言語に従う。`<Suspense>` の中で呼んだ `notFound()` は
 * `not-found.tsx` のタイトルに届かないので、`notFound()` を呼ぶページの `generateMetadata` も、無いと判定したらこれを返す。
 */
export async function notFoundMetadata(): Promise<Metadata> {
  const t = (await getMessages()).common.notFound;
  return { title: `${t.title} - Sacty` };
}
