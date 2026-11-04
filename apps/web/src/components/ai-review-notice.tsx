"use client";

import type { Task } from "@sacty/core";
import { useMessages } from "@/i18n/client";

/**
 * 承認待ちの PR の今の head に、sacty の AI のレビューが付いているか（付いていない・レビュー中・付いた）を出す（PBI-302 D1）。
 * 作り直した head にレビューが届く前に、人がマージに進まないよう気づけるようにするだけで、承認やマージは止めない。
 */
export function AiReviewNotice({ task }: { task: Task }) {
  const { task: m } = useMessages();
  const state = task.aiReview;
  if (!state) return null;
  const head = state.head.slice(0, 7);
  const url = state.url && /^https:\/\/[^\s"'<>]+$/.test(state.url) ? state.url : undefined;
  return (
    <section
      aria-labelledby="ai-review"
      data-testid="ai-review"
      data-status={state.status}
      className={`flex flex-col gap-1.5 rounded-xl border px-5 py-4 ${
        state.status === "attached" ? "border-accent-line" : "border-warn-line bg-warn-soft"
      }`}
    >
      <h2 id="ai-review" className="text-[15px] font-semibold">
        {m.aiReview.title}
      </h2>
      <p className="text-sm">{m.aiReview[state.status](head)}</p>
      {state.status !== "attached" && (
        <p className="text-xs text-muted-foreground">{m.aiReview.help}</p>
      )}
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          className="w-fit text-sm text-accent-foreground underline"
        >
          {m.aiReview.open}
        </a>
      )}
    </section>
  );
}
