"use client";

import { auditRemarkCount, isPendingAuditProposal, type ProjectAudits } from "@sacty/core";
import { cn } from "cn";
import Link from "next/link";
import { AuditStatusLabel, MockBadge, ProposalView } from "@/components/audit";
import { CardSection } from "@/components/card-section";
import { Button } from "@/components/ui/button";
import { WithHint } from "@/components/ui/hint";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";
import { formatStamp, usd } from "@/lib/labels";
import { projectAuditReportPath, taskPath } from "@/lib/paths";

/** 原因の状態の色。再発は目立たせる（警告の色）。 */
const CAUSE_STYLE: Record<ProjectAudits["causes"][number]["status"], string> = {
  recurred: "border-warn-line bg-warn-soft text-warn font-semibold",
  proposed: "border-accent-line bg-accent text-accent-foreground",
  adopted: "border-ok-line bg-ok-soft text-ok",
  fixed: "border-ok-line bg-ok-soft text-ok",
  rejected: "border-input text-muted-foreground",
};

/**
 * プロジェクトの監査の画面（PBI-124）。タスクをまたいでまとめた原因・改修の提案（判断待ちを上に）・監査したタスク・
 * レポートの出力を出す。プロジェクトをまたいで集約しない。
 */
export function AuditScreen({ data, today }: { data: ProjectAudits; today: string }) {
  const messages = useMessages();
  const m = messages.audit;
  const pending = data.proposals.filter(isPendingAuditProposal).length;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
        <WithHint hint={m.screen.defaultCapHint}>
          {m.screen.defaultCap(usd(data.defaultCapUsd))}
        </WithHint>
        {data.mock && <MockBadge />}
      </div>

      <CardSection
        id="audit-causes"
        title={m.screen.causes}
        hint={m.screen.causesHint}
        note={m.screen.causesNote(data.causes.length)}
      >
        {data.causes.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.screen.causesNone}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.causes.map((cause) => (
              <li
                key={cause.id}
                data-testid={`audit-cause-${cause.id}`}
                className={cn(
                  "flex flex-col gap-1.5 rounded-lg border px-3 py-2.5",
                  cause.status === "recurred" ? "border-warn-line" : "border-border",
                )}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span
                    data-testid="audit-cause-status"
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs",
                      CAUSE_STYLE[cause.status],
                    )}
                  >
                    {m.screen.causeStatus[cause.status]}
                  </span>
                  <span className="text-sm font-semibold">{cause.title}</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {m.screen.occurrences(cause.occurrences.length)}
                  </span>
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  {cause.fixedAt && (
                    <span>
                      {m.screen.fixedAt}{" "}
                      <time dateTime={cause.fixedAt} className="font-mono">
                        {formatStamp(cause.fixedAt, messages.locale)}
                      </time>
                    </span>
                  )}
                  {cause.recurredAt && (
                    <span className="text-warn">
                      {m.screen.recurredAt}{" "}
                      <time dateTime={cause.recurredAt} className="font-mono">
                        {formatStamp(cause.recurredAt, messages.locale)}
                      </time>
                    </span>
                  )}
                </div>
                <p className="flex flex-wrap gap-x-3 gap-y-1 text-[13px]">
                  <span className="text-muted-foreground">{m.screen.tasks}</span>
                  {cause.occurrences.map((o) => (
                    <Link
                      key={o.taskId}
                      href={taskPath(o.taskId)}
                      className="text-accent-foreground underline [overflow-wrap:anywhere]"
                    >
                      {o.taskTitle}
                    </Link>
                  ))}
                </p>
              </li>
            ))}
          </ul>
        )}
      </CardSection>

      <CardSection
        id="audit-proposals"
        title={m.screen.proposals}
        note={pending > 0 ? m.screen.proposalsNote(pending) : undefined}
      >
        {data.proposals.length === 0 ? (
          <p className="text-sm text-muted-foreground">{m.screen.proposalsNone}</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.proposals.map((p) => (
              <li key={p.id}>
                <ProposalView proposal={p} from={{ taskId: p.taskId, title: p.taskTitle }} />
              </li>
            ))}
          </ul>
        )}
      </CardSection>

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
