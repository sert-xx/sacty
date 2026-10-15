import { liveResponse } from "@/lib/live-server";
import { loadTaskDetail } from "@/lib/task-detail-data";

/**
 * タスクの詳細のデータ（PBI-108）。画面が一定の間隔で取り直す。リポジトリの候補（Org の対象は gh で GitHub に問い合わせる）
 * は、`?repositories=1` のときだけ取る（画面が候補をまだ持っていないときだけ求める）。
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const repositories = new URL(request.url).searchParams.get("repositories") === "1";
  return liveResponse(request, () => loadTaskDetail(id, { repositories }));
}
