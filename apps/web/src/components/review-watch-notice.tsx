"use client";

import { currentReviewVerdict, reviewWatching, type Task } from "@sacty/core";
import { WithHint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

/**
 * レビューを投稿した後の、PR の変化の見守り（PBI-411）。見守っている間は、今の回の判定と、何を待っているかを出す
 * （待っているのは PR の作者の対応で、人の出番ではない）。見守りを終えて完了したタスクには、終えた理由を出す。
 */
export function ReviewWatchNotice({ task }: { task: Task }) {
  const { task: m } = useMessages();
  const w = m.reviewWatch;
  const url =
    task.reviewPost && /^https:\/\/[^\s"'<>]+$/.test(task.reviewPost.url)
      ? task.reviewPost.url
      : undefined;
  const link = url && (
    <a
      href={url}
      target="_blank"
      rel="noreferrer noopener"
      className="w-fit text-sm text-accent-foreground underline"
    >
      {w.open}
    </a>
  );
  if (task.status === "idle" && reviewWatching(task)) {
    const round = task.reviewRound ?? 1;
    const verdict = currentReviewVerdict(task);
    const missing = task.reviewVerdicts?.findLast((v) => v.round === round)?.missing;
    return (
      <section
        aria-labelledby="review-watch"
        data-testid="review-watch"
        data-state="watching"
        className="flex flex-col gap-1.5 rounded-xl border border-border px-5 py-4"
      >
        <h2 id="review-watch" className="text-[15px] font-semibold">
          <WithHint hint={task.reviewOf ? w.parentHint : w.hint}>{w.title}</WithHint>
        </h2>
        <p role="status" className="text-sm">
          {w.verdict(
            round,
            m.reviewVerdict[verdict ?? (missing === "absent" ? "absent" : "unreadable")],
          )}
        </p>
        <p className="text-sm">{task.reviewOf ? w.waitingParent : w.waiting}</p>
        {link}
      </section>
    );
  }
  // 指摘なしで完了した後のマージ・クローズ（先頭を追うのをやめただけ）には出さない。完了の理由は、指摘なし（状態の表示と同じ）
  const ended =
    task.status !== "cancelled" && currentReviewVerdict(task) !== "no_findings"
      ? task.reviewWatchEnded
      : undefined;
  if (!ended) return null;
  return (
    <section
      aria-labelledby="review-watch"
      data-testid="review-watch"
      data-state={ended.reason}
      className="flex flex-col gap-1.5 rounded-xl border border-border px-5 py-4"
    >
      <h2 id="review-watch" className="text-[15px] font-semibold">
        {w.endedTitle}
      </h2>
      <p role="status" className="text-sm">
        {w.ended[ended.reason]}
      </p>
      {link}
    </section>
  );
}
