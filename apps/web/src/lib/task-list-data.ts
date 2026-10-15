import { isRepoless, type Task } from "@sacty/core";
import { getMessages } from "@/i18n/server";
import { currentProjectId, resolveProject } from "@/lib/current-project";
import { listProjects, listTasks } from "@/lib/daemon";

import { needsPerson, personAction, type StatusTone, statusText, statusTone } from "@/lib/labels";
import { withSubtasks } from "@/lib/subtasks";

/** タスクの一覧の1行に出すもの（画面が取り直すのは、これだけ。PBI-108）。 */
export type TaskRow = {
  id: string;
  title: string;
  /** 分割で作った子タスク（親のすぐ下に字下げして出す。PBI-27）。 */
  child: boolean;
  start: Task["start"];
  template?: NonNullable<Task["template"]>;
  source?: { repo: string; number: number };
  repoless: boolean;
  /** 子タスクに付けたリポジトリ（PBI-73）。 */
  repo?: string;
  steps: Pick<Task["steps"][number], "key" | "state">[];
  status: { text: string; tone: StatusTone };
};

/** 人間の判断が必要なタスクのカード。 */
export type NeedsYouCard = {
  id: string;
  title: string;
  status: string;
  action: { href: string; label: string };
};

/** 表示しているプロジェクトのタスクの一覧（PBI-108）。 */
export type TaskListData = {
  /** 表示しているプロジェクト（無ければ null）。 */
  projectId: string | null;
  needsYou: NeedsYouCard[];
  rows: TaskRow[];
};

/**
 * タスクの一覧のデータ。projectId を渡せば、そのプロジェクト（画面を描いたときのプロジェクトのまま取り直す）。渡さな
 * ければ cookie のプロジェクト。デーモンに届かなければ例外。
 */
export async function loadTaskList(projectId?: string): Promise<TaskListData> {
  const [tasks, projects, cookie, { labels }] = await Promise.all([
    listTasks(),
    listProjects(),
    currentProjectId(),
    getMessages(),
  ]);
  const project =
    projectId !== undefined
      ? projects.find((p) => p.id === projectId)
      : resolveProject(projects, cookie);
  const mine = tasks.filter((t) => t.projectId === project?.id);
  return {
    projectId: project?.id ?? null,
    needsYou: mine.filter(needsPerson).map((t) => ({
      id: t.id,
      title: t.title,
      status: statusText(t, labels),
      action: personAction(t, labels),
    })),
    rows: withSubtasks(mine).map(({ task, child }) => ({
      id: task.id,
      title: task.title,
      child,
      start: task.start,
      ...(task.template ? { template: task.template } : {}),
      ...(task.source ? { source: { repo: task.source.repo, number: task.source.number } } : {}),
      repoless: isRepoless(task),
      ...(child && task.repo ? { repo: task.repo } : {}),
      steps: task.steps.map((s) => ({ key: s.key, state: s.state })),
      status: { text: statusText(task, labels), tone: statusTone(task) },
    })),
  };
}
