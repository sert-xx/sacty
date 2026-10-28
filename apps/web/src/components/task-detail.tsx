"use client";

import {
  type ActivityEvent,
  appliedProposalFor,
  canDecideTests,
  canDerive,
  canOverrideVerification,
  canRechooseSteps,
  canRereview,
  canRerun,
  canRetryExport,
  deliveredWithoutChanges,
  exportDue,
  gatePullRequest,
  investigationIsGoal,
  isRepoless,
  isSecurityTask,
  openProposal,
  rerunEditableBody,
  resumeNoteRoom,
  type StepKey,
  type Task,
} from "@sacty/core";
import { cn } from "cn";
import { Check } from "lucide-react";
import Link from "next/link";
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { ActionLink } from "@/components/action-link";
import { TaskAuditCard } from "@/components/audit";
import { CardSection, ExpandCards } from "@/components/card-section";
import { DaemonError } from "@/components/daemon-error";
import { DeploymentWatchCard } from "@/components/deployment";
import { DerivedTasksCard } from "@/components/derive-dialog";
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
import { ResumeForm, type ResumeStepSetting } from "@/components/resume-form";
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

/** タスクの詳細の表示の切り替え（タブ）。監査はタスクを監査したときだけ出す。 */
type TabKey = "overview" | "activity" | "costs" | "settings" | "audit";

/** 最近の作業履歴に出す行の数。 */
const RECENT_EVENTS = 5;

/**
 * いまの工程。作業中の工程・承認を待っている工程・最後に終えた工程の順に選ぶ（成果物の表示の最初の選択に使う）。
 */
export function currentStep(task: Task): StepKey | undefined {
  return (
    task.steps.find((s) => s.state === "active")?.key ??
    task.gate?.step ??
    [...task.steps].reverse().find((s) => s.state === "done")?.key ??
    task.steps.find((s) => s.state !== "skip")?.key
  );
}

/**
 * タスクの詳細の中身（取り直したデータから描く）。
 * 上に固定した見出し（題・状態・工程・操作・タブ）と、人の対応が要るときの案内を常に出し、その下をタブで切り替える。
 * 右の列には、よく確かめる事実（プロパティ）と最近の作業履歴を出す。隠したタブの中身も描いておく（入力の途中の文字・
 * 開いた欄を、タブを切り替えても消さないため）。
 */
