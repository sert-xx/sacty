import {
  auditAdoptionRate,
  auditRemarkCount,
  isPendingAuditProposal,
  type ProjectAudits,
} from "@sacty/core";
import type { Messages } from "@/i18n";
import { auditTargetText } from "@/lib/audit";
import { usd } from "@/lib/labels";

/** 日付（YYYY-MM-DD）か。 */
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** レポートの日時（年を含めた UTC。ファイルは後で読むので、画面の短い日時にしない）。 */
export function reportStamp(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * レポートの期間（PBI-124）。from・to は日付（YYYY-MM-DD、UTC）で、to の日の終わりまでを含む。日付でない・実在しない・
 * from が to より後なら null。
 */
export function reportPeriod(
  from: string | null,
  to: string | null,
): { from: string; to: string; start: string; end: string } | null {
  if (!from || !to || !DAY.test(from) || !DAY.test(to)) return null;
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`) + 86_400_000;
  if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return null;
  // 実在しない日付（2月30日など）は、Date が翌月へ繰り越すので、日付に戻して入力と比べる（PR #134 レビュー指摘）
  const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  if (day(start) !== from || day(end - 86_400_000) !== to) return null;
  return { from, to, start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

/**
 * 監査のレポート（Markdown。PBI-124）。期間に完了した監査の、原因・改修の提案・判断をまとめる。見出しと表の項目は画面の
 * 言語で書き、監査の結果の文（原因・提案）は訳さない。
 */
export function auditReport(
  data: ProjectAudits,
  projectName: string,
  period: NonNullable<ReturnType<typeof reportPeriod>>,
  messages: Messages,
): string {
  const m = messages.audit;
  const r = messages.audit.report;
  const inPeriod = (at: string | undefined) =>
    at !== undefined && at >= period.start && at < period.end;
  const audits = data.audits.filter((a) => a.status === "completed" && inPeriod(a.finishedAt));
  const auditIds = new Set(audits.map((a) => a.taskId));
  const causes = data.causes
    .map((c) => ({ ...c, occurrences: c.occurrences.filter((o) => auditIds.has(o.taskId)) }))
    .filter((c) => c.occurrences.length > 0);
  const proposals = data.proposals.filter((p) => auditIds.has(p.taskId));
  const adopted = proposals.filter((p) => p.decision?.kind === "adopted").length;
  const rejected = proposals.filter((p) => p.decision?.kind === "rejected").length;
  const rate = auditAdoptionRate(adopted, rejected);
  const remarks = audits.reduce((sum, a) => sum + (a.counts ? auditRemarkCount(a.counts) : 0), 0);
  const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

  const lines: string[] = [
    `# ${m.title}: ${projectName}`,
    "",
    `${r.from} ${period.from} — ${r.to} ${period.to}`,
  ];
  if (data.mock) lines.push("", `> ${m.mock}: ${m.mockHint}`);
  lines.push(
    "",
    `- ${m.screen.audits}: ${audits.length}`,
    `- ${m.screen.remarks}: ${remarks}`,
    `- ${m.screen.causes}: ${causes.length}`,
    `- ${m.dashboard.recurred}: ${causes.filter((c) => c.status === "recurred").length}`,
    `- ${m.dashboard.pending}: ${proposals.filter(isPendingAuditProposal).length}`,
    `- ${m.dashboard.adoption}: ${rate === null ? m.dashboard.noRate : `${Math.round(rate * 100)}%`}`,
    "",
    `## ${m.screen.causes}`,
    "",
  );
  if (causes.length === 0) lines.push(m.screen.causesNone);
  for (const c of causes) {
    lines.push(
      `### ${c.title}`,
      "",
      `- ${m.screen.status}: ${m.screen.causeStatus[c.status]}`,
      `- ${m.screen.tasks}: ${c.occurrences.map((o) => o.taskTitle).join(", ")}`,
    );
    if (c.fixedAt) lines.push(`- ${m.screen.fixedAt}: ${reportStamp(c.fixedAt)}`);
    if (c.recurredAt) {
      lines.push(`- ${m.screen.recurredAt}: ${reportStamp(c.recurredAt)}`);
    }
    lines.push("");
  }
  lines.push(`## ${m.screen.proposals}`, "");
  if (proposals.length === 0) lines.push(m.screen.proposalsNone);
  for (const p of proposals) {
    const target = auditTargetText(
      p.decision?.kind === "adopted" ? p.decision.target : p.target,
      m.target,
    );
    const state =
      p.decision?.kind === "adopted"
        ? m.proposal.adopted
        : p.decision?.kind === "rejected"
          ? m.proposal.rejected
          : m.proposal.pending;
    lines.push(
      `### ${p.title}`,
      "",
      `- ${m.screen.status}: ${state}`,
      `- ${m.target.label}: ${target.kind}${target.detail ? ` ${target.detail}` : ""}`,
      `- ${m.proposal.from}: ${p.taskTitle}`,
    );
    if (p.decision?.kind === "adopted")
      lines.push(`- ${m.proposal.task}: ${p.decision.task.title}`);
    if (p.decision?.kind === "rejected") {
      lines.push(`- ${m.proposal.rejectedReason}: ${p.decision.reason}`);
    }
    lines.push("", p.body, "");
  }
  lines.push(
    `## ${m.screen.audits}`,
    "",
    `| ${m.screen.task} | ${m.screen.remarks} | ${m.screen.cost} | ${m.screen.finishedAt} |`,
    "| --- | ---: | ---: | --- |",
  );
  for (const a of audits) {
    lines.push(
      `| ${cell(a.taskTitle)} | ${a.counts ? auditRemarkCount(a.counts) : 0} | ${usd(a.usedUsd)} | ${a.finishedAt ? reportStamp(a.finishedAt) : ""} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}
