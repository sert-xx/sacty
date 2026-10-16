"use client";

import Link from "next/link";
import { DaemonError } from "@/components/daemon-error";
import { IntakeRunNow, IntakeStatusView } from "@/components/intake-status";
import { StaleNotice } from "@/components/live-status";
import { useMessages } from "@/i18n/client";
import { projectSettingsPath } from "@/lib/paths";
import type { ProjectListData } from "@/lib/project-list-data";
import { useLiveData } from "@/lib/use-live-data";

/**
 * 取り込みの状況（直近の取り込み・取り込めなかった対象）とプロジェクトの一覧（PBI-108）。画面をリロードせず、一定の間隔で
 * データだけを取り直す（作成・インポートのフォームの書きかけは消えない）。initial が null（描いたときにデーモンに届か
 * なかった）なら、届くまで error を出す。
 */
export function LiveProjectList({
  initial,
  initialVersion,
  error,
}: {
  initial: ProjectListData | null;
  initialVersion?: string;
  error?: string;
}) {
  const { data, stale } = useLiveData(() => "/live/projects", initial, initialVersion);
  if (!data) return <DaemonError message={error ?? ""} />;
  return (
    <>
      <StaleNotice stale={stale} />
      <ProjectList data={data} />
    </>
  );
}

function ProjectList({ data }: { data: ProjectListData }) {
  const m = useMessages();
  const t = m.projects;
  const { projects, status } = data;
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
          <IntakeStatusView intake={intake} />
        </div>
        <IntakeRunNow intake={intake} />
      </section>
      <ul className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-4">
        {projects.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5"
          >
            <Link
              href={projectSettingsPath(p.id)}
              className="text-[17px] font-semibold hover:underline"
            >
              {p.name}
            </Link>
            <p className="text-sm text-muted-foreground">{t.summary(p.targets.length)}</p>
            {(p.targets.length > 0 || (p.tickets ?? []).length > 0) && (
              <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground">
                {p.targets.map((target) => (
                  <li key={`${target.scope}:${target.target}`} className="break-all">
                    {t.targetScope(t.scope[target.scope])}
                    <span className="font-mono">{target.target}</span>
                  </li>
                ))}
                {/* チケットの取り込み先（PBI-52） */}
                {(p.tickets ?? []).map((source) => (
                  <li key={`ticket:${source.platform}:${source.service}`} className="break-all">
                    {t.ticketSource(source.platform, source.keys)}
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