export function TaskDetailView({ data }: { data: TaskDetailData }) {
  const { task, activity } = data;
  const messages = useMessages();
  const lastFailure = [...activity].reverse().find((e) => e.type === "AgentRunFailed");
  const proposal = openProposal(task);
  const { task: m, parts } = messages;
  const l = m.layout;
  // チケットのタスクで、チケットを読む段階で止まったら、人がリポジトリを選ぶ（選び直せる。PBI-52）
  // リポジトリを指定せずに作ったタスクで、オーケストレーターが選べずに止まったときも、人が選ぶ（PBI-73）
  const ticketRepositories = needsTicketRepositories(task)
    ? (data.ticketRepositories ?? [])
    : undefined;
  // 一時停止できるのは、sacty やエージェントが作業している（または作業を待っている）間。
  // ゴールガーディアンの変更の申し出の判定中は、すぐ終わるので止めない
  const canPause =
    (task.status === "queued" ||
      task.status === "running" ||
      (task.status === "idle" && task.verification !== undefined)) &&
    !(proposal && !proposal.judgement);

  const [tab, setTab] = useState<TabKey>("overview");
  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: "overview", label: l.overview },
    { key: "activity", label: l.activity, count: activity.length },
    { key: "costs", label: l.costs },
    { key: "settings", label: l.settings },
    ...(data.audit !== undefined ? [{ key: "audit" as const, label: l.audit }] : []),
  ];
  const keys = tabs.map((t) => t.key);
  // 出していないタブ（監査の無いタスクの監査など）は、概要にする
  const shown = keys.includes(tab) ? tab : "overview";
  const available = useRef(keys);
  available.current = keys;
  // 開いたタブは URL に残す（リロード・共有しても同じタブを開く）。ハッシュ（監査の根拠の #event-…・監査の一覧の
  // #audit・判断の #proposals）の要素が隠したタブにあれば、そのタブを開いてから移る
  useRevealHash(
    (key) => setTab(key as TabKey),
    "tab",
    () => {
      const asked = new URLSearchParams(window.location.search).get("tab") as TabKey | null;
      setTab(asked && available.current.includes(asked) ? asked : "overview");
    },
  );
  const choose = (key: TabKey) => {
    setTab(key);
    const url = new URL(window.location.href);
    if (key === "overview") url.searchParams.delete("tab");
    else url.searchParams.set("tab", key);
    url.hash = "";
    window.history.replaceState(window.history.state, "", url);
  };

  return (
    <>
      {/* 題・状態・工程・操作・タブは、スクロールしても見えるよう上に固定する */}
      <div className="sticky top-16 z-20 -mx-4 flex flex-col gap-3 border-b border-border bg-background/95 px-4 pt-4 backdrop-blur sm:-mx-8 sm:px-8">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="flex min-w-0 flex-col gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <h1 className="text-xl font-bold text-balance">{task.title}</h1>
              <StatusLabel task={task} />
            </div>
            <StepChips task={task} />
          </div>
          <div className="flex flex-wrap items-start gap-2">
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
        </div>
        <div
          role="tablist"
          aria-label={l.tabs}
          className="-mb-px flex gap-1 overflow-x-auto"
          onKeyDown={(e) => moveTab(e, keys, shown, choose, (k) => `tab-${k}`)}
        >
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              role="tab"
              id={`tab-${t.key}`}
              aria-selected={shown === t.key}
              aria-controls={`panel-${t.key}`}
              tabIndex={shown === t.key ? 0 : -1}
              onClick={() => choose(t.key)}
              className={cn(
                "inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap",
                shown === t.key
                  ? "border-primary font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <span className="rounded-full bg-muted px-1.5 text-xs tabular-nums text-muted-foreground">
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 人の対応が要るとき（承認・判断・再開）は、どのタブでも見えるよう、タブの上に出す */}
      <GateNotice task={task} />
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
          toReview={canOverrideVerification(task)}
          steps={resumeStepSettings(task, data, m.images.defaultDescription)}
          noteRoom={resumeNoteRoom(task)}
          usedUsd={task.budget.usedUsd}
          capUsd={task.budget.capUsd}
          lastFailure={(() => {
            const failure =
              task.pausedMessage ??
              (task.pausedReason !== "budget" && lastFailure?.type === "AgentRunFailed"
                ? lastFailure.payload.message
                : undefined);
            return failure === undefined ? undefined : messages.labels.text(failure);
          })()}
        />
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-6">
          <TabPanel tab="overview" open={shown}>
            <Overview data={data} />
          </TabPanel>
          <TabPanel tab="activity" open={shown}>
            <section
              aria-labelledby="activity"
              className="flex flex-col gap-1 rounded-xl border border-border bg-card p-5"
            >
              <h2 id="activity" className="pb-2 text-[15px] font-semibold">
                {m.activity}
              </h2>
              <ActivityList task={task} events={[...activity].reverse()} anchors />
            </section>
          </TabPanel>
          <TabPanel tab="costs" open={shown}>
            <section className="flex flex-col gap-2 rounded-xl border border-border bg-card p-5">
              <CostMeter task={task} />
            </section>
            {/* 工程ごとのエージェント・設定・費用（PBI-46） */}
            <StepCosts task={task} activity={activity} subtasks={data.children} />
            {/* オーケストレーターのセッション（PBI-67） */}
            <OrchestratorSession task={task} />
          </TabPanel>
          <TabPanel tab="settings" open={shown}>
            <StepsChoice task={task} data={data} />
          </TabPanel>
          {/* 完了したタスクの監査（PBI-124） */}
          {data.audit !== undefined && (
            <TabPanel tab="audit" open={shown}>
              <TaskAuditCard audit={data.audit} />
            </TabPanel>
          )}
        </div>
        <aside className="flex min-w-0 flex-col gap-6">
          <Properties data={data} />
          {shown !== "activity" && activity.length > 0 && (
            <section
              aria-labelledby="recent"
              className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4"
            >
              <h2 id="recent" className="pb-1 text-sm font-semibold">
                {l.recent}
              </h2>
              <ActivityList
                task={task}
                events={[...activity].reverse().slice(0, RECENT_EVENTS)}
                compact
              />
              {activity.length > RECENT_EVENTS && (
                <button
                  type="button"
                  onClick={() => choose("activity")}
                  className="self-start pt-1 text-xs text-accent-foreground underline"
                >
                  {l.showAll(activity.length)}
                </button>
              )}
            </section>
          )}
        </aside>
      </div>
      {/* オーケストレーターへの質問と答え（PBI-54）。画面の右の AI のアイコンから開くサイドパネル（PBI-61） */}
      <TaskChat task={task} />
    </>
  );
}

