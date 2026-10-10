import { type NextRequest, NextResponse } from "next/server";
import { DEFAULT_PROJECT_ID, PROJECT_COOKIE } from "@/lib/current-project";

/** 表示しているプロジェクトの設定へ移る（サイドメニューの「設定」から）。 */
export function GET(request: NextRequest) {
  const id = request.cookies.get(PROJECT_COOKIE)?.value || DEFAULT_PROJECT_ID;
  // 相対パスで返す（ホスト名を書き換えないため）
  return new NextResponse(null, {
    status: 303,
    headers: { location: `/projects/${encodeURIComponent(id)}` },
  });
}
