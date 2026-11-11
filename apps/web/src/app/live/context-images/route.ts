import { loadContextImagesData } from "@/lib/context-images-data";
import { liveResponse } from "@/lib/live-server";

/** コンテキストのイメージの作成の状況（PBI-325）。画面が一定の間隔で取り直す。 */
export async function GET(request: Request) {
  return liveResponse(request, loadContextImagesData);
}
