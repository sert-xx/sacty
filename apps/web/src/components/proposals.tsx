"use client";

import { proposalAccepted, type Task, type TaskProposal } from "@sacty/core";
import { cn } from "cn";
import { ChangeDecisionForm } from "@/components/change-decision-form";
import { Markdown } from "@/components/markdown";
import { TestViewpoints } from "@/components/test-viewpoints";
import type { Messages } from "@/i18n";
import { useMessages } from "@/i18n/client";
import { formatStamp } from "@/lib/labels";

function outcome(
  p: TaskProposal,
  m: Messages["parts"]["proposals"],
): { text: string; tone: "ok" | "no" | "wait" } {
  if (!p.judgement) return { text: m.judging, tone: "wait" };
  const accepted = proposalAccepted(p);
  if (accepted === undefined) return { text: m.awaitingPerson, tone: "wait" };
  if (!accepted) return { text: m.notApplied, tone: "no" };
  if (!p.applied) return { text: m.awaitingApply, tone: "wait" };
  return p.target === "requirements"
    ? { text: m.appliedRequirements, tone: "ok" }
    : { text: m.applied, tone: "ok" };
}

const TONE = {
  ok: "border-accent-line bg-accent text-accent-foreground",
  no: "border-input text-muted-foreground",
  wait: "border-warn-line bg-warn-soft text-warn",
} as const;

/** タスク詳細の「変更の申し出と判定」。 */
export function Proposals({ task }: { task: Task }) {
  const messages = useMessages();
  const m = messages.parts.proposals;
  return (
    <section
      aria-labelledby="proposals"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="proposals" className="text-[15px] font-semibold">
        {m.title} <span className="text-[13px] font-normal text-muted-foreground">{m.note}</span>
      </h2>
      {task.proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.empty}</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {[...task.proposals].reverse().map((p) => (
            <ProposalItem key={p.id} task={task} proposal={p} messages={messages} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ProposalItem({
  task,
  proposal: p,
  messages,
}: {
  task: Task;
  proposal: TaskProposal;
  messages: Messages;
}) {
  const m = messages.parts.proposals;
  const step = messages.labels.step;
  const result = outcome(p, m);
  const waiting =
    task.status === "escalated" && p.judgement?.verdict === "undecidable" && !p.decision;
  return (
    <li
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border p-3.5 text-sm leading-6",
        waiting ? "border-2 border-warn-line" : "border-border",
      )}
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-muted-foreground">{p.id}</span>
        <span className="font-medium">{m.heading(step[p.fromStep], step[p.target])}</span>
        <span className={cn("rounded-full border px-2 py-0.5 text-xs", TONE[result.tone])}>
          {result.text}
        </span>
        <time dateTime={p.proposedAt} className="text-xs text-muted-foreground tabular-nums">
          {formatStamp(p.proposedAt, messages.locale)}
        </time>
      </p>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="pt-0.5 text-xs text-muted-foreground">{m.reason}</dt>
        <dd className="break-words">{p.reason}</dd>
        <dt className="pt-0.5 text-xs text-muted-foreground">{m.facts}</dt>
        <dd>
          {p.facts.length > 0 ? (
            <ul className="list-disc pl-5">
              {p.facts.map((f) => (
                <li key={f} className="break-words">
                  {f}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">{m.none}</span>
          )}
        </dd>
        <dt className="pt-0.5 text-xs text-muted-foreground">{m.judgement}</dt>
        <dd className="break-words">
          {p.judgement ? (
            <>
              <span className="font-medium">{messages.labels.verdict[p.judgement.verdict]}</span>：
              {messages.labels.text(p.judgement.reason)}
              <span className="ml-1 text-xs text-muted-foreground">{m.byGuardian}</span>
            </>
          ) : (
            <span className="text-muted-foreground">{m.judgingShort}</span>
          )}
        </dd>
        {p.decision && (
          <>
            <dt className="pt-0.5 text-xs text-muted-foreground">{m.decision}</dt>
            <dd>{p.decision.accept ? m.accepted : m.rejected}</dd>
          </>
        )}
      </dl>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {m.showProposed(step[p.target])}
        </summary>
        <Markdown className="mt-2 rounded-lg border border-border bg-muted px-4 py-3">
          {p.proposed}
        </Markdown>
        {p.testViewpoints && (
          <div className="mt-2">
            <TestViewpoints viewpoints={p.testViewpoints} />
          </div>
        )}
      </details>
      {waiting && (
        <ChangeDecisionForm
          taskId={task.id}
          proposalId={p.id}
          requirements={p.target === "requirements"}
        />
      )}
    </li>
  );
}