/**
 * URL のハッシュの要素が、隠したタブ・成果物の工程の中にあれば、その中身を開いてから要素へ移る。
 * 開いた先（data-tab・data-step の値）を select に渡す。移ったら true。
 */
export function revealHash(
  select: (key: string) => void,
  attribute = "tab",
  hash = window.location.hash,
): boolean {
  let id: string;
  try {
    id = decodeURIComponent(hash.slice(1));
  } catch {
    // 不正なパーセント表記（#100% など）は、ハッシュが無いものとして扱う
    return false;
  }
  const target = id ? document.getElementById(id) : null;
  const key = target?.closest<HTMLElement>(`[data-${attribute}]`)?.dataset[attribute];
  if (!target || key === undefined) return false;
  select(key);
  // 開いたタブを描いてから移る
  requestAnimationFrame(() =>
    requestAnimationFrame(() => target.scrollIntoView({ block: "center" })),
  );
  return true;
}

/**
 * ハッシュの要素を開いて移る（revealHash）のを、画面を開いたとき・ハッシュが変わったとき・同じ画面へのハッシュ付きの
 * リンクを押したときに行う。画面の中のリンク（next/link）は history.pushState で移るので hashchange が起きない。
 * 押したリンクの URL のハッシュで、移った後に開く。fallback は、ハッシュで開けなかったときの初めの表示。
 */
function useRevealHash(select: (key: string) => void, attribute: string, fallback?: () => void) {
  const latest = useRef({ select, fallback });
  latest.current = { select, fallback };
  useEffect(() => {
    const open = (hash?: string) => {
      if (!revealHash((key) => latest.current.select(key), attribute, hash)) {
        latest.current.fallback?.();
      }
    };
    const onHashChange = () => open();
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
        return;
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement) || link.target === "_blank") return;
      const url = new URL(link.href, window.location.href);
      if (
        url.origin !== window.location.origin ||
        url.pathname !== window.location.pathname ||
        !url.hash
      )
        return;
      // 移った後（URL を書き換えた後）に開く
      setTimeout(() => open(url.hash), 0);
    };
    open();
    window.addEventListener("hashchange", onHashChange);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      document.removeEventListener("click", onClick, true);
    };
  }, [attribute]);
}

/** タブの並びの中を、左右の矢印キー・Home・End で移る（選んだタブにフォーカスを移す）。 */
function moveTab<K extends string>(
  event: KeyboardEvent<HTMLElement>,
  keys: K[],
  current: K,
  select: (key: K) => void,
  idOf: (key: K) => string,
) {
  const index = keys.indexOf(current);
  const next =
    event.key === "ArrowRight"
      ? keys[(index + 1) % keys.length]
      : event.key === "ArrowLeft"
        ? keys[(index - 1 + keys.length) % keys.length]
        : event.key === "Home"
          ? keys[0]
          : event.key === "End"
            ? keys.at(-1)
            : undefined;
  if (next === undefined) return;
  event.preventDefault();
  select(next);
  document.getElementById(idOf(next))?.focus();
}

