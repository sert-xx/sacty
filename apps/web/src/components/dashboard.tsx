"use client";

import { auditAdoptionRate } from "@sacty/core";
import { cn } from "cn";
import Link from "next/link";
import { Fragment, type ReactNode, useEffect, useState } from "react";
import { ActionLink } from "@/components/action-link";
import { MockBadge } from "@/components/audit";
import { DaemonError } from "@/components/daemon-error";
import { IntakeRunNow, IntakeStatusView } from "@/components/intake-status";
import { StaleNotice } from "@/components/live-status";
import { StatusLabelView } from "@/components/task-bits";
import { Hint, WithHint } from "@/components/ui/hint";
import { useMessages } from "@/i18n/client";
import type { DashboardMessages } from "@/i18n/messages/dashboard";
import { perTask } from "@/lib/audit";
import type { DashboardData } from "@/lib/dashboard-data";
import { FIX_ONCE_REASONS, REWORK_STEPS } from "@/lib/dashboard-rules";
import { usd } from "@/lib/labels";
import { projectAuditPath, taskPath } from "@/lib/paths";
import { useLiveData } from "@/lib/use-live-data";

/** 1行に切り詰め、行にフォーカスがある間は折り返して全文を出す。 */
const FULL_ON_FOCUS =
  "truncate group-focus-within:whitespace-normal group-focus-within:[overflow-wrap:anywhere]";

/** ダッシュボードのデータを取り直す先（PBI-114）。 */
export const DASHBOARD_LIVE_URL = "/live/dashboard";

/** 画面の時計を進める間隔（待っている時間の表示。PBI-118）。 */
export const CLOCK_INTERVAL_MS = 60_000;

/** 実行待ちが上限より多い状態が、これだけ続いたら目立たせる（PBI-118）。 */
export const QUEUE_OVER_MS = 10 * 60_000;

/**
 * 待っている時間・期間の文（分・時間・日のどれか1つ。PBI-118）。1分未満は「1分未満」。
 */
export function durationText(ms: number, d: DashboardMessages["duration"]): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) return d.underMinute;
  if (minutes < 60) return d.minutes(minutes);
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return d.hours(hours);
  return d.days(Math.floor(hours / 24));
}

/**
 * 画面の時計（1分ごとに進む）。待っている時間と、待ち行列の「続いている」の判定に使う。データに「今」を入れると取り直しの
 * たびに版が変わるので、画面で持つ。
 */
function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
  return now;
}

/**
 * ダッシュボード（PBI-114・PBI-118）。欄（カード）を並べる。画面をリロードせず、一定の間隔でデータだけを取り直す（PBI-108）。
 * 欄を足すときは、DashboardData に欄のデータを足し、ここに DashboardCard を足す。
 * initial が null（描いたときにデーモンに届かなかった）なら、届くまで error を出し、届いたら欄を出す。
 */
export function LiveDashboard({
  initial,
  initialVersion,
  error,
}: {
  initial: DashboardData | null;
  initialVersion?: string;
  error?: string;
}) {
  const { data, stale } = useLiveData(() => DASHBOARD_LIVE_URL, initial, initialVersion);
  const now = useClock();
  return (
    <>
      <StaleNotice stale={stale} />
      {!data ? (
        <DaemonError message={error ?? ""} />
      ) : (
        <>
          <NotificationProblems problems={data.notificationProblems ?? []} />
          <DashboardGrid>
            <AttentionCard data={data} now={now} />
            <PausedCard data={data} />
            <OpenTasksCard data={data} />
            <CostsCard data={data} />
            <QueueCard data={data} now={now} />
            <IntakeCard data={data} />
            <FlowCard data={data} />
            <QualityCard data={data} />
            {data.audit && <AuditCard audit={data.audit} />}
          </DashboardGrid>
        </>
      )}
    </>
  );
}

/**
 * Slack の通知を送れなかった理由（PBI-115）。通知は sacty 全体の設定なので、最初の画面のダッシュボードにも出し、直す場所
 * （sacty の設定）へのリンクを添える。無ければ何も出さない。
 */
