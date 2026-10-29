import type { ActivityEvent } from "./events.js";

/**
 * エラーレポートで、エラーとして扱う記録の種類。error：実行や操作の失敗、stop：タスクが止まった（人が止めたものを除く）、
 * check：テスト・CI・デプロイの確認が通らなかった。
 */
export type FailureKind = "error" | "stop" | "check";

/**
 * 作業履歴の1件が、エラーレポートでエラーとして扱う記録か。扱わないなら undefined。
 * エラーの分析（ErrorAnalyzed）は、分析の結果なのでエラーに数えない。
 */
export function failureKind(event: ActivityEvent): FailureKind | undefined {
  const payload = event.payload as Record<string, unknown>;
  switch (event.type) {
    case "ErrorAnalysisRequested":
    case "ErrorAnalyzed":
      return undefined;
    case "TaskPaused":
      return event.payload.reason === "manual" ? undefined : "stop";
    case "TaskEscalated":
      return "stop";
    case "TestsRun":
      return event.payload.passed ? undefined : "check";
    case "PullRequestCiFinished":
      return event.payload.result === "failed" || event.payload.result === "timed_out"
        ? "check"
        : undefined;
    case "DeploymentChecked":
      return event.payload.result === "unhealthy" ? "check" : undefined;
  }
  if (event.type.endsWith("Failed")) return "error";
  if (payload.failed !== undefined || payload.runResult === "failed") return "error";
  return undefined;
}

/** 作業履歴に、エラーレポートでエラーとして扱う記録があるか（画面がレポートの欄を出すか決める）。 */
export function hasFailures(activity: readonly ActivityEvent[]): boolean {
  return activity.some((e) => failureKind(e) !== undefined);
}
