import { createHash } from "node:crypto";
import type { ActivityEvent } from "@sacty/core";
import { type AgentFiles, getAgentFiles, getRunLog, getTask, type RunLogMeta } from "@/lib/daemon";
import { runLogId } from "@/lib/session-log";

/** 実行のログの画面に出すもの（PBI-62・PBI-108）。 */
export type RunLogData = {
  taskId: string;
  taskTitle: string;
  projectId: string;
  /** この実行の作業履歴の行（開始・完了・失敗など）。 */
  rows: ActivityEvent[];
  /** ログ（まだ無い・読めないときは null）。 */
  log: { meta: RunLogMeta; events: string; stderr: string } | null;
  agentFiles: AgentFiles | null;
};

/** 実行のログの画面のデータ。タスクが無ければ null。デーモンに届かなければ例外。 */
export async function loadRunLog(id: string, runId: string): Promise<RunLogData | null> {
  const found = await getTask(id);
  if (!found) return null;
  const [log, agentFiles] = await Promise.all([getRunLog(id, runId), getAgentFiles(id, runId)]);
  return {
    taskId: found.task.id,
    taskTitle: found.task.title,
    projectId: found.task.projectId,
    rows: found.activity.filter((e) => runLogId(e) === runId),
    log,
    agentFiles,
  };
}

/** 文の目印（中身が同じなら同じ）。画面が持っている部分が、いまのファイルの先頭と同じかを確かめる。 */
export function textMark(text: string): string {
  return createHash("sha256").update(text).digest("base64url");
}

/**
 * 画面が持っている文（先頭から length 文字、目印 mark）に続く分（PBI-108）。いまの文の先頭が持っている文と同じなら、
 * 足された分だけを返す（from は length）。違えば（大きすぎて途中を省いた形に書き直されたなど）、全体を返す（from は 0）。
 */
export function appendedText(
  full: string,
  length: number,
  mark: string | undefined,
): { from: number; text: string; mark: string } {
  const same =
    length > 0 &&
    length <= full.length &&
    mark !== undefined &&
    textMark(full.slice(0, length)) === mark;
  return same
    ? { from: length, text: full.slice(length), mark: textMark(full) }
    : { from: 0, text: full, mark: textMark(full) };
}
