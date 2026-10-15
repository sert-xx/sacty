import { liveResponse } from "@/lib/live-server";
import { loadProjectList } from "@/lib/project-list-data";

/** プロジェクトの一覧の画面のデータ（プロジェクトと取り込みの状況。PBI-108）。画面が一定の間隔で取り直す。 */
export async function GET(request: Request) {
  return liveResponse(request, loadProjectList);
}
