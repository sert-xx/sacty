import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LiveReview } from "@/components/review";
import { FollowProject } from "@/components/shell/follow-project";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getTask } from "@/lib/daemon";
import { liveVersion } from "@/lib/live-server";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const m = await getMessages();
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">{m.review.loading}</p>}>
      <Review params={params} />
    </Suspense>
  );
}

async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let found: Awaited<ReturnType<typeof getTask>>;
  try {
    found = await getTask(id);
  } catch (error) {
    // 届くようになったら、取り直したタスクでレビューを出す（PBI-108）
    if (error instanceof DaemonUnavailableError) {
      return <LiveReview key={id} id={id} initial={null} error={error.message} />;
    }
    throw error;
  }
  if (!found) notFound();
  const { task } = found;
  return (
    <>
      {/* 開いたタスクのプロジェクトを、表示しているプロジェクトにする（ヘッダーとずれないように。PBI-98） */}
      <FollowProject projectId={task.projectId} />
      {/* 画面をリロードせず、タスクだけを取り直す（PBI-108） */}
      <LiveReview key={id} id={id} initial={task} initialVersion={liveVersion(task)} />
    </>
  );
}
