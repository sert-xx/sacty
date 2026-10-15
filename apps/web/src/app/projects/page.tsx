import { Suspense } from "react";
import { ImportProjectForm } from "@/components/import-project-form";
import { ProjectEditor } from "@/components/project-editor";
import { LiveProjectList } from "@/components/project-list";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getStatus } from "@/lib/daemon";
import { liveVersion } from "@/lib/live-server";
import { loadProjectList, type ProjectListData } from "@/lib/project-list-data";

export default async function ProjectsPage() {
  const t = (await getMessages()).projects;
  return (
    <>
      <h1 className="text-2xl font-bold">{t.title}</h1>
      <Suspense fallback={<p className="text-sm text-muted-foreground">{t.loading}</p>}>
        <Projects />
      </Suspense>
      <section aria-labelledby="import-project" className="flex flex-col gap-3">
        <h2 id="import-project" className="text-[15px] font-semibold">
          {t.importTitle}
        </h2>
        <ImportProjectForm />
      </section>
      <section aria-labelledby="new-project" className="flex flex-col gap-3">
        <h2 id="new-project" className="text-[15px] font-semibold">
          {t.newTitle}
        </h2>
        <ProjectEditor
          images={(await getStatus().catch(() => undefined))?.images ?? []}
          platforms={(await getStatus().catch(() => undefined))?.platforms ?? []}
        />
      </section>
    </>
  );
}

async function Projects() {
  let data: ProjectListData;
  try {
    data = await loadProjectList();
  } catch (error) {
    // 届くようになったら、取り直したデータを出す（PBI-108）
    if (error instanceof DaemonUnavailableError) {
      return <LiveProjectList initial={null} error={error.message} />;
    }
    throw error;
  }
  // 取り込みの状況とプロジェクトの一覧は、画面をリロードせずに取り直す（PBI-108）
  return <LiveProjectList initial={data} initialVersion={liveVersion(data)} />;
}