/** タブの中身。隠したタブも描いておく（入力の途中の文字・開いた欄を消さない）。 */
function TabPanel({ tab, open, children }: { tab: TabKey; open: TabKey; children: ReactNode }) {
  return (
    <div
      role="tabpanel"
      id={`panel-${tab}`}
      aria-labelledby={`tab-${tab}`}
      data-tab={tab}
      hidden={tab !== open}
      className="flex flex-col gap-6"
    >
      {children}
    </div>
  );
}

/** 人の承認・判断を待っているときの案内と、判断する場所への操作。 */
function GateNotice({ task }: { task: Task }) {
  const { task: m, labels } = useMessages();
  if (task.status !== "awaiting_approval" && task.status !== "escalated") return null;
  const proposal = openProposal(task);
  // 承認ゲートで見守っている、sacty が作った PR（実装・要求要件・設計。PBI-57・PBI-110）
  const watched = gatePullRequest(task);
  const action = personAction(task, labels);
  // PR の指摘の戻し先の確認（PBI-14b。PBI-58 より前の作業履歴だけ）
  const rework =
    task.status === "escalated" && task.escalation?.reason === "rework_confirmation"
      ? task.escalation
      : undefined;
  return (
    <section
      aria-labelledby="gate"
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warn-line bg-warn-soft px-5 py-4"
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
  );
}

/**
 * 概要のタブ。中止したときの片付け、依頼の内容、工程ごとの成果物（いまの工程を先に表示）、PR と、そのタスクに関わる
 * ときだけ出る結果（分割・統合レビュー・セキュリティ・続きのタスク・変更の申し出）。
 */
function Overview({ data }: { data: TaskDetailData }) {
  const { task } = data;
  const { task: m } = useMessages();
  return (
    <>
      {task.status === "cancelled" && task.cancelled && <CancelledCard data={data} />}
      <TaskContent task={task} />
      <Deliverables data={data} />
      <PullRequestCard task={task} />
      {/* 承認したセキュリティチェックのレポートの区分ごとの対応のタスク */}
      {data.securityFindings !== undefined && (
        <SecurityFixesCard task={task} findings={data.securityFindings} />
      )}
      {/* 完了したタスクの続きの作業のタスク（派生） */}
      {canDerive(task) && (
        <DerivedTasksCard
          task={task}
          derived={data.derivedTasks ?? []}
          security={isSecurityTask(task)}
        />
      )}
      {/* 申し出が無いときは出さない（無いことは作業履歴で確かめられる） */}
      {task.proposals.length > 0 && <Proposals task={task} />}
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
    </>
  );
}

/** 依頼の内容。長いときは途中まで出し、開いて読む（成果物が下に押しやられないように）。 */
function TaskContent({ task }: { task: Task }) {
  const { task: m } = useMessages();
  const [open, setOpen] = useState(false);
  const long = (task.body?.length ?? 0) > 400 || (task.body?.split("\n").length ?? 0) > 8;
  return (
    <section
      aria-labelledby="content"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="content" className="text-[15px] font-semibold">
        {m.content}
      </h2>
      {task.body ? (
        <div
          className={cn(
            long &&
              !open &&
              "max-h-40 overflow-hidden [mask-image:linear-gradient(to_bottom,black_60%,transparent)]",
          )}
        >
          <Markdown>{task.body}</Markdown>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{m.contentEmpty}</p>
      )}
      {long && (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="self-start text-xs text-accent-foreground underline"
        >
          {open ? m.layout.readLess : m.layout.readMore}
        </button>
      )}
    </section>
  );
}

