import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DaemonError } from "@/components/daemon-error";
import { ProjectEditor } from "@/components/project-editor";
import { FollowProject } from "@/components/shell/follow-project";
import { Hint } from "@/components/ui/hint";
import { getMessages } from "@/i18n/server";
import {
  CONTEXT_CHECK_PARAM,
  DaemonUnavailableError,
  getGitHubAccounts,
  getProject,
  getProjectContextError,
  getProjectPlatforms,
  getStatus,
} from "@/lib/daemon";

/** プロジェクトの設定（PBI-114 で `/projects/<ID>` から移した）。プロジェクトが無ければ 404。 */
export default async function ProjectSettingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = (await getMessages()).projects;
  return (
    <>
      <nav aria-label={t.breadcrumb} className="text-sm text-muted-foreground">
        <Link href="/projects" className="text-accent-foreground underline">
          {t.title}
        </Link>
      </nav>
      <Suspense fallback={<p className="text-sm text-muted-foreground">{t.loading}</p>}>
        <ProjectSettings params={params} searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function ProjectSettings({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const messages = await getMessages();
  const t = messages.projects;
  let view: Awaited<ReturnType<typeof getProject>>;
  try {
    view = await getProject(id);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  if (!view) notFound();
  // 作成・インポートの後は、コンテキストの誤りをここで確かめて知らせる（保存の結果は画面を移ると届かないため。PBI-76）
  const contextError = (await searchParams)[CONTEXT_CHECK_PARAM]
    ? await getProjectContextError(view.project.id).catch(() => undefined)
    : undefined;
  return (
    <>
      {/* 開いたプロジェクトを、表示しているプロジェクトにする（一覧から開いたときなど。ヘッダーとずれないように。PBI-98） */}
      <FollowProject projectId={view.project.id} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t.settingsTitle(view.project.name)}</h1>
        {/* ダウンロードなので、クライアントの画面遷移にしない */}
        <span className="flex items-center gap-1.5">
          <a
            href={`/projects/${encodeURIComponent(view.project.id)}/export`}
            download
            className="inline-flex min-h-9 items-center rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-muted"
          >
            {t.export}
          </a>
          <Hint text={t.exportHint} />
        </span>
      </div>
      {contextError !== undefined && (
        <p role="alert" className="text-sm leading-6 whitespace-pre-line text-warn">
          {t.editor.createdContextError(messages.labels.text(contextError))}
        </p>
      )}
      {/* 除外リポジトリはサーバーで決まるので props で受け取る（保存後の refresh で反映される） */}
      <ProjectEditor
        project={view.project}
        exclusions={view.exclusions}
        github={await getGitHubAccounts()}
        // 選べるイメージ（PBI-41）。状態を取れなければ、選ぶ欄を出さない（指定済みのイメージは出す）
        images={(await getStatus().catch(() => undefined))?.images ?? []}
        platforms={(await getStatus().catch(() => undefined))?.platforms ?? []}
        // プロジェクトで使える外部 PF（コンテキストの platforms.yaml も。PBI-74）。取れなければ一覧を出さない
        projectPlatforms={await getProjectPlatforms(view.project.id).catch(() => undefined)}
      />
    </>
  );
}
