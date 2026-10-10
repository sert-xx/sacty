"use client";

import type { PauseReason } from "@sacty/core";
import { useActionState } from "react";
import { type ResumeState, resumeTaskAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMessages } from "@/i18n/client";
import { usd } from "@/lib/labels";

const initial: ResumeState = {};

export function ResumeForm({
  taskId,
  reason,
  usedUsd,
  capUsd,
  lastFailure,
}: {
  taskId: string;
  reason: PauseReason;
  usedUsd: number;
  capUsd: number;
  lastFailure?: string;
}) {
  const m = useMessages();
  const [state, formAction, pending] = useActionState(resumeTaskAction, initial);
  const needsCap = reason === "budget";
  const suggested = Math.max(capUsd * 2, Math.ceil(usedUsd) + 1);

  return (
    <section
      aria-labelledby="paused"
      className="flex flex-col gap-3 rounded-xl border border-warn-line bg-warn-soft p-5"
    >
      <h2 id="paused" className="text-[15px] font-semibold text-warn">
        {m.labels.pause[reason]}
      </h2>
      <p className="text-sm leading-6">{m.labels.pauseHelp[reason]}</p>
      {lastFailure && (
        <p className="rounded-md bg-card px-3 py-2 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
          {lastFailure}
        </p>
      )}
      <form action={formAction} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="taskId" value={taskId} />
        {needsCap && (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cap-usd">{m.parts.resume.newCap(usd(usedUsd))}</Label>
            <div className="flex items-center gap-2">
              <span className="font-mono">$</span>
              <Input
                id="cap-usd"
                name="capUsd"
                type="number"
                step="0.01"
                min={0.01}
                required
                defaultValue={state.capUsd ?? String(suggested)}
                className="w-32 bg-card font-mono"
                aria-invalid={Boolean(state.message)}
                aria-describedby={state.message ? "resume-error" : undefined}
              />
            </div>
          </div>
        )}
        <Button type="submit" disabled={pending}>
          {pending
            ? m.parts.resume.resuming
            : needsCap
              ? m.parts.resume.resumeWithCap
              : m.parts.resume.resume}
        </Button>
      </form>
      {state.message && (
        <p id="resume-error" role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
      {needsCap && <p className="text-xs text-muted-foreground">{m.parts.resume.capNote}</p>}
    </section>
  );
}
