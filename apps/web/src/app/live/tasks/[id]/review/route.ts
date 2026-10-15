import { getTask } from "@/lib/daemon";
import { liveResponse } from "@/lib/live-server";

/** 成果物のレビューの画面のデータ（タスク。PBI-108）。画面が一定の間隔で取り直す。 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return liveResponse(request, async () => (await getTask(id))?.task ?? null);
}
