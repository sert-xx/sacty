import type { Notice, ProjectOption } from "@/components/shell/menus";
import { getMessages } from "@/i18n/server";
import { currentProjectId, resolveProject } from "@/lib/current-project";
import { listProjects, listTasks } from "@/lib/daemon";
import { needsPerson, personLink, statusText } from "@/lib/labels";

/** ヘッダーのプロジェクトの切り替えとお知らせに出すもの（PBI-98）。画面が取り直す（PBI-108）。 */
export type HeaderData = {
  projects: ProjectOption[];
  current: ProjectOption;
  /** 全プロジェクトの、人間の対応待ち（新しい順）。 */
  notices: Notice[];
};

/**
 * ヘッダーのデータ。currentId を渡せば、そのプロジェクトを表示しているものとする（画面が取り直すときは、描いたときの
 * プロジェクトのままにする。ほかのタブで切り替えたときに、ヘッダーだけが変わらないように）。渡さなければ cookie の
 * プロジェクト。プロジェクトが1つも無ければ null。デーモンに届かなければ例外。
 */
export async function loadHeaderData(currentId?: string): Promise<HeaderData | null> {
  // 対応待ち（承認待ち・エスカレーション・一時停止）は終わっていないタスクなので、終わっていないタスクだけを取る（PBI-114）
  const [projects, tasks] = await Promise.all([listProjects(), listTasks({ open: true })]);
  // プロジェクトが1つも無いときは、切り替えもお知らせも出さない（作成画面のほかへ移らせない。PBI-22）
  if (projects.length === 0) return null;
  const m = await getMessages();
  const current = resolveProject(projects, currentId ?? (await currentProjectId()));
  const waiting = tasks.filter(needsPerson);
  const options = projects.map((p) => ({
    id: p.id,
    name: p.name,
    needsYou: waiting.filter((t) => t.projectId === p.id).length,
  }));
  const name = (id: string) => projects.find((p) => p.id === id)?.name ?? id;
  const notices: Notice[] = [...waiting]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((t) => ({
      taskId: t.id,
      title: t.title,
      projectId: t.projectId,
      projectName: name(t.projectId),
      status: statusText(t, m.labels),
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
