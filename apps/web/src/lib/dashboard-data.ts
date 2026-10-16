import {
  BUDGET_WARN_RATIO,
  type DashboardSummary,
  isFinished,
  type PauseReason,
  type Project,
  type Task,
} from "@sacty/core";
import { getMessages } from "@/i18n/server";
import {
  type DaemonStatus,
  getDashboardSummary,
  getStatus,
  listProjects,
  listTasks,
} from "@/lib/daemon";
import { PAUSE_REASON_ORDER } from "@/lib/dashboard-rules";
import { personAction, type StatusTone, statusText, statusTone } from "@/lib/labels";
import { notificationProblems } from "@/lib/notification-problems";

/** ダッシュボードの「終わっていないタスク」の欄の1行（PBI-114）。 */
export type OpenTaskRow = {
  id: string;
  title: string;
  projectId: string;
  projectName: string;
  status: { text: string; tone: StatusTone };
};

/** 「あなたの出番」の1行（PBI-118）。href は人が判断する場所（personAction と同じ）。 */
export type AttentionRow = OpenTaskRow & {
  href: string;
  /** 待ち始めた時刻（その状態になった作業履歴の記録。無ければ updatedAt）。 */
  waitingSince: string;
};

/** 「止まっているタスクの理由」の1つの理由（PBI-118）。件数が 0 の理由は無い。 */
export type PausedGroup = {
  reason: PauseReason;
  tasks: Pick<OpenTaskRow, "id" | "title" | "projectName">[];
};

/** 「費用と予算」の予算に近いタスクの1行（PBI-118）。 */
export type BudgetRow = Pick<OpenTaskRow, "id" | "title" | "projectName"> & {
  usedUsd: number;
  capUsd: number;
  estimated: boolean;
  /** 上限に達した。 */
  exceeded: boolean;
};

/**
 * ダッシュボードのデータ（PBI-114・PBI-118）。画面が取り直す（PBI-108）。欄を足すときは、ここに欄ごとのデータを足す。
 * projects はプロジェクトの数（無いときの表示に使う）。notificationProblems は、Slack の通知を送れなかった理由
 * （画面の言語の文。無ければ空。PBI-115）。
 * 時刻は ISO で持ち、待っている時間は画面が描くときに計算する（データに「今」を入れると、取り直しのたびに版が変わるため）。
 */
export type DashboardData = {
  projects: number;
  openTasks: OpenTaskRow[];
  notificationProblems?: string[];
  attention: AttentionRow[];
  paused: PausedGroup[];
  costs: DashboardSummary["costs"] & { timeZone: string; nearBudget: BudgetRow[] };
  intake: DaemonStatus["intake"];
  flow: DashboardSummary["flow"];
  quality: DashboardSummary["quality"];
  queue: DashboardSummary["queue"];
};

/** 終わっていないタスクか（完了・中止を除くすべて。承認待ち・一時停止・エスカレーションも含む。PBI-114）。 */
export function isOpenTask(task: Task): boolean {
  return !isFinished(task);
}

type Labels = Parameters<typeof statusText>[1];

/** 今あるプロジェクトの、終わっていないタスク（消したプロジェクトのタスクは出さない）。 */
function liveOpenTasks(projects: readonly Project[], tasks: readonly Task[]): Task[] {
  const ids = new Set(projects.map((p) => p.id));
  return tasks.filter((t) => ids.has(t.projectId) && isOpenTask(t));
}

/**
 * すべてのプロジェクトの、終わっていないタスク（新しく動いた順）。件数の上限は無い。プロジェクトが無くなったタスクは
 * 出さない（開いても、どのプロジェクトのタスクか分からないため）。
 */
export function openTaskRows(
  projects: readonly Project[],
  tasks: readonly Task[],
  labels: Labels,
): OpenTaskRow[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return liveOpenTasks(projects, tasks)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      projectName: names.get(t.projectId) ?? t.projectId,
      status: { text: statusText(t, labels), tone: statusTone(t) },
    }));
}

