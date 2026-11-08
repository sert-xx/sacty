"use client";

import { TASK_TITLE_MAX } from "@sacty/core";
import { PencilIcon } from "lucide-react";
import { useActionState, useState } from "react";
import { type RenameTaskState, renameTaskAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessages } from "@/i18n/client";

const initial: RenameTaskState = {};

/**
 * タスクの詳細の題と、題を変える操作（PBI-323）。中止したタスク（editable が false）のほかは、状態を問わず変えられる。
 * 入力は開いたときの題から始め、開いている間は、ほかの所で題が変わっても（トリアージ・別の画面）入力した題を消さない。
 * フォームは閉じると外れるので、開き直すと作り直され、前に開いたときの断られた理由を残さない。変えられたら入力を閉じる。空・長すぎる題・同じ題は、
 * デーモンが理由を示して断る。
 */
export function TaskTitle({
  taskId,
  title,
  editable,
}: {
  taskId: string;
  title: string;
  editable: boolean;
}) {
  const m = useMessages().task.rename;
  const [editing, setEditing] = useState<string | undefined>(undefined);
  if (editing === undefined || !editable) {
    // 題・状態の並び（見出しの親）は変えないよう、包まずに出す
    return (
      <>
        <h1 className="text-xl font-bold text-balance [overflow-wrap:anywhere]">{title}</h1>
        {editable && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={m.edit}
            title={m.edit}
            data-testid="task-title-edit"
            onClick={() => {
              setEditing(title);
            }}
          >
            <PencilIcon aria-hidden />
          </Button>
        )}
      </>
    );
  }
  return (
    <TaskTitleForm
      taskId={taskId}
      title={title}
      start={editing}
      onClose={() => setEditing(undefined)}
    />
  );
}

function TaskTitleForm({
  taskId,
  title,
  start,
  onClose,
}: {
  taskId: string;
  title: string;
  start: string;
  onClose: () => void;
}) {
  const m = useMessages().task.rename;
  // 入力は制御したまま持つ（断られたときも、自動の更新でも、入力した題を消さない）
  const [value, setValue] = useState(start);
  const [state, formAction, pending] = useActionState(
    async (prev: RenameTaskState, formData: FormData) => {
      const result = await renameTaskAction(prev, formData);
      if (!result.message) onClose();
      return result;
    },
    initial,
  );
  const id = "task-title-input";
  return (
    <form
      action={formAction}
      className="flex w-full min-w-0 flex-col gap-1"
      data-testid="task-title-form"
    >
      <input type="hidden" name="taskId" value={taskId} />
      <h1 className="sr-only">{title}</h1>
      <label htmlFor={id} className="sr-only">
        {m.label}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={id}
          name="title"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
          }}
          maxLength={TASK_TITLE_MAX}
          required
          autoFocus
          aria-describedby={`${id}-hint`}
          className="h-9 min-w-0 flex-1 basis-64 text-base font-bold"
        />
        <Button type="submit" disabled={pending} className="min-h-9">
          {pending ? m.saving : m.save}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          className="min-h-9"
          onClick={onClose}
        >
          {m.cancel}
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {m.hint}
      </p>
      {state.message && (
        <p role="alert" className="text-sm text-warn">
          {state.message}
        </p>
      )}
    </form>
  );
}
