"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { DaemonError } from "@/components/daemon-error";
import { StaleNotice } from "@/components/live-status";
import { StatusLabelView } from "@/components/task-bits";
import { useMessages } from "@/i18n/client";
import type { DashboardData } from "@/lib/dashboard-data";
import { taskPath } from "@/lib/paths";
import { useLiveData } from "@/lib/use-live-data";

/** ダッシュボードのデータを取り直す先（PBI-114）。 */
export const DASHBOARD_LIVE_URL = "/live/dashboard";

/**
 * ダッシュボード（PBI-114）。欄（カード）を並べる。画面をリロードせず、一定の間隔でデータだけを取り直す（PBI-108）。
 * 欄を足すときは、DashboardData に欄のデータを足し、ここに DashboardCard を足す。
 * initial が null（描いたときにデーモンに届かなかった）なら、届くまで error を出し、届いたら欄を出す。
 */
export function LiveDashboard({
  initial,
  initialVersion,
  error,
}: {
  initial: DashboardData | null;
  initialVersion?: string;
  error?: string;
}) {
  const { data, stale } = useLiveData(() => DASHBOARD_LIVE_URL, initial, initialVersion);
  return (
    <>
      <StaleNotice stale={stale} />
      {!data ? (
        <DaemonError message={error ?? ""} />
      ) : (
        <DashboardGrid>
          <OpenTasksCard data={data} />
        </DashboardGrid>
      )}
    </>
  );
}

/** 欄を並べる枠。幅が足りれば横に並べ、足りなければ縦に積む（欄が1つなら幅いっぱい）。 */
export function DashboardGrid({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="dashboard-grid"
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,26rem),1fr))] items-start gap-6"
    >
      {children}
    </div>
  );
}

/** ダッシュボードの欄（カード）。見出しと、見出しの横の補足を出す。 */
export function DashboardCard({
  id,
  title,
  note,
  children,
}: {
  id: string;
  title: ReactNode;
  note?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      data-testid={`dashboard-card-${id}`}
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card"
    >
      <div className="flex items-baseline justify-between gap-3 px-5 pt-4 pb-3">
        <h2 id={id} className="text-[15px] font-semibold">
          {title}
        </h2>
        {note && <span className="text-[13px] text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/**
 * すべてのプロジェクトの、終わっていないタスク（PBI-114）。件数の上限は無く、欄の高さは5件分。それより多ければ欄の中で
 * スクロールする（取り直しでは同じ要素が残るので、スクロールの位置は消えない）。
 */
export function OpenTasksCard({ data }: { data: DashboardData }) {
  const m = useMessages().dashboard.openTasks;
  const rows = data.openTasks;
  return (
    <DashboardCard
      id="open-tasks"
      title={m.title}
      note={
        data.projects > 0 ? (
          <>
            {m.note}・<span data-testid="open-tasks-count">{m.count(rows.length)}</span>
          </>
        ) : undefined
      }
    >
      {data.projects === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">
          {m.noProjects}{" "}
          <Link href="/projects" className="text-accent-foreground underline">
            {m.createProject}
          </Link>
        </p>
      ) : rows.length === 0 ? (
        <p className="px-5 pb-5 text-sm text-muted-foreground">{m.empty}</p>
      ) : (
        // 1行は h-16（4rem）。5件分の高さ（20rem）を超えたら、欄の中でスクロールする。キーボードでもスクロールできるよう、
        // フォーカスを受ける
        <ul
          aria-label={m.list}
          data-testid="open-tasks-list"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: スクロールする欄を、キーボードでもスクロールできるようにする
          tabIndex={0}
          className="max-h-80 overflow-y-auto border-t border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {rows.map((task) => (
            <li
              key={task.id}
              data-testid={`open-task-${task.id}`}
              className="flex h-16 items-center gap-4 border-b border-border px-5 last:border-b-0 hover:bg-muted"
            >
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <Link
                  href={taskPath(task.id)}
                  className="truncate font-medium text-foreground hover:underline"
                >
                  {task.title}
                </Link>
                <span className="truncate text-xs text-muted-foreground">
                  <span className="sr-only">{m.project}</span>
                  {task.projectName}
                </span>
              </div>
              <div className="shrink-0 text-sm">
                <span className="sr-only">{m.status}</span>
                <StatusLabelView text={task.status.text} tone={task.status.tone} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </DashboardCard>
  );
}
