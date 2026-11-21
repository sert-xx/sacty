import type { Task } from "./projection.js";

/**
 * 人の出番の組（PBI-442）。decision：人が判断すれば先へ進む（承認待ち・エスカレーション）、paused：止まったまま
 * （一時停止。理由は問わない）。
 */
export type PersonTurnGroup = "decision" | "paused";

/** 組の並び（上の組が先）。 */
export const PERSON_TURN_GROUPS: readonly PersonTurnGroup[] = ["decision", "paused"];

type PersonTurnInput = Pick<Task, "status" | "pendingReview">;

/** 承認待ちで、AI が PR の指摘の戻し先を判断している間か（人の出番に入れない）。 */
export function isAwaitingAiJudgement(task: PersonTurnInput): boolean {
  return task.status === "awaiting_approval" && Boolean(task.pendingReview);
}

/**
 * タスクが人の出番か、出番ならどちらの組か。出番でなければ undefined。画面（ダッシュボード・ベル・一覧のカード）・
 * MCP・デーモンの集計は、人の出番の判定をここで行う（写しを持たない）。
 */
export function personTurnGroup(task: PersonTurnInput): PersonTurnGroup | undefined {
  if (task.status === "escalated") return "decision";
  if (task.status === "awaiting_approval")
    return isAwaitingAiJudgement(task) ? undefined : "decision";
  if (task.status === "paused") return "paused";
  return undefined;
}

export type PersonTurnTask<T> = {
  task: T;
  group: PersonTurnGroup;
  /** 待ち始めた時刻（ISO 8601）。集計に記録が無ければ updatedAt。 */
  waitingSince: string;
  /** waitingSince が集計の記録か（false なら updatedAt で代えた）。 */
  recorded: boolean;
};

/**
 * 人の出番のタスクを、組（decision → paused）→ 待ち始めの古い順 → ID の順に並べる。projectIds にないプロジェクト
 * （消したプロジェクト）のタスクは入れない。
 */
export function personTurnTasks<
  T extends PersonTurnInput & Pick<Task, "id" | "projectId" | "updatedAt">,
>(
  tasks: readonly T[],
  options: {
    projectIds: ReadonlySet<string>;
    waitingSince: Readonly<Record<string, string>>;
  },
): PersonTurnTask<T>[] {
  const out: PersonTurnTask<T>[] = [];
  for (const task of tasks) {
    if (!options.projectIds.has(task.projectId)) continue;
    const group = personTurnGroup(task);
    if (!group) continue;
    const recorded = options.waitingSince[task.id];
    out.push({
      task,
      group,
      waitingSince: recorded ?? task.updatedAt,
      recorded: recorded !== undefined,
    });
  }
  return out.sort(
    (a, b) =>
      PERSON_TURN_GROUPS.indexOf(a.group) - PERSON_TURN_GROUPS.indexOf(b.group) ||
      a.waitingSince.localeCompare(b.waitingSince) ||
      a.task.id.localeCompare(b.task.id),
  );
}
