"use client";

import { humanAsks, type Task } from "@sacty/core";
import { useMessages } from "@/i18n/client";
import { summarizeDecision } from "@/lib/decision-summary";

/**
 * 人に確かめてほしいこと（PBI-301）を、承認の画面とタスクの詳細の目立つ所に出す。
 * - 戻し先の判断で、PR の指摘の意図を読み取れなかった理由（実装は読み取れた範囲で直している）
 * - 実行が指摘への対応と一緒に挙げた、聞き返し・推測で決めたこと（`confirm`）
 * 同じ内容は PR のコメントにも書く（PR を見ている人が気づけるように）。判断の理由は長いので、要点を先に出し、全文は開いて読む。
 */
export function HumanAskNotice({ task }: { task: Task }) {
  const { task: m, labels } = useMessages();
  const { text } = labels;
  const asks = humanAsks(task);
  const count = (asks.undecided ? 1 : 0) + asks.confirms.length;
  if (count === 0) return null;
  const reason = asks.undecided ? summarizeDecision(text(asks.undecided.reason)) : undefined;
  return (
    <section
      aria-labelledby="human-ask"
      data-testid="human-ask"
      className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-soft px-5 py-4"
    >
      <h2 id="human-ask" className="text-[15px] font-semibold text-warn">
        {m.humanAsk.title(count)}
      </h2>
      <p className="text-sm">{m.humanAsk.help}</p>
      <ul className="flex flex-col gap-2 text-sm leading-6">
        {asks.undecided && reason && (
          <li data-testid="human-ask-undecided" className="flex flex-col [overflow-wrap:anywhere]">
            <span className="font-medium">
              {m.humanAsk.undecided(asks.undecided.remarkIds.join("・"))}
            </span>
            <span>{reason.summary}</span>
            {reason.full && (
              <details>
                <summary className="w-fit cursor-pointer text-xs text-accent-foreground underline">
                  {labels.event.more}
                </summary>
                <span className="block whitespace-pre-line pt-1 text-xs text-muted-foreground">
                  {reason.full}
                </span>
              </details>
            )}
            <span className="text-xs text-muted-foreground">{m.humanAsk.undecidedHelp}</span>
          </li>
        )}
        {asks.confirms.map((c) => (
          <li
            key={c.remarkId}
            data-testid="human-ask-confirm"
            className="flex flex-col [overflow-wrap:anywhere]"
          >
            <span className="font-medium">{m.humanAsk.confirm(c.remarkId)}</span>
            <span className="whitespace-pre-line">{c.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