/**
 * 工程ごとの成果物。工程を選んで1つずつ表示する（最初は、いまの工程）。成果物の無い工程（飛ばした・まだの工程）は
 * 選べない。
 */
function Deliverables({ data }: { data: TaskDetailData }) {
  const { task } = data;
  const messages = useMessages();
  const l = messages.task.layout;
  const has = (key: StepKey, ok: (s: Task["steps"][number]) => boolean = () => true) =>
    task.steps.some((s) => s.key === key && ok(s));
  const panels: { key: StepKey; node: ReactNode }[] = [];
  // 調査の結果（PBI-18）
  if (has("investigate")) {
    panels.push({ key: "investigate", node: <Deliverable task={task} step="investigate" /> });
  }
  // レビューの結果（PBI-19）。人間の承認は無く、そのまま PR に投稿する
  if (has("review"))
    panels.push({ key: "review", node: <Deliverable task={task} step="review" /> });
  // 再現の説明と、sacty が確かめた結果（PBI-29）
  if (has("reproduce", (s) => s.state !== "skip")) {
    panels.push({
      key: "reproduce",
      node: (
        <>
          <Deliverable task={task} step="reproduce" />
          <ReproductionResult task={task} />
        </>
      ),
    });
  }
  // 工程の見直しで飛ばした工程は、成果が無いので出さない
  if (has("requirements", (s) => s.state !== "skip")) {
    panels.push({ key: "requirements", node: <Deliverable task={task} step="requirements" /> });
  }
  if (task.outputs.design || has("design", (s) => s.state !== "todo" && s.state !== "skip")) {
    panels.push({ key: "design", node: <Deliverable task={task} step="design" /> });
  }
  for (const step of ["document", "operation"] as const) {
    if (has(step)) panels.push({ key: step, node: <Deliverable task={task} step={step} /> });
  }
  if (task.split) {
    panels.push({ key: "split", node: <Subtasks task={task} subtasks={data.children} /> });
  }
  // 統合レビューの結果（PBI-31）
  if (has("integrate")) panels.push({ key: "integrate", node: <IntegrationResult task={task} /> });
  if (task.outputs.implement || has("implement", (s) => s.state !== "todo")) {
    panels.push({ key: "implement", node: <Implementation task={task} /> });
  }
  // マージの後の CI/CD とデプロイの監視（PBI-89）
  // まだ始まっていない監視は、成果が無いので選べない。工程の無い古いタスクでも、監視の記録があれば出す
  if (has("deployment", (s) => s.state !== "todo") || task.deployment) {
    panels.push({
      key: "deployment",
      node: <DeploymentWatchCard task={task} fixTask={data.deploymentFix} />,
    });
  }
  const current = currentStep(task);
  const fallback = panels.find((p) => p.key === current)?.key ?? panels.at(-1)?.key;
  const [chosen, setChosen] = useState<StepKey | undefined>(undefined);
  const selected = panels.some((p) => p.key === chosen) ? chosen : fallback;
  // ハッシュの要素（#deliverable-design など）が隠した工程にあれば、その工程を開く
  useRevealHash((key) => setChosen(key as StepKey), "step");
  const state = new Map(task.steps.map((s) => [s.key, s.state]));
  return (
    <>
      {panels.length === 0 ? (
        <section className="rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
          {l.deliverablesNone}
        </section>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-[15px] font-semibold">
              {l.deliverables} <Hint text={l.deliverablesHint} />
            </h2>
            <div
              role="tablist"
              aria-label={l.deliverables}
              className="flex flex-wrap gap-1"
              onKeyDown={(e) =>
                selected &&
                moveTab(
                  e,
                  panels.map((p) => p.key),
                  selected,
                  setChosen,
                  (k) => `deliverable-tab-${k}`,
                )
              }
            >
              {panels.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  role="tab"
                  id={`deliverable-tab-${p.key}`}
                  aria-selected={p.key === selected}
                  aria-controls={`deliverable-panel-${p.key}`}
                  tabIndex={p.key === selected ? 0 : -1}
                  onClick={() => setChosen(p.key)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs",
                    p.key === selected
                      ? "border-primary bg-primary text-primary-foreground font-semibold"
                      : "border-input bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  {state.get(p.key) === "done" && <Check aria-hidden="true" className="size-3" />}
                  {state.get(p.key) === "active" && (
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 rounded-full",
                        p.key === selected ? "bg-primary-foreground" : "bg-primary",
                      )}
                    />
                  )}
                  {messages.labels.step[p.key]}
                </button>
              ))}
            </div>
          </div>
          {panels.map((p) => (
            <div
              key={p.key}
              role="tabpanel"
              id={`deliverable-panel-${p.key}`}
              aria-labelledby={`deliverable-tab-${p.key}`}
              data-step={p.key}
              hidden={p.key !== selected}
              className="flex flex-col gap-6"
            >
              <ExpandCards value={true}>{p.node}</ExpandCards>
            </div>
          ))}
        </div>
      )}
      {/* 統合レビューの工程の無いタスクでも、結果があれば出す（PBI-31） */}
      {!has("integrate") && <IntegrationResult task={task} />}
    </>
  );
}

