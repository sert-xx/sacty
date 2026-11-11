import { loadContextImagesData } from "@/lib/context-images-data";
import { ContextImagesNoticeLive } from "./context-images-notice-live";

/**
 * コンテキストのイメージ（images.yaml）の作成の状況（PBI-325）。描いたときの状態から始め、画面の中で取り直す。デーモンに
 * つながらなければ、何も無い状態から始める（デーモンにつながらないことは、それぞれの画面が知らせる）。
 */
export async function ContextImagesNotice() {
  const initial = await loadContextImagesData().catch(() => ({ contextImages: [] }));
  return <ContextImagesNoticeLive initial={initial} />;
}
