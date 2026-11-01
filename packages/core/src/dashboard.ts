import { addUsd, isChargedEvent } from "./cost.js";
import type { ActivityEvent, ReworkCause, StepKey } from "./events.js";
import { isFinished, type Task } from "./projection.js";

/**
 * ダッシュボードの集計（PBI-118）。作業履歴のイベントを1つずつ畳み込み、欄に要るものだけを持つ（デーモンが起動のときに
 * 作業履歴を読むときと、作業履歴に書き足すときに add を呼ぶ）。画面が3秒ごとに取り直しても、タスクの全件や作業履歴を読み直さない。
 * 期間の境は、sacty を動かしているマシン（デーモン）のローカルの日付で決める。
 */

/** 完了・中止の件数と、完了したタスクの作成から完了までの時間の中央値（完了が無ければ null）。 */
export type FlowSum = { completed: number; cancelled: number; medianLeadMs: number | null };

/** 品質の信号の種類（直近 30 日の回数）。 */
export type QualityKind =
  /** 人が差し戻した（ChangesRequested のうち、PR の指摘によるものでないもの）。 */
  | "changesRequested"
  /** PR の指摘で差し戻した（ChangesRequested のうち、ゴールガーディアンの判断で戻したもの。Task の prRework）。 */
  | "pullRequestRework"
  /** ゴールガーディアンの見逃し（GuardianMissed）。 */
  | "guardianMissed"
  /** 統合レビューの不合格（IntegrationReviewed の passed が偽）。 */
  | "integrationFailed"
  /** マージの後の監視で修正のタスクを作った（DeploymentFixRegistered）。 */
  | "fixTask";

/**
 * 差し戻しの原因の集計の区分（PBI-268）。unspecified は、原因が分からない差し戻し（人が原因を選ばず、ゴールガーディアンも判断していない。
 * 原因を記録する前の作業履歴で、見逃しの記録（GuardianMissed）が直前に無いものを含む）。
 */
export type ReworkCauseKey = ReworkCause | "unspecified";

export const REWORK_CAUSE_KEYS: readonly ReworkCauseKey[] = [
  "guardian_missed",
  "new_request",
  "base_changed",
  "unspecified",
];

