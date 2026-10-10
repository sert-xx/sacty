import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { DaemonError } from "@/components/daemon-error";
import { NewTicketDialog } from "@/components/new-ticket-dialog";
import { StatusLabel, StepChips } from "@/components/task-bits";
import { DaemonUnavailableError, getStatus, listTasks } from "@/lib/daemon";
import { AUTH_LABEL, needsPerson, START_LABEL, statusText } from "@/lib/labels";

export default function TasksPage() {
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">プロジェクト：デフォルト</p>
          <h1 className="text-2xl font-bold">タスク</h1>
        </div>
        <NewTicketDialog />
      </div>
      <Suspense fallback={null}>
        <AgentStatus />
      </Suspense>
      <Suspense fallback={null}>
        <NeedsYou />
      </Suspense>
      <section aria-labelledby="all-tasks" className="rounded-xl border border-border bg-card">
        <h2 id="all-tasks" className="px-5 pt-4 pb-3 text-[15px] font-semibold">
          すべてのタスク
        </h2>
        <Suspense fallback={<p className="px-5 pb-5 text-sm text-muted-foreground">読み込み中…</p>}>
          <TaskTable />
        </Suspense>
      </section>
    </>
  );
}

/** 工程を実行するAIの設定状況。問題があれば理由を出す。 */
async function AgentStatus() {
  let status: Awaited<ReturnType<typeof getStatus>>;
  try {
    status = await getStatus();
  } catch {
    return null; // デーモンに届かない場合は一覧側で表示する
  }
  if (status.problems.length > 0) {
    return (
      <div
        role="alert"
        className="rounded-xl border border-warn-line bg-warn-soft p-4 text-sm text-warn"
      >
        工程を実行できません。{status.problems.join(" ")}
      </div>
    );
  }
  if (!status.agent) return null;
  return (
    <p className="text-sm text-muted-foreground">
      工程を実行するAI：<span className="font-mono">{status.agent.id}</span>（
      {AUTH_LABEL[status.agent.authMode as keyof typeof AUTH_LABEL] ?? status.agent.authMode}）
    </p>
  );
}

/** 人間の判断が必要なタスク（承認待ち・エスカレーション・一時停止）。 */
async function NeedsYou() {
  let tasks: Awaited<ReturnType<typeof listTasks>>;
  try {
    tasks = (await listTasks()).filter(needsPerson);
  } catch {
    return null;
  }
  if (tasks.length === 0) return null;
  return (
    <section aria-labelledby="needs-you" className="flex flex-col gap-3">
      <h2 id="needs-you" className="text-[15px] font-semibold">
        あなたの出番
      </h2>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(280px,1fr))] gap-4">
        {tasks.map((task) => {
          const toReview = task.status === "awaiting_approval" || task.status === "escalated";
          return (
            <li
              key={task.id}
              className="flex flex-col gap-2.5 rounded-xl border border-warn-line bg-card p-5"
            >
              <span className="w-fit rounded-full border border-warn-line bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn">
                {statusText(task)}
              </span>
              <span className="text-[17px] font-semibold">{task.title}</span>
              <Link
                href={toReview ? `/tasks/${task.id}/review` : `/tasks/${task.id}`}
                className="text-sm font-semibold text-accent-foreground"
              >
                {toReview ? "チェックする →" : "判断する →"}
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
    tasks = await listTasks();
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

  if (tasks.length === 0) {
    return (
      <p className="px-5 pb-8 text-sm text-muted-foreground">
        タスクはまだありません。「チケットを作成」から最初のタスクを作ってください。
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <AutoRefresh active={tasks.some((t) => t.status === "queued" || t.status === "running")} />
      <table className="w-full min-w-[760px] border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground">
            <th scope="col" className="px-5 py-2.5 font-medium">
              タスク
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              開始地点
            </th>
            <th scope="col" className="px-3 py-2.5 font-medium">
              工程（オーケストレーターが選択）
            </th>
            <th scope="col" className="px-5 py-2.5 font-medium">
              状態
            </th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => (
            <tr key={task.id} className="border-t border-border hover:bg-muted">
              <td className="px-5 py-3.5">
                <Link
                  href={`/tasks/${task.id}`}
                  className="font-medium text-foreground hover:underline"
                >
                  {task.title}
                </Link>
              </td>
              <td className="px-3 py-3.5 whitespace-nowrap text-muted-foreground">
                {START_LABEL[task.start]}
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
