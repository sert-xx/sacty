import { FORK_HOLD_MARKER_PREFIX } from "./github.js";

/*
 * フォークからの PR の、新しいコミットを自動ではレビューしないことを、その PR に知らせるコメント（PBI-461）。
 * PR を見ている人は Sacty の画面を開かないので、Sacty の内部の言葉（タスク・見守り・再レビューの仕組み）を使わずに書く。
 * 目印は、同じタスクで繰り返し書かないために、投稿済みかを探す目印にする。
 */

/** 知らせの目印（タスクごと）。 */
export function forkHoldMarker(taskId: string): string {
  return `${FORK_HOLD_MARKER_PREFIX}${taskId} -->`;
}

/** 新しいコミットを自動ではレビューしないことを知らせる本文。 */
export function buildForkHoldNotice(taskId: string, commit: string): string {
  return [
    forkHoldMarker(taskId),
    `この PR はフォークからのため、新しいコミット（\`${commit.slice(0, 7)}\`）は自動ではレビューされません。もう一度レビューが必要なときは、Sacty を運用している人に、レビューのやり直しを頼んでください。`,
  ].join("\n");
}