/**
 * あなたの出番（PBI-118）：人の判断を待っているタスク（状態の表示が「人の出番」のもの。承認待ちでもゴールガーディアンが
 * PR の指摘を判断している間は除く）を、待っている時間が長い順に出す。待ち始めは、デーモンの集計の時刻（その状態になった
 * 作業履歴の記録）。無ければ updatedAt。
 */
export function attentionRows(
  projects: readonly Project[],
  tasks: readonly Task[],
  waitingSince: DashboardSummary["waitingSince"],
  labels: Labels,
): AttentionRow[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return liveOpenTasks(projects, tasks)
    .filter((t) => statusTone(t) === "person")
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectId: t.projectId,
      projectName: names.get(t.projectId) ?? t.projectId,
      status: { text: statusText(t, labels), tone: statusTone(t) },
      href: personAction(t, labels).href,
      waitingSince: waitingSince[t.id] ?? t.updatedAt,
    }))
    .sort((a, b) => a.waitingSince.localeCompare(b.waitingSince) || a.id.localeCompare(b.id));
}

/** 止まっているタスクの理由ごとの件数とタスク（PBI-118）。理由の無い古い記録は「人が止めた」に入れる。 */
export function pausedGroups(projects: readonly Project[], tasks: readonly Task[]): PausedGroup[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  const byReason = new Map<PauseReason, PausedGroup["tasks"]>();
  for (const t of liveOpenTasks(projects, tasks)
    .filter((t) => t.status === "paused")
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id))) {
    const reason = t.pausedReason ?? "manual";
    const list = byReason.get(reason) ?? [];
    list.push({ id: t.id, title: t.title, projectName: names.get(t.projectId) ?? t.projectId });
    byReason.set(reason, list);
  }
  return PAUSE_REASON_ORDER.flatMap((reason) => {
    const list = byReason.get(reason);
    return list ? [{ reason, tasks: list }] : [];
  });
}

/**
 * 予算に近いタスク（PBI-118）：終わっていないタスクのうち、予算の 80%（BUDGET_WARN_RATIO）以上を使ったか、上限に達したもの。
 * 使った割合が大きい順。
 */
export function nearBudgetRows(projects: readonly Project[], tasks: readonly Task[]): BudgetRow[] {
  const names = new Map(projects.map((p) => [p.id, p.name]));
  return liveOpenTasks(projects, tasks)
    .filter((t) => t.budget.usedUsd >= t.budget.capUsd * BUDGET_WARN_RATIO)
    .sort(
      (a, b) =>
        b.budget.usedUsd / b.budget.capUsd - a.budget.usedUsd / a.budget.capUsd ||
        a.id.localeCompare(b.id),
    )
    .map((t) => ({
      id: t.id,
      title: t.title,
      projectName: names.get(t.projectId) ?? t.projectId,
      usedUsd: t.budget.usedUsd,
      capUsd: t.budget.capUsd,
      estimated: t.budget.estimated,
      exceeded: t.budget.usedUsd >= t.budget.capUsd,
    }));
}

/** ダッシュボードのデータ。デーモンに届かなければ例外。 */
export async function loadDashboard(): Promise<DashboardData> {
  const [projects, tasks, status, summary, { labels }] = await Promise.all([
    listProjects(),
    // 終わっていないタスクだけを取る（完了したタスクの成果物を3秒ごとに運ばない）
    listTasks({ open: true }),
    getStatus(),
    // 作業履歴を要する集計は、デーモンが畳み込んで持っているものを取る（PBI-118）
    getDashboardSummary(),
    getMessages(),
  ]);
  return {
    projects: projects.length,
    openTasks: openTaskRows(projects, tasks, labels),
    notificationProblems: notificationProblems(status.warnings, labels.text),
    attention: attentionRows(projects, tasks, summary.waitingSince, labels),
    paused: pausedGroups(projects, tasks),
    costs: {
      ...summary.costs,
      timeZone: summary.timeZone,
      nearBudget: nearBudgetRows(projects, tasks),
    },
    intake: status.intake,
    flow: summary.flow,
    quality: summary.quality,
    queue: summary.queue,
  };
}
