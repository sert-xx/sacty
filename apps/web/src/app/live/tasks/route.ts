import { liveResponse } from "@/lib/live-server";
import { isProjectId } from "@/lib/project-select";
import { loadTaskList } from "@/lib/task-list-data";

/**
 * タスクの一覧のデータ（PBI-108）。画面が一定の間隔で取り直す。`?project=<ID>` は、画面を描いたときに表示していた
 * プロジェクト（無ければ表示しているプロジェクト）。対象リポジトリの候補（gh で GitHub に問い合わせる）は取らない。
 */
export async function GET(request: Request) {
  const project = new URL(request.url).searchParams.get("project") ?? "";
  return liveResponse(request, () => loadTaskList(isProjectId(project) ? project : undefined));
}
