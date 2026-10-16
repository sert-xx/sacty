import { isRepoless, type Task } from "@sacty/core";
import { getMessages } from "@/i18n/server";
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

/** プロジェクトのタスクの一覧（PBI-108）。 */
export type TaskListData = {
  /** 一覧のプロジェクト（URL の ID。PBI-114）。 */
  projectId: string;
  needsYou: NeedsYouCard[];
  rows: TaskRow[];
};

/**
 * プロジェクトのタスクの一覧のデータ（projectId は URL のプロジェクト。PBI-114）。プロジェクトが無ければ null。デーモンに
 * 届かなければ例外。
 */
export async function loadTaskList(projectId: string): Promise<TaskListData | null> {
  const [tasks, projects, { labels }] = await Promise.all([
    listTasks(),
    listProjects(),
    getMessages(),
  ]);
  const project = projects.find((p) => p.id === projectId);
  if (!project) return null;
  const mine = tasks.filter((t) => t.projectId === project.id);
  return {
    projectId: project.id,
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
