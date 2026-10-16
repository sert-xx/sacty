"use client";

import { isCompleted, MAX_INTEGRATION_ATTEMPTS, type Task } from "@sacty/core";
import { cn } from "cn";
import { CardSection } from "@/components/card-section";
import { Markdown } from "@/components/markdown";
import { useMessages } from "@/i18n/client";
import { formatStamp } from "@/lib/labels";

const OK = "border-accent-line bg-accent text-accent-foreground";
const NG = "border-warn-line bg-warn-soft text-warn";

function Pill({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <span className={cn("max-w-full rounded-full border px-2 py-0.5 text-xs", ok ? OK : NG)}>
      {children}
    </span>
  );
}

/**
 * 最新の統合レビュー（PBI-31）。合否と読んだコード、足りないこと、観点ごとの判定、過去の指摘の再発、
 * ゴールガーディアンの説明を出す。
 */
export function IntegrationResult({ task }: { task: Task }) {
  const { task: messages, labels, locale } = useMessages();
  const review = task.integration;
  if (!review) return null;
  const m = messages.integration;
  const titles = new Map((task.approved.design?.testViewpoints ?? []).map((v) => [v.id, v.title]));
  return (
    // 人間が承認した（タスクが完了した）統合レビューは折りたたむ
    <CardSection id="integration" title={m.title} hint={m.hint} collapsed={isCompleted(task)}>
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Pill ok={review.passed}>{review.passed ? m.passed : m.failed}</Pill>
        {!review.passed && task.integrationFailures > 0 && (
          <span className="text-warn">
            {m.failures(task.integrationFailures, MAX_INTEGRATION_ATTEMPTS)}
          </span>
        )}
        <span className="text-xs text-muted-foreground">{formatStamp(review.at, locale)}</span>
      </p>
      <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
        {/* リポジトリの無い親（PBI-73）は、子タスクのリポジトリごとに読んだブランチ */}
        {review.repositories
          ? m.target(
              review.repositories
                .map((r) => `${r.repo} ${r.baseBranch}@${r.commit.slice(0, 7)}`)
                .join("・"),
              "",
            )
          : m.target(review.baseBranch, review.commit.slice(0, 7))}
      </p>
      {review.summary && (
        <p className="text-sm leading-6 break-words">{labels.text(review.summary)}</p>
      )}
      {review.findings.length > 0 && (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium text-warn">{m.findings}</p>
          <ul className="list-disc pl-5 leading-6">
            {review.findings.map((f) => (
              <li key={f} className="break-words">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}
      <div className="flex flex-col gap-1.5 text-sm">
        <p className="text-xs text-muted-foreground">{m.viewpoints}</p>
        <ul className="flex flex-col gap-1.5">
          {review.viewpoints.map((v) => (
            <li key={v.viewpointId} className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xs text-muted-foreground">{v.viewpointId}</span>
              {titles.get(v.viewpointId) && (
                <span className="font-medium">{titles.get(v.viewpointId)}</span>
              )}
              <Pill ok={v.verified}>{v.verified ? m.verified : m.notVerified}</Pill>
              <span className="break-words">{labels.text(v.reason)}</span>
            </li>
          ))}
        </ul>
      </div>
      {review.remarks.length > 0 && (
        <div className="flex flex-col gap-1.5 text-sm">
          <p className="text-xs text-muted-foreground">{m.recurrence}</p>
          <ul className="flex flex-col gap-1.5">
            {review.remarks.map((r) => (
              <li key={r.remarkId} className="flex flex-wrap items-baseline gap-2">
                <span className="font-mono text-xs text-muted-foreground">{r.remarkId}</span>
                <Pill ok={r.notRecurred}>{r.notRecurred ? m.notRecurred : m.recurred}</Pill>
                <span className="break-words">{labels.text(r.reason)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {task.outputs.integrate && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{m.explanation}</summary>
          <Markdown className="mt-2 rounded-lg border border-border bg-muted px-5 py-4">
            {task.outputs.integrate}
          </Markdown>
        </details>
      )}
    </CardSection>
  );
}
