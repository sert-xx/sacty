import { loadHeaderData } from "@/lib/header-data";
import { liveResponse } from "@/lib/live-server";
import { isProjectId } from "@/lib/project-select";

/**
 * ヘッダーのプロジェクトの切り替えとお知らせのデータ（PBI-108）。画面が一定の間隔で取り直す。
 * `?current=<ID>` は、画面を描いたときに表示していたプロジェクト。
 */
export async function GET(request: Request) {
  const current = new URL(request.url).searchParams.get("current") ?? "";
  return liveResponse(request, () => loadHeaderData(isProjectId(current) ? current : undefined));
}