export type DashboardSummary = {
  /** 期間の境を決めたタイムゾーン（デーモンのマシン）。 */
  timeZone: string;
  /**
   * 対応待ち（承認待ち・一時停止・エスカレーション）のタスクの、待ち始めた時刻（その状態になった作業履歴の記録の時刻）。
   * 記録が無ければ無い（画面は updatedAt で補う）。
   */
  waitingSince: Record<string, string>;
  costs: {
    /**
     * 今日（ローカルの日付）の費用（米ドル）。sacty が使用量と単価から計算した概算で、実際の請求とは分けない
     * （サブスクリプションなどの換算値も足す）。
     */
    today: number;
    /** 今日を含む直近 7 日の費用（米ドル。today と同じく概算）。 */
    days7: number;
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
    /**
     * 原因ごとの差し戻しの回数（人の差し戻しと PR の指摘の差し戻し。PBI-268）。guardian_missed は、差し戻した人かゴールガーディアンが
     * 見逃しと判断したもの。ゴールガーディアンの見逃し（counts.guardianMissed）は、そのうち合格の最終レビューがあったものを数えるので、
     * 同じ数とは限らない。unspecified は原因が分からないもの（見逃しかどうか分からない）で、見逃しの数と並べて出す。
     */
    reworkByCause: Record<ReworkCauseKey, number>;
  };
  queue: {
    /** 実行中（ワーカーが処理している）タスクの数。 */
    running: number;
    /** 実行待ち（ワーカーが次に処理する対象で、まだ処理していない）タスクの数。 */
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

/**
 * 実行待ちが上限より多い状態の始まり（PBI-118）。多ければ、前の始まり（previous）があればそれ、無ければ now。多くなければ無い。
 * デーモンは、タスクの状態・実行の開始と終わり・設定・プロジェクトが変わるたびにこれで更新し、画面の取得に依らず追う。
 */
export function queueOverSince(
  waiting: number,
  max: number,
  now: number,
  previous: number | undefined,
): number | undefined {
  if (waiting <= max) return undefined;
  return previous ?? now;
}

/** 持っておく期間（直近 30 日の欄に要る分と、日付の境のずれの余裕）。これより古い記録は捨てる。 */
const KEEP_DAYS = 32;
const DAY_MS = 24 * 60 * 60 * 1000;

type CostEntry = { at: number; projectId: string; usd: number };
type FinishEntry = { at: number; projectId: string; cancelled: boolean; leadMs: number };
type QualityEntry = {
  at: number;
  projectId: string;
  kind: QualityKind;
  step?: StepKey;
  /** 差し戻し（ChangesRequested）の原因。 */
  cause?: ReworkCauseKey;
};

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
 * 古い記録（KEEP_DAYS より前）は、畳み込みの中で1日に1回と、集計のときに捨てる（画面を開かずに動かし続けても増え続けない）。
 */
export class DashboardStats {
  private readonly waiting = new Map<string, string>();
  private costs: CostEntry[] = [];
  private readonly finished = new Map<string, FinishEntry>();
  private quality: QualityEntry[] = [];
  /** 直前のイベントが GuardianMissed だったタスク（原因を記録する前の作業履歴で、見逃しの差し戻しを見分ける。PBI-268）。 */
  private readonly afterMissed = new Set<string>();
  /** 最後に古い記録を捨てた時刻（畳み込んだイベントの時刻で数える）。 */
  private prunedAt = Number.NEGATIVE_INFINITY;

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
        // 差し戻しは、実際に差し戻した記録（ChangesRequested）を1回として数える。PR の指摘でゴールガーディアンが戻したものは、
        // 投影がこの記録の時刻で prRework に残す（PBI-58）。判断（ReworkJudged）だけで差し戻されなかった（上限で
        // エスカレーションした）ものは数えない
        this.quality.push({
          at,
          projectId: event.projectId,
          kind: after.prRework?.at === event.at ? "pullRequestRework" : "changesRequested",
          step: event.payload.step,
          // 原因を記録する前の作業履歴は、見逃しの記録（GuardianMissed）が差し戻しの直前にあれば、見逃しの差し戻しとして数える
          cause:
            event.payload.cause ??
            (this.afterMissed.has(event.taskId) ? "guardian_missed" : "unspecified"),
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
    if (event.type === "GuardianMissed") this.afterMissed.add(event.taskId);
    else this.afterMissed.delete(event.taskId);
    if (isChargedEvent(event) && event.payload.costUsd > 0) {
      this.costs.push({
        at,
        projectId: event.projectId,
        usd: event.payload.costUsd,
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
    // 記録の時刻で1日に1回、古い記録を捨てる（起動のときの読み込みでも、集計を取る前でも増え続けない）
    if (at - this.prunedAt >= DAY_MS) this.prune(at);
  }

  /**
   * 集計する。projects は今あるプロジェクトの ID（消したプロジェクトのタスクは数えない）。tasks は今のタスク（対応待ちの時刻と、
   * 待ち行列のタスクのプロジェクトの確認に使う）。queue は、ワーカーが処理しているタスクの ID（running）、ワーカーが次に処理する対象で
   * まだ処理していないタスクの ID（waiting）、上限、実行待ちが上限より多い状態の始まり（呼ぶ側が追う。queueOverSince）。
   */
  summary(input: {
    now: number;
    timeZone: string;
    projects: ReadonlySet<string>;
    tasks: Iterable<Task>;
    queue: {
      running: Iterable<string>;
      waiting: Iterable<string>;
      max: number;
      overSince?: number;
    };
  }): DashboardSummary {
    const { now, projects } = input;
    this.prune(now);
    const live = <T extends { projectId: string }>(entries: Iterable<T>) =>
      [...entries].filter((e) => projects.has(e.projectId));

    const todayStart = localDayStart(now, 0);
    const days7Start = localDayStart(now, 6);
    const days30Start = localDayStart(now, 29);

    const costSum = (from: number): number => {
      let usd = 0;
      for (const c of live(this.costs)) {
        if (c.at >= from) usd = addUsd(usd, c.usd);
      }
      return usd;
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
    const reworkByCause = Object.fromEntries(REWORK_CAUSE_KEYS.map((k) => [k, 0])) as Record<
      ReworkCauseKey,
      number
    >;
    for (const q of live(this.quality)) {
      if (q.at < days30Start) continue;
      counts[q.kind] += 1;
      if (q.step) reworkBySteps[q.step] = (reworkBySteps[q.step] ?? 0) + 1;
      if (q.cause) reworkByCause[q.cause] += 1;
    }

    const waitingSince: Record<string, string> = {};
    const liveTasks = new Set<string>();
    for (const task of input.tasks) {
      if (!projects.has(task.projectId)) continue;
      liveTasks.add(task.id);
      if (
        task.status === "awaiting_approval" ||
        task.status === "paused" ||
        task.status === "escalated"
      ) {
        const since = this.waiting.get(task.id);
        if (since) waitingSince[task.id] = since;
      }
    }
    const count = (ids: Iterable<string>) => [...ids].filter((id) => liveTasks.has(id)).length;
    const overSince = input.queue.overSince;

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
      quality: {
        since: new Date(days30Start).toISOString(),
        counts,
        reworkBySteps,
        reworkByCause,
      },
      queue: {
        running: count(input.queue.running),
        queued: count(input.queue.waiting),
        max: input.queue.max,
        ...(overSince !== undefined ? { overSince: new Date(overSince).toISOString() } : {}),
      },
    };
  }

  private prune(now: number): void {
    this.prunedAt = now;
    const limit = now - KEEP_DAYS * DAY_MS;
    this.costs = this.costs.filter((c) => c.at >= limit);
    this.quality = this.quality.filter((q) => q.at >= limit);
    for (const [id, f] of this.finished) if (f.at < limit) this.finished.delete(id);
  }
}
