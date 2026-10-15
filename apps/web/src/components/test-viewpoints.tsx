"use client";

import type { TestViewpoint } from "@sacty/core";
import { useMessages } from "@/i18n/client";

/** テスト観点の一覧。狭い画面でも崩れないよう、表ではなく観点ごとのカードで出す。 */
export function TestViewpoints({ viewpoints }: { viewpoints: TestViewpoint[] }) {
  const m = useMessages();
  if (viewpoints.length === 0) {
    return (
      <p className="rounded-md border border-warn-line bg-warn-soft p-3 text-sm leading-6 text-warn">
        {m.parts.viewpoints.empty}
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-2.5">
      {viewpoints.map((v) => (
        <li key={v.id} className="rounded-lg border border-border p-3.5 text-sm leading-6">
          <p className="flex flex-wrap items-baseline gap-2 font-medium">
            <span className="font-mono text-xs text-muted-foreground">{v.id}</span>
            {v.title}
          </p>
          <dl className="mt-1.5 grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1">
            <dt className="pt-0.5 text-xs text-muted-foreground">{m.parts.viewpoints.input}</dt>
            <dd className="break-words whitespace-pre-wrap">{v.input}</dd>
            <dt className="pt-0.5 text-xs text-muted-foreground">{m.parts.viewpoints.expected}</dt>
            <dd className="break-words whitespace-pre-wrap">{v.expected}</dd>
          </dl>
        </li>
      ))}
    </ol>
  );
}
