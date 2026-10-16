import { isFinished, type Project, type Task } from "@sacty/core";
import { getMessages } from "@/i18n/server";
import { listProjects, listTasks } from "@/lib/daemon";
import { type StatusTone, statusText, statusTone } from "@/lib/labels";

/** ダッシュボードの「終わっていないタスク」の欄の1行（PBI-114）。 */
export type OpenTaskRow = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  status: { text: string; tone: StatusTone };
};

/**
 * ダッシュボードのデータ（PBI-114）。画面が取り直す（PBI-108）。欄を足すときは、ここに欄ごとのデータを足す。
 * projects はプロジェクトの数（無いときの表示に使う）。
 */
export type DashboardData = {
  projects: number;
  openTasks: OpenTaskRow[];
};

/** 終わっていないタスクか（完了・中止を除くすべて。承認待ち・一時停止・エスカレーションも含む。PBI-114）。 */
export function isOpenTask(task: Task): boolean {
  return !isFinished(task);
}

/**
 * すべてのプロジェクトの、終わっていないタスク（新しく動いた順）。件数の上限は無い。プロジェクトが無くなったタスクは
 * 出さない（開いても、どのプロジェクトのタスクか分からないため）。
 */
export function openTaskRows(
  projects: readonly Project[],
  tasks: readonly Task[],
  labels: Parameters<typeof statusText>[1],
): OpenTaskRow[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return tasks
    .filter((t) => names.has(t.projectId) && isOpenTask(t))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      projectName: names.get(t.projectId) ?? t.projectId,
      status: { text: statusText(t, labels), tone: statusTone(t) },
    }));
}

/** ダッシュボードのデータ。デーモンに届かなければ例外。 */
export async function loadDashboard(): Promise<DashboardData> {
  const [projects, tasks, { labels }] = await Promise.all([
    listProjects(),
    // 終わっていないタスクだけを取る（完了したタスクの成果物を3秒ごとに運ばない）
    listTasks({ open: true }),
    getMessages(),
  ]);
  return { projects: projects.length, openTasks: openTaskRows(projects, tasks, labels) };
}