export function NotificationProblems({ problems }: { problems: readonly string[] }) {
  const m = useMessages().dashboard.notification;
  if (problems.length === 0) return null;
  return (
    <div
      role="status"
      data-testid="notification-problems"
      className="flex flex-col gap-1 rounded-xl border border-warn-line bg-warn-soft p-4 text-sm text-warn"
    >
      {problems.map((p) => (
        <p key={p}>{p}</p>
      ))}
      <Link href="/settings" className="w-fit underline">
        {m.openSettings}
      </Link>
    </div>
  );
}

/** 欄を並べる枠。幅が足りれば横に並べ、足りなければ縦に積む（欄が1つなら幅いっぱい）。 */
export function DashboardGrid({ children }: { children: ReactNode }) {
  return (
    <div
      data-testid="dashboard-grid"
      className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,26rem),1fr))] items-start gap-6"
    >
      {children}
    </div>
  );
}

/** ダッシュボードの欄（カード）。見出しと、見出しの横の短い事実（note）と、仕組みの補足（hint。PBI-117）を出す。 */
export function DashboardCard({
  id,
  title,
  note,
  hint,
  children,
}: {
  id: string;
  title: ReactNode;
  note?: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      data-testid={`dashboard-card-${id}`}
      className="flex min-w-0 flex-col rounded-xl border border-border bg-card"
    >
      {/* 狭い画面では、見出しを折り返さず、補足を次の行に回す */}
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-5 pt-4 pb-3">
        <span className="inline-flex shrink-0 items-center gap-1">
          <h2 id={id} className="text-[15px] font-semibold">
            {title}
          </h2>
          <Hint text={hint} />
        </span>
        {note && <span className="text-[13px] text-muted-foreground">{note}</span>}
      </div>
      {children}
    </section>
  );
}

/** 欄の中の空のときの文。 */
function Empty({ children }: { children: ReactNode }) {
  return <p className="px-5 pb-5 text-sm text-muted-foreground">{children}</p>;
}

/**
 * 一覧の欄の一覧。1行は h-16（4rem）。5件分の高さ（20rem）を超えたら、欄の中でスクロールする。キーボードでもスクロール
 * できるよう、フォーカスを受ける（取り直しでは同じ要素が残るので、スクロールの位置は消えない）。
 */
function ScrollList({
  label,
  testId,
  children,
}: {
  label: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <ul
      aria-label={label}
      data-testid={testId}
      // biome-ignore lint/a11y/noNoninteractiveTabindex: スクロールする欄を、キーボードでもスクロールできるようにする
      tabIndex={0}
      className="max-h-80 overflow-y-auto border-t border-border outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </ul>
  );
}

/**
 * 一覧の欄の1行。題（リンク）とプロジェクトの名前は1行に切り詰め、全文は、ホバーで title に、行にフォーカスがある間は
 * 折り返して出す（同じ書き出しの項目を見分けられるように）。右側（aside）に状態などを出す。
 */
function TaskRow({
  testId,
  href,
  external,
  title,
  projectName,
  aside,
}: {
  testId: string;
  href: string;
  /** href が GitHub の PR（新しいタブで開く。PBI-136）。 */
  external?: boolean;
  title: string;
  projectName: string;
  aside?: ReactNode;
}) {
  const m = useMessages().dashboard.openTasks;
  return (
    <li
      data-testid={testId}
      className="group flex min-h-16 items-center gap-4 border-b border-border px-5 py-2 last:border-b-0 hover:bg-muted"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <ActionLink
          href={href}
          external={external}
          title={title}
          className="font-medium text-foreground hover:underline"
          // 題だけを省略し、外部の印は省略の外に置く（PR #148 レビュー提案）
          labelClassName={FULL_ON_FOCUS}
        >
          {title}
        </ActionLink>
        <span title={projectName} className={cn("text-xs text-muted-foreground", FULL_ON_FOCUS)}>
          <span className="sr-only">{m.project}</span>
          {projectName}
        </span>
      </div>
      {aside && <div className="flex shrink-0 flex-col items-end gap-0.5 text-sm">{aside}</div>}
    </li>
  );
}

