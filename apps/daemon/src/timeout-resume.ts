import type { ActivityEvent, AgentRunContinuedReason, DaemonText } from "@sacty/core";
import { checkArchivedFiles } from "./agent-sessions.js";
import { implementCompletionLines } from "./completion.js";
import { sessionMainFile, validSessionId } from "./orchestrator-sessions.js";

/**
 * 時間切れで止めた実行を、再開のときにエージェントのセッションの続きから進める（PBI-280）。
 *
 * 止めた実行は、作業履歴に `AgentRunTimedOut` を残す。その実行のセッション（エージェントが自分で書いた元のファイル）は
 * `AgentSessionArchived` に写してあるので、次に同じ役割を同じエージェントで実行するときは、それを設定の場所に戻して、
 * それぞれの再開の仕組み（Claude Code の --resume・Codex の resume）で続ける。続けたか、続けられずに最初から実行し直したかは、
 * `AgentRunContinued` に残す。
 *
 * 未完了で終わった実装の実行（`ImplementationIncomplete`）の次の実装の実行も、同じ仕組みで、セッションの続きから進める
 * （PBI-350）。最初からやり直すと、前の実行の会話を捨てて、指示の全文を読むところから始まるため。
 */

type Payload<T extends ActivityEvent["type"]> = Extract<ActivityEvent, { type: T }>["payload"];
export type TimedOutRun = Payload<"AgentRunTimedOut">;

/** 続きの元になる、前の実行。runtime が無いのは、エージェントのファイルを写した記録が無い実行（AI の種類が分からない）。 */
export type StoppedRun = {
  runId: string;
  role: string;
  agentId: string;
  runtime?: "claude-code" | "codex";
};

/**
 * 何の続きか。timeout は時間切れで止めた実行（止めた上限の分）、incomplete は未完了で終わった実装の実行（paused は、その後に
 * タスクが一時停止したか。一時停止を挟んだ続きには、人の補足や新しい指摘が入りうるので、指示の全文を渡す）。
 */
export type ContinueCause =
  | { kind: "timeout"; minutes: number }
  | { kind: "incomplete"; paused: boolean };

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

/**
 * 直前の実装の実行が未完了で終わったものなら、その実行（PBI-350）。作業履歴を新しいほうから見て、最初に出会う実行の記録で
 * 決める：未完了の記録（ImplementationIncomplete）なら、その前の実装の完了（AgentRunCompleted）の実行。ほかの実行の記録
 * （エージェントのファイルを写した記録・開始・失敗）に先に出会ったら、未完了の後に別の実行があったので無し（時間切れで
 * 止めた実行は、timedOutRunBefore が先に扱う）。質問への答え（chat）は、挟まっても数えない。
 * paused は、未完了の記録より後に、タスクが一時停止したか。
 */
export function incompleteRunBefore(
  events: readonly ActivityEvent[],
  currentRunId?: string,
): { run: StoppedRun; paused: boolean } | undefined {
  let paused = false;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (!event) continue;
    if (event.type === "TaskPaused") paused = true;
    if (event.type === "ImplementationIncomplete") {
      for (let j = i - 1; j >= 0; j--) {
        const before = events[j];
        if (before?.type !== "AgentRunCompleted") continue;
        if (before.payload.step !== "implement") return undefined;
        const runId = before.payload.runId;
        const archived = events.find(
          (e) => e.type === "AgentSessionArchived" && e.payload.runId === runId,
        );
        return {
          run: {
            runId,
            role: "implement",
            agentId: before.payload.agentId,
            ...(archived?.type === "AgentSessionArchived"
              ? { runtime: archived.payload.runtime }
              : {}),
          },
          paused,
        };
      }
      return undefined;
    }
    if (event.type === "AgentRunTimedOut" || event.type === "AgentRunContinued") return undefined;
    if (event.type === "AgentSessionArchived" && event.payload.role !== "chat") return undefined;
    if (
      (event.type === "AgentRunStarted" || event.type === "AgentRunFailed") &&
      event.payload.runId !== currentRunId
    ) {
      return undefined;
    }
  }
  return undefined;
}

export type ContinuePlan =
  | {
      mode: "resume";
      stopped: StoppedRun;
      cause: ContinueCause;
      sessionId: string;
      filesDir: string;
    }
  | { mode: "restart"; stopped: StoppedRun; cause: ContinueCause; reason: AgentRunContinuedReason };

/**
 * 実行の前に、前の実行（時間切れで止めた実行か、未完了で終わった実装の実行）のセッションを続けられるかを決める。前の実行が
 * どちらでもない・別の役割なら undefined（今までどおり。何も記録しない）。同じ役割なら、続けるか、続けられない理由を返す。
 * 続けるのは、同じエージェント（AI の種類と ID）で、写したファイルが記録どおりにそろっているとき。
 */
