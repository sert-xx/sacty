"use client";

import type { StepKey } from "@sacty/core";
import { useActionState } from "react";
import { retryExportAction, type TaskControlState } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";

const initial: TaskControlState = {};

/** 書き出せなかった承認済みの成果を、書き出し直す（PBI-56）。 */
export function ExportRetryButton({ taskId, step }: { taskId: string; step: StepKey }) {
  const m = useMessages().task.exports;
  const [state, action, pending] = useActionState(retryExportAction, initial);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="step" value={step} />
      <Button type="submit" variant="outline" disabled={pending} className="min-h-10">
        {pending ? m.retrying : m.retry}
      </Button>
      {state.message && (
        <p role="alert" className="w-full text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}