/**
 * あなたの出番（PBI-118）：人の判断を待っているタスクを、待っている時間が長い順に出す。題は、人が判断する場所（承認の画面か
 * タスクの詳細）へのリンク。
 */
export function AttentionCard({ data, now }: { data: DashboardData; now: number }) {
  const t = useMessages().dashboard;
  const m = t.attention;
  const rows = data.attention;
  return (
    <DashboardCard
      id="attention"
      title={m.title}
      hint={m.hint}
      note={
        rows.length > 0 ? (
          <span data-testid="attention-summary">{m.summary(rows.length)}</span>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <Empty>{m.empty}</Empty>
      ) : (
        <ScrollList label={m.list} testId="attention-list">
          {rows.map((task) => (
            <TaskRow
              key={task.id}
              testId={`attention-${task.id}`}
              href={task.href}
              external={task.external}
              title={task.title}
              projectName={task.projectName}
              aside={
                <>
                  <span className="sr-only">{t.openTasks.status}</span>
                  <StatusLabelView text={task.status.text} tone={task.status.tone} />
                  {/* 待っている時間は画面の時計で計算するので、サーバーと数秒ずれても描き直さない */}
                  <span
                    data-testid={`attention-waiting-${task.id}`}
                    className="text-xs text-muted-foreground tabular-nums"
                    suppressHydrationWarning
                  >
                    <span className="sr-only">{m.waiting}</span>
                    {durationText(now - Date.parse(task.waitingSince), t.duration)}
                  </span>
                </>
              }
            />
          ))}
        </ScrollList>
      )}
    </DashboardCard>
  );
}

/**
 * 止まっているタスクの理由（PBI-118）：一時停止の理由ごとの件数。行を押すと、その理由のタスクが欄の中で広がる（details。
 * 取り直しでも同じ要素が残るので、開いた状態は消えない）。利用上限・認証は、1か所直せばまとめて動くことが多いので目立たせる。
 * 無ければ欄を小さく出す。
 */
