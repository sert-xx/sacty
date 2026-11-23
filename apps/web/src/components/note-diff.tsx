"use client";

import { useMessages } from "@/i18n/client";

type Viewpoint = { id: string; title: string; input: string; expected: string };
type Entry = { sign: string; raw: string; viewpoint?: Viewpoint };

export function NoteDiff({ diff }: { diff: { design: string; testViewpoints: string } }) {
  const { parts } = useMessages();
  const m = parts.proposals;
  const label = (sign: string) => (sign === "-" ? m.removed : m.added);
  const color = (sign: string) => (sign === "-" ? "bg-destructive/10" : "bg-ok-soft");
  const entries: Entry[] = diff.testViewpoints
    ? diff.testViewpoints.split("\n").map((raw) => {
        const sign = raw[0] === "-" || raw[0] === "+" ? raw[0] : "";
        if (sign) {
          try {
            const value = JSON.parse(raw.slice(1));
            if (
              value &&
              [value.id, value.title, value.input, value.expected].every(
                (v) => typeof v === "string",
              )
            ) {
              return { sign, raw, viewpoint: value as Viewpoint };
            }
          } catch {
            /* 元の行を表示する */
          }
        }
        return { sign, raw };
      })
    : [];
  const groups: Entry[][] = [];
  for (const entry of entries) {
    const group =
      entry.viewpoint && groups.find((g) => g[0]?.viewpoint?.id === entry.viewpoint?.id);
    if (group) group.push(entry);
    else groups.push([entry]);
  }
  return (
    <div className="min-w-0 space-y-3 pt-1 text-sm" data-testid="note-diff">
      <section className="min-w-0">
        <h4 className="font-medium">{m.designDiff}</h4>
        {diff.design ? (
          diff.design.split("\n").map((line, i) => {
            const sign = line[0] === "-" || line[0] === "+" ? line[0] : "";
            return (
              <div
                key={`${line}:${
                  diff.design
                    .split("\n")
                    .slice(0, i)
                    .filter((v) => v === line).length
                }`}
                className={`grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-2 text-foreground ${sign ? color(sign) : ""}`}
                data-testid="design-diff-line"
              >
                <span>
                  {sign && (
                    <>
                      <span aria-hidden="true">{sign}</span>
                      <span className="sr-only">{label(sign)}</span>
                    </>
                  )}
                </span>
                <span className="min-w-0 whitespace-pre-wrap break-all">
                  {sign ? line.slice(1) : line}
                </span>
              </div>
            );
          })
        ) : (
          <p>{m.noChanges}</p>
        )}
      </section>
      <section className="min-w-0">
        <h4 className="font-medium">{m.viewpointsDiff}</h4>
        {groups.length === 0 ? (
          <p>{m.noChanges}</p>
        ) : (
          <div className="space-y-2">
            {groups.map((group, i) => (
              <div
                key={`${group[0]?.raw}:${groups.slice(0, i).filter((g) => g[0]?.raw === group[0]?.raw).length}`}
                className="grid min-w-0 gap-2 sm:grid-cols-2"
              >
                {group.map((entry, j) =>
                  entry.viewpoint ? (
                    <article
                      key={`${entry.raw}:${group.slice(0, j).filter((v) => v.raw === entry.raw).length}`}
                      className={`min-w-0 rounded-lg border border-border p-3 text-foreground ${color(entry.sign)}`}
                      data-testid="viewpoint-diff-card"
                    >
                      <p>{label(entry.sign)}</p>
                      <p className="break-all font-medium">
                        {entry.viewpoint.id} {entry.viewpoint.title}
                      </p>
                      <dl className="grid min-w-0 grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1">
                        <dt>{parts.viewpoints.input}</dt>
                        <dd className="min-w-0 whitespace-pre-wrap break-all">
                          {entry.viewpoint.input}
                        </dd>
                        <dt>{parts.viewpoints.expected}</dt>
                        <dd className="min-w-0 whitespace-pre-wrap break-all">
                          {entry.viewpoint.expected}
                        </dd>
                      </dl>
                    </article>
                  ) : (
                    <p
                      key={`${entry.raw}:${group.slice(0, j).filter((v) => v.raw === entry.raw).length}`}
                      className="min-w-0 whitespace-pre-wrap break-all"
                    >
                      {entry.raw}
                    </p>
                  ),
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
