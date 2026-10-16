"use client";

import Link from "next/link";
import { runIntakeAction } from "@/app/actions";
import { DaemonError } from "@/components/daemon-error";
import { StaleNotice } from "@/components/live-status";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";
import { intakeRuns } from "@/lib/intake";
import { formatStamp } from "@/lib/labels";
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
  // 取り込みの種類ごとの直近の取り込み（PBI-100）
  const { runs, errors } = intake ? intakeRuns(intake) : { runs: [], errors: [] };
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
          ) : !intake.settingsUnreadable &&
            !intake.label &&
            !intake.reviewLabel &&
            !intake.reviewRequested &&
            !intake.ticketLabel ? (
            // 取り込むラベルは sacty 全体の設定（PBI-26）
            <p className="text-warn">
              {t.intake.noLabel}{" "}
              <Link href="/settings" className="underline">
                {t.intake.settings}
              </Link>
            </p>
          ) : (
            <>
              {/* sacty の設定を読めなかった（PBI-100）。理由は、定期の確認の前でも状況の API が返す */}
              {intake.settingsUnreadable && (
                <p className="text-warn break-words">
                  {t.intake.settingsUnreadable}
                  {intake.settingsError && m.labels.text(intake.settingsError)}
                </p>
              )}
              <p className="text-muted-foreground">
                {[
                  intake.label ? t.intake.label(intake.label) : "",
                  // Off にしたレビュー用のラベルは出さない（PBI-53）
                  intake.reviewRequested ||
                  (intake.reviewLabel && !intake.triageOff?.includes("reviewLabel"))
                    ? t.intake.review(
                        intake.reviewRequested === true,
                        intake.triageOff?.includes("reviewLabel") ? "" : (intake.reviewLabel ?? ""),
                      )
                    : "",
                  // チケット（PBI-52）。Off なら出さない
                  intake.ticketLabel && !intake.triageOff?.includes("tickets")
                    ? t.intake.ticket(intake.ticketLabel)
                    : "",
                ]
                  .filter(Boolean)
                  .join(" / ")}
                {(intake.triageOff ?? []).length > 0 &&
                  t.intake.off((intake.triageOff ?? []).map((kind) => t.intake.kinds[kind]))}{" "}
                <Link href="/settings" className="underline">
                  {t.intake.settings}
                </Link>
              </p>
              {runs.length > 0 ? (
                <ul className="text-muted-foreground">
                  {runs.map((run) => (
                    <li key={run.kind}>
                      {t.intake.lastRun(
                        t.intake.runKinds[run.kind],
                        formatStamp(run.lastRunAt, m.locale),
                        run.imported,
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-muted-foreground">{t.intake.never}</p>
              )}
              {errors.length > 0 && (
                <div role="alert" className="flex flex-col gap-1 text-warn">
                  <p>{t.intake.errors}</p>
                  <ul className="list-disc pl-5">
                    {errors.map((e) => (
                      <li
                        key={`${e.kind}:${e.query ?? ""}:${JSON.stringify(e.message)}`}
                        className="break-words"
                      >
                        {t.intake.errorKind(t.intake.runKinds[e.kind])}
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
