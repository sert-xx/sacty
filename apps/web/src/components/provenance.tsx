"use client";

import { needsCheck, type ProvenanceItem, type StepKey, type Task } from "@sacty/core";
import { cn } from "cn";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

/**
 * 項目ごとの出典の分類（要求要件・設計）。人間が確かめる項目（推論・原文が入力に見つからない引用・分類の無い項目）を
 * 先に挙げて目立たせ、引用・導出は件数と折りたたみにする。分類より前の記録の工程（分類させていない）では何も出さない。
 */
export function ProvenanceNote({ task, step }: { task: Task; step: StepKey }) {
  const m = useMessages().task.provenance;
  const provenance = task.provenances?.[step];
  if (provenance === undefined) return null;
  if (provenance === null) {
    return (
      <p
        data-testid={`provenance-${step}`}
        data-result="missing"
        className="flex items-center gap-1 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-sm text-warn"
      >
        {m.missing}
        <Hint text={m.missingHint} />
      </p>
    );
  }
  const check = provenance.items.filter((item) => needsCheck(provenance, item));
  const others = provenance.items.filter((item) => !needsCheck(provenance, item));
  const total = check.length + provenance.unclassified.length;
  const count = (kind: ProvenanceItem["kind"]) =>
    provenance.items.filter((item) => item.kind === kind).length;
  const reason = (item: ProvenanceItem) =>
    item.kind === "input" && item.found !== true ? m.reason.notFound : m.reason[item.kind];
  const line = (item: ProvenanceItem) => (
    <li key={item.id}>
      <span className="font-medium">{item.id}</span>
      {m.separator}
      {reason(item)}
      {item.refs.length > 0 && <span className="text-muted-foreground">{m.basis(item.refs)}</span>}
      {item.excerpt && (
        <blockquote className="mt-1 border-l-2 border-border pl-2 text-muted-foreground">
          {item.excerpt}
        </blockquote>
      )}
    </li>
  );
  return (
    <details
      data-testid={`provenance-${step}`}
      data-result={total > 0 ? "check" : "clear"}
      // 確かめる項目があれば、最初から見せる
      open={total > 0}
      className={cn(
        "rounded-lg border px-3 py-2 text-sm",
        total > 0
          ? "border-warn-line bg-warn-soft text-warn"
          : "border-accent-line text-accent-foreground",
      )}
    >
      <summary className="cursor-pointer">
        <span className="inline-flex items-center gap-1">
          {m.title(total)}
          <span className="text-muted-foreground">
            {m.counts(count("input"), count("derived"), count("inference"))}
          </span>
          <Hint text={m.hint} />
        </span>
      </summary>
      <div className="mt-2 flex flex-col gap-2 text-foreground [overflow-wrap:anywhere]">
        {provenance.sequential && <p className="text-warn">{m.sequential}</p>}
        {total > 0 && (
          <ul className="list-disc pl-5">
            {check.map(line)}
            {provenance.unclassified.map((id) => (
              <li key={id}>
                <span className="font-medium">{id}</span>
                {m.separator}
                {m.reason.unclassified}
              </li>
            ))}
          </ul>
        )}
        {others.length > 0 && (
          <details>
            <summary className="cursor-pointer text-muted-foreground">{m.others}</summary>
            <ul className="mt-1 list-disc pl-5">{others.map(line)}</ul>
          </details>
        )}
      </div>
    </details>
  );
}
