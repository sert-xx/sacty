"use client";

import { effectiveSelfReviewDepth, type Task } from "@sacty/core";
import { useActionState } from "react";
import { type ChangeSelfReviewDepthState, changeSelfReviewDepthAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

const initial: ChangeSelfReviewDepthState = {};

/**
 * 提出の前のセルフレビューの深さ（PBI-369）。オーケストレーターが工程を選ぶときに判定した依頼の大きさと理由を出す。
 * 軽いと判定されたタスクでは、人が「通常の深さで」と上書きでき、上書きした後は判定に戻せる。判定の無いタスク
 * （この判定より前の記録・答えを読めなかったタスク・PR のレビューだけのタスク）では何も出さない。
 */
export function SelfReviewDepthNote({ task }: { task: Task }) {
  const messages = useMessages();
  const m = messages.task.selfReviewDepth;
  const judged = task.selfReviewDepth;
  if (!judged) return null;
  const depth = effectiveSelfReviewDepth(task);
  const overridden = judged.judged === "light" && depth === "normal";
  const reason = judged.reason === undefined ? "" : messages.labels.text(judged.reason);
  return (
    <div
      data-testid="self-review-depth"
      data-depth={depth}
      data-judged={judged.judged}
      className="flex flex-col gap-1 text-sm leading-6 text-muted-foreground"
    >
      <p className="[overflow-wrap:anywhere]">
        {overridden ? m.overridden : depth === "light" ? m.light : m.normal} <Hint text={m.hint} />
        {reason && (
          <>
            <br />
            {overridden ? m.judgedLightReason(reason) : m.reason(reason)}
          </>
        )}
      </p>
      {judged.judged === "light" && task.status !== "cancelled" && (
        <SelfReviewDepthForm taskId={task.id} to={overridden ? "light" : "normal"} />
      )}
    </div>
  );
}

/** 深さを変える操作。軽いと判定されたタスクにだけ出す（to は、押したときに変える先の深さ）。 */
function SelfReviewDepthForm({ taskId, to }: { taskId: string; to: "light" | "normal" }) {
  const m = useMessages().task.selfReviewDepth;
  const [state, formAction, pending] = useActionState(changeSelfReviewDepthAction, initial);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="depth" value={to} />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={pending}
        data-testid="self-review-depth-change"
      >
        {pending ? m.changing : to === "normal" ? m.toNormal : m.toJudged}
      </Button>
      <span className="text-xs">{m.when}</span>
      {state.message && (
        <p role="alert" className="w-full text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}
