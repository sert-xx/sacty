import { ImportProjectForm } from "@/components/import-project-form";
import { ProjectEditor } from "@/components/project-editor";
import { AppRail } from "@/components/shell/rail";
import { getMessages } from "@/i18n/server";
import { getStatus, listProjects } from "@/lib/daemon";

/** プロジェクトが1つ以上あるか。デーモンにつながらなければ undefined（各画面がつながらないことを出す）。 */
export async function hasProjects(): Promise<boolean | undefined> {
  try {
    return (await listProjects()).length > 0;
  } catch {
    return undefined;
  }
}

/**
 * プロジェクトが1つも無いときは、どの画面を開いても、最初のプロジェクトを作る画面だけを出す
 * （既定のプロジェクトは無い。PBI-22）。作るかインポートすると、そのプロジェクトの画面に進む。
 */
export async function ProjectGate({ children }: { children: React.ReactNode }) {
  if ((await hasProjects()) !== false) return children;
  const t = (await getMessages()).projects;
  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-bold">{t.first.title}</h1>
        <p className="text-sm leading-6 text-muted-foreground">{t.first.note}</p>
      </div>
      <section aria-labelledby="new-project" className="flex flex-col gap-3">
        <h2 id="new-project" className="text-[15px] font-semibold">
          {t.newTitle}
        </h2>
        <ProjectEditor images={(await getStatus().catch(() => undefined))?.images ?? []} />
      </section>
      <section aria-labelledby="import-project" className="flex flex-col gap-3">
        <h2 id="import-project" className="text-[15px] font-semibold">
          {t.importTitle}
        </h2>
        <ImportProjectForm />
      </section>
    </>
  );
}

/** サイドメニュー。プロジェクトが1つも無いときは出さない（作成画面のほかへ移らせない）。 */
export async function RailGate() {
  if ((await hasProjects()) === false) return null;
  return <AppRail />;
}