export function PausedCard({ data }: { data: DashboardData }) {
  const m = useMessages().dashboard.paused;
  const groups = data.paused;
  const total = groups.reduce((n, g) => n + g.tasks.length, 0);
  return (
    <DashboardCard
      id="paused"
      title={m.title}
      hint={m.hint}
      note={total > 0 ? <span data-testid="paused-summary">{m.summary(total)}</span> : undefined}
    >
      {groups.length === 0 ? (
        <Empty>{m.empty}</Empty>
      ) : (
        <ul data-testid="paused-reasons" className="border-t border-border">
          {groups.map((group) => {
            const fixOnce = FIX_ONCE_REASONS.includes(group.reason);
            return (
              <li
                key={group.reason}
                data-testid={`paused-${group.reason}`}
                className="border-b border-border last:border-b-0"
              >
                <details className="group/reason">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-5 py-3 text-sm hover:bg-muted [&::-webkit-details-marker]:hidden">
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className={cn("font-medium", fixOnce && "text-warn")}>
                        {m.reasons[group.reason]}
                      </span>
                      {fixOnce && (
                        <span
                          data-testid={`paused-fix-once-${group.reason}`}
                          className="rounded-full border border-warn-line bg-warn-soft px-2 py-0.5 text-xs text-warn"
                        >
                          {m.fixOnce}
                        </span>
                      )}
                    </span>
                    <span
                      data-testid={`paused-count-${group.reason}`}
                      className={cn(
                        "shrink-0 font-semibold tabular-nums underline decoration-dotted underline-offset-4",
                        fixOnce ? "text-warn" : "text-foreground",
                      )}
                    >
                      {m.count(group.tasks.length)}
                    </span>
                  </summary>
                  {/* 展開した一覧も、ほかの一覧の欄と同じく 5 件分の高さで、あふれたら欄の中でスクロールする（PR #128 レビュー指摘） */}
                  <ul
                    data-testid={`paused-tasks-${group.reason}`}
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: スクロールする一覧を、キーボードでもスクロールできるようにする
                    tabIndex={0}
                    className="flex max-h-80 flex-col gap-2 overflow-y-auto px-5 pb-3 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {group.tasks.map((task) => (
                      <li
                        key={task.id}
                        data-testid={`paused-task-${task.id}`}
                        className="group flex min-w-0 flex-col"
                      >
                        <Link
                          href={taskPath(task.id)}
                          title={task.title}
                          className={cn("text-sm font-medium hover:underline", FULL_ON_FOCUS)}
                        >
                          {task.title}
                        </Link>
                        <span
                          title={task.projectName}
                          className={cn("text-xs text-muted-foreground", FULL_ON_FOCUS)}
                        >
                          {task.projectName}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </DashboardCard>
  );
}

/**
 * すべてのプロジェクトの、終わっていないタスク（PBI-114）。件数の上限は無く、欄の高さは5件分。それより多ければ欄の中で
 * スクロールする。
 */
export function OpenTasksCard({ data }: { data: DashboardData }) {
  const m = useMessages().dashboard.openTasks;
  const rows = data.openTasks;
  return (
    <DashboardCard
      id="open-tasks"
      title={m.title}
      note={
        data.projects > 0 ? (
          <span data-testid="open-tasks-summary">{m.summary(rows.length)}</span>
        ) : undefined
      }
    >
      {data.projects === 0 ? (
        <Empty>
          {m.noProjects}{" "}
          <Link href="/projects" className="text-accent-foreground underline">
            {m.createProject}
          </Link>
        </Empty>
      ) : rows.length === 0 ? (
        <Empty>{m.empty}</Empty>
      ) : (
        <ScrollList label={m.list} testId="open-tasks-list">
          {rows.map((task) => (
            <TaskRow
              key={task.id}
              testId={`open-task-${task.id}`}
              href={taskPath(task.id)}
              title={task.title}
              projectName={task.projectName}
              aside={
                <>
                  <span className="sr-only">{m.status}</span>
                  <StatusLabelView text={task.status.text} tone={task.status.tone} />
                </>
              }
            />
          ))}
        </ScrollList>
      )}
    </DashboardCard>
  );
}

/**
 * 費用と予算（PBI-118）：今日と直近7日の費用（実請求と概算を分ける。概算が無ければ概算の行は出さない）と、予算に近いタスク
 * （80% 以上か上限に達した。終わっていないタスクだけ）。
 */
export function CostsCard({ data }: { data: DashboardData }) {
  const m = useMessages().dashboard.costs;
  const { today, days7, nearBudget, timeZone } = data.costs;
  const hasEstimated = today.estimatedUsd > 0 || days7.estimatedUsd > 0;
  const cell = "px-2 py-1 text-right whitespace-nowrap";
  return (
    <DashboardCard id="costs" title={m.title} hint={m.hint(timeZone)}>
      <div className="px-3 pb-3">
        <table aria-label={m.table} className="text-sm tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              <td />
              <th scope="col" className={cn(cell, "font-normal")}>
                {m.today}
              </th>
              <th scope="col" className={cn(cell, "font-normal")}>
                {m.days7}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th
                scope="row"
                className="px-2 py-1 text-left font-normal whitespace-nowrap text-muted-foreground"
              >
                {m.actual}
              </th>
              <td data-testid="cost-today-actual" className={cn(cell, "font-semibold")}>
                {usd(today.actualUsd)}
              </td>
              <td data-testid="cost-days7-actual" className={cn(cell, "font-semibold")}>
                {usd(days7.actualUsd)}
              </td>
            </tr>
            {hasEstimated && (
              <tr data-testid="cost-estimated">
                <th
                  scope="row"
                  className="px-2 py-1 text-left font-normal whitespace-nowrap text-muted-foreground"
                >
                  <WithHint hint={m.estimatedHint}>{m.estimated}</WithHint>
                </th>
                <td data-testid="cost-today-estimated" className={cn(cell, "font-semibold")}>
                  {usd(today.estimatedUsd)}
                </td>
                <td data-testid="cost-days7-estimated" className={cn(cell, "font-semibold")}>
                  {usd(days7.estimatedUsd)}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <h3 className="px-5 pb-2 text-sm font-medium">
        <WithHint hint={m.nearBudgetHint}>{m.nearBudget}</WithHint>
      </h3>
      {nearBudget.length === 0 ? (
        <Empty>{m.nearBudgetEmpty}</Empty>
      ) : (
        <ScrollList label={m.nearBudgetList} testId="near-budget-list">
          {nearBudget.map((task) => (
            <TaskRow
              key={task.id}
              testId={`near-budget-${task.id}`}
              href={taskPath(task.id)}
              title={task.title}
              projectName={task.projectName}
              aside={
                <>
                  <span
                    data-testid={`near-budget-used-${task.id}`}
                    className={cn("font-mono text-xs tabular-nums", task.exceeded && "text-warn")}
                  >
                    <span className="sr-only">{m.used}</span>
                    {usd(task.usedUsd)} / {usd(task.capUsd)}
                  </span>
                  <span className="flex gap-1">
                    {task.estimated && (
                      <span className="rounded-full border border-input px-2 py-0.5 text-xs text-muted-foreground">
                        {m.estimated}
                      </span>
                    )}
                    {task.exceeded && (
                      <span
                        data-testid={`near-budget-exceeded-${task.id}`}
                        className="rounded-full border border-warn-line bg-warn-soft px-2 py-0.5 text-xs text-warn"
                      >
                        {m.exceeded}
                      </span>
                    )}
                  </span>
                </>
              }
            />
          ))}
        </ScrollList>
      )}
    </DashboardCard>
  );
}

/**
 * 工程の待ち行列（PBI-118）：実行中の件数 / 同時に実行する数の上限と、実行待ちの件数。実行待ちが上限より多い状態が
 * QUEUE_OVER_MS 続いたら目立たせ、sacty の設定へのリンクを添える。
 */
export function QueueCard({ data, now }: { data: DashboardData; now: number }) {
  const m = useMessages().dashboard.queue;
  const { running, queued, max, overSince } = data.queue;
  const over = overSince !== undefined && now - Date.parse(overSince) >= QUEUE_OVER_MS;
  const figure = "text-2xl font-semibold tabular-nums";
  return (
    <DashboardCard id="queue" title={m.title} hint={m.hint}>
      <dl className="flex flex-wrap gap-x-8 gap-y-2 px-5 pb-5 text-sm">
        <div className="flex flex-col">
          <dt className="text-muted-foreground">{m.running}</dt>
          <dd data-testid="queue-running" className={figure}>
            {m.ratio(running, max)}
          </dd>
        </div>
        <div className="flex flex-col">
          <dt className="text-muted-foreground">{m.queued}</dt>
          <dd data-testid="queue-queued" className={cn(figure, over && "text-warn")}>
            {queued}
          </dd>
        </div>
      </dl>
      {over && (
        <p
          role="status"
          data-testid="queue-over"
          className="mx-5 mb-5 rounded-lg border border-warn-line bg-warn-soft px-3 py-2 text-sm text-warn"
        >
          {m.over}{" "}
          <Link href="/settings" className="underline">
            {m.openSettings}
          </Link>
        </p>
      )}
    </DashboardCard>
  );
}

/** 取り込みの状況（PBI-118）：プロジェクトの一覧と同じ表示と、「今すぐ取り込む」。 */
export function IntakeCard({ data }: { data: DashboardData }) {
  const m = useMessages().dashboard.intake;
  return (
    <DashboardCard id="intake-status" title={m.title} hint={m.hint}>
      <div className="flex flex-col gap-1 px-5 pb-4 text-sm">
        <IntakeStatusView intake={data.intake} />
      </div>
      {data.intake && (
        <div className="px-5 pb-5">
          <IntakeRunNow intake={data.intake} />
        </div>
      )}
    </DashboardCard>
  );
}

/** 流量（PBI-118）：直近7日・30日の完了・中止の件数と、作成から完了までの時間の中央値。 */
export function FlowCard({ data }: { data: DashboardData }) {
  const t = useMessages().dashboard;
  const m = t.flow;
  const cell = "px-2 py-1 text-right whitespace-nowrap";
  const lead = (ms: number | null) => (ms === null ? m.none : durationText(ms, t.duration));
  const periods = [
    ["days7", m.days7, data.flow.days7],
    ["days30", m.days30, data.flow.days30],
  ] as const;
  return (
    <DashboardCard id="flow" title={m.title} hint={m.hint}>
      <div className="px-3 pb-5">
        <table aria-label={m.table} className="w-full text-sm tabular-nums">
          <thead>
            <tr className="text-muted-foreground">
              <th scope="col" className="px-2 py-1 text-left font-normal whitespace-nowrap">
                {m.period}
              </th>
              <th scope="col" className={cn(cell, "font-normal")}>
                {m.completed}
              </th>
              <th scope="col" className={cn(cell, "font-normal")}>
                {m.cancelled}
              </th>
              {/* 狭い画面では、この見出しだけ折り返す（数字の列は折り返さない） */}
              <th scope="col" className="px-2 py-1 text-right font-normal">
                <WithHint hint={m.leadHint}>{m.lead}</WithHint>
              </th>
            </tr>
          </thead>
          <tbody>
            {periods.map(([key, label, sum]) => (
              <tr key={key} data-testid={`flow-${key}`}>
                <th
                  scope="row"
                  className="px-2 py-1 text-left font-normal whitespace-nowrap text-muted-foreground"
                >
                  {label}
                </th>
                <td data-testid={`flow-${key}-completed`} className={cn(cell, "font-semibold")}>
                  {sum.completed}
                </td>
                <td data-testid={`flow-${key}-cancelled`} className={cn(cell, "font-semibold")}>
                  {sum.cancelled}
                </td>
                <td data-testid={`flow-${key}-lead`} className={cn(cell, "font-semibold")}>
                  {lead(sum.medianLeadMs)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DashboardCard>
  );
}

/**
 * 品質の信号（PBI-118）：直近30日の、人の差し戻し・PR の指摘の差し戻し・ゴールガーディアンの見逃し・統合レビューの不合格・
 * 監視で作った修正のタスクの回数と、工程ごとの差し戻しの回数（要求要件・設計・実装は常に出し、ほかの工程は回数があるときだけ）。
 */
export function QualityCard({ data }: { data: DashboardData }) {
  const all = useMessages();
  const m = all.dashboard.quality;
  const { counts, reworkBySteps } = data.quality;
  const signals = [
    ["changesRequested", m.changesRequested, m.changesRequestedHint],
    ["pullRequestRework", m.pullRequestRework, m.pullRequestReworkHint],
    ["guardianMissed", m.guardianMissed, m.guardianMissedHint],
    ["integrationFailed", m.integrationFailed, m.integrationFailedHint],
    ["fixTask", m.fixTask, m.fixTaskHint],
  ] as const;
  const steps = [
    ...REWORK_STEPS,
    ...(Object.keys(reworkBySteps) as (keyof typeof reworkBySteps)[]).filter(
      (step) => !REWORK_STEPS.includes(step) && (reworkBySteps[step] ?? 0) > 0,
    ),
  ];
  const row = "grid grid-cols-[1fr_auto] items-baseline gap-x-4 gap-y-1 text-sm";
  return (
    <DashboardCard id="quality" title={m.title} hint={m.hint}>
      <dl aria-label={m.counts} className={cn(row, "px-5 pb-4")}>
        {signals.map(([key, label, hint]) => (
          <Fragment key={key}>
            <dt className="text-muted-foreground">
              <WithHint hint={hint}>{label}</WithHint>
            </dt>
            <dd data-testid={`quality-${key}`} className="text-right font-semibold tabular-nums">
              {m.times(counts[key])}
            </dd>
          </Fragment>
        ))}
      </dl>
      <h3 className="px-5 pb-1 text-sm font-medium">
        <WithHint hint={m.byStepsHint}>{m.bySteps}</WithHint>
      </h3>
      <dl className={cn(row, "px-5 pb-5")}>
        {steps.map((step) => (
          <Fragment key={step}>
            <dt className="text-muted-foreground">{all.labels.step[step]}</dt>
            <dd data-testid={`rework-${step}`} className="text-right font-semibold tabular-nums">
              {m.times(reworkBySteps[step] ?? 0)}
            </dd>
          </Fragment>
        ))}
      </dl>
    </DashboardCard>
  );
}

/**
 * 監査（PBI-124）：プロジェクトごとの原因・再発・判断待ちの件数と提案の採用率、週ごとのタスクあたりの差し戻し・指摘の件数。
 * 件数だけを出し、原因や提案の中身は、プロジェクトの監査の画面で見る（プロジェクトをまたいで集約しない）。
 */
export function AuditCard({ audit }: { audit: NonNullable<DashboardData["audit"]> }) {
  const all = useMessages();
  const m = all.audit.dashboard;
  const cell = "px-2 py-1 text-right whitespace-nowrap tabular-nums";
  return (
    <DashboardCard
      // タスクの詳細の監査の欄（id="audit"）と重ねない。画面を移っても前の画面が裏に残るので、#audit が取り違える
      id="audit-summary"
      title={m.title}
      hint={m.hint}
      note={audit.mock ? <MockBadge /> : undefined}
    >
      {audit.projects.length === 0 && audit.trend.length === 0 ? (
        <Empty>{m.none}</Empty>
      ) : (
        <div className="flex flex-col gap-4 px-3 pb-5">
          {/* 狭い画面・英語・文字の拡大でも、表はカードの中で横にスクロールする（ページを横に広げない。PR #134 レビュー指摘） */}
          {audit.projects.length > 0 && (
            <div className="overflow-x-auto" data-testid="audit-projects-scroll">
              <table aria-label={m.title} className="w-full text-sm">
                <thead>
                  <tr className="text-muted-foreground">
                    <th scope="col" className="px-2 py-1 text-left font-normal">
                      {m.project}
                    </th>
                    <th scope="col" className={cn(cell, "font-normal")}>
                      {m.causes}
                    </th>
                    <th scope="col" className={cn(cell, "font-normal")}>
                      {m.recurred}
                    </th>
                    <th scope="col" className={cn(cell, "font-normal")}>
                      {m.pending}
                    </th>
                    <th scope="col" className={cn(cell, "font-normal")}>
                      <WithHint hint={m.adoptionHint}>{m.adoption}</WithHint>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {audit.projects.map((p) => {
                    const rate = auditAdoptionRate(p.adopted, p.rejected);
                    return (
                      <tr key={p.projectId} data-testid={`audit-project-${p.projectId}`}>
                        <th scope="row" className="px-2 py-1 text-left font-normal">
                          <Link
                            href={projectAuditPath(p.projectId)}
                            className="text-accent-foreground underline [overflow-wrap:anywhere]"
                          >
                            {p.projectName}
                          </Link>
                        </th>
                        <td className={cn(cell, "font-semibold")}>{p.causes}</td>
                        <td className={cn(cell, "font-semibold", p.recurred > 0 && "text-warn")}>
                          {p.recurred}
                        </td>
                        <td className={cn(cell, "font-semibold")}>{p.pending}</td>
                        <td className={cn(cell, "font-semibold")}>
                          {rate === null ? m.noRate : `${Math.round(rate * 100)}%`}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {audit.trend.length > 0 && (
            <div className="flex flex-col gap-1">
              <h3 className="px-2 text-sm font-medium">
                <WithHint hint={m.trendHint}>{m.trend}</WithHint>
              </h3>
              <div className="overflow-x-auto" data-testid="audit-trend-scroll">
                <table aria-label={m.trend} className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground">
                      <th scope="col" className="px-2 py-1 text-left font-normal">
                        {m.week}
                      </th>
                      <th scope="col" className={cn(cell, "font-normal")}>
                        {m.tasks}
                      </th>
                      <th scope="col" className={cn(cell, "font-normal")}>
                        {m.perTask}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {audit.trend.map((w) => (
                      <tr key={w.weekStart} data-testid={`audit-trend-${w.weekStart}`}>
                        <th scope="row" className="px-2 py-1 text-left font-mono font-normal">
                          {w.weekStart}
                        </th>
                        <td className={cn(cell, "font-semibold")}>{w.tasks}</td>
                        <td className={cn(cell, "font-semibold")}>
                          {perTask(w.remarks, w.tasks) ?? m.noRate}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </DashboardCard>
  );
}
