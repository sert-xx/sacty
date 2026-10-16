/**
 * 画面の URL（PBI-114）。画面の中のリンクと移動先は、ここで作る（URL を変えたときに、古い URL を指すリンクを残さない）。
 *
 * - `/`：ダッシュボードへ移す
 * - `/dashboard`：ダッシュボード
 * - `/projects/<ID>`：そのプロジェクトのタスクの一覧へ移す
 * - `/projects/<ID>/tasks`：そのプロジェクトのタスクの一覧
 * - `/projects/<ID>/settings`：そのプロジェクトの設定
 * - `/projects/current`・`/projects/current/tasks`：表示しているプロジェクト（cookie）の設定・タスクの一覧へ移す
 */

export const DASHBOARD_PATH = "/dashboard";

/** プロジェクトの一覧。 */
export const PROJECTS_PATH = "/projects";

/** プロジェクトのタスクの一覧。 */
export function projectTasksPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}/tasks`;
}

/** プロジェクトの設定。 */
export function projectSettingsPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}/settings`;
}

/** 表示しているプロジェクト（cookie）のタスクの一覧・設定へ移る URL（サイドメニューから）。 */
export const CURRENT_PROJECT_TASKS_PATH = "/projects/current/tasks";
export const CURRENT_PROJECT_SETTINGS_PATH = "/projects/current";

/** タスクの詳細。 */
export function taskPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`;
}

/**
 * 表示するプロジェクト（cookie）を切り替えてから、to へ移る URL（ヘッダーの切り替え・お知らせから）。先に cookie を
 * 変えるので、移った先でヘッダーの選択が一瞬ずれることもない。
 */
export function switchPath(projectId: string, to: string): string {
  return `/switch?project=${encodeURIComponent(projectId)}&to=${encodeURIComponent(to)}`;
}
