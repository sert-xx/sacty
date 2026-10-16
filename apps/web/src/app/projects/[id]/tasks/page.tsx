import { notFound } from "next/navigation";
import { Suspense } from "react";
import { NewTask, NewTaskPlaceholder } from "@/components/new-task";
import { FollowProject } from "@/components/shell/follow-project";
import { LiveTaskList, TasksSection } from "@/components/task-list";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getStatus, listProjects } from "@/lib/daemon";
import { liveVersion } from "@/lib/live-server";
import { loadTaskList } from "@/lib/task-list-data";

/**
 * プロジェクトのタスクの一覧（PBI-114 で `/` から移した）。表示するプロジェクトは URL の ID で決め、表示している
 * プロジェクト（cookie。ヘッダーが出す）をそれに合わせる。プロジェクトが無ければ 404。
 */
export default async function TasksPage({ params }: { params: Promise<{ id: string }> }) {
  const { tasks: m, forms } = await getMessages();
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <Suspense fallback={<p className="text-sm text-muted-foreground">&nbsp;</p>}>
            <ProjectName params={params} />
          </Suspense>
          <h1 className="text-2xl font-bold">{m.title}</h1>
        </div>
        {/* 表示しているプロジェクトを読むまでは、同じ大きさの押せないボタンを出す（ボタンを最初の表示から出し、
            位置をずらさない。PBI-109） */}
        <Suspense fallback={<NewTaskPlaceholder label={forms.task.create} />}>
          <NewTaskFor params={params} />
        </Suspense>
      </div>
      <Suspense fallback={null}>
        <AgentStatus />
      </Suspense>
      {/* 人間の判断が必要なタスクと、すべてのタスク。画面をリロードせず、データだけを取り直す（PBI-108） */}
      <Suspense
        fallback={
          <TasksSection>
            <p className="px-5 pb-5 text-sm text-muted-foreground">{m.loading}</p>
          </TasksSection>
        }
      >
        <Tasks params={params} />
      </Suspense>
    </>
  );
}

async function ProjectName({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  try {
    const project = (await listProjects()).find((p) => p.id === id);
    if (!project) return null;
    const m = (await getMessages()).tasks;
    return <p className="text-sm text-muted-foreground">{m.project(project.name)}</p>;
  } catch {
    return null;
  }
}

async function NewTaskFor({ params }: { params: Promise<{ id: string }> }) {
  return <NewTask projectId={(await params).id} />;
}

/** 工程を実行するAIの設定状況。問題があれば理由を出す。 */
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

/** URL のプロジェクトのタスク（描いたときのデータ。画面が取り直す。PBI-108）。 */
async function Tasks({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let data: Awaited<ReturnType<typeof loadTaskList>>;
  try {
    data = await loadTaskList(id);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return <LiveTaskList projectId={id} initial={null} error={error.message} />;
    }
    throw error;
  }
  // 存在しないプロジェクトの ID（消したプロジェクト・打ち間違い）
  if (!data) notFound();
  return (
    <>
      {/* 開いたプロジェクトを、表示しているプロジェクトにする（ヘッダーの選択と URL をずらさない。PBI-98・PBI-114） */}
      <FollowProject projectId={id} />
      <LiveTaskList projectId={id} initial={data} initialVersion={liveVersion(data)} />
    </>
  );
}
