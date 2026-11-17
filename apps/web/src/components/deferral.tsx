"use client";

import {
  type DeferralDecision,
  type DeferralHandling,
  decidedDeferrals,
  deferProposals,
  gatePullRequest,
  type RemarkOrigin,
  type Task,
} from "@sacty/core";
import { useActionState, useState } from "react";
import { type DeferralState, deferralAction } from "@/app/actions";
import { DeferralHandledLine } from "@/components/deferral-handled";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

/** 後続に回すときの扱いの選択肢（この順に出す）。 */
const HANDLINGS: readonly DeferralHandling[] = ["none", "task", "issue"];

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
  const handlingLabel: Record<DeferralHandling, string> = {
    none: t.handlingNone,
    task: t.handlingTask,
    issue: t.handlingIssue,
  };
  const [state, formAction, pending] = useActionState(deferralAction, initial);
  // 選んでいる決定（扱いの選択は、「後続に回す」を選んだ指摘だけで使えるようにする。ラジオは非制御のまま、選び直しを追う）
  const [picked, setPicked] = useState<Record<string, string>>({});
  // 選んでいる扱い（GitHub の Issue を作る扱いは、取り消せないので、選んでいる間、注意を常に出す）
  const [handlings, setHandlings] = useState<Record<string, string>>({});
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
                          onChange={() => setPicked((all) => ({ ...all, [p.remarkId]: value }))}
                          className="size-4 accent-primary"
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </fieldset>
                  {/* 補足の印は、label の外に置く（select の名前に、補足の文を混ぜない） */}
                  <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <label htmlFor={`deferral-handling-${p.remarkId}`}>{t.handling}</label>
                    <Hint text={t.handlingHint} className="size-4" />
                    <select
                      id={`deferral-handling-${p.remarkId}`}
                      name={`handling:${p.remarkId}`}
                      data-testid="deferral-handling"
                      // 「後続に回す」を選んだ指摘だけで選べる（ほかの決定では使わないので、選べない見た目にする）
                      disabled={
                        (picked[p.remarkId] ?? state.decisions?.[p.remarkId] ?? "") !== "defer"
                      }
                      defaultValue={
                        state.handlings?.[p.remarkId] ?? task.deferralHandlingDefault ?? "none"
                      }
                      onChange={(e) =>
                        setHandlings((all) => ({ ...all, [p.remarkId]: e.target.value }))
                      }
                      className="h-9 rounded-md border border-input bg-card px-2 text-sm text-foreground disabled:opacity-50"
                    >
                      {HANDLINGS.map((value) => (
                        <option key={value} value={value}>
                          {handlingLabel[value]}
                        </option>
                      ))}
                    </select>
                    {(handlings[p.remarkId] ??
                      state.handlings?.[p.remarkId] ??
                      task.deferralHandlingDefault ??
                      "none") === "issue" && (
                      <span data-testid="deferral-issue-note" className="text-warn">
                        {t.issueNote}
                      </span>
                    )}
                  </span>
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
        <details
          data-testid="deferral-decided"
          className="text-sm leading-6"
          // 扱いを実行できなかった指摘があれば、開いて出す（閉じたままだと、失敗に気づけない）
          open={decided.some((d) => d.handled?.failure !== undefined) || undefined}
        >
          <summary className="cursor-pointer font-medium">{t.decided(decided.length)}</summary>
          <ul className="flex flex-col gap-2 pt-2">
            {decided.map((d) => (
              <li key={d.remarkId} className="flex flex-col [overflow-wrap:anywhere]">
                <span className="text-xs text-muted-foreground">
                  {t.remark(d.remarkId)} ・ {d.decision === "defer" ? t.decidedDefer : t.decidedFix}
                </span>
                <span className="max-h-32 overflow-y-auto whitespace-pre-line">{d.text}</span>
                {/* 後続に回すと決めた指摘の扱いと、その結果 */}
                {/* 扱いの無い決定は、何もしない（決定のコメントの「何もしません」と合わせる） */}
                {d.decision === "defer" && (!d.handling || d.handling === "none") && (
                  <span data-testid="deferral-handled" className="text-xs text-muted-foreground">
                    {handlingLabel.none}
                  </span>
                )}
                {d.decision === "defer" && d.handling && d.handling !== "none" && (
                  <span data-testid="deferral-handled" className="text-xs text-muted-foreground">
                    <DeferralHandledLine handling={d.handling} handled={d.handled} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
