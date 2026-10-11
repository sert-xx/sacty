import { type NextRequest, NextResponse } from "next/server";
import { PROJECT_COOKIE, resolveProject } from "@/lib/current-project";
import { listProjects } from "@/lib/daemon";

/** 表示しているプロジェクトの設定へ移る（サイドメニューの「設定」から）。 */
export async function GET(request: NextRequest) {
  const id = request.cookies.get(PROJECT_COOKIE)?.value ?? "";
  // cookie のプロジェクトが無い・消えていれば、最初のプロジェクト（既定のプロジェクトは無い。PBI-22）。
  // デーモンにつながらなければ、プロジェクトの一覧（つながらないことを表示する）へ
  const project = await listProjects()
    .then((projects) => resolveProject(projects, id))
    .catch(() => undefined);
  // 相対パスで返す（ホスト名を書き換えないため）
  return new NextResponse(null, {
    status: 303,
    headers: {
      location: project ? `/projects/${encodeURIComponent(project.id)}` : "/projects",
    },
  });
}
