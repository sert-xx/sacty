"use client";

import type { StepKey } from "@sacty/core";
import { useActionState } from "react";
import { type ChangeStepImageState, changeStepImageAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";

const initial: ChangeStepImageState = {};

/**
 * 工程のイメージを変えるフォーム（PBI-106）。選べるのは images の名前と既定のイメージ（説明も出す）。今のイメージが
 * images から消えていれば、選択肢には出さない（選び直してもらう）。
 */
export function StepImageForm({
  taskId,
  step,
  current,
  options,
}: {
  taskId: string;
  step: StepKey;
  current: string;
  options: { name: string; description: string }[];
}) {
  const messages = useMessages();
  const m = messages.task.images;
  const [state, formAction, pending] = useActionState(changeStepImageAction, initial);
  const id = `step-image-${step}`;
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <input type="hidden" name="step" value={step} />
      <label htmlFor={id} className="sr-only">
        {m.label(messages.labels.step[step])}
      </label>
      <select
        id={id}
        name="image"
        defaultValue={options.some((o) => o.name === current) ? current : ""}
        required
        data-testid={id}
        className="h-9 max-w-full min-w-0 rounded-md border border-border bg-card px-2 font-mono text-sm"
      >
        {!options.some((o) => o.name === current) && (
          <option value="" disabled>
            {current}
          </option>
        )}
        {options.map((o) => (
          <option key={o.name} value={o.name}>
            {m.option(o.name, o.description)}
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
