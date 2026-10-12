import { isCompleted, type Task } from "@sacty/core";

/**
 * 一覧の並び。分割で作った子タスクは、親のすぐ下に、分割で決めた順に並べる（PBI-27）。
 * 親が一覧に無い子タスク（ほかのプロジェクトに移ったなど）は、そのままの位置に出す。
 */
export function withSubtasks(tasks: Task[]): { task: Task; child: boolean }[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const placed = new Set<string>();
  const rows: { task: Task; child: boolean }[] = [];
  for (const task of tasks) {
    if (placed.has(task.id)) continue;
    if (task.parent && byId.has(task.parent.taskId)) continue;
    rows.push({ task, child: false });
    placed.add(task.id);
    for (const c of task.split?.children ?? []) {
      const child = byId.get(c.taskId);
      if (!child || placed.has(child.id)) continue;
      rows.push({ task: child, child: true });
      placed.add(child.id);
    }
  }
  // 親が一覧にあるのに、親の分割の一覧に無い子タスク（作業履歴の不整合）も落とさない
  for (const task of tasks) {
    if (!placed.has(task.id)) rows.push({ task, child: Boolean(task.parent) });
  }
  return rows;
}

/** 子タスクの進み具合と費用の合計（PBI-27）。 */
export function subtaskSummary(parent: Task, tasks: ReadonlyMap<string, Task>) {
  const children = (parent.split?.children ?? []).map((c) => ({
    ...c,
    task: tasks.get(c.taskId),
  }));
  return {
    children,
    done: children.filter((c) => c.task && isCompleted(c.task)).length,
    costUsd:
      Math.round(children.reduce((sum, c) => sum + (c.task?.budget.usedUsd ?? 0), 0) * 1e6) / 1e6,
  };
}
