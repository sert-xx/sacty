"use client";

import { pendingQuestion, questionBlocked, type Task } from "@sacty/core";
import { ChatPanel } from "@/components/chat-panel";
import { Markdown } from "@/components/markdown";
import { QuestionForm } from "@/components/question-form";
import { useMessages } from "@/i18n/client";
import { formatStamp } from "@/lib/labels";

/**
 * オーケストレーターへの質問と答え（PBI-54）。質問と答えはタスクごとに残り、開き直しても読める。
 * 画面の右の AI のアイコンから開くサイドパネルに出す（PBI-61）。
 * 答えを待っている間は、画面の自動の更新で答えを出す。質問できないときは、理由を出す。
 */
export function TaskChat({ task }: { task: Task }) {
  const messages = useMessages();
  const { labels, locale } = messages;
  const m = messages.task.chat;
  const blocked = questionBlocked(task);
  return (
    <ChatPanel
      pending={pendingQuestion(task) !== undefined}
      count={task.questions.length}
      form={
        <QuestionForm taskId={task.id} {...(blocked ? { blocked: labels.text(blocked) } : {})} />
      }
    >
      {task.questions.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.empty}</p>
      ) : (
        <ol className="flex flex-col">
          {task.questions.map((q) => (
            <li
              key={q.id}
              className="flex flex-col gap-2 border-t border-border py-3 text-sm first:border-t-0 first:pt-0"
            >
              <div className="flex flex-col gap-1">
                <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span>{m.question}</span>
                  <span className="font-mono">{q.id}</span>
                  <time dateTime={q.askedAt} className="font-mono tabular-nums">
                    {formatStamp(q.askedAt, locale)}
                  </time>
                </p>
                <p className="leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]">{q.text}</p>
              </div>
              <div className="flex min-w-0 flex-col gap-1 rounded-lg border border-border bg-muted/40 p-3">
                <p className="flex flex-wrap gap-x-2 text-xs text-muted-foreground">
                  <span>{m.answer}</span>
                  {q.answer && (
                    <time dateTime={q.answer.at} className="font-mono tabular-nums">
                      {formatStamp(q.answer.at, locale)}
                    </time>
                  )}
                </p>
                {!q.answer ? (
                  <p className="text-muted-foreground">{m.answering}</p>
                ) : q.answer.text !== undefined ? (
                  <Markdown>{q.answer.text}</Markdown>
                ) : (
                  <p className="text-warn [overflow-wrap:anywhere]">
                    {m.failed(q.answer.failed === undefined ? "" : labels.text(q.answer.failed))}
                  </p>
                )}
              </div>
            </li>
          ))}
        </ol>
      )}
    </ChatPanel>
  );
}
