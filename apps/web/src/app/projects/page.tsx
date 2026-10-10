import Link from "next/link";
import { Suspense } from "react";
import { runIntakeAction } from "@/app/actions";
import { DaemonError } from "@/components/daemon-error";
import { ImportProjectForm } from "@/components/import-project-form";
import { ProjectEditor } from "@/components/project-editor";
import { Button } from "@/components/ui/button";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getStatus, listProjects } from "@/lib/daemon";
import { formatStamp } from "@/lib/labels";

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
        <ProjectEditor />
      </section>
    </>
  );
}

async function Projects() {
  const m = await getMessages();
  const t = m.projects;
  let data: [Awaited<ReturnType<typeof listProjects>>, Awaited<ReturnType<typeof getStatus>>];
  try {
    data = await Promise.all([listProjects(), getStatus()]);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  const [projects, status] = data;
  const intake = status.intake;
  return (
    <>
      <section
        aria-labelledby="intake"
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card p-5 text-sm"
      >
        <div className="flex flex-col gap-1">
          <h2 id="intake" className="text-[15px] font-semibold">
            {t.intake.title}
          </h2>
          {!intake ? (
            <p className="text-muted-foreground">{t.intake.stopped}</p>
          ) : (
            <>
              <p className="text-muted-foreground">
                {intake.lastRunAt
                  ? t.intake.lastRun(formatStamp(intake.lastRunAt, m.locale), intake.imported ?? 0)
                  : t.intake.never}
              </p>
              {intake.errors && intake.errors.length > 0 && (
                <div role="alert" className="flex flex-col gap-1 text-warn">
                  <p>{t.intake.errors}</p>
                  <ul className="list-disc pl-5">
                    {intake.errors.map((e) => (
                      <li
                        key={`${e.query ?? ""}:${JSON.stringify(e.message)}`}
                        className="break-words"
                      >
                        {e.query && <span className="font-mono text-xs">{e.query}</span>}{" "}
                        {m.labels.text(e.message)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
        </div>
        {intake && (
          <form action={runIntakeAction}>
            <Button type="submit" variant="outline">
              {t.intake.runNow}
            </Button>
          </form>
        )}
      </section>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
        {projects.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5"
          >
            <Link href={`/projects/${p.id}`} className="text-[17px] font-semibold hover:underline">
              {p.name}
            </Link>
            <p className="text-sm text-muted-foreground">
              {t.summary(p.sources.length, p.repositories.length)}
            </p>
            {p.sources.length > 0 && (
              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                {p.sources.map((s) => (
                  <li key={`${s.scope}:${s.target}`} className="break-all">
                    {t.sourceScope(t.scope[s.scope])}
                    <span className="font-mono">{s.target}</span>
                    {t.sourceLabel(s.label)}
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
