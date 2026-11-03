import { createHash } from "node:crypto";
import { type DaemonText, type PauseReason, renderMessage } from "@sacty/core";
import { redact, redactText } from "./agents/redact.js";
import { REVIEW_STOP_MARKER_PREFIX } from "./github.js";

/*
 * Sacty のレビューが止まったことを、レビューを頼んだ PR で分かるようにする投稿（PBI-292）。
 * レビューを頼んだ人は PR だけを見ているので、タスクがエラーなどで一時停止しても気づけない。止まったら PR にコメントし、
 * 再開してレビューを投稿したら、そのコメントを解消済みに直す。
 */

/** 止まったことを PR に知らせる理由（人間が止めたとき・子タスクの中止・実装の検証は、レビューでは起きない・人が知っているので知らせない）。 */
const NOTIFIED: readonly PauseReason[] = ["error", "usage_limit", "auth", "budget"];

export function notifiesReviewStop(reason: PauseReason | undefined): boolean {
  return reason !== undefined && NOTIFIED.includes(reason);
}

const REASON: Record<string, string> = {
  error: "エラー",
  usage_limit: "AI の利用上限",
  auth: "認証エラー",
  budget: "予算の上限",
};

/** 理由の要点の長さの上限（文字数）。外から来た文（エージェントの出力・stderr など）を PR に載せるので短く切る。 */
export const SUMMARY_MAX = 300;

/**
 * 止まった理由の要点。秘密情報を伏せてから、1行にして切り詰める。順序が逆（切り詰めてから伏せる）だと、切り口にかかった秘密情報の
 * 前半が、値の全体に一致しないまま残る。
 */
export function stopSummary(text: DaemonText | undefined, secrets: readonly string[]): string {
  if (text === undefined) return "";
  const hidden = redact(renderMessage(redactText(text, secrets), "ja"), secrets);
  const oneLine = hidden.replace(/\s+/g, " ").trim();
  return oneLine.length > SUMMARY_MAX ? `${oneLine.slice(0, SUMMARY_MAX)}…` : oneLine;
}

/**
 * 止まり方の識別子（理由と要点が同じなら同じ）。同じ止まり方を、同じ PR に何度も書かないための目印の一部。
 * 要点にある数・ID・時刻のように、止まるたびに変わる部分は無視する（変わるたびに、別の止まり方として書かないように）。
 */
export function stopKey(reason: PauseReason, summary: string): string {
  const stable = summary.toLowerCase().replace(/[0-9a-f]{8,}|\d+/g, "#");
  return createHash("sha256").update(`${reason}\n${stable}`).digest("hex").slice(0, 12);
}

/** 止まったことの投稿の目印（解消前）。 */
export function stopMarker(taskId: string, key: string): string {
  return `${REVIEW_STOP_MARKER_PREFIX}${taskId}:${key} -->`;
}

/** そのタスクの、止まったことの投稿（解消前も解消後も）の目印の前半。 */
export function stopMarkerOfTask(taskId: string): string {
  return `${REVIEW_STOP_MARKER_PREFIX}${taskId}:`;
}

/** 本文が、解消前の止まったことの投稿か（目印の行が `:resolved -->` で終わらない）。 */
export function isOpenStopNotice(body: string): boolean {
  const first = body.trimStart().split("\n", 1)[0] ?? "";
  return first.startsWith(REVIEW_STOP_MARKER_PREFIX) && !first.endsWith(":resolved -->");
}

/** 止まったことを知らせる投稿の本文。 */
export function buildStopNotice(input: {
  taskId: string;
  reason: PauseReason;
  /** `stopSummary` で伏せて切り詰めた、理由の要点（無ければ空）。 */
  summary: string;
  /** タスクの画面の URL。 */
  taskUrl: string;
}): string {
  const key = stopKey(input.reason, input.summary);
  // 外から来た文は、コードにして載せる（本文の @名前 で、知らない人に通知が飛ばないように）
  return [
    stopMarker(input.taskId, key),
    "## Sacty のレビューが止まりました",
    "",
    "このレビューは、止まったため、まだ投稿されていません。",
    "",
    `- 理由：${REASON[input.reason] ?? "エラー"}${input.summary ? `（\`${input.summary.replaceAll("`", "'")}\`）` : ""}`,
    `- 再開のしかた：[タスクの画面](${input.taskUrl})を開いて、再開してください。レビューを最初からやり直します。`,
    "",
    "再開してレビューを投稿すると、この投稿は解消済みに変わります。",
  ].join("\n");
}

/** 解消済みにした投稿の本文。元の投稿の目印を解消済みの目印にし、見出しと案内を解消済みの案内に替える。 */
export function buildResolvedNotice(original: string, reviewUrl: string): string {
  const lines = original.trimStart().split("\n");
  const first = (lines[0] ?? "").replace(/ -->$/, ":resolved -->");
  // 止まったときの理由は残す（見出し・目印・再開の案内は古いので外す）
  const reason = lines.find((line) => line.startsWith("- 理由："));
  return [
    first,
    "## （解消済み）Sacty のレビューが止まりました",
    "",
    reviewUrl
      ? `再開して、レビューを投稿しました：${reviewUrl}`
      : "再開して、レビューを投稿しました。",
    "この投稿の内容は古くなっています。",
    ...(reason ? ["", "止まったときの内容：", reason] : []),
  ].join("\n");
}
