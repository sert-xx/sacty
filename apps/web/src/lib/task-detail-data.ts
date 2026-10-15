import type { ActivityEvent, Task } from "@sacty/core";
import {
  type CleanupItem,
  getCleanupPlan,
  getProject,
  getStatus,
  getTask,
  listProjectRepositories,
  listTasks,
} from "@/lib/daemon";
import { canControl, needsTicketRepositories } from "@/lib/labels";

/** タスクの詳細に出すもの（画面が取り直す。PBI-108）。 */
export type TaskDetailData = {
  task: Task;
  activity: ActivityEvent[];
  projectName: string;
  /** 分割で作った子タスクの親（PBI-27）。 */
  parent?: Task;
  /** マージの後の監視で作った修正のタスクの、元のタスク（PBI-89）。 */
  origin?: Task;
  /** マージの後の監視で作った修正のタスク（PBI-89）。 */
  deploymentFix?: Task;
  /** 分割で作った子タスク（PBI-27）。 */
  children: Task[];
  /** 中止したときに片付けるもの（操作できるときだけ）。 */
  cleanupPlan?: CleanupItem[];
  /** 工程のイメージの候補の元（取得できなければ無い。PBI-106）。 */
  imageStatus?: { problems: unknown[]; images?: { name: string; description: string }[] };
  /**
   * 一時停止で、人がリポジトリを選ぶときの候補（PBI-52・PBI-73）。Org の対象はデーモンが gh で GitHub に問い合わせる
   * ので、求められたときだけ取る（取り直しのたびには取らない）。
   */
  ticketRepositories?: string[];
  /** 候補を求めたが、取れなかった（画面は、間を空けて取り直す）。 */
  ticketRepositoriesFailed?: boolean;
};

/**
 * タスクの詳細のデータ。タスクが無ければ null。デーモンに届かなければ例外。repositories のときだけ、リポジトリの
 * 候補を取る（要るときだけ）。
 */
export async function loadTaskDetail(
  id: string,
  { repositories }: { repositories: boolean },
): Promise<TaskDetailData | null> {
  const found = await getTask(id);
  if (!found) return null;
  const { task, activity } = found;
  const [project, parent, origin, deploymentFix, all, cleanupPlan, status, candidates] =
    await Promise.all([
      getProject(task.projectId),
      task.parent ? getTask(task.parent.taskId) : undefined,
      task.fix ? getTask(task.fix.taskId).catch(() => undefined) : undefined,
      task.deployment?.fix ? getTask(task.deployment.fix.taskId).catch(() => undefined) : undefined,
      task.split ? listTasks() : undefined,
      canControl(task) ? getCleanupPlan(task.id) : undefined,
      task.steps.length > 0 ? getStatus().catch(() => undefined) : undefined,
      repositories && needsTicketRepositories(task)
        ? listProjectRepositories(task.projectId).catch(() => undefined)
        : undefined,
    ]);
  const childIds = new Set((task.split?.children ?? []).map((c) => c.taskId));
  return {
    task,
    activity,
    projectName: project?.project.name ?? task.projectId,
    ...(parent ? { parent: parent.task } : {}),
    ...(origin ? { origin: origin.task } : {}),
    ...(deploymentFix ? { deploymentFix: deploymentFix.task } : {}),
    children: (all ?? []).filter((t) => childIds.has(t.id)),
    ...(cleanupPlan !== undefined ? { cleanupPlan: cleanupPlan ?? [] } : {}),
    ...(status ? { imageStatus: { problems: status.problems, images: status.images } } : {}),
    // 取れなかったときは候補を持たせず、画面が後で取り直す（取れた0件と分ける。PR #119 レビュー指摘）
    ...(repositories && needsTicketRepositories(task)
      ? candidates
        ? { ticketRepositories: candidates.repositories }
        : { ticketRepositoriesFailed: true }
      : {}),
  };
}
