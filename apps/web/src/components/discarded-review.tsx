"use client";

import { discardedAiReviews, type Task } from "@sacty/core";
import { useMessages } from "@/i18n/client";

/**
 * 古い head へのレビューとして取り込まずに捨てた、AI のレビューの指摘を出す（PBI-291）。人が PR を承認・マージする前に
 * 気づけるよう、承認待ちの画面とタスクの詳細に出す。捨てた理由（古い head）と、指摘の要点・リンクを添える。作り直しには取り込まない
 * ので、今の head に当てはまると人が判断したら、差し戻しの指摘として伝える。
 */
export function DiscardedReviewNotice({ task }: { task: Task }) {
  const { task: m } = useMessages();
  const discarded = discardedAiReviews(task);
  if (!discarded) return null;
  return (
    <section
      aria-labelledby="discarded-review"
      data-testid="discarded-review"
      className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-soft px-5 py-4"
    >
      <h2 id="discarded-review" className="text-[15px] font-semibold text-warn">
        {m.discardedReview.title(discarded.items.length)}
      </h2>
      <p className="text-sm">
        {m.discardedReview.help(discarded.number, discarded.head.slice(0, 7))}
      </p>
      <ul className="flex flex-col gap-1.5 text-sm leading-6">
        {discarded.items.map((item) => (
          <li key={item.key} className="flex flex-col">
            <span className="text-xs text-muted-foreground">
              {item.author} / {m.discardedReview.reviewed(item.commit.slice(0, 7))}
            </span>
            {item.summary && <span className="break-words">{item.summary}</span>}
            {item.url && (
              <a
                href={item.url}
                target="_blank"
                rel="noreferrer noopener"
                className="w-fit text-accent-foreground underline"
              >
                {m.discardedReview.open}
              </a>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