export async function planContinuation(
  events: readonly ActivityEvent[],
  run: { role: string; agentId: string; runtime: string; runId?: string },
  filesDirOf: (runId: string) => string | undefined,
): Promise<ContinuePlan | undefined> {
  const timedOut = timedOutRunBefore(events, run.runId);
  const incomplete = timedOut ? undefined : incompleteRunBefore(events, run.runId);
  const stopped: StoppedRun | undefined = timedOut ?? incomplete?.run;
  if (!stopped || stopped.role !== run.role) return undefined;
  const cause: ContinueCause = timedOut
    ? { kind: "timeout", minutes: timedOut.minutes }
    : { kind: "incomplete", paused: incomplete?.paused === true };
  const restart = (reason: AgentRunContinuedReason): ContinuePlan => ({
    mode: "restart",
    stopped,
    cause,
    reason,
  });
  let archived: Payload<"AgentSessionArchived"> | undefined;
  for (const event of events) {
    if (event.type === "AgentSessionArchived" && event.payload.runId === stopped.runId) {
      archived = event.payload;
    }
  }
  // 未完了で終わった実行の AI の種類は、写したファイルの記録にしか無い。記録が無ければ、続けるセッションも無い
  if (!stopped.runtime) return restart("no_session");
  // 別のエージェントのセッションは続けられない
  if (stopped.agentId !== run.agentId || stopped.runtime !== run.runtime) {
    return restart("agent_changed");
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
  return { mode: "resume", stopped, cause, sessionId: archived.sessionId, filesDir };
}

/**
 * 未完了で終わった実装の実行を続ける実行の指示（PBI-350）。セッションの続きであること、提出していないこと、残っていること、
 * この実行の中で最後まで実装すること、最後のメッセージを出し直すことを伝える。
 * - full が false（間に一時停止が無い、自動の続き）：最初の指示の全文は、会話に残っているので送り直さない（続きのたびに全文を
 *   足すと、文脈が膨らむ）。完了の申告の形だけは、もう一度添える。呼び出し側が、後ろに、実行ごとに変わりうる案内を足す。
 * - full が true（一時停止を挟んだ続き）：後ろに、指示の全文（人の補足・新しい指摘を含む）を続ける。残っていることは、
 *   全文の中の「前回の実行」の節にあるので、ここでは繰り返さない。
 */
export function incompleteResumeLines(
  feedback:
    | { remaining: readonly string[]; undeclared?: boolean; unmapped?: readonly string[] }
    | undefined,
  full: boolean,
): string[] {
  const unmapped = feedback?.unmapped ?? [];
  const why =
    unmapped.length > 0
      ? "完了と申告しましたが、観点とテストの対応に、テストの対応していないテスト観点がありました"
      : feedback?.undeclared
        ? "完了の申告が無いか、決まった形どおりに読めないまま終わりました"
        : "範囲を実装し終える前に終わり、未完了と申告しました";
  const left = full
    ? []
    : unmapped.length > 0
      ? [`テストが対応していなかったテスト観点：${unmapped.join("、")}`]
      : (feedback?.remaining.length ?? 0) > 0
        ? [
            "直前の申告にあった、残っていること：",
            ...(feedback?.remaining ?? []).map((r) => `- ${r}`),
          ]
        : [];
  return [
    `【未完了からの続き】この実行は、直前の実装の実行のセッションの続きです。直前の実行は、${why}。sacty は提出していません（PR は、作っていません・更新していません）。`,
    "これまでの会話に、最初の指示（範囲・観点・出力の形式）と、読んだもの・書いたもの・実行した結果が残っています。作業領域にも、これまでの変更が残っています（未コミットの変更も含む）。同じ調査・変更をやり直さず、現状を確かめてから、止まったところから続けてください。",
    "コンテナの中の作業領域の外のファイル（/tmp など）と、インストールしたものは残っていません。必要なら作り直してください。",
    ...left,
    "- この実行の中で、範囲のすべて（最初の指示が求める、実装すること・観点・指摘への対応）を実装し終える。区切りのよい所で実行を終えない（実行を終えるたびに、sacty はこのセッションを再開するだけで、途中で終えても進まない）",
    "- 上の一覧は、直前の申告の写しで、範囲のすべてとは限らない。完了を申告する前に、範囲の項目を1つずつ、いまのファイルとテストの結果で確かめる（終わったはず、で申告しない）",
    "- 最後のメッセージは、最初の指示が求める出力のすべて（実装の説明・観点とテストの対応・指摘への対応・検証の記録・完了の申告など）を、省かずに出し直す。直前の実行の最後のメッセージは、提出されていない",
    ...(full
      ? [
          "次の指示は、最初の指示と同じ内容に、止めている間に人が足した補足や新しい指摘を含めたものです。",
          "",
        ]
      : implementCompletionLines()),
  ];
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
