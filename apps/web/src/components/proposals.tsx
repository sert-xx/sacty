import { proposalAccepted, type Task, type TaskProposal } from "@sacty/core";
import { cn } from "cn";
import { ChangeDecisionForm } from "@/components/change-decision-form";
import { TestViewpoints } from "@/components/test-viewpoints";
import { formatStamp, STEP_LABEL, VERDICT_LABEL } from "@/lib/labels";

function outcome(p: TaskProposal): { text: string; tone: "ok" | "no" | "wait" } {
  if (!p.judgement) return { text: "ゴールガーディアンが判定中", tone: "wait" };
  const accepted = proposalAccepted(p);
  if (accepted === undefined) return { text: "人間の判断待ち", tone: "wait" };
  if (!accepted) return { text: "反映しない", tone: "no" };
  if (!p.applied) return { text: "反映待ち", tone: "wait" };
  return p.target === "requirements"
    ? { text: "反映済み（要求要件は人間の再承認へ）", tone: "ok" }
    : { text: "反映済み", tone: "ok" };
}

const TONE = {
  ok: "border-accent-line bg-accent text-accent-foreground",
  no: "border-input text-muted-foreground",
  wait: "border-warn-line bg-warn-soft text-warn",
} as const;

/** タスク詳細の「変更の申し出と判定」。 */
export function Proposals({ task }: { task: Task }) {
  return (
    <section
      aria-labelledby="proposals"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="proposals" className="text-[15px] font-semibold">
        変更の申し出と判定{" "}
        <span className="text-[13px] font-normal text-muted-foreground">
          承認済みの成果物を変えるには、ゴールガーディアンの判定が必要です
        </span>
      </h2>
      {task.proposals.length === 0 ? (
        <p className="text-sm text-muted-foreground">変更の申し出はありません。</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {[...task.proposals].reverse().map((p) => (
            <ProposalItem key={p.id} task={task} proposal={p} />
          ))}
        </ol>
      )}
    </section>
  );
}

function ProposalItem({ task, proposal: p }: { task: Task; proposal: TaskProposal }) {
  const result = outcome(p);
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
        <span className="font-medium">
          {STEP_LABEL[p.fromStep]}の工程から、{STEP_LABEL[p.target]}の変更
        </span>
        <span className={cn("rounded-full border px-2 py-0.5 text-xs", TONE[result.tone])}>
          {result.text}
        </span>
        <time dateTime={p.proposedAt} className="text-xs text-muted-foreground tabular-nums">
          {formatStamp(p.proposedAt)}
        </time>
      </p>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1.5">
        <dt className="pt-0.5 text-xs text-muted-foreground">理由</dt>
        <dd className="break-words">{p.reason}</dd>
        <dt className="pt-0.5 text-xs text-muted-foreground">根拠の事実</dt>
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
            <span className="text-muted-foreground">（なし）</span>
          )}
        </dd>
        <dt className="pt-0.5 text-xs text-muted-foreground">判定</dt>
        <dd className="break-words">
          {p.judgement ? (
            <>
              <span className="font-medium">{VERDICT_LABEL[p.judgement.verdict]}</span>：
              {p.judgement.reason}
              <span className="ml-1 text-xs text-muted-foreground">（ゴールガーディアン）</span>
            </>
          ) : (
            <span className="text-muted-foreground">判定中…</span>
          )}
        </dd>
        {p.decision && (
          <>
            <dt className="pt-0.5 text-xs text-muted-foreground">人間の判断</dt>
            <dd>{p.decision.accept ? "変更を認めた" : "認めなかった"}</dd>
          </>
        )}
      </dl>
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">
          変更後の{STEP_LABEL[p.target]}を見る
        </summary>
        <pre className="mt-2 rounded-lg border border-border bg-muted px-4 py-3 font-sans text-sm leading-7 break-words whitespace-pre-wrap">
          {p.proposed}
        </pre>
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
