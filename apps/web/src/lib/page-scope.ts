/**
 * 開いている画面が、どのプロジェクトの画面か（PBI-114）。ヘッダーのプロジェクトの切り替えと、サイドメニューが使う。
 *
 * - `all`：プロジェクトをまたぐ画面（ダッシュボード・プロジェクトの一覧・sacty 全体の設定など）。ヘッダーは
 *   「すべてのプロジェクト」を選んだ表示にする。
 * - `project`：プロジェクトの画面。id は URL のプロジェクト（`/projects/<ID>/...`）。タスクの詳細・レビュー・実行のログ
 *   （`/tasks/...`）は URL にプロジェクトが無いので undefined（表示しているプロジェクト＝cookie。画面が FollowProject で
 *   タスクのプロジェクトに合わせる）。
 */
export type PageScope = { kind: "all" } | { kind: "project"; id?: string };

const PROJECT_PAGE = /^\/projects\/([^/]+)\/(?:tasks|settings|audit)(?:\/|$)/;

export function pageScope(pathname: string): PageScope {
  const match = PROJECT_PAGE.exec(pathname);
  if (match?.[1] && match[1] !== "current") {
    let id: string;
    try {
      id = decodeURIComponent(match[1]);
    } catch {
      return { kind: "all" };
    }
    return { kind: "project", id };
  }
  if (pathname === "/tasks" || pathname.startsWith("/tasks/")) return { kind: "project" };
  return { kind: "all" };
}
