import type { Project } from "@sacty/core";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { cache, Suspense } from "react";
import { AuditScreen } from "@/components/audit-screen";
import { DaemonError } from "@/components/daemon-error";
import { FollowProject } from "@/components/shell/follow-project";
import { getMessages } from "@/i18n/server";
import { parseCauseFilter, parseShown, sliceAudits } from "@/lib/audit-view";
import { DaemonUnavailableError, getProjectAudits, listProjects } from "@/lib/daemon";
import { notFoundMetadata } from "@/lib/not-found-metadata";

/**
 * プロジェクトの監査の画面（PBI-124）。表示するプロジェクトは URL の ID で決め、表示しているプロジェクト（cookie）を
 * それに合わせる。プロジェクトが無ければ 404。採用・却下の後は、サーバーアクションが画面を描き直す。絞り込み（?causes=）と出す件数（?shown=）は URL で受ける。
 */
type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** 描く部品と `generateMetadata` が同じ読み込みを共有する（デーモンへの問い合わせは 1 回）。 */
const loadPage = cache(async (id: string) => {
  const [projects, audits] = await Promise.all([listProjects(), getProjectAudits(id)]);
  return { project: projects.find((p) => p.id === id), audits };
});

/** 無いプロジェクトのときは、無いページのタイトルにする。 */
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  try {
    const { project, audits } = await loadPage(id);
    if (!audits || project === undefined) return await notFoundMetadata();
  } catch {
    // 取れなければ既定のタイトル
  }
  return {};
}

export default async function ProjectAuditPage({ params, searchParams }: Props) {
  const m = (await getMessages()).audit;
  return (
    <Suspense fallback={<h1 className="text-2xl font-bold">{m.title}</h1>}>
      <Audit params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Audit({ params, searchParams }: Props) {
  const { id } = await params;
  const m = (await getMessages()).audit;
  let project: Project | undefined;
  let data: Awaited<ReturnType<typeof getProjectAudits>>;
  try {
    const loaded = await loadPage(id);
    project = loaded.project;
    data = loaded.audits;
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
  if (!data || project === undefined) notFound();
  // 絞り込みと出す件数は URL に残す。区切りはここで行い、出す原因とその提案だけをクライアントに渡す（PBI-443）
  const query = await searchParams;
  const sliced = sliceAudits(data, parseCauseFilter(query.causes), parseShown(query.shown));
  return (
    <>
      <FollowProject projectId={id} />
      <div className="flex flex-col gap-1">
        <p className="text-sm text-muted-foreground">{m.screen.project(project.name)}</p>
        <h1 className="text-2xl font-bold">{m.title}</h1>
      </div>
      <AuditScreen
        data={sliced.data}
        view={sliced.view}
        today={new Date().toISOString().slice(0, 10)}
      />
    </>
  );
}
