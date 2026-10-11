import { appliedProposalFor, openProposal, type StepKey, type Task } from "@sacty/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { CardSection } from "@/components/card-section";
import { DaemonError } from "@/components/daemon-error";
import { Implementation } from "@/components/implementation";
import { Markdown } from "@/components/markdown";
import { Proposals } from "@/components/proposals";
import { PullRequestCard } from "@/components/pull-request";
import { ResumeForm } from "@/components/resume-form";
import { CostMeter, StatusLabel, StepChips } from "@/components/task-bits";
import { TaskControls } from "@/components/task-controls";
import { TestViewpoints } from "@/components/test-viewpoints";
import { getMessages } from "@/i18n/server";
import { DaemonUnavailableError, getCleanupPlan, getProject, getTask } from "@/lib/daemon";
import {
  canControl,
  describeEvent,
  formatStamp,
  isWorking,
  personAction,
  statusText,
} from "@/lib/labels";

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
  const { task, activity } = found;
  const projectName = (await getProject(task.projectId))?.project.name ?? task.projectId;
  const lastFailure = [...activity].reverse().find((e) => e.type === "AgentRunFailed");
  const proposal = openProposal(task);
  const messages = await getMessages();
  const { task: m, labels, parts, locale } = messages;
  const action = personAction(task, labels);
  // PR の指摘の戻し先の確認（PBI-14b）
  const rework =
    task.status === "escalated" && task.escalation?.reason === "rework_confirmation"
      ? task.escalation
      : undefined;
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
        {canControl(task) && (
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
                : rework
                  ? m.gate.rework
                  : task.status === "escalated"
                    ? m.gate.tooMany
                    : statusText(task, labels)}
            </h2>
            <p className="text-sm">
              {proposal
                ? m.gate.undecidableHelp
                : rework
                  ? m.gate.reworkHelp(labels.step[rework.target], labels.text(rework.note ?? ""))
                  : task.status === "escalated"
                    ? m.gate.tooManyHelp
                    : task.gate?.step === "pr" && task.pullRequestState === "closed"
                      ? m.gate.prClosedHelp
                      : task.gate?.step === "pr" && task.pullRequestState === "merged_outdated"
                        ? m.gate.prMergedOutdatedHelp
                        : task.gate?.step === "pr" && task.pullRequestState === "open"
                          ? m.gate.prHelp
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
          {/* どこまで進んだかを先に見られるよう、工程はタスクの内容より上に置く */}
          <section
            aria-labelledby="steps"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="steps" className="text-[15px] font-semibold">
              {m.steps}{" "}
              <span className="text-[13px] font-normal text-muted-foreground">{m.stepsNote}</span>
            </h2>
            <StepChips task={task} />
            {task.stepsChoice && (
              <p className="text-sm leading-6 text-muted-foreground">
                {task.stepsChoice.fallback
                  ? labels.text(task.stepsChoice.reason)
                  : m.stepsReason(labels.text(task.stepsChoice.reason))}
              </p>
            )}
          </section>
          <section
            aria-labelledby="content"
            className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
          >
            <h2 id="content" className="text-[15px] font-semibold">
              {m.content}
            </h2>
            {task.body ? (
              <Markdown>{task.body}</Markdown>
            ) : (
              <p className="text-sm text-muted-foreground">{m.contentEmpty}</p>
            )}
          </section>
          {/* 調査の結果（PBI-18）。要求要件は、その工程があるタスクだけ */}
          {task.steps.some((s) => s.key === "investigate") && (
            <Deliverable task={task} step="investigate" />
          )}
          {/* レビューの結果（PBI-19）。人間の承認は無く、そのまま PR に投稿する */}
          {task.steps.some((s) => s.key === "review") && <Deliverable task={task} step="review" />}
          {task.steps.some((s) => s.key === "requirements") && (
            <Deliverable task={task} step="requirements" />
          )}
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
        </div>

        <section
          aria-labelledby="activity"
          className="flex min-w-0 flex-[1_1_320px] flex-col gap-1 rounded-xl border border-border bg-card p-5"
        >
          <h2 id="activity" className="pb-2 text-[15px] font-semibold">
            {m.activity}{" "}
            <span className="text-[13px] font-normal text-muted-foreground">{m.activityNote}</span>
          </h2>
          <ol className="flex flex-col">
            {[...activity].reverse().map((event) => (
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
    <CardSection
      id={`deliverable-${step}`}
      title={messages.labels.step[step]}
      note={
        approved
          ? m.approved(approved.submission)
          : step === "review" && task.reviewPost
            ? m.reviewPosted
            : fromProposal
              ? m.fromProposal(fromProposal.id)
              : stale
                ? m.stale
                : m.draft
      }
      // 承認済みの成果物は折りたたむ（承認待ち・作業中のものは開いたまま）
      collapsed={Boolean(approved)}
    >
      {output ? (
        <Markdown>{output}</Markdown>
      ) : // 行へのコメントだけのレビューは本文が空（書き終えている）
      step === "review" && output === "" ? null : (
        <p className="text-sm text-muted-foreground">{running ? m.running : m.notYet}</p>
      )}
      {step === "review" && task.reviewComments.length > 0 && (
        <>
          <h3 className="pt-2 text-sm font-semibold">
            {m.reviewComments(task.reviewComments.length)}
          </h3>
          <ul className="flex flex-col gap-2">
            {task.reviewComments.map((c) => (
              <li
                // 同じ行に複数のコメントがありうるので、本文も含める
                key={`${c.path}:${c.line}:${c.body}`}
                className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm"
              >
                <code className="font-mono text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {c.path}:{c.line}
                </code>
                <Markdown>{c.body}</Markdown>
              </li>
            ))}
          </ul>
        </>
      )}
      {step === "review" && task.reviewTarget && (
        <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
          <li className="[overflow-wrap:anywhere]">
            {m.reviewTarget}
            <a
              href={task.reviewTarget.url}
              className="text-accent-foreground underline"
              target="_blank"
              rel="noreferrer"
            >
              #{task.reviewTarget.number} {task.reviewTarget.title}
            </a>
          </li>
          {task.reviewPost && (
            <li className="[overflow-wrap:anywhere]">
              {m.reviewPost}
              <a
                href={task.reviewPost.url}
                className="text-accent-foreground underline"
                target="_blank"
                rel="noreferrer"
              >
                {task.reviewPost.url}
              </a>
            </li>
          )}
        </ul>
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
    </CardSection>
  );
}
