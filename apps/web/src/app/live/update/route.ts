import { liveResponse } from "@/lib/live-server";
import { loadUpdateData } from "@/lib/update-data";

/** sacty の新しい版の知らせ（PBI-135）。画面が一定の間隔で取り直す（PR #147 レビュー指摘）。 */
export async function GET(request: Request) {
  return liveResponse(request, loadUpdateData);
}
