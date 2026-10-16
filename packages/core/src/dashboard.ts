import { addUsd, isChargedEvent } from "./cost.js";
import type { ActivityEvent, StepKey } from "./events.js";
import { isFinished, type Task } from "./projection.js";

/**
 * ダッシュボードの集計（PBI-118）。作業履歴のイベントを1つずつ畳み込み、欄に要るものだけを持つ（デーモンが起動のときに
 * 作業履歴を読むときと、作業履歴に書き足すときに add を呼ぶ）。画面が3秒ごとに取り直しても、タスクの全件や作業履歴を読み直さない。
 * 期間の境は、sacty を動かしているマシン（デーモン）のローカルの日付で決める。
 */

/** 費用の合計。実請求（estimated でない）と概算（サブスクリプションなどの換算値）を分けて持つ。 */
export type CostSum = { actualUsd: number; estimatedUsd: number };

/** 完了・中止の件数と、完了したタスクの作成から完了までの時間の中央値（完了が無ければ null）。 */
export type FlowSum = { completed: number; cancelled: number; medianLeadMs: number | null };

/** 品質の信号の種類（直近 30 日の回数）。 */
export type QualityKind =
  /** 人が差し戻した（ChangesRequested）。 */
  | "changesRequested"
  /** PR の指摘で差し戻した（ReworkJudged）。 */
  | "pullRequestRework"
  /** ゴールガーディアンの見逃し（GuardianMissed）。 */
  | "guardianMissed"
  /** 統合レビューの不合格（IntegrationReviewed の passed が偽）。 */
  | "integrationFailed"
  /** マージの後の監視で修正のタスクを作った（DeploymentFixRegistered）。 */
  | "fixTask";

export type DashboardSummary = {
  /** 期間の境を決めたタイムゾーン（デーモンのマシン）。 */
  timeZone: string;
  /**
   * 対応待ち（承認待ち・一時停止・エスカレーション）のタスクの、待ち始めた時刻（その状態になった作業履歴の記録の時刻）。
   * 記録が無ければ無い（画面は updatedAt で補う）。
   */
  waitingSince: Record<string, string>;
  costs: {
    /** 今日（ローカルの日付）の費用。 */
    today: CostSum;
    /** 今日を含む直近 7 日の費用。 */
    days7: CostSum;
    /** 期間の始まり（ISO）。 */
    since: { today: string; days7: string };
  };
  flow: {
    days7: FlowSum;
    days30: FlowSum;
    since: { days7: string; days30: string };
  };
  quality: {
    /** 期間の始まり（今日を含む直近 30 日）。 */
    since: string;
    counts: Record<QualityKind, number>;
    /** 工程ごとの差し戻しの回数（人の差し戻しと PR の指摘の差し戻し。差し戻した工程＝承認ゲートで止まっていた工程）。 */
    reworkBySteps: Partial<Record<StepKey, number>>;
  };
  queue: {
    running: number;
    queued: number;
    /** 同時に実行するタスクの数の上限（sacty の設定）。 */
    max: number;
    /** 実行待ちが上限より多い状態が続いている始まり（続いていなければ無い）。 */
    overSince?: string;
  };
};

/** デーモンのマシンのローカルの日付で、now の daysBack 日前の 0 時（ミリ秒）。 */
export function localDayStart(now: number, daysBack: number): number {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime();
}

/** 中央値。空なら null。 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** 持っておく期間（直近 30 日の欄に要る分と、日付の境のずれの余裕）。これより古い記録は捨てる。 */
const KEEP_DAYS = 32;

type CostEntry = { at: number; projectId: string; usd: number; estimated: boolean };
type FinishEntry = { at: number; projectId: string; cancelled: boolean; leadMs: number };
type QualityEntry = { at: number; projectId: string; kind: QualityKind; step?: StepKey };

const QUALITY_KINDS: readonly QualityKind[] = [
  "changesRequested",
  "pullRequestRework",
  "guardianMissed",
  "integrationFailed",
  "fixTask",
];

/**
 * 作業履歴のイベントを畳み込んで持つ、ダッシュボードの集計の元。
 * - waiting：タスクごとの、対応待ちになった最後の記録の時刻（StepSubmitted・TaskPaused・TaskEscalated・再現できなかった
 *   ReproductionChecked）
 * - costs：費用を持つイベント（CHARGED_EVENT_TYPES）の費用と時刻
 * - finished：タスクが終わった（isFinished が偽から真になった）時刻（終わっていない状態に戻れば消す）
 * - quality：品質の信号のイベントの時刻と種類
 * 古い記録（KEEP_DAYS より前）は、集計のときに捨てる。
 */
export class DashboardStats {
  private readonly waiting = new Map<string, string>();
  private costs: CostEntry[] = [];
  private readonly finished = new Map<string, FinishEntry>();
  private quality: QualityEntry[] = [];

