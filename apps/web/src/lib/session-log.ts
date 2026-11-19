import { type ActivityEvent, ERROR_ANALYSIS_ROLE } from "@sacty/core";

// セッションログの読み分けは、デーモンのエラーレポートと共通にするため core に置く
export { type LogEntry, parseSessionLog, runLogId } from "@sacty/core";

/**
 * 実行の役割（表示の名前を引くキー）。エラーの分析は、セッションログでは質問と同じ chat なので、その実行の作業履歴の行
 * （ErrorAnalyzed）から読み替える。
 */
export function runRoleKey(role: string, rows: readonly ActivityEvent[]): string {
  return rows.some((e) => e.type === "ErrorAnalyzed") ? ERROR_ANALYSIS_ROLE : role;
}
