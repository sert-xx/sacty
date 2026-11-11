import { type ContextImagesView, getStatus } from "@/lib/daemon";

/** コンテキストのイメージの作成の状況（PBI-325）。画面が取り直す。無ければ空。 */
export type ContextImagesData = { contextImages: ContextImagesView[] };

/** デーモンにコンテキストのイメージの作成の状況を聞く。届かなければ例外（取り直しでは「更新できない」になる）。 */
export async function loadContextImagesData(): Promise<ContextImagesData> {
  return { contextImages: (await getStatus()).contextImages ?? [] };
}
