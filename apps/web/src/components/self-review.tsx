"use client";

import type { StepKey, Task } from "@sacty/core";
import { cn } from "cn";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

/**
 * 提出の前のセルフレビュー（PBI-120）。パスしたか・回数を本文に出し、パスしていない・記録が無いときは目立たせる
 * （承認の判断に要るため）。総評と残った指摘・見られなかった観点は、折りたたんで読む。セルフレビューより前の記録の工程
 * （報告をさせていない）では何も出さない。
 */
export function SelfReviewNote({ task, step }: { task: Task; step: StepKey }) {
  const m = useMessages().task.selfReview;
  const review = task.selfReviews?.[step];
  if (review === undefined) return null;
  if (review === null) {
    return (
      <p
        data-testid={`self-review-${step}`}
        data-result="missing"
        className="flex items-center gap-1 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-sm text-warn"
      >
        {m.missing}
        <Hint text={m.missingHint} />
      </p>
    );
  }
  const details = [
    ...(review.remaining.length > 0 ? [{ label: m.remaining, items: review.remaining }] : []),
    ...(review.notReviewed.length > 0 ? [{ label: m.notReviewed, items: review.notReviewed }] : []),
  ];
  const head = (
    <span className="inline-flex items-center gap-1">
      {review.passed ? m.passed(review.rounds) : m.failed(review.rounds, review.remaining.length)}
      <Hint text={m.hint} />
    </span>
  );
  const box = cn(
    "rounded-lg border px-3 py-2 text-sm",
    review.passed
      ? "border-accent-line text-accent-foreground"
      : "border-warn-line bg-warn-soft text-warn",
  );
  if (!review.summary && details.length === 0) {
    return (
      <p
        data-testid={`self-review-${step}`}
        data-result={review.passed ? "passed" : "failed"}
        className={box}
      >
        {head}
      </p>
    );
  }
  return (
    <details
      data-testid={`self-review-${step}`}
      data-result={review.passed ? "passed" : "failed"}
      // パスしていないときは、残った指摘を最初から見せる
      open={!review.passed}
      className={box}
    >
      <summary className="cursor-pointer">{head}</summary>
      <div className="mt-2 flex flex-col gap-2 text-foreground">
        {review.summary && (
          <p className="[overflow-wrap:anywhere]">
            <span className="font-medium">{m.summary}：</span>
            {review.summary}
          </p>
        )}
        {details.map((d) => (
          <div key={d.label}>
            <p className="font-medium">{d.label}</p>
            <ul className="list-disc pl-5 [overflow-wrap:anywhere]">
              {d.items.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}