/** 中止したときの片付けの結果と、最初からやり直す操作。 */
function CancelledCard({ data }: { data: TaskDetailData }) {
  const { task } = data;
  const { task: m, parts, labels, locale } = useMessages();
  if (!task.cancelled) return null;
  return (
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
  );
}

/** プロパティの1行。 */
function Prop({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[88px_minmax(0,1fr)] gap-2 py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="[overflow-wrap:anywhere]">{children}</dd>
    </div>
  );
}

/** タスクへのリンク。 */
function TaskLink({ id, title, testId }: { id: string; title?: string; testId?: string }) {
  return (
    <Link
      href={`/tasks/${encodeURIComponent(id)}`}
      className="text-accent-foreground underline"
      data-testid={testId}
    >
      {title ?? id}
    </Link>
  );
}

/**
 * よく確かめる事実（プロパティ）。プロジェクト・リポジトリ・ブランチ・テスト・元のチケット・PR・費用・関係するタスク・
 * 作成と最終更新。どのタブでも右の列に出す。
 */
function Properties({ data }: { data: TaskDetailData }) {
  const { task, activity, projectName, parent, origin } = data;
  const { task: m, labels, locale } = useMessages();
  const l = m.layout;
  const repo = task.source?.repo ?? task.repo ?? task.repository?.url;
  const step = task.steps.find((s) => s.state === "active")?.key ?? task.gate?.step;
  const created = activity[0]?.at;
  const updated = activity.at(-1)?.at;
  const related: [string, ReactNode][] = [
    ...(task.parent
      ? [
          [l.parent, <TaskLink key="p" id={task.parent.taskId} title={parent?.title} />] as [
            string,
            ReactNode,
          ],
        ]
      : []),
    ...(task.rerun
      ? [
          [
            l.rerunOf,
            <TaskLink
              key="r"
              id={task.rerun.taskId}
              title={data.rerunOf?.title}
              testId="rerun-of"
            />,
          ] as [string, ReactNode],
        ]
      : []),
    ...(task.derivedFrom
      ? [
          [
            l.derivedFrom,
            <TaskLink
              key="d"
              id={task.derivedFrom.taskId}
              title={data.derivedFrom?.title}
              testId="derived-from"
            />,
          ] as [string, ReactNode],
        ]
      : []),
    ...(task.fix
      ? [
          [
            l.fixOrigin,
            <span key="f">
              <TaskLink id={task.fix.taskId} title={origin?.title} testId="fix-origin" />
              {m.deployment.fixDepth(task.fix.depth)}
            </span>,
          ] as [string, ReactNode],
        ]
      : []),
    ...(task.securityFix
      ? [
          [
            l.securityReport,
            <span key="s">
              <TaskLink
                id={task.securityFix.taskId}
                title={data.securityReport?.title}
                testId="security-report"
              />
              {m.security.reportCategory(labels.securityCategory[task.securityFix.category])}
            </span>,
          ] as [string, ReactNode],
        ]
      : []),
  ];
  return (
    <section
      aria-labelledby="properties"
      className="flex flex-col gap-1 rounded-xl border border-border bg-card p-4 text-[13px]"
    >
      <h2 id="properties" className="pb-1 text-sm font-semibold">
        {l.properties}
      </h2>
      <dl className="flex flex-col">
        {step && <Prop label={l.currentStep}>{labels.step[step]}</Prop>}
        {task.pullRequest?.url && (
          <Prop label={l.pullRequest}>
            <a
              href={task.pullRequest.url}
              target="_blank"
              rel="noreferrer"
              className="text-accent-foreground underline"
            >
              #{task.pullRequest.number}
            </a>
          </Prop>
        )}
        <Prop label={l.cost}>
          <span className="font-mono tabular-nums">
            {usd(task.budget.usedUsd)} / {usd(task.budget.capUsd)}
          </span>
          <span
            aria-hidden="true"
            className="mt-1 block h-1.5 w-full overflow-hidden rounded-full bg-border"
          >
            <span
              className={cn(
                "block h-full",
                task.budget.usedUsd >= task.budget.capUsd ? "bg-warn" : "bg-primary",
              )}
              style={{ width: `${Math.min(1, task.budget.usedUsd / task.budget.capUsd) * 100}%` }}
            />
          </span>
        </Prop>
        <Prop label={l.project}>
          <Link
            href={projectSettingsPath(task.projectId)}
            className="text-accent-foreground underline"
          >
            {projectName}
          </Link>
        </Prop>
        <Prop label={l.repository}>
          {repo ? (
            <span className="font-mono text-xs">
              {repo.replace(/^https:\/\/github\.com\//, "")}
              {/* オーケストレーター・人が選んだリポジトリは、選んだ理由を出す（PBI-73） */}
              {task.repoChoice && task.repoChoice.by !== "person" && (
                <>
                  {" "}
                  <Hint text={m.repoChoiceHint(labels.text(task.repoChoice.reason))} />
                </>
              )}
            </span>
          ) : isRepoless(task) ? (
            <span data-testid="no-repository">{l.none}</span>
          ) : (
            "—"
          )}
        </Prop>
        {task.repository && (
          <Prop label={l.baseBranch}>
            <span className="font-mono text-xs">{task.repository.baseBranch}</span>
          </Prop>
        )}
        {task.repository && task.stepsChoice && usesTestCommand(task) && (
          <Prop label={l.testCommand}>
            {task.testCommand ? (
              <span className="font-mono text-xs">{task.testCommand}</span>
            ) : task.noTestsReason ? (
              testCommandOfNoTests(task, m)
            ) : (
              m.testCommandUnknown
            )}
          </Prop>
        )}
        {(task.source || task.ticket) && (
          <Prop label={l.source}>
            {task.source && (
              <a
                href={task.source.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-accent-foreground underline"
              >
                {task.source.repo}#{task.source.number}
              </a>
            )}
            {task.ticket && (
              <a
                href={task.ticket.url}
                target="_blank"
                rel="noreferrer"
                className="font-mono text-xs text-accent-foreground underline"
              >
                {task.ticket.key}
              </a>
            )}
          </Prop>
        )}
        <Prop label={l.start}>
          {labels.start[task.start]}
          {/* テンプレートで作ったタスク（PBI-90） */}
          {task.template && (
            <>
              {" ・ "}
              <span data-testid="task-template">{labels.template[task.template]}</span>
            </>
          )}
        </Prop>
        {related.map(([label, node]) => (
          <Prop key={label} label={label}>
            {node}
          </Prop>
        ))}
        {task.rerunBy && (
          <Prop label={l.rerunBy}>
            <TaskLink id={task.rerunBy} title={data.rerunBy?.title} />
          </Prop>
        )}
        {created && <Prop label={l.created}>{formatStamp(created, locale)}</Prop>}
        {updated && <Prop label={l.updated}>{formatStamp(updated, locale)}</Prop>}
      </dl>
    </section>
  );
}

/**
 * 作業履歴の行の並び（新しい順に渡す）。anchors なら、監査の根拠からたどれるよう行に ID を付ける（PBI-124）。
 * compact は右の列の最近の作業履歴（時刻を短く、行を詰める）。
 */
function ActivityList({
  task,
  events,
  anchors = false,
  compact = false,
}: {
  task: Task;
  events: ActivityEvent[];
  anchors?: boolean;
  compact?: boolean;
}) {
  const messages = useMessages();
  return (
    <ol className="flex flex-col">
      {events.map((event) => (
        <li
          key={event.id}
          id={anchors ? `event-${event.id}` : undefined}
          className={cn(
            "grid gap-3 border-t border-border text-[13px] target:bg-accent",
            compact
              ? "grid-cols-[76px_minmax(0,1fr)] py-2"
              : "scroll-mt-60 grid-cols-[96px_minmax(0,1fr)] py-2.5",
          )}
        >
          <time
            dateTime={event.at}
            className="font-mono text-xs text-muted-foreground tabular-nums"
          >
            {formatStamp(event.at, messages.locale)}
          </time>
          {/* パスやブランチ名など、区切りの無い長い文字列でも幅からはみ出さないようにする */}
          <span className={cn("[overflow-wrap:anywhere]", compact && "line-clamp-2")}>
            <EventText event={event} />
            {/* エージェントの実行の行から、その実行のセッションログを開く（PBI-62） */}
            {!compact && runLogId(event) && (
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
  );
}

/**
 * 工程の設定のタブ。オーケストレーターが選んだ工程と理由、ベースブランチ・テストのコマンド、引き継いだ PR、
 * 書き出し先、工程のイメージとエージェント。
 */
function StepsChoice({ task, data }: { task: Task; data: TaskDetailData }) {
  const { task: m, labels } = useMessages();
  return (
    <section
      aria-labelledby="steps"
      className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5"
    >
      <h2 id="steps" className="text-[15px] font-semibold">
        {m.steps} {/* PR のレビューの取り込みのタスクは、sacty がレビューだけにする（PBI-44） */}
        {task.source?.review ? (
          <span className="text-[13px] font-normal text-muted-foreground">{m.stepsNoteReview}</span>
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

/**
 * 再開と一緒にイメージ・エージェントを変えられる工程（まだ終わっていない工程）。候補は、タスクの詳細の工程の設定と同じ
 * ものを使う（取得できない・設定を読めなければ undefined）。
 */
function resumeStepSettings(
  task: Task,
  data: Pick<TaskDetailData, "imageStatus" | "agentStatus">,
  defaultDescription: string,
): ResumeStepSetting[] {
  const imageOptions = stepImageOptions(data.imageStatus, defaultDescription);
  const agents = new Map(
    stepAgentRows(task, data.agentStatus?.stepAgents).map((row) => [row.step, row.agent]),
  );
  return stepImageRows(task)
    .filter((row) => row.when !== "done")
    .map((row) => {
      const agentChangeable = agents.has(row.step);
      const current = agents.get(row.step);
      const options = stepAgentOptions(data.agentStatus, current);
      return {
        step: row.step,
        image: row.image,
        ...(imageOptions ? { imageOptions } : {}),
        ...(agentChangeable
          ? { agent: { ...(current ? { current } : {}), ...(options ? { options } : {}) } }
          : {}),
      };
    });
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
                      : row.source.by === "request"
                        ? m.byRequest
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
                    : row.source.by === "request"
                      ? m.byRequest
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
