import type { TaskRow } from "@/lib/task-list-data";

/**
 * 絞り込んだ後の一覧の行に、表示する字下げの段と親の題を付ける（PBI-341）。親が表示されていない子（絞り込みで隠れた・
 * ほかのプロジェクトにある）は、直前の無関係なタスクの子に見えないよう字下げしない。親の題は、子であることを読み上げで
 * 伝えるのに使う。
 */
export function indentShown(
  shown: TaskRow[],
): (TaskRow & { shownDepth: number; parentTitle?: string })[] {
  const depthOf = new Map<string, number>();
  const titleOf = new Map(shown.map((r) => [r.id, r.title]));
  return shown.map((row) => {
    const parent = row.parentId;
    const parentDepth = parent !== undefined ? depthOf.get(parent) : undefined;
    const shownDepth = parentDepth === undefined ? 0 : parentDepth + 1;
    depthOf.set(row.id, shownDepth);
    const parentTitle = shownDepth > 0 && parent ? titleOf.get(parent) : undefined;
    return { ...row, shownDepth, ...(parentTitle !== undefined ? { parentTitle } : {}) };
  });
}
