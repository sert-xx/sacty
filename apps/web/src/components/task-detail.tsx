"use client";

import {
  type ActivityEvent,
  appliedProposalFor,
  canDecideTests,
  canRechooseSteps,
  canRereview,
  canRerun,
  canRetryExport,
  deliveredWithoutChanges,
  exportDue,
  gatePullRequest,
  investigationIsGoal,
  isRepoless,
  openProposal,
  rerunEditableBody,
  type StepKey,
  type Task,
} from "@sacty/core";
import Link from "next/link";
import { type ReactNode, useRef } from "react";
import { ActionLink } from "@/components/action-link";
import { TaskAuditCard } from "@/components/audit";
import { CardSection } from "@/components/card-section";
import { DaemonError } from "@/components/daemon-error";
import { DeploymentWatchCard } from "@/components/deployment";
import { ExportRetryButton } from "@/components/export-retry-button";
import { Implementation } from "@/components/implementation";
import { IntegrationResult } from "@/components/integration";
import {
  FollowProjectAfterRecovery,
  RefreshWhenMissing,
  StaleNotice,
} from "@/components/live-status";
import { Markdown } from "@/components/markdown";
import { OrchestratorSession } from "@/components/orchestrator-session";
import { Proposals } from "@/components/proposals";
import { ProvenanceNote } from "@/components/provenance";
import { PullRequestCard } from "@/components/pull-request";
import { ReproductionResult } from "@/components/reproduction";
import { RereviewButton } from "@/components/rereview-button";
import { RerunDialog } from "@/components/rerun-dialog";
import { ResumeForm } from "@/components/resume-form";
import { SecurityFixesCard } from "@/components/security-fixes";
import { SelfReviewNote } from "@/components/self-review";
import { StepAgentForm } from "@/components/step-agent-form";
import { StepCosts } from "@/components/step-costs";
import { StepImageForm } from "@/components/step-image-form";
import { CostMeter, StatusLabel, StepChips } from "@/components/task-bits";
import { TaskChat } from "@/components/task-chat";
import { TaskControls } from "@/components/task-controls";
import { TestViewpoints } from "@/components/test-viewpoints";
import { Hint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";
import {
  canControl,
  describeEventParts,
  formatStamp,
  needsTicketRepositories,
  personAction,
  statusText,
  stepAgentOptions,
  stepAgentRows,
  stepImageOptions,
  stepImageRows,
  testCommandOfNoTests,
  usd,
  usesTestCommand,
} from "@/lib/labels";
import { projectSettingsPath } from "@/lib/paths";
import { runLogId } from "@/lib/session-log";
import { subtaskSummary } from "@/lib/subtasks";
import type { TaskDetailData } from "@/lib/task-detail-data";
import { useLiveData } from "@/lib/use-live-data";

/** リポジトリの候補を取れなかったときに、求め直すまでの間（PR #119 レビュー指摘）。 */
export const REPOSITORIES_RETRY_MS = 30_000;

/**
 * タスクの詳細のデータを取り直す先。一時停止で人がリポジトリを選ぶのに、候補をまだ持っていないときだけ、候補も求める
 * （Org の対象は gh で GitHub に問い合わせるので、取り直しのたびには求めない。PBI-108）。
 */
export function taskDetailLiveUrl(id: string, withRepositories: boolean): string {
  return `/live/tasks/${encodeURIComponent(id)}${withRepositories ? "?repositories=1" : ""}`;
}

/**
 * タスクの詳細（PBI-108）。画面をリロードせず、一定の間隔でデータだけを取り直し、変わった所だけを画面に反映する
 * （タブが隠れている間は止め、見えたらすぐに取り直す）。入力の途中の文字・選択・開いた欄・フォーカス・スクロールの
 * 位置は消えない。initial が null（描いたときにデーモンに届かなかった）なら、届くまで error を出す。
 */
export function LiveTaskDetail({
  id,
  initial,
  initialVersion,
  error,
}: {
  id: string;
  initial: TaskDetailData | null;
  initialVersion?: string;
  error?: string;
}) {
  // リポジトリの候補は、一度取ったら使い続ける（取り直しのデータには入れない）
  const repositories = useRef(initial?.ticketRepositories);
  // 候補を最後に求めた時刻（取れなかったときは、間を空けて求め直す。gh で GitHub に問い合わせ続けない）
  const askedAt = useRef(initial?.ticketRepositoriesFailed ? Date.now() : Number.NEGATIVE_INFINITY);
  const { data, stale, missing } = useLiveData(
    (current) => {
      const ask =
        current !== null &&
        needsTicketRepositories(current.task) &&
        repositories.current === undefined &&
        Date.now() - askedAt.current >= REPOSITORIES_RETRY_MS;
      if (ask) askedAt.current = Date.now();
      return taskDetailLiveUrl(id, ask);
    },
    initial,
    initialVersion,
  );
  if (data?.ticketRepositories) repositories.current = data.ticketRepositories;
  if (!data) return <DaemonError message={error ?? ""} />;
  return (
    <>
      <StaleNotice stale={stale} />
      <RefreshWhenMissing missing={missing} />
      {initial === null && <FollowProjectAfterRecovery projectId={data.task.projectId} />}
      <TaskDetailView data={{ ...data, ticketRepositories: repositories.current }} />
    </>
  );
}

/** タスクの詳細の中身（取り直したデータから描く）。 */
export function TaskDetailView({ data }: { data: TaskDetailData }) {
  const { task, activity, projectName, parent, origin } = data;
  const messages = useMessages();
  const lastFailure = [...activity].reverse().find((e) => e.type === "AgentRunFailed");
  const proposal = openProposal(task);
  // 承認ゲートで見守っている、sacty が作った PR（実装・要求要件・設計。PBI-57・PBI-110）
  const watched = gatePullRequest(task);
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
  // リポジトリを指定せずに作ったタスクで、オーケストレーターが選べずに止まったときも、人が選ぶ（PBI-73）
  const ticketRepositories = needsTicketRepositories(task)
    ? (data.ticketRepositories ?? [])
    : undefined;
  const canPause =
    (task.status === "queued" ||
      task.status === "running" ||
      (task.status === "idle" && task.verification !== undefined)) &&
    !(proposal && !proposal.judgement);

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold text-balance">{task.title}</h1>
          <StatusLabel task={task} />
        </div>
        <p className="text-sm text-muted-foreground">
          {m.start}
          {labels.start[task.start]}
          {/* テンプレートで作ったタスク（PBI-90） */}
          {task.template && (
            <>
              {m.template}
              <span data-testid="task-template">{labels.template[task.template]}</span>
            </>
          )}
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
          <Link
            href={projectSettingsPath(task.projectId)}
            className="text-accent-foreground underline"
          >
            {projectName}
          </Link>
          {/* 対象リポジトリを選ぶ前の版（PBI-21 より前）のタスクは、用意したリポジトリの URL を出す */}
          {(task.source?.repo ?? task.repo ?? task.repository?.url) ? (
            <>
              {m.repository}
              <span className="font-mono [overflow-wrap:anywhere]">
                {task.source?.repo ?? task.repo ?? task.repository?.url}
              </span>
              {/* オーケストレーター・人が選んだリポジトリ（子タスクに付けたものを含む）は、選んだ理由を出す（PBI-73） */}
              {task.repoChoice && (
                <>
                  {m.repoChoiceBy(task.repoChoice.by === "person")}
                  {task.repoChoice.by !== "person" && (
                    <Hint text={m.repoChoiceHint(labels.text(task.repoChoice.reason))} />
                  )}
                </>
              )}
            </>
          ) : (
            // リポジトリを指定せずに作ったタスク（PBI-73）
            isRepoless(task) && <span data-testid="no-repository">{m.noRepository}</span>
          )}
          {task.fix && (
            <>
              {m.deployment.origin}
              <Link
                href={`/tasks/${encodeURIComponent(task.fix.taskId)}`}
                className="text-accent-foreground underline"
                data-testid="fix-origin"
              >
                {origin?.title ?? task.fix.taskId}
              </Link>
              {m.deployment.fixDepth(task.fix.depth)}
            </>
          )}
          {/* レポートの区分から作った対応のタスクは、元のレポートと区分を出す */}
          {task.securityFix && (
            <>
              {m.security.reportOf}
              <Link
                href={`/tasks/${encodeURIComponent(task.securityFix.taskId)}`}
                className="text-accent-foreground underline"
                data-testid="security-report"
              >
                {data.securityReport?.title ?? task.securityFix.taskId}
              </Link>
              {m.security.reportCategory(labels.securityCategory[task.securityFix.category])}
            </>
          )}
          {task.rerun && (
            <>
              {m.rerunOf}
              <Link
                href={`/tasks/${encodeURIComponent(task.rerun.taskId)}`}
                className="text-accent-foreground underline"
                data-testid="rerun-of"
              >
                {data.rerunOf?.title ?? task.rerun.taskId}
              </Link>
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
            plan={data.cleanupPlan ?? []}
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
                        : // 実装の PR と、要求要件・設計の PR（PBI-57・PBI-110）
                          watched?.state === "closed"
                          ? m.gate.prClosedHelp
                          : watched?.state === "merged_outdated"
                            ? m.gate.prMergedOutdatedHelp
                            : watched?.step === "implement"
                              ? m.gate.prHelp
                              : task.gate?.step === "implement" && deliveredWithoutChanges(task)
                                ? m.gate.noChangesHelp
                                : watched
                                  ? m.gate.stepPrHelp(labels.step[watched.step])
                                  : m.gate.reviewHelp}
            </p>
          </div>
          <ActionLink
            href={action.href}
            external={action.external}
            className="inline-flex min-h-11 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground"
          >
            {action.label}
          </ActionLink>
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
              // 要求要件・設計の PR とブランチ（PBI-57）は、対象ごとに複数ある（片付けた先で区別する）
              <li
                key={`${c.target}:${c.result}:${labels.text(c.detail ?? "")}`}
                className="flex flex-wrap items-baseline gap-2"
              >
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
          {/* 中止したタスクを、最初からやり直す（再実行）。再実行は1度だけ（作ったタスクへ案内する） */}
          {task.rerunBy ? (
            <p data-testid="rerun-by">
              {parts.rerun.rerunBy}
              <Link
                href={`/tasks/${encodeURIComponent(task.rerunBy)}`}
                className="text-accent-foreground underline"
              >
                {data.rerunBy?.title ?? task.rerunBy}
              </Link>
            </p>
          ) : (
            canRerun(task) && (
              <RerunDialog
                taskId={task.id}
                projectId={task.projectId}
                title={task.title}
                body={rerunEditableBody(task)}
                repo={task.source?.repo ?? task.repo ?? task.repository?.url ?? ""}
                images={stepImageOptions(data.imageStatus, m.images.defaultDescription)}
              />
            )
          )}
        </section>
      )}

      {task.status === "paused" && task.pausedReason && (
        <ResumeForm
          taskId={task.id}
          repositories={ticketRepositories}
          repoLabel={task.ticket ? parts.resume.ticketRepo : parts.resume.chooseRepo}
          repoOptional={!task.ticket}
          chosenRepo={task.repo}
          {...(canDecideTests(task)
            ? {
                tests: {
                  bugfix: task.steps.some((s) => s.key === "reproduce"),
                  rechoose: canRechooseSteps(task),
                },
              }
            : {})}
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
              {/* PR のレビューの取り込みのタスクは、sacty がレビューだけにする（PBI-44） */}
              {task.source?.review ? (
                <span className="text-[13px] font-normal text-muted-foreground">
                  {m.stepsNoteReview}
                </span>
              ) : (
                <Hint text={m.stepsHint} />
              )}
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
                      <>
                        <span className="font-mono">{task.testCommand}</span>
                        {task.testsDecidedBy === "person" && m.testCommandByPerson}
                      </>
                    ) : task.noTestsReason ? (
                      // テストの仕組みが無いと判断したタスク（PBI-94）。根拠は補足に出す。人が再開のときに決めたら、その理由
                      <>
                        {testCommandOfNoTests(task, m)}{" "}
                        <Hint
                          text={
                            task.testsDecidedBy === "person"
                              ? m.noTestsReasonByPerson(task.noTestsReason)
                              : m.noTestsReason(task.noTestsReason)
                          }
                        />
                      </>
                    ) : (
                      m.testCommandUnknown
                    )}
                  </>
                )}
              </p>
            )}
            {/* 引き継いで直す既存の PR。新しい PR を作らず、その PR のブランチにコミットを積む */}
            {task.continuedPullRequest && (
              <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
                {m.continuedPullRequest}
                {task.continuedPullRequest.url.startsWith("https://") ? (
                  <a
                    href={task.continuedPullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent-foreground underline"
                  >
                    #{task.continuedPullRequest.number}
                  </a>
                ) : (
                  `#${task.continuedPullRequest.number}`
                )}
                {m.continuedPullRequestBranch(task.continuedPullRequest.branch)}{" "}
                <Hint text={m.continuedPullRequestHint} />
              </p>
            )}
            {/* 人がタスクの作成時に指定した進め方 */}
            {task.requestedPlan && (
              <p className="text-sm leading-6 text-muted-foreground">
                {m.stepsRequested(labels.plan[task.requestedPlan])}
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
                <h3 className="font-semibold">
                  {m.exports.title} <Hint text={m.exports.hint} />
                </h3>
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
            {/* 工程のイメージと、選んだ元。いつでも変えられ、その工程を次に実行するときから使う（PBI-106） */}
            {task.steps.length > 0 && <StepImages task={task} imageStatus={data.imageStatus} />}
            {/* 工程のエージェント。人が選ぶと、その工程の次の実行から使う（PBI-121） */}
            {task.steps.length > 0 && <StepAgents task={task} agentStatus={data.agentStatus} />}
          </section>
          {/* 完了したタスクの監査（PBI-124） */}
          {data.audit !== undefined && <TaskAuditCard audit={data.audit} />}
          {task.operation && (
            <CardSection
              id="operation-settings"
              title={m.operationSettings.title}
              hint={m.operationSettings.hint}
            >
              <p className="text-sm text-muted-foreground">{m.operationSettings.description}</p>
              <dl className="grid gap-3 text-sm leading-6">
                {(
                  [
                    [m.operationSettings.connection, task.operation.name],
                    [m.operationSettings.via, m.operationSettings[task.operation.via]],
                    [m.operationSettings.target, task.operation.target],
                    [m.operationSettings.change, task.operation.change],
                    [m.operationSettings.verification, task.operation.verification],
                  ] as const
                ).map(([label, value]) => (
                  <div key={label}>
                    <dt className="font-semibold">{label}</dt>
                    <dd className="whitespace-pre-wrap [overflow-wrap:anywhere] text-muted-foreground">
                      {value}
                    </dd>
                  </div>
                ))}
              </dl>
            </CardSection>
          )}
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
          {/* タスクの開始時に集めた情報。工程が始まったら折りたたむ */}
          {task.gathered && (
            <CardSection
              id="gathered"
              title={m.gathered.title}
              note={m.gathered.sources(task.gathered.sources.length)}
              hint={m.gathered.hint}
              collapsed={task.steps.some((s) => s.state !== "todo")}
            >
              <Markdown>{task.gathered.brief}</Markdown>
              {task.gathered.sources.length > 0 && (
                <ul className="list-disc pl-5 text-sm text-muted-foreground">
                  {task.gathered.sources.map((source, index) => (
                    // 同じ題の情報源もあるので、順番も鍵にする
                    // biome-ignore lint/suspicious/noArrayIndexKey: 並びは変わらない
                    <li key={`${index}-${source.title}`} className="[overflow-wrap:anywhere]">
                      {source.url && /^https?:\/\//.test(source.url) ? (
                        <a href={source.url} target="_blank" rel="noreferrer" className="underline">
                          {source.title}
                        </a>
                      ) : (
                        source.title
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardSection>
          )}
          {/* 調査の結果（PBI-18）。要求要件は、その工程があるタスクだけ */}
          {task.steps.some((s) => s.key === "investigate") && (
            <Deliverable task={task} step="investigate" />
          )}
          {/* レビューの結果（PBI-19）。人間の承認は無く、そのまま PR に投稿する */}
          {task.steps.some((s) => s.key === "review") && <Deliverable task={task} step="review" />}
          {/* 再現の説明と、sacty が確かめた結果（PBI-29） */}
          {task.steps.some((s) => s.key === "reproduce" && s.state !== "skip") && (
            <>
              <Deliverable task={task} step="reproduce" />
              <ReproductionResult task={task} />
            </>
          )}
          {/* 工程の見直しで飛ばした工程は、成果が無いので出さない */}
          {task.steps.some((s) => s.key === "requirements" && s.state !== "skip") && (
            <Deliverable task={task} step="requirements" />
          )}
          {(task.outputs.design ||
            task.steps.some(
              (s) => s.key === "design" && s.state !== "todo" && s.state !== "skip",
            )) && <Deliverable task={task} step="design" />}
          {(["document", "operation"] as const).map((step) =>
            task.steps.some((s) => s.key === step) ? (
              <Deliverable key={step} task={task} step={step} />
            ) : null,
          )}
          {task.split && <Subtasks task={task} subtasks={data.children} />}
          {/* 統合レビューの結果（PBI-31） */}
          <IntegrationResult task={task} />
          {(task.outputs.implement ||
            task.steps.some((s) => s.key === "implement" && s.state !== "todo")) && (
            <Implementation task={task} />
          )}
          <PullRequestCard task={task} />
          {/* 承認したセキュリティチェックのレポートの区分ごとの対応のタスク */}
          {data.securityFindings !== undefined && (
            <SecurityFixesCard task={task} findings={data.securityFindings} />
          )}
          {/* マージの後の CI/CD とデプロイの監視（PBI-89） */}
          <DeploymentWatchCard task={task} fixTask={data.deploymentFix} />
          {(task.approved.requirements || task.proposals.length > 0) && <Proposals task={task} />}
          {/* 工程ごとのエージェント・設定・費用（PBI-46） */}
          <StepCosts task={task} activity={activity} subtasks={data.children} />
          {/* オーケストレーターのセッション（PBI-67） */}
          <OrchestratorSession task={task} />
        </div>

        <section
          aria-labelledby="activity"
          className="flex min-w-0 flex-[1_1_320px] flex-col gap-1 rounded-xl border border-border bg-card p-5"
        >
          <h2 id="activity" className="pb-2 text-[15px] font-semibold">
            {m.activity}
          </h2>
          <ol className="flex flex-col">
            {[...activity].reverse().map((event) => (
              <li
                key={event.id}
                // 監査の根拠から、作業履歴の行へたどれるようにする（PBI-124）
                id={`event-${event.id}`}
                className="scroll-mt-20 grid grid-cols-[96px_minmax(0,1fr)] gap-3 border-t border-border py-2.5 text-[13px] target:bg-accent"
              >
                <time
                  dateTime={event.at}
                  className="font-mono text-xs text-muted-foreground tabular-nums"
                >
                  {formatStamp(event.at, messages.locale)}
                </time>
                {/* パスやブランチ名など、区切りの無い長い文字列でも幅からはみ出さないようにする */}
                <span className="[overflow-wrap:anywhere]">
                  <EventText event={event} />
                  {/* エージェントの実行の行から、その実行のセッションログを開く（PBI-62） */}
                  {runLogId(event) && (
                    <Link
                      href={`/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(runLogId(event) ?? "")}`}
                      className="ml-2 text-xs whitespace-nowrap text-accent-foreground underline"
                    >
                      {messages.runLog.open}
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>
      {/* オーケストレーターへの質問と答え（PBI-54）。画面の右の AI のアイコンから開くサイドパネル（PBI-61） */}
      <TaskChat task={task} />
    </>
  );
}

/**
 * 作業履歴の1行の文。長い行（コンテキストの用意の外部 PF の一覧）は、1行目だけを出し、詳細は開いて読む（PR #127 レビュー指摘）。
 * 差し戻しの行は、指摘の本文を詳細に出す。詳細の改行は、そのまま改行として出す。
 */
export function EventText({ event }: { event: ActivityEvent }) {
  const { labels } = useMessages();
  const { text, detail } = describeEventParts(event, labels);
  if (!detail) return <>{text}</>;
  return (
    <details className="inline">
      <summary className="inline cursor-pointer list-none [&::-webkit-details-marker]:hidden">
        {text} <span className="text-xs text-accent-foreground underline">{labels.event.more}</span>
      </summary>
      <span className="block whitespace-pre-line pt-1 text-xs text-muted-foreground">{detail}</span>
    </details>
  );
}

/** 工程のイメージ（PBI-41）と、選んだ元・いつから使うか。中止していなければ、どの工程も変えられる（PBI-106）。 */
function StepImages({
  task,
  imageStatus,
}: {
  task: Task;
  imageStatus: TaskDetailData["imageStatus"];
}) {
  const { task: t, labels, locale } = useMessages();
  const m = t.images;
  const rows = stepImageRows(task);
  if (rows.length === 0) return null;
  // 選べるのは、既定のイメージと images の名前（説明も出す）。取得できない・設定を読めないときは、候補を確かめられない
  // ことを出し、消した名前の警告と変更の操作は出さない（一時的な失敗を、設定から消したことと取り違えない）
  const options = stepImageOptions(imageStatus, m.defaultDescription);
  const attention = !options || rows.some((row) => !options.some((o) => o.name === row.image));
  return (
    <StepSettings title={m.title} hint={m.hint} open={attention} testId="step-images">
      {!options && (
        <p role="status" className="text-warn" data-testid="step-images-unavailable">
          {m.unavailable}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => (
          <li
            key={row.step}
            className="flex flex-col gap-1 [overflow-wrap:anywhere]"
            data-testid={`step-image-row-${row.step}`}
          >
            <span>
              <span className="font-medium">{labels.step[row.step]}</span>
              {m.sep}
              <span className="font-mono">{row.image}</span>
              {options && !options.some((o) => o.name === row.image) && (
                <span className="text-warn">{m.missing}</span>
              )}
              <span className="text-muted-foreground">
                {" ・ "}
                {row.source.by === "person"
                  ? m.byPerson(formatStamp(row.source.at, locale), row.source.from)
                  : row.source.by === "project"
                    ? m.byProject
                    : row.source.by === "rerun"
                      ? m.byRerun
                      : row.source.by === "orchestrator"
                        ? row.source.default
                          ? m.byOrchestratorDefault(row.source.default)
                          : row.source.unexplained
                            ? m.byOrchestratorUnexplained
                            : m.byOrchestrator
                        : m.none}
              </span>
            </span>
            <span className="text-xs text-muted-foreground">
              {row.when === "running"
                ? m.whenRunning
                : row.when === "done"
                  ? m.whenDone
                  : m.whenNext}
              {(row.step === "implement" || row.step === "reproduce") && <> ・ {m.testNote}</>}
            </span>
            {options && task.status !== "cancelled" && (
              // 変えた後に、選択を今のイメージに合わせる（フォームのリセットが前のイメージに戻すため、作り直す）
              <StepImageForm
                key={`${row.step}:${row.image}`}
                taskId={task.id}
                step={row.step}
                current={row.image}
                options={options}
              />
            )}
          </li>
        ))}
      </ul>
    </StepSettings>
  );
}

/** 工程のエージェントと、決めた元・いつから使うか（PBI-121）。中止していなければ、どの工程も変えられる。 */
function StepAgents({
  task,
  agentStatus,
}: {
  task: Task;
  agentStatus: TaskDetailData["agentStatus"];
}) {
  const { task: t, labels, locale } = useMessages();
  const m = t.agents;
  const rows = stepAgentRows(task, agentStatus?.stepAgents);
  if (rows.length === 0) return null;
  const images = t.images;
  const unavailable = stepAgentOptions(agentStatus, undefined) === undefined;
  const missing = (agent: string | undefined) =>
    stepAgentOptions(agentStatus, agent) !== undefined &&
    Boolean(agent) &&
    !agentStatus?.agents?.some((a) => a.id === agent);
  const attention = unavailable || rows.some((row) => missing(row.agent));
  return (
    <StepSettings title={m.title} hint={m.hint} open={attention} testId="step-agents">
      {unavailable && (
        <p role="status" className="text-warn" data-testid="step-agents-unavailable">
          {m.unavailable}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const options = stepAgentOptions(agentStatus, row.agent);
          return (
            <li
              key={row.step}
              className="flex flex-col gap-1 [overflow-wrap:anywhere]"
              data-testid={`step-agent-row-${row.step}`}
            >
              <span>
                <span className="font-medium">{labels.step[row.step]}</span>
                {m.sep}
                <span className="font-mono">{row.agent ?? m.unknown}</span>
                {missing(row.agent) && (
                  <span className="inline-flex items-center gap-1 text-warn">
                    {" "}
                    {m.missing}
                    <Hint text={m.missingHint} />
                  </span>
                )}
                <span className="text-muted-foreground">
                  {" ・ "}
                  {row.source.by === "person"
                    ? m.byPerson(formatStamp(row.source.at, locale), row.source.from)
                    : m.byConfig}
                </span>
              </span>
              <span className="text-xs text-muted-foreground">
                {row.when === "running"
                  ? images.whenRunning
                  : row.when === "done"
                    ? images.whenDone
                    : images.whenNext}
              </span>
              {options && task.status !== "cancelled" && (
                <StepAgentForm
                  key={`${row.step}:${row.agent ?? ""}`}
                  taskId={task.id}
                  step={row.step}
                  current={row.agent}
                  options={options}
                />
              )}
            </li>
          );
        })}
      </ul>
    </StepSettings>
  );
}

/**
 * 工程の設定（イメージ・エージェント）の折りたたみ（PBI-138）。普段は変えないので見出しだけを出して閉じ、確かめが要る
 * とき（候補を確かめられない・設定から消えた名前）は見落とさないよう開いて出す。
 */
function StepSettings({
  title,
  hint,
  open,
  testId,
  children,
}: {
  title: string;
  hint: string;
  open: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <details open={open} className="text-sm leading-6" data-testid={testId}>
      <summary className="cursor-pointer marker:text-muted-foreground">
        <h3 className="inline font-semibold">
          {title} <Hint text={hint} />
        </h3>
      </summary>
      <div className="flex flex-col gap-1 pt-1">{children}</div>
    </details>
  );
}

/** タスク分割で作った子タスク（状態・依存・PR）と、進み具合・費用の合計（PBI-27）。 */
function Subtasks({ task, subtasks }: { task: Task; subtasks: Task[] }) {
  const m = useMessages().task.subtasks;
  const all = new Map(subtasks.map((t) => [t.id, t]));
  const { children, done, costUsd } = subtaskSummary(task, all);
  const titles = new Map(children.map((c) => [c.taskId, c.title]));
  return (
    <CardSection id="subtasks" title={m.title} hint={m.hint}>
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
                <span className="inline-flex items-center gap-0.5 rounded-full border border-back-line bg-back-soft py-0.5 pr-0.5 pl-2 text-xs font-semibold text-back">
                  {m.fix}
                  <Hint text={m.fixHint} className="size-4" />
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
function Deliverable({ task, step }: { task: Task; step: StepKey }) {
  const messages = useMessages();
  const m = messages.task.deliverable;
  const approved = task.approved[step];
  const output = approved?.output ?? task.outputs[step];
  const viewpoints = approved?.testViewpoints ?? task.testViewpoints;
  // 前の工程に差し戻されて、まだ実行対象になっていない工程の下書き
  const stale = !approved && task.steps.find((s) => s.key === step)?.state === "todo";
  const fromProposal = approved ? undefined : appliedProposalFor(task, step);
  const running =
    task.status === "running" && task.steps.some((s) => s.key === step && s.state === "active");
  // 見出しの横の短い事実と、仕組みの補足（PBI-117）
  const [note, hint]: [string, string | undefined] =
    // 再現は、再現のエージェントがテストで確かめて申告し、先へ進む（人間は承認しない。PBI-29）
    approved && step === "reproduce"
      ? [m.reproduced, undefined]
      : approved && step === "investigate" && !investigationIsGoal(task)
        ? [m.preliminary, m.preliminaryHint]
        : approved?.edited?.fallback
          ? // 人が直してマージしたが、成果のファイルが消された・読めなかった（PBI-63）
            [
              m.approvedFallback(approved.submission, approved.edited.fallback === "deleted"),
              m.approvedFallbackHint,
            ]
          : approved?.edited?.sacty !== undefined
            ? [m.approvedEdited(approved.submission), m.approvedHint]
            : approved
              ? [m.approved(approved.submission), m.approvedHint]
              : step === "review" && task.reviewPost
                ? [m.reviewPosted, undefined]
                : fromProposal
                  ? [m.fromProposal(fromProposal.id), undefined]
                  : stale
                    ? [m.stale, m.staleHint]
                    : [m.draft, undefined];
  return (
    <CardSection
      id={`deliverable-${step}`}
      title={messages.labels.step[step]}
      note={note}
      hint={hint}
      // 承認済みの成果物は折りたたむ（承認待ち・作業中のものは開いたまま）
      collapsed={Boolean(approved)}
      // 外部に直接書いたページ（文書作成）か、承認した成果の書き出しの結果（PBI-56）。折りたたんでも見えるようにする
      footer={
        step === "document" && (task.documentPages?.length ?? 0) > 0 ? (
          <DocumentPages pages={task.documentPages ?? []} />
        ) : task.exportPlans?.[step]?.to ? (
          <ExportResult task={task} step={step} />
        ) : undefined
      }
    >
      {/* 提出の前のセルフレビュー（PBI-120）。承認済みの成果物では、凍結した版のものではないので出さない */}
      {!approved && output && <SelfReviewNote task={task} step={step} />}
      {!approved && output && <ProvenanceNote task={task} step={step} />}
      {output ? (
        <Markdown>{output}</Markdown>
      ) : // 行へのコメントだけのレビューは本文が空（書き終えている）
      step === "review" && output === "" ? null : (
        <p className="text-sm text-muted-foreground">{running ? m.running : m.notYet}</p>
      )}
      {/* 人が PR で直してマージした版を承認済みにしたときの、sacty が出した版（PBI-63） */}
      {approved?.edited?.sacty !== undefined && (
        <details className="rounded-lg border border-border p-3.5 text-sm">
          <summary className="cursor-pointer font-semibold">{m.sactyVersion}</summary>
          <div className="mt-2">
            <Markdown>{approved.edited.sacty}</Markdown>
          </div>
        </details>
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
            </span>{" "}
            <Hint text={m.viewpointsHint} />
          </h3>
          <TestViewpoints viewpoints={viewpoints} />
        </>
      )}
    </CardSection>
  );
}

/**
 * 文書作成で、タスクの説明の指示に従ってエージェントが外部に直接作った・直したページ（成果物）。ページがあれば書き出さない。
 */
function DocumentPages({ pages }: { pages: readonly string[] }) {
  const m = useMessages().task.documentPages;
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
      <h3 className="font-semibold">
        {m.title} <Hint text={m.hint} />
      </h3>
      <ul className="flex list-disc flex-col gap-1 pl-5">
        {pages.map((url) => (
          <li key={url} className="[overflow-wrap:anywhere]">
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="text-accent-foreground underline"
            >
              {url}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 承認した成果の書き出しの結果（PBI-56）。書き出した先の URL か、書き出せなかった理由（いまの仕様のまま進める）と、
 * 書き出し直す操作。差し戻しの後に承認し直した版は、前に書き出した先を更新する。
 */
function ExportResult({ task, step }: { task: Task; step: StepKey }) {
  const messages = useMessages();
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
            {m.failed(last.submission, messages.labels.text(last.failed))}{" "}
            <Hint text={m.failedHint} />
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
