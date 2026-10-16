import { liveResponse } from "@/lib/live-server";
import { isProjectId } from "@/lib/project-select";
import { loadTaskList } from "@/lib/task-list-data";

/**
 * タスクの一覧のデータ（PBI-108）。画面が一定の間隔で取り直す。`?project=<ID>` は、一覧のプロジェクト（URL の ID。
 * PBI-114）。無い・形が違えば、対象が無い（missing）。対象リポジトリの候補（gh で GitHub に問い合わせる）は取らない。
 */
export async function GET(request: Request) {
  const project = new URL(request.url).searchParams.get("project") ?? "";
  return liveResponse(request, async () => (isProjectId(project) ? loadTaskList(project) : null));
}
