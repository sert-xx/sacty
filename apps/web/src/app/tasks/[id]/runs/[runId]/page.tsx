import { notFound } from "next/navigation";
import { Suspense } from "react";
import { LiveRunLog } from "@/components/run-log";
import { FollowProject } from "@/components/shell/follow-project";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError } from "@/lib/daemon";
import { loadRunLog } from "@/lib/run-log-data";

type Params = { params: Promise<{ id: string; runId: string }> };

/** エージェントの実行のセッションログ（PBI-62）。作業履歴の実行の行の「ログを見る」から開く。 */
export default async function RunLogPage({ params }: Params) {
  const m = (await getMessages()).runLog;
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">{m.loading}</p>}>
      <RunLog params={params} />
    </Suspense>
  );
}

async function RunLog({ params }: Params) {
  const { id, runId } = await params;
  let data: Awaited<ReturnType<typeof loadRunLog>>;
  try {
    data = await loadRunLog(id, runId);
  } catch (error) {
    // 届くようになったら、取り直したログを出す（PBI-108）
    if (error instanceof DaemonUnavailableError) {
      return (
        <LiveRunLog key={runId} taskId={id} runId={runId} initial={null} error={error.message} />
      );
    }
    throw error;
  }
  if (!data) notFound();
  return (
    <>
      {/* 開いたタスクのプロジェクトを、表示しているプロジェクトにする（ヘッダーとずれないように。PBI-98） */}
      <FollowProject projectId={data.projectId} />
      {/* 実行中は、画面をリロードせず、足された行だけを取って後ろに足す（PBI-108） */}
      <LiveRunLog key={runId} taskId={id} runId={runId} initial={data} />
    </>
  );
}
