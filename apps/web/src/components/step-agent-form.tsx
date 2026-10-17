"use client";

import type { StepKey } from "@sacty/core";
import { useActionState } from "react";
import { type ChangeStepAgentState, changeStepAgentAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";

const initial: ChangeStepAgentState = {};

/**
 * 工程のエージェントを変えるフォーム（PBI-121）。選べるのは config.yaml の agents の名前（モデル・リーズニングエフォートも出す）。
 * 今のエージェントが agents から消えていれば、選択肢には出さない（選び直してもらう）。
 */
export function StepAgentForm({
  taskId,
  step,
  current,
  options,
}: {
  taskId: string;
  step: StepKey;
  current: string | undefined;
  options: { id: string; model?: string; reasoningEffort?: string }[];
}) {
  const messages = useMessages();
  const m = messages.task.agents;
  const [state, formAction, pending] = useActionState(changeStepAgentAction, initial);
  const id = `step-agent-${step}`;
  const known = options.some((o) => o.id === current);
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="step" value={step} />
      <label htmlFor={id} className="sr-only">
        {m.label(messages.labels.step[step])}
      </label>
      <select
        id={id}
        name="agent"
        defaultValue={known ? current : ""}
        required
        data-testid={id}
        className="h-9 max-w-full min-w-0 rounded-md border border-border bg-card px-2 font-mono text-sm"
      >
        {!known && (
          <option value="" disabled>
            {current ?? m.unknown}
          </option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {m.option(o.id, o.model, o.reasoningEffort)}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline" disabled={pending} className="min-h-9">
        {pending ? m.changing : m.change}
      </Button>
      {state.message && (
        <p role="alert" className="w-full text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}
