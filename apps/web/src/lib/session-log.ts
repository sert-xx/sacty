import type { ActivityEvent } from "@sacty/core";

// セッションログの読み分けは、デーモンのエラーレポートと共通にするため core に置く
export { type LogEntry, parseSessionLog } from "@sacty/core";

/** 作業履歴のうち、エージェントの実行の行（ログを見られる行）。 */
const RUN_EVENTS = new Set<ActivityEvent["type"]>([
  "AgentRunStarted",
  "AgentRunCompleted",
  "AgentRunFailed",
  "StepsChosen",
  "StepsSkipped",
  "OrchestratorFailed",
  "InformationGathered",
  "TicketTriaged",
  "RepositoryChosen",
  "ChangeJudged",
  "ReworkJudged",
  "FinalReviewed",
  "FinalReviewFailed",
  "QuestionAnswered",
  "ErrorAnalyzed",
  "ExportStarted",
  "OutputExported",
  "AgentSessionArchived",
  "OrchestratorSessionUsed",
  // 完了したタスクの監査の実行（PBI-125）
  "AuditSurveyed",
  "AuditDeepDived",
  "AuditFailed",
]);

/** 作業履歴の行から、ログを見られる実行の ID。実行の行でない・ID の無い古い行なら undefined。 */
export function runLogId(event: ActivityEvent): string | undefined {
  if (!RUN_EVENTS.has(event.type)) return undefined;
  const runId = (event.payload as { runId?: unknown }).runId;
  return typeof runId === "string" && runId ? runId : undefined;
}
