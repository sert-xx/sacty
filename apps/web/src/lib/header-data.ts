import { personTurnTasks } from "@sacty/core";
import type { Notice, ProjectOption } from "@/components/shell/menus";
import { getMessages } from "@/i18n/server";
import { currentProjectId, resolveProject } from "@/lib/current-project";
import { getDashboardSummary, listProjects, listTasks } from "@/lib/daemon";
import { personLink, personStatusText } from "@/lib/labels";

/** ヘッダーのプロジェクトの切り替えとお知らせに出すもの（PBI-98）。画面が取り直す（PBI-108）。 */
export type HeaderData = {
  projects: ProjectOption[];
  current: ProjectOption;
  /** 全プロジェクトの、人間の対応待ち（ダッシュボードの「あなたの出番」と同じ対象・同じ並び。PBI-442）。 */
  notices: Notice[];
};

/**
 * ヘッダーのデータ。currentId を渡せば、そのプロジェクトを表示しているものとする（画面が取り直すときは、描いたときの
 * プロジェクトのままにする。ほかのタブで切り替えたときに、ヘッダーだけが変わらないように）。渡さなければ cookie の
 * プロジェクト。プロジェクトが1つも無ければ null。デーモンに届かなければ例外。
 */
export async function loadHeaderData(currentId?: string): Promise<HeaderData | null> {
  // 対応待ち（承認待ち・エスカレーション・一時停止）は終わっていないタスクなので、終わっていないタスクだけを取る（PBI-114）
  // 待ち始めは、デーモンの集計から読む（ダッシュボード・MCP と同じ出どころ。完了したタスクや作業履歴は運ばない）
  const [projects, tasks, summary] = await Promise.all([
    listProjects(),
    listTasks({ open: true }),
    getDashboardSummary(),
  ]);
  // プロジェクトが1つも無いときは、切り替えもお知らせも出さない（作成画面のほかへ移らせない。PBI-22）
  if (projects.length === 0) return null;
  const m = await getMessages();
  const current = resolveProject(projects, currentId ?? (await currentProjectId()));
  const waiting = personTurnTasks(tasks, {
    projectIds: new Set(projects.map((p) => p.id)),
    waitingSince: summary.waitingSince,
  });
  const options = projects.map((p) => ({
    id: p.id,
    name: p.name,
    needsYou: waiting.filter((w) => w.task.projectId === p.id).length,
  }));
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const notices: Notice[] = waiting.map(({ task: t, group, waitingSince }) => ({
    taskId: t.id,
    title: t.title,
    projectId: t.projectId,
    projectName: name(t.projectId),
    status: personStatusText(t, m.labels),
    group,
    waitingSince,
    ...personLink(t, m.labels),
  }));
  return {
    projects: options,
    current: options.find((o) => o.id === current?.id) ?? {
      id: "",
      name: m.shell.project.fallbackName,
      needsYou: 0,
    },
    notices,
  };
}
