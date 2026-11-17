import type { Task } from "@sacty/core";

/**
 * 観点ごとの担当を起動しないレビューが続いたために、止まっているか（PBI-379）。
 *
 * 一時停止の説明が、その止まり方の文言（`review.notDispatchedPaused`）のときだけ。やり直しの途中で人が一時停止した・やり直しの
 * 実行が別の理由（利用上限・エラー・予算）で止まったときは、採らなかった実行があっても、この止まり方ではない。
 */
export function pausedForUndispatchedReview(task: Pick<Task, "status" | "pausedMessage">): boolean {
  const stopped = task.pausedMessage;
  return (
    task.status === "paused" &&
    typeof stopped === "object" &&
    stopped !== null &&
    stopped.code === "review.notDispatchedPaused"
  );
}
