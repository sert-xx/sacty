import type { ActivityEvent } from "@sacty/core";
import { type AgentFiles, getAgentFiles, getRunLog, getTask, type RunLog } from "@/lib/daemon";
import { runLogId } from "@/lib/session-log";

/** 実行のログの画面に出すもの（PBI-62・PBI-108）。 */
export type RunLogData = {
  taskId: string;
  taskTitle: string;
  projectId: string;
  /** この実行の作業履歴の行（開始・完了・失敗など）。 */
  rows: ActivityEvent[];
  /** ログ（まだ無い・読めないときは null）。 */
  log: RunLog | null;
  agentFiles: AgentFiles | null;
  /** エージェントの元のファイルの一覧を読めなかった（後で取り直す。PR #119 レビュー指摘）。 */
  agentFilesFailed?: boolean;
};

/**
 * エージェントの元のファイルの一覧（PBI-66）。読めなければ failed（ログの本体とは分け、一覧だけを後で取り直す。
 * PR #119 レビュー指摘）。
 */
export async function loadAgentFiles(
  id: string,
  runId: string,
): Promise<{ agentFiles: AgentFiles | null } | { failed: true }> {
  try {
    return { agentFiles: await getAgentFiles(id, runId) };
  } catch {
    return { failed: true };
  }
}

/** 実行のログの画面のデータ。タスクが無ければ null。デーモンに届かなければ例外。 */
export async function loadRunLog(id: string, runId: string): Promise<RunLogData | null> {
  const found = await getTask(id);
  if (!found) return null;
  const [log, files] = await Promise.all([getRunLog(id, runId), loadAgentFiles(id, runId)]);
  return {
    taskId: found.task.id,
    taskTitle: found.task.title,
    projectId: found.task.projectId,
    rows: found.activity.filter((e) => runLogId(e) === runId),
    log,
    ...("failed" in files ? { agentFiles: null, agentFilesFailed: true } : files),
  };
}
