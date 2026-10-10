import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DaemonError } from "@/components/daemon-error";
import { ProjectEditor } from "@/components/project-editor";
import { DaemonUnavailableError, getProject } from "@/lib/daemon";

export default function ProjectPage({ params }: { params: Promise<{ id: string }> }) {
  return (
    <>
      <nav aria-label="パンくず" className="text-sm text-muted-foreground">
        <Link href="/projects" className="text-accent-foreground underline">
          プロジェクト
        </Link>
      </nav>
      <Suspense fallback={<p className="text-sm text-muted-foreground">読み込み中…</p>}>
        <ProjectSettings params={params} />
      </Suspense>
    </>
  );
}

async function ProjectSettings({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let view: Awaited<ReturnType<typeof getProject>>;
  try {
    view = await getProject(id);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  if (!view) notFound();
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{view.project.name} の設定</h1>
        {/* ダウンロードなので、クライアントの画面遷移にしない */}
        <a
          href={`/projects/${view.project.id}/export`}
          download
          className="inline-flex min-h-9 items-center rounded-md border border-input bg-card px-3 text-sm font-medium hover:bg-muted"
        >
          エクスポート
        </a>
      </div>
      <p className="text-sm text-muted-foreground">
        エクスポートには、名前・取り込み元・リポジトリの設定だけを含めます（個人の設定やトークンは含めません）。
      </p>
      {/* 除外リポジトリはサーバーで決まるので props で受け取る（保存後の refresh で反映される） */}
      <ProjectEditor project={view.project} exclusions={view.exclusions} />
    </>
  );
}
