import { isCompleted, type Task } from "@sacty/core";

/** 一覧の親（分割の親、またはレビューする PR を作ったタスク。PBI-27・PBI-341）。 */
export function listParentOf(task: Task): string | undefined {
  return task.parent?.taskId ?? task.reviewOf?.taskId;
}

/**
 * 一覧の並び。分割で作った子タスクは、親のすぐ下に、分割で決めた順に並べる（PBI-27）。PR のレビューの子タスク（reviewOf。
 * PBI-330）も、レビューする PR を作ったタスクのすぐ下に、分割の子の後に、作った日時の昇順で並べる（PBI-341）。分割の子の
 * レビューの子は、その分割の子の下にもう一段字下げする（depth は字下げの段。子なら1以上）。
 * 親が一覧に無い子タスク（ほかのプロジェクトに移ったなど）は、そのままの位置に出す。
 */
export function withSubtasks(tasks: Task[]): { task: Task; child: boolean; depth: number }[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const reviews = new Map<string, Task[]>();
  for (const task of tasks) {
    const of = task.reviewOf?.taskId;
    if (!of || task.parent) continue;
    reviews.set(of, [...(reviews.get(of) ?? []), task]);
  }
  const placed = new Set<string>();
  const rows: { task: Task; child: boolean; depth: number }[] = [];
  const place = (task: Task, depth: number) => {
    rows.push({ task, child: depth > 0, depth });
    placed.add(task.id);
    const children = [
      ...(task.split?.children ?? []).map((c) => byId.get(c.taskId)),
      // レビューの子は、一覧の並び（新しい順など）にかかわらず、作った順にする
      ...(reviews.get(task.id) ?? []).toSorted((x, y) => x.createdAt.localeCompare(y.createdAt)),
    ];
    for (const child of children) {
      if (!child || placed.has(child.id)) continue;
      place(child, depth + 1);
    }
  };
  for (const task of tasks) {
    if (placed.has(task.id)) continue;
    const parent = listParentOf(task);
    if (parent && byId.has(parent)) continue;
    place(task, 0);
  }
  // 親が一覧にあるのに、親の分割の一覧に無い子タスク（作業履歴の不整合）・親子が輪になった記録も落とさない
  for (const task of tasks) {
    if (!placed.has(task.id)) {
      const child = Boolean(listParentOf(task));
      rows.push({ task, child, depth: child ? 1 : 0 });
      placed.add(task.id);
    }
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
