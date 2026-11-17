"use client";

import { type DeferralHandling, decidedDeferrals, type Task } from "@sacty/core";
import Link from "next/link";
import { useMessages } from "@/i18n/client";

type Decided = ReturnType<typeof decidedDeferrals>[number];

/**
 * 後続に回すと決めた指摘の、扱いと、その結果（後続のタスク・Issue へのリンク、できなかった理由、まだなら予定）。
 * 承認の画面の決定済みの記録と、タスクの詳細の一覧で、同じ文で出す。扱いの無い決定（何もしない）では使わない。
 */
export function DeferralHandledLine({
  handling,
  handled,
}: {
  handling: Exclude<DeferralHandling, "none">;
  handled: Decided["handled"];
}) {
  const { task: m, labels } = useMessages();
  const t = m.deferral;
  return (
    <>
      {handling === "task" ? t.handlingTask : t.handlingIssue}
      {" ・ "}
      {handled?.failure !== undefined ? (
        <span data-testid="deferral-failure" className="text-warn">
          {t.handlingFailed(labels.text(handled.failure))}
        </span>
      ) : handled?.taskId ? (
        <Link href={`/tasks/${handled.taskId}`} className="text-accent-foreground underline">
          {t.handledTask}
        </Link>
      ) : handled?.url ? (
        <a
          href={handled.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-accent-foreground underline"
        >
          {t.handledIssue}
        </a>
      ) : handling === "task" ? (
        t.handlingPendingTask
      ) : (
        t.handlingPendingIssue
      )}
    </>
  );
}

/** タスクの詳細に出す、後続に回すと決めた指摘（後続のタスクか Issue を作る扱いのもの）。 */
export function handledDeferrals(
  task: Task,
): (Decided & { handling: Exclude<DeferralHandling, "none"> })[] {
  return decidedDeferrals(task).flatMap((d) =>
    d.decision === "defer" &&
    (d.handling === "task" || d.handling === "issue") &&
    // 中止したタスクでは、後続のタスクを作らず、止まった Issue の作成も記録しないので、結果のあるものだけを出す
    (task.status !== "cancelled" || d.handled)
      ? [{ ...d, handling: d.handling }]
      : [],
  );
}

/**
 * 後続に回すと決めた指摘の扱いの結果を、タスクの詳細に出す（PBI-384）。後続のタスクは、元のタスクが完了してから作るので、
 * 結果（後続のタスクへのリンク・作れなかった理由）は、承認の画面の決定済みの記録（実装の承認待ちの間だけ出る）では読めない。
 * 完了したタスクの詳細で、作業履歴を開かなくても読めるようにする。できなかった指摘があれば、注意の色で出す。
 */
export function DeferralHandledNotice({ task }: { task: Task }) {
  const { task: m } = useMessages();
  const t = m.deferral;
  const items = handledDeferrals(task);
  if (items.length === 0) return null;
  const failed = items.some((d) => d.handled?.failure !== undefined);
  return (
    <section
      aria-labelledby="deferral-handled"
      data-testid="deferral-results"
      className={`flex flex-col gap-1.5 rounded-xl border px-5 py-4 ${
        failed ? "border-warn-line bg-warn-soft" : "border-accent-line"
      }`}
    >
      <h2 id="deferral-handled" className="text-[15px] font-semibold">
        {t.handledTitle(items.length)}
      </h2>
      <ul className="flex flex-col gap-1 text-sm leading-6">
        {items.map((d) => (
          <li
            key={d.remarkId}
            data-testid="deferral-result"
            className="flex flex-col [overflow-wrap:anywhere]"
          >
            <span>
              <span className="font-medium">{t.remark(d.remarkId)}</span>
              {" ・ "}
              <DeferralHandledLine handling={d.handling} handled={d.handled} />
            </span>
            {/* どの指摘かを、ID だけでなく文でも見分けられるようにする（長ければ 2 行まで。全文は title で読める） */}
            <span
              data-testid="deferral-result-text"
              title={d.text}
              className="line-clamp-2 text-xs text-muted-foreground"
            >
              {d.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
