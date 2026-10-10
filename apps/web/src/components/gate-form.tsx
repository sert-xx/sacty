"use client";

import { GATED_STEPS, type StepKey } from "@sacty/core";
import { useActionState } from "react";
import { type GateState, gateAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { STEP_LABEL } from "@/lib/labels";

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
}: {
  taskId: string;
  step: StepKey;
  /** 画面が表示している提出回。最新でなければデーモンが拒否する。 */
  submission: number;
  /** 差し戻し先の候補（先頭が承認ゲートの工程）。1つだけなら選択肢を出さない。 */
  targets: StepKey[];
  defaultTarget: StepKey;
  escalated: boolean;
  maxChanges: number;
  pendingComments: string[];
}) {
  const [state, formAction, pending] = useActionState(gateAction, initial);

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="step" value={step} />
      <input type="hidden" name="submission" value={submission} />
      {escalated && (
        <p className="rounded-md border border-warn-line bg-warn-soft p-3 text-sm leading-6 text-warn">
          差し戻しが上限（{maxChanges}
          回）に達しました。要求そのものを見直すなど、方針を判断してください。このまま承認するか、上限を超えて差し戻しを続けられます。
        </p>
      )}
      {targets.length > 1 && (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="pb-1 text-sm font-medium">差し戻す場合の、やり直す工程</legend>
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
                {target === targets[0]
                  ? `${STEP_LABEL[target]}をやり直す`
                  : `${STEP_LABEL[target]}からやり直す`}
                {target !== targets[0] && GATED_STEPS.includes(target) && (
                  <span className="block text-xs text-muted-foreground">
                    {STEP_LABEL[target]}の承認を取り消します。再提出された{STEP_LABEL[target]}
                    を、もう一度承認する必要があります。
                  </span>
                )}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <Label htmlFor="gate-comments">指摘（差し戻す場合は必須。1行に1件）</Label>
      <Textarea
        id="gate-comments"
        name="comments"
        rows={5}
        className="max-h-72 overflow-y-auto bg-card"
        placeholder="例：受け入れ条件に、エラー時の振る舞いがない"
        defaultValue={state.comments ?? pendingComments.join("\n")}
        aria-invalid={Boolean(state.message)}
        aria-describedby={state.message ? "gate-error" : undefined}
      />
      {state.message && (
        <p id="gate-error" role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
      <div className="flex flex-wrap gap-2.5">
        <Button
          type="submit"
          name="decision"
          value={escalated ? "continue" : "request"}
          variant="outline"
          disabled={pending}
          className="min-h-11 flex-1 border-warn-line text-warn"
        >
          {escalated ? "上限を超えて差し戻す" : "差し戻す"}
        </Button>
        <Button
          type="submit"
          name="decision"
          value="approve"
          disabled={pending}
          className="min-h-11 flex-1"
        >
          承認する
        </Button>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        指摘はタスクに累積し、再提出のたびにすべてエージェントに渡されます。同じ工程への差し戻しが
        {maxChanges}回を超えるとエスカレーションになります。
      </p>
    </form>
  );
}
