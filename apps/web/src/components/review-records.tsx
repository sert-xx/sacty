"use client";

import type { Task } from "@sacty/core";
import { useMessages } from "@/i18n/client";

/**
 * レビューの記録（PBI-460）。PR には出さない過程の情報（観点ごとの扱い・見られなかった観点・採用しなかった指摘・落とした件数・
 * 検証の経過）と、回ごとに動いたエージェントを、すべての回について出す。記録の文は、PR を読んだエージェントが書いたものなので、
 * Markdown・HTML として解釈せず、文字列のまま出す。記録の無い回（これより前の作業履歴を含む）は、欄を出さない。
 */
export function ReviewRecords({ records }: { records: NonNullable<Task["reviewRecords"]> }) {
  const m = useMessages().task.deliverable;
  const sep = m.reviewRecordSep;
  if (records.length === 0) return null;
  return (
    <section data-testid="review-records" className="flex flex-col gap-2 pt-1">
      <h3 className="text-sm font-semibold">{m.reviewRecordTitle}</h3>
      {records.map((r) => (
        <div
          key={r.round}
          data-round={r.round}
          className="flex flex-col gap-1.5 rounded-lg border border-border p-3 text-sm [overflow-wrap:anywhere]"
        >
          <p className="font-medium">{m.reviewRecordRound(r.round)}</p>
          {r.reviewDispatch && (
            <p className="text-muted-foreground">
              {m.reviewAgent(r.reviewDispatch.agentId, r.reviewDispatch.model)}
              {" · "}
              {m.reviewSubagents(r.reviewDispatch.subagents)}
              {r.reviewDispatch.configuredAgentId && (
                <> · {m.reviewAgentSwitched(r.reviewDispatch.configuredAgentId)}</>
              )}
            </p>
          )}
          {r.record === null ? (
            <p className="text-muted-foreground">{m.reviewRecordUnreadable}</p>
          ) : (
            <dl className="flex flex-col gap-1.5">
              {r.record.mode && (
                <Item label={m.reviewRecordModeLabel}>{m.reviewRecordMode(r.record.mode)}</Item>
              )}
              {r.record.viewpoints.length > 0 && (
                <Item label={m.reviewRecordViewpoints}>
                  <List
                    items={r.record.viewpoints.map(
                      (v) =>
                        `${v.id}${sep}${m.reviewRecordStatus(v.status)}${v.reason ? ` (${v.reason})` : ""}`,
                    )}
                  />
                </Item>
              )}
              {r.record.notReviewed.length > 0 && (
                <Item label={m.reviewRecordNotReviewed}>
                  <List items={r.record.notReviewed.map((v) => `${v.id}${sep}${v.reason}`)} />
                </Item>
              )}
              {r.record.dismissed.length > 0 && (
                <Item label={m.reviewRecordDismissed}>
                  <List
                    items={r.record.dismissed.map(
                      (d) => `${d.title}${d.viewpoint ? ` [${d.viewpoint}]` : ""}${sep}${d.reason}`,
                    )}
                  />
                </Item>
              )}
              {r.record.dropped && (
                <Item label={m.reviewRecordDropped}>
                  {m.reviewRecordDroppedCounts(r.record.dropped)}
                </Item>
              )}
              {r.record.scope.length > 0 && (
                <Item label={m.reviewRecordScope}>
                  <List items={r.record.scope} />
                </Item>
              )}
              {r.record.verification.length > 0 && (
                <Item label={m.reviewRecordVerification}>
                  <List
                    items={r.record.verification.map(
                      (v) => `${m.reviewRecordVerificationKind(v.kind)}${sep}${v.text}`,
                    )}
                  />
                </Item>
              )}
            </dl>
          )}
        </div>
      ))}
    </section>
  );
}

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="whitespace-pre-wrap">{children}</dd>
    </div>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5">
      {items.map((text, i) => (
        // 同じ文が並びうるので、位置も含める
        // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない一覧
        <li key={`${i}:${text}`}>{text}</li>
      ))}
    </ul>
  );
}
