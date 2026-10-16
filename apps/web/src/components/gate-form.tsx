"use client";

import { GATED_STEPS, type StepKey } from "@sacty/core";
import { useActionState } from "react";
import { type GateState, gateAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMessages } from "@/i18n/client";

const initial: GateState = {};

export function GateForm({
  taskId,
  step,
  submission,
  targets,
  defaultTarget,
  escalated,
  maxChanges,
  pendingComments,
  pullRequest,
  rework,
  notReproduced = false,
  noChanges = false,
}: {
  taskId: string;
  step: StepKey;
  /** 画面が表示している提出回。最新でなければデーモンが拒否する。 */
  submission: number;
  /** 差し戻し先の候補（先頭が承認ゲートの工程）。空なら差し戻し不可。1つだけなら選択肢を出さない。 */
  targets: StepKey[];
  defaultTarget: StepKey;
  escalated: boolean;
  maxChanges: number;
  pendingComments: string[];
  /** PR を作った工程（実装・要求要件・設計）。PR のマージで承認するので、承認のボタンは出さない（PBI-14a）。 */
  pullRequest?: { number: number; url?: string; closed: boolean; mergedOutdated: boolean };
  /** PR の指摘の戻し先の確認（PBI-14b）。ゴールガーディアンの提案と理由。 */
  rework?: { target: StepKey; note: string };
  /** 再現できなかった（PBI-29）。承認では先へ進めないので、承認のボタンは出さない。 */
  notReproduced?: boolean;
  /** 実装に変更が無く、PR を作らなかった実装の承認（PBI-90・PBI-110）。承認すると変更なしで完了する。 */
  noChanges?: boolean;
}) {
  const [state, formAction, pending] = useActionState(gateAction, initial);
  const m = useMessages();
  const t = m.review.gate;
  const stepLabel = m.labels.step;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="step" value={step} />
      <input type="hidden" name="submission" value={submission} />
      {pullRequest && (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-muted p-3 text-sm leading-6">
          <p className="font-semibold">{t.prTitle}</p>
          <p className="flex flex-wrap items-center gap-1">
            {step === "implement" ? t.prHelp : t.stepPrHelp(stepLabel[step])}
            <Hint text={step === "implement" ? t.prHint : t.stepPrHint(stepLabel[step])} />
          </p>
          {pullRequest.url && (
            <a
              href={pullRequest.url}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex min-h-11 w-fit items-center rounded-lg bg-primary px-4 font-semibold text-primary-foreground"
            >
              {t.prOpen(pullRequest.number)}
            </a>
          )}
          {pullRequest.closed && <p className="text-warn">{t.prClosed}</p>}
          {pullRequest.mergedOutdated && <p className="text-warn">{t.prMergedOutdated}</p>}
          <p className="text-muted-foreground">{t.prRequestNote}</p>
        </div>
      )}
      {rework && (
        <div className="flex flex-col gap-1.5 rounded-md border border-warn-line bg-warn-soft p-3 text-sm leading-6 text-warn">
          <p className="font-semibold">{t.reworkTitle}</p>
          <p>{t.reworkSuggestion(stepLabel[rework.target], rework.note)}</p>
          <p className="flex flex-wrap items-center gap-1">
            {t.reworkHelp}
            <Hint text={t.reworkHint} />
          </p>
        </div>
      )}
      {noChanges && (
        <div
          data-testid="no-changes"
          className="flex flex-col gap-1.5 rounded-md border border-warn-line bg-warn-soft p-3 text-sm leading-6 text-warn"
        >
          <p className="font-semibold">{t.noChangesTitle}</p>
          <p className="flex flex-wrap items-center gap-1">
            {t.noChangesHelp}
            <Hint text={t.noChangesHint} />
          </p>
        </div>
      )}
      {notReproduced && (
        <div className="flex flex-col gap-1.5 rounded-md border border-warn-line bg-warn-soft p-3 text-sm leading-6 text-warn">
          <p className="font-semibold">{t.notReproducedTitle}</p>
          <p>{t.notReproducedHelp}</p>
        </div>
      )}
      {targets.length > 0 && escalated && !rework && (
        <p className="rounded-md border border-warn-line bg-warn-soft p-3 text-sm leading-6 text-warn">
          {t.escalated(maxChanges)}
        </p>
      )}
      {targets.length > 1 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="pb-1 text-sm font-medium">{t.targetLegend}</legend>
          {targets.map((target) => (
            <label key={target} className="flex min-h-9 items-start gap-2 text-sm leading-6">
              <input
                type="radio"
                name="target"
                value={target}
                defaultChecked={target === (state.target ?? defaultTarget)}
                className="mt-1.5 size-4 accent-primary"
              />
              <span>
                {target === targets[0] ? t.redo(stepLabel[target]) : t.redoFrom(stepLabel[target])}
                {target !== targets[0] && GATED_STEPS.includes(target) && (
                  <span className="block text-xs text-muted-foreground">
                    {t.revokeNote(stepLabel[target])}
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      {targets.length > 0 && (
        <>
          <span className="flex items-center gap-1">
            <Label htmlFor="gate-comments">
              {rework ? t.commentsLabelRework : t.commentsLabel}
            </Label>
            <Hint text={t.commentsHint(maxChanges)} />
          </span>
          <Textarea
            id="gate-comments"
            name="comments"
            rows={5}
            className="max-h-72 overflow-y-auto bg-card"
            placeholder={t.commentsPlaceholder}
            defaultValue={state.comments ?? pendingComments.join("\n")}
            aria-invalid={Boolean(state.message)}
            aria-describedby={state.message ? "gate-error" : undefined}
          />
        </>
      )}
      {targets.length === 0 && step === "operation" && (
        <p className="text-sm leading-6 text-muted-foreground">{t.operationExecutedHelp}</p>
      )}
      {state.message && (
        <p id="gate-error" role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2.5">
        {targets.length > 0 && (
          <Button
            type="submit"
            name="decision"
            value={escalated && !rework ? "continue" : "request"}
            variant="outline"
            disabled={pending}
            className="min-h-11 flex-1 border-warn-line text-warn"
          >
            {escalated && !rework ? t.requestOverLimit : t.request}
          </Button>
        )}
        {!pullRequest && !notReproduced && (
          <Button
            type="submit"
            name="decision"
            value="approve"
            disabled={pending}
            className="min-h-11 flex-1"
          >
            {t.approve}
          </Button>
        )}
      </div>
    </form>
  );
}
