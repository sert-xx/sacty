import { appliedProposalFor, openProposal, type StepKey, type Task } from "@sacty/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { DaemonError } from "@/components/daemon-error";
import { Implementation } from "@/components/implementation";
import { Proposals } from "@/components/proposals";
import { PullRequestCard } from "@/components/pull-request";
import { ResumeForm } from "@/components/resume-form";
import { CostMeter, StatusLabel, StepChips } from "@/components/task-bits";
import { TaskControls } from "@/components/task-controls";
import { TestViewpoints } from "@/components/test-viewpoints";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getCleanupPlan, getProject, getTask } from "@/lib/daemon";
import { describeEvent, formatStamp, isWorking, personAction, statusText } from "@/lib/labels";

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const m = (await getMessages()).task;
  return (
    <>
      <nav aria-label={m.breadcrumb} className="text-sm text-muted-foreground">
        <Link href="/" className="text-accent-foreground underline">
          {m.tasks}
        </Link>
      </nav>
      <Suspense fallback={<p className="text-sm text-muted-foreground">{m.loading}</p>}>
        <TaskDetail params={params} />
      </Suspense>
    </>
  );
}

async function TaskDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let found: Awaited<ReturnType<typeof getTask>>;
  try {
    found = await getTask(id);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  if (!found) notFound();
  const { task, ledger } = found;
  const projectName = (await getProject(task.projectId))?.project.name ?? task.projectId;
  const lastFailure = [...ledger].reverse().find((e) => e.type === "AgentRunFailed");
  const proposal = openProposal(task);
  const messages = await getMessages();
  const { task: m, labels, parts, locale } = messages;
  const action = personAction(task, labels);
  // 一時停止できるのは、sacty やエージェントが作業している（または作業を待っている）間。
  // ゴールガーディアンの変更の申し出の判定中は、すぐ終わるので止めない
  const canPause =
    (task.status === "queued" ||
      task.status === "running" ||
      (task.status === "idle" && task.verification !== undefined)) &&
    !(proposal && !proposal.judgement);

  return (
    <>
      <AutoRefresh active={isWorking(task)} />
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-balance">{task.title}</h1>
          <StatusLabel task={task} />
        </div>
        <p className="text-sm text-muted-foreground">
          {m.start}
          {labels.start[task.start]}
          {task.source && (
            <>
              {m.sourceOpen}
              <a
                href={task.source.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-accent-foreground underline"
              >
                {task.source.repo}#{task.source.number}
              </a>
              {m.sourceClose}
            </>
          )}
          {m.project}
          <Link href={`/projects/${task.projectId}`} className="text-accent-foreground underline">
            {projectName}
          </Link>
        </p>
        <CostMeter task={task} />
        {task.status !== "cancelled" && (
          <TaskControls
            taskId={task.id}
            title={task.title}
            canPause={canPause}
            plan={(await getCleanupPlan(task.id)) ?? []}
          />
        )}
      </div>

      {(task.status === "awaiting_approval" || task.status === "escalated") && (
        <section
          aria-labelledby="gate"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn-line bg-warn-soft p-5"
        >
          <div className="flex flex-col gap-1">
            <h2 id="gate" className="text-[15px] font-semibold text-warn">
              {proposal
                ? m.gate.undecidable
                : task.status === "escalated"
                  ? m.gate.tooMany
                  : statusText(task, labels)}
            </h2>
            <p className="text-sm">
              {proposal
                ? m.gate.undecidableHelp
                : task.status === "escalated"
                  ? m.gate.tooManyHelp
                  : m.gate.reviewHelp}
            </p>
          </div>
          <Link
            href={action.href}
            className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
          >
            {action.label}
          </Link>
        </section>
      )}

      {task.status === "cancelled" && task.cancelled && (
        <section
          aria-labelledby="cancelled"
          className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5 text-sm"
        >
          <h2 id="cancelled" className="text-[15px] font-semibold">
            {parts.control.cancelledTitle}
          </h2>
          <p className="text-muted-foreground">
            {parts.control.cancelledAt(formatStamp(task.cancelled.at, locale))}
          </p>
          <ul className="flex flex-col gap-1.5">
            {task.cancelled.cleanup.map((c) => (
              <li key={c.target} className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{labels.cleanupTarget[c.target]}</span>
                <span className={c.result === "failed" ? "text-warn" : "text-muted-foreground"}>
                  {labels.cleanupResult[c.result]}
                </span>
                {c.detail && (
                  <span className="font-mono text-xs break-all text-muted-foreground">
                    {labels.text(c.detail)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {task.status === "paused" && task.pausedReason && (
        <ResumeForm
          taskId={task.id}
          reason={task.pausedReason}
          usedUsd={task.budget.usedUsd}
          capUsd={task.budget.capUsd}
          lastFailure={(() => {
            const failure =
              task.pausedMessage ??
              (task.pausedReason !== "budget" && lastFailure?.type === "AgentRunFailed"
                ? lastFailure.payload.message
                : undefined);
            return failure === undefined ? undefined : labels.text(failure);
          })()}
        />
      )}

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-6">
          <section
            aria-labelledby="ticket"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="ticket" className="text-[15px] font-semibold">
              {m.ticket}
            </h2>
            {task.body ? (
              <p className="leading-7 whitespace-pre-wrap">{task.body}</p>
            ) : (
              <p className="text-sm text-muted-foreground">{m.ticketEmpty}</p>
            )}
          </section>
          <Deliverable task={task} step="requirements" />
          {(task.outputs.design ||
            task.steps.some((s) => s.key === "design" && s.state !== "todo")) && (
            <Deliverable task={task} step="design" />
          )}
          {(task.outputs.implement ||
            task.steps.some((s) => s.key === "implement" && s.state !== "todo")) && (
            <Implementation task={task} />
          )}
          <PullRequestCard task={task} />
          {(task.approved.requirements || task.proposals.length > 0) && <Proposals task={task} />}
          <section
            aria-labelledby="steps"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="steps" className="text-[15px] font-semibold">
              {m.steps}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">{m.stepsNote}</span>
            </h2>
            <StepChips task={task} />
          </section>
        </div>

        <section
          aria-labelledby="ledger"
          className="flex min-w-0 flex-[1_1_320px] flex-col gap-1 rounded-xl border border-border bg-card p-5"
        >
          <h2 id="ledger" className="pb-2 text-[15px] font-semibold">
            {m.ledger}{" "}
            <span className="text-[13px] font-normal text-muted-foreground">{m.ledgerNote}</span>
          </h2>
          <ol className="flex flex-col">
            {[...ledger].reverse().map((event) => (
              <li
                key={event.id}
                className="grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-t border-border py-2.5 text-[13px]"
              >
                <time
                  dateTime={event.at}
                  className="font-mono text-xs text-muted-foreground tabular-nums"
                >
                  {formatStamp(event.at, messages.locale)}
                </time>
                {/* パスやブランチ名など、区切りの無い長い文字列でも幅からはみ出さないようにする */}
                <span className="[overflow-wrap:anywhere]">{describeEvent(event, labels)}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}

/**
 * 工程の成果物。承認済みなら凍結した版を、そうでなければ工程エージェントの最新の下書きを出す。
 */
async function Deliverable({ task, step }: { task: Task; step: StepKey }) {
  const messages = await getMessages();
  const m = messages.task.deliverable;
  const approved = task.approved[step];
  const output = approved?.output ?? task.outputs[step];
  const viewpoints = approved?.testViewpoints ?? task.testViewpoints;
  // 前の工程に差し戻されて、まだ実行対象になっていない工程の下書き
  const stale = !approved && task.steps.find((s) => s.key === step)?.state === "todo";
  const fromProposal = approved ? undefined : appliedProposalFor(task, step);
  const running =
    task.status === "running" && task.steps.some((s) => s.key === step && s.state === "active");
  return (
    <section
      aria-labelledby={`deliverable-${step}`}
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id={`deliverable-${step}`} className="text-[15px] font-semibold">
        {messages.labels.step[step]}{" "}
        <span className="text-[13px] font-normal text-muted-foreground">
          {approved
            ? m.approved(approved.submission)
            : fromProposal
              ? m.fromProposal(fromProposal.id)
              : stale
                ? m.stale
                : m.draft}
        </span>
      </h2>
      {output ? (
        <pre className="font-sans text-sm leading-7 break-words whitespace-pre-wrap">{output}</pre>
      ) : (
        <p className="text-sm text-muted-foreground">{running ? m.running : m.notYet}</p>
      )}
      {step === "design" && output && (
        <>
          <h3 className="pt-2 text-sm font-semibold">
            {m.viewpoints}{" "}
            <span className="text-[13px] font-normal text-muted-foreground">
              {m.viewpointsNote(viewpoints.length)}
            </span>
          </h3>
          <TestViewpoints viewpoints={viewpoints} />
        </>
      )}
    </section>
  );
}
