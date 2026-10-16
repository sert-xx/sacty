"use client";

import Link from "next/link";
import { DaemonError } from "@/components/daemon-error";
import { FollowProjectAfterRecovery, StaleNotice } from "@/components/live-status";
import { StatusLabelView, StepChipsView } from "@/components/task-bits";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";
import type { TaskListData } from "@/lib/task-list-data";
import { useLiveData } from "@/lib/use-live-data";

/** タスクの一覧のデータを取り直す先。プロジェクトは、URL のプロジェクト（PBI-114）。 */
export function taskListLiveUrl(projectId: string): string {
  return `/live/tasks?project=${encodeURIComponent(projectId)}`;
}

/**
 * 人間の判断が必要なタスクと、すべてのタスク（PBI-108）。画面をリロードせず、一定の間隔でデータだけを取り直し、
 * 新しいタスク・状態の変化を出す（タブが隠れている間は止め、見えたらすぐに取り直す）。
 * projectId は URL のプロジェクト（PBI-114）。描いたときにデーモンに届かなくても、そのプロジェクトを取り直す。
 * initial が null（描いたときにデーモンに届かなかった）なら、届くまで error を出し、届いたら一覧を出し、表示している
 * プロジェクトを URL のプロジェクトに合わせる（ヘッダーとずらさない）。
 */
export function LiveTaskList({
  projectId,
  initial,
  initialVersion,
  error,
}: {
  projectId: string;
  initial: TaskListData | null;
  initialVersion?: string;
  error?: string;
}) {
  const url = taskListLiveUrl(projectId);
  const { data, stale } = useLiveData(() => url, initial, initialVersion);
  const { tasks: m, labels } = useMessages();
  return (
    <>
      <StaleNotice stale={stale} />
      {initial === null && data && <FollowProjectAfterRecovery projectId={data.projectId} />}
      {data && data.needsYou.length > 0 && (
        <section aria-labelledby="needs-you" className="flex flex-col gap-3">
          <h2 id="needs-you" className="text-[15px] font-semibold">
            {m.needsYou}
          </h2>
          <ul className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
            {data.needsYou.map((task) => (
              <li
                key={task.id}
                className="flex flex-col gap-2.5 rounded-xl border border-warn-line bg-card p-5"
              >
                <span className="w-fit rounded-full border border-warn-line bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn">
                  {task.status}
                </span>
                <span className="text-[17px] font-semibold">{task.title}</span>
                <Link
                  href={task.action.href}
                  className="text-sm font-semibold text-accent-foreground"
                >
                  {task.action.label} →
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
      <TasksSection>
        {!data ? (
          <div className="px-5 pb-5">
            <DaemonError message={error ?? ""} />
          </div>
        ) : data.rows.length === 0 ? (
          <p className="px-5 pb-8 text-sm text-muted-foreground">{m.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-5 py-2.5 font-medium">
                    {m.column.task}
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    {m.column.start}
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    {m.column.steps} <Hint text={m.stepsHint} className="size-4" />
                  </th>
                  <th scope="col" className="px-5 py-2.5 font-medium">
                    {m.column.status}
                  </th>
                </tr>
              </thead>
              <tbody>
                {/* 分割で作った子タスクは、親のすぐ下に字下げして出す（PBI-27） */}
                {data.rows.map((task) => (
                  <tr
                    key={task.id}
                    className="border-t border-border hover:bg-muted"
                    data-testid={`task-row-${task.id}`}
                  >
                    <td className={task.child ? "py-3.5 pr-5 pl-10" : "px-5 py-3.5"}>
                      {task.child && (
                        <span aria-hidden="true" className="mr-1.5 text-muted-foreground">
                          ↳
                        </span>
                      )}
                      <Link
                        href={`/tasks/${task.id}`}
                        className="font-medium text-foreground hover:underline"
                      >
                        {task.title}
                      </Link>
                    </td>
                    <td className="px-3 py-3.5 whitespace-nowrap text-muted-foreground">
                      {labels.start[task.start]}
                      {/* テンプレートで作ったタスク（PBI-90） */}
                      {task.template && (
                        <span className="mt-0.5 block w-fit rounded border border-border px-1.5 text-xs">
                          {labels.template[task.template]}
                        </span>
                      )}
                      {task.source && (
                        <span className="block font-mono text-xs">
                          {task.source.repo}#{task.source.number}
                        </span>
                      )}
                      {/* リポジトリを指定せずに作ったタスクと、分割の子タスクに付けたリポジトリ（PBI-73） */}
                      {task.repoless && (
                        <span className="mt-0.5 block w-fit rounded border border-border px-1.5 text-xs">
                          {m.noRepository}
                        </span>
                      )}
                      {task.repo && (
                        <span className="block font-mono text-xs [overflow-wrap:anywhere] whitespace-normal">
                          {task.repo}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3.5">
                      <StepChipsView steps={task.steps} />
                    </td>
                    <td className="px-5 py-3.5">
                      <StatusLabelView text={task.status.text} tone={task.status.tone} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </TasksSection>
    </>
  );
}

/** すべてのタスクの枠（読み込み中の仮表示と同じ）。 */
export function TasksSection({ children }: { children: React.ReactNode }) {
  const m = useMessages().tasks;
  return (
    <section aria-labelledby="all-tasks" className="rounded-xl border border-border bg-card">
      <h2 id="all-tasks" className="px-5 pt-4 pb-3 text-[15px] font-semibold">
        {m.allTasks}
      </h2>
      {children}
    </section>
  );
}
