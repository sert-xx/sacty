import { type NextRequest, NextResponse } from "next/server";
import { safeLocalPath } from "@/lib/current-project";
import { isProjectId, PROJECT_COOKIE, PROJECT_COOKIE_OPTIONS } from "@/lib/project-select";

/**
 * 表示するプロジェクトを切り替えて、指定の画面へ移る（お知らせから、ほかのプロジェクトの
 * タスクを開くときなど）。移動先は画面の中のパスだけを受け付ける。
 */
export function GET(request: NextRequest) {
  const project = request.nextUrl.searchParams.get("project") ?? "";
  const to = request.nextUrl.searchParams.get("to") ?? "/";
  // 移動先は相対パスで返す（サーバーが知っているホスト名と、ブラウザが開いているホスト名が
  // 違うことがあり、絶対 URL にすると cookie を付けたホストから外れてしまうため）
  const res = new NextResponse(null, {
    status: 303,
    headers: { location: safeLocalPath(to) ?? "/" },
  });
  if (isProjectId(project)) res.cookies.set(PROJECT_COOKIE, project, PROJECT_COOKIE_OPTIONS);
  return res;
}
