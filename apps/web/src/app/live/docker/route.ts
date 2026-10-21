import { loadDockerData } from "@/lib/docker-data";
import { liveResponse } from "@/lib/live-server";

/** Docker とエージェントのイメージの注意（PBI-148）。画面が一定の間隔で取り直す。 */
export async function GET(request: Request) {
  return liveResponse(request, loadDockerData);
}
