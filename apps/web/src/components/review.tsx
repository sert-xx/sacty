"use client";

import {
  appliedProposalFor,
  changeRounds,
  deliveredWithoutChanges,
  gatePullRequest,
  MAX_CHANGE_REQUESTS,
  pullRequestConflict,
  reworkTargets,
  stepAgentChangeable,
  type Task,
  type TaskRemark,
} from "@sacty/core";
import { cn } from "cn";
import Link from "next/link";
import { voidRemarkAction } from "@/app/actions";
import { DaemonError } from "@/components/daemon-error";
import { GateForm } from "@/components/gate-form";
import { Implementation } from "@/components/implementation";
import { IntegrationResult } from "@/components/integration";
import {
  FollowProjectAfterRecovery,
  RefreshWhenMissing,
  StaleNotice,
} from "@/components/live-status";
import { Markdown } from "@/components/markdown";
import { ProvenanceNote } from "@/components/provenance";
import { PullRequestCard } from "@/components/pull-request";
import { ReproductionResult } from "@/components/reproduction";
import { SelfReviewNote } from "@/components/self-review";
import { TestViewpoints } from "@/components/test-viewpoints";
import { Hint } from "@/components/ui/hint";
import type { Messages } from "@/i18n";
import { useMessages } from "@/i18n/client";
import { useLiveData } from "@/lib/use-live-data";

/** レビューのデータを取り直す先（PBI-108）。 */
export function reviewLiveUrl(id: string): string {
  return `/live/tasks/${encodeURIComponent(id)}/review`;
}

/**
 * 成果物のレビュー（承認・差し戻し）の画面（PBI-108）。画面をリロードせず、一定の間隔でタスクだけを取り直し、変わった所
 * だけを反映する。書きかけのコメントや選んだ差し戻し先は消えない。ほかのタブ・CLI で承認・差し戻したら、承認待ちでなく
 * なったことを出す。initial が null（描いたときにデーモンに届かなかった）なら、届くまで error を出す。
 */
export function LiveReview({
  id,
  initial,
  initialVersion,
  error,
}: {
  id: string;
  initial: Task | null;
  initialVersion?: string;
  error?: string;
}) {
  const url = reviewLiveUrl(id);
  const { data: task, stale, missing } = useLiveData(() => url, initial, initialVersion);
  if (!task) return <DaemonError message={error ?? ""} />;
  return (
    <>
      <StaleNotice stale={stale} />
      <RefreshWhenMissing missing={missing} />
      {initial === null && <FollowProjectAfterRecovery projectId={task.projectId} />}
      <ReviewView task={task} />
    </>
  );
}

/** レビューの画面の中身（取り直したタスクから描く）。 */
export function ReviewView({ task }: { task: Task }) {
  const m = useMessages();
  const t = m.review;
  const stepLabel = m.labels.step;
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
  // 統合レビューのゲートでは、タスク分割への指摘を出す（ほかの工程は、その工程への指摘）
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
          / {t.approval}
        </nav>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-balance">
            {step === "reproduce" ? t.notReproduced : t.stepApproval(stepLabel[step])}
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
          {step === "implement" ? (
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
              {/* 提出の前のセルフレビュー（PBI-120） */}
              {task.outputs[step] && <SelfReviewNote task={task} step={step} />}
              {/* 項目ごとの出典の分類。人間が確かめる項目を先に出す */}
              {task.outputs[step] && <ProvenanceNote task={task} step={step} />}
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
                </span>{" "}
                <Hint text={t.viewpointsHint} />
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
                </span>{" "}
                <Hint text={t.frozenHint} />
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
            noChanges={step === "implement" && deliveredWithoutChanges(task)}
            steps={task.steps
              .filter((s) => s.state !== "skip")
              .map((s) => ({
                step: s.key,
                image: task.images?.[s.key] ?? "default",
                agentChangeable: stepAgentChangeable(s.key),
                ...(task.agents?.[s.key] ? { agent: task.agents[s.key] } : {}),
              }))}
            pullRequest={
              // 実装の PR と、要求要件・設計の PR（PBI-57・PBI-110）。PR のマージで承認する
              watched?.step === step
                ? {
                    number: watched.number,
                    ...(watched.url ? { url: watched.url } : {}),
                    closed: watched.state === "closed",
                    mergedOutdated: watched.state === "merged_outdated",
                    conflicting: pullRequestConflict(task) !== undefined,
                    conflictingContinued: task.continuedPullRequest !== undefined,
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
        <form action={voidRemarkAction} className="col-start-2 flex items-center gap-1">
          <input type="hidden" name="taskId" value={taskId} />
          <input type="hidden" name="remarkId" value={remark.id} />
          <button
            type="submit"
            className="min-h-8 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            {t.void}
          </button>
          <Hint text={t.voidHint} className="size-4" />
        </form>
      )}
    </li>
  );
}
