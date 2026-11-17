"use client";

import {
  type DeferralDecision,
  decidedDeferrals,
  deferProposals,
  gatePullRequest,
  type RemarkOrigin,
  type Task,
} from "@sacty/core";
import { useActionState } from "react";
import { type DeferralState, deferralAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

const initial: DeferralState = {};

/**
 * 指摘の元の PR のコメントの URL（PR の URL と、種類ごとの位置）。その PR のコメントから取り込んだ指摘でなければ undefined。
 * 位置の形は、デーモンが返信に付けるリンク（remarkOriginUrl）と同じ。
 */
export function deferralOriginUrl(
  pullRequest: { number: number; url?: string } | undefined,
  origin: RemarkOrigin | undefined,
): string | undefined {
  if (!pullRequest?.url || !origin || origin.number !== pullRequest.number) return undefined;
  const match = origin.key.match(/^(review|review_comment|comment):(\d+)$/);
  if (!match) return undefined;
  const anchor =
    match[1] === "review"
      ? `pullrequestreview-${match[2]}`
      : match[1] === "review_comment"
        ? `discussion_r${match[2]}`
        : `issuecomment-${match[2]}`;
  return `${pullRequest.url.replace(/\/+$/, "")}#${anchor}`;
}

/**
 * 実装が「後続に回したい」と申告した指摘（案）の一覧を、承認の画面に出し、人が 1 件ずつ「後続に回す／この PR で直す」を
 * 決める（PBI-370）。後続に回すかどうかの最終決定は人で、実装が出せるのは案と理由まで。選んでいない指摘は、まだ決めない
 * まま残る。「この PR で直す」を 1 件でも選ぶと、実装に差し戻す。決定済みの指摘は、下に記録として出す。
 */
export function DeferralNotice({ task }: { task: Task }) {
  const { task: m } = useMessages();
  const t = m.deferral;
  const [state, formAction, pending] = useActionState(deferralAction, initial);
  const proposals = deferProposals(task);
  const gate = task.gate;
  // 決定済みの記録は、実装の承認待ちの間だけ出す（一覧と同じ所で読めるように）
  const decided =
    task.status === "awaiting_approval" && gate?.step === "implement" ? decidedDeferrals(task) : [];
  if (!gate || (proposals.length === 0 && decided.length === 0)) return null;
  const pullRequest = gatePullRequest(task);
  const choices: [DeferralDecision | "", string][] = [
    ["", t.later],
    ["defer", t.defer],
    ["fix", t.fix],
  ];
  return (
    <section
      {...(proposals.length > 0
        ? { "aria-labelledby": "deferral" }
        : { "aria-label": t.decided(decided.length) })}
      data-testid="deferral"
      className="flex flex-col gap-3 rounded-xl border border-warn-line bg-warn-soft px-5 py-4"
    >
      {proposals.length > 0 && (
        <form action={formAction} className="flex flex-col gap-3">
          <input type="hidden" name="taskId" value={task.id} />
          <input type="hidden" name="step" value={gate.step} />
          <input type="hidden" name="submission" value={gate.submission} />
          <h2 id="deferral" className="flex items-center gap-1 text-[15px] font-semibold text-warn">
            {t.title(proposals.length)}
            <Hint text={t.hint} />
          </h2>
          <p className="text-sm">{t.help}</p>
          <ul className="flex flex-col gap-3 text-sm leading-6">
            {proposals.map((p) => {
              const url = deferralOriginUrl(pullRequest, p.origin);
              return (
                <li
                  key={p.remarkId}
                  data-testid="deferral-item"
                  className="flex flex-col gap-1.5 rounded-lg border border-warn-line bg-card p-3 [overflow-wrap:anywhere]"
                >
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">{t.remark(p.remarkId)}</span>
                    {p.source === "sacty_review" && <span>{t.ai}</span>}
                    {url && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-accent-foreground underline"
                      >
                        {t.open}
                      </a>
                    )}
                  </span>
                  <span className="max-h-48 overflow-y-auto whitespace-pre-line">{p.text}</span>
                  <span className="text-xs font-medium text-muted-foreground">{t.reason}</span>
                  <span className="max-h-48 overflow-y-auto whitespace-pre-line">{p.reason}</span>
                  <fieldset className="flex flex-wrap gap-x-4 gap-y-1 pt-1">
                    <legend className="sr-only">{t.legend(p.remarkId)}</legend>
                    {choices.map(([value, label]) => (
                      <label key={value} className="flex min-h-9 items-center gap-2">
                        <input
                          type="radio"
                          name={`decision:${p.remarkId}`}
                          value={value}
                          defaultChecked={value === (state.decisions?.[p.remarkId] ?? "")}
                          className="size-4 accent-primary"
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </fieldset>
                </li>
              );
            })}
          </ul>
          <p className="text-xs text-muted-foreground">{t.fixNote}</p>
          {state.message && (
            <p role="alert" className="text-sm text-warn">
              {state.message}
            </p>
          )}
          <Button type="submit" disabled={pending} className="min-h-11 w-fit">
            {t.submit}
          </Button>
        </form>
      )}
      {decided.length > 0 && (
        <details data-testid="deferral-decided" className="text-sm leading-6">
          <summary className="cursor-pointer font-medium">{t.decided(decided.length)}</summary>
          <ul className="flex flex-col gap-2 pt-2">
            {decided.map((d) => (
              <li key={d.remarkId} className="flex flex-col [overflow-wrap:anywhere]">
                <span className="text-xs text-muted-foreground">
                  {t.remark(d.remarkId)} ・ {d.decision === "defer" ? t.decidedDefer : t.decidedFix}
                </span>
                <span className="max-h-32 overflow-y-auto whitespace-pre-line">{d.text}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
