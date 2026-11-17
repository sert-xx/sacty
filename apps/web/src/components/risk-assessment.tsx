"use client";

import { RISK_SIGNAL_WEIGHT, type Task } from "@sacty/core";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

/**
 * PR のリスク評価（PBI-362）。人が PR をどの深さでレビューするかを決めるための目安。合図には重さを添え、依存の版の更新が
 * あれば上げ幅を出す（PBI-377）。sacty が PR を出す前の評価と、PR から
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
              <dd data-testid="risk-signals">
                {a.signals
                  .map((signal) => {
                    // 合図の名前に、重さを添える（PBI-377）。外した合図（以前の記録）には、添えない
                    const weight = RISK_SIGNAL_WEIGHT[signal];
                    return weight === "retired"
                      ? m.signal[signal]
                      : m.weighted[weight](m.signal[signal]);
                  })
                  .join(" · ")}{" "}
                <Hint text={m.signalsHint} />
              </dd>
            </>
          )}
          {a.dependencyUpdate && (
            <>
              <dt className={term}>{m.dependencyUpdate}</dt>
              <dd data-testid="risk-dependency-update">
                {m.dependencyUpdates[a.dependencyUpdate]} <Hint text={m.dependencyUpdateHint} />
              </dd>
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
