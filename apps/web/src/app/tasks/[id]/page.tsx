import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FollowProject } from "@/components/shell/follow-project";
import { LiveTaskDetail } from "@/components/task-detail";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError } from "@/lib/daemon";
import { liveVersion } from "@/lib/live-server";
import { CURRENT_PROJECT_TASKS_PATH, projectTasksPath } from "@/lib/paths";
import { loadTaskDetail } from "@/lib/task-detail-data";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const m = (await getMessages()).task;
  return (
    <Suspense
      fallback={
        <>
          <Breadcrumb />
          <p className="text-sm text-muted-foreground">{m.loading}</p>
        </>
      }
    >
      <TaskDetail params={params} />
    </Suspense>
  );
}

/**
 * タスクの一覧へ戻るリンク。タスクのプロジェクトのタスクの一覧へ戻る（PBI-114）。タスクを読む前・読めないときは、表示して
 * いるプロジェクトのタスクの一覧へ。
 */
async function Breadcrumb({ projectId }: { projectId?: string }) {
  const m = (await getMessages()).task;
  return (
    <nav aria-label={m.breadcrumb} className="text-sm text-muted-foreground">
      <Link
        href={projectId ? projectTasksPath(projectId) : CURRENT_PROJECT_TASKS_PATH}
        className="text-accent-foreground underline"
      >
        {m.tasks}
      </Link>
    </nav>
  );
}

async function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let data: Awaited<ReturnType<typeof loadTaskDetail>>;
  try {
    data = await loadTaskDetail(id, { repositories: true });
  } catch (error) {
    // 届くようになったら、取り直したデータで詳細を出す（PBI-108）
    if (error instanceof DaemonUnavailableError) {
      return (
        <>
          <Breadcrumb />
          <LiveTaskDetail key={id} id={id} initial={null} error={error.message} />
        </>
      );
    }
    throw error;
  }
  if (!data) notFound();
  return (
    <>
      <Breadcrumb projectId={data.task.projectId} />
      {/* 開いたタスクのプロジェクトを、表示しているプロジェクトにする（ヘッダーとずれないように。PBI-98） */}
      <FollowProject projectId={data.task.projectId} />
      {/* 画面をリロードせず、データだけを取り直す（PBI-108） */}
      <LiveTaskDetail key={id} id={id} initial={data} initialVersion={liveVersion(data)} />
    </>
  );
}
