"use client";

import Link from "next/link";
import { useMessages } from "@/i18n/client";
import { elapsedText, preparingNow, runningNow } from "@/lib/run-status";
import type { TaskDetailData } from "@/lib/task-detail-data";
import { useClock } from "@/lib/use-clock";

/**
 * 概要の「いま実行していること」の1行。工程のエージェントを実行中なら「工程の名前・経過・ログを見る」、最初の工程の前なら、
 * していることの名前だけ（始まった時刻・実行の ID を持たないので、経過もログも出さない）。ほかの状態では何も出さない。
 * 経過は aria-live に入れない（進むたびに読み上げない）。
 */
export function RunStatusLine({ data }: { data: TaskDetailData }) {
  const { task, activity } = data;
  const messages = useMessages();
  const m = messages.task.runStatus;
  const run = runningNow(task, activity);
  const now = useClock(run?.startedAtMs);
  const phase = preparingNow(task);
  if (!run && !phase) return null;
  const text = run
    ? run.step
      ? m.running(messages.labels.step[run.step])
      : m.runningUnknown
    : messages.labels.state.preparing[phase as NonNullable<typeof phase>];
  return (
    <p
      data-testid="run-status"
      className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 rounded-xl border border-border bg-card px-4 py-3 text-sm break-words"
    >
      <span className="font-medium">{text}</span>
      {run?.startedAtMs !== undefined && (
        <>
          <span aria-hidden="true">{m.separator}</span>
          <span suppressHydrationWarning className="tabular-nums">
            <span className="sr-only">{m.elapsedLabel}</span>
            {elapsedText(now - run.startedAtMs, m.elapsed)}
          </span>
        </>
      )}
      {run && (
        <>
          <span aria-hidden="true">{m.separator}</span>
          <Link
            href={`/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(run.runId)}`}
            className="text-accent-foreground underline"
          >
            {messages.runLog.open}
          </Link>
        </>
      )}
    </p>
  );
}
