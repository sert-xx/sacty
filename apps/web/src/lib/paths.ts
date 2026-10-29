/**
 * 画面の URL（PBI-114）。画面の中のリンクと移動先は、ここで作る（URL を変えたときに、古い URL を指すリンクを残さない）。
 *
 * - `/`：ダッシュボードへ移す
 * - `/dashboard`：ダッシュボード
 * - `/projects/<ID>`：そのプロジェクトのタスクの一覧へ移す
 * - `/projects/<ID>/tasks`：そのプロジェクトのタスクの一覧
 * - `/projects/<ID>/settings`：そのプロジェクトの設定
 * - `/projects/<ID>/audit`：そのプロジェクトの監査（PBI-124）
 * - `/projects/<ID>/schedules`：そのプロジェクトのスケジュールタスクの一覧
 * - `/projects/<ID>/schedules/<スケジュールタスクの ID>`：スケジュールタスクの詳細（作ったタスクの一覧）
 * - `/projects/current`・`/projects/current/tasks`・`/projects/current/schedules`・`/projects/current/audit`：表示して
 *   いるプロジェクト（cookie）の設定・タスクの一覧・スケジュールタスクの一覧・監査へ移す
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

/** プロジェクトの監査（PBI-124）。 */
export function projectAuditPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}/audit`;
}

/** プロジェクトの監査のレポート（Markdown のダウンロード。PBI-124）。 */
export function projectAuditReportPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}/audit/report`;
}

/** プロジェクトのスケジュールタスクの一覧。 */
export function projectSchedulesPath(id: string): string {
  return `/projects/${encodeURIComponent(id)}/schedules`;
}

/** スケジュールタスクの詳細。 */
export function schedulePath(projectId: string, scheduleId: string): string {
  return `${projectSchedulesPath(projectId)}/${encodeURIComponent(scheduleId)}`;
}

/** 表示しているプロジェクト（cookie）のタスクの一覧・スケジュールタスク・監査・設定へ移る URL（サイドメニューから）。 */
export const CURRENT_PROJECT_TASKS_PATH = "/projects/current/tasks";
export const CURRENT_PROJECT_SCHEDULES_PATH = "/projects/current/schedules";
export const CURRENT_PROJECT_AUDIT_PATH = "/projects/current/audit";
export const CURRENT_PROJECT_SETTINGS_PATH = "/projects/current";

/** タスクの詳細。 */
export function taskPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}`;
}

/** タスクのエラーレポートのダウンロード。 */
export function errorReportPath(id: string): string {
  return `/tasks/${encodeURIComponent(id)}/error-report`;
}

/** ダウンロードするエラーレポートのファイルの名前（タスクの短い ID と、作った日時。ID の英数字と - だけを使う）。 */
export function errorReportFileName(id: string, at: Date): string {
  const short = id.replace(/[^A-Za-z0-9-]/g, "").slice(0, 8) || "task";
  const stamp = at.toISOString().replace(/[-:]/g, "").slice(0, 13);
  return `sacty-error-report-${short}-${stamp}.md`;
}

/**
 * 表示するプロジェクト（cookie）を切り替えてから、to へ移る URL（ヘッダーの切り替え・お知らせから）。先に cookie を
 * 変えるので、移った先でヘッダーの選択が一瞬ずれることもない。
 */
export function switchPath(projectId: string, to: string): string {
  return `/switch?project=${encodeURIComponent(projectId)}&to=${encodeURIComponent(to)}`;
}
