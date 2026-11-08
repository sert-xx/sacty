"use client";

import { useActionState } from "react";
import { type ChangeTaskImageState, changeTaskImageAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { useMessages } from "@/i18n/client";
import { useSelectValue } from "@/lib/use-select-value";

const initial: ChangeTaskImageState = {};

/**
 * タスクのイメージを変えるフォーム（PBI-318。PBI-106 の工程のイメージのフォームから）。選べるのは images の名前と既定の
 * イメージ。今のイメージが images から消えていた・古い版の工程ごとのイメージ（current が無い）なら、選択肢には出さない
 * （選び直してもらう）。説明が長いと選択肢も長くなるので、選択肢は名前だけにして、選んだイメージの説明は下に折り返して出す。
 */
export function TaskImageForm({
  taskId,
  current,
  options,
}: {
  taskId: string;
  current?: string;
  options: { name: string; description: string }[];
}) {
  const messages = useMessages();
  const m = messages.task.images;
  const [state, formAction, pending] = useActionState(changeTaskImageAction, initial);
  const id = "task-image-select";
  const known = current !== undefined && options.some((o) => o.name === current);
  const initialImage = known ? current : "";
  // 選択肢は非制御のまま（自動の更新で、選んでいる途中の値を消さない。PBI-108）。説明だけ、実際の選択を追って出す
  const [selected, selectRef] = useSelectValue(initialImage);
  const description = options.find((o) => o.name === selected)?.description;
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <label htmlFor={id} className="sr-only">
        {m.label}
      </label>
      <select
        id={id}
        name="image"
        ref={selectRef}
        defaultValue={initialImage}
        aria-describedby={description ? `${id}-description` : undefined}
        required
        data-testid={id}
        className="h-9 max-w-full min-w-0 rounded-md border border-border bg-card px-2 font-mono text-sm"
      >
        {!known && (
          <option value="" disabled>
            {current ?? m.perStep}
          </option>
        )}
        {options.map((o) => (
          <option key={o.name} value={o.name} title={o.description}>
            {o.name}
          </option>
        ))}
      </select>
      <Button type="submit" variant="outline" disabled={pending} className="min-h-9">
        {pending ? m.changing : m.change}
      </Button>
      {description && (
        <p
          id={`${id}-description`}
          className="w-full text-xs leading-5 wrap-anywhere text-muted-foreground"
        >
          {description}
        </p>
      )}
      {state.message && (
        <p role="alert" className="w-full text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}
