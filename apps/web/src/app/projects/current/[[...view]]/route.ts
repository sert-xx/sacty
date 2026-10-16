import { type NextRequest, NextResponse } from "next/server";
import { PROJECT_COOKIE, resolveProject } from "@/lib/current-project";
import { listProjects } from "@/lib/daemon";
import { projectSettingsPath, projectTasksPath } from "@/lib/paths";

/**
 * 表示しているプロジェクトの画面へ移る（サイドメニューから）。`/projects/current` は設定、`/projects/current/tasks` は
 * タスクの一覧（PBI-114）。ほかは 404。
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ view?: string[] }> },
) {
  const view = (await params).view ?? [];
  const to =
    view.length === 0
      ? projectSettingsPath
      : view.length === 1 && view[0] === "tasks"
        ? projectTasksPath
        : undefined;
  if (!to) return new NextResponse(null, { status: 404 });
  const id = request.cookies.get(PROJECT_COOKIE)?.value ?? "";
  // cookie のプロジェクトが無い・消えていれば、最初のプロジェクト（既定のプロジェクトは無い。PBI-22）。
  // デーモンにつながらなければ、プロジェクトの一覧（つながらないことを表示する）へ
  const project = await listProjects()
    .then((projects) => resolveProject(projects, id))
    .catch(() => undefined);
  // 相対パスで返す（ホスト名を書き換えないため）
  return new NextResponse(null, {
    status: 303,
    headers: { location: project ? to(project.id) : "/projects" },
  });
}
