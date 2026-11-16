"use client";

import type { Task } from "@sacty/core";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

/**
 * PR のリスク評価（PBI-362）。人が PR をどの深さでレビューするかを決めるための目安。sacty が PR を出す前の評価と、PR から
 * 取り込んだレビューのタスクの評価の、最後のもの。評価が無ければ何も出さない。評価できなかったときは、その理由を出す。
 */
export function RiskAssessmentCard({ task }: { task: Pick<Task, "riskAssessment"> }) {
  const messages = useMessages();
  const risk = task.riskAssessment;
  if (!risk) return null;
  const m = messages.parts.riskAssessment;
  const a = risk.assessment;
  const term = "pt-0.5 text-xs text-muted-foreground";
  return (
    <section
      aria-labelledby="risk-assessment"
      data-testid="risk-assessment"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="risk-assessment" className="text-[15px] font-semibold">
        {m.title} <Hint text={m.hint} />
      </h2>
      {a ? (
        <dl className="grid grid-cols-[152px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm leading-6">
          <dt className={term}>{m.level}</dt>
          <dd data-testid="risk-level" className="font-semibold">
            {m.levels[a.level]}
          </dd>
          <dt className={term}>{m.depth}</dt>
          <dd>
            {m.depths[a.level]}{" "}
            <Hint
              text={
                { low: m.depthLowHint, medium: m.depthMediumHint, high: m.depthHighHint }[a.level]
              }
            />
          </dd>
          {a.signals.length > 0 && (
            <>
              <dt className={term}>{m.signals}</dt>
              <dd>{a.signals.map((signal) => m.signal[signal]).join(" · ")}</dd>
            </>
          )}
          <dt className={term}>{m.change}</dt>
          <dd className="[overflow-wrap:anywhere]">{a.change}</dd>
          <dt className={term}>{m.scope}</dt>
          <dd className="[overflow-wrap:anywhere]">{a.scope}</dd>
          <dt className={term}>{m.reversibility}</dt>
          <dd className="[overflow-wrap:anywhere]">{a.reversibility}</dd>
          <dt className={term}>{m.verification}</dt>
          <dd className="[overflow-wrap:anywhere]">{a.verification}</dd>
          {a.focus.length > 0 && (
            <>
              <dt className={term}>{m.focus}</dt>
              <dd>
                <ul className="flex flex-col gap-1">
                  {a.focus.map((f) => (
                    <li key={`${f.where}\n${f.why}`} className="[overflow-wrap:anywhere]">
                      <span className="font-mono text-xs">{f.where}</span> {f.why}
                    </li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      ) : (
        <p data-testid="risk-failed" className="text-sm leading-6 text-warn">
          {m.failed}
          {risk.reason && (
            <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {messages.labels.text(risk.reason)}
            </span>
          )}
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {m.via[risk.via]}
        {risk.commit ? ` · ${m.commit(risk.commit.slice(0, 7))}` : ""}
      </p>
    </section>
  );
}
