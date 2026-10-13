import {
  appliedProposalFor,
  changeRounds,
  gatePullRequest,
  MAX_CHANGE_REQUESTS,
  reworkTargets,
  type TaskRemark,
} from "@sacty/core";
import { cn } from "cn";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { voidRemarkAction } from "@/app/actions";
import { DaemonError } from "@/components/daemon-error";
import { GateForm } from "@/components/gate-form";
import { Implementation } from "@/components/implementation";
import { IntegrationResult } from "@/components/integration";
import { Markdown } from "@/components/markdown";
import { PullRequestCard } from "@/components/pull-request";
import { ReproductionResult } from "@/components/reproduction";
import { TestViewpoints } from "@/components/test-viewpoints";
import type { Messages } from "@/i18n";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getTask } from "@/lib/daemon";

export default async function ReviewPage({ params }: { params: Promise<{ id: string }> }) {
  const m = await getMessages();
  return (
    <Suspense fallback={<p className="text-sm text-muted-foreground">{m.review.loading}</p>}>
      <Review params={params} />
    </Suspense>
  );
}

async function Review({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const m = await getMessages();
  const t = m.review;
  const stepLabel = m.labels.step;
  let found: Awaited<ReturnType<typeof getTask>>;
  try {
    found = await getTask(id);
  } catch (error) {
    if (error instanceof DaemonUnavailableError) return <DaemonError message={error.message} />;
    throw error;
  }
  if (!found) notFound();
  const { task } = found;
  const step = task.gate?.step ?? task.escalation?.step;

  if (!step) {
    return (
      <div className="flex flex-col gap-3">
        <h1 className="text-2xl font-bold">{task.title}</h1>
        <p className="text-sm text-muted-foreground">{t.notAwaiting}</p>
        <Link href={`/tasks/${task.id}`} className="text-sm text-accent-foreground underline">
          {t.backToTask}
        </Link>
      </div>
    );
  }

  const rounds = changeRounds(task, reworkTargets(task, step)[0] ?? step);
  const latestRound = rounds;
  // 差し戻し先：この工程か、それより前の工程エージェントが作る工程（ゲートに近い順）
  const targets = reworkTargets(task, step);
  // 成果物チェック（PR作成）のゲートでは、実装への指摘を出す
  const remarkStep = targets[0] ?? step;
  const remarks = task.remarks
    .filter((r) => r.step === remarkStep)
    .sort((a, b) => b.round - a.round || a.id.localeCompare(b.id));
  const submission = task.gate?.submission ?? task.submissions[step] ?? 1;
  const fromProposal = appliedProposalFor(task, step);
  const frozenRequirements = step !== "requirements" ? task.approved.requirements : undefined;
  const watched = gatePullRequest(task);

  return (
    <>
      <div className="flex flex-col gap-2">
        <nav aria-label={t.breadcrumb} className="text-sm text-muted-foreground">
          <Link href={`/tasks/${task.id}`} className="text-accent-foreground underline">
            {task.title}
          </Link>{" "}
          / {t.deliverableReview}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-balance">
            {step === "pr"
              ? t.deliverableReview
              : step === "reproduce"
                ? t.notReproduced
                : t.stepApproval(stepLabel[step])}
          </h1>
          <span className="rounded-full border border-back-line bg-back-soft px-2.5 py-0.5 text-xs font-semibold text-back">
            {t.submission(submission)}
            {rounds > 0 ? t.rounds(rounds) : ""}
          </span>
          {task.status === "escalated" && (
            <span className="rounded-full border border-warn-line bg-warn-soft px-2.5 py-0.5 text-xs font-semibold text-warn">
              {t.escalated}
            </span>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-start gap-6">
        <div className="flex min-w-0 flex-[999_1_520px] flex-col gap-6">
          {fromProposal && (
            <section
              aria-labelledby="from-proposal"
              className="flex flex-col gap-2 rounded-xl border border-warn-line bg-warn-soft p-5 text-sm leading-6"
            >
              <h2 id="from-proposal" className="text-[15px] font-semibold text-warn">
                {t.fromProposalTitle(fromProposal.id)}
              </h2>
              <p>
                {t.fromProposalBody(
                  stepLabel[fromProposal.fromStep],
                  Boolean(fromProposal.decision),
                  stepLabel[step],
                )}
              </p>
              <p>{t.reason(fromProposal.reason)}</p>
              {fromProposal.facts.length > 0 && (
                <ul className="list-disc pl-5">
                  {fromProposal.facts.map((f) => (
                    <li key={f}>{f}</li>
                  ))}
                </ul>
              )}
            </section>
          )}
          {remarks.length > 0 && (
            <section
              aria-labelledby="history"
              className="flex flex-col gap-3 rounded-xl border border-back-line bg-card p-5"
            >
              <h2 id="history" className="text-[15px] font-semibold">
                {t.history}
              </h2>
              <ol className="flex flex-col gap-2.5">
                {remarks.map((remark) => (
                  <RemarkItem
                    key={remark.id}
                    remark={remark}
                    taskId={task.id}
                    submission={submission}
                    current={remark.round === latestRound}
                    t={t.remark}
                  />
                ))}
              </ol>
            </section>
          )}
          {step === "pr" ? (
            <>
              <PullRequestCard task={task} />
              <Implementation task={task} />
            </>
          ) : step === "integrate" ? (
            // 統合レビュー（PBI-31）は、ゴールガーディアンの判定と説明を成果物として出す
            <IntegrationResult task={task} />
          ) : (
            <section
              aria-labelledby="deliverable"
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
            >
              <h2 id="deliverable" className="text-[15px] font-semibold">
                {t.deliverable}{" "}
                <span className="text-[13px] font-normal text-muted-foreground">
                  {stepLabel[step]}
                </span>
              </h2>
              {task.outputs[step] ? (
                <Markdown className="rounded-lg border border-border bg-muted px-5 py-4">
                  {task.outputs[step]}
                </Markdown>
              ) : (
                <p className="text-sm text-muted-foreground">{t.noOutput}</p>
              )}
            </section>
          )}
          {step === "reproduce" && <ReproductionResult task={task} />}
          {/* 要求要件・設計の PR と、PR の指摘の戻し先の判断（PBI-57） */}
          {(step === "requirements" || step === "design") && watched && (
            <PullRequestCard task={task} />
          )}
          {step === "design" && (
            <section
              aria-labelledby="viewpoints"
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
            >
              <h2 id="viewpoints" className="text-[15px] font-semibold">
                {t.viewpoints}{" "}
                <span className="text-[13px] font-normal text-muted-foreground">
                  {t.viewpointsNote(task.testViewpoints.length)}
                </span>
              </h2>
              <TestViewpoints viewpoints={task.testViewpoints} />
            </section>
          )}
          {frozenRequirements && (
            <details className="group rounded-xl border border-border bg-card p-5">
              <summary className="cursor-pointer text-[15px] font-semibold">
                {t.frozenRequirements}{" "}
                <span className="text-[13px] font-normal text-muted-foreground">
                  {t.frozenNote(frozenRequirements.submission)}
                </span>
              </summary>
              <Markdown className="mt-3 rounded-lg border border-border bg-muted px-5 py-4">
                {frozenRequirements.output}
              </Markdown>
            </details>
          )}
        </div>

        <section
          aria-labelledby="decision"
          className="flex min-w-0 flex-[1_1_340px] flex-col gap-3 rounded-xl border border-border bg-card p-5"
        >
          <h2 id="decision" className="text-[15px] font-semibold">
            {t.decision}
          </h2>
          <GateForm
            taskId={task.id}
            step={step}
            submission={submission}
            targets={targets}
            defaultTarget={task.escalation?.target ?? targets[0] ?? step}
            escalated={task.status === "escalated"}
            maxChanges={MAX_CHANGE_REQUESTS}
            pendingComments={task.escalation?.pendingRemarks.map((r) => r.text) ?? []}
            notReproduced={step === "reproduce"}
            pullRequest={
              // 成果物チェックの PR と、要求要件・設計の PR（PBI-57）。PR のマージで承認する
              watched?.step === step
                ? {
                    number: watched.number,
                    ...(watched.url ? { url: watched.url } : {}),
                    closed: watched.state === "closed",
                    mergedOutdated: watched.state === "merged_outdated",
                  }
                : undefined
            }
            rework={
              task.status === "escalated" && task.escalation?.reason === "rework_confirmation"
                ? {
                    target: task.escalation.target,
                    note: m.labels.text(task.escalation.note ?? ""),
                  }
                : undefined
            }
          />
        </section>
      </div>
    </>
  );
}

function RemarkItem({
  remark,
  taskId,
  submission,
  current,
  t,
}: {
  remark: TaskRemark;
  taskId: string;
  submission: number;
  current: boolean;
  t: Messages["review"]["remark"];
}) {
  return (
    <li
      className={cn(
        "grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-1.5 rounded-lg border p-3.5 text-sm leading-6",
        current ? "border-2 border-back-line" : "border-border",
        remark.voided && "opacity-60",
      )}
    >
      <span className="pt-0.5 text-xs text-muted-foreground">{t.label}</span>
      <span className="flex flex-wrap items-center gap-2">
        <span className={cn(remark.voided && "line-through")}>{remark.text}</span>
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-xs",
            current
              ? "border-back-line bg-back-soft font-semibold text-back"
              : "border-input text-muted-foreground",
          )}
        >
          {t.round(remark.round, current)}
        </span>
        {remark.voided && (
          <span className="rounded-full border border-input px-2 py-0.5 text-xs text-muted-foreground">
            {t.voided}
          </span>
        )}
        <span className="font-mono text-xs text-muted-foreground">{remark.id}</span>
      </span>
      <span className="pt-0.5 text-xs text-muted-foreground">{t.response}</span>
      <span className={cn(!remark.response && "text-muted-foreground")}>
        {remark.voided
          ? t.voidedNote
          : remark.response
            ? remark.response
            : t.noResponse(submission)}
        {remark.response && remark.respondedIn && !remark.voided && (
          <span className="ml-2 text-xs text-muted-foreground">
            {t.respondedIn(remark.respondedIn)}
          </span>
        )}
      </span>
      {!remark.voided && (
        <form action={voidRemarkAction} className="col-start-2">
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="remarkId" value={remark.id} />
          <button
            type="submit"
            className="min-h-8 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {t.void}
          </button>
        </form>
      )}
    </li>
  );
}
