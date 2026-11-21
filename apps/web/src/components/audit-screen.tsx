"use client";

import { auditRemarkCount, type ProjectAudits } from "@sacty/core";
import Link from "next/link";
import type { ReactNode } from "react";
import { AuditStatusLabel, MockBadge } from "@/components/audit";
import { AuditCauses } from "@/components/audit-causes";
import { CardSection } from "@/components/card-section";
import { Button } from "@/components/ui/button";
import { WithHint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";
import type { AuditView } from "@/lib/audit-view";
import { formatStamp, usd } from "@/lib/labels";
import { projectAuditReportPath, taskPath } from "@/lib/paths";

/**
 * プロジェクトの監査の画面（PBI-124）。タスクをまたいでまとめた原因（畳んだ行。開くと改修の提案を出す。PBI-443）・
 * 不安定なテスト・監査したタスク・レポートの出力を出す。プロジェクトをまたいで集約しない。
 */
export function AuditScreen({
  data,
  view,
  today,
  flaky,
}: {
  /** 出す原因とその提案だけにした監査のデータ（区切りは画面のサーバーの側で行う。sliceAudits）。 */
  data: ProjectAudits;
  view: AuditView;
  today: string;
  /** 不安定なテストの台帳の欄（PBI-312）。 */
  flaky?: ReactNode;
}) {
  const messages = useMessages();
  const m = messages.audit;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <WithHint hint={m.screen.defaultCapHint}>
          {m.screen.defaultCap(usd(data.defaultCapUsd))}
        </WithHint>
        {data.mock && <MockBadge />}
      </div>

      <AuditCauses data={data} view={view} />

      {flaky}

      <CardSection id="audit-tasks" title={m.screen.audits}>
        {data.audits.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.screen.auditsNone}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-muted-foreground">
                  <th scope="col" className="px-2 py-1 font-normal">
                    {m.screen.task}
                  </th>
                  <th scope="col" className="px-2 py-1 font-normal">
                    {m.screen.status}
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-normal whitespace-nowrap">
                    {m.screen.remarks}
                  </th>
                  <th scope="col" className="px-2 py-1 text-right font-normal">
                    {m.screen.cost}
                  </th>
                  <th scope="col" className="px-2 py-1 font-normal whitespace-nowrap">
                    {m.screen.finishedAt}
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.audits.map((a) => (
                  <tr
                    key={a.taskId}
                    data-testid={`audit-row-${a.taskId}`}
                    className="border-t border-border"
                  >
                    <td className="px-2 py-1.5">
                      <Link
                        href={`${taskPath(a.taskId)}#audit`}
                        className="text-accent-foreground underline [overflow-wrap:anywhere]"
                      >
                        {a.taskTitle}
                      </Link>
                    </td>
                    <td className="px-2 py-1.5">
                      <AuditStatusLabel status={a.status} />
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">
                      {a.counts ? auditRemarkCount(a.counts) : "—"}
                    </td>
                    <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                      {usd(a.usedUsd)}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-xs whitespace-nowrap text-muted-foreground">
                      {a.finishedAt ? formatStamp(a.finishedAt, messages.locale) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardSection>

      <CardSection id="audit-report" title={m.report.title} hint={m.report.hint}>
        <form
          method="get"
          action={projectAuditReportPath(data.projectId)}
          className="flex flex-wrap items-end gap-3"
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-report-from">{m.report.from}</Label>
            <Input
              id="audit-report-from"
              type="date"
              name="from"
              required
              defaultValue={monthBefore(today)}
              max={today}
              className="w-44"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="audit-report-to">{m.report.to}</Label>
            <Input
              id="audit-report-to"
              type="date"
              name="to"
              required
              defaultValue={today}
              max={today}
              className="w-44"
            />
          </div>
          <Button type="submit" variant="outline">
            {m.report.download}
          </Button>
        </form>
      </CardSection>
    </div>
  );
}

/** 30日前の日付（YYYY-MM-DD）。 */
function monthBefore(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString().slice(0, 10);
}
