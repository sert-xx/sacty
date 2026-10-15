import { isRepoless } from "@sacty/core";
import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { DaemonError } from "@/components/daemon-error";
import { NewTask, NewTaskPlaceholder } from "@/components/new-task";
import { StatusLabel, StepChips } from "@/components/task-bits";
import { getMessages } from "@/i18n/server";
import { currentProjectId, resolveProject } from "@/lib/current-project";
import { DaemonUnavailableError, getStatus, listProjects, listTasks } from "@/lib/daemon";
import { isWorking, needsPerson, personAction, statusText } from "@/lib/labels";
import { withSubtasks } from "@/lib/subtasks";

export default async function TasksPage() {
  const { tasks: m, forms } = await getMessages();
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Suspense fallback={<p className="text-sm text-muted-foreground">&nbsp;</p>}>
            <ProjectName />
          </Suspense>
          <h1 className="text-2xl font-bold">{m.title}</h1>
        </div>
        {/* 表示しているプロジェクトを読むまでは、同じ大きさの押せないボタンを出す（ボタンを最初の表示から出し、
            位置をずらさない。PBI-109） */}
        <Suspense fallback={<NewTaskPlaceholder label={forms.task.create} />}>
          <NewTask />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <AgentStatus />
      </Suspense>
      <Suspense fallback={null}>
        <NeedsYou />
      </Suspense>
      <section aria-labelledby="all-tasks" className="rounded-xl border border-border bg-card">
        <h2 id="all-tasks" className="px-5 pt-4 pb-3 text-[15px] font-semibold">
          {m.allTasks}
        </h2>
        <Suspense fallback={<p className="px-5 pb-5 text-sm text-muted-foreground">{m.loading}</p>}>
          <TaskTable />
        </Suspense>
      </section>
    </>
  );
}

/** 工程を実行するAIの設定状況。問題があれば理由を出す。 */
/** 表示しているプロジェクト（cookie）のタスク。 */
async function projectTasks() {
  const [tasks, projects, id] = await Promise.all([
    listTasks(),
    listProjects(),
    currentProjectId(),
  ]);
  const project = resolveProject(projects, id);
  return tasks.filter((t) => t.projectId === project?.id);
}

async function ProjectName() {
  try {
    const project = resolveProject(await listProjects(), await currentProjectId());
    const m = (await getMessages()).tasks;
    return <p className="text-sm text-muted-foreground">{m.project(project?.name)}</p>;
  } catch {
    return null;
  }
}

async function AgentStatus() {
  let status: Awaited<ReturnType<typeof getStatus>>;
  try {
    status = await getStatus();
  } catch {
    return null; // デーモンに届かない場合は一覧側で表示する
  }
  const { tasks: m, labels } = await getMessages();
  if (status.problems.length > 0) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-warn-line bg-warn-soft p-4 text-sm text-warn"
      >
        {m.cannotRun}
        {status.problems.map(labels.text).join(" ")}
      </div>
    );
  }
  if (!status.agent) return null;
  return (
    <>
      <p className="text-sm text-muted-foreground">
        {m.agent}
        <span className="font-mono">{status.agent.id}</span>
        {m.agentAuth(
          labels.auth[status.agent.authMode as keyof typeof labels.auth] ?? status.agent.authMode,
        )}
      </p>
      {/* 動くが、知らせたいこと（認証情報を用意できない組織内 PF など。PBI-35） */}
      {(status.warnings ?? []).length > 0 && (
        <ul
          role="status"
          className="flex flex-col gap-1 rounded-xl border border-warn-line bg-warn-soft p-4 text-sm text-warn"
        >
          {(status.warnings ?? []).map((w) => (
            <li key={labels.text(w)}>{labels.text(w)}</li>
          ))}
        </ul>
      )}
    </>
  );
}

/** 人間の判断が必要なタスク（承認待ち・エスカレーション・一時停止）。 */
async function NeedsYou() {
  let tasks: Awaited<ReturnType<typeof listTasks>>;
  try {
    tasks = (await projectTasks()).filter(needsPerson);
  } catch {
    return null;
  }
  if (tasks.length === 0) return null;
  const { tasks: m, labels } = await getMessages();
  return (
    <section aria-labelledby="needs-you" className="flex flex-col gap-3">
      <h2 id="needs-you" className="text-[15px] font-semibold">
        {m.needsYou}
      </h2>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
        {tasks.map((task) => {
          const action = personAction(task, labels);
          return (
            <li
              key={task.id}
              className="flex flex-col gap-2.5 rounded-xl border border-warn-line bg-card p-5"
            >
              <span className="w-fit rounded-full border border-warn-line bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn">
                {statusText(task, labels)}
              </span>
              <span className="text-[17px] font-semibold">{task.title}</span>
              <Link href={action.href} className="text-sm font-semibold text-accent-foreground">
                {action.label} →
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

async function TaskTable() {
  let tasks: Awaited<ReturnType<typeof listTasks>>;
  try {
    tasks = await projectTasks();
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return (
        <div className="px-5 pb-5">
          <DaemonError message={error.message} />
        </div>
      );
    }
    throw error;
  }
  const { tasks: m, labels } = await getMessages();

  if (tasks.length === 0) {
    return <p className="px-5 pb-8 text-sm text-muted-foreground">{m.empty}</p>;
  }

  return (
    <div className="overflow-x-auto">
      <AutoRefresh active={tasks.some(isWorking)} />
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
              {m.column.steps}
            </th>
            <th scope="col" className="px-5 py-2.5 font-medium">
              {m.column.status}
            </th>
          </tr>
        </thead>
        <tbody>
          {/* 分割で作った子タスクは、親のすぐ下に字下げして出す（PBI-27） */}
          {withSubtasks(tasks).map(({ task, child }) => (
            <tr key={task.id} className="border-t border-border hover:bg-muted">
              <td className={child ? "py-3.5 pr-5 pl-10" : "px-5 py-3.5"}>
                {child && (
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
                {isRepoless(task) && (
                  <span className="mt-0.5 block w-fit rounded border border-border px-1.5 text-xs">
                    {m.noRepository}
                  </span>
                )}
                {child && task.repo && (
                  <span className="block font-mono text-xs [overflow-wrap:anywhere] whitespace-normal">
                    {task.repo}
                  </span>
                )}
              </td>
              <td className="px-3 py-3.5">
                <StepChips task={task} />
              </td>
              <td className="px-5 py-3.5">
                <StatusLabel task={task} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
