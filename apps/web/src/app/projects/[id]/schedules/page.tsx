import type { ScheduleView } from "@sacty/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DaemonError } from "@/components/daemon-error";
import { ScheduleDialog } from "@/components/schedule-dialog";
import { FollowProject } from "@/components/shell/follow-project";
import { Hint } from "@/components/ui/hint";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, listProjects, listSchedules } from "@/lib/daemon";
import { formatStamp } from "@/lib/labels";
import { schedulePath } from "@/lib/paths";
import { ruleText } from "@/lib/schedule-form";

/**
 * プロジェクトのスケジュールタスクの一覧。表示するプロジェクトは URL の ID で決め、表示しているプロジェクト（cookie）を
 * それに合わせる。プロジェクトが無ければ 404。
 */
export default async function SchedulesPage({ params }: { params: Promise<{ id: string }> }) {
  const m = (await getMessages()).schedules;
  return (
    <Suspense
      fallback={
        <h1 className="flex items-center gap-1 text-2xl font-bold">
          {m.title} <Hint text={m.titleHint} />
        </h1>
      }
    >
      <Schedules params={params} />
    </Suspense>
  );
}

async function Schedules({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { schedules: m, locale } = await getMessages();
  const heading = (
    <h1 className="flex items-center gap-1 text-2xl font-bold">
      {m.title} <Hint text={m.titleHint} />
    </h1>
  );
  let project: Awaited<ReturnType<typeof listProjects>>[number] | undefined;
  let schedules: ScheduleView[] | null;
  try {
    const [projects, found] = await Promise.all([listProjects(), listSchedules(id)]);
    project = projects.find((p) => p.id === id);
    schedules = found;
  } catch (error) {
    if (error instanceof DaemonUnavailableError) {
      return (
        <>
          {heading}
          <DaemonError message={error.message} />
        </>
      );
    }
    throw error;
  }
  if (!project || !schedules) notFound();
  return (
    <>
      <FollowProject projectId={id} />
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <p className="text-sm text-muted-foreground">{m.project(project.name)}</p>
          {heading}
        </div>
        <ScheduleDialog
          key={project.id}
          projectId={project.id}
          projectName={project.name}
          hasTargets={project.targets.length > 0}
        />
      </div>
      <section className="rounded-xl border border-border bg-card">
        {schedules.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">{m.empty}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th scope="col" className="px-5 py-2.5 font-medium">
                    {m.column.name}
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    {m.column.rule}
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    {m.column.next}
                  </th>
                  <th scope="col" className="px-3 py-2.5 font-medium">
                    {m.column.last}
                  </th>
                  <th scope="col" className="px-5 py-2.5 font-medium">
                    {m.column.state}
                  </th>
                </tr>
              </thead>
              <tbody>
                {schedules.map((s) => (
                  <tr
                    key={s.id}
                    className="border-t border-border hover:bg-muted"
                    data-testid={`schedule-row-${s.id}`}
                  >
                    <td className="px-5 py-3.5">
                      <Link
                        href={schedulePath(project.id, s.id)}
                        className="font-medium text-foreground hover:underline"
                      >
                        {s.name}
                      </Link>
                    </td>
                    <td className="px-3 py-3.5 text-muted-foreground">{ruleText(s.rule, m)}</td>
                    <td className="px-3 py-3.5 whitespace-nowrap text-muted-foreground">
                      {s.nextRunAt ? formatStamp(s.nextRunAt, locale) : m.none}
                    </td>
                    <td className="px-3 py-3.5 whitespace-nowrap text-muted-foreground">
                      {s.lastRun ? formatStamp(s.lastRun.slot, locale) : m.none}
                      {s.lastRun?.error && (
                        <span className="block text-xs text-warn">{m.lastFailed}</span>
                      )}
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap">
                      {s.enabled ? m.enabled : m.disabled}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
