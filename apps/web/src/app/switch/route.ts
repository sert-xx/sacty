import { type NextRequest, NextResponse } from "next/server";
import { isLocalPath, PROJECT_COOKIE } from "@/lib/current-project";

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
    headers: { location: isLocalPath(to) ? to : "/" },
  });
  if (/^[\w-]{1,100}$/.test(project)) {
    res.cookies.set(PROJECT_COOKIE, project, {
      path: "/",
      sameSite: "lax",
      httpOnly: true,
      maxAge: 60 * 60 * 24 * 365,
    });
  }
  return res;
}
