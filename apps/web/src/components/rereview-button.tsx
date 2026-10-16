"use client";

import { useActionState } from "react";
import { rereviewTaskAction, type TaskControlState } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";

const initial: TaskControlState = {};

/** 再レビュー（PBI-44）。レビューを PR に投稿して完了したタスクで、PR の最新のコミットをもう一度レビューする。 */
export function RereviewButton({ taskId }: { taskId: string }) {
  const t = useMessages().parts.control;
  const [state, action, pending] = useActionState(rereviewTaskAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="taskId" value={taskId} />
      <Button type="submit" variant="outline" disabled={pending} className="min-h-10">
        {pending ? t.rereviewing : t.rereview}
      </Button>
      <Hint text={t.rereviewHint} />
      {state.message && (
        <p role="alert" className="w-full text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}
