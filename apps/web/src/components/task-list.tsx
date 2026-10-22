"use client";

import Link from "next/link";
import { useId, useState } from "react";
import { ActionLink } from "@/components/action-link";
import { DaemonError } from "@/components/daemon-error";
import { FollowProjectAfterRecovery, StaleNotice } from "@/components/live-status";
import { StatusLabelView, StepChipsView } from "@/components/task-bits";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { useMessages } from "@/i18n/client";
import {
  ACTIVE,
  EMPTY_FILTER,
  filterOptions,
  isFiltering,
  matchesFilter,
  NO_REPO,
  type TaskFilter,
} from "@/lib/task-filter";
import type { TaskListData, TaskRow } from "@/lib/task-list-data";
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
  // 絞り込みは画面の中だけで持つ（取り直しても消さない。別のプロジェクトへ移ると、key が変わって消える）
  const [filter, setFilter] = useState<TaskFilter>(EMPTY_FILTER);
  const rows = data ? data.rows.filter((row) => matchesFilter(row, filter)) : [];
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
                <ActionLink
                  href={task.action.href}
                  external={task.action.external}
                  className="text-sm font-semibold text-accent-foreground"
                >
                  {task.action.label}
                  {!task.action.external && " →"}
                </ActionLink>
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
          <>
            <TaskFilterBar
              rows={data.rows}
              shown={rows.length}
              filter={filter}
              onChange={setFilter}
            />
            {rows.length === 0 ? (
              <p className="px-5 pb-8 text-sm text-muted-foreground">{m.filter.none}</p>
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
                    {rows.map((task) => (
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
                          {/* 作業するリポジトリ（repo だけ。PBI-141） */}
                          {task.repoName && (
                            <span
                              className="mt-0.5 block font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]"
                              data-testid={`task-repo-${task.id}`}
                            >
                              {task.repoName}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-3.5 whitespace-nowrap text-muted-foreground">
                          {labels.start[task.start]}
                          {/* テンプレートで作ったタスク（PBI-90） */}
                          {task.template && (
                            <span className="mt-0.5 block w-fit rounded border border-border px-1.5 text-xs">
                              {labels.template[task.template]}
                            </span>
                          )}
                          {/* 取り込み元の番号（リポジトリは題の下に出す。PBI-141） */}
                          {task.source && (
                            <span className="block font-mono text-xs">#{task.source.number}</span>
                          )}
                          {/* リポジトリを指定せずに作ったタスク（PBI-73） */}
                          {task.repoless && (
                            <span className="mt-0.5 block w-fit rounded border border-border px-1.5 text-xs">
                              {m.noRepository}
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
          </>
        )}
      </TasksSection>
    </>
  );
}

const SELECT =
  "h-8 rounded-lg border border-input bg-card px-2 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/** 一覧の絞り込み（題の検索・開始時期・開始地点・リポジトリ・状態）。選択肢は、一覧にあるものだけを出す。 */
function TaskFilterBar({
  rows,
  shown,
  filter,
  onChange,
}: {
  rows: TaskRow[];
  shown: number;
  filter: TaskFilter;
  onChange: (filter: TaskFilter) => void;
}) {
  const { tasks: m, labels } = useMessages();
  const uid = useId();
  const { starts, repos } = filterOptions(rows, filter);
  const set = <K extends keyof TaskFilter>(key: K, value: TaskFilter[K]) =>
    onChange({ ...filter, [key]: value });
  const field = "flex flex-col gap-1 text-xs text-muted-foreground";
  return (
    <search
      aria-label={m.filter.label}
      className="flex flex-wrap items-end gap-3 px-5 pb-4"
      data-testid="task-filter"
    >
      <label htmlFor={`${uid}-query`} className={`${field} min-w-48 flex-1`}>
        {m.filter.query}
        <Input
          id={`${uid}-query`}
          type="search"
          value={filter.query}
          placeholder={m.filter.queryPlaceholder}
          onChange={(e) => set("query", e.target.value)}
        />
      </label>
      <label htmlFor={`${uid}-from`} className={field}>
        {m.filter.from}
        <Input
          id={`${uid}-from`}
          type="date"
          className="w-auto"
          value={filter.from}
          max={filter.to || undefined}
          onChange={(e) => set("from", e.target.value)}
        />
      </label>
      <label htmlFor={`${uid}-to`} className={field}>
        {m.filter.to}
        <Input
          id={`${uid}-to`}
          type="date"
          className="w-auto"
          value={filter.to}
          min={filter.from || undefined}
          onChange={(e) => set("to", e.target.value)}
        />
      </label>
      <label className={field}>
        {m.filter.start}
        <select
          className={SELECT}
          value={filter.start}
          onChange={(e) => set("start", e.target.value as TaskFilter["start"])}
        >
          <option value="">{m.filter.all}</option>
          {starts.map((start) => (
            <option key={start} value={start}>
              {labels.start[start]}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        {m.filter.repo}
        <select
          className={SELECT}
          value={filter.repo}
          onChange={(e) => set("repo", e.target.value)}
        >
          <option value="">{m.filter.all}</option>
          {repos.map((repo) => (
            <option key={repo} value={repo}>
              {repo === NO_REPO ? m.filter.noRepo : repo}
            </option>
          ))}
        </select>
      </label>
      <label className={field}>
        {m.filter.status}
        <select
          className={SELECT}
          value={filter.status}
          onChange={(e) => set("status", e.target.value as TaskFilter["status"])}
        >
          <option value="">{m.filter.all}</option>
          {([ACTIVE, "person", "working", "waiting", "completed", "cancelled"] as const).map(
            (tone) => (
              <option key={tone} value={tone}>
                {m.filter.tone[tone]}
              </option>
            ),
          )}
        </select>
      </label>
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span role="status" data-testid="task-filter-count">
          {m.filter.count(shown, rows.length)}
        </span>
        {isFiltering(filter) && (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange(EMPTY_FILTER)}>
            {m.filter.clear}
          </Button>
        )}
      </div>
    </search>
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
