import { loadDashboard } from "@/lib/dashboard-data";
import { liveResponse } from "@/lib/live-server";

/** ダッシュボードのデータ（PBI-114）。画面が一定の間隔で取り直す（PBI-108）。 */
export async function GET(request: Request) {
  return liveResponse(request, loadDashboard);
}
