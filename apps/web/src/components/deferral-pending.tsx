"use client";

import { deferProposals, type Task } from "@sacty/core";
import Link from "next/link";
import { useMessages } from "@/i18n/client";

/**
 * 実装が「後続に回したい」と申告した指摘（案）のうち、人がまだ決めていないものがあることを、タスクの詳細に出す（PBI-370）。
 * PR を作った実装の承認待ちでは、タスクの詳細から PR を開くので、承認の画面を開かなくても気づけるようにする。決めるのは、
 * 承認の画面（一覧と、指摘ごとの決定）。
 */
export function DeferralPendingNotice({ task }: { task: Task }) {
  const { task: m } = useMessages();
  const count = deferProposals(task).length;
  if (count === 0) return null;
  return (
    <section
      aria-labelledby="deferral-pending"
      data-testid="deferral-pending"
      className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-soft px-5 py-4"
    >
      <h2 id="deferral-pending" className="text-[15px] font-semibold text-warn">
        {m.deferral.title(count)}
      </h2>
      <p className="text-sm">{m.deferral.help}</p>
      <Link
        href={`/tasks/${task.id}/review`}
        className="w-fit text-sm text-accent-foreground underline"
      >
        {m.deferral.decide}
      </Link>
    </section>
  );
}
