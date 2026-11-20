"use client";

import { RISK_SIGNAL_WEIGHT, type Task } from "@sacty/core";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

type RiskSource = Pick<
  Task,
  "riskAssessment" | "pullRequest" | "reviewTarget" | "reviewRestartCommit"
>;
type ReviewedHead = Pick<Task, "riskAssessment" | "reviewTarget" | "reviewRestartCommit">;
type ReviewTaskLink = { step: string; number: number; task?: ReviewedHead };

/** レビューのタスクが最後にレビューした（している）先頭。回が進んで対象を解決する前は、再レビューを始めた先頭。 */
const lastReviewedHead = (t: ReviewedHead) => t.reviewTarget?.headCommit ?? t.reviewRestartCommit;

/**
 * 画面に出すリスク評価と、それが今の PR の先頭の評価か（PBI-429）。
 * - レビューのタスク自身の評価（via: review）は、そのタスクが最後にレビューした先頭と比べる。評価は指摘なしの回にしか
 *   記録されないので、先頭が進んで指摘のある回になっても、前の先頭の評価が残る（その評価を、今の先頭のものとして見せない）。
 * - PR を作ったタスクは、その実装の PR のレビューの子タスクが指摘なしの回に出した評価を、子タスクを開かずに出す
 *   （子タスクの評価があれば、それを先に出す）。評価した先頭が、子タスクが最後にレビューした先頭と違えば、
 *   今の先頭の評価として見せない（current が偽。比べる先頭が無いときも偽）。
 * - 版を上げる前の記録（via: publish）は、評価した先頭と今の先頭を比べて、同じように出す。
 * 評価が無ければ undefined（何も出さない）。
 */
export function riskAssessmentToShow(
  task: RiskSource,
  reviewTasks: readonly ReviewTaskLink[] = [],
): { risk: NonNullable<Task["riskAssessment"]>; current: boolean } | undefined {
  const own = task.riskAssessment;
  const judgeReview = (risk: NonNullable<Task["riskAssessment"]>, reviewer: ReviewedHead) => {
    const head = lastReviewedHead(reviewer);
    return {
      risk,
      current: risk.commit !== undefined && head !== undefined && risk.commit === head,
    };
  };
  if (own?.via === "review") return judgeReview(own, task);
  const pr = task.pullRequest;
  const heads = [pr?.commit, pr?.reviewedCommit].filter((h): h is string => !!h);
  const judge = (risk: NonNullable<Task["riskAssessment"]>) => ({
    risk,
    current: risk.commit !== undefined && heads.includes(risk.commit),
  });
  const child = reviewTasks.findLast(
    (r) =>
      r.step === "implement" && r.number === pr?.number && r.task?.riskAssessment?.via === "review",
  )?.task;
  if (child?.riskAssessment) return judgeReview(child.riskAssessment, child);
  return own ? judge(own) : undefined;
}

/**
 * PR のリスク評価（PBI-362）。人が PR をどの深さでレビューするかを決めるための目安。合図には重さを添え、依存の版の更新が
 * あれば上げ幅を出す（PBI-377）。レビューの工程の、指摘なしの回の評価（PBI-429）。PR を作ったタスクでは、その PR の
 * レビューの子タスクの評価を出す。評価が無ければ何も出さない。評価できなかったときは、その理由を出す。
 */
export function RiskAssessmentCard({
  task,
  reviewTasks,
}: {
  task: RiskSource;
  reviewTasks?: readonly ReviewTaskLink[];
}) {
  const messages = useMessages();
  const shown = riskAssessmentToShow(task, reviewTasks);
  if (!shown) return null;
  const { risk, current } = shown;
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
      {!current && (
        <p data-testid="risk-stale" className="text-xs text-warn">
          {m.stale}
        </p>
      )}
    </section>
  );
}
