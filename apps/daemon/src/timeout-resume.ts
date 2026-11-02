import type { ActivityEvent, AgentRunContinuedReason, DaemonText } from "@sacty/core";
import { checkArchivedFiles } from "./agent-sessions.js";
import { sessionMainFile, validSessionId } from "./orchestrator-sessions.js";

/**
 * 時間切れで止めた実行を、再開のときにエージェントのセッションの続きから進める（PBI-280）。
 *
 * 止めた実行は、作業履歴に `AgentRunTimedOut` を残す。その実行のセッション（エージェントが自分で書いた元のファイル）は
 * `AgentSessionArchived` に写してあるので、次に同じ役割を同じエージェントで実行するときは、それを設定の場所に戻して、
 * それぞれの再開の仕組み（Claude Code の --resume・Codex の resume）で続ける。続けたか、続けられずに最初から実行し直したかは、
 * `AgentRunContinued` に残す。
 */

type Payload<T extends ActivityEvent["type"]> = Extract<ActivityEvent, { type: T }>["payload"];
export type TimedOutRun = Payload<"AgentRunTimedOut">;

/** 時間切れの止め方（run.timeout）で止めた失敗か。コンテナの停止を確かめられなかった失敗（run.containerNotConfirmed）は含めない。 */
export function timeoutMinutes(message: DaemonText): number | undefined {
  if (typeof message === "string" || message.code !== "run.timeout") return undefined;
  const minutes = message.params?.minutes;
  return typeof minutes === "number" && minutes > 0 ? minutes : undefined;
}

/**
 * 直前の実行が時間切れで止まったものなら、その実行。作業履歴を新しいほうから見て、最初に出会う実行の記録で決める：
 * 時間切れの記録 (AgentRunTimedOut) ならその実行、続けた記録 (AgentRunContinued) ならすでに続けたので無し、
 * それ以外の実行（エージェントのファイルを写した記録）なら、時間切れの後に別の実行があったので無し。
 * 質問への答え（chat）は、時間切れの後に挟まっても数えない。
 * 続けた実行がデーモンの停止などで中断されると、写した記録も続けた記録も残らない。その実行の開始・失敗の記録（時間切れで止めた
 * 実行自身と、いま実行する currentRunId のものを除く）も別の実行として数え、進捗を含まない古い会話を続けない。
 */
export function timedOutRunBefore(
  events: readonly ActivityEvent[],
  currentRunId?: string,
): TimedOutRun | undefined {
  const stoppedRuns = new Set<string>();
  for (const event of events)
    if (event.type === "AgentRunTimedOut") stoppedRuns.add(event.payload.runId);
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "AgentRunTimedOut") return event.payload;
    if (event.type === "AgentRunContinued") return undefined;
    if (event.type === "AgentSessionArchived" && event.payload.role !== "chat") return undefined;
    if (
      (event.type === "AgentRunStarted" || event.type === "AgentRunFailed") &&
      event.payload.runId !== currentRunId &&
      !stoppedRuns.has(event.payload.runId)
    ) {
      return undefined;
    }
  }
  return undefined;
}

export type ContinuePlan =
  | { mode: "resume"; stopped: TimedOutRun; sessionId: string; filesDir: string }
  | { mode: "restart"; stopped: TimedOutRun; reason: AgentRunContinuedReason };

/**
 * 実行の前に、前の時間切れの実行のセッションを続けられるかを決める。前の実行が時間切れでない・別の役割なら undefined
 * （今までどおり。何も記録しない）。同じ役割なら、続けるか、続けられない理由を返す。
 * 続けるのは、同じエージェント（AI の種類と ID）で、写したファイルが記録どおりにそろっているとき。
 */
export async function planTimeoutResume(
  events: readonly ActivityEvent[],
  run: { role: string; agentId: string; runtime: string; runId?: string },
  filesDirOf: (runId: string) => string | undefined,
): Promise<ContinuePlan | undefined> {
  const stopped = timedOutRunBefore(events, run.runId);
  if (!stopped || stopped.role !== run.role) return undefined;
  const restart = (reason: AgentRunContinuedReason): ContinuePlan => ({
    mode: "restart",
    stopped,
    reason,
  });
  // 別のエージェントのセッションは続けられない
  if (stopped.agentId !== run.agentId || stopped.runtime !== run.runtime) {
    return restart("agent_changed");
  }
  let archived: Payload<"AgentSessionArchived"> | undefined;
  for (const event of events) {
    if (event.type === "AgentSessionArchived" && event.payload.runId === stopped.runId) {
      archived = event.payload;
    }
  }
  if (
    !archived ||
    archived.notArchived ||
    archived.files.length === 0 ||
    !archived.sessionId ||
    !validSessionId(archived.sessionId)
  ) {
    return restart("no_session");
  }
  // 上限で間を省いたファイルは、そのまま戻しても続けられない
  if (archived.files.some((f) => f.truncated)) return restart("truncated");
  if (!sessionMainFile(stopped.runtime, archived.sessionId, archived.files)) {
    return restart("files_broken");
  }
  const filesDir = filesDirOf(stopped.runId);
  if (!filesDir) return restart("files_broken");
  const checked = await checkArchivedFiles(filesDir, archived.files);
  if (!checked.every((f) => f.status === "match")) return restart("files_broken");
  return { mode: "resume", stopped, sessionId: archived.sessionId, filesDir };
}

/** 作業領域に、止める前の変更が残る役割（実装と再現は、タスクの作業領域の clone を使う。ほかの役割は、実行ごとに新しく用意した写しを使う）。 */
export const KEEPS_WORKSPACE_ROLES: readonly string[] = ["implement", "reproduce"];

/**
 * 続ける実行の指示の先頭に足す知らせ。時間切れで止めて再開したこと、セッションの続きであること、作業領域・コンテナの中で
 * 残るものと残らないものを伝える。
 */
export function timeoutResumeLines(role: string, minutes: number): string[] {
  return [
    `【時間切れからの再開】この実行は、直前の実行が上限の ${minutes} 分を超えて止められた後の再開で、直前の実行のセッションの続きです。`,
    "これまでの会話に、読んだもの・書いたもの・実行した結果が残っています。それらを信頼して、同じ調査・検証・下書きをやり直さず、止まったところから進めてください。",
    KEEPS_WORKSPACE_ROLES.includes(role)
      ? "作業領域には、止める前に書いたファイルが残っています（未コミットの変更も含む）。変更を書き直さず、現状を確かめてから続けてください。"
      : "作業領域は新しく用意したものなので、止める前に書いたファイルは残っていません。必要なものは、会話の記録から作り直してください。",
    "コンテナの中の作業領域の外のファイル（/tmp など）と、インストールしたものは残っていません。必要なら作り直してください。",
    "次の指示は、前の実行と同じ内容（または、止めている間に人が足した補足を含むもの）です。同じ時間の上限で動くので、残りの作業を優先してください。",
    "",
  ];
}
