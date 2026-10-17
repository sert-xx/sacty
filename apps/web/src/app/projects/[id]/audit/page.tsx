import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AuditScreen } from "@/components/audit-screen";
import { DaemonError } from "@/components/daemon-error";
import { FollowProject } from "@/components/shell/follow-project";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getProjectAudits, listProjects } from "@/lib/daemon";

/**
 * プロジェクトの監査の画面（PBI-124）。表示するプロジェクトは URL の ID で決め、表示しているプロジェクト（cookie）を
 * それに合わせる。プロジェクトが無ければ 404。採用・却下の後は、サーバーアクションが画面を描き直す。
 */
export default async function ProjectAuditPage({ params }: { params: Promise<{ id: string }> }) {
  const m = (await getMessages()).audit;
  return (
    <Suspense fallback={<h1 className="text-2xl font-bold">{m.title}</h1>}>
      <Audit params={params} />
    </Suspense>
  );
}

async function Audit({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = (await getMessages()).audit;
  let projectName: string | undefined;
  let data: Awaited<ReturnType<typeof getProjectAudits>>;
  try {
    const [projects, audits] = await Promise.all([listProjects(), getProjectAudits(id)]);
    projectName = projects.find((p) => p.id === id)?.name;
    data = audits;
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return (
        <>
          <h1 className="text-2xl font-bold">{m.title}</h1>
          <DaemonError message={error.message} />
        </>
      );
    }
    throw error;
  }
  if (!data || projectName === undefined) notFound();
  return (
    <>
      <FollowProject projectId={id} />
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{m.screen.project(projectName)}</p>
        <h1 className="text-2xl font-bold">{m.title}</h1>
      </div>
      <AuditScreen data={data} today={new Date().toISOString().slice(0, 10)} />
    </>
  );
}
