import {
  appliedProposalFor,
  awaitingTicketTriage,
  canRereview,
  canRetryExport,
  exportDue,
  investigationIsGoal,
  openProposal,
  pendingQuestion,
  type StepKey,
  type Task,
} from "@sacty/core";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/auto-refresh";
import { CardSection } from "@/components/card-section";
import { DaemonError } from "@/components/daemon-error";
import { ExportRetryButton } from "@/components/export-retry-button";
import { Implementation } from "@/components/implementation";
import { IntegrationResult } from "@/components/integration";
import { Markdown } from "@/components/markdown";
import { Proposals } from "@/components/proposals";
import { PullRequestCard } from "@/components/pull-request";
import { ReproductionResult } from "@/components/reproduction";
import { RereviewButton } from "@/components/rereview-button";
import { ResumeForm } from "@/components/resume-form";
import { StepCosts } from "@/components/step-costs";
import { CostMeter, StatusLabel, StepChips } from "@/components/task-bits";
import { TaskChat } from "@/components/task-chat";
import { TaskControls } from "@/components/task-controls";
import { TestViewpoints } from "@/components/test-viewpoints";
import { getMessages } from "@/i18n/server";
import {
  DaemonUnavailableError,
  getCleanupPlan,
  getProject,
  getTask,
  listProjectRepositories,
  listTasks,
} from "@/lib/daemon";
import {
  canControl,
  describeEvent,
  formatStamp,
  isWorking,
  personAction,
  statusText,
  usd,
  usesTestCommand,
} from "@/lib/labels";
import { subtaskSummary } from "@/lib/subtasks";

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
  // 分割で作った子タスクの親（PBI-27）
  const parent = task.parent ? (await getTask(task.parent.taskId))?.task : undefined;
  const lastFailure = [...activity].reverse().find((e) => e.type === "AgentRunFailed");
  const proposal = openProposal(task);
  const messages = await getMessages();
  const { task: m, labels, parts, locale } = messages;
  const action = personAction(task, labels);
  // PR の指摘の戻し先の確認（PBI-14b。PBI-58 より前の作業履歴だけ）
  const rework =
    task.status === "escalated" && task.escalation?.reason === "rework_confirmation"
      ? task.escalation
      : undefined;
  // 一時停止できるのは、sacty やエージェントが作業している（または作業を待っている）間。
  // ゴールガーディアンの変更の申し出の判定中は、すぐ終わるので止めない
  // チケットのタスクで、チケットを読む段階で止まったら、人がリポジトリを選ぶ（選び直せる。PBI-52）
  const ticketRepositories =
    awaitingTicketTriage(task) && task.status === "paused"
      ? ((await listProjectRepositories(task.projectId).catch(() => undefined))?.repositories ?? [])
      : undefined;
  const canPause =
    (task.status === "queued" ||
      task.status === "running" ||
      (task.status === "idle" && task.verification !== undefined)) &&
    !(proposal && !proposal.judgement);

  return (
    <>
      {/* オーケストレーターが質問に答えている間・承認した成果を書き出している間も、終わるまで更新する（PBI-54・PBI-56） */}
      <AutoRefresh
        active={
          isWorking(task) ||
          pendingQuestion(task) !== undefined ||
          (task.status !== "paused" && exportDue(task) !== undefined)
        }
      />
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
          {task.ticket && (
            <>
              {m.sourceOpen}
              <a
                href={task.ticket.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-accent-foreground underline"
              >
                {task.ticket.key}
              </a>
              {m.sourceClose}
            </>
          )}
          {m.project}
          <Link href={`/projects/${task.projectId}`} className="text-accent-foreground underline">
            {projectName}
          </Link>
          {/* 対象リポジトリを選ぶ前の版（PBI-21 より前）のタスクは、用意したリポジトリの URL を出す */}
          {(task.source?.repo ?? task.repo ?? task.repository?.url) && (
            <>
              {m.repository}
              <span className="font-mono [overflow-wrap:anywhere]">
                {task.source?.repo ?? task.repo ?? task.repository?.url}
              </span>
            </>
          )}
          {task.parent && (
            <>
              {m.parent}
              <Link
                href={`/tasks/${task.parent.taskId}`}
                className="text-accent-foreground underline"
              >
                {parent?.title ?? task.parent.taskId}
              </Link>
            </>
          )}
        </p>
        <CostMeter task={task} />
        {canRereview(task) && <RereviewButton taskId={task.id} />}
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
                    : task.gate?.step === "reproduce"
                      ? m.gate.notReproducedHelp
                      : task.gate?.step === "integrate"
                        ? task.integration?.passed === false
                          ? m.gate.integrateFailedHelp(task.integrationFailures)
                          : m.gate.integrateHelp
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
          repositories={ticketRepositories}
          chosenRepo={task.repo}
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
              <span className="text-[13px] font-normal text-muted-foreground">
                {/* PR のレビューの取り込みのタスクは、sacty がレビューだけにする（PBI-44） */}
                {task.source?.review ? m.stepsNoteReview : m.stepsNote}
              </span>
            </h2>
            <StepChips task={task} />
            {/* オーケストレーターが決めたベースブランチとテストのコマンド（PBI-25） */}
            {task.repository && task.stepsChoice && (
              <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                {m.baseBranch}
                <span className="font-mono">{task.repository.baseBranch}</span>
                {/* テストのコマンドは、実装を検証するときだけ使う（PBI-28） */}
                {usesTestCommand(task) && (
                  <>
                    {m.testCommand}
                    {task.testCommand ? (
                      <span className="font-mono">{task.testCommand}</span>
                    ) : (
                      m.testCommandUnknown
                    )}
                  </>
                )}
              </p>
            )}
            {task.stepsChoice && (
              <p className="text-sm leading-6 text-muted-foreground">
                {task.stepsChoice.fallback
                  ? labels.text(task.stepsChoice.reason)
                  : m.stepsReason(labels.text(task.stepsChoice.reason))}
              </p>
            )}
            {/* オーケストレーターが工程ごとに決めた書き出し先と理由（PBI-56） */}
            {task.exportPlans && Object.keys(task.exportPlans).length > 0 && (
              <div className="flex flex-col gap-1 text-sm leading-6">
                <h3 className="font-semibold">{m.exports.title}</h3>
                <ul className="flex flex-col gap-1 text-muted-foreground">
                  {task.steps
                    .filter((s) => task.exportPlans?.[s.key])
                    .map((s) => {
                      const plan = task.exportPlans?.[s.key];
                      return (
                        <li key={s.key} className="[overflow-wrap:anywhere]">
                          <span className="font-medium text-foreground">{labels.step[s.key]}</span>
                          {m.exports.sep}
                          {plan?.to ? (
                            <span className="font-mono">
                              {m.exports.to(plan.to.name, plan.to.location)}
                            </span>
                          ) : (
                            m.exports.none
                          )}
                          {plan && labels.text(plan.reason) && (
                            <> ・ {m.exports.reason(labels.text(plan.reason))}</>
                          )}
                        </li>
                      );
                    })}
                </ul>
              </div>
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
          {/* 再現の説明と、sacty が確かめた結果（PBI-29） */}
          {task.steps.some((s) => s.key === "reproduce") && (
            <>
              <Deliverable task={task} step="reproduce" />
              <ReproductionResult task={task} />
            </>
          )}
          {task.steps.some((s) => s.key === "requirements") && (
            <Deliverable task={task} step="requirements" />
          )}
          {(task.outputs.design ||
            task.steps.some((s) => s.key === "design" && s.state !== "todo")) && (
            <Deliverable task={task} step="design" />
          )}
          {task.split && <Subtasks task={task} />}
          {/* 統合レビューの結果（PBI-31） */}
          <IntegrationResult task={task} />
          {(task.outputs.implement ||
            task.steps.some((s) => s.key === "implement" && s.state !== "todo")) && (
            <Implementation task={task} />
          )}
          <PullRequestCard task={task} />
          {(task.approved.requirements || task.proposals.length > 0) && <Proposals task={task} />}
          {/* オーケストレーターへの質問と答え（PBI-54） */}
          <TaskChat task={task} />
          {/* 工程ごとのエージェント・設定・費用（PBI-46） */}
          <StepCosts task={task} activity={activity} />
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

/** タスク分割で作った子タスク（状態・依存・PR）と、進み具合・費用の合計（PBI-27）。 */
async function Subtasks({ task }: { task: Task }) {
  const m = (await getMessages()).task.subtasks;
  const all = new Map((await listTasks()).map((t) => [t.id, t]));
  const { children, done, costUsd } = subtaskSummary(task, all);
  const titles = new Map(children.map((c) => [c.taskId, c.title]));
  return (
    <CardSection id="subtasks" title={m.title} note={m.note}>
      <p className="text-sm text-muted-foreground">
        {m.progress(done, children.length)} ・ {m.cost(usd(costUsd))}
      </p>
      {task.split?.reason && (
        <p className="text-sm leading-6 text-muted-foreground">{m.reason(task.split.reason)}</p>
      )}
      <ol className="flex flex-col">
        {children.map((c) => (
          <li
            key={c.taskId}
            className="flex flex-col gap-1 border-t border-border py-2.5 text-sm first:border-t-0"
          >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Link href={`/tasks/${c.taskId}`} className="font-medium hover:underline">
                {c.title}
              </Link>
              {/* 統合レビューの後に追加した修正の子タスク（PBI-31） */}
              {c.round > 1 && (
                <span
                  title={m.fixNote}
                  className="rounded-full border border-back-line bg-back-soft px-2 py-0.5 text-xs font-semibold text-back"
                >
                  {m.fix}
                </span>
              )}
              {c.task ? (
                <StatusLabel task={c.task} />
              ) : (
                <span className="text-muted-foreground">{m.missing}</span>
              )}
              {c.task?.pullRequest?.url && (
                <a
                  href={c.task.pullRequest.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-accent-foreground underline"
                >
                  {m.pullRequest} #{c.task.pullRequest.number}
                </a>
              )}
            </div>
            {c.dependsOn.length > 0 && (
              <p className="text-xs text-muted-foreground">
                {m.dependsOn(c.dependsOn.map((d) => titles.get(d) ?? d))}
              </p>
            )}
          </li>
        ))}
      </ol>
    </CardSection>
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
        // 再現は、sacty がテストで確かめて先へ進む（人間は承認しない。PBI-29）
        approved && step === "reproduce"
          ? m.reproduced
          : approved && step === "investigate" && !investigationIsGoal(task)
            ? m.preliminary
            : approved
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
      {/* 承認した成果の書き出しの結果（PBI-56） */}
      {task.exportPlans?.[step]?.to && <ExportResult task={task} step={step} />}
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

/**
 * 承認した成果の書き出しの結果（PBI-56）。書き出した先の URL か、書き出せなかった理由（いまの仕様のまま進める）と、
 * 書き出し直す操作。差し戻しの後に承認し直した版は、前に書き出した先を更新する。
 */
async function ExportResult({ task, step }: { task: Task; step: StepKey }) {
  const messages = await getMessages();
  const m = messages.task.exports;
  const exported = task.exports[step];
  const last = exported?.last;
  const approved = task.approved[step];
  // 承認した版が、まだ書き出されていない（書き出し中・書き出し直しを求めた）
  const due = approved !== undefined && exportDue(task) === step;
  if (!approved && !exported?.url) return null;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
      <h3 className="font-semibold">{m.result}</h3>
      {due ? (
        <>
          <p className="text-muted-foreground">{task.status === "paused" ? m.paused : m.pending}</p>
          {exported?.url && (
            <p className="[overflow-wrap:anywhere] text-muted-foreground">
              {m.previous}
              <a
                href={exported.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent-foreground underline"
              >
                {exported.url}
              </a>
            </p>
          )}
        </>
      ) : last?.url ? (
        <p className="[overflow-wrap:anywhere]">
          {m.exported(last.submission)}
          <a
            href={last.url}
            target="_blank"
            rel="noreferrer"
            className="text-accent-foreground underline"
          >
            {last.url}
          </a>
        </p>
      ) : last?.failed !== undefined ? (
        <>
          <p className="text-warn [overflow-wrap:anywhere]">
            {m.failed(last.submission, messages.labels.text(last.failed))}
          </p>
          {exported?.url && (
            <p className="[overflow-wrap:anywhere] text-muted-foreground">
              {m.previous}
              <a
                href={exported.url}
                target="_blank"
                rel="noreferrer"
                className="text-accent-foreground underline"
              >
                {exported.url}
              </a>
            </p>
          )}
          {canRetryExport(task, step) && <ExportRetryButton taskId={task.id} step={step} />}
        </>
      ) : null}
    </div>
  );
}
