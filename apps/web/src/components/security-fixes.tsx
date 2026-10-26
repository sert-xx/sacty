"use client";

import {
  SECURITY_SEVERITIES,
  SecurityCategory,
  type SecurityFinding,
  type Task,
} from "@sacty/core";
import Link from "next/link";
import { useActionState } from "react";
import { requestSecurityFixAction, type TaskControlState } from "@/app/actions";
import { CardSection } from "@/components/card-section";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";

const initial: TaskControlState = {};

/**
 * 承認したセキュリティチェックのレポートの、区分ごとの対応のタスク。区分ごとに指摘を並べ、まだ作っていなければ対応のタスクを
 * 作るボタンを、作ってあればそのタスクへのリンクを出す。findings は、デーモンがレポートから読んだ指摘。
 */
export function SecurityFixesCard({
  task,
  findings,
}: {
  task: Task;
  findings: readonly SecurityFinding[];
}) {
  const { task: messages, labels } = useMessages();
  const m = messages.security;
  const categories = SecurityCategory.options.filter((c) => findings.some((f) => f.category === c));
  return (
    <CardSection id="security-fixes" title={m.title} hint={m.hint}>
      {categories.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.none}</p>
      ) : (
        <ul className="flex flex-col gap-4">
          {categories.map((category) => {
            const listed = findings
              .filter((f) => f.category === category)
              .sort(
                (a, b) =>
                  SECURITY_SEVERITIES.indexOf(a.severity) - SECURITY_SEVERITIES.indexOf(b.severity),
              );
            const requested = task.securityFixes?.[category];
            return (
              <li
                key={category}
                className="flex flex-col gap-2"
                data-testid={`security-${category}`}
              >
                <p className="flex flex-wrap items-baseline gap-2 text-sm">
                  <span className="font-semibold">{labels.securityCategory[category]}</span>
                  <span className="text-muted-foreground">{m.findings(listed.length)}</span>
                </p>
                <ul className="flex flex-col gap-1 text-[13px] [overflow-wrap:anywhere]">
                  {listed.map((f) => (
                    <li key={f.id}>
                      <span className="font-mono text-xs text-muted-foreground">{f.id}</span>{" "}
                      <span
                        className={
                          f.severity === "critical" || f.severity === "high" ? "text-warn" : ""
                        }
                      >
                        [{m.severity[f.severity]}]
                      </span>{" "}
                      {f.title}
                      {f.refs.length > 0 && (
                        <span className="text-muted-foreground">{m.refs(f.refs)}</span>
                      )}
                    </li>
                  ))}
                </ul>
                {requested ? (
                  <p className="text-sm">
                    {m.created}
                    <Link
                      href={`/tasks/${encodeURIComponent(requested.taskId)}`}
                      className="text-accent-foreground underline"
                    >
                      {requested.title}
                    </Link>
                  </p>
                ) : (
                  <CreateButton taskId={task.id} category={category} />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </CardSection>
  );
}

function CreateButton({ taskId, category }: { taskId: string; category: SecurityCategory }) {
  const m = useMessages().task.security;
  const [state, action, pending] = useActionState(requestSecurityFixAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="category" value={category} />
      <Button type="submit" variant="outline" disabled={pending} className="min-h-10">
        {pending ? m.creating : m.create}
      </Button>
      {state.message && (
        <p role="alert" className="w-full text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}