  /** イベントを1つ畳み込む。before はそのイベントの前のタスク（作成なら無い）、after は後のタスク。 */
  add(event: ActivityEvent, before: Task | undefined, after: Task): void {
    const at = Date.parse(event.at);
    switch (event.type) {
      case "StepSubmitted":
      case "TaskPaused":
      case "TaskEscalated":
        this.waiting.set(event.taskId, event.at);
        break;
      case "ReproductionChecked":
        // 再現できなかったら、提出を記録せずに人の判断を待つ（PBI-29）
        if (!event.payload.reproduced) this.waiting.set(event.taskId, event.at);
        break;
      case "ChangesRequested":
        this.quality.push({
          at,
          projectId: event.projectId,
          kind: "changesRequested",
          step: event.payload.step,
        });
        break;
      case "ReworkJudged":
        // 戻し先を判断できなければ、その PR の工程（承認ゲートの工程）をやり直す（PBI-58・PBI-110）
        this.quality.push({
          at,
          projectId: event.projectId,
          kind: "pullRequestRework",
          step: event.payload.target ?? after.gate?.step ?? "implement",
        });
        break;
      case "GuardianMissed":
        this.quality.push({ at, projectId: event.projectId, kind: "guardianMissed" });
        break;
      case "IntegrationReviewed":
        if (!event.payload.passed) {
          this.quality.push({ at, projectId: event.projectId, kind: "integrationFailed" });
        }
        break;
      case "DeploymentFixRegistered":
        this.quality.push({ at, projectId: event.projectId, kind: "fixTask" });
        break;
    }
    if (isChargedEvent(event) && event.payload.costUsd > 0) {
      this.costs.push({
        at,
        projectId: event.projectId,
        usd: event.payload.costUsd,
        estimated: event.payload.estimated,
      });
    }
    const wasFinished = before ? isFinished(before) : false;
    // 終わったタスクは対応待ちにならないので、待ち始めの記録を持ち続けない
    if (isFinished(after)) this.waiting.delete(event.taskId);
    if (!wasFinished && isFinished(after)) {
      this.finished.set(event.taskId, {
        at,
        projectId: event.projectId,
        cancelled: after.status === "cancelled",
        leadMs: Math.max(0, at - Date.parse(after.createdAt)),
      });
    } else if (wasFinished && !isFinished(after)) {
      this.finished.delete(event.taskId);
    }
  }

  /**
   * 集計する。projects は今あるプロジェクトの ID（消したプロジェクトのタスクは数えない）。tasks は今のタスク（待ち行列と
   * 対応待ちの時刻に使う）。overSince は、実行待ちが上限より多い状態の始まり（呼ぶ側が前の値を渡す）。
   */
  summary(input: {
    now: number;
    timeZone: string;
    projects: ReadonlySet<string>;
    tasks: Iterable<Task>;
    maxParallel: number;
    overSince?: number;
  }): DashboardSummary {
    const { now, projects } = input;
    this.prune(now);
    const live = <T extends { projectId: string }>(entries: Iterable<T>) =>
      [...entries].filter((e) => projects.has(e.projectId));

    const todayStart = localDayStart(now, 0);
    const days7Start = localDayStart(now, 6);
    const days30Start = localDayStart(now, 29);

    const costSum = (from: number): CostSum => {
      let actualUsd = 0;
      let estimatedUsd = 0;
      for (const c of live(this.costs)) {
        if (c.at < from) continue;
        if (c.estimated) estimatedUsd = addUsd(estimatedUsd, c.usd);
        else actualUsd = addUsd(actualUsd, c.usd);
      }
      return { actualUsd, estimatedUsd };
    };

    const flowSum = (from: number): FlowSum => {
      const inWindow = live(this.finished.values()).filter((f) => f.at >= from);
      return {
        completed: inWindow.filter((f) => !f.cancelled).length,
        cancelled: inWindow.filter((f) => f.cancelled).length,
        medianLeadMs: median(inWindow.filter((f) => !f.cancelled).map((f) => f.leadMs)),
      };
    };

    const counts = Object.fromEntries(QUALITY_KINDS.map((k) => [k, 0])) as Record<
      QualityKind,
      number
    >;
    const reworkBySteps: Partial<Record<StepKey, number>> = {};
    for (const q of live(this.quality)) {
      if (q.at < days30Start) continue;
      counts[q.kind] += 1;
      if (q.step) reworkBySteps[q.step] = (reworkBySteps[q.step] ?? 0) + 1;
    }

    const waitingSince: Record<string, string> = {};
    let running = 0;
    let queued = 0;
    for (const task of input.tasks) {
      if (!projects.has(task.projectId)) continue;
      if (task.status === "running") running += 1;
      if (task.status === "queued") queued += 1;
      if (
        task.status === "awaiting_approval" ||
        task.status === "paused" ||
        task.status === "escalated"
      ) {
        const since = this.waiting.get(task.id);
        if (since) waitingSince[task.id] = since;
      }
    }
    const over = queued > input.maxParallel;
    const overSince = over ? (input.overSince ?? now) : undefined;

    return {
      timeZone: input.timeZone,
      waitingSince,
      costs: {
        today: costSum(todayStart),
        days7: costSum(days7Start),
        since: {
          today: new Date(todayStart).toISOString(),
          days7: new Date(days7Start).toISOString(),
        },
      },
      flow: {
        days7: flowSum(days7Start),
        days30: flowSum(days30Start),
        since: {
          days7: new Date(days7Start).toISOString(),
          days30: new Date(days30Start).toISOString(),
        },
      },
      quality: { since: new Date(days30Start).toISOString(), counts, reworkBySteps },
      queue: {
        running,
        queued,
        max: input.maxParallel,
        ...(overSince !== undefined ? { overSince: new Date(overSince).toISOString() } : {}),
      },
    };
  }

  private prune(now: number): void {
    const limit = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
    this.costs = this.costs.filter((c) => c.at >= limit);
    this.quality = this.quality.filter((q) => q.at >= limit);
    for (const [id, f] of this.finished) if (f.at < limit) this.finished.delete(id);
  }
}
