import {
  type ActivityEvent,
  failureKind,
  type PreparingPhase,
  type StepKey,
  type Task,
} from "@sacty/core";
import { runLogId } from "@/lib/session-log";

/** いま実行している工程のエージェントの実行（タスクの概要の行。経過の起点は、その実行の開始の記録の時刻）。 */
export type RunningNow = {
  runId: string;
  /** 実行を始めた記録の工程。記録が無ければ、いま作業中の工程。それも無ければ undefined。 */
  step: StepKey | undefined;
  /** 実行を始めた時刻（ミリ秒）。記録が無い・読めないときは undefined（経過を出さない）。 */
  startedAtMs: number | undefined;
};

/** 工程のエージェントを実行中なら、その実行。実行中でなければ undefined（実行待ち・承認待ち・一時停止・完了・中止など）。 */
export function runningNow(task: Task, activity: readonly ActivityEvent[]): RunningNow | undefined {
  if (task.status !== "running" || !task.currentRunId) return undefined;
  const runId = task.currentRunId;
  const started = [...activity]
    .reverse()
    .find((e) => e.type === "AgentRunStarted" && e.payload.runId === runId);
  const at = started ? Date.parse(started.at) : Number.NaN;
  return {
    runId,
    step:
      started?.type === "AgentRunStarted"
        ? started.payload.step
        : task.steps.find((s) => s.state === "active")?.key,
    startedAtMs: Number.isNaN(at) ? undefined : at,
  };
}

/** 最初の工程が始まる前に、sacty が進めている処理の段階。無ければ undefined。 */
export function preparingNow(task: Task): PreparingPhase | undefined {
  return task.status === "queued" ? task.preparing : undefined;
}

/**
 * 経過の書き方：1分未満／N分／N時間／N時間M分（1時間以上で、分が 0 なら時間だけ）。
 * 画面の言葉は e が持つ。負の値（時計のずれ）は 0 として扱う。
 */
export function elapsedText(
  ms: number,
  e: {
    underMinute: string;
    minutes: (n: number) => string;
    hours: (h: number) => string;
    hoursMinutes: (h: number, min: number) => string;
  },
): string {
  const total = Math.floor(Math.max(0, ms) / 60_000);
  if (total < 1) return e.underMinute;
  if (total < 60) return e.minutes(total);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? e.hours(hours) : e.hoursMinutes(hours, minutes);
}

/**
 * 一時停止の原因になった実行（止まった実行のログへの道。実行の ID）。いまの一時停止（最後の TaskPaused）の直前の失敗だけを
 * 採る：TaskPaused から作業履歴をさかのぼり、ログを開ける実行の失敗（エラーの種類。AgentRunFailed・OrchestratorFailed など）
 * を採る。別の実行の開始・完了などの実行の行・再開・人が手で止めた一時停止に当たったら、そこで止める（過去の失敗へつながない）。
 * 一時停止の記録が続いて並ぶとき（マージの後の2つ目など）は、それも越えてさかのぼる。
 */
export function stoppedRunId(task: Task, activity: readonly ActivityEvent[]): string | undefined {
  if (task.status !== "paused" || task.pausedReason === "manual") return undefined;
  const paused = activity.findLastIndex((e) => e.type === "TaskPaused");
  if (paused < 0) return undefined;
  for (let i = paused - 1; i >= 0; i--) {
    const e = activity[i];
    if (!e) continue;
    if (e.type === "TaskResumed") return undefined;
    if (e.type === "TaskPaused") {
      if (e.payload.reason === "manual") return undefined;
      continue;
    }
    const runId = runLogId(e);
    if (runId === undefined) continue;
    return failureKind(e) === "error" ? runId : undefined;
  }
  return undefined;
}
