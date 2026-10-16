"use client";

import type { Task } from "@sacty/core";
import { CardSection } from "@/components/card-section";
import { useMessages } from "@/i18n/client";

/** 再現の確かめの結果（PBI-29）。sacty が再現のテストを実行した結果と、申告された再現のテスト。 */
export function ReproductionResult({ task }: { task: Task }) {
  const { task: messages, labels } = useMessages();
  const r = task.reproduction;
  if (!r) return null;
  const m = messages.reproduction;
  return (
    <CardSection id="reproduction" title={m.title} hint={m.hint}>
      <p className={r.reproduced ? "text-sm font-medium" : "text-sm font-medium text-warn"}>
        {r.reproduced ? m.reproduced : m.notReproduced}
      </p>
      {r.note && <p className="text-sm text-muted-foreground">{labels.text(r.note)}</p>}
      {r.command && (
        <p className="font-mono text-xs [overflow-wrap:anywhere] text-muted-foreground">
          {m.command(r.command, r.exitCode)}
        </p>
      )}
      {r.tests.length > 0 && (
        <div className="flex flex-col gap-1 text-sm">
          <p className="font-medium">{m.tests}</p>
          <ul className="list-disc pl-5 font-mono text-xs [overflow-wrap:anywhere]">
            {r.tests.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        </div>
      )}
      {r.output && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">{m.output}</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg border border-border bg-muted p-3 font-mono text-xs whitespace-pre-wrap">
            {r.output.slice(-8000)}
          </pre>
        </details>
      )}
    </CardSection>
  );
}
