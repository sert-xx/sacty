"use client";

import { QUESTION_MAX } from "@sacty/core";
import { useActionState } from "react";
import { askQuestionAction, type QuestionState } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useMessages } from "@/i18n/client";

const initial: QuestionState = {};

/**
 * オーケストレーターへの質問の入力（PBI-54）。質問できないとき（予算の上限・中止・答えを待っている）は、
 * 理由を出して送れなくする。送れなかったときは、書いた質問を残す。
 */
export function QuestionForm({ taskId, blocked }: { taskId: string; blocked?: string }) {
  const m = useMessages().task.chat;
  const [state, action, pending] = useActionState(askQuestionAction, initial);
  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="taskId" value={taskId} />
      <Label htmlFor="question">{m.label}</Label>
      <Textarea
        id="question"
        name="text"
        required
        maxLength={QUESTION_MAX}
        placeholder={m.placeholder}
        // 送れなかったときは、書いた質問を残す（送れたら空に戻す）
        key={state.text === undefined ? "sent" : `kept-${state.text}`}
        defaultValue={state.text ?? ""}
        disabled={blocked !== undefined || pending}
        aria-describedby="question-help"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={blocked !== undefined || pending} className="min-h-10">
          {pending ? m.sending : m.send}
        </Button>
        <span
          id="question-help"
          className={blocked ? "text-sm text-warn" : "text-sm text-muted-foreground"}
        >
          {blocked ?? m.help}
        </span>
      </div>
      {state.message && (
        <p role="alert" className="text-sm text-warn whitespace-pre-wrap">
          {state.message}
        </p>
      )}
    </form>
  );
}
