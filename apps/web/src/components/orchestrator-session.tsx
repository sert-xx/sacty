"use client";

import type { Task } from "@sacty/core";
import { CardSection } from "@/components/card-section";
import { useMessages } from "@/i18n/client";
import { formatStamp } from "@/lib/labels";

/**
 * タスクのオーケストレーターのセッション（PBI-67）。AI・セッションの ID・使った回数・新しく始めた理由。
 * セッションを使ったことのないタスクでは出さない。
 */
export function OrchestratorSession({ task }: { task: Task }) {
  const messages = useMessages();
  const session = task.orchestratorSession;
  if (!session) return null;
  const { labels, locale } = messages;
  const m = messages.task.orchestratorSession;
  const rows: [string, string][] = [
    [m.agent, m.agentValue(session.agentId, session.runtime)],
    [m.sessionId, session.sessionId ?? "—"],
    [m.uses, m.usesValue(session.uses)],
    [m.reason, labels.orchestratorSession.reason[session.reason ?? "first"]],
    [m.lastUsed, formatStamp(session.lastUsedAt, locale)],
  ];
  return (
    <CardSection id="orchestrator-session" title={m.title} note={m.note}>
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="font-mono [overflow-wrap:anywhere]">{value}</dd>
          </div>
        ))}
      </dl>
      {!session.saved && <p className="text-sm text-warn">{m.notSaved}</p>}
    </CardSection>
  );
}
